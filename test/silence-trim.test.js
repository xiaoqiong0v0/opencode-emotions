/**
 * TTS 首尾静音裁剪单测（2026-10-22 第十三批修法 1）。
 *
 * 覆盖：①前静音+语声+尾静音 → 前后被裁（保留尾部保护余量）；②无静音不变；
 * ③全静音不裁空；④阈值边缘不误裁（刚好高 1 个量化级）；⑤分块边界（静音跨多块/奇数块）；
 * ⑥字节对齐；⑦真实 StreamSink 播放路径（假播放器统计 stdin 字节数）；
 * ⑧分段回退路径每句独立裁剪。
 *
 * 修复前如何红：`audio-sink.ts` 里根本没有裁剪（首尾静音原样写播放器），
 * `silence-trim.ts` 也不存在 ⇒ 本文件全部用例在修复前 red（导入即失败）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SilenceTrimmer,
  TTS_TRIM_LEADING_HOLD_MAX_MS,
  TTS_TRIM_TAIL_GUARD_MS,
  TTS_TRIM_THRESHOLD_DBFS,
} from "../dist/voice/tts/silence-trim.js";
import { createAudioSink, WAV_HEADER_BYTES } from "../dist/voice/tts/audio-sink.js";

/** 测试采样率（与 MiMo/分段回退一致的口径量级）。 */
const SAMPLE_RATE = 24000;
/** 16bit 单声道每毫秒字节数。 */
const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000;
/** 语声幅度（≈ -12 dBFS，远高于门限）。 */
const TONE_AMPLITUDE = 8000;
/** 单帧（10ms）时长误差容忍：±2 帧。 */
const TOLERANCE_MS = 20;

/** 记录日志的假 logger。 */
function stubLogger() {
  return { loaded() {}, info() {}, warn() {}, error() {}, hook() {}, tool() {} };
}

/**
 * 生成静音 PCM（全 0）。
 * @param {number} ms 时长（毫秒）
 * @returns {Buffer} s16le 字节
 */
function silencePcmMs(ms) {
  return Buffer.alloc(Math.round((ms * SAMPLE_RATE) / 1000) * 2);
}

/**
 * 生成方波语声 PCM（±幅值交替，RMS≈幅值/32768）。
 * @param {number} ms 时长（毫秒）
 * @param {number} amplitude 幅值（0~32767）
 * @returns {Buffer} s16le 字节
 */
function tonePcmMs(ms, amplitude = TONE_AMPLITUDE) {
  const samples = Math.round((ms * SAMPLE_RATE) / 1000);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) buf.writeInt16LE(i % 2 === 0 ? amplitude : -amplitude, i * 2);
  return buf;
}

/**
 * 生成直流 PCM（恒定幅值，帧 RMS=幅值/32768，用于阈值边缘用例）。
 * @param {number} ms 时长（毫秒）
 * @param {number} amplitude 幅值
 * @returns {Buffer} s16le 字节
 */
function dcPcmMs(ms, amplitude) {
  const samples = Math.round((ms * SAMPLE_RATE) / 1000);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) buf.writeInt16LE(amplitude, i * 2);
  return buf;
}

/**
 * 按给定块大小把 PCM 切成多块（用于验证「分块边界不影响判定」）。
 * @param {Buffer} pcm 完整 PCM
 * @param {number} chunkBytes 每块字节数（可为奇数）
 * @returns {Buffer[]} 分块
 */
function splitPcm(pcm, chunkBytes) {
  const chunks = [];
  for (let offset = 0; offset < pcm.length; offset += chunkBytes) {
    chunks.push(pcm.subarray(offset, Math.min(offset + chunkBytes, pcm.length)));
  }
  return chunks;
}

/**
 * 用裁剪器处理一组块并取最终字节。
 * @param {Buffer[]} chunks 输入块
 * @param {object} [options] 裁剪参数
 * @returns {{ output: Buffer, stats: object }} 放行字节与统计
 */
function runTrimmer(chunks, options = {}) {
  const trimmer = new SilenceTrimmer(SAMPLE_RATE, options);
  const out = [];
  for (const chunk of chunks) {
    const trimmed = trimmer.push(chunk);
    if (trimmed.length > 0) out.push(trimmed);
  }
  const tail = trimmer.finish();
  if (tail.length > 0) out.push(tail);
  return { output: Buffer.concat(out), stats: trimmer.getStats() };
}

/**
 * 断言毫秒值接近期望（±TOLERANCE_MS）。
 * @param {number} actual 实际值
 * @param {number} expected 期望值
 * @param {string} message 断言说明
 */
function assertMs(actual, expected, message) {
  assert.ok(
    Math.abs(actual - expected) <= TOLERANCE_MS,
    `${message}（实际 ${actual.toFixed(1)}ms，期望 ${expected}ms ±${TOLERANCE_MS}ms）`,
  );
}

test("① 前静音 500ms + 语声 1000ms + 尾静音 600ms：前后被裁、尾部保留保护余量", () => {
  const input = [silencePcmMs(500), tonePcmMs(1000), silencePcmMs(600)];
  const { output, stats } = runTrimmer(input);
  assertMs(stats.leadingTrimmedMs, 500, "首部静音应被裁掉");
  assertMs(stats.trailingTrimmedMs, 600 - TTS_TRIM_TAIL_GUARD_MS, "尾部只保留保护余量");
  assertMs(stats.emittedMs, 1000 + TTS_TRIM_TAIL_GUARD_MS, "放行时长 = 语声 + 保护余量");
  assert.equal(output.length % 2, 0, "16bit 对齐");
});

test("② 无静音流：字节完全不变（不误裁语声）", () => {
  const pcm = tonePcmMs(800);
  const { output, stats } = runTrimmer([pcm]);
  assert.ok(output.equals(pcm), "无静音时输出必须与输入逐字节相同");
  assert.equal(stats.leadingTrimmedMs, 0);
  assert.equal(stats.trailingTrimmedMs, 0);
  assertMs(stats.emittedMs, 800, "放行时长 = 输入时长");
});

test("③ 全静音流：不裁空（原样放行）", () => {
  const pcm = silencePcmMs(1000);
  const { output, stats } = runTrimmer([pcm]);
  assert.equal(output.length, pcm.length, "全静音必须原样保留（避免以为播了其实没声）");
  assert.ok(output.equals(pcm));
  assert.equal(stats.emittedMs, stats.inputMs);
});

test("③b 全静音超首部暂存上限：仍原样保留（放弃裁剪后不丢字节）", () => {
  const pcm = silencePcmMs(TTS_TRIM_LEADING_HOLD_MAX_MS + 500);
  const { output } = runTrimmer([pcm]);
  assert.equal(output.length, pcm.length, "超上限也只在内存里放行，不丢字节");
});

test("④ 阈值边缘：刚好高 1 个量化级不误裁，低 1 个量化级按静音处理", () => {
  const thresholdAmplitude = Math.ceil(32768 * Math.pow(10, TTS_TRIM_THRESHOLD_DBFS / 20));
  const above = [silencePcmMs(200), dcPcmMs(100, thresholdAmplitude), tonePcmMs(300)];
  const aboveResult = runTrimmer(above);
  assertMs(aboveResult.stats.leadingTrimmedMs, 200, "门限之上的弱信号不得被裁");

  const below = [silencePcmMs(200), dcPcmMs(100, thresholdAmplitude - 1), tonePcmMs(300)];
  const belowResult = runTrimmer(below);
  assertMs(belowResult.stats.leadingTrimmedMs, 300, "门限之下的静音（含弱底噪）按静音裁掉");
});

test("⑤ 分块边界：静音跨多块 / 奇数块，结果与单块完全一致", () => {
  const input = Buffer.concat([silencePcmMs(500), tonePcmMs(1000), silencePcmMs(600)]);
  const single = runTrimmer([input]);
  const chunked = runTrimmer(splitPcm(input, 7 * 2 + 1)); // 奇数块（15 字节），跨帧、跨静音段
  const chunkedLarge = runTrimmer(splitPcm(input, 333));
  assert.ok(chunked.output.equals(single.output), "小奇数块与单块结果必须一致");
  assert.ok(chunkedLarge.output.equals(single.output), "不规则块与单块结果必须一致");
  assert.equal(chunked.stats.leadingTrimmedMs, single.stats.leadingTrimmedMs);
  assert.equal(chunked.stats.trailingTrimmedMs, single.stats.trailingTrimmedMs);
});

test("⑥ 字节对齐：奇数长度输入末尾不丢字节、输出保持 16bit 对齐", () => {
  const pcm = Buffer.concat([tonePcmMs(100), Buffer.from([0x7f])]); // 人为奇数尾字节
  const { output } = runTrimmer([pcm]);
  assert.equal(output.length % 2, 0, "输出必须是完整采样点（裁剪按 2 字节对齐）");
  assert.equal(output.length, pcm.length - 1, "偶数部分原样放行，奇数尾字节丢弃（不切断采样点）");
});

test("⑦ 真实 StreamSink 播放路径：写入播放器 stdin 的字节数 = 裁剪后字节数", async () => {
  const dir = mkdtempSync(join(tmpdir(), "silence-trim-sink-"));
  const countFile = join(dir, "bytes.txt");
  try {
    // 假流式播放器：读完 stdin 后把收到的字节数写入文件（不发声）
    const script = `let n=0;process.stdin.on("data",(c)=>{n+=c.length});process.stdin.on("end",()=>{require("node:fs").writeFileSync(${JSON.stringify(countFile)},String(n))})`;
    const player = { id: "fake", launcher: () => ({ bin: process.execPath, args: ["-e", script] }) };
    const sink = createAudioSink({ kind: "stream", player }, SAMPLE_RATE, stubLogger());
    const input = Buffer.concat([silencePcmMs(500), tonePcmMs(1000), silencePcmMs(600)]);
    for (const chunk of splitPcm(input, 1600)) sink.write(chunk);
    await sink.end();
    const written = Number(readFileSync(countFile, "utf8"));
    const stats = sink.trimStats();
    assert.equal(written, input.length - 500 * BYTES_PER_MS - (600 - TTS_TRIM_TAIL_GUARD_MS) * BYTES_PER_MS);
    assertMs(stats.leadingTrimmedMs, 500, "流式路径统计：首部裁剪");
    assertMs(stats.trailingTrimmedMs, 500, "流式路径统计：尾部裁剪");
    assertMs(stats.emittedMs, 1100, "流式路径统计：放行时长");
    assert.ok(stats.inputMs > stats.emittedMs, "放行必须短于输入（确有裁剪）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("⑧ 分段回退路径：每句独立裁剪（段边界 = 句边界，静音不跨句携带）", async () => {
  const seen = [];
  const player = {
    id: "fake",
    bin: process.execPath,
    launcher: (file) => {
      seen.push(statSync(file).size);
      return { bin: process.execPath, args: ["-e", "0"] };
    },
  };
  const sink = createAudioSink({ kind: "segments", player }, SAMPLE_RATE, stubLogger());
  // 两句：各 100ms 首静音 + 200ms 语声 + 300ms 尾静音
  sink.write(Buffer.concat([silencePcmMs(100), tonePcmMs(200), silencePcmMs(300)]));
  sink.boundary();
  sink.write(Buffer.concat([silencePcmMs(100), tonePcmMs(200), silencePcmMs(300)]));
  sink.boundary();
  await sink.end();
  const expectedPcm = 200 + TTS_TRIM_TAIL_GUARD_MS;
  assert.deepEqual(
    seen,
    [WAV_HEADER_BYTES + expectedPcm * BYTES_PER_MS, WAV_HEADER_BYTES + expectedPcm * BYTES_PER_MS],
    "每句都裁掉首静音与尾部多余静音",
  );
  const stats = sink.trimStats();
  assertMs(stats.leadingTrimmedMs, 200, "两句首静音各 100ms 都要计入总账");
  assertMs(stats.trailingTrimmedMs, 400, "两句尾静音各裁 (300-100)ms");
});
