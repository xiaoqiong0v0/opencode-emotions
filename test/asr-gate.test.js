/**
 * 半双工静音门单测（`src/voice/asr-gate.ts` 的门条件 + 与 `playback-state.ts` 归属 helper 的接缝）。
 *
 * 覆盖：空（从未活跃）→ 放；播放活跃 → 拦；播放结束 300ms（尾音窗口内）→ 拦；结束 600ms（窗口已过）→ 放；
 * 窗口边界（恰好 tailMs 放、差 1ms 拦）；窗口起点随活跃刷新；时钟回拨（保守拦）；非法时刻 / `tailMs<=0`（放）；
 * `tailMs` 缺省 = `ASR_GATE_TAIL_MS`；
 * **归属口径边界**（真值取自 helper、临时目录注入、`isAlive` 注入不真探进程）：其它会话有**存活**播放 →
 * 传**本会话 id** 判假 ⇒ 门放行；传哨兵键 `_`（TUI 无会话路由时的口径）同样判假；传**空串**才为真
 * （本门不使用空串口径，此处钉死差异，防止改用空 sessionID 越界读其它会话）；无主条目任何会话都算 → 拦。
 * **活跃口径（审计 P1，2026-10-22）**：新鲜 ≠ 活跃——判活以 pid 存活为准，判死条目当场清理；
 * 仅无 pid 的条目用 ≤15s 短 TTL，探测异常一律 fail-open（不阻断）。
 * 产物接线断言见 `test/tui-diagnostics.test.js`。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ASR_GATE_TAIL_MS,
  resolveFinalDelivery,
  shouldDropAsrFinal,
  STOP_FINAL_GRACE_MS,
} from "../dist/voice/asr-gate.js";
import {
  isInterruptablePlaybackActive,
  PLAYBACK_OWNERLESS_KEY,
  writePlayback,
} from "../dist/voice/playback-state.js";

/** 固定基准时刻（纯函数不吃真实时钟，用例可完全确定）。 */
const T = 1_000_000;

test("静音门：无播放且本进程从未观察到活跃 → 放行", () => {
  assert.equal(shouldDropAsrFinal(false, 0, T, 500), false);
});

test("静音门：播放活跃 → 丢弃（与尾音窗口无关）", () => {
  assert.equal(shouldDropAsrFinal(true, 0, T, 500), true, "首次活跃也应拦");
  assert.equal(shouldDropAsrFinal(true, T - 9_999, T, 500), true, "窗口早已过期但仍在播 → 仍拦");
});

test("静音门：播放结束 300ms（尾音窗口内）→ 仍丢弃（覆盖尾音/混响）", () => {
  assert.equal(shouldDropAsrFinal(false, T - 300, T, 500), true);
});

test("静音门：播放结束 600ms（窗口已过）→ 放行", () => {
  assert.equal(shouldDropAsrFinal(false, T - 600, T, 500), false);
});

test("静音门：窗口边界为严格小于（恰好 tailMs 放、差 1ms 拦）", () => {
  assert.equal(shouldDropAsrFinal(false, T - 500, T, 500), false, "恰好经过 tailMs → 放行");
  assert.equal(shouldDropAsrFinal(false, T - 499, T, 500), true, "差 1ms 仍在窗口内 → 丢弃");
});

test("静音门：起点随判活刷新（连续播放把尾音窗口逐条推后）", () => {
  // 句子 1 播完（起点 = T）：400ms 后仍拦
  assert.equal(shouldDropAsrFinal(false, T, T + 400, 500), true);
  // 期间句子 2 开播并播到 T+300（调用方把起点刷新为 T+300）：相对新起点 400ms 仍拦、801ms 放
  assert.equal(shouldDropAsrFinal(false, T + 300, T + 700, 500), true);
  assert.equal(shouldDropAsrFinal(false, T + 300, T + 801, 500), false);
});

test("静音门：时钟回拨（now 早于起点）→ 保守丢弃", () => {
  assert.equal(shouldDropAsrFinal(false, T, T - 10, 500), true, "差值为负仍算窗口内");
});

test("静音门：非法时刻与 tailMs<=0（关闭尾音窗口）→ 一律放行", () => {
  assert.equal(shouldDropAsrFinal(false, Number.NaN, T, 500), false, "NaN 起点");
  assert.equal(shouldDropAsrFinal(false, -1, T, 500), false, "负起点等同于从未活跃");
  assert.equal(shouldDropAsrFinal(false, T - 100, Number.NaN, 500), false, "NaN 当前时刻");
  assert.equal(shouldDropAsrFinal(false, T - 100, T, 0), false, "tailMs=0 → 只拦真正在播的");
});

test("静音门：tailMs 缺省即 ASR_GATE_TAIL_MS（常量可单测、不写死在用例里）", () => {
  assert.ok(Number.isFinite(ASR_GATE_TAIL_MS) && ASR_GATE_TAIL_MS > 0, "尾音窗口须为正数");
  const w = ASR_GATE_TAIL_MS;
  assert.equal(shouldDropAsrFinal(false, T - (w - 1), T), true);
  assert.equal(shouldDropAsrFinal(false, T - (w + 1), T), false);
});

test("静音门：归属口径边界——其它会话的活跃播放不算（helper 会话归属门保证）", () => {
  const dir = mkdtempSync(join(tmpdir(), "asr-gate-"));
  try {
    const opts = { dataDir: dir, now: () => T };
    // 只有**其它会话**（ses_other）在播；isAlive 恒 true ⇒ 该条目确实活跃（判活以进程存活为准，不看新鲜）
    const inject = { isAlive: () => true };
    assert.equal(writePlayback({ pid: 4242, provider: "aliyun", startedAt: T, kind: "speak", sessionID: "ses_other" }, opts), true);

    // ① 传本会话 id：不算其它会话 → 判假 → 门放行（正题：跨会话不误拦）
    assert.equal(isInterruptablePlaybackActive("ses_self", T, { ...opts, ...inject }), false);
    assert.equal(shouldDropAsrFinal(false, 0, T, ASR_GATE_TAIL_MS), false, "helper 判假 ⇒ 该条 final 照常分发");

    // ② 哨兵键 `_`（TUI 取不到会话路由时的口径）：同样只算无主，不算 ses_other
    assert.equal(isInterruptablePlaybackActive(PLAYBACK_OWNERLESS_KEY, T, { ...opts, ...inject }), false);

    // ③ 空串 = 全部条目（与无参 stopPlayback 同口径）：**门不使用**，此处钉死差异以防越界读其它会话
    assert.equal(isInterruptablePlaybackActive("", T, { ...opts, ...inject }), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("静音门：无主（手动 speak）播放算本会话可见 → 拦", () => {
  const dir = mkdtempSync(join(tmpdir(), "asr-gate-"));
  try {
    const opts = { dataDir: dir, now: () => T };
    assert.equal(writePlayback({ pid: 4343, provider: "sapi", startedAt: T, kind: "speak" }, opts), true);
    const active = isInterruptablePlaybackActive("ses_self", T, { ...opts, isAlive: () => true });
    assert.equal(active, true, "无主条目任何会话都算（与 stopPlayback 同口径）");
    assert.equal(shouldDropAsrFinal(active, T, T, ASR_GATE_TAIL_MS), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 停止后 final 宽限投递（2026-10-24）----

test("分发决策：当前开关优先（注入/输入）", () => {
  const last = { mode: "input", sessionID: "ses_a", at: T };
  assert.deepEqual(
    resolveFinalDelivery({ injectOn: true, inputOn: false, lastClosed: last, currentSessionID: "ses_a", now: T }),
    { delivered: true, mode: "inject", viaGrace: false },
  );
  assert.deepEqual(
    resolveFinalDelivery({ injectOn: false, inputOn: true, lastClosed: last, currentSessionID: "ses_a", now: T }),
    { delivered: true, mode: "input", viaGrace: false },
  );
});

test("分发决策：关闭后 3s 内、会话一致 → 按关闭前的模式投递（inject 不被丢）", () => {
  const last = { mode: "inject", sessionID: "ses_a", at: T };
  assert.deepEqual(
    resolveFinalDelivery({ injectOn: false, inputOn: false, lastClosed: last, currentSessionID: "ses_a", now: T + 1_000 }),
    { delivered: true, mode: "inject", viaGrace: true },
  );
  // 边界：恰好 3s 仍在宽限内；差 1ms 过期
  assert.deepEqual(
    resolveFinalDelivery({ injectOn: false, inputOn: false, lastClosed: last, currentSessionID: "ses_a", now: T + STOP_FINAL_GRACE_MS }),
    { delivered: true, mode: "inject", viaGrace: true },
  );
  assert.deepEqual(
    resolveFinalDelivery({ injectOn: false, inputOn: false, lastClosed: last, currentSessionID: "ses_a", now: T + STOP_FINAL_GRACE_MS + 1 }),
    { delivered: false, reason: "grace-expired" },
  );
});

test("分发决策：超过 3s 丢弃（不注入/不追加）且原因可区分", () => {
  const last = { mode: "input", sessionID: "ses_a", at: T };
  assert.deepEqual(
    resolveFinalDelivery({ injectOn: false, inputOn: false, lastClosed: last, currentSessionID: "ses_a", now: T + 3_001 }),
    { delivered: false, reason: "grace-expired" },
  );
  // 无关闭记录 → 没有可投递模式
  assert.deepEqual(
    resolveFinalDelivery({ injectOn: false, inputOn: false, lastClosed: null, currentSessionID: "ses_a", now: T }),
    { delivered: false, reason: "no-active-mode" },
  );
});

test("分发决策：会话不一致 → 丢弃（不跨会话投递）", () => {
  const last = { mode: "inject", sessionID: "ses_a", at: T };
  assert.deepEqual(
    resolveFinalDelivery({ injectOn: false, inputOn: false, lastClosed: last, currentSessionID: "ses_b", now: T + 100 }),
    { delivered: false, reason: "session-mismatch" },
  );
});

test("分发决策：取不到会话时按无主哨兵口径配对（不越界匹配有主会话）", () => {
  const ownerless = { mode: "input", sessionID: undefined, at: T };
  assert.deepEqual(
    resolveFinalDelivery({ injectOn: false, inputOn: false, lastClosed: ownerless, currentSessionID: undefined, now: T + 100 }),
    { delivered: true, mode: "input", viaGrace: true },
    "关闭与当前都无会话 → 同一无主口径，允许投递",
  );
  assert.deepEqual(
    resolveFinalDelivery({ injectOn: false, inputOn: false, lastClosed: ownerless, currentSessionID: "ses_a", now: T + 100 }),
    { delivered: false, reason: "session-mismatch" },
    "关闭时无主、当前有会话 → 不匹配",
  );
  const owned = { mode: "input", sessionID: "ses_a", at: T };
  assert.deepEqual(
    resolveFinalDelivery({ injectOn: false, inputOn: false, lastClosed: owned, currentSessionID: undefined, now: T + 100 }),
    { delivered: false, reason: "session-mismatch" },
    "关闭时有会话、当前无会话 → 不匹配",
  );
});

test("分发决策：时钟回拨按过期处理；graceMs<=0 关闭宽限", () => {
  const last = { mode: "inject", sessionID: "ses_a", at: T };
  assert.deepEqual(
    resolveFinalDelivery({ injectOn: false, inputOn: false, lastClosed: last, currentSessionID: "ses_a", now: T - 10 }),
    { delivered: false, reason: "grace-expired" },
  );
  assert.deepEqual(
    resolveFinalDelivery({ injectOn: false, inputOn: false, lastClosed: last, currentSessionID: "ses_a", now: T + 10 }, 0),
    { delivered: false, reason: "grace-expired" },
  );
});

test("分发决策：停止进行中（stopping=true）不受 3s 宽限截断，会话一致即投递", () => {
  const last = { mode: "inject", sessionID: "ses_a", at: T };
  // 优雅停止可等 10s、单段 HTTP 可到 60s：停止进行中即使 age 远超 3s 也必须投递
  for (const ageMs of [3_001, 10_000, 60_000]) {
    assert.deepEqual(
      resolveFinalDelivery({
        injectOn: false,
        inputOn: false,
        lastClosed: last,
        currentSessionID: "ses_a",
        now: T + ageMs,
        stopping: true,
      }),
      { delivered: true, mode: "inject", viaGrace: true },
      `stopping=true、ageMs=${ageMs} 时应投递`,
    );
  }
  // 停止结束（stopping=false/缺省）后回到 3s 宽限
  assert.deepEqual(
    resolveFinalDelivery({ injectOn: false, inputOn: false, lastClosed: last, currentSessionID: "ses_a", now: T + 3_001 }),
    { delivered: false, reason: "grace-expired" },
  );
  // 停止进行中也不跨会话投递
  assert.deepEqual(
    resolveFinalDelivery({
      injectOn: false,
      inputOn: false,
      lastClosed: last,
      currentSessionID: "ses_b",
      now: T + 10_000,
      stopping: true,
    }),
    { delivered: false, reason: "session-mismatch" },
  );
});
