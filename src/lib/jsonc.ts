/**
 * JSONC 解析（零依赖）：剥离 `//` 行注释、`/* *\/` 块注释（字符串内的注释符保留）
 * 与对象/数组末尾的多余逗号，再交给 `JSON.parse` 做严格解析。
 *
 * 与 referential 实现同构（逐字符扫描并跟踪字符串状态与转义），
 * 避免「字符串里的 // 被当注释」这类行为漂移。
 */

/**
 * 去掉 JSONC 文本中的行注释与块注释，字符串内的内容保留。
 * @param text JSONC 原文
 * @returns 去掉注释后的文本
 */
export function stripJsoncComments(text: string): string {
  const out: string[] = [];
  let i = 0;
  const length = text.length;
  let inString = false;
  let escaped = false;
  while (i < length) {
    const ch = text[i];
    if (inString) {
      out.push(ch);
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out.push(ch);
      i += 1;
      continue;
    }
    if (ch === "/" && i + 1 < length && text[i + 1] === "/") {
      i += 2;
      while (i < length && text[i] !== "\r" && text[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && i + 1 < length && text[i + 1] === "*") {
      i += 2;
      while (i + 1 < length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out.push(ch);
    i += 1;
  }
  return out.join("");
}

/**
 * 去掉 JSONC 文本中对象/数组末尾的多余逗号（仅删字符串外的逗号）。
 * @param text 已去注释的文本
 * @returns 去掉尾逗号后的文本
 */
export function stripTrailingCommas(text: string): string {
  const out: string[] = [];
  let i = 0;
  const length = text.length;
  let inString = false;
  let escaped = false;
  while (i < length) {
    const ch = text[i];
    if (inString) {
      out.push(ch);
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out.push(ch);
      i += 1;
      continue;
    }
    if (ch === ",") {
      // 向前跳过空白，若紧接 } 或 ] 则判定为尾逗号并丢弃
      let j = i + 1;
      while (j < length && (text[j] === " " || text[j] === "\t" || text[j] === "\r" || text[j] === "\n")) j += 1;
      if (j < length && (text[j] === "}" || text[j] === "]")) {
        i += 1;
        continue;
      }
    }
    out.push(ch);
    i += 1;
  }
  return out.join("");
}

/**
 * 把 JSONC 文本解析为 JS 值（剥离注释与尾逗号后按严格 JSON 解析）。
 * @param text JSONC 原文
 * @returns 解析结果
 * @throws SyntaxError 剥离后仍非法时由 JSON.parse 抛出
 */
export function parseJsonc(text: string): unknown {
  return JSON.parse(stripTrailingCommas(stripJsoncComments(text)));
}
