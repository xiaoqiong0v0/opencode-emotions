/**
 * **半双工静音门**：TTS 播放期间**丢弃** ASR final，掐断「朗读 → 麦克风 → 转文字 → 注入 → 再朗读」回环。
 *
 * 为什么需要（一手证据）：本机 AEC（回声消除）实测 **unsupported**——麦克风采集流录到了默认输出设备
 * 正在播放的 TTS，播放窗能量为独立基线的 **19.2 倍（25.7 dB）**，远超 3 倍（≈10 dB）判据；原始 dshow
 * 采集路径上没有生效的 AEC（报告：`.tmp/scratch/aec-probe-report.md`，2026-10-22）。
 * 故按既定口径走「播放时闭嘴」的**半双工**兜底：**识别照常跑**，只在**分发层**不消费结果
 * （runtime / ffmpeg 层不做任何静音，避免把「听不见」做进采集链）。
 *
 * 会话归属口径**只复用** `playback-state.ts` 的 `isInterruptablePlaybackActive(sessionID)`
 * （与 `stopPlayback`、F10 双态中断同一道归属门：只看**本会话键 + 无主 `_`** 条目，其它会话一律不算）。
 * 本模块**不读状态文件、不自造归属判断**，只承载「活跃 ∪ 尾音窗口」这一条纯条件，便于单测。
 *
 * 尾音窗口（{@link ASR_GATE_TAIL_MS}）：每次判活为真把窗口起点刷新为当刻，之后
 * `now - lastActiveAt < tailMs` 内仍算活跃——覆盖播放结束后的尾音与房间混响
 * （waveOut 队列约 160ms 预读 + 实测混响），避免「刚停就把剩下的尾音录进去」。
 *
 * 半双工代价（**预期行为，非缺陷**）：播放期间用户说话会被吞掉；要先说则按 F8/F9 或 F10
 * （两者都会 `stopPlayback` 停播，门随之自动释放）。
 */

import { PLAYBACK_OWNERLESS_KEY } from "./playback-state.js";

/**
 * 播放结束后的**尾音缓冲**窗口（毫秒）：此窗口内的 ASR final 仍被丢弃。
 * 取值依据：内置 waveOut 播放器 EOF 后只播完已排队的 ≈160ms（`docs/ASYNC.md` 不变量），
 * 加上房间混响与「刚停就开口」的说话起始，500ms 足够覆盖且不至于把用户下一句吞太久。
 */
export const ASR_GATE_TAIL_MS = 500;

/**
 * 关闭语音模式后的 **final 宽限窗口**（毫秒）：按 F8/F9 关闭后，runtime 优雅停止时会先冲刷
 * 最后一段并等 ASR 回包；这段时间模式信号已经是 off，若只按当前开关判定，这条 final 会被静默丢弃
 * （2026-10-24 根因）。故关闭后、且会话一致的 final 仍按**关闭前的模式**投递：
 * - **停止进行中**（`stopping=true`）**始终允许**：优雅停止最长 10s、单段 HTTP 超时 60s，按固定 3s
 *   截断会丢掉慢回包的尾段；
 * - **停止结束后**再给 {@link STOP_FINAL_GRACE_MS}（3s）宽限，覆盖回调/事件排队的最后一点延迟，
 *   同时避免把很久以后才到的迟到结果误投到已关闭的模式。
 */
export const STOP_FINAL_GRACE_MS = 3000;

/** 语音模式（与 TUI 的 `SlotMode` 同形；本模块只做分发决策，不依赖 UI 模块）。 */
export type AsrDeliveryMode = "inject" | "input";

/** 「最近一次关闭的语音模式」记录（由 TUI 在模式关闭时写入）。 */
export interface LastClosedVoiceMode {
  /** 关闭的模式。 */
  mode: AsrDeliveryMode;
  /** 关闭时所在会话；取不到路由时按无主口径（见 {@link resolveFinalDelivery}）。 */
  sessionID: string | undefined;
  /** 关闭时刻（毫秒时间戳）。 */
  at: number;
}

/** 分发决策：投递（按哪个模式、是否走宽限）或丢弃（原因）。 */
export type FinalDeliveryDecision =
  | { delivered: true; mode: AsrDeliveryMode; viaGrace: boolean }
  | { delivered: false; reason: "no-active-mode" | "session-mismatch" | "grace-expired" };

/**
 * 决定一条 ASR final 由哪个模式处理（含停止后的宽限投递）。
 *
 * 判定顺序：① 当前 `injectOn` → 注入；② 当前 `inputOn` → 追加；③ 都关时，若会话一致且
 * （**停止进行中** 或 距最近一次关闭 ≤ graceMs）→ 按**那次关闭的模式**投递（`viaGrace=true`）；
 * ④ 否则丢弃并给出原因。
 * 会话一致口径复用播放状态的哨兵键：`sessionID ?? PLAYBACK_OWNERLESS_KEY`，取不到路由时只与
 * 「关闭时也取不到」配对，**不越界匹配其它会话**。
 * @param params 当前开关、最近关闭记录、当前会话、当前时刻与「是否正在停止」（时刻/停止态可注入，便于单测）
 * @param graceMs 停止结束后的宽限窗口（毫秒；`<=0` 或非有限值表示关闭宽限；停止进行中不受此限）
 * @returns 投递/丢弃决策
 */
export function resolveFinalDelivery(
  params: {
    injectOn: boolean;
    inputOn: boolean;
    lastClosed?: LastClosedVoiceMode | null;
    currentSessionID?: string;
    now: number;
    stopping?: boolean;
  },
  graceMs: number = STOP_FINAL_GRACE_MS,
): FinalDeliveryDecision {
  if (params.injectOn) return { delivered: true, mode: "inject", viaGrace: false };
  if (params.inputOn) return { delivered: true, mode: "input", viaGrace: false };
  const last = params.lastClosed;
  if (!last) return { delivered: false, reason: "no-active-mode" };
  const closedKey = last.sessionID ?? PLAYBACK_OWNERLESS_KEY;
  const currentKey = params.currentSessionID ?? PLAYBACK_OWNERLESS_KEY;
  if (closedKey !== currentKey) return { delivered: false, reason: "session-mismatch" };
  // 停止进行中：优雅停止可能等 10s、单段 HTTP 可到 60s，固定宽限会误丢慢回包
  if (params.stopping === true) return { delivered: true, mode: last.mode, viaGrace: true };
  if (!Number.isFinite(graceMs) || graceMs <= 0) return { delivered: false, reason: "grace-expired" };
  const ageMs = params.now - last.at;
  // 时钟回拨（ageMs<0）按过期处理：宽限只服务「刚关闭」，不回退时间
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > graceMs) {
    return { delivered: false, reason: "grace-expired" };
  }
  return { delivered: true, mode: last.mode, viaGrace: true };
}

/**
 * 门条件：这条 ASR final 是否应当**丢弃**（播放活跃，或播放刚结束仍在尾音窗口内）。
 *
 * 纯函数、无副作用；活跃判定由调用方经 `isInterruptablePlaybackActive` 得出后传入，
 * 本函数不读状态文件、不认识会话（归属口径不在这里）。
 * @param playbackActive 本会话（或无主）当前是否有可中断的活跃播放
 * @param lastActiveAt 上一次判活为真的时刻（毫秒时间戳；`0`/非有限值 = 本进程从未观察到活跃）
 * @param now 当前时刻（毫秒时间戳）
 * @param tailMs 尾音窗口长度（毫秒；缺省 {@link ASR_GATE_TAIL_MS}，`<=0` 表示关闭尾音窗口）
 * @returns true = 丢弃该条 final；false = 照常分发
 */
export function shouldDropAsrFinal(
  playbackActive: boolean,
  lastActiveAt: number,
  now: number,
  tailMs: number = ASR_GATE_TAIL_MS,
): boolean {
  // 正在播：无条件丢（尾音窗口无关）
  if (playbackActive) return true;
  // 从未活跃过 / 非法时刻：没有可覆盖的尾巴，放行
  if (!Number.isFinite(lastActiveAt) || lastActiveAt <= 0) return false;
  if (!Number.isFinite(now) || !Number.isFinite(tailMs) || tailMs <= 0) return false;
  // 严格小于：恰好经过 tailMs 即放行；时钟回拨（now < lastActiveAt）差值为负 ⇒ 仍判在窗口内丢弃（保守取向）
  return now - lastActiveAt < tailMs;
}
