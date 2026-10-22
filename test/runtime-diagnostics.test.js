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

import {
  pickStderrSummary,
  resolveRuntimeScript,
  RUNTIME_RELATIVE_TO_CWD,
  RUNTIME_RELATIVE_TO_SELF,
  selfDirFromModuleUrl,
} from "../dist/lib/runtime-diagnostics.js";

/** 把给定集合视为「存在」的存在性检查（纯内存，不触文件系统）。 */
function existsSet(paths) {
  const set = new Set(paths);
  return (path) => set.has(path);
}

test("selfDirFromModuleUrl：file: URL → 产物所在目录", () => {
  assert.equal(selfDirFromModuleUrl("file:///D:/pkg/dist/tui.js"), "D:\\pkg\\dist");
  // POSIX URL 只在 POSIX 平台是合法路径；Windows 上 fileURLToPath 会抛（无盘符）⇒ 捕获后降级 null
  if (process.platform === "win32") {
    assert.equal(selfDirFromModuleUrl("file:///home/user/pkg/dist/tui.js"), null, "非法形态必须降级，不能抛穿插件");
  } else {
    assert.equal(selfDirFromModuleUrl("file:///home/user/pkg/dist/tui.js"), "/home/user/pkg/dist");
  }
});

test("selfDirFromModuleUrl：绝对路径字符串同样可用（宿主直接给路径的形态）", () => {
  assert.equal(selfDirFromModuleUrl("D:\\pkg\\dist\\tui.js"), "D:\\pkg\\dist");
  assert.equal(selfDirFromModuleUrl("/home/user/pkg/dist/tui.js"), "/home/user/pkg/dist");
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
  const got = resolveRuntimeScript({
    envScript: env,
    selfDir: "C:\\pkg\\dist",
    cwd,
    exists: existsSet([env, "C:\\pkg\\dist\\runtime\\voice-runtime.js"]),
  });
  assert.equal(got.source, "env");
  assert.equal(got.script, env);
  assert.equal(got.exists, true);
  assert.equal(got.candidates[0], env, "候选顺序里 env 最前");

  const missing = resolveRuntimeScript({ envScript: env, selfDir: null, cwd, exists: existsSet([]) });
  assert.equal(missing.source, "env", "显式覆盖即使不存在仍被尊重（由调用方带绝对路径报错）");
  assert.equal(missing.exists, false);
  assert.equal(missing.script, env);
});

test("resolveRuntimeScript：env 相对值归一为 cwd 下的绝对路径", () => {
  const got = resolveRuntimeScript({
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
    const got = resolveRuntimeScript({ envScript: value, selfDir: "C:\\pkg\\dist", cwd: "C:\\work", exists: existsSet([selfScript]) });
    assert.equal(got.source, "self", `env=${JSON.stringify(value)} 应视为未设置`);
    assert.equal(got.script, selfScript);
    assert.equal(got.exists, true);
  }
});

test("resolveRuntimeScript：自身锚点命中即采用，与 cwd 完全无关（修根因主路径）", () => {
  const got = resolveRuntimeScript({
    selfDir: "C:\\Users\\king-\\.cache\\opencode\\packages\\x\\dist",
    cwd: "C:\\Users\\king-",
    exists: existsSet(["C:\\Users\\king-\\.cache\\opencode\\packages\\x\\dist\\runtime\\voice-runtime.js"]),
  });
  assert.equal(got.source, "self");
  assert.equal(got.script, "C:\\Users\\king-\\.cache\\opencode\\packages\\x\\dist\\runtime\\voice-runtime.js");
  assert.ok(!got.script.startsWith("C:\\Users\\king-\\dist"), "不得回落到 cwd 拼法");
});

test("resolveRuntimeScript：镜像布局（.opencode/plugin）同级 runtime 同样命中", () => {
  const got = resolveRuntimeScript({
    selfDir: "C:\\cfg\\.opencode\\plugin",
    cwd: "C:\\Users\\king-",
    exists: existsSet(["C:\\cfg\\.opencode\\plugin\\runtime\\voice-runtime.js"]),
  });
  assert.equal(got.source, "self");
  assert.equal(got.script, "C:\\cfg\\.opencode\\plugin\\runtime\\voice-runtime.js");
});

test("resolveRuntimeScript：自身锚点不存在/不可用时才用 cwd 兜底（source=cwd）", () => {
  const cwdScript = `C:\\work\\${RUNTIME_RELATIVE_TO_CWD.join("\\")}`;
  const selfMiss = resolveRuntimeScript({
    selfDir: "C:\\pkg\\dist",
    cwd: "C:\\work",
    exists: existsSet([cwdScript]),
  });
  assert.equal(selfMiss.source, "cwd", "自身锚点不存在 ⇒ 降级 cwd 兜底（调用方需记日志）");
  assert.equal(selfMiss.script, cwdScript);
  assert.equal(selfMiss.exists, true);

  const noAnchor = resolveRuntimeScript({ selfDir: null, cwd: "C:\\work", exists: existsSet([cwdScript]) });
  assert.equal(noAnchor.source, "cwd", "锚点不可用（宿主虚拟化）⇒ cwd 兜底");
  assert.deepEqual(noAnchor.candidates, [cwdScript], "无锚点时候选只剩 cwd 拼法");
});

test("resolveRuntimeScript：候选都不存在 → source=none、exists=false、返回首选并列出全部候选", () => {
  const got = resolveRuntimeScript({
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

  const noSelf = resolveRuntimeScript({ selfDir: null, cwd: "C:\\Users\\king-", exists: existsSet([]) });
  assert.equal(noSelf.source, "none");
  assert.equal(noSelf.script, "C:\\Users\\king-\\dist\\runtime\\voice-runtime.js");
});

test("pickStderrSummary：Node 崩溃输出取 `Cannot find module` 关键行，而不是末行的版本号", () => {
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
  const summary = pickStderrSummary(crash, 120);
  assert.equal(summary, "Error: Cannot find module 'C:\\Users\\king-\\dist\\runtime\\voice-runtime.js'");
  assert.ok(!summary.includes("Node.js v"), "不得只显版本横幅");
});

test("pickStderrSummary：无错误标记时取首个非噪声行；全噪声退化首行", () => {
  assert.equal(
    pickStderrSummary("node:internal/foo:1\nVOICE mic=12 sumSq=34 captured=2s\nNode.js stats\n", 120),
    "VOICE mic=12 sumSq=34 captured=2s",
  );
  assert.equal(pickStderrSummary("node:internal/a:1\nNode.js v24.16.0\n", 120), "node:internal/a:1");
});

test("pickStderrSummary：空输入返回空串；超长按 maxLength 截断", () => {
  assert.equal(pickStderrSummary("", 120), "");
  assert.equal(pickStderrSummary("   \r\n\r\n  ", 120), "");
  const long = `Error: ENOENT: no such file or directory, open '${"x".repeat(300)}'`;
  const summary = pickStderrSummary(long, 40);
  assert.equal(summary.length, 41, "40 字符 + 省略号");
  assert.ok(summary.endsWith("…"));
  assert.ok(summary.startsWith("Error: ENOENT"));
});
