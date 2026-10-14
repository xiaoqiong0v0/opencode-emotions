// NDJSON 契约（voice/ndjson）单元测试（node --test）。
// 测试对象为构建产物 dist/voice/ndjson.js，由 `npm test` 先执行 tsc 构建再运行；
// 覆盖 TUI 插件读取 voice-runtime `--json` stdout 的同一条解析路径（encode → 分片 → 行重组 → parse）。

import test from "node:test";
import assert from "node:assert/strict";

import { NdjsonLineSplitter, encodeEvent, parseEventLine } from "../dist/voice/ndjson.js";

test("encodeEvent / parseEventLine：四类事件往返一致", () => {
  const events = [
    { type: "ready", model: "qwen3-asr-flash-realtime" },
    { type: "final", text: "你好", emotion: "happy", annotation: "😊(2/3)" },
    { type: "error", message: "连接失败" },
    { type: "done" },
  ];
  for (const event of events) {
    const line = encodeEvent(event);
    assert.equal(line.endsWith("\n"), true, "每行以换行结尾");
    assert.deepEqual(parseEventLine(line), event, JSON.stringify(event));
  }
});

test("parseEventLine：缺省字段补齐与非法输入返回 null", () => {
  assert.deepEqual(parseEventLine('{"type":"final","text":"hi"}'), {
    type: "final",
    text: "hi",
    emotion: "",
    annotation: "",
  });
  assert.deepEqual(parseEventLine('{"type":"ready"}'), { type: "ready", model: "" });
  assert.deepEqual(parseEventLine('{"type":"error"}'), { type: "error", message: "未知错误" });

  const invalid = [
    "",
    "   ",
    "not json",
    "[]",
    "{}",
    "null",
    "123",
    '{"type":"unknown"}',
    '{"type":"final"}',
    '{"type":"final","text":""}',
  ];
  for (const line of invalid) assert.equal(parseEventLine(line), null, JSON.stringify(line));
});

test("NdjsonLineSplitter：跨分片半行重组（插件 stdout 读取路径）", () => {
  const splitter = new NdjsonLineSplitter();
  const stream =
    encodeEvent({ type: "ready", model: "m" }) +
    encodeEvent({ type: "final", text: "第一句", emotion: "sad", annotation: "😑(2/3)" }) +
    encodeEvent({ type: "final", text: "第二句", emotion: "", annotation: "" }) +
    encodeEvent({ type: "done" });

  // 按 7 个字符任意切分，模拟真实 stdout 的不规则分片
  const chunks = [];
  for (let i = 0; i < stream.length; i += 7) chunks.push(stream.slice(i, i + 7));
  const lines = [];
  for (const chunk of chunks) lines.push(...splitter.push(chunk));

  assert.equal(splitter.flush(), "", "完整流不应有残留");
  assert.deepEqual(lines.map(parseEventLine), [
    { type: "ready", model: "m" },
    { type: "final", text: "第一句", emotion: "sad", annotation: "😑(2/3)" },
    { type: "final", text: "第二句", emotion: "", annotation: "" },
    { type: "done" },
  ]);
});

test("NdjsonLineSplitter：CRLF 与末尾残留", () => {
  const splitter = new NdjsonLineSplitter();
  assert.deepEqual(splitter.push('{"type":"done"}\r\n'), ['{"type":"done"}']);
  assert.deepEqual(splitter.push('{"type":"final","text":"x"}'), []);
  assert.deepEqual(parseEventLine(splitter.flush()), {
    type: "final",
    text: "x",
    emotion: "",
    annotation: "",
  });
});
