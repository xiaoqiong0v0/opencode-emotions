/**
 * 运行时 ffmpeg 启动自检接线回归（2026-10-23 第十七批；2026-10-28 第十九批改纯自包含）。
 *
 * 口径：非 Termux 下只要 `FFMPEG_BIN` 未通过 `-version` 真执行校验，就**总是**走
 * `ensureFfmpegBinary()`（不再「全部解析失败才自愈」，也不再回落系统 PATH）。
 *
 * 注入方式：
 * - `VOICE_FFMPEG_STATIC_DIRS` 指向隔离临时目录（空 ⇒ unavailable，绝不联网）；
 * - 「自检成功」用临时目录里一份**能通过 `-version`** 的可执行文件冒充 ffmpeg
 *   （Windows 用 `cmd.exe` 副本：`cmd -version` 退出码 0；POSIX 用 `#!/bin/sh` 脚本）；
 * - `--list` 走 `spawnSync` 枚举（不会因 stdin 管道悬挂），便于验证「已越过自检」。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ffmpegBinaryName } from "../dist/voice/ffmpeg-heal.js";

/** runtime 脚本绝对路径（构建产物）。 */
const RUNTIME = fileURLToPath(new URL("../dist/runtime/voice-runtime.js", import.meta.url));
/** 默认（麦克风模式）argv。 */
const MIC_ARGV = ["--json", "--device", "___nope___", "--provider", "aliyun-qwen-file"];
/**
 * 断言中文文案的用例**必须固定** `uiLanguage=zh`。
 *
 * 2026-10-30 第二十二批起 NDJSON `message` / stderr 用户文案按 `uiLanguage` 渲染，而内置默认是 `en`；
 * 不固定语言就会读到英文（例：「No usable ffmpeg found…」而不是「未找到可用的 ffmpeg…」）。
 */
const UI_ZH = { VOICE_UI_LANGUAGE: "zh" };

/**
 * 造一个「`-version` 退出码 0」的假 ffmpeg（不联任何网）。
 * @param {string} dir 目标目录
 * @returns {string} 二进制绝对路径
 */
function writeFakeFfmpeg(dir) {
  const binary = join(dir, ffmpegBinaryName(process.platform));
  if (process.platform === "win32") {
    // cmd.exe -version 退出码 0；后续枚举参数也不阻塞（spawnSync 下 stdin 立即关闭）
    const comspec = process.env.COMSPEC ?? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
    copyFileSync(comspec, binary);
    return binary;
  }
  writeFileSync(binary, '#!/bin/sh\nif [ "$1" = "-version" ]; then echo "ffmpeg version fake"; exit 0; fi\nexit 1\n');
  chmodSync(binary, 0o755);
  return binary;
}

/**
 * 运行 runtime 并收集输出（stdin 保持打开，模拟 TUI 的 pipe）。
 * @param {string} configDir 隔离配置目录
 * @param {Record<string, string|undefined>} extraEnv 额外环境变量
 * @param {string[]} argv 命令行参数
 * @returns {Promise<{code: number|null, stdout: string, events: object[], stderr: string, elapsedMs: number}>}
 */
function runRuntime(configDir, extraEnv, argv = MIC_ARGV) {
  // 隔离 PATH（仅 Windows）：宿主机装没装系统 ffmpeg 不得影响「解析失败」用例；
  // 空目录里没有任何可执行文件，ffmpeg-static 的路径来源也由各用例的 FFMPEG_BIN 显式控制。
  // Linux 保留系统 PATH：设备枚举依赖 pactl / arecord（生产路径不回落 ffmpeg，无需隔离）。
  const emptyPath = join(configDir, "empty-path");
  mkdirSync(emptyPath, { recursive: true });
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, [RUNTIME, ...argv], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        EMOTIONS_CONFIG_DIR: configDir,
        ...(process.platform === "win32" ? { PATH: emptyPath } : {}),
        DASHSCOPE_API_KEY: "dummy-key",
        DASHSCOPE_WORKSPACE_ID: "dummy-workspace",
        ...extraEnv,
      },
    });
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
      const events = argv.includes("--json")
        ? stdout
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [];
      resolve({ code, stdout, events, stderr, elapsedMs: Date.now() - startedAt });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

test("自检不可用 ⇒ progress + error（带引导）+ 非 0 退出、不悬挂", async () => {
  const dir = mkdtempSync(join(tmpdir(), "runtime-heal-fail-"));
  try {
    const emptyStatic = join(dir, "empty-static");
    mkdirSync(emptyStatic, { recursive: true });
    const { code, events, elapsedMs } = await runRuntime(dir, {
      ...UI_ZH,
      VOICE_FFMPEG_STATIC_DIRS: emptyStatic,
      FFMPEG_BIN: join(dir, "missing-ffmpeg.exe"),
    });
    const types = events.map((event) => event.type);
    assert.equal(types.includes("progress"), true, "自检前必须发 progress（TUI 显示准备中）");
    const progress = events.find((event) => event.type === "progress");
    assert.equal(progress.stage, "ffmpeg");
    const errors = events.filter((event) => event.type === "error");
    assert.equal(errors.length, 1, "失败必须发且只发一条 error");
    assert.equal(errors[0].code, "ffmpeg-unavailable", "error 事件必须带稳定 code（修复前无 code）");
    // 文案口径（第二十二批）：`message` 是**按 uiLanguage 渲染的用户文案**，不再是内部拼接串
    assert.match(errors[0].message, /未找到可用的 ffmpeg/, "文案点明自检失败（zh 用户文案）");
    assert.match(errors[0].message, /FFMPEG_BIN/, "带引导（可设 FFMPEG_BIN）");
    assert.equal(types.includes("done"), false, "失败路径不得发 done");
    assert.equal(code, 1, "自检失败必须以非 0 退出");
    assert.ok(elapsedMs < 10_000, `不得联网/悬挂（实际 ${elapsedMs}ms）`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("随附二进制存在且 -version 通过 ⇒ 直接用，不 spawn install.js（无 install.js 也成功）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "runtime-heal-ok-"));
  try {
    const staticDir = join(dir, "ffmpeg-static");
    mkdirSync(staticDir, { recursive: true });
    writeFileSync(join(staticDir, "package.json"), JSON.stringify({ name: "ffmpeg-static" }));
    writeFakeFfmpeg(staticDir);
    // 刻意不写 install.js：若误判为「不可用」会走下载并因缺脚本失败
    const { code, stdout, stderr } = await runRuntime(
      dir,
      { ...UI_ZH, VOICE_FFMPEG_STATIC_DIRS: staticDir, FFMPEG_BIN: join(dir, "missing-ffmpeg.exe") },
      ["--list"],
    );
    // 假 ffmpeg 枚举不出真实设备 ⇒ 枚举成功但 0 设备 = 一等错误（退出码 3，见第二十一批）
    assert.equal(code, 3, `应越过自检并走到设备枚举（无设备 ⇒ 3）；stderr=${stderr}`);
    assert.match(stdout, /未检测到音频输入设备/, "必须走到设备枚举并给出提示");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("随附二进制存在但 -version 失败 ⇒ 视为不可用（不信「文件存在」）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "runtime-heal-broken-"));
  try {
    const staticDir = join(dir, "ffmpeg-static");
    mkdirSync(staticDir, { recursive: true });
    writeFileSync(join(staticDir, "package.json"), JSON.stringify({ name: "ffmpeg-static" }));
    // 存在但不是可执行程序 ⇒ -version 必失败；无 install.js ⇒ unavailable
    writeFileSync(join(staticDir, ffmpegBinaryName(process.platform)), "not an executable");
    const { code, stderr } = await runRuntime(
      dir,
      { ...UI_ZH, VOICE_FFMPEG_STATIC_DIRS: staticDir, FFMPEG_BIN: join(dir, "missing-ffmpeg.exe") },
      ["--list"],
    );
    assert.equal(code, 1, "存在但不可执行不得被当作可用");
    assert.match(stderr, /未找到可用的 ffmpeg/, "stderr 用户文案点明失败原因（zh）");
    assert.match(stderr, /FFMPEG_BIN/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FFMPEG_BIN 通过 -version 校验 ⇒ 完全跳过自检（无 progress）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "runtime-heal-skip-"));
  try {
    const fakeDir = join(dir, "bin");
    mkdirSync(fakeDir, { recursive: true });
    const fake = writeFakeFfmpeg(fakeDir);
    const { code, stdout, stderr } = await runRuntime(dir, {
      ...UI_ZH,
      FFMPEG_BIN: fake,
      VOICE_FFMPEG_STATIC_DIRS: join(dir, "unused"),
    }, ["--list"]);
    assert.equal(code, 3, `应使用 FFMPEG_BIN 继续枚举（假 ffmpeg 无设备 ⇒ 3）；stderr=${stderr}`);
    assert.equal(/准备 ffmpeg/.test(stdout), false, "已可用时不得触发自检/联网");
    assert.match(stdout, /未检测到音频输入设备/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FFMPEG_BIN 存在但不可执行 ⇒ 不得盲信，仍走自检（修复前会直接跳过）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "runtime-heal-badexec-"));
  try {
    const emptyStatic = join(dir, "empty-static");
    mkdirSync(emptyStatic, { recursive: true });
    const bad = join(dir, "ffmpeg.exe");
    writeFileSync(bad, "not an executable");
    const { code, events } = await runRuntime(dir, {
      VOICE_FFMPEG_STATIC_DIRS: emptyStatic,
      FFMPEG_BIN: bad,
    });
    const types = events.map((event) => event.type);
    assert.equal(types.includes("progress"), true, "不可执行的 FFMPEG_BIN 必须触发自检");
    assert.equal(code, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
