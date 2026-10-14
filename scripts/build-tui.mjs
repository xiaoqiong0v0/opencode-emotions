#!/usr/bin/env node
/**
 * 把 TUI 插件入口 `src/tui.tsx` 编译为 `dist/tui.js`。
 *
 * 为什么不能交给 `tsc`（`npm run build` 的另一半）：
 * - opencode 宿主的 Solid 运行时插件（`@opentui/solid` 的 `transformSolidSource`）只对
 *   `.tsx`/`.jsx` 施加 `babel-preset-solid`（见其 `jsxPattern = /\.[cm]?[jt]sx$/`），
 *   对 `.js` **只做 import 重写**；因此预编译产物必须本身就是「Solid 编译后」的形态。
 * - `tsc` 的自动 JSX 运行时输出 `jsx("text", { fg, children })` 不会把 props/children 包成
 *   访问器/`effect`；而 Solid 编译会产出 `createElement` + `insert(() => …)` + `effect(…setProp)`，
 *   槽位 UI 依赖后者才具备响应式。
 *
 * 故这里用**宿主同款 Babel 链**：`babel-preset-solid`（universal，moduleName=`@opentui/solid`）
 * + `@babel/preset-typescript`。产物保留裸 `@opentui/solid` / `solid-js` import，
 * 由宿主在加载时重写为运行时模块 id（本脚本**不做** import 重写，否则宿主无法再映射）。
 *
 * 用法：`node scripts/build-tui.mjs`（由 `npm run build` 串联执行）。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { transformAsync } from "@babel/core";
import ts from "@babel/preset-typescript";
import solid from "babel-preset-solid";

/** 仓库根（本脚本位于 scripts/ 下）。 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** 输入：TUI 插件源码（以 `.tsx` 结尾以触发 Solid + TS preset）。 */
const SRC_TSX = resolve(ROOT, "src", "tui.tsx");
/** 输出：TUI 插件编译产物。 */
const OUT_JS = resolve(ROOT, "dist", "tui.js");
/** Solid 运行时模块名（宿主会把它重写为自身运行时模块）。 */
const MODULE_NAME = "@opentui/solid";

/** 编译 `src/tui.tsx` → `dist/tui.js`。 */
async function buildTui() {
  const code = await readFile(SRC_TSX, "utf8");
  const result = await transformAsync(code, {
    filename: SRC_TSX,
    configFile: false,
    babelrc: false,
    presets: [
      [solid, { moduleName: MODULE_NAME, generate: "universal" }],
      [ts],
    ],
  });
  if (!result?.code) throw new Error(`Babel 未产出代码：${SRC_TSX}`);
  // 防回归：预编译产物若残留 JSX 自动运行时 import，说明 Solid preset 未生效。
  if (result.code.includes(`${MODULE_NAME}/jsx-runtime`)) {
    throw new Error("Solid 编译未生效：产物仍引用 jsx-runtime（不应出现）");
  }
  await mkdir(dirname(OUT_JS), { recursive: true });
  await writeFile(OUT_JS, result.code, "utf8");
  console.log(`[build-tui] ${relative(ROOT, SRC_TSX)} -> ${relative(ROOT, OUT_JS)}`);
}

await buildTui();
