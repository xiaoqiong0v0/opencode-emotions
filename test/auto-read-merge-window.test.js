/**
 * 自动朗读「首句合并窗」回归测试（2026-10-22 第十三批修法 1）。
 *
 * 修复前如何红：`drain` 第一个完整句一到就立即 `deliverUnit`（无任何时间窗），
 * 故 ① 会 spawn 2 次（"第一句话。" 与 "第二句话。" 各一次）、④ 打断前已经把首句派发出去。
 * 本文件用假 spawn（记录正文 + 时间戳）与可注入窗口（`firstMergeWindowMs`）复现真实事件形态。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAutoReader } from "../dist/voice/auto-read.js";
import { writeAutoTts } from "../dist/voice/auto-tts.js";

/** 每条用例的消息/会话 id（目录按用例隔离，id 可复用）。 */
const SID = "ses_merge_window";
const MID = "msg_merge_window";

/**
 * 构造假 spawn：记录每次派生的正文与时刻，delayMs 后正常退出。
 * @param {{ text: string, at: number }[]} records 记录器
 * @param {number} delayMs 子进程存活时长（模拟播放）
 * @returns {(cmd: string, args: string[]) => EventEmitter} spawn 实现
 */
function makeFakeSpawn(records, delayMs) {
  return (_cmd, args) => {
    const child = new EventEmitter();
    child.killed = false;
    child.pid = 8000 + records.length;
    child.stderr = new EventEmitter();
    child.stderr.setEncoding = () => {};
    child.kill = () => {
      child.killed = true;
      child.emit("exit", 1, null);
    };
    // spawnSpeak 的参数：`[cliPath, "speak", "--text-file", <file>]`
    records.push({ text: readFileSync(args[3], "utf8"), at: Date.now() });
    setTimeout(() => child.emit("exit", 0, null), delayMs);
    return child;
  };
}

/**
 * 创建隔离目录内、开关已开的 auto-read。
 * @param {string} dataDir 隔离数据目录
 * @param {{ text: string, at: number }[]} records spawn 记录器
 * @param {string[]} logs 日志收集器
 * @param {number} windowMs 首句合并窗（毫秒）
 * @param {object} [options] 附加依赖
 * @returns {object} reader
 */
function createReader(dataDir, records, logs, windowMs, options = {}) {
  writeAutoTts(SID, true, { dataDir });
  const log = {
    info: (...args) => logs.push(args.join(" ")),
    warn: (...args) => logs.push(`WARN ${args.join(" ")}`),
    error: (...args) => logs.push(`ERR ${args.join(" ")}`),
    loaded: () => {},
    hook: () => {},
    tool: () => {},
  };
  return createAutoReader({
    log,
    cliPath: "cli.js",
    fetchParts: async () => [{ type: "text", text: "不应走到回退路径" }],
    paths: { dataDir },
    spawnEnabled: true,
    spawnFn: makeFakeSpawn(records, options.spawnDelayMs ?? 40),
    spawnBin: "node",
    followSupport: false,
    streamMinChars: 5,
    firstMergeWindowMs: windowMs,
  });
}

/** 助手消息开始事件（登记 role=assistant，delta 才能过角色门）。 */
const startEvent = () => ({
  type: "message.updated",
  properties: { sessionID: SID, info: { id: MID, role: "assistant", time: { created: Date.now() - 5000 } } },
});

/** 一条 part 快照事件（text-start 空快照）。 */
const partEvent = () => ({
  type: "message.part.updated",
  properties: { part: { id: "p1", type: "text", text: "", messageID: MID, sessionID: SID } },
});

/** 一条文本增量事件。 */
const deltaEvent = (delta) => ({
  type: "message.part.delta",
  properties: { sessionID: SID, messageID: MID, partID: "p1", field: "text", delta },
});

/** 助手消息完成事件。 */
const finalizeEvent = () => ({
  type: "message.updated",
  properties: {
    sessionID: SID,
    info: { id: MID, role: "assistant", time: { created: Date.now() - 5000, completed: Date.now() } },
  },
});

/**
 * 轮询等待条件成立。
 * @param {() => boolean} predicate 条件
 * @param {number} timeoutMs 上限
 */
async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("waitFor 超时");
}

/** 睡眠指定毫秒。 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("① 流未结束：窗口内完成的句子并入首单元（1 次 spawn，修复前 2 次）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "merge-window-merge-"));
  const records = [];
  const logs = [];
  try {
    const reader = createReader(dir, records, logs, 150);
    reader.handleEvent(startEvent());
    reader.handleEvent(partEvent());
    const startedAt = Date.now();
    reader.handleEvent(deltaEvent("第一句话。"));
    await sleep(30);
    reader.handleEvent(deltaEvent("第二句话。"));
    await waitFor(() => records.length >= 1);
    assert.equal(records.length, 1, "两句必须合并成一次派发");
    assert.equal(records[0].text, "第一句话。第二句话。", "合并保持句对齐与顺序（无分隔、无丢字）");
    // 契约更新（2026-10-23 第十五批）：原断言要求「等满窗口（>=100ms）」；现在窗口内新完成一整句即
    // `wakeFirstWindow("arrived")` 立即结算合并，不再白等到期。新断言：确实等到了第二句（>25ms），
    // 但早于窗口到期（<140ms）——合并收益保留、延迟更小。
    const waited = records[0].at - startedAt;
    assert.ok(waited >= 25, `首单元必须等到第二句到达才派发（不是首句立即派发），实际 ${waited}ms`);
    assert.ok(waited < 140, `第二句到达即合并派发，不得等满窗口，实际 ${waited}ms`);
    assert.ok(
      logs.some((line) => line.includes("首句合并窗") && line.includes("outcome=arrived")),
      "新句到达路径必须留下 outcome=arrived 日志",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("② 窗口到期即派发（没有新句也必须按时出声）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "merge-window-timeout-"));
  const records = [];
  try {
    const reader = createReader(dir, records, [], 120);
    reader.handleEvent(startEvent());
    reader.handleEvent(partEvent());
    const startedAt = Date.now();
    reader.handleEvent(deltaEvent("第一句话。"));
    await waitFor(() => records.length >= 1);
    assert.equal(records[0].text, "第一句话。");
    const waited = records[0].at - startedAt;
    assert.ok(waited >= 90, `应等待窗口再派发（实际 ${waited}ms）`);
    assert.ok(waited < 800, "窗口到期后必须及时派发（不得无限等）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("③ 流在窗口内结束：立即派发（不多等）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "merge-window-done-"));
  const records = [];
  const logs = [];
  try {
    const reader = createReader(dir, records, logs, 500);
    reader.handleEvent(startEvent());
    reader.handleEvent(partEvent());
    const startedAt = Date.now();
    reader.handleEvent(deltaEvent("第一句话。"));
    await sleep(30);
    reader.handleEvent(finalizeEvent());
    await waitFor(() => records.length >= 1);
    const waited = records[0].at - startedAt;
    assert.ok(waited < 300, `消息已结束不得再等满窗口（实际 ${waited}ms）`);
    assert.equal(records[0].text, "第一句话。");
    assert.ok(
      logs.some((line) => line.includes("首句合并窗") && line.includes("outcome=done")),
      "结束路径应记录 outcome=done",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("④ 等待期间打断：立即取消等待且不派发（修复前首句已派发）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "merge-window-cancel-"));
  const records = [];
  try {
    const reader = createReader(dir, records, [], 200);
    reader.handleEvent(startEvent());
    reader.handleEvent(partEvent());
    reader.handleEvent(deltaEvent("第一句话。"));
    await sleep(40);
    reader.interrupt(SID);
    await sleep(300);
    assert.equal(records.length, 0, "打断后不得派发（不得因合并窗拖延中断）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("⑤ 第二单元不受影响：不等待合并窗、正文独立", async () => {
  const dir = mkdtempSync(join(tmpdir(), "merge-window-second-"));
  const records = [];
  const logs = [];
  try {
    const reader = createReader(dir, records, logs, 200);
    reader.handleEvent(startEvent());
    reader.handleEvent(partEvent());
    reader.handleEvent(deltaEvent("第一句话。"));
    await waitFor(() => records.length === 1);
    const secondAt = Date.now();
    reader.handleEvent(deltaEvent("第二句话。"));
    await waitFor(() => records.length === 2);
    assert.deepEqual(
      records.map((entry) => entry.text),
      ["第一句话。", "第二句话。"],
      "第二单元独立派发（不被合并、不被改序）",
    );
    assert.ok(records[1].at - secondAt < 200, "第二单元不得再等一个合并窗");
    const windowLogs = logs.filter((line) => line.includes("首句合并窗"));
    assert.equal(windowLogs.length, 1, "合并窗只对首个单元生效一次");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("⑥ 700ms 吐句节奏：len=16 + len=17 必须合并为 1 次合成（自适应窗口 1200ms）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "merge-window-700-"));
  const records = [];
  const logs = [];
  // 16 字 / 17 字，各是一个完整句（句末标点），合计 33 字 ≤ DRAIN_MERGE_MAX_CHARS
  const first = `${"甲".repeat(15)}。`;
  const second = `${"乙".repeat(16)}。`;
  try {
    // 不注入窗口：默认基值 400ms、无句间观测时上限 1200ms —— 700ms 的第二句应能在窗口内到达
    const reader = createReader(dir, records, logs, undefined);
    reader.handleEvent(startEvent());
    reader.handleEvent(partEvent());
    const startedAt = Date.now();
    reader.handleEvent(deltaEvent(first));
    await sleep(700);
    reader.handleEvent(deltaEvent(second));
    await waitFor(() => records.length >= 1);
    assert.equal(records.length, 1, "两句必须合并成一次合成（不是两次）");
    assert.equal(records[0].text, first + second, "合并后正文完整且顺序不变");
    assert.equal(records[0].text.length, 33, "合并单元 = 16 + 17 字");
    const waited = records[0].at - startedAt;
    assert.ok(waited >= 690, `必须等到第二句到达（实际 ${waited}ms）`);
    assert.ok(waited < 1200, `不得拖到窗口上限才派发（实际 ${waited}ms）`);
    assert.ok(
      logs.some((line) => line.includes("首句合并窗") && line.includes("outcome=arrived")),
      "700ms 到达应走 arrived 结算并留日志",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


