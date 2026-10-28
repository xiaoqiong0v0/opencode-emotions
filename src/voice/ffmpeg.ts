/**
 * ffmpeg 可执行文件解析与音频转码工具（供采集复用）。
 *
 * - `resolveFfmpegPath()`：解析顺序（**纯自包含**，2026-10-28 第十九批）
 *   1. `FFMPEG_BIN` —— 显式设置的**人工逃生门**（离线/内网），且必须通过真执行校验；
 *   2. `ffmpeg-static` 随包二进制（`optionalDependencies`，惰性 + try/catch 加载）—— 存在且通过真执行校验；
 *   3. 失败 —— 抛带**用户引导**的清晰错误（文案见 `voice/guidance.ts`）。
 *   **不再回落到系统 PATH**（旧的 `isOnPath("ffmpeg")` 分支已删除；`commandExists` 仅 Termux 例外路径仍在用）。
 *   **可用性判定＝真执行**：`spawnSync(<bin>, ["-version"])`（`shell:false`、3s 超时、退出码 0），
 *   结果按路径 memo（每进程一次）——修掉「文件存在 / PATH 命中但不可执行」的假阳性。
 *   **Termux 例外**：无 Android 预编译二进制，仍用系统 `ffmpeg`（PATH），缺失时提示 `pkg install ffmpeg`。
 *   *为何用 `spawnSync` 而非异步 `spawn`*：`resolveFfmpegPath` 是同步 API（被 `listAudioDevices` /
 *   `MicCapture.start` 等同步路径调用），改异步会波及全部采集调用方；memo 后每进程至多阻塞一次。
 * - `decodeToPcm()`：把任意音频字节（含 Termux 分块录音的 opus/aac）转成 16k 单声道 s16le PCM，喂 ASR。
 *
 * 纯 Node，用 `spawn` 走管道，不落中间文件。
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute } from "node:path";

import { ffmpegInstallHints, ffmpegMissingGuidance } from "./guidance.js";
import { commandExists, isTermux } from "./platform.js";

export { ffmpegInstallHints };

const require = createRequire(import.meta.url);

/** ffmpeg 路径环境变量名（用户自备 ffmpeg 时的显式逃生门）。 */
export const FFMPEG_ENV = "FFMPEG_BIN";
/** 转码超时（毫秒）。 */
export const DECODE_TIMEOUT_MS = 15000;
/** `-version` 真执行校验超时（毫秒）。 */
export const FFMPEG_PROBE_TIMEOUT_MS = 3000;

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
 * 真执行校验函数签名：执行 `<bin> -version`，返回退出码（启动失败/超时返回负值）。
 */
export type FfmpegProbe = (bin: string) => number;

/**
 * 执行 `<bin> -version` 探测可执行性（生产默认实现）。
 *
 * `shell:false`（不经过 shell）、3s 超时、stdout/stderr 全部丢弃但照常捕获管道（防子进程写满阻塞）。
 * @param bin 候选可执行路径/命令名
 * @returns 退出码；spawn 失败（ENOENT/EACCES）或超时为 -1
 */
function runVersionProbe(bin: string): number {
  try {
    const result = spawnSync(bin, ["-version"], {
      shell: false,
      windowsHide: true,
      timeout: FFMPEG_PROBE_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error) return -1;
    return typeof result.status === "number" ? result.status : -1;
  } catch {
    return -1;
  }
}

/** 真执行校验结果 memo（key=可执行路径；`true`/`false` 都缓存，每进程只 spawn 一次）。 */
const probeCache = new Map<string, boolean>();

/**
 * 复位真执行校验 memo（**仅供测试**；生产不要调用）。
 */
export function resetFfmpegProbeCache(): void {
  probeCache.clear();
}

/**
 * 清除单个路径的校验缓存（**文件被替换/重新下载后必须清**，否则会命中旧结论）。
 * @param bin 可执行路径
 */
export function forgetFfmpegProbe(bin: string): void {
  probeCache.delete(bin);
}

/**
 * 判断 ffmpeg 可执行文件是否真正可用：真执行 `<bin> -version` 且退出码 0。
 *
 * 结果按路径 memo（同一进程第二次直接命中缓存，不再 spawn）。
 * @param bin 可执行路径/命令名
 * @param probe 执行实现（测试可注入；仍走 memo）
 * @returns 可用 true
 */
export function probeFfmpeg(bin: string, probe: FfmpegProbe = runVersionProbe): boolean {
  const cached = probeCache.get(bin);
  if (cached !== undefined) return cached;
  const ok = probe(bin) === 0;
  probeCache.set(bin, ok);
  return ok;
}

/**
 * `resolveFfmpegPath` 的可注入选项（便于离线单测，不影响生产默认行为）。
 */
export interface ResolveFfmpegOptions {
  /** 环境变量表；默认 `process.env`。 */
  env?: NodeJS.ProcessEnv;
  /** 目标平台；默认 `process.platform`。 */
  platform?: NodeJS.Platform;
  /** PATH 探测函数（**仅 Termux 例外路径**使用）；默认按 env/platform 走 `commandExists`。 */
  isOnPath?: (bin: string) => boolean;
  /** 随附二进制解析函数；默认惰性 `ffmpeg-static`。 */
  staticPath?: () => string | null;
  /** 文件存在性检查；默认 `fs.existsSync`（测试可注入以覆盖「路径在但文件缺失」分支）。 */
  exists?: (path: string) => boolean;
  /** 真执行校验实现（默认走 memo 化的 `-version` 探测）。 */
  probe?: FfmpegProbe;
  /** Termux 判定；默认 `platform.ts` 的 `isTermux`。 */
  termux?: (env: NodeJS.ProcessEnv) => boolean;
}

/**
 * 存在性命中（Windows 兼容 `.exe` 后缀补全）。
 * @param candidate 候选路径
 * @param exists 存在性检查
 * @param platform 目标平台
 * @returns 命中的完整路径；未命中 null
 */
function existingCandidate(
  candidate: string,
  exists: (path: string) => boolean,
  platform: NodeJS.Platform,
): string | null {
  if (exists(candidate)) return candidate;
  if (platform === "win32" && !candidate.toLowerCase().endsWith(".exe") && exists(`${candidate}.exe`)) {
    return `${candidate}.exe`;
  }
  return null;
}

/**
 * 是否含路径分隔符（裸命令名交给 OS 按 PATH 解析）。
 * @param candidate 候选值
 * @returns 含分隔符/绝对路径 true
 */
function hasPathSeparator(candidate: string): boolean {
  return isAbsolute(candidate) || candidate.includes("/") || candidate.includes("\\");
}

/**
 * Termux 例外：系统 `ffmpeg`（PATH），无需自包含二进制、也不做真执行校验。
 * @param override `FFMPEG_BIN` 原始值（已 trim，可能为空）
 * @param context 注入项
 * @returns 可执行路径/命令名
 * @throws Error 系统 ffmpeg 不可用（文案提示 `pkg install ffmpeg`）
 */
function resolveTermuxFfmpeg(
  override: string | undefined,
  context: {
    env: NodeJS.ProcessEnv;
    platform: NodeJS.Platform;
    exists: (path: string) => boolean;
    isOnPath: (bin: string) => boolean;
  },
): string {
  const { env, platform, exists, isOnPath } = context;
  if (override) {
    const hit = existingCandidate(override, exists, platform);
    if (hit) return hit;
    if (!hasPathSeparator(override) && isOnPath(override)) return override;
  }
  if (isOnPath("ffmpeg")) return "ffmpeg";
  throw new Error(
    ffmpegMissingGuidance({
      platform,
      env,
      override: override || undefined,
      overrideProblem: override ? "missing-file" : undefined,
    }),
  );
}

/**
 * 解析 ffmpeg 可执行文件路径（**纯自包含**）。
 *
 * 顺序：`FFMPEG_BIN`（显式且真执行通过）→ `ffmpeg-static`（存在且真执行通过）→ 抛错。
 * **不回落系统 PATH**（Termux 例外：走系统 `ffmpeg`）。
 * @param options 可注入选项（env/platform/存在性/真执行/随附路径，缺省用生产默认）
 * @returns ffmpeg 可执行文件绝对路径（Termux 下可能是命令名 `ffmpeg`）
 * @throws Error 均不可用（错误文本含去哪配/怎么配的中文引导）
 */
export function resolveFfmpegPath(options: ResolveFfmpegOptions = {}): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;
  const override = env[FFMPEG_ENV]?.trim();

  if ((options.termux ?? isTermux)(env)) {
    return resolveTermuxFfmpeg(override, {
      env,
      platform,
      exists,
      isOnPath: options.isOnPath ?? ((bin: string) => commandExists(bin, env, platform)),
    });
  }

  const probe = options.probe;
  // ① 显式逃生门：文件存在（或裸命令名）且 `-version` 真执行通过
  if (override) {
    const hit = existingCandidate(override, exists, platform);
    const candidate = hit ?? (hasPathSeparator(override) ? null : override);
    if (candidate && probeFfmpeg(candidate, probe)) return candidate;
  }

  // ② 随包自包含二进制：存在且 `-version` 真执行通过
  const staticPath = (options.staticPath ?? loadFfmpegStatic)();
  const staticHit = staticPath ? existingCandidate(staticPath, exists, platform) : null;
  if (staticHit && probeFfmpeg(staticHit, probe)) return staticHit;

  // ③ 失败（不回落 PATH）
  throw new Error(
    ffmpegMissingGuidance({
      platform,
      env,
      override: override || undefined,
      overrideProblem: override ? (existingCandidate(override, exists, platform) ? "unusable" : "missing-file") : undefined,
      staticProblem: staticPath
        ? existingCandidate(staticPath, exists, platform)
          ? "unusable"
          : "missing-file"
        : undefined,
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
