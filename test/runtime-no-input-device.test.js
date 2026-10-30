/**
 * 「无音频输入设备」一等错误的端到端回归（2026-10-30 第二十一批）。
 *
 * 修复前：枚举成功但 0 设备时只抛普通 Error ⇒ 退出码 1、`--list` 打一行引导后仍退出 0，
 * TUI 只能看到「语音运行时已退出（code=1）」，无法区分「没设备」与「配置错」。
 * 修复后：NDJSON `error.code=no-input-device` + 专用退出码 3 + stderr 同句可操作文案。
 *
 * 注入方式（纯 Node、不依赖真实设备）：`FFMPEG_BIN` 指向 **pwsh**——
 * `pwsh -Version` 退出码 0（通过真执行校验、跳过自愈），而 dshow 枚举参数对 pwsh 无意义、
 * 不会输出任何 `[dshow]` 设备行 ⇒ 枚举成功且设备数为 0。仅 win32 走 dshow，其他平台跳过；
 * 本机无 pwsh 时同样跳过（不伪造「设备枚举」实现）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** runtime 脚本绝对路径（构建产物）。 */
const RUNTIME = fileURLToPath(new URL("../dist/runtime/voice-runtime.js", import.meta.url));
/** 专用退出码（与 `voice/ndjson.ts` 的 EXIT_NO_INPUT_DEVICE 对齐）。 */
const EXIT_NO_INPUT_DEVICE = 3;

/**
 * 取可用的「假 ffmpeg」：`-version` 退出 0、枚举参数不产设备行。
 * @returns {string|null} 可执行名；不可用时 null（测试跳过）
 */
function fakeFfmpeg() {
  try {
    const probe = spawnSync("pwsh", ["-Version"], { encoding: "utf8", timeout: 5000, windowsHide: true });
    return probe.status === 0 ? "pwsh" : null;
  } catch {
    return null;
  }
}

/**
 * 运行 runtime 并收集 NDJSON 事件（stdin 保持打开，模拟 TUI 的 pipe）。
 * @param {string[]} extraArgs runtime 参数
 * @param {string} configDir 隔离配置目录
 * @param {string} ffmpeg 「假 ffmpeg」可执行名
 * @param {Record<string, string|undefined>} [extraEnv] 额外环境变量（如 VOICE_UI_LANGUAGE）；
 *   值为 `undefined` 表示**从子进程环境里删除该键**（不是「传 undefined」）
 * @returns {Promise<{code: number|null, events: object[], stdout: string, stderr: string}>}
 */
function runRuntime(extraArgs, configDir, ffmpeg, extraEnv = {}) {
  // `spawn` 的 env 里值为 undefined 的键会被**丢弃**（不是删除），父进程同名变量会原样残留，
  // 所以「没有凭证」的用例必须先显式 delete 再 spawn。
  const env = {
    ...process.env,
    EMOTIONS_CONFIG_DIR: configDir,
    // 「假 ffmpeg」：`-version` 通过；dshow 枚举参数不产设备行 ⇒ 空列表
    FFMPEG_BIN: ffmpeg,
  };
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RUNTIME, ...extraArgs], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`runtime 未在 10s 内退出；stdout=${stdout} stderr=${stderr}`));
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
      const events = extraArgs.includes("--json")
        ? stdout
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [];
      resolve({ code, events, stdout, stderr });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * 建一个隔离配置目录（loadVoiceConfig 不读用户真实配置）。
 * @returns {string} 目录路径
 */
function makeConfigDir() {
  return mkdtempSync(join(tmpdir(), "runtime-no-mic-"));
}

test("麦克风模式枚举为空：error.code=no-input-device + 退出码 3 + stderr 同一句文案，且不进采集", async (t) => {
  if (process.platform !== "win32") {
    t.skip("设备枚举注入依赖 Windows dshow 分支（其他平台不适用）");
    return;
  }
  const ffmpeg = fakeFfmpeg();
  if (!ffmpeg) {
    t.skip("本机无 pwsh，无法注入「枚举为空」");
    return;
  }
  const dir = makeConfigDir();
  try {
    const { code, events, stderr } = await runRuntime(["--json", "--provider", "aliyun-qwen-file"], dir, ffmpeg, { VOICE_UI_LANGUAGE: "zh" });
    const errors = events.filter((event) => event.type === "error");
    assert.equal(errors.length, 1, "必须且只发一条 error");
    assert.equal(errors[0].code, "no-input-device", "error 事件必须带稳定错误码（修复前无 code）");
    assert.match(errors[0].message, /未检测到音频输入设备/, "error 文案点明缺麦克风");
    assert.match(errors[0].message, /--list/, "error 文案给出自查入口");
    assert.equal(code, EXIT_NO_INPUT_DEVICE, "无设备必须用专用退出码 3（修复前为 1）");
    assert.match(stderr, /未检测到音频输入设备/, "stderr 必须打同一句可操作文案");
    const types = events.map((event) => event.type);
    assert.equal(types.includes("ready"), false, "无设备不得进入采集（不发 ready）");
    assert.equal(types.includes("level"), false, "无设备不得发 level");
    assert.equal(types.includes("done"), false, "失败路径不得发 done（避免与正常结束混淆）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--list 枚举为空：打印提示且退出码 3（修复前空列表 + 退出 0）", async (t) => {
  if (process.platform !== "win32") {
    t.skip("设备枚举注入依赖 Windows dshow 分支（其他平台不适用）");
    return;
  }
  const ffmpeg = fakeFfmpeg();
  if (!ffmpeg) {
    t.skip("本机无 pwsh，无法注入「枚举为空」");
    return;
  }
  const dir = makeConfigDir();
  try {
    const { code, events, stderr } = await runRuntime(["--json", "--list"], dir, ffmpeg, { VOICE_UI_LANGUAGE: "zh" });
    assert.equal(code, EXIT_NO_INPUT_DEVICE, "--list 无设备必须以退出码 3 结束");
    assert.match(stderr, /未检测到音频输入设备/, "人类日志（--json 下走 stderr）必须打印提示");
    const errors = events.filter((event) => event.type === "error");
    assert.equal(errors.length, 1, "--json --list 无设备也必须发一条结构化 error");
    assert.equal(errors[0].code, "no-input-device");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const plainDir = makeConfigDir();
  try {
    const { code, stdout } = await runRuntime(["--list"], plainDir, ffmpeg, { VOICE_UI_LANGUAGE: "zh" });
    assert.equal(code, EXIT_NO_INPUT_DEVICE);
    assert.match(stdout, /未检测到音频输入设备/, "非 json 模式提示必须打到 stdout（对用户可见）");
  } finally {
    rmSync(plainDir, { recursive: true, force: true });
  }
});

test("uiLanguage=en：同一条无设备错误只出英文（stderr 不含中文，修复前硬编码中文）", async (t) => {
  if (process.platform !== "win32") {
    t.skip("设备枚举注入依赖 Windows dshow 分支（其他平台不适用）");
    return;
  }
  const ffmpeg = fakeFfmpeg();
  if (!ffmpeg) {
    t.skip("本机无 pwsh，无法注入「枚举为空」");
    return;
  }
  const dir = makeConfigDir();
  try {
    const { code, events, stderr } = await runRuntime(["--json", "--provider", "aliyun-qwen-file"], dir, ffmpeg, {
      VOICE_UI_LANGUAGE: "en",
    });
    assert.equal(code, EXIT_NO_INPUT_DEVICE);
    // 只对**用户可见错误行**断言语言：stderr 还含内部中文日志（如 `[ffmpeg] 使用 FFMPEG_BIN（pwsh），跳过自检`），
    // 那部分按契约保留中文、不参与用户文案（见设计文档「错误码与文案本地化」）。
    const visibleLines = stderr.split(/\r?\n/).filter((line) => line.trim() !== "" && !line.startsWith("[ffmpeg]"));
    const visible = visibleLines.join("\n");
    assert.ok(visible.length > 0, "en 下必须仍有用户可见错误行");
    assert.match(visible, /No audio input device/i, "en 下用户可见错误行必须英文");
    assert.doesNotMatch(visible, /[\u4e00-\u9fff]/, "en 下用户可见错误行不得混排中文");
    assert.doesNotMatch(visible, /音频输入设备/, "en 下不得残留中文模板句");
    // 内部日志行仍为中文（日志侧不本地化，便于按固定关键字排查）
    assert.ok(stderr.split(/\r?\n/).some((line) => line.startsWith("[ffmpeg]")), "内部日志行不受语言影响（仍存在）");
    // NDJSON message 同样按 uiLanguage 渲染，故此处为英文（JSON 消费者无需再查文案表）
    const errorEvent = events.filter((event) => event.type === "error")[0];
    assert.equal(errorEvent.code, "no-input-device");
    assert.doesNotMatch(errorEvent.message, /[\u4e00-\u9fff]/, "en 下 NDJSON message 也不得混排中文");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("凭证缺失：error.code=credentials-missing + 退出码 1（修复前无 code）", async (t) => {
  if (process.platform !== "win32") {
    t.skip("依赖 Windows 分支的 ffmpeg 假体（其他平台跳过）");
    return;
  }
  const ffmpeg = fakeFfmpeg();
  if (!ffmpeg) {
    t.skip("本机无 pwsh，无法注入假 ffmpeg");
    return;
  }
  const dir = makeConfigDir();
  try {
    // --wav 跳过设备枚举；凭证解析先于读 WAV ⇒ 稳定命中凭证缺失
    const { code, events } = await runRuntime(["--json", "--wav", "___nope___.wav", "--provider", "aliyun-qwen-file"], dir, ffmpeg, {
      VOICE_UI_LANGUAGE: "en",
      DASHSCOPE_API_KEY: undefined,
      DASHSCOPE_WORKSPACE_ID: undefined,
      ALIYUN_ACCESS_KEY_ID: undefined,
    });
    const errors = events.filter((event) => event.type === "error");
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, "credentials-missing", "凭证缺失必须带稳定 code");
    assert.equal(code, 1, "凭证缺失仍按退出码 1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});