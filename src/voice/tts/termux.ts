/**
 * Termux（Android）TTS provider：spawn `termux-tts-speak` 走**系统 TTS**（免 API/联网）。
 *
 * 选项依据 Termux API 官方 `-h`：
 *   `termux-tts-speak [-e engine] [-l language] [-n region] [-v variant] [-p pitch] [-r rate] [-s stream] [text]`
 * 这里把配置映射为：`-r`（语速）与可选的 `-e/-l/-n/-v/-s`（经环境变量 `TTS_TERMUX_*` 覆盖），正文作为位置参数。
 * 语速口径：本项目 `rate` 为 SAPI 风格 [-10,10]（0 = 中性），映射到 termux 的 `-r`（1.0 正常）
 * 为 `1 + rate/10`，夹到 [0.5, 2]；`rate===0` 时不下发（用系统默认）。
 *
 * 仅在 Termux 可用（`isTermux()`）；命令缺失时抛**清晰错误**（提示 `pkg install termux-api` + Termux:API 应用）。
 * 并发：内部至多持有一个子进程，新的 speak 先 kill 旧进程（打断），见 docs/ASYNC.md。
 */

import { spawn, type ChildProcess } from "node:child_process";

import createLogger from "@xiaoqiong0v0/opencode-plugin-logger";
import type { Logger } from "@xiaoqiong0v0/opencode-plugin-logger";

import { commandExists, isTermux, termuxExecutable } from "../platform.js";
import {
  clampRate,
  DEFAULT_RATE,
  DEFAULT_VOICE_LABEL,
  type ResolvedTtsOptions,
  type SpeakResult,
  type TtsProvider,
} from "./types.js";

/** provider 标识。 */
export const TERMUX_TTS_PROVIDER_NAME = "termux";
/** Termux TTS 命令名（`$PREFIX/bin/termux-tts-speak`）。 */
export const TERMUX_TTS_BIN = "termux-tts-speak";
/** TTS engine 环境变量（映射 `-e`）。 */
export const ENV_TERMUX_ENGINE = "TTS_TERMUX_ENGINE";
/** TTS language 环境变量（映射 `-l`）。 */
export const ENV_TERMUX_LANGUAGE = "TTS_TERMUX_LANGUAGE";
/** TTS region 环境变量（映射 `-n`）。 */
export const ENV_TERMUX_REGION = "TTS_TERMUX_REGION";
/** TTS variant 环境变量（映射 `-v`）。 */
export const ENV_TERMUX_VARIANT = "TTS_TERMUX_VARIANT";
/** TTS stream 环境变量（映射 `-s`；ALARM/MUSIC/NOTIFICATION/RING/SYSTEM/VOICE_CALL）。 */
export const ENV_TERMUX_STREAM = "TTS_TERMUX_STREAM";
/** termux `-r` 语速下界。 */
export const TERMUX_RATE_MIN = 0.5;
/** termux `-r` 语速上界。 */
export const TERMUX_RATE_MAX = 2.0;
/** 命令缺失时的安装提示。 */
export const TERMUX_TTS_HINT = `请执行 pkg install termux-api，并在手机上安装 Termux:API 应用（命令 ${TERMUX_TTS_BIN}）`;

/** TermuxProvider 的可注入依赖（便于离线单测）。 */
export interface TermuxProviderOptions {
  /** 环境变量表；默认 `process.env`。 */
  env?: NodeJS.ProcessEnv;
  /** 目标平台；默认 `process.platform`。 */
  platform?: NodeJS.Platform;
  /** 命令可用性探测；默认按绝对路径判定。 */
  isAvailable?: (bin: string) => boolean;
  /** spawn 实现；默认 `node:child_process.spawn`（测试注入假子进程）。 */
  spawn?: typeof spawn;
}

/**
 * 把项目语速（SAPI 风格 [-10,10]）映射为 termux `-r`（1.0 正常，夹到 [0.5,2]）。
 * @param rate 项目语速（0 = 中性 → 不指定）
 * @returns 映射后的语速；`rate===0`/非法时返回 null（不下发）
 */
export function mapTermuxRate(rate: number): number | null {
  if (!Number.isFinite(rate) || rate === 0) return null;
  const mapped = 1 + rate / 10;
  return Math.min(TERMUX_RATE_MAX, Math.max(TERMUX_RATE_MIN, Math.round(mapped * 100) / 100));
}

/**
 * 构造 `termux-tts-speak` 参数（纯函数，便于单测）。
 * @param options 解析后的朗读参数
 * @param env 环境变量表（读取 `TTS_TERMUX_*` 可选覆盖）
 * @returns argv（不含可执行文件本身；正文为最后一个位置参数）
 */
export function buildTermuxTtsArgs(options: ResolvedTtsOptions, env: NodeJS.ProcessEnv = process.env): string[] {
  const args: string[] = [];
  const push = (flag: string, value: string | undefined): void => {
    const trimmed = value?.trim();
    if (trimmed && trimmed.length > 0) args.push(flag, trimmed);
  };
  push("-e", env[ENV_TERMUX_ENGINE]);
  push("-l", env[ENV_TERMUX_LANGUAGE]);
  push("-n", env[ENV_TERMUX_REGION]);
  push("-v", env[ENV_TERMUX_VARIANT]);
  const rate = mapTermuxRate(options.rate);
  if (rate !== null) args.push("-r", String(rate));
  push("-s", env[ENV_TERMUX_STREAM]);
  args.push(options.text);
  return args;
}

/** Termux（Android 系统 TTS）provider。 */
export class TermuxProvider implements TtsProvider {
  readonly name = TERMUX_TTS_PROVIDER_NAME;
  private readonly log: Logger = createLogger("tts-termux");
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly isAvailable: (bin: string) => boolean;
  private readonly spawnFn: typeof spawn;
  private child: ChildProcess | null = null;

  /**
   * @param options 可注入依赖（env/platform/探测/spawn；缺省用生产默认）
   */
  constructor(options: TermuxProviderOptions = {}) {
    this.env = options.env ?? process.env;
    this.platform = options.platform ?? process.platform;
    this.isAvailable = options.isAvailable ?? ((bin: string) => commandExists(bin, this.env, this.platform));
    this.spawnFn = options.spawn ?? spawn;
  }

  /**
   * 后台开始朗读：立即返回（不等待播放完成）；内部先打断上一次。
   *
   * `done` 在 `termux-tts-speak` 子进程真正退出后 settle：正常退出 resolve、被 `stop()`/新一次
   * `speak()` 打断也 resolve（有意停止）、非 0 退出/无法启动则 reject 可识别错误。
   * （Termux API 的该命令在系统 TTS 播完后才返回，故进程退出即约等于播放结束。）
   * @param options 解析后的朗读参数
   * @returns 本次朗读的启动结果（含 `done`）
   * @throws Error 非 Termux / 文本为空 / 未安装 termux-api
   */
  speak(options: ResolvedTtsOptions): SpeakResult {
    if (this.platform !== "android" && !isTermux(this.env)) {
      throw new Error("termux provider 仅在 Termux（Android）可用；请把 TTS_PROVIDER 设为 sapi 或 aliyun");
    }
    if (options.text.trim().length === 0) {
      throw new Error("text 不能为空");
    }
    const bin = termuxExecutable(this.env, TERMUX_TTS_BIN);
    if (!this.isAvailable(bin)) {
      throw new Error(`未找到 ${TERMUX_TTS_BIN}：${TERMUX_TTS_HINT}`);
    }
    this.stop();
    const done = this.startPlayer(bin, buildTermuxTtsArgs(options, this.env));
    return {
      provider: this.name,
      voice: options.voice || DEFAULT_VOICE_LABEL,
      rate: clampRate(options.rate, DEFAULT_RATE),
      done,
    };
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null) return;
    try {
      child.kill();
    } catch (err) {
      this.log.warn("停止 termux TTS 子进程失败", err as Error);
    }
  }

  /**
   * 启动 `termux-tts-speak`（可被 stop 打断），并返回「本次播放真正结束」的 Promise。
   *
   * settle 语义与 `SpeakResult.done` 契约一致：正常退出/被顶替 resolve，非 0 退出或启动失败 reject。
   * @param bin 命令绝对路径
   * @param args 命令参数
   * @returns 播放结束（成功/有意停止 resolve，失败 reject）后 settle
   */
  private startPlayer(bin: string, args: string[]): Promise<void> {
    let child: ChildProcess;
    try {
      child = this.spawnFn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.log.error(`启动 ${bin} 失败`, error);
      return Promise.reject(error);
    }
    this.child = child;
    return new Promise<void>((resolveDone, rejectDone) => {
      let settled = false;
      /** 幂等 settle（`exit` / `error` 可能先后到达）。 */
      const settle = (action: () => void): void => {
        if (settled) return;
        settled = true;
        action();
      };
      child.stderr?.on("data", (chunk: Buffer) => {
        const line = String(chunk).trim();
        if (line.length > 0) this.log.warn(`termux tts stderr: ${line}`);
      });
      child.on("error", (err: Error) => {
        if (this.child === child) this.child = null;
        this.log.error(`termux TTS 子进程异常（${bin}）`, err);
        settle(() => rejectDone(new Error(`termux TTS 播放失败（${bin}）：${err.message}`)));
      });
      child.on("exit", (code: number | null) => {
        // 被 stop()/新一次 speak 顶替时 this.child 已不是本子进程 ⇒ 有意打断，正常收尾
        const current = this.child === child;
        if (current) this.child = null;
        if (!current) {
          settle(resolveDone);
          return;
        }
        if (code !== null && code !== 0) {
          const err = new Error(`termux TTS 播放失败（退出码=${code}）`);
          this.log.error(err.message);
          settle(() => rejectDone(err));
          return;
        }
        settle(resolveDone);
      });
    });
  }
}
