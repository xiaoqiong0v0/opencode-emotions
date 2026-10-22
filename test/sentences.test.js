/**
 * `splitSentences`（标点断句，纯函数）的离线单测。
 *
 * 覆盖：中/英句末标点、`.` 的小数保护、省略号、连续标点并入同句、空段丢弃、未完尾巴（tail）原样返回。
 * 该函数现**仅用于退化分段**（无流式播放器时的段边界），不再用于合成分块/自动朗读主切分
 * （见 `test/stream.test.js` 的阈值 + 增量口径）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { splitSentences } from "../dist/voice/tts/sentences.js";

test("splitSentences：中文句末标点，标点跟在前句末尾", () => {
  assert.deepEqual(splitSentences("你好。世界！"), { sentences: ["你好。", "世界！"], tail: "" });
  assert.deepEqual(splitSentences("甲；乙？丙。"), { sentences: ["甲；", "乙？", "丙。"], tail: "" });
  assert.deepEqual(splitSentences("等等……然后呢"), { sentences: ["等等……"], tail: "然后呢" });
});

test("splitSentences：英文句末标点，`.` 仅在后接空白/结尾时成句（小数不误切）", () => {
  assert.deepEqual(splitSentences("Hi. There! Ok?"), { sentences: ["Hi.", "There!", "Ok?"], tail: "" });
  assert.deepEqual(splitSentences("3.14 是圆周率。"), { sentences: ["3.14 是圆周率。"], tail: "" });
  // 注：缩写（e.g.）不做特判——`.` 后接空白即成句，属已知取舍
  assert.deepEqual(splitSentences("e.g. this"), { sentences: ["e.g."], tail: " this" });
});

test("splitSentences：连续标点并入同句、换行分句、空段丢弃", () => {
  assert.deepEqual(splitSentences("真的吗？！行。"), { sentences: ["真的吗？！", "行。"], tail: "" });
  assert.deepEqual(splitSentences("Hello!!!"), { sentences: ["Hello!!!"], tail: "" });
  assert.deepEqual(splitSentences("你好。\n\n世界。"), { sentences: ["你好。", "世界。"], tail: "" });
});

test("splitSentences：无尾标点/空串——尾巴原样返回", () => {
  assert.deepEqual(splitSentences("你好。世界"), { sentences: ["你好。"], tail: "世界" });
  assert.deepEqual(splitSentences("abcdef"), { sentences: [], tail: "abcdef" });
  assert.deepEqual(splitSentences(""), { sentences: [], tail: "" });
});
