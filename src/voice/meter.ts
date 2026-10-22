/**
 * 麦克风电平（RMS → 归一化 `level`）的纯函数与常量。
 *
 * 用途：语音运行时（`src/runtime/voice-runtime.ts`）在采集期间按窗口结算 PCM 的 RMS，
 * 经本模块归一为 `[0,1]` 后由 NDJSON `level` 事件上行给 TUI（`src/tui.tsx`），
 * 最终由槽位的**盲文音量列**渲染（`src/voice/slot.ts` 的 `meterGlyph`）。
 * 本模块只做**纯计算**：不读时钟、不接事件、不依赖渲染 ⇒ 可离线单测。
 */

/**
 * 满量程 RMS（16bit 归一化幅值的均方根）。
 * 依据：实测语音 RMS 约 0.01~0.06（`[采集] … RMS=` 日志口径），取 0.08 作「说到顶」的参考值
 * ⇒ `level = rms / 本值`；该值只影响音量列的灵敏度，可由常量直接调整（不改调用方）。
 */
export const LEVEL_FULL_SCALE_RMS = 0.08;

/**
 * `level` 事件上行节流间隔（毫秒）：采集激活期间**最多每 100ms 发一条**（10Hz）。
 * 目的是限制 stdout 行数与 TUI 重渲染次数——低频足够表达「有没有在说话」，不必逐块上报。
 */
export const LEVEL_EVENT_INTERVAL_MS = 100;

/**
 * 把 16bit 归一化 PCM 的 RMS 折算为盲文音量列用的电平（纯函数，线性满量程映射）。
 * 映射：`level = rms / LEVEL_FULL_SCALE_RMS`，**超界 clamp 到 1**；
 * **非有限值（NaN / ±Infinity）与负值一律归 0**（采集侧异常不让音量列乱跳）。
 * 单调不减：更大的 RMS 不会得到更小的 level。
 * @param rms 均方根幅值（16bit PCM 归一化量纲，正常范围约 0~1）
 * @returns 归一化电平 ∈ [0,1]
 */
export function rmsToLevel(rms: number): number {
  if (!Number.isFinite(rms) || rms <= 0) return 0;
  const level = rms / LEVEL_FULL_SCALE_RMS;
  return level >= 1 ? 1 : level;
}
