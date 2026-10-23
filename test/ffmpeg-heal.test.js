/**
 * ffmpeg 运行时自愈（`voice/ffmpeg-heal`）离线单测。
 *
 * 覆盖：纯决策全分支 / 候选目录顺序与命中 / 已存在不 spawn / 有其它副本先拷贝 /
 * 需安装时 spawn 参数与超时 kill / 失败不抛 / 每进程一次 memo。
 * 修复前 `dist/voice/ffmpeg-heal.js` 不存在（导入失败）⇒ 本文件在旧代码上必红。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  DEFAULT_HEAL_TIMEOUT_MS,
  FFMPEG_STATIC_DIRS_ENV,
  decideHealAction,
  ensureFfmpegBinary,
  ffmpegBinaryName,
  findFfmpegStaticDir,
  resetEnsureFfmpegMemo,
  staticDirCandidates,
} from "../dist/voice/ffmpeg-heal.js";

/**
 * 构造可观测的假 fs。
 * @param initialFiles 初始存在的文件集合
 * @returns 假 fs + 调用记录
 */
function makeFs(initialFiles = []) {
  const files = new Set(initialFiles);
  const calls = { copy: [], chmod: [] };
  return {
    files,
    calls,
    exists: (path) => files.has(path),
    copyFile: (source, target) => {
      calls.copy.push([source, target]);
      if (!files.has(source)) throw new Error("ENOENT");
      files.add(target);
    },
    chmod: (path, mode) => calls.chmod.push([path, mode]),
    readdir: () => [],
  };
}

/**
 * 构造一个可控子进程（事件回调由测试触发）。
 * @returns {child, handlers, kills}
 */
function makeChild() {
  const handlers = {};
  const kills = [];
  const child = {
    stdout: null,
    stderr: null,
    on(event, listener) {
      handlers[event] = listener;
      return child;
    },
    kill(signal) {
      kills.push(signal ?? null);
      return true;
    },
  };
  return { child, handlers, kills };
}

/** 等待一个宏任务，让 spawn 发生。 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("ffmpegBinaryName：win32 用 .exe，其余不带后缀", () => {
  assert.equal(ffmpegBinaryName("win32"), "ffmpeg.exe");
  assert.equal(ffmpegBinaryName("linux"), "ffmpeg");
  assert.equal(ffmpegBinaryName("darwin"), "ffmpeg");
  assert.equal(DEFAULT_HEAL_TIMEOUT_MS, 120_000);
});

test("decideHealAction：全分支（已存在 > 其它副本 > 安装 > 放弃）", () => {
  assert.equal(decideHealAction({ hasBinary: true, hasInstallScript: false, hasNode: false }), "already-ok");
  assert.equal(
    decideHealAction({ hasBinary: false, hasInstallScript: false, hasNode: false, hasOtherCopy: true }),
    "copy-from-elsewhere",
  );
  assert.equal(decideHealAction({ hasBinary: false, hasInstallScript: true, hasNode: true }), "run-install");
  // 其它副本优先于 install.js
  assert.equal(
    decideHealAction({ hasBinary: false, hasInstallScript: true, hasNode: true, hasOtherCopy: true }),
    "copy-from-elsewhere",
  );
  // 缺 install.js 或缺 node ⇒ 放弃
  assert.equal(decideHealAction({ hasBinary: false, hasInstallScript: false, hasNode: true }), "give-up");
  assert.equal(decideHealAction({ hasBinary: false, hasInstallScript: true, hasNode: false }), "give-up");
});

test("findFfmpegStaticDir：按候选顺序返回第一个含 package.json 的目录", () => {
  const a = join("root", "a");
  const b = join("root", "b");
  const c = join("root", "c");
  const fs = makeFs([join(b, "package.json"), join(c, "package.json")]);
  assert.equal(findFfmpegStaticDir([a, b, c], fs.exists), b);
  assert.equal(findFfmpegStaticDir([a], fs.exists), null);
  assert.equal(findFfmpegStaticDir([], fs.exists), null);
});

test("staticDirCandidates：本插件 node_modules 先于被提升的上层 node_modules", () => {
  const base = join(process.cwd(), "plug");
  const moduleUrl = pathToFileURL(
    join(base, "node_modules", "@scope", "pkg", "dist", "voice", "ffmpeg-heal.js"),
  ).href;
  const candidates = staticDirCandidates({ moduleUrl, home: join(process.cwd(), "home"), readdir: () => [] });
  const own = join(base, "node_modules", "@scope", "pkg", "node_modules", "ffmpeg-static");
  const hoisted = join(base, "node_modules", "ffmpeg-static");
  assert.ok(candidates.includes(own), `应包含插件自身目录：${own}`);
  assert.ok(candidates.includes(hoisted), `应包含提升后的目录：${hoisted}`);
  assert.ok(candidates.indexOf(own) < candidates.indexOf(hoisted), "插件自身候选必须先于上层");
  assert.equal(candidates.includes(join(base, "node_modules", "node_modules", "ffmpeg-static")), false);
});

test("staticDirCandidates：缓存根下 @scope/name 与普通包都纳入", () => {
  const home = join("home");
  const map = new Map([
    [join(home, ".cache", "opencode", "packages"), ["plain@latest", "@scope"]],
    [join(home, ".cache", "opencode", "packages", "@scope"), ["name@latest"]],
  ]);
  const candidates = staticDirCandidates({
    moduleUrl: pathToFileURL(join("plug", "dist", "voice", "ffmpeg-heal.js")).href,
    home,
    readdir: (path) => map.get(path) ?? [],
  });
  assert.ok(candidates.includes(join(home, ".cache", "opencode", "packages", "plain@latest", "node_modules", "ffmpeg-static")));
  assert.ok(
    candidates.includes(
      join(home, ".cache", "opencode", "packages", "@scope", "name@latest", "node_modules", "ffmpeg-static"),
    ),
  );
});

test("ensureFfmpegBinary：解析已可用 ⇒ already-ok，不找目录、不 spawn", async () => {
  resetEnsureFfmpegMemo();
  const fs = makeFs();
  let spawnCalls = 0;
  const result = await ensureFfmpegBinary({
    memoize: false,
    fs,
    resolveExisting: () => "/usr/bin/ffmpeg",
    staticDirs: [join("root", "ffmpeg-static")],
    spawn: () => {
      spawnCalls += 1;
      throw new Error("不应 spawn");
    },
    nodePath: join("root", "node"),
  });
  assert.equal(result.status, "ok");
  assert.equal(result.action, "already-ok");
  assert.equal(result.binaryPath, "/usr/bin/ffmpeg");
  assert.equal(spawnCalls, 0);
});

test("ensureFfmpegBinary：二进制已存在 ⇒ 不 spawn", async () => {
  resetEnsureFfmpegMemo();
  const target = join("root", "ffmpeg-static");
  const binary = join(target, ffmpegBinaryName(process.platform));
  const fs = makeFs([join(target, "package.json"), binary, join("root", "node")]);
  let spawnCalls = 0;
  const result = await ensureFfmpegBinary({
    memoize: false,
    fs,
    resolveExisting: () => null,
    staticDirs: [target],
    nodePath: join("root", "node"),
    spawn: () => {
      spawnCalls += 1;
      throw new Error("不应 spawn");
    },
  });
  assert.equal(result.status, "ok");
  assert.equal(result.action, "already-ok");
  assert.equal(result.binaryPath, binary);
  assert.equal(spawnCalls, 0);
  assert.equal(fs.calls.copy.length, 0);
});

test("ensureFfmpegBinary：同机有其它副本 ⇒ 直接拷贝且不 spawn", async () => {
  resetEnsureFfmpegMemo();
  const target = join("root", "a", "ffmpeg-static");
  const other = join("root", "b", "ffmpeg-static");
  const binaryName = ffmpegBinaryName(process.platform);
  const sourceBinary = join(other, binaryName);
  const fs = makeFs([
    join(target, "package.json"),
    join(other, "package.json"),
    sourceBinary,
    join("root", "node"),
  ]);
  let spawnCalls = 0;
  const result = await ensureFfmpegBinary({
    memoize: false,
    fs,
    resolveExisting: () => null,
    staticDirs: [target, other],
    nodePath: join("root", "node"),
    spawn: () => {
      spawnCalls += 1;
      throw new Error("不应 spawn");
    },
  });
  assert.equal(result.status, "copied");
  assert.equal(result.action, "copy-from-elsewhere");
  assert.equal(spawnCalls, 0);
  assert.deepEqual(fs.calls.copy, [[sourceBinary, join(target, binaryName)]]);
  assert.equal(fs.exists(join(target, binaryName)), true);
});

test("ensureFfmpegBinary：需安装 ⇒ spawn(当前 node, [install.js], cwd=包目录)，成功后 installed", async () => {
  resetEnsureFfmpegMemo();
  const target = join("root", "ffmpeg-static");
  const binary = join(target, ffmpegBinaryName(process.platform));
  const nodePath = join("root", "node");
  const fs = makeFs([join(target, "package.json"), join(target, "install.js"), nodePath]);
  const { child, handlers } = makeChild();
  const spawnCalls = [];
  const promise = ensureFfmpegBinary({
    memoize: false,
    fs,
    resolveExisting: () => null,
    staticDirs: [target],
    nodePath,
    spawn: (command, args, options) => {
      spawnCalls.push({ command, args: [...args], options });
      return child;
    },
  });
  await tick();
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, nodePath, "必须用当前 Node 可执行文件");
  assert.deepEqual(spawnCalls[0].args, ["install.js"], "必须以 install.js 为唯一参数（无 shell）");
  assert.equal(spawnCalls[0].options.cwd, target);
  assert.deepEqual(spawnCalls[0].options.stdio, ["ignore", "pipe", "pipe"]);
  // 模拟下载完成
  fs.files.add(binary);
  handlers.close(0);
  const result = await promise;
  assert.equal(result.status, "installed");
  assert.equal(result.action, "run-install");
  assert.equal(result.binaryPath, binary);
});

test("ensureFfmpegBinary：超时 ⇒ kill + status=timeout，不抛", async () => {
  resetEnsureFfmpegMemo();
  const target = join("root", "ffmpeg-static");
  const nodePath = join("root", "node");
  const fs = makeFs([join(target, "package.json"), join(target, "install.js"), nodePath]);
  const { child, kills } = makeChild();
  const promise = ensureFfmpegBinary({
    memoize: false,
    fs,
    resolveExisting: () => null,
    staticDirs: [target],
    nodePath,
    timeoutMs: 5,
    spawn: () => child,
  });
  await tick();
  const result = await promise;
  assert.equal(result.status, "timeout");
  assert.equal(kills.length, 1, "超时必须 kill 子进程");
});

test("ensureFfmpegBinary：install.js 非 0 ⇒ status=error，不抛", async () => {
  resetEnsureFfmpegMemo();
  const target = join("root", "ffmpeg-static");
  const nodePath = join("root", "node");
  const fs = makeFs([join(target, "package.json"), join(target, "install.js"), nodePath]);
  const { child, handlers } = makeChild();
  const promise = ensureFfmpegBinary({
    memoize: false,
    fs,
    resolveExisting: () => null,
    staticDirs: [target],
    nodePath,
    spawn: () => child,
  });
  await tick();
  handlers.close(1);
  const result = await promise;
  assert.equal(result.status, "error");
  assert.match(result.detail, /退出码=1/);
});

test("ensureFfmpegBinary：找不到 ffmpeg-static 目录 ⇒ unavailable，不抛", async () => {
  resetEnsureFfmpegMemo();
  const result = await ensureFfmpegBinary({
    memoize: false,
    fs: makeFs(),
    resolveExisting: () => null,
    staticDirs: [join("root", "missing")],
  });
  assert.equal(result.status, "unavailable");
  assert.equal(result.action, "give-up");
});

test("ensureFfmpegBinary：每进程只尝试一次（memo），失败也缓存", async () => {
  resetEnsureFfmpegMemo();
  let resolveCalls = 0;
  const options = {
    fs: makeFs(),
    staticDirs: [join("root", "missing")],
    resolveExisting: () => {
      resolveCalls += 1;
      return null;
    },
  };
  const first = await ensureFfmpegBinary(options);
  const second = await ensureFfmpegBinary(options);
  assert.equal(first.status, "unavailable");
  assert.equal(second.status, "unavailable");
  assert.equal(resolveCalls, 1, "第二次必须直接命中 memo");
  resetEnsureFfmpegMemo();
});

test("ensureFfmpegBinary：VOICE_FFMPEG_STATIC_DIRS 可覆盖候选", async () => {
  resetEnsureFfmpegMemo();
  const target = join("root", "custom-static");
  const binary = join(target, ffmpegBinaryName(process.platform));
  const fs = makeFs([join(target, "package.json"), binary]);
  const result = await ensureFfmpegBinary({
    memoize: false,
    fs,
    resolveExisting: () => null,
    env: { [FFMPEG_STATIC_DIRS_ENV]: `${target}${process.platform === "win32" ? ";" : ":"}${join("root", "nope")}` },
  });
  assert.equal(result.status, "ok");
  assert.equal(result.binaryPath, binary);
});
