/**
 * **播放状态文件**：跨进程记录「当前正在播放 TTS 的进程 PID」，供**打断（barge-in）**按 PID 停止。
 *
 * 为什么用文件：播放可能由**不同进程**发起（server 插件派生的 CLI 子进程、TUI 插件、工具调用），
 * 而打断触发点又可能在另一进程（server `chat.message` / TUI `F8`·`F9`）。两者需要共享落点。
 * 落点：`~/.opencode/plugins-cache/opencode-emotions/tts-playback`（JSON），**原子写**。
 * **留 base 根、不进每会话目录**（用户口径，2026-10-20）：文件本身跨会话共用、瞬态自清，
 * 挪动会牵动 CLI/tool 的 spawn 链，无收益不动。
 *
 * **多条目 map（2026-10-21 第五批，跨会话混音）**：文件内容为 `{ [sessionID]: PlaybackEntry }`——
 * 每个会话一键、并行播放互不覆盖（旧单槽整文件覆盖写会让先播条目失踪、无法再被停）；
 * 无 sessionID（手动 speak）与**旧单条格式**（顶层有数值 `pid`）读作哨兵键
 * {@link PLAYBACK_OWNERLESS_KEY}（无主条目：任何会话的打断都可停）。
 * 产品口径（用户拍板）：**跨会话混音**（B 会话开播**不杀** A 会话，Windows 混音器天然多流并存）、
 * **单会话互斥**（同会话内新播顶旧播、发消息/F10 关仍立即停本会话）、**不做排队**。
 *
 * 安全红线：**只按记录里的 PID 终止本插件自己派生的 TTS 进程**，绝不按进程名/模式匹配杀；
 * 每个目标 PID 都需满足 `pid>1`、≠自身、未超 TTL（防 PID 复用误杀）；找不到/已退出**静默降级**。
 * 先 `SIGTERM`，有界超时（{@link SIGTERM_GRACE_MS}）后仍存活再 `SIGKILL`。
 * **双 PID（2026-10-21）**：`pid`（CLI node）+ 可选 `playerPid`（真正发声的孙进程，如 sapi 的 PowerShell）
 * **各自过红线后都杀**——Windows `TerminateProcess` 不杀子孙，只杀 `pid` 会让孙进程继续播完（用户实测缺陷）。
 */

import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import createLogger from "@xiaoqiong0v0/opencode-plugin-logger";
import type { Logger } from "@xiaoqiong0v0/opencode-plugin-logger";

import { autoTtsDataDir, PLAYBACK_FILE_NAME, writeFileAtomic, type AutoTtsOptions } from "./auto-tts.js";

/** 播放状态文件名（定义随 `auto-tts.ts` 的 base 根保留清单共用；此处 re-export 保持原导出面）。 */
export { PLAYBACK_FILE_NAME };
/**
 * 播放会话归属的环境变量名：**auto-read 派生 CLI 时按消息 sessionID 注入**（`spawnSpeak`/`spawnWorker`），
 * CLI 登记 `tts-playback` 时读取（`emotions-cli` `registerPlaybackLifecycle`）。走 **env 而非 argv**——
 * 免改 CLI 参数解析；手动 speak（工具/命令行）未设置该 env ⇒ 条目无主，任何消息可打断（有意兼容）。
 */
export const PLAYBACK_SESSION_ENV = "EMOTIONS_SESSION_ID";
/**
 * **无主条目**的 map 键（哨兵）：手动 speak（无 sessionID）与旧单条格式（顶层有数值 `pid`）都落此键。
 * 语义沿用「无主可被任意停止」；导出供单测与文档引用（opencode 会话 ID 恒为 `ses_` 前缀，不会撞键）。
 */
export const PLAYBACK_OWNERLESS_KEY = "_";
/** 状态条目被认为「新鲜」的最长时间（超过则视为陈旧，防 PID 复用误杀；每次读写时顺带清）。 */
export const PLAYBACK_TTL_MS = 30 * 60 * 1000;
/**
 * **短心跳 TTL**（毫秒）：仅用于「无法做 pid 存活探测」的条目（无 pid / pid 非法）。
 *
 * 旧口径把 `PLAYBACK_TTL_MS`(30min) 当活跃判据，导致「进程已死但条目仍新鲜」被当成正在播放：
 * ASR 半双工门最长 30 分钟内**静默吞掉真人语音**（审计 P1）。判活改为 pid 存活优先后，
 * 该常量只保留「刚登记、pid 尚未落盘」这一类窄窗口，取值 ≤15s，远小于 30min。
 */
export const PLAYBACK_FRESH_TTL_MS = 15_000;
/** `SIGTERM` 后升级到 `SIGKILL` 的等待（毫秒）。 */
export const SIGTERM_GRACE_MS = 1500;

const log: Logger = createLogger("playback");

/** 记录的一条播放状态。 */
export interface PlaybackEntry {
  /** 发起播放的进程 PID（CLI / `__play` 自身）。 */
  pid: number;
  /**
   * **真正发声**的子进程（孙进程）PID（如 sapi 的 PowerShell）；可选（旧格式无此字段）。
   * 为什么需要：Windows `TerminateProcess` 不杀子孙——只杀 `pid`（CLI node）会让 PowerShell 孙进程继续播完。
   * 由 CLI 在 `speak()` 返回后经 `TtsProvider.activePlayerPid?.()` 补写；流式 waveOut 路径（stdin EOF 自退）不登记。
   */
  playerPid?: number;
  /** TTS provider（如 aliyun/sapi/termux）。 */
  provider: string;
  /** 云 TTS 任务 ID（本地 provider 无）。 */
  taskId?: string;
  /** 记录时刻（毫秒时间戳）。 */
  startedAt: number;
  /** 来源标签（如 `speak`，含自动朗读派生的播放），便于排查。 */
  kind: string;
  /**
   * 播放归属会话（**可选**；旧格式/手动 speak 未设置时无此键=无主播放）。
   * 写入：auto-read 派生 CLI 时经 env {@link PLAYBACK_SESSION_ENV} 传递、CLI 登记时带入；
   * 读取：带 sessionID 的 `stopPlayback` 据此做跨会话隔离（无主条目任何消息都可打断）；
   * 存储：map 键恒为 `sessionID ?? PLAYBACK_OWNERLESS_KEY`（读写两侧同口径）。
   */
  sessionID?: string;
}

/** 状态文件读写选项（路径 + 可注入时钟；`now` 供 TTL 清理的确定性单测）。 */
export interface PlaybackFileOptions extends AutoTtsOptions {
  /** 当前时间；默认 `Date.now()`（用于读写时的陈旧条目清理）。 */
  now?: () => number;
}

/** 读写/停止选项（可注入以便单测，不真杀进程）。 */
export interface PlaybackStateOptions extends PlaybackFileOptions {
  /** 终止函数；默认 `process.kill(pid, signal)`。 */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** 存活探测；默认 `process.kill(pid, 0)`。 */
  isAlive?: (pid: number) => boolean;
  /**
   * 打断方所属会话（`chat.message`/TUI/CLI 清场按当前会话传入）：非空 → 只停「**该会话键 + 无主**」
   * 条目，条目 `sessionID` 存在且不等 → 跨会话**不杀**（不清状态、记一行 info）；
   * 空/缺省 → **停全部条目**（dispose/全清路径）。
   */
  sessionID?: string;
}

/**
 * 播放状态文件绝对路径。
 * @param options 路径选项
 * @returns `~/.opencode/plugins-cache/opencode-emotions/tts-playback`
 */
export function playbackStatePath(options: AutoTtsOptions = {}): string {
  return join(autoTtsDataDir(options), PLAYBACK_FILE_NAME);
}

/**
 * 读取播放状态（文件缺失/损坏 → 空；每次读取顺带清 TTL 陈旧条目并落盘）。
 * @param sessionID 会话键：非空 → 返回该键条目（无 → undefined）；缺省/空白 → 返回**全部条目**
 *   （`{ [sessionID|"_"]: PlaybackEntry }`，供无参 stop/测试盘点）
 * @param options 路径选项（`now` 可注入）
 * @returns 该键条目 / 全部条目 map
 */
export function readPlayback(sessionID: string, options?: PlaybackFileOptions): PlaybackEntry | undefined;
export function readPlayback(sessionID?: undefined, options?: PlaybackFileOptions): Record<string, PlaybackEntry>;
export function readPlayback(
  sessionID?: string | PlaybackFileOptions,
  options: PlaybackFileOptions = {},
): PlaybackEntry | Record<string, PlaybackEntry> | undefined {
  let key: string | undefined;
  let opts = options;
  if (typeof sessionID === "object" && sessionID !== null) {
    // 兼容旧调用形状 readPlayback(options)（JS 老调用方/未同步的测试）：防把对象误当 sessionID 读真实状态目录
    opts = sessionID;
    key = undefined;
  } else {
    key = sessionID;
  }
  const map = loadMap(opts);
  if (typeof key === "string" && key.length > 0) return map[key];
  return map;
}

/**
 * 原子写入播放状态：按 `entry.sessionID ?? PLAYBACK_OWNERLESS_KEY` **upsert 单键**、**不动其它键**
 * （跨会话并行播放互不覆盖；同会话重写 = 顶掉本会话旧条目 = 单会话互斥）。
 * @param entry 状态
 * @param options 路径选项（`now` 可注入）
 * @returns 是否写入成功（失败静默 false，不影响播放）
 */
export function writePlayback(entry: PlaybackEntry, options: PlaybackFileOptions = {}): boolean {
  try {
    const map = loadMap(options);
    const key = typeof entry.sessionID === "string" && entry.sessionID.length > 0
      ? entry.sessionID
      : PLAYBACK_OWNERLESS_KEY;
    map[key] = entry;
    return persistMap(map, options);
  } catch {
    return false;
  }
}

/**
 * 清除状态：删除**含该 pid 的条目**（`pid` 或 `playerPid` 匹配；多条命中时一并删，避免误留孤儿）。
 * @param pid 期望的 PID
 * @param options 路径选项（`now` 可注入）
 */
export function clearPlayback(pid: number, options: PlaybackFileOptions = {}): void {
  const map = loadMap(options);
  const next: Record<string, PlaybackEntry> = {};
  let changed = false;
  for (const [key, entry] of Object.entries(map)) {
    if (entry.pid === pid || entry.playerPid === pid) {
      changed = true;
      continue;
    }
    next[key] = entry;
  }
  if (changed) persistMap(next, options);
}

/**
 * 进程存活探测（`process.kill(pid, 0)`：EPERM 表示存在但无权限 → 视为存活）。
 * @param pid 进程 PID
 * @returns 存活 true
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * 停止播放（多条目）：读 map → **逐条目**过会话归属门 → 对每条目的 **`pid` 与 `playerPid` 两个目标**
 * 各自过红线后 `SIGTERM`（有界超时后 `SIGKILL`）→ 清该条目。
 *
 * **多条目语义表（2026-10-21 第五批）**：
 * | 操作 | sessionID | 行为 |
 * | --- | --- | --- |
 * | stop | 非空 | 停「该会话键 + 无主条目」；条目 `sessionID` 存在且不等 → 跳过（info 一行） |
 * | stop | 空/缺省 | 停**全部条目**（dispose/全清） |
 * | write | —（看 `entry.sessionID`） | 按 `sessionID ?? "_"` upsert 单键，不动其它键 |
 * | read | 非空 | 该键条目（无 → undefined） |
 * | read | 空/缺省 | 全部条目（键 map） |
 * | clear | —（按 pid） | 删**含该 pid**（`pid`/`playerPid`）的条目，可能多条 |
 * | 旧单条格式 | — | 顶层有数值 `pid` → 读作无主键 `_`（无主可被任意停止） |
 *
 * 为什么两个都杀：`pid` 是 CLI（node）进程，`playerPid` 是真正发声的孙进程（如 sapi 的 PowerShell）；
 * Windows `TerminateProcess` 不杀子孙——只杀 `pid` 会让孙进程继续把当前块播完（用户实测缺陷）。
 * 静默降级：无记录 / 条目陈旧（超 TTL，读取时已清）/ 目标都不可杀（`<=1`、指向自身、已退出）→ 不杀。
 * 日志（`createLogger("playback")`）：成功停止每条记 info `stopped playback session=<id|-> provider=<…>`；
 * 跨会话跳过每条记一行 info（低噪，一行，带双方 session 键）。
 * @param options 选项（路径/注入的 kill·isAlive·now/`sessionID` 会话范围）
 * @returns 是否发出了终止信号（任一目标命中即 true；全部跳过为 false）
 */
export function stopPlayback(options: PlaybackStateOptions = {}): boolean {
  const map = loadMap(options);
  const wanted = typeof options.sessionID === "string" ? options.sessionID.trim() : "";
  const kill = options.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
  const isAlive = options.isAlive ?? isProcessAlive;
  let signaled = false;
  // 逐条目：门（带 sessionID 且条目有主且不等 → 跳过）→ 红线流程（TERM→KILL）→ 清条目
  for (const entry of Object.values(map)) {
    const owned = typeof entry.sessionID === "string" && entry.sessionID.length > 0;
    if (wanted.length > 0 && owned && entry.sessionID !== wanted) {
      log.info(
        `skipped cross-session stop: session=${wanted} entry=${entry.sessionID} provider=${entry.provider}`,
      );
      continue;
    }
    if (stopOneEntry(entry, { options, kill, isAlive })) signaled = true;
  }
  return signaled;
}

/** 单条播放条目的活跃判定结果。 */
export type PlaybackLiveness =
  /** 至少一个 pid（`pid`/`playerPid`）确认存活。 */
  | "active"
  /** 所有可探测 pid 都确认已死（可安全清理）。 */
  | "dead"
  /** 探测抛错/无法判定——调用方必须按「不阻断」处理（fail-open，见判活函数）。 */
  | "unknown"
  /** 没有可探测 pid，但条目仍在短心跳窗口内（{@link PLAYBACK_FRESH_TTL_MS}）。 */
  | "fresh";

/**
 * 判定单条播放条目的活跃性（纯函数，可用注入的探测函数离线单测）。
 *
 * 口径（审计 P1 修复：「新鲜」不再等于「在播」）：
 * - 有 `pid`/`playerPid` 且任一探测为存活 → `active`；
 * - 全部探测为死 → `dead`（调用方清理，不得残留阻断后续）；
 * - 探测抛错 → `unknown`（**不能**据此阻断；丢语音比多一次回声更不可接受）；
 * - 没有可探测 pid（外部/旧格式未带）→ 短 TTL 内 `fresh`，超出即 `dead`。
 * @param entry 播放条目
 * @param now 当前时间戳（毫秒）
 * @param isAlive 存活探测（默认 `process.kill(pid, 0)` 语义；EPERM 视为存活）
 * @returns 活跃判定结果
 */
export function classifyPlaybackEntry(
  entry: PlaybackEntry,
  now: number,
  isAlive: (pid: number) => boolean = isProcessAlive,
): PlaybackLiveness {
  const candidates = [entry.pid, entry.playerPid].filter(
    (pid): pid is number => typeof pid === "number" && Number.isInteger(pid) && pid > 0,
  );
  if (candidates.length === 0) {
    const fresh =
      Number.isFinite(now) &&
      Number.isFinite(entry.startedAt) &&
      now - entry.startedAt <= PLAYBACK_FRESH_TTL_MS;
    return fresh ? "fresh" : "dead";
  }
  let probeFailed = false;
  for (const pid of new Set(candidates)) {
    try {
      if (isAlive(pid)) return "active";
    } catch {
      probeFailed = true;
    }
  }
  return probeFailed ? "unknown" : "dead";
}

/**
 * **F10 双态中断判活**（2026-10-22）：该会话（或**无主**）是否存在「可中断的活跃播放」。
 *
 * 会话归属口径与 {@link stopPlayback} **完全一致**（同源 `loadMap` + 同一道归属门）：
 * `sessionID` 非空 → 只看「该会话键条目 + 无主条目」，其它会话的条目**一律不算**；
 * `sessionID` 空/空白 → 全部条目都算（与无参 stop 停全部同口径）。
 *
 * 「活跃」判据（{@link classifyPlaybackEntry}）：
 * 1. `pid` 或 `playerPid` **进程存活**——正常在播（`process.kill(pid,0)`；EPERM 视为存活）；
 * 2. 无 pid 的条目只在 {@link PLAYBACK_FRESH_TTL_MS}（≤15s）短窗口内算活跃；
 * 3. 探测抛错/无法判定 → **不阻断**（fail-open 到「不丢语音」）。
 * 确认已死的条目在本次调用内**就地清理并落盘**，不再残留阻断后续判定。
 *
 * 消费方：① TUI `toggleAutoRead`（F10）——为真则本次按键**只中断播放、不切换开关**；
 * ② TUI `dispatch()` 的**半双工静音门**（2026-10-22，`voice/asr-gate.ts`）——为真则**丢弃该条 ASR final**，
 * 掐断「朗读→麦克风→转文字→注入→再朗读」回环（AEC 实测 unsupported 的兜底）。
 * 本函数只读状态、必要时清理死条目，**绝不杀进程**；任何内部异常都降级为 false（不阻断）。
 * @param sessionID 打断方会话 id（空/空白=全部条目）
 * @param nowMs 当前时间戳（毫秒；缺省用 `options.now ?? Date.now()`）
 * @param options 路径/时钟选项 + 存活探测注入（`isAlive`，单测不真探进程）
 * @returns 是否存在可中断的活跃播放
 */
export function isInterruptablePlaybackActive(
  sessionID: string,
  nowMs?: number,
  options: PlaybackFileOptions & { isAlive?: (pid: number) => boolean } = {},
): boolean {
  try {
    const map = loadMap(options);
    const wanted = typeof sessionID === "string" ? sessionID.trim() : "";
    const now =
      typeof nowMs === "number" && Number.isFinite(nowMs) ? nowMs : (options.now ?? (() => Date.now()))();
    const isAlive = options.isAlive ?? isProcessAlive;
    const deadKeys: string[] = [];
    let active = false;
    // 逐条目：会话归属门（与 stopPlayback 同口径：有主且不等 → 跳过）→ 存活探测/短 TTL
    for (const [key, entry] of Object.entries(map)) {
      const owned = typeof entry.sessionID === "string" && entry.sessionID.length > 0;
      if (wanted.length > 0 && owned && entry.sessionID !== wanted) continue;
      const state = classifyPlaybackEntry(entry, now, isAlive);
      if (state === "active" || state === "fresh") active = true;
      else if (state === "dead") deadKeys.push(key);
      // state="unknown"：探测失败 → 不阻断（fail-open）
    }
    if (deadKeys.length > 0) {
      for (const key of deadKeys) delete map[key];
      if (persistMap(map, options)) {
        log.info(`pruned dead playback entries: count=${deadKeys.length} keys=${deadKeys.join(",")}`);
      }
    }
    return active;
  } catch (err) {
    // 判活绝不能拖垮分发/热键：任何意外一律按「无活跃播放」处理（不丢语音）
    log.warn("playback liveness check failed; treated as inactive", err as Error);
    return false;
  }
}

/**
 * **TUI 退出停播**：对一批会话逐个 `stopPlayback({ sessionID })`——每个会话**恰好停一次**，
 * 单个会话停止失败/抛错**不中断**其余会话（dispose 路径绝不抛）。
 *
 * 调用方：`tui.tsx` `api.lifecycle.onDispose` 遍历本窗口 `touchedSessions`（修「Ctrl+C 退出还在读」：
 * 旧 dispose 只 `stopRuntime()` 停语音输入 runtime，TTS 的 CLI worker + 发声孙进程（PowerShell）
 * 不属 runtime → 窗口退出后成孤儿、stdin 管道缓冲里已投递的句子继续播完）。
 * 会话语义：只停**本窗口见过的会话**，不误杀其它窗口的会话；**已知取舍**——两窗口开着**同一会话**
 * 时一窗退出会连带停掉该会话的播放（互停）。崩溃路径（未及 dispose）孤儿尾巴属已知残余：
 * CLI/PowerShell 的 stdin 管道 EOF 收尾机制保留。
 * @param sessionIDs 会话 id 列表（空/空白 id 跳过，不调 stop）
 * @param stop 停止函数注入（默认 `stopPlayback`；单测注入 mock 断言逐会话一次）
 * @returns 实际发出终止信号的会话 id 列表（按入参顺序）
 */
export function stopPlaybackForSessions(
  sessionIDs: Iterable<string>,
  stop: (options: PlaybackStateOptions) => boolean = stopPlayback,
): string[] {
  const stopped: string[] = [];
  for (const sid of sessionIDs) {
    if (typeof sid !== "string" || sid.trim().length === 0) continue;
    try {
      if (stop({ sessionID: sid })) stopped.push(sid);
    } catch {
      // 单会话停止失败不影响其余会话的停播
    }
  }
  return stopped;
}

/** 单条目的停止依赖（从 {@link stopPlayback} 闭包传入，便于私有化签名）。 */
interface StopEntryDeps {
  options: PlaybackStateOptions;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  isAlive: (pid: number) => boolean;
}

/**
 * 停止单条目：`pid`+`playerPid` 去重后逐个过红线（`>1`、≠自身、存活），先 TERM、1.5s 后仍存活升级 KILL，
 * 成功/无目标都清该条目（按 pid 删，避免孤儿）。陈旧条目已在 `loadMap` 清除，此处不再查 TTL。
 * @param entry 待停条目（已过会话归属门）
 * @param deps 终止/存活探测/路径选项
 * @returns 是否发出了终止信号（任一目标命中即 true）
 */
function stopOneEntry(entry: PlaybackEntry, deps: StopEntryDeps): boolean {
  const candidates: number[] = [entry.pid];
  if (typeof entry.playerPid === "number") candidates.push(entry.playerPid);
  const targets = [...new Set(candidates)].filter((pid) => pid > 1 && pid !== process.pid && deps.isAlive(pid));
  if (targets.length === 0) {
    clearPlayback(entry.pid, deps.options);
    return false;
  }
  let signaled = false;
  for (const pid of targets) {
    try {
      deps.kill(pid, "SIGTERM");
      signaled = true;
    } catch {
      // 单个目标失败（瞬退/无权限）不影响其余目标
    }
  }
  if (!signaled) {
    clearPlayback(entry.pid, deps.options);
    return false;
  }
  const timer = setTimeout(() => {
    for (const pid of targets) {
      try {
        if (deps.isAlive(pid)) deps.kill(pid, "SIGKILL");
      } catch {
        // 升级失败忽略
      }
    }
  }, SIGTERM_GRACE_MS);
  timer.unref?.();
  clearPlayback(entry.pid, deps.options);
  log.info(`stopped playback session=${entry.sessionID ?? "-"} provider=${entry.provider}`);
  return true;
}

/**
 * 载入并校验播放 map（每次读写顺带清 TTL 陈旧条目/非法条目并落盘）。
 * 兼容：**旧单条格式**（顶层有数值 `pid`）→ 视为无主条目（键 `PLAYBACK_OWNERLESS_KEY`）；
 * 损坏文件 → 清掉并按空处理（与旧 `clearPlayback`「损坏即清理」一致，静默降级）。
 * @param options 路径选项（`now` 可注入）
 * @returns 键归一后的 map（键 = `entry.sessionID ?? PLAYBACK_OWNERLESS_KEY`）
 */
function loadMap(options: PlaybackFileOptions = {}): Record<string, PlaybackEntry> {
  const raw = readRaw(options);
  if (raw === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    removeStateFile(options);
    return {};
  }
  const map: Record<string, PlaybackEntry> = {};
  let dropped = false;
  if (isLegacySingleEntry(parsed)) {
    const entry = parseEntry(parsed);
    if (entry) map[PLAYBACK_OWNERLESS_KEY] = entry;
    else dropped = true;
  } else if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    for (const [rawKey, value] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = parseEntry(value);
      if (!entry) {
        dropped = true;
        continue;
      }
      // 键归一：entry 带 sessionID 则以其为键（读写同口径），否则保留原键（无主 = `_`）
      const key = entry.sessionID ?? (rawKey.length > 0 ? rawKey : PLAYBACK_OWNERLESS_KEY);
      map[key] = entry;
    }
  } else {
    dropped = true; // 顶层非对象（null/数字/字符串/数组）：无可救条目
  }
  if (purgeStale(map, (options.now ?? Date.now)())) dropped = true;
  if (dropped) persistMap(map, options);
  return map;
}

/**
 * 校验单条状态（字段非法 → undefined；可选字段合法才带键，不给旧格式多出键）。
 * @param raw 解析后的原始值
 * @returns 合法条目；非法 → undefined
 */
function parseEntry(raw: unknown): PlaybackEntry | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const data = raw as Partial<PlaybackEntry>;
  if (typeof data.pid !== "number" || !Number.isInteger(data.pid) || data.pid <= 0) return undefined;
  if (typeof data.provider !== "string" || typeof data.startedAt !== "number") return undefined;
  const entry: PlaybackEntry = {
    pid: data.pid,
    provider: data.provider,
    taskId: typeof data.taskId === "string" ? data.taskId : undefined,
    startedAt: data.startedAt,
    kind: typeof data.kind === "string" ? data.kind : "",
  };
  // playerPid 可选（旧格式无此字段）：合法正整数才带上
  if (typeof data.playerPid === "number" && Number.isInteger(data.playerPid) && data.playerPid > 0) {
    entry.playerPid = data.playerPid;
  }
  // sessionID 可选（旧格式/手动 speak 无此字段）：非空字符串才带上
  if (typeof data.sessionID === "string" && data.sessionID.length > 0) {
    entry.sessionID = data.sessionID;
  }
  return entry;
}

/**
 * 判定「旧单条格式」：顶层对象直接带数值 `pid`（新 map 格式的键是会话 ID、`pid` 在值里）。
 * @param parsed JSON.parse 结果
 * @returns 是旧单条格式 true
 */
function isLegacySingleEntry(parsed: unknown): boolean {
  return typeof parsed === "object" && parsed !== null && typeof (parsed as { pid?: unknown }).pid === "number";
}

/**
 * 清除陈旧条目（`now - startedAt > PLAYBACK_TTL_MS`；防 PID 复用误杀，多条目下逐键判）。
 * @param map 待清理的 map（原地删）
 * @param now 当前时间戳
 * @returns 是否有条目被清
 */
function purgeStale(map: Record<string, PlaybackEntry>, now: number): boolean {
  let changed = false;
  for (const [key, entry] of Object.entries(map)) {
    if (now - entry.startedAt > PLAYBACK_TTL_MS) {
      delete map[key];
      changed = true;
    }
  }
  return changed;
}

/**
 * 持久化 map：空 map → 删文件（与旧行为「清完即删」一致）；非空 → 原子写。
 * @param map 条目 map
 * @param options 路径选项
 * @returns 是否写入成功（失败静默 false）
 */
function persistMap(map: Record<string, PlaybackEntry>, options: AutoTtsOptions): boolean {
  try {
    const path = playbackStatePath(options);
    if (Object.keys(map).length === 0) {
      rmSync(path, { force: true });
      return true;
    }
    writeFileAtomic(path, JSON.stringify(map));
    return true;
  } catch {
    return false;
  }
}

/** 删除状态文件（静默失败）。 */
function removeStateFile(options: AutoTtsOptions): void {
  try {
    rmSync(playbackStatePath(options), { force: true });
  } catch {
    // 清理失败忽略
  }
}

/** 读原始状态文件文本（失败/缺失 → undefined）。 */
function readRaw(options: AutoTtsOptions): string | undefined {
  try {
    return readFileSync(playbackStatePath(options), "utf8");
  } catch {
    return undefined;
  }
}
