/**
 * **流式送文分块器**（纯函数/纯状态，无 IO）：TTS「真流式」路径统一的**阈值 + 增量**口径。
 *
 * 设计（取代旧的「按标点断句再聚合」合成分块）：
 * - **不做句切分**：文本按到达顺序增量送入 CosyVoice（多条 `continue-task`），由服务端自动分句；
 * - **最小缓冲阈值**：首次发送前需缓冲到 **≥ {@link DEFAULT_STREAM_MIN_CHARS}** 字（可配置），
 *   避免开头一两个字就建连/送文造成的**开头卡顿**；达标后**随到随发**；
 * - **仅防服务端单条上限**的安全硬切：单条 `continue-task` ≤ {@link MAX_CONTINUE_CHARS}(2 万)，
 *   累计正文 ≤ {@link MAX_TOTAL_CHARS}(20 万)——正常路径不会触发（服务端另约束**相邻两条间隔 ≤23s**，
 *   由调用方按发送节奏保证）。
 *
 * 用在两处，口径一致：① `aliyun.ts` 流式合成的 `continue-task` 分块；② `auto-read.ts` 增量自动朗读
 * 的「何时开始 / 每增量送多少」。**退化分段**（无流式播放器）仍用 `sentences.ts` 的 `splitSentences()`
 * 按句切段，与本模块无关。
 */

/** 默认最小缓冲阈值（首次发送前需缓冲的字符数）。 */
export const DEFAULT_STREAM_MIN_CHARS = 5;
/** 单条 `continue-task` 的字符上限（服务端约束 ≤2 万）。 */
export const MAX_CONTINUE_CHARS = 20000;
/** 累计正文的字符上限（服务端约束 ≤20 万）。 */
export const MAX_TOTAL_CHARS = 200000;

/**
 * 把任意值归一为「非负整数阈值」；非法（NaN/非有限/负）回退默认并为 0 兜底。
 * @param value 原始阈值
 * @returns 非负整数
 */
export function normalizeStreamMinChars(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_STREAM_MIN_CHARS;
  return Math.max(0, Math.trunc(value));
}

/** `createStreamChunker` 选项。 */
export interface StreamChunkerOptions {
  /** 首次发送前需缓冲的最小字符数（默认 {@link DEFAULT_STREAM_MIN_CHARS}）。 */
  minChars?: number;
  /** 单块字符上限（默认 {@link MAX_CONTINUE_CHARS}，仅防服务端单条上限）。 */
  maxChars?: number;
}

/** 流式送文分块器。 */
export interface StreamChunker {
  /** 是否已开始发送（首次达标后为 true）。 */
  readonly started: boolean;
  /**
   * 送入一段增量文本。
   * @param delta 增量
   * @returns 本次应发送的块（按到达顺序）；未达阈值或空输入时返回空数组
   */
  push(delta: string): string[];
  /**
   * 结束送文：把缓冲中的**剩余文本**（含未达阈值的短文本）全部吐出（按上限硬切）。
   * @returns 剩余块；无剩余时返回空数组
   */
  flush(): string[];
}

/**
 * 创建流式送文分块器。
 * @param options 选项（最小缓冲阈值 / 单块上限）
 * @returns 分块器
 */
export function createStreamChunker(options: StreamChunkerOptions = {}): StreamChunker {
  const minChars = normalizeStreamMinChars(options.minChars);
  const maxChars = Math.max(1, Math.trunc(options.maxChars ?? MAX_CONTINUE_CHARS));
  let buffer = "";
  let started = false;

  /** 把缓冲按单块上限硬切后全部吐出（清空缓冲）。 */
  const drain = (): string[] => {
    const out: string[] = [];
    while (buffer.length > maxChars) {
      out.push(buffer.slice(0, maxChars));
      buffer = buffer.slice(maxChars);
    }
    if (buffer.length > 0) {
      out.push(buffer);
      buffer = "";
    }
    return out;
  };

  return {
    get started(): boolean {
      return started;
    },
    push(delta: string): string[] {
      if (delta.length === 0) return [];
      buffer += delta;
      if (!started) {
        if (buffer.length < minChars) return [];
        started = true;
      }
      return drain();
    },
    flush(): string[] {
      if (buffer.length === 0) return [];
      started = true;
      return drain();
    },
  };
}
