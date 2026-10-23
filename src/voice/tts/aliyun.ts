/**
 * 阿里云百炼 **CosyVoice** TTS provider（WebSocket `run-task` 协议）——**流式**实现。
 *
 * 接入方式（官方当前推荐，见 `docs/设计-语音输入注入.md` §11）：
 *   `wss://{workspace}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference`
 *   握手头 `Authorization: Bearer <apiKey>` + `X-DashScope-WorkSpace: <workspace>`；
 *   流程：`run-task` → 收 `task-started` → **多条 `continue-task`（增量送入正文）** → `finish-task`
 *   → 二进制音频帧**边到边播** → `task-finished`。
 *
 * 流式播放（`docs/设计-语音输入注入.md` §15）：
 * - 合成固定 `format=pcm`（裸 s16le 单声道），不做「整段合成→落盘→播」；
 * - **纯流式送文**（`stream.ts` 的 `createStreamChunker`）：**不做句切分**，缓冲到 ≥ `tts.streamMinChars`
 *   才首次 `continue-task`，之后随到随发；仅单条/累计超服务端上限才硬切；
 * - 音频帧到达即交给 `audio-sink.ts`：优先写流式播放器 stdin（零落盘）；无流式播放器时
 *   回退「按句边界临时 WAV 顺序播放」（见 `audio-sink.ts`，**此处才用 `splitSentences`**）；
 * - **取消**：`finish-task` 且 `payload.input.directive="cancel"` → 立即停、丢弃后续音频；同连接可再 `run-task`。
 *
 * 安全：凭证只读、绝不打印；错误文本统一经 `redact()` 脱敏。并发/打断契约见 docs/ASYNC.md 交互点 ⑩。
 */

import { randomBytes, randomUUID } from "node:crypto";

import createLogger from "@xiaoqiong0v0/opencode-plugin-logger";
import type { Logger } from "@xiaoqiong0v0/opencode-plugin-logger";
import WebSocket from "ws";

import { redact, resolveCredentials, type CredentialFileConfig, type Credentials } from "../credentials.js";
import { createProviderSink, type AudioSink } from "./audio-sink.js";
import { splitSentences } from "./sentences.js";
import { createStreamChunker, normalizeStreamMinChars, DEFAULT_STREAM_MIN_CHARS, MAX_CONTINUE_CHARS, MAX_TOTAL_CHARS } from "./stream.js";
import type { ResolvedTtsOptions, SpeakResult, TtsProvider } from "./types.js";

export { MAX_CONTINUE_CHARS, MAX_TOTAL_CHARS } from "./stream.js";
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
/**
 * 默认输出格式（历史口径；生产流式路径固定 `STREAM_FORMAT=pcm`，本值仅参与「忽略 format」比较、不再驱动落盘格式）。
 */
export const DEFAULT_FORMAT = "wav";
/** 流式合成固定使用的输出格式（裸 PCM，供 stdin 播放器/low-latency）。 */
export const STREAM_FORMAT = "pcm";
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
/** 支持 `instruction` 风格指令的模型前缀（v3/v3.5 与 qwen-audio-3.x；v2 不支持）。 */
export const INSTRUCTION_MODEL_PREFIXES: readonly string[] = ["cosyvoice-v3", "qwen-audio-3"];

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
 * 该模型是否支持 `instruction`（风格/情感/方言指令）。
 * 官方：仅 cosyvoice-v3 / v3.5 与 qwen-audio-3.x 支持；**cosyvoice-v2 不支持**。
 * @param model 模型名
 * @returns 支持 true
 */
export function supportsInstruction(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return INSTRUCTION_MODEL_PREFIXES.some((prefix) => normalized.startsWith(prefix));
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
 * 构造 `finish-task` + `directive:"cancel"` 取消消息（纯函数）。
 * 服务端收到后**立即停止**合成并丢弃后续音频；同一连接可再次 `run-task`（北京 CosyVoice v2+）。
 * @param taskId 任务 ID
 * @returns 完整消息体
 */
export function buildCosyVoiceCancelTask(taskId: string): Record<string, unknown> {
  return {
    header: { action: "finish-task", task_id: taskId, streaming: "duplex" },
    payload: { input: { directive: "cancel" } },
  };
}

/**
 * 修正流式 WAV 的 RIFF/`data` 块长度字段（纯函数）。
 *
 * 说明：流式路径改走**裸 PCM**（不再落 WAV），本函数仅保留给历史/全量 WAV 路径与兼容用途；
 * 对正常 WAV 幂等。背景：CosyVoice 的流式 WAV 头部长度是占位值（约 2GB），
 * `System.Media.SoundPlayer` 会据此静默不出声，故按实际字节数重写两处长度。
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

/** 服务端连接/事件回调。 */
interface SessionHandlers {
  onAudio: (chunk: Buffer) => void;
}

/**
 * 一次 CosyVoice 流式会话（`run-task` → `continue-task`* → `finish-task`，音频帧回调解出）。
 * 单实例单连接；`cancel()` 发 `directive=cancel` 并关闭连接。
 */
class CosyVoiceSession {
  private ws: WebSocket | null = null;
  private started = false;
  private settled = false;
  private timer: NodeJS.Timeout | null = null;
  private startResolve: (() => void) | null = null;
  private startReject: ((err: Error) => void) | null = null;
  private doneResolve: (() => void) | null = null;
  private doneReject: ((err: Error) => void) | null = null;
  private readonly donePromise: Promise<void>;

  /**
   * @param taskId 任务 ID
   * @param params 合成参数
   * @param credentials 凭证
   * @param handlers 音频回调
   * @param log 日志器
   */
  constructor(
    private readonly taskId: string,
    private readonly params: CosyVoiceParams,
    private readonly credentials: Credentials,
    private readonly handlers: SessionHandlers,
    private readonly log: Logger,
  ) {
    this.donePromise = new Promise<void>((resolveDone, rejectDone) => {
      this.doneResolve = resolveDone;
      this.doneReject = rejectDone;
    });
  }

  /** 建立连接并发 `run-task`，在收到 `task-started` 后 resolve。 */
  start(): Promise<void> {
    return new Promise<void>((resolveStart, rejectStart) => {
      this.startResolve = resolveStart;
      this.startReject = rejectStart;
      let ws: WebSocket;
      try {
        ws = new WebSocket(buildTtsUrl(this.credentials.workspace), {
          headers: {
            Authorization: `Bearer ${this.credentials.apiKey}`,
            "X-DashScope-WorkSpace": this.credentials.workspace,
          },
        });
      } catch (err) {
        this.fail(this.redactError(err));
        return;
      }
      this.ws = ws;
      this.timer = setTimeout(() => this.fail(new Error(`CosyVoice 合成超时（${SYNTH_TIMEOUT_MS}ms）`)), SYNTH_TIMEOUT_MS);
      ws.on("open", () => this.send(buildCosyVoiceRunTask({ taskId: this.taskId, ...this.params })));
      ws.on("message", (data: WebSocket.RawData, isBinary: boolean) => this.handleMessage(data, isBinary));
      ws.on("error", (err: Error) => this.fail(this.redactError(err)));
      ws.on("close", () => {
        if (!this.settled) this.fail(new Error("CosyVoice 连接提前关闭"));
      });
    });
  }

  /** 发送一条 `continue-task`（承载增量正文）。 */
  pushText(text: string): void {
    this.send(buildCosyVoiceContinueTask(this.taskId, text));
  }

  /** 发送 `finish-task`（正文送完）。 */
  finish(): void {
    this.send(buildCosyVoiceFinishTask(this.taskId));
  }

  /** 播放真正结束（`task-finished` 或失败）时 settle。 */
  done(): Promise<void> {
    return this.donePromise;
  }

  /** 取消：发 `directive=cancel` 并关闭连接（幂等；settle 为正常结束）。 */
  cancel(): void {
    if (!this.settled) {
      const ws = this.ws;
      if (this.started && ws && ws.readyState === WebSocket.OPEN) this.send(buildCosyVoiceCancelTask(this.taskId));
      this.settled = true;
      this.clearTimer();
      this.startResolve?.();
      this.doneResolve?.();
    }
    this.close();
  }

  /** 处理一条服务端消息。 */
  private handleMessage(data: WebSocket.RawData, isBinary: boolean): void {
    if (isBinary) {
      if (this.settled) return;
      try {
        this.handlers.onAudio(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
      } catch (err) {
        this.log.warn("CosyVoice 音频帧写出失败", err as Error);
      }
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
        this.started = true;
        this.clearTimer();
        this.startResolve?.();
        this.startResolve = null;
        this.startReject = null;
        break;
      case "task-finished":
        this.finishSuccess();
        break;
      case "task-failed":
        this.fail(this.redactError(new Error(`CosyVoice 合成失败：${message.header?.error_message ?? "未知错误"}`)));
        break;
      default:
        break;
    }
  }

  /** 成功结束：settle done，关闭连接。 */
  private finishSuccess(): void {
    if (this.settled) return;
    this.settled = true;
    this.clearTimer();
    this.doneResolve?.();
    this.close();
  }

  /** 失败：若尚未 `task-started` 则 reject `start()`（并 resolve done，避免未处理拒绝）。 */
  private fail(err: Error): void {
    if (this.settled) return;
    this.settled = true;
    this.clearTimer();
    this.close();
    if (!this.started) {
      this.doneResolve?.();
      this.startReject?.(err);
      this.startResolve = null;
      this.startReject = null;
    } else {
      this.doneReject?.(err);
    }
  }

  /** 发送一条 JSON 文本帧（连接不可用时忽略）。 */
  private send(body: Record<string, unknown>): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(body));
  }

  /** 关闭连接。 */
  private close(): void {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    try {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    } catch {
      // 关闭阶段异常忽略
    }
  }

  /** 清除超时定时器。 */
  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** 脱敏任意异常。 */
  private redactError(err: unknown): Error {
    const message = err instanceof Error ? err.message : String(err);
    return new Error(redact(message, this.credentials.apiKey));
  }
}

/** 阿里云 CosyVoice TTS provider（流式；单实例，新 speak 打断旧朗读）。 */
export class AliyunProvider implements TtsProvider {
  readonly name = ALIYUN_PROVIDER_NAME;
  /** 二进制音频帧本就经 AudioSink 落地 ⇒ 支持只合成不出声（预取）。 */
  readonly pcmOutputSupport = true;
  private readonly log: Logger = createLogger("tts-aliyun");
  private session: CosyVoiceSession | null = null;
  private sink: AudioSink | null = null;
  private params: CosyVoiceParams | null = null;
  private credentials: Credentials | null = null;
  private activeToken = "";
  /** 本次朗读的流式最小缓冲阈值（首次 `continue-task` 前需缓冲的字符数）。 */
  private streamMinChars = DEFAULT_STREAM_MIN_CHARS;

  /**
   * 后台流式合成并播放：立即返回（不等待播放完成）；内部先打断上一次。
   * @param options 解析后的朗读参数（含凭证配置）
   * @returns 本次朗读的启动结果（含 `taskId` 与 `done`）
   * @throws Error 无可用播放路径 / 文本为空 / 凭证缺失 / 文本过长
   */
  speak(options: ResolvedTtsOptions): SpeakResult {
    if (options.text.trim().length === 0) {
      throw new Error("text 不能为空");
    }
    const resolved = resolveCosyVoiceParams(options);
    const params: CosyVoiceParams = { ...resolved, format: STREAM_FORMAT };
    // 据实校验：v2 等不支持 instruction 的模型，忽略风格指令（记一条日志，不报错）
    if (params.instruction && !supportsInstruction(params.model)) {
      this.log.info(`模型 ${params.model} 不支持 instruction，已忽略风格指令`);
      params.instruction = "";
    }
    if (resolved.format !== STREAM_FORMAT && resolved.format !== "wav") {
      this.log.info(`流式合成固定使用 ${STREAM_FORMAT}，已忽略 format=${resolved.format}`);
    }
    const credentials = resolveCredentials({
      config: options.credentials as CredentialFileConfig | undefined,
      section: "tts",
      providerLabel: "阿里云 TTS",
    });
    // 音频落地：有 sinkFactory（只合成不出声）时用它；否则在发起时**同步**选定播放路径，
    // 无任何可用路径立刻抛清晰错误（不静默）
    const sink = createProviderSink(options, params.sampleRate, this.log);
    this.stop();
    const token = randomBytes(8).toString("hex");
    this.activeToken = token;
    this.params = params;
    this.credentials = credentials;
    this.streamMinChars = normalizeStreamMinChars(options.streamMinChars);
    this.sink = sink;
    const done = this.run(options.text, token).catch((err: unknown) => {
      this.log.error("CosyVoice 合成/播放失败", err instanceof Error ? err : String(err));
    });
    return { provider: this.name, voice: params.voice, rate: params.rate, taskId: randomUUID(), done };
  }

  /** 打断：取消会话（`directive=cancel`）、关闭连接、中断播放（幂等）。 */
  stop(): void {
    this.activeToken = "";
    const session = this.session;
    this.session = null;
    if (session) session.cancel();
    const sink = this.sink;
    this.sink = null;
    if (sink) sink.abort();
    this.params = null;
    this.credentials = null;
  }

  /**
   * 完整流程（按播放策略分派）：连接 → 送文 → finish → 等待 `task-finished` → 等播放结束。
   * @param text 正文
   * @param token 本次调用令牌（被打断则中止）
   */
  private async run(text: string, token: string): Promise<void> {
    const sink = this.sink;
    const params = this.params;
    const credentials = this.credentials;
    if (!sink || !params || !credentials) return;
    try {
      // stream / pcm-file 都走纯流式送文；只有分段回退（segments）才按句一会话
      if (sink.kind === "segments") {
        await this.runSegmented(text, token, params, credentials, sink);
      } else {
        await this.runStream(text, token, params, credentials, sink);
      }
    } catch (err) {
      sink.abort();
      throw err;
    }
  }

  /**
   * **流式路径**（有 stdin 播放器）：单会话、**纯流式送文**（不做句切分），音频帧到达即写 sink
   * （零落盘、低首包延迟）。
   *
   * 送文口径（`createStreamChunker`）：首次发送前缓冲到 ≥ {@link streamMinChars}，之后随到随发；
   * 仅单条超 `MAX_CONTINUE_CHARS` / 累计超 `MAX_TOTAL_CHARS` 才硬切（正常不会触发）。
   * 注：本路径的正文由**调用方一次性给出**（CLI `speak`）；真正的「边生成边送」在 `auto-read.ts`
   * ——它为每个增量各起一次 CLI，阈值在彼处生效；此处用同一分块器保证口径一致。
   * @param text 正文
   * @param token 令牌
   * @param params 合成参数
   * @param credentials 凭证
   * @param sink 流式 sink
   */
  private async runStream(
    text: string,
    token: string,
    params: CosyVoiceParams,
    credentials: Credentials,
    sink: AudioSink,
  ): Promise<void> {
    if (text.length > MAX_TOTAL_CHARS) {
      throw new Error(`文本过长（${text.length} 字 > 上限 ${MAX_TOTAL_CHARS} 字）`);
    }
    const session = this.newSession(params, credentials, sink);
    this.session = session;
    await session.start();
    if (this.activeToken !== token) return;
    const chunker = createStreamChunker({ minChars: this.streamMinChars, maxChars: MAX_CONTINUE_CHARS });
    const chunks = [...chunker.push(text), ...chunker.flush()];
    for (const chunk of chunks) {
      if (this.activeToken !== token) return;
      session.pushText(chunk);
    }
    session.finish();
    await session.done();
    if (this.activeToken !== token) return;
    await sink.end();
  }

  /**
   * **分段路径**（无 stdin 播放器）：**一句一会话**——每句合成完毕（`task-finished`）即
   * `sink.boundary()` 落成一段，**段边界 = 句边界**（减少段间间隙）；上一段播放期间可继续合成下一句。
   * @param text 正文
   * @param token 令牌
   * @param params 合成参数
   * @param credentials 凭证
   * @param sink 分段 sink
   */
  private async runSegmented(
    text: string,
    token: string,
    params: CosyVoiceParams,
    credentials: Credentials,
    sink: AudioSink,
  ): Promise<void> {
    const { sentences, tail } = splitSentences(text);
    const pieces = tail.length > 0 ? [...sentences, tail] : sentences;
    for (const piece of pieces) {
      if (this.activeToken !== token) return;
      const session = this.newSession(params, credentials, sink);
      this.session = session;
      await session.start();
      if (this.activeToken !== token) return;
      session.pushText(piece);
      session.finish();
      await session.done();
      if (this.activeToken !== token) return;
      sink.boundary();
    }
    if (this.activeToken !== token) return;
    await sink.end();
  }

  /**
   * 新建一次 CosyVoice 会话（音频帧写入给定 sink）。
   * @param params 合成参数
   * @param credentials 凭证
   * @param sink 音频落地
   * @returns 会话实例
   */
  private newSession(params: CosyVoiceParams, credentials: Credentials, sink: AudioSink): CosyVoiceSession {
    return new CosyVoiceSession(
      randomUUID(),
      params,
      credentials,
      { onAudio: (chunk: Buffer) => sink.write(chunk) },
      this.log,
    );
  }
}
