/**
 * 运行时脚本路径解析与 stderr 摘要的离线单测（`dist/lib/runtime-diagnostics.js`）。
 *
 * 背景（2026-10-22 根因）：TUI 旧实现把运行时脚本按 **cwd 相对**拼，用户在家目录启动 opencode
 * ⇒ 拼出不存在的 `<home>/dist/runtime/voice-runtime.js` ⇒ spawn 的 node 立即 `Cannot find module`
 * 退出（code=1），而 toast 只显 stderr **末行**（`Node.js v24.x`），完全看不出原因。
 * 本测试锁两件事：① 解析顺序 **env > 插件产物自身位置 > cwd 兜底**（含候选都不存在的显式失败）；
 * ② stderr 摘要取**含错误标记的关键行**而非末行。存在性检查全经注入，不碰真实文件系统。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  pickStderrSummary,
  resolveRuntimeScript,
  STDERR_SUMMARY_MAX,
  summarizeRuntimeFailure,
  RUNTIME_RELATIVE_TO_CWD,
  RUNTIME_RELATIVE_TO_SELF,
  selfDirFromModuleUrl,
} from "../dist/lib/runtime-diagnostics.js";

/** 把给定集合视为「存在」的存在性检查（纯内存，不触文件系统）。 */
function existsSet(paths) {
  const set = new Set(paths);
  return (path) => set.has(path);
}

/** 以 Windows 语义调用解析（显式注入平台，断言不随宿主平台漂移）。 */
function resolveWin(input) {
  return resolveRuntimeScript({ platform: "win32", ...input });
}

test("selfDirFromModuleUrl：file: URL → 产物所在目录（按注入平台归一，不依赖宿主）", () => {
  assert.equal(selfDirFromModuleUrl("file:///D:/pkg/dist/tui.js", "win32"), "D:\\pkg\\dist");
  assert.equal(selfDirFromModuleUrl("file:///home/user/pkg/dist/tui.js", "linux"), "/home/user/pkg/dist");
  // POSIX URL 在 Windows 语义下不合法（无盘符）⇒ 捕获后降级 null
  assert.equal(
    selfDirFromModuleUrl("file:///home/user/pkg/dist/tui.js", "win32"),
    null,
    "非法形态必须降级，不能抛穿插件",
  );
  // 默认平台（宿主）的正例：import.meta.url 必须能解出宿主产物目录，不能一律降级
  const expectedHostDir = dirname(fileURLToPath(import.meta.url));
  assert.notEqual(selfDirFromModuleUrl(import.meta.url), null, "宿主平台默认解析不得降级为 null");
  assert.equal(selfDirFromModuleUrl(import.meta.url), expectedHostDir, "默认平台应与宿主 path 归一结果一致");
});

test("selfDirFromModuleUrl：绝对路径字符串同样可用（按注入平台判定绝对/目录）", () => {
  assert.equal(selfDirFromModuleUrl("D:\\pkg\\dist\\tui.js", "win32"), "D:\\pkg\\dist");
  assert.equal(selfDirFromModuleUrl("/home/user/pkg/dist/tui.js", "linux"), "/home/user/pkg/dist");
});

test("selfDirFromModuleUrl：虚拟命名空间/相对值/空值一律 null（交给兜底）", () => {
  assert.equal(selfDirFromModuleUrl("plugin:voice-tui"), null, "非 file 的虚拟 scheme 不可靠");
  assert.equal(selfDirFromModuleUrl("bun:///virtual/tui.js"), null, "同上");
  assert.equal(selfDirFromModuleUrl("dist/tui.js"), null, "相对路径不是可靠锚点");
  assert.equal(selfDirFromModuleUrl("   "), null, "空白视为缺失");
  assert.equal(selfDirFromModuleUrl(""), null);
  assert.equal(selfDirFromModuleUrl(null), null);
  assert.equal(selfDirFromModuleUrl(undefined), null);
});

test("resolveRuntimeScript：环境变量覆盖最优先（相对值按 cwd 归一，且不把关存在性）", () => {
  const cwd = "C:\\work";
  const env = "C:\\custom\\my-runtime.js";
  const got = resolveWin({
    envScript: env,
    selfDir: "C:\\pkg\\dist",
    cwd,
    exists: existsSet([env, "C:\\pkg\\dist\\runtime\\voice-runtime.js"]),
  });
  assert.equal(got.source, "env");
  assert.equal(got.script, env);
  assert.equal(got.exists, true);
  assert.equal(got.candidates[0], env, "候选顺序里 env 最前");

  const missing = resolveWin({ envScript: env, selfDir: null, cwd, exists: existsSet([]) });
  assert.equal(missing.source, "env", "显式覆盖即使不存在仍被尊重（由调用方带绝对路径报错）");
  assert.equal(missing.exists, false);
  assert.equal(missing.script, env);
});

test("resolveRuntimeScript：env 相对值归一为 cwd 下的绝对路径", () => {
  const got = resolveWin({
    envScript: "tools\\runtime.js",
    cwd: "C:\\work",
    exists: existsSet(["C:\\work\\tools\\runtime.js"]),
  });
  assert.equal(got.source, "env");
  assert.equal(got.script, "C:\\work\\tools\\runtime.js");
});

test("resolveRuntimeScript：env 空串/空白视为未设置（走自身锚点）", () => {
  const selfScript = `C:\\pkg\\dist\\${RUNTIME_RELATIVE_TO_SELF.join("\\")}`;
  for (const value of ["", "   ", null, undefined]) {
    const got = resolveWin({ envScript: value, selfDir: "C:\\pkg\\dist", cwd: "C:\\work", exists: existsSet([selfScript]) });
    assert.equal(got.source, "self", `env=${JSON.stringify(value)} 应视为未设置`);
    assert.equal(got.script, selfScript);
    assert.equal(got.exists, true);
  }
});

test("resolveRuntimeScript：自身锚点命中即采用，与 cwd 完全无关（修根因主路径）", () => {
  const got = resolveWin({
    selfDir: "C:\\Users\\king-\\.cache\\opencode\\packages\\x\\dist",
    cwd: "C:\\Users\\king-",
    exists: existsSet(["C:\\Users\\king-\\.cache\\opencode\\packages\\x\\dist\\runtime\\voice-runtime.js"]),
  });
  assert.equal(got.source, "self");
  assert.equal(got.script, "C:\\Users\\king-\\.cache\\opencode\\packages\\x\\dist\\runtime\\voice-runtime.js");
  assert.ok(!got.script.startsWith("C:\\Users\\king-\\dist"), "不得回落到 cwd 拼法");
});

test("resolveRuntimeScript：镜像布局（.opencode/plugin）同级 runtime 同样命中", () => {
  const got = resolveWin({
    selfDir: "C:\\cfg\\.opencode\\plugin",
    cwd: "C:\\Users\\king-",
    exists: existsSet(["C:\\cfg\\.opencode\\plugin\\runtime\\voice-runtime.js"]),
  });
  assert.equal(got.source, "self");
  assert.equal(got.script, "C:\\cfg\\.opencode\\plugin\\runtime\\voice-runtime.js");
});

test("resolveRuntimeScript：自身锚点不存在/不可用时才用 cwd 兜底（source=cwd）", () => {
  const cwdScript = `C:\\work\\${RUNTIME_RELATIVE_TO_CWD.join("\\")}`;
  const selfMiss = resolveWin({
    selfDir: "C:\\pkg\\dist",
    cwd: "C:\\work",
    exists: existsSet([cwdScript]),
  });
  assert.equal(selfMiss.source, "cwd", "自身锚点不存在 ⇒ 降级 cwd 兜底（调用方需记日志）");
  assert.equal(selfMiss.script, cwdScript);
  assert.equal(selfMiss.exists, true);

  const noAnchor = resolveWin({ selfDir: null, cwd: "C:\\work", exists: existsSet([cwdScript]) });
  assert.equal(noAnchor.source, "cwd", "锚点不可用（宿主虚拟化）⇒ cwd 兜底");
  assert.deepEqual(noAnchor.candidates, [cwdScript], "无锚点时候选只剩 cwd 拼法");
});

test("resolveRuntimeScript：候选都不存在 → source=none、exists=false、返回首选并列出全部候选", () => {
  const got = resolveWin({
    selfDir: "C:\\pkg\\dist",
    cwd: "C:\\Users\\king-",
    exists: existsSet([]),
  });
  assert.equal(got.source, "none");
  assert.equal(got.exists, false);
  assert.equal(got.script, "C:\\pkg\\dist\\runtime\\voice-runtime.js", "none 时返回自身锚点首选（最可能是真身）");
  assert.deepEqual(got.candidates, [
    "C:\\pkg\\dist\\runtime\\voice-runtime.js",
    "C:\\Users\\king-\\dist\\runtime\\voice-runtime.js",
  ]);

  const noSelf = resolveWin({ selfDir: null, cwd: "C:\\Users\\king-", exists: existsSet([]) });
  assert.equal(noSelf.source, "none");
  assert.equal(noSelf.script, "C:\\Users\\king-\\dist\\runtime\\voice-runtime.js");
});

test("resolveRuntimeScript：POSIX 语义（platform=linux）的归一、优先级与 source", () => {
  const selfScript = "/opt/pkg/dist/runtime/voice-runtime.js";
  const cwdScript = "/work/dist/runtime/voice-runtime.js";

  const selfHit = resolveRuntimeScript({
    platform: "linux",
    selfDir: "/opt/pkg/dist",
    cwd: "/work",
    exists: existsSet([selfScript]),
  });
  assert.equal(selfHit.source, "self", "自身锚点存在即采用（POSIX 主路径）");
  assert.equal(selfHit.script, selfScript);
  assert.equal(selfHit.exists, true);
  assert.deepEqual(selfHit.candidates, [selfScript, cwdScript]);

  const cwdHit = resolveRuntimeScript({
    platform: "linux",
    selfDir: "/opt/pkg/dist",
    cwd: "/work",
    exists: existsSet([cwdScript]),
  });
  assert.equal(cwdHit.source, "cwd", "自身锚点不存在才降级 cwd");
  assert.equal(cwdHit.script, cwdScript);
  assert.equal(cwdHit.exists, true);

  const envRelative = resolveRuntimeScript({
    platform: "linux",
    envScript: "tools/runtime.js",
    cwd: "/work",
    exists: existsSet(["/work/tools/runtime.js"]),
  });
  assert.equal(envRelative.source, "env", "env 覆盖最优先");
  assert.equal(envRelative.script, "/work/tools/runtime.js", "相对值按 POSIX cwd 归一");
  assert.equal(envRelative.exists, true);
  assert.equal(envRelative.candidates[0], "/work/tools/runtime.js");

  const envAbsolute = resolveRuntimeScript({
    platform: "linux",
    envScript: "/opt/custom/runtime.js",
    cwd: "/work",
    exists: existsSet([]),
  });
  assert.equal(envAbsolute.source, "env");
  assert.equal(envAbsolute.script, "/opt/custom/runtime.js", "绝对 POSIX 值原样采用");
  assert.equal(envAbsolute.exists, false, "env 覆盖不把关存在性");

  const none = resolveRuntimeScript({
    platform: "linux",
    selfDir: "/opt/pkg/dist",
    cwd: "/work",
    exists: existsSet([]),
  });
  assert.equal(none.source, "none");
  assert.equal(none.exists, false);
  assert.equal(none.script, selfScript, "none 时返回自身锚点首选");
  assert.deepEqual(none.candidates, [selfScript, cwdScript]);
});

test("pickStderrSummary：Node 崩溃输出取错误关键行，而不是末行的版本号", () => {
  const crash = [
    "node:internal/modules/cjs/loader:1210",
    "  throw err;",
    "  ^",
    "",
    "Error: Cannot find module 'C:\\Users\\king-\\dist\\runtime\\voice-runtime.js'",
    "Require stack:",
    "- C:\\Users\\king-\\dist\\runtime\\voice-runtime.js",
    "    at Module._resolveFilename (node:internal/modules/cjs/loader:1210:15)",
    "    at node:internal/main/run_main_module:34:53",
    "  code: 'MODULE_NOT_FOUND',",
    "Node.js v24.16.0",
  ].join("\r\n");
  const summary = pickStderrSummary(crash, 300);
  assert.equal(summary, "Error: Cannot find module 'C:\\Users\\king-\\dist\\runtime\\voice-runtime.js'");
  assert.ok(!summary.includes("Node.js v"), "不得只显版本横幅");
});

test("pickStderrSummary：多行含错误关键字 → 取**最后一条**错误行（修复前取首条，真因被埋）", () => {
  const stderr = [
    "[ffmpeg] 自检完成（ok）",
    "错误：旧问题（已被后续覆盖）",
    "[采集] 采样数=0 RMS=0.00000",
    "错误：未检测到音频输入设备（麦克风）",
    "[采集] 采样数=100 RMS=0.00001",
  ].join("\n");
  assert.equal(pickStderrSummary(stderr, 300), "错误：未检测到音频输入设备（麦克风）");
});

test("pickStderrSummary：无错误关键字时取**最后一行**（不再取首个非噪声行）", () => {
  assert.equal(pickStderrSummary("VOICE mic=12 sumSq=34 captured=2s\n采集中：device=麦克风", 300), "采集中：device=麦克风");
  assert.equal(pickStderrSummary("node:internal/a:1\nNode.js v24.16.0\n", 300), "Node.js v24.16.0");
});

test("pickStderrSummary：空输入返回空串；超长**截断中部**、保留首尾错误信息", () => {
  assert.equal(pickStderrSummary("", 300), "");
  assert.equal(pickStderrSummary("   \r\n\r\n  ", 300), "");
  const tail = `退出码=1：未检测到音频输入设备 ${"x".repeat(300)} 原因：设备被禁用`;
  const summary = pickStderrSummary(`错误：${tail}`, 100);
  assert.equal(summary.length, 101, "100 字符 + 中部省略号");
  assert.ok(summary.startsWith("错误："), "必须保留开头「错误：」");
  assert.ok(summary.includes("…"), "超长必须在中间插入省略号");
  assert.ok(summary.endsWith("原因：设备被禁用"), "必须保留尾部具体原因");
});

test("summarizeRuntimeFailure：优先用 NDJSON error 事件的 message（stderr 再吵也不影响）", () => {
  const stderr = ["[ffmpeg] 自检完成（ok）：ok", "错误：stderr 里的旧噪声"].join("\n");
  const summary = summarizeRuntimeFailure({
    stderr,
    errorMessage: "未检测到音频输入设备（麦克风）。请检查：① 麦克风已连接…",
    code: 3,
  });
  assert.equal(summary, "未检测到音频输入设备（麦克风）。请检查：① 麦克风已连接…");
});

test("summarizeRuntimeFailure：无 error 事件时退化到 stderr（错误行 → 末行）；全空返回空串", () => {
  assert.equal(
    summarizeRuntimeFailure({ stderr: "统计 1\n采集失败：ffmpeg 退出码=1", errorMessage: null, code: 1 }),
    "采集失败：ffmpeg 退出码=1",
  );
  assert.equal(summarizeRuntimeFailure({ stderr: "统计 1\n最后一行", errorMessage: "" }), "最后一行");
  assert.equal(summarizeRuntimeFailure({ stderr: "", errorMessage: null }), "");
  assert.equal(STDERR_SUMMARY_MAX, 300, "摘要上限 300（旧口径 120/160 会截掉真因）");
});
