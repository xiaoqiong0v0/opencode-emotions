/**
 * **音频落地（AudioSink）**：把云端返回的**裸 PCM（s16le 单声道）帧**边收边放。
 *
 * 策略（`selectAudioStrategy`，同步选定——无任何可用路径立即抛清晰错误，不静默）：
 * - 首选**流式**：`stream-player.ts` 里能吃 stdin 的播放器（Windows 内置 waveOut（`pwsh`+winmm）、
 *   Linux `aplay`/`paplay`/`sox play`、`ffplay`），音频帧到达即写入其 stdin，**零落盘、零等待**（低首包延迟）。
 * - 回退**分段**：找不到流式播放器时，用 `player.ts` 的文件播放器（Windows SoundPlayer /
 *   Termux play-audio / macOS afplay / Linux paplay·aplay）——**段边界 = 句边界**：由 provider 在每句
 *   音频收完后调 `boundary()` 落一段（补 44 字节 WAV 头写临时文件后**顺序播放**）；仅在单句异常超长
 *   时按安全上限（{@link MAX_SEGMENT_SECONDS}）兜底切分，避免缓冲无界。
 *
 * 纯函数（策略选择、WAV 头构造）与 IO（spawn）分离，便于离线单测。
 *
 * **首尾静音裁剪（2026-10-22，第十三批修法 1）**：两条播放路径在写播放器/落段之前都经
 * `silence-trim.ts` 的 `SilenceTrimmer`——首部静音丢弃（首音延迟不增加）、尾部静音裁到只剩
 * 保护余量、全静音流原样放行（不裁空）。**只作用于 TTS 输出**，ASR 采集链路完全不经过本模块。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Logger } from "@xiaoqiong0v0/opencode-plugin-logger";

// WAV 头构造已收敛到 `voice/wav.ts`（按段 ASR 也复用）；此处再导出以保持 tts 侧既有导入路径不变。
import { buildWav, buildWavHeader, WAV_HEADER_BYTES } from "../wav.js";
import { selectPlayer, type SelectedPlayer } from "./player.js";
import { SilenceTrimmer, type SilenceTrimStats } from "./silence-trim.js";
import { selectStreamPlayer, type SelectedStreamPlayer, type SelectStreamPlayerOptions } from "./stream-player.js";

export { buildWavHeader, WAV_HEADER_BYTES };

/** 裸 PCM 的固定格式（CosyVoice 流式输出）。 */
export const PCM_CHANNELS = 1;
export const PCM_BITS = 16;
/** 分段回退的安全上限：单段最长时长（秒）——仅用于兜底，正常段边界由 `boundary()`（句边界）决定。 */
export const MAX_SEGMENT_SECONDS = 30;

/** 一次播放策略：流式或分段。 */
export type AudioStrategy =
  | { kind: "stream"; player: SelectedStreamPlayer }
  | { kind: "segments"; player: SelectedPlayer };

/** 音频落地抽象（`write` 按到达顺序喂入 PCM 帧）。 */
export interface AudioSink {
  /**
   * 策略类型：`stream`=stdin 流式播放器；`segments`=分段临时 WAV 顺序播放；
   * `pcm-file`=**只合成不出声**（写 WAV 文件，供自动朗读预取）。
   */
  readonly kind: "stream" | "segments" | "pcm-file";
  /** 播放器 id（日志/错误用）。 */
  readonly id: string;
  /** 写入一帧裸 PCM（s16le 单声道）。 */
  write(chunk: Buffer): void;
  /** 标记「一个句子的音频已收完」：分段路径据此把当前缓冲落成一段（**段边界 = 句边界**）；流式为无操作。 */
  boundary(): void;
  /** 结束：等待已写入的音频**真正播完**（流式关闭 stdin 等退出；分段等队列清空）。 */
  end(): Promise<void>;
  /** 立即中断：杀掉播放进程、清理临时文件（幂等）。 */
  abort(): void;
  /** 首尾静音裁剪统计（毫秒；日志/端到端自测核对「裁掉多少」用）。 */
  trimStats(): SilenceTrimStats;
  /**
   * **预热**（可选）：在**还没有任何音频**时提前启动发声进程（打开设备、加载编译缓存），
   * 使随后的首帧写入到出声的延迟≈0。仅流式 sink 实现；分段/文件 sink 无操作。
   *
   * 语义边界：预热**不出声**（waveOut 脚本在 `Read` 上阻塞，无数据即静音），且**不得**写
   * `tts-playback` 登记（那是「正在播放」的判据）；失败可忽略——写入首帧时仍会按需 spawn。
   */
  prewarm?(): void;
}

/** 策略选择选项。 */
export interface SelectAudioStrategyOptions extends SelectStreamPlayerOptions {
  /** 预选定的文件播放器（缺省内部 `selectPlayer`）；测试可注入。 */
  filePlayer?: SelectedPlayer;
}

/**
 * 同步选定播放策略：优先流式，其次分段（文件播放器）。都没有时抛**清晰错误**。
 * @param options 选项（采样率/平台/env/探测/预选文件播放器）
 * @returns 选定的策略
 * @throws Error 无任何可用播放路径（错误文本含流式候选与文件播放器候选，以及 `TTS_PLAYER` 提示）
 */
export function selectAudioStrategy(options: SelectAudioStrategyOptions): AudioStrategy {
  const stream = selectStreamPlayer(options);
  if (stream) return { kind: "stream", player: stream };
  try {
    const file = options.filePlayer ?? selectPlayer({ platform: options.platform, env: options.env, isAvailable: options.isAvailable });
    return { kind: "segments", player: file };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      "未找到可用的音频播放路径（流式与分段均不可用）。" +
        `流式候选：waveout(Windows 内置) / aplay / paplay / sox(play) / ffplay；分段回退：${detail}`,
    );
  }
}

/** 流式 sink：首帧到达才启动播放器，随后把 PCM 帧写入其 stdin。 */
class StreamSink implements AudioSink {
  readonly kind = "stream" as const;
  readonly id: string;
  private readonly player: SelectedStreamPlayer;
  private readonly trimmer: SilenceTrimmer;
  private child: ChildProcess | null = null;
  private ended = false;
  private failed = false;
  /** 是否已向播放器写过音频（用于区分「预热失败可重试」与「播放中崩溃不再重试」）。 */
  private audioStarted = false;

  /**
   * @param player 选中的流式播放器
   * @param sampleRate 采样率（Hz；首尾静音裁剪按帧判定用）
   */
  constructor(player: SelectedStreamPlayer, sampleRate: number) {
    this.player = player;
    this.id = player.id;
    this.trimmer = new SilenceTrimmer(sampleRate);
  }

  write(chunk: Buffer): void {
    if (this.ended || this.failed || chunk.length === 0) return;
    // 先裁剪再写：首部静音不落播放器（首音延迟不增加），尾部静音暂存到 end() 结算
    const trimmed = this.trimmer.push(chunk);
    if (trimmed.length > 0) this.writeRaw(trimmed);
  }

  /** 流式为连续流，句边界无需切割（无操作）。 */
  boundary(): void {
    // 无操作：stdin 播放器天然连续播放
  }

  /**
   * 预热：提前 spawn 播放器（打开设备、加载编译缓存），**不写任何音频**。
   * 只在尚无播放器、未结束、未失败时生效（幂等）；spawn 失败由写入首帧时的重试兜底。
   */
  prewarm(): void {
    if (this.ended || this.failed || this.child) return;
    this.spawnPlayer();
  }

  end(): Promise<void> {
    // 结算尾部静音（保留保护余量/全静音兜底）后才关 stdin，保证最后一批字节也进入播放器
    if (!this.ended) {
      const tail = this.trimmer.finish();
      if (tail.length > 0) this.writeRaw(tail);
    }
    const child = this.child;
    this.ended = true;
    if (!child) return Promise.resolve();
    return new Promise<void>((resolveEnd) => {
      if (child.exitCode !== null) {
        resolveEnd();
        return;
      }
      child.once("exit", () => resolveEnd());
      child.once("error", () => resolveEnd());
      try {
        child.stdin?.end();
      } catch {
        resolveEnd();
      }
    });
  }

  abort(): void {
    this.ended = true;
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null) {
      try {
        child.kill();
      } catch {
        // 中断阶段异常忽略
      }
    }
  }

  trimStats(): SilenceTrimStats {
    return this.trimmer.getStats();
  }

  /** 把（已裁剪的）PCM 写入播放器 stdin；首帧才启动播放器。 */
  private writeRaw(data: Buffer): void {
    if (this.failed || data.length === 0) return;
    if (!this.child) this.spawnPlayer();
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed) return;
    stdin.write(data);
    this.audioStarted = true;
  }

  /** 启动流式播放器（stdin 为 pipe）。 */
  private spawnPlayer(): void {
    const command = this.player.launcher();
    try {
      this.child = spawn(command.bin, command.args, { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
    } catch {
      this.child = null;
      this.failed = true;
      return;
    }
    this.child.stderr?.on("data", () => {
      // 流式播放器的 stderr 多为非致命提示，忽略（不刷屏）
    });
    const spawned = this.child;
    // 播放器退出：**预热阶段**（还没写过音频）失败 → 清引用，首帧写入重新 spawn（退化为「首帧才启动」，
    // 不静默丢音，最多重试一次）；**播放中**退出 → 置 failed，不再重 spawn（避免逐帧派生风暴）。
    spawned.on("exit", () => {
      if (this.child !== spawned) return;
      if (this.audioStarted) this.failed = true;
      else this.child = null;
    });
    spawned.on("error", () => {
      if (this.child === spawned) this.child = null;
      this.failed = true;
    });
  }
}

/**
 * 分段 sink：**段边界 = 句边界**——由 provider 在每句音频收完后调 `boundary()` 落一段，
 * 补 WAV 头写临时文件后**顺序**播放（上一段播放期间可继续合成/落下一段，减少间隙）。
 * 仅在单句异常超长时按安全上限 {@link MAX_SEGMENT_SECONDS} 兜底切分，避免缓冲无界。
 */
class SegmentedSink implements AudioSink {
  readonly kind = "segments" as const;
  readonly id: string;
  private readonly player: SelectedPlayer;
  private readonly sampleRate: number;
  private readonly safetyBytes: number;
  private readonly log: Logger;
  private readonly chunks: Buffer[] = [];
  private trimmer: SilenceTrimmer;
  /** 已完成句子的裁剪统计累计（`trimStats()` 返回跨句总计）。 */
  private readonly trimTotals: SilenceTrimStats = { inputMs: 0, emittedMs: 0, leadingTrimmedMs: 0, trailingTrimmedMs: 0 };
  /** 当前句裁剪器是否已并入总账（防止 `boundary()`/`end()` 重复累计）。 */
  private trimAccumulated = false;
  private buffered = 0;
  private dir: string | null = null;
  private seq = 0;
  private queue: Promise<void> = Promise.resolve();
  private current: ChildProcess | null = null;
  private aborted = false;

  /**
   * @param player 文件播放器
   * @param sampleRate 采样率（Hz）
   * @param log 日志器
   */
  constructor(player: SelectedPlayer, sampleRate: number, log: Logger) {
    this.player = player;
    this.id = player.id;
    this.sampleRate = sampleRate;
    this.log = log;
    this.trimmer = new SilenceTrimmer(sampleRate);
    this.safetyBytes = Math.max(2, Math.round(sampleRate * PCM_CHANNELS * (PCM_BITS / 8) * MAX_SEGMENT_SECONDS));
  }

  write(chunk: Buffer): void {
    if (this.aborted || chunk.length === 0) return;
    // 一句之内流式裁剪；句边界（boundary）时结算尾部并换新裁剪器（每句独立，不跨段携带静音）
    const trimmed = this.trimmer.push(chunk);
    if (trimmed.length === 0) return;
    this.chunks.push(trimmed);
    this.buffered += trimmed.length;
    // 正常不在此切段（段边界由 boundary() 决定）；仅当单句异常超长时兜底，避免缓冲无界
    if (this.buffered >= this.safetyBytes) this.flush();
  }

  /** 一个句子的音频已收完：结算首尾静音 → 落成一段（段边界 = 句边界）。 */
  boundary(): void {
    if (this.aborted) return;
    this.settleTrimmer();
    this.flush();
    this.accumulateTrimStats();
    this.trimmer = new SilenceTrimmer(this.sampleRate);
    this.trimAccumulated = false;
  }

  async end(): Promise<void> {
    this.settleTrimmer();
    this.flush();
    this.accumulateTrimStats();
    await this.queue;
    this.cleanup();
  }

  abort(): void {
    this.aborted = true;
    this.chunks.length = 0;
    this.buffered = 0;
    const child = this.current;
    this.current = null;
    if (child && child.exitCode === null) {
      try {
        child.kill();
      } catch {
        // 忽略
      }
    }
    this.cleanup();
  }

  trimStats(): SilenceTrimStats {
    if (this.trimAccumulated) return { ...this.trimTotals };
    const current = this.trimmer.getStats();
    return {
      inputMs: this.trimTotals.inputMs + current.inputMs,
      emittedMs: this.trimTotals.emittedMs + current.emittedMs,
      leadingTrimmedMs: this.trimTotals.leadingTrimmedMs + current.leadingTrimmedMs,
      trailingTrimmedMs: this.trimTotals.trailingTrimmedMs + current.trailingTrimmedMs,
    };
  }

  /** 把当前句裁剪器并入本段缓冲后的统计总账（每句只并一次，幂等）。 */
  private accumulateTrimStats(): void {
    if (this.trimAccumulated) return;
    const current = this.trimmer.getStats();
    this.trimTotals.inputMs += current.inputMs;
    this.trimTotals.emittedMs += current.emittedMs;
    this.trimTotals.leadingTrimmedMs += current.leadingTrimmedMs;
    this.trimTotals.trailingTrimmedMs += current.trailingTrimmedMs;
    this.trimAccumulated = true;
  }

  /** 把裁剪器结算出的最后一批字节并入当前段缓冲（尾部保护余量 / 全静音兜底）。 */
  private settleTrimmer(): void {
    const tail = this.trimmer.finish();
    if (tail.length === 0) return;
    this.chunks.push(tail);
    this.buffered += tail.length;
  }

  /** 把当前缓冲落成一个 WAV 段并排入顺序播放队列。 */
  private flush(): void {
    if (this.buffered === 0) return;
    const pcm = Buffer.concat(this.chunks, this.buffered);
    this.chunks.length = 0;
    this.buffered = 0;
    // 「44 字节头 + PCM」拼接单源在 wav.buildWav（与按段 ASR 同一公式）
    const wav = buildWav(pcm, this.sampleRate);
    const file = this.writeSegment(wav);
    if (!file) return;
    this.queue = this.queue.then(() => this.playSegment(file));
  }

  /**
   * 把一段 WAV 写入专属临时目录。
   * @param wav WAV 字节
   * @returns 文件路径；失败返回 null
   */
  private writeSegment(wav: Buffer): string | null {
    try {
      if (!this.dir) this.dir = mkdtempSync(join(tmpdir(), "oc-tts-seg-"));
      const file = join(this.dir, `seg-${this.seq++}.wav`);
      writeFileSync(file, wav);
      return file;
    } catch (err) {
      this.log.warn("写 TTS 分段临时文件失败", err as Error);
      return null;
    }
  }

  /**
   * 顺序播放一段（等其退出再返回）。
   * @param file WAV 文件路径
   */
  private playSegment(file: string): Promise<void> {
    if (this.aborted) return Promise.resolve();
    const command = this.player.launcher(file);
    return new Promise<void>((resolveSegment) => {
      let child: ChildProcess;
      try {
        child = spawn(command.bin, command.args, {
          env: { ...process.env, ...command.env },
          stdio: ["ignore", "ignore", "pipe"],
          windowsHide: true,
        });
      } catch (err) {
        this.log.error(`启动分段播放器 ${command.bin}（${this.player.id}）失败`, err as Error);
        resolveSegment();
        return;
      }
      this.current = child;
      child.stderr?.on("data", (chunk: Buffer) => {
        const line = String(chunk).trim();
        if (line.length > 0) this.log.warn(`tts segment stderr: ${line}`);
      });
      child.on("error", (err: Error) => {
        if (this.current === child) this.current = null;
        this.log.error(`分段播放进程异常（${command.bin}）`, err);
        resolveSegment();
      });
      child.on("exit", (code: number | null) => {
        if (this.current === child) this.current = null;
        if (code !== null && code !== 0) this.log.error(`分段播放进程（${command.bin}）退出码=${code}`);
        resolveSegment();
      });
    });
  }

  /** 删除临时目录（幂等）。 */
  private cleanup(): void {
    const dir = this.dir;
    this.dir = null;
    if (!dir) return;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      this.log.warn("清理 TTS 分段临时目录失败", err as Error);
    }
  }
}

/** `PcmFileSink` 的选项。 */
export interface PcmFileSinkOptions {
  /**
   * data 区字节上限；缺省 **不限**（`Infinity`）。
   * 取舍见类注释：预取改为「跟随增长播放」后，截断会让**长单元在播放中途失败**，
   * 故默认不设限——磁盘占用由「单元正文上限（`DRAIN_MERGE_MAX_CHARS`）× 语速」天然有界，
   * 且文件在播完/失败/取消时立即删除。该选项保留给病态防御与单测。
   */
  maxBytes?: number;
}

/**
 * **只合成不出声**的 AudioSink：把（经同一套首尾静音裁剪的）16bit PCM 以 WAV 容器写进临时文件。
 *
 * 用途：自动朗读的**下一单元预取**——合成进程只落盘、不碰播放器；播放由另一个
 * `speak --pcm-file --pcm-follow` 进程在上一单元播完后**跟随文件增长**边到边读
 * （见 `tts/prefetch.ts` 与 `runPlayGrowingPcmFile`）。
 * 复用 provider 合成链路（`provider.speak` + `sink.write`）与 `SilenceTrimmer`——**不复制合成逻辑**。
 *
 * **写盘默认不限**（见 {@link PcmFileSinkOptions.maxBytes}）：边合成边播时播放端按当前文件长度读取，
 * 写端若在上限处截断会让播放中途失去尾部（用户听到「没念完」）。有界性由三件事共同保证：
 * 单元正文上限（≤ `DRAIN_MERGE_MAX_CHARS`）、合成超时（`PREFETCH_TIMEOUT_MS`）、播完即删文件。
 * 只有显式传入 `maxBytes` 时才按上限截断（`end()` 抛错，调用方降级）。
 */
export class PcmFileSink implements AudioSink {
  readonly kind = "pcm-file" as const;
  readonly id = "pcm-file";
  private readonly path: string;
  private readonly sampleRate: number;
  private readonly trimmer: SilenceTrimmer;
  private readonly maxBytes: number;
  private fd: number | null;
  private dataBytes = 0;
  private overflow = false;

  /**
   * @param path 输出 WAV 路径（覆盖写；调用方负责生命周期）
   * @param sampleRate 采样率（Hz；写头用）
   * @param options 上限选项（缺省不限）
   * @throws Error 文件无法创建/写头失败
   */
  constructor(path: string, sampleRate: number, options: PcmFileSinkOptions = {}) {
    this.path = path;
    this.sampleRate = sampleRate;
    this.trimmer = new SilenceTrimmer(sampleRate);
    this.maxBytes =
      options.maxBytes !== undefined && Number.isFinite(options.maxBytes)
        ? Math.max(2, Math.trunc(options.maxBytes))
        : Number.POSITIVE_INFINITY;
    this.fd = openSync(path, "w+");
    // 先占位 44 字节头，end() 时按真实 data 长度回填（流式写无法预知总长）
    writeSync(this.fd, buildWavHeader(0, sampleRate), 0, WAV_HEADER_BYTES, 0);
  }

  write(chunk: Buffer): void {
    if (this.fd === null || this.overflow || chunk.length === 0) return;
    // 与播放路径同一套裁剪：预取音频与直播音频的首尾静音口径一致
    this.writeRaw(this.trimmer.push(chunk));
  }

  /** 单元内连续，无需段边界（预取单元本身就是一个朗读单元）。 */
  boundary(): void {
    // 无操作
  }

  /**
   * 结算尾部静音、回填 WAV 头并关闭文件。
   * @throws Error 音频超过上限（此时已删除半成品文件）
   */
  async end(): Promise<void> {
    if (this.fd === null) {
      if (this.overflow) throw new Error(`预取音频超过上限（>${this.maxBytes} 字节）`);
      return;
    }
    this.writeRaw(this.trimmer.finish());
    const fd = this.fd;
    if (this.overflow) {
      this.fd = null;
      try {
        closeSync(fd);
      } catch {
        // 关闭失败忽略（随后删文件）
      }
      this.removeFile();
      throw new Error(`预取音频超过上限（>${this.maxBytes} 字节）`);
    }
    writeSync(fd, buildWavHeader(this.dataBytes, this.sampleRate), 0, WAV_HEADER_BYTES, 0);
    this.fd = null;
    try {
      closeSync(fd);
    } catch {
      // 关闭失败忽略（文件仍可被播放器读取）
    }
  }

  /** 中断：关闭并删除半成品文件（幂等）。 */
  abort(): void {
    const fd = this.fd;
    this.fd = null;
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // 忽略
      }
    }
    this.removeFile();
  }

  trimStats(): SilenceTrimStats {
    return this.trimmer.getStats();
  }

  /**
   * 已写入的 PCM 字节数（不含 44 字节头；日志/断言用）。
   * @returns data 区字节数
   */
  get bytesWritten(): number {
    return this.dataBytes;
  }

  /** 写入（已裁剪的）PCM；超上限只标记溢出、不再写盘。 */
  private writeRaw(data: Buffer): void {
    const fd = this.fd;
    if (fd === null || this.overflow || data.length === 0) return;
    if (this.dataBytes + data.length > this.maxBytes) {
      this.overflow = true;
      return;
    }
    writeSync(fd, data, 0, data.length, WAV_HEADER_BYTES + this.dataBytes);
    this.dataBytes += data.length;
  }

  /** 删除输出文件（静默失败）。 */
  private removeFile(): void {
    try {
      rmSync(this.path, { force: true });
    } catch {
      // 清理失败忽略
    }
  }
}

/**
 * 按策略创建音频落地。
 * @param strategy 选定策略
 * @param sampleRate 采样率（Hz；分段回退补 WAV 头用）
 * @param log 日志器
 * @returns AudioSink
 */
export function createAudioSink(strategy: AudioStrategy, sampleRate: number, log: Logger): AudioSink {
  if (strategy.kind === "stream") return new StreamSink(strategy.player, sampleRate);
  return new SegmentedSink(strategy.player, sampleRate, log);
}

/** 可注入音频落地的选项（仅 CLI 的 `--pcm-out` 使用）。 */
export interface SinkSourceOptions {
  /**
   * 自定义 sink 工厂（给定 provider 解析出的采样率）：
   * 预取路径注入 `PcmFileSink`，**不触碰播放器**；缺省走正常播放路径。
   */
  sinkFactory?: (sampleRate: number) => AudioSink;
}

/**
 * 为 provider 创建音频落地：有 `sinkFactory` 用之（PCM 落盘），否则按播放策略同步选定
 * （流式优先 → 分段回退 → 都不可用即抛清晰错误）。
 *
 * 单点收敛「provider 决定采样率 → 选播放器/落盘」的接线，避免每个 provider 各写一份。
 * @param options 含可选 `sinkFactory`
 * @param sampleRate provider 解析出的采样率（Hz）
 * @param log 日志器
 * @returns AudioSink
 * @throws Error 无可用播放路径（仅非 `sinkFactory` 路径）
 */
export function createProviderSink(options: SinkSourceOptions, sampleRate: number, log: Logger): AudioSink {
  if (options.sinkFactory) return options.sinkFactory(sampleRate);
  const strategy = selectAudioStrategy({ sampleRate });
  return createAudioSink(strategy, sampleRate, log);
}
