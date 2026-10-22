// 情绪标注工具单元测试（node --test）。测试对象为构建产物 dist/lib/*.js，
// 由 `npm test` 先执行 tsc 构建再运行。
//
// 手动符号解析（`!`/`?`/`...`/`666`）已移除，相关用例随代码一并删除（见 docs/设计-情绪输入插件.md）。

import test from "node:test";
import assert from "node:assert/strict";

import { trimAnnotationTail } from "../dist/lib/parser.js";
import { ARGUMENTS_PLACEHOLDER, commandTemplate, EMOTION_COMMANDS } from "../dist/lib/commands.js";

test("命令模板：固定情绪 + 等级，占位符为 $ARGUMENTS", () => {
  const byName = new Map(EMOTION_COMMANDS.map((c) => [c.name, c]));
  assert.equal(commandTemplate(byName.get("angry")), "😡(2/3) $ARGUMENTS");
  assert.equal(commandTemplate(byName.get("neutral")), "😐 $ARGUMENTS");
  assert.equal(commandTemplate(byName.get("great")), "🤩(3/3) $ARGUMENTS");
});

test("命令集：仅 9 个精准主命令，无别名", () => {
  assert.equal(EMOTION_COMMANDS.length, 9);
  assert.deepEqual(
    EMOTION_COMMANDS.map((c) => c.name),
    ["annoyed", "angry", "furious", "confused", "speechless", "neutral", "ok", "happy", "great"],
  );
  // 别名已从命令定义移除：任何条目都不应带 aliases 字段
  for (const command of EMOTION_COMMANDS) {
    assert.equal("aliases" in command, false, `命令 ${command.name} 不应带 aliases`);
  }
});

// 无参数命令：模板空参替换后残留尾部空格，钩子用 trimAnnotationTail 清理
test("trimAnnotationTail：全部命令空参后不留尾部空白", () => {
  for (const command of EMOTION_COMMANDS) {
    const raw = commandTemplate(command).replace(ARGUMENTS_PLACEHOLDER, "");
    const cleaned = trimAnnotationTail(raw);
    assert.equal(cleaned, cleaned.trimEnd(), `命令 ${command.name} 残留尾部空白`);
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
  const PLAIN = ["普通一句话 ", "好开心!", "😊 真开心  ", "  前导空格 内容 ", "😐😐 两个中性表情 ", "!!! 又崩了 "];
  for (const plain of PLAIN) {
    assert.equal(trimAnnotationTail(plain), plain, `输入 ${JSON.stringify(plain)}`);
  }
});
