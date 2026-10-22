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
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Logger } from "@xiaoqiong0v0/opencode-plugin-logger";

// WAV 头构造已收敛到 `voice/wav.ts`（按段 ASR 也复用）；此处再导出以保持 tts 侧既有导入路径不变。
import { buildWav, buildWavHeader, WAV_HEADER_BYTES } from "../wav.js";
import { selectPlayer, type SelectedPlayer } from "./player.js";
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
  /** 策略类型。 */
  readonly kind: "stream" | "segments";
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
  private child: ChildProcess | null = null;
  private ended = false;
  private failed = false;

  /**
   * @param player 选中的流式播放器
   */
  constructor(player: SelectedStreamPlayer) {
    this.player = player;
    this.id = player.id;
  }

  write(chunk: Buffer): void {
    if (this.ended || this.failed || chunk.length === 0) return;
    if (!this.child) this.spawnPlayer();
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed) return;
    stdin.write(chunk);
  }

  /** 流式为连续流，句边界无需切割（无操作）。 */
  boundary(): void {
    // 无操作：stdin 播放器天然连续播放
  }

  end(): Promise<void> {
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
    this.child.on("error", () => {
      this.child = null;
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
    this.safetyBytes = Math.max(2, Math.round(sampleRate * PCM_CHANNELS * (PCM_BITS / 8) * MAX_SEGMENT_SECONDS));
  }

  write(chunk: Buffer): void {
    if (this.aborted || chunk.length === 0) return;
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    // 正常不在此切段（段边界由 boundary() 决定）；仅当单句异常超长时兜底，避免缓冲无界
    if (this.buffered >= this.safetyBytes) this.flush();
  }

  /** 一个句子的音频已收完：落成一段（段边界 = 句边界）。 */
  boundary(): void {
    if (this.aborted) return;
    this.flush();
  }

  async end(): Promise<void> {
    this.flush();
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

/**
 * 按策略创建音频落地。
 * @param strategy 选定策略
 * @param sampleRate 采样率（Hz；分段回退补 WAV 头用）
 * @param log 日志器
 * @returns AudioSink
 */
export function createAudioSink(strategy: AudioStrategy, sampleRate: number, log: Logger): AudioSink {
  if (strategy.kind === "stream") return new StreamSink(strategy.player);
  return new SegmentedSink(strategy.player, sampleRate, log);
}
