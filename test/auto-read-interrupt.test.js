/**
 * 自动朗读「finalize 之后的尾部播放窗口仍可被 interrupt 命中」回归测试（2026-10-22 审计修复）。
 *
 * 修复前：`finalize()` 在启动异步 `drain()` 后**立刻**删掉 `streams`/`partMeta` ⇒ 消息已完成但
 * 队列/carry 还在播放时，`interrupt(sessionID)` 遍历不到它，尾段照常 spawn 朗读。
 * 本文件用假 spawn（EventEmitter 子进程 + 延迟 exit）复现真实事件形态，断言：
 * 1. finalize 后立刻 interrupt → 不再新增 spawn、尾段不读；
 * 2. 正常 finalize 无中断 → 两个单元都念完，且收敛后状态被清理（再次 interrupt 无命中）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAutoReader } from "../dist/voice/auto-read.js";
import { writeAutoTts } from "../dist/voice/auto-tts.js";

/** 测试用会话/消息 id。 */
const SID = "ses_audit_finalize";
const MID = "msg_audit_finalize";

/**
 * 构造假的 spawn：记录「本次派生的正文文件内容」并在 delayMs 后正常退出。
 * @param {string[]} texts 收集每次 spawn 的正文（从 `--text-file` 读取）
 * @param {number} delayMs 子进程存活时长
 * @returns {(cmd: string, args: string[]) => EventEmitter} spawn 实现
 */
function makeFakeSpawn(texts, delayMs = 200) {
  return (_cmd, args) => {
    const child = new EventEmitter();
    child.killed = false;
    child.pid = 9000 + texts.length;
    child.stderr = new EventEmitter();
    child.stderr.setEncoding = () => {};
    child.kill = () => {
      child.killed = true;
      child.emit("exit", 1, null);
    };
    // spawnSpeak 的参数：`[cliPath, "speak", "--text-file", <file>]`
    texts.push(readFileSync(args[3], "utf8"));
    setTimeout(() => child.emit("exit", 0, null), delayMs);
    return child;
  };
}

/**
 * 创建一个隔离目录内、开关已开的 auto-read（不触网、不真起进程）。
 * @param {string} dataDir 隔离数据目录
 * @param {string[]} texts spawn 正文收集器
 * @param {string[]} logs 日志收集器
 */
function createReader(dataDir, texts, logs) {
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
    // 本文件验证 finalize/interrupt 语义（不验证首句合并窗）：置 0 保持原有派发时序
    firstMergeWindowMs: 0,
    log,
    cliPath: "cli.js",
    fetchParts: async () => [{ type: "text", text: "不应走到回退路径" }],
    paths: { dataDir },
    spawnEnabled: true,
    spawnFn: makeFakeSpawn(texts),
    spawnBin: "node",
    followSupport: false,
    streamMinChars: 5,
  });
}

/** 一条 part 快照事件（text-start 空快照）。 */
const partEvent = (text) => ({
  type: "message.part.updated",
  properties: { part: { id: "p1", type: "text", text, messageID: MID, sessionID: SID } },
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
 * 轮询等待条件成立（避免固定 sleep 引起偶发）。
 * @param {() => boolean} predicate 条件
 * @param {number} timeoutMs 上限
 */
async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("waitFor 超时");
}

test("finalize 后立刻 interrupt：尾段不再 spawn/朗读（修复前会多 1 次 spawn）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-finalize-int-"));
  const texts = [];
  const logs = [];
  try {
    const reader = createReader(dir, texts, logs);
    reader.handleEvent({
      type: "message.updated",
      properties: { sessionID: SID, info: { id: MID, role: "assistant", time: { created: Date.now() - 5000 } } },
    });
    reader.handleEvent(partEvent(""));
    reader.handleEvent(deltaEvent("第一句话。"));
    reader.handleEvent(deltaEvent("没有标点的尾巴继续增长"));
    // 等第一单元已经在播（drain 在 await 中，carry 尚未派发）
    await waitFor(() => texts.length === 1);

    reader.handleEvent(finalizeEvent());
    reader.interrupt(SID);
    // 给 drain 足够的恢复时间（> 假子进程 200ms 存活期）
    await new Promise((resolve) => setTimeout(resolve, 500));

    assert.equal(texts.length, 1, "finalize 后 interrupt 不得再派生尾段");
    assert.equal(texts[0], "第一句话。", "只念完中断前已开始的单元");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("正常 finalize（无中断）：尾部单元念完，且收敛后状态被清理（无条目泄漏）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-finalize-ok-"));
  const texts = [];
  const logs = [];
  try {
    const reader = createReader(dir, texts, logs);
    reader.handleEvent({
      type: "message.updated",
      properties: { sessionID: SID, info: { id: MID, role: "assistant", time: { created: Date.now() - 5000 } } },
    });
    reader.handleEvent(partEvent(""));
    reader.handleEvent(deltaEvent("第一句话。"));
    reader.handleEvent(deltaEvent("没有标点的尾巴继续增长"));
    await waitFor(() => texts.length === 1);

    reader.handleEvent(finalizeEvent());
    await waitFor(() => texts.length === 2);
    // 等最后一次播放结束（假子进程 200ms）并让 drain 收敛到终态（回收 streams/partMeta）
    await new Promise((resolve) => setTimeout(resolve, 500));

    assert.deepEqual(texts, ["第一句话。", "没有标点的尾巴继续增长"], "两个单元都要念完");
    assert.ok(
      logs.some((line) => line.includes("自动朗读汇总")),
      "finalize 仍要打一条汇总",
    );

    // drain 收敛后 streams 条目应已删除：此时 interrupt 不应再命中任何消息
    const before = logs.filter((line) => line.includes("自动朗读已打断")).length;
    reader.interrupt(SID);
    const after = logs.filter((line) => line.includes("自动朗读已打断")).length;
    assert.equal(after, before, "完成后状态必须清理（interrupt 不再命中，证明无条目泄漏）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
