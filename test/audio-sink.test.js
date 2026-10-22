/**
 * 音频落地策略与 WAV 头构造的离线单测（不启动任何真实播放器）。
 *
 * 覆盖：WAV 头字段、流式优先、分段回退（注入文件播放器）、两条路径都不可用时抛清晰错误。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { statSync } from "node:fs";

import { buildWavHeader, createAudioSink, selectAudioStrategy, WAV_HEADER_BYTES } from "../dist/voice/tts/audio-sink.js";

/** 记录日志的假 logger。 */
function stubLogger() {
  return { loaded() {}, info() {}, warn() {}, error() {}, hook() {}, tool() {} };
}

test("buildWavHeader：44 字节标准 PCM 头，长度/采样率/字节率正确", () => {
  const header = buildWavHeader(1000, 22050, 1, 16);
  assert.equal(header.length, WAV_HEADER_BYTES);
  assert.equal(header.toString("ascii", 0, 4), "RIFF");
  assert.equal(header.toString("ascii", 8, 12), "WAVE");
  assert.equal(header.toString("ascii", 36, 40), "data");
  assert.equal(header.readUInt32LE(4), 36 + 1000, "RIFF 总长 = 36 + data");
  assert.equal(header.readUInt32LE(24), 22050, "采样率");
  assert.equal(header.readUInt32LE(28), 22050 * 2, "字节率 = sr * 块对齐");
  assert.equal(header.readUInt32LE(40), 1000, "data 长度");
});

test("selectAudioStrategy：优先流式", () => {
  const strategy = selectAudioStrategy({ sampleRate: 22050, platform: "linux", env: {}, isAvailable: (b) => b === "/usr/bin/aplay" });
  assert.equal(strategy.kind, "stream");
  assert.equal(strategy.player.id, "aplay");
});

test("selectAudioStrategy：无流式播放器时回退分段（文件播放器）", () => {
  const filePlayer = { id: "soundplayer", bin: "pwsh", launcher: () => ({ bin: "pwsh", args: [] }) };
  const strategy = selectAudioStrategy({
    sampleRate: 22050,
    platform: "win32",
    env: {},
    isAvailable: () => false,
    filePlayer,
  });
  assert.equal(strategy.kind, "segments");
  assert.equal(strategy.player.id, "soundplayer");
});

test("selectAudioStrategy：两条路径都不可用时抛清晰错误", () => {
  assert.throws(
    () => selectAudioStrategy({ sampleRate: 22050, platform: "win32", env: {}, isAvailable: () => false }),
    /未找到可用的音频播放路径/,
  );
});

test("SegmentedSink：段边界=句边界（boundary 触发落段，一段一个 WAV）", async () => {
  const seen = [];
  const player = {
    id: "fake",
    bin: process.execPath,
    launcher: (file) => {
      seen.push(statSync(file).size);
      return { bin: process.execPath, args: ["-e", "0"] };
    },
  };
  const sink = createAudioSink({ kind: "segments", player }, 22050, stubLogger());
  assert.equal(sink.kind, "segments");
  // 三句：句末各调一次 boundary
  sink.write(Buffer.alloc(100));
  sink.boundary();
  sink.write(Buffer.alloc(50));
  sink.boundary();
  sink.write(Buffer.alloc(30));
  await sink.end();
  // 每段 = 44 字节 WAV 头 + 该句 PCM
  assert.deepEqual(seen, [WAV_HEADER_BYTES + 100, WAV_HEADER_BYTES + 50, WAV_HEADER_BYTES + 30]);
});

test("SegmentedSink：空缓冲 boundary 不产生空段", async () => {
  const seen = [];
  const player = {
    id: "fake",
    bin: process.execPath,
    launcher: (file) => {
      seen.push(statSync(file).size);
      return { bin: process.execPath, args: ["-e", "0"] };
    },
  };
  const sink = createAudioSink({ kind: "segments", player }, 22050, stubLogger());
  sink.boundary();
  sink.write(Buffer.alloc(20));
  sink.boundary();
  await sink.end();
  assert.deepEqual(seen, [WAV_HEADER_BYTES + 20]);
});
