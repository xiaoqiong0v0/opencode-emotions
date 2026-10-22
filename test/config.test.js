/**
 * 语音配置离线单测：JSONC 解析、配置目录解析、首次写默认、合并/校验、环境变量覆盖、坏文件降级。
 *
 * 测试对象为构建产物 dist/；所有文件操作都在系统临时目录内，不触碰真实配置目录。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveConfigDir } from "../dist/lib/config-dir.js";
import { parseJsonc, stripJsoncComments, stripTrailingCommas } from "../dist/lib/jsonc.js";
import {
  ASR_PROVIDER_PRESETS,
  CONFIG_FILE_NAME,
  DEFAULT_ASR_PROVIDER,
  DEFAULT_CONFIG_TEMPLATE,
  DEFAULT_VOICE_CONFIG,
  ENV_CONFIG_DIR,
  ENV_LANGUAGE,
  ENV_TOOL_LANGUAGE,
  ENV_UI_LANGUAGE,
  LEGACY_CONFIG_FILE_NAME,
  LEGACY_ENV_CONFIG_DIR,
  legacyVoiceConfigPath,
  loadVoiceConfig,
  resolveAsrParams,
  resolveAsrProvider,
  voiceConfigPath,
} from "../dist/voice/config.js";

/** 建一个隔离的临时配置目录。 */
function tempDir() {
  return mkdtempSync(join(tmpdir(), "voice-cfg-"));
}

test("jsonc：注释与尾逗号可解析，字符串内 // 保留", () => {
  const text = `{
    // 行注释
    "a": 1, /* 块注释 */
    "b": "http://x//y", // 尾随
    "c": [1, 2,],
  }`;
  assert.deepEqual(parseJsonc(text), { a: 1, b: "http://x//y", c: [1, 2] });
  assert.equal(stripJsoncComments('"// not comment" // real').includes("// not comment"), true);
  assert.equal(stripTrailingCommas("{ a: 1, }".replace(/([a-z])/g, '"$1"')), '{ "a": 1 }');
});

test("resolveConfigDir：显式注入 > 环境变量 > 默认", () => {
  assert.equal(resolveConfigDir({ injected: "C:/x" }), "C:/x");
  // 环境变量未设置时回退到默认目录
  delete process.env.UNIT_CFG_DIR;
  assert.equal(resolveConfigDir({ envName: "UNIT_CFG_DIR" }), resolveConfigDir());
  process.env.UNIT_CFG_DIR = "D:/from-env";
  try {
    assert.equal(resolveConfigDir({ envName: "UNIT_CFG_DIR" }), "D:/from-env");
  } finally {
    delete process.env.UNIT_CFG_DIR;
  }
  // envNames：按顺序取第一个非空（新名优先于旧名）
  delete process.env.UNIT_NEW_DIR;
  delete process.env.UNIT_OLD_DIR;
  try {
    process.env.UNIT_OLD_DIR = "D:/old";
    assert.equal(resolveConfigDir({ envNames: ["UNIT_NEW_DIR", "UNIT_OLD_DIR"] }), "D:/old", "新名未设则取旧名");
    process.env.UNIT_NEW_DIR = "D:/new";
    assert.equal(resolveConfigDir({ envNames: ["UNIT_NEW_DIR", "UNIT_OLD_DIR"] }), "D:/new", "新名优先");
  } finally {
    delete process.env.UNIT_NEW_DIR;
    delete process.env.UNIT_OLD_DIR;
  }
  // 默认：以 .config/opencode 结尾
  assert.match(resolveConfigDir(), /\.config[\\/]opencode$/);
});

test("DEFAULT_CONFIG_TEMPLATE 与 DEFAULT_VOICE_CONFIG 等价（防漂移）", () => {
  assert.deepEqual(parseJsonc(DEFAULT_CONFIG_TEMPLATE), DEFAULT_VOICE_CONFIG);
});

test("loadVoiceConfig：文件缺失 → 写出默认文件并返回默认值", () => {
  const dir = tempDir();
  try {
    const path = join(dir, CONFIG_FILE_NAME);
    assert.equal(existsSync(path), false);
    const cfg = loadVoiceConfig({ configDir: dir, env: {} });
    assert.deepEqual(cfg, DEFAULT_VOICE_CONFIG);
    assert.equal(existsSync(path), true, "首次运行应写出默认文件");
    assert.deepEqual(parseJsonc(readFileSync(path, "utf8")), DEFAULT_VOICE_CONFIG);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("命名约定：配置文件名与插件同名，旧名仅作兼容", () => {
  assert.equal(CONFIG_FILE_NAME, "emotions.jsonc");
  assert.equal(LEGACY_CONFIG_FILE_NAME, "voice.jsonc");
  assert.equal(ENV_CONFIG_DIR, "EMOTIONS_CONFIG_DIR");
  assert.equal(LEGACY_ENV_CONFIG_DIR, "VOICE_CONFIG_DIR");
});

test("语言两键：默认均 en", () => {
  assert.equal(DEFAULT_VOICE_CONFIG.uiLanguage, "en");
  assert.equal(DEFAULT_VOICE_CONFIG.toolLanguage, "en");
  const dir = tempDir();
  try {
    const cfg = loadVoiceConfig({ configDir: dir, env: {} });
    assert.deepEqual([cfg.uiLanguage, cfg.toolLanguage], ["en", "en"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("语言两键：互相独立（一个被文件覆盖不影响另一个，另一侧用默认 en）", () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, CONFIG_FILE_NAME), `{ "uiLanguage": "zh" }`, "utf8");
    let cfg = loadVoiceConfig({ configDir: dir, env: {} });
    assert.equal(cfg.uiLanguage, "zh");
    assert.equal(cfg.toolLanguage, "en", "toolLanguage 不受 uiLanguage 影响");
    writeFileSync(join(dir, CONFIG_FILE_NAME), `{ "toolLanguage": "zh" }`, "utf8");
    cfg = loadVoiceConfig({ configDir: dir, env: {} });
    assert.equal(cfg.uiLanguage, "en", "uiLanguage 不受 toolLanguage 影响");
    assert.equal(cfg.toolLanguage, "zh");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("语言两键：旧键 language 兜底（新键缺→language；新键在则优先）", () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, CONFIG_FILE_NAME), `{ "language": "en" }`, "utf8");
    let cfg = loadVoiceConfig({ configDir: dir, env: {} });
    assert.deepEqual([cfg.uiLanguage, cfg.toolLanguage], ["en", "en"], "旧键兜底两者");
    writeFileSync(join(dir, CONFIG_FILE_NAME), `{ "language": "en", "uiLanguage": "zh" }`, "utf8");
    cfg = loadVoiceConfig({ configDir: dir, env: {} });
    assert.deepEqual([cfg.uiLanguage, cfg.toolLanguage], ["zh", "en"], "新键优先于旧键，缺的那侧仍兜底");
    writeFileSync(join(dir, CONFIG_FILE_NAME), `{ "uiLanguage": 42 }`, "utf8");
    cfg = loadVoiceConfig({ configDir: dir, env: {} });
    assert.deepEqual([cfg.uiLanguage, cfg.toolLanguage], ["en", "en"], "非字符串按缺失处理→兜底链");
    writeFileSync(join(dir, CONFIG_FILE_NAME), `{ "uiLanguage": "xx" }`, "utf8");
    cfg = loadVoiceConfig({ configDir: dir, env: {} });
    assert.equal(cfg.uiLanguage, "en", "非法字符串回退默认 en");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("语言两键：环境变量优先级（新名 > 旧名 VOICE_LANGUAGE > 文件）", () => {
  assert.equal(ENV_UI_LANGUAGE, "VOICE_UI_LANGUAGE");
  assert.equal(ENV_TOOL_LANGUAGE, "VOICE_TOOL_LANGUAGE");
  assert.equal(ENV_LANGUAGE, "VOICE_LANGUAGE");
  const dir = tempDir();
  try {
    writeFileSync(join(dir, CONFIG_FILE_NAME), `{ "language": "en" }`, "utf8");
    // 旧 env：兜底两者，且覆盖文件
    let cfg = loadVoiceConfig({ configDir: dir, env: { VOICE_LANGUAGE: "zh" } });
    assert.deepEqual([cfg.uiLanguage, cfg.toolLanguage], ["zh", "zh"], "旧 env 兜底两者且优先于文件");
    // 新 env：各自覆盖，缺的那侧回落旧 env
    cfg = loadVoiceConfig({ configDir: dir, env: { VOICE_UI_LANGUAGE: "zh", VOICE_LANGUAGE: "en" } });
    assert.deepEqual([cfg.uiLanguage, cfg.toolLanguage], ["zh", "en"], "新名优先，旧名兜底另一侧");
    // 新 env 单独覆盖一侧，另一侧回落文件旧键 language
    cfg = loadVoiceConfig({ configDir: dir, env: { VOICE_TOOL_LANGUAGE: "zh" } });
    assert.deepEqual([cfg.uiLanguage, cfg.toolLanguage], ["en", "zh"], "文件值仍生效");
    // 大小写/区域码归一 + 非法值回退默认
    cfg = loadVoiceConfig({ configDir: dir, env: { VOICE_UI_LANGUAGE: "EN-US", VOICE_TOOL_LANGUAGE: "bogus" } });
    assert.deepEqual([cfg.uiLanguage, cfg.toolLanguage], ["en", "en"], "区域码归一；非法回退默认 en");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadVoiceConfig：新名缺失 + 旧名存在 → 原样复制为 emotions.jsonc（用户值保留、旧文件不删）", () => {
  const dir = tempDir();
  try {
    const legacy = join(dir, LEGACY_CONFIG_FILE_NAME);
    const legacyText = `{ "tts": { "provider": "aliyun", "voice": "longxiaochun_v2" } }`;
    writeFileSync(legacy, legacyText, "utf8");
    const cfg = loadVoiceConfig({ configDir: dir, env: {} });
    assert.equal(cfg.tts.provider, "aliyun", "用户已改值保留");
    assert.equal(cfg.tts.voice, "longxiaochun_v2", "用户已改值保留");
    assert.equal(cfg.asr.provider, DEFAULT_VOICE_CONFIG.asr.provider, "未给字段仍回落默认");
    const migrated = join(dir, CONFIG_FILE_NAME);
    assert.equal(existsSync(migrated), true, "应生成 emotions.jsonc");
    assert.equal(readFileSync(migrated, "utf8"), legacyText, "内容原样复制（不改写）");
    assert.equal(existsSync(legacy), true, "旧文件保留");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadVoiceConfig：新名已存在 → 忽略旧名、不改写新名、不删旧名", () => {
  const dir = tempDir();
  try {
    const newText = `{ "tts": { "voice": "new" } }`;
    const legacyText = `{ "tts": { "voice": "old" } }`;
    writeFileSync(join(dir, CONFIG_FILE_NAME), newText, "utf8");
    writeFileSync(join(dir, LEGACY_CONFIG_FILE_NAME), legacyText, "utf8");
    const cfg = loadVoiceConfig({ configDir: dir, env: {} });
    assert.equal(cfg.tts.voice, "new", "新名优先");
    assert.equal(readFileSync(join(dir, CONFIG_FILE_NAME), "utf8"), newText, "新名不被改写");
    assert.equal(readFileSync(join(dir, LEGACY_CONFIG_FILE_NAME), "utf8"), legacyText, "旧名保持原样");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("voiceConfigPath/legacyVoiceConfigPath：EMOTIONS_CONFIG_DIR 优先于旧名 VOICE_CONFIG_DIR", () => {
  // 目录解析读的是 process.env（resolveConfigDir），故此处直接操作真实环境变量
  delete process.env[ENV_CONFIG_DIR];
  delete process.env[LEGACY_ENV_CONFIG_DIR];
  try {
    process.env[LEGACY_ENV_CONFIG_DIR] = "D:/legacy-dir";
    assert.equal(voiceConfigPath(), join("D:/legacy-dir", CONFIG_FILE_NAME), "旧名仍可用（向后兼容）");
    process.env[ENV_CONFIG_DIR] = "D:/new-dir";
    assert.equal(voiceConfigPath(), join("D:/new-dir", CONFIG_FILE_NAME), "新名优先");
    assert.equal(legacyVoiceConfigPath(), join("D:/new-dir", LEGACY_CONFIG_FILE_NAME));
  } finally {
    delete process.env[ENV_CONFIG_DIR];
    delete process.env[LEGACY_ENV_CONFIG_DIR];
  }
});

test("loadVoiceConfig：JSONC 注释/尾逗号/部分覆盖可解析并合并", () => {
  const dir = tempDir();
  try {
    writeFileSync(
      join(dir, CONFIG_FILE_NAME),
      `{
        // 只覆盖部分字段
        "asr": { "provider": "aliyun-v2", "language": "en", },
        "vad": { "threshold": 0.8 },
      }`,
      "utf8",
    );
    const cfg = loadVoiceConfig({ configDir: dir, env: {} });
    assert.equal(cfg.asr.provider, "aliyun-v2");
    assert.equal(cfg.asr.language, "en");
    assert.equal(cfg.asr.model, DEFAULT_VOICE_CONFIG.asr.model, "未给字段回落默认");
    assert.equal(cfg.vad.threshold, 0.8);
    assert.equal(cfg.vad.silenceDurationMs, DEFAULT_VOICE_CONFIG.vad.silenceDurationMs);
    assert.deepEqual(cfg.tts, DEFAULT_VOICE_CONFIG.tts);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadVoiceConfig：非法值逐项回退 + 越界夹取", () => {
  const dir = tempDir();
  try {
    writeFileSync(
      join(dir, CONFIG_FILE_NAME),
      `{ "asr": { "provider": "bogus" }, "vad": { "threshold": 99, "silenceDurationMs": 10 }, "tts": { "rate": 999 } }`,
      "utf8",
    );
    const cfg = loadVoiceConfig({ configDir: dir, env: {} });
    assert.equal(cfg.asr.provider, DEFAULT_VOICE_CONFIG.asr.provider, "未知 provider 回退默认");
    assert.equal(cfg.vad.threshold, 1, "阈值夹到上界");
    assert.equal(cfg.vad.silenceDurationMs, 200, "静音夹到下界");
    assert.equal(cfg.tts.rate, 10, "语速夹到上界");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadVoiceConfig：坏文件 → 静默降级默认（不抛、不覆盖原文件）", () => {
  const dir = tempDir();
  try {
    const path = join(dir, CONFIG_FILE_NAME);
    writeFileSync(path, "{ this is not valid jsonc ", "utf8");
    const cfg = loadVoiceConfig({ configDir: dir, env: {} });
    assert.deepEqual(cfg, DEFAULT_VOICE_CONFIG);
    assert.equal(readFileSync(path, "utf8"), "{ this is not valid jsonc ", "坏文件不被覆盖");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadVoiceConfig：环境变量覆盖文件与默认", () => {
  const cfg = loadVoiceConfig({
    configDir: tempDir(),
    env: {
      VOICE_DEVICE: "My Mic",
      VOICE_ASR_PROVIDER: "aliyun-v2",
      VOICE_ASR_MODEL: "m-x",
      VOICE_ASR_LANGUAGE: "ja",
      VOICE_VAD_THRESHOLD: "0.7",
      VOICE_VAD_SILENCE_MS: "1200",
      TTS_PROVIDER: "aliyun",
      TTS_VOICE: "V",
      TTS_RATE: "-4",
    },
  });
  assert.equal(cfg.device, "My Mic");
  assert.equal(cfg.asr.provider, "aliyun-v2");
  assert.equal(cfg.asr.model, "m-x");
  assert.equal(cfg.asr.language, "ja");
  assert.equal(cfg.vad.threshold, 0.7);
  assert.equal(cfg.vad.silenceDurationMs, 1200);
  assert.equal(cfg.tts.provider, "aliyun");
  assert.equal(cfg.tts.voice, "V");
  assert.equal(cfg.tts.rate, -4);
});

test("resolveAsrProvider：预设协议/传输/采样率/未知回退", () => {
  assert.equal(ASR_PROVIDER_PRESETS["aliyun-qwen"].protocol, "realtime");
  assert.equal(ASR_PROVIDER_PRESETS["aliyun-qwen"].transport, "stream");
  assert.equal(ASR_PROVIDER_PRESETS["aliyun-qwen"].model, "qwen3-asr-flash-realtime");
  assert.equal(ASR_PROVIDER_PRESETS["aliyun-8k"].protocol, "inference");
  assert.equal(ASR_PROVIDER_PRESETS["aliyun-8k"].sampleRate, 8000);
  assert.equal(ASR_PROVIDER_PRESETS["aliyun-v2"].extendedV2, true);
  // 按段（segment）provider：无 WS 方言（protocol 缺省）、同步 HTTP 模型
  assert.equal(ASR_PROVIDER_PRESETS["aliyun-qwen-file"].transport, "segment");
  assert.equal(ASR_PROVIDER_PRESETS["aliyun-qwen-file"].protocol, undefined);
  assert.equal(ASR_PROVIDER_PRESETS["aliyun-qwen-file"].model, "qwen3-asr-flash");
  assert.equal(ASR_PROVIDER_PRESETS["aliyun-qwen-file"].supportsEmotion, true);
  assert.equal(ASR_PROVIDER_PRESETS["mimo"].transport, "segment");
  assert.equal(ASR_PROVIDER_PRESETS["mimo"].model, "mimo-v2.5-asr");
  assert.equal(ASR_PROVIDER_PRESETS["mimo"].supportsEmotion, false);
  assert.equal(ASR_PROVIDER_PRESETS["mimo"].supportsLanguageHints, true);
  assert.equal(DEFAULT_ASR_PROVIDER, "aliyun-qwen", "默认 provider 不因新增按段 provider 而改变");
  assert.equal(resolveAsrProvider("nope").id, "aliyun-qwen");
  assert.equal(resolveAsrProvider("mimo").id, "mimo");
  assert.equal(resolveAsrProvider("aliyun-qwen-file").id, "aliyun-qwen-file");
});

test("asProvider 白名单：新按段 provider 可从配置解析，未知 id 仍回退默认", () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, CONFIG_FILE_NAME), `{ "asr": { "provider": "mimo" } }`, "utf8");
    assert.equal(loadVoiceConfig({ configDir: dir, env: {} }).asr.provider, "mimo", "mimo 在白名单内");
    writeFileSync(join(dir, CONFIG_FILE_NAME), `{ "asr": { "provider": "aliyun-qwen-file" } }`, "utf8");
    assert.equal(loadVoiceConfig({ configDir: dir, env: {} }).asr.provider, "aliyun-qwen-file", "aliyun-qwen-file 在白名单内");
    writeFileSync(join(dir, CONFIG_FILE_NAME), `{ "asr": { "provider": "MiMo" } }`, "utf8");
    assert.equal(
      loadVoiceConfig({ configDir: dir, env: {} }).asr.provider,
      DEFAULT_ASR_PROVIDER,
      "大小写不匹配仍回退默认（白名单精确匹配）",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadVoiceConfig：新增 ASR/TTS/凭证字段可解析，非法值逐项回退", () => {
  const dir = tempDir();
  try {
    writeFileSync(
      join(dir, CONFIG_FILE_NAME),
      `{
        "asr": {
          "languageHints": [" en ", "", 42, "zh"],
          "vocabularyId": "vocab-1",
          "context": "客服话术",
          "credentials": { "path": "C:/creds", "apiKey": "sk-x", "workspaceId": "ws-9" }
        },
        "tts": { "instruction": "方言：粤语", "pitch": 1.2, "volume": 70, "format": "mp3", "sampleRate": 24000, "model": "cosyvoice-v3-plus", "streamMinChars": 12 }
      }`,
      "utf8",
    );
    const cfg = loadVoiceConfig({ configDir: dir, env: {} });
    assert.deepEqual(cfg.asr.languageHints, ["en", "zh"], "去空串、丢弃非字符串、去空白");
    assert.equal(cfg.asr.vocabularyId, "vocab-1");
    assert.equal(cfg.asr.context, "客服话术");
    assert.deepEqual(cfg.asr.credentials, { path: "C:/creds", apiKey: "sk-x", workspaceId: "ws-9" });
    assert.equal(cfg.tts.instruction, "方言：粤语");
    assert.equal(cfg.tts.pitch, 1.2);
    assert.equal(cfg.tts.volume, 70);
    assert.equal(cfg.tts.format, "mp3");
    assert.equal(cfg.tts.sampleRate, 24000);
    assert.equal(cfg.tts.model, "cosyvoice-v3-plus");
    assert.equal(cfg.tts.streamMinChars, 12);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadVoiceConfig：类型不符（languageHints 非数组 / credentials 非对象）回退默认", () => {
  const dir = tempDir();
  try {
    writeFileSync(
      join(dir, CONFIG_FILE_NAME),
      `{ "asr": { "languageHints": "en", "credentials": "oops" }, "tts": { "pitch": "high", "sampleRate": "fast" } }`,
      "utf8",
    );
    const cfg = loadVoiceConfig({ configDir: dir, env: {} });
    assert.deepEqual(cfg.asr.languageHints, []);
    assert.deepEqual(cfg.asr.credentials, DEFAULT_VOICE_CONFIG.asr.credentials);
    assert.equal(cfg.tts.pitch, 0);
    assert.equal(cfg.tts.sampleRate, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadVoiceConfig：新增环境变量覆盖（语言提示逗号分隔、凭证由 resolveCredentials 处理）", () => {
  const cfg = loadVoiceConfig({
    configDir: tempDir(),
    env: {
      VOICE_ASR_LANGUAGE_HINTS: " en , zh ",
      VOICE_ASR_VOCABULARY_ID: "vid",
      VOICE_ASR_CONTEXT: "ctx",
      TTS_INSTRUCTION: "情感：愤怒",
      TTS_PITCH: "0.8",
      TTS_VOLUME: "60",
      TTS_FORMAT: "opus",
      TTS_SAMPLE_RATE: "16000",
      TTS_MODEL: "cosyvoice-v3-flash",
      TTS_STREAM_MIN_CHARS: "7",
    },
  });
  assert.deepEqual(cfg.asr.languageHints, ["en", "zh"]);
  assert.equal(cfg.asr.vocabularyId, "vid");
  assert.equal(cfg.asr.context, "ctx");
  assert.equal(cfg.tts.instruction, "情感：愤怒");
  assert.equal(cfg.tts.pitch, 0.8);
  assert.equal(cfg.tts.volume, 60);
  assert.equal(cfg.tts.format, "opus");
  assert.equal(cfg.tts.sampleRate, 16000);
  assert.equal(cfg.tts.model, "cosyvoice-v3-flash");
  assert.equal(cfg.tts.streamMinChars, 7);
});

test("loadVoiceConfig：tts.streamMinChars 默认 5、负数归一为 0、非数字回退默认", () => {
  assert.equal(DEFAULT_VOICE_CONFIG.tts.streamMinChars, 5);
  const dir = tempDir();
  try {
    writeFileSync(join(dir, CONFIG_FILE_NAME), `{ "tts": { "streamMinChars": -3 } }`, "utf8");
    assert.equal(loadVoiceConfig({ configDir: dir, env: {} }).tts.streamMinChars, 0, "负数夹到 0");
    writeFileSync(join(dir, CONFIG_FILE_NAME), `{ "tts": { "streamMinChars": "x" } }`, "utf8");
    assert.equal(loadVoiceConfig({ configDir: dir, env: {} }).tts.streamMinChars, 5, "非数字回退默认 5");
    writeFileSync(join(dir, CONFIG_FILE_NAME), `{ "tts": { "streamMinChars": 3.9 } }`, "utf8");
    assert.equal(loadVoiceConfig({ configDir: dir, env: {} }).tts.streamMinChars, 3, "取整");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("凭证独立：DEFAULT_VOICE_CONFIG 与模板都含 tts.credentials 空块", () => {
  const empty = { path: "", apiKey: "", workspaceId: "" };
  assert.deepEqual(DEFAULT_VOICE_CONFIG.tts.credentials, empty, "默认 tts.credentials 为空块");
  const tpl = parseJsonc(DEFAULT_CONFIG_TEMPLATE);
  assert.deepEqual(tpl.tts.credentials, empty, "模板 tts.credentials 为空块");
  assert.deepEqual(tpl.asr.credentials, DEFAULT_VOICE_CONFIG.asr.credentials);
});

test("MiMo 凭证：DEFAULT/模板含 tts.mimoCredentials 空块；文件解析与 aliyun 凭证互不影响", () => {
  assert.deepEqual(DEFAULT_VOICE_CONFIG.tts.mimoCredentials, { apiKey: "" });
  const tpl = parseJsonc(DEFAULT_CONFIG_TEMPLATE);
  assert.deepEqual(tpl.tts.mimoCredentials, { apiKey: "" }, "模板 mimoCredentials 为空块");
  const dir = tempDir();
  try {
    writeFileSync(
      join(dir, CONFIG_FILE_NAME),
      `{ "tts": { "credentials": { "apiKey": "aliyun-key", "workspaceId": "ws" }, "mimoCredentials": { "apiKey": "mimo-key" } } }`,
      "utf8",
    );
    const cfg = loadVoiceConfig({ configDir: dir, env: {} });
    assert.equal(cfg.tts.mimoCredentials.apiKey, "mimo-key");
    assert.equal(cfg.tts.credentials.apiKey, "aliyun-key", "aliyun 凭证不受 mimoCredentials 影响");
    // mimoCredentials 非对象 → 回退默认空块，不影响 aliyun
    writeFileSync(join(dir, CONFIG_FILE_NAME), `{ "tts": { "mimoCredentials": "oops" } }`, "utf8");
    const bad = loadVoiceConfig({ configDir: dir, env: {} });
    assert.deepEqual(bad.tts.mimoCredentials, { apiKey: "" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ASR MiMo 凭证：DEFAULT/模板含 asr.mimoCredentials 空块；文件解析与 tts 组互不影响", () => {
  assert.deepEqual(DEFAULT_VOICE_CONFIG.asr.mimoCredentials, { apiKey: "" });
  const tpl = parseJsonc(DEFAULT_CONFIG_TEMPLATE);
  assert.deepEqual(tpl.asr.mimoCredentials, { apiKey: "" }, "模板 asr.mimoCredentials 为空块");
  const dir = tempDir();
  try {
    writeFileSync(
      join(dir, CONFIG_FILE_NAME),
      `{ "asr": { "mimoCredentials": { "apiKey": "asr-mimo" } }, "tts": { "mimoCredentials": { "apiKey": "tts-mimo" } } }`,
      "utf8",
    );
    const cfg = loadVoiceConfig({ configDir: dir, env: {} });
    assert.equal(cfg.asr.mimoCredentials.apiKey, "asr-mimo");
    assert.equal(cfg.tts.mimoCredentials.apiKey, "tts-mimo", "两组各自独立、互不覆盖");
    // asr.mimoCredentials 非对象 → 回退默认空块，不影响 tts 组
    writeFileSync(
      join(dir, CONFIG_FILE_NAME),
      `{ "asr": { "mimoCredentials": "oops" }, "tts": { "mimoCredentials": { "apiKey": "tts-mimo" } } }`,
      "utf8",
    );
    const bad = loadVoiceConfig({ configDir: dir, env: {} });
    assert.deepEqual(bad.asr.mimoCredentials, { apiKey: "" });
    assert.equal(bad.tts.mimoCredentials.apiKey, "tts-mimo", "ASR 非法不影响 TTS");
    // 只配 asr 组、tts 组空 → 互不影响
    writeFileSync(join(dir, CONFIG_FILE_NAME), `{ "asr": { "mimoCredentials": { "apiKey": "asr-only" } } }`, "utf8");
    const oneSide = loadVoiceConfig({ configDir: dir, env: {} });
    assert.equal(oneSide.asr.mimoCredentials.apiKey, "asr-only");
    assert.deepEqual(oneSide.tts.mimoCredentials, { apiKey: "" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("凭证独立：只配 tts.credentials → TTS 解析到、ASR 保持默认（互不影响）", () => {
  const dir = tempDir();
  try {
    writeFileSync(
      join(dir, CONFIG_FILE_NAME),
      `{ "tts": { "credentials": { "path": "T:/tts", "apiKey": "tts-key", "workspaceId": "tts-ws" } } }`,
      "utf8",
    );
    const cfg = loadVoiceConfig({ configDir: dir, env: {} });
    assert.deepEqual(cfg.tts.credentials, { path: "T:/tts", apiKey: "tts-key", workspaceId: "tts-ws" });
    assert.deepEqual(cfg.asr.credentials, DEFAULT_VOICE_CONFIG.asr.credentials, "ASR 未配 → 不受 TTS 影响");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("凭证独立：只配 asr.credentials → ASR 解析到、TTS 保持默认（互不影响）", () => {
  const dir = tempDir();
  try {
    writeFileSync(
      join(dir, CONFIG_FILE_NAME),
      `{ "asr": { "credentials": { "apiKey": "asr-key", "workspaceId": "asr-ws" } } }`,
      "utf8",
    );
    const cfg = loadVoiceConfig({ configDir: dir, env: {} });
    assert.equal(cfg.asr.credentials.apiKey, "asr-key");
    assert.deepEqual(cfg.tts.credentials, DEFAULT_VOICE_CONFIG.tts.credentials, "TTS 未配 → 不受 ASR 影响");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("凭证独立：两侧各配不同值互不覆盖；类型不符分别逐项回退", () => {
  const dir = tempDir();
  try {
    writeFileSync(
      join(dir, CONFIG_FILE_NAME),
      `{
        "asr": { "credentials": { "apiKey": "asr-key", "workspaceId": "asr-ws" } },
        "tts": { "credentials": { "apiKey": "tts-key", "workspaceId": "tts-ws" } }
      }`,
      "utf8",
    );
    const cfg = loadVoiceConfig({ configDir: dir, env: {} });
    assert.deepEqual(cfg.asr.credentials, { path: "", apiKey: "asr-key", workspaceId: "asr-ws" });
    assert.deepEqual(cfg.tts.credentials, { path: "", apiKey: "tts-key", workspaceId: "tts-ws" });
    // tts.credentials 给了非对象 → 逐项回退默认，且不影响 asr.credentials
    writeFileSync(
      join(dir, CONFIG_FILE_NAME),
      `{ "asr": { "credentials": { "apiKey": "asr-key" } }, "tts": { "credentials": "oops" } }`,
      "utf8",
    );
    const bad = loadVoiceConfig({ configDir: dir, env: {} });
    assert.deepEqual(bad.tts.credentials, DEFAULT_VOICE_CONFIG.tts.credentials);
    assert.equal(bad.asr.credentials.apiKey, "asr-key", "TTS 非法不影响 ASR");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveAsrParams：按 provider 能力过滤并记录被忽略键", () => {
  const requested = { language: "zh", languageHints: ["en"], vocabularyId: "v1", context: "c1" };

  const qwen = resolveAsrParams(ASR_PROVIDER_PRESETS["aliyun-qwen"], requested);
  assert.equal(qwen.language, "zh", "language 所有 provider 均保留");
  assert.deepEqual(qwen.languageHints, []);
  assert.equal(qwen.vocabularyId, "");
  assert.equal(qwen.context, "");
  assert.deepEqual(qwen.ignored, ["languageHints", "vocabularyId", "context"]);

  const v2 = resolveAsrParams(ASR_PROVIDER_PRESETS["aliyun-v2"], requested);
  assert.deepEqual(v2.languageHints, ["en"]);
  assert.equal(v2.vocabularyId, "v1");
  assert.equal(v2.context, "");
  assert.deepEqual(v2.ignored, ["context"], "paraformer 无上下文增强");

  const none = resolveAsrParams(ASR_PROVIDER_PRESETS["aliyun-8k"], {
    language: "",
    languageHints: [],
    vocabularyId: "",
    context: "",
  });
  assert.deepEqual(none.ignored, [], "未设置任何增强参数时不报忽略");
});
