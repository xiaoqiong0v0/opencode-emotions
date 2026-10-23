/**
 * **TTS 输出的首尾静音裁剪**（流式、与分块边界无关）。
 *
 * 背景（2026-10-22 实测，见 `.tmp/scratch/gap-analysis.md`）：云端 TTS 每段音频自带
 * **首部静音 0.09~0.14s + 尾部静音 0.36~0.53s**；自动朗读逐单元串行播放时，这段静音
 * 直接叠加进「句间停顿」，是 0.5~0.65s 可消掉的部分。
 *
 * 口径（**不新造**）：
 * - 能量沿用 `voice/level.ts` 的 `pcmRms` + `rmsToDbfs`（与按段 ASR 的静音判定同一口径），
 *   按 {@link TTS_TRIM_FRAME_MS}（10ms）短帧结算，帧边界与 chunk 边界无关（分块只影响 IO，
 *   不影响判定结果）；
 * - 门限 {@link TTS_TRIM_THRESHOLD_DBFS}（-45 dBFS，RMS≈0.0056）：云端 TTS 的静音接近数字零、
 *   正常语声短帧通常 ≥ -35 dBFS，取 -45 留约 10dB 余量；**可调**——若发现轻语声（气声起音、
 *   耳语）被裁，把它调低（如 -50）；若底噪被当成语声，调高（如 -40）。
 *
 * 裁剪规则：
 * - **首部**：帧能量低于门限的帧先暂存，遇到首个有声帧时**整体丢弃**（首音延迟不增加：
 *   裁剪只丢字节，不引入等待）。首部静音超过 {@link TTS_TRIM_LEADING_HOLD_MAX_MS} 时
 *   **放弃首部裁剪**并把已暂存的静音原样放行（防御病态输入/内存无界）。
 * - **尾部**：有声之后低于门限的**连续静音帧**暂存在小缓冲里；遇到后续有声帧就整体放行
 *   （句内停顿不改），到流结束则只保留最后 {@link TTS_TRIM_TAIL_GUARD_MS}（100ms）作为
 *   保护余量（避免切掉气息/尾音收尾），其余丢弃。
 * - **全静音不裁空**：整段从未检出有声帧时，`finish()` 把原始字节全部放行（宁可播静音，
 *   也不出现「以为播了其实没声」）。
 *
 * 暂存上限与延迟：{@link TTS_TRIM_TAIL_HOLD_MAX_MS}（800ms）只是**静音帧**的暂存上限，
 * 超出即放行最旧的整帧。正常 TTS 单句内不会出现 >800ms 的停顿时，因此对语声时序零影响；
 * 只有「句内超长停顿」才会被限制在 800ms 内开始放行（否则内存与后续语声会被无限拖延）。
 *
 * 字节对齐：按 2 字节采样点整体丢弃/保留；chunk 尾部的奇数字节暂存到下一块（跨块拼成采样点），
 * 流尾若仍只剩 1 个字节则丢弃（不足以构成采样点，优先保证 16bit 对齐）。不改变顺序、采样率、声道。
 */

import { pcmRms, rmsToDbfs } from "../level.js";

/** 静音判定的短帧长度（毫秒）：与 ASR 段切分的 30ms 相比更短，避免首音/尾音被整帧吞掉。 */
export const TTS_TRIM_FRAME_MS = 10;
/**
 * 静音门限（dBFS）。依据：云端 TTS 的静音接近数字零（-90 dBFS 以下），正常语声
 * 10ms 短帧通常 ≥ -35 dBFS；取 -45 留约 10dB 余量。**可调**（见文件头）。
 */
export const TTS_TRIM_THRESHOLD_DBFS = -45;
/** 尾部保护余量（毫秒）：尾部静音只裁到剩这么长，避免切掉气息/尾音收尾。 */
export const TTS_TRIM_TAIL_GUARD_MS = 100;
/**
 * 尾部静音暂存上限（毫秒，仅静音帧）：超出即放行最旧的整帧。
 * 实测尾静音 0.36~0.53s，取 800ms 可完整裁掉；再大只会增加长停顿时的内存/放行延迟。
 */
export const TTS_TRIM_TAIL_HOLD_MAX_MS = 800;
/** 首部静音暂存上限（毫秒）：超过即放弃首部裁剪、原样放行（防御病态输入与内存无界）。 */
export const TTS_TRIM_LEADING_HOLD_MAX_MS = 2000;
/** 16bit 单声道每采样点字节数（裁剪按采样点对齐，绝不切断采样点）。 */
const PCM_BYTES_PER_SAMPLE = 2;

/** 裁剪器可调参数（默认取上方常量；测试用于构造边界场景）。 */
export interface SilenceTrimOptions {
  /** 静音门限（dBFS）。 */
  thresholdDbfs?: number;
  /** 尾部保护余量（毫秒）。 */
  tailGuardMs?: number;
  /** 尾部静音暂存上限（毫秒）。 */
  tailHoldMaxMs?: number;
  /** 首部静音暂存上限（毫秒）。 */
  leadingHoldMaxMs?: number;
}

/** 裁剪统计（毫秒；用于日志与端到端自测核对「裁掉多少」）。 */
export interface SilenceTrimStats {
  /** 输入总时长。 */
  inputMs: number;
  /** 实际放行（交给播放器）的时长。 */
  emittedMs: number;
  /** 首部被裁掉的时长。 */
  leadingTrimmedMs: number;
  /** 尾部被裁掉的时长。 */
  trailingTrimmedMs: number;
}

/** 裁剪器内部阶段：`leading`=尚未遇到有声帧；`body`=已进入正文（静音成为尾部候选）。 */
type TrimPhase = "leading" | "body";

/**
 * 流式首尾静音裁剪器：`push()` 喂入裸 PCM 块，返回**应当放行**的字节（可能为空）；
 * 流结束时调 `finish()` 取最后一批（尾部保护余量 / 全静音兜底）。
 *
 * 非线程安全：单实例只应由单条播放链（`AudioSink.write` 的调用方）顺序使用。
 */
export class SilenceTrimmer {
  /** 帧字节数（10ms 对齐到采样点）。 */
  private readonly frameBytes: number;
  /** 尾部保护余量（字节）。 */
  private readonly guardBytes: number;
  /** 尾部静音暂存上限（字节）。 */
  private readonly tailHoldBytes: number;
  /** 首部静音暂存上限（字节）。 */
  private readonly leadingHoldBytes: number;
  /** 静音门限（dBFS）。 */
  private readonly thresholdDbfs: number;
  /** 每秒字节数（统计用）。 */
  private readonly bytesPerSecond: number;
  /** 当前阶段。 */
  private phase: TrimPhase = "leading";
  /** 是否已检出有声帧（全静音兜底的判据）。 */
  private hasVoice = false;
  /** 首部阶段暂存的静音帧。 */
  private leading: Buffer[] = [];
  /** 首部暂存字节数。 */
  private leadingBytes = 0;
  /** 正文阶段暂存的尾部候选静音帧。 */
  private silence: Buffer[] = [];
  /** 尾部候选静音字节数。 */
  private silenceBytes = 0;
  /** 不足一帧的尾字节（保持帧切分与 chunk 边界无关）。 */
  private partialFrame: Buffer = Buffer.alloc(0);
  /** chunk 尾部的单个奇数字节（等下一块再拼成采样点）。 */
  private oddByte: Buffer | null = null;
  /** 输入字节数。 */
  private inputBytes = 0;
  /** 放行字节数。 */
  private emittedBytes = 0;
  /** 首部裁掉字节数。 */
  private leadingTrimmedBytes = 0;
  /** 尾部裁掉字节数。 */
  private trailingTrimmedBytes = 0;
  /** 是否已结算（`finish()` 幂等）。 */
  private finished = false;

  /**
   * @param sampleRate 采样率（Hz，必须为正有限值）
   * @param options 可调参数（缺省用模块常量）
   */
  constructor(sampleRate: number, options: SilenceTrimOptions = {}) {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
      throw new Error(`静音裁剪需要正数采样率（当前 ${String(sampleRate)}）`);
    }
    this.bytesPerSecond = sampleRate * PCM_BYTES_PER_SAMPLE;
    this.frameBytes = Math.max(PCM_BYTES_PER_SAMPLE, alignToSample((TTS_TRIM_FRAME_MS * this.bytesPerSecond) / 1000));
    this.thresholdDbfs = options.thresholdDbfs ?? TTS_TRIM_THRESHOLD_DBFS;
    this.guardBytes = alignToSample(((options.tailGuardMs ?? TTS_TRIM_TAIL_GUARD_MS) * this.bytesPerSecond) / 1000);
    this.tailHoldBytes = alignToSample(((options.tailHoldMaxMs ?? TTS_TRIM_TAIL_HOLD_MAX_MS) * this.bytesPerSecond) / 1000);
    this.leadingHoldBytes = alignToSample(
      ((options.leadingHoldMaxMs ?? TTS_TRIM_LEADING_HOLD_MAX_MS) * this.bytesPerSecond) / 1000,
    );
  }

  /**
   * 喂入一块裸 PCM（s16le 单声道）。
   * @param chunk 到达顺序的一块字节
   * @returns 本次应放行的字节（空 Buffer 表示全部被暂存/裁掉；调用方按序写入播放器）
   */
  push(chunk: Buffer): Buffer {
    if (this.finished || chunk.length === 0) return Buffer.alloc(0);
    this.inputBytes += chunk.length;
    const out: Buffer[] = [];
    let data = chunk;
    if (this.oddByte) {
      data = Buffer.concat([this.oddByte, data]);
      this.oddByte = null;
    }
    let offset = 0;
    // 先补齐上一块留下的不足一帧的数据（帧判定不跨 chunk 抖动）
    if (this.partialFrame.length > 0) {
      const need = this.frameBytes - this.partialFrame.length;
      if (data.length - offset < need) {
        this.partialFrame = copyTail(this.partialFrame, data.subarray(offset));
        return this.collect(out);
      }
      const frame = copyTail(this.partialFrame, data.subarray(offset, offset + need));
      offset += need;
      this.partialFrame = Buffer.alloc(0);
      this.consumeFrame(frame, out);
    }
    while (data.length - offset >= this.frameBytes) {
      this.consumeFrame(data.subarray(offset, offset + this.frameBytes), out);
      offset += this.frameBytes;
    }
    const rest = data.subarray(offset);
    if (rest.length > 0) {
      // 奇数尾字节留到下一块拼采样点（末尾由 finish() 原样放行）
      if (rest.length % PCM_BYTES_PER_SAMPLE === 1) {
        this.oddByte = Buffer.from(rest.subarray(rest.length - 1));
        this.partialFrame = Buffer.from(rest.subarray(0, rest.length - 1));
      } else {
        this.partialFrame = Buffer.from(rest);
      }
    }
    return this.collect(out);
  }

  /**
   * 流结束：结算尾部（保留保护余量）或全静音兜底（原样放行）。
   * 幂等：重复调用只第一次生效（后续返回空 Buffer）。
   * @returns 最后一批应放行的字节（空 Buffer 表示无需再写）
   */
  finish(): Buffer {
    if (this.finished) return Buffer.alloc(0);
    this.finished = true;
    const out: Buffer[] = [];
    if (this.oddByte) {
      // 流尾残余的单个奇数字节不足以构成采样点：丢弃（16bit 对齐优先；正常 provider 不会出现）
      this.oddByte = null;
    }
    if (this.partialFrame.length > 0) {
      const frame = this.partialFrame;
      this.partialFrame = Buffer.alloc(0);
      if (frame.length >= PCM_BYTES_PER_SAMPLE) this.consumeFrame(frame, out);
      else this.propagate(frame, out);
    }
    if (!this.hasVoice) {
      // 全静音（或首部裁剪已放弃）：原始字节全部放行，绝不裁成空
      for (const frame of this.leading) this.propagate(frame, out);
      for (const frame of this.silence) this.propagate(frame, out);
    } else {
      // 首部阶段理论上已清空（检出有声时丢弃）；兜底放行，避免丢数据
      for (const frame of this.leading) this.propagate(frame, out);
      // 尾部只保留保护余量（不足余量则全留）
      let drop = Math.max(0, this.silenceBytes - this.guardBytes);
      while (this.silence.length > 0 && drop > 0) {
        const head = this.silence[0];
        if (head.length <= drop) {
          this.silence.shift();
          drop -= head.length;
          this.trailingTrimmedBytes += head.length;
        } else {
          this.silence[0] = head.subarray(drop);
          this.trailingTrimmedBytes += drop;
          drop = 0;
        }
      }
      for (const frame of this.silence) this.propagate(frame, out);
    }
    this.leading = [];
    this.leadingBytes = 0;
    this.silence = [];
    this.silenceBytes = 0;
    this.phase = "body";
    return this.collect(out);
  }

  /**
   * 取裁剪统计（毫秒）。
   * @returns 输入/放行/首部裁掉/尾部裁掉的时长
   */
  getStats(): SilenceTrimStats {
    return {
      inputMs: this.bytesToMs(this.inputBytes),
      emittedMs: this.bytesToMs(this.emittedBytes),
      leadingTrimmedMs: this.bytesToMs(this.leadingTrimmedBytes),
      trailingTrimmedMs: this.bytesToMs(this.trailingTrimmedBytes),
    };
  }

  /**
   * 判定一帧并累计到输出。
   * @param frame 一帧（≤ frameBytes，尾部残帧可能更短）
   * @param out 输出收集器
   */
  private consumeFrame(frame: Buffer, out: Buffer[]): void {
    const loud = rmsToDbfs(pcmRms(frame)) >= this.thresholdDbfs;
    if (this.phase === "leading") {
      if (!loud) {
        this.leading.push(frame);
        this.leadingBytes += frame.length;
        if (this.leadingBytes > this.leadingHoldBytes) {
          // 首部静音超上限：放弃裁剪，已暂存的原样放行（之后的静音走尾部候选）
          for (const held of this.leading) this.propagate(held, out);
          this.leading = [];
          this.leadingBytes = 0;
          this.phase = "body";
        }
        return;
      }
      // 首个有声帧：丢弃此前暂存的静音（这就是首部裁剪的收益）
      this.leadingTrimmedBytes += this.leadingBytes;
      this.leading = [];
      this.leadingBytes = 0;
      this.phase = "body";
      this.hasVoice = true;
      this.propagate(frame, out);
      return;
    }
    if (loud) {
      this.hasVoice = true;
      // 句内有声：暂存的静音是句内停顿，整体放行（不改语流）
      for (const held of this.silence) this.propagate(held, out);
      this.silence = [];
      this.silenceBytes = 0;
      this.propagate(frame, out);
      return;
    }
    this.silence.push(frame);
    this.silenceBytes += frame.length;
    if (this.silenceBytes > this.tailHoldBytes) {
      // 静音暂存超上限：放行最旧整帧（只保留最近 tailHoldBytes，避免记忆无界）
      const overflow = this.silenceBytes - this.tailHoldBytes;
      let flushed = 0;
      while (this.silence.length > 0 && this.silence[0].length <= overflow - flushed) {
        const head = this.silence.shift() as Buffer;
        flushed += head.length;
        this.propagate(head, out);
      }
      this.silenceBytes -= flushed;
    }
  }

  /**
   * 放行一段字节并计数。
   * @param data 要交给播放器的字节
   * @param out 输出收集器
   */
  private propagate(data: Buffer, out: Buffer[]): void {
    this.emittedBytes += data.length;
    out.push(data);
  }

  /**
   * 合并输出收集器。
   * @param out 收集器
   * @returns 合并后的字节（空则空 Buffer）
   */
  private collect(out: Buffer[]): Buffer {
    if (out.length === 0) return Buffer.alloc(0);
    if (out.length === 1) return out[0];
    return Buffer.concat(out);
  }

  /**
   * 字节数换算为毫秒。
   * @param bytes 字节数
   * @returns 时长（毫秒）
   */
  private bytesToMs(bytes: number): number {
    return (bytes / this.bytesPerSecond) * 1000;
  }
}

/**
 * 把字节长度对齐到采样点边界（向下取整到偶数）。
 * @param bytes 原始字节数
 * @returns 2 的倍数的字节数
 */
function alignToSample(bytes: number): number {
  return Math.floor(bytes / PCM_BYTES_PER_SAMPLE) * PCM_BYTES_PER_SAMPLE;
}

/**
 * 拼接两段缓冲并复制到新 Buffer（暂存数据不引用调用方 chunk 的内存）。
 * @param head 前段
 * @param tail 后段
 * @returns 新 Buffer
 */
function copyTail(head: Buffer, tail: Buffer): Buffer {
  if (tail.length === 0) return Buffer.from(head);
  return Buffer.concat([head, tail]);
}
