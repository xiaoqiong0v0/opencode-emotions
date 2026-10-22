/**
 * MiMo TTS provider 离线单测（不触网、不真实播放）。
 *
 * 覆盖：注册表认识 mimo 且默认 provider 不变、凭证解析 env>配置>报错（不含明文）、
 * SSE chunk 解析 / base64→PCM（mock fetch 固定样例流）、情绪→user 指令拼装、
 * 请求体构造（assistant 放正文）、空文本/缺 Key 抛错、stop 幂等。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_PROVIDER,
  MiMoProvider,
  buildMimoMessages,
  buildMimoRequestBody,
  extractMimoAudioPcm,
  getProvider,
  resolveMimoParams,
  speak,
  streamMimoPcm,
} from "../dist/voice/tts/index.js";
import {
  DEFAULT_MIMO_MODEL,
  DEFAULT_MIMO_VOICE,
  MIMO_API_URL,
  MIMO_RATE_HINT_FAST,
  MIMO_RATE_HINT_SLOW,
  MIMO_SAMPLE_RATE,
  MIMO_STREAM_FORMAT,
} from "../dist/voice/tts/mimo.js";
import { ENV_MIMO_API_KEY, resolveMimoApiKey } from "../dist/voice/credentials.js";
import { DEFAULT_VOICE_CONFIG } from "../dist/voice/config.js";
import { TTS_PROVIDER_CAPABILITIES, resolveTtsConfig } from "../dist/voice/tts/types.js";

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
    streamMinChars: 5,
    ...overrides,
  };
}

test("registry：认识 mimo 且默认 provider 不变（sapi）", () => {
  assert.equal(getProvider("mimo").name, "mimo");
  assert.equal(getProvider("mimo"), getProvider("mimo"), "按名缓存单实例");
  assert.equal(DEFAULT_PROVIDER, "sapi", "默认 provider 不因 mimo 引入而改变");
  assert.equal(resolveTtsConfig({ text: "x" }, {}).provider, "sapi");
  assert.equal(resolveTtsConfig({ text: "x" }, { TTS_PROVIDER: "mimo" }).provider, "mimo");
  assert.equal(TTS_PROVIDER_CAPABILITIES.mimo.instruction, true);
  assert.equal(TTS_PROVIDER_CAPABILITIES.mimo.format, false);
  assert.equal(TTS_PROVIDER_CAPABILITIES.mimo.sampleRate, false);
  assert.equal(MIMO_SAMPLE_RATE, 24000);
  assert.equal(MIMO_STREAM_FORMAT, "pcm16");
  assert.equal(MIMO_API_URL, "https://api.xiaomimimo.com/v1/chat/completions");
});

test("resolveMimoApiKey：env > 配置 > 报错，错误信息不含密钥", () => {
  // env 优先于配置
  assert.equal(
    resolveMimoApiKey({ env: { [ENV_MIMO_API_KEY]: "env-key" }, config: { apiKey: "cfg-key" } }),
    "env-key",
  );
  // 仅配置
  assert.equal(resolveMimoApiKey({ env: {}, config: { apiKey: "cfg-key" } }), "cfg-key");
  // 空白视为缺失
  assert.equal(resolveMimoApiKey({ env: { [ENV_MIMO_API_KEY]: "  " }, config: { apiKey: " k " } }), "k");
  // 两级都缺 → 抛配置引导错误且不含任何密钥痕迹
  assert.throws(
    () => resolveMimoApiKey({ env: {}, config: { apiKey: "" } }),
    (err) => /未配置 MiMo 凭证/.test(err.message) && !/apiKey=/.test(err.message) && !err.message.includes("sk-"),
  );
  // 错误信息不得回显配置里可能存在的半截值
  assert.throws(
    () => resolveMimoApiKey({ env: {}, config: {} }),
    (err) => !err.message.includes("cfg-"),
  );
});

test("buildMimoMessages：正文放 assistant，风格指令放 user（情绪→user 指令拼装）", () => {
  // 无指令：仅 assistant 一条
  assert.deepEqual(buildMimoMessages("你好", ""), [{ role: "assistant", content: "你好" }]);
  // 有指令：user 在前、assistant 在后
  assert.deepEqual(buildMimoMessages("正文", "用开心的语气说"), [
    { role: "user", content: "用开心的语气说" },
    { role: "assistant", content: "正文" },
  ]);
});

test("resolveMimoParams：默认值 + 情绪 instruction 保留 + 非 0 语速并入风格指令", () => {
  const d = resolveMimoParams(fullOptions());
  assert.equal(d.model, DEFAULT_MIMO_MODEL);
  assert.equal(d.voice, DEFAULT_MIMO_VOICE);
  assert.equal(d.instruction, "");

  // 情绪映射出的中文指令（resolveTtsConfig 已映射）作为风格指令
  const emo = resolveMimoParams(fullOptions({ instruction: "用悲伤的语气说" }));
  assert.equal(emo.instruction, "用悲伤的语气说");

  // 正语速并入「稍快」
  const fast = resolveMimoParams(fullOptions({ rate: 3 }));
  assert.equal(fast.instruction, MIMO_RATE_HINT_FAST);
  // 负语速并入「稍慢」
  const slow = resolveMimoParams(fullOptions({ rate: -2 }));
  assert.equal(slow.instruction, MIMO_RATE_HINT_SLOW);
  // instruction + rate 合并
  const both = resolveMimoParams(fullOptions({ instruction: "用开心的语气说", rate: 2 }));
  assert.equal(both.instruction, `用开心的语气说；${MIMO_RATE_HINT_FAST}`);
  // 覆盖 model/voice
  const o = resolveMimoParams(fullOptions({ model: "custom-model", voice: "茉莉" }));
  assert.equal(o.model, "custom-model");
  assert.equal(o.voice, "茉莉");
});

test("情绪端到端：--emotion happy → user 消息内容为中文风格指令", () => {
  const cfg = resolveTtsConfig({ text: "测试", emotion: "happy", provider: "mimo" }, {});
  assert.equal(cfg.instruction, "用开心的语气说");
  const messages = buildMimoMessages(cfg.text, resolveMimoParams(fullOptions({ instruction: cfg.instruction })).instruction);
  assert.deepEqual(messages[0], { role: "user", content: "用开心的语气说" });
  assert.deepEqual(messages[messages.length - 1], { role: "assistant", content: "测试" });
});

test("buildMimoRequestBody：stream/pcm16/voice/model 与消息装配", () => {
  const body = buildMimoRequestBody({ model: DEFAULT_MIMO_MODEL, voice: "冰糖", text: "你好", instruction: "用开心的语气说" });
  assert.equal(body.stream, true);
  assert.equal(body.model, DEFAULT_MIMO_MODEL);
  assert.deepEqual(body.audio, { format: "pcm16", voice: "冰糖" });
  assert.deepEqual(body.messages, [
    { role: "user", content: "用开心的语气说" },
    { role: "assistant", content: "你好" },
  ]);
});

test("extractMimoAudioPcm：base64 delta.audio.data → PCM 字节；缺字段返回 null", () => {
  const pcm = Buffer.from([1, 0, 2, 0, 255, 128]);
  const chunk = { choices: [{ delta: { audio: { data: pcm.toString("base64") } } }] };
  assert.deepEqual(extractMimoAudioPcm(chunk), pcm);
  assert.equal(extractMimoAudioPcm({ choices: [{ delta: {} }] }), null);
  assert.equal(extractMimoAudioPcm({ choices: [] }), null);
  assert.equal(extractMimoAudioPcm(null), null);
  assert.equal(extractMimoAudioPcm({ choices: [{ delta: { audio: { data: "" } } }] }), null);
});

test("streamMimoPcm：mock fetch 固定 SSE 样例流 → 逐 chunk 解出 PCM（base64→PCM）", async () => {
  const pcm1 = Buffer.from([1, 0, 2, 0]);
  const pcm2 = Buffer.from([3, 0, 4, 0]);
  const sse = [
    `data: ${JSON.stringify({ choices: [{ delta: { audio: { data: pcm1.toString("base64") } } }] })}`,
    "",
    `data: ${JSON.stringify({ choices: [{ delta: { audio: { data: pcm2.toString("base64") } } }] })}`,
    "",
    // 非音频 chunk（如文本 delta）应被跳过、不中断
    `data: ${JSON.stringify({ choices: [{ delta: { content: "x" } }] })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const received = [];
  let capturedInit;
  const fetchImpl = async (url, init) => {
    capturedInit = { url, init };
    return new Response(sse, { status: 200 });
  };
  await streamMimoPcm({
    apiKey: "test-key",
    body: buildMimoRequestBody({ model: DEFAULT_MIMO_MODEL, voice: "冰糖", text: "你好", instruction: "" }),
    signal: new AbortController().signal,
    fetchImpl,
    onAudio: (chunk) => received.push(chunk),
  });
  assert.equal(capturedInit.url, MIMO_API_URL);
  assert.equal(capturedInit.init.method, "POST");
  assert.equal(capturedInit.init.headers.Authorization, "Bearer test-key");
  const sent = JSON.parse(capturedInit.init.body);
  assert.equal(sent.stream, true);
  assert.deepEqual(received, [pcm1, pcm2], "按到达顺序解出两段 PCM，文本 delta 被跳过");
});

test("streamMimoPcm：HTTP 非 2xx 抛错且脱敏（不含密钥）", async () => {
  const secret = "sk-mimo-super-secret";
  const fetchImpl = async () => new Response(`unauthorized ${secret}`, { status: 401 });
  await assert.rejects(
    streamMimoPcm({
      apiKey: secret,
      body: {},
      signal: new AbortController().signal,
      fetchImpl,
      onAudio: () => {},
    }),
    (err) => /401/.test(err.message) && !err.message.includes(secret) && err.message.includes("***"),
  );
});

test("MiMoProvider：空文本抛错、缺 Key 抛清晰错误、stop 幂等（不触网）", () => {
  const provider = new MiMoProvider();
  assert.throws(() => provider.speak(fullOptions({ text: "   ", mimoApiKey: "k" })), /text 不能为空/);
  assert.throws(() => provider.speak(fullOptions({ mimoApiKey: "" })), /未配置 MiMo 凭证/);
  assert.throws(() => provider.speak(fullOptions()), /未配置 MiMo 凭证/);
  assert.doesNotThrow(() => provider.stop());
  assert.doesNotThrow(() => provider.stop(), "stop 可重复调用");
});

test("speak 接线：provider=mimo 时转发 mimoApiKey（env > tts.mimoCredentials）", () => {
  const config = structuredClone(DEFAULT_VOICE_CONFIG);
  config.tts.provider = "mimo";
  config.tts.mimoCredentials = { apiKey: "cfg-mimo-key" };
  const provider = getProvider("mimo");
  const original = provider.speak;
  let captured;
  provider.speak = (options) => {
    captured = options;
    return { provider: "mimo", voice: "", rate: 0 };
  };
  try {
    // 仅配置
    speak({ text: "测试" }, { env: {}, config });
    assert.equal(captured.mimoApiKey, "cfg-mimo-key");
    // env 优先于配置
    speak({ text: "测试" }, { env: { MIMO_API_KEY: "env-mimo-key" }, config });
    assert.equal(captured.mimoApiKey, "env-mimo-key");
    // aliyun 配置不串扰：provider 仍能拿到自己的 key，且不读 aliyun workspace
    config.asr.credentials = { path: "", apiKey: "asr-key", workspaceId: "asr-ws" };
    config.tts.credentials = { path: "", apiKey: "tts-key", workspaceId: "tts-ws" };
    speak({ text: "测试" }, { env: {}, config });
    assert.equal(captured.mimoApiKey, "cfg-mimo-key");
    assert.deepEqual(captured.credentials, config.tts.credentials, "aliyun 凭证照常转发、互不影响");
  } finally {
    provider.speak = original;
  }
});

test("speak 接线：provider=mimo 缺 Key 时在 speak() 入口即抛清晰错误", () => {
  const config = structuredClone(DEFAULT_VOICE_CONFIG);
  config.tts.provider = "mimo";
  config.tts.mimoCredentials = { apiKey: "" };
  assert.throws(
    () => speak({ text: "测试" }, { env: {}, config }),
    /未配置 MiMo 凭证/,
  );
});
