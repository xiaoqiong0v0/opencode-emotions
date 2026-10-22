#!/usr/bin/env node
/**
 * 确保 `ffmpeg-static` 随附二进制（Windows `ffmpeg.exe` / 其余 `ffmpeg`）在**项目**与
 * **本机插件缓存**中真实存在（补齐 + 校验）。
 *
 * 为什么需要本脚本（2026-10-22 根因，已取证）：
 * - opencode 安装插件走 `@npmcli/arborist` 且**硬编码 `ignoreScripts: true`**
 *   （opencode 源码 `packages/core/src/npm.ts`）——ffmpeg-static 靠 `install` 脚本从 GitHub
 *   Release 下载二进制，脚本不会执行 ⇒ 缓存目录里只有包文件、没有 `ffmpeg(.exe)`；
 * - 本仓部署工具 `publish_local` 只同步 package.json 的 `dependencies`（整体拷贝），
 *   而 ffmpeg-static 是 `optionalDependencies`（Termux 等平台安装失败不拖垮主装）⇒ 不会被它同步。
 *
 * 行为：
 * 1. 项目侧 `node_modules/ffmpeg-static` 缺二进制 → 在该目录跑 `node install.js` 下载（需网络）；
 * 2. 缓存侧（`~/.cache/opencode/packages/<包名>{,@latest}/node_modules/ffmpeg-static`）存在但缺
 *    二进制 → **优先从项目整体拷贝**（离线、零下载）；项目侧也没有时在缓存目录就地跑 install.js；
 * 3. 全部就位时打印 OK；`--check` 只检查不补齐（有缺失退出码 1，可作发布前门禁）。
 *
 * 用法：
 *   node scripts/ensure-ffmpeg.mjs           # 检查并补齐（项目 + 本机缓存）
 *   node scripts/ensure-ffmpeg.mjs --check   # 只检查；有缺失退出码 1
 *
 * 零第三方依赖（仅 node:内置模块）。
 */

import { chmodSync, copyFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** 仓库根（本脚本位于 scripts/ 下）。 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** 项目 node_modules 下的 ffmpeg-static 目录。 */
const PROJECT_STATIC_DIR = join(ROOT, "node_modules", "ffmpeg-static");
/** 本机插件缓存根（opencode 约定路径）。 */
const CACHE_ROOT = join(homedir(), ".cache", "opencode", "packages");
/** install.js 下载超时（毫秒）；ffmpeg 二进制约 80MB，给足余量。 */
const INSTALL_TIMEOUT_MS = 180_000;
/** Windows 平台的二进制文件名。 */
const EXE_NAME_WIN = "ffmpeg.exe";
/** 非 Windows 平台的二进制文件名。 */
const EXE_NAME_POSIX = "ffmpeg";

/**
 * 当前平台下 ffmpeg-static 应有的二进制文件名。
 * @returns `ffmpeg.exe`（win32）或 `ffmpeg`
 */
function exeName() {
  return process.platform === "win32" ? EXE_NAME_WIN : EXE_NAME_POSIX;
}

/**
 * 读取本插件包名（用于拼缓存目录）。
 * @returns package.json 的 name
 */
function pluginPackageName() {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  return pkg.name;
}

/**
 * 在指定 ffmpeg-static 目录跑 install.js 下载二进制。
 * @param dir ffmpeg-static 包目录
 * @returns 下载成功（二进制落地）true
 */
function runInstallScript(dir) {
  const result = spawnSync(process.execPath, ["install.js"], {
    cwd: dir,
    stdio: "inherit",
    timeout: INSTALL_TIMEOUT_MS,
  });
  return result.status === 0 && existsSync(join(dir, exeName()));
}

/**
 * 确保某个 ffmpeg-static 目录里有二进制；缺失时按「拷贝源优先、否则就地下载」补齐。
 * @param dir ffmpeg-static 包目录（不存在直接跳过）
 * @param copySource 可供拷贝的二进制源文件（项目侧产物；无则 null）
 * @param checkOnly 只检查不补齐
 * @returns `ok`（已就位）| `fixed`（本次补齐）| `missing`（仍缺失）| `skipped`（目录不存在）
 */
function ensureDir(dir, copySource, checkOnly) {
  if (!existsSync(dir)) return "skipped";
  const target = join(dir, exeName());
  if (existsSync(target)) return "ok";
  if (checkOnly) return "missing";
  if (copySource && existsSync(copySource)) {
    copyFileSync(copySource, target);
    if (process.platform !== "win32") chmodSync(target, 0o755);
    console.log(`[ensure-ffmpeg] 已从项目拷贝二进制 → ${target}`);
    return existsSync(target) ? "fixed" : "missing";
  }
  console.log(`[ensure-ffmpeg] ${dir} 缺二进制，就地运行 install.js 下载…`);
  return runInstallScript(dir) ? "fixed" : "missing";
}

/**
 * 主流程：项目侧 → 缓存两侧（带/不带 @latest 后缀）。
 * @returns 全部就位 0；有缺失 1
 */
function main() {
  const checkOnly = process.argv.includes("--check");
  const name = pluginPackageName();
  const cacheDirs = [
    PROJECT_STATIC_DIR,
    join(CACHE_ROOT, name, "node_modules", "ffmpeg-static"),
    join(CACHE_ROOT, `${name}@latest`, "node_modules", "ffmpeg-static"),
  ];

  // 项目侧先补：既服务本仓运行，也作为缓存拷贝源
  let projectExe = join(PROJECT_STATIC_DIR, exeName());
  const projectState = ensureDir(PROJECT_STATIC_DIR, null, checkOnly);
  if (!existsSync(projectExe)) projectExe = null;
  if (projectState === "ok" || projectState === "fixed") {
    console.log(`[ensure-ffmpeg] 项目：ok（${projectExe}）`);
  } else if (projectState === "missing") {
    console.log(`[ensure-ffmpeg] 项目：缺失（${projectExe ?? join(PROJECT_STATIC_DIR, exeName())}）`);
  }

  let missing = projectState === "missing";
  for (const dir of cacheDirs.slice(1)) {
    const state = ensureDir(dir, projectExe, checkOnly);
    if (state === "skipped") {
      console.log(`[ensure-ffmpeg] 缓存：跳过（目录不存在）${dir}`);
      continue;
    }
    console.log(`[ensure-ffmpeg] 缓存：${state}（${join(dir, exeName())}）`);
    if (state === "missing") missing = true;
  }
  if (missing) {
    console.error(
      "[ensure-ffmpeg] 仍有缺失：若网络不可达 GitHub Release，可设置环境变量 FFMPEG_BIN 指向任一可用 ffmpeg，" +
        "或用 winget/choco/scoop 安装系统 ffmpeg。",
    );
    return 1;
  }
  console.log("[ensure-ffmpeg] 全部就位。");
  return 0;
}

process.exit(main());
