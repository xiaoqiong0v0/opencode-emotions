/**
 * meter spinner（连接中）的换帧计时器。
 *
 * 把「何时起表/停表、销毁后不得重启」从 TUI 组件闭包里抽出来，便于离线单测：
 * - 仅 `connecting` 时运行，进入 `listening`/`idle` 停表并把帧索引归零；
 * - 所有 interval 经 {@link IntervalRegistry} 创建，{@link SpinTicker.dispose} 统一清空；
 * - **销毁后 {@link SpinTicker.setConnecting} 一律无效**（不再起表），修 2026-10-22 审计 P1：
 *   `onDispose` 先停表、`stopRuntime()` 内部的状态变化又调 `setConnecting(true)` ⇒ 定时器被重建、每次重载泄漏。
 */

import { IntervalRegistry, type TimerApi, type TimerHandle } from "../lib/timer-registry.js";

/** {@link SpinTicker} 构造参数。 */
export interface SpinTickerOptions {
  /** 换帧间隔（毫秒）。 */
  intervalMs: number;
  /** 帧总数（必须 ≥ 1，按取模轮播）。 */
  frameCount: number;
  /** 每次换帧回调（参数为新的帧索引）。 */
  onFrame: (frame: number) => void;
  /** 定时器实现（缺省系统实现；单测注入假实现）。 */
  timers?: TimerApi;
}

/** meter spinner 的起停控制器（单实例对应一个 TUI 组件）。 */
export class SpinTicker {
  private readonly registry: IntervalRegistry;
  private readonly intervalMs: number;
  private readonly frameCount: number;
  private readonly onFrame: (frame: number) => void;
  private handle: TimerHandle | null = null;
  private frame = 0;

  /**
   * @param options 间隔 / 帧数 / 回调 / 可注入定时器
   */
  constructor(options: SpinTickerOptions) {
    if (!Number.isFinite(options.intervalMs) || options.intervalMs <= 0) {
      throw new Error(`SpinTicker intervalMs 必须为正数：${options.intervalMs}`);
    }
    if (!Number.isInteger(options.frameCount) || options.frameCount < 1) {
      throw new Error(`SpinTicker frameCount 必须为正整数：${options.frameCount}`);
    }
    this.intervalMs = options.intervalMs;
    this.frameCount = options.frameCount;
    this.onFrame = options.onFrame;
    this.registry = new IntervalRegistry(options.timers);
  }

  /** 当前是否在轮播。 */
  get active(): boolean {
    return this.handle !== null;
  }

  /** 当前活跃定时器数量（正常为 0/1；单测断言销毁后为 0）。 */
  get activeTimerCount(): number {
    return this.registry.size;
  }

  /** 是否已销毁。 */
  get disposed(): boolean {
    return this.registry.isDisposed;
  }

  /**
   * 按阶段同步起停：`connecting=true` 起表（已在跑则不动），`false` 停表并归零。
   * 销毁后调用一律无效（不创建定时器、不改帧）。
   * @param connecting 是否处于「连接中」阶段
   */
  setConnecting(connecting: boolean): void {
    if (this.registry.isDisposed) return;
    if (!connecting) {
      this.stop();
      return;
    }
    if (this.handle !== null) return;
    const handle = this.registry.create(() => {
      this.frame = (this.frame + 1) % this.frameCount;
      this.onFrame(this.frame);
    }, this.intervalMs);
    if (handle === null) return;
    this.handle = handle;
    handle.unref?.();
  }

  /**
   * 销毁：清空全部定时器并锁定（幂等）。**不回调 `onFrame`**——销毁期间不应再写组件信号。
   */
  dispose(): void {
    this.handle = null;
    this.registry.disposeAll();
  }

  /** 停表并把帧索引归零（回调 0 让渲染层复位）。 */
  private stop(): void {
    if (this.handle === null) return;
    this.registry.clear(this.handle);
    this.handle = null;
    this.frame = 0;
    this.onFrame(0);
  }
}
