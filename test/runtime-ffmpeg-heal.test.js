/**
 * 运行时 ffmpeg 自愈接线回归（2026-10-23 第十七批）。
 *
 * 修复前：解析失败直接抛错，新机器（opencode 跳过 ffmpeg-static 的 install 脚本）必现
 * `spawnSync ffmpeg ENOENT`，没有任何自动补齐。
 *
 * 注入方式：
 * - `VOICE_FFMPEG_FORCE_HEAL=1` 强制跳过「已可用」短路；
 * - `VOICE_FFMPEG_STATIC_DIRS` 指向隔离临时目录（空 ⇒ unavailable，绝不联网）；
 * - 「自愈成功」用临时目录里一份 node 可执行文件冒充 ffmpeg（解析/枚举都会被尝试）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ffmpegBinaryName } from "../dist/voice/ffmpeg-heal.js";

/** runtime 脚本绝对路径（构建产物）。 */
const RUNTIME = fileURLToPath(new URL("../dist/runtime/voice-runtime.js", import.meta.url));

/**
 * 运行 runtime 并收集 NDJSON 事件（stdin 保持打开，模拟 TUI 的 pipe）。
 * @param {string} configDir 隔离配置目录
 * @param {Record<string, string|undefined>} extraEnv 额外环境变量
 * @returns {Promise<{code: number|null, events: object[], stderr: string, elapsedMs: number}>}
 */
function runRuntime(configDir, extraEnv) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(
      process.execPath,
      [RUNTIME, "--json", "--device", "___nope___", "--provider", "aliyun-qwen-file"],
      {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: {
          ...process.env,
          EMOTIONS_CONFIG_DIR: configDir,
          DASHSCOPE_API_KEY: "dummy-key",
          DASHSCOPE_WORKSPACE_ID: "dummy-workspace",
          ...extraEnv,
        },
      },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`runtime 未在 15s 内退出（悬挂）；stdout=${stdout} stderr=${stderr}`));
    }, 15_000);
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

test("解析失败 + 自愈不可用 ⇒ progress + error（带引导）+ 非 0 退出、不悬挂", async () => {
  const dir = mkdtempSync(join(tmpdir(), "runtime-heal-fail-"));
  try {
    const emptyStatic = join(dir, "empty-static");
    mkdirSync(emptyStatic, { recursive: true });
    const { code, events, elapsedMs } = await runRuntime(dir, {
      VOICE_FFMPEG_FORCE_HEAL: "1",
      VOICE_FFMPEG_STATIC_DIRS: emptyStatic,
      FFMPEG_BIN: join(dir, "missing-ffmpeg.exe"),
    });
    const types = events.map((event) => event.type);
    assert.equal(types.includes("progress"), true, "自愈前必须发 progress（TUI 显示准备中）");
    const progress = events.find((event) => event.type === "progress");
    assert.equal(progress.stage, "ffmpeg");
    const errors = events.filter((event) => event.type === "error");
    assert.equal(errors.length, 1, "失败必须发且只发一条 error");
    assert.match(errors[0].message, /ffmpeg 自动补齐失败/, "文案点明自愈失败");
    assert.match(errors[0].message, /FFMPEG_BIN/, "带现有引导（可设 FFMPEG_BIN）");
    assert.equal(types.includes("done"), false, "失败路径不得发 done");
    assert.equal(code, 1, "自愈失败必须以非 0 退出");
    assert.ok(elapsedMs < 10_000, `不得联网/悬挂（实际 ${elapsedMs}ms）`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("解析失败 + 自愈成功 ⇒ 继续枚举（不再报「未找到可用的 ffmpeg」）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "runtime-heal-ok-"));
  try {
    const staticDir = join(dir, "ffmpeg-static");
    mkdirSync(staticDir, { recursive: true });
    writeFileSync(join(staticDir, "package.json"), JSON.stringify({ name: "ffmpeg-static" }));
    const binary = join(staticDir, ffmpegBinaryName(process.platform));
    // 优先硬链接（避免复制 ≈80MB 触发杀软扫描、拖慢并发测试）；跨卷时回退复制
    try {
      linkSync(process.execPath, binary);
    } catch {
      copyFileSync(process.execPath, binary);
    }
    if (process.platform !== "win32") chmodSync(binary, 0o755);

    const { code, events } = await runRuntime(dir, {
      VOICE_FFMPEG_FORCE_HEAL: "1",
      VOICE_FFMPEG_STATIC_DIRS: staticDir,
      FFMPEG_BIN: join(dir, "missing-ffmpeg.exe"),
    });
    const types = events.map((event) => event.type);
    assert.equal(types.includes("progress"), true, "自愈成功也应有 progress");
    const errors = events.filter((event) => event.type === "error");
    assert.equal(errors.length, 1, "后续枚举失败会报错（用 node 冒充 ffmpeg）");
    assert.equal(
      /未找到可用的 ffmpeg/.test(errors[0].message),
      false,
      "自愈成功后不得再报 ffmpeg 全链路缺失（说明已继续枚举）",
    );
    assert.match(
      errors[0].message,
      /未采集到任何音频|未找到音频输入设备|无法启动 ffmpeg/,
      "错误应来自枚举/采集阶段（证明已越过自愈继续执行）",
    );
    assert.equal(code, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("已可用（FFMPEG_BIN 命中）⇒ 完全跳过自愈（无 progress）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "runtime-heal-skip-"));
  try {
    const { events } = await runRuntime(dir, {
      // 不设 VOICE_FFMPEG_FORCE_HEAL；node 自身冒充 ffmpeg，解析即命中
      FFMPEG_BIN: process.execPath,
      VOICE_FFMPEG_STATIC_DIRS: join(dir, "unused"),
    });
    const types = events.map((event) => event.type);
    assert.equal(types.includes("progress"), false, "已可用时不得触发自愈/联网");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
