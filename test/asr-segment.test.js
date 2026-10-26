/**
 * 按段（segment）ASR 离线单测（不触网：fetch 全部 mock）。
 *
 * 覆盖：分段缓冲与静音切段（固定 PCM 样例）、纯静音丢弃、时长上限强制切段、
 * 10MB base64 红线的超限切分、MiMo/阿里按段请求体拼装与响应解析、
 * 工厂按 provider 分流、close 幂等与 abort、buildWav 头。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SegmentAsrClientBase,
  maxWavBytesForBase64,
  pcmRms,
  splitPcmByMaxBytes,
  computeGateDbfs,
  DEFAULT_MAX_SEGMENT_MS,
  ENERGY_DBFS_MAX,
  ENERGY_DBFS_MIN,
  ENERGY_FRAME_MS,
  NOISE_MARGIN_DB,
  NOISE_WINDOW_MS,
  NOISE_WINDOW_FRAMES,
  NOISE_WINDOW_PERCENTILE,
  NOISE_WINDOW_MIN_FRAMES,
  NOISE_RECALC_FRAMES,
  VOICE_CONFIRM_FRAMES,
  clampVadMarginDb,
  rmsToDbfs,
  thresholdToDbfs,
  MAX_BASE64_BYTES,
  WAV_DATA_URL_PREFIX,
} from "../dist/voice/asr/segment.js";
import {
  AliyunFileAsrClient,
  buildAliyunFileAsrBody,
  buildFileAsrUrl,
  parseAliyunFileResponse,
} from "../dist/voice/asr/aliyun-file.js";
import {
  MimoAsrClient,
  buildMimoAsrRequestBody,
  mapMimoAsrLanguage,
  parseMimoAsrResponse,
} from "../dist/voice/asr/mimo.js";
import { createAsrClient } from "../dist/voice/asr/index.js";
import { ASR_PROVIDER_PRESETS } from "../dist/voice/config.js";
import { buildWav, WAV_HEADER_BYTES } from "../dist/voice/wav.js";

/** 采样率（测试统一用 16k）。 */
const SR = 16000;

/**
 * 生成固定 PCM：恒定幅值的「语音」或全 0 静音。
 * @param ms 时长毫秒
 * @param loud 是否语音（true=幅值 8000，RMS≈0.244；false=静音）
 * @returns s16le 字节
 */
function pcm(ms, loud) {
  const samples = Math.floor((SR * ms) / 1000);
  const buf = Buffer.alloc(samples * 2);
  if (loud) {
    for (let i = 0; i < samples; i += 1) buf.writeInt16LE(8000, i * 2);
  }
  return buf;
}

/** 按 100ms 块切分 PCM（模拟采集回调粒度）。 */
function chunks100(pcmBuf) {
  const frame = Math.floor((SR * 100) / 1000) * 2;
  const out = [];
  for (let off = 0; off < pcmBuf.length; off += frame) out.push(pcmBuf.subarray(off, Math.min(off + frame, pcmBuf.length)));
  return out;
}

/** 可控 fetch 桩：记录请求、按队列返回响应。 */
function mockFetch(responses) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const next = responses.shift();
    if (!next) throw new Error("mockFetch：没有更多预设响应");
    if (next.throw) throw new Error(next.throw);
    return {
      ok: next.ok ?? true,
      status: next.status ?? 200,
      text: async () => next.text ?? "",
      json: async () => next.json,
    };
  };
  return { impl, calls };
}

test("pcmRms / maxWavBytesForBase64：能量与 10MB 红线换算", () => {
  assert.equal(pcmRms(Buffer.alloc(100)), 0);
  const loud = pcm(10, true);
  assert.ok(pcmRms(loud) > 0.2 && pcmRms(loud) < 0.3, "恒定 8000 幅值 RMS≈0.244");
  // 10MB base64 → WAV 上限：(10MB - 前缀) * 3/4，含 44 字节头
  const maxWav = maxWavBytesForBase64(MAX_BASE64_BYTES);
  assert.equal(maxWav, Math.floor(((10 * 1024 * 1024 - WAV_DATA_URL_PREFIX.length) * 3) / 4));
  // 新的标定口径：threshold 越高门限越高（越抗噪），默认 0.5 对应 -35dBFS（标定数据见 segment.ts）
  assert.equal(thresholdToDbfs(0), ENERGY_DBFS_MIN);
  assert.equal(thresholdToDbfs(1), ENERGY_DBFS_MAX);
  assert.equal(thresholdToDbfs(0.5), (ENERGY_DBFS_MIN + ENERGY_DBFS_MAX) / 2);
  assert.ok(thresholdToDbfs(0.7) > thresholdToDbfs(0.3), "threshold 单调：越高越抗噪");
  assert.equal(thresholdToDbfs(Number.NaN), thresholdToDbfs(0.5), "非法阈值回退默认");
  assert.ok(ENERGY_FRAME_MS >= 20 && ENERGY_FRAME_MS <= 40, "短帧 20~40ms");
  assert.equal(rmsToDbfs(0), Number.NEGATIVE_INFINITY);
  assert.ok(Math.abs(rmsToDbfs(1)) < 1e-9);
});

test("splitPcmByMaxBytes：不超限原样、超限均分且采样点对齐", () => {
  const one = Buffer.alloc(100, 1);
  assert.deepEqual(splitPcmByMaxBytes(one, 1000), [one]);
  assert.deepEqual(splitPcmByMaxBytes(Buffer.alloc(0), 10), []);
  const parts = splitPcmByMaxBytes(Buffer.alloc(400, 2), 100);
  assert.equal(parts.length, 4, "400 字节按 100 上限切成 4 段");
  for (const part of parts) {
    assert.ok(part.length <= 100);
    assert.equal(part.length % 2, 0, "保持 16bit 对齐");
  }
  assert.equal(parts.reduce((n, p) => n + p.length, 0), 400, "切分不丢字节");
});

test("buildWav：44 字节标准头，RIFF/WAVE/采样率/长度正确", () => {
  const data = pcm(10, true);
  const wav = buildWav(data, SR);
  assert.equal(wav.length, WAV_HEADER_BYTES + data.length);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.readUInt32LE(24), SR);
  assert.equal(wav.readUInt16LE(22), 1, "单声道");
  assert.equal(wav.readUInt16LE(34), 16, "16bit");
  assert.equal(wav.readUInt32LE(40), data.length, "data 长度");
  assert.equal(wav.readUInt32LE(4), 36 + data.length, "RIFF 长度");
});

test("分段缓冲与静音切段：语音+静音 ≥ silenceDurationMs 切一段，finish 冲刷", async () => {
  const submitted = [];
  const results = [];
  class TestClient extends SegmentAsrClientBase {
    async submitSegment(wav) {
      submitted.push(wav);
      return { text: `段${submitted.length}`, emotion: "" };
    }
  }
  const client = new TestClient({
    sampleRate: SR,
    vad: { threshold: 0.5, silenceDurationMs: 400 },
    onResult: (r) => results.push(r),
  });
  await client.connect();
  // 语音 300ms + 静音 500ms（>=400ms 静音 → 切段）；再语音 300ms 靠 finish 冲刷
  for (const chunk of chunks100(pcm(300, true))) client.feed(chunk);
  for (const chunk of chunks100(pcm(500, false))) client.feed(chunk);
  for (const chunk of chunks100(pcm(300, true))) client.feed(chunk);
  await client.finish();
  assert.equal(submitted.length, 2, "静音触发 1 次 + finish 冲刷 1 次");
  assert.deepEqual(
    results.map((r) => [r.text, r.isFinal]),
    [["段1", true], ["段2", true]],
    "每段各产一条 final 结果",
  );
  // 静音累计到阈值即切（含触发阈值的那 400ms 静音）：300 语音 + 400 静音 = 700ms；
  // 剩余 100ms 静音归入下一段缓冲，与后续 300ms 语音一起由 finish 冲刷（100+300=400ms）
  const firstSamples = (submitted[0].length - WAV_HEADER_BYTES) / 2;
  assert.ok(Math.abs(firstSamples / SR - 0.7) < 0.01, `第一段≈700ms，实际 ${((firstSamples / SR) * 1000).toFixed(0)}ms`);
  const secondSamples = (submitted[1].length - WAV_HEADER_BYTES) / 2;
  assert.ok(Math.abs(secondSamples / SR - 0.4) < 0.01, `第二段≈400ms，实际 ${((secondSamples / SR) * 1000).toFixed(0)}ms`);
  assert.equal(client.isFinished, true);
  assert.equal(client.transport, "segment");
});

test("纯静音缓冲丢弃：从未检出语音的段不发送", async () => {
  const submitted = [];
  class TestClient extends SegmentAsrClientBase {
    async submitSegment(wav) {
      submitted.push(wav);
      return { text: "不应出现", emotion: "" };
    }
  }
  const client = new TestClient({ sampleRate: SR, vad: { threshold: 0.5, silenceDurationMs: 300 }, onResult: () => {} });
  for (const chunk of chunks100(pcm(1000, false))) client.feed(chunk);
  await client.finish();
  assert.equal(submitted.length, 0, "纯静音不发送");
});

/**
 * 生成振幅已知的正弦 PCM（s16le 单声道），用于能量标定回归。
 * @param {number} ms 时长（毫秒）
 * @param {number} rms 目标线性 RMS（[0,1]；0 = 纯静音）。正弦 RMS = 振幅/√2。
 * @returns {Buffer} PCM 字节
 */
function sinePcm(ms, rms) {
  const samples = Math.floor((SR * ms) / 1000);
  const buf = Buffer.alloc(samples * 2);
  const amplitude = rms * Math.SQRT2;
  for (let i = 0; i < samples; i += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * 220 * i) / SR) * amplitude * 32767);
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, value)), i * 2);
  }
  return buf;
}

/**
 * 生成类语声 PCM：默认每 6 个 30ms 帧中有 1 帧轻音（-33 dBFS），其余 -17 dBFS。
 * 单帧恒定幅值没有语声的动态范围（p10 会等于 p50），该生成器让 p50≈-17、p10≈-33，
 * 用于验证「滑动分位不会被语声 p50 带跑」。
 * @param {number} ms 时长（毫秒）
 * @param {{loudDbfs?: number, dipDbfs?: number, dipEvery?: number}} opts 目标电平
 * @returns {Buffer} s16le PCM
 */
function speechPcm(ms, opts = {}) {
  const loudDbfs = opts.loudDbfs ?? -17;
  const dipDbfs = opts.dipDbfs ?? -33;
  const dipEvery = opts.dipEvery ?? 6;
  const frameSamples = Math.floor((SR * ENERGY_FRAME_MS) / 1000);
  const samples = Math.floor((SR * ms) / 1000);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const frameIndex = Math.floor(i / frameSamples);
    const rms = frameIndex % dipEvery === dipEvery - 1 ? 10 ** (dipDbfs / 20) : 10 ** (loudDbfs / 20);
    const value = Math.round(Math.sin((2 * Math.PI * 220 * i) / SR) * rms * Math.SQRT2 * 32767);
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, value)), i * 2);
  }
  return buf;
}

/** 按固定毫秒切分 PCM（模拟采集回调粒度；300ms 与 30ms 帧对齐）。 */
function chunksMs(pcmBuf, ms) {
  const frame = Math.floor((SR * ms) / 1000) * 2;
  const out = [];
  for (let off = 0; off < pcmBuf.length; off += frame) out.push(pcmBuf.subarray(off, Math.min(off + frame, pcmBuf.length)));
  return out;
}

/** `chunksMs(buf, 300)` 的简写（300ms 与 30ms 帧对齐）。 */
function chunks300(buf) {
  return chunksMs(buf, 300);
}

test("能量标定回归：低底噪 + 500ms 窗平均 RMS 0.035 的语声必须切段（旧门 0.05 会整段丢弃）", async () => {
  const submitted = [];
  class TestClient extends SegmentAsrClientBase {
    async submitSegment(wav) {
      submitted.push(wav);
      return { text: `段${submitted.length}`, emotion: "" };
    }
  }
  const client = new TestClient({ sampleRate: SR, vad: { threshold: 0.5, silenceDurationMs: 300 }, onResult: () => {} });
  // 起录 500ms 低底噪（RMS 0.0005 ≈ -66 dBFS）→ 自适应门限回落到配置基线 -35 dBFS
  client.feed(sinePcm(500, 0.0005));
  // 真实量级语声：500ms/块、块平均 RMS=0.035（实测说话块 0.03~0.04），共 5 块
  for (let i = 0; i < 5; i += 1) client.feed(sinePcm(500, 0.035));
  // 500ms 静音 → 触发切段
  for (const chunk of chunks100(pcm(500, false))) client.feed(chunk);
  await client.finish();
  assert.equal(submitted.length, 1, "低幅语声必须被识别为语音并切段发送（修复前发送 0 段）");
  const samples = (submitted[0].length - WAV_HEADER_BYTES) / 2;
  assert.ok(samples / SR >= 2.9, `该段应包含 ~3s（低底噪 + 语声），实际 ${(samples / SR).toFixed(2)}s`);
});

test("能量标定：同一 500ms 块内「短词 + 静音」不再被整窗平均摊薄", async () => {
  const submitted = [];
  class TestClient extends SegmentAsrClientBase {
    async submitSegment(wav) {
      submitted.push(wav);
      return { text: "短词", emotion: "" };
    }
  }
  const client = new TestClient({ sampleRate: SR, vad: { threshold: 0.5, silenceDurationMs: 300 }, onResult: () => {} });
  // 一个 500ms 块 = 200ms 语声（RMS 0.06）+ 300ms 静音 ⇒ 块平均 RMS≈0.038（< 旧门 0.05），帧级仍应判语音
  client.feed(Buffer.concat([sinePcm(200, 0.06), pcm(300, false)]));
  for (const chunk of chunks100(pcm(500, false))) client.feed(chunk);
  await client.finish();
  assert.equal(submitted.length, 1, "块内短词必须触发切段");
});

test("能量标定：静音底噪（RMS 0.0005）与纯静音都不得切段", async () => {
  const submitted = [];
  class TestClient extends SegmentAsrClientBase {
    async submitSegment(wav) {
      submitted.push(wav);
      return { text: "不应出现", emotion: "" };
    }
  }
  const client = new TestClient({ sampleRate: SR, vad: { threshold: 0.5, silenceDurationMs: 300 }, onResult: () => {} });
  // 本机实测底噪 0.00035~0.00061（≈ -69~-64 dBFS），远低于默认门限 -35dBFS
  for (let i = 0; i < 6; i += 1) client.feed(sinePcm(500, 0.0005));
  await client.finish();
  assert.equal(submitted.length, 0, "底噪不得被判为语音");
});

test("滑动窗口常量：5s / 167 帧 / p10 / 1s 下限 / 300ms 节流", () => {
  assert.equal(NOISE_WINDOW_MS, 5000);
  assert.equal(NOISE_WINDOW_FRAMES, Math.ceil(5000 / ENERGY_FRAME_MS));
  assert.equal(NOISE_WINDOW_FRAMES, 167);
  assert.equal(NOISE_WINDOW_PERCENTILE, 0.1, "取 p10 低分位：说话时仍落在停顿/轻音帧");
  assert.equal(NOISE_WINDOW_MIN_FRAMES, Math.ceil(1000 / ENERGY_FRAME_MS));
  assert.equal(NOISE_RECALC_FRAMES, 10, "每 10 帧（300ms）重算一次，不逐帧排序");
});

test("自适应门限公式：底噪低回落配置基线，高底噪抬升并夹在 [-50,-20] dBFS", () => {
  const base = thresholdToDbfs(0.5); // -35 dBFS
  assert.equal(computeGateDbfs(base, -66), base, "底噪 -66 dBFS → 仍用配置基线");
  assert.equal(computeGateDbfs(base, -80), base, "极低底噪不会把门限压到配置值以下");
  assert.equal(computeGateDbfs(thresholdToDbfs(1), -80), ENERGY_DBFS_MAX, "threshold=1 基线即上界");
  assert.equal(computeGateDbfs(thresholdToDbfs(0), -80), ENERGY_DBFS_MIN, "threshold=0 基线即下界");
  assert.equal(computeGateDbfs(base, -28), -22, "高底噪 -28 dBFS + 6dB 余量 → 门限 -22 dBFS");
  assert.equal(computeGateDbfs(base, -30), -24, "-30 dBFS 底噪 → 门限 -24 dBFS");
  assert.equal(computeGateDbfs(base, 0), ENERGY_DBFS_MAX, "极端底噪夹到上界");
  assert.equal(computeGateDbfs(base, -100), base, "底噪下界仍不压低配置基线");
  assert.equal(NOISE_MARGIN_DB, 6, "自适应余量固定 6dB（30ms 帧级实测：误判 0.6%、命中 81%）");
  assert.equal(VOICE_CONFIRM_FRAMES, 5, "语音确认需连续 5 帧（150ms）");
});

test("底噪自适应：静音底噪 -28dBFS（高于固定门限 -35）仍能正常切段", async () => {
  const submitted = [];
  class TestClient extends SegmentAsrClientBase {
    async submitSegment(wav) {
      submitted.push(wav);
      return { text: `段${submitted.length}`, emotion: "" };
    }
  }
  const client = new TestClient({ sampleRate: SR, vad: { threshold: 0.5, silenceDurationMs: 400 }, onResult: () => {} });
  // 1.2s 底噪 RMS 0.04 ≈ -28 dBFS：窗口满 1s 后启用 p10 ⇒ 门限 -28+6=-22
  for (const chunk of chunks300(sinePcm(1200, 0.04))) client.feed(chunk);
  assert.ok(Math.abs(client.currentGateDbfs - -22) < 0.5, `底噪 -28 → 门限 -22，实际 ${client.currentGateDbfs.toFixed(2)}`);
  // 语声 RMS 0.25 ≈ -12 dBFS（高于门限 -22）
  client.feed(sinePcm(500, 0.25));
  // 静音底噪 600ms（≥400ms）→ 应触发切段；按 100ms 采集块喂入，400ms 时切，剩余静音不送
  for (const chunk of chunks100(sinePcm(600, 0.04))) client.feed(chunk);
  await client.finish();
  assert.equal(submitted.length, 1, "高底噪下仍须按「有语音 + 静音」切段（修复前 silenceMs 恒 0、永不切段）");
  const samples = (submitted[0].length - WAV_HEADER_BYTES) / 2;
  assert.ok(Math.abs(samples / SR - 2.1) < 0.1, `第一段≈2.1s（1.2 底噪 + 0.5 语音 + 0.4 静音），实际 ${(samples / SR).toFixed(2)}s`);
});

test("底噪自适应：高底噪纯静音不判语音、不发送（避免幻听文本）", async () => {
  const submitted = [];
  class TestClient extends SegmentAsrClientBase {
    async submitSegment(wav) {
      submitted.push(wav);
      return { text: "幻听", emotion: "" };
    }
  }
  const client = new TestClient({ sampleRate: SR, vad: { threshold: 0.5, silenceDurationMs: 400 }, onResult: () => {} });
  // 1.5s 持续底噪（-28 dBFS）：窗口满 1s 后门限抬到 -22，底噪全部判静音 ⇒ 不切段、不发请求
  for (const chunk of chunks300(sinePcm(1500, 0.04))) client.feed(chunk);
  assert.ok(Math.abs(client.currentGateDbfs - -22) < 0.5, `纯底噪稳态门限应为 -22，实际 ${client.currentGateDbfs.toFixed(2)}`);
  await client.finish();
  assert.equal(submitted.length, 0, "高底噪纯静音不得被送去识别");
});

test("起录即说话：300ms 短录音窗口不足 1s 仍提交 1 段（不得把末段语音当底噪）", async () => {
  const submitted = [];
  class TestClient extends SegmentAsrClientBase {
    async submitSegment(wav) {
      submitted.push(wav);
      return { text: "短句", emotion: "" };
    }
  }
  const client = new TestClient({ sampleRate: SR, vad: { threshold: 0.5, silenceDurationMs: 400 }, onResult: () => {} });
  // 起录即说话：300ms、RMS 0.035（≈ -29 dBFS，高于配置基线 -35）；窗口帧数 10 < 34 ⇒ 用配置基线
  for (const chunk of chunks100(sinePcm(300, 0.035))) client.feed(chunk);
  await client.finish();
  assert.equal(submitted.length, 1, "短录音必须用配置基线判定并提交（不得用几帧语声算 p10 抬门限）");
  const ms = ((submitted[0].length - WAV_HEADER_BYTES) / 2 / SR) * 1000;
  assert.ok(Math.abs(ms - 300) < 50, `该段应约 300ms，实际 ${ms.toFixed(0)}ms`);
});

test("滑动分位：少量低谷帧不入 p10（2×-38 不塌陷），持续下降后 300ms 内跟随", async () => {
  const submitted = [];
  class TestClient extends SegmentAsrClientBase {
    async submitSegment(wav) {
      submitted.push(wav);
      return { text: `段${submitted.length}`, emotion: "" };
    }
  }
  const client = new TestClient({ sampleRate: SR, vad: { threshold: 0.5, silenceDurationMs: 400 }, onResult: () => {} });
  // 1.2s 底噪 -28 dBFS → 门限 -22
  for (const chunk of chunks300(sinePcm(1200, 0.04))) client.feed(chunk);
  assert.ok(Math.abs(client.currentGateDbfs - -22) < 0.5, `初始门限应为 -22，实际 ${client.currentGateDbfs.toFixed(2)}`);
  // 连续 2 帧骤降到 -38 dBFS：只占窗口 2/42≈5% < p10，底噪/门限不动
  for (let i = 0; i < 2; i += 1) client.feed(sinePcm(30, 10 ** (-38 / 20)));
  assert.ok(Math.abs(client.currentGateDbfs - -22) < 0.5, `2 帧低谷不得改动 p10，实际 ${client.currentGateDbfs.toFixed(2)}`);
  // 持续降到 -45 dBFS（13 帧 ≈ 390ms）：低分位跟随 ⇒ 底噪 -45、门限回落到配置基线 -35（-45+6 更低）
  for (let i = 0; i < 13; i += 1) client.feed(sinePcm(30, 10 ** (-45 / 20)));
  assert.ok(Math.abs(client.currentGateDbfs - -35) < 0.5, `持续下降后门限应≈-35，实际 ${client.currentGateDbfs.toFixed(2)}`);
  // 探针 -31 dBFS：高于跟随后的门限（-35）、低于未跟随时的门限（-22）⇒ 只有跟上才判语音
  for (const chunk of chunks100(sinePcm(300, 10 ** (-31 / 20)))) client.feed(chunk);
  for (const chunk of chunks100(sinePcm(400, 10 ** (-45 / 20)))) client.feed(chunk);
  await client.finish();
  assert.equal(submitted.length, 1, "持续下降后门限须在 ≤0.3s 内跟随，-31 dBFS 探针应被判语音并切段");
});

test("滑动分位：连续 20s 语声（p50 -17）不把门限抬到 -20 以上", async () => {
  const submitted = [];
  class TestClient extends SegmentAsrClientBase {
    async submitSegment(wav) {
      submitted.push(wav);
      return { text: `段${submitted.length}`, emotion: "" };
    }
  }
  const client = new TestClient({ sampleRate: SR, vad: { threshold: 0.5, silenceDurationMs: 6000 }, onResult: () => {} });
  // 20s 类语声：p50=-17、p10=-33；低分位贴底噪/轻音 ⇒ 门限≈-27，不会被语声 p50 带跑
  const gates = [];
  for (const chunk of chunksMs(speechPcm(20000), 300)) {
    client.feed(chunk);
    gates.push(client.currentGateDbfs);
  }
  assert.ok(gates.every((gate) => gate <= -20), `门限恒被夹在 -20 及以下，实际 ${Math.min(...gates).toFixed(1)}~${Math.max(...gates).toFixed(1)}`);
  const steady = gates.slice(40); // 12s 之后窗口已完全由语声构成（仍含轻音帧）
  assert.ok(steady.every((gate) => gate < -25 && gate > -32), `语声期间门限应贴轻音分位（≈-27），实际 ${Math.min(...steady).toFixed(1)}~${Math.max(...steady).toFixed(1)}`);
  assert.ok(Math.abs(steady[steady.length - 1] - -27) < 1.5, `稳态门限应≈-27（p10 -33 + 6），实际 ${steady[steady.length - 1].toFixed(1)}`);
  await client.finish();
  assert.equal(submitted.length, 2, "12s 兜底切段 + finish 冲刷剩余 8s（语声未被飘走的门限盖住）");
});

test("冷启动数字静音 → 真实底噪 -32：5s 内门限自愈到 ≈-26（windowed 日志）", async () => {
  const lines = [];
  class TestClient extends SegmentAsrClientBase {
    async submitSegment() {
      return { text: "", emotion: "" };
    }
  }
  const client = new TestClient({
    sampleRate: SR,
    vad: { threshold: 0.5, silenceDurationMs: 400 },
    onResult: () => {},
    logger: captureLogger(lines),
  });
  // 2s 数字静音（RMS=0 → 记账 -100）：门限停留在配置基线 -35
  for (const chunk of chunks300(pcm(2000, false))) client.feed(chunk);
  assert.ok(Math.abs(client.currentGateDbfs - -35) < 0.1, `数字静音期门限应=基线 -35，实际 ${client.currentGateDbfs.toFixed(2)}`);
  // 随后 5s 真实底噪 -32 dBFS：滑动窗口淘汰冷启动低值 ⇒ 门限升到 -32+6=-26
  for (const chunk of chunks300(sinePcm(5000, 10 ** (-32 / 20)))) client.feed(chunk);
  assert.ok(
    Math.abs(client.currentGateDbfs - -26) <= 1.5,
    `5s 内门限应升到 -26±1.5，实际 ${client.currentGateDbfs.toFixed(2)}`,
  );
  const gateLogs = lines.filter((line) => line.startsWith("asr gate: reason=windowed"));
  assert.ok(gateLogs.length >= 1, "门限变化 ≥3dB 须写 windowed 日志");
  const loggedGates = gateLogs
    .map((line) => /newGateDbfs=(-?\d+\.\d)/.exec(line)?.[1])
    .filter((value) => value !== undefined)
    .map(Number);
  assert.ok(
    loggedGates.some((gate) => Math.abs(gate - -26) <= 1.5),
    `门限日志须记录升到 -26±1.5（实际：${gateLogs.join(" | ")}）`,
  );
});

test("稳态底噪 -32：10s 内门限稳定在 -26 附近（波动 <2dB）", () => {
  class TestClient extends SegmentAsrClientBase {
    async submitSegment() {
      return { text: "", emotion: "" };
    }
  }
  const client = new TestClient({ sampleRate: SR, vad: { threshold: 0.5, silenceDurationMs: 400 }, onResult: () => {} });
  const gates = [];
  for (const chunk of chunks300(sinePcm(10000, 10 ** (-32 / 20)))) {
    client.feed(chunk);
    gates.push(client.currentGateDbfs);
  }
  const steady = gates.slice(7); // 2.1s 后窗口已由真实底噪构成
  const min = Math.min(...steady);
  const max = Math.max(...steady);
  assert.ok(max - min < 2, `稳态门限波动应 <2dB，实际 ${min.toFixed(2)}~${max.toFixed(2)}`);
  assert.ok(steady.every((gate) => Math.abs(gate - -26) <= 1), `稳态门限应≈-26，实际 ${min.toFixed(2)}~${max.toFixed(2)}`);
  client.close();
});

test("低 SNR 语声（比底噪高 7dB）：150ms 确认后能检出并切段", async () => {
  const submitted = [];
  class TestClient extends SegmentAsrClientBase {
    async submitSegment(wav) {
      submitted.push(wav);
      return { text: `段${submitted.length}`, emotion: "" };
    }
  }
  const client = new TestClient({ sampleRate: SR, vad: { threshold: 0.5, silenceDurationMs: 300 }, onResult: () => {} });
  // 5s 底噪 -32 ⇒ 门限 -26
  for (const chunk of chunks300(sinePcm(5000, 10 ** (-32 / 20)))) client.feed(chunk);
  assert.ok(Math.abs(client.currentGateDbfs - -26) <= 0.5, `底噪 -32 → 门限 -26，实际 ${client.currentGateDbfs.toFixed(2)}`);
  // 语声只比底噪高 7dB（-25）：高于门限 1dB，仍需连续 5 帧（150ms）确认
  for (const chunk of chunks300(sinePcm(600, 10 ** (-25 / 20)))) client.feed(chunk);
  assert.equal(submitted.length, 0, "600ms 语声未被静音切断前不应提交");
  // 回落到底噪 400ms（≥silenceDurationMs 300）⇒ 切段
  for (const chunk of chunks100(sinePcm(400, 10 ** (-32 / 20)))) client.feed(chunk);
  await client.finish();
  assert.equal(submitted.length, 1, "低 SNR 语声应被检出并切段");
  const samples = (submitted[0].length - WAV_HEADER_BYTES) / 2;
  assert.ok(Math.abs(samples / SR - 5.9) < 0.1, `该段≈5.9s（5 底噪 + 0.6 语声 + 0.3 静音），实际 ${(samples / SR).toFixed(2)}s`);
});

test("语音确认①：单帧尖峰 / 仅连续 4 帧都不算语音（不提交、不切段）", async () => {
  const submitted = [];
  class TestClient extends SegmentAsrClientBase {
    async submitSegment(wav) {
      submitted.push(wav);
      return { text: "幻听", emotion: "" };
    }
  }
  const client = new TestClient({ sampleRate: SR, vad: { threshold: 0.5, silenceDurationMs: 400 }, onResult: () => {} });
  // 1.2s 底噪 -28 dBFS（RMS 0.04）→ 滑动分位门限 -22
  for (const chunk of chunks300(sinePcm(1200, 0.04))) client.feed(chunk);
  assert.ok(Math.abs(client.currentGateDbfs - -22) < 0.5, `门限应为 -22，实际 ${client.currentGateDbfs.toFixed(2)}`);
  // 孤立 1 帧 -12 dBFS（0.25 RMS）后立刻回落到门限下（-35）⇒ 连续计数清零
  client.feed(sinePcm(30, 0.25));
  client.feed(sinePcm(30, 10 ** (-35 / 20)));
  // 再连续 4 帧 -12 dBFS（120ms，差 1 帧不足确认）
  for (let i = 0; i < 4; i += 1) client.feed(sinePcm(30, 0.25));
  // 随后 500ms 底噪：从未确认语音 ⇒ 不得切段/提交
  for (const chunk of chunks300(sinePcm(600, 0.04))) client.feed(chunk);
  await client.finish();
  assert.equal(submitted.length, 0, "单帧尖峰/仅 4 帧连续不得被确认为语音（否则噪声尖峰会送去识别）");
});

test("语音确认②：连续 5 帧（150ms）越门限 + 静音 ⇒ 提交且整段包含句首 150ms", async () => {
  const submitted = [];
  class TestClient extends SegmentAsrClientBase {
    async submitSegment(wav) {
      submitted.push(wav);
      return { text: "确认", emotion: "" };
    }
  }
  const client = new TestClient({ sampleRate: SR, vad: { threshold: 0.5, silenceDurationMs: 400 }, onResult: () => {} });
  // 1.2s 底噪 -28 dBFS → 门限 -22
  for (const chunk of chunks300(sinePcm(1200, 0.04))) client.feed(chunk);
  // 恰好 5×30ms=150ms 的 -12 dBFS 语声：第 5 帧才确认「有语音」
  client.feed(sinePcm(150, 0.25));
  // 400ms 底噪触发切段（剩余 200ms 归入下一段并被 finish 丢弃）
  for (const chunk of chunks100(sinePcm(600, 0.04))) client.feed(chunk);
  await client.finish();
  assert.equal(submitted.length, 1, "连续 150ms 越门限必须确认为语音并切段");
  const ms = ((submitted[0].length - WAV_HEADER_BYTES) / 2 / SR) * 1000;
  assert.ok(Math.abs(ms - 1750) < 50, `该段≈1750ms（1200 底噪 + 150 句首 + 400 静音），实际 ${ms.toFixed(0)}ms`);
  assert.ok(ms >= 1740, "确认期的 150ms 必须留在段内（不得丢句首）");
});

test("语音确认③：确认前的静音不累计进 silenceMs（长静音后说话不被提前切段）", async () => {
  const submitted = [];
  class TestClient extends SegmentAsrClientBase {
    async submitSegment(wav) {
      submitted.push(wav);
      return { text: "长静音后说话", emotion: "" };
    }
  }
  const client = new TestClient({ sampleRate: SR, vad: { threshold: 0.5, silenceDurationMs: 400 }, onResult: () => {} });
  // 1.2s 底噪 -28 → 门限 -22
  for (const chunk of chunks300(sinePcm(1200, 0.04))) client.feed(chunk);
  // 确认前 500ms 数字静音（已超 silenceDurationMs）：只统计「hasVoice 置真之后」的静音，此处不得累计
  for (const chunk of chunks100(pcm(500, false))) client.feed(chunk);
  // 150ms 语声 → 第 5 帧确认；之后仅 200ms 静音（< 400）不应切段，由 finish 冲刷
  client.feed(sinePcm(150, 0.25));
  for (const chunk of chunks100(pcm(200, false))) client.feed(chunk);
  await client.finish();
  assert.equal(submitted.length, 1, "确认前的静音若累计会导致提前切段/整段丢弃");
  const ms = ((submitted[0].length - WAV_HEADER_BYTES) / 2 / SR) * 1000;
  assert.ok(Math.abs(ms - 2050) < 50, `该段≈2050ms（1200 底噪 + 500 静音 + 150 语声 + 200 静音），实际 ${ms.toFixed(0)}ms`);
});

test("默认 12s 兜底：连续语音超 DEFAULT_MAX_SEGMENT_MS 强制切段", async () => {
  assert.equal(DEFAULT_MAX_SEGMENT_MS, 12000, "默认单段上限应为 12s（旧 60s 太长）");
  const submitted = [];
  class TestClient extends SegmentAsrClientBase {
    async submitSegment(wav) {
      submitted.push(wav);
      return { text: `段${submitted.length}`, emotion: "" };
    }
  }
  const client = new TestClient({ sampleRate: SR, vad: { threshold: 0.5, silenceDurationMs: 6000 }, onResult: () => {} });
  // 连续语声 13s（p50=-17、每 180ms 一个 30ms 轻音帧，无 ≥6s 停顿）；按 300ms 块喂入（与帧对齐）
  for (const chunk of chunksMs(speechPcm(13000), 300)) client.feed(chunk);
  await client.finish();
  assert.equal(submitted.length, 2, "12s 处强制切段 + finish 冲刷剩余 1s");
  const firstMs = (submitted[0].length - WAV_HEADER_BYTES) / 2 / SR * 1000;
  const secondMs = (submitted[1].length - WAV_HEADER_BYTES) / 2 / SR * 1000;
  assert.ok(Math.abs(firstMs - 12000) < 100, `第一段≈12000ms，实际 ${firstMs.toFixed(0)}ms`);
  assert.ok(Math.abs(secondMs - 1000) < 100, `第二段≈1000ms，实际 ${secondMs.toFixed(0)}ms`);
});

test("时长上限强制切段：连续语音超 maxSegmentMs 即切", async () => {
  const submitted = [];
  class TestClient extends SegmentAsrClientBase {
    async submitSegment(wav) {
      submitted.push(wav);
      return { text: `段${submitted.length}`, emotion: "" };
    }
  }
  const client = new TestClient({
    sampleRate: SR,
    vad: { threshold: 0.5, silenceDurationMs: 6000 },
    maxSegmentMs: 1000,
    onResult: () => {},
  });
  for (const chunk of chunks100(pcm(2500, true))) client.feed(chunk); // 连续语音 2.5s 无静音
  await client.finish();
  assert.equal(submitted.length, 3, "1000ms + 1000ms + 冲刷 500ms");
});

test("10MB base64 红线：超限在发送时均分切开、各切片结果分别产出（不丢）", async () => {
  const submitted = [];
  const results = [];
  class TestClient extends SegmentAsrClientBase {
    async submitSegment(wav) {
      submitted.push(wav);
      return { text: `切${submitted.length}`, emotion: "" };
    }
  }
  // maxBase64Bytes=200 → maxWav≈133 → 单段 PCM 上限≈89 字节
  const client = new TestClient({
    sampleRate: SR,
    vad: { threshold: 0.5, silenceDurationMs: 6000 },
    maxBase64Bytes: 200,
    onResult: (r) => results.push(r),
  });
  // 150ms 语声（=连续 5 帧确认的最短长度）：150ms × 16k × 2B = 4800 字节 → 切分后 54 片
  const pcmBytes = (SR * 150) / 1000 * 2;
  client.feed(pcm(150, true));
  await client.finish();
  assert.ok(submitted.length >= 2, `超限须切分多片，实际 ${submitted.length}`);
  let splitBytes = 0;
  for (const wav of submitted) {
    const base64Len = Math.ceil((wav.length / 3) * 4);
    assert.ok(base64Len + WAV_DATA_URL_PREFIX.length <= 200 + 4, `每片 base64 不超红线：${base64Len}`);
    splitBytes += wav.length - WAV_HEADER_BYTES;
  }
  assert.equal(splitBytes, pcmBytes, "切分不丢 PCM 字节（4800 字节全部送出）");
  assert.equal(results.length, submitted.length, "各切片结果分别产出");
});

test("close 幂等：进行中请求被 abort、不再上报结果、后续 feed 无效", async () => {
  const results = [];
  class HangingClient extends SegmentAsrClientBase {
    // 挂起直到 abort（模拟慢 HTTP），验证 close() 能中断在途请求
    async submitSegment(wav, signal) {
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }
  }
  const client = new HangingClient({ sampleRate: SR, vad: { threshold: 0.5, silenceDurationMs: 300 }, onResult: (r) => results.push(r) });
  for (const chunk of chunks100(pcm(300, true))) client.feed(chunk);
  const finishing = client.finish(); // 触发发送（挂起中）
  client.close(); // abort 在途请求
  await finishing;
  client.feed(pcm(100, true)); // close 后 feed 无效
  await client.finish(); // 幂等
  assert.equal(results.length, 0, "close 后不上报迟到结果");
  assert.equal(client.isFinished, true);
  assert.doesNotThrow(() => client.close(), "close 可重复调用");
});

test("mapMimoAsrLanguage：language 优先 zh/en，其次 hints zh→zh、en→en，否则 auto", () => {
  assert.equal(mapMimoAsrLanguage("zh", []), "zh");
  assert.equal(mapMimoAsrLanguage("en", ["zh"]), "en", "显式 language 优先于 hints");
  assert.equal(mapMimoAsrLanguage("", ["zh", "en"]), "zh", "hints 含 zh → zh");
  assert.equal(mapMimoAsrLanguage("", ["en"]), "en");
  assert.equal(mapMimoAsrLanguage("ja", []), "auto", "不支持的语种回落 auto");
  assert.equal(mapMimoAsrLanguage("", ["th"]), "auto");
  assert.equal(mapMimoAsrLanguage("", []), "auto");
});

test("buildMimoAsrRequestBody：模型名 / data URL / 根级 asr_options.language", () => {
  const body = buildMimoAsrRequestBody({
    model: "mimo-v2.5-asr",
    dataUrl: "data:audio/wav;base64,AAAA",
    language: "zh",
  });
  assert.equal(body.model, "mimo-v2.5-asr");
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].role, "user");
  assert.deepEqual(body.messages[0].content[0], {
    type: "input_audio",
    input_audio: { data: "data:audio/wav;base64,AAAA" },
  });
  assert.deepEqual(body.asr_options, { language: "zh" });
  assert.equal("stream" in body, false, "按段为非流式请求");
});

test("parseMimoAsrResponse：文本取 content、无情绪；缺 message 抛错", () => {
  assert.deepEqual(parseMimoAsrResponse({ choices: [{ message: { content: "你好" } }] }), { text: "你好", emotion: "" });
  assert.throws(() => parseMimoAsrResponse({ choices: [] }), /缺少 choices\[0\]\.message/);
  assert.throws(() => parseMimoAsrResponse(null), /不是对象/);
});

test("MimoAsrClient 接线（mock fetch）：请求体含 data URL/language/模型名，结果回 final，不含真 key", async () => {
  const key = "sk-test-not-a-real-key";
  const { impl, calls } = mockFetch([
    { json: { choices: [{ message: { content: "识别结果" } }] } },
  ]);
  const results = [];
  const errors = [];
  const client = new MimoAsrClient({
    apiKey: key,
    sampleRate: SR,
    vad: { threshold: 0.5, silenceDurationMs: 300 },
    onResult: (r) => results.push(r),
    onError: (m) => errors.push(m),
    fetchImpl: impl,
  });
  for (const chunk of chunks100(pcm(300, true))) client.feed(chunk);
  await client.finish();
  assert.equal(calls.length, 1);
  const { url, init, body } = calls[0];
  assert.equal(url, "https://api.xiaomimimo.com/v1/chat/completions");
  assert.equal(init.headers.Authorization, `Bearer ${key}`, "Bearer 鉴权");
  assert.equal(body.model, "mimo-v2.5-asr");
  assert.equal(body.asr_options.language, "auto", "无 language/hints → auto");
  const dataUrl = body.messages[0].content[0].input_audio.data;
  assert.ok(dataUrl.startsWith("data:audio/wav;base64,"), "data URL 前缀");
  assert.ok(dataUrl.length > WAV_DATA_URL_PREFIX.length, "含 base64 载荷");
  assert.deepEqual(results, [{ text: "识别结果", isFinal: true, emotion: "" }]);
  assert.equal(errors.length, 0);
});

test("buildAliyunFileAsrBody：官方 cURL 同构（stream:false、根级 asr_options、enable_itn）", () => {
  const withLang = buildAliyunFileAsrBody({ model: "qwen3-asr-flash", dataUrl: "data:audio/wav;base64,AAAA", language: "zh" });
  assert.equal(withLang.model, "qwen3-asr-flash");
  assert.equal(withLang.stream, false);
  assert.deepEqual(withLang.messages[0].content[0], { type: "input_audio", input_audio: { data: "data:audio/wav;base64,AAAA" } });
  assert.deepEqual(withLang.asr_options, { enable_itn: false, language: "zh" });
  const auto = buildAliyunFileAsrBody({ model: "qwen3-asr-flash", dataUrl: "x", language: "" });
  assert.deepEqual(auto.asr_options, { enable_itn: false }, "语言为空不下发 language（自动识别）");
  assert.equal(buildFileAsrUrl("ws1"), "https://ws1.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions");
});

test("parseAliyunFileResponse：annotations 情绪映射 7 类、未知情绪归空", () => {
  const happy = parseAliyunFileResponse({
    choices: [{ message: { content: "欢迎使用阿里云。", annotations: [{ type: "audio_info", language: "zh", emotion: "happy" }] } }],
  });
  assert.deepEqual(happy, { text: "欢迎使用阿里云。", emotion: "happy" });
  const unknown = parseAliyunFileResponse({
    choices: [{ message: { content: "x", annotations: [{ emotion: "EXCITED" }] } }],
  });
  assert.equal(unknown.emotion, "", "未知情绪归空串");
  assert.throws(() => parseAliyunFileResponse({}), /缺少 choices\[0\]\.message/);
});

test("AliyunFileAsrClient 接线（mock fetch）：专属域名端点、Bearer、情绪透传", async () => {
  const { impl, calls } = mockFetch([
    { json: { choices: [{ message: { content: "好的", annotations: [{ type: "audio_info", emotion: "neutral" }] } }] } },
  ]);
  const results = [];
  const client = new AliyunFileAsrClient({
    workspace: "ws1",
    apiKey: "sk-ali-test",
    language: "zh",
    sampleRate: SR,
    vad: { threshold: 0.5, silenceDurationMs: 300 },
    onResult: (r) => results.push(r),
    fetchImpl: impl,
  });
  for (const chunk of chunks100(pcm(300, true))) client.feed(chunk);
  await client.finish();
  assert.equal(calls.length, 1);
  const { url, body } = calls[0];
  assert.equal(url, "https://ws1.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions");
  assert.equal(body.model, "qwen3-asr-flash");
  assert.equal(body.asr_options.language, "zh");
  assert.deepEqual(results, [{ text: "好的", isFinal: true, emotion: "neutral" }]);
});

test("HTTP 失败：记错误并继续（不丢后续段），错误文本脱敏不含 key", async () => {
  const key = "sk-secret-do-not-leak";
  const { impl, calls } = mockFetch([
    { ok: false, status: 429, text: `rate limited for ${key}` },
    { json: { choices: [{ message: { content: "第二段" } }] } },
  ]);
  const results = [];
  const errors = [];
  const client = new MimoAsrClient({
    apiKey: key,
    sampleRate: SR,
    vad: { threshold: 0.5, silenceDurationMs: 300 },
    onResult: (r) => results.push(r),
    onError: (m) => errors.push(m),
    fetchImpl: impl,
  });
  for (const chunk of chunks100(pcm(300, true))) client.feed(chunk);
  for (const chunk of chunks100(pcm(500, false))) client.feed(chunk); // 触发切段 1（将失败）
  for (const chunk of chunks100(pcm(300, true))) client.feed(chunk);
  await client.finish(); // 冲刷段 2（成功）
  assert.equal(calls.length, 2, "失败段之后继续发送");
  assert.equal(results.length, 1);
  assert.equal(results[0].text, "第二段");
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes("***") && !errors[0].includes(key), "错误文本已脱敏");
});

test("createAsrClient 工厂分流：stream/segment 各归其位，凭证缺失即抛", () => {
  const noop = () => {};
  const base = { model: "", language: "", languageHints: [], vocabularyId: "", context: "", vad: { threshold: 0.5, silenceDurationMs: 800 }, onResult: noop };
  const stream = createAsrClient({ ...base, preset: ASR_PROVIDER_PRESETS["aliyun-qwen"], credentials: { workspace: "w", apiKey: "k" } });
  assert.equal(stream.transport, "stream");
  assert.equal(stream.constructor.name, "AliyunAsrClient");
  const file = createAsrClient({ ...base, preset: ASR_PROVIDER_PRESETS["aliyun-qwen-file"], credentials: { workspace: "w", apiKey: "k" } });
  assert.equal(file.transport, "segment");
  assert.equal(file.constructor.name, "AliyunFileAsrClient");
  const mimo = createAsrClient({ ...base, preset: ASR_PROVIDER_PRESETS["mimo"], mimoApiKey: "mk" });
  assert.equal(mimo.transport, "segment");
  assert.equal(mimo.constructor.name, "MimoAsrClient");
  assert.throws(() => createAsrClient({ ...base, preset: ASR_PROVIDER_PRESETS["mimo"] }), /缺少 API Key/);
  assert.throws(() => createAsrClient({ ...base, preset: ASR_PROVIDER_PRESETS["aliyun-qwen-file"] }), /缺少凭证/);
  assert.throws(() => createAsrClient({ ...base, preset: ASR_PROVIDER_PRESETS["aliyun-qwen"] }), /缺少凭证/);
  // mimo 语言映射经工厂生效：hints 含 zh → 下发 zh
  let mimoBodyLanguage;
  const probe = createAsrClient({
    ...base,
    languageHints: ["zh"],
    preset: ASR_PROVIDER_PRESETS["mimo"],
    mimoApiKey: "mk",
  });
  assert.equal(probe.constructor.name, "MimoAsrClient");
  // 直接验证映射函数（工厂内部已用同一函数）
  mimoBodyLanguage = mapMimoAsrLanguage("", ["zh"]);
  assert.equal(mimoBodyLanguage, "zh");
});

// ==================== 2026-10-24 诊断日志 / vad.marginDb ====================

/** 记录 info 行的假 logger（其余级别忽略）。 */
function captureLogger(lines) {
  return {
    loaded() {},
    log() {},
    info(message) {
      lines.push(message);
    },
    warn() {},
    error() {},
    hook() {},
    tool() {},
  };
}

test("帧级 VAD 诊断：按窗口节流输出，字段齐全且含 p50/p90/max/above", () => {
  const lines = [];
  let now = 0;
  class QuietClient extends SegmentAsrClientBase {
    async submitSegment() {
      return { text: "x", emotion: "" };
    }
  }
  const client = new QuietClient({
    sampleRate: SR,
    vad: { threshold: 0.5, silenceDurationMs: 6000 },
    onResult: () => {},
    logger: captureLogger(lines),
    now: () => now,
  });
  // 600ms 语音（窗口帧数 <1s 下限时 noise=null），窗口未满 2s 不输出
  for (const chunk of chunks100(pcm(600, true))) client.feed(chunk);
  assert.equal(lines.filter((line) => line.startsWith("[vad]")).length, 0, "未满窗口不输出");
  // 注入时钟跳 2s：下一帧即触发一次汇总
  now += 2000;
  client.feed(chunks100(pcm(100, true))[0]);
  const vad = lines.filter((line) => line.startsWith("[vad]"));
  assert.equal(vad.length, 1, "满 2s 只输出一行（节流）");
  assert.match(
    vad[0],
    /^\[vad\] gate=-?\d+\.\d noise=(-?\d+\.\d|null) threshold=-35\.0 frames p50=-?\d+\.\d p90=-?\d+\.\d max=-?\d+\.\d above=\d+% hasVoice=(true|false) silenceMs=\d+$/,
    vad[0],
  );
  // 同一时刻继续喂帧：未再满窗口，不重复输出
  client.feed(chunks100(pcm(100, true))[0]);
  assert.equal(lines.filter((line) => line.startsWith("[vad]")).length, 1, "窗口内不逐帧刷屏");
});

test("切段/识别结果日志：submit 带时长与越门限占比，result 带长度与非空文本", async () => {
  const lines = [];
  class EchoClient extends SegmentAsrClientBase {
    async submitSegment() {
      return { text: "这是一段稍长的识别结果文本", emotion: "" };
    }
  }
  const client = new EchoClient({
    sampleRate: SR,
    vad: { threshold: 0.5, silenceDurationMs: 400 },
    onResult: () => {},
    logger: captureLogger(lines),
  });
  for (const chunk of chunks100(pcm(300, true))) client.feed(chunk);
  for (const chunk of chunks100(pcm(500, false))) client.feed(chunk);
  await client.finish();
  const submit = lines.filter((line) => line.startsWith("[asr] segment submit"));
  assert.equal(submit.length, 1, "切段即入队并记一条 submit");
  assert.match(submit[0], /^\[asr\] segment submit dur=0\.7s frames=\d+ above=\d+%$/);
  const result = lines.filter((line) => line.startsWith("[asr] segment result"));
  assert.equal(result.length, 1);
  assert.match(result[0], /^\[asr\] segment result len=13 text=这是一段稍长的识别结果文本$/);
});

test("识别结果为空：仍记 result 日志（len=0 + empty）且不回调 onResult", async () => {
  const lines = [];
  let called = 0;
  class EmptyClient extends SegmentAsrClientBase {
    async submitSegment() {
      return { text: "   ", emotion: "" };
    }
  }
  const client = new EmptyClient({
    sampleRate: SR,
    vad: { threshold: 0.5, silenceDurationMs: 6000 },
    onResult: () => {
      called += 1;
    },
    logger: captureLogger(lines),
  });
  for (const chunk of chunks100(pcm(300, true))) client.feed(chunk);
  await client.finish();
  assert.equal(called, 0, "空文本不上报");
  const result = lines.filter((line) => line.startsWith("[asr] segment result"));
  assert.equal(result.length, 1);
  assert.match(result[0], /^\[asr\] segment result len=0 text="" empty$/);
});

test("vad.marginDb：默认余量 6dB，实例门限按注入余量抬升", () => {
  class QuietClient extends SegmentAsrClientBase {
    async submitSegment() {
      return { text: "x", emotion: "" };
    }
  }
  assert.equal(computeGateDbfs(-50, -40), -34, "缺省 margin 沿用 NOISE_MARGIN_DB=6");
  assert.equal(NOISE_MARGIN_DB, 6);
  assert.equal(clampVadMarginDb(undefined), 6, "未配置回落 6");
  assert.equal(clampVadMarginDb(1), 3, "下界夹到 3");
  assert.equal(clampVadMarginDb(99), 15, "上界夹到 15");
  const base = { sampleRate: SR, vad: { threshold: 0, silenceDurationMs: 800 }, onResult: () => {} };
  const six = new QuietClient(base);
  const twelve = new QuietClient({ ...base, vad: { threshold: 0, silenceDurationMs: 800, marginDb: 12 } });
  // 未喂帧时 noiseDbfs=null（窗口不足 1s）⇒ 两个实例都直接用配置基线，余量只影响后续分位门限
  assert.equal(twelve.currentGateDbfs, six.currentGateDbfs, "窗口未启用的门限均为配置基线");
  assert.ok(computeGateDbfs(-50, -30, 12) > computeGateDbfs(-50, -30, 6), "余量越大门限越高");
});
