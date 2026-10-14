/**
 * TTS provider 层离线单测（不触发真实播放/网络）。
 *
 * 覆盖：语速夹取、配置解析优先级（含新增指令/音高/音量/格式/采样率/模型）、
 * 不支持参数的忽略判定、SAPI 脚本/环境约定、CosyVoice 纯函数消息构造、provider 注册表与错误路径。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AliyunProvider,
  DEFAULT_PROVIDER,
  DEFAULT_RATE,
  MAX_RATE,
  MIN_RATE,
  SAPI_SCRIPT,
  buildSapiEnv,
  clampRate,
  getProvider,
  ignoredTtsParams,
  resolveTtsConfig,
  speak,
  stopAll,
} from "../dist/voice/tts/index.js";
import {
  buildCosyVoiceContinueTask,
  buildCosyVoiceFinishTask,
  buildCosyVoiceRunTask,
  buildTtsUrl,
  normalizeWavHeader,
  resolveCosyVoiceParams,
} from "../dist/voice/tts/aliyun.js";
import { DEFAULT_VOICE_CONFIG } from "../dist/voice/config.js";

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

test("clampRate：区间夹取与非法值回退", () => {
  assert.equal(clampRate(5, 0), 5);
  assert.equal(clampRate(MIN_RATE - 5, 0), MIN_RATE);
  assert.equal(clampRate(MAX_RATE + 5, 0), MAX_RATE);
  assert.equal(clampRate(Number.NaN, 0), 0);
  assert.equal(clampRate(Number.POSITIVE_INFINITY, 0), 0);
  assert.equal(clampRate(2.9, 0), 2);
});

test("resolveTtsConfig：默认值", () => {
  const cfg = resolveTtsConfig({ text: "你好" }, {});
  assert.equal(cfg.provider, DEFAULT_PROVIDER);
  assert.equal(cfg.voice, "");
  assert.equal(cfg.rate, DEFAULT_RATE);
  assert.equal(cfg.instruction, "");
  assert.equal(cfg.pitch, 0);
  assert.equal(cfg.volume, 0);
  assert.equal(cfg.format, "");
  assert.equal(cfg.sampleRate, 0);
  assert.equal(cfg.model, "");
  assert.equal(cfg.text, "你好");
});

test("resolveTtsConfig：环境变量生效（provider 小写、音色去空白、语速解析）", () => {
  const cfg = resolveTtsConfig(
    { text: "hi" },
    { TTS_PROVIDER: "Aliyun", TTS_VOICE: "  Microsoft Huihui  ", TTS_RATE: "3" },
  );
  assert.equal(cfg.provider, "aliyun");
  assert.equal(cfg.voice, "Microsoft Huihui");
  assert.equal(cfg.rate, 3);
});

test("resolveTtsConfig：工具参数优先于环境变量，非法语速回退默认", () => {
  const cfg = resolveTtsConfig(
    { text: "hi", voice: "Microsoft Yaoyao", rate: 99 },
    { TTS_VOICE: "ignored", TTS_RATE: "1" },
  );
  assert.equal(cfg.voice, "Microsoft Yaoyao");
  assert.equal(cfg.rate, MAX_RATE);

  const bad = resolveTtsConfig({ text: "x" }, { TTS_RATE: "abc" });
  assert.equal(bad.rate, DEFAULT_RATE);
});

test("resolveTtsConfig：文件配置优先级低于环境变量、高于内置默认", () => {
  const fromFile = resolveTtsConfig({ text: "hi" }, {}, { provider: "ALIYUN", voice: "FileVoice", rate: 4 });
  assert.equal(fromFile.provider, "aliyun");
  assert.equal(fromFile.voice, "FileVoice");
  assert.equal(fromFile.rate, 4);

  const fromEnv = resolveTtsConfig(
    { text: "hi" },
    { TTS_VOICE: "EnvVoice", TTS_RATE: "1" },
    { voice: "FileVoice", rate: 4 },
  );
  assert.equal(fromEnv.voice, "EnvVoice");
  assert.equal(fromEnv.rate, 1);

  const fromTool = resolveTtsConfig(
    { text: "hi", voice: "ToolVoice", rate: -3 },
    { TTS_VOICE: "EnvVoice" },
    { voice: "FileVoice" },
  );
  assert.equal(fromTool.voice, "ToolVoice");
  assert.equal(fromTool.rate, -3);
});

test("resolveTtsConfig：新增字段来自环境变量与文件（环境变量优先）", () => {
  const cfg = resolveTtsConfig(
    { text: "hi" },
    {
      TTS_INSTRUCTION: "用四川话",
      TTS_PITCH: "1.5",
      TTS_VOLUME: "80",
      TTS_FORMAT: "mp3",
      TTS_SAMPLE_RATE: "24000",
      TTS_MODEL: "cosyvoice-v3-plus",
    },
    { instruction: "文件值", pitch: 0.5, volume: 30, format: "wav", sampleRate: 16000, model: "file-model" },
  );
  assert.equal(cfg.instruction, "用四川话");
  assert.equal(cfg.pitch, 1.5);
  assert.equal(cfg.volume, 80);
  assert.equal(cfg.format, "mp3");
  assert.equal(cfg.sampleRate, 24000);
  assert.equal(cfg.model, "cosyvoice-v3-plus");

  // 仅文件值生效
  const fromFile = resolveTtsConfig({ text: "hi" }, {}, { instruction: "x", pitch: 0.8, format: "opus" });
  assert.equal(fromFile.instruction, "x");
  assert.equal(fromFile.pitch, 0.8);
  assert.equal(fromFile.format, "opus");
});

test("ignoredTtsParams：sapi 忽略云专有参数，aliyun 全部支持", () => {
  const cloudOnly = fullOptions({ instruction: "x", pitch: 1.2, format: "mp3", sampleRate: 24000, model: "m" });
  assert.deepEqual(ignoredTtsParams("sapi", cloudOnly).sort(), ["format", "instruction", "model", "pitch", "sampleRate"]);
  assert.deepEqual(ignoredTtsParams("aliyun", cloudOnly), []);
  // 未设置时 sapi 不报忽略
  assert.deepEqual(ignoredTtsParams("sapi", fullOptions()), []);
});

test("resolveCosyVoiceParams：默认值、覆盖与越界回退", () => {
  const d = resolveCosyVoiceParams(fullOptions());
  assert.equal(d.model, "cosyvoice-v2");
  assert.equal(d.voice, "longxiaochun_v2");
  assert.equal(d.format, "wav");
  assert.equal(d.sampleRate, 22050);
  assert.equal(d.volume, 50);
  assert.equal(d.rate, 1.0);
  assert.equal(d.pitch, 1.0);
  assert.equal(d.instruction, "");

  const o = resolveCosyVoiceParams(
    fullOptions({ voice: "longanhuan_v3", model: "cosyvoice-v3-plus", format: "mp3", sampleRate: 48000, volume: 120, rate: 5, pitch: 0.1, instruction: "情感：开心" }),
  );
  assert.equal(o.voice, "longanhuan_v3");
  assert.equal(o.model, "cosyvoice-v3-plus");
  assert.equal(o.format, "mp3");
  assert.equal(o.sampleRate, 48000);
  assert.equal(o.volume, 100, "音量夹到上界");
  assert.equal(o.rate, 2.0, "语速夹到上界");
  assert.equal(o.pitch, 0.5, "音高夹到下界");
  assert.equal(o.instruction, "情感：开心");

  // 非法格式/采样率回退默认
  const bad = resolveCosyVoiceParams(fullOptions({ format: "aac", sampleRate: 12345 }));
  assert.equal(bad.format, "wav");
  assert.equal(bad.sampleRate, 22050);
});

test("buildCosyVoiceRunTask：参数来自配置，instruction 为空时不出现", () => {
  const params = resolveCosyVoiceParams(fullOptions({ voice: "longanyang", instruction: "方言：粤语" }));
  const message = buildCosyVoiceRunTask({ taskId: "t-1", ...params });
  assert.deepEqual(message.header, { action: "run-task", task_id: "t-1", streaming: "duplex" });
  assert.equal(message.payload.task, "tts");
  assert.equal(message.payload.function, "SpeechSynthesizer");
  assert.equal(message.payload.model, "cosyvoice-v2");
  assert.equal(message.payload.parameters.text_type, "PlainText");
  assert.equal(message.payload.parameters.voice, "longanyang");
  assert.equal(message.payload.parameters.format, "wav");
  assert.equal(message.payload.parameters.sample_rate, 22050);
  assert.equal(message.payload.parameters.volume, 50);
  assert.equal(message.payload.parameters.rate, 1.0);
  assert.equal(message.payload.parameters.pitch, 1.0);
  assert.equal(message.payload.parameters.instruction, "方言：粤语");

  const plain = buildCosyVoiceRunTask({ taskId: "t-2", ...resolveCosyVoiceParams(fullOptions()) });
  assert.equal("instruction" in plain.payload.parameters, false);
});

test("buildCosyVoiceContinueTask / finishTask：结构与正文", () => {
  assert.deepEqual(buildCosyVoiceContinueTask("t", "你好世界"), {
    header: { action: "continue-task", task_id: "t", streaming: "duplex" },
    payload: { input: { text: "你好世界" } },
  });
  assert.deepEqual(buildCosyVoiceFinishTask("t"), {
    header: { action: "finish-task", task_id: "t", streaming: "duplex" },
    payload: { input: {} },
  });
  assert.equal(buildTtsUrl("ws1"), "wss://ws1.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference");
});

/** 小端 uint32。 */
function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}

/**
 * 构造一个"流式风格" WAV：RIFF/data 长度字段为占位值（复刻 CosyVoice 的实际返回）。
 * @param dataBytes 实际数据区长度
 * @returns WAV 字节
 */
function streamingWav(dataBytes) {
  const head = Buffer.concat([Buffer.from("RIFF"), u32(0x7fffffbf), Buffer.from("WAVE")]);
  const fmt = Buffer.concat([
    Buffer.from("fmt "),
    u32(16),
    Buffer.concat([u32(0x00010001), u32(22050), u32(44100), Buffer.from([0x02, 0x00, 0x10, 0x00])]),
  ]);
  const data = Buffer.concat([Buffer.from("data"), u32(0x7fffff9b), Buffer.alloc(dataBytes)]);
  return Buffer.concat([head, fmt, data]);
}

test("normalizeWavHeader：修正流式 WAV 的占位长度，幂等且不改入参", () => {
  const buf = streamingWav(1000);
  const fixed = normalizeWavHeader(buf);
  assert.equal(fixed.readUInt32LE(40), 1000, "data 块长度改为实际数据字节数");
  assert.equal(fixed.readUInt32LE(4), fixed.length - 8, "RIFF 总长改为 文件长度-8");
  assert.equal(buf.readUInt32LE(40), 0x7fffff9b, "入参不被改动");

  assert.deepEqual(normalizeWavHeader(fixed), fixed, "对已修正的 WAV 幂等");
  assert.throws(() => normalizeWavHeader(Buffer.from("not a wav")), /不是合法/);
});

test("SAPI：脚本走环境变量、文本 base64 中文可还原、音量条件下发", () => {
  assert.match(SAPI_SCRIPT, /System\.Speech/);
  assert.match(SAPI_SCRIPT, /FromBase64String/);
  assert.match(SAPI_SCRIPT, /\.Volume/);
  const env = buildSapiEnv({ text: "你好，世界", voice: "Microsoft Huihui", rate: 0 }, {});
  assert.equal(Buffer.from(env.OC_TTS_TEXT_B64, "base64").toString("utf8"), "你好，世界");
  assert.equal(env.OC_TTS_VOICE, "Microsoft Huihui");
  assert.equal(env.OC_TTS_RATE, "0");
  assert.equal("OC_TTS_VOLUME" in env, false, "音量未指定时不下发");

  const loud = buildSapiEnv(fullOptions({ volume: 130, text: "x" }), {});
  assert.equal(loud.OC_TTS_VOLUME, "100", "音量夹到上界");
});

test("provider 注册表：按名缓存、未知抛错", () => {
  assert.equal(getProvider("sapi").name, "sapi");
  assert.equal(getProvider("aliyun").name, "aliyun");
  assert.equal(getProvider("sapi"), getProvider("sapi"));
  assert.throws(() => getProvider("nope"), /未知 TTS provider/);
});

test("speak 错误路径：未知 provider 抛错、不抛给会话（由工具层兜底）", () => {
  assert.throws(
    () => speak({ text: "x" }, { env: { TTS_PROVIDER: "nope" }, config: DEFAULT_VOICE_CONFIG }),
    /未知 TTS provider/,
  );
  assert.doesNotThrow(() => stopAll());
});

test("AliyunProvider：空文本抛错、stop 幂等（不触网）", () => {
  assert.throws(() => new AliyunProvider().speak(fullOptions({ text: "   " })), /text 不能为空/);
  assert.doesNotThrow(() => new AliyunProvider().stop());
});
