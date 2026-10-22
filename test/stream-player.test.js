/**
 * 流式（stdin raw PCM）播放器选择的离线单测（不启动任何真实播放器）。
 *
 * 覆盖：各平台候选顺序（Linux aplay→paplay→sox→ffplay / Termux sox→ffplay / win ffplay）、
 * 参数拼装（S16_LE、采样率、`-` stdin）、`TTS_PLAYER` 覆盖与文件型播放器回退（返回 null）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  STREAM_PLAYER_IDS,
  WAVEOUT_SCRIPT,
  buildWaveOutScript,
  selectStreamPlayer,
} from "../dist/voice/tts/stream-player.js";

test("selectStreamPlayer：Linux 候选顺序 aplay → paplay → sox → ffplay", () => {
  const aplay = selectStreamPlayer({ sampleRate: 22050, platform: "linux", env: {}, isAvailable: (b) => b === "/usr/bin/aplay" });
  assert.equal(aplay.id, "aplay");
  const cmd = aplay.launcher();
  assert.equal(cmd.bin, "/usr/bin/aplay");
  assert.deepEqual(cmd.args, ["-q", "-f", "S16_LE", "-r", "22050", "-c", "1", "-t", "raw", "-"]);

  const paplay = selectStreamPlayer({ sampleRate: 16000, platform: "linux", env: {}, isAvailable: (b) => b === "/usr/bin/paplay" });
  assert.equal(paplay.id, "paplay");
  assert.deepEqual(paplay.launcher().args, ["--raw", "--format=s16le", "--rate=16000", "--channels=1"]);

  const sox = selectStreamPlayer({ sampleRate: 24000, platform: "linux", env: {}, isAvailable: (b) => b === "play" });
  assert.equal(sox.id, "sox-play");
  assert.deepEqual(sox.launcher().args, ["-q", "-t", "raw", "-b", "16", "-e", "signed", "-r", "24000", "-c", "1", "-"]);

  const ff = selectStreamPlayer({ sampleRate: 8000, platform: "linux", env: {}, isAvailable: (b) => b === "ffplay" });
  assert.equal(ff.id, "ffplay");
  assert.ok(ff.launcher().args.includes("-autoexit"));
});

test("selectStreamPlayer：Termux 先 sox 再 ffplay；都不在则 null", () => {
  const sox = selectStreamPlayer({
    sampleRate: 22050,
    platform: "android",
    env: {},
    isAvailable: () => true,
  });
  assert.equal(sox.id, "sox-play");
  assert.equal(
    selectStreamPlayer({ sampleRate: 22050, platform: "linux", env: { TERMUX_VERSION: "0.118" }, isAvailable: () => false }),
    null,
  );
});

test("selectStreamPlayer：Windows 首选内置 waveOut；无 pwsh/ffplay 则 null（交给分段回退）", () => {
  const builtin = selectStreamPlayer({ sampleRate: 22050, platform: "win32", env: {}, isAvailable: () => true });
  assert.equal(builtin.id, "waveout");
  assert.equal(builtin.bin, "pwsh", "pwsh 优先");
  const cmd = builtin.launcher();
  assert.equal(cmd.bin, "pwsh");
  assert.deepEqual(cmd.args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
  assert.match(cmd.args[3], /waveOutOpen/, "内联 C# 调 winmm");
  assert.match(cmd.args[3], /WaveOutRaw/);
  assert.match(cmd.args[3], /Play\(22050, 1\)/, "采样率/声道内联进脚本");

  // 仅 ffplay 可用时回退 ffplay
  const ff = selectStreamPlayer({ sampleRate: 22050, platform: "win32", env: {}, isAvailable: (b) => b === "ffplay" });
  assert.equal(ff.id, "ffplay");
  assert.equal(selectStreamPlayer({ sampleRate: 22050, platform: "win32", env: {}, isAvailable: () => false }), null);

  // powershell 回退
  const ps = selectStreamPlayer({ sampleRate: 16000, platform: "win32", env: {}, isAvailable: (b) => b === "powershell" });
  assert.equal(ps.id, "waveout");
  assert.equal(ps.bin, "powershell");
});

test("WAVEOUT_SCRIPT / buildWaveOutScript：waveOut P/Invoke、stdin 读取、Reset+Close 收尾", () => {
  assert.match(WAVEOUT_SCRIPT, /waveOutPrepareHeader/);
  assert.match(WAVEOUT_SCRIPT, /waveOutWrite/);
  assert.match(WAVEOUT_SCRIPT, /waveOutReset/);
  assert.match(WAVEOUT_SCRIPT, /waveOutClose/);
  assert.match(WAVEOUT_SCRIPT, /Console\.OpenStandardInput/);
  assert.match(buildWaveOutScript(8000, 2), /Play\(8000, 2\)$/);
  // 预读缓冲压到 ~160ms（40ms/块 × 4 块），消「CLI 被杀后孙进程把已排队音频播完」的长尾音；
  // 旧值 16384B×8（≈2.7s@24kHz）不得回归
  assert.match(WAVEOUT_SCRIPT, /int maxPending = 4;/, "队列深度 4 块");
  assert.match(WAVEOUT_SCRIPT, /\* 40 \/ 1000;/, "块大小按时长 40ms 计算");
  assert.doesNotMatch(WAVEOUT_SCRIPT, /MAX_PENDING = 8|16384/, "旧深队列常量已移除");
});

test("selectStreamPlayer：TTS_PLAYER 只对已知流式 id 生效，文件型播放器返回 null", () => {
  const forced = selectStreamPlayer({ sampleRate: 22050, platform: "win32", env: { TTS_PLAYER: "aplay" }, isAvailable: () => true });
  assert.equal(forced.id, "aplay");

  const alias = selectStreamPlayer({ sampleRate: 22050, platform: "linux", env: { TTS_PLAYER: "sox" }, isAvailable: () => true });
  assert.equal(alias.id, "sox-play");

  // 内置 waveOut 显式覆盖（别名 winmm）
  const waveout = selectStreamPlayer({ sampleRate: 22050, platform: "win32", env: { TTS_PLAYER: "waveout" }, isAvailable: () => true });
  assert.equal(waveout.id, "waveout");
  const winmm = selectStreamPlayer({ sampleRate: 22050, platform: "win32", env: { TTS_PLAYER: "winmm" }, isAvailable: () => true });
  assert.equal(winmm.id, "waveout");

  // play-audio 只能放文件，不能流式 → 返回 null（由 audio-sink 回退分段）
  assert.equal(
    selectStreamPlayer({ sampleRate: 22050, platform: "linux", env: { TTS_PLAYER: "play-audio" }, isAvailable: () => true }),
    null,
  );
});

test("STREAM_PLAYER_IDS：包含全部已知流式 id（含内置 waveout）", () => {
  assert.deepEqual([...STREAM_PLAYER_IDS], ["waveout", "aplay", "paplay", "sox-play", "ffplay"]);
});
