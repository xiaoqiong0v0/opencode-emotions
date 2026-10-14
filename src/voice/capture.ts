/**
 * 麦克风采集：用 ffmpeg-static 从系统音频输入设备取 16kHz/单声道/16bit PCM（s16le）。
 *
 * 采集进程（子进程）与 ASR 客户端并发运行；共享状态与顺序契约见 docs/ASYNC.md。
 * 事件：`data`（PCM 分片）、`error`、`close`。
 */

import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

import { resolveFfmpegPath } from "./ffmpeg.js";

export { resolveFfmpegPath } from "./ffmpeg.js";

/** 采集采样率（Hz）：与阿里云实时 ASR 要求一致。 */
export const CAPTURE_SAMPLE_RATE = 16000;
/** 采集声道数：单声道。 */
export const CAPTURE_CHANNELS = 1;
/** 每个采样点字节数（s16le）。 */
export const BYTES_PER_SAMPLE = 2;

/** stderr 诊断信息保留的最大字符数。 */
const STDERR_TAIL_CHARS = 2000;

/** 音频输入设备。 */
export interface AudioDevice {
  /** 友好名（喂给 ffmpeg dshow 的名字）。 */
  name: string;
  /** dshow 备用名（可能为空）。 */
  alternativeName?: string;
}

/** MicCapture 事件表（供类型化 on/emit 使用）。 */
export interface MicCaptureEventMap {
  data: [chunk: Buffer];
  error: [error: Error];
  close: [code: number | null];
}

/** MicCapture 配置。 */
export interface MicCaptureOptions {
  /** 设备友好名；缺省由调用方先枚举选择。 */
  device: string;
  /** 采集采样率（Hz）；缺省 CAPTURE_SAMPLE_RATE，按 ASR provider 预设传入。 */
  sampleRate?: number;
}

/**
 * 从 ffmpeg `-list_devices` 的 stderr 文本解析 dshow 音频设备。
 * @param text ffmpeg 输出文本
 * @returns 设备列表
 */
function parseDshowDevices(text: string): AudioDevice[] {
  const devices: AudioDevice[] = [];
  const nameRe = /"([^"]+)"\s*\(audio\)/g;
  const altRe = /Alternative name "([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = nameRe.exec(text)) !== null) {
    devices.push({ name: match[1] });
  }
  let index = 0;
  while ((match = altRe.exec(text)) !== null) {
    if (devices[index]) devices[index].alternativeName = match[1];
    index += 1;
  }
  return devices;
}

/**
 * 枚举本机 dshow 音频输入设备（Windows）。
 * @returns 设备列表（可能为空）
 */
export function listAudioDevices(): AudioDevice[] {
  const args = ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"];
  const result = spawnSync(resolveFfmpegPath(), args, { encoding: "utf8" });
  const text = `${result.stderr ?? ""}${result.stdout ?? ""}`;
  return parseDshowDevices(text);
}

/**
 * 构造 ffmpeg 采集参数。
 * @param device 设备友好名
 * @param sampleRate 目标采样率（Hz）；缺省 CAPTURE_SAMPLE_RATE
 * @returns ffmpeg 参数数组
 */
export function buildCaptureArgs(device: string, sampleRate: number = CAPTURE_SAMPLE_RATE): string[] {
  return [
    "-hide_banner",
    "-nostdin",
    "-f",
    "dshow",
    "-i",
    `audio=${device}`,
    "-f",
    "s16le",
    "-ar",
    String(sampleRate),
    "-ac",
    String(CAPTURE_CHANNELS),
    "-",
  ];
}

/** 麦克风采集器（EventEmitter，事件见 MicCaptureEventMap）。 */
export class MicCapture extends EventEmitter {
  private process: ChildProcess | null = null;
  private readonly device: string;
  private readonly sampleRate: number;
  private stderrTail = "";

  /**
   * @param options 采集配置
   */
  constructor(options: MicCaptureOptions) {
    super();
    this.device = options.device;
    this.sampleRate = options.sampleRate ?? CAPTURE_SAMPLE_RATE;
  }

  /** 采集是否进行中。 */
  get isRunning(): boolean {
    return this.process !== null;
  }

  /** ffmpeg stderr 的尾部（诊断用，最多 2000 字符）。 */
  get diagnostics(): string {
    return this.stderrTail;
  }

  /**
   * 启动采集；重复调用抛错。
   * @throws Error 已在运行
   */
  start(): void {
    if (this.process) {
      throw new Error("采集已在运行，不能重复启动");
    }
    this.stderrTail = "";
    const proc = spawn(resolveFfmpegPath(), buildCaptureArgs(this.device, this.sampleRate), {
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.process = proc;

    proc.stdout?.on("data", (chunk: Buffer) => {
      this.emit("data", chunk);
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-STDERR_TAIL_CHARS);
    });
    proc.on("error", (err: Error) => {
      this.emit("error", err);
    });
    proc.on("close", (code: number | null) => {
      this.process = null;
      this.emit("close", code);
    });
  }

  /** 停止采集（强制结束子进程）；未运行时无操作。 */
  stop(): void {
    const proc = this.process;
    if (!proc) return;
    proc.kill();
  }

  /** 类型化 `on`（事件名与参数由 MicCaptureEventMap 约束）。 */
  override on<K extends keyof MicCaptureEventMap>(
    event: K,
    listener: (...args: MicCaptureEventMap[K]) => void,
  ): this;
  override on(event: string | symbol, listener: (...args: unknown[]) => void): this;
  override on(event: string | symbol, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener);
  }
}
