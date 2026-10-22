/**
 * TUI 槽位**单个**状态指示的格式化（纯函数，可离线单测）。
 *
 * 形态：`[🎙 恒静态][meter 1 列盲文音量][↧F8][/][⤉F9][🔊 F10]`，例如
 * `🎙  ↧F8/⤉F9 🔊 F10`（关，meter 列空白）/ `🎙 ⠹↧F8/⤉F9 🔊 F10`（连接中，spinner）/
 * `🎙 ⠿↧F8/⤉F9 🔊 F10`（在听，电平拉满）。
 * **2026-10-21 用户指令（第十批）**：删除 `●`/`○`/`⏳` 状态圆圈段，改为
 * **两个模式图标紧贴各自键位成组**（输入/F8、注入/F9，图标与键名**无空格**、组间 `/` 分隔）。模式**没有文字段**
 * （第九批已删 `注入`/`输入`）——当前模式 = **哪一组「图标+键位」整组亮**。
 * **2026-10-21 用户指令（第十一批）**：① 恢复 `🎙` 麦克风图标段常驻最前；② 输入组图标 `⇥`（U+21E5）与 `F8`
 * **渲染重叠** ⇒ 换为 `↧`（U+21A7，向下箭头到横线，同样表「写进输入框」，宽度口径仍计 1）；注组图标 `⤉`（U+21C9）**不变**。
 * **历史（第十二批 / 2026-10-22 缺陷一+二）**：最前一格曾做「`⏳ `（连接中）↔ `🎙 `/`🎤 `（在听，帧轮播）」的 mic 三态；
 * **2026-10-22 用户指令（第十三批）已推翻并全部删除**：emoji 帧轮播**视觉重心不齐、丑**，根因是 **emoji 字形与进格宽度由终端/字体决定**
 * （轮播会跳位、不居中，且不吃终端前景色 ⇒ 变色动画同样无效）。
 * **现状（第十三批）**：
 * ① `🎙 ` **永远静态**——不换字形、不变色、无任何动画；
 * ② 其后新增**恒定 1 列的盲文音量列**（`meter` 段，U+2800–U+28FF），由 runtime 上行的**真实麦克风电平**
 *   （NDJSON `level` 事件，10Hz 节流；归一见 `src/voice/meter.ts` 的 `rmsToLevel`）驱动 ⇒ **有音频输入才有动画**；
 * ③ 三态由 `meter.phase` 表达：`idle`→空白占位、`connecting`→盲文 spinner（帧索引轮播）、`listening`→盲文纵向电平条（6 档）。
 * **为何用盲文**：盲文块 East Asian Width = **Neutral** ⇒ 各终端**恒 1 列**、单色可着色、**无字形差异**（不像 emoji 由字体决定外观）；
 * **连接中**的提示也因此从 emoji `⏳` 改为盲文 spinner。
 * **总宽恒定**（任意 meter 三态 × 电平 × 帧索引 × 模式 × 语言 × 自动朗读开关）：
 * - **mic 段恒为 `🎙 `**（emoji 2 列 + 尾随空格 1 列 = 3 列；宽字符紧贴后续字形会重叠 ⇒ 空格必留）；
 * - **meter 段恒为 1 列**（空白 / spinner / 电平条字形都是盲文块或空格，`displayWidth` 恒 1）；
 * - 键位段恒为 `↧F8` `/` `⤉F9`（两组都显示，作「可按 F8=输入 / F9=注入 切换」提示），与 keymap 绑定同源、不随模式变；
 *   **显示按物理键序恒定**（`F8` 在前、`F9` 在后），语义为 `F8`=输入、`F9`=注入（2026-10-21 对调，键值单源为本模块常量）；
 * - 末端追加段恒为 ` 🔊 F10`（前置一个空格分隔；自动朗读**状态指示**，图标与键名都是固定串、
 *   文本不随开关变，开关只经配色角色 `autoReadActive`/`autoReadInactive` 表达亮/灰），**不是模式**、不进模式语义。
 *
 * **为何定宽**：mic 段与 meter 段的文本都**不随状态变化**（mic 恒 `🎙 `、meter 恒取 1 列字形），
 * 其余分段全是常量 ⇒ 整条总宽与任何状态无关，无需补空格占位（旧 `MIC_BUSY_SEGMENT_WIDTH` / `padToWidth` 早批已删）。
 * 宽度口径 = TUI 渲染库 `@opentui/core` 内联的 `string-width@7`（Bun 宿主下为 `Bun.stringWidth`，`ambiguousIsNarrow:true`）：
 * 歧义宽度字符按窄计、emoji 与 CJK 计 2、ASCII 计 1（`↧` U+21A7 / `⤉` U+21C9 均为歧义宽度箭头，计 1；`🔊`/`🎙` 计 2；
 * **盲文 `⠁`–`⠿`（U+2800–U+28FF）EA=Neutral 计 1**）。
 * 各段文本均与语言无关 ⇒ **中/英总宽相同**（现 **18** = 3 `🎙 ` + 1 meter + 3 `↧F8` + 1 `/` + 3 `⤉F9` + 7 ` 🔊 F10`，见单测；上批 17）。
 *
 * **渲染与文本分离**：本模块只产出**文本 + 配色角色**（`formatSlotSegments`），**不含任何颜色值**；
 * 具体颜色由渲染层（`src/tui.tsx`）按角色映射 `api.theme` 的颜色键。
 * `formatSlotIndicator` 保留为「拼接后的纯文本」便捷入口（旧调用/单测用）。
 * **`phrases` 形参与 `SlotState.mode` 字段当前不被消费**（模式段已删、余下分段全是常量文本）：保留是为了旧调用签名不变，
 * 以及「meter 三态 × 电平 × 帧索引 × 模式 × 语言 × 自动朗读开关」**全组合等宽契约**仍能逐维枚举验证。
 */

import type { Phrases } from "../lib/i18n.js";

/** 语音模式：注入（新消息）/ 输入（追加输入框）。 */
export type SlotMode = "inject" | "input";

/** 盲文音量列（meter 段）所处阶段：关（不采）/ 连接中（还没开麦）/ 在听（电平驱动）。 */
export type MeterPhase = "idle" | "connecting" | "listening";

/** 盲文音量列（meter 段）渲染入参。 */
export interface SlotMeterState {
  /** 三态：`idle`→空白占位、`connecting`→spinner 轮播、`listening`→电平条分档。 */
  phase: MeterPhase;
  /**
   * 归一化电平 ∈ [0,1]（**仅 `listening` 消费**）：来自 runtime NDJSON `level` 事件
   * （由 `src/voice/meter.ts` 的 `rmsToLevel` 按真实麦克风电平算出）。越界 / NaN / 非有限由 `meterGlyph` 归最低档。
   */
  level: number;
  /**
   * spinner **帧索引**（**仅 `connecting` 消费**）：由 TUI 侧定时器递增，`meterGlyph` 取模归一到 `[0, n)`；
   * 任意整数（含负 / 超界 / 非有限）都不会抛错、也不会改变宽度。
   */
  frame: number;
}

/** 槽位指示渲染入参。 */
export interface SlotState {
  /**
   * 当前模式。**2026-10-21 删除模式描述段后不再渲染为文字**（模式仅由 `↧F8` / `⤉F9` 哪一组高亮表达）；
   * 字段保留以免改动旧调用签名，并供「模式 × …」全组合等宽契约继续枚举。
   */
  mode: SlotMode;
  /**
   * 盲文音量列描述（2026-10-22 第十三批：取代原「mic 三态 + `micFrame` emoji 帧轮播」）。
   * 阶段 / 电平 / 帧索引均由渲染层（`src/tui.tsx`）算好后传入，本模块只做**纯字形选择**（不读时钟、不接事件）。
   */
  meter: SlotMeterState;
}

/** 分段渲染入参 = 文本状态 + 各开关的激活态（决定对应「图标+键位」组/喇叭段是否高亮）。 */
export interface SlotRenderState extends SlotState {
  /** 注入模式是否开启（开启则 `⤉F9` 整组用注入色）。 */
  injectOn: boolean;
  /** 输入模式是否开启（开启则 `↧F8` 整组用输入色）。 */
  inputOn: boolean;
  /** 自动朗读是否开启（开启则末端 `🔊 F10` 段用激活色，关闭仅转暗、文本不变）。 */
  autoReadOn: boolean;
}

/**
 * 槽位分段的**配色角色**（渲染层据此选 theme 颜色键；本模块不涉及具体颜色）。
 * - `mic`：最前 `🎙 ` 段（2026-10-21 第十一批恢复常驻；2026-10-22 第十三批起**永远静态**——
 *   不换字形、不变色，任何状态都是同一个中性色），静态标记「本槽位属于语音功能」（`icon` 角色的等价位）；
 * - `meter`：`🎙 ` 之后的**盲文音量列**（第十三批新增；恒 1 列）——三态**静态取色**：
 *   `listening` 用 `accent`（有电平、真在听）、`connecting`/`idle` 用 `textMuted`（暗色，不做变色动画）；
 *   动画只体现在**字形本身**（spinner 换帧 / 电平条换档），不靠颜色；
 * - `keyActive`：当前激活模式的**整组「图标+键位」**（注入激活→`⤉F9`、输入激活→`↧F8`）
 *   ——**模式状态唯一的视觉表达**（文字段已删；图标与键位同段同色，2026-10-21 用户指令成组）；
 * - `keyInactive`：未激活的整组（暗色）；
 * - `separator`：两组之间的 `/`（暗色）；
 * - `autoReadActive`：末端 `🔊 F10` 段（自动朗读开启 → 激活色）；
 * - `autoReadInactive`：末端 `🔊 F10` 段（自动朗读关闭 → 暗色；文本与开启态完全相同）。
 * （旧 `glyph` 角色随 `●`/`○` 圆圈段删除，2026-10-21 用户指令；旧 `icon` 角色以 `mic` 之名恢复；
 * 旧 `busy` 角色随连接中 `⏳ ` 字形删除 ⇒ 改由 `meter` 的 spinner 表达「还在连」，2026-10-22 第十三批。）
 */
export type SlotColorRole =
  | "mic"
  | "meter"
  | "keyActive"
  | "keyInactive"
  | "separator"
  | "autoReadActive"
  | "autoReadInactive";

/** 一个槽位分段：文本 + 配色角色。 */
export interface SlotSegment {
  /** 分段文本。 */
  text: string;
  /** 配色角色。 */
  role: SlotColorRole;
}

/** 麦克风图标（🎙；emoji 宽字符，其后必留一个空格防渲染重叠。2026-10-21 用户指令**恢复为常驻最前段**，样式仿末端 `🔊 F10`；2026-10-22 第十三批起**永远静态**——不做任何帧轮播 / 换字形 / 变色动画）。 */
export const MIC_ICON = "🎙";
/**
 * meter 列（盲文音量列）的**关态**字形：空白。
 * 宽度依据：ASCII 空格 = **1 列**（`displayWidth` 口径）。关态没有任何动画，但仍占 1 列——
 * **占位是为了保持槽位总宽恒定**（不随状态抖动）。
 */
export const METER_IDLE_GLYPH = " ";
/**
 * meter 列**连接中**（`phase === "connecting"`）的 spinner 帧序列，按 `meter.frame` 取模轮播。
 * 宽度依据：全部为 U+2800–U+28FF 盲文点字，East Asian Width = **Neutral** ⇒ 每个字形 `displayWidth` **恒 = 1**
 * （由单测锁定）；不像 emoji 那样由终端/字体决定字形与进格数 ⇒ 轮播不跳位、天然居中（第十三批选型理由）。
 */
export const METER_SPINNER_FRAMES: readonly string[] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/**
 * meter 列**在听**（`phase === "listening"`）的电平条帧序列（低 → 高 6 档，盲文点按纵向自下而上填满），
 * 按 `meter.level` 分档取用。宽度依据同 spinner：U+2800–U+28FF 全为 EA=Neutral ⇒ `displayWidth` **恒 = 1**。
 */
export const METER_LEVEL_FRAMES: readonly string[] = ["⠁", "⠃", "⠇", "⠏", "⠟", "⠿"];
/** 输入模式图标（↧ U+21A7，向下箭头到横线，表「写进输入框」；歧义宽度、本口径计 1 列，紧贴键名成组。2026-10-21 用户指令：原 `⇥` U+21E5 与 `F8` 字形重叠，换为本字形、宽度不变）。 */
export const INPUT_KEY_ICON = "↧";
/** 注入模式图标（⤉ U+21C9，向右双箭头，表「发成新消息」；歧义宽度、本口径计 1 列，紧贴键名成组）。 */
export const INJECT_KEY_ICON = "⤉";
/** 注入模式热键（小写，供 keymap 绑定；2026-10-21 语义对调：注入绑 **F9**）。 */
export const INJECT_KEY = "f9";
/** 输入模式热键（小写，供 keymap 绑定；2026-10-21 语义对调：输入绑 **F8**）。 */
export const INPUT_KEY = "f8";
/** 注入模式热键显示名。 */
export const INJECT_KEY_LABEL = "F9";
/** 输入模式热键显示名。 */
export const INPUT_KEY_LABEL = "F8";
/** 自动朗读热键（小写，供 keymap 绑定；显示只进槽位末端状态段，不进模式语义）。 */
export const AUTO_READ_KEY = "f10";
/** 自动朗读热键显示名。 */
export const AUTO_READ_KEY_LABEL = "F10";
/** 自动朗读喇叭图标（🔊；emoji 宽字符，前后各留一个空格防渲染重叠）。 */
export const AUTO_READ_ICON = "🔊";
/** 两模式组之间的分隔符。 */
export const SLOT_KEY_SEPARATOR = "/";
/** 分段之间的空格（emoji 宽字符后必须留，防渲染重叠）。 */
const SLOT_SPACE = " ";

/** 末端「自动朗读状态」段文本：前置空格 + 🔊 + 空格 + F10；**恒为固定串**，开关只影响配色角色不影响宽度。 */
const AUTO_READ_SEGMENT_TEXT = `${SLOT_SPACE}${AUTO_READ_ICON}${SLOT_SPACE}${AUTO_READ_KEY_LABEL}`;
/** mic 段文本：`🎙 `（emoji + 尾随空格，宽字符紧贴后续字形会重叠 ⇒ 空格必留）；**恒为固定串**，任何状态都不换字形也不换色（第十三批）。 */
const MIC_SEGMENT_TEXT = `${MIC_ICON}${SLOT_SPACE}`;
/** 输入组段文本：`↧F8`（图标与键位**紧贴无空格**，整组同色；2026-10-21 用户指令成组、同日把 `⇥` 换成 `↧`）。 */
const INPUT_SEGMENT_TEXT = `${INPUT_KEY_ICON}${INPUT_KEY_LABEL}`;
/** 注入组段文本：`⤉F9`（同上）。 */
const INJECT_SEGMENT_TEXT = `${INJECT_KEY_ICON}${INJECT_KEY_LABEL}`;

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
 * 故 `↧`/`⤉` 等歧义宽度箭头计 1、`⏳`/`🔊`/`🎙` 计 2、CJK 计 2、ASCII 计 1。
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

/**
 * 取 meter 列（盲文音量列）当前字形（纯函数，按三态选字；不读时钟、不做动画计时——帧索引由调用方推进）。
 * - `idle` → `METER_IDLE_GLYPH`（空白，仍占 1 列，保证总宽恒定）；
 * - `connecting` → `METER_SPINNER_FRAMES[frame 取模]`：`frame` 可为**任意整数**（含负 / 超界 / 非有限），
 *   此处归一到 `[0, n)`，不抛错；
 * - `listening` → `METER_LEVEL_FRAMES[档位]`，档位 = `min(n-1, floor(level × n))`：
 *   `level > 1` 取最高档，`level` 为负 / NaN / 非有限归最低档（第 0 档），都不抛错。
 * **宽度契约**：返回值的 `displayWidth` **恒为 1**（盲文块 U+2800–U+28FF 全为 EA=Neutral、空白为 ASCII）——由单测锁定。
 * @param meter 三态 + 电平 + 帧索引（来自 `SlotState.meter`）
 * @returns 单个 1 列字形
 */
export function meterGlyph(meter: SlotMeterState): string {
  if (meter.phase === "connecting") {
    const count = METER_SPINNER_FRAMES.length;
    const normalized = Number.isFinite(meter.frame) ? Math.trunc(meter.frame) : 0;
    return METER_SPINNER_FRAMES[((normalized % count) + count) % count];
  }
  if (meter.phase === "listening") {
    const count = METER_LEVEL_FRAMES.length;
    const scaled = Number.isFinite(meter.level) ? Math.floor(meter.level * count) : 0;
    return METER_LEVEL_FRAMES[Math.min(count - 1, Math.max(0, scaled))];
  }
  return METER_IDLE_GLYPH;
}

/**
 * 把状态拆成**分段**（文本 + 配色角色），供渲染层逐段上色。
 * 分段顺序：`🎙 `(mic，恒静态) → meter(1 列盲文音量列) → `↧F8`(输入组) → `/` → `⤉F9`(注入组) → ` 🔊 F10`
 * （**两组按物理键序排列**，显示恒为 `↧F8/⤉F9`；**图标与键位同段同色**，整组高亮跟随各自的开关状态
 * ——**这就是模式状态的全部视觉表达**：原「模式描述段」（`注入`/`输入`）与原「`●`/`○` 圆圈段」
 * 均已按 2026-10-21 用户指令删除）；
 * **前两段的职责划分**（2026-10-22 第十三批：删 emoji 帧轮播，改盲文音量列承载全部语音状态动画）：
 *  - mic 段恒为 `🎙 `（角色 `mic`，静态中性色，**任何状态下文本与角色都不变**）；
 *  - meter 段按 `state.meter.phase` 取字形（角色 `meter`，恒 1 列）：
 *    `idle`（关模式）→ 空白；`connecting`（开模式但未连上 ASR）→ spinner 帧（告诉用户「还在连、别急着说」）；
 *    `listening`（开模式且已就绪）→ 电平条档（由真实麦克风电平驱动，**有音频输入才动**）。
 * 末端喇叭段是固定串（自动朗读开关只切换配色角色 `autoReadActive`/`autoReadInactive`、不改文本），故拼接结果的总显示宽度在
 * 任意 meter 三态 × 电平 × 帧索引 × 模式 × 语言 × 自动朗读开关下恒定（分段文本已与语言无关）。
 * @param phrases 当前语言文案表（**当前不被消费**：分段全为常量文本；保留以维持旧调用签名与全组合等宽契约枚举）
 * @param state 状态 + 注入/输入/自动朗读三个开关的激活态（`mode` 字段不参与渲染，`meter` 只影响第 2 段字形）
 * @returns 分段数组（固定 6 段）
 */
export function formatSlotSegments(phrases: Phrases, state: SlotRenderState): SlotSegment[] {
  void phrases; // 有意不消费：分段全为常量文本（形参为 API 稳定与等宽组合契约枚举而留）
  return [
    { text: MIC_SEGMENT_TEXT, role: "mic" },
    { text: meterGlyph(state.meter), role: "meter" },
    { text: INPUT_SEGMENT_TEXT, role: state.inputOn ? "keyActive" : "keyInactive" },
    { text: SLOT_KEY_SEPARATOR, role: "separator" },
    { text: INJECT_SEGMENT_TEXT, role: state.injectOn ? "keyActive" : "keyInactive" },
    { text: AUTO_READ_SEGMENT_TEXT, role: state.autoReadOn ? "autoReadActive" : "autoReadInactive" },
  ];
}

/**
 * 把状态渲染为槽位指示文本（单个元素）。
 * mic 段恒为 `🎙 `（静态、不做动画），第 2 段恒为 meter 列的**单个 1 列盲文字形**（三态取字，见 `meterGlyph`）
 * ⇒ 任意 meter 三态 × 电平 × 帧索引 下拼接总宽恒定（见 `formatSlotSegments`）。
 * 键位段恒为 `↧F8/⤉F9`（两组都显示，作切换提示；**哪组亮即当前模式**，无模式文字段）、
 * 末端恒追加 ` 🔊 F10`（自动朗读状态段），均不随模式/开关变文本。
 * @param phrases 当前语言文案表（透传给 `formatSlotSegments`，当前不被消费）
 * @param state 状态（`mode` 字段不参与渲染；`meter` 决定第 2 段字形；三个开关按「全关」补默认值）
 * @returns 形如 `🎙  ↧F8/⤉F9 🔊 F10`（关，meter 空白）/ `🎙 ⠹↧F8/⤉F9 🔊 F10`（连接中）/ `🎙 ⠿↧F8/⤉F9 🔊 F10`（在听·满电平）
 */
export function formatSlotIndicator(phrases: Phrases, state: SlotState): string {
  const segments = formatSlotSegments(phrases, { ...state, injectOn: false, inputOn: false, autoReadOn: false });
  return segments.map((segment) => segment.text).join("");
}
