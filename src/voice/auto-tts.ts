/**
 * 自动朗读（auto_tts）的**每会话目录共享状态**读写（对齐先例 `plugins-cache/file-tool/<sessionID>/files`）。
 *
 * 为什么用文件而不是内存：开关由 **TUI 进程的 F10 热键**写入，而「助手消息完成时是否朗读」由
 * **另一个进程**（server 插件）读取——两个进程需要一个共享落点（模型/CLI 不能切换，见 README 热键表）。
 *
 * **存储布局（2026-10-20，替代旧的单文件 JSON map）**：`dataDir` 注入/默认的是**会话数据根**
 * `~/.opencode/plugins-cache/opencode-emotions`，内部再拼 sessionID 子目录：
 * - `<root>/<sessionID>/auto-tts`：内容为极简单值 **`on` / `off`**（一目录一会话，无需 map；缺文件=关）；
 * - `<root>/<sessionID>/auto-tts-seen`：该会话的已朗读消息 id（去重本来就是按会话的消息）；
 * - `<root>/<sessionID>/interrupt-req`：**会话级中断请求水位**（内容=毫秒时间戳，2026-10-22 新增）——
 *   写方=TUI 进程（F10 中断 / F8·F9 barge-in），读方=server 侧 auto-read（每个派发单元前同步读一次）。
 *   为什么要有它：`stopPlayback({sessionID})` 按 PID 杀，**单元间隙无进程可杀**（杀空）、worker 死后
 *   非 follow 路径又会重新 spawn（杀后重生），两种都拦不住 ⇒ 中断意图必须**跨进程落到文件**由朗读侧自查。
 *   语义=**时间戳水位**：所有「开始时间 < 请求时间」的在途消息都停，之后的新消息不受影响（开关未变、后续照读）。
 *   该文件在**会话目录内**，`resetAutoTtsSession()` 删目录时一并清掉，**不进** `AUTO_TTS_RESET_KEEP_NAMES`。
 *
 * **留在 base 根、不进会话目录**（本模块只提供根路径，不触碰其语义）：
 * - `tts-playback`（播放 PID，见 `playback-state.ts`）：播放进程跨会话打断共用、瞬态自清——
 *   打断方只需按 PID 停，不关心会话归属；挪动会牵动 CLI/tool 的 spawn 链，无收益不动。
 * - `tts/`（自动朗读派生 CLI 的临时正文目录，见 `auto-read.ts`）：同上按进程共用、播完即删。
 *
 * 写入为**原子写**（临时文件 + rename）；读取失败/内容非法一律**按关降级**，绝不影响插件。
 *
 * 重启语义（**2026-10-21 演进：每会话首见懒重置**，推翻旧「TUI init 清整个 base 目录」）：
 * 现由 TUI 进程在**首次见到某会话**时（指示灯 `autoReadOn` 求值 / F10 `toggleAutoRead` 入口两触点）
 * 调 `resetAutoTtsSessionOnce()` 只清**该会话目录**，记入进程内 touchedSessions 集合（只增不减）。
 * 语义：**本 TUI 进程首见某会话 → 该会话从关开始**（重启 = 各自会话首见时重置）；后开窗口只重置
 * 它自己首见的会话，**不再误清其它窗口已激活的会话**。
 * 为什么作废旧取舍（日志实锤）：用户在 A 窗 F10 写 on（14:16:29）→ 开 B 窗触发 init 全清把 A 的
 * auto-tts 删掉 → 回 A 窗灯读到关（文件真没了）、F10 再按读 off 写 on（14:17:09）——「按了没反应」。
 * `resetAutoTtsState()`（全量清）**保留但生产不再调用**：测试/人工维护用。
 */

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** 每会话目录内「开关」文件名。 */
export const AUTO_TTS_FILE_NAME = "auto-tts";
/** 每会话目录内「已朗读消息 id」文件名（去重，防插件重启/重放重复朗读）。 */
export const AUTO_TTS_SEEN_FILE_NAME = "auto-tts-seen";
/**
 * 每会话目录内「中断请求水位」文件名（内容=毫秒时间戳单值；缺文件/非法=无请求）。
 * 写方=TUI 进程（F10 中断、F8/F9 barge-in），读方=server 侧 auto-read（派发单元前同步读）。
 */
export const INTERRUPT_REQ_FILE_NAME = "interrupt-req";
/** 会话数据根相对**家目录**的路径段（对齐先例 `plugins-cache/file-tool`）。 */
export const AUTO_TTS_DIR_SEGMENTS = [".opencode", "plugins-cache", "opencode-emotions"] as const;
/** 已朗读消息 id 的保留上限（每会话滚动覆盖）。 */
export const AUTO_TTS_SEEN_LIMIT = 50;
/** 开关文件内容：开。 */
export const AUTO_TTS_ON_VALUE = "on";
/** 开关文件内容：关。 */
export const AUTO_TTS_OFF_VALUE = "off";
/**
 * F10 切换的**键重复抑制窗口**（毫秒，尾沿静默）：距上一次按键事件不足本窗口的新事件一律吞掉，
 * 且每次事件都刷新窗口起点。取 700ms 是因为 Windows 键盘「重复延迟」默认约 500ms、重复速率约 30 次/秒——
 * 按住 F10 会连发按键事件（opencode spike 已实证「长按会键重复」），若逐事件切换，一次按住即可产生
 * 偶数次翻转，净效果=关（状态文件空、指示灯不亮，即实测「按了状态不变」根因）。
 * 误触快速连按（<700ms 间隔）同样只算一次；有意连续切换需间隔 ≥700ms。
 */
export const AUTO_TTS_TOGGLE_QUIET_MS = 700;
/** 播放状态文件名（与 `playback-state.ts` 共用；该文件留 base 根、跨会话打断共用）。 */
export const PLAYBACK_FILE_NAME = "tts-playback";
/** 自动朗读派生 CLI 的临时正文目录名（留 base 根，`auto-read.ts` 消费）。 */
export const TTS_TMP_DIR_NAME = "tts";
/**
 * base 根下 reset 时**保留**的条目名（其余一律清掉）：
 * - `tts-playback`：播放 PID 瞬态文件（定义见 `playback-state.ts`）；
 * - `tts`：自动朗读临时正文目录（见文件头「留在 base 根」说明）。
 */
export const AUTO_TTS_RESET_KEEP_NAMES: readonly string[] = [PLAYBACK_FILE_NAME, TTS_TMP_DIR_NAME];
/** sessionID 合法字符（防路径穿越：只允许 opencode 会话 id 形态的 `[A-Za-z0-9._-]`）。 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/** 路径解析选项。 */
export interface AutoTtsOptions {
  /** **会话数据根**注入（测试隔离用）；缺省 `~/.opencode/plugins-cache/opencode-emotions`（内部再拼 sessionID 子目录）。 */
  dataDir?: string;
}

/**
 * 校验 sessionID 可安全用作目录名（非空、仅 `[A-Za-z0-9._-]`，防路径穿越）。
 * @param sessionID 会话 id
 * @returns 是否合法
 */
function isValidSessionID(sessionID: unknown): sessionID is string {
  return typeof sessionID === "string" && sessionID.length > 0 && SESSION_ID_PATTERN.test(sessionID);
}

/**
 * 解析会话数据根：`dataDir` 注入 > `~/.opencode/plugins-cache/opencode-emotions`（PATH 拼家目录）。
 * @param options 路径选项
 * @returns 会话数据根绝对路径
 */
function dataDir(options: AutoTtsOptions = {}): string {
  if (typeof options.dataDir === "string" && options.dataDir.length > 0) return options.dataDir;
  return join(homedir(), ...AUTO_TTS_DIR_SEGMENTS);
}

/**
 * 会话数据根绝对路径（`~/.opencode/plugins-cache/opencode-emotions`；`tts-playback`/`tts/` 留此根）。
 * @param options 路径选项
 * @returns 会话数据根
 */
export function autoTtsDataDir(options: AutoTtsOptions = {}): string {
  return dataDir(options);
}

/**
 * 指定会话的数据目录（`<root>/<sessionID>`）。
 * @param sessionID 会话 id（非法时返回空串，由调用方降级）
 * @param options 路径选项
 * @returns 会话目录绝对路径；sessionID 非法时为空串
 */
export function autoTtsSessionDir(sessionID: string, options: AutoTtsOptions = {}): string {
  if (!isValidSessionID(sessionID)) return "";
  return join(dataDir(options), sessionID);
}

/**
 * 指定会话的开关文件绝对路径（`<root>/<sessionID>/auto-tts`）。
 * @param sessionID 会话 id
 * @param options 路径选项
 * @returns 开关文件路径；sessionID 非法时为空串
 */
export function autoTtsStatePath(sessionID: string, options: AutoTtsOptions = {}): string {
  const dir = autoTtsSessionDir(sessionID, options);
  return dir ? join(dir, AUTO_TTS_FILE_NAME) : "";
}

/**
 * 指定会话的已朗读记录文件绝对路径（`<root>/<sessionID>/auto-tts-seen`）。
 * @param sessionID 会话 id
 * @param options 路径选项
 * @returns 去重文件路径；sessionID 非法时为空串
 */
export function autoTtsSeenPath(sessionID: string, options: AutoTtsOptions = {}): string {
  const dir = autoTtsSessionDir(sessionID, options);
  return dir ? join(dir, AUTO_TTS_SEEN_FILE_NAME) : "";
}

/**
 * 指定会话的**中断请求水位**文件绝对路径（`<root>/<sessionID>/interrupt-req`）。
 * @param sessionID 会话 id
 * @param options 路径选项
 * @returns 中断请求文件路径；sessionID 非法时为空串
 */
export function autoTtsInterruptPath(sessionID: string, options: AutoTtsOptions = {}): string {
  const dir = autoTtsSessionDir(sessionID, options);
  return dir ? join(dir, INTERRUPT_REQ_FILE_NAME) : "";
}

/**
 * 读取**指定会话**的自动朗读开关（文件内容 === `on` 为开；缺文件/读取失败/非法内容一律关，绝不抛错）。
 * @param sessionID 会话 id
 * @param options 路径选项
 * @returns 该会话是否开启自动朗读
 */
export function readAutoTts(sessionID: string, options: AutoTtsOptions = {}): boolean {
  const path = autoTtsStatePath(sessionID, options);
  if (!path) return false;
  try {
    return readFileSync(path, "utf8").trim() === AUTO_TTS_ON_VALUE;
  } catch {
    return false;
  }
}

/**
 * 原子写入文件（先写临时文件再 rename；失败清理临时文件）。
 * @param path 目标路径
 * @param content 文本内容
 * @throws Error 写入失败（无权限等）
 */
export function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, path);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // 清理失败忽略（不掩盖原始错误）
    }
    throw err;
  }
}

/**
 * 写入**指定会话**的自动朗读开关（内容 `on`/`off` 单值，原子写；会话目录自动创建）。
 * @param sessionID 会话 id
 * @param enabled 是否开启（true=写 `on`；false=写 `off`）
 * @param options 路径选项
 * @returns 是否写入成功（sessionID 非法或写入失败 → false，由调用方提示）
 */
export function writeAutoTts(sessionID: string, enabled: boolean, options: AutoTtsOptions = {}): boolean {
  const path = autoTtsStatePath(sessionID, options);
  if (!path) return false;
  try {
    writeFileAtomic(path, enabled ? AUTO_TTS_ON_VALUE : AUTO_TTS_OFF_VALUE);
    return true;
  } catch {
    return false;
  }
}

/**
 * 读取**指定会话**已朗读消息 id 集合（按行拆分；缺文件/读取失败 → 空集）。
 * @param sessionID 会话 id
 * @param options 路径选项
 * @returns 消息 id 集合（sessionID 非法 → 空集）
 */
export function readAutoTtsSeen(sessionID: string, options: AutoTtsOptions = {}): Set<string> {
  const path = autoTtsSeenPath(sessionID, options);
  if (!path) return new Set();
  try {
    const raw = readFileSync(path, "utf8");
    return new Set(raw.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0));
  } catch {
    return new Set();
  }
}

/**
 * 持久化**指定会话**已朗读消息 id 集合（保留最后 {@link AUTO_TTS_SEEN_LIMIT} 条；失败静默）。
 * @param sessionID 会话 id
 * @param seen 消息 id 集合（按插入序）
 * @param options 路径选项
 */
export function writeAutoTtsSeen(sessionID: string, seen: ReadonlySet<string>, options: AutoTtsOptions = {}): void {
  const path = autoTtsSeenPath(sessionID, options);
  if (!path) return;
  const ids = [...seen].slice(-AUTO_TTS_SEEN_LIMIT);
  try {
    writeFileAtomic(path, ids.join("\n"));
  } catch {
    // 记录失败不影响朗读
  }
}

/**
 * 写入**指定会话**的中断请求水位（内容=毫秒时间戳单值，原子写；会话目录自动创建）。
 *
 * 调用方=TUI 进程的**中断出口**（F10 双态中断、F8/F9 barge-in）：与 `stopPlayback` 并列、
 * **无论是否杀中都要写**——「单元间隙无进程可杀」与「worker 死后重新 spawn」两类缺口只能靠
 * 朗读侧自查水位拦下（消费方见 `auto-read.ts`）。语义=**会话级时间戳水位**：此后所有
 * 「消息开始时间 &lt; 本时间戳」的在途消息都应停；晚于它的新消息不受影响（F10 开关状态未变）。
 * @param sessionID 会话 id（空/非法 → 不写、返回 false，保持「无主」语义）
 * @param nowMs 水位时间戳（毫秒；缺省取 `Date.now()`，非有限/非正数一律回退当前时刻）
 * @param options 路径选项
 * @returns 是否写入成功（写失败返回 false，由调用方记日志，绝不抛错影响热键）
 */
export function writeInterruptRequest(sessionID: string, nowMs?: number, options: AutoTtsOptions = {}): boolean {
  const path = autoTtsInterruptPath(sessionID, options);
  if (!path) return false;
  const stamp = typeof nowMs === "number" && Number.isFinite(nowMs) && nowMs > 0 ? Math.trunc(nowMs) : Date.now();
  try {
    writeFileAtomic(path, String(stamp));
    return true;
  } catch {
    // 写失败降级为「无中断请求」（朗读继续，绝不影响热键本身）
    return false;
  }
}

/**
 * 读取**指定会话**的中断请求水位时间戳（毫秒）。
 *
 * 无文件 / 读失败 / 内容非法（非有限数、非正数）一律返回 **0**（= 无中断请求，放行朗读），
 * 绝不抛错——调用方在派发单元的关键路径上同步调用，异常必须就地吞掉。
 * @param sessionID 会话 id
 * @param options 路径选项
 * @returns 请求时间戳（毫秒）；无有效请求时为 0
 */
export function readInterruptRequest(sessionID: string, options: AutoTtsOptions = {}): number {
  const path = autoTtsInterruptPath(sessionID, options);
  if (!path) return 0;
  try {
    const raw = readFileSync(path, "utf8").trim();
    const stamp = Number(raw);
    return Number.isFinite(stamp) && stamp > 0 ? stamp : 0;
  } catch {
    return 0;
  }
}

/**
 * 判断本次 F10 按键事件是否应被接受（键重复/快速连按抑制，纯函数便于单测）。
 *
 * 尾沿静默语义：`nowMs - lastEventMs >= AUTO_TTS_TOGGLE_QUIET_MS` 才接受；调用方对**每个**事件
 * （无论接受与否）都要把 `lastEventMs` 刷新为当前时刻——这样按住期间连发的重复事件会不断后移窗口，
 * 整次按住只产生一次有效切换；松开静默 ≥700ms 后的下一次点按重新生效。
 * @param nowMs 当前时间戳（毫秒）
 * @param lastEventMs 上一次按键事件的时间戳（毫秒；0/初始值表示从未发生）
 * @returns 是否接受本次切换
 */
export function shouldAcceptAutoTtsToggle(nowMs: number, lastEventMs: number): boolean {
  if (!Number.isFinite(nowMs) || nowMs < 0) return false;
  return nowMs - lastEventMs >= AUTO_TTS_TOGGLE_QUIET_MS;
}

/**
 * 重置**单个会话**的自动朗读状态：删除该会话目录 `<root>/<sessionID>`（开关 `auto-tts`、去重
 * `auto-tts-seen` 与**中断请求水位** `interrupt-req` 同目录一起清——后者在会话目录内，
 * **不需要**也**不应该**进 {@link AUTO_TTS_RESET_KEEP_NAMES}，那个清单只管 base 根的
 * `tts-playback`/`tts`），**只动这一个会话**——其它会话目录与 base 根保留项
 * （{@link AUTO_TTS_RESET_KEEP_NAMES}：`tts-playback`/`tts`）一概不碰。
 *
 * 每会话首见懒重置的原语（2026-10-21 取代 init 全清，见文件头「重启语义」）。
 * @param sessionID 会话 id（空/非法 → 不动任何文件）
 * @param options 路径选项
 * @returns 是否删除了该会话目录（幂等：目录本就不存在返回 false，不抛错）
 */
export function resetAutoTtsSession(sessionID: string, options: AutoTtsOptions = {}): boolean {
  const dir = autoTtsSessionDir(sessionID, options);
  if (!dir || !existsSync(dir)) return false;
  try {
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    // 清理失败降级为 false（重置尽力而为，绝不影响 TUI 读/切）
    return false;
  }
}

/**
 * **每会话首见懒重置**（TUI 两触点共用：指示灯 `autoReadOn` 求值、F10 `toggleAutoRead` 入口）：
 * 调用方持有的进程内集合 `touched`（只增不减）里没有该会话 → 记入并清**该会话目录**；
 * 已见过 → 什么都不做（返回 false）。
 *
 * 语义：**本 TUI 进程首次看到某会话 → 该会话从关开始**（重启 = 各自会话首见时重置）；
 * 后开窗口只影响它自己首见的会话，**不再误清其它窗口已激活的会话**（推翻旧「init 全清」取舍，
 * 引用文件头日志证据）。空/非法 sid 不入集合、不重置。
 * @param touched 调用方持有的已触碰会话集合（TUI 模块级 Set，进程内共享）
 * @param sessionID 会话 id
 * @param options 路径选项
 * @returns 本次是否执行了重置（首见删=true；再见/非法=false）
 */
export function resetAutoTtsSessionOnce(
  touched: Set<string>,
  sessionID: string,
  options: AutoTtsOptions = {},
): boolean {
  if (!isValidSessionID(sessionID) || touched.has(sessionID)) return false;
  touched.add(sessionID);
  return resetAutoTtsSession(sessionID, options);
}

/**
 * 重置自动朗读状态（**清整个会话数据根**）：删除所有会话子目录（开关+去重一起清）与旧版平铺遗留
 * 文件（base 根下的 `auto-tts`/`auto-tts-seen` JSON map），保留 {@link AUTO_TTS_RESET_KEEP_NAMES}
 * （`tts-playback` 瞬态 PID 文件、`tts/` 临时正文目录）。
 *
 * **生产已不再调用（2026-10-21 起）**——TUI init 全清在多窗口混音场景会误清先开窗口已激活的会话
 * （日志实锤，见文件头「重启语义」），已由 `resetAutoTtsSessionOnce()` 每会话首见懒重置取代。
 * 本函数**保留语义不变**，供测试与人工全量清（如维护脚本/排障手动重置）。
 * @param options 路径选项
 * @returns 是否删除了至少一个条目（幂等：目录本就干净时返回 false，不抛错）
 */
export function resetAutoTtsState(options: AutoTtsOptions = {}): boolean {
  const root = dataDir(options);
  if (!existsSync(root)) return false;
  let removed = false;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return false;
  }
  for (const name of entries) {
    if (AUTO_TTS_RESET_KEEP_NAMES.includes(name)) continue;
    try {
      rmSync(join(root, name), { recursive: true, force: true });
      removed = true;
    } catch {
      // 清理失败忽略（重置是尽力而为，不影响 TUI 启动）
    }
  }
  return removed;
}
