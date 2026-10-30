/**
 * 语音运行时「采集进程异常退出」的端到端回归（2026-10-22 审计修复）。
 *
 * 修复前：采集进程（ffmpeg）以非 0 退出且 0 字节音频时，runtime 只在 stderr 打一行
 * `[采集结束] 退出码=…`，仍然发过 `ready`、继续以 10Hz 发 `level:0`、并一直等信号（实测挂死 12s），
 * 最终退出码还是 0 —— 上层无法区分「用户没说话」和「采集坏了」。
 *
 * 注入方式（2026-10-28 第十九批调整）：`FFMPEG_BIN` 指向**随附 ffmpeg-static 二进制**
 * （必须能通过 `-version` 真执行校验，见 `voice/ffmpeg.ts`），设备名用必定不存在的 `___nope___`
 * ⇒ ffmpeg 立即非 0 退出、0 字节。用 `--provider aliyun-qwen-file`（segment 客户端 `connect()` 无网络）
 * 与 dummy 凭证，保证失败点确实在采集而不是凭证/网络。随附二进制缺失（未下载）时跳过。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** runtime 脚本绝对路径（构建产物）。 */
const RUNTIME = fileURLToPath(new URL("../dist/runtime/voice-runtime.js", import.meta.url));
const require = createRequire(import.meta.url);

/**
 * 解析随附 ffmpeg-static 二进制（不可用则 null，测试跳过）。
 * @returns {string|null} 二进制绝对路径
 */
function selfContainedFfmpeg() {
  try {
    const resolved = require("ffmpeg-static");
    return typeof resolved === "string" && resolved.length > 0 && existsSync(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

/**
 * 运行 runtime 并收集 NDJSON 事件（stdin 保持打开，模拟 TUI 的 pipe）。
 * @param {string} configDir 隔离配置目录
 * @returns {Promise<{code: number|null, events: object[], stderr: string, elapsedMs: number}>}
 */
function runRuntime(configDir, ffmpegPath) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(
      process.execPath,
      [RUNTIME, "--json", "--device", "___nope___", "--provider", "aliyun-qwen-file"],
      {
        // stdin 用 pipe 且不关闭：与 TUI spawn 一致，避免 EOF 提前触发优雅停止
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: {
          ...process.env,
          EMOTIONS_CONFIG_DIR: configDir,
          // 随附 ffmpeg 二进制 + 不存在的设备 → 立即非 0 退出、0 字节
          FFMPEG_BIN: ffmpegPath,
          DASHSCOPE_API_KEY: "dummy-key",
          DASHSCOPE_WORKSPACE_ID: "dummy-workspace",
        },
      },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`runtime 未在 10s 内退出（悬挂）；stdout=${stdout} stderr=${stderr}`));
    }, 10_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      const events = stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      resolve({ code, events, stderr, elapsedMs: Date.now() - startedAt });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

test("采集进程立即异常退出：无 ready / 有 error / 无 level / 退出码非 0 / 不悬挂", async (t) => {
  const ffmpeg = selfContainedFfmpeg();
  if (!ffmpeg) {
    t.skip("需要 ffmpeg-static 随附二进制（本机未下载）");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "runtime-capture-fail-"));
  try {
    const { code, events, stderr, elapsedMs } = await runRuntime(dir, ffmpeg);
    const types = events.map((event) => event.type);
    assert.equal(types.includes("ready"), false, "采集未就绪不得发 ready（修复前会发）");
    assert.equal(types.includes("level"), false, "采集已死不得继续刷 level（修复前 10Hz）");
    assert.equal(types.includes("done"), false, "失败路径不得发 done（会与退出码 0 混淆）");
    const errors = events.filter((event) => event.type === "error");
    assert.equal(errors.length, 1, "必须发且只发一条 error");
    assert.equal(errors[0].code, "capture-failed", "error 事件必须带稳定 code（修复前无 code）");
    assert.match(errors[0].message, /采集|音频/, "error 文案点明采集链");
    assert.match(errors[0].message, /退出码/, "error 带采集进程退出码");
    assert.equal(code, 1, "异常退出必须以非 0 退出码结束（修复前为 0）");
    assert.ok(elapsedMs < 8000, `不得悬挂等待信号（实际 ${elapsedMs}ms）`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
