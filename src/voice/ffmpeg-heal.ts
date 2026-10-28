/**
 * `ffmpeg-static` 随附二进制的**运行时自愈**（唯一实现，`scripts/ensure-ffmpeg.mjs` 也复用它）。
 *
 * 背景（2026-10-22 已取证）：opencode 安装插件时硬编码 `ignoreScripts: true`，`ffmpeg-static` 的
 * `install.js` 不会执行 ⇒ 包目录里只有 JS 文件、没有 `ffmpeg(.exe)`；旧的一次性脚本不在 npm 包
 * `files` 里、也不会自动运行，新机器首次启动语音时报 `spawnSync ffmpeg ENOENT`。
 *
 * 结构：
 * - **纯决策**（无 IO，便于单测）：{@link ffmpegBinaryName} / {@link findFfmpegStaticDir} /
 *   {@link decideHealAction} / {@link staticDirCandidates}；
 * - **副作用编排**（可注入 fs/spawn）：{@link healStaticDir}（单个包目录）与
 *   {@link ensureFfmpegBinary}（按候选目录找目标 + 其它副本优先拷贝 + 每进程一次 memo）。
 *
 * 安全边界：任何失败都**返回结果、绝不抛未捕获异常**；`install.js` 用 `spawn`（无 shell）以
 * 当前 Node 可执行文件运行，超时 kill。
 */

import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { forgetFfmpegProbe, probeFfmpeg, resolveFfmpegPath } from "./ffmpeg.js";

/** `ffmpeg-static` 包名（亦是其目录名）。 */
export const FFMPEG_STATIC_PACKAGE = "ffmpeg-static";
/** 包内的二进制下载脚本文件名。 */
export const FFMPEG_INSTALL_SCRIPT = "install.js";
/** `install.js` 默认超时（毫秒）；二进制约 80MB，给足下载余量。 */
export const DEFAULT_HEAL_TIMEOUT_MS = 120_000;
/** 覆盖 `ffmpeg-static` 目录候选的环境变量（多路径按平台分隔符；离线/排障/测试用）。 */
export const FFMPEG_STATIC_DIRS_ENV = "VOICE_FFMPEG_STATIC_DIRS";
/** opencode 插件缓存根（相对 home）。 */
const PACKAGES_CACHE_SEGMENTS = [".cache", "opencode", "packages"] as const;
/** `node_modules` 目录名。 */
const NODE_MODULES = "node_modules";
/** 包存在性判据文件。 */
const PACKAGE_JSON = "package.json";
/** 显式下载代理覆盖（优先级最高；形如 `http://127.0.0.1:7897`）。 */
export const DOWNLOAD_PROXY_ENV = "VOICE_FFMPEG_DOWNLOAD_PROXY";
/** 让 Node 子进程按 env 里的代理变量走代理（Node 24+ 生效，低版本忽略无害）。 */
export const NODE_USE_ENV_PROXY = "NODE_USE_ENV_PROXY";
/** 视为「用户已配置代理」的环境变量键（按此顺序取第一个非空值）。 */
const ENV_PROXY_KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"] as const;
/** Windows 系统代理所在的注册表键（HKCU）。 */
const WINDOWS_INTERNET_SETTINGS_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
/** 单次注册表查询超时（毫秒）。 */
const REG_QUERY_TIMEOUT_MS = 2000;

/** Windows 系统代理信息（`enabled` 且 `server` 都存在才可用）。 */
export interface SystemProxyInfo {
  /** 系统代理是否启用。 */
  enabled: boolean;
  /** 代理地址（`host:port` 或带 scheme）。 */
  server?: string;
}

/** 代理来源（日志/测试用）。 */
export type ProxySource = "explicit" | "env" | "system" | "none";

/** 解析出的代理及其来源。 */
export interface ResolvedDownloadProxy {
  /** 来源：显式 > env > 系统 > 无。 */
  source: ProxySource;
  /** 实际使用的代理地址（`none` 时无）。 */
  proxy?: string;
}

/** `buildDownloadEnv` 入参。 */
export interface BuildDownloadEnvInput {
  /** 基础环境变量表（不改动）。 */
  env: NodeJS.ProcessEnv;
  /** 系统代理（Windows 由注册表解析得到）。 */
  systemProxy?: SystemProxyInfo;
  /** 显式代理（来自 `VOICE_FFMPEG_DOWNLOAD_PROXY`）。 */
  explicitProxy?: string;
}

/** 自愈动作（纯决策结果）。 */
export type HealAction = "already-ok" | "run-install" | "copy-from-elsewhere" | "give-up";

/** 自愈结果状态。 */
export type HealStatus = "ok" | "copied" | "installed" | "unavailable" | "timeout" | "error";

/** `decideHealAction` 入参（全部为布尔事实，不做 IO）。 */
export interface HealDecisionInput {
  /** 目标目录里二进制已存在。 */
  hasBinary: boolean;
  /** 目标目录里 `install.js` 存在。 */
  hasInstallScript: boolean;
  /** 当前 Node 可执行文件可用（能跑 `install.js`）。 */
  hasNode: boolean;
  /** 同机其它目录存在可用副本（可离线拷贝）。 */
  hasOtherCopy?: boolean;
}

/**
 * 纯决策：给定事实，选择补齐动作。
 * @param input 事实集合
 * @returns 动作码（`already-ok` → `copy-from-elsewhere` → `run-install` → `give-up`）
 */
export function decideHealAction(input: HealDecisionInput): HealAction {
  if (input.hasBinary) return "already-ok";
  if (input.hasOtherCopy === true) return "copy-from-elsewhere";
  if (input.hasInstallScript && input.hasNode) return "run-install";
  return "give-up";
}

/**
 * 当前平台下 `ffmpeg-static` 应有的二进制文件名。
 * @param platform 目标平台
 * @returns win32 → `ffmpeg.exe`，其余 → `ffmpeg`
 */
export function ffmpegBinaryName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
}

/**
 * 规范化代理地址：带 scheme 原样返回，否则补 `http://`。
 * @param server 原始地址（`host:port` 或带 scheme）
 * @returns 可直接作为 `HTTPS_PROXY` 的值
 */
function normalizeProxyUrl(server: string): string {
  const value = server.trim();
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`;
}

/** env 里第一个非空的代理变量值（无则 undefined）。 */
function envProxyValue(env: NodeJS.ProcessEnv): string | undefined {
  for (const key of ENV_PROXY_KEYS) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

/**
 * 纯决策：选出生效的下载代理及其来源（不做 IO）。
 * 优先级：`explicitProxy` > env 已有代理 > 系统代理 > 无。
 * @param input 见 {@link BuildDownloadEnvInput}
 * @returns 来源与地址（`none` 时无 `proxy`）
 */
export function resolveDownloadProxy(input: BuildDownloadEnvInput): ResolvedDownloadProxy {
  const explicit = input.explicitProxy?.trim();
  if (explicit) return { source: "explicit", proxy: normalizeProxyUrl(explicit) };
  const fromEnv = envProxyValue(input.env);
  if (fromEnv) return { source: "env", proxy: fromEnv };
  const server = input.systemProxy?.server?.trim();
  if (input.systemProxy?.enabled === true && server) return { source: "system", proxy: normalizeProxyUrl(server) };
  return { source: "none" };
}

/**
 * 构造 `install.js` 子进程的环境变量（纯函数，不改动入参）。
 * 总是设置 `NODE_USE_ENV_PROXY=1`；只在来源为 `explicit` / `system` 时同时注入
 * `HTTPS_PROXY` 与 `HTTP_PROXY`（env 已有的代理原样保留，`NO_PROXY` 不动）。
 * @param input 见 {@link BuildDownloadEnvInput}
 * @returns 新的环境变量对象
 */
export function buildDownloadEnv(input: BuildDownloadEnvInput): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...input.env };
  env[NODE_USE_ENV_PROXY] = "1";
  const resolved = resolveDownloadProxy(input);
  if (resolved.proxy !== undefined && (resolved.source === "explicit" || resolved.source === "system")) {
    env.HTTPS_PROXY = resolved.proxy;
    env.HTTP_PROXY = resolved.proxy;
  }
  return env;
}

/** 日志里隐藏代理 URL 里的用户信息（`user:pass@` → `***@`）。 */
function maskProxyForLog(proxy: string): string {
  return proxy.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1***@");
}

/**
 * 解析 `reg query ... /v ProxyEnable` 与 `/v ProxyServer` 的输出（纯函数）。
 * 支持 `host:port` 与 `proto=host:port;...` 两种 `ProxyServer` 形式（优先 `http=`，否则取第一项）。
 * @param regQueryOutput 两次查询输出拼接后的文本
 * @returns 系统代理信息；缺键/解析失败 ⇒ `{ enabled: false }`
 */
export function parseWindowsProxy(regQueryOutput: string): SystemProxyInfo {
  const text = typeof regQueryOutput === "string" ? regQueryOutput : "";
  let enabled: boolean | undefined;
  let server: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(ProxyEnable|ProxyServer)\s+REG_\w+\s+(.*)$/.exec(line);
    if (!match) continue;
    const value = match[2].trim();
    if (match[1] === "ProxyEnable") {
      enabled = /^(0x0*1|1)$/i.test(value);
      continue;
    }
    if (value) server = parseProxyServerValue(value);
  }
  if (enabled !== true) return { enabled: false };
  return server ? { enabled: true, server } : { enabled: true };
}

/**
 * 从 `ProxyServer` 原始值里取地址：`proto=host:port;...` 取 `http=` 项，否则第一项。
 * @param raw `ProxyServer` 值
 * @returns 地址（可能为空 ⇒ undefined）
 */
function parseProxyServerValue(raw: string): string | undefined {
  const parts = raw.split(";").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return undefined;
  const httpPart = parts.find((part) => /^http=/i.test(part));
  const chosen = httpPart ?? parts[0];
  const value = chosen.includes("=") ? chosen.slice(chosen.indexOf("=") + 1).trim() : chosen;
  return value || undefined;
}

/** 注册表查询结果（仅 stdout）。 */
interface RegQueryResult {
  status: number | null;
  stdout?: string | Buffer;
}

/** 可注入的注册表查询（`reg query` 语义）。 */
export type RegQuery = (args: readonly string[]) => RegQueryResult;

/** 生产注册表查询：`spawnSync reg`（无 shell、有超时）。 */
const DEFAULT_REG_QUERY: RegQuery = (args) => {
  const result = spawnSync("reg", [...args], {
    shell: false,
    windowsHide: true,
    timeout: REG_QUERY_TIMEOUT_MS,
    encoding: "utf8",
  });
  return { status: result.status ?? null, stdout: result.stdout ?? "" };
};

/** `detectWindowsSystemProxy` 入参。 */
export interface DetectSystemProxyOptions {
  /** 目标平台（非 win32 直接返回未启用）。 */
  platform?: NodeJS.Platform;
  /** 环境变量表（已有代理 / 显式覆盖时跳过注册表查询）。 */
  env?: NodeJS.ProcessEnv;
  /** 注册表查询注入。 */
  regQuery?: RegQuery;
  /** 调试日志（失败/跳过时一行，不刷屏）。 */
  log?: (message: string) => void;
}

/**
 * 读取 Windows 系统代理（失败静默降级为未启用）。
 * 仅当 `platform === "win32"`、env 无代理且未设 `VOICE_FFMPEG_DOWNLOAD_PROXY` 时才查注册表。
 * @param options 注入项
 * @returns 系统代理信息（绝不抛、绝不阻断）
 */
export function detectWindowsSystemProxy(options: DetectSystemProxyOptions = {}): SystemProxyInfo {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const log = options.log ?? (() => undefined);
  if (platform !== "win32") return { enabled: false };
  if (env[DOWNLOAD_PROXY_ENV]?.trim()) {
    log("[ffmpeg-heal] 已设 VOICE_FFMPEG_DOWNLOAD_PROXY，跳过系统代理查询");
    return { enabled: false };
  }
  if (envProxyValue(env)) {
    log("[ffmpeg-heal] env 已有代理，跳过系统代理查询");
    return { enabled: false };
  }
  try {
    const query = options.regQuery ?? DEFAULT_REG_QUERY;
    const enable = query(["query", WINDOWS_INTERNET_SETTINGS_KEY, "/v", "ProxyEnable"]);
    if (enable.status !== 0) {
      log(`[ffmpeg-heal] 读取 ProxyEnable 失败（exit=${enable.status ?? "null"}），按未启用处理`);
      return { enabled: false };
    }
    const enableText = String(enable.stdout ?? "");
    // 未启用时不必再查 ProxyServer（少一次阻塞调用）
    if (parseWindowsProxy(enableText).enabled !== true) return { enabled: false };
    const server = query(["query", WINDOWS_INTERNET_SETTINGS_KEY, "/v", "ProxyServer"]);
    if (server.status !== 0) {
      log(`[ffmpeg-heal] 读取 ProxyServer 失败（exit=${server.status ?? "null"}），按未启用处理`);
      return { enabled: false };
    }
    return parseWindowsProxy(`${enableText}\n${String(server.stdout ?? "")}`);
  } catch (err) {
    log(`[ffmpeg-heal] 系统代理查询异常，按未启用处理：${(err as Error).message}`);
    return { enabled: false };
  }
}

/** 可注入的 fs 子集（测试用；生产走 node:fs）。 */
export interface FfmpegHealFs {
  /** 路径存在。 */
  exists(path: string): boolean;
  /** 复制文件（同步）。 */
  copyFile(source: string, target: string): void;
  /** 改权限（同步；Windows 可 no-op）。 */
  chmod(target: string, mode: number): void;
  /** 列目录（失败返回空数组，绝不抛）。 */
  readdir(path: string): readonly string[];
}

/** 生产 fs 实现。 */
const DEFAULT_FS: FfmpegHealFs = {
  exists: (path) => existsSync(path),
  copyFile: (source, target) => copyFileSync(source, target),
  chmod: (target, mode) => chmodSync(target, mode),
  readdir: (path) => {
    try {
      return readdirSync(path);
    } catch {
      return [];
    }
  },
};

/** 子进程最小结构（仅自愈需要的事件）。 */
export interface HealChildProcess {
  stdout: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
  stderr: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: (code: number | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

/** spawn 注入签名（无 shell、无 `exec`）。 */
export type FfmpegHealSpawn = (
  command: string,
  args: readonly string[],
  options: { cwd: string; stdio: ["ignore", "pipe", "pipe"]; windowsHide: boolean; env?: NodeJS.ProcessEnv },
) => HealChildProcess;

/** 生产 spawn 实现。 */
const DEFAULT_SPAWN: FfmpegHealSpawn = (command, args, options) =>
  spawn(command, [...args], options) as unknown as HealChildProcess;

/**
 * 构造 `ffmpeg-static` 目录候选（顺序即优先级）：
 * ① 本插件自身及各级祖先的 `node_modules/ffmpeg-static`（覆盖「插件私有」与「被提升到上层」）；
 * ② opencode 插件缓存根下各包的 `node_modules/ffmpeg-static`（含 `@scope/name` 两级）。
 * @param options 注入项（模块 URL / home / 目录读取）
 * @returns 去重后的候选目录（可能不存在，交给 `findFfmpegStaticDir` 判定）
 */
export function staticDirCandidates(options: {
  moduleUrl?: string;
  home?: string;
  readdir?: (path: string) => readonly string[];
} = {}): string[] {
  const readdir = options.readdir ?? DEFAULT_FS.readdir;
  const candidates: string[] = [];
  const seen = new Set<string>();
  const push = (dir: string): void => {
    if (seen.has(dir)) return;
    seen.add(dir);
    candidates.push(dir);
  };

  // ① 从本模块文件位置逐级上溯（插件装在 …/node_modules/@scope/pkg/ 下，依赖可能提升到更上层）
  let dir = dirname(fileURLToPath(options.moduleUrl ?? import.meta.url));
  for (;;) {
    // 位于 node_modules 目录时，其下再拼 node_modules 无意义（…/node_modules/node_modules）
    if (basename(dir) !== NODE_MODULES) push(join(dir, NODE_MODULES, FFMPEG_STATIC_PACKAGE));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // ② opencode 包缓存根：<home>/.cache/opencode/packages/<pkg>/node_modules/ffmpeg-static
  const cacheRoot = join(options.home ?? homedir(), ...PACKAGES_CACHE_SEGMENTS);
  const pushPackage = (packageDir: string): void => {
    push(join(packageDir, NODE_MODULES, FFMPEG_STATIC_PACKAGE));
  };
  for (const entry of readdir(cacheRoot)) {
    if (entry.startsWith("@")) {
      for (const scoped of readdir(join(cacheRoot, entry))) pushPackage(join(cacheRoot, entry, scoped));
      continue;
    }
    pushPackage(join(cacheRoot, entry));
  }
  return candidates;
}

/**
 * 按候选顺序找第一个真实存在的 `ffmpeg-static` 包目录。
 * @param candidates 候选目录（按优先级）
 * @param exists 存在性检查（测试可注入）
 * @returns 命中的包目录；全不命中 null
 */
export function findFfmpegStaticDir(
  candidates: readonly string[],
  exists: (path: string) => boolean = existsSync,
): string | null {
  for (const dir of candidates) {
    if (exists(join(dir, PACKAGE_JSON))) return dir;
  }
  return null;
}

/** `healStaticDir` 入参。 */
export interface HealStaticDirOptions {
  /** 目标平台（默认 `process.platform`）。 */
  platform?: NodeJS.Platform;
  /** 当前 Node 可执行文件（默认 `process.execPath`）。 */
  nodePath?: string;
  /** `install.js` 超时（毫秒）。 */
  timeoutMs?: number;
  /** 可拷贝的已有二进制（按顺序尝试）。 */
  copySources?: readonly string[];
  /** fs 注入。 */
  fs?: FfmpegHealFs;
  /** spawn 注入。 */
  spawn?: FfmpegHealSpawn;
  /** 日志（摘要行；默认静默）。 */
  log?: (message: string) => void;
  /** 二进制「可用」判定覆盖（运行时据 `-version` 真执行结果传入：存在但不可执行 ⇒ false）。 */
  binaryUsable?: boolean;
  /** 真执行校验实现（默认 `probeFfmpeg`，即 memo 化的 `<bin> -version`）。 */
  verify?: (path: string) => boolean;
  /** 下载子进程的基础环境变量（默认 `process.env`；读取 `VOICE_FFMPEG_DOWNLOAD_PROXY` 与 env 代理）。 */
  env?: NodeJS.ProcessEnv;
  /** 系统代理（不传则按平台自动检测；测试可注入）。 */
  systemProxy?: SystemProxyInfo;
  /** 系统代理读取函数（默认 Windows 查注册表；测试可注入以断言「拷贝分支不读注册表」）。 */
  readSystemProxy?: () => SystemProxyInfo;
}

/** 单个 `ffmpeg-static` 目录的补齐结果。 */
export interface HealStaticDirResult {
  /** 结果状态。 */
  status: HealStatus;
  /** 选中的动作码（便于日志/测试断言）。 */
  action: HealAction;
  /** 面向用户/日志的说明（不含凭据）。 */
  detail: string;
  /** 期望的二进制绝对路径。 */
  binaryPath: string;
}

/** 追加子进程输出摘要（保留尾部，防无界增长）。 */
function appendTail(parts: string[], chunk: Buffer | string, max: number = 2000): void {
  parts.push(String(chunk));
  let total = parts.reduce((sum, part) => sum + part.length, 0);
  while (total > max && parts.length > 1) {
    total -= parts.shift()?.length ?? 0;
  }
}

/**
 * 在指定目录运行 `install.js`（`spawn` + 当前 Node，无 shell），超时 kill。
 * @param dir `ffmpeg-static` 包目录
 * @param binaryPath 期望落地的二进制路径
 * @param options 注入项
 * @returns 安装结果（`installed` / `timeout` / `error`）
 */
function runInstallScript(
  dir: string,
  binaryPath: string,
  options: Required<Pick<HealStaticDirOptions, "nodePath" | "fs" | "spawn">> & {
    timeoutMs: number;
    log: (message: string) => void;
    platform: NodeJS.Platform;
    env: NodeJS.ProcessEnv;
    systemProxy?: SystemProxyInfo;
    readSystemProxy?: () => SystemProxyInfo;
  },
): Promise<HealStaticDirResult> {
  const { nodePath, fs, spawn: spawnFn, timeoutMs, log } = options;
  // 代理决策与注册表读取只在真正下载时发生（拷贝分支不碰注册表）
  const systemProxy =
    options.systemProxy ??
    (options.readSystemProxy
      ? options.readSystemProxy()
      : detectWindowsSystemProxy({ platform: options.platform, env: options.env, log }));
  const explicitProxy = options.env[DOWNLOAD_PROXY_ENV];
  const resolvedProxy = resolveDownloadProxy({ env: options.env, systemProxy, explicitProxy });
  const downloadEnv = buildDownloadEnv({ env: options.env, systemProxy, explicitProxy });
  log(
    `[ffmpeg-heal] 下载代理 source=${resolvedProxy.source}` +
      (resolvedProxy.proxy ? ` url=${maskProxyForLog(resolvedProxy.proxy)}` : ""),
  );
  return new Promise<HealStaticDirResult>((resolveInstall) => {
    let child: HealChildProcess;
    try {
      child = spawnFn(nodePath, [FFMPEG_INSTALL_SCRIPT], {
        cwd: dir,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env: downloadEnv,
      });
    } catch (err) {
      resolveInstall({
        status: "error",
        action: "run-install",
        detail: `启动 install.js 失败：${(err as Error).message}`,
        binaryPath,
      });
      return;
    }
    const stdout: string[] = [];
    const stderr: string[] = [];
    let settled = false;
    const settle = (result: HealStaticDirResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveInstall(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // kill 失败不影响结果判定
      }
      settle({
        status: "timeout",
        action: "run-install",
        detail: `install.js 超时（${timeoutMs}ms）已终止`,
        binaryPath,
      });
    }, Math.max(1, timeoutMs));

    child.stdout?.on("data", (chunk) => appendTail(stdout, chunk));
    child.stderr?.on("data", (chunk) => appendTail(stderr, chunk));
    child.on("error", (error) => {
      settle({
        status: "error",
        action: "run-install",
        detail: `install.js 运行失败：${error.message}`,
        binaryPath,
      });
    });
    child.on("close", (code) => {
      const summary = `${stdout.join("")}${stderr.join("")}`.trim().slice(-400);
      if (code === 0 && fs.exists(binaryPath)) {
        log(`[ffmpeg-heal] install.js 完成：${binaryPath}`);
        settle({ status: "installed", action: "run-install", detail: `已下载二进制：${binaryPath}`, binaryPath });
        return;
      }
      settle({
        status: "error",
        action: "run-install",
        detail: `install.js 退出码=${code ?? "null"}，二进制${fs.exists(binaryPath) ? "已存在" : "仍缺失"}${
          summary ? `；输出：${summary}` : ""
        }`,
        binaryPath,
      });
    });
  });
}

/**
 * 补齐**单个** `ffmpeg-static` 目录（脚本与运行时共用，无 memo）。
 * @param dir 包目录
 * @param options 注入项
 * @returns 结果（绝不抛）
 */
export async function healStaticDir(
  dir: string,
  options: HealStaticDirOptions = {},
): Promise<HealStaticDirResult> {
  const platform = options.platform ?? process.platform;
  const fs = options.fs ?? DEFAULT_FS;
  const binaryPath = join(dir, ffmpegBinaryName(platform));
  const log = options.log ?? (() => undefined);
  const nodePath = options.nodePath ?? process.execPath;
  try {
    // `binaryUsable` 由上层据「-version 真执行」结果传入；未传时退回仅看存在性
    const hasBinary = options.binaryUsable ?? fs.exists(binaryPath);
    const hasInstallScript = fs.exists(join(dir, FFMPEG_INSTALL_SCRIPT));
    // Node 可执行文件存在才认为能跑 install.js（测试注入的假路径走 false 分支）
    const hasNode = nodePath.length > 0 && fs.exists(nodePath);
    const copySources = (options.copySources ?? []).filter((source) => source !== binaryPath && fs.exists(source));
    const action = decideHealAction({ hasBinary, hasInstallScript, hasNode, hasOtherCopy: copySources.length > 0 });
    log(`[ffmpeg-heal] dir=${dir} action=${action}（binary=${hasBinary} install=${hasInstallScript} node=${hasNode} copies=${copySources.length}）`);

    if (action === "already-ok") {
      return { status: "ok", action, detail: `二进制已存在：${binaryPath}`, binaryPath };
    }

    if (action === "copy-from-elsewhere") {
      const errors: string[] = [];
      for (const source of copySources) {
        try {
          fs.copyFile(source, binaryPath);
          if (platform !== "win32") fs.chmod(binaryPath, 0o755);
          if (fs.exists(binaryPath)) {
            log(`[ffmpeg-heal] 已拷贝二进制 ${source} → ${binaryPath}`);
            return { status: "copied", action, detail: `已从 ${source} 拷贝二进制`, binaryPath };
          }
          errors.push(`${source}（拷贝后不存在）`);
        } catch (err) {
          errors.push(`${source}（${(err as Error).message}）`);
        }
      }
      // 跨盘/权限失败 → 降级到 install.js（若可运行）
      if (!hasInstallScript || !hasNode) {
        return {
          status: "error",
          action,
          detail: `拷贝失败且无法运行 install.js：${errors.join("；")}`,
          binaryPath,
        };
      }
      log(`[ffmpeg-heal] 拷贝失败，降级 install.js：${errors.join("；")}`);
    }

    if (!hasInstallScript) {
      return { status: "unavailable", action: "give-up", detail: `缺少 ${FFMPEG_INSTALL_SCRIPT}：${dir}`, binaryPath };
    }
    if (!hasNode) {
      return { status: "unavailable", action: "give-up", detail: `当前 Node 可执行文件不可用：${nodePath}`, binaryPath };
    }
    return await runInstallScript(dir, binaryPath, {
      nodePath,
      fs,
      spawn: options.spawn ?? DEFAULT_SPAWN,
      timeoutMs: options.timeoutMs ?? DEFAULT_HEAL_TIMEOUT_MS,
      log,
      platform,
      env: options.env ?? process.env,
      systemProxy: options.systemProxy,
      readSystemProxy: options.readSystemProxy,
    });
  } catch (err) {
    return {
      status: "error",
      action: "give-up",
      detail: `自愈异常：${(err as Error).message}`,
      binaryPath,
    };
  }
}

/** `ensureFfmpegBinary` 入参。 */
export interface EnsureFfmpegOptions extends HealStaticDirOptions {
  /** 模块 URL（决定「本插件自身」候选；默认当前模块）。 */
  moduleUrl?: string;
  /** home（决定插件缓存根；默认 `os.homedir()`）。 */
  home?: string;
  /** 候选目录覆盖（为空则用 `VOICE_FFMPEG_STATIC_DIRS`，再回退 {@link staticDirCandidates}）。 */
  staticDirs?: readonly string[];
  /** 环境变量表（读取 `VOICE_FFMPEG_STATIC_DIRS`；默认 `process.env`）。 */
  env?: NodeJS.ProcessEnv;
  /** 解析现有 ffmpeg（默认 `resolveFfmpegPath`；抛错视为不可用）。 */
  resolveExisting?: () => string | null;
  /** 是否启用每进程一次 memo（默认 true；脚本按目录循环时传 false）。 */
  memoize?: boolean;
}

/** `ensureFfmpegBinary` 结果。 */
export interface EnsureFfmpegResult {
  /** 结果状态。 */
  status: HealStatus;
  /** 选中的动作码。 */
  action: HealAction;
  /** 说明（面向用户/日志）。 */
  detail: string;
  /** 可用的二进制路径（成功时必有；失败时是期望路径或 undefined）。 */
  binaryPath?: string;
}

/**
 * 解析 `VOICE_FFMPEG_STATIC_DIRS`（多路径用平台分隔符；空值视为未设置）。
 * @param env 环境变量表
 * @returns 目录数组；未设置 null
 */
function staticDirsFromEnv(env: NodeJS.ProcessEnv): string[] | null {
  const raw = env[FFMPEG_STATIC_DIRS_ENV]?.trim();
  if (!raw) return null;
  const dirs = raw.split(delimiter).map((dir) => dir.trim()).filter(Boolean);
  return dirs.length > 0 ? dirs : null;
}

/** 默认「现有解析」：`resolveFfmpegPath` 抛错 ⇒ null。 */
function defaultResolveExisting(): string | null {
  try {
    return resolveFfmpegPath();
  } catch {
    return null;
  }
}

/** 每进程只尝试一次的结果缓存（失败也缓存：用户修复后需重启进程）。 */
let healMemo: Promise<EnsureFfmpegResult> | undefined;

/**
 * 复位 memo（**仅供测试**；生产不要调用）。
 */
export function resetEnsureFfmpegMemo(): void {
  healMemo = undefined;
}

/** 无 memo 的实际编排。 */
async function ensureFfmpegUncached(options: EnsureFfmpegOptions): Promise<EnsureFfmpegResult> {
  const platform = options.platform ?? process.platform;
  const fs = options.fs ?? DEFAULT_FS;
  try {
    const existing = (options.resolveExisting ?? defaultResolveExisting)();
    if (existing) {
      return { status: "ok", action: "already-ok", detail: `ffmpeg 已可用（${existing}），跳过自愈`, binaryPath: existing };
    }
    const dirs =
      options.staticDirs ??
      staticDirsFromEnv(options.env ?? process.env) ??
      staticDirCandidates({ moduleUrl: options.moduleUrl, home: options.home });
    const target = findFfmpegStaticDir(dirs, fs.exists);
    if (!target) {
      return {
        status: "unavailable",
        action: "give-up",
        detail: `未找到 ${FFMPEG_STATIC_PACKAGE} 目录（候选 ${dirs.length} 个）`,
      };
    }
    const binaryName = ffmpegBinaryName(platform);
    const targetBinary = join(target, binaryName);
    // 纯存在性不算可用：必须 `-version` 真执行通过（否则按「缺失」处理，走拷贝/重新下载）
    const verify = options.verify ?? ((path: string) => probeFfmpeg(path));
    const binaryUsable = fs.exists(targetBinary) && verify(targetBinary);
    const others: string[] = [];
    for (const dir of dirs) {
      if (dir === target) continue;
      const candidate = join(dir, binaryName);
      if (fs.exists(candidate) && verify(candidate) && !others.includes(candidate)) others.push(candidate);
    }
    for (const source of options.copySources ?? []) {
      if (source !== targetBinary && fs.exists(source) && verify(source) && !others.includes(source)) others.push(source);
    }
    (options.log ?? (() => undefined))(
      `[ffmpeg-heal] target=${target} binaryUsable=${binaryUsable} 其它副本=${others.length}`,
    );
    const healed = await healStaticDir(target, { ...options, copySources: others, binaryUsable });
    if (
      (healed.status === "ok" || healed.status === "copied" || healed.status === "installed") &&
      healed.binaryPath !== undefined
    ) {
      // 文件可能刚被拷贝/下载覆盖：先清旧校验缓存再验一次
      forgetFfmpegProbe(healed.binaryPath);
      if (!verify(healed.binaryPath)) {
        return {
          status: "error",
          action: healed.action,
          detail: `二进制存在但 -version 校验失败：${healed.binaryPath}`,
          binaryPath: healed.binaryPath,
        };
      }
    }
    return healed;
  } catch (err) {
    return {
      status: "error",
      action: "give-up",
      detail: `自愈异常：${(err as Error).message}`,
    };
  }
}

/**
 * 确保 ffmpeg 可用（运行时入口）：解析已可用（**真执行通过**）则跳过；否则找 `ffmpeg-static` 目录，
 * 优先从同机其它副本拷贝，否则就地跑 `install.js`；结果路径仍要过 `-version` 真执行校验。
 *
 * 2026-10-28 第十九批：`FFMPEG_BIN` 未通过校验 / 未设置、随附二进制不可用时**总是**走本函数
 * （不再「仅当全部解析失败才自愈」，也不再回落系统 PATH）。
 *
 * **每进程只尝试一次**（`memoize !== false` 时），失败结果同样缓存——避免重试风暴。
 * @param options 注入项
 * @returns 结果（绝不抛）
 */
export function ensureFfmpegBinary(options: EnsureFfmpegOptions = {}): Promise<EnsureFfmpegResult> {
  if (options.memoize === false) return ensureFfmpegUncached(options);
  if (healMemo === undefined) healMemo = ensureFfmpegUncached(options);
  return healMemo;
}
