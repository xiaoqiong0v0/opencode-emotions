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
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import createLogger from "@xiaoqiong0v0/opencode-plugin-logger";
import type { Logger } from "@xiaoqiong0v0/opencode-plugin-logger";

import { format, getPhrases } from "../lib/i18n.js";
import type { AutoTtsOptions } from "../voice/auto-tts.js";
import { loadVoiceConfig } from "../voice/config.js";
import { resolveCredentials, resolveMimoApiKey } from "../voice/credentials.js";
import { parseCliArgs, PLAY_COMMAND, type CliCommand } from "../voice/cli.js";
import {
  clearPlayback,
  PLAYBACK_SESSION_ENV,
  stopPlayback,
  writePlayback,
} from "../voice/playback-state.js";
import { normalizeEmotion } from "../voice/tts/emotion.js";
import { MIMO_SAMPLE_RATE } from "../voice/tts/mimo.js";
import {
  getProvider,
  resolveCosyVoiceParams,
  resolveTtsConfig,
  selectAudioStrategy,
  speak,
  DEFAULT_VOICE_LABEL,
  type ResolvedTtsConfig,
  type TtsProvider,
} from "../voice/tts/index.js";

/** 内部子进程载荷环境变量（base64(JSON)，避免把文本/参数暴露在命令行）。 */
export const ENV_PLAY_PAYLOAD = "OC_VOICE_PLAY";

const log: Logger = createLogger("emotions-cli");

/** 无法得知时的占位。 */
const NONE = "-";

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
 * 解析本次朗读的正文（`--text-file` 优先于 `--text`）。
 * @param command speak 命令
 * @returns 正文；读取失败时抛错
 */
function resolveSpeakText(command: Extract<CliCommand, { kind: "speak" }>): string {
  if (command.textFile) return readFileSync(command.textFile, "utf8").trim();
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
  fields: { provider: string; taskId?: string },
  options: AutoTtsOptions = {},
): void {
  writePlayback(
    {
      pid: process.pid,
      playerPid: getProvider(fields.provider).activePlayerPid?.(),
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
  const request = {
    text: "",
    voice: command.voice,
    rate: command.rate,
    emotion: command.emotion,
    provider: command.provider,
  };
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
 * 执行 `speak`：前台播放、follow 常驻或派生后台 `__play`。
 * @param command 解析后的 speak 命令
 * @returns 退出码（0 成功）
 */
async function runSpeak(command: Extract<CliCommand, { kind: "speak" }>): Promise<number> {
  if (command.follow) return runSpeakFollow(command);
  const config = loadVoiceConfig();
  const phrases = getPhrases(config.toolLanguage);
  let text: string;
  try {
    text = resolveSpeakText(command);
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
  const request = {
    text,
    voice: command.voice,
    rate: command.rate,
    emotion: command.emotion,
    provider: command.provider,
  };
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
      await (result.done ?? Promise.resolve());
      clearPlayback(process.pid);
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
    await (result.done ?? Promise.resolve());
    clearPlayback(process.pid);
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
      out(getPhrases(loadVoiceConfig().toolLanguage).cli.help);
      return 0;
    }
    case "error":
      err(`${command.message}\n\n${getPhrases(loadVoiceConfig().toolLanguage).cli.help}`);
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
