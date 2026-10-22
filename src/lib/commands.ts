/**
 * 情绪命令定义（英文命令 → 固定「情绪 + 等级」）。
 * 只注册精准主命令，不设别名（命令面板保持精简）。
 * 命令模板占位符用 `$ARGUMENTS`（实测有效；`{{input}}` 是死文本）。
 */

import { NEUTRAL_ANNOTATION, renderAnnotation, type Emotion } from "./emotions.js";

/** 单条情绪命令。 */
export interface EmotionCommand {
  /** 主命令名（不含前导斜杠） */
  name: string;
  /** 固定情绪；`neutral` 表示中性（只输出 😐，不带等级） */
  emotion: Emotion | "neutral";
}

/** 9 个情绪主命令（见设计文档第 2.2 节）。 */
export const EMOTION_COMMANDS: readonly EmotionCommand[] = [
  { name: "annoyed", emotion: { family: "anger", level: 1 } },
  { name: "angry", emotion: { family: "anger", level: 2 } },
  { name: "furious", emotion: { family: "anger", level: 3 } },
  { name: "confused", emotion: { family: "confusion", level: 2 } },
  { name: "speechless", emotion: { family: "speechless", level: 2 } },
  { name: "neutral", emotion: "neutral" },
  { name: "ok", emotion: { family: "great", level: 1 } },
  { name: "happy", emotion: { family: "great", level: 2 } },
  { name: "great", emotion: { family: "great", level: 3 } },
];

/** 命令参数占位符。 */
export const ARGUMENTS_PLACEHOLDER = "$ARGUMENTS";

/**
 * 生成命令模板：`emoji(等级/3) $ARGUMENTS`（中性命令为 `😐 $ARGUMENTS`）。
 * @param command 情绪命令定义
 * @returns 命令模板字符串
 */
export function commandTemplate(command: EmotionCommand): string {
  const annotation = command.emotion === "neutral" ? NEUTRAL_ANNOTATION : renderAnnotation(command.emotion);
  return `${annotation} ${ARGUMENTS_PLACEHOLDER}`;
}
