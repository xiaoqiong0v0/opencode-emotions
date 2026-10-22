/**
 * 跨平台播放器选择逻辑的离线单测（不启动任何真实播放器）。
 *
 * 覆盖：候选/探测对齐 opencode-sound-notify —
 * Windows SoundPlayer（pwsh 优先）、macOS afplay、Linux /usr/bin/paplay→/usr/bin/aplay、
 * Termux play-audio（$PREFIX/bin 绝对路径 + -s <stream>、缺失提示 pkg install play-audio）、
 * `TTS_PLAYER` 覆盖、`TTS_STREAM` 默认 media、PATH 探测。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { commandExists, isTermux, selectPlayer, DEFAULT_TTS_STREAM } from "../dist/voice/tts/player.js";

const TERMUX_BIN = "/data/data/com.termux/files/usr/bin/play-audio";

test("selectPlayer：Windows 用 SoundPlayer，pwsh 优先、回退 powershell", () => {
  const both = selectPlayer({ platform: "win32", env: {}, isAvailable: () => true });
  assert.equal(both.id, "soundplayer");
  assert.equal(both.bin, "pwsh");

  const onlyWinPs = selectPlayer({ platform: "win32", env: {}, isAvailable: (bin) => bin === "powershell" });
  assert.equal(onlyWinPs.bin, "powershell");
  const cmd = onlyWinPs.launcher("C:\\tmp\\a.wav");
  assert.equal(cmd.bin, "powershell");
  assert.match(cmd.args.join(" "), /System\.Media\.SoundPlayer/);
  assert.equal(cmd.env.OC_TTS_WAV, "C:\\tmp\\a.wav", "WAV 路径经环境变量传入（无注入面）");
});

test("selectPlayer：macOS 用 afplay", () => {
  const selected = selectPlayer({ platform: "darwin", env: {}, isAvailable: () => true });
  assert.equal(selected.id, "afplay");
  assert.deepEqual(selected.launcher("/a.wav"), { bin: "afplay", args: ["/a.wav"] });
});

test("selectPlayer：Linux 按绝对路径探测 /usr/bin/paplay → /usr/bin/aplay", () => {
  const paplayFirst = selectPlayer({
    platform: "linux",
    env: {},
    isAvailable: (bin) => bin === "/usr/bin/paplay" || bin === "/usr/bin/aplay",
  });
  assert.equal(paplayFirst.id, "paplay", "paplay 在 aplay 之前");
  assert.deepEqual(paplayFirst.launcher("/a.wav"), { bin: "/usr/bin/paplay", args: ["/a.wav"] });

  const onlyAplay = selectPlayer({ platform: "linux", env: {}, isAvailable: (bin) => bin === "/usr/bin/aplay" });
  assert.equal(onlyAplay.id, "aplay");
  assert.equal(onlyAplay.bin, "/usr/bin/aplay");
  assert.deepEqual(onlyAplay.launcher("/a.wav"), { bin: "/usr/bin/aplay", args: ["/a.wav"] });
});

test("isTermux：TERMUX_VERSION / PREFIX 判定", () => {
  assert.equal(isTermux({ TERMUX_VERSION: "0.118.0" }), true);
  assert.equal(isTermux({ PREFIX: "/data/data/com.termux/files/usr" }), true);
  assert.equal(isTermux({}), false);
  assert.equal(isTermux({ PREFIX: "/usr" }), false);
});

test("selectPlayer：Termux 用 play-audio（$PREFIX/bin 绝对路径 + -s media）", () => {
  assert.equal(DEFAULT_TTS_STREAM, "media");
  const selected = selectPlayer({
    platform: "linux",
    env: { TERMUX_VERSION: "0.118" },
    isAvailable: (bin) => bin === TERMUX_BIN,
  });
  assert.equal(selected.id, "play-audio");
  assert.equal(selected.bin, TERMUX_BIN);
  assert.deepEqual(selected.launcher("/t/a.wav"), { bin: TERMUX_BIN, args: ["-s", "media", "/t/a.wav"] });
});

test("selectPlayer：Termux 平台为 android 也走 play-audio（默认前缀）", () => {
  const selected = selectPlayer({ platform: "android", env: {}, isAvailable: () => true });
  assert.equal(selected.id, "play-audio");
  assert.equal(selected.bin, TERMUX_BIN);
});

test("selectPlayer：Termux 自定义 PREFIX 与 TTS_STREAM 音频流", () => {
  const custom = selectPlayer({
    platform: "linux",
    env: { PREFIX: "/data/data/com.termux/files/usr", TTS_STREAM: "alarm" },
    isAvailable: () => true,
  });
  assert.equal(custom.id, "play-audio");
  assert.deepEqual(custom.launcher("/t/a.wav"), { bin: TERMUX_BIN, args: ["-s", "alarm", "/t/a.wav"] });
});

test("selectPlayer：Termux 缺 play-audio 时报错提示 pkg install play-audio", () => {
  assert.throws(
    () => selectPlayer({ platform: "linux", env: { TERMUX_VERSION: "0.118" }, isAvailable: () => false }),
    /pkg install play-audio/,
  );
});

test("selectPlayer：TTS_PLAYER 显式覆盖（已知 id / play-audio / 任意命令）", () => {
  const known = selectPlayer({ platform: "linux", env: { TTS_PLAYER: "paplay" }, isAvailable: () => true });
  assert.equal(known.id, "paplay");
  assert.equal(known.bin, "/usr/bin/paplay");

  const playAudio = selectPlayer({
    platform: "linux",
    env: { TTS_PLAYER: "play-audio", PREFIX: "/data/data/com.termux/files/usr" },
    isAvailable: () => true,
  });
  assert.equal(playAudio.id, "play-audio");
  assert.deepEqual(playAudio.launcher("/a.wav").args, ["-s", "media", "/a.wav"]);

  const custom = selectPlayer({
    platform: "win32",
    env: { TTS_PLAYER: "myplayer" },
    isAvailable: (bin) => bin === "myplayer",
  });
  assert.equal(custom.id, "myplayer");
  assert.deepEqual(custom.launcher("/a.wav"), { bin: "myplayer", args: ["/a.wav"] });
});

test("selectPlayer：无可用播放器时报清晰错误（含候选、安装提示与 TTS_PLAYER/TTS_STREAM）", () => {
  try {
    selectPlayer({ platform: "linux", env: {}, isAvailable: () => false });
    assert.fail("应当抛错");
  } catch (err) {
    assert.match(err.message, /未找到可用的音频播放器/);
    assert.match(err.message, /paplay/);
    assert.match(err.message, /aplay/);
    assert.match(err.message, /TTS_PLAYER/);
    assert.match(err.message, /TTS_STREAM/);
  }
});

test("commandExists：按 PATH 探测可执行文件", () => {
  const dir = mkdtempSync(join(tmpdir(), "player-path-"));
  try {
    writeFileSync(join(dir, "fakeplay"), "", "utf8");
    const env = { PATH: dir };
    assert.equal(commandExists("fakeplay", env, "linux"), true);
    assert.equal(commandExists("nope-not-here", env, "linux"), false);
    assert.equal(commandExists(join(dir, "fakeplay"), env, "linux"), true, "绝对路径直接判定");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
