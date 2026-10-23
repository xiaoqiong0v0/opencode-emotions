/**
 * meter spinner 计时器（`SpinTicker` + `IntervalRegistry`）的行为测试。
 *
 * 修 2026-10-22 审计 P1：`onDispose` 停表后 `stopRuntime()` 的状态变化又调 `syncSpinFrame()`，
 * interval 被重建、每次重载泄漏一个 100ms 定时器。契约：
 * - 唯一创建出口 = `IntervalRegistry`；
 * - `dispose()` 后活跃定时器数恒为 0，且之后任何 `setConnecting(true)` 都不得再起表（含「销毁过程中状态变化」）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { IntervalRegistry } from "../dist/lib/timer-registry.js";
import { SpinTicker } from "../dist/voice/spin-ticker.js";

/** 计数式假定时器：可统计活跃数量、手动触发回调、校验清理。 */
function createFakeTimers() {
  const timers = new Map();
  let nextId = 1;
  return {
    /** 活跃定时器数量。 */
    get activeCount() {
      return timers.size;
    },
    /** 已创建过的定时器总数（泄漏时只增不减）。 */
    created: 0,
    timers,
    setInterval(handler, ms) {
      const handle = { id: nextId++, handler, ms, unref() {} };
      timers.set(handle.id, handle);
      this.created += 1;
      return handle;
    },
    clearInterval(handle) {
      timers.delete(handle.id);
    },
    /** 触发所有活跃定时器一次（模拟 100ms 到点）。 */
    tickAll() {
      for (const timer of [...timers.values()]) timer.handler();
    },
  };
}

/** 构造被测 ticker（记录每次 onFrame）。 */
function createTicker() {
  const timers = createFakeTimers();
  const frames = [];
  const ticker = new SpinTicker({
    intervalMs: 100,
    frameCount: 3,
    onFrame: (frame) => frames.push(frame),
    timers,
  });
  return { timers, frames, ticker };
}

test("IntervalRegistry：统一创建 / 单个清理 / disposeAll 清空并锁定", () => {
  const timers = createFakeTimers();
  const registry = new IntervalRegistry(timers);
  const a = registry.create(() => {}, 100);
  const b = registry.create(() => {}, 200);
  assert.ok(a && b);
  assert.equal(registry.size, 2);
  registry.clear(a);
  assert.equal(registry.size, 1, "clear 单个后只剩 1");
  registry.disposeAll();
  assert.equal(registry.size, 0);
  assert.equal(timers.activeCount, 0, "真实定时器全部清除");
  assert.equal(registry.isDisposed, true);
  assert.equal(registry.create(() => {}, 100), null, "销毁后拒绝再创建（返回 null）");
  assert.equal(timers.activeCount, 0, "销毁后 create 不得落到宿主定时器");
});

test("SpinTicker：connecting 起表轮播、离开 connecting 停表归零", () => {
  const { timers, frames, ticker } = createTicker();
  ticker.setConnecting(true);
  assert.equal(ticker.active, true);
  assert.equal(ticker.activeTimerCount, 1);
  ticker.setConnecting(true);
  assert.equal(timers.created, 1, "重复 setConnecting(true) 不得重复建表");
  timers.tickAll();
  timers.tickAll();
  assert.deepEqual(frames, [1, 2], "帧索引按 frameCount 取模递增");
  ticker.setConnecting(false);
  assert.equal(ticker.active, false);
  assert.equal(ticker.activeTimerCount, 0);
  assert.equal(timers.activeCount, 0);
  assert.equal(frames.at(-1), 0, "停表把帧索引归零（渲染层复位）");
});

test("SpinTicker：dispose 后活跃定时器=0；销毁过程中的状态变化不得重启", () => {
  const { timers, frames, ticker } = createTicker();
  ticker.setConnecting(true);
  assert.equal(timers.activeCount, 1);

  ticker.dispose();
  assert.equal(ticker.activeTimerCount, 0, "dispose 后活跃定时器数=0");
  assert.equal(timers.activeCount, 0);
  const framesAfterDispose = frames.length;

  // 回归：旧实现里 stopRuntime()/handleChildGone() 会在 dispose 之后再次 syncSpinFrame → 重建 interval。
  ticker.setConnecting(true);
  ticker.setConnecting(false);
  ticker.setConnecting(true);
  assert.equal(ticker.activeTimerCount, 0, "销毁后任何 setConnecting 都不得再起表");
  assert.equal(timers.activeCount, 0);
  assert.equal(frames.length, framesAfterDispose, "销毁后不得再回调 onFrame");
});

test("SpinTicker：dispose 幂等；构造参数非法时报错", () => {
  const { ticker } = createTicker();
  ticker.setConnecting(true);
  ticker.dispose();
  ticker.dispose();
  assert.equal(ticker.activeTimerCount, 0);
  assert.throws(() => new SpinTicker({ intervalMs: 0, frameCount: 3, onFrame: () => {} }), /intervalMs/);
  assert.throws(() => new SpinTicker({ intervalMs: 100, frameCount: 0, onFrame: () => {} }), /frameCount/);
});

