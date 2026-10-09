// 符号解析器单元测试（node --test）。测试对象为构建产物 dist/lib/*.js，
// 由 `npm test` 先执行 tsc 构建再运行。

import test from "node:test";
import assert from "node:assert/strict";

import { parseEmotion, rewriteEmotion, trimAnnotationTail } from "../dist/lib/parser.js";
import { ARGUMENTS_PLACEHOLDER, commandTemplate, EMOTION_COMMANDS } from "../dist/lib/commands.js";

// rewriteEmotion 表格用例：[输入, 期望输出]
const REWRITE_CASES = [
  // 开头符号（含文档示例）
  ["！！！测试", "🤬(3/3) 测试"],
  ["!!! 又崩了", "🤬(3/3) 又崩了"],
  ["？？？ 这是啥", "😵(3/3) 这是啥"],
  ["... 算了", "😐(1/3) 算了"],
  ["...算了", "😐(1/3) 算了"],
  ["..... 服了", "😮💨(3/3) 服了"],
  // 无语族全角句号 `。`（与半角 `.` 等价，按个数分档）
  ["。。。算了", "😐(1/3) 算了"],
  ["。。。。算了", "😑(2/3) 算了"],
  ["。。。。。算了", "😮💨(3/3) 算了"],
  ["666 这版真不错", "🙂(1/3) 这版真不错"],
  ["666666 太强了", "🤩(3/3) 太强了"],
  // 结尾符号（不强制前置空格）
  ["又崩了 !!!", "🤬(3/3) 又崩了"],
  ["崩溃了！！！", "🤬(3/3) 崩溃了"],
  ["好开心！！", "😡(2/3) 好开心"],
  ["这是个测试??", "🤔(2/3) 这是个测试"],
  ["太强了666", "🙂(1/3) 太强了"],
  // 只发符号 → 正文即标注
  ["!!!", "🤬(3/3)"],
  ["666", "🙂(1/3)"],
  ["...", "😐(1/3)"],
  // 等级换算（封顶 3）
  ["!!", "😡(2/3)"],
  ["!!!!", "🤬(3/3)"],
  ["6666", "😊(2/3)"],
  ["66666", "🤩(3/3)"],
  ["6666666", "🤩(3/3)"],
  ["....", "😑(2/3)"],
  // 全角/半角
  ["！", "😠(1/3)"],
  ["？？", "🤔(2/3)"],
  // 首尾同时出现 → 取开头
  ["!!! 正文 ???", "🤬(3/3) 正文 ???"],
];

// 应保持原文（返回 null）的用例
const NO_MATCH_CASES = [
  "好开心！", // 结尾单个不认
  "这是一个测试?", // 结尾单个不认
  "666元", // 数字类后非空白
  "666折",
  "66", // 不足最少个数
  "!? 测试", // 混写
  "!?",
  "这是 !!! 测试", // 正文中间符号
  "hello !!! world",
  "123666", // 数字类前置数字
  "…… 无语", // 全角省略号不识别
  "…… 算了", // 全角省略号不识别（保持原文）
  "…", // 单个全角省略号不识别
  "算了……", // 结尾全角省略号不识别
  "。", // 单个全角句号不识别（无语族最少 3 个）
  "这是一个测试。", // 结尾单个全角句号不识别
  "普通一句话",
  "",
];

test("rewriteEmotion：符号解析与标注改写", () => {
  for (const [input, expected] of REWRITE_CASES) {
    assert.equal(rewriteEmotion(input), expected, `输入 ${JSON.stringify(input)}`);
  }
});

test("rewriteEmotion：不误判 / 不命中时返回 null", () => {
  for (const input of NO_MATCH_CASES) {
    assert.equal(rewriteEmotion(input), null, `输入 ${JSON.stringify(input)}`);
  }
});

test("幂等：已带标注的文本二次处理不再命中", () => {
  const once = rewriteEmotion("!!! 测试");
  assert.equal(once, "🤬(3/3) 测试");
  assert.equal(rewriteEmotion(once), null);
  assert.equal(rewriteEmotion("😐"), null);
  assert.equal(rewriteEmotion("😡(2/3) 需求又改了"), null);
});

test("parseEmotion：给出情绪与正文", () => {
  assert.deepEqual(parseEmotion("！！！测试"), { emotion: { family: "anger", level: 3 }, body: "测试" });
  assert.deepEqual(parseEmotion("崩溃了！！！"), { emotion: { family: "anger", level: 3 }, body: "崩溃了" });
});

test("命令模板：固定情绪 + 等级，占位符为 $ARGUMENTS", () => {
  const byName = new Map(EMOTION_COMMANDS.map((c) => [c.name, c]));
  assert.equal(commandTemplate(byName.get("angry")), "😡(2/3) $ARGUMENTS");
  assert.equal(commandTemplate(byName.get("neutral")), "😐 $ARGUMENTS");
  assert.equal(commandTemplate(byName.get("great")), "🤩(3/3) $ARGUMENTS");
  assert.equal(EMOTION_COMMANDS.length, 9);
});

// 无参数命令：模板空参替换后残留尾部空格，钩子用 trimAnnotationTail 清理
test("trimAnnotationTail：全部命令空参后不留尾部空白，且不被二次改写", () => {
  for (const command of EMOTION_COMMANDS) {
    const raw = commandTemplate(command).replace(ARGUMENTS_PLACEHOLDER, "");
    const cleaned = trimAnnotationTail(raw);
    assert.equal(cleaned, cleaned.trimEnd(), `命令 ${command.name} 残留尾部空白`);
    assert.equal(rewriteEmotion(cleaned), null, `命令 ${command.name} 清理后被二次改写`);
  }
});

test("trimAnnotationTail：只清理标注开头文本，不动普通消息", () => {
  // 标注文本：尾部空白去掉
  assert.equal(trimAnnotationTail("😊(2/3) "), "😊(2/3)");
  assert.equal(trimAnnotationTail("😐 "), "😐");
  assert.equal(trimAnnotationTail("😐\t \n"), "😐");
  // 带参数的命令产出：正文完整保留
  assert.equal(trimAnnotationTail("😊(2/3) 测试通过"), "😊(2/3) 测试通过");
  // 普通用户消息原样返回（含尾部空格也不动）
  const PLAIN = ["普通一句话 ", "好开心!", "😊 真开心  ", "  前导空格 内容 ", "😐😐 两个中性表情 "];
  for (const plain of PLAIN) {
    assert.equal(trimAnnotationTail(plain), plain, `输入 ${JSON.stringify(plain)}`);
  }
});
