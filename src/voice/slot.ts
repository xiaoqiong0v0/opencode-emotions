/**
 * TUI 槽位**单个**状态指示的格式化（纯函数，可离线单测）。
 *
 * 形态：`[🎙 状态][注入|输入][F8/F9]`，例如 `🎙 ●  注入 F8/F9` / `🎙 ⏳ 注入 F8/F9`，一眼可读。
 * **总宽恒定**（任意 mic 状态 × 模式 × 语言）：
 * - 🎙 图标固定，**其后必跟一个空格**（emoji 为宽字符，紧贴后续字形会在 TUI 渲染重叠）；
 * - **状态字形段**（`●`=开 / `○`=关 / `⏳`=启动中，含尾随空格）右侧补空格到固定宽度 `GLYPH_SEGMENT_WIDTH`；
 * - **模式描述段**（i18n 词表 `注入` / `Input` …，含尾随空格）右侧补空格到**该语言**的 `modeSegmentWidth(phrases)`；
 * - 第三段恒为 `F8/F9`（两个热键都显示，作「可按 F8/F9 切换」提示），与 keymap 绑定同源、不随模式变。
 *
 * **为何定宽**：`●`/`○` 在该渲染口径下为 1 列、`⏳` 为 2 列，直接拼接时开/关态比启动态窄 1 列；
 * 切换 `F8`/`F9`（`注入`/`输入`、`Inject`/`Input` 长度不同）整条宽度也会抖动。故「按当前语言预计算
 * 可变段的最大显示宽度 + 定宽填充」，使拼接后总宽恒定。宽度口径 = TUI 渲染库 `@opentui/core` 内联的
 * `string-width@7`（Bun 宿主下为 `Bun.stringWidth`，`ambiguousIsNarrow:true`）：歧义宽度字符按窄计、
 * emoji 与 CJK 计 2、ASCII 计 1。
 *
 * **渲染与文本分离**：本模块只产出**文本 + 配色角色**（`formatSlotSegments`），**不含任何颜色值**；
 * 具体颜色由渲染层（`src/tui.tsx`）按角色映射 `api.theme` 的颜色键。
 * `formatSlotIndicator` 保留为「拼接后的纯文本」便捷入口（旧调用/单测用）。
 */

import type { Phrases } from "../lib/i18n.js";

/** 麦克风状态：开 / 启动中 / 关。 */
export type MicState = "on" | "starting" | "off";

/** 语音模式：注入（新消息）/ 输入（追加输入框）。 */
export type SlotMode = "inject" | "input";

/** 槽位指示渲染入参。 */
export interface SlotState {
  /** 麦克风状态。 */
  mic: MicState;
  /** 当前展示的模式。 */
  mode: SlotMode;
}

/** 分段渲染入参 = 文本状态 + 两个开关的激活态（决定对应热键是否高亮）。 */
export interface SlotRenderState extends SlotState {
  /** 注入模式是否开启（开启则 `F8` 用注入色）。 */
  injectOn: boolean;
  /** 输入模式是否开启（开启则 `F9` 用输入色）。 */
  inputOn: boolean;
}

/**
 * 槽位分段的**配色角色**（渲染层据此选 theme 颜色键；本模块不涉及具体颜色）。
 * - `icon`：🎙 图标；
 * - `glyph`：状态字形 `●` / `○` / `⏳`（与图标同色，保留独立角色以备日后微调）；
 * - `mode`：模式描述 `注入` / `输入`；
 * - `keyActive`：当前激活模式的热键（注入激活→`F8`、输入激活→`F9`）；
 * - `keyInactive`：未激活的热键（暗色）；
 * - `separator`：两键之间的 `/`（暗色）。
 */
export type SlotColorRole = "icon" | "glyph" | "mode" | "keyActive" | "keyInactive" | "separator";

/** 一个槽位分段：文本 + 配色角色。 */
export interface SlotSegment {
  /** 分段文本。 */
  text: string;
  /** 配色角色。 */
  role: SlotColorRole;
}

/** 麦克风图标。 */
export const MIC_ICON = "🎙";
/** 状态字形。 */
export const MIC_ON_GLYPH = "●";
export const MIC_OFF_GLYPH = "○";
export const MIC_STARTING_GLYPH = "⏳";
/** 注入模式热键（小写，供 keymap 绑定）。 */
export const INJECT_KEY = "f8";
/** 输入模式热键（小写，供 keymap 绑定）。 */
export const INPUT_KEY = "f9";
/** 注入模式热键显示名。 */
export const INJECT_KEY_LABEL = "F8";
/** 输入模式热键显示名。 */
export const INPUT_KEY_LABEL = "F9";
/** 两热键之间的分隔符。 */
export const SLOT_KEY_SEPARATOR = "/";
/** 槽位第三段：两键都显示（「可按 F8/F9 切换」提示），由上面两个热键显示名组合，不随模式变。 */
export const SLOT_KEYS_LABEL = `${INJECT_KEY_LABEL}${SLOT_KEY_SEPARATOR}${INPUT_KEY_LABEL}`;
/** 分段之间的空格（emoji 宽字符后必须留，防渲染重叠）。 */
const SLOT_SPACE = " ";

/** 全部状态字形（与 `micGlyph` 返回值一致），供预计算最大宽度用。 */
const MIC_GLYPHS: readonly string[] = [MIC_ON_GLYPH, MIC_OFF_GLYPH, MIC_STARTING_GLYPH];

/** 零宽（计 0 列）码点闭区间：控制符 / 组合记号 / 零宽连接符 等（与渲染口径一致）。 */
const ZERO_WIDTH_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x0300, 0x036f],
  [0x1ab0, 0x1aff],
  [0x1dc0, 0x1dff],
  [0x200b, 0x200f],
  [0x20d0, 0x20ff],
  [0xfe00, 0xfe0f],
  [0xfe20, 0xfe2f],
  [0xfeff, 0xfeff],
];

/** 双列（计 2 列）码点闭区间：emoji 与 East Asian Wide/Fullwidth（与渲染口径一致的近似）。 */
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x231a, 0x23fa],
  [0x2600, 0x27bf],
  [0x2b00, 0x2bff],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f000, 0x1faff],
  [0x20000, 0x3fffd],
];

/** 码点是否落在给定闭区间表内。 */
function inRanges(codePoint: number, ranges: readonly (readonly [number, number])[]): boolean {
  return ranges.some(([start, end]) => codePoint >= start && codePoint <= end);
}

/**
 * 终端显示宽度（列数），口径与 TUI 渲染库一致：
 * 组合/控制/零宽字符计 0；emoji 与 East Asian Wide/Fullwidth 计 2；其余（含歧义宽度）计 1。
 * `@opentui/core` 内联 `string-width@7`（Bun 宿主下为 `Bun.stringWidth`，`ambiguousIsNarrow:true`），
 * 故 `●`/`○` 等歧义宽度字符计 1、`⏳`/`🎙` 计 2、CJK 计 2、ASCII 计 1。
 * @param text 待测文本
 * @returns 显示列宽
 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const codePoint = ch.codePointAt(0) ?? 0;
    if (inRanges(codePoint, ZERO_WIDTH_RANGES)) continue;
    width += inRanges(codePoint, WIDE_RANGES) ? 2 : 1;
  }
  return width;
}

/** 状态字形段的固定显示宽度 Wg = 全部状态字形（含其后必留空格）的最大宽度。 */
export const GLYPH_SEGMENT_WIDTH: number = Math.max(
  ...MIC_GLYPHS.map((glyph) => displayWidth(`${glyph}${SLOT_SPACE}`)),
);

/** 每种语言词表 → 模式描述段最大显示宽度 Wl（按 `Phrases` 缓存，避免每次渲染重算）。 */
const MODE_SEGMENT_WIDTH_CACHE = new WeakMap<Phrases, number>();

/**
 * 该语言下所有模式描述（含其后必留空格）的最大显示宽度 Wl。
 * 「按语言预计算」：同一语言只算一次，供定宽填充保证任意模式切换时总宽恒定。
 * @param phrases 当前语言文案表
 * @returns Wl（显示列宽）
 */
export function modeSegmentWidth(phrases: Phrases): number {
  const cached = MODE_SEGMENT_WIDTH_CACHE.get(phrases);
  if (cached !== undefined) return cached;
  const width = Math.max(
    displayWidth(`${phrases.slot.modeInject}${SLOT_SPACE}`),
    displayWidth(`${phrases.slot.modeInput}${SLOT_SPACE}`),
  );
  MODE_SEGMENT_WIDTH_CACHE.set(phrases, width);
  return width;
}

/**
 * 右侧补空格到固定显示宽度（已足宽则原样返回；不截断）。
 * @param text 原文
 * @param target 目标显示宽度
 * @returns 定宽文本
 */
function padToWidth(text: string, target: number): string {
  const pad = target - displayWidth(text);
  return pad > 0 ? text + SLOT_SPACE.repeat(pad) : text;
}

/**
 * 取状态字形。
 * @param mic 麦克风状态
 * @returns `●` / `○` / `⏳`
 */
export function micGlyph(mic: MicState): string {
  switch (mic) {
    case "on":
      return MIC_ON_GLYPH;
    case "starting":
      return MIC_STARTING_GLYPH;
    default:
      return MIC_OFF_GLYPH;
  }
}

/**
 * 把状态拆成**分段**（文本 + 配色角色），供渲染层逐段上色。
 * 分段顺序：图标 → 状态字形 → 模式描述 → `F8` → `/` → `F9`；各段文本首尾自带空格，
 * 且**状态字形段与模式描述段按各自最大宽度右侧补空格定宽**（见 `GLYPH_SEGMENT_WIDTH` /
 * `modeSegmentWidth`），故拼接结果的总显示宽度在任意 mic 状态 × 模式 × 语言下恒定。
 * @param phrases 当前语言文案表
 * @param state 状态 + 两开关激活态
 * @returns 分段数组
 */
export function formatSlotSegments(phrases: Phrases, state: SlotRenderState): SlotSegment[] {
  const label = state.mode === "inject" ? phrases.slot.modeInject : phrases.slot.modeInput;
  return [
    { text: `${MIC_ICON}${SLOT_SPACE}`, role: "icon" },
    { text: padToWidth(`${micGlyph(state.mic)}${SLOT_SPACE}`, GLYPH_SEGMENT_WIDTH), role: "glyph" },
    { text: padToWidth(`${label}${SLOT_SPACE}`, modeSegmentWidth(phrases)), role: "mode" },
    { text: INJECT_KEY_LABEL, role: state.injectOn ? "keyActive" : "keyInactive" },
    { text: SLOT_KEY_SEPARATOR, role: "separator" },
    { text: INPUT_KEY_LABEL, role: state.inputOn ? "keyActive" : "keyInactive" },
  ];
}

/**
 * 把状态渲染为槽位指示文本（单个元素）。
 * 图标与状态字形之间留一个空格；状态字形段与模式描述段按最大宽度**定宽填充**，
 * 故任意状态拼接总宽恒定（见 `formatSlotSegments`）。
 * 第三段恒为 `F8/F9`（两键都显示，作切换提示），不随当前模式变。
 * @param phrases 当前语言文案表
 * @param state 状态
 * @returns 形如 `🎙 ●  注入 F8/F9`
 */
export function formatSlotIndicator(phrases: Phrases, state: SlotState): string {
  const segments = formatSlotSegments(phrases, { ...state, injectOn: false, inputOn: false });
  return segments.map((segment) => segment.text).join("");
}
