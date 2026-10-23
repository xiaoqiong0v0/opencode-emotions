/**
 * 按键重复抑制（F8 / F9 / F10 共用）。
 *
 * 背景（spike 实测 + 2026-10-22 审计）：按住功能键会被 OS 连发按键事件（Windows 默认重复延迟
 * ~500ms、速率 ~30/s）。对「切换开关」类热键逐事件执行会产生偶数次翻转、净效果=回到原状态，
 * 表现为「按了没反应」；对 F8/F9 还会反复 spawn/stop runtime（进程抖动）。
 *
 * 语义 = **尾沿静默窗口**：距上一次按键事件不足 `quietMs` 的新事件一律不接受，
 * 且**每个事件（含被吞掉的）都刷新窗口起点** ⇒ 整次按住只接受第一个事件；
 * 松开静默满窗口后的下一次点按重新生效。
 */

/** 默认抑制窗口（毫秒）：Windows 键盘重复延迟默认约 500ms，取 700ms 留余量。 */
export const DEFAULT_KEY_REPEAT_QUIET_MS = 700;

/**
 * 纯函数判据（无状态）：本事件是否应接受。
 * @param nowMs 本事件时间戳（毫秒）
 * @param lastEventMs 上一次按键事件时间戳（0 = 从未发生）
 * @param quietMs 静默窗口（毫秒）
 * @returns 是否接受本次事件
 */
export function shouldAcceptKeyRepeat(
  nowMs: number,
  lastEventMs: number,
  quietMs: number = DEFAULT_KEY_REPEAT_QUIET_MS,
): boolean {
  if (!Number.isFinite(nowMs) || nowMs < 0) return false;
  return nowMs - lastEventMs >= quietMs;
}

/**
 * 有状态的按键重复抑制器：每个热键一个实例（F8 / F9 / F10 **各自独立**，互不抑制）。
 * 内部只在 `accept()` 时刷新窗口起点，调用方无需自行维护时间戳。
 */
export class KeyRepeatGuard {
  private lastEventAt = 0;
  private readonly quietMs: number;

  /**
   * @param quietMs 静默窗口（毫秒，缺省 {@link DEFAULT_KEY_REPEAT_QUIET_MS}）
   */
  constructor(quietMs: number = DEFAULT_KEY_REPEAT_QUIET_MS) {
    if (!Number.isFinite(quietMs) || quietMs < 0) {
      throw new Error(`KeyRepeatGuard quietMs 必须为非负数：${quietMs}`);
    }
    this.quietMs = quietMs;
  }

  /**
   * 记录本次事件并判断是否接受（**无论接受与否都刷新窗口起点**）。
   * @param nowMs 本事件时间戳（毫秒）
   * @returns 是否接受
   */
  accept(nowMs: number): boolean {
    if (!Number.isFinite(nowMs) || nowMs < 0) return false;
    const accepted = shouldAcceptKeyRepeat(nowMs, this.lastEventAt, this.quietMs);
    this.lastEventAt = nowMs;
    return accepted;
  }

  /** 上次事件时间戳（诊断用）。 */
  get lastEventTimestamp(): number {
    return this.lastEventAt;
  }
}
