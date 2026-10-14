/**
 * ASR 参数桩：校验构造出的 `session.update` / `run-task` 完全来自配置，
 * 且**不包含**阿里云不存在的 `prefix_padding_ms`。
 *
 * 覆盖两种协议：realtime（qwen，turn_detection）与 inference（paraformer，run-task parameters）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildInferenceUrl,
  buildRealtimeUrl,
  buildRunTask,
  buildSessionUpdate,
} from "../dist/voice/aliyun.js";
import { ASR_PROVIDER_PRESETS } from "../dist/voice/config.js";

test("session.update（qwen）：无 prefix_padding_ms，threshold/silence/language 来自配置", () => {
  const message = buildSessionUpdate({
    sampleRate: 16000,
    language: "en",
    vad: { threshold: 0.8, silenceDurationMs: 1200 },
  });
  const session = message.session;
  assert.equal(message.type, "session.update");
  assert.equal(session.sample_rate, 16000);
  assert.deepEqual(session.turn_detection, {
    type: "server_vad",
    threshold: 0.8,
    silence_duration_ms: 1200,
  });
  assert.deepEqual(session.input_audio_transcription, { language: "en" });
  assert.equal(JSON.stringify(message).includes("prefix_padding_ms"), false);

  // 语言为空 → 不下发 language（自动识别）
  const auto = buildSessionUpdate({ sampleRate: 16000, language: "", vad: {} });
  assert.deepEqual(auto.session.input_audio_transcription, {});
  assert.equal(JSON.stringify(auto).includes('"language"'), false);
});

test("session.update：VAD 缺省取配置默认（0.5 / 800）", () => {
  const message = buildSessionUpdate({ sampleRate: 16000, language: "", vad: {} });
  assert.equal(message.session.turn_detection.threshold, 0.5);
  assert.equal(message.session.turn_detection.silence_duration_ms, 800);
});

test("run-task（paraformer-v2）：无 prefix_padding_ms，max_sentence_silence/language_hints 来自配置", () => {
  const preset = ASR_PROVIDER_PRESETS["aliyun-v2"];
  const message = buildRunTask({
    model: preset.model,
    sampleRate: preset.sampleRate,
    language: "en",
    vad: { threshold: 0.8, silenceDurationMs: 1500 },
    taskId: "task-1",
    extendedV2: preset.extendedV2,
  });
  assert.deepEqual(message.header, { action: "run-task", task_id: "task-1", streaming: "duplex" });
  assert.equal(message.payload.model, "paraformer-realtime-v2");
  assert.equal(message.payload.parameters.sample_rate, 16000);
  assert.equal(message.payload.parameters.max_sentence_silence, 1500);
  assert.equal(message.payload.parameters.semantic_punctuation_enabled, false);
  assert.deepEqual(message.payload.parameters.language_hints, ["en"]);
  assert.equal(JSON.stringify(message).includes("prefix_padding_ms"), false);
});

test("run-task（paraformer-8k）：采样率来自预设、不下发 v2 专有参数", () => {
  const preset = ASR_PROVIDER_PRESETS["aliyun-8k"];
  const message = buildRunTask({
    model: preset.model,
    sampleRate: preset.sampleRate,
    language: "zh",
    vad: { silenceDurationMs: 1500 },
    taskId: "t",
    extendedV2: preset.extendedV2,
  });
  assert.equal(message.payload.parameters.sample_rate, 8000);
  assert.equal("max_sentence_silence" in message.payload.parameters, false);
  assert.deepEqual(message.payload.parameters.language_hints, ["zh"]);
  assert.equal(JSON.stringify(message).includes("prefix_padding_ms"), false);
});

test("run-task：语言为空/不在 paraformer 支持集时不下发 language_hints", () => {
  const base = { model: "paraformer-realtime-v2", sampleRate: 16000, taskId: "t", extendedV2: true };
  assert.equal("language_hints" in buildRunTask({ ...base, language: "" }).payload.parameters, false);
  assert.equal("language_hints" in buildRunTask({ ...base, language: "th" }).payload.parameters, false);
});

test("run-task：显式 language_hints / vocabulary_id / context 来自参数", () => {
  const message = buildRunTask({
    model: "paraformer-realtime-v2",
    sampleRate: 16000,
    language: "zh",
    languageHints: ["en", "ja", "th"],
    vocabularyId: "vocab-1",
    context: "客服领域上下文",
    taskId: "t",
    extendedV2: true,
  });
  assert.deepEqual(message.payload.parameters.language_hints, ["en", "ja"], "仅保留下发支持的语种");
  assert.equal(message.payload.parameters.vocabulary_id, "vocab-1");
  assert.equal(message.payload.input.context, "客服领域上下文");
});

test("run-task：未给增强参数时不出现对应字段", () => {
  const message = buildRunTask({
    model: "paraformer-realtime-v2",
    sampleRate: 16000,
    language: "",
    taskId: "t",
    extendedV2: true,
  });
  assert.equal("language_hints" in message.payload.parameters, false);
  assert.equal("vocabulary_id" in message.payload.parameters, false);
  assert.equal("context" in message.payload.input, false);
});

test("端点拼接：realtime 带 model 查询、inference 固定路径", () => {
  assert.equal(
    buildRealtimeUrl("ws1", "qwen3-asr-flash-realtime"),
    "wss://ws1.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen3-asr-flash-realtime",
  );
  assert.equal(
    buildInferenceUrl("ws1"),
    "wss://ws1.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference",
  );
});
