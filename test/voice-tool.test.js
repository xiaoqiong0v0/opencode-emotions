/**
 * `emotions_cli` 工具「F10 开启时拦截模型 speak」判定单测（纯函数，零 IO、不 exec 任何进程）。
 *
 * 覆盖（2026-10-22）：只拦以 `speak` 开头（词边界）的参数串——含 `--follow`/`--background` 变体；
 * `help`/`devices`/`status` 等非 speak 子命令不拦；`speaky` 这类**无词边界**前缀不拦；
 * 开关为关时一切不拦（拦截条件 = speak ∧ autoReadEnabled）。
 * 状态读取与文案取词在 execute 接线层（tool.ts，读每会话状态文件 + safePhrases 现取），
 * 本文件只验证判定纯函数 `shouldInterceptSpeakForAutoRead` 的口径。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { shouldInterceptSpeakForAutoRead } from "../dist/voice/tool.js";

test("shouldInterceptSpeakForAutoRead：speak 系（含 --follow/--background）+ 开关开 → 拦", () => {
  assert.equal(shouldInterceptSpeakForAutoRead("speak --text \"你好\"", true), true);
  assert.equal(shouldInterceptSpeakForAutoRead("speak", true), true);
  assert.equal(shouldInterceptSpeakForAutoRead("speak --follow --provider sapi", true), true);
  assert.equal(shouldInterceptSpeakForAutoRead("speak --text hi --background", true), true);
});

test("shouldInterceptSpeakForAutoRead：开关关 → 一切不拦", () => {
  assert.equal(shouldInterceptSpeakForAutoRead("speak --text \"你好\"", false), false);
});

test("shouldInterceptSpeakForAutoRead：非 speak 子命令不拦（help/devices/status/空）", () => {
  for (const args of ["help", "devices", "status", "", "speakx --text a"]) {
    assert.equal(shouldInterceptSpeakForAutoRead(args, true), false, `不拦：${JSON.stringify(args)}`);
  }
});

test("shouldInterceptSpeakForAutoRead：词边界——`speaky` 前缀不误拦；只认串首 speak", () => {
  assert.equal(shouldInterceptSpeakForAutoRead("speaky --text a", true), false, "speaky 无词边界不拦");
  assert.equal(shouldInterceptSpeakForAutoRead("help speak", true), false, "speak 不在串首不拦");
});
