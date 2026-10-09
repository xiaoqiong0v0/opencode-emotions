/**
 * 情绪模型与统一标注生成（纯函数，无外部依赖）。
 *
 * 分层：任何情绪来源（符号解析、命令、后续的语音/ASR）都先归一为内部模型 `Emotion`，
 * 再由本模块统一渲染成 `emoji(等级/3)`，新增来源不改标注格式（见设计文档第 9 节）。
 */

/** 可由符号表达的情绪族。 */
export type EmotionFamily = "anger" | "confusion" | "speechless" | "great";

/** 情绪等级：1 最轻，3 最强。 */
export type EmotionLevel = 1 | 2 | 3;

/** 内部情绪模型：情绪族 + 等级。 */
export interface Emotion {
  family: EmotionFamily;
  level: EmotionLevel;
}

/** 每个情绪族的三档 emoji（下标 0 对应等级 1）。 */
export const EMOJI_TABLE: Readonly<Record<EmotionFamily, readonly [string, string, string]>> = {
  anger: ["😠", "😡", "🤬"],
  confusion: ["😕", "🤔", "😵"],
  speechless: ["😐", "😑", "😮💨"],
  great: ["🙂", "😊", "🤩"],
};

/** 中性命令的标注：仅一个 😐，不带等级。 */
export const NEUTRAL_ANNOTATION = "😐";

/**
 * 取指定情绪族、指定等级的 emoji。
 * @param family 情绪族
 * @param level 等级 1..3
 * @returns 对应 emoji 字符
 */
export function emojiOf(family: EmotionFamily, level: EmotionLevel): string {
  return EMOJI_TABLE[family][level - 1];
}

/**
 * 把内部情绪模型渲染为统一标注 `emoji(等级/3)`。
 * @param emotion 内部情绪模型
 * @returns 形如 `😡(2/3)` 的标注字符串
 */
export function renderAnnotation(emotion: Emotion): string {
  return `${emojiOf(emotion.family, emotion.level)}(${emotion.level}/3)`;
}
