#!/usr/bin/env node
/**
 * `voice-cli` 入口（编译到 `dist/cli/voice-cli.js`）：语音能力的**命令行**前端。
 *
 * 子命令：
 * - `speak --text <t> [--emotion <e>] [--voice <v>] [--rate <n>] [--provider <p>] [--background]`
 * - `devices`：列出本机音频输入设备（ffmpeg dshow）
 * - `status`：查看解析后的语音配置（不打印任何密钥）
 * - `help`：显示用法（随 `language` 本地化）
 *
 * 进程模型（`speak`）：
 * - **前台**（默认）：直接调用 TTS provider 合成并播放，进程自然存活到播放结束；
 * - **`--background`**：把真正的合成+播放交给**分离的子进程**（内部子命令 `__play`，参数经环境变量 base64 传入，
 *   不落命令行、不含密钥），本进程立即打印确认并退出。`voice_cli` 工具用此模式，保持「不卡回合」。
 *
 * 安全：凭证只读、绝不打印；对外错误经 `redact()` 脱敏。
 *
 * 入口保护：`.opencode/plugin/` **顶层**的每个 `.js` 都会被 opencode 当插件自动 import，
 * 故 `main()` 只在「作为入口直接运行」时执行（见 `isDirectEntry()`）；被 import 时无副作用、
 * 不打印任何东西。`main` 一并导出，供单测与程序化调用。
 */

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import createLogger from "@xiaoqiong0v0/opencode-plugin-logger";
import type { Logger } from "@xiaoqiong0v0/opencode-plugin-logger";

import { format, getPhrases } from "../lib/i18n.js";
import { loadVoiceConfig } from "../voice/config.js";
import { resolveCredentials } from "../voice/credentials.js";
import { parseCliArgs, PLAY_COMMAND, type CliCommand } from "../voice/cli.js";
import { normalizeEmotion } from "../voice/tts/emotion.js";
import { getProvider, resolveTtsConfig, speak, type ResolvedTtsConfig } from "../voice/tts/index.js";

/** 内部子进程载荷环境变量（base64(JSON)，避免把文本/参数暴露在命令行）。 */
export const ENV_PLAY_PAYLOAD = "OC_VOICE_PLAY";

const log: Logger = createLogger("voice-cli");

/** 无法得知时的占位。 */
const NONE = "-";
/** 空值占位。 */
const DEFAULT_LABEL = "默认";

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
 * 执行 `speak`：前台播放或派生后台 `__play`。
 * @param command 解析后的 speak 命令
 * @returns 退出码（0 成功）
 */
async function runSpeak(command: Extract<CliCommand, { kind: "speak" }>): Promise<number> {
  const config = loadVoiceConfig();
  const phrases = getPhrases(config.language);
  const request = {
    text: command.text,
    voice: command.voice,
    rate: command.rate,
    emotion: command.emotion,
    provider: command.provider,
  };
  const emotionLabel = normalizeEmotion(command.emotion) ?? NONE;

  if (!command.background) {
    try {
      const result = speak(request);
      out(
        format(phrases.cli.speakStarted, {
          provider: result.provider,
          voice: result.voice || DEFAULT_LABEL,
          rate: result.rate,
          emotion: emotionLabel,
        }),
      );
      return 0;
    } catch (error) {
      err(format(phrases.cli.speakFailed, { message: errText(error) }));
      return 1;
    }
  }

  // 后台模式：先在前台校验（provider 名、云凭证），再派生分离子进程，保持「不克隆进程 + 立即返回」
  let resolved!: ResolvedTtsConfig;
  try {
    resolved = resolveTtsConfig(request, process.env, config.tts);
    getProvider(resolved.provider);
    if (resolved.provider === "aliyun") {
      resolveCredentials({ env: process.env, config: config.asr.credentials });
    }
  } catch (error) {
    err(format(phrases.cli.speakFailed, { message: errText(error) }));
    return 1;
  }

  const payload: PlayPayload = {
    text: command.text,
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
      voice: resolved.voice || DEFAULT_LABEL,
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
function runPlay(): number {
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
    speak({
      text: payload.text,
      voice: payload.voice,
      rate: payload.rate,
      emotion: payload.emotion,
      provider: payload.provider,
    });
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
  const phrases = getPhrases(loadVoiceConfig().language);
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
  out(`language: ${config.language}`);
  out(`provider: ${resolved.provider}`);
  out(`voice: ${resolved.voice || `(${DEFAULT_LABEL})`}`);
  out(`rate: ${resolved.rate}`);
  out(`instruction: ${resolved.instruction || "(none)"}`);
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
    resolveCredentials({ env: process.env, config: config.asr.credentials });
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
      out(getPhrases(loadVoiceConfig().language).cli.help);
      return 0;
    }
    case "error":
      err(`${command.message}\n\n${getPhrases(loadVoiceConfig().language).cli.help}`);
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
      log.error("voice-cli 未捕获异常", error as Error);
      err(errText(error));
      process.exitCode = 1;
    });
}
