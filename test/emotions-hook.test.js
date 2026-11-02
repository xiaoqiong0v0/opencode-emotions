/**
 * server 插件 `chat.message` **按 sessionID 隔离打断**的行为级单测（修跨会话误杀）。
 *
 * 背景根因（2026-10-21 实证）：任意窗口任意会话的 `chat.message` 都无条件 `stopPlayback()`，
 * 而 `tts-playback` 是全局文件——另一窗口新会话来消息会把本会话正在播的 sapi follow worker
 * 杀在句中。修复后 `stopPlayback({ sessionID: input.sessionID })`：
 * 跨会话条目**不杀不清**、同会话条目照停、无主条目（手动 CLI/旧格式）按会话停**跳过**。
 *
 * 手法（不真杀任何进程）：
 * - 把 `USERPROFILE`/`HOME` 指向临时目录 → `os.homedir()` 每次读 env，播放状态根随之隔离；
 * - 条目 `pid` 用**本进程 pid**（红线 `pid≠自身` 挡下）→ 同会话路径的可观测结果只是「状态被清」，
 *   全程不向任何真实 PID 发信号；
 * - 断言「条目保留 / 被清」即证明 hook 把 `input.sessionID` 传给了 `stopPlayback`
 *   （跨会话若仍无条件停，条目会被清空 → ① 断言失败）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import emotions, { interruptOnUserMessage, resolveChatSessionID } from "../dist/emotions.js";
import { autoTtsDataDir } from "../dist/voice/auto-tts.js";
import { playbackStatePath, readPlayback, writePlayback } from "../dist/voice/playback-state.js";

test("chat.message：按 input.sessionID 隔离打断（跨会话保留条目、同会话清条目）", async () => {
  const home = mkdtempSync(join(tmpdir(), "emotions-hook-"));
  const prevProfile = process.env.USERPROFILE;
  const prevHome = process.env.HOME;
  try {
    // 隔离状态根：homedir() 在每次调用时读 env（Windows 读 USERPROFILE、POSIX 读 HOME）
    process.env.USERPROFILE = home;
    process.env.HOME = home;
    const dataDir = autoTtsDataDir();
    const stateFile = playbackStatePath({ dataDir });
    assert.ok(stateFile.startsWith(home), "状态根已隔离到临时目录（前置自检）");
    // writePlayback 不建目录（生产里 base 根由插件运行时已建）——测试手动补上
    mkdirSync(dataDir, { recursive: true });

    // 构造「本会话正在播放」的条目：pid=自身 → 任何杀流程都会被红线挡下（零真实信号）
    // （多条目 map：entry.sessionID=ses_target → 键=ses_target；taskId: undefined 经 JSON 往返省略，deepEqual 需键一致）
    const startedAt = Date.now();
    const expected = { pid: process.pid, provider: "sapi", taskId: undefined, startedAt, kind: "speak", sessionID: "ses_target" };
    writePlayback(expected, { dataDir });
    assert.deepEqual(readPlayback("ses_target", { dataDir }), expected, "条目已写入");

    // server 工厂：client 惰性使用（本测试不触发 fetch），最小桩即可
    assert.equal(typeof emotions.server, "function", "默认导出含 server 工厂");
    const hooks = await emotions.server({ client: {} });
    assert.equal(typeof hooks["chat.message"], "function", "chat.message 钩子存在");
    assert.equal(typeof hooks.dispose, "function", "dispose 钩子存在（清场：取消预取/朗读子进程）");
    await hooks.dispose();

    // ① 跨会话消息（另一窗口新会话）→ 不杀不清：条目原样保留（误杀修复的核心断言）
    await hooks["chat.message"]({ sessionID: "ses_other", client: {} }, {});
    assert.deepEqual(
      readPlayback("ses_target", { dataDir }),
      expected,
      "跨会话打断被跳过：条目保留（pid 未被触碰）",
    );

    // ② 同会话消息 → 走停止流程：红线（pid=自身）挡下 → 可观测结果为状态被清
    await hooks["chat.message"]({ sessionID: "ses_target", client: {} }, {});
    assert.equal(existsSync(stateFile), false, "同会话打断执行了停止流程（状态被清）");
  } finally {
    if (prevProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevProfile;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("chat.message 把 input.sessionID 传给 autoReader.interrupt（产物无裸 interrupt 全清）", () => {
  // 手法同 tui-diagnostics：读构建产物 `dist/emotions.js` 文本做接线断言——autoReader 是 server
  // 工厂内部实例、测试无法注入观察，而「传没传 sessionID」正是跨会话腰斩的接线点（tui 侧
  // stopPlayback 已有同款产物断言先例）。行为级隔离断言见 test/auto-tts.test.js 的 interrupt 用例。
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "emotions.js"), "utf8");
  // 只看代码行（滤掉注释行——doc/行内注释里允许出现调用示例文本）
  const code = src
    .split("\n")
    .filter((line) => {
      const head = line.trim();
      return !head.startsWith("*") && !head.startsWith("//") && !head.startsWith("/*");
    })
    .join("\n");
  // 裸调用 = 全清（清所有会话队列/置所有水位/杀所有子进程），必须绝迹
  assert.deepEqual(code.match(/interrupt\(\s*\)/g) ?? [], [], "存在裸 interrupt()：跨会话清队列/水位/杀子进程回归");
  // chat.message 必须把钩子入参交给带归属解析的打断入口（会话收窄的唯一接线点）
  const wired = code.match(/interruptOnUserMessage\(input, autoReader\)/g) ?? [];
  assert.equal(wired.length, 1, "chat.message 必须调用 interruptOnUserMessage(input, autoReader)");
  // 解析后的 sessionID 才允许传给 interrupt（不得再透传可能缺失的 input.sessionID）
  assert.ok(/interrupt\(sessionID\)/.test(code), "interrupt 必须收到已解析的 sessionID");
});

test("resolveChatSessionID：sessionID → properties.sessionID → message.sessionID 逐级回落", () => {
  assert.equal(resolveChatSessionID({ sessionID: " ses_a " }), "ses_a", "首级 trim");
  assert.equal(resolveChatSessionID({ sessionID: "  ", properties: { sessionID: "ses_b" } }), "ses_b", "空白回落到 properties");
  assert.equal(resolveChatSessionID({ message: { sessionID: "ses_c" } }), "ses_c", "回落到 message");
  assert.equal(resolveChatSessionID({}), undefined);
  assert.equal(resolveChatSessionID(undefined), undefined);
});

test("缺归属：跳过打断（不调 stopPlayback / interrupt、不抛，warn 只记一次）", () => {
  // 修复前 `stopPlayback({ sessionID: undefined })` = 停全部条目、`interrupt(undefined)` = 全清，
  // 本用例（spy 断言零调用 + warn 一次）在修复前必红。
  const calls = { stop: [], interrupt: [], warn: [] };
  const deps = {
    stop: (options) => calls.stop.push(options),
    interrupt: (sessionID) => calls.interrupt.push(sessionID),
    warn: (message) => calls.warn.push(message),
    warnState: { warned: false },
  };
  assert.doesNotThrow(() => interruptOnUserMessage({}, undefined, deps), "缺归属绝不抛出");
  assert.equal(interruptOnUserMessage({ sessionID: "   " }, undefined, deps), false);
  assert.deepEqual(calls.stop, [], "缺归属不得调用 stopPlayback（否则隐式全清）");
  assert.deepEqual(calls.interrupt, [], "缺归属不得调用 interrupt()");
  assert.equal(calls.warn.length, 1, "同一进程只 warn 一次（防刷屏）");
  assert.match(calls.warn[0], /可用字段/, "warn 含可用字段诊断");
});

test("有归属：只以该 sessionID 调用 stopPlayback 与 interrupt", () => {
  const calls = { stop: [], interrupt: [] };
  const ok = interruptOnUserMessage(
    { sessionID: "ses_target" },
    undefined,
    { stop: (options) => calls.stop.push(options), interrupt: (sessionID) => calls.interrupt.push(sessionID) },
  );
  assert.equal(ok, true);
  assert.deepEqual(calls.stop, [{ sessionID: "ses_target" }], "stopPlayback 只收到该会话 id");
  assert.deepEqual(calls.interrupt, ["ses_target"], "interrupt 只收到该会话 id");
});

test("chat.message 钩子：缺 sessionID 不触碰任何会话的播放条目", async () => {
  const home = mkdtempSync(join(tmpdir(), "emotions-hook-skip-"));
  const prevProfile = process.env.USERPROFILE;
  const prevHome = process.env.HOME;
  try {
    process.env.USERPROFILE = home;
    process.env.HOME = home;
    const dataDir = autoTtsDataDir();
    mkdirSync(dataDir, { recursive: true });
    const entry = { pid: process.pid, provider: "sapi", taskId: undefined, startedAt: Date.now(), kind: "speak", sessionID: "ses_keep" };
    writePlayback(entry, { dataDir });

    const hooks = await emotions.server({ client: {} });
    await hooks["chat.message"]({}, {});
    assert.deepEqual(readPlayback("ses_keep", { dataDir }), entry, "缺归属时任何会话条目都不得被清");
  } finally {
    if (prevProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevProfile;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
});


