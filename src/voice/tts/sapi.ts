/**
 * Windows SAPI（System.Speech）provider：spawn PowerShell 合成并播放。
 *
 * 安全：文本经 base64 走环境变量传入，绝不拼接进脚本，杜绝命令注入且中文安全。
 * 跨平台：非 Windows 直接抛错（由工具层转为错误字符串）。
 * 并发：内部至多持有一个子进程，新的 speak 先 kill 旧进程（打断），见 docs/ASYNC.md。
 * follow 常驻（`--follow`）：整 worker 生命周期只 spawn 一次 PowerShell（`SAPI_FOLLOW_SCRIPT`
 * 的 ReadLine 循环），行文本经 stdin 送入、Speak 同步串行；`followEnd()` 关 stdin 等退出（冲刷尾音）。
 */

import { spawn, type ChildProcess } from "node:child_process";

import createLogger from "@xiaoqiong0v0/opencode-plugin-logger";
import type { Logger } from "@xiaoqiong0v0/opencode-plugin-logger";

import { POWERSHELL_BINS } from "../platform.js";
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
 * PowerShell 可执行文件候选（按顺序回退；单源 `POWERSHELL_BINS`）。
 *
 * 顺序很重要：先 `pwsh`（PowerShell 7 / .NET），它能选择全部 OneCore 音色
 * （Microsoft Huihui / Kangkang / Yaoyao）；Windows PowerShell 5.1（.NET Framework）
 * 只认 Desktop 音色（本机仅 `Microsoft Huihui Desktop` / `Microsoft Zira Desktop`），
 * 选不到时 `SelectVoice` 会抛错并回落到默认音色。故仅有 5.1 的机器仍可朗读（默认中文音色）。
 */
const BIN_CANDIDATES = POWERSHELL_BINS;
/** 传入子进程的文本环境变量（UTF-8 的 base64）。 */
const ENV_TEXT_B64 = "OC_TTS_TEXT_B64";
/** 传入子进程的音色环境变量。 */
const ENV_VOICE = "OC_TTS_VOICE";
/** 传入子进程的语速环境变量。 */
const ENV_RATE = "OC_TTS_RATE";
/** 传入子进程的音量环境变量（0-100；未指定时不传）。 */
const ENV_VOLUME = "OC_TTS_VOLUME";
/**
 * follow 模式常驻子进程收尾等待上限（毫秒）：`followEnd()` 关 stdin（EOF）后等 Speak 冲刷尾音退出；
 * 超时则强杀（防挂死 worker）。取 30s：正常 EOF 后 ReadLine 立即返回、Dispose 秒级退出，
 * 超时只会发生在 Speak 卡死等异常态。
 */
export const FOLLOW_EXIT_TIMEOUT_MS = 30_000;

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

/**
 * SAPI **follow 常驻**脚本（CLI `speak --follow` / auto-read worker）：整 worker 生命周期只 spawn
 * 这**一个** PowerShell——`[Console]::In.ReadLine()` 循环按行读 UTF-8 文本，非空即 `$syn.Speak($line)`
 * （Speak **同步** = 天然串行，无需锁）；EOF（stdin 关闭/断开 → ReadLine 返回 $null）→ Dispose 退出。
 * - `[Console]::InputEncoding=UTF8`：stdin 重定向下默认 ANSI，中文行会乱码；try/catch 防无控制台环境抛错。
 * - `while($null -ne ($line=…))`：**不能**写 `while($line=…)`——PowerShell 里空串 `""` 布尔为假，
 *   空行会误结束循环（写方虽已滤空行，脚本仍须自身健壮）。
 * - 环境变量只带 voice/rate/volume（正文走 stdin，无注入面）。
 */
export const SAPI_FOLLOW_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "Add-Type -AssemblyName System.Speech",
  "$syn=New-Object System.Speech.Synthesis.SpeechSynthesizer",
  `if($env:${ENV_RATE}){$syn.Rate=[int]$env:${ENV_RATE}}`,
  `if($env:${ENV_VOLUME}){$syn.Volume=[int]$env:${ENV_VOLUME}}`,
  `if($env:${ENV_VOICE}){try{$syn.SelectVoice($env:${ENV_VOICE})}catch{[Console]::Error.WriteLine('voice-not-found:'+$env:${ENV_VOICE})}}`,
  "try{[Console]::InputEncoding=[System.Text.Encoding]::UTF8}catch{}",
  "while($null -ne ($line=[Console]::In.ReadLine())){if($line.Trim().Length -gt 0){$syn.Speak($line)}}",
  "$syn.Dispose()",
].join("; ");

/** PowerShell 调用参数（脚本作为单个 argv 传入，无 shell 拼接）。 */
const SAPI_ARGS = ["-NoProfile", "-NonInteractive", "-Command", SAPI_SCRIPT];
/** follow 模式 PowerShell 调用参数（同安全口径，脚本换成 ReadLine 循环）。 */
const SAPI_FOLLOW_ARGS = ["-NoProfile", "-NonInteractive", "-Command", SAPI_FOLLOW_SCRIPT];

/**
 * 构造音色/语速/音量子进程环境变量（follow 模式复用；正文走 stdin，不带文本 env）。
 * @param options 解析后的朗读参数
 * @param base 基础环境（默认 process.env）
 * @returns 注入音色/语速/音量后的环境变量表
 */
function buildSapiVoiceEnv(options: ResolvedTtsOptions, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    [ENV_VOICE]: options.voice,
    [ENV_RATE]: String(clampRate(options.rate, DEFAULT_RATE)),
  };
  // 音量：0 = 未指定（SAPI 默认 100），仅显式正数时下发
  if (Number.isFinite(options.volume) && options.volume > 0) {
    env[ENV_VOLUME] = String(Math.min(100, Math.max(0, Math.trunc(options.volume))));
  }
  return env;
}

/**
 * 构造传给 PowerShell 子进程的环境变量。
 * @param options 解析后的朗读参数
 * @param base 基础环境（默认 process.env）
 * @returns 注入文本/音色/语速/音量后的环境变量表
 */
export function buildSapiEnv(options: ResolvedTtsOptions, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...buildSapiVoiceEnv(options, base),
    [ENV_TEXT_B64]: Buffer.from(options.text, "utf8").toString("base64"),
  };
}

/**
 * 构造 follow 模式子进程的环境变量（音色/语速/音量；正文走 stdin 行，无文本 env）。
 * @param options 解析后的朗读参数
 * @param base 基础环境（默认 process.env）
 * @returns 注入音色/语速/音量后的环境变量表
 */
export function buildSapiFollowEnv(options: ResolvedTtsOptions, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return buildSapiVoiceEnv(options, base);
}

/** Windows SAPI provider。 */
export class SapiProvider implements TtsProvider {
  readonly name = SAPI_PROVIDER_NAME;
  /** 支持 follow 常驻模式（一次 spawn PowerShell + ReadLine 循环连续 Speak）。 */
  readonly followSupport = true;
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
    this.spawnPlayer(0, buildSapiEnv(options), SAPI_ARGS, "ignore");
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
   * 当前 PowerShell 子进程 PID（真正发声的孙进程；供 `tts-playback` 登记 `playerPid`）。
   *
   * `spawnPlayer()` 在 `speak()`/`followStart()` 内同步调用 ⇒ 返回后即可读到；子进程退出/未启动时 undefined。
   * @returns 子进程 PID；无存活子进程时 undefined
   */
  activePlayerPid(): number | undefined {
    return this.child?.pid;
  }

  followStart(options: ResolvedTtsOptions): void {
    if (process.platform !== "win32") {
      throw new Error("sapi provider 仅支持 Windows；请设置 TTS_PROVIDER 使用其它 provider");
    }
    // 先 stop：普通 speak 的子进程 / 上一个 follow 常驻进程都不允许与本 follow 并存
    this.stop();
    this.spawnPlayer(0, buildSapiFollowEnv(options), SAPI_FOLLOW_ARGS, "pipe");
  }

  followLine(text: string): void {
    const child = this.child;
    const stdin = child?.stdin;
    if (!child || child.exitCode !== null || !stdin || !stdin.writable) {
      throw new Error("sapi follow 子进程未启动或已退出");
    }
    stdin.write(`${text}\n`);
  }

  async followEnd(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null) return;
    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
    });
    try {
      // EOF → ReadLine 返回 $null → 循环退出 → Dispose → 进程结束（冲刷尾音）
      child.stdin?.end();
    } catch {
      // stdin 已断：直接等 exit（或超时强杀）
    }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // 已退出忽略
        }
        resolve();
      }, FOLLOW_EXIT_TIMEOUT_MS);
    });
    try {
      await Promise.race([exited, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * 按候选顺序尝试启动 PowerShell；`ENOENT` 时回退下一个候选。
   * @param index 当前候选下标
   * @param env 子进程环境变量
   * @param args PowerShell 参数（普通 speak 单发脚本 / follow ReadLine 循环脚本）
   * @param stdinMode stdin 模式：普通 speak `"ignore"`；follow `"pipe"`（写入待读行）
   */
  private spawnPlayer(index: number, env: NodeJS.ProcessEnv, args: readonly string[], stdinMode: "ignore" | "pipe"): void {
    const bin = BIN_CANDIDATES[index];
    if (bin === undefined) {
      this.log.error("未找到可用 PowerShell（powershell / pwsh）");
      return;
    }
    let child: ChildProcess;
    try {
      child = spawn(bin, [...args], { env, stdio: [stdinMode, "ignore", "pipe"], windowsHide: true });
    } catch (err) {
      this.log.error(`启动 ${bin} 失败`, err as Error);
      return;
    }
    this.child = child;
    // follow 模式 stdin 写入后子进程死亡 → EPIPE 走 error 事件；不监听会让宿主进程崩溃
    child.stdin?.on("error", (err: Error) => {
      this.log.warn(`sapi follow stdin 写入失败：${err.message}`);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const line = String(chunk).trim();
      if (line.length > 0) this.log.warn(`sapi stderr: ${line}`);
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (this.child === child) this.child = null;
      if (err.code === "ENOENT" && index + 1 < BIN_CANDIDATES.length) {
        this.spawnPlayer(index + 1, env, args, stdinMode);
        return;
      }
      this.log.error(`SAPI 子进程异常（${bin}）`, err);
    });
    child.on("exit", () => {
      if (this.child === child) this.child = null;
    });
  }
}
