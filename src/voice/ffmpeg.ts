/**
 * ffmpeg 可执行文件解析与音频转码工具（供采集复用）。
 *
 * - `resolveFfmpegPath()`：按 **`FFMPEG_BIN` → PATH 的 `ffmpeg` → `ffmpeg-static`（可选依赖）** 顺序解析，
 *   每一级都做**存在性校验**（`existsSync`；Windows 兼容 `.exe` 后缀补全）——解析到但文件不存在
 *   （典型：缓存安装未跑 ffmpeg-static 的 install 下载脚本，只有包文件没有二进制）→ **继续下一级**，
 *   全失败才抛带**用户引导**的清晰错误（文案见 `voice/guidance.ts`）。
 *   `ffmpeg-static` 为 `optionalDependencies`，故用**惰性 + try/catch** 加载——未安装时不能影响插件启动
 *   （尤其 Termux 上不会装该原生包）。
 * - `decodeToPcm()`：把任意音频字节（含 Termux 分块录音的 opus/aac）转成 16k 单声道 s16le PCM，喂 ASR。
 *
 * 纯 Node，用 `spawn` 走管道，不落中间文件。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute } from "node:path";

import { ffmpegInstallHints, ffmpegMissingGuidance } from "./guidance.js";
import { commandExists } from "./platform.js";

export { ffmpegInstallHints };

const require = createRequire(import.meta.url);

/** ffmpeg 路径环境变量名（用户自备 ffmpeg 时优先使用）。 */
export const FFMPEG_ENV = "FFMPEG_BIN";
/** 转码超时（毫秒）。 */
export const DECODE_TIMEOUT_MS = 15000;

/** 缓存的 `ffmpeg-static` 路径（`undefined` = 尚未加载；`null` = 未安装/不可用）。 */
let ffmpegStaticCache: string | null | undefined;

/**
 * 惰性加载 `ffmpeg-static` 随附二进制路径（可选依赖，未安装时返回 null，绝不抛错）。
 * @returns 二进制绝对路径；未安装/非字符串时 null
 */
function loadFfmpegStatic(): string | null {
  if (ffmpegStaticCache !== undefined) return ffmpegStaticCache;
  try {
    const resolved = require("ffmpeg-static") as string | null;
    ffmpegStaticCache = typeof resolved === "string" && resolved.length > 0 ? resolved : null;
  } catch {
    // optionalDependencies 未安装（如 Termux）——属正常情况
    ffmpegStaticCache = null;
  }
  return ffmpegStaticCache;
}

/**
 * `resolveFfmpegPath` 的可注入选项（便于离线单测，不影响生产默认行为）。
 */
export interface ResolveFfmpegOptions {
  /** 环境变量表；默认 `process.env`。 */
  env?: NodeJS.ProcessEnv;
  /** 目标平台；默认 `process.platform`。 */
  platform?: NodeJS.Platform;
  /** PATH 探测函数；默认按 env/platform 走 `commandExists`。 */
  isOnPath?: (bin: string) => boolean;
  /** 随附二进制解析函数；默认惰性 `ffmpeg-static`。 */
  staticPath?: () => string | null;
  /** 文件存在性检查；默认 `fs.existsSync`（测试可注入以覆盖「路径在但文件缺失」分支）。 */
  exists?: (path: string) => boolean;
}

/**
 * 判断候选 ffmpeg 路径是否真正可用：文件存在（Windows 兼容 `.exe` 后缀补全）或裸命令名在 PATH 上。
 * @param candidate 候选路径/命令名
 * @param exists 存在性检查
 * @param platform 目标平台
 * @param isOnPath PATH 探测（仅裸命令名使用）
 * @returns 可用 true
 */
function isUsableBinary(
  candidate: string,
  exists: (path: string) => boolean,
  platform: NodeJS.Platform,
  isOnPath: (bin: string) => boolean,
): boolean {
  if (exists(candidate)) return true;
  // Windows：用户/工具可能省略 `.exe` 后缀，补全后再验一次
  if (platform === "win32" && !candidate.toLowerCase().endsWith(".exe") && exists(`${candidate}.exe`)) return true;
  // 裸命令名（无路径分隔符）交给 PATH 探测（PATHEXT 由 commandExists 处理）
  const hasSep = isAbsolute(candidate) || candidate.includes("/") || candidate.includes("\\");
  if (!hasSep && isOnPath(candidate)) return true;
  return false;
}

/**
 * 解析 ffmpeg 可执行文件路径，顺序：`FFMPEG_BIN` → PATH `ffmpeg` → `ffmpeg-static`。
 *
 * 每一级都校验真实可用性；解析到但文件不存在 → **继续下一级**，全失败才抛错（含用户引导文案）。
 * @param options 可注入选项（env/platform/探测/存在性，缺省用生产默认）
 * @returns ffmpeg 可执行文件路径（PATH 命中时返回命令名 `ffmpeg`，交给 spawn 解析）
 * @throws Error 三者都不可用（错误文本含去哪配/怎么配的中文引导）
 */
export function resolveFfmpegPath(options: ResolveFfmpegOptions = {}): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const isOnPath = options.isOnPath ?? ((bin: string) => commandExists(bin, env, platform));
  const exists = options.exists ?? existsSync;

  const override = env[FFMPEG_ENV]?.trim();
  if (override && isUsableBinary(override, exists, platform, isOnPath)) {
    // Windows 补全后缀的命中返回完整文件名（spawn 直接可用）
    if (platform === "win32" && !exists(override) && exists(`${override}.exe`)) return `${override}.exe`;
    return override;
  }
  if (isOnPath("ffmpeg")) return "ffmpeg";

  const staticPath = (options.staticPath ?? loadFfmpegStatic)();
  if (staticPath) {
    if (exists(staticPath)) return staticPath;
    if (platform === "win32" && !staticPath.toLowerCase().endsWith(".exe") && exists(`${staticPath}.exe`)) {
      return `${staticPath}.exe`;
    }
  }
  throw new Error(
    ffmpegMissingGuidance({
      platform,
      env,
      override: override || undefined,
      overrideProblem: override ? "missing-file" : undefined,
      staticProblem: staticPath ? "missing-file" : undefined,
    }),
  );
}

/**
 * 构造把输入音流转成 16bit 单声道 PCM（s16le）的 ffmpeg 参数。
 * @param format 输入格式（`pcm` 需显式声明裸流参数，其余自动探测容器/编码）
 * @param inputSampleRate 输入采样率（仅 `pcm` 需要）
 * @param outSampleRate 输出采样率（Hz）
 * @param outChannels 输出声道数
 * @returns ffmpeg 参数数组（stdin → stdout）
 */
export function buildPcmDecodeArgs(
  format: string,
  inputSampleRate: number,
  outSampleRate: number,
  outChannels: number,
): string[] {
  const head = ["-hide_banner", "-loglevel", "error"];
  const input =
    format === "pcm"
      ? ["-f", "s16le", "-ar", String(inputSampleRate), "-ac", "1", "-i", "pipe:0"]
      : ["-i", "pipe:0"];
  return [...head, ...input, "-f", "s16le", "-ar", String(outSampleRate), "-ac", String(outChannels), "pipe:1"];
}

/**
 * 把输入字节经 ffmpeg 管道转换，返回 stdout 字节。
 * @param args ffmpeg 参数数组
 * @param input 原始音频字节
 * @param timeoutMs 超时（毫秒）
 * @param label 错误信息里的动作标签
 * @returns 转换后的字节
 * @throws Error ffmpeg 不可用/超时/退出码非 0
 */
function runFfmpeg(args: string[], input: Buffer, timeoutMs: number, label: string): Promise<Buffer> {
  return new Promise<Buffer>((resolveRun, rejectRun) => {
    let proc;
    try {
      proc = spawn(resolveFfmpegPath(), args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      rejectRun(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectRun(error);
      else resolveRun(Buffer.concat(out));
    };
    const timer = setTimeout(() => {
      proc.kill();
      finish(new Error(`${label}超时（${timeoutMs}ms）`));
    }, timeoutMs);
    proc.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    proc.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
    proc.on("error", (error: Error) => finish(error));
    proc.on("close", (code: number | null) => {
      if (code === 0) finish();
      else finish(new Error(`${label}失败（ffmpeg 退出码=${code}）：${Buffer.concat(err).toString().trim()}`));
    });
    proc.stdin?.end(input);
  });
}

/**
 * 把任意音频字节转成 16bit 单声道 PCM（s16le）字节（Termux 分块录音喂 ASR 用）。
 * @param input 原始音频字节
 * @param format 输入格式（opus/aac/wav/pcm…；压缩容器自动探测）
 * @param inputSampleRate 输入采样率（仅 `pcm` 需要）
 * @param outSampleRate 输出采样率（Hz）
 * @param outChannels 输出声道数
 * @returns s16le PCM 字节
 * @throws Error ffmpeg 不可用或转码失败
 */
export function decodeToPcm(
  input: Buffer,
  format: string,
  inputSampleRate: number,
  outSampleRate: number,
  outChannels: number,
): Promise<Buffer> {
  return runFfmpeg(
    buildPcmDecodeArgs(format, inputSampleRate, outSampleRate, outChannels),
    input,
    DECODE_TIMEOUT_MS,
    "音频解码",
  );
}
