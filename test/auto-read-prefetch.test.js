/**
 * 自动朗读「下一单元预取」编排测试（2026-10-22 第十四批）。
 *
 * 用**假 spawn**模拟 CLI 三种形态（普通合成+播放 / `--pcm-out` 只合成 / `--pcm-file --await-go` 交播），
 * 断言编排契约本身（真实 CLI 的 sink/闸门另见 `test/prefetch.test.js`）：
 * 1. 播第 N 句期间完成第 N+1 句预取，上一单元退出 → 交播空档 **<200ms**（修复前=整条管线重启 ≈1.6s）；
 * 2. 预取进行中打断 → kill 合成/预热进程、无额外 spawn、无额外播放、后续新消息不受影响；
 * 3. 预取失败/超时 → 该句退回串行播放（不丢句、不阻塞后续）；
 * 4. 深度 0 关闭预取（行为回到串行）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAutoReader } from "../dist/voice/auto-read.js";
import { writeAutoTts } from "../dist/voice/auto-tts.js";
import { PCM_PLAY_STARTED_MARKER } from "../dist/voice/cli.js";

/** 测试用会话/消息 id（目录按用例隔离，id 可复用）。 */
const SID = "ses_prefetch";
const MID = "msg_prefetch";
const MID2 = "msg_prefetch_next";

/** 等待若干毫秒。 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 轮询等待条件成立。
 * @param {() => boolean} predicate 条件
 * @param {number} timeoutMs 上限
 * @param {string} label 错误标签
 */
async function waitFor(predicate, timeoutMs = 2000, label = "条件") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(5);
  }
  throw new Error(`waitFor 超时：${label}`);
}

/**
 * 构造假 spawn：按 argv 区分三种 CLI 形态并模拟真实时序（**2026-10-23 第十五批新契约**）：
 * - `synth`（`--pcm-out`）：合成落盘，`synthMs` 后退出；
 * - `play-pcm`（`--pcm-file --pcm-follow`）：**与合成同时派生**（预热，未 `go` 前不出声）；
 *   stdin 收 `go` 才记交播时刻并打印开始标记；收 `done`/`abort` 后 `pcmPlayMs` 退出
 *   （退出码默认 0=播完；`options.playExitCode` 可注入「从未起播=1」等契约码）。
 * @param {object} options 时序/故障注入
 * @returns {{spawnFn: Function, spawns: object[], events: object[]}}
 */
function makeFakeSpawn(options = {}) {
  const spawns = [];
  const events = [];
  const synthMs = options.synthMs ?? 60;
  const speakMs = options.speakMs ?? 250;
  const pcmPlayMs = options.pcmPlayMs ?? 150;
  const playExitCode = options.playExitCode ?? 0;
  const spawnFn = (_cmd, args) => {
    const child = new EventEmitter();
    child.killed = false;
    child.pid = 11000 + spawns.length;
    child.stderr = new EventEmitter();
    child.stderr.setEncoding = () => {};
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    const has = (flag) => args.includes(flag);
    const kind = has("--pcm-out") ? "synth" : has("--pcm-file") ? "play-pcm" : "speak";
    let text = "";
    let pcmPath = null;
    if (kind === "speak") text = readFileSync(args[3], "utf8");
    else if (kind === "synth") {
      text = readFileSync(args[3], "utf8");
      pcmPath = args[5];
    } else {
      pcmPath = args[3];
    }
    const record = { kind, args, text, pcmPath, at: Date.now(), child, exitedAt: 0, timers: [] };
    spawns.push(record);
    events.push({ kind: "spawn", via: kind, at: record.at });
    const later = (fn, ms) => {
      const timer = setTimeout(fn, ms);
      record.timers.push(timer);
      return timer;
    };
    child.kill = () => {
      if (child.killed) return;
      child.killed = true;
      record.killedAt = Date.now();
      for (const timer of record.timers) clearTimeout(timer);
      setImmediate(() => {
        child.emit("exit", 1, null);
        child.emit("close", 1, null);
      });
    };
    child.once("close", (code) => {
      record.exitedAt = Date.now();
      record.exitCode = code;
    });

    if (kind === "synth") {
      later(() => {
        if (child.killed) return;
        if (options.synthFail) {
          child.emit("exit", 1, null);
          child.emit("close", 1, null);
          return;
        }
        // 伪造一个 44 字节头 + 480 字节 data 的 WAV（预取只校验大小）
        writeFileSync(pcmPath, Buffer.alloc(44 + 480, 0x11));
        child.emit("exit", 0, null);
        child.emit("close", 0, null);
      }, synthMs);
    } else if (kind === "play-pcm") {
      // 新契约：播放进程先派生并预热（未收到 go 不出声），交播后才写 go → done/abort
      child.stdin = {
        writable: true,
        write(line) {
          const command = String(line).trim();
          if (command === "go") {
            record.gateAt = Date.now();
            events.push({ kind: "gate", at: record.gateAt });
            setImmediate(() => {
              if (!options.noPlayMarker && !child.killed) child.stdout.emit("data", `${PCM_PLAY_STARTED_MARKER}\n`);
            });
            return true;
          }
          if (command === "done" || command === "abort") {
            record.writerEnd = command;
            later(() => {
              if (child.killed) return;
              child.emit("exit", playExitCode, null);
              child.emit("close", playExitCode, null);
            }, pcmPlayMs);
          }
          return true;
        },
        end() {},
        on() {},
        off() {},
      };
    } else {
      later(() => {
        if (child.killed) return;
        child.emit("exit", 0, null);
        child.emit("close", 0, null);
      }, speakMs);
    }
    return child;
  };
  return { spawnFn, spawns, events };
}

/** 收集日志的假 logger。 */
function makeLogs() {
  const lines = [];
  return {
    lines,
    log: {
      info: (...args) => lines.push(args.join(" ")),
      warn: (...args) => lines.push(`WARN ${args.join(" ")}`),
      error: (...args) => lines.push(`ERR ${args.join(" ")}`),
      loaded: () => {},
      hook: () => {},
      tool: () => {},
    },
  };
}

/** 创建隔离目录内的 auto-read（开关已开）。 */
function createReader(dataDir, fake, logs, overrides = {}) {
  writeAutoTts(SID, true, { dataDir });
  return createAutoReader({
    log: logs.log,
    cliPath: "cli.js",
    fetchParts: async () => [],
    paths: { dataDir },
    spawnEnabled: true,
    spawnFn: fake.spawnFn,
    spawnBin: "node",
    followSupport: false,
    streamMinChars: 5,
    firstMergeWindowMs: 0,
    prefetchSupport: true,
    prefetchDepth: 1,
    prefetchTimeoutMs: 1000,
    ...overrides,
  });
}

/** 消息开始（登记 assistant 角色）。 */
const startEvent = (mid = MID) => ({
  type: "message.updated",
  properties: { sessionID: SID, info: { id: mid, role: "assistant" } },
});
/** text part 起始快照（登记 part 类型）。 */
const partEvent = (mid = MID) => ({
  type: "message.part.updated",
  properties: { part: { id: `p-${mid}`, type: "text", text: "", messageID: mid, sessionID: SID } },
});
/** 文本增量。 */
const deltaEvent = (text, mid = MID) => ({
  type: "message.part.delta",
  properties: { sessionID: SID, messageID: mid, partID: `p-${mid}`, field: "text", delta: text },
});
/** 消息完成（触发 finalize）。 */
const doneEvent = (mid = MID) => ({
  type: "message.updated",
  properties: { sessionID: SID, info: { id: mid, role: "assistant", time: { completed: Date.now() } } },
});

/** 临时数据目录。 */
function tempDataDir() {
  const dir = mkdtempSync(join(tmpdir(), "oc-auto-prefetch-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** `tts/` 临时目录里是否已清空（不存在也算空）。 */
function ttsDirEmpty(dataDir) {
  const dir = join(dataDir, "tts");
  return !existsSync(dir) || readdirSync(dir).length === 0;
}

test("预取：播第 1 句期间合成第 2 句，交播空档 <200ms 且顺序正确", async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const fake = makeFakeSpawn({ synthMs: 60, speakMs: 250, pcmPlayMs: 120 });
    const logs = makeLogs();
    const reader = createReader(dir, fake, logs);
    reader.handleEvent(startEvent());
    reader.handleEvent(partEvent());
    reader.handleEvent(deltaEvent("第一句话。"));
    await sleep(40); // 第 1 句已派生并开始播放
    reader.handleEvent(deltaEvent("第二句话。")); // 播放期间到达 → 触发预取
    await sleep(600);
    reader.handleEvent(doneEvent());
    await sleep(50);

    const speak = fake.spawns.filter((s) => s.kind === "speak");
    const synth = fake.spawns.filter((s) => s.kind === "synth");
    const playPcm = fake.spawns.filter((s) => s.kind === "play-pcm");
    assert.deepEqual(speak.map((s) => s.text), ["第一句话。"], "第 2 句不得再走整条管线串行路径");
    assert.deepEqual(synth.map((s) => s.text), ["第二句话。"], "只预取下一单元（深度 1）");
    assert.equal(playPcm.length, 1, "预取成功后派生一个预热播放进程");
    assert.ok(playPcm[0].args.includes("--pcm-follow"), "播放进程用跟随增长模式（新契约 argv）");
    assert.ok(synth[0].at < speak[0].exitedAt, "合成必须发生在第 1 句播放期间（并发）");
    assert.ok(playPcm[0].at < speak[0].exitedAt, "播放进程必须在上一单元退出前预热");
    assert.ok(playPcm[0].gateAt >= speak[0].exitedAt, "N+1 的音频不得早于 N 播完（交播闸门）");
    const gap = playPcm[0].gateAt - speak[0].exitedAt;
    assert.ok(gap < 200, `句间空档应 <200ms，实测 ${gap}ms`);
    assert.equal(ttsDirEmpty(dir), true, "预取临时文件播完即删");
  } finally {
    cleanup();
  }
});

test("交播不等合成：合成 6s、前句播放 3s ⇒ 交播空档 <200ms（不是等合成完成）", async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    // 长单元场景：合成 6000ms 明显长于前句播放 3000ms。修复前（第十四批）要等合成整段完成
    // （≈3000ms 剩余 + 预热），修复后 go 一写即起播（跟随文件增长）。
    const fake = makeFakeSpawn({ synthMs: 6000, speakMs: 3000, pcmPlayMs: 100 });
    const logs = makeLogs();
    // 合成 6s > 默认预取超时之外？不——默认 30s；这里显式给 10s 以免用例注入的 1s 触发超时
    const reader = createReader(dir, fake, logs, { prefetchTimeoutMs: 10000 });
    reader.handleEvent(startEvent());
    reader.handleEvent(partEvent());
    reader.handleEvent(deltaEvent("第一句话。"));
    await sleep(40); // 第 1 句已开始播放
    reader.handleEvent(deltaEvent("第二句话。")); // 播放期间到达 → 预取（合成 6s）

    const speak1 = () => fake.spawns.find((s) => s.kind === "speak");
    const playPcm = () => fake.spawns.find((s) => s.kind === "play-pcm");
    const synth = () => fake.spawns.find((s) => s.kind === "synth");
    await waitFor(() => speak1()?.exitCode !== undefined, 5000, "第 1 句播完");
    await waitFor(() => playPcm()?.gateAt !== undefined, 1000, "交播 go");
    const gap = playPcm().gateAt - speak1().exitedAt;
    assert.ok(gap < 200, `交播不得等整段合成完成，空档应 <200ms，实测 ${gap}ms`);
    assert.equal(synth().exitCode, undefined, "交播时合成仍在进行（6s 未完成）——证明没有等它");
    assert.ok(
      logs.lines.some((line) => line.includes("预取开始")),
      "预取应在第 1 句播放期间启动",
    );

    // 等合成/播放自然收尾，避免用例结束后仍有定时器写已删除目录
    await waitFor(() => synth().exitCode !== undefined, 8000, "合成结束");
    await waitFor(() => playPcm()?.exitCode !== undefined || playPcm() === undefined, 2000, "播放结束");
    reader.handleEvent(doneEvent());
    await sleep(60);
    assert.equal(ttsDirEmpty(dir), true, "播完即删临时文件");
  } finally {
    cleanup();
  }
});

test("预取中打断：kill 合成进程、无额外 spawn/播放，且不误杀后续新消息", async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const fake = makeFakeSpawn({ synthMs: 500, speakMs: 400 });
    const logs = makeLogs();
    const reader = createReader(dir, fake, logs);
    reader.handleEvent(startEvent());
    reader.handleEvent(partEvent());
    reader.handleEvent(deltaEvent("第一句话。"));
    await sleep(30);
    reader.handleEvent(deltaEvent("第二句话。"));
    await sleep(40);
    const synth = fake.spawns.find((s) => s.kind === "synth");
    assert.ok(synth, "预取应已启动");
    const before = fake.spawns.length;
    reader.interrupt(SID);
    await sleep(600);
    assert.equal(synth.child.killed, true, "打断必须 kill 预取合成进程");
    // 契约更新（第十五批）：播放进程与合成**同时**派生（预热），因此不再断言「play-pcm spawn=0」；
    // 新断言 = 未写 go（从未交播/出声）且被 kill（不留孤儿）。
    const prefetched = fake.spawns.filter((s) => s.kind === "play-pcm");
    assert.equal(prefetched.length, 1, "新契约：播放进程与合成同时派生（预热）");
    assert.equal(prefetched[0].gateAt, undefined, "预取未完成不得交播（未写 go，未出声）");
    assert.equal(prefetched[0].child.killed, true, "打断必须 kill 预热播放进程");
    assert.equal(fake.spawns.length, before, "打断后不得再有任何 spawn");
    assert.equal(ttsDirEmpty(dir), true, "打断必须丢弃缓冲并删文件");

    // 新消息不受影响（水位只作用于被打断的消息）
    reader.handleEvent(startEvent(MID2));
    reader.handleEvent(partEvent(MID2));
    reader.handleEvent(deltaEvent("新消息句。", MID2));
    await sleep(60);
    assert.equal(
      fake.spawns.filter((s) => s.kind === "speak" && s.text === "新消息句。").length,
      1,
      "后续新消息仍应正常朗读（不得误杀）",
    );
  } finally {
    cleanup();
  }
});

test("预取失败：该句退回串行播放（不丢句、不阻塞后续）", async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const fake = makeFakeSpawn({ synthMs: 40, synthFail: true, speakMs: 200 });
    const logs = makeLogs();
    const reader = createReader(dir, fake, logs);
    reader.handleEvent(startEvent());
    reader.handleEvent(partEvent());
    reader.handleEvent(deltaEvent("第一句话。"));
    await sleep(30);
    reader.handleEvent(deltaEvent("第二句话。"));
    await sleep(500);
    reader.handleEvent(doneEvent());
    await sleep(50);
    const speak = fake.spawns.filter((s) => s.kind === "speak");
    assert.deepEqual(speak.map((s) => s.text), ["第一句话。", "第二句话。"], "预取失败必须回退串行且不丢句");
    const prefetched = fake.spawns.filter((s) => s.kind === "play-pcm");
    assert.equal(prefetched.length, 1, "新契约：播放进程与合成同时派生（预热）");
    assert.equal(prefetched[0].gateAt, undefined, "合成失败时不得交播");
    assert.equal(prefetched[0].child.killed, true, "合成失败必须回收预热播放进程");
    assert.equal(ttsDirEmpty(dir), true);
  } finally {
    cleanup();
  }
});

test("预取超时：kill 合成进程并退回串行（该句仍完整播出）", async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const fake = makeFakeSpawn({ synthMs: 10000, speakMs: 200 });
    const logs = makeLogs();
    const reader = createReader(dir, fake, logs, { prefetchTimeoutMs: 60 });
    reader.handleEvent(startEvent());
    reader.handleEvent(partEvent());
    reader.handleEvent(deltaEvent("第一句话。"));
    await sleep(25);
    reader.handleEvent(deltaEvent("第二句话。"));
    await sleep(400);
    const synth = fake.spawns.find((s) => s.kind === "synth");
    assert.equal(synth.child.killed, true, "超时必须 kill 合成进程");
    const prefetched = fake.spawns.filter((s) => s.kind === "play-pcm");
    assert.equal(prefetched.length, 1, "新契约：播放进程与合成同时派生（预热）");
    assert.equal(prefetched[0].gateAt, undefined, "超时未交播不得写 go");
    assert.equal(prefetched[0].child.killed, true, "超时必须回收预热播放进程");
    assert.equal(
      fake.spawns.filter((s) => s.kind === "speak" && s.text === "第二句话。").length,
      1,
      "超时后该句退回串行播放",
    );
    assert.equal(ttsDirEmpty(dir), true);
  } finally {
    cleanup();
  }
});

test("标记丢失但播放进程退出码 0（已播完）⇒ 不重播（防双播）", async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    // 回归用例：旧实现只看 stdout 标记，marker 丢失 ⇒ 误判「从未起播」→ 串行重读 = **播两遍**
    const fake = makeFakeSpawn({ synthMs: 30, speakMs: 200, pcmPlayMs: 40, noPlayMarker: true });
    const logs = makeLogs();
    const reader = createReader(dir, fake, logs);
    reader.handleEvent(startEvent());
    reader.handleEvent(partEvent());
    reader.handleEvent(deltaEvent("第一句话。"));
    await sleep(20);
    reader.handleEvent(deltaEvent("第二句话。"));
    await sleep(700);
    const speak = fake.spawns.filter((s) => s.kind === "speak");
    assert.deepEqual(speak.map((s) => s.text), ["第一句话。"], "退出码 0=已播完，绝不能重读第二句");
    assert.equal(
      fake.spawns.filter((s) => s.kind === "play-pcm").length,
      1,
      "交播进程本身只派生一次",
    );
    reader.dispose();
  } finally {
    cleanup();
  }
});

test("播放进程退出码表示从未起播（1）⇒ 退回串行，且只重试一次", async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const fake = makeFakeSpawn({ synthMs: 30, speakMs: 200, pcmPlayMs: 40, noPlayMarker: true, playExitCode: 1 });
    const logs = makeLogs();
    const reader = createReader(dir, fake, logs);
    reader.handleEvent(startEvent());
    reader.handleEvent(partEvent());
    reader.handleEvent(deltaEvent("第一句话。"));
    await sleep(20);
    reader.handleEvent(deltaEvent("第二句话。"));
    await sleep(900);
    const speak = fake.spawns.filter((s) => s.kind === "speak");
    assert.deepEqual(speak.map((s) => s.text), ["第一句话。", "第二句话。"], "未起播才允许串行重读");
    assert.equal(
      speak.filter((s) => s.text === "第二句话。").length,
      1,
      "只重试一次（不得反复重读）",
    );
    reader.dispose();
  } finally {
    cleanup();
  }
});

test("深度 0：关闭预取（无 --pcm-out/--pcm-file 派生，行为回到串行）", async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const fake = makeFakeSpawn({ speakMs: 150 });
    const logs = makeLogs();
    const reader = createReader(dir, fake, logs, { prefetchDepth: 0 });
    reader.handleEvent(startEvent());
    reader.handleEvent(partEvent());
    reader.handleEvent(deltaEvent("第一句话。"));
    await sleep(25);
    reader.handleEvent(deltaEvent("第二句话。"));
    await sleep(400);
    assert.equal(fake.spawns.filter((s) => s.kind === "synth").length, 0);
    assert.equal(fake.spawns.filter((s) => s.kind === "play-pcm").length, 0);
    assert.deepEqual(
      fake.spawns.filter((s) => s.kind === "speak").map((s) => s.text),
      ["第一句话。", "第二句话。"],
    );
  } finally {
    cleanup();
  }
});

test("dispose：清场同样 kill 预取合成进程、不交播、删缓冲", async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const fake = makeFakeSpawn({ synthMs: 500, speakMs: 800 });
    const logs = makeLogs();
    const reader = createReader(dir, fake, logs);
    reader.handleEvent(startEvent());
    reader.handleEvent(partEvent());
    reader.handleEvent(deltaEvent("第一句话。"));
    await sleep(30);
    reader.handleEvent(deltaEvent("第二句话。"));
    await sleep(30);
    const synth = fake.spawns.find((s) => s.kind === "synth");
    assert.ok(synth);
    const before = fake.spawns.length;
    reader.dispose();
    await sleep(400);
    assert.equal(synth.child.killed, true);
    assert.equal(fake.spawns.length, before, "dispose 后不得再 spawn");
    const prefetched = fake.spawns.filter((s) => s.kind === "play-pcm");
    assert.equal(prefetched.length, 1, "新契约：播放进程与合成同时派生（预热）");
    assert.equal(prefetched[0].gateAt, undefined, "dispose 时不得交播");
    assert.equal(prefetched[0].child.killed, true, "dispose 必须回收预热播放进程");
    assert.equal(ttsDirEmpty(dir), true);
  } finally {
    cleanup();
  }
});
