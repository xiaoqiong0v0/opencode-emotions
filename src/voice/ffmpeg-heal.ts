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

import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveFfmpegPath } from "./ffmpeg.js";

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
  options: { cwd: string; stdio: ["ignore", "pipe", "pipe"]; windowsHide: boolean },
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
  },
): Promise<HealStaticDirResult> {
  const { nodePath, fs, spawn: spawnFn, timeoutMs, log } = options;
  return new Promise<HealStaticDirResult>((resolveInstall) => {
    let child: HealChildProcess;
    try {
      child = spawnFn(nodePath, [FFMPEG_INSTALL_SCRIPT], {
        cwd: dir,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
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
    const hasBinary = fs.exists(binaryPath);
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
    const others: string[] = [];
    for (const dir of dirs) {
      if (dir === target) continue;
      const candidate = join(dir, binaryName);
      if (fs.exists(candidate) && !others.includes(candidate)) others.push(candidate);
    }
    for (const source of options.copySources ?? []) {
      if (source !== targetBinary && fs.exists(source) && !others.includes(source)) others.push(source);
    }
    (options.log ?? (() => undefined))(`[ffmpeg-heal] target=${target} 其它副本=${others.length}`);
    return await healStaticDir(target, { ...options, copySources: others });
  } catch (err) {
    return {
      status: "error",
      action: "give-up",
      detail: `自愈异常：${(err as Error).message}`,
    };
  }
}

/**
 * 确保 ffmpeg 可用（运行时入口）：解析已可用则跳过；否则找 `ffmpeg-static` 目录，
 * 优先从同机其它副本拷贝，否则就地跑 `install.js`。
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
