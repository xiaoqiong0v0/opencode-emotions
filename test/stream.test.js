/**
 * 流式送文分块器（`createStreamChunker`，纯状态、无 IO）的离线单测。
 *
 * 覆盖「真流式」口径：阈值未达标不发送、达标后开始且后续随到随发、仅超单条上限才硬切、
 * 结束 flush 兜底（含未达阈值的短文本）、`normalizeStreamMinChars` 归一。
 * 该口径同时用于 `aliyun.ts` 流式合成与 `auto-read.ts` 增量自动朗读。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createStreamChunker,
  normalizeStreamMinChars,
  DEFAULT_STREAM_MIN_CHARS,
  MAX_CONTINUE_CHARS,
} from "../dist/voice/tts/stream.js";

test("normalizeStreamMinChars：非负整数归一，非法回退默认", () => {
  assert.equal(DEFAULT_STREAM_MIN_CHARS, 5);
  assert.equal(normalizeStreamMinChars(undefined), 5);
  assert.equal(normalizeStreamMinChars(Number.NaN), 5);
  assert.equal(normalizeStreamMinChars(Number.POSITIVE_INFINITY), 5);
  assert.equal(normalizeStreamMinChars(-3), 0);
  assert.equal(normalizeStreamMinChars(2.9), 2);
  assert.equal(normalizeStreamMinChars(0), 0);
  assert.equal(normalizeStreamMinChars(8), 8);
});

test("阈值未达标不发送；达标后开始，之后随到随发（默认 5）", () => {
  const c = createStreamChunker({ minChars: 5 });
  assert.equal(c.started, false);
  assert.deepEqual(c.push("你好"), [], "2 字 < 5：缓冲、不发");
  assert.equal(c.started, false);
  assert.deepEqual(c.push("世界"), [], "累计 4 字 < 5：仍不发");
  assert.deepEqual(c.push("啊"), ["你好世界啊"], "累计 5 字达标：一次发出全部缓冲");
  assert.equal(c.started, true);
  assert.deepEqual(c.push("！"), ["！"], "已开始：随到随发（1 字也立即发）");
  assert.deepEqual(c.push(""), [], "空增量不发");
  assert.deepEqual(c.flush(), [], "已无缓冲：flush 为空");
});

test("flush 兜底：始终未达阈值的短文本在结束时送出", () => {
  const c = createStreamChunker({ minChars: 5 });
  assert.deepEqual(c.push("短"), []);
  assert.deepEqual(c.push("文"), []);
  assert.deepEqual(c.flush(), ["短文"], "结束把未达阈值的缓冲吐出（不丢文本）");
  assert.equal(c.started, true);
  assert.deepEqual(c.flush(), []);
});

test("minChars=0：首次即发（无缓冲）", () => {
  const c = createStreamChunker({ minChars: 0 });
  assert.deepEqual(c.push("a"), ["a"]);
  assert.deepEqual(c.push("bc"), ["bc"]);
});

test("仅超单条上限才硬切（正常路径不触发）", () => {
  const c = createStreamChunker({ minChars: 5, maxChars: 10 });
  // 一次送入 > 上限：按上限硬切为多块
  assert.deepEqual(c.push("a".repeat(25)), ["a".repeat(10), "a".repeat(10), "a".repeat(5)]);
  // 已开始后单块超上限同样硬切
  assert.deepEqual(c.push("b".repeat(12)), ["b".repeat(10), "b".repeat(2)]);
  // 默认上限 = MAX_CONTINUE_CHARS，普通文本不会触发硬切
  const big = createStreamChunker({ minChars: 5 });
  assert.deepEqual(big.push("x".repeat(100)), ["x".repeat(100)]);
  assert.equal(MAX_CONTINUE_CHARS, 20000);
});
