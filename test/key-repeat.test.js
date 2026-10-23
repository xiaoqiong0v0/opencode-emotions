/**
 * 按键重复抑制（F8 / F9 / F10 共用判据）的行为测试。
 *
 * 契约（2026-10-22 审计 P1）：尾沿静默窗口内重复事件只接受 1 次；静默满窗口后再次生效；
 * 每个热键一个 `KeyRepeatGuard` 实例 ⇒ F8 / F9 状态**各自独立**，互不抑制、也不与 F10 共享窗口。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_KEY_REPEAT_QUIET_MS,
  KeyRepeatGuard,
  shouldAcceptKeyRepeat,
} from "../dist/lib/key-repeat.js";

test("KeyRepeatGuard：窗口内连发 5 次只生效 1 次（每个事件都刷新窗口起点）", () => {
  const guard = new KeyRepeatGuard();
  const t0 = 1_000_000;
  // 按住 F8：首个事件接受；随后 OS 连发（~33ms 一次）全部被吞，且逐个把窗口起点后移
  const events = [t0, t0 + 1, t0 + 34, t0 + 67, t0 + 100];
  const accepted = events.filter((now) => guard.accept(now));
  assert.deepEqual(accepted, [t0], "5 次连发只接受第 1 次");
  assert.equal(guard.lastEventTimestamp, events.at(-1), "被吞的事件同样刷新窗口起点");
});

test("KeyRepeatGuard：静默满窗口后再次生效，窗口内（699ms）仍被抑制", () => {
  const guard = new KeyRepeatGuard();
  const t0 = 2_000_000;
  assert.equal(guard.accept(t0), true);
  assert.equal(guard.accept(t0 + DEFAULT_KEY_REPEAT_QUIET_MS - 1), false, "不足窗口仍吞");
  // 上一步刷新了起点，故从 t0+699 起再等满窗口才接受
  assert.equal(guard.accept(t0 + DEFAULT_KEY_REPEAT_QUIET_MS - 1), false);
  const last = t0 + DEFAULT_KEY_REPEAT_QUIET_MS - 1;
  assert.equal(guard.accept(last + DEFAULT_KEY_REPEAT_QUIET_MS), true, "静默满窗口后接受");
});

test("F8 / F9 各自独立：同一时刻按下互不抑制（各自一个 guard）", () => {
  const f8 = new KeyRepeatGuard();
  const f9 = new KeyRepeatGuard();
  const t0 = 3_000_000;
  assert.equal(f8.accept(t0), true, "F8 首次接受");
  assert.equal(f9.accept(t0), true, "F9 是独立实例，同一时刻仍接受（不被 F8 抑制）");
  assert.equal(f8.accept(t0 + 10), false, "F8 的重复事件仍被自己的窗口吞掉");
  assert.equal(f9.accept(t0 + 10), false, "F9 的重复事件也被自己的窗口吞掉");
});

test("shouldAcceptKeyRepeat：非法时间戳一律拒绝；相等边界按「满窗口」接受", () => {
  assert.equal(shouldAcceptKeyRepeat(Number.NaN, 0), false);
  assert.equal(shouldAcceptKeyRepeat(-1, 0), false);
  assert.equal(shouldAcceptKeyRepeat(0, 0), false, "0-0 不足默认窗口");
  assert.equal(shouldAcceptKeyRepeat(700, 0), true, "差值为窗口整值 ⇒ 接受（>= 语义）");
});

test("KeyRepeatGuard：构造参数校验（负窗口拒绝）", () => {
  assert.throws(() => new KeyRepeatGuard(-1), /quietMs/);
  assert.throws(() => new KeyRepeatGuard(Number.NaN), /quietMs/);
});
