/**
 * 情绪 → CosyVoice 风格指令（`instruction`）映射（纯函数，可离线单测）。
 *
 * 口径：`--emotion <name>` 把情绪名映射为**中文风格指令**（CosyVoice `instruction`，≤100 字）；
 * - 取值兼容两套命名：ASR 的 7 类情绪（happy/sad/angry/fearful/disgusted/surprised/neutral）
 *   与项目既有情绪族英文名（anger / confusion / speechless / great）及其它常用英文情绪词（别名表）；
 * - `neutral`、空值或无法识别的取值 → 返回空串（**不加指令**，不报错）；
 * - **sapi 无风格能力**，由 `ignoredTtsParams` 判定为忽略（只记日志）。
 *
 * 指令文本固定中文：CosyVoice v2 为中文模型，中文指令最稳；与 UI 语言（i18n）无关。
 */

/** 规范情绪名 → CosyVoice 风格指令（空串 = 不加指令）。 */
export const EMOTION_INSTRUCTIONS: Readonly<Record<string, string>> = {
  happy: "用开心的语气说",
  sad: "用悲伤的语气说",
  angry: "用愤怒的语气说",
  fearful: "用恐惧的语气说",
  disgusted: "用厌恶的语气说",
  surprised: "用惊讶的语气说",
  confused: "用疑惑的语气说",
  speechless: "用无奈的语气说",
  neutral: "",
};

/** 别名 → 规范情绪名（覆盖项目情绪族名与常用英文词）。 */
export const EMOTION_ALIASES: Readonly<Record<string, string>> = {
  // 怒族（anger/annoyed/mad/furious/rage）→ angry
  anger: "angry",
  annoyed: "angry",
  mad: "angry",
  furious: "angry",
  rage: "angry",
  // 疑惑族（confusion/puzzled）→ confused
  confusion: "confused",
  puzzled: "confused",
  // 无语族（sigh/meh/helpless）→ speechless
  sigh: "speechless",
  meh: "speechless",
  helpless: "speechless",
  // 非常好族（great/excited/good/nice/ok/fine/glad）→ happy
  great: "happy",
  excited: "happy",
  joyful: "happy",
  glad: "happy",
  good: "happy",
  nice: "happy",
  ok: "happy",
  okay: "happy",
  fine: "happy",
  // 其它常用词
  fear: "fearful",
  afraid: "fearful",
  disgust: "disgusted",
  surprise: "surprised",
  astonished: "surprised",
  calm: "neutral",
  plain: "neutral",
};

/**
 * 把原始情绪名归一化为规范情绪名。
 * @param raw 原始值（可空；大小写/空白不敏感）
 * @returns 规范情绪名；空值/未知返回 undefined
 */
export function normalizeEmotion(raw: string | undefined): string | undefined {
  const key = (raw ?? "").trim().toLowerCase();
  if (key.length === 0) return undefined;
  const canonical = Object.prototype.hasOwnProperty.call(EMOTION_INSTRUCTIONS, key)
    ? key
    : EMOTION_ALIASES[key];
  return canonical && Object.prototype.hasOwnProperty.call(EMOTION_INSTRUCTIONS, canonical)
    ? canonical
    : undefined;
}

/**
 * 解析情绪对应的 CosyVoice 风格指令。
 * @param raw 原始情绪名（可空）
 * @returns 风格指令；`neutral`/空值/未知 → 空串（不加指令）
 */
export function resolveEmotionInstruction(raw: string | undefined): string {
  const canonical = normalizeEmotion(raw);
  if (canonical === undefined) return "";
  return EMOTION_INSTRUCTIONS[canonical] ?? "";
}
