#!/usr/bin/env node
/**
 * 清空构建产物目录 `dist/`（由 `npm run build` 的 `prebuild` 自动执行）。
 *
 * 为什么需要：`tsc` 不会删除 `outDir` 里已不存在的文件——源文件改名/移位后会残留旧产物
 * （如把 `src/index.ts` 改成 `src/emotions.ts` 后 `dist/index.js` 仍在），污染发布镜像。
 *
 * 用法：`node scripts/clean-dist.mjs`（通常无需手动跑）。
 */

import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 仓库根（本脚本位于 scripts/ 下）。 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

rmSync(resolve(ROOT, "dist"), { recursive: true, force: true });
console.log("[clean-dist] removed dist/");
