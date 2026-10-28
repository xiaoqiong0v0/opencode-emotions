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
  DOWNLOAD_PROXY_ENV,
  FFMPEG_STATIC_DIRS_ENV,
  NODE_USE_ENV_PROXY,
  buildDownloadEnv,
  decideHealAction,
  ensureFfmpegBinary,
  ffmpegBinaryName,
  findFfmpegStaticDir,
  healStaticDir,
  parseWindowsProxy,
  resetEnsureFfmpegMemo,
  resolveDownloadProxy,
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
    // 静态二进制「可用」判定注入为恒真（本用例只验 fs/不 spawn，不验 -version）
    verify: () => true,
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
    verify: () => true,
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
    verify: () => true,
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
    verify: () => true,
  });
  assert.equal(result.status, "ok");
  assert.equal(result.binaryPath, binary);
});

test("ensureFfmpegBinary：静态二进制存在但 -version 失败 ⇒ 不认为可用，改跑 install.js（修复前 already-ok 必红）", async () => {
  resetEnsureFfmpegMemo();
  const target = join("root", "ffmpeg-static");
  const binary = join(target, ffmpegBinaryName(process.platform));
  const nodePath = join("root", "node");
  const fs = makeFs([join(target, "package.json"), binary, join(target, "install.js"), nodePath]);
  const { child, handlers } = makeChild();
  let spawnCalls = 0;
  const promise = ensureFfmpegBinary({
    memoize: false,
    fs,
    resolveExisting: () => null,
    staticDirs: [target],
    nodePath,
    // 「存在但不可执行」：真执行校验恒失败
    verify: () => false,
    spawn: () => {
      spawnCalls += 1;
      return child;
    },
  });
  await tick();
  assert.equal(spawnCalls, 1, "存在但不可执行 ⇒ 必须走 install.js 重新下载（不得直接 already-ok）");
  handlers.close(0);
  const result = await promise;
  assert.equal(result.status, "error", "下载后仍校验失败 ⇒ error（绝不谎报 ok）");
  assert.match(result.detail, /-version 校验失败/);
});

test("ensureFfmpegBinary：校验失败的其它副本不被拷贝（避免扩散坏二进制）", async () => {
  resetEnsureFfmpegMemo();
  const target = join("root", "a", "ffmpeg-static");
  const other = join("root", "b", "ffmpeg-static");
  const binaryName = ffmpegBinaryName(process.platform);
  const fs = makeFs([
    join(target, "package.json"),
    join(target, "install.js"),
    join(other, "package.json"),
    join(other, binaryName),
    join("root", "node"),
  ]);
  const { child, handlers } = makeChild();
  let spawnCalls = 0;
  const promise = ensureFfmpegBinary({
    memoize: false,
    fs,
    resolveExisting: () => null,
    staticDirs: [target, other],
    nodePath: join("root", "node"),
    verify: () => false,
    spawn: () => {
      spawnCalls += 1;
      return child;
    },
  });
  await tick();
  assert.equal(fs.calls.copy.length, 0, "校验不通过的副本不得被拷贝");
  assert.equal(spawnCalls, 1, "应改走 install.js");
  handlers.close(1);
  const result = await promise;
  assert.equal(result.status, "error");
});

// ---------------------------------------------------------------------------
// 第二十批（2026-10-28）：下载走代理（Node https 默认不读系统代理）
// 以下用例在修复前必红：`buildDownloadEnv` / `parseWindowsProxy` 导出不存在。
// ---------------------------------------------------------------------------

test("buildDownloadEnv：无任何代理 ⇒ 只加 NODE_USE_ENV_PROXY=1，不改其它键", () => {
  const input = { env: { PATH: "/bin", FOO: "bar" } };
  const out = buildDownloadEnv(input);
  assert.equal(out[NODE_USE_ENV_PROXY], "1");
  assert.equal(out.HTTPS_PROXY, undefined);
  assert.equal(out.HTTP_PROXY, undefined);
  assert.equal(out.PATH, "/bin");
  assert.equal(out.FOO, "bar");
  assert.equal(resolveDownloadProxy(input).source, "none");
});

test("buildDownloadEnv：env 已有 HTTPS_PROXY ⇒ 不覆盖、不注入系统代理", () => {
  const out = buildDownloadEnv({
    env: { HTTPS_PROXY: "http://env-proxy:1080" },
    systemProxy: { enabled: true, server: "127.0.0.1:7897" },
  });
  assert.equal(out.HTTPS_PROXY, "http://env-proxy:1080");
  assert.equal(out.HTTP_PROXY, undefined, "不得注入系统代理");
  assert.equal(out.NODE_USE_ENV_PROXY, "1");
});

test("buildDownloadEnv：只有系统代理 ⇒ 同时注入 HTTPS_PROXY 与 HTTP_PROXY", () => {
  const out = buildDownloadEnv({ env: {}, systemProxy: { enabled: true, server: "127.0.0.1:7897" } });
  assert.equal(out.HTTPS_PROXY, "http://127.0.0.1:7897");
  assert.equal(out.HTTP_PROXY, "http://127.0.0.1:7897");
  assert.equal(resolveDownloadProxy({ env: {}, systemProxy: { enabled: true, server: "127.0.0.1:7897" } }).source, "system");
});

test("buildDownloadEnv：explicit 优先于 env 与系统代理", () => {
  const out = buildDownloadEnv({
    env: { HTTPS_PROXY: "http://env-proxy:1080" },
    systemProxy: { enabled: true, server: "127.0.0.1:7897" },
    explicitProxy: "127.0.0.1:8888",
  });
  assert.equal(out.HTTPS_PROXY, "http://127.0.0.1:8888");
  assert.equal(out.HTTP_PROXY, "http://127.0.0.1:8888");
  const source = resolveDownloadProxy({
    env: { HTTPS_PROXY: "http://env-proxy:1080" },
    explicitProxy: "127.0.0.1:8888",
  }).source;
  assert.equal(source, "explicit");
});

test("buildDownloadEnv：NO_PROXY / no_proxy 原样保留", () => {
  const out = buildDownloadEnv({
    env: { NO_PROXY: "localhost,127.0.0.1", no_proxy: "internal" },
    systemProxy: { enabled: true, server: "127.0.0.1:7897" },
  });
  assert.equal(out.NO_PROXY, "localhost,127.0.0.1");
  assert.equal(out.no_proxy, "internal");
});

test("buildDownloadEnv：server / explicit 已带 scheme ⇒ 不重复加前缀", () => {
  assert.equal(
    buildDownloadEnv({ env: {}, systemProxy: { enabled: true, server: "socks5://127.0.0.1:1080" } }).HTTPS_PROXY,
    "socks5://127.0.0.1:1080",
  );
  assert.equal(buildDownloadEnv({ env: {}, explicitProxy: "http://127.0.0.1:7897" }).HTTP_PROXY, "http://127.0.0.1:7897");
});

test("buildDownloadEnv：不修改入参对象", () => {
  const env = { PATH: "/bin" };
  const systemProxy = { enabled: true, server: "127.0.0.1:7897" };
  buildDownloadEnv({ env, systemProxy, explicitProxy: "" });
  assert.deepEqual(env, { PATH: "/bin" });
  assert.deepEqual(systemProxy, { enabled: true, server: "127.0.0.1:7897" });
});

test("parseWindowsProxy：ProxyEnable=0 ⇒ 未启用", () => {
  assert.deepEqual(parseWindowsProxy("    ProxyEnable    REG_DWORD    0x0\n"), { enabled: false });
});

test("parseWindowsProxy：ProxyServer 单值 host:port", () => {
  const text = [
    "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
    "    ProxyEnable    REG_DWORD    0x1",
    "    ProxyServer    REG_SZ    127.0.0.1:7897",
    "",
  ].join("\r\n");
  assert.deepEqual(parseWindowsProxy(text), { enabled: true, server: "127.0.0.1:7897" });
});

test("parseWindowsProxy：proto=host:port;... 取 http 项", () => {
  const text = [
    "    ProxyEnable    REG_DWORD    0x1",
    "    ProxyServer    REG_SZ    https=secure:443;http=127.0.0.1:7897;ftp=127.0.0.1:21",
  ].join("\n");
  assert.deepEqual(parseWindowsProxy(text), { enabled: true, server: "127.0.0.1:7897" });
});

test("parseWindowsProxy：空/异常输出 ⇒ { enabled:false }", () => {
  assert.deepEqual(parseWindowsProxy(""), { enabled: false });
  assert.deepEqual(parseWindowsProxy("错误: 系统找不到指定的注册表项或值。"), { enabled: false });
  assert.deepEqual(parseWindowsProxy("ProxyEnable REG_SZ garbage"), { enabled: false });
});

test("healStaticDir：install.js 子进程 env 含 NODE_USE_ENV_PROXY 与系统代理", async () => {
  const target = join("root", "ffmpeg-static");
  const nodePath = join("root", "node");
  const fs = makeFs([join(target, "install.js"), nodePath]);
  const { child, handlers } = makeChild();
  const spawnCalls = [];
  let registryReads = 0;
  const promise = healStaticDir(target, {
    platform: "win32",
    fs,
    nodePath,
    env: {},
    readSystemProxy: () => {
      registryReads += 1;
      return { enabled: true, server: "127.0.0.1:7897" };
    },
    spawn: (command, args, options) => {
      spawnCalls.push({ command, args: [...args], options });
      return child;
    },
  });
  await tick();
  assert.equal(registryReads, 1, "下载分支才读系统代理");
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].options.env[NODE_USE_ENV_PROXY], "1");
  assert.equal(spawnCalls[0].options.env.HTTPS_PROXY, "http://127.0.0.1:7897");
  assert.equal(spawnCalls[0].options.env.HTTP_PROXY, "http://127.0.0.1:7897");
  // 收尾：模拟下载成功（二进制落地 + close 0），避免 Promise 悬挂
  fs.files.add(join(target, ffmpegBinaryName("win32")));
  handlers.close(0);
  assert.equal((await promise).status, "installed");
});

test("healStaticDir：拷贝分支不读注册表（也不传下载 env）", async () => {
  const target = join("root", "a", "ffmpeg-static");
  const other = join("root", "b", "ffmpeg-static");
  const binaryName = ffmpegBinaryName(process.platform);
  const fs = makeFs([join(target, "install.js"), join(other, binaryName), join("root", "node")]);
  let registryReads = 0;
  let spawnCalls = 0;
  const result = await healStaticDir(target, {
    fs,
    nodePath: join("root", "node"),
    env: {},
    copySources: [join(other, binaryName)],
    readSystemProxy: () => {
      registryReads += 1;
      return { enabled: true, server: "127.0.0.1:7897" };
    },
    spawn: () => {
      spawnCalls += 1;
      throw new Error("不应 spawn");
    },
  });
  assert.equal(result.status, "copied");
  assert.equal(registryReads, 0, "拷贝分支不得读注册表");
  assert.equal(spawnCalls, 0);
});

test("healStaticDir：env 已有代理时下载 env 保留 env 代理（不注入系统代理）", async () => {
  const target = join("root", "ffmpeg-static");
  const fs = makeFs([join(target, "install.js"), join("root", "node")]);
  const { child, handlers } = makeChild();
  const spawnCalls = [];
  const promise = healStaticDir(target, {
    fs,
    nodePath: join("root", "node"),
    env: { [DOWNLOAD_PROXY_ENV]: "", https_proxy: "http://env-proxy:1080" },
    systemProxy: { enabled: true, server: "127.0.0.1:7897" },
    spawn: (command, args, options) => {
      spawnCalls.push({ command, args, options });
      return child;
    },
  });
  await tick();
  assert.equal(spawnCalls[0].options.env.https_proxy, "http://env-proxy:1080");
  assert.equal(spawnCalls[0].options.env.HTTPS_PROXY, undefined);
  assert.equal(spawnCalls[0].options.env.HTTP_PROXY, undefined);
  assert.equal(spawnCalls[0].options.env[NODE_USE_ENV_PROXY], "1");
  fs.files.add(join(target, ffmpegBinaryName(process.platform)));
  handlers.close(0);
  await promise;
});
