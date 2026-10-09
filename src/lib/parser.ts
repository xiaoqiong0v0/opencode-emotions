/**
 * 符号解析（纯函数，无外部依赖）。
 *
 * 只识别**首个 token 或末尾 token**的**纯某一种符号**连续串，规则见设计文档第 4 节：
 * - 开头标点类（`!` `?` `...` `。。。`）可直接接正文；数字类 `666` 必须后跟空白或行尾。
 * - 无语族认半角 `.` 与全角 `。`（两者完全等价，按个数分档），不认省略号 `…` / `……`。
 * - 结尾不强制前置空格，但至少 2 个（无语/非常好族本身至少 3 个）。
 * - 首尾同时出现取开头；整条只有符号时正文为空；已带标注的文本跳过（幂等）。
 */

import {
  EMOJI_TABLE,
  NEUTRAL_ANNOTATION,
  renderAnnotation,
  type Emotion,
  type EmotionFamily,
  type EmotionLevel,
} from "./emotions.js";

/** 解析结果：情绪模型 + 去掉符号后的正文。 */
export interface ParseResult {
  /** 解析出的情绪 */
  emotion: Emotion;
  /** 去掉情绪符号后的正文（可能为空字符串） */
  body: string;
}

/** 各情绪族可用的符号字符（怒/疑惑含全角；无语认半角 `.` 与全角 `。`，不认省略号 `…`）。 */
const SYMBOL_CHARS: Readonly<Record<EmotionFamily, string>> = {
  anger: "!！",
  confusion: "?？",
  speechless: ".。",
  great: "6",
};

/** 各情绪族的最少符号个数（等级从 1 起算）。 */
const MIN_COUNT: Readonly<Record<EmotionFamily, number>> = {
  anger: 1,
  confusion: 1,
  speechless: 3,
  great: 3,
};

/** 开头符号匹配：族 + 正则 + 是否数字类。 */
const OPENING_RULES: ReadonlyArray<{ family: EmotionFamily; re: RegExp; digit: boolean }> = [
  { family: "anger", re: /^[!！]+/, digit: false },
  { family: "confusion", re: /^[?？]+/, digit: false },
  { family: "speechless", re: /^[.。]+/, digit: false },
  { family: "great", re: /^6+/, digit: true },
];

/** 结尾符号匹配：族 + 正则 + 是否数字类。 */
const CLOSING_RULES: ReadonlyArray<{ family: EmotionFamily; re: RegExp; digit: boolean }> = [
  { family: "anger", re: /[!！]+$/, digit: false },
  { family: "confusion", re: /[?？]+$/, digit: false },
  { family: "speechless", re: /[.。]+$/, digit: false },
  { family: "great", re: /6+$/, digit: true },
];

/** 全部情绪 emoji（用于构造幂等前缀正则）。 */
const ALL_EMOJIS: string[] = [];
for (const trio of Object.values(EMOJI_TABLE)) {
  ALL_EMOJIS.push(...trio);
}

/**
 * 已带标注的前缀：情绪 `emoji(n/3)`，或独立的中性 😐。
 * 命中则符号解析跳过（保证二次处理不再叠加）；也供钩子判定「是否为标注文本」。
 */
export const ANNOTATED_PREFIX_RE = new RegExp(
  `^(?:${ALL_EMOJIS.join("|")})\\(\\d/3\\)|^${NEUTRAL_ANNOTATION}(?=\\s|$)`,
);

/**
 * 取字符所属的情绪族。
 * @param ch 单个字符（可为 undefined 表示越界）
 * @returns 所属情绪族；不属于任何族时返回 undefined
 */
function familyOfChar(ch: string | undefined): EmotionFamily | undefined {
  if (ch === undefined) return undefined;
  for (const family of Object.keys(SYMBOL_CHARS) as EmotionFamily[]) {
    if (SYMBOL_CHARS[family].includes(ch)) return family;
  }
  return undefined;
}

/**
 * 统计符号串的「个数」：每个符号字符记 1（半角 `.` 与全角 `。` 等价，各按 1 计）。
 * @param run 符号串
 * @returns 符号个数
 */
function countSymbols(run: string): number {
  return run.length;
}

/**
 * 由符号个数换算等级，公式 `min(个数 - (最少个数 - 1), 3)`。
 * @param family 情绪族
 * @param count 符号个数
 * @returns 等级 1..3
 */
function levelOf(family: EmotionFamily, count: number): EmotionLevel {
  const raw = count - (MIN_COUNT[family] - 1);
  return Math.min(Math.max(raw, 1), 3) as EmotionLevel;
}

/**
 * 判断字符是否为空白。
 * @param ch 待判断字符
 * @returns 是空白返回 true
 */
function isWhitespace(ch: string | undefined): boolean {
  return ch !== undefined && /\s/.test(ch);
}

/**
 * 尝试把文本开头解析为情绪符号。
 * @param text 已 trim 的文本
 * @returns 情绪与消耗的字符数；开头无有效符号时返回 null
 */
function parseOpening(text: string): { emotion: Emotion; consumed: number } | null {
  for (const rule of OPENING_RULES) {
    const match = rule.re.exec(text);
    if (!match) continue;
    const run = match[0];
    const next = text[run.length];
    const nextFamily = familyOfChar(next);
    // 纯符号：紧跟字符不能属于另一种情绪族（同族字符已被贪婪匹配吞掉）
    if (nextFamily !== undefined && nextFamily !== rule.family) return null;
    // 数字类必须后跟空白或行尾，防止把 `666元`、`666折` 误判
    if (rule.digit && !(next === undefined || isWhitespace(next))) return null;
    const count = countSymbols(run);
    if (count < MIN_COUNT[rule.family]) return null;
    return { emotion: { family: rule.family, level: levelOf(rule.family, count) }, consumed: run.length };
  }
  return null;
}

/**
 * 尝试把文本结尾解析为情绪符号。
 * @param text 已 trim 的文本
 * @returns 情绪与消耗的字符数；结尾无有效符号时返回 null
 */
function parseClosing(text: string): { emotion: Emotion; consumed: number } | null {
  for (const rule of CLOSING_RULES) {
    const match = rule.re.exec(text);
    if (!match) continue;
    const run = match[0];
    const start = text.length - run.length;
    const prev = start > 0 ? text[start - 1] : undefined;
    const prevFamily = familyOfChar(prev);
    // 纯符号：前置字符不能属于另一种情绪族
    if (prevFamily !== undefined && prevFamily !== rule.family) return null;
    // 数字类：前置字符不能是阿拉伯数字，防止把 `123666` 误判
    if (rule.digit && prev !== undefined && /[0-9]/.test(prev)) return null;
    const count = countSymbols(run);
    // 结尾符号至少 2 个：单个 `！`/`？` 是中文常见句尾标点，不误伤
    if (count < Math.max(2, MIN_COUNT[rule.family])) return null;
    return { emotion: { family: rule.family, level: levelOf(rule.family, count) }, consumed: run.length };
  }
  return null;
}

/**
 * 解析消息文本中的情绪符号。
 * 先尝试开头（标点可直接接正文，数字需边界），无则尝试结尾；已带标注的文本直接跳过。
 * @param text 原始消息文本
 * @returns 解析结果（情绪 + 正文）；无匹配时返回 null
 */
export function parseEmotion(text: string): ParseResult | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  if (ANNOTATED_PREFIX_RE.test(trimmed)) return null;

  const opening = parseOpening(trimmed);
  if (opening) {
    return { emotion: opening.emotion, body: trimmed.slice(opening.consumed).trimStart() };
  }
  const closing = parseClosing(trimmed);
  if (closing) {
    const end = trimmed.length - closing.consumed;
    return { emotion: closing.emotion, body: trimmed.slice(0, end).trimEnd() };
  }
  return null;
}

/**
 * 把消息文本重写为「统一标注 + 正文」；无匹配时返回 null（调用方据此保持原文不变）。
 * @param text 原始消息文本
 * @returns 重写后的文本；无匹配时返回 null
 */
export function rewriteEmotion(text: string): string | null {
  const parsed = parseEmotion(text);
  if (!parsed) return null;
  const annotation = renderAnnotation(parsed.emotion);
  return parsed.body.length > 0 ? `${annotation} ${parsed.body}` : annotation;
}

/**
 * 清理「以情绪标注开头」文本的尾部空白；非标注文本原样返回。
 * 用途：无参数命令（模板 `emoji(2/3) $ARGUMENTS`）空参替换后残留尾部空格。
 * @param text 消息文本
 * @returns 标注文本去掉尾部空白；普通消息不变
 */
export function trimAnnotationTail(text: string): string {
  if (!ANNOTATED_PREFIX_RE.test(text)) return text;
  return text.replace(/\s+$/, "");
}
