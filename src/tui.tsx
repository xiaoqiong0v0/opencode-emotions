/** @jsxImportSource @opentui/solid */
/**
 * opencode-voice TUI 插件（**单插件**，承担 UI + 运行时管理 + 分发）。
 *
 * 背景：spike 已证实 TUI 插件自带 `api.client`（OpencodeClient），注入无需 server 插件，
 * 故旧 `voice-server`（HTTP 网关 + session-tracker + process-manager）整套删除。
 *
 * 能力：
 * - 在 `session_prompt_right` 渲染**单个**状态指示 `[🎙 恒静态][meter 1 列盲文音量][↧F8/⤉F9][🔊 F10]`
 *   （如关 `🎙  ↧F8/⤉F9 🔊 F10`、连接中 `🎙 ⠹↧F8/⤉F9 🔊 F10`、在听满电平 `🎙 ⠿↧F8/⤉F9 🔊 F10`）：
 *   **2026-10-21 用户指令（第十批）**：`●`/`○`/`⏳` 状态圆圈段删除，改为
 *   **两个模式图标紧贴各自键位成组**（输入/F8、注入/F9）。
 *   **2026-10-21 用户指令（第十一批）**：① `🎙` 麦克风图标段**恢复**为最前静态前缀（样式仿末端
 *   `🔊 F10`：图标 + 空格，不分模式、取中性色 `accent`）；② 输入组图标 `⇥`(U+21E5) 与 `F8`
 *   字形重叠 ⇒ 换为 `↧`(U+21A7)（宽度口径仍计 1），注组 `⤉`(U+21C9) 不变。
 *   **历史（第十二批 / 2026-10-22 缺陷一+二）**：`⏳`/`🎙`/`🎤` 曾**共用最前一格**做 mic 三态 + emoji 帧轮播；
 *   **2026-10-22 用户指令（第十三批）全部推翻删除**——emoji 的字形与进格宽度由终端/字体决定，
 *   轮播会**跳位、视觉重心不齐**（且不居中、丑），emoji 也**不吃终端前景色**（变色动画同样无效）。
 *   **现状（第十三批）**：① `🎙 ` **永远静态**（不换字形、不变色）；② 其后是**恒定 1 列盲文音量列**（`meter` 段），
 *   三态由 `asrReady` × 开关推导：`idle`（关）→ 空白、`connecting`（开但未连上 ASR）→ 盲文 spinner（每 100ms 换帧）、
 *   `listening`（已就绪）→ 盲文电平条（6 档，由 runtime NDJSON `level` 事件的**真实麦克风电平**驱动 ⇒ **有音频输入才动**）；
 *   选字与宽度口径见 `src/voice/slot.ts`（盲文 EA=Neutral 恒 1 列），整条总宽 **恒 18**（zh/en 一致，上批 17）。
 *   当前模式（**无模式文字段**，第九批删 `注入`/`输入`）**= 哪一组「图标+键位」整组亮**：
 *   **`↧F8` 亮=输入、`⤉F9` 亮=注入**）+ 两组热键（段恒为 `↧F8/⤉F9`）
 *   + 末端**自动朗读状态段** `🔊 F10`（恒为固定文本，仅配色表达开关：亮=开、暗=关；**不是模式**、不进模式语义）；
 * - 两个**点按开关**热键（不能按住：长按会键重复且松键不上报，见 spike 结论）：
 *   - `F8` = 模式 B「语音输入」：识别结果经 `client.tui.appendPrompt` 增量追加进输入框，由用户编辑后发送；
 *   - `F9` = 模式 A「语音注入」：识别结果经 `client.session.prompt` 变成一条带 🎙 标记的新消息；
 *   - `F10` = **自动朗读双态**（模型不可切换，独占于热键）：**本会话（或无主）有活跃播放**时点按 = **只中断播放、
 *     不切开关**（`isInterruptablePlaybackActive` 判活 → `writeInterruptRequest(sessionID)` 写会话级**中断请求水位**
 *     + `stopPlayback({ sessionID })` + toast，不写状态文件、
 *     不 bump 指示灯修订号，开关与灯原样；水位文件是跨进程兜底——停播按 PID 杀，单元间隙无进程可杀、
 *     worker 死后朗读侧又可能重新 spawn，两种都由 server 侧 `auto-read` 读水位拦）；**无活跃播放**时才走原 toggle 语义——点按切换**当前会话**的共享状态文件
 *   （每会话目录 `<root>/<sessionID>/auto-tts`，内容 `on`/`off`，缺省=关；一个会话的开关不影响其它会话）；
 *   关闭时立即 `stopPlayback({ sessionID })` 停掉**本会话**正在朗读的那段（跨会话不误杀、无主播放仍可停），开启只影响后续助手回复、**不**补读历史。
 *   **键重复抑制**：按住 F10 会被 OS 连发按键事件（长按会键重复），逐事件切换会偶数次翻转净回「关」，
 *   故一次按键事件流只算一次切换（尾沿静默窗口见 `shouldAcceptAutoTtsToggle`）。
 *   子会话（subagent）不支持：按 F10 时 toast 提示「子会话不自动朗读」，不写状态文件。
 *   槽位末端 `🔊 F10` 段只做**状态显示**（响应式跟随当前会话：初值/切换会话/F10 后重算）。
 *   （运行时消费该状态并派生 CLI 朗读，见 `voice/auto-read.ts` / `voice/auto-tts.ts`。）
 * - 运行时：`child_process.spawn` 起 `dist/runtime/voice-runtime.js --json`，按行读其 stdout 的 NDJSON
 *   （契约见 `voice/ndjson.ts`），按当前模式分发；`api.ui.toast` 给可见反馈。
 * - **半双工静音门**（2026-10-22，AEC 实测 unsupported 的兜底）：`dispatch()` **最前面**判「本会话（或无主）
 *   是否有活跃播放」（复用 `isInterruptablePlaybackActive`，不另造归属口径）+ 尾音窗口
 *   （`voice/asr-gate.ts`，`ASR_GATE_TAIL_MS`）；活跃 ⇒ **丢弃该条 final**（只记一行 `asr gate drop` 日志，
 *   不 toast、不注入、不 appendPrompt），掐断「朗读→麦克→转文字→注入→再朗读」回环。代价＝播放期间说话被吞（预期）。
 *
 * 进程边界：TUI 运行在 Bun 宿主内，通过相对导入复用 `voice/ndjson.js` 的契约解析（同一构建产物内相对解析）。
 * 装载：`tui.json` 的 `plugin` 指向**编译产物**（`.opencode/plugin/tui.js`，即镜像后的 `dist/tui.js`）。
 * 构建：`.tsx` **不参与主 `tsc` 构建**，由 `scripts/build-tui.mjs` 用**宿主同款 Babel 链**
 *   （`babel-preset-solid` universal + `@babel/preset-typescript`）编译成 `dist/tui.js`——
 *   必须走 Solid 编译（JSX 会被包成 `createElement`/`insert`/`setProp` + `effect` 的响应式结构）；
 *   若改用 `tsc` 的 `jsx()` 产物，props/children 不会被包成访问器，槽位将失去响应式。
 * i18n：全部面向用户的文案取自 `lib/i18n.ts` 词表，语言来自 `emotions.jsonc` 的 `uiLanguage`。
 * 健壮性：所有异常一律 catch，绝不影响 opencode；子进程异常退出时复位开关、可再次热键重启。
 */

import { spawn, type ChildProcess } from "node:child_process";

import { createSignal } from "solid-js";

import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui";
import createLogger from "@xiaoqiong0v0/opencode-plugin-logger";
import type { Logger } from "@xiaoqiong0v0/opencode-plugin-logger";

import { DEFAULT_LANGUAGE, format, getPhrases, type Phrases } from "./lib/i18n.js";
import { pickStderrSummary, resolveRuntimeScript, selfDirFromModuleUrl } from "./lib/runtime-diagnostics.js";
import { loadVoiceConfig } from "./voice/config.js";
import { ASR_GATE_TAIL_MS, shouldDropAsrFinal } from "./voice/asr-gate.js";
import {
  AUTO_READ_DEFAULT_NODE_BIN,
  AUTO_READ_NODE_BIN_ENV,
} from "./voice/auto-read.js";
import {
  autoTtsStatePath,
  readAutoTts,
  resetAutoTtsSessionOnce,
  shouldAcceptAutoTtsToggle,
  writeAutoTts,
  writeInterruptRequest,
} from "./voice/auto-tts.js";
import { NdjsonLineSplitter, parseEventLine, type RuntimeFinal } from "./voice/ndjson.js";
import {
  isInterruptablePlaybackActive,
  PLAYBACK_OWNERLESS_KEY,
  stopPlayback,
  stopPlaybackForSessions,
} from "./voice/playback-state.js";
import {
  AUTO_READ_KEY,
  AUTO_READ_KEY_LABEL,
  formatSlotSegments,
  INPUT_KEY,
  INPUT_KEY_LABEL,
  INJECT_KEY,
  INJECT_KEY_LABEL,
  METER_SPINNER_FRAMES,
  type MeterPhase,
  type SlotColorRole,
  type SlotMode,
  type SlotSegment,
} from "./voice/slot.js";

/** 文件来源插件必须导出 id。 */
const PLUGIN_ID = "voice-tui";
/**
 * 诊断日志名（F10 全链路埋点）：写进与其它插件同一份日志文件
 * （`~/.opencode/plugins-log/<日期>.log`，开关在 `~/.config/opencode/plugin-logger.jsonc` 的 `enabled`）。
 */
const LOG_NAME = "emotions-tui";
/** 诊断日志（未启用时 createLogger 返回空实现，零开销、绝不影响 TUI）。 */
const log: Logger = createLogger(LOG_NAME);
/**
 * 指示读路径诊断（低噪）：上一次 `autoReadOn` 求值所用的会话 id；`null` 表示尚未求值过。
 * 仅当本次 sid 与上次不同才打一条 `indicator session=…`，用于实测「切会话是否重算、两源各是什么」。
 */
let lastIndicatorSid: string | null = null;
/**
 * 本 TUI 进程**见过的会话集合**（**只增不减**；一个 opencode 窗口 = 一个 TUI 进程 = 一个模块实例）。
 * 两处消费：
 * 1. **每会话首见懒重置**（`resetAutoTtsSessionOnce`）：首见某会话 → 清该会话 auto-tts 目录（从关开始），
 *    再见不重置——推翻旧「init 全清整个 base」（那会误清其它窗口已激活的会话，日志实锤见 init 注释）；
 * 2. **退出停播**（`onDispose` → `stopPlaybackForSessions`）：窗口退出时停掉本窗口见过的会话的播放。
 * 空/非法 sid 不入集合（`resetAutoTtsSessionOnce` 内 `isValidSessionID` 拦截）。
 */
const touchedSessions = new Set<string>();
/** 模式 A 命令名。 */
const CMD_MODE_A = "voice.inject.toggle";
/** 模式 B 命令名。 */
const CMD_MODE_B = "voice.input.toggle";
/** 自动朗读开关命令名（F10；模型不可切换，独占于热键）。 */
const CMD_AUTO_TTS = "voice.autotts.toggle";
/**
 * 插件产物**自身目录**（运行时脚本的路径锚点）：由 `import.meta.url` 推出 `dist/tui.js` 所在目录
 * （镜像布局下即 `.opencode/plugin/`），运行时脚本与其同级 `runtime/voice-runtime.js`。
 * 锚点不可靠（宿主把模块 URL 虚拟化 ⇒ `null`）时，解析自动降级到 cwd 兜底并记日志。
 * 2026-10-22 根因修复：旧实现只按 `process.cwd()` 拼路径，在家目录启动 opencode 即 spawn 必死。
 */
const SELF_DIR = selfDirFromModuleUrl(import.meta.url);
/** Node 可执行文件环境变量与默认名（与 auto-read 派生 CLI 共用同一 env，单源在 auto-read.ts）。 */
const NODE_BIN_ENV = AUTO_READ_NODE_BIN_ENV;
const DEFAULT_NODE_BIN = AUTO_READ_DEFAULT_NODE_BIN;
/** 运行时脚本路径环境变量（覆盖优先；缺省按插件产物自身位置解析）。 */
const SCRIPT_ENV = "VOICE_RUNTIME_SCRIPT";
/** 子进程 stderr 缓冲保留的末尾字符数（防无界增长；全量仅进日志、不进 toast）。 */
const STDERR_BUFFER_MAX = 4000;
/** toast 里 stderr 关键行的最大长度（够容纳 `Error: Cannot find module '<绝对路径>'`）。 */
const STDERR_TOAST_MAX = 120;
/** 注入消息前缀标记（标识来源于语音）。 */
const INJECT_MARKER = "🎙";
/** 等待子进程 spawn 的超时（毫秒）。 */
const SPAWN_TIMEOUT_MS = 5000;
/** 停止子进程时等待其退出的上限（毫秒）。 */
const STOP_TIMEOUT_MS = 2000;
/** toast 里预览文本的最大长度。 */
const PREVIEW_LEN = 24;
/**
 * 静音门**丢弃日志**里文本预览的最大长度（2026-10-22）：只需够辨认「被吞掉的那句在说什么」，
 * 与 toast 预览（{@link PREVIEW_LEN}）分开——丢弃日志只进日志文件、不占 toast 版面。
 */
const ASR_GATE_PREVIEW_LEN = 20;
/**
 * toast 里**运行时 error 事件消息**的最大长度（与 stderr 摘要 `STDERR_TOAST_MAX` 同口径 120）：
 * 配置引导文案（哪缺、去哪配）的关键信息约定在前 120 字符内，不能用 24 字符的通用预览截掉。
 */
const ERROR_TOAST_MAX = 120;
/**
 * meter 列**连接中** spinner 的**换帧间隔**（毫秒，2026-10-22 第十三批）：
 * **仅 connecting**（F8/F9 开着但 `asrReady=false`）时定时器每 100ms 递增一次帧索引，由 `slot.ts` 取模选盲文字形；
 * 进入 `listening`（在听，动画改由真实电平驱动、无需定时器）或 `idle`（关）时**停表并归零**。
 * 取代旧的 `MIC_FRAME_INTERVAL_MS`（emoji 帧轮播，已随第十三批删除）。
 */
const SPIN_FRAME_INTERVAL_MS = 100;

/** 模式标识（与槽位渲染共用）。 */
type VoiceMode = SlotMode;

/** 槽位分段可用的 theme 颜色键（核对自 `@opencode-ai/plugin` `dist/tui.d.ts` 的 `TuiThemeCurrent`）。 */
type SlotThemeKey = "primary" | "accent" | "success" | "warning" | "info" | "textMuted";

/** 模式 → 固定颜色键：注入=`warning`、输入=`primary`（模式文字段删除后**仅供「激活整组图标+键位」取色**）。 */
const MODE_THEME_KEY: Record<VoiceMode, SlotThemeKey> = {
  inject: "warning",
  input: "primary",
};

/** 把任意错误转为简短字符串。 */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 取错误堆栈（无堆栈时占位），仅供诊断日志完整还原失败链路；
 * 与 toast 摘要 `errText` 分开（toast 只显 message，日志额外带 stack）。
 */
function errStack(err: unknown): string {
  return err instanceof Error && err.stack ? err.stack : "(no stack)";
}

/** 截断文本用于 toast 预览（`max` 可按场景放宽，见 `ERROR_TOAST_MAX`）。 */
function preview(text: string, max: number = PREVIEW_LEN): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 延时。 */
function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

/** 读取 UI 文案语言（`uiLanguage`）的文案表（配置读取失败回退默认，绝不影响 TUI）。 */
function safePhrases(): Phrases {
  try {
    return getPhrases(loadVoiceConfig().uiLanguage);
  } catch {
    return getPhrases(DEFAULT_LANGUAGE);
  }
}

/**
 * 等待子进程成功 spawn（`error` 或超时则 reject）。
 * @param child 子进程
 * @param timeoutMs 超时毫秒
 * @returns 成功时 resolve
 */
function waitForSpawn(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolveSpawn, rejectSpawn) => {
    let settled = false;
    const settle = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) rejectSpawn(err);
      else resolveSpawn();
    };
    const timer = setTimeout(() => settle(new Error(`启动超时（${timeoutMs}ms 内未收到 spawn 事件）`)), timeoutMs);
    child.once("spawn", () => settle());
    child.once("error", (err: Error) => settle(err));
  });
}

/**
 * 读取当前会话 id。
 * @param api 宿主注入的 TUI API
 * @returns 当前处于会话路由时的 sessionID；否则 undefined
 */
function currentSessionID(api: TuiPluginApi): string | undefined {
  try {
    const current = api.route.current;
    if (current.name === "session" && "params" in current && current.params) {
      const sessionID = (current.params as { sessionID?: unknown }).sessionID;
      if (typeof sessionID === "string" && sessionID.length > 0) return sessionID;
    }
  } catch {
    // 路由不可用时视为无会话
  }
  return undefined;
}

/**
 * 组合注入/追加正文：有标注时前置 `emoji(等级/3)`。
 * @param result 识别结果
 * @returns 正文
 */
function composeBody(result: RuntimeFinal): string {
  const annotation = result.annotation.trim();
  return annotation ? `${annotation} ${result.text}` : result.text;
}

const tui: TuiPlugin = async (api: TuiPluginApi) => {
  // 重启语义（**2026-10-21 改「每会话首见懒重置」，推翻旧「init 清整个 base」**）：TUI 初始化**不再**调
  // `resetAutoTtsState()` 全清——旧取舍在多窗口混音场景作废（日志实锤：14:16:29 A 窗 F10 写 on →
  // 中途开 B 窗触发 init 全清把 A 的 auto-tts 目录删掉 → 14:17:09 回 A 窗灯读到关、F10 再按读 off 又写 on，
  // 看着「按了没反应」；指示灯/路由响应式本身正常）。现由两个触点（指示读 `autoReadOn` 求值、F10
  // `toggleAutoRead` 入口）在**本进程首次见到某会话**时清**该会话目录**（`resetAutoTtsSessionOnce`，
  // 记入模块级 `touchedSessions`，只增不减）：本进程首见 = 该会话从关开始；后开窗口只重置它自己首见的
  // 会话，**不误清其它窗口已激活的会话**（见 `auto-tts.ts` 文件头「重启语义」）。
  const phrases = safePhrases();
  const [injectOn, setInjectOn] = createSignal(false);
  const [inputOn, setInputOn] = createSignal(false);
  // ASR 就绪信号（2026-10-22 缺陷一「就绪反馈闭环」）：本会话语音 runtime 已连上 ASR、真在听 = true；
  // 由 runtime NDJSON `ready` 事件置真，startRuntime/stopRuntime/handleChildGone/关模式置假。
  // 驱动 meter 三态（`connecting` ↔ `listening`）与 spinner 定时器启停；替代旧 `busy`（旧只覆盖 spawn 等待窗口，
  // 不含「spawn 成功但 ASR 还没连上」的 1~3s 死区 ⇒ mode started toast 出现时其实还没开麦、反馈错位）。
  const [asrReady, setAsrReady] = createSignal(false);
  // 当前展示的模式（开/关都保留；默认「输入」），用于单个槽位指示的模式位
  const [mode, setMode] = createSignal<VoiceMode>("input");
  // 自动朗读分会话开关的**修订号**（仅驱动槽位末端 `🔊 F10` 段重算）：
  // 真值在每会话状态文件（`<sessionID>/auto-tts`，内容 on/off）；F10 toggle 写成功后 bump 本信号，
  // 槽位渲染读 `readAutoTts(routeSid || props.session_id || "")`——**路由优先**（与写路径同源取值），
  // props 仅兜底并作为响应依赖（宿主若响应式传参，切会话时 props 变化触发重算）。
  const [autoReadRev, setAutoReadRev] = createSignal(0);
  // F10 上一次按键事件时刻（键重复抑制的窗口起点；每个事件都刷新，见 shouldAcceptAutoTtsToggle）
  let lastAutoTtsToggleEventAt = 0;
  /**
   * 静音门**尾音窗口起点**（2026-10-22，半双工兜底；本 TUI 进程内私有，只由 `dispatch()` 读写）：
   * 每次判活为真刷新为当刻，之后 {@link ASR_GATE_TAIL_MS} 内仍丢弃 final（覆盖尾音/混响）。
   * `0` = 本进程从未观察到活跃播放。与 `touchedSessions` 同为**窗口级**状态（多窗口各自独立，无需跨进程同步）。
   */
  let lastInterruptableActiveAt = 0;

  let child: ChildProcess | null = null;
  let splitter = new NdjsonLineSplitter();
  let toggling = false;
  let stopping = false;
  let disposed = false;
  /** 子进程 stderr 的末尾缓冲（运行时会周期性打采集统计，故留存全量尾部供**日志**还原，toast 只显关键行）。 */
  let stderrTail = "";

  /** 模式是否开启。 */
  const isOn = (target: VoiceMode): boolean => (target === "inject" ? injectOn() : inputOn());
  /** 是否已有开关开启（等价于运行时应存在）。 */
  const anyOn = (): boolean => injectOn() || inputOn();
  /** 是否已有存活的子进程。 */
  const childAlive = (): boolean => child !== null && child.exitCode === null && !child.killed;
  /** 模式对应的完整标签。 */
  const modeLabel = (target: VoiceMode): string =>
    target === "inject" ? phrases.label.inject : phrases.label.input;

  // 盲文音量列（meter 段）状态（2026-10-22 第十三批：取代旧 mic 帧轮播）——**两段来源**：
  // ① `micLevel`：runtime NDJSON `level` 事件写入的**真实麦克风电平**（`[0,1]`，10Hz 节流、直接覆盖不累积），
  //    仅 `listening` 态被消费（分档成电平条）；② `spinFrame`：仅 `connecting` 态由定时器每 SPIN_FRAME_INTERVAL_MS 递增，
  //    由 slot.ts 取模选 spinner 盲文字形。阶段本身不单独存信号——由 `anyOn()` × `asrReady()` 现推（见 `meterPhase()`）。
  const [micLevel, setMicLevel] = createSignal(0);
  const [spinFrame, setSpinFrame] = createSignal(0);
  let spinFrameTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * 按当前阶段同步 spinner 定时器：**只有「连接中」**（`anyOn()` 且 `!asrReady()`，开了但 ASR 还没连上）才起表轮播，
   * 进入「在听」（动画改由真实电平驱动）或「关」（无动画）时**停表并把帧索引归零**。
   * 触点：handleEvent ready / level（就绪后无需起表）、toggleMode 收尾（finally）、
   * handleChildGone（runtime 意外退出）、stopRuntime、startRuntime（新 runtime 进入连接中）、onDispose（清表防泄漏）。
   */
  const syncSpinFrame = (): void => {
    const connecting = anyOn() && !asrReady();
    if (connecting && spinFrameTimer === null) {
      const frameCount = METER_SPINNER_FRAMES.length;
      spinFrameTimer = setInterval(
        () => setSpinFrame((v: number) => (v + 1) % frameCount),
        SPIN_FRAME_INTERVAL_MS,
      );
      spinFrameTimer.unref?.();
    } else if (!connecting && spinFrameTimer !== null) {
      clearInterval(spinFrameTimer);
      spinFrameTimer = null;
      setSpinFrame(0);
    }
  };

  /** 弹 toast（安全包装，dispose 后静默）。 */
  const toast = (variant: "info" | "success" | "warning" | "error", message: string): void => {
    if (disposed) return;
    try {
      api.ui.toast({ variant, title: phrases.toast.title, message });
    } catch {
      // 宿主 UI 不可用时忽略
    }
  };

  /** 追加一段子进程 stderr 到末尾缓冲（超限截尾，防无界增长）。 */
  const appendStderr = (chunk: string): void => {
    if (chunk.length === 0) return;
    stderrTail = (stderrTail + chunk).slice(-STDERR_BUFFER_MAX);
  };
  /** stderr 末尾缓冲的单行形态（仅日志用：换行折叠成 ` | `，一条日志即可还原崩溃现场）。 */
  const stderrForLog = (): string => stderrTail.replace(/\r?\n/g, " | ").trim();

  /** 子进程结束/异常时复位开关并提示（主动停止时不提示）。 */
  const handleChildGone = (reason: string): void => {
    // 口径分开：toast 只显**关键行**（含 Error 的首行，退化时取首个非噪声行），日志留**全量尾部**。
    // 旧实现只存末行 ⇒ Node 崩溃时末行是版本横幅（`Node.js v…`），用户看不到真正的原因。
    const summary = pickStderrSummary(stderrTail, STDERR_TOAST_MAX);
    log.warn(`runtime exited: reason=${reason} stderr=${stderrForLog() || "-"}`);
    child = null;
    splitter = new NdjsonLineSplitter();
    // runtime 没了 ⇒ 复位 asrReady（不再在听），停 spinner（含主动停止路径；开关信号下面按情况复位）
    setAsrReady(false);
    syncSpinFrame();
    if (stopping) return;
    setInjectOn(false);
    setInputOn(false);
    const detail = summary ? `；stderr：${summary}` : "";
    toast("error", format(phrases.toast.runtimeExited, { reason, detail }));
  };

  /** 处理一条 NDJSON 事件。 */
  const handleEvent = (event: ReturnType<typeof parseEventLine>): void => {
    if (!event) return;
    switch (event.type) {
      case "ready":
        // ASR 已连上、真在听 ⇒ asrReady 置真（meter 段从「连接中 spinner」切到「在听·电平条」）+ 停 spinner。
        // 注：若此刻模式已被关掉（迟到的 ready），asrReady 仍置真但 anyOn=false ⇒ meterPhase() 走 idle、
        // syncSpinFrame 不起表（connecting=false）、不影响视觉；toast 保留（沿用既有行为）。
        setAsrReady(true);
        syncSpinFrame();
        toast("info", phrases.toast.ready);
        break;
      case "level":
        // 麦克风电平（10Hz 节流上行）：**直接覆盖**信号、不累积、不过滤（越界由 slot.ts 的 meterGlyph 归档）。
        // 高频事件 ⇒ **不 toast、不写日志**（本项目 logger 无 debug 级，逐条 info 会刷屏日志），只做数据搬运。
        setMicLevel(event.level);
        break;
      case "final":
        void dispatch(event);
        break;
      case "error":
        // 配置引导类错误（ffmpeg/设备/凭证）按 120 字符口径展示，保证「哪缺、去哪配」可见
        toast("warning", format(phrases.toast.runtimeError, { message: preview(event.message, ERROR_TOAST_MAX) }));
        break;
      case "done":
        break;
      default:
        break;
    }
  };

  /** stdout 分片 → 完整行 → 事件。 */
  const onStdout = (chunk: string): void => {
    for (const line of splitter.push(chunk)) handleEvent(parseEventLine(line));
  };

  /** 启动语音运行时（单实例；等 `spawn` 事件确认）。 */
  const startRuntime = async (): Promise<void> => {
    if (childAlive()) return;
    // 新 runtime 尚未连上 ASR ⇒ 先复位 asrReady（meter 段进入「连接中」spinner，等 `ready` 事件再切电平条）。
    setAsrReady(false);
    syncSpinFrame();
    // 脚本路径：env 覆盖 > 插件产物自身位置 > cwd 兜底（见 lib/runtime-diagnostics.ts 的根因说明）
    const scriptEnv = process.env[SCRIPT_ENV] ?? null;
    const resolution = resolveRuntimeScript({ envScript: scriptEnv, selfDir: SELF_DIR, cwd: process.cwd() });
    const script = resolution.script;
    const bin = process.env[NODE_BIN_ENV] || DEFAULT_NODE_BIN;
    // 诊断埋点：解析出的 node/脚本路径 + **来源/是否存在/全部候选**（ENOENT/权限/路径错，第一时间可判）
    log.info(
      `startRuntime begin: bin=${bin} script=${script} scriptSource=${resolution.source} scriptExists=${resolution.exists} selfDir=${SELF_DIR ?? "-"} cwd=${process.cwd()} candidates=${resolution.candidates.join(" | ")} scriptEnv=${scriptEnv ? "set" : "-"} nodeBinEnv=${process.env[NODE_BIN_ENV] ? "set" : "-"}`,
    );
    // 候选都不存在（或显式 env 覆盖指向不存在的文件）⇒ 直接报错并带上**完整绝对路径**，
    // 不再 spawn 一个必死的 node 进程（旧行为：node 秒退 code=1，toast 只剩版本横幅，无从下手）。
    if (!resolution.exists) {
      throw new Error(
        `语音运行时脚本不存在：${script}（来源=${resolution.source}，候选=${resolution.candidates.join(" | ")}，可用 ${SCRIPT_ENV} 指定绝对路径）`,
      );
    }

    let spawned: ChildProcess;
    try {
      spawned = spawn(bin, [script, "--json"], {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      throw new Error(`无法启动 ${bin}：${errText(err)}`);
    }
    // 诊断埋点：spawn() 已同步返回句柄（尚未收到 spawn 事件）——与 begin/failed 对照即可判卡在哪一步
    log.info(`startRuntime spawned: pid=${spawned.pid ?? "-"}`);

    child = spawned;
    splitter = new NdjsonLineSplitter();
    stderrTail = "";
    spawned.stdout?.setEncoding("utf8");
    spawned.stdout?.on("data", (chunk: string) => onStdout(chunk));
    spawned.stderr?.on("data", (chunk: Buffer) => appendStderr(String(chunk)));
    spawned.on("error", (err: Error) => handleChildGone(`进程错误：${err.message}`));
    spawned.on("exit", (code: number | null, signal: NodeJS.Signals | null) =>
      handleChildGone(`code=${code ?? "-"} signal=${signal ?? "-"}`),
    );

    await waitForSpawn(spawned, SPAWN_TIMEOUT_MS);
    // 诊断埋点：已收到 spawn 事件确认（startRuntime 成功返回；失败链路里这一条缺席）
    log.info(`startRuntime ready: pid=${spawned.pid ?? "-"}`);
  };

  /** 停止语音运行时并等待其退出。 */
  const stopRuntime = async (): Promise<void> => {
    // 主动停止：立即复位 asrReady（不再在听）、停 spinner；不依赖 exit 事件（超时兜底路径也能复位）。
    setAsrReady(false);
    syncSpinFrame();
    const current = child;
    if (!current || current.exitCode !== null) {
      child = null;
      return;
    }
    stopping = true;
    const exited = new Promise<void>((resolveExit) => current.once("exit", () => resolveExit()));
    try {
      current.kill();
    } catch (err) {
      console.error(`[voice] 停止子进程失败：${errText(err)}`);
    }
    await Promise.race([exited, delay(STOP_TIMEOUT_MS)]);
    stopping = false;
    if (child === current) child = null;
  };

  /**
   * 按当前模式分发一条最终结果。
   * **最前面先过静音门**（2026-10-22 半双工兜底，AEC 实测 unsupported）：本会话（或无主）有活跃 TTS
   * 播放、或播放刚结束仍在尾音窗口内 ⇒ **直接丢弃**这条 final（只记一行日志，不 toast、不注入、不 appendPrompt）。
   * 口径详见 `src/voice/asr-gate.ts` 文件头与 `docs/设计-语音输入注入.md` §16；`ready/error/done` 事件不经此处。
   */
  const dispatch = async (result: RuntimeFinal): Promise<void> => {
    // 归属判定**只复用** helper（与 stopPlayback / F10 双态中断同一道会话归属门：本会话键 + 无主 `_`，
    // 其它会话条目一律不算）。取不到会话路由时传哨兵键 `PLAYBACK_OWNERLESS_KEY` ⇒ 只算无主播放：
    // 本会话未知时**宁可漏拦也不越界读其它会话**（helper 的空 sessionID = 全部条目，不符合本门范围）。
    // 不缓存 playback 状态：final 频率低（一次说话才一条），每次直接读一个 JSON 文件比维护缓存更便宜、
    // 也不会读到陈旧值（helper 内部还顺带清 TTL 陈旧条目）。
    const gateSessionID = currentSessionID(api);
    const gateNow = Date.now();
    const playbackActive = isInterruptablePlaybackActive(gateSessionID ?? PLAYBACK_OWNERLESS_KEY, gateNow);
    if (playbackActive) lastInterruptableActiveAt = gateNow;
    if (shouldDropAsrFinal(playbackActive, lastInterruptableActiveAt, gateNow, ASR_GATE_TAIL_MS)) {
      log.info(
        `asr gate drop: session=${gateSessionID ?? "-"} active=${playbackActive} sinceActiveMs=${gateNow - lastInterruptableActiveAt} text=${preview(result.text, ASR_GATE_PREVIEW_LEN)}`,
      );
      return;
    }
    const body = composeBody(result);
    if (injectOn()) {
      const sessionID = currentSessionID(api);
      if (!sessionID) {
        toast("warning", phrases.toast.notInSession);
        return;
      }
      try {
        const response = await api.client.session.prompt({
          sessionID,
          noReply: false,
          parts: [{ type: "text", text: `${INJECT_MARKER} ${body}` }],
        });
        if (response.error) {
          toast("error", format(phrases.toast.injectFailed, { message: preview(JSON.stringify(response.error)) }));
        } else {
          toast("success", format(phrases.toast.injected, { text: preview(result.text) }));
        }
      } catch (err) {
        toast("error", format(phrases.toast.injectException, { message: errText(err) }));
      }
      return;
    }
    if (inputOn()) {
      try {
        await api.client.tui.appendPrompt({ text: ` ${body} ` });
        toast("success", format(phrases.toast.appended, { text: preview(result.text) }));
      } catch (err) {
        toast("error", format(phrases.toast.appendFailed, { message: errText(err) }));
      }
    }
  };

  /** 切换某模式（点按开关；两种模式互斥）。 */
  const toggleMode = async (target: VoiceMode): Promise<void> => {
    // 诊断埋点（F8/F9）：入口关键状态，打在 re-entry 守卫之前——
    // 若 toggling=true 被吞（上一次切换未完），日志仍可见（随后即 return，无 started/off）。
    log.info(
      `mode toggle: target=${target} next=${!isOn(target)} toggling=${toggling} session=${currentSessionID(api) ?? "-"} childAlive=${childAlive()} anyOn=${anyOn()}`,
    );
    if (toggling) return;
    toggling = true;
    // 打断（barge-in）：按 F8/F9 语音输入时，立刻停掉正在播放的 TTS（按共享状态文件里的 PID）。
    // 带当前 sessionID 做会话隔离：只停本会话/无主播放（取不到会话路由时退化为停任意，与旧行为一致）。
    // 诊断埋点（2026-10-22，与 F10 中断日志同风格）：stopped=是否发出终止信号 + 会话，
    // 用于核实「F8/F9 到底有没有停掉播放」——false 也可能是「本就没有在播」，结合 playback 日志判定。
    const interruptSession = currentSessionID(api);
    try {
      // 会话级中断请求水位（2026-10-22）：`stopPlayback` 只按 PID 杀，**单元间隙无进程可杀**时杀空、
      // 朗读侧随后又可能重新 spawn ⇒ 中断意图必须落文件由 auto-read 自查。取不到会话路由则不写
      // （保持「无主」语义，与 stopPlayback 的无参退化同口径）。写失败静默（不影响语音输入）。
      if (interruptSession) writeInterruptRequest(interruptSession);
      const stopped = stopPlayback({ sessionID: interruptSession });
      log.info(`f8f9 interrupt: stopped=${stopped} session=${interruptSession ?? "-"} toggling=${target}`);
    } catch {
      log.info(`f8f9 interrupt: stopped=false session=${interruptSession ?? "-"} error=true`);
      // 打断失败不影响语音输入
    }
    const label = modeLabel(target);
    const next = !isOn(target);
    setMode(target);
    try {
      if (target === "inject") {
        setInjectOn(next);
        if (next) setInputOn(false);
      } else {
        setInputOn(next);
        if (next) setInjectOn(false);
      }

      if (next) {
        if (!childAlive()) {
          try {
            await startRuntime();
            // 诊断埋点：启动成功（子进程存活、pid 留存），与 startRuntime ready 对照
            log.info(`mode started: target=${target} label=${label} pid=${child?.pid ?? "-"}`);
            toast("success", format(phrases.toast.modeOn, { label }));
          } catch (err) {
            // 诊断埋点（核心取证）：startRuntime 失败——日志带完整 message + stack + stderr 全量尾部；
            // toast 只显 errText(err)（脚本不存在时该 message 本身就带完整绝对路径与候选，够定位）。
            log.warn(
              `startRuntime failed: target=${target} next=${next} err=${errText(err)} stack=${errStack(err)} stderr=${stderrForLog() || "-"}`,
            );
            if (target === "inject") setInjectOn(false);
            else setInputOn(false);
            toast("error", format(phrases.toast.startFailed, { message: errText(err) }));
          }
        } else {
          toast("info", format(phrases.toast.switched, { label }));
        }
      } else if (!anyOn()) {
        await stopRuntime();
        // 诊断埋点：关闭成功
        log.info(`mode off: target=${target} label=${label}`);
        toast("info", format(phrases.toast.modeOff, { label }));
      } else {
        toast("info", format(phrases.toast.switched, { label: modeLabel(target === "inject" ? "input" : "inject") }));
      }
    } finally {
      toggling = false;
      // 开关状态已落定：同步 spinner 定时器（连接中→起表，在听/关→停表复位）。
      // 新起 runtime 时 asrReady 仍为 false ⇒ 此刻正是「连接中」，此处**就是要起表**（`ready` 到达后停表改电平驱动）。
      syncSpinFrame();
    }
  };

  /**
   * 切换自动朗读（F10；点按开关，跨进程只写共享状态文件的**当前会话**条目，模型不可经 CLI 切换）。
   * 开启=后续助手回复自动朗读（**不**补读历史）；关闭=立即停掉正在朗读的那段（按共享状态里的 PID）。
   * **键重复抑制**：按住 F10 被 OS 连发按键事件时，一次物理按压只切换一次（尾沿静默窗口，
   * 每个事件都刷新窗口起点；吞掉的重复事件静默返回、不 toast）。
   * 子会话（subagent）→ toast 提示且**不写状态**；不在会话路由 → toast 提示。
   * 写成功后 bump `autoReadRev`（驱动槽位末端 `🔊 F10` 段重算）；写失败保持原值。
   */
  const toggleAutoRead = (): void => {
    const sessionID = currentSessionID(api);
    if (!sessionID) {
      // 诊断埋点③a：路由里取不到 sessionID（此时不刷新抑制窗口，与既有行为一致）
      log.info("f10 toggle skip: no session route");
      toast("warning", phrases.toast.notInSession);
      return;
    }
    // 触点②（F10 入口）：与指示读共用**每会话首见懒重置**（指示槽未渲染/未求值时的兜底）——
    // 本进程首见该会话 → 清该会话目录（从关开始），再见不重置；再继续读/切。
    if (resetAutoTtsSessionOnce(touchedSessions, sessionID)) {
      log.info(`lazy reset auto-tts session=${sessionID} firstTouch=f10`);
    }
    // 键重复/快速连按抑制：接受与否都刷新窗口起点（按住期间连发事件不断后移窗口 → 整次按住只切换一次）
    const now = Date.now();
    const last = lastAutoTtsToggleEventAt;
    const accepted = shouldAcceptAutoTtsToggle(now, last);
    lastAutoTtsToggleEventAt = now;
    // 诊断埋点③b：入口关键变量（accepted=false 表示被键重复抑制吞掉，静默返回是本意行为）
    log.info(`f10 toggle: sessionID=${sessionID} now=${now} last=${last} accepted=${accepted}`);
    if (!accepted) return;
    // **F10 双态中断**（2026-10-22 用户拍板）：本会话（或无主）有**活跃播放**时，本次按键**只中断播放、
    // 不切开关**——不写状态文件、不 bump autoReadRev（指示灯/开关原样），停播走既有按 PID 的 stopPlayback。
    // 判活与 stopPlayback **同源同口径**（isInterruptablePlaybackActive：只看本会话键 + 无主键，禁碰其它会话）。
    // 放在键重复抑制之后：按住连发仍只处理第一个 accepted 事件（中断后 return，不会顺带翻转开关）。
    if (isInterruptablePlaybackActive(sessionID)) {
      // 会话级中断请求水位（2026-10-22 修「按 F10 后剩余文本继续播」）：**无论 stopPlayback 是否杀中都写**——
      // ① 落在单元间隙时没有进程可杀（杀空），② worker 死后 auto-read 会重新 spawn（杀后重生），
      // 两者都只能由朗读侧在每个派发单元前读该水位拦下（消费方 `voice/auto-read.ts`，时序契约 `docs/ASYNC.md` ⑰）。
      // 放在 stopPlayback 之前：即便停播抛异常，中断意图也已落盘。开关与指示灯不动（双态语义保持）。
      const interruptReq = writeInterruptRequest(sessionID);
      let stopped = false;
      try {
        stopped = stopPlayback({ sessionID });
      } catch {
        // 停播异常也按「已中断」返回（开关不动）；条目瞬态，下一按键事件会再判
      }
      log.info(`f10 interrupt: session=${sessionID} stopped=${stopped} interruptReq=${interruptReq} toggled=false`);
      toast("info", phrases.toast.autoReadInterrupted);
      return;
    }
    // 子会话硬跳过：TUI 侧用宿主本地 state 同步判定（无需经 client 单飞）；
    // server 侧另有 fetchIsChildSession 硬跳过兜底（TUI 判定失败/绕过时仍不读）。
    try {
      const session = api.state.session.get(sessionID);
      if (session?.parentID) {
        // 诊断埋点③c：判定为子会话 → toast 且不写状态文件
        log.info(`f10 toggle: sessionID=${sessionID} childSession parentID=${session.parentID} skip=true`);
        toast("info", phrases.toast.autoReadChildSession);
        return;
      }
    } catch {
      // state 不可用时降级为不拦（server 侧仍会硬跳过）
    }
    const next = !readAutoTts(sessionID);
    const writeOk = writeAutoTts(sessionID, next);
    // 诊断埋点④：写结果 + 目标路径（write false 时保留既有 error toast）
    log.info(`f10 write ${writeOk ? "ok" : "false"}: path=${autoTtsStatePath(sessionID)} value=${next ? "on" : "off"}`);
    if (!writeOk) {
      toast("error", phrases.toast.autoReadFailed);
      return;
    }
    setAutoReadRev((n: number) => n + 1);
    if (!next) {
      // 关闭：立刻停止当前正在播放的朗读（子进程登记的 PID），不等它自然播完。
      // 带当前 sessionID 会话隔离：F10 只关本会话，故也只停本会话/无主的播放。
      try {
        stopPlayback({ sessionID });
      } catch {
        // 停止失败不影响开关本身
      }
    }
    toast("success", next ? phrases.toast.autoReadOn : phrases.toast.autoReadOff);
  };

  // dispose：停止语音输入子进程 + **停本窗口会话的 TTS 播放**，避免留下孤儿进程。
  // 修「Ctrl+C 退出还在读」（日志实锤）：旧 dispose 只 `stopRuntime()`——TTS 的 CLI worker + 发声孙进程
  // （PowerShell）不属 voice-runtime，窗口退出后成孤儿、stdin 管道缓冲里已投递的句子继续播完。
  // 遍历本窗口**见过的**会话（touchedSessions）逐个带会话语义停：不误杀其它窗口的会话；
  // **已知取舍**：两窗口开着同一会话时一窗退出会互停该会话的播放。崩溃路径（未及 dispose）孤儿尾巴
  // 属已知残余——CLI/PowerShell 的 stdin 管道 EOF 收尾机制保留（auto-read server 侧进程退出自然死亡）。
  api.lifecycle.onDispose(() => {
    disposed = true;
    // 清 meter spinner 定时器（组件销毁必须停表，否则 interval 泄漏、setSignal 打在被销毁的 scope 上）
    if (spinFrameTimer !== null) {
      clearInterval(spinFrameTimer);
      spinFrameTimer = null;
    }
    void stopRuntime();
    stopPlaybackForSessions(touchedSessions);
  });

  // 常驻 UI：输入框右侧**单个**状态指示 `🎙 [meter]↧F8/⤉F9 🔊 F10`（2026-10-21 用户指令：●/○/⏳ 圆圈段删除、
  // 模式图标紧贴键位成组；同日第十一批恢复 `🎙` 段、`⇥`→`↧`；**2026-10-22 第十三批**：`🎙 ` 改为**恒静态**、
  // 删除 emoji 帧轮播与 `⏳`，其右侧新增**恒定 1 列盲文音量列**承载语音状态动画；末端 F10 段只显状态不显文字）。
  // 分段配色：`🎙 ` 段恒为中性 accent（静态标记）；**meter 列按三态静态取色**（在听=accent、连接中/关=textMuted，
  // 动画只体现在字形、不靠变色）；**激活模式的「图标+键位」整组用其模式色**
  // （**模式无文字段，靠 ↧F8/⤉F9 哪组亮表达**）；未激活整组/分隔符/未启用朗读用暗色；关闭态（无激活模式）两组键位都取 `textMuted`；
  // 自动朗读末端段独立着色（开=`success` 亮、关=`textMuted` 暗，文本恒定不随开关变）。
  api.slots.register({
    order: 0,
    slots: {
      // 宿主**应当**传入 session_id（opencode `packages/tui/src/routes/session/index.tsx` 的
      // `<pluginRuntime.Slot name="session_prompt_right" session_id={route.sessionID} />`），但 props 在本插件内
      // **是否响应式从未证实**；故读键以 `currentSessionID(api)` 为准（与写同源，见 `autoReadOn`），
      // props 仅兜底 + 响应依赖。
      session_prompt_right(props: { session_id: string }) {
        const theme = api.theme.current;
        /**
         * 盲文音量列（meter 段）当前阶段（2026-10-22 第十三批：取代旧 mic 三态 + emoji 帧轮播）：
         * 关模式=`idle`（该列空白）；开模式但 ASR 未连上（`asrReady=false`）=`connecting`（spinner，告诉用户「还在连、别急着说」）；
         * 开模式且已就绪（`asrReady=true`）=`listening`（电平条，由 runtime `level` 事件的真实电平驱动）。
         * `asrReady` 沿用上一批的「就绪反馈闭环」口径（只覆盖 spawn 等待 + ASR 连接死区）。
         */
        const meterPhase = (): MeterPhase => (!anyOn() ? "idle" : asrReady() ? "listening" : "connecting");
        /**
         * 当前会话的自动朗读开关（响应式）：依赖 `autoReadRev` 信号（F10 写成功后 bump）
         * 与 `props.session_id`（此处读一次构成响应依赖，宿主若响应式传参则切会话触发重算）。
         * **读写必须同源：路由优先、props 仅兜底 + 响应依赖；写在 toggle 同函数同源取值
         * （`currentSessionID(api)`）**——此前 props 优先级更高，若其为陈旧/非响应值，切会话后灯读旧会话状态。
         * `sid` 为空（不在会话路由且宿主未传）→ `autoTtsStatePath("")` 返回空串→读为关（安全）。
         */
        const autoReadOn = (): boolean => {
          autoReadRev();
          const routeSid = currentSessionID(api);
          const fromProps = props.session_id;
          const sid = routeSid || fromProps || "";
          // 低噪诊断：sid 变化才打一条，实测「切会话是否重算、两源各是什么」
          if (sid !== lastIndicatorSid) {
            lastIndicatorSid = sid;
            log.info(`indicator session=${sid || "absent"} route=${routeSid || "-"} props=${fromProps || "-"}`);
          }
          // 触点①（指示读）：本进程**首见**该会话 → 清该会话 auto-tts 目录（从关开始）；
          // 再见不动（保住本窗口已激活的开关；空/非法 sid 不入集合不重置）
          if (resetAutoTtsSessionOnce(touchedSessions, sid)) {
            log.info(`lazy reset auto-tts session=${sid} firstTouch=indicator`);
          }
          return readAutoTts(sid);
        };
        /** 当前分段（响应式：随 meter 三态 / 真实电平 / spinner 帧索引 / 注入·输入开关 / 自动朗读开关重算；定宽口径见 `slot.ts`（恒 18 列）；`mode` 字段不参与渲染，仅为 `SlotState` 签名保留）。 */
        const segments = (): SlotSegment[] =>
          formatSlotSegments(phrases, {
            mode: mode(),
            meter: { phase: meterPhase(), level: micLevel(), frame: spinFrame() },
            injectOn: injectOn(),
            inputOn: inputOn(),
            autoReadOn: autoReadOn(),
          });
        /** 分段角色 → theme 颜色（颜色只在渲染层选定；模式文字段已删，模式仅由整组 `keyActive`/`keyInactive` 表达）。 */
        const colorOf = (role: SlotColorRole): (typeof theme)["text"] => {
          switch (role) {
            case "mic":
              // `🎙 ` 段：恒为中性 accent（2026-10-21 第十一批恢复常驻；第十三批起彻底静态——
              // emoji 不吃终端 fg 颜色，变色动画无效，动画全部交给 meter 列的字形）
              return theme.accent;
            case "meter":
              // 盲文音量列：**静态取色**（在听=accent 亮、连接中/关=textMuted 暗），不做变色动画——
              // 盲文是单色字形、可正常着色，但**状态差异只靠字形**（空白/spinner/电平档），颜色仅区分「是否在听」
              return meterPhase() === "listening" ? theme.accent : theme.textMuted;
            case "keyActive":
              return theme[MODE_THEME_KEY[mode()]];
            case "autoReadActive":
              // 自动朗读开启：末端 `🔊 F10` 段用激活色（与「麦克风开」同档的 success），独立于模式开关态
              return theme.success;
            case "keyInactive":
            case "autoReadInactive":
            case "separator":
            default:
              return theme.textMuted;
          }
        };
        /**
         * 第 i 段的**响应式取值**：内联调用 `segments()` 返回一个**具体分段值**（文本 + 配色角色）。
          * 依赖信号（`asrReady/micLevel/spinFrame/injectOn/inputOn/mode`），故在渲染表达式中内联调用即保持响应式。
         */
        const seg = (i: number): SlotSegment => segments()[i] ?? { text: "", role: "separator" };
        // 静态结构 + 响应式内容：固定 6 个 `<text>`（顺序同 `formatSlotSegments`：`🎙 ` 静态段/meter 盲文音量列/↧F8 组/分隔/⤉F9 组/🔊F10；
        // 「●/○/⏳ 状态字形」段已按 2026-10-21 用户指令改造为「图标贴键成组」，`🎙` 段同日第十一批恢复；
        // 第十三批删掉「🎙 与 ⏳ 共用一格 + emoji 帧轮播」，改为 `🎙 ` 恒静态 + 其后 1 列盲文音量列），
        // 不再用 `<For>` 逐段重建，避免分段数组变化时节点被销毁/重建造成的闪烁。
        // **必须包进单个内层 `<box gap={0}>`**（防回退，勿再改回 Fragment）：宿主 `right` 槽位外层是
        // `<box flexDirection="row" gap={1} alignItems="center">`（opencode 源码 `packages/tui/src/component/prompt/index.tsx`），
        // 对**每个直接子项**接缝 +1 格。返回 Fragment 会让 6 个 `<text>` 摊平成 6 个子项各吃一份 gap；
        // 而 `↧F8`/`/`/`⤉F9` 三段自带空格为 0（`src/voice/slot.ts` 分段数组 + `SLOT_KEY_SEPARATOR`），
        // 于是连续两个 gap 叠在接缝上 → 视觉成 `↧F8 / ⤉F9`（即 2026-10-20 修掉的错位根因）。
        // 包成 1 个子项后：外层 gap 只加在整块前后，内部 gap 显式归零 → 各段紧拼，渲染逐字等于
        // `formatSlotIndicator()` 的格式串（`"🎙  ↧F8/⤉F9 🔊 F10"`，分段内置空格原样保留）。
        // **props 一律内联求值为具体值**：`fg` 传 `colorOf(...)` 得到的 `RGBA`、children 传字符串；
        // 内层 box 的 `flexDirection`/`gap`/`alignItems` 是静态字符串/数字，直接写即可。
        // 切勿把访问器函数（`() => color`）当 prop 值传入——Solid 会包成 `Cell`，原生 `fg` setter
        // 只接受 `ArrayBufferView`（RGBA），收到 `Cell` 即抛 `ERR_INVALID_ARG_TYPE`（启动崩溃根因）。
        return (
          <box flexDirection="row" gap={0} alignItems="center">
            <text fg={colorOf(seg(0).role)}>{seg(0).text}</text>
            <text fg={colorOf(seg(1).role)}>{seg(1).text}</text>
            <text fg={colorOf(seg(2).role)}>{seg(2).text}</text>
            <text fg={colorOf(seg(3).role)}>{seg(3).text}</text>
            <text fg={colorOf(seg(4).role)}>{seg(4).text}</text>
            <text fg={colorOf(seg(5).role)}>{seg(5).text}</text>
          </box>
        );
      },
    },
  });

  // 热键：F8=语音输入开关，F9=语音注入开关（均为点按，无冲突；键值单源在 slot.ts 的 INJECT_KEY/INPUT_KEY）。
  // 命令/绑定提为局部数组：注册完成后诊断日志要打印二者数量（不硬编码）。
  const commands = [
    {
      name: CMD_MODE_A,
      title: format(phrases.command.injectTitle, { key: INJECT_KEY_LABEL }),
      desc: phrases.command.injectDesc,
      category: "Voice",
      run() {
        // 诊断埋点（F9）：按键事件确实到达命令 run（证明绑定生效；随后才有 toggle/startRuntime 埋点）
        log.info(`mode command run: cmd=${CMD_MODE_A} key=${INJECT_KEY_LABEL}`);
        void toggleMode("inject");
      },
    },
    {
      name: CMD_MODE_B,
      title: format(phrases.command.inputTitle, { key: INPUT_KEY_LABEL }),
      desc: phrases.command.inputDesc,
      category: "Voice",
      run() {
        // 诊断埋点（F8）：按键事件确实到达命令 run（证明绑定生效；随后才有 toggle/startRuntime 埋点）
        log.info(`mode command run: cmd=${CMD_MODE_B} key=${INPUT_KEY_LABEL}`);
        void toggleMode("input");
      },
    },
    {
      name: CMD_AUTO_TTS,
      title: format(phrases.command.autoTtsTitle, { key: AUTO_READ_KEY_LABEL }),
      desc: phrases.command.autoTtsDesc,
      category: "Voice",
      run() {
        // 诊断埋点②：按键事件确实到达命令 run（证明 F10 绑定生效；随后才有 toggle/write 埋点）
        log.info(`f10 command run: cmd=${CMD_AUTO_TTS}`);
        toggleAutoRead();
      },
    },
  ];
  const bindings = [
    { key: INJECT_KEY, cmd: CMD_MODE_A },
    { key: INPUT_KEY, cmd: CMD_MODE_B },
    { key: AUTO_READ_KEY, cmd: CMD_AUTO_TTS },
  ];
  api.keymap.registerLayer({
    priority: 1000,
    commands,
    bindings,
  });
  // 诊断埋点①：热键层注册完成（数量 + F10 命令名，证明本次 init 真的注册过自动朗读热键）
  log.info(
    `keymap layer registered: commands=${commands.length} bindings=${bindings.length} autoTtsCmd=${CMD_AUTO_TTS}`,
  );
};

const plugin: TuiPluginModule & { id: string } = {
  id: PLUGIN_ID,
  tui,
};

export default plugin;
