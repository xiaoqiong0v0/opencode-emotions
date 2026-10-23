/**
 * JSONC 解析（零依赖）：剥离 `//` 行注释、`/* *\/` 块注释（字符串内的注释符保留）
 * 与对象/数组末尾的多余逗号，再交给 `JSON.parse` 做严格解析。
 *
 * 与 referential 实现同构（逐字符扫描并跟踪字符串状态与转义），
 * 避免「字符串里的 // 被当注释」这类行为漂移。
 *
 * **错误位置（2026-10-22 审计修复）**：剥离会改变字符偏移（注释被删除、行号可能漂移），
 * 故两趟剥离都保留 **剥离后索引 → 原文索引** 的映射；解析失败时把 `JSON.parse` 的偏移
 * （缺失时用内置扫描器定位）换算回用户原文偏移，供配置层给出「第几行第几列」。
 */

/** 剥离结果：文本 + 「剥离后字符索引 → 原文索引」映射。 */
interface MappedText {
  /** 剥离后的文本。 */
  text: string;
  /** `map[i]` = 剥离后第 i 个字符在输入文本中的索引。 */
  map: number[];
}

/**
 * 去掉 JSONC 文本中的行注释与块注释，字符串内的内容保留，并记录索引映射。
 * @param text JSONC 原文
 * @returns 剥离结果
 */
function stripJsoncCommentsMapped(text: string): MappedText {
  const out: string[] = [];
  const map: number[] = [];
  let i = 0;
  const length = text.length;
  let inString = false;
  let escaped = false;
  while (i < length) {
    const ch = text[i];
    if (inString) {
      out.push(ch);
      map.push(i);
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out.push(ch);
      map.push(i);
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
    map.push(i);
    i += 1;
  }
  return { text: out.join(""), map };
}

/**
 * 去掉 JSONC 文本中对象/数组末尾的多余逗号（仅删字符串外的逗号），并记录索引映射。
 * @param text 已去注释的文本
 * @returns 剥离结果
 */
function stripTrailingCommasMapped(text: string): MappedText {
  const out: string[] = [];
  const map: number[] = [];
  let i = 0;
  const length = text.length;
  let inString = false;
  let escaped = false;
  while (i < length) {
    const ch = text[i];
    if (inString) {
      out.push(ch);
      map.push(i);
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out.push(ch);
      map.push(i);
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
    map.push(i);
    i += 1;
  }
  return { text: out.join(""), map };
}

/**
 * 去掉 JSONC 文本中的行注释与块注释，字符串内的内容保留。
 * @param text JSONC 原文
 * @returns 去掉注释后的文本
 */
export function stripJsoncComments(text: string): string {
  return stripJsoncCommentsMapped(text).text;
}

/**
 * 去掉 JSONC 文本中对象/数组末尾的多余逗号（仅删字符串外的逗号）。
 * @param text 已去注释的文本
 * @returns 去掉尾逗号后的文本
 */
export function stripTrailingCommas(text: string): string {
  return stripTrailingCommasMapped(text).text;
}

/** 内置 JSON 扫描器在首个语法错误处的索引。 */
class JsonScanError extends Error {
  /**
   * @param index 出错字符索引（EOF 时为文本长度）
   */
  constructor(readonly index: number) {
    super("json syntax error");
  }
}

/**
 * 找到严格 JSON 文本的首个语法错误索引（`JSON.parse` 在部分错误上不提供位置时兜底）。
 *
 * 只做结构校验（对象/数组/字符串/数字/字面量），不产生面向用户的错误文案；
 * 用于把「Unexpected token」这类无位置消息定位到字符偏移。
 * @param text 严格 JSON 文本
 * @returns 出错字符索引；未发现错误（或扫描器无法判定）→ undefined
 */
export function findJsonErrorOffset(text: string): number | undefined {
  const length = text.length;
  let pos = 0;

  /** 记录当前索引并抛出扫描错误。 */
  const fail = (): never => {
    throw new JsonScanError(Math.min(pos, length));
  };
  /** 跳过 JSON 空白。 */
  const skipWhitespace = (): void => {
    while (pos < length && (text[pos] === " " || text[pos] === "\t" || text[pos] === "\r" || text[pos] === "\n")) {
      pos += 1;
    }
  };
  /** 解析字符串（含转义与未转义控制字符校验）。 */
  const parseString = (): void => {
    if (text[pos] !== '"') fail();
    pos += 1;
    while (pos < length) {
      const ch = text[pos];
      if (ch === '"') {
        pos += 1;
        return;
      }
      if (ch === "\\") {
        pos += 2;
        continue;
      }
      if (ch.charCodeAt(0) < 0x20) fail();
      pos += 1;
    }
    fail();
  };
  /** 解析数字。 */
  const parseNumber = (): void => {
    if (text[pos] === "-") pos += 1;
    if (text[pos] === "0") pos += 1;
    else if (text[pos] !== undefined && /[1-9]/.test(text[pos])) {
      pos += 1;
      while (pos < length && /[0-9]/.test(text[pos])) pos += 1;
    } else fail();
    if (text[pos] === ".") {
      pos += 1;
      if (text[pos] === undefined || !/[0-9]/.test(text[pos])) fail();
      while (pos < length && /[0-9]/.test(text[pos])) pos += 1;
    }
    if (text[pos] === "e" || text[pos] === "E") {
      pos += 1;
      if (text[pos] === "+" || text[pos] === "-") pos += 1;
      if (text[pos] === undefined || !/[0-9]/.test(text[pos])) fail();
      while (pos < length && /[0-9]/.test(text[pos])) pos += 1;
    }
  };
  /** 解析对象。 */
  const parseObject = (): void => {
    pos += 1;
    skipWhitespace();
    if (text[pos] === "}") {
      pos += 1;
      return;
    }
    for (;;) {
      skipWhitespace();
      parseString();
      skipWhitespace();
      if (text[pos] !== ":") fail();
      pos += 1;
      parseValue();
      skipWhitespace();
      if (text[pos] === ",") {
        pos += 1;
        continue;
      }
      if (text[pos] === "}") {
        pos += 1;
        return;
      }
      fail();
    }
  };
  /** 解析数组。 */
  const parseArray = (): void => {
    pos += 1;
    skipWhitespace();
    if (text[pos] === "]") {
      pos += 1;
      return;
    }
    for (;;) {
      parseValue();
      skipWhitespace();
      if (text[pos] === ",") {
        pos += 1;
        continue;
      }
      if (text[pos] === "]") {
        pos += 1;
        return;
      }
      fail();
    }
  };
  /** 解析字面量。 */
  const parseLiteral = (word: string): void => {
    if (text.startsWith(word, pos)) pos += word.length;
    else fail();
  };
  /** 解析任意值。 */
  function parseValue(): void {
    skipWhitespace();
    const ch = text[pos];
    if (ch === "{") parseObject();
    else if (ch === "[") parseArray();
    else if (ch === '"') parseString();
    else if (ch === "-" || (ch !== undefined && /[0-9]/.test(ch))) parseNumber();
    else if (ch === "t") parseLiteral("true");
    else if (ch === "f") parseLiteral("false");
    else if (ch === "n") parseLiteral("null");
    else fail();
  }

  try {
    parseValue();
    skipWhitespace();
    if (pos !== length) fail();
    return undefined;
  } catch (error) {
    return error instanceof JsonScanError ? error.index : undefined;
  }
}

/** 解析错误 → 原文偏移（弱引用，不污染异常对象）。 */
const errorOffsets = new WeakMap<object, number>();

/**
 * 取 `parseJsonc` 抛出的错误在**原文**中的字符偏移。
 * @param error 解析异常
 * @returns 字符偏移；非 JSONC 解析错误/无法定位 → undefined
 */
export function getJsoncErrorOffset(error: unknown): number | undefined {
  return typeof error === "object" && error !== null ? errorOffsets.get(error) : undefined;
}

/**
 * 把「剥离后偏移」换算回原文偏移（EOF 或映射缺失时退化为原文长度）。
 * @param strippedOffset 剥离后文本中的偏移
 * @param trailing 第二趟（尾逗号）剥离映射
 * @param comments 第一趟（注释）剥离映射
 * @param originalLength 原文长度
 * @returns 原文字符偏移
 */
function toOriginalOffset(
  strippedOffset: number,
  trailing: MappedText,
  comments: MappedText,
  originalLength: number,
): number {
  const commentIndex = trailing.map[strippedOffset];
  if (commentIndex === undefined) return originalLength;
  const originalIndex = comments.map[commentIndex];
  return originalIndex === undefined ? originalLength : originalIndex;
}

/**
 * 把 JSONC 文本解析为 JS 值（剥离注释与尾逗号后按严格 JSON 解析）。
 * @param text JSONC 原文
 * @returns 解析结果
 * @throws SyntaxError 剥离后仍非法时由 `JSON.parse` 抛出（可用 {@link getJsoncErrorOffset} 取原文偏移）
 */
export function parseJsonc(text: string): unknown {
  const comments = stripJsoncCommentsMapped(text);
  const trailing = stripTrailingCommasMapped(comments.text);
  try {
    return JSON.parse(trailing.text);
  } catch (error) {
    const native = /at position (\d+)/i.exec(error instanceof Error ? error.message : "");
    const strippedOffset = native ? Number(native[1]) : findJsonErrorOffset(trailing.text);
    if (strippedOffset !== undefined && typeof error === "object" && error !== null) {
      errorOffsets.set(error, toOriginalOffset(strippedOffset, trailing, comments, text.length));
    }
    throw error;
  }
}
