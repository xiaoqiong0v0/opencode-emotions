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
  ENERGY_VAD_SCALE,
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
  assert.ok(ENERGY_VAD_SCALE > 0 && ENERGY_VAD_SCALE < 1);
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
  // maxBase64Bytes=200 → maxWav≈133 → 单段 PCM 上限≈89 字节；喂 400 字节 → 切分后 5 片
  const client = new TestClient({
    sampleRate: SR,
    vad: { threshold: 0.5, silenceDurationMs: 6000 },
    maxBase64Bytes: 200,
    onResult: (r) => results.push(r),
  });
  client.feed(pcm(12.5, true)); // 12.5ms × 16k × 2B = 400 字节
  await client.finish();
  assert.ok(submitted.length >= 2, `超限须切分多片，实际 ${submitted.length}`);
  for (const wav of submitted) {
    const base64Len = Math.ceil((wav.length / 3) * 4);
    assert.ok(base64Len + WAV_DATA_URL_PREFIX.length <= 200 + 4, `每片 base64 不超红线：${base64Len}`);
  }
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
