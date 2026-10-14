/**
 * ffmpeg 可执行文件解析与音频转码工具（供采集与云 TTS 播放复用）。
 *
 * - `resolveFfmpegPath()`：环境变量 `FFMPEG_BIN` 优先，否则用 `ffmpeg-static` 随附二进制；
 * - `decodeToWav()`：把云 TTS 返回的任意音频字节（wav/pcm/mp3/opus）转成 WAV 字节，供本机播放。
 *
 * 纯 Node，用 `spawn` 走管道，不落中间文件。
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
/** ffmpeg-static 导出的 ffmpeg 二进制路径（平台不支持时为 null）。 */
const ffmpegStatic: string | null = require("ffmpeg-static") as string | null;

/** ffmpeg 路径环境变量名（用户自备 ffmpeg 时优先使用）。 */
export const FFMPEG_ENV = "FFMPEG_BIN";
/** 转码超时（毫秒）。 */
export const DECODE_TIMEOUT_MS = 15000;

/**
 * 解析 ffmpeg 可执行文件路径：环境变量优先，否则用 ffmpeg-static。
 * @returns ffmpeg 绝对路径
 * @throws Error 找不到可用二进制
 */
export function resolveFfmpegPath(): string {
  const override = process.env[FFMPEG_ENV];
  if (override) return override;
  if (!ffmpegStatic) {
    throw new Error(`未找到 ffmpeg 可执行文件：请设置 ${FFMPEG_ENV} 或安装 ffmpeg-static`);
  }
  return ffmpegStatic;
}

/**
 * 构造把输入音流转成 WAV 的 ffmpeg 参数。
 * @param format 输入格式（`pcm` 需显式声明裸流参数，其余自动探测）
 * @param sampleRate 输入采样率（仅 `pcm` 需要）
 * @returns ffmpeg 参数数组（stdin → stdout）
 */
export function buildDecodeArgs(format: string, sampleRate: number): string[] {
  const head = ["-hide_banner", "-loglevel", "error"];
  const input =
    format === "pcm"
      ? ["-f", "s16le", "-ar", String(sampleRate), "-ac", "1", "-i", "pipe:0"]
      : ["-i", "pipe:0"];
  return [...head, ...input, "-f", "wav", "pipe:1"];
}

/**
 * 把任意音频字节转成 WAV（16bit PCM）字节。
 * @param input 原始音频字节
 * @param format 输入格式（wav/pcm/mp3/opus）
 * @param sampleRate 输入采样率（`pcm` 需要）
 * @returns WAV 字节
 * @throws Error ffmpeg 不可用或转码失败
 */
export function decodeToWav(input: Buffer, format: string, sampleRate: number): Promise<Buffer> {
  return new Promise<Buffer>((resolveDecode, rejectDecode) => {
    let proc;
    try {
      proc = spawn(resolveFfmpegPath(), buildDecodeArgs(format, sampleRate), { stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      rejectDecode(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectDecode(error);
      else resolveDecode(Buffer.concat(out));
    };
    const timer = setTimeout(() => {
      proc.kill();
      finish(new Error(`音频转码超时（${DECODE_TIMEOUT_MS}ms）`));
    }, DECODE_TIMEOUT_MS);
    proc.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    proc.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
    proc.on("error", (error: Error) => finish(error));
    proc.on("close", (code: number | null) => {
      if (code === 0) finish();
      else finish(new Error(`音频转码失败（ffmpeg 退出码=${code}）：${Buffer.concat(err).toString().trim()}`));
    });
    proc.stdin?.end(input);
  });
}
