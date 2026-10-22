#!/usr/bin/env node
/**
 * 本地发布：把构建产物 `dist/` **整体镜像**到 `.opencode/plugin/`，并让 `.opencode/tui.json`
 * 指向编译后的 TUI 产物。
 *
 * 约定（与 `dist/` 结构一一对应）：
 * - `.opencode/plugin/` **顶层只允许真插件入口**（`emotions.js` / `tui.js`）；
 *   opencode 会把该目录顶层的每个 `.js` 当插件自动 import，故 CLI / 运行时等非插件产物一律进子目录。
 *   `emotions.js` 是**唯一 server 入口**（情绪命令 + `emotions_cli` 工具），另有 `tui.js`（TUI 插件）。
 * - 子目录（`cli/` `runtime/` `lib/` `voice/`）不被自动扫描，可安全承载依赖。
 *
 * 行为：
 * 1. 校验 `dist/` 顶层结构（防回归）——顶层 `.js` 必须是白名单内的插件入口；
 * 2. 清理本脚本管理的输出目录 `.opencode/plugin/`（整体重建，保证幂等）；
 * 3. 递归镜像 `dist/` → `.opencode/plugin/`；
 * 4. 再次校验 `.opencode/plugin/` 顶层，并确保 TUI 入口存在；
 * 5. 确保 `.opencode/tui.json` 的 `plugin` 指向 `./plugin/tui.js`（相对该配置文件解析）。
 *
 * 用法：`node scripts/publish-proj.mjs`（由 `npm run publish:proj` 在 `npm run build` 后执行）。
 */

import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 仓库根（本脚本位于 scripts/ 下）。 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** 构建产物目录。 */
const DIST = join(ROOT, "dist");
/** 本脚本管理的输出目录（opencode 自动加载 server 插件的目录）。 */
const PLUGIN_DIR = join(ROOT, ".opencode", "plugin");
/** TUI 插件配置文件。 */
const TUI_JSON = join(ROOT, ".opencode", "tui.json");

/** 允许出现在插件目录顶层的真插件入口（其余非插件产物必须进子目录）。 */
const PLUGIN_ENTRIES = ["emotions.js", "tui.js"];
/** 允许出现在顶层的非插件子目录。 */
const ALLOWED_DIRS = ["cli", "runtime", "lib", "voice"];
/** TUI 插件入口（相对 `tui.json` 所在的 `.opencode/` 目录）。 */
const TUI_ENTRY_SPEC = "./plugin/tui.js";
/** 必须存在的子目录产物（结构回归哨兵）。 */
const REQUIRED_SUBDIR_FILES = [join("cli", "emotions-cli.js"), join("runtime", "voice-runtime.js")];

/**
 * 校验某目录顶层结构：顶层文件必须是白名单插件入口，顶层目录必须来自白名单。
 * @param {string} dir 待校验目录
 * @param {string} label 报错时用于定位的标签
 */
function assertTopLevel(dir, label) {
  if (!existsSync(dir)) throw new Error(`${label} 不存在：${dir}（请先 npm run build）`);
  const entries = readdirSync(dir);
  const badFiles = [];
  for (const name of entries) {
    const isDir = statSync(join(dir, name)).isDirectory();
    if (isDir) {
      if (!ALLOWED_DIRS.includes(name)) badFiles.push(`${name}/（未知顶层目录）`);
      continue;
    }
    // 顶层非插件文件：只允许白名单内的 `.js` 插件入口（cli/runtime 等一律子目录）。
    if (!name.endsWith(".js") || !PLUGIN_ENTRIES.includes(name)) {
      badFiles.push(`${name}（顶层只允许 ${PLUGIN_ENTRIES.join(" / ")}）`);
    }
  }
  if (badFiles.length) {
    throw new Error(
      `${label} 顶层结构非法：\n  - ${badFiles.join("\n  - ")}\n` +
        `非插件产物（CLI/运行时等）必须位于子目录（可放：${ALLOWED_DIRS.join(" / ")}）。`,
    );
  }
  for (const name of PLUGIN_ENTRIES) {
    if (!existsSync(join(dir, name))) throw new Error(`${label} 缺少插件入口：${name}`);
  }
}

/** 校验必须存在的子目录产物（防结构回归）。 */
function assertRequiredFiles(base, label) {
  for (const rel of REQUIRED_SUBDIR_FILES) {
    if (!existsSync(join(base, rel))) throw new Error(`${label} 缺少子目录产物：${rel}`);
  }
}

/** 让 `.opencode/tui.json` 的 `plugin` 指向编译产物（保留其余字段）。 */
function pointTuiConfigAtBuild() {
  let json = {};
  if (existsSync(TUI_JSON)) {
    json = JSON.parse(readFileSync(TUI_JSON, "utf8"));
  }
  json.plugin = [TUI_ENTRY_SPEC];
  writeFileSync(TUI_JSON, `${JSON.stringify(json, null, 2)}\n`, "utf8");
}

function main() {
  // 1) 源结构校验
  assertTopLevel(DIST, "dist/");
  assertRequiredFiles(DIST, "dist/");

  // 2) 清理本脚本管理的输出目录（整体重建 ⇒ 幂等；该目录为 gitignored 的纯生成物）
  rmSync(PLUGIN_DIR, { recursive: true, force: true });

  // 3) 递归镜像
  cpSync(DIST, PLUGIN_DIR, { recursive: true });

  // 4) 目标结构校验
  assertTopLevel(PLUGIN_DIR, ".opencode/plugin/");
  assertRequiredFiles(PLUGIN_DIR, ".opencode/plugin/");

  // 5) TUI 配置指向编译产物
  pointTuiConfigAtBuild();

  const top = readdirSync(PLUGIN_DIR).sort();
  console.log(
    `[publish:proj] dist/ -> .opencode/plugin/ 完成；顶层：[${top.join(", ")}]；` +
      `tui.json plugin=${TUI_ENTRY_SPEC}（${relative(ROOT, TUI_JSON)}）`,
  );
}

main();
