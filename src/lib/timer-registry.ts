/**
 * 定时器统一登记 / 销毁（TUI 插件用）。
 *
 * 为什么需要它（2026-10-22 审计 P1）：`onDispose` 里先清 spinner 定时器、再 `stopRuntime()`，
 * 而 `stopRuntime()` 内部又调 `syncSpinFrame()` —— 旧实现据此把 interval **重新创建**回来，
 * 每次插件重载泄漏一个 100ms interval。仅靠「记得清表」不足以防回归，故：
 * - 所有 interval 必须经本登记表创建（统一出口）；
 * - {@link IntervalRegistry.disposeAll} 先置销毁标记再清空集合；
 * - 销毁后 {@link IntervalRegistry.create} **拒绝创建**（返回 null），从结构上杜绝再起表。
 */

/** 定时器句柄（Node `setInterval` 的返回值；只要求可选 `unref`）。 */
export type TimerHandle = ReturnType<typeof setInterval>;

/** 可注入的定时器实现（单测用假计时器统计活跃数量）。 */
export interface TimerApi {
  /** 创建周期定时器。 */
  setInterval(handler: () => void, ms: number): TimerHandle;
  /** 清除周期定时器。 */
  clearInterval(handle: TimerHandle): void;
}

/** 默认定时器实现（直接转发到宿主全局）。 */
export const SYSTEM_TIMERS: TimerApi = {
  setInterval: (handler: () => void, ms: number): TimerHandle => setInterval(handler, ms),
  clearInterval: (handle: TimerHandle): void => clearInterval(handle),
};

/** 定时器登记表：统一创建、统一清理，销毁后不再允许创建。 */
export class IntervalRegistry {
  private readonly handles = new Set<TimerHandle>();
  private disposed = false;

  /**
   * @param timers 定时器实现（缺省系统实现；单测注入假实现）
   */
  constructor(private readonly timers: TimerApi = SYSTEM_TIMERS) {}

  /** 当前活跃定时器数量（诊断/单测用）。 */
  get size(): number {
    return this.handles.size;
  }

  /** 是否已销毁（销毁后不再创建任何定时器）。 */
  get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * 创建一个受管定时器。
   * @param handler 周期回调
   * @param ms 周期（毫秒）
   * @returns 定时器句柄；**已销毁时返回 null 且不创建**
   */
  create(handler: () => void, ms: number): TimerHandle | null {
    if (this.disposed) return null;
    const handle = this.timers.setInterval(handler, ms);
    this.handles.add(handle);
    return handle;
  }

  /**
   * 清除并注销单个定时器（重复/未知句柄安全）。
   * @param handle 句柄
   */
  clear(handle: TimerHandle): void {
    if (!this.handles.delete(handle)) return;
    this.timers.clearInterval(handle);
  }

  /** 销毁全部定时器并锁定登记表（幂等）。 */
  disposeAll(): void {
    this.disposed = true;
    for (const handle of this.handles) this.timers.clearInterval(handle);
    this.handles.clear();
  }
}
