/**
 * Termux TTS provider 的离线单测（不启动 termux-tts-speak）。
 *
 * 覆盖：语速映射、`termux-tts-speak` 参数拼装（官方 -h 选项 + TTS_TERMUX_* 覆盖）、
 * provider 可用性错误路径（非 Termux / 缺 termux-api）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ENV_TERMUX_ENGINE,
  ENV_TERMUX_LANGUAGE,
  ENV_TERMUX_REGION,
  ENV_TERMUX_STREAM,
  ENV_TERMUX_VARIANT,
  TERMUX_RATE_MAX,
  TERMUX_RATE_MIN,
  TERMUX_TTS_BIN,
  TermuxProvider,
  buildTermuxTtsArgs,
  mapTermuxRate,
} from "../dist/voice/tts/termux.js";

/** 完整的 ResolvedTtsOptions（provider 入参契约）。 */
function fullOptions(overrides = {}) {
  return {
    text: "你好",
    voice: "",
    rate: 0,
    instruction: "",
    pitch: 0,
    volume: 0,
    format: "",
    sampleRate: 0,
    model: "",
    ...overrides,
  };
}

test("mapTermuxRate：0/非法不下发，SAPI [-10,10] 映射到 [0.5,2]", () => {
  assert.equal(mapTermuxRate(0), null);
  assert.equal(mapTermuxRate(Number.NaN), null);
  assert.equal(mapTermuxRate(5), 1.5);
  assert.equal(mapTermuxRate(-5), 0.5);
  assert.equal(mapTermuxRate(10), TERMUX_RATE_MAX);
  assert.equal(mapTermuxRate(-10), TERMUX_RATE_MIN);
});

test("buildTermuxTtsArgs：默认只发正文，正文为最后一个位置参数", () => {
  assert.deepEqual(buildTermuxTtsArgs(fullOptions(), {}), ["你好"]);
});

test("buildTermuxTtsArgs：语速映射到 -r，TTS_TERMUX_* 覆盖各选项", () => {
  const args = buildTermuxTtsArgs(fullOptions({ text: "hi", rate: 5 }), {
    [ENV_TERMUX_ENGINE]: "com.example.tts",
    [ENV_TERMUX_LANGUAGE]: "zh",
    [ENV_TERMUX_REGION]: "CN",
    [ENV_TERMUX_VARIANT]: "v1",
    [ENV_TERMUX_STREAM]: "MUSIC",
  });
  assert.deepEqual(args, [
    "-e",
    "com.example.tts",
    "-l",
    "zh",
    "-n",
    "CN",
    "-v",
    "v1",
    "-r",
    "1.5",
    "-s",
    "MUSIC",
    "hi",
  ]);
  assert.equal(args[args.length - 1], "hi", "正文始终在最后");
});

test("buildTermuxTtsArgs：空白环境变量不产生空参数", () => {
  const args = buildTermuxTtsArgs(fullOptions({ rate: 0 }), { [ENV_TERMUX_LANGUAGE]: "   " });
  assert.deepEqual(args, ["你好"]);
});

test("TermuxProvider：非 Termux 环境抛清晰错误（不 spawn）", () => {
  const provider = new TermuxProvider({ env: {}, platform: "win32", isAvailable: () => false });
  assert.throws(() => provider.speak(fullOptions()), /仅在 Termux/);
});

test("TermuxProvider：Termux 环境但缺命令 → 提示 pkg install termux-api", () => {
  const provider = new TermuxProvider({
    env: { TERMUX_VERSION: "0.118" },
    platform: "linux",
    isAvailable: () => false,
  });
  try {
    provider.speak(fullOptions());
    assert.fail("应当抛错");
  } catch (err) {
    assert.match(err.message, /pkg install termux-api/);
    assert.match(err.message, new RegExp(TERMUX_TTS_BIN));
  }
});

test("TermuxProvider：空文本抛错", () => {
  const provider = new TermuxProvider({
    env: { TERMUX_VERSION: "0.118" },
    platform: "linux",
    isAvailable: () => true,
  });
  assert.throws(() => provider.speak(fullOptions({ text: "   " })), /text 不能为空/);
  assert.doesNotThrow(() => provider.stop());
});
