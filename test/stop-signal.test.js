/**
 * 语音运行时「优雅停止」通道测试（2026-10-22 审计修复）。
 *
 * 修复前：runtime 只挂 `SIGINT`；TUI 正常停止发 SIGTERM（win32 上 Node 不可捕获，kill 即
 * `TerminateProcess`）⇒ `finish()` 不执行 → 无 `done` → segment 尾段被 `close()` 清掉（每次停止丢最后一句）。
 * 本文件覆盖：
 * 1. 控制器单元行为：SIGTERM/SIGINT 幂等收敛、stdin `stop` 令牌、stdin EOF、`--seconds` 定时器、
 *    `dispose()` 只清理不触发；
 * 2. 真实子进程集成：按运行时的方式 `spawn` 一个 worker，父进程写 `stop\n` → 子进程输出尾段 `final`
 *    与 `done` 并以 0 退出（证明 win32 也能优雅收尾）；
 * 3. POSIX 额外验证真 SIGTERM 走同一路径（win32 跳过，因系统层面不可捕获）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createStopController, platformStopSignals, STOP_STDIN_TOKEN } from "../dist/runtime/stop-signal.js";

/** 让事件循环转一圈。 */
function tick(ms = 20) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("platformStopSignals：win32 追加 SIGBREAK；POSIX 用 SIGINT/SIGTERM/SIGHUP", () => {
  assert.deepEqual(platformStopSignals("win32"), ["SIGINT", "SIGTERM", "SIGBREAK"]);
  assert.deepEqual(platformStopSignals("linux"), ["SIGINT", "SIGTERM", "SIGHUP"]);
});

test("控制器：SIGTERM/SIGINT 都收敛且幂等（监听器收尾后摘除）", async () => {
  const stdin = Readable.from([]);
  stdin.isTTY = true; // 禁用 stdin 通道，单测信号
  const baselineTerm = process.listenerCount("SIGTERM");
  const baselineInt = process.listenerCount("SIGINT");
  const controller = createStopController({ stdin, signals: ["SIGINT", "SIGTERM"] });
  let settled = 0;
  controller.stopped.then(() => {
    settled += 1;
  });
  process.emit("SIGTERM");
  process.emit("SIGINT");
  process.emit("SIGTERM");
  await controller.stopped;
  await tick();
  assert.equal(settled, 1, "重复信号只 resolve 一次");
  assert.equal(process.listenerCount("SIGTERM"), baselineTerm, "SIGTERM 监听器已摘除");
  assert.equal(process.listenerCount("SIGINT"), baselineInt, "SIGINT 监听器已摘除");
});

test("控制器：stdin `stop` 行与 EOF 都能触发（非 TTY 才启用）", async () => {
  const byToken = new Readable({ read() {} });
  byToken.isTTY = false;
  const c1 = createStopController({ stdin: byToken, signals: [] });
  byToken.push(`${STOP_STDIN_TOKEN}\n`);
  await c1.stopped;

  const byEof = new Readable({ read() {} });
  byEof.isTTY = false;
  const c2 = createStopController({ stdin: byEof, signals: [] });
  byEof.push(null);
  await c2.stopped;

  const tty = new Readable({ read() {} });
  tty.isTTY = true;
  const c3 = createStopController({ stdin: tty, signals: [] });
  tty.push(`${STOP_STDIN_TOKEN}\n`);
  let ttySettled = false;
  c3.stopped.then(() => {
    ttySettled = true;
  });
  await tick(30);
  assert.equal(ttySettled, false, "TTY 下打字不得被当作停止");
  c3.finish();
  await c3.stopped;
});

test("控制器：--seconds 到点收敛；dispose 只清理不触发", async () => {
  const stdin = Readable.from([]);
  stdin.isTTY = true;
  const timed = createStopController({ stdin, signals: [], seconds: 0.03 });
  await timed.stopped;

  const disposed = createStopController({ stdin, signals: [], seconds: 0.05 });
  let settled = false;
  disposed.stopped.then(() => {
    settled = true;
  });
  disposed.dispose();
  await tick(80);
  assert.equal(settled, false, "dispose 不 resolve");
});

/**
 * 生成「按运行时方式消费停止通道」的 worker 脚本。
 * @param moduleUrl stop-signal 模块 URL
 * @returns 脚本源码
 */
function workerSource(moduleUrl) {
  return [
    `import { createStopController } from ${JSON.stringify(moduleUrl)};`,
    "const stop = createStopController();",
    'process.stdout.write("ready\\n");',
    "await stop.stopped;",
    'process.stdout.write(JSON.stringify({ type: "final", text: "尾段" }) + "\\n");',
    'process.stdout.write(JSON.stringify({ type: "done" }) + "\\n");',
  ].join("\n");
}

/**
 * 启动 worker，等它 ready 后发送停止动作并收集输出。
 * @param {string} script worker 脚本
 * @param {(child: import("node:child_process").ChildProcess) => void} requestStop 停止动作
 * @returns {Promise<{code: number|null, stdout: string}>}
 */
function runWorker(script, requestStop) {
  const dir = mkdtempSync(join(tmpdir(), "stop-signal-"));
  const file = join(dir, "worker.mjs");
  writeFileSync(file, script, "utf8");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`worker 未在时限内退出；stdout=${stdout} stderr=${stderr}`));
    }, 5000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes("ready\n")) {
        stdout = stdout.replace("ready\n", "");
        requestStop(child);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      rmSync(dir, { recursive: true, force: true });
      resolve({ code, stdout });
    });
  });
}

test("集成：父进程写 stdin `stop` → worker 输出尾段 final + done 并以 0 退出", async () => {
  const moduleUrl = pathToFileURL(fileURLToPath(new URL("../dist/runtime/stop-signal.js", import.meta.url))).href;
  const { code, stdout } = await runWorker(workerSource(moduleUrl), (child) => {
    child.stdin.write(`${STOP_STDIN_TOKEN}\n`);
  });
  const lines = stdout.trim().split("\n").filter(Boolean);
  assert.equal(code, 0, "优雅停止后退出码必须为 0（不得被杀）");
  assert.deepEqual(
    lines.map((line) => JSON.parse(line).type),
    ["final", "done"],
    "停止后必须产出尾段 final 与 done",
  );
  assert.equal(JSON.parse(lines[0]).text, "尾段");
});

test("集成：POSIX 真 SIGTERM 走同一优雅路径（win32 上信号不可捕获，跳过）", { skip: process.platform === "win32" }, async () => {
  const moduleUrl = pathToFileURL(fileURLToPath(new URL("../dist/runtime/stop-signal.js", import.meta.url))).href;
  const { code, stdout } = await runWorker(workerSource(moduleUrl), (child) => {
    child.kill("SIGTERM");
  });
  assert.equal(code, 0);
  assert.match(stdout, /"type":"done"/);
});
