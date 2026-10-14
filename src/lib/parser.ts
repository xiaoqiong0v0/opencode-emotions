/**
 * 情绪标注文本工具（纯函数，无外部依赖）。
 *
 * 手动符号解析（`!`/`?`/`...`/`666` → 标注）已**移除**：情绪改由命令（`/angry` 等）
 * 与语音来源（TUI 插件注入）提供，手动符号冗余；规则见 `docs/设计-情绪输入插件.md`。
 * 本模块只保留「标注文本」相关工具——命令模板空参替换后会残留尾部空格，需要清理。
 */

import { EMOJI_TABLE, NEUTRAL_ANNOTATION } from "./emotions.js";

/** 全部情绪 emoji（用于构造标注前缀正则）。 */
const ALL_EMOJIS: string[] = [];
for (const trio of Object.values(EMOJI_TABLE)) {
  ALL_EMOJIS.push(...trio);
}

/**
 * 已带标注的前缀：情绪 `emoji(n/3)`，或独立的中性 😐。
 * 供 `trimAnnotationTail` 判定「文本是否以情绪标注开头」。
 */
const ANNOTATED_PREFIX_RE = new RegExp(
  `^(?:${ALL_EMOJIS.join("|")})\\(\\d/3\\)|^${NEUTRAL_ANNOTATION}(?=\\s|$)`,
);

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
