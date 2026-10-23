/**
 * WAV 读取、封装与格式转换（纯 Node，不依赖 ffmpeg）。
 *
 * 用途：
 * - 读：非交互自测时把一段 WAV 文件读成 ASR 客户端要求的
 *   16kHz/单声道/16bit PCM 字节流（仅支持未压缩 PCM 的 WAV）。
 * - 写：`buildWavHeader`/`buildWav` 把裸 s16le PCM 打包成标准 WAV
 *   （按段 ASR 上传 data URL 用；头构造逻辑原先在 `tts/audio-sink.ts`，统一收敛到本模块）。
 */

import { closeSync, openSync, readFileSync, readSync } from "node:fs";

/** 一个 WAV 头（PCM）的字节数。 */
export const WAV_HEADER_BYTES = 44;

/** WAV 头信息（不读 data 区，供流式播放预取文件用）。 */
export interface WavHeaderInfo {
  /** 采样率（Hz）。 */
  sampleRate: number;
  /** 声道数。 */
  channels: number;
  /** 位深（bit）。 */
  bitsPerSample: number;
  /** data 区在文件中的起始偏移（字节）。 */
  dataOffset: number;
  /** data 区长度（字节；以头部声明为准）。 */
  dataBytes: number;
}

/** 扫描 WAV 头时最多读取的字节数（canonical 头只有 44 字节；给扩展块留余量）。 */
const WAV_HEADER_SCAN_BYTES = 4096;

/**
 * **只读文件头**解析 WAV 的 fmt/data 信息（不加载 data 区）。
 *
 * 用途：自动朗读预取——播放进程拿到合成出的 WAV 后先读头拿采样率/数据区间，再流式喂给播放器。
 * 与 {@link parseWav} 同一套 chunk 规则（含偶数字节对齐），但只读前 {@link WAV_HEADER_SCAN_BYTES} 字节。
 * @param path WAV 文件路径
 * @returns 采样率/声道/位深与 data 区间
 * @throws Error 不是合法 WAV、缺少 fmt/data 块或头超出扫描上限
 */
export function readWavHeader(path: string): WavHeaderInfo {
  let fd: number | null = null;
  let buf: Buffer;
  try {
    fd = openSync(path, "r");
    buf = Buffer.alloc(WAV_HEADER_SCAN_BYTES);
    const read = readSync(fd, buf, 0, buf.length, 0);
    buf = buf.subarray(0, read);
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // 关闭失败忽略（只读探测）
      }
    }
  }
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("不是合法的 WAV 文件（缺少 RIFF/WAVE 标识）");
  }
  let fmt: { channels: number; sampleRate: number; bits: number } | null = null;
  let dataOffset = -1;
  let dataBytes = 0;
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === "fmt ") {
      if (body + 16 > buf.length) break;
      fmt = {
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      dataOffset = body;
      dataBytes = size;
      break;
    }
    pos = body + size + (size % 2);
  }
  if (!fmt || dataOffset < 0) throw new Error("WAV 缺少 fmt 或 data 块（或头部超出扫描上限）");
  return { sampleRate: fmt.sampleRate, channels: fmt.channels, bitsPerSample: fmt.bits, dataOffset, dataBytes };
}

/** 解析出的 WAV 内容。 */
export interface WavData {
  /** 采样率（Hz）。 */
  sampleRate: number;
  /** 声道数。 */
  channels: number;
  /** 位深（仅支持 16）。 */
  bitsPerSample: number;
  /** 数据区（交错的原始 PCM 字节）。 */
  data: Buffer;
}

/**
 * 解析 WAV（RIFF）头部与数据区，兼容 chunk 之间的填充字节。
 * @param buf 完整文件字节
 * @returns 解析结果
 * @throws Error 文件不是合法 WAV，或缺少 fmt/data 块
 */
export function parseWav(buf: Buffer): WavData {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("不是合法的 WAV 文件（缺少 RIFF/WAVE 标识）");
  }
  let fmt: { channels: number; sampleRate: number; bits: number } | null = null;
  let data: Buffer | null = null;

  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === "fmt ") {
      fmt = {
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      data = buf.subarray(body, Math.min(body + size, buf.length));
    }
    pos = body + size + (size % 2); // chunk 按偶数字节对齐
  }

  if (!fmt || !data) {
    throw new Error("WAV 缺少 fmt 或 data 块");
  }
  return { sampleRate: fmt.sampleRate, channels: fmt.channels, bitsPerSample: fmt.bits, data };
}

/**
 * 读取 WAV 并转为目标采样率的单声道 16bit PCM 字节流。
 * @param path WAV 文件路径
 * @param targetRate 目标采样率（如 16000）
 * @returns s16le 字节流
 * @throws Error 非 16bit PCM 或读取失败
 */
export function readWavAsPcm16(path: string, targetRate: number): Buffer {
  const wav = parseWav(readFileSync(path));
  if (wav.bitsPerSample !== 16) {
    throw new Error(`仅支持 16bit PCM WAV（当前 ${wav.bitsPerSample}bit）`);
  }
  const samples = toInt16(wav.data);
  const mono = toMono(samples, wav.channels);
  const resampled = wav.sampleRate === targetRate ? mono : resample(mono, wav.sampleRate, targetRate);
  return Buffer.from(resampled.buffer, resampled.byteOffset, resampled.byteLength);
}

/**
 * 生成指定时长的静音 PCM（用于喂给服务端 VAD 触发断句）。
 * @param milliseconds 时长（毫秒）
 * @param sampleRate 采样率
 * @returns 全 0 的 s16le 字节流
 */
export function silencePcm(milliseconds: number, sampleRate: number): Buffer {
  const samples = Math.max(0, Math.floor((milliseconds * sampleRate) / 1000));
  return Buffer.alloc(samples * 2);
}

/**
 * 构造标准 PCM WAV 头（44 字节，小端）。
 * @param dataLength 数据区字节数
 * @param sampleRate 采样率（Hz）
 * @param channels 声道数（默认单声道）
 * @param bits 位深（默认 16）
 * @returns 44 字节 WAV 头
 */
export function buildWavHeader(dataLength: number, sampleRate: number, channels = 1, bits = 16): Buffer {
  const blockAlign = (channels * bits) / 8;
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataLength, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bits, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataLength, 40);
  return header;
}

/**
 * 把裸 s16le 单声道 PCM 打包为完整 WAV 文件字节（16bit）。
 * @param pcm s16le 字节流
 * @param sampleRate 采样率（Hz）
 * @returns 完整 WAV 字节（44 字节头 + data）
 */
export function buildWav(pcm: Buffer, sampleRate: number): Buffer {
  return Buffer.concat([buildWavHeader(pcm.length, sampleRate), pcm]);
}

/**
 * 把字节流按小端 16bit 转成 Int16Array。
 * @param data s16le 字节
 * @returns 采样点数组
 */
function toInt16(data: Buffer): Int16Array {
  const count = Math.floor(data.length / 2);
  const out = new Int16Array(count);
  for (let i = 0; i < count; i += 1) {
    out[i] = data.readInt16LE(i * 2);
  }
  return out;
}

/**
 * 多声道下混为单声道（逐帧求平均）。
 * @param samples 交错采样点
 * @param channels 声道数
 * @returns 单声道采样点
 */
function toMono(samples: Int16Array, channels: number): Int16Array {
  if (channels <= 1) return samples;
  const frames = Math.floor(samples.length / channels);
  const out = new Int16Array(frames);
  for (let i = 0; i < frames; i += 1) {
    let sum = 0;
    for (let c = 0; c < channels; c += 1) {
      sum += samples[i * channels + c];
    }
    out[i] = Math.round(sum / channels);
  }
  return out;
}

/**
 * 线性插值重采样（单声道）。块级独立处理，块边界可能有轻微不连续（自测可接受）。
 * @param samples 单声道采样点
 * @param srcRate 原采样率
 * @param dstRate 目标采样率
 * @returns 重采样后的采样点
 */
function resample(samples: Int16Array, srcRate: number, dstRate: number): Int16Array {
  if (srcRate === dstRate || samples.length === 0) return samples;
  const count = Math.max(0, Math.round((samples.length * dstRate) / srcRate));
  const out = new Int16Array(count);
  if (count === 0) return out;
  if (samples.length === 1) {
    out.fill(samples[0]);
    return out;
  }
  const ratio = (samples.length - 1) / (count - 1);
  for (let i = 0; i < count; i += 1) {
    const x = i * ratio;
    const left = Math.floor(x);
    const right = Math.min(left + 1, samples.length - 1);
    const frac = x - left;
    out[i] = Math.round(samples[left] * (1 - frac) + samples[right] * frac);
  }
  return out;
}
