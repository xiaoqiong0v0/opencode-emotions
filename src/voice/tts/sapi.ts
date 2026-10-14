/**
 * Windows SAPI（System.Speech）provider：spawn PowerShell 合成并播放。
 *
 * 安全：文本经 base64 走环境变量传入，绝不拼接进脚本，杜绝命令注入且中文安全。
 * 跨平台：非 Windows 直接抛错（由工具层转为错误字符串）。
 * 并发：内部至多持有一个子进程，新的 speak 先 kill 旧进程（打断），见 docs/ASYNC.md。
 */

import { spawn, type ChildProcess } from "node:child_process";

import createLogger from "@xiaoqiong0v0/opencode-plugin-logger";
import type { Logger } from "@xiaoqiong0v0/opencode-plugin-logger";

import {
  clampRate,
  DEFAULT_RATE,
  DEFAULT_VOICE_LABEL,
  type ResolvedTtsOptions,
  type SpeakResult,
  type TtsProvider,
} from "./types.js";

/** provider 标识。 */
export const SAPI_PROVIDER_NAME = "sapi";
/**
 * PowerShell 可执行文件候选（按顺序回退）。
 *
 * 顺序很重要：先 `pwsh`（PowerShell 7 / .NET），它能选择全部 OneCore 音色
 * （Microsoft Huihui / Kangkang / Yaoyao）；Windows PowerShell 5.1（.NET Framework）
 * 只认 Desktop 音色（本机仅 `Microsoft Huihui Desktop` / `Microsoft Zira Desktop`），
 * 选不到时 `SelectVoice` 会抛错并回落到默认音色。故仅有 5.1 的机器仍可朗读（默认中文音色）。
 */
const BIN_CANDIDATES = ["pwsh", "powershell"] as const;
/** 传入子进程的文本环境变量（UTF-8 的 base64）。 */
const ENV_TEXT_B64 = "OC_TTS_TEXT_B64";
/** 传入子进程的音色环境变量。 */
const ENV_VOICE = "OC_TTS_VOICE";
/** 传入子进程的语速环境变量。 */
const ENV_RATE = "OC_TTS_RATE";
/** 传入子进程的音量环境变量（0-100；未指定时不传）。 */
const ENV_VOLUME = "OC_TTS_VOLUME";

/**
 * SAPI 合成脚本：从环境变量读取文本/音色/语速/音量，同步合成并播放。
 * 不接收任何拼接参数，故不存在注入面；文本用 base64 解码以兼容中文与特殊字符。
 */
export const SAPI_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "Add-Type -AssemblyName System.Speech",
  "$syn=New-Object System.Speech.Synthesis.SpeechSynthesizer",
  `if($env:${ENV_RATE}){$syn.Rate=[int]$env:${ENV_RATE}}`,
  `if($env:${ENV_VOLUME}){$syn.Volume=[int]$env:${ENV_VOLUME}}`,
  `if($env:${ENV_VOICE}){try{$syn.SelectVoice($env:${ENV_VOICE})}catch{[Console]::Error.WriteLine('voice-not-found:'+$env:${ENV_VOICE})}}`,
  `$bytes=[Convert]::FromBase64String($env:${ENV_TEXT_B64})`,
  "$text=[System.Text.Encoding]::UTF8.GetString($bytes)",
  "$syn.Speak($text)",
  "$syn.Dispose()",
].join("; ");

/** PowerShell 调用参数（脚本作为单个 argv 传入，无 shell 拼接）。 */
const SAPI_ARGS = ["-NoProfile", "-NonInteractive", "-Command", SAPI_SCRIPT];

/**
 * 构造传给 PowerShell 子进程的环境变量。
 * @param options 解析后的朗读参数
 * @param base 基础环境（默认 process.env）
 * @returns 注入文本/音色/语速/音量后的环境变量表
 */
export function buildSapiEnv(options: ResolvedTtsOptions, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    [ENV_TEXT_B64]: Buffer.from(options.text, "utf8").toString("base64"),
    [ENV_VOICE]: options.voice,
    [ENV_RATE]: String(clampRate(options.rate, DEFAULT_RATE)),
  };
  // 音量：0 = 未指定（SAPI 默认 100），仅显式正数时下发
  if (Number.isFinite(options.volume) && options.volume > 0) {
    env[ENV_VOLUME] = String(Math.min(100, Math.max(0, Math.trunc(options.volume))));
  }
  return env;
}

/** Windows SAPI provider。 */
export class SapiProvider implements TtsProvider {
  readonly name = SAPI_PROVIDER_NAME;
  private readonly log: Logger = createLogger("tts-sapi");
  private child: ChildProcess | null = null;

  speak(options: ResolvedTtsOptions): SpeakResult {
    if (process.platform !== "win32") {
      throw new Error("sapi provider 仅支持 Windows；请设置 TTS_PROVIDER 使用其它 provider");
    }
    if (options.text.trim().length === 0) {
      throw new Error("text 不能为空");
    }
    this.stop();
    this.spawnPlayer(0, buildSapiEnv(options));
    return {
      provider: this.name,
      voice: options.voice || DEFAULT_VOICE_LABEL,
      rate: clampRate(options.rate, DEFAULT_RATE),
    };
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null) return;
    try {
      child.kill();
    } catch (err) {
      this.log.warn("停止 SAPI 子进程失败", err as Error);
    }
  }

  /**
   * 按候选顺序尝试启动 PowerShell；`ENOENT` 时回退下一个候选。
   * @param index 当前候选下标
   * @param env 子进程环境变量
   */
  private spawnPlayer(index: number, env: NodeJS.ProcessEnv): void {
    const bin = BIN_CANDIDATES[index];
    if (bin === undefined) {
      this.log.error("未找到可用 PowerShell（powershell / pwsh）");
      return;
    }
    let child: ChildProcess;
    try {
      child = spawn(bin, SAPI_ARGS, { env, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    } catch (err) {
      this.log.error(`启动 ${bin} 失败`, err as Error);
      return;
    }
    this.child = child;
    child.stderr?.on("data", (chunk: Buffer) => {
      const line = String(chunk).trim();
      if (line.length > 0) this.log.warn(`sapi stderr: ${line}`);
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (this.child === child) this.child = null;
      if (err.code === "ENOENT" && index + 1 < BIN_CANDIDATES.length) {
        this.spawnPlayer(index + 1, env);
        return;
      }
      this.log.error(`SAPI 子进程异常（${bin}）`, err);
    });
    child.on("exit", () => {
      if (this.child === child) this.child = null;
    });
  }
}
