#!/usr/bin/env node
/**
 * 确保 `ffmpeg-static` 随附二进制（Windows `ffmpeg.exe` / 其余 `ffmpeg`）在**项目**与
 * **本机插件缓存**中真实存在（补齐 + 校验）。
 *
 * **薄封装（2026-10-23 第十七批）**：补齐逻辑只在 `src/voice/ffmpeg-heal.ts`（构建产物
 * `dist/voice/ffmpeg-heal.js`）里；本脚本只负责列出「项目 + 缓存」目录并逐目录调用
 * `healStaticDir()`，不再保留第二套 install/拷贝实现。
 *
 * 用法：
 *   node scripts/ensure-ffmpeg.mjs           # 检查并补齐（项目 + 本机缓存）
 *   node scripts/ensure-ffmpeg.mjs --check   # 只检查；有缺失退出码 1
 *
 * 注意：运行时（voice-runtime）已内置同一套自愈，本脚本是**部署/发布前门禁与离线预取**用的。
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ffmpegBinaryName, healStaticDir } from "../dist/voice/ffmpeg-heal.js";

/** 仓库根（本脚本位于 scripts/ 下）。 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** 本机插件缓存根（opencode 约定路径）。 */
const CACHE_ROOT = join(homedir(), ".cache", "opencode", "packages");
/** 只检查不补齐。 */
const CHECK_ONLY = process.argv.includes("--check");
/** 当前平台二进制名。 */
const BINARY_NAME = ffmpegBinaryName(process.platform);

/**
 * 读取本插件包名（用于拼缓存目录）。
 * @returns package.json 的 name
 */
function pluginPackageName() {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  return pkg.name;
}

/**
 * 主流程：项目侧先补（兼作缓存拷贝源）→ 缓存两侧（带/不带 @latest 后缀）。
 * @returns 全部就位 0；有缺失 1
 */
async function main() {
  const name = pluginPackageName();
  const dirs = [
    join(ROOT, "node_modules", "ffmpeg-static"),
    join(CACHE_ROOT, name, "node_modules", "ffmpeg-static"),
    join(CACHE_ROOT, `${name}@latest`, "node_modules", "ffmpeg-static"),
  ];

  let missing = false;
  /** 已就位/本次补齐的二进制（按顺序作为后续目录的离线拷贝源）。 */
  let copySource = null;
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      if (!CHECK_ONLY) console.log(`[ensure-ffmpeg] 跳过（目录不存在）${dir}`);
      continue;
    }
    const binary = join(dir, BINARY_NAME);
    if (existsSync(binary)) {
      console.log(`[ensure-ffmpeg] ok（${binary}）`);
      copySource ??= binary;
      continue;
    }
    if (CHECK_ONLY) {
      console.log(`[ensure-ffmpeg] 缺失（${binary}）`);
      missing = true;
      continue;
    }
    const result = await healStaticDir(dir, {
      copySources: copySource ? [copySource] : [],
      log: (message) => console.log(message),
    });
    console.log(`[ensure-ffmpeg] ${result.status}（${result.binaryPath}）：${result.detail}`);
    if (result.status === "ok" || result.status === "copied" || result.status === "installed") {
      copySource ??= result.binaryPath;
    } else {
      missing = true;
    }
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

process.exitCode = await main();
