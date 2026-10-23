/**
 * **标点断句**（纯函数）：流式 TTS 全程统一的「切句口径」。
 *
 * 规则：
 * - 句末标点：中文 `。！？；…．` 与英文 `! ? ;`；英文 `.` 仅当**后接空白或到结尾**时算句末
 *   （避免把小数 `3.14`、缩写 `e.g.` 误当句末）；换行 `\n`/`\r` 亦为分句点；
 * - 标点**跟在前句末尾**（不丢标点）；**连续句末标点并入同一句**（`真的吗？！`、`Hello!!!`）；
 * - 空段（仅空白/换行）**丢弃**；
 * - 未以标点结尾的**尾巴**由 `tail` 原样返回：调用方据此判断「尚未成句」——
 *   增量场景须等后续增量补齐，只有遇到标点才算一句完成。
 *
 * 仅用于**无流式播放器时的退化分段**：`aliyun.ts` 的 `runSegmented()` 按句边界落段
 * （段边界 = 句边界）。**不再**用于合成分块（`stream.ts` 的纯流式）或 auto_tts 主切分（阈值 + 增量）。
 */

/** 中文句末标点（含省略号与全角句点）。 */
const CJK_TERMINATORS = "。！？；…．";

/**
 * 判断某位置是否落在「句末标点」上（`.` 需后接空白/结尾才成立）。
 * @param text 文本
 * @param index 位置
 * @returns 是则 true
 */
function isTerminatorAt(text: string, index: number): boolean {
  const ch = text[index];
  if (ch === undefined) return false;
  if (ch === "\n" || ch === "\r") return true;
  if (CJK_TERMINATORS.includes(ch)) return true;
  if (ch === "!" || ch === "?" || ch === ";") return true;
  if (ch === ".") {
    const next = text[index + 1];
    return next === undefined || /\s/.test(next);
  }
  return false;
}

/** 切句结果。 */
export interface SentenceSplit {
  /** 完整句（以句末标点结尾，保留标点，已去首尾空白）。 */
  sentences: string[];
  /** 未完结的尾段**原文**（自上一个标点之后、未 trim），供增量拼接与偏移计算。 */
  tail: string;
}

/**
 * 一句在**原文中的可见区间**（trim 后）。
 *
 * 用途：句对齐切分既要「文本单元」也要「原文消费到哪」——预取把下一单元从队列里提前摘走时，
 * 必须按原文偏移精确切分（句子之间有空白，不能用 `text.length` 直接切片）。
 */
export interface SentenceSpan {
  /** 该句 trim 后的文本（含句末标点）。 */
  text: string;
  /** 在原文中的起始下标（含）。 */
  start: number;
  /** 在原文中的结束下标（不含；恰好落在句末标点之后）。 */
  end: number;
}

/** 带原文偏移的切句结果。 */
export interface SentenceSpanSplit {
  /** 完整句（含原文区间）。 */
  spans: SentenceSpan[];
  /** 未完结尾段在原文中的起始下标（`text.slice(tailStart)` 即 `tail` 原文）。 */
  tailStart: number;
}

/**
 * 按句末标点切分文本，并给出每句在原文中的区间（纯函数，无 IO）。
 *
 * 与 {@link splitSentences} 同一口径（连续句末标点并入、空段丢弃），额外返回原文偏移：
 * `spans[i].end` 是「消费到该句为止」的原文下标——调用方据此把已预取的句子从待读队列里摘除。
 * @param text 输入文本
 * @returns 完整句区间数组与未完尾段起点
 */
export function splitSentenceSpans(text: string): SentenceSpanSplit {
  const spans: SentenceSpan[] = [];
  const length = text.length;
  let start = 0;
  let i = 0;
  while (i < length) {
    if (!isTerminatorAt(text, i)) {
      i += 1;
      continue;
    }
    // 连续句末标点并入同一句（不错切成空段）
    let end = i;
    while (end + 1 < length && isTerminatorAt(text, end + 1)) end += 1;
    const raw = text.slice(start, end + 1);
    const sentence = raw.trim();
    if (sentence.length > 0) {
      // trim 只可能去掉首尾空白：用 indexOf 定位可见区间在原文中的起点
      const lead = raw.indexOf(sentence);
      const visibleStart = start + lead;
      spans.push({ text: sentence, start: visibleStart, end: visibleStart + sentence.length });
    }
    start = end + 1;
    i = end + 1;
  }
  return { spans, tailStart: start };
}

/**
 * 按句末标点切分文本（纯函数，无 IO）。
 * @param text 输入文本
 * @returns 完整句数组与未完结尾段（`tail` 为原始后缀）
 */
export function splitSentences(text: string): SentenceSplit {
  const { spans, tailStart } = splitSentenceSpans(text);
  return { sentences: spans.map((span) => span.text), tail: text.slice(tailStart) };
}
