/**
 * TUI 错误/告警文案本地化的产物接线断言（只读 `dist/tui.js` 文本，不执行）。
 *
 * TUI 产物依赖宿主重写 `@opentui/solid` / `solid-js`，无法在 node 里 import，故沿用
 * `test/tui-diagnostics.test.js` 的做法：只断言构建产物里确实走了 i18n 映射、
 * 且不再残留硬编码的中文错误文案（修复前 `exitCodeReason()` 的中文与直接展示 runtime message 会让
 * `uiLanguage=en` 仍显中文）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** TUI 产物绝对路径（仓库根/dist/tui.js）。 */
const TUI_JS = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "tui.js");

/** 读取 TUI 产物源码文本。 */
function tuiSource() {
  return readFileSync(TUI_JS, "utf8");
}

/**
 * 剥离 JS 源码里的注释（`//` 行注释与 `/* *\/` 块注释），字符串字面量原样保留。
 *
 * **为什么需要**：Babel 产物会保留源码注释，而注释里合法引用了旧硬编码中文（「修复前是…」），
 * 直接对原文 `includes` 会误判成「产物仍硬编码」。逐字符扫描并跟踪引号状态，
 * 避免把 `https://…` 这类字符串里的 `//` 当成注释起点。
 * @param {string} source 源码文本
 * @returns {string} 去掉注释后的文本
 */
function stripComments(source) {
  let out = "";
  let quote = null;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      out += ch;
      if (ch === "\\") {
        out += source[i + 1] ?? "";
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

test("TUI 错误/告警文案走 i18n：runtimeErrorText / runtimeErrorShortText 均按 uiLanguage", () => {
  const src = tuiSource();
  assert.ok(src.includes("runtimeErrorText("), "error/warning 必须经 runtimeErrorText 渲染（修复前直接展示 message）");
  assert.ok(src.includes("runtimeErrorShortText("), "退出码提示必须经 runtimeErrorShortText（修复前硬编码中文）");
  assert.ok(src.includes("uiLanguage"), "渲染必须传 uiLanguage");
});

test("TUI 产物不再硬编码中文错误文案（修复前 exitCodeReason 返回「未检测到麦克风」）", () => {
  // 先剥注释再断言：Babel 产物保留源码注释，注释里会合法引用旧硬编码中文（描述「修复前」）。
  // 选这个口径而不是「改断言稳定可观测点」，是因为「产物里不得出现该中文句子」本身就是本批要守的契约，
  // 只要排除注释噪声即可直接判定，无需再引入间接指标。
  const code = stripComments(tuiSource());
  assert.equal(code.includes("未检测到麦克风"), false, "TUI 不得硬编码中文错误句子");
  assert.equal(code.includes("麦克风似乎没有声音"), false, "TUI 不得硬编码中文告警句子");
});
