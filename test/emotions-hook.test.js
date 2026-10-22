/**
 * server 插件 `chat.message` **按 sessionID 隔离打断**的行为级单测（修跨会话误杀）。
 *
 * 背景根因（2026-10-21 实证）：任意窗口任意会话的 `chat.message` 都无条件 `stopPlayback()`，
 * 而 `tts-playback` 是全局文件——另一窗口新会话来消息会把本会话正在播的 sapi follow worker
 * 杀在句中。修复后 `stopPlayback({ sessionID: input.sessionID })`：
 * 跨会话条目**不杀不清**、同会话条目照停、无主条目（手动 speak/旧格式）任何消息可停。
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

import emotions from "../dist/emotions.js";
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
  // chat.message 必须把钩子入参的 sessionID 透传给 interrupt（会话收窄的唯一接线点）
  const scoped = code.match(/interrupt\(\s*input\.sessionID\s*\)/g) ?? [];
  assert.equal(scoped.length, 1, "chat.message 必须调用 autoReader.interrupt(input.sessionID)");
});
