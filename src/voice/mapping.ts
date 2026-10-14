/**
 * 语音情绪（7 类）→ 项目内部情绪模型（族 + 等级）的映射。
 *
 * 语音侧标签来自阿里云 qwen3-asr-flash-realtime（见 aliyun.ts）；映射后统一交给
 * `lib/emotions.ts` 的 `renderAnnotation` 渲染成 `emoji(等级/3)`，不另造标注格式。
 */

import { renderAnnotation, type Emotion } from "../lib/emotions.js";

/** 语音识别可能返回的 7 类情绪标签。 */
export type VoiceEmotion =
  | "happy"
  | "sad"
  | "angry"
  | "fearful"
  | "disgusted"
  | "surprised"
  | "neutral";

/**
 * 语音情绪 → 内部情绪模型；`null` 表示不标注（中性）。
 *
 * 映射口径（等级固定 2，见设计文档）：
 * - happy → great(2)
 * - angry / disgusted → anger(2)
 * - sad → speechless(2)
 * - fearful / surprised → confusion(2)
 * - neutral → 不标注
 */
export const VOICE_EMOTION_MAP: Readonly<Record<VoiceEmotion, Emotion | null>> = {
  happy: { family: "great", level: 2 },
  angry: { family: "anger", level: 2 },
  disgusted: { family: "anger", level: 2 },
  sad: { family: "speechless", level: 2 },
  fearful: { family: "confusion", level: 2 },
  surprised: { family: "confusion", level: 2 },
  neutral: null,
};

/** 合法语音情绪标签集合（用于校验）。 */
const VOICE_EMOTIONS: ReadonlySet<string> = new Set(Object.keys(VOICE_EMOTION_MAP));

/**
 * 判断字符串是否为已知的语音情绪标签。
 * @param raw 原始标签
 * @returns 属于 7 类之一返回 true
 */
export function isVoiceEmotion(raw: string): raw is VoiceEmotion {
  return VOICE_EMOTIONS.has(raw);
}

/**
 * 把语音情绪标签映射为内部情绪模型。
 * @param raw 原始标签（大小写不敏感，自动去空白）
 * @returns 内部情绪模型；中性或未知标签返回 null
 */
export function mapVoiceEmotion(raw: string | undefined): Emotion | null {
  const key = (raw ?? "").trim().toLowerCase();
  if (!isVoiceEmotion(key)) return null;
  return VOICE_EMOTION_MAP[key];
}

/**
 * 把语音情绪标签渲染为统一标注 `emoji(等级/3)`。
 * @param raw 原始标签
 * @returns 标注字符串；中性或未知标签返回 null（调用方据此不标注）
 */
export function annotationForVoiceEmotion(raw: string | undefined): string | null {
  const emotion = mapVoiceEmotion(raw);
  return emotion ? renderAnnotation(emotion) : null;
}
