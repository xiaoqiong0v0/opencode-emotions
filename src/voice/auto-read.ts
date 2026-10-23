/**
 * 自动朗读触发器：`auto_tts` 开启时，把助手回复的**可见正文**（只取 `text` 型 part，排除
 * `reasoning`/thinking）**边生成边送 TTS**。
 *
 * 事件与取文本的源码依据（opencode v1.18.25）：
 * - `message.updated`：助手消息**创建时**即发布（`session/prompt.ts:1201` `sessions.updateMessage(msg)`，
 *   带 `info.role`）——晚于它的 part/delta 事件都能查到角色；完成时再次发布（`processor.ts:595-596` 置
 *   `time.completed`），只带 `info`（不含 parts）。
 * - **文本流式增量走的是 `message.part.delta`，不是 `message.part.updated`**（`processor.ts:499-509`
 *   `text-delta` → `session.updatePartDelta` → 事件 `message.part.delta`，payload 只有
 *   `{sessionID, messageID, partID, field:"text", delta}`，**无 part、无 role、无类型**）；
 *   `message.part.updated` 只在 **text-start**（`text:""`，`processor.ts:496`）与 **text-end**（全量快照，
 *   `processor.ts:530`）各发一次。故增量朗读必须消费 `message.part.delta`，用 part 起始快照学习
 *   `partID→type`（reasoning 也走 delta，payload 无类型，必须靠这个表过滤）。
 * - **快照兜底**：`part.text` 全量快照 + 已送偏移取增量（比 `delta` 更抗丢失/乱序）；快照始终不短于
 *   已送偏移时以快照为准。
 * - 角色过滤：part/delta 都不带 role → 先用 `message.updated` 的 `info.role` 建立 `messageID→role` 表；
 *   **未知时惰性补取一次**（deps `fetchMessageRole`，并发去重，经 client 取 `info.role`），只对
 *   `assistant` 读（用户消息绝不读）。被角色门挡过的 part 置 `tainted`：其后续 delta 全丢，
 *   由 text-end 快照整段重发（或完成回退）兜底——保证「entry.text 恒为真实文本前缀」，
 *   快照偏移推算无重复、无丢失。摘要消息（`info.summary===true`）不读。
 * - **子会话硬跳过**（2026-10-20）：按 sessionID **单飞取一次** `client.session.get`（deps
 *   `fetchIsChildSession`，并发去重；字段 `parentID`，SDK 类型 `Session.parentID`），缓存
 *   sessionID→是否子会话；是子会话 → **无论 map 里开没开都不读**（early return，part/delta/回退/drain 全覆盖）。
 *   未知期间按「子会话」处理（fail-closed，防子会话首条消息漏读）。
 *
 * **分会话开关**：`readAutoTts(sessionID, pathOptions)` 读 `<root>/<sessionID>/auto-tts`（内容 `on`/`off`）；缺省=关。
 *
 * 朗读方式（**阈值 + 增量转发 + 串行队列 + 凑批合并 + 句对齐切分 + sapi follow 常驻 worker**，见 `docs/设计-语音输入注入.md` §15）：
 * - 增量文本用 `createStreamChunker()`（`tts/stream.ts`）按同一口径处理：**缓冲到 ≥ `tts.streamMinChars`**
 *   （默认 5）才**首次**开始派生，**此后随到随发**。
 * - **凑批合并（2026-10-21，消「两字一顿」）**：`drain` 每轮 shift 出首块后，把**此刻已在队列**的块
 *   继续拼上（单次合并 ≤ {@link DRAIN_MERGE_MAX_CHARS} 字，超出留队列下次读）。
 * - **句对齐切分（2026-10-21 真修第二步）**：合并结果经 {@link splitDrainUnits}（内部 `splitSentences()`）
 *   切成**按句对齐**的朗读单元——完整句按 ≤2000 字贪婪连读、**未完结尾段 carry 到下一批**（块边界落在句尾，
 *   非 sapi provider 的段间停顿落到句尾）；单句超上限才句内硬切（唯一句中断点）。
 * - **sapi follow 常驻 worker（2026-10-21）**：provider 能力位 `followSupport`（deps 注入，生产=
 *   `resolveFollowSupport()`）为真时，消息首个朗读单元派生**一个** `speak --follow` worker（stdin 保持打开），
 *   后续单元 `worker.stdin.write(line+"\n")` **不再每块 spawn/await 退出**；finalize 时关 stdin 并等 worker
 *   退出（冲刷尾音）。worker 记入 `activeChildren`（interrupt 可杀）；中途死亡 → 写失败 → 该消息停读
 *   （C 水位同语义：不再补读），不影响下一条。非 follow provider → 仍每单元 spawn CLI（A 的句块粒度）。
 * - 增量未覆盖到的消息（未观察到 part 更新 / 插件启动晚）在**完成时回退**为「整段读」。
 * - `interrupt(sessionID?)`（barge-in **水位**，2026-10-21 改；同日第四批**按会话收窄**）：打断（用户发消息 /
 *   语音输入）时清空目标范围的队列、杀目标范围的朗读子进程（含 follow worker），并对**目标范围的在途消息**
 *   置 `interrupted` 位（消息级集合，覆盖 `streams` 有状态的 + `diag` 已过门但尚无状态的）；
 *   置位后该消息的 delta/part 新块**一律丢弃**、完成时**不补读**（直接 `seen.add`，防「完成回退整段读」
 *   把整条又念一遍）；**新 messageID 不受影响**（下一条消息正常读）。
 *   **目标范围**：带 `sessionID` → 只处理**属于该会话**的消息（队列/水位/子进程三项均按会话过滤，
 *   修「A 会话发消息腰斩 B 会话朗读」）；**无参或空白** → 全清（dispose/进程退出等清场路径原语义）。
 * - **会话级中断请求水位（2026-10-22，补「F10 中断后剩余文本继续播」）**：TUI 进程在中断出口
 *   （F10 双态中断 / F8·F9 barge-in）原子写 `<root>/<sessionID>/interrupt-req`（内容=请求时刻），
 *   本模块在**每个派发单元**前同步读一次（`applyInterruptRequest`：`deliverUnit` 入口=follow 写前=
 *   非 follow spawn 前，外加 `runFallback` 整段读前）——请求时刻**严格大于**该消息开始时间
 *   （`messageStarts` 记账：服务端 `info.time.created` 优先，否则插件首次观察时刻）⇒ 命中，
 *   走与 `interrupt()` **同一套**打断执行体 `stopInFlight(sessionID, 请求时刻)`。
 *   为什么需要它：`stopPlayback` 按 PID 杀，**单元间隙没有进程可杀**（杀空）、worker 死后非 follow 路径
 *   又会**重新 spawn**（杀后重生），两种都只有朗读侧自查才拦得住。
 *   语义=**会话级时间戳水位**：所有「开始时间 &lt; 请求时刻」的在途消息都停，晚于它的**新消息不受影响**
 *   （F10 开关状态没变，后续回复照读）；读失败/无记账一律**放行**（宁可漏拦不可误杀）。
 * - 空文本（纯空白块/正文/单元）**直接跳过**（不写临时文件、不 spawn、不报错；CLI `speak` 入口同口径）。
 * - `streamMinChars` 默认从 `emotions.jsonc` 的 `tts.streamMinChars` 读取（可用 deps 注入以便单测）。
 *
 * 诊断（info 级、**每消息一条汇总**防刷屏，长期开）：`自动朗读汇总：message=… session=…
 * path=stream|fallback|skip skipReason=… parts=… deltas=… roleMiss=… skips=… chunks=… chars=…`（见 `logSummary`）。
 *
 * 去重：内存 + 持久化消息 id（每会话 `<root>/<sessionID>/auto-tts-seen`），防插件重启/事件重放重复朗读。
 * 安全：正文经**临时文件** + argv 数组传给 CLI（不拼 shell 字符串、不落命令行超长文本）。
 */

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Logger } from "@xiaoqiong0v0/opencode-plugin-logger";

import {
  autoTtsDataDir,
  readAutoTts,
  readAutoTtsSeen,
  readInterruptRequest,
  TTS_TMP_DIR_NAME,
  writeAutoTtsSeen,
  type AutoTtsOptions,
} from "./auto-tts.js";
import { loadVoiceConfig } from "./config.js";
import { PLAYBACK_SESSION_ENV } from "./playback-state.js";
import { splitSentenceSpans } from "./tts/sentences.js";
import {
  normalizePrefetchDepth,
  PrefetchUnit,
  PREFETCH_DEPTH_DEFAULT,
} from "./tts/prefetch.js";
import { createStreamChunker, DEFAULT_STREAM_MIN_CHARS, type StreamChunker } from "./tts/stream.js";

/** 消息最小结构（只取判定所需字段）。 */
export interface MessageLike {
  id?: string;
  role?: string;
  summary?: boolean;
  /** `created`=消息创建时刻（服务端 `Date.now()`，会话级中断水位的比较基准）。 */
  time?: { created?: number; completed?: number };
}

/** part 最小结构（只取判定所需字段）。 */
export interface PartLike {
  /** part id（`message.part.delta` 用它关联类型与增量；真实事件必带）。 */
  id?: string;
  type?: string;
  text?: string;
  ignored?: boolean;
  synthetic?: boolean;
  sessionID?: string;
  messageID?: string;
}

/** `message.updated` 事件的最小结构。 */
interface MessageUpdatedEvent {
  type?: string;
  properties?: { info?: MessageLike; sessionID?: string };
}

/** `message.part.updated` 事件的最小结构。 */
interface MessagePartUpdatedEvent {
  type?: string;
  properties?: { part?: PartLike };
}

/** `message.part.delta` 事件的最小结构（payload 无 part，见文件头源码依据）。 */
interface MessagePartDeltaEvent {
  type?: string;
  properties?: { sessionID?: string; messageID?: string; partID?: string; field?: string; delta?: string };
}

/** 自动朗读器依赖（便于单测注入）。 */
export interface AutoReaderDeps {
  /** 插件日志器。 */
  log: Logger;
  /** CLI 产物路径（`emotions-cli.js`）。 */
  cliPath: string;
  /** 取某条消息的 parts（默认由 server 插件用 client 取；完成回退用）。 */
  fetchParts: (sessionID: string, messageID: string) => Promise<PartLike[]>;
  /**
   * 角色未知时惰性补取一次（server 插件用 client 取 `info.role`）；缺省则未知角色一律交给完成回退。
   * 并发去重由本模块保证（同一 messageID 至多一个在途）。
   */
  fetchMessageRole?: (sessionID: string, messageID: string) => Promise<string | undefined>;
  /**
   * 子会话判定（server 插件用 client 取 `Session.parentID`）；缺省则**不跳过**（测试可不注入）。
   * 并发去重由本模块保证（同一 sessionID 至多一个在途）；结果按 sessionID 永久缓存（进程内）。
   * 字段依据：`@opencode-ai/sdk` `Session.parentID?: string`（`dist/gen/types.gen.d.ts:469`）。
   */
  fetchIsChildSession?: (sessionID: string) => Promise<boolean>;
  /** 状态路径选项（`dataDir` 注入以隔离真实状态目录）。 */
  paths?: AutoTtsOptions;
  /** 配置目录（`emotions.jsonc` 所在目录；测试注入以隔离真实配置目录；缺省按 env/默认目录解析）。 */
  configDir?: string;
  /** 流式最小缓冲阈值（首次朗读前需缓冲的字符数）；缺省从 `emotions.jsonc` 的 `tts.streamMinChars` 读取。 */
  streamMinChars?: number;
  /**
   * 首句合并窗（毫秒，见 {@link FIRST_MERGE_WINDOW_MS}）：只对每条消息**首个派发单元**生效；
   * 缺省 400，0 = 关闭。注入时该值同时作为**自适应上限**（未注入时上限=
   * {@link FIRST_MERGE_WINDOW_MAX_MS}=1200）——测试注入小值即可缩短用例时长。
   */
  firstMergeWindowMs?: number;
  /**
   * provider 是否支持 follow 常驻 worker（`speak --follow`）。生产由 `emotions.ts` 注入
   * `resolveFollowSupport()`（env→config→默认解析链）；缺省 false——测试不触真实配置/ provider，
   * 走按块 spawn 旧路径（确定性）。为 true 时 spawn/写行/收尾全经 `spawnFn` 注入观察。
   */
  followSupport?: boolean;
  /** 派生 CLI 用的 Node 可执行文件（默认 env `VOICE_NODE_BIN` > `"node"`；测试注入以观察 argv/bin）。 */
  spawnBin?: string;
  /** 派生函数（默认 `child_process.spawn`；测试注入假 child 以观察 stderr/退出码）。 */
  spawnFn?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  /** 是否派生真实子进程（测试可置 false，仅记录 argv）。 */
  spawnEnabled?: boolean;
  /**
   * provider 是否支持**只合成不出声**（`speak --pcm-out`，见 `resolvePcmOutputSupport()`）。
   * 缺省 false（测试确定性：不触预取，走原有串行路径）。为 true 且 `prefetchDepth > 0` 时，
   * 自动朗读在播当前单元期间预取**下一单元**（合成到临时文件 + 预热播放进程），交播间隔目标 <200ms。
   */
  prefetchSupport?: boolean;
  /**
   * 预取深度：默认 {@link PREFETCH_DEPTH_DEFAULT}(1)，0 = 关闭，>1 夹到 1（见 `normalizePrefetchDepth`）。
   * 仅 `prefetchSupport=true` 时生效；且 `spawnEnabled=false`（单测假派生）一律不预取。
   */
  prefetchDepth?: number;
  /** 单次预取合成超时（毫秒）；缺省 `PREFETCH_TIMEOUT_MS`（仅测试注入短值）。 */
  prefetchTimeoutMs?: number;
}

/** 自动朗读器句柄。 */
export interface AutoReader {
  /** 处理一条插件事件（同步返回；内部异步派生，可安全 fire-and-forget）。 */
  handleEvent(event: unknown): void;
  /**
   * 打断（barge-in 水位）：清空待读队列、杀掉当前朗读子进程，并对**目标范围的在途消息**置 `interrupted`
   * 位（此后这些消息的增量/入队丢弃、完成不补读；下一条新 messageID 不受影响）。幂等。
   * @param sessionID 只处理**属于该会话**的在途消息（队列/水位/子进程三项都按会话过滤）；
   *   缺省或空白 = **全清**（dispose/进程退出等清场路径保持原「全清」语义）
   */
  interrupt(sessionID?: string): void;
  /**
   * **清场**（插件 `dispose` / 进程退出）：取消**全部会话**的待读队列、预取（kill 合成/预热子进程 +
   * 删缓冲）与朗读子进程。语义等同 `interrupt()` 无参，但作为独立入口，避免与「消息级打断」混淆。
   */
  dispose(): void;
}

/** `messageID→role` 缓存上限（防无界增长）。 */
export const ROLE_CACHE_LIMIT = 200;
/** `partID→type` 登记表上限（防无界增长）。 */
export const PART_META_LIMIT = 500;
/** 每消息诊断计数表上限（防无界增长）。 */
export const DIAG_LIMIT = 200;
/** 进程内缓存的「会话→已朗读 id 集合」上限（LRU 淘汰；去重真源在每会话 `auto-tts-seen` 文件）。 */
export const SEEN_SESSION_CACHE_LIMIT = 50;
/**
 * `message.part.delta` 路径读取 `auto-tts` 开关的内存 TTL（毫秒）。
 * delta 是**高频**事件（逐 token 级），每事件一次磁盘读不划算；`part.updated`/完成回退/`drain`
 * 派生前仍是**实时读**——F10 关闭的「立即停」由后者保证（最多 300ms 后的下一批 delta 才被开关挡掉，
 * 已入队的段由 drain 复查清空）。
 */
export const AUTO_TTS_TOGGLE_CACHE_MS = 300;

/**
 * 派生 CLI 用的 Node 可执行文件环境变量名（与 TUI 运行时子进程共用同一 env）。
 * server 插件进程里 `process.execPath` 是 `opencode.exe`（不是 node），`opencode.exe <cli.js> speak`
 * 会立即失败退出（stdio:"ignore" 时代被静默吞掉 → 「触发了但没声音」根因），故默认改 PATH 上的 `node`。
 */
export const AUTO_READ_NODE_BIN_ENV = "VOICE_NODE_BIN";
/** 派生 CLI 用的默认 Node 可执行文件（PATH 解析）。 */
export const AUTO_READ_DEFAULT_NODE_BIN = "node";
/** 朗读子进程 stderr 收集上限（字符数，防无界增长）。 */
export const AUTO_READ_STDERR_LIMIT = 2048;
/**
 * `drain` 凑批合并上限（字符）：单次处理的合并正文不超过该长度，超出的块留在队列下次读。
 * 取舍：合并消「每块冷启动 PowerShell」的碎块听感；句对齐切分后它同时是**朗读单元的连读上限**
 * （多句连读 ≤ 上限，超出则在句边界断开）。打断不依赖块边界（按 PID 杀进程即时生效），
 * 上限只是防御超长，不是打断粒度约束。
 */
export const DRAIN_MERGE_MAX_CHARS = 2000;
/**
 * **首句合并窗基值（毫秒，2026-10-22 第十三批修法 1；2026-10-23 第十五批改自适应）**：
 * 每条消息的**首个派发单元**就绪时，若消息流仍未结束，等一段时间以合并随后完成的句子
 * （例：61 字被切成 24+37 时，24 字的单元 1 播完还要为 37 字重启一次 CLI/合成/播放器，实测约 1.7s）。
 *
 * 自适应（用户实测：模型吐句间隔可能 >400ms）：实际等待 =
 * `max(基值, 观测到的句间到达间隔)`，夹到 `[{@link FIRST_MERGE_WINDOW_MIN_MS}, 上限]`；
 * 且**下一条可合并文本到达 / 流结束 / 上限到期**三者先到即结算。代价是首音延迟最多 +上限，
 * 收益是省掉一次整条管线重启；设为 0 即关闭（语义=旧行为）。
 */
export const FIRST_MERGE_WINDOW_MS = 400;
/** 首句合并窗下限（0 = 关闭）。 */
export const FIRST_MERGE_WINDOW_MIN_MS = 0;
/**
 * 首句合并窗**上限**（毫秒）：再长首音延迟体感明显。模型吐句间隔实测可达 ~700ms，
 * 上限取 1200 才能覆盖「慢半拍」的下一句，同时给首音延迟封顶。
 */
export const FIRST_MERGE_WINDOW_MAX_MS = 1200;
/**
 * 合并窗的取消轮询间隔（毫秒）：窗口等待期间周期检查「打断水位 / 会话级中断请求 / 开关关闭 /
 * 子会话门」，保证打断**立即生效**（不依赖窗口到期）。`done` 由 `finalize()` 主动唤醒，不靠轮询。
 */
export const FIRST_MERGE_WINDOW_POLL_MS = 50;
/** 消息级打断水位集合上限（LRU 淘汰最旧，防未完成消息无界堆积）。 */
export const INTERRUPTED_LIMIT = 100;
/**
 * `messageID → 开始时间` 记账表上限（LRU 淘汰最旧，防无界增长）。
 * 用途：**会话级中断请求水位**的比较基准（`interrupt-req` 时间戳 > 该消息开始时间 ⇒ 命中）。
 */
export const MESSAGE_START_LIMIT = 200;
/**
 * follow worker stdin 背压等待上限（毫秒）：`write()` 返回 false 时等 `drain` 的最长时间；
 * 超时按已投递处理（行很小，正常不会触发；防御性尊重背压而不无限等）。
 */
export const WORKER_DRAIN_TIMEOUT_MS = 5000;
/**
 * follow worker 退出等待上限（毫秒）：finalize 关 stdin（EOF）后等 worker CLI 退出的最长时间；
 * 超时强杀（worker CLI 内部 `followEnd` 另有 30s 等 PowerShell 的超时，此处是外层兜底）。
 */
export const WORKER_EXIT_TIMEOUT_MS = 30_000;

/** follow worker 句柄（每消息一个；stdin 保持打开直到 finalize/中止/打断）。 */
interface FollowWorker {
  /** 派生的 `speak --follow` CLI 子进程。 */
  child: ChildProcess;
  /** 子进程退出（或 spawn error）后 settle——早退是「后续写失败」的信号。 */
  exited: Promise<void>;
  /** 是否已不可用（退出 / stdin 断）。 */
  dead: boolean;
}

/** `activeChildren` 条目：朗读子进程的归属（`interrupt(sessionID)` 据此只杀本会话的进程）。 */
interface ActiveChild {
  /** 子进程正在朗读的消息 id（日志/排查用）。 */
  messageID: string;
  /** 子进程所属会话 id（= 消息的 sessionID；收窄 kill 的过滤依据）。 */
  sessionID: string;
}

/**
 * 把一段已凑批合并的文本切成「按句对齐」的朗读单元（纯函数，无 IO）。
 *
 * 规则：
 * - `splitSentences()` 切出完整句；**未完结尾段（tail）不进本批**（调用方 carry 到下一批拼接，
 *   使块边界落在句尾——非 sapi provider 的段间停顿因此落到句尾）；
 * - 连续完整句按 ≤ `maxChars` **贪婪连读**成一个单元（多句连读，消碎块×进程冷启动）；
 * - **单句超 `maxChars` 时句内硬切**（唯一允许的句中断点，防御异常超长输入）。
 * @param merged 合并后的文本（carry + 队列块）
 * @param maxChars 单元字符上限（默认 {@link DRAIN_MERGE_MAX_CHARS}）
 * @returns `units`=按序完整句单元（每单元 ≤ maxChars，已 trim 非空）；`carry`=未完结尾段**原文**
 */
export function splitDrainUnits(
  merged: string,
  maxChars: number = DRAIN_MERGE_MAX_CHARS,
): { units: string[]; carry: string } {
  const { units, carry } = splitDrainUnitSpans(merged, maxChars);
  return { units: units.map((unit) => unit.text), carry };
}

/** 一个朗读单元 + 它在合并正文中的**原文消费终点**（供预取提前摘除）。 */
export interface DrainUnitSpan {
  /** 单元文本（完整句拼接，已 trim）。 */
  text: string;
  /** 消费到该单元为止的原文下标（不含）；`merged.slice(0, end)` 即本单元覆盖的原文。 */
  end: number;
}

/**
 * 与 {@link splitDrainUnits} 同一口径，但额外给出每个单元的**原文区间终点**。
 *
 * 预取必须精确知道「从待读队列里摘走哪一段」：句子之间存在被 trim 的空白，
 * 不能简单用 `unit.text.length` 切片（否则会错位/重复）。`end` 落在句末标点之后，
 * `merged.slice(end)` 即剩余文本（含下一句前的空白，后续切句会再 trim）。
 * @param merged 合并后的文本（carry + 队列块）
 * @param maxChars 单元字符上限（默认 {@link DRAIN_MERGE_MAX_CHARS}）
 * @returns `units`=按序单元（文本 + 原文终点）；`carry`=未完结尾段**原文**
 */
export function splitDrainUnitSpans(
  merged: string,
  maxChars: number = DRAIN_MERGE_MAX_CHARS,
): { units: DrainUnitSpan[]; carry: string } {
  const limit = Math.max(1, Math.trunc(maxChars));
  const { spans, tailStart } = splitSentenceSpans(merged);
  const pieces: DrainUnitSpan[] = [];
  for (const span of spans) {
    if (span.text.length <= limit) {
      pieces.push({ text: span.text, end: span.end });
      continue;
    }
    // 唯一的句内硬切：单句超上限（按 trim 后文本切，终点仍可精确映射回原文）
    for (let i = 0; i < span.text.length; i += limit) {
      const piece = span.text.slice(i, i + limit);
      pieces.push({ text: piece, end: span.start + i + piece.length });
    }
  }
  const units: DrainUnitSpan[] = [];
  let current: DrainUnitSpan | null = null;
  for (const piece of pieces) {
    if (!current) {
      current = { text: piece.text, end: piece.end };
      continue;
    }
    if (current.text.length + piece.text.length <= limit) {
      current = { text: current.text + piece.text, end: piece.end };
    } else {
      units.push(current);
      current = { text: piece.text, end: piece.end };
    }
  }
  if (current) units.push(current);
  // 没有完整句时 carry 必须是整段原文（tailStart 为 0）；有完整句时 tailStart 与最后一个 span.end
  // 之间的空白属于剩余文本，故用 tailStart 切分（与 splitSentences 的 tail 完全一致）。
  return { units, carry: merged.slice(tailStart) };
}

/**
 * 归一化首句合并窗（毫秒）：非有限值回退 {@link FIRST_MERGE_WINDOW_MS}，越界夹到
 * [{@link FIRST_MERGE_WINDOW_MIN_MS}, {@link FIRST_MERGE_WINDOW_MAX_MS}]，其余取整。
 * @param ms 注入值（缺省=默认 400）
 * @returns 实际使用的窗口长度（毫秒；0 = 关闭合并窗）
 */
export function normalizeFirstMergeWindow(ms: number | undefined): number {
  if (ms === undefined || !Number.isFinite(ms)) return FIRST_MERGE_WINDOW_MS;
  return Math.min(FIRST_MERGE_WINDOW_MAX_MS, Math.max(FIRST_MERGE_WINDOW_MIN_MS, Math.trunc(ms)));
}

/**
 * 计算**一次**首句合并窗的实际等待时长（自适应，纯函数）。
 *
 * 口径：`clamp(max(基值, 观测到的句间到达间隔), 0, 上限)`；本消息尚无观测（首个单元必然如此）
 * 时按**上限**等——用户实测模型的吐句间隔可能 >400ms，固定 400ms 会把同一句回复拆成两个单元。
 * 等待本身还会被「下一条可合并文本到达 / 流结束」提前结算，故上限不是固定延迟。
 * @param baseMs 基值（`FIRST_MERGE_WINDOW_MS` 或注入值）
 * @param observedGapMs 观测到的句间到达间隔（毫秒）；无观测为 undefined
 * @param capMs 上限（注入值或 {@link FIRST_MERGE_WINDOW_MAX_MS}）
 * @returns 实际等待时长（毫秒；0 = 不等待）
 */
export function adaptiveFirstMergeWindow(
  baseMs: number,
  observedGapMs: number | undefined,
  capMs: number,
): number {
  const cap = Math.max(FIRST_MERGE_WINDOW_MIN_MS, Math.trunc(capMs));
  if (cap === 0) return 0;
  const base = Math.min(cap, Math.max(FIRST_MERGE_WINDOW_MIN_MS, Math.trunc(baseMs)));
  const observed =
    observedGapMs === undefined || !Number.isFinite(observedGapMs)
      ? cap
      : Math.max(base, Math.trunc(observedGapMs));
  return Math.min(cap, Math.max(base, observed));
}

/** 单个 text part 的增量状态（同一条消息可有多个 text part，各有独立偏移）。 */
interface PartStreamState {
  /** 已观察到的全量文本（增量追加 / 快照覆盖）。 */
  text: string;
  /** 已送入 TTS 的字符偏移（相对本 part 的 `text`）。 */
  flushed: number;
}

/** part 类型登记（从 `message.part.updated` 学习，供 `message.part.delta` 判定是否 text）。 */
interface PartMeta {
  type: string;
  /** 非正文（`ignored`/`synthetic`）→ 不读。 */
  skip: boolean;
  /**
   * 被角色门/类型门挡过事件的 part：**后续 delta 一律丢弃**。
   * 不变式：`tainted` 保证各 part 的 `text` 恒为真实文本的**前缀**（无空洞），
   * 从而快照的 `pending = snapshot.slice(flushed)` 永远无重复、无丢失。
   */
  tainted: boolean;
}

/** 每条消息的诊断计数（完成时聚合成一条 info）。 */
interface MessageDiag {
  /**
   * 该消息所属会话 id（2026-10-21 第四批新增）：`interrupt(sessionID)` 靠它把「已过门但尚无
   * StreamState」的在途消息也按会话过滤——`streams` 条目自带 sessionID，`diag` 原先没有，
   * 不补字段就无法对这类消息做会话收窄（会退化成跨会话置水位）。
   */
  sessionID: string;
  /** 过完结构校验的 text part 事件数（含 text-start 空快照）。 */
  partEvents: number;
  /** 过完结构校验的 delta 事件数（含被类型/角色过滤的）。 */
  deltaEvents: number;
  /** 角色门未命中数（role 非 assistant 或未知）。 */
  roleMiss: number;
  /** 摘要消息跳过数。 */
  summarySkips: number;
  /** enqueue 的块数。 */
  chunks: number;
  /** enqueue 的字符数。 */
  chars: number;
}

/** 一条消息的增量朗读状态。 */
interface StreamState {
  sessionID: string;
  /** 各 text part 的增量状态（按 partID）。 */
  parts: Map<string, PartStreamState>;
  /** 待读文本队列（每个增量一块）。 */
  queue: string[];
  /**
   * 句切分后的**未完结尾段**（自上一批之后尚无句末标点的原文）：下一批 drain 拼到 merged 头部再切，
   * 使块边界落在句尾；消息完成（done）时作为最终单元冲出（末尾无标点也不丢文本）。
   */
  carry: string;
  /**
   * 在途 drain 循环（同一消息至多一个）。
   *
   * 2026-10-22 审计修复：原来的 `active: boolean` 只能表达「忙/闲」，`finalize()` 无法知道
   * 尾部队列何时真正放完；现改为可 await 的 Promise——`finalize` 在它收敛后才回收
   * `streams`/partMeta，使「消息已完成但仍在 drain/播放」的窗口仍能被 `interrupt()` 命中。
   */
  loop: Promise<void> | null;
  /** 消息是否已完成。 */
  done: boolean;
  /** 流式送文分块器（阈值 + 增量；缓冲未达阈值的短文本）。 */
  chunker: StreamChunker;
  /** follow worker（provider 支持时每消息一个；finalize/中止时关 stdin 等退出）。 */
  worker?: FollowWorker;
  /** follow worker 派生失败后，该消息退回按块 spawn CLI 路径。 */
  followBroken: boolean;
  /** 是否已经派发过该消息的首个单元（首句合并窗只生效一次）。 */
  firstDispatchDone: boolean;
  /**
   * 当前是否有单元正在播放（`drain` 已开始投递、尚未 await 到播放结束）。
   * 只有为 true 时 `enqueue` 才会尝试预取下一单元——否则会把还没凑批合并的文本提前摘走，
   * 改变既有凑批语义（首句合并窗也依赖队列）。
   */
  playing: boolean;
  /**
   * **已预取、等待交播的下一单元**（深度 1，单槽）：其正文在预取启动时就从 `queue/carry`
   * 按原文偏移**摘走**（顺序确定、不会与后续文本重排）；失败/打断时按 `entry.text` 退回串行投递，
   * 保证不丢句。所有权：预取进程与临时文件归本条目，消费/取消后清空。
   */
  prefetch?: PrefetchUnit;
  /**
   * 首句合并窗的唤醒钩子（等待期间 `finalize()`/`stopInFlight()`/新文本用它立即推进）：
   * - `done`＝消息流已结束（立即派发，不必等窗口到期）；
   * - `cancel`＝打断/开关关闭/子会话门（立即取消等待，**不得拖延中断**）；
   * - `arrived`＝又完成了一整句（可并入首单元，立即结算并合并，不必等满窗口）。
   * 无等待者时为 undefined（幂等清理）。
   */
  wakeFirstWindow?: (reason: "done" | "cancel" | "arrived") => void;
}

/**
 * 判定事件是否为「已完成的助手消息」。
 * @param event 插件事件
 * @returns 是则返回 `{ sessionID, messageID }`；否则 undefined
 */
function completedAssistantMessage(event: unknown): { sessionID: string; messageID: string } | undefined {
  if (!event || typeof event !== "object") return undefined;
  const typed = event as MessageUpdatedEvent;
  if (typed.type !== "message.updated") return undefined;
  const info = typed.properties?.info;
  if (!info || typeof info !== "object") return undefined;
  if (info.role !== "assistant") return undefined;
  if (info.summary === true) return undefined;
  if (typeof info.time?.completed !== "number") return undefined;
  const messageID = info.id;
  const sessionID = typed.properties?.sessionID;
  if (typeof messageID !== "string" || messageID.length === 0) return undefined;
  if (typeof sessionID !== "string" || sessionID.length === 0) return undefined;
  return { sessionID, messageID };
}

/**
 * 从 parts 中抽取**可见正文**：只取 `text` 型 part（排除 `reasoning` 等），跳过 `ignored`。
 * @param parts 消息 parts
 * @returns 以换行连接的正文（已去首尾空白；无正文时为空串）
 */
export function extractReplyText(parts: readonly PartLike[]): string {
  return parts
    .filter((part) => part?.type === "text" && part.ignored !== true && typeof part.text === "string")
    .map((part) => (part.text ?? "").trim())
    .filter((text) => text.length > 0)
    .join("\n")
    .trim();
}

/** 把消息 id 规整为安全文件名片段。 */
function sanitizeId(id: string): string {
  return id.replace(/[^\w.-]/g, "_");
}

/**
 * 构建自动朗读器。
 * @param deps 依赖（日志 / CLI 路径 / 取 parts / 角色补取 / 子会话判定 / 测试注入）
 * @returns 事件处理器
 */
export function createAutoReader(deps: AutoReaderDeps): AutoReader {
  const { log, cliPath, fetchParts } = deps;
  const pathOptions = deps.paths ?? {};
  // 派生 bin：deps.spawnBin > env VOICE_NODE_BIN > "node"（PATH 解析）。
  // 不用 process.execPath——server 插件进程里那是 opencode.exe，会秒退且无任何日志（「触发了但没声音」根因）。
  const spawnBin = deps.spawnBin ?? (process.env[AUTO_READ_NODE_BIN_ENV]?.trim() || AUTO_READ_DEFAULT_NODE_BIN);
  const spawnFn = deps.spawnFn ?? spawn;
  const spawnEnabled = deps.spawnEnabled !== false;
  // 阈值口径与 provider 一致：缺省从 emotions.jsonc 的 tts.streamMinChars 读取（可注入）
  const streamMinChars = deps.streamMinChars ?? loadVoiceConfig({ configDir: deps.configDir }).tts.streamMinChars;
  const effectiveMinChars = Number.isFinite(streamMinChars) ? Math.max(0, Math.trunc(streamMinChars)) : DEFAULT_STREAM_MIN_CHARS;
  // 首句合并窗（0 = 关闭；越界夹取，见 normalizeFirstMergeWindow）
  const firstMergeWindowBaseMs = normalizeFirstMergeWindow(deps.firstMergeWindowMs);
  // 注入值同时作为自适应上限（测试注入小值即可缩短用例）——未注入时上限 = FIRST_MERGE_WINDOW_MAX_MS
  const firstMergeWindowCapMs =
    deps.firstMergeWindowMs === undefined ? FIRST_MERGE_WINDOW_MAX_MS : firstMergeWindowBaseMs;
  /**
   * 跨消息的「句间到达间隔」观测（毫秒；进程内）：模型吐句节奏是模型属性而非消息属性，
   * 故一条消息里学到的间隔供**下一条消息**的首句合并窗使用；无观测时按上限等。
   */
  let lastObservedSentenceGapMs: number | undefined;
  /** 上一条观测到的句末标点时刻（只统计**同一消息**内的相邻句，避免把跨消息空闲算成间隔）。 */
  let lastSentenceBoundary: { messageID: string; at: number } | undefined;
  /** 最近一次首句合并窗的实际等待时长（日志用）。 */
  let lastMergeWindowMs = 0;
  // provider follow 能力：生产由 emotions.ts 注入 resolveFollowSupport()；缺省 false（测试确定性，走按块 spawn）
  const followSupport = deps.followSupport === true;
  /**
   * 预取深度（见 {@link AutoReaderDeps.prefetchDepth}）：`prefetchSupport` 为假、`spawnEnabled=false`
   * 或 depth=0 时**完全关闭**（既有测试与 sapi 路径行为不变）。
   */
  const prefetchDepth =
    deps.prefetchSupport === true && spawnEnabled
      ? normalizePrefetchDepth(deps.prefetchDepth ?? PREFETCH_DEPTH_DEFAULT)
      : 0;
  // 已朗读消息 id：按会话懒加载持久化记录（覆盖插件重启/事件重放），运行期滚动写回该会话文件
  /** `sessionID → 已朗读消息 id 集合`（LRU：命中即移到队尾；上限 {@link SEEN_SESSION_CACHE_LIMIT}）。 */
  const seenBySession = new Map<string, Set<string>>();
  /**
   * 取（懒加载）某会话的已朗读集合；顺带做 LRU 触达。
   * @param sessionID 会话 id
   * @returns 该会话的已朗读消息 id 集合
   */
  const seenFor = (sessionID: string): Set<string> => {
    const existing = seenBySession.get(sessionID);
    if (existing) {
      seenBySession.delete(sessionID);
      seenBySession.set(sessionID, existing);
      return existing;
    }
    const loaded = readAutoTtsSeen(sessionID, pathOptions);
    seenBySession.set(sessionID, loaded);
    if (seenBySession.size > SEEN_SESSION_CACHE_LIMIT) {
      const oldest = seenBySession.keys().next().value;
      if (oldest !== undefined && oldest !== sessionID) seenBySession.delete(oldest);
    }
    return loaded;
  };
  /**
   * 标记某会话的某条消息已朗读并持久化（幂等：已在集合中不重复写文件）。
   * @param sessionID 会话 id
   * @param messageID 消息 id
   */
  const rememberSeen = (sessionID: string, messageID: string): void => {
    const seen = seenFor(sessionID);
    if (seen.has(messageID)) return;
    seen.add(messageID);
    writeAutoTtsSeen(sessionID, seen, pathOptions);
  };
  const inFlight = new Set<string>();
  /** 每条助手消息的增量状态。 */
  const streams = new Map<string, StreamState>();
  /** `messageID → role`（过滤用户消息；只朗读 assistant）。 */
  const roles = new Map<string, string>();
  /** `messageID → summary`（摘要消息不读；与 roles 同步淘汰）。 */
  const summaries = new Set<string>();
  /** `partID → 类型登记`（delta 无类型，靠 part 起始快照学习）。 */
  const partMeta = new Map<string, PartMeta>();
  /** 每消息诊断计数。 */
  const diag = new Map<string, MessageDiag>();
  /** 在途的角色补取（并发去重）。 */
  const roleFetches = new Set<string>();
  /** `sessionID → 是否子会话`（永久缓存；`undefined`=未知）。 */
  const childSessions = new Map<string, boolean>();
  /** 在途的子会话判定（并发去重；promise 供 fallback 路径 await）。 */
  const childFetches = new Map<string, Promise<void>>();
  /**
   * 当前存活的朗读子进程 → **归属**（2026-10-21 第四批由裸 `Set` 改 `Map`）：打断时按引用 kill
   * （不用进程名），且 `interrupt(sessionID)` 要按「子进程所属会话」过滤——裸 Set 无归属，
   * 只能全杀（跨会话腰斩的根因之一）。
   */
  const activeChildren = new Map<ChildProcess, ActiveChild>();
  /**
   * 消息级**打断水位**（`interrupted` 标，`interrupt()` 置位）：已被打断的消息 id 集合。
   * 用 Set 而非 `StreamState` 字段，是为了同时覆盖「尚无 StreamState 的在途消息」
   * （只过了角色门/类型门就被打断 → 完成时会走 `runFallback` 回退整段读——置位后不补读）。
   */
  const interrupted = new Set<string>();
  /**
   * `messageID → 开始时间`（毫秒，上限 {@link MESSAGE_START_LIMIT}）：**会话级中断请求水位**
   * （TUI 写的 `interrupt-req`）的比较基准。取值优先级：服务端 `info.time.created`（权威，晚到的
   * 事件可覆盖）> 插件对该消息的**首次观察**时刻（`diagFor` 建计数条目时记，part/delta 任一路径都先经它）；
   * 两者都没有（插件从未收到该消息的任何事件）时按当前时刻算 ⇒ 只会「刚开始」，不会被旧水位判中（宁漏不误杀）。
   */
  const messageStarts = new Map<string, number>();
  let speakSeq = 0;
  /** delta 路径的开关 TTL 缓存（见 `AUTO_TTS_TOGGLE_CACHE_MS`）；按 sessionID 分键。 */
  const toggleCache = new Map<string, { value: boolean; at: number }>();

  /**
   * 记一条「消息 → 开始时间」（超 {@link MESSAGE_START_LIMIT} 按插入序淘汰最旧）。
   * @param messageID 消息 id
   * @param startedAt 开始时间戳（毫秒）
   */
  const rememberStart = (messageID: string, startedAt: number): void => {
    messageStarts.set(messageID, startedAt);
    if (messageStarts.size > MESSAGE_START_LIMIT) {
      const oldest = messageStarts.keys().next().value;
      if (oldest !== undefined && oldest !== messageID) messageStarts.delete(oldest);
    }
  };

  /**
   * 取某消息的**开始时间**（会话级中断水位的比较基准）：有记账取记账值；无记账（插件从未收到该消息的
   * 任何事件）按**当前时刻**算 ⇒ 视作「刚开始」，不会被更早写下的请求判中（宁可漏拦不可误杀）。
   * @param messageID 消息 id
   * @returns 开始时间戳（毫秒）
   */
  const startedAtOf = (messageID: string): number => messageStarts.get(messageID) ?? Date.now();

  /**
   * 取（并按上限淘汰）某消息的诊断计数（新条目记入所属会话，供 `interrupt(sessionID)` 会话过滤）。
   * @param messageID 消息 id
   * @param sessionID 该消息所属会话 id（已存在的条目忽略——同消息不会换会话）
   * @returns 诊断计数对象
   */
  const diagFor = (messageID: string, sessionID: string): MessageDiag => {
    const existing = diag.get(messageID);
    if (existing) return existing;
    // 首次观察到该消息（part/delta 任一路径）⇒ 记开始时间兜底（权威值由 `message.updated` 的
    // `info.time.created` 覆盖，见 handleEvent）；会话级中断水位据此判「该消息是否在请求之前就开始」。
    if (!messageStarts.has(messageID)) rememberStart(messageID, Date.now());
    const created: MessageDiag = {
      sessionID,
      partEvents: 0,
      deltaEvents: 0,
      roleMiss: 0,
      summarySkips: 0,
      chunks: 0,
      chars: 0,
    };
    diag.set(messageID, created);
    if (diag.size > DIAG_LIMIT) {
      const oldest = diag.keys().next().value;
      if (oldest !== undefined && oldest !== messageID) diag.delete(oldest);
    }
    return created;
  };

  /**
   * 给一批消息置打断水位（已置位的跳过；超上限按插入序淘汰最旧）。
   * @param ids 消息 id 集合
   * @returns 本次**新**置位的消息数
   */
  const markInterrupted = (ids: Iterable<string>): number => {
    let added = 0;
    for (const id of ids) {
      if (interrupted.has(id)) continue;
      interrupted.add(id);
      added += 1;
    }
    while (interrupted.size > INTERRUPTED_LIMIT) {
      const oldest = interrupted.values().next().value;
      if (oldest === undefined) break;
      interrupted.delete(oldest);
    }
    return added;
  };

  /**
   * **打断执行体**（`interrupt()` 与「会话级中断请求」命中时**共用同一套**，不再另写第二份）：
   * 对**目标范围**的在途消息置 `interrupted` 水位并停读——
   * ① `streams` 里有状态的（在播/排队/缓冲）：清其队列/carry；② `diag` 里已过门但尚无 StreamState 的
   *    （防其完成后走 `runFallback` 整段补读把被打断的又念一遍）；③ 按归属 kill 朗读子进程（含 follow worker）。
   * **按会话收窄（2026-10-21 第四批）**：带 `sessionID` 只处理该会话（其它会话完全不动）；无参/空白 = 全清
   * （dispose/进程退出等清场路径保持原语义）。
   * **按开始时间收窄（2026-10-22，会话级中断请求水位）**：带 `startedBefore` 时**只处理开始时间严格早于该时刻**
   * 的消息——晚于水位的**新**消息不受影响（F10 中断只停「按下的那一刻已经开始」的回复；开关没变、后续回复照读）。
   * 开始时间无记账的消息按「刚开始」处理 ⇒ 不置水位、不 kill（宁可漏拦不可误杀）。
   * 残余：「插件启动后从未收到任何 part/delta 且无 message.updated」的消息无从识别（streams/diag 都没有它），
   * 完成时仍可能回退整段读——事件驱动下无法凭空得知其 id，见 `docs/ASYNC.md` 交互点 ⑫。
   * @param sessionID 目标会话；缺省/空白 = 全部会话
   * @param startedBefore 开始时间水位（毫秒时间戳）；缺省 = 不设时间上限
   */
  const stopInFlight = (sessionID?: string, startedBefore?: number): void => {
    const scoped = typeof sessionID === "string" && sessionID.length > 0;
    const timeScoped = typeof startedBefore === "number" && Number.isFinite(startedBefore);
    /** 该消息是否落在时间水位之前（无记账 ⇒ 不算命中）。 */
    const inTimeScope = (messageID: string): boolean =>
      !timeScoped || startedAtOf(messageID) < (startedBefore as number);
    const activeIds = new Set<string>();
    for (const [messageID, state] of streams) {
      if (scoped && state.sessionID !== sessionID) continue;
      if (!inTimeScope(messageID)) continue;
      activeIds.add(messageID);
      state.queue.length = 0;
      state.carry = "";
      // 已预取的下一单元：立即 kill 合成/预热进程并删缓冲文件（打断优先级最高，不得残留播放）
      discardPrefetch(state);
      // 首句合并窗等待者立即取消（打断不得因等新句而拖延）
      state.wakeFirstWindow?.("cancel");
    }
    for (const [messageID, counters] of diag) {
      if (scoped && counters.sessionID !== sessionID) continue;
      if (!inTimeScope(messageID)) continue;
      activeIds.add(messageID);
    }
    if (activeIds.size > 0) {
      markInterrupted(activeIds);
      log.info(
        `自动朗读已打断：messages=${activeIds.size}${scoped ? ` session=${sessionID}` : ""}` +
          (timeScoped ? ` startedBefore=${startedBefore}` : ""),
      );
    }
    for (const [child, owner] of activeChildren) {
      if (scoped && owner.sessionID !== sessionID) continue;
      // 带时间水位时只杀「该消息在水位之前开始」的子进程；无记账 ⇒ 不杀（不误杀后续新消息的播放）
      if (timeScoped && !inTimeScope(owner.messageID)) continue;
      try {
        child.kill();
      } catch {
        // 已退出/无权限忽略
      }
      // 全清时立即摘除（原行为）；收窄时留给子进程 exit/error 回调摘除——kill 失败但进程仍活时
      // 不丢追踪，后续同会话 interrupt 还能再杀
      if (!scoped) activeChildren.delete(child);
    }
    if (!scoped) activeChildren.clear();
  };

  /**
   * **会话级中断请求**检查（跨进程水位：TUI 进程在中断出口原子写 `<sessionID>/interrupt-req`，
   * 内容为请求时刻）——补 `stopPlayback` 按 PID 杀的两个缺口：**单元间隙无进程可杀（杀空）** 与
   * **worker 死后非 follow 路径重新 spawn（杀后重生）**。
   * 判定：请求时刻 **严格大于** 该消息开始时间 ⇒ 命中 ⇒ 走 `stopInFlight(sessionID, 请求时刻)`
   * （置水位 + 清队列/carry + kill 本会话在途子进程），返回 true，调用方**不得投递该单元**。
   * 每个派发单元**同步读一次文件、不加缓存**（单元间隔秒级，要的正是新鲜度；F10 生效延迟只到下一单元）；
   * 读失败/异常/无请求一律返回 false **放行**（宁可漏拦不可误杀，绝不影响朗读主链）。
   * @param messageID 待投递的消息 id
   * @param sessionID 该消息所属会话 id
   * @returns 是否命中中断请求
   */
  const applyInterruptRequest = (messageID: string, sessionID: string): boolean => {
    let requested = 0;
    try {
      requested = readInterruptRequest(sessionID, pathOptions);
    } catch {
      return false;
    }
    if (requested <= 0) return false;
    const startedAt = startedAtOf(messageID);
    if (requested <= startedAt) return false;
    log.info(
      `自动朗读命中中断请求：message=${messageID} session=${sessionID} req=${requested} started=${startedAt}`,
    );
    stopInFlight(sessionID, requested);
    return true;
  };

  /**
   * delta 路径读指定会话的开关（300ms TTL 缓存，按 sessionID 分键）；part 路径与 drain/回退仍实时读。
   * @param sessionID 会话 id
   * @returns 该会话是否开启自动朗读
   */
  const isAutoTtsOnCached = (sessionID: string): boolean => {
    const now = Date.now();
    const cached = toggleCache.get(sessionID);
    if (cached && now - cached.at < AUTO_TTS_TOGGLE_CACHE_MS) return cached.value;
    const value = readAutoTts(sessionID, pathOptions);
    toggleCache.set(sessionID, { value, at: now });
    return value;
  };

  /**
   * 角色未知时惰性补取一次（并发去重）：只回填 `roles` 表，**不追溯**已丢弃的增量
   * （text-end 快照 `flushed=0` 时整段重置发出，保证无重复无丢失）。
   * @param messageID 消息 id
   * @param sessionID 会话 id
   */
  const scheduleRoleFetch = (messageID: string, sessionID: string): void => {
    if (!deps.fetchMessageRole) return;
    if (roleFetches.has(messageID)) return;
    roleFetches.add(messageID);
    deps
      .fetchMessageRole(sessionID, messageID)
      .then((role) => {
        if (role === "assistant" || role === "user") {
          roles.set(messageID, role);
          log.info(`自动朗读角色补取：message=${messageID} role=${role}`);
        }
      })
      .catch((err: unknown) => {
        log.warn("自动朗读角色补取失败", err as Error);
      })
      .finally(() => {
        roleFetches.delete(messageID);
      });
  };

  /**
   * 子会话判定（单飞去重，模式照抄 `fetchMessageRole`）：结果写入 `childSessions` 永久缓存。
   * 返回的 Promise 在判定完成（成功或失败）后 resolve，供 `awaitChildCheck` 复用。
   * @param sessionID 会话 id
   * @returns 在途判定 Promise（已有在途时返回同一个）
   */
  const scheduleChildFetch = (sessionID: string): Promise<void> => {
    if (!deps.fetchIsChildSession) return Promise.resolve();
    const existing = childFetches.get(sessionID);
    if (existing) return existing;
    if (childSessions.has(sessionID)) return Promise.resolve();
    const pending = deps
      .fetchIsChildSession(sessionID)
      .then((isChild) => {
        childSessions.set(sessionID, isChild);
        log.info(`自动朗读子会话判定：session=${sessionID} child=${isChild}`);
      })
      .catch((err: unknown) => {
        log.warn(`自动朗读子会话判定失败：session=${sessionID}`, err as Error);
        // 失败不缓存：下次事件会重试单飞（fail-closed 期间继续按子会话跳过）
      })
      .finally(() => {
        childFetches.delete(sessionID);
      });
    childFetches.set(sessionID, pending);
    return pending;
  };

  /**
   * 子会话门（同步，用于 delta/part/drain 等高频路径）：
   * 是子会话 → true（跳过）；未知 → 触发补取并按「子会话」处理（fail-closed，防首条 delta 漏读）。
   * 未注入 `fetchIsChildSession` 时恒 false（测试可不注入，行为同旧）。
   * @param sessionID 会话 id
   * @returns 是否应跳过朗读
   */
  const childGateBlocks = (sessionID: string): boolean => {
    if (!deps.fetchIsChildSession) return false;
    const known = childSessions.get(sessionID);
    if (known !== undefined) return known;
    void scheduleChildFetch(sessionID);
    return true;
  };

  /**
   * 子会话门（异步，用于 fallback 路径）：**await 单飞判定完成**再决策，
   * 避免父会话首条消息在判定未完成时被 fail-closed 误跳过。
   * @param sessionID 会话 id
   * @returns 是否应跳过朗读（是子会话）
   */
  const awaitChildCheck = async (sessionID: string): Promise<boolean> => {
    if (!deps.fetchIsChildSession) return false;
    if (!childSessions.has(sessionID)) await scheduleChildFetch(sessionID);
    return childSessions.get(sessionID) === true;
  };

  /**
   * 读/登记事件所属 part 的类型（供 delta 过滤）。
   * @param part 事件 part（可能无 id——真实 opencode 事件必带，无 id 时无法关联 delta）
   * @returns partID；无 id 时 undefined
   */
  const learnPartMeta = (part: PartLike): string | undefined => {
    const partID = part.id;
    if (typeof partID !== "string" || partID.length === 0) return undefined;
    const existing = partMeta.get(partID);
    partMeta.set(partID, {
      type: part.type ?? "",
      skip: part.ignored === true || part.synthetic === true,
      // taint 只增不减：重学类型（如再次快照）不得洗白「已丢过事件」的 part
      tainted: existing?.tainted ?? false,
    });
    if (partMeta.size > PART_META_LIMIT) {
      const oldest = partMeta.keys().next().value;
      if (oldest !== undefined && oldest !== partID) partMeta.delete(oldest);
    }
    return partID;
  };

  /**
   * 角色/摘要门：摘要消息跳过（静默计数）；assistant 放行；未知触发惰性补取并计未命中。
   * @param messageID 消息 id
   * @param sessionID 会话 id
   * @param counters 诊断计数
   * @returns 是否允许朗读
   */
  const gateAllows = (messageID: string, sessionID: string, counters: MessageDiag): boolean => {
    if (summaries.has(messageID)) {
      counters.summarySkips += 1;
      return false;
    }
    if (roles.get(messageID) === "assistant") return true;
    counters.roleMiss += 1;
    if (!roles.has(messageID)) scheduleRoleFetch(messageID, sessionID);
    return false;
  };

  /**
   * 派生 CLI（`speak --text-file <tmp>`）朗读一个句子单元，返回其退出 Promise（非 follow 路径）。
   * 子进程记入 `activeChildren`（带 messageID/sessionID 归属），供 `interrupt(sessionID?)` 按会话精确 kill。
   * env 注入 `EMOTIONS_SESSION_ID=<消息 sessionID>`（见 `PLAYBACK_SESSION_ENV`）：CLI 登记
   * `tts-playback` 时带上会话归属，跨会话消息才不会误杀本会话的播放。
   * @param text 待朗读文本（一个句对齐单元）
   * @param messageID 消息 id（用于临时文件名）
   * @param sessionID 消息所属会话 id（经 env 传给 CLI）
   * @returns 播放子进程退出后 resolve
   */
  const spawnSpeak = (text: string, messageID: string, sessionID: string): Promise<void> => {
    // 空文本（纯空白）直接跳过：不写临时文件、不派生、不报错——否则 CLI 侧 trim 后为空，
    // provider 抛「text 不能为空」→ 子进程异常退出 warn（用户实测缺陷，同口径见 CLI speak 入口）
    if (text.trim().length === 0) return Promise.resolve();
    // 临时正文目录留 base 根（不进会话目录）：跨会话按进程共用、播完即删；
    // 打断/播放链只按 PID 与文件路径走，不关心会话归属（见 auto-tts.ts「留在 base 根」说明）。
    const dir = join(autoTtsDataDir(pathOptions), TTS_TMP_DIR_NAME);
    const file = join(dir, `${sanitizeId(messageID)}-${speakSeq++}-${randomUUID()}.txt`);
    const cleanup = (): void => {
      try {
        rmSync(file, { force: true });
      } catch {
        // 清理失败忽略
      }
    };
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, text, "utf8");
    } catch (err) {
      log.warn("自动朗读写临时文件失败", err as Error);
      return Promise.resolve();
    }
    if (!spawnEnabled) {
      log.info(`自动朗读（测试模式）：cli=${cliPath} --text-file ${file} len=${text.length}`);
      cleanup();
      return Promise.resolve();
    }
    return new Promise<void>((resolveSpeak) => {
      let child: ChildProcess;
      try {
        // stderr 接管（pipe）：子进程秒退/报错不再被 stdio:"ignore" 静默吞掉；
        // env 显式带上进程 env + 会话归属（CLI 登记 tts-playback 的 sessionID 来源）
        child = spawnFn(spawnBin, [cliPath, "speak", "--text-file", file], {
          stdio: ["ignore", "ignore", "pipe"],
          windowsHide: true,
          env: { ...process.env, [PLAYBACK_SESSION_ENV]: sessionID },
        });
      } catch (err) {
        log.warn("自动朗读派生失败", err as Error);
        cleanup();
        resolveSpeak();
        return;
      }
      activeChildren.set(child, { messageID, sessionID });
      // 收集 stderr（有界）：退出后若非 0 退出或有输出，warn 带片段
      let stderr = "";
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        if (stderr.length < AUTO_READ_STDERR_LIMIT) stderr += chunk;
      });
      const finish = (): void => {
        activeChildren.delete(child);
        cleanup();
        resolveSpeak();
      };
      child.once("exit", (code, signal) => {
        const snippet = stderr.trim().slice(0, 200);
        // 主动打断（interrupt kill）不算异常：child.killed 为 true 时静默收尾
        if (!child.killed && (code !== 0 || snippet.length > 0)) {
          log.warn(
            `自动朗读子进程异常退出：code=${code ?? "-"} signal=${signal ?? "-"} bin=${spawnBin}` +
              (snippet ? ` stderr=${snippet}` : ""),
          );
        }
        finish();
      });
      child.once("error", (err) => {
        log.warn("自动朗读派生子进程失败", err);
        finish();
      });
      log.info(`自动朗读已触发：message=${messageID} len=${text.length}`);
    });
  };

  /**
   * 派生 follow worker（`speak --follow`）：stdin 保持打开，后续句子单元逐行写入（不再每块 spawn）。
   * 子进程记入 `activeChildren`（带 messageID/sessionID 归属；`interrupt(sessionID)` 按会话杀、无参全杀）；stderr 接管（与 `spawnSpeak` 同口径）；
   * stdin `error` 监听防 EPIPE 炸宿主进程。info 只打**一条** worker 启动日志（每块静默，保持低噪）。
   * env 注入 `EMOTIONS_SESSION_ID=<消息 sessionID>`（与 `spawnSpeak` 同口径）：worker CLI 登记的
   * `tts-playback` 带会话归属——跨会话消息（另一窗口新会话的 `chat.message`）不会误杀本会话 worker。
   * @param messageID 消息 id（日志用）
   * @param sessionID 消息所属会话 id（经 env 传给 CLI）
   * @returns worker 句柄；派生失败（异常/spawnEnabled=false）返回 undefined（调用方退回按块 spawn）
   */
  const spawnWorker = (messageID: string, sessionID: string): FollowWorker | undefined => {
    if (!spawnEnabled) {
      log.info(`自动朗读 worker（测试模式）：cli=${cliPath} speak --follow message=${messageID}`);
      return undefined;
    }
    let child: ChildProcess;
    try {
      child = spawnFn(spawnBin, [cliPath, "speak", "--follow"], {
        stdio: ["pipe", "ignore", "pipe"],
        windowsHide: true,
        env: { ...process.env, [PLAYBACK_SESSION_ENV]: sessionID },
      });
    } catch (err) {
      log.warn("自动朗读 worker 派生失败", err as Error);
      return undefined;
    }
    activeChildren.set(child, { messageID, sessionID });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < AUTO_READ_STDERR_LIMIT) stderr += chunk;
    });
    const worker: FollowWorker = { child, dead: false, exited: Promise.resolve() };
    worker.exited = new Promise<void>((resolve) => {
      child.once("exit", (code, signal) => {
        worker.dead = true;
        activeChildren.delete(child);
        const snippet = stderr.trim().slice(0, 200);
        // 主动打断（interrupt kill）不算异常：child.killed 为 true 时静默收尾
        if (!child.killed && (code !== 0 || snippet.length > 0)) {
          log.warn(
            `自动朗读 worker 异常退出：code=${code ?? "-"} signal=${signal ?? "-"} bin=${spawnBin}` +
              (snippet ? ` stderr=${snippet}` : ""),
          );
        }
        resolve();
      });
      child.once("error", (err) => {
        worker.dead = true;
        activeChildren.delete(child);
        log.warn("自动朗读 worker 子进程错误", err);
        resolve();
      });
    });
    // follow 模式 stdin 写入后 worker 死亡 → EPIPE 走 error 事件；不监听会让宿主进程崩溃
    child.stdin?.on("error", (err: Error) => {
      worker.dead = true;
      log.warn(`自动朗读 worker stdin 写入失败：${err.message}`);
    });
    log.info(`自动朗读 worker 启动：message=${messageID} cli=${cliPath}`);
    return worker;
  };

  /**
   * follow 路径投递一个句子单元：写 worker stdin 一行（行内禁换行——句单元由 splitDrainUnits 保证）。
   * 背压：`write()` 返回 false 时等 `drain`（有界 {@link WORKER_DRAIN_TIMEOUT_MS}；行很小正常不触发）。
   * @param state 消息状态
   * @param unit 一个句子单元（非空、无换行）
   * @throws worker 不可写/写失败时抛错（调用方转「该消息停读」）
   */
  const writeWorkerLine = async (state: StreamState, unit: string): Promise<void> => {
    const worker = state.worker;
    const stdin = worker?.child.stdin;
    if (!worker || worker.dead || !stdin || !stdin.writable) {
      throw new Error("follow worker 不可用");
    }
    const ok = stdin.write(`${unit}\n`);
    if (ok) return;
    await new Promise<void>((resolve, reject) => {
      const onDrain = (): void => {
        clearTimeout(timer);
        stdin.off("error", onError);
        resolve();
      };
      const onError = (err: Error): void => {
        clearTimeout(timer);
        stdin.off("drain", onDrain);
        reject(err);
      };
      const timer = setTimeout(() => {
        stdin.off("drain", onDrain);
        stdin.off("error", onError);
        resolve();
      }, WORKER_DRAIN_TIMEOUT_MS);
      stdin.once("drain", onDrain);
      stdin.once("error", onError);
    });
  };

  /**
   * follow worker 收尾：关 stdin（EOF → worker CLI `followEnd` → PowerShell 冲刷尾音退出）
   * 并等 worker 退出（有界 {@link WORKER_EXIT_TIMEOUT_MS}，超时强杀）。
   * @param state 消息状态
   */
  const closeWorker = async (state: StreamState): Promise<void> => {
    const worker = state.worker;
    state.worker = undefined;
    if (!worker || worker.dead) return;
    try {
      worker.child.stdin?.end();
    } catch {
      // stdin 已断：直接等 exit（或超时强杀）
    }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        try {
          worker.child.kill();
        } catch {
          // 已退出忽略
        }
        resolve();
      }, WORKER_EXIT_TIMEOUT_MS);
    });
    try {
      await Promise.race([worker.exited, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  /**
   * 投递一个句子单元：follow worker → 写 stdin 行（不 await 播放，worker 内 Speak 同步串行）；
   * 非 follow / worker 派生失败 → 按块 spawn CLI（await 退出，旧行为）。
   * worker 中途死亡 → 写失败 → **该消息停读**（warn + C 水位同语义：置 interrupted、清队列/carry，
   * 不再补读），不影响下一条消息。
   * **入口先查会话级中断请求水位**（`applyInterruptRequest`，2026-10-22）：命中则该单元既不写 worker
   * 也不 spawn（本函数是 follow 写前 / 非 follow spawn 前**唯一**的派生入口，一处检查覆盖两条路径）。
   * @param state 消息状态
   * @param unit 句子单元
   * @param messageID 消息 id
   */
  const deliverUnit = async (state: StreamState, unit: string, messageID: string): Promise<void> => {
    if (applyInterruptRequest(messageID, state.sessionID)) return;
    if (followSupport && !state.followBroken) {
      if (!state.worker) {
        state.worker = spawnWorker(messageID, state.sessionID);
        if (!state.worker) state.followBroken = true; // 派生失败：该消息退回按块 spawn 路径
      }
      if (state.worker) {
        try {
          await writeWorkerLine(state, unit);
          return;
        } catch (err) {
          log.warn(`自动朗读 worker 写入失败，停止该消息朗读：message=${messageID}`, err as Error);
          markInterrupted([messageID]);
          state.queue.length = 0;
          state.carry = "";
          return;
        }
      }
    }
    await spawnSpeak(unit, messageID, state.sessionID);
  };

  /**
   * 丢弃当前消息已预取的下一单元（kill 合成/预热子进程 + 删文件；幂等）。
   * 打断/开关关/子会话门/收敛清理都走它，保证**不残留播放、不残留临时文件**。
   * @param state 消息状态
   */
  const discardPrefetch = (state: StreamState): void => {
    const entry = state.prefetch;
    state.prefetch = undefined;
    entry?.cancel();
  };

  /**
   * 为一段**已知正文**启动预取（深度 1：已有预取时不重复启动）。
   * @param state 消息状态
   * @param text 下一单元正文（非空）
   * @param messageID 消息 id
   */
  const startPrefetchText = (state: StreamState, text: string, messageID: string): void => {
    if (prefetchDepth < 1 || state.prefetch) return;
    if (text.trim().length === 0) return;
    if (interrupted.has(messageID)) return;
    const entry = new PrefetchUnit(
      {
        cliPath,
        spawnBin,
        spawnFn,
        log,
        paths: pathOptions,
        attach: (child) => activeChildren.set(child, { messageID, sessionID: state.sessionID }),
        detach: (child) => activeChildren.delete(child),
        timeoutMs: deps.prefetchTimeoutMs,
      },
      text,
      messageID,
      state.sessionID,
    );
    state.prefetch = entry;
    entry.start();
    void entry.ready.then((ok) => {
      if (!ok && state.prefetch === entry) {
        log.info(`自动朗读预取不可用，将退回串行：message=${messageID} len=${text.length}`);
      }
    });
  };

  /**
   * 从待读队列里**按句对齐**摘出下一单元并预取（仅当有单元正在播放时）。
   *
   * 为什么只在播放中：`drain` 每轮要把「此刻已在队列」的块凑批合并 + 首句合并窗；提前摘走会
   * 改变既有合并语义。播放期间新到的文本不会参与本轮合并（drain 正 await 播放），此时摘走是安全的。
   * 摘除用原文偏移（`splitDrainUnitSpans`），顺序确定；失败时 `entry.text` 仍会串行补读，不丢句。
   * @param state 消息状态
   * @param messageID 消息 id
   */
  const maybeStartPrefetch = (state: StreamState, messageID: string): void => {
    if (prefetchDepth < 1 || state.prefetch || !state.playing) return;
    if (interrupted.has(messageID)) return;
    if (childGateBlocks(state.sessionID)) return;
    if (!readAutoTts(state.sessionID, pathOptions)) return;
    const pending = state.carry + state.queue.join("");
    if (pending.length === 0) return;
    const { units } = splitDrainUnitSpans(pending);
    let candidate: { text: string; consumed: number } | null = null;
    if (units.length > 0) {
      candidate = { text: units[0].text, consumed: units[0].end };
    } else if (state.done) {
      // 消息已完成：末尾无标点的尾段也作为最终单元（与 drain 的 finalUnit 同口径）
      const finalText = pending.trim();
      if (finalText.length > 0) candidate = { text: finalText, consumed: pending.length };
    }
    if (!candidate) return;
    // 摘走：carry 保留剩余原文（含句间空白），队列块已全部并入 pending
    state.carry = pending.slice(candidate.consumed);
    state.queue.length = 0;
    startPrefetchText(state, candidate.text, messageID);
  };

  /**
   * 交播一个**已预取**单元：打断/开关/子会话门复查 → 打开交播闸门 → 等播放进程退出。
   * 预取不可用（合成失败/超时/播放器从未起播）→ **退回串行** `deliverUnit`（同一正文，不丢句）。
   * @param state 消息状态
   * @param entry 预取条目
   * @param messageID 消息 id
   */
  const playPrefetched = async (state: StreamState, entry: PrefetchUnit, messageID: string): Promise<void> => {
    if (applyInterruptRequest(messageID, state.sessionID)) {
      entry.cancel();
      return;
    }
    if (!readAutoTts(state.sessionID, pathOptions) || childGateBlocks(state.sessionID)) {
      entry.cancel();
      return;
    }
    const played = await entry.play();
    if (played) return;
    if (interrupted.has(messageID)) {
      entry.cancel();
      return;
    }
    log.warn(`自动朗读预取不可用，退回串行：message=${messageID} len=${entry.text.length}`);
    await deliverUnit(state, entry.text, messageID);
  };

  /**
   * 播放一个单元（统一入口）：若 `state.prefetch` 恰好是本单元则交播预取，否则走串行合成播放；
   * 播放**开始后**立即尝试预取下一单元（深度 1），并在播放结束的 finally 里回落 `playing`。
   *
   * 顺序契约：`state.playing` 在派生/交播**之前**置位、在播放结束**之后**清除；预取只在
   * `playing=true` 时启动，因此**不会**把还在凑批/合并窗阶段的文本提前摘走。
   * @param state 消息状态
   * @param unit 单元正文
   * @param messageID 消息 id
   * @param prefetched 已预取条目（可选；正文必须与 `unit` 一致）
   * @param nextText 已确定的本批下一单元正文（可选；优先于队列预取——它更靠前）
   * @returns 本单元播放结束（或被中断/降级路径收敛）后 resolve
   */
  const playUnit = (
    state: StreamState,
    unit: string,
    messageID: string,
    prefetched?: PrefetchUnit,
    nextText?: string,
  ): Promise<void> => {
    state.playing = true;
    const done = prefetched ? playPrefetched(state, prefetched, messageID) : deliverUnit(state, unit, messageID);
    // 派生已同步完成（非 follow）/已写 stdin 行（follow）：此刻启动下一单元预取。
    // **顺序**：本批已确定的下一单元优先占用单槽（它比队列里的文本更靠前），再尝试队列预取。
    if (nextText !== undefined) startPrefetchText(state, nextText, messageID);
    maybeStartPrefetch(state, messageID);
    return done.finally(() => {
      state.playing = false;
    });
  };

  /**
   * 投递一个单元并消费其预取条目（若文本一致）：预取按序摘取，文本不一致视为异常
   * （理论上不会发生）——丢弃预取、串行播放本单元，绝不混音/乱序。
   * @param state 消息状态
   * @param unit 单元正文
   * @param messageID 消息 id
   * @param nextText 本批下一单元正文（可选；用于在播当前单元期间预取它）
   */
  const deliverNext = async (
    state: StreamState,
    unit: string,
    messageID: string,
    nextText?: string,
  ): Promise<void> => {
    const entry = state.prefetch;
    if (entry && entry.text === unit) {
      state.prefetch = undefined;
      await playUnit(state, unit, messageID, entry, nextText);
      return;
    }
    if (entry) discardPrefetch(state);
    await playUnit(state, unit, messageID, undefined, nextText);
  };

  /**
   * 合并窗期间是否应取消等待（打断优先级最高）：消息级打断水位、开关被关、子会话门、
   * 会话级中断请求（跨进程水位，命中即走同一套 `stopInFlight`）。
   * @param state 消息状态
   * @param messageID 消息 id
   * @returns 是否应立即取消等待并放弃派发
   */
  const mergeWindowCancelRequested = (state: StreamState, messageID: string): boolean =>
    interrupted.has(messageID) ||
    !readAutoTts(state.sessionID, pathOptions) ||
    childGateBlocks(state.sessionID) ||
    applyInterruptRequest(messageID, state.sessionID);

  /**
   * 等待首句合并窗（见 {@link adaptiveFirstMergeWindow}）。四种结算：
   * - `timeout`：自适应窗口到期；
   * - `arrived`：又完成了一整句（可并入首单元；`enqueue` 唤醒，立即结算合并，不必等满窗口）；
   * - `done`：消息流在窗口内结束（`finalize()` 主动唤醒，立即派发，不多等）；
   * - `cancel`：打断/开关关闭/子会话门/会话级中断请求（**立即**取消，绝不拖延中断）。
   * 等待期间每 {@link FIRST_MERGE_WINDOW_POLL_MS} 复查一次取消条件（跨进程请求只能轮询），
   * 并登记 `state.wakeFirstWindow` 供同进程的 `finalize()`/`stopInFlight()`/`enqueue()` 即时唤醒。
   * @param state 消息状态
   * @param messageID 消息 id
   * @returns 结算原因
   */
  const waitFirstMergeWindow = (
    state: StreamState,
    messageID: string,
  ): Promise<"timeout" | "arrived" | "done" | "cancel"> =>
    new Promise<"timeout" | "arrived" | "done" | "cancel">((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      let poll: NodeJS.Timeout | undefined;
      function finish(reason: "timeout" | "arrived" | "done" | "cancel"): void {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        if (poll !== undefined) clearInterval(poll);
        if (state.wakeFirstWindow === wake) state.wakeFirstWindow = undefined;
        resolve(reason);
      }
      function wake(reason: "done" | "cancel" | "arrived"): void {
        finish(reason);
      }
      state.wakeFirstWindow = wake;
      // 等待开始前就已打断/关闭/已结束：不必再等
      if (mergeWindowCancelRequested(state, messageID)) {
        finish("cancel");
        return;
      }
      if (state.done) {
        finish("done");
        return;
      }
      const windowMs = adaptiveFirstMergeWindow(firstMergeWindowBaseMs, lastObservedSentenceGapMs, firstMergeWindowCapMs);
      lastMergeWindowMs = windowMs;
      if (windowMs <= 0) {
        finish("timeout");
        return;
      }
      timer = setTimeout(() => finish("timeout"), windowMs);
      poll = setInterval(() => {
        if (mergeWindowCancelRequested(state, messageID)) finish("cancel");
        else if (state.done) finish("done");
      }, FIRST_MERGE_WINDOW_POLL_MS);
    });

  /**
   * 把「窗口内新完成的完整句」并入首个单元（**只并完整句**，保持句对齐与顺序）：
   * 取 `carry + 队列全部块` 重新按 `splitDrainUnits()` 口径切分（未完尾段回写 `carry`，
   * 沿用既有 carry 语义），再按 {@link DRAIN_MERGE_MAX_CHARS} 贪婪追加到首单元；
   * 超上限的句子**按原顺序**作为本批后续单元返回（不丢、不重排）。
   * @param state 消息状态
   * @param unit 首个单元（窗口前的正文，保证 ≤ 合并上限）
   * @returns `unit`=合并后的首单元；`rest`=未能并入的完整句单元（顺序不变）
   */
  const mergeNewSentencesIntoFirstUnit = (state: StreamState, unit: string): { unit: string; rest: string[] } => {
    if (state.carry.length === 0 && state.queue.length === 0) return { unit, rest: [] };
    const pending = state.carry + state.queue.join("");
    state.queue.length = 0;
    state.carry = "";
    const { units, carry } = splitDrainUnits(pending);
    state.carry = carry;
    const rest: string[] = [];
    let merged = unit;
    for (const extra of units) {
      if (merged.length + extra.length <= DRAIN_MERGE_MAX_CHARS) merged += extra;
      else rest.push(extra);
    }
    return { unit: merged, rest };
  };

  /**
   * 串行播放某消息的待读队列（每轮把**此刻已在队列**的块凑批合并 → 句对齐切分 → 逐单元投递）。
   * 派生前复查：子会话（或未知 fail-closed）→ 清空队列/carry 不再播；开关关 → 清空不再播；
   * 打断水位置位 → 清空不再播（中止时一并关 follow worker）。
   * 消息完成（done）且队列/carry 已空 → 关 follow worker（EOF 等退出，冲刷尾音）。
   * 不在 drain 打汇总（避免与 finalize/runFallback 双打；skip 汇总只在 finalize/runFallback 路径）。
   * **首句合并窗（2026-10-22 第十三批修法 1）**：每消息**首个**单元派发前，若消息流未结束，
   * 最多等 `firstMergeWindowMs` 把窗口内新完成的句子并进该单元（省一次整条管线重启）；
   * 第 2 个及以后单元、以及已是最后一句（流已结束）的情况**不等待**。
   * **幂等**：已在跑时返回同一个 Promise（调用方可 await 到真正收敛）。
   * @param state 消息状态
   * @param messageID 消息 id
   * @returns 该消息本轮到收敛（队列/carry 清空、follow worker 关闭）后 resolve
   */
  const drain = (state: StreamState, messageID: string): Promise<void> => {
    // 已在跑：返回同一 Promise（调用方可 await 到真正收敛，不再「忙就立即返回」）
    if (state.loop) return state.loop;
    const loop = (async () => {
      for (;;) {
        const hasPending =
          state.prefetch !== undefined || state.queue.length > 0 || state.carry.length > 0;
        // 终态收敛：完成且无待处理文本（含预取槽）→ 关 follow worker（EOF 等退出，冲刷尾音）
        if (state.done && !hasPending) {
          if (state.worker) await closeWorker(state);
          break;
        }
        // 打断水位：interrupt() 置位后不再派生（interrupt 已清队列/预取，此处兜底 await 期间的置位）。
        // 预取同样立即丢弃（kill 合成/预热进程 + 删文件），绝不残留播放。
        if (interrupted.has(messageID)) {
          discardPrefetch(state);
          state.queue.length = 0;
          state.carry = "";
          if (state.worker) await closeWorker(state);
          break;
        }
        // 子会话硬跳过：判定为子会话（或未知期间 fail-closed）→ 清空队列/carry/预取、不再派生
        if (childGateBlocks(state.sessionID)) {
          discardPrefetch(state);
          state.queue.length = 0;
          state.carry = "";
          if (state.worker) await closeWorker(state);
          break;
        }
        // 派生前复查开关（实时读，不经 TTL 缓存）：F10 关闭后立即停止，不再继续播已入队的下一段
        if (!readAutoTts(state.sessionID, pathOptions)) {
          discardPrefetch(state);
          state.queue.length = 0;
          state.carry = "";
          if (state.worker) await closeWorker(state);
          break;
        }
        // 预取槽优先消费（其正文已从队列按序摘走）：交播失败自动退回串行，不丢句
        if (state.prefetch) {
          const entry = state.prefetch;
          state.prefetch = undefined;
          await playUnit(state, entry.text, messageID, entry);
          if (interrupted.has(messageID)) break;
          continue;
        }
        if (state.queue.length === 0) {
          // 未完成且队列空：carry 留待下一批拼接（等新 delta / finalize）
          if (!state.done) break;
          // 已完成：carry 尾段作为最终单元冲出（消息末尾无标点也不丢文本）
          const finalUnit = state.carry;
          state.carry = "";
          if (finalUnit.trim().length > 0) await playUnit(state, finalUnit, messageID);
          continue;
        }
        // 凑批合并（消碎块×进程冷启动）：shift 首块（前置 carry）后继续 shift 拼接**此刻已在队列**的块。
        // 事件驱动：只拼现成的块，不等待/不轮询新 delta；单次合并 ≤ DRAIN_MERGE_MAX_CHARS。
        const first = state.queue.shift() as string;
        let merged = state.carry + first;
        state.carry = "";
        while (state.queue.length > 0 && merged.length < DRAIN_MERGE_MAX_CHARS) {
          const next = state.queue[0];
          if (merged.length + next.length > DRAIN_MERGE_MAX_CHARS) break;
          merged += state.queue.shift();
        }
        // 句对齐切分：完整句连读成单元；未完结尾段 carry 到下一批（块边界落在句尾）
        const { units, carry } = splitDrainUnits(merged);
        state.carry = carry;
        let batchUnits = units;
        // 首句合并窗：仅当（a）该消息还没派发过首个单元、（b）本批恰好只有 1 个完整句单元
        // （≥2 说明本批已够长，无需再等）、（c）消息流未结束（最后一句不等，避免无谓延迟）、
        // （d）窗口 > 0 时生效。等待期间新完成的句子（`arrived`）或窗口到期后并入该单元。
        if (!state.firstDispatchDone && batchUnits.length === 1 && !state.done && firstMergeWindowCapMs > 0) {
          const outcome = await waitFirstMergeWindow(state, messageID);
          if (outcome === "cancel") {
            // 打断优先级最高：不派发，清空待读文本/预取（与上面打断分支同语义）
            discardPrefetch(state);
            state.queue.length = 0;
            state.carry = "";
            if (state.worker) await closeWorker(state);
            break;
          }
          state.firstDispatchDone = true;
          log.info(
            `自动朗读首句合并窗：message=${messageID} outcome=${outcome} windowMs=${lastMergeWindowMs}`,
          );
          const mergedFirst = mergeNewSentencesIntoFirstUnit(state, batchUnits[0]);
          batchUnits = [mergedFirst.unit, ...mergedFirst.rest];
        } else if (batchUnits.length > 0) {
          state.firstDispatchDone = true;
        }
        for (let index = 0; index < batchUnits.length; index += 1) {
          const unit = batchUnits[index];
          if (unit.trim().length === 0) continue;
          // 同批的下一单元正文已确定：在**当前单元开始播放后**预取它（深度 1；优先于队列）
          const following = batchUnits[index + 1];
          await deliverNext(state, unit, messageID, following);
          // worker 死亡/打断置位后不再继续投递本批剩余单元
          if (interrupted.has(messageID)) break;
        }
        if (interrupted.has(messageID)) {
          discardPrefetch(state);
          state.queue.length = 0;
          state.carry = "";
          break;
        }
        // 已预取的下一单元必须先交播（它在队列里更靠前）；硬切留到下一轮，避免丢句/乱序
        if (state.prefetch) continue;
        // 无标点超长尾巴兜底：累计 carry 超上限＝「单句超上限」唯一场景 → 句内硬切（防无限攒到 done）
        if (!state.done && state.carry.length > DRAIN_MERGE_MAX_CHARS) {
          const head = state.carry.slice(0, DRAIN_MERGE_MAX_CHARS);
          state.carry = state.carry.slice(DRAIN_MERGE_MAX_CHARS);
          state.firstDispatchDone = true;
          await deliverNext(state, head, messageID);
        }
      }
    })();
    state.loop = loop.finally(() => {
      state.loop = null;
    });
    return state.loop;
  };

  /**
   * 当前待读文本里是否已有**完整句单元**（首句合并窗可立即并入首单元）。
   * 只在合并窗等待期间调用——否则每个增量都做一次切句是浪费。
   * @param state 消息状态
   * @returns 有可合并的完整句返回 true
   */
  const hasMergeableUnit = (state: StreamState): boolean =>
    splitDrainUnits(state.carry + state.queue.join("")).units.length > 0;

  /**
   * 把一块待读文本加入队列并触发串行播放（同时累计诊断）。
   * @param state 消息状态
   * @param chunk 待读文本（一个增量块）
   * @param messageID 消息 id
   */
  const enqueue = (state: StreamState, chunk: string, messageID: string): void => {
    // 打断水位：该消息已被 interrupt() 置位 → 丢弃新块（不再进队、不再计数）
    if (interrupted.has(messageID)) return;
    state.queue.push(chunk);
    const counters = diagFor(messageID, state.sessionID);
    counters.chunks += 1;
    counters.chars += chunk.length;
    // 观测「句间到达间隔」（与切句同一口径：本块含句末标点即视为一句到达）：
    // 只统计同一消息内的相邻句，最终用于**下一条消息**首句合并窗的自适应上限。
    if (splitSentenceSpans(chunk).spans.length > 0) {
      const now = Date.now();
      if (lastSentenceBoundary?.messageID === messageID) {
        lastObservedSentenceGapMs = now - lastSentenceBoundary.at;
      }
      lastSentenceBoundary = { messageID, at: now };
    }
    void drain(state, messageID);
    // 首句合并窗等待中又完成了一整句：立即结算并合并（不必等满窗口）——只在真有可合并单元时唤醒
    if (state.wakeFirstWindow && hasMergeableUnit(state)) state.wakeFirstWindow("arrived");
    // 播放中到达的文本：一形成完整句就提前合成下一单元（预取的最大收益路径）
    maybeStartPrefetch(state, messageID);
  };

  /**
   * 把各 part 已观察到但未送出的尾部文本经分块器送出（快照/增量共用）。
   * @param state 消息状态
   * @param messageID 消息 id
   */
  const flushPending = (state: StreamState, messageID: string): void => {
    for (const entry of state.parts.values()) {
      if (entry.flushed >= entry.text.length) continue;
      const pending = entry.text.slice(entry.flushed);
      entry.flushed = entry.text.length;
      // 阈值 + 增量：未达 streamMinChars 时先缓冲（发送时随到随发），不做句切分
      for (const chunk of state.chunker.push(pending)) enqueue(state, chunk, messageID);
    }
  };

  /** 取（或建）消息的增量状态。 */
  const stateFor = (messageID: string, sessionID: string): StreamState => {
    const existing = streams.get(messageID);
    if (existing) return existing;
    const created: StreamState = {
      sessionID,
      parts: new Map<string, PartStreamState>(),
      queue: [],
      carry: "",
      loop: null,
      done: false,
      chunker: createStreamChunker({ minChars: effectiveMinChars }),
      followBroken: false,
      firstDispatchDone: false,
      playing: false,
    };
    streams.set(messageID, created);
    return created;
  };

  /**
   * 处理一条 `message.part.updated`：登记 part 类型；text part 用全量快照校准后按「阈值 + 增量」送入 TTS。
   * @param event 事件
   */
  const handlePart = (event: MessagePartUpdatedEvent): void => {
    const part = event.properties?.part;
    if (!part) return;
    const messageID = part.messageID;
    const sessionID = part.sessionID;
    if (typeof messageID !== "string" || messageID.length === 0) return;
    if (typeof sessionID !== "string" || sessionID.length === 0) return;
    // 非 text part（reasoning/tool/…）只登记类型，供 delta 过滤（不读）
    if (part.type !== "text") {
      learnPartMeta(part);
      return;
    }
    // 子会话硬跳过（fail-closed）：未知期间也跳过，等判定完成后再由 text-end 快照兜底
    if (childGateBlocks(sessionID)) return;
    if (!readAutoTts(sessionID, pathOptions)) return;
    if (seenFor(sessionID).has(messageID)) return;
    const counters = diagFor(messageID, sessionID);
    counters.partEvents += 1;
    const partID = learnPartMeta(part);
    // 无 part id（非真实事件形态）：无法关联 delta/偏移，交给完成回退
    if (!partID) return;
    if (!gateAllows(messageID, sessionID, counters)) {
      // 被角色门挡过 → taint：后续 delta 一律丢弃，等 text-end 快照整段重发（保住「前缀」不变式）
      const meta = partMeta.get(partID);
      if (meta) meta.tainted = true;
      return;
    }
    if (typeof part.text !== "string") return;
    // 打断水位：该消息已被 interrupt() 置位 → 不再快照校准/补发（新块一律丢弃）
    if (interrupted.has(messageID)) return;
    const state = stateFor(messageID, sessionID);
    const entry = state.parts.get(partID) ?? { text: "", flushed: 0 };
    state.parts.set(partID, entry);
    // 快照覆盖：不短于已送偏移时以快照为准（全量快照比 delta 抗丢失/乱序）
    if (part.text.length >= entry.flushed) entry.text = part.text;
    flushPending(state, messageID);
  };

  /**
   * 处理一条 `message.part.delta`：文本流式的**真正增量通道**（`text-delta` 只发这个事件，payload 无 part）。
   * 类型靠 part 起始快照登记表过滤（reasoning 也走 delta）；被角色门挡过的 part（`tainted`）的 delta
   * 一律丢弃，由 text-end 快照整段重发兜底（保住「entry.text 恒为真实文本前缀」不变式）。
   * @param event 事件
   */
  const handleDelta = (event: MessagePartDeltaEvent): void => {
    const props = event.properties;
    if (!props) return;
    const { messageID, sessionID, partID } = props;
    if (typeof messageID !== "string" || messageID.length === 0) return;
    if (typeof sessionID !== "string" || sessionID.length === 0) return;
    if (typeof partID !== "string" || partID.length === 0) return;
    if (typeof props.delta !== "string" || props.delta.length === 0) return;
    // field 恒为 "text"（text 与 reasoning 共用）；防御性只认 text
    if (props.field !== undefined && props.field !== "text") return;
    // 子会话硬跳过（fail-closed）
    if (childGateBlocks(sessionID)) return;
    // delta 高频：读开关走 TTL 缓存（立即停由 drain 派生前的实时读保证）
    if (!isAutoTtsOnCached(sessionID)) return;
    if (seenFor(sessionID).has(messageID)) return;
    const counters = diagFor(messageID, sessionID);
    counters.deltaEvents += 1;
    // 打断水位：该消息已被 interrupt() 置位 → 丢弃新块（不入文本、不入队；事件仍计入 deltas 便于排查）
    if (interrupted.has(messageID)) return;
    const meta = partMeta.get(partID);
    // 未见过该 part 的起始快照（text-start/reasoning-start 的 part.updated）→ 无法判定类型，丢弃（完成快照兜底）
    if (!meta || meta.type !== "text" || meta.skip || meta.tainted) return;
    if (!gateAllows(messageID, sessionID, counters)) {
      // 角色门挡过 → taint：此后该 part 的 delta 全丢（空洞会破坏快照的前缀偏移推算）
      meta.tainted = true;
      return;
    }
    const state = stateFor(messageID, sessionID);
    const entry = state.parts.get(partID) ?? { text: "", flushed: 0 };
    state.parts.set(partID, entry);
    entry.text += props.delta;
    flushPending(state, messageID);
  };

  /**
   * 完成回退：未经过增量朗读的消息，取全部 parts 整段读（旧行为）。
   * 子会话判定在此 **await 单飞完成**再决策（fallback 是低频路径，不走 fail-closed）。
   * 打断水位：置位后的消息**不补读**（seen 已置，防「回退整段读」把被打断的消息又念一遍）。
   * @param sessionID 会话 id
   * @param messageID 消息 id
   */
  const runFallback = async (sessionID: string, messageID: string): Promise<void> => {
    try {
      // 子会话硬跳过：等判定完成（单飞），是子会话则打 skip 汇总并返回
      if (await awaitChildCheck(sessionID)) {
        logSummary(messageID, sessionID, "skip", "child");
        return;
      }
      // 开关关：静默跳过（不打汇总，避免关闭态刷屏；与旧行为一致）
      if (!readAutoTts(sessionID, pathOptions)) return;
      if (seenFor(sessionID).has(messageID)) return;
      rememberSeen(sessionID, messageID);
      // 打断水位（finalize 之后、取 parts 之前被置位的情形）：不整段补读
      if (interrupted.has(messageID)) {
        interrupted.delete(messageID);
        logSummary(messageID, sessionID, "skip", "interrupted");
        return;
      }
      const parts = await fetchParts(sessionID, messageID);
      const text = extractReplyText(parts);
      if (text.length === 0) return;
      // 打断水位（fetch 期间被置位的并发兜底）：不读
      if (interrupted.has(messageID)) {
        interrupted.delete(messageID);
        logSummary(messageID, sessionID, "skip", "interrupted");
        return;
      }
      // 会话级中断请求水位（回退整段读的 spawn 前；`deliverUnit` 只管增量路径，这里是第二条派生入口）
      if (applyInterruptRequest(messageID, sessionID)) {
        logSummary(messageID, sessionID, "skip", "interrupted");
        return;
      }
      await spawnSpeak(text, messageID, sessionID);
      logSummary(messageID, sessionID, "fallback", undefined, text.length);
    } catch (err) {
      log.warn("自动朗读处理失败", err as Error);
    } finally {
      inFlight.delete(messageID);
    }
  };

  /**
   * 聚合诊断：每消息一条 info（防刷屏），并清理该消息的诊断/part 登记。
   * @param messageID 消息 id
   * @param sessionID 会话 id
   * @param path 走的路径：`stream`=增量；`fallback`=完成回退整段读；`skip`=跳过（子会话 / 打断水位）
   * @param skipReason 跳过原因（仅 `path=skip` 时有值）：`child`=子会话；`interrupted`=打断水位
   * @param textLen 回退路径的整段字符数（覆盖 chars 展示）
   */
  const logSummary = (
    messageID: string,
    sessionID: string,
    path: "stream" | "fallback" | "skip",
    skipReason?: "child" | "interrupted",
    textLen?: number,
  ): void => {
    const counters: MessageDiag = diag.get(messageID) ?? {
      sessionID,
      partEvents: 0,
      deltaEvents: 0,
      roleMiss: 0,
      summarySkips: 0,
      chunks: 0,
      chars: 0,
    };
    log.info(
      `自动朗读汇总：message=${messageID} session=${sessionID} path=${path}` +
        (skipReason ? ` skipReason=${skipReason}` : "") +
        ` parts=${counters.partEvents} deltas=${counters.deltaEvents} roleMiss=${counters.roleMiss}` +
        ` skips=${counters.summarySkips} chunks=${counters.chunks} chars=${textLen ?? counters.chars}`,
    );
    diag.delete(messageID);
  };

  /**
   * 助手消息完成：把增量剩余部分读出并标记去重；无增量记录则回退整段读。
   * 打断水位置位的消息**不补读**：直接 `seen.add`（防回退整段重读）并清理状态。
   * @param target 会话/消息 id
   */
  const finalize = (target: { sessionID: string; messageID: string }): void => {
    const { sessionID, messageID } = target;
    if (seenFor(sessionID).has(messageID)) return;
    const state = streams.get(messageID);
    // 打断水位：被打断的消息不再补读（flush 不发、也不走回退整段读），置 seen 封口
    if (interrupted.has(messageID)) {
      interrupted.delete(messageID);
      rememberSeen(sessionID, messageID);
      if (state) {
        discardPrefetch(state);
        for (const partID of state.parts.keys()) partMeta.delete(partID);
        streams.delete(messageID);
        logSummary(messageID, sessionID, "stream");
      } else {
        // 尚无流式状态（只过了角色门就被打断）：按 skip 记一条，说明「为什么整条没读完」
        logSummary(messageID, sessionID, "skip", "interrupted");
      }
      return;
    }
    if (!state) {
      if (inFlight.has(messageID)) return;
      inFlight.add(messageID);
      void runFallback(sessionID, messageID);
      return;
    }
    // 完成：先置 done（drain 末轮据此冲出 carry 尾段并关 follow worker），再冲刷剩余缓冲补齐朗读
    state.done = true;
    flushPending(state, messageID);
    for (const chunk of state.chunker.flush()) enqueue(state, chunk, messageID);
    // 首句合并窗等待者立即推进（流已结束：不再等窗口，直接派发当前首单元）
    state.wakeFirstWindow?.("done");
    // 无新块入队时也触发一轮 drain：终态收敛（关 follow worker / 空转即退）
    const settlement = drain(state, messageID);
    rememberSeen(sessionID, messageID);
    logSummary(messageID, sessionID, "stream");
    // **状态回收推迟到 drain 收敛之后**（2026-10-22 审计修复）：finalize 只代表「文本已完整」，
    // 队列/carry 还在异步播放。旧实现此刻就删 streams/partMeta ⇒ 之后 interrupt(sessionID) 看不到
    // 这条消息，尾段照念。改为在 settlement 收敛后统一摘除（完成后必清、不泄漏）。
    void settlement
      .catch((err: unknown) => {
        log.warn("自动朗读收尾失败（状态仍会清理）", err as Error);
      })
      .finally(() => {
        // 收敛后状态回收：预取槽若仍在（异常路径）一并取消，绝不残留子进程/临时文件
        discardPrefetch(state);
        if (streams.get(messageID) === state) streams.delete(messageID);
        for (const partID of state.parts.keys()) partMeta.delete(partID);
      });
  };

  return {
    handleEvent(event: unknown): void {
      if (!event || typeof event !== "object") return;
      const type = (event as { type?: unknown }).type;
      if (type === "message.part.updated") {
        handlePart(event as MessagePartUpdatedEvent);
        return;
      }
      if (type === "message.part.delta") {
        handleDelta(event as MessagePartDeltaEvent);
        return;
      }
      if (type !== "message.updated") return;
      const info = (event as MessageUpdatedEvent).properties?.info;
      if (info?.id && typeof info.role === "string") {
        roles.set(info.id, info.role);
        if (info.summary === true) summaries.add(info.id);
        if (roles.size > ROLE_CACHE_LIMIT) {
          const oldest = roles.keys().next().value;
          if (oldest !== undefined && oldest !== info.id) {
            roles.delete(oldest);
            summaries.delete(oldest);
          }
        }
      }
      // 开始时间记账（会话级中断水位的比较基准）：服务端 `time.created` 是**权威创建时刻**
      // （早于插件首次观察，故覆盖 `diagFor` 记的观察值）；该事件创建与完成各发一次、`created` 同值。
      if (typeof info?.id === "string" && info.id.length > 0 && typeof info.time?.created === "number") {
        rememberStart(info.id, info.time.created);
      }
      const target = completedAssistantMessage(event);
      if (target) finalize(target);
    },
    interrupt(sessionID?: string): void {
      stopInFlight(sessionID);
    },
    dispose(): void {
      stopInFlight();
    },
  };
}
