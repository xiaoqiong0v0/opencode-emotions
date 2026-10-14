/**
 * 阿里云百炼 **CosyVoice** TTS provider（WebSocket `run-task` 协议）。
 *
 * 接入方式（官方当前推荐，见 `docs/设计-语音输入注入.md` §11）：
 *   `wss://{workspace}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference`
 *   握手头 `Authorization: Bearer <apiKey>` + `X-DashScope-WorkSpace: <workspace>`；
 *   流程：`run-task`（参数：text_type/voice/format/sample_rate/volume/rate/pitch/instruction）
 *   → 收 `task-started` → `continue-task`（正文）→ `finish-task` → 收二进制音频帧 → `task-finished`。
 *
 * 播放：把合成结果落临时 WAV（非 wav 用 ffmpeg 转码；流式 WAV 头长度字段经 `normalizeWavHeader` 修正），
 * 用 PowerShell `System.Media.SoundPlayer` 同步播放；
 * 播放进程可被 `stop()` 打断。**仅 Windows 支持播放**（非 Windows 抛清晰错误）。
 *
 * 安全：凭证只读、绝不打印；错误文本统一经 `redact()` 脱敏。并发/打断契约见 docs/ASYNC.md 交互点 ⑩。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import createLogger from "@xiaoqiong0v0/opencode-plugin-logger";
import type { Logger } from "@xiaoqiong0v0/opencode-plugin-logger";
import WebSocket from "ws";

import { redact, resolveCredentials, type CredentialFileConfig, type Credentials } from "../credentials.js";
import { decodeToWav } from "../ffmpeg.js";
import type { ResolvedTtsOptions, SpeakResult, TtsProvider } from "./types.js";
/** provider 标识。 */
export const ALIYUN_PROVIDER_NAME = "aliyun";
/** 默认 CosyVoice 模型（官方在售；可被 `tts.model` 覆盖）。 */
export const DEFAULT_COSYVOICE_MODEL = "cosyvoice-v2";
/** 默认音色（cosyvoice-v2 系统音色「龙小淳」；**须与模型版本一致**，可被 `tts.voice` 覆盖）。 */
export const DEFAULT_COSYVOICE_VOICE = "longxiaochun_v2";
/** WebSocket 端点模板（华北2 北京 MaaS 专属域名）。 */
export const TTS_URL_TEMPLATE = "wss://{workspace}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference";
/** CosyVoice 支持的输出格式。 */
export const TTS_FORMATS: readonly string[] = ["pcm", "wav", "mp3", "opus"];
/** CosyVoice 支持的采样率。 */
export const TTS_SAMPLE_RATES: readonly number[] = [8000, 16000, 22050, 24000, 44100, 48000];
/** 默认输出格式（wav 便于本机直接播放）。 */
export const DEFAULT_FORMAT = "wav";
/** 默认采样率。 */
export const DEFAULT_SAMPLE_RATE = 22050;
/** 默认音量。 */
export const DEFAULT_VOLUME = 50;
/** 默认语速。 */
export const DEFAULT_SPEED = 1.0;
/** 默认音高。 */
export const DEFAULT_PITCH = 1.0;
/** 语速范围。 */
export const MIN_SPEED = 0.5;
export const MAX_SPEED = 2.0;
/** 音高范围。 */
export const MIN_PITCH = 0.5;
export const MAX_PITCH = 2.0;
/** 合成整体超时（毫秒）。 */
export const SYNTH_TIMEOUT_MS = 30000;
/** PowerShell 可执行文件候选（按顺序回退）。 */
const PLAYER_BIN_CANDIDATES = ["pwsh", "powershell"] as const;
/** 传给播放子进程的 WAV 路径环境变量。 */
const ENV_WAV_PATH = "OC_TTS_WAV";
/** SoundPlayer 播放脚本（WAV 路径走环境变量，无注入面）。 */
const PLAYER_SCRIPT = `$ErrorActionPreference='Stop'; (New-Object System.Media.SoundPlayer $env:${ENV_WAV_PATH}).PlaySync()`;
/** 播放参数。 */
const PLAYER_ARGS = ["-NoProfile", "-NonInteractive", "-Command", PLAYER_SCRIPT];

/** 解析后的 CosyVoice 合成参数。 */
export interface CosyVoiceParams {
  model: string;
  voice: string;
  format: string;
  sampleRate: number;
  volume: number;
  rate: number;
  pitch: number;
  instruction: string;
}

/** 服务端事件的最小结构。 */
interface ServerMessage {
  header?: { event?: string; error_code?: string; error_message?: string };
}

/** 夹取到区间。 */
function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * 按 workspace 拼接 CosyVoice WebSocket 端点。
 * @param workspace 业务空间 ID
 * @returns wss URL
 */
export function buildTtsUrl(workspace: string): string {
  return TTS_URL_TEMPLATE.replace("{workspace}", workspace);
}

/**
 * 把配置解析为 CosyVoice 参数（越界/非法回退默认；0/空 = 未指定）。
 * @param options 解析后的朗读参数
 * @returns CosyVoice 参数
 */
export function resolveCosyVoiceParams(options: ResolvedTtsOptions): CosyVoiceParams {
  const format = TTS_FORMATS.includes(options.format.trim()) ? options.format.trim() : DEFAULT_FORMAT;
  const sampleRate = TTS_SAMPLE_RATES.includes(options.sampleRate) ? options.sampleRate : DEFAULT_SAMPLE_RATE;
  const volume = Number.isFinite(options.volume) && options.volume > 0 ? clamp(options.volume, 0, 100) : DEFAULT_VOLUME;
  const rate = Number.isFinite(options.rate) && options.rate > 0 ? clamp(options.rate, MIN_SPEED, MAX_SPEED) : DEFAULT_SPEED;
  const pitch =
    Number.isFinite(options.pitch) && options.pitch > 0 ? clamp(options.pitch, MIN_PITCH, MAX_PITCH) : DEFAULT_PITCH;
  return {
    model: options.model.trim() || DEFAULT_COSYVOICE_MODEL,
    voice: options.voice.trim() || DEFAULT_COSYVOICE_VOICE,
    format,
    sampleRate,
    volume,
    rate,
    pitch,
    instruction: options.instruction.trim(),
  };
}

/**
 * 构造 `run-task` 消息（纯函数，便于单测）。
 * @param params taskId + 合成参数
 * @returns 完整消息体
 */
export function buildCosyVoiceRunTask(params: { taskId: string } & CosyVoiceParams): Record<string, unknown> {
  const parameters: Record<string, unknown> = {
    text_type: "PlainText",
    voice: params.voice,
    format: params.format,
    sample_rate: params.sampleRate,
    volume: params.volume,
    rate: params.rate,
    pitch: params.pitch,
  };
  if (params.instruction) parameters.instruction = params.instruction;
  return {
    header: { action: "run-task", task_id: params.taskId, streaming: "duplex" },
    payload: {
      task_group: "audio",
      task: "tts",
      function: "SpeechSynthesizer",
      model: params.model,
      input: {},
      parameters,
    },
  };
}

/**
 * 构造 `continue-task`（承载正文）消息（纯函数）。
 * @param taskId 任务 ID
 * @param text 待合成文本
 * @returns 完整消息体
 */
export function buildCosyVoiceContinueTask(taskId: string, text: string): Record<string, unknown> {
  return {
    header: { action: "continue-task", task_id: taskId, streaming: "duplex" },
    payload: { input: { text } },
  };
}

/**
 * 构造 `finish-task` 消息（纯函数）。
 * @param taskId 任务 ID
 * @returns 完整消息体
 */
export function buildCosyVoiceFinishTask(taskId: string): Record<string, unknown> {
  return { header: { action: "finish-task", task_id: taskId, streaming: "duplex" }, payload: { input: {} } };
}

/**
 * 修正流式 WAV 的 RIFF/`data` 块长度字段（纯函数）。
 *
 * 背景：CosyVoice 返回的是**流式 WAV**，其 RIFF 总长与 `data` 块长度是占位值（约 2GB），
 * 而 `System.Media.SoundPlayer` 不会因此报错，只会按占位长度读到"立刻 EOF"，从而**静默不出声**
 * （实测：原样 WAV PlaySync 仅阻塞 11ms，修正头后 784ms）。本函数按实际字节数重写两处长度。
 * @param buf 完整 WAV 字节
 * @returns 头部长度已修正的新 WAV 字节（不改动入参）
 * @throws Error 不是合法 WAV（缺少 RIFF/WAVE 标识）
 */
export function normalizeWavHeader(buf: Buffer): Buffer {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("不是合法的 WAV 文件（缺少 RIFF/WAVE 标识）");
  }
  const out = Buffer.from(buf);
  let pos = 12;
  while (pos + 8 <= out.length) {
    const id = out.toString("ascii", pos, pos + 4);
    const declared = out.readUInt32LE(pos + 4);
    const body = pos + 8;
    // 声明长度越界时夹取到剩余字节，避免跳过真正的 data 块
    const size = Math.min(declared, out.length - body);
    if (id === "data") out.writeUInt32LE(size, pos + 4);
    pos = body + size + (size % 2);
  }
  out.writeUInt32LE(out.length - 8, 4);
  return out;
}

/** 阿里云 CosyVoice TTS provider（单实例；新 speak 打断旧朗读）。 */
export class AliyunProvider implements TtsProvider {
  readonly name = ALIYUN_PROVIDER_NAME;
  private readonly log: Logger = createLogger("tts-aliyun");
  private ws: WebSocket | null = null;
  private player: ChildProcess | null = null;
  private tmpDir: string | null = null;
  private activeToken = "";

  /**
   * 后台合成并播放：立即返回（不等待合成/播放完成）；内部先打断上一次。
   * @param options 解析后的朗读参数（含凭证配置）
   * @returns 本次朗读的启动结果
   * @throws Error 平台不支持 / 文本为空 / 凭证缺失 / 配置非法
   */
  speak(options: ResolvedTtsOptions): SpeakResult {
    if (process.platform !== "win32") {
      throw new Error("aliyun(CosyVoice) 播放仅支持 Windows；其它平台请改用 sapi 或本地播放器");
    }
    if (options.text.trim().length === 0) {
      throw new Error("text 不能为空");
    }
    const params = resolveCosyVoiceParams(options);
    const credentials = resolveCredentials({ config: options.credentials as CredentialFileConfig | undefined });
    this.stop();
    const token = randomBytes(8).toString("hex");
    this.activeToken = token;
    void this.run(options.text, params, credentials, token).catch((err: unknown) => {
      this.log.error("CosyVoice 合成/播放失败", err instanceof Error ? err : String(err));
    });
    return { provider: this.name, voice: params.voice, rate: params.rate };
  }

  /** 打断：关闭连接、杀掉播放进程、删除临时目录（幂等）。 */
  stop(): void {
    this.activeToken = "";
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
      } catch {
        // 关闭阶段异常忽略
      }
    }
    const player = this.player;
    this.player = null;
    if (player && player.exitCode === null) {
      try {
        player.kill();
      } catch (err) {
        this.log.warn("停止 CosyVoice 播放进程失败", err as Error);
      }
    }
    this.cleanupTemp();
  }

  /**
   * 完整流程：合成 → 转码（非 wav）→ 落盘 → 播放。
   * @param text 文本
   * @param params 合成参数
   * @param credentials 凭证
   * @param token 本次调用令牌（被打断则中止）
   */
  private async run(text: string, params: CosyVoiceParams, credentials: Credentials, token: string): Promise<void> {
    const taskId = randomUUID();
    const audio = await this.synthesize(taskId, text, params, credentials);
    if (this.activeToken !== token) return;
    if (audio.length === 0) {
      throw new Error("CosyVoice 未返回音频数据（服务端可能返回了空结果或 task-failed）");
    }
    const raw = params.format === "wav" ? audio : await decodeToWav(audio, params.format, params.sampleRate);
    if (this.activeToken !== token) return;
    // 直接透传的流式 WAV 头部长度是占位值，SoundPlayer 会据此静默不出声，须先修正
    const file = this.writeTemp(normalizeWavHeader(raw));
    if (this.activeToken !== token) {
      this.cleanupTemp();
      return;
    }
    this.play(file);
  }

  /**
   * 建立 WebSocket 并完成一次 CosyVoice 合成，返回云端音频字节。
   * @param taskId 任务 ID
   * @param text 文本
   * @param params 合成参数
   * @param credentials 凭证
   * @returns 合成音频字节
   */
  private synthesize(
    taskId: string,
    text: string,
    params: CosyVoiceParams,
    credentials: Credentials,
  ): Promise<Buffer> {
    return new Promise<Buffer>((resolveSynth, rejectSynth) => {
      const chunks: Buffer[] = [];
      let settled = false;
      const ws = new WebSocket(buildTtsUrl(credentials.workspace), {
        headers: {
          Authorization: `Bearer ${credentials.apiKey}`,
          "X-DashScope-WorkSpace": credentials.workspace,
        },
      });
      this.ws = ws;
      const finish = (error?: Error, audio?: Buffer): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.ws === ws) this.ws = null;
        try {
          ws.close();
        } catch {
          // 忽略
        }
        if (error) rejectSynth(error);
        else resolveSynth(audio ?? Buffer.alloc(0));
      };
      const timer = setTimeout(() => finish(new Error(`CosyVoice 合成超时（${SYNTH_TIMEOUT_MS}ms）`)), SYNTH_TIMEOUT_MS);

      ws.on("open", () => {
        this.send(ws, buildCosyVoiceRunTask({ taskId, ...params }));
      });
      ws.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
        if (isBinary) {
          chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
          return;
        }
        let message: ServerMessage;
        try {
          message = JSON.parse(data.toString()) as ServerMessage;
        } catch {
          return;
        }
        switch (message.header?.event) {
          case "task-started":
            this.send(ws, buildCosyVoiceContinueTask(taskId, text));
            this.send(ws, buildCosyVoiceFinishTask(taskId));
            break;
          case "task-finished":
            finish(undefined, Buffer.concat(chunks));
            break;
          case "task-failed":
            finish(
              new Error(
                redact(`CosyVoice 合成失败：${message.header?.error_message ?? "未知错误"}`, credentials.apiKey),
              ),
            );
            break;
          default:
            break;
        }
      });
      ws.on("error", (err: Error) => finish(new Error(redact(err.message, credentials.apiKey))));
      ws.on("close", () => {
        if (!settled) finish(new Error("CosyVoice 连接提前关闭"));
      });
    });
  }

  /** 发送一条 JSON 文本帧（连接不可用时忽略）。 */
  private send(ws: WebSocket, body: Record<string, unknown>): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(body));
  }

  /**
   * 把 WAV 字节写入专属临时目录。
   * @param wav WAV 字节
   * @returns WAV 文件绝对路径
   */
  private writeTemp(wav: Buffer): string {
    const dir = mkdtempSync(join(tmpdir(), "oc-tts-"));
    this.tmpDir = dir;
    const file = join(dir, "speech.wav");
    writeFileSync(file, wav);
    return file;
  }

  /**
   * 用 PowerShell `System.Media.SoundPlayer` 后台播放（可被 stop 打断）。
   * @param file WAV 文件路径
   */
  private play(file: string): void {
    this.spawnPlayer(0, file);
  }

  /**
   * 按候选顺序启动播放进程；`ENOENT` 时回退下一个候选。
   * @param index 当前候选下标
   * @param file WAV 文件路径
   */
  private spawnPlayer(index: number, file: string): void {
    const bin = PLAYER_BIN_CANDIDATES[index];
    if (bin === undefined) {
      this.log.error("未找到可用 PowerShell（powershell / pwsh），无法播放 CosyVoice 音频");
      this.cleanupTemp();
      return;
    }
    let child: ChildProcess;
    try {
      child = spawn(bin, PLAYER_ARGS, {
        env: { ...process.env, [ENV_WAV_PATH]: file },
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      this.log.error(`启动 ${bin} 失败`, err as Error);
      this.cleanupTemp();
      return;
    }
    this.player = child;
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      const line = String(chunk).trim();
      if (line.length === 0) return;
      stderr = `${stderr}${line}\n`;
      this.log.warn(`aliyun tts stderr: ${line}`);
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (this.player === child) this.player = null;
      if (err.code === "ENOENT" && index + 1 < PLAYER_BIN_CANDIDATES.length) {
        this.spawnPlayer(index + 1, file);
        return;
      }
      this.log.error(`CosyVoice 播放进程异常（${bin}）`, err);
      this.cleanupTemp();
    });
    child.on("exit", (code: number | null) => {
      if (this.player === child) this.player = null;
      // 非 0 退出码说明播放入口失败（此前会被静默忽略）；记日志以便排查
      if (code !== null && code !== 0) {
        this.log.error(`CosyVoice 播放进程（${bin}）退出码=${code}`, stderr.trim() || undefined);
      }
      this.cleanupTemp();
    });
  }

  /** 删除当前临时目录（幂等）。 */
  private cleanupTemp(): void {
    const dir = this.tmpDir;
    this.tmpDir = null;
    if (!dir) return;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      this.log.warn("清理 CosyVoice 临时目录失败", err as Error);
    }
  }
}
