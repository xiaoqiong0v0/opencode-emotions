#!/usr/bin/env node
/**
 * `emotions-cli` 入口（编译到 `dist/cli/emotions-cli.js`）：语音能力的**命令行**前端。
 *
 * 子命令：
 * - `speak --text <t> | --text-file <path> [--emotion <e>] [--voice <v>] [--rate <n>] [--provider <p>] [--background]`
 * - `speak --follow [...]`：常驻 worker——从 **stdin 按行读 UTF-8 文本**连续朗读（每行一块，空行跳过），
 *   EOF 收尾退出；与 `--text`/`--text-file`/`--background` 互斥；provider 需支持 follow（能力位
 *   `TtsProvider.followSupport`，现仅 sapi——一次 PowerShell + ReadLine 循环，无逐块冷启动）。
 * - `devices`：列出本机音频输入设备（ffmpeg dshow）
 * - `status`：查看解析后的语音配置（不打印任何密钥）
 * - `help`：显示用法（随 `toolLanguage` 本地化）
 *
 * 注：**自动朗读开关不在此**——它由 TUI 的 `F10` 热键独占切换（模型不可经 CLI 控制），见 `docs/设计-语音输入注入.md`。
 *
 * 进程模型（`speak`）：
 * - **前台**（默认）：直接调用 TTS provider 合成并播放，进程自然存活到播放结束；
 * - **`--background`**：把真正的合成+播放交给**分离的子进程**（内部子命令 `__play`，参数经环境变量 base64 传入，
 *   不落命令行、不含密钥），本进程立即打印确认并退出。`emotions_cli` 工具用此模式，保持「不卡回合」。
 * - `--text-file`：正文从文件读取（长文本 / 避免把正文拼进命令行）。文件由调用方负责生命周期。
 *
 * 安全：凭证只读、绝不打印；对外错误经 `redact()` 脱敏。
 *
 * 入口保护：`.opencode/plugin/` **顶层**的每个 `.js` 都会被 opencode 当插件自动 import，
 * 故 `main()` 只在「作为入口直接运行」时执行（见 `isDirectEntry()`）；被 import 时无副作用、
 * 不打印任何东西。`main` 一并导出，供单测与程序化调用。
 */

import { spawn } from "node:child_process";
import { closeSync, createReadStream, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import createLogger from "@xiaoqiong0v0/opencode-plugin-logger";
import type { Logger } from "@xiaoqiong0v0/opencode-plugin-logger";

import { format, getPhrases, type CliPhrases } from "../lib/i18n.js";
import type { AutoTtsOptions } from "../voice/auto-tts.js";
import { loadVoiceConfig, loadVoiceConfigWithWarnings } from "../voice/config.js";
import { resolveCredentials, resolveMimoApiKey } from "../voice/credentials.js";
import {
  AWAIT_GO_LINE,
  parseCliArgs,
  PCM_FOLLOW_ABORT_LINE,
  PCM_FOLLOW_DONE_LINE,
  PCM_PLAY_EXIT_PARTIAL,
  PCM_PLAY_STARTED_MARKER,
  PLAY_COMMAND,
  type CliCommand,
} from "../voice/cli.js";
import {
  clearPlayback,
  PLAYBACK_SESSION_ENV,
  stopPlayback,
  writePlayback,
} from "../voice/playback-state.js";
import { normalizeEmotion } from "../voice/tts/emotion.js";
import { MIMO_SAMPLE_RATE } from "../voice/tts/mimo.js";
import { readWavHeader, type WavHeaderInfo } from "../voice/wav.js";
import {
  createAudioSink,
  getProvider,
  PcmFileSink,
  resolveCosyVoiceParams,
  resolveTtsConfig,
  selectAudioStrategy,
  speak,
  DEFAULT_VOICE_LABEL,
  type AudioSink,
  type ResolvedTtsConfig,
  type SpeakResult,
  type TtsProvider,
  type TtsRequest,
} from "../voice/tts/index.js";

/** 内部子进程载荷环境变量（base64(JSON)，避免把文本/参数暴露在命令行）。 */
export const ENV_PLAY_PAYLOAD = "OC_VOICE_PLAY";

const log: Logger = createLogger("emotions-cli");

/** 无法得知时的占位。 */
const NONE = "-";

/**
 * `speak --pcm-file` 在 `tts-playback` 里登记的 provider 名。
 * 它不是真 provider（只播放已有 PCM），故 `activePlayerPid()` 解析会失败并被吞掉。
 */
export const PCM_PLAYBACK_PROVIDER = "pcm";

/**
 * 取 provider 的「真正发声子进程」PID（未知 provider / 未实现一律 undefined，不抛错）。
 * @param provider provider 名
 * @returns 孙进程 PID；无则 undefined
 */
function activePlayerPidOf(provider: string): number | undefined {
  try {
    return getProvider(provider).activePlayerPid?.();
  } catch {
    return undefined;
  }
}

/**
 * 由 speak 命令与正文构造 provider 请求（`--text`/`--text-file`/`--text-stdin`/`--pcm-out` 共用）。
 * @param command 解析后的 speak 命令
 * @param text 已解析的正文（follow 模式传空串）
 * @returns provider 请求
 */
function speakRequestOf(command: Extract<CliCommand, { kind: "speak" }>, text: string): TtsRequest {
  return {
    text,
    voice: command.voice,
    rate: command.rate,
    emotion: command.emotion,
    provider: command.provider,
  };
}

/**
 * 从 stdin 读一行，判断是否为交播闸门放行（`go`）。
 * @param stream 输入流（默认 `process.stdin`）
 * @returns 读到 `go` 行返回 true；流提前 EOF 返回 false（**不播放**）
 */
async function waitForGo(stream: NodeJS.ReadableStream): Promise<boolean> {
  const readable = stream as NodeJS.ReadableStream & { setEncoding?: (encoding: BufferEncoding) => void };
  readable.setEncoding?.("utf8");
  let buffer = "";
  for await (const chunk of readable) {
    buffer += typeof chunk === "string" ? chunk : String(chunk);
    const newline = buffer.indexOf("\n");
    if (newline >= 0) return buffer.slice(0, newline).trim() === AWAIT_GO_LINE;
    // 容错：父进程若只写 `go` 未带换行也视为放行（不会误判更长内容）
    if (buffer.trim() === AWAIT_GO_LINE) return true;
  }
  return false;
}

/** `__play` 子进程载荷。 */
interface PlayPayload {
  text: string;
  voice?: string;
  rate?: number;
  emotion?: string;
  provider?: string;
}

/** 把任意异常转为字符串。 */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 写一行到 stdout。 */
function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** 写一行到 stderr。 */
function err(line: string): void {
  process.stderr.write(`${line}\n`);
}

/**
 * 读完整个 stdin（UTF-8 原文，不去空白）。
 *
 * 用途：`speak --text-stdin`——工具层把正文经 stdin 传入，彻底绕开 Windows 命令行 8191 字符上限与
 * shell 的变量/运算符展开（`&`、`%USERNAME%`、引号都原样保留）。
 * @returns stdin 全文
 */
async function readStdinAll(): Promise<string> {
  const chunks: string[] = [];
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? chunk : String(chunk));
  }
  return chunks.join("");
}

/**
 * 解析本次朗读的正文（`--text-file` 优先，其次 `--text-stdin`，最后 `--text`）。
 * @param command speak 命令
 * @returns 正文；文件读取失败时抛错
 */
async function resolveSpeakText(command: Extract<CliCommand, { kind: "speak" }>): Promise<string> {
  if (command.textFile) return readFileSync(command.textFile, "utf8").trim();
  if (command.textStdin) return readStdinAll();
  return command.text;
}

/**
 * 登记本次播放（PID + playerPid + provider + taskId + **会话归属**）并挂信号/退出收尾。
 *
 * 目的：让**另一个进程**（server 插件的 `chat.message`、TUI 的 `F8/F9`/`F10`）能按 PID 打断本进程；
 * `SIGTERM` 时先请 provider 取消（云 TTS 发 `directive=cancel`）再退出，并清理共享状态。
 *
 * `playerPid`（真正发声的孙进程，如 sapi 的 PowerShell）：`provider.speak()` 是**同步返回**的、
 * 发声子进程在 `speak()` 内已 spawn ⇒ 此处读一次 `activePlayerPid?.()` 即为当前孙进程 PID
 * （一次写盘即可，无需轮询补写；若日后有 provider 改为异步 spawn，需在这里补「读到非空再写」）。
 * 流式 waveOut/aliyun/mimo 无独立发声子进程 → 不写 `playerPid`（JSON 自动省略，保持旧格式兼容）。
 *
 * **会话归属走 env**（`EMOTIONS_SESSION_ID`，见 `PLAYBACK_SESSION_ENV`）：auto-read 派生 CLI 时按消息
 * sessionID 注入、这里读入条目——**免改 argv 解析**；手动 speak 未设置 ⇒ 条目无主（任何消息可打断，有意兼容）。
 * `options`（`dataDir` 注入）仅供单测隔离真实状态目录，生产不传。
 * @param fields 登记字段（provider 必填；taskId 为云 TTS 任务 id）
 * @param options 状态路径选项（默认真实配置根）
 */
export function registerPlaybackLifecycle(
  fields: { provider: string; taskId?: string; playerPid?: number },
  options: AutoTtsOptions = {},
): void {
  writePlayback(
    {
      pid: process.pid,
      // 显式传入优先（`--pcm-file` 无 provider 实例）；未知 provider 解析失败按「无孙进程」处理
      playerPid: fields.playerPid ?? activePlayerPidOf(fields.provider),
      provider: fields.provider,
      taskId: fields.taskId,
      startedAt: Date.now(),
      kind: "speak",
      sessionID: process.env[PLAYBACK_SESSION_ENV]?.trim() || undefined,
    },
    options,
  );
  const cleanup = (): void => clearPlayback(process.pid, options);
  process.once("exit", cleanup);
  const onSignal = (): void => {
    try {
      getProvider(fields.provider).stop();
    } catch {
      // 停止失败忽略（进程随后强制退出）
    }
    cleanup();
    process.exit(0);
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
}

/**
 * 等本次朗读真正结束并清理 `tts-playback` 登记（成功/失败都清）。
 *
 * 为什么必须 `await` 到 `done` 才清：本地 provider（sapi/termux）的 `speak()` 是同步 spawn、
 * 旧实现不返回 `done` ⇒ 条目在开播瞬间就被删掉，播放期间 F8/F9/F10 与 ASR 半双工门都看不到它
 * （无法打断、可叠播）。现在所有 provider 都返回 `done`，本函数是**唯一**的收尾清理点。
 * @param result provider 的启动结果（`done` 缺省视为已完成）
 * @param options 状态路径选项（单测注入临时目录）
 * @throws 播放失败时把 provider 的可识别错误原样抛给调用方（退出码 1）
 */
export async function awaitPlayback(result: SpeakResult, options: AutoTtsOptions = {}): Promise<void> {
  try {
    await (result.done ?? Promise.resolve());
  } finally {
    clearPlayback(process.pid, options);
  }
}

/**
 * 从 stdin 按行读取 UTF-8 文本并逐行回调（`\r\n` 兼容；空行跳过；末行无换行也作为一行）。
 * stdin 结束（EOF）后 resolve；读取错误或回调抛错时 reject（for-await 自然传播）。
 * @param onLine 每非空行回调（同步；抛错即停止读取并向上抛）
 */
async function readStdinLines(onLine: (line: string) => void): Promise<void> {
  const stdin = process.stdin;
  stdin.setEncoding("utf8");
  let buffer = "";
  for await (const chunk of stdin) {
    buffer += typeof chunk === "string" ? chunk : String(chunk);
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const raw = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (line.trim().length > 0) onLine(line);
      index = buffer.indexOf("\n");
    }
  }
  // EOF 时缓冲里可能还有未带换行的末行
  if (buffer.trim().length > 0) onLine(buffer);
}

/**
 * 执行 `speak --follow`（常驻 worker）：从 stdin 按行读 UTF-8 文本，对**同一 provider 实例**连续
 * speak（每行一块；空行跳过）；stdin EOF → 收尾退出（关常驻发声子进程输入流并等退出，冲刷尾音）。
 * provider 走 TTS_PROVIDER 解析链（env→config→默认），不支持 follow 时 i18n 报错退出（exit 1）。
 * 启动即登记 `tts-playback`（pid + playerPid=常驻 PowerShell）——stopPlayback 双杀即静音。
 * @param command 解析后的 speak 命令（`follow=true`；正文来源是 stdin，`text` 恒空）
 * @returns 退出码（0 成功；行写入失败/provider 异常为 1）
 */
async function runSpeakFollow(command: Extract<CliCommand, { kind: "speak" }>): Promise<number> {
  const config = loadVoiceConfig();
  const phrases = getPhrases(config.toolLanguage);
  const request = speakRequestOf(command, "");
  let resolved!: ResolvedTtsConfig;
  let provider!: TtsProvider;
  try {
    resolved = resolveTtsConfig(request, process.env, config.tts);
    provider = getProvider(resolved.provider);
  } catch (error) {
    err(format(phrases.cli.speakFailed, { message: errText(error) }));
    return 1;
  }
  if (
    provider.followSupport !== true ||
    typeof provider.followStart !== "function" ||
    typeof provider.followLine !== "function" ||
    typeof provider.followEnd !== "function"
  ) {
    err(format(phrases.cli.followUnsupported, { provider: resolved.provider }));
    return 1;
  }
  try {
    // 只清本会话（含无主）再开播：跨会话混音——B 会话开播不杀 A 会话；无 env（手动/工具）= 无参全清（既有语义）
    stopPlayback({ sessionID: process.env[PLAYBACK_SESSION_ENV]?.trim() || undefined });
    provider.followStart({
      text: "",
      voice: resolved.voice,
      rate: resolved.rate,
      instruction: resolved.instruction,
      pitch: resolved.pitch,
      volume: resolved.volume,
      format: resolved.format,
      sampleRate: resolved.sampleRate,
      model: resolved.model,
      streamMinChars: resolved.streamMinChars,
      credentials: config.tts.credentials,
    });
  } catch (error) {
    err(format(phrases.cli.speakFailed, { message: errText(error) }));
    return 1;
  }
  // 登记 pid + playerPid + 会话归属：followStart 同步 spawn 常驻 PowerShell ⇒ activePlayerPid() 此刻即其 PID
  // （登记/信号收尾与前台 speak 共用 registerPlaybackLifecycle，sessionID 同样经 env 读入）
  registerPlaybackLifecycle({ provider: resolved.provider });
  // 收尾（EOF/异常路径显式清状态；exit/信号清理由 register 内部兜底）
  const cleanup = (): void => clearPlayback(process.pid);
  out(
    format(phrases.cli.speakStarted, {
      provider: resolved.provider,
      voice: resolved.voice || DEFAULT_VOICE_LABEL,
      rate: resolved.rate,
      emotion: normalizeEmotion(command.emotion) ?? NONE,
    }),
  );
  try {
    await readStdinLines((line) => provider.followLine!(line));
  } catch (error) {
    // 行写入失败（常驻子进程死亡）/ stdin 读取错误：报错退出，auto-read 据 worker 退出停读该消息
    err(format(phrases.cli.speakFailed, { message: errText(error) }));
    try {
      provider.stop();
    } catch {
      // 忽略
    }
    cleanup();
    return 1;
  }
  try {
    // EOF 收尾：关常驻子进程 stdin → ReadLine 返回 null → Speak 冲刷尾音 → 退出（有界超时强杀）
    await provider.followEnd!();
  } catch (error) {
    log.warn("follow 收尾失败", error as Error);
  }
  cleanup();
  return 0;
}

/**
 * `speak --pcm-file` 的可注入依赖（单测用；生产全部走真实实现）。
 */
export interface PlayPcmFileDeps {
  /** 音频落地工厂（缺省按采样率选流式/分段播放策略）。 */
  createSink?: (sampleRate: number) => AudioSink;
  /** WAV 头读取（缺省 `readWavHeader`）。 */
  readHeader?: (path: string) => WavHeaderInfo;
  /** 交播闸门等待（缺省读 `process.stdin` 一行 `go`；**仅静态模式**用）。 */
  awaitGo?: (stream: NodeJS.ReadableStream) => Promise<boolean>;
  /** 跟随增长模式的**控制行来源**（缺省 `process.stdin`；单测注入 PassThrough）。 */
  controlStream?: NodeJS.ReadableStream;
  /** 跟随增长模式的文件轮询间隔（毫秒；缺省 {@link PCM_FOLLOW_POLL_MS}）。 */
  followPollMs?: number;
  /** 跟随增长模式等首个 WAV 头的上限（毫秒；缺省 {@link PCM_FOLLOW_HEADER_TIMEOUT_MS}）。 */
  followHeaderTimeoutMs?: number;
  /** `tts-playback` 登记（缺省 `registerPlaybackLifecycle`）。 */
  registerPlayback?: (provider: string) => void;
  /** 清理 `tts-playback` 登记（缺省按本进程 PID 清）。 */
  clearPlayback?: () => void;
  /** 打印「开始出声」标记（缺省写 stdout；单测可注入 no-op 避免污染测试输出）。 */
  announceStart?: () => void;
}

/** 跟随增长模式的轮询间隔（毫秒）：文件暂时没有新字节时多久再看一次。15ms ≈ 半帧音频，播放器预读足以吸收。 */
export const PCM_FOLLOW_POLL_MS = 15;
/** 跟随增长模式的单次读块上限（字节）：64KB ≈ 0.67s@48kHz，一轮系统调用即可补齐。 */
export const PCM_FOLLOW_READ_CHUNK_BYTES = 64 * 1024;
/** 跟随增长模式等首个 WAV 头的上限（毫秒）：合成进程构造 sink 时立刻写头，正常远小于 1s。 */
export const PCM_FOLLOW_HEADER_TIMEOUT_MS = 30_000;
/** 16bit 单声道采样点字节数：跟随读只写完整采样点（绝不产生半样本/撕裂）。 */
const PCM_SAMPLE_BYTES = 2;

/** 跟随模式写端的结束原因（由 stdin 控制行推导）。 */
type WriterEnd = "done" | "abort" | "eof";

/** 跟随模式的控制行通道（stdin 按行协议 → 可 await 的队列）。 */
interface ControlChannel {
  /** 取下一条控制行；通道已结束（EOF/错误）返回 null。 */
  next(): Promise<string | null>;
  /** 结束通道并移除监听（幂等）。 */
  close(): void;
}

/**
 * 打开跟随模式的控制行通道。
 * @param stream 输入流（生产 `process.stdin`；单测注入 PassThrough）
 * @returns 可 await 的控制行通道
 */
function openControlChannel(stream: NodeJS.ReadableStream): ControlChannel {
  const lines: string[] = [];
  const waiters: Array<(line: string | null) => void> = [];
  let buffer = "";
  let closed = false;
  const readable = stream as NodeJS.ReadableStream & { setEncoding?: (encoding: BufferEncoding) => void };
  readable.setEncoding?.("utf8");
  const push = (line: string): void => {
    const waiter = waiters.shift();
    if (waiter) waiter(line);
    else lines.push(line);
  };
  const onData = (chunk: string | Buffer): void => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      push(buffer.slice(0, newline).trim());
      buffer = buffer.slice(newline + 1);
    }
  };
  /** 通道结束：补发最后一行（无换行容错），再把等待者一律唤醒为 null。 */
  const finish = (): void => {
    if (closed) return;
    closed = true;
    if (buffer.trim().length > 0) push(buffer.trim());
    buffer = "";
    while (waiters.length > 0) (waiters.shift() as (line: string | null) => void)(null);
  };
  readable.on("data", onData);
  readable.on("end", finish);
  readable.on("error", finish);
  return {
    next(): Promise<string | null> {
      const line = lines.shift();
      if (line !== undefined) return Promise.resolve(line);
      if (closed) return Promise.resolve(null);
      return new Promise<string | null>((resolve) => waiters.push(resolve));
    },
    close(): void {
      finish();
      readable.off("data", onData);
      readable.off("end", finish);
      readable.off("error", finish);
    },
  };
}

/**
 * 执行 `speak --pcm-file`：播放一个 PCM（WAV）文件。
 *
 * 两种模式（顺序/门禁契约相同，差别只在「是否等文件写完」）：
 * - **静态**（默认）：文件必须已完整；预热 → 等闸门 `go` → 一次读完 → 播完退出。
 * - **跟随增长**（`--pcm-follow`）：文件仍可能在被合成**增长中**；拿 `go` 后从 data 区当前长度
 *   边到边读（未增长则轮询），写端用控制行 `done`/`abort` 收尾——**交播点不等整段合成完成**。
 *
 * 与普通 `speak` 的关键差异（顺序/门禁契约）：
 * - **不调用 `stopPlayback`**：本模式被上一单元的播放链**提前派生并预热**，若照常开播清场会把
 *   正在播的上一单元杀掉；
 * - **预热阶段不登记 `tts-playback`**（那是「正在播放」的判据）：只有拿到交播闸门（`go`）且
 *   **真正开始写音频前**才登记，避免预取让 F10/ASR 半双工门误判；
 * - 预热（`sink.prewarm`）打开播放器设备但**不写音频** ⇒ 无声；交播后写文件，进程退出 = 播完。
 * @param command 解析后的 speak 命令（`pcmFile` 必填）
 * @param deps 可注入依赖（单测）
 * @returns 退出码（0 成功/闸门未放行；1 文件或播放失败；{@link PCM_PLAY_EXIT_PARTIAL}=已播部分后写端异常）
 */
export async function runPlayPcmFile(
  command: Extract<CliCommand, { kind: "speak" }>,
  deps: PlayPcmFileDeps = {},
): Promise<number> {
  const path = command.pcmFile as string;
  return command.pcmFollow === true ? runPlayGrowingPcmFile(path, deps) : runPlayStaticPcmFile(path, command, deps);
}

/**
 * 静态模式：播放一个**已完整合成**的 PCM（WAV）文件。
 * @param path WAV 路径
 * @param command 解析后的 speak 命令（`awaitGo` 决定是否等交播闸门）
 * @param deps 可注入依赖
 * @returns 退出码
 */
async function runPlayStaticPcmFile(
  path: string,
  command: Extract<CliCommand, { kind: "speak" }>,
  deps: PlayPcmFileDeps,
): Promise<number> {
  const phrases = getPhrases(loadVoiceConfig().toolLanguage);
  const readHeader = deps.readHeader ?? readWavHeader;
  let info: WavHeaderInfo;
  try {
    info = readHeader(path);
    assertPlayableHeader(info, true);
  } catch (error) {
    err(format(phrases.cli.pcmFileInvalid, { message: errText(error) }));
    return 1;
  }
  let sink: AudioSink;
  try {
    sink = deps.createSink
      ? deps.createSink(info.sampleRate)
      : createAudioSink(selectAudioStrategy({ sampleRate: info.sampleRate }), info.sampleRate, log);
  } catch (error) {
    err(format(phrases.cli.speakFailed, { message: errText(error) }));
    return 1;
  }
  // 预热：提前打开设备（waveOut 脚本在 stdin Read 上阻塞 ⇒ 无声），失败由首帧写入重试
  try {
    sink.prewarm?.();
  } catch (error) {
    log.warn("预取播放预热失败（首帧将重试）", error as Error);
  }
  if (command.awaitGo) {
    const go = await (deps.awaitGo ? deps.awaitGo(process.stdin) : waitForGo(process.stdin));
    if (!go) {
      sink.abort();
      return 0;
    }
  }
  // ★ 交播点：此刻才登记「正在播放」（预热阶段不得登记），且不调用 stopPlayback
  const register = deps.registerPlayback ?? ((provider: string) => registerPlaybackLifecycle({ provider }));
  const clear = deps.clearPlayback ?? (() => clearPlayback(process.pid));
  register(PCM_PLAYBACK_PROVIDER);
  (deps.announceStart ?? (() => out(PCM_PLAY_STARTED_MARKER)))();
  try {
    const stream = createReadStream(path, { start: info.dataOffset, end: info.dataOffset + info.dataBytes - 1 });
    for await (const chunk of stream) sink.write(chunk as Buffer);
    sink.boundary();
    await sink.end();
    return 0;
  } catch (error) {
    sink.abort();
    err(format(phrases.cli.speakFailed, { message: errText(error) }));
    return 1;
  } finally {
    clear();
  }
}

/**
 * 跟随增长模式：**边合成边交播**——拿 `go` 后不等整段合成完成，按文件当前长度边到边读。
 *
 * 顺序：闸门 `go`（上一单元播完）→ 写端控制行监听 → 等首个 WAV 头（合成进程构造 sink 时即写）
 * → 预热播放器 → 逐块读取（未增长则轮询）→ 写端 `done` 后收尾；`abort`/EOF 按「已播部分 + 明确错误」退出。
 *
 * 为什么不等整段：长单元合成（6s+）比上一句播放（3s）更久，等整段会把交播点拖到合成结束，
 * 预取收益归零（用户实测句间停顿 ≈4s）。
 * @param path WAV 路径（可能仍在增长）
 * @param deps 可注入依赖
 * @returns 退出码
 */
async function runPlayGrowingPcmFile(path: string, deps: PlayPcmFileDeps): Promise<number> {
  const phrases = getPhrases(loadVoiceConfig().toolLanguage);
  const readHeader = deps.readHeader ?? readWavHeader;
  const control = openControlChannel(deps.controlStream ?? process.stdin);
  const pollMs = Math.max(1, Math.trunc(deps.followPollMs ?? PCM_FOLLOW_POLL_MS));
  const headerTimeoutMs = Math.max(1, Math.trunc(deps.followHeaderTimeoutMs ?? PCM_FOLLOW_HEADER_TIMEOUT_MS));
  try {
    // ① 写端控制行监听（**第一条 = 交播闸门 `go`**，之后才是 done/abort/EOF）。
    //    单读取者：禁止另开一个 `control.next()` 抢闸门行。
    const writer: { end: WriterEnd | null } = { end: null };
    let gateResolve!: (ok: boolean) => void;
    const gate = new Promise<boolean>((resolve) => {
      gateResolve = resolve;
    });
    let gateRead = false;
    /** 闸门是否已放行（同步可见：预热发生在 `go` 之前，不能先 await gate 阻塞预热）。 */
    let gateAllowed = false;
    const writerEnded = new Promise<WriterEnd>((resolve) => {
      void (async () => {
        for (;;) {
          const line = await control.next();
          if (!gateRead) {
            gateRead = true;
            if (line === AWAIT_GO_LINE) {
              gateAllowed = true;
              gateResolve(true);
              continue;
            }
            // 第一条不是 go（含 stdin 先 EOF/父进程取消）：不播，退出 0（旧语义不变）
            gateResolve(false);
            writer.end = "eof";
            resolve("eof");
            return;
          }
          if (line === null) {
            writer.end = "eof";
            resolve("eof");
            return;
          }
          if (line === PCM_FOLLOW_DONE_LINE) {
            writer.end = "done";
            resolve("done");
            return;
          }
          if (line === PCM_FOLLOW_ABORT_LINE) {
            writer.end = "abort";
            resolve("abort");
            return;
          }
          // 未知控制行：忽略（前向兼容）
        }
      })();
    });
    // ② 等首个头（文件可能还没创建/头还没落盘）。头由合成进程构造 sink 时立即写，**不依赖 go**。
    const header = await waitFollowHeader(path, readHeader, writer, writerEnded, headerTimeoutMs, pollMs);
    if (typeof header === "string") {
      // 闸门未放行（父进程取消/未交播）⇒ 当没播，不报错；已放行却仍无合法头才是真错误
      if (!gateAllowed) return 0;
      err(
        format(phrases.cli.pcmFileInvalid, {
          message: header === "timeout" ? `等待音频文件头超时（${headerTimeoutMs}ms）` : `写端提前结束（${header}）`,
        }),
      );
      return 1;
    }
    try {
      assertPlayableHeader(header, false);
    } catch (error) {
      err(format(phrases.cli.pcmFileInvalid, { message: errText(error) }));
      return 1;
    }
    let sink: AudioSink;
    try {
      sink = deps.createSink
        ? deps.createSink(header.sampleRate)
        : createAudioSink(selectAudioStrategy({ sampleRate: header.sampleRate }), header.sampleRate, log);
    } catch (error) {
      err(format(phrases.cli.speakFailed, { message: errText(error) }));
      return 1;
    }
    // ③ **预热在闸门之前**：进程只出声前就把播放器打开（waveOut 在 stdin Read 上阻塞 ⇒ 无声），
    //    使 `go` 到首帧的延迟≈0（预热不登记 `tts-playback`）。
    try {
      sink.prewarm?.();
    } catch (error) {
      log.warn("预取播放预热失败（首帧将重试）", error as Error);
    }
    // ④ 闸门未放行（stdin 先 EOF/取消）：不写任何音频，回收 sink 后退出 0
    if (!gateAllowed) {
      const allowed = await gate;
      if (!allowed) {
        sink.abort();
        return 0;
      }
    }
    return await pumpGrowingPcm({ path, header, sink, writer, writerEnded, deps, pollMs, phrases: phrases.cli });
  } finally {
    control.close();
  }
}

/**
 * 等跟随模式的首个 WAV 头出现（与写端结束竞争）。
 * @param path WAV 路径
 * @param readHeader 头读取函数
 * @param writer 写端结束状态（同步可见）
 * @param writerEnded 写端结束 Promise
 * @param timeoutMs 等头上限（毫秒）
 * @param pollMs 轮询间隔（毫秒）
 * @returns 头信息；或写端结束原因 / `timeout`
 * @throws Error 写端已正常结束但头仍非法（真格式错误，不无限等）
 */
async function waitFollowHeader(
  path: string,
  readHeader: (path: string) => WavHeaderInfo,
  writer: { end: WriterEnd | null },
  writerEnded: Promise<WriterEnd>,
  timeoutMs: number,
  pollMs: number,
): Promise<WavHeaderInfo | WriterEnd | "timeout"> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return readHeader(path);
    } catch (error) {
      // 写端已完整结束却仍读不到合法头 ⇒ 真错误（不吞成超时）
      if (writer.end === "done") throw error;
    }
    if (writer.end !== null) return writer.end;
    if (Date.now() >= deadline) return "timeout";
    const winner = await Promise.race([
      writerEnded,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), pollMs)),
    ]);
    if (winner !== null) return winner;
  }
}

/**
 * 跟随读取并播放仍在增长的文件，直到写端结束。
 *
 * 并发契约：写端（另一进程）顺序追加 `data` 区；本函数按 `stat` 到的长度读已落盘部分，
 * 未增长时轮询等待控制行——**只读已完整落盘的字节**，且按 16bit 采样点对齐（奇数字节暂存到下一轮）。
 * @param options 播放所需上下文
 * @returns 退出码（0=完整播完；1=未起播/失败；{@link PCM_PLAY_EXIT_PARTIAL}=已播部分后写端异常）
 */
async function pumpGrowingPcm(options: {
  path: string;
  header: WavHeaderInfo;
  sink: AudioSink;
  writer: { end: WriterEnd | null };
  writerEnded: Promise<WriterEnd>;
  deps: PlayPcmFileDeps;
  pollMs: number;
  phrases: CliPhrases;
}): Promise<number> {
  const { path, header, sink, writer, writerEnded, deps, pollMs, phrases } = options;
  const register = deps.registerPlayback ?? ((provider: string) => registerPlaybackLifecycle({ provider }));
  const clear = deps.clearPlayback ?? (() => clearPlayback(process.pid));
  const announce = deps.announceStart ?? (() => out(PCM_PLAY_STARTED_MARKER));
  let registered = false;
  /** ★ 交播点：首帧音频前才登记 `tts-playback` 并打印「开始出声」标记（预热不算在播）。 */
  const beginPlayback = (): void => {
    if (registered) return;
    registered = true;
    register(PCM_PLAYBACK_PROVIDER);
    announce();
  };
  let fd: number | null = null;
  let position = header.dataOffset;
  /** 上一轮剩下的奇数字节（不足一个采样点），与下一轮拼成完整采样点。 */
  let carry: Buffer = Buffer.alloc(0);
  let playedBytes = 0;
  let result = 0;
  try {
    fd = openSync(path, "r");
    for (;;) {
      const available = statSync(path).size - position;
      if (available > 0) {
        const want = Math.min(available, PCM_FOLLOW_READ_CHUNK_BYTES);
        const buffer = Buffer.allocUnsafe(want);
        const read = readSync(fd, buffer, 0, want, position);
        if (read <= 0) {
          // 文件被截断/写端异常：按写端异常收尾（不得当作读完）
          writer.end = writer.end ?? "abort";
          break;
        }
        position += read;
        const data = carry.length > 0 ? Buffer.concat([carry, buffer.subarray(0, read)]) : buffer.subarray(0, read);
        const aligned = data.length - (data.length % PCM_SAMPLE_BYTES);
        carry = Buffer.from(data.subarray(aligned));
        if (aligned > 0) {
          beginPlayback();
          sink.write(data.subarray(0, aligned));
          playedBytes += aligned;
        }
        continue;
      }
      if (writer.end !== null) break;
      await Promise.race([
        writerEnded,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), pollMs)),
      ]);
    }
    if (writer.end === "done") {
      if (carry.length > 0) {
        // 写端声明完整但残留半个采样点：可见告警（优先保证 16bit 对齐，绝不写半样本）
        log.warn(`跟随播放收到未对齐尾字节（${carry.length}B），已丢弃`);
      }
      sink.boundary();
      await sink.end();
    } else {
      // 写端异常（abort/EOF/截断）：已播部分 + 明确错误，不得静默当完整
      sink.abort();
      err(
        format(phrases.speakFailed, {
          message:
            `写端异常结束（${writer.end ?? "abort"}），本单元只播出已到达的 ${Math.round(playedBytes / (header.sampleRate * PCM_SAMPLE_BYTES) * 1000)}ms` +
            "（不会重读，避免重复）",
        }),
      );
      result = playedBytes > 0 ? PCM_PLAY_EXIT_PARTIAL : 1;
    }
  } catch (error) {
    sink.abort();
    err(format(phrases.speakFailed, { message: errText(error) }));
    // 已播出部分后异常：必须报「已播部分」（3），否则调用方会把 1 当「从未起播」→ 重读 = 双播
    result = playedBytes > 0 ? PCM_PLAY_EXIT_PARTIAL : 1;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // 关闭失败忽略（进程即将退出）
      }
    }
    if (registered) clear();
  }
  return result;
}

/**
 * 校验 WAV 头是否可播放。
 * @param info 头信息
 * @param requireData 是否要求 data 区非空（静态模式必须；跟随模式头先于数据，允许 0）
 * @throws Error 不可播放（位深/声道/data 长度）
 */
function assertPlayableHeader(info: WavHeaderInfo, requireData: boolean): void {
  if (info.bitsPerSample !== 16) throw new Error(`仅支持 16bit PCM（当前 ${info.bitsPerSample}bit）`);
  if (info.channels < 1) throw new Error("声道非法");
  if (requireData && info.dataBytes <= 0) throw new Error("data 区为空");
}

/**
 * 执行 `speak --pcm-out`：**只合成不出声**，把 16bit PCM（WAV 容器）写进临时文件。
 *
 * 复用 provider 合成链路与 `PcmFileSink`（含同一套首尾静音裁剪）；不派生播放器、不登记
 * `tts-playback`。自动朗读预取在上一单元播放期间调用它，随后用 `--pcm-file` 交播。
 * @param command 解析后的 speak 命令（`pcmOut` 必填，正文来源同普通 speak）
 * @returns 退出码（0 成功/空文本跳过；1 失败）
 */
async function runPcmOut(command: Extract<CliCommand, { kind: "speak" }>): Promise<number> {
  const config = loadVoiceConfig();
  const phrases = getPhrases(config.toolLanguage);
  let text: string;
  try {
    text = await resolveSpeakText(command);
  } catch (error) {
    err(format(phrases.cli.speakFailed, { message: `无法读取正文：${errText(error)}` }));
    return 1;
  }
  if (text.trim().length === 0) {
    out(phrases.cli.speakSkipped);
    return 0;
  }
  const request = speakRequestOf(command, text);
  const path = command.pcmOut as string;
  try {
    const resolved = resolveTtsConfig(request, process.env, config.tts);
    if (getProvider(resolved.provider).pcmOutputSupport !== true) {
      err(format(phrases.cli.pcmUnsupported, { provider: resolved.provider }));
      return 1;
    }
    const result = speak(request, {
      config,
      sinkFactory: (sampleRate: number) => new PcmFileSink(path, sampleRate),
    });
    await (result.done ?? Promise.resolve());
    return 0;
  } catch (error) {
    err(format(phrases.cli.speakFailed, { message: errText(error) }));
    return 1;
  }
}

/**
 * 执行 `speak`：前台播放、follow 常驻、只合成（`--pcm-out`）、播放 PCM 文件（`--pcm-file`）
 * 或派生后台 `__play`。
 * @param command 解析后的 speak 命令
 * @returns 退出码（0 成功）
 */
async function runSpeak(command: Extract<CliCommand, { kind: "speak" }>): Promise<number> {
  if (command.pcmFile !== undefined) return runPlayPcmFile(command);
  if (command.pcmOut !== undefined) return runPcmOut(command);
  if (command.follow) return runSpeakFollow(command);
  const config = loadVoiceConfig();
  const phrases = getPhrases(config.toolLanguage);
  let text: string;
  try {
    text = await resolveSpeakText(command);
  } catch (error) {
    err(format(phrases.cli.speakFailed, { message: `无法读取 --text-file：${errText(error)}` }));
    return 1;
  }
  // 空文本（纯空白）：直接跳过——不报错、不 `stopPlayback()`（不打断正在播的上一条）、不派生 `__play`、
  // 不触发 provider（否则 sapi 会抛「text 不能为空」→ 子进程异常退出 warn；用户实测缺陷）。
  if (text.trim().length === 0) {
    out(phrases.cli.speakSkipped);
    return 0;
  }
  const request = speakRequestOf(command, text);
  const emotionLabel = normalizeEmotion(command.emotion) ?? NONE;

  if (!command.background) {
    try {
      // 只清本会话（含无主）再开播：跨会话混音——B 会话开播不杀 A 会话；无 env（手动/工具）= 无参全清（既有语义）
      stopPlayback({ sessionID: process.env[PLAYBACK_SESSION_ENV]?.trim() || undefined });
      const result = speak(request);
      out(
        format(phrases.cli.speakStarted, {
          provider: result.provider,
          voice: result.voice || DEFAULT_VOICE_LABEL,
          rate: result.rate,
          emotion: emotionLabel,
        }),
      );
      registerPlaybackLifecycle(result);
      // 等真正播完（流式：finish 后音频放完；本地：子进程退出）再清理并退出
      await awaitPlayback(result);
      return 0;
    } catch (error) {
      err(format(phrases.cli.speakFailed, { message: errText(error) }));
      return 1;
    }
  }

  // 后台模式：先在前台校验（provider 名、云凭证、播放器可用性），再派生分离子进程
  let resolved!: ResolvedTtsConfig;
  try {
    resolved = resolveTtsConfig(request, process.env, config.tts);
    getProvider(resolved.provider);
    // 云 provider 合成跨平台、但需要播放路径：这里先探测（流式优先，缺则分段回退），
    // 都不可用时立即报清晰错误（不静默、不派生子进程）
    if (resolved.provider === "aliyun") {
      resolveCredentials({ env: process.env, config: config.tts.credentials, section: "tts", providerLabel: "阿里云 TTS" });
      selectAudioStrategy({ sampleRate: resolveCosyVoiceParams(resolved).sampleRate });
    }
    if (resolved.provider === "mimo") {
      // MiMo 凭证独立于 aliyun（env MIMO_API_KEY > tts.mimoCredentials.apiKey）；流式固定 24kHz
      resolveMimoApiKey({ env: process.env, config: config.tts.mimoCredentials });
      selectAudioStrategy({ sampleRate: MIMO_SAMPLE_RATE });
    }
  } catch (error) {
    err(format(phrases.cli.speakFailed, { message: errText(error) }));
    return 1;
  }

  const payload: PlayPayload = {
    text,
    voice: command.voice,
    rate: command.rate,
    emotion: command.emotion,
    provider: command.provider,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  try {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), PLAY_COMMAND], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, [ENV_PLAY_PAYLOAD]: encoded },
    });
    child.unref();
  } catch (error) {
    err(format(phrases.cli.speakFailed, { message: errText(error) }));
    return 1;
  }
  out(
    format(phrases.cli.speakStarted, {
      provider: resolved.provider,
      voice: resolved.voice || DEFAULT_VOICE_LABEL,
      rate: resolved.rate,
      emotion: emotionLabel,
    }),
  );
  return 0;
}

/**
 * 执行 `__play`：内部子进程，解码载荷后真正合成并播放；靠子进程句柄自然存活到播放结束。
 * @returns 退出码
 */
async function runPlay(): Promise<number> {
  const raw = process.env[ENV_PLAY_PAYLOAD];
  if (!raw) {
    log.error("__play 缺少载荷");
    return 1;
  }
  let payload: PlayPayload;
  try {
    payload = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as PlayPayload;
  } catch (error) {
    log.error("__play 载荷解析失败", error as Error);
    return 1;
  }
  try {
    // 只清本会话（含无主）再开播：跨会话混音——B 会话开播不杀 A 会话；无 env（手动/工具）= 无参全清（既有语义）
    stopPlayback({ sessionID: process.env[PLAYBACK_SESSION_ENV]?.trim() || undefined });
    const result = speak({
      text: payload.text,
      voice: payload.voice,
      rate: payload.rate,
      emotion: payload.emotion,
      provider: payload.provider,
    });
    registerPlaybackLifecycle(result);
    await awaitPlayback(result);
    return 0;
  } catch (error) {
    log.error("__play 播放失败", error as Error);
    return 1;
  }
}

/**
 * 执行 `devices`：列出音频输入设备。
 * @returns 退出码
 */
async function runDevices(): Promise<number> {
  const { listAudioDevices } = await import("../voice/capture.js");
  const phrases = getPhrases(loadVoiceConfig().toolLanguage);
  let devices: Array<{ name: string; alternativeName?: string }>;
  try {
    devices = listAudioDevices();
  } catch (error) {
    err(format(phrases.cli.speakFailed, { message: errText(error) }));
    return 1;
  }
  if (devices.length === 0) {
    out(phrases.cli.noDevices);
    return 0;
  }
  out(phrases.cli.devicesHeader);
  devices.forEach((device, index) => {
    const alt = device.alternativeName ? `  [alt: ${device.alternativeName}]` : "";
    out(`  ${index + 1}. ${device.name}${alt}`);
  });
  return 0;
}

/**
 * 执行 `status`：打印解析后的配置（绝不打印密钥，仅报告凭证是否存在）。
 * @returns 退出码
 */
async function runStatus(): Promise<number> {
  const config = loadVoiceConfig();
  const resolved = resolveTtsConfig({ text: "-" }, process.env, config.tts);
  out(`uiLanguage: ${config.uiLanguage}`);
  out(`toolLanguage: ${config.toolLanguage}`);
  out(`provider: ${resolved.provider}`);
  out(`voice: ${resolved.voice || `(${DEFAULT_VOICE_LABEL})`}`);
  out(`rate: ${resolved.rate}`);
  out(`instruction: ${resolved.instruction || "(none)"}`);
  out(`streamMinChars: ${resolved.streamMinChars}`);
  let configPath = "";
  try {
    const { voiceConfigPath } = await import("../voice/config.js");
    configPath = voiceConfigPath();
  } catch {
    configPath = "";
  }
  out(`config: ${configPath}`);
  out(`node: ${process.version}`);
  out(`platform: ${process.platform}`);
  try {
    const { resolveFfmpegPath } = await import("../voice/ffmpeg.js");
    out(`ffmpeg: ${resolveFfmpegPath()}`);
  } catch (error) {
    out(`ffmpeg: (unavailable: ${errText(error)})`);
  }
  try {
    // status 面向 TTS：云凭证检查用 tts.credentials（与 asr 各自独立）
    resolveCredentials({ env: process.env, config: config.tts.credentials, section: "tts", providerLabel: "阿里云 TTS" });
    out("credentials: apiKey=set workspace=set");
  } catch {
    out("credentials: missing (apiKey/workspace not resolved)");
  }
  return 0;
}

/**
 * 判断本模块是否「作为入口被直接运行」（而非被 import）。
 *
 * 判据：`process.argv[1]` 解析出的真实路径 == 本模块文件的真实路径。两侧都过 `realpathSync`，
 * 以消除大小写、`..`、符号链接差异；`argv[1]` 缺失或不可解析时一律按「被 import」处理。
 * @returns 直接运行为 true；被当作模块引入为 false
 */
export function isDirectEntry(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(resolve(entry)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

/**
 * 主入口：解析参数并分发。
 * @param argv 参数数组
 * @returns 退出码
 */
export async function main(argv: readonly string[]): Promise<number> {
  // 配置解析失败必须在 CLI 侧**可见**（stderr），且已由 config 模块保证不覆盖原文件
  const initial = loadVoiceConfigWithWarnings();
  const initialPhrases = getPhrases(initial.config.toolLanguage);
  for (const warning of initial.warnings) {
    if (warning.kind === "parse-error") {
      err(format(initialPhrases.cli.configInvalid, { message: warning.message }));
    }
  }
  const command = parseCliArgs(argv);
  switch (command.kind) {
    case "speak":
      return runSpeak(command);
    case "devices":
      return runDevices();
    case "status":
      return runStatus();
    case "play":
      return runPlay();
    case "help": {
      out(initialPhrases.cli.help);
      return 0;
    }
    case "error":
      err(`${command.message}\n\n${initialPhrases.cli.help}`);
      return 1;
    default:
      return 1;
  }
}

// 入口保护：仅「直接运行」时执行；被 opencode 当插件 import 时静默跳过（不再打印 help）
if (isDirectEntry()) {
  main(process.argv.slice(2))
    .then((code) => {
      if (code !== 0) process.exitCode = code;
    })
    .catch((error: unknown) => {
      log.error("emotions-cli 未捕获异常", error as Error);
      err(errText(error));
      process.exitCode = 1;
    });
}
