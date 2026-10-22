/**
 * 凭证解析离线单测：优先级（环境变量 > 配置 > 文件 > 默认路径）、逐字段合并、缺失报错与脱敏。
 *
 * 全部用注入的 `readFile` 隔离 IO；不触碰真实凭证、不打印密钥。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  defaultCredentialsPath,
  redact,
  resolveCredentials,
  resolveMimoApiKey,
  ENV_MIMO_API_KEY,
} from "../dist/voice/credentials.js";

/** 构造一个记录读取路径的假读文件器。 */
function trackingReader(map) {
  const reads = [];
  const reader = (path) => {
    reads.push(path);
    if (path in map) return map[path];
    const err = new Error(`ENOENT: ${path}`);
    err.code = "ENOENT";
    throw err;
  };
  return { reader, reads };
}

test("resolveCredentials：环境变量优先于配置与文件", () => {
  const { reader, reads } = trackingReader({});
  const creds = resolveCredentials({
    env: { DASHSCOPE_API_KEY: "env-key", DASHSCOPE_WORKSPACE_ID: "env-ws" },
    config: { apiKey: "cfg-key", workspaceId: "cfg-ws", path: "C:/creds" },
    defaultPath: "D:/default",
    readFile: reader,
  });
  assert.deepEqual(creds, { apiKey: "env-key", workspace: "env-ws" });
  assert.deepEqual(reads, [], "直填值齐备时不读文件");
});

test("resolveCredentials：配置直填优先于文件；缺失字段才读文件", () => {
  const { reader, reads } = trackingReader({ "C:/creds": { apiKey: "file-key", workspace: "file-ws" } });
  const creds = resolveCredentials({
    env: {},
    config: { apiKey: "cfg-key", path: "C:/creds" },
    readFile: reader,
  });
  assert.deepEqual(creds, { apiKey: "cfg-key", workspace: "file-ws" });
  assert.deepEqual(reads, ["C:/creds"], "workspace 缺失时读文件补齐");
});

test("resolveCredentials：路径优先级 cliPath > 环境变量 > 配置 > 默认", () => {
  const { reader, reads } = trackingReader({
    "D:/default": { apiKey: "d", workspace: "d" },
    "C:/cfg": { apiKey: "c", workspace: "c" },
    "C:/env": { apiKey: "e", workspace: "e" },
    "C:/cli": { apiKey: "cli", workspace: "cli" },
  });
  const base = { env: { VOICE_ALIYUN_CREDENTIALS: "C:/env" }, config: { path: "C:/cfg" }, defaultPath: "D:/default", readFile: reader };

  assert.deepEqual(resolveCredentials({ ...base, cliPath: "C:/cli" }), { apiKey: "cli", workspace: "cli" });
  assert.deepEqual(resolveCredentials(base), { apiKey: "e", workspace: "e" });
  assert.deepEqual(
    resolveCredentials({ ...base, env: {} }),
    { apiKey: "c", workspace: "c" },
  );
  assert.deepEqual(resolveCredentials({ env: {}, defaultPath: "D:/default", readFile: reader }), { apiKey: "d", workspace: "d" });
  assert.deepEqual(reads.slice(-1), ["D:/default"], "无任何路径来源时回退默认");
});

test("resolveCredentials：旧路径环境变量 ALIYUN_CREDENTIALS 兼容", () => {
  const { reader } = trackingReader({ "C:/legacy": { apiKey: "L", workspace: "L" } });
  const creds = resolveCredentials({ env: { ALIYUN_CREDENTIALS: "C:/legacy" }, readFile: reader });
  assert.deepEqual(creds, { apiKey: "L", workspace: "L" });
});

test("resolveCredentials：缺 apiKey/workspaceId 抛配置引导（真实配置路径+键+env）且信息不含密钥", () => {
  const { reader } = trackingReader({});
  assert.throws(
    () =>
      resolveCredentials({
        env: {},
        defaultPath: "D:/missing",
        readFile: reader,
        section: "asr",
        providerLabel: "aliyun-qwen",
        configFile: "C:/cfg/emotions.jsonc",
      }),
    (err) =>
      /未配置 aliyun-qwen 凭证/.test(err.message) &&
      err.message.includes("C:/cfg/emotions.jsonc") &&
      /asr\.credentials\.apiKey/.test(err.message) &&
      err.message.includes("DASHSCOPE_API_KEY") &&
      !/DASHSCOPE_API_KEY=/.test(err.message),
  );
  assert.throws(
    () =>
      resolveCredentials({
        env: { DASHSCOPE_API_KEY: "sk-secret" },
        defaultPath: "D:/missing",
        readFile: reader,
        configFile: "C:/cfg/emotions.jsonc",
      }),
    (err) =>
      /未配置 阿里云 凭证/.test(err.message) &&
      /asr\.credentials\.workspaceId/.test(err.message) &&
      err.message.includes("DASHSCOPE_WORKSPACE_ID") &&
      !err.message.includes("sk-secret"),
  );
});

test("resolveCredentials：直填足够时吞掉文件读取错误", () => {
  const reader = () => {
    throw new Error("ENOENT");
  };
  const creds = resolveCredentials({
    env: { DASHSCOPE_API_KEY: "k", DASHSCOPE_WORKSPACE_ID: "w" },
    config: { path: "C:/nope" },
    readFile: reader,
  });
  assert.deepEqual(creds, { apiKey: "k", workspace: "w" });
});

test("defaultCredentialsPath：<cwd>/.tmp/aliyun", () => {
  const path = defaultCredentialsPath("C:/work");
  assert.match(path, /\.tmp[\\/]aliyun$/);
});

test("redact：抹除全部密钥出现", () => {
  assert.equal(redact("Bearer sk-abc failed sk-abc", "sk-abc"), "Bearer *** failed ***");
  assert.equal(redact("nothing", ""), "nothing");
});

test("resolveCredentials：TTS 独立凭证——只有 tts 配齐时 tts 侧解析成功、asr 侧不受牵连", () => {
  const { reader } = trackingReader({});
  const ttsConfig = { path: "T:/creds", apiKey: "tts-key", workspaceId: "tts-ws" };
  const asrConfig = { path: "", apiKey: "", workspaceId: "" };
  // TTS 用自己的 tts.credentials 直接解析成功，且不读任何文件
  assert.deepEqual(resolveCredentials({ env: {}, config: ttsConfig, readFile: reader }), {
    apiKey: "tts-key",
    workspace: "tts-ws",
  });
  // ASR 侧空配置 + 无 env + 无凭证文件 → 抛缺失错误（证明两侧互不共享，tts 的 key 不会流到 asr）
  assert.throws(
    () => resolveCredentials({ env: {}, config: asrConfig, defaultPath: "A:/missing", readFile: reader }),
    /未配置 阿里云 凭证/,
  );
});

test("resolveMimoApiKey：独立链（env > 配置），无 workspace 要求，报错不含密钥", () => {
  // env > 配置
  assert.equal(resolveMimoApiKey({ env: { [ENV_MIMO_API_KEY]: "env-mimo" }, config: { apiKey: "cfg-mimo" } }), "env-mimo");
  // 仅配置（无 workspace 也能解析成功——与 aliyun 强制 workspace 的链不同）
  assert.equal(resolveMimoApiKey({ env: {}, config: { apiKey: "cfg-mimo" } }), "cfg-mimo");
  // 两级都缺 → 清晰报错（配置引导）、不含密钥痕迹
  assert.throws(
    () => resolveMimoApiKey({ env: {}, config: {}, configFile: "C:/cfg/emotions.jsonc" }),
    (err) =>
      /未配置 MiMo 凭证/.test(err.message) &&
      err.message.includes("C:/cfg/emotions.jsonc") &&
      err.message.includes("MIMO_API_KEY") &&
      !err.message.includes("cfg-mimo"),
  );
  // aliyun resolveCredentials 不读 MIMO_API_KEY；MiMo 链也不要求 DASHSCOPE workspace
  assert.throws(
    () => resolveCredentials({ env: { MIMO_API_KEY: "only-mimo" }, defaultPath: "M:/missing", readFile: trackingReader({}).reader }),
    /未配置 阿里云 凭证/,
  );
});

test("resolveMimoApiKey：configPath 参数化——ASR 报 asr 路径、缺省（TTS）报 tts 路径", () => {
  // 缺省不传 configPath → 错误文案指 tts.mimoCredentials.apiKey（TTS 调用方语义不变）
  assert.throws(
    () => resolveMimoApiKey({ env: {}, config: {} }),
    (err) => err.message.includes("tts.mimoCredentials.apiKey"),
  );
  // ASR 调用方传 configPath → 错误文案指 asr.mimoCredentials.apiKey
  assert.throws(
    () => resolveMimoApiKey({ env: {}, config: {}, configPath: "asr.mimoCredentials.apiKey" }),
    (err) => err.message.includes("asr.mimoCredentials.apiKey") && !err.message.includes("tts.mimoCredentials"),
  );
  // 显式传 tts 路径也生效（TTS 调用方显式传参时行为一致）
  assert.throws(
    () => resolveMimoApiKey({ env: {}, config: {}, configPath: "tts.mimoCredentials.apiKey" }),
    (err) => err.message.includes("tts.mimoCredentials.apiKey"),
  );
});

test("resolveMimoApiKey：ASR 独立链（env > asr 组）——asr 空 + tts 有值时 ASR 仍报错（文案指 asr 路径）", () => {
  // 模拟 voice-runtime ASR 分支：传入 asr 组配置 + asr 路径；env > asr 本组
  const asrGroup = { apiKey: "asr-mimo" };
  assert.equal(
    resolveMimoApiKey({ env: { [ENV_MIMO_API_KEY]: "env-mimo" }, config: asrGroup, configPath: "asr.mimoCredentials.apiKey" }),
    "env-mimo",
  );
  assert.equal(
    resolveMimoApiKey({ env: {}, config: asrGroup, configPath: "asr.mimoCredentials.apiKey" }),
    "asr-mimo",
  );
  // asr 组空、tts 组有值：ASR 只看传入的 asr 组（不回退 tts），报错文案指 asr 路径
  assert.throws(
    () => resolveMimoApiKey({ env: {}, config: { apiKey: "" }, configPath: "asr.mimoCredentials.apiKey" }),
    (err) => err.message.includes("asr.mimoCredentials.apiKey") && !err.message.includes("tts.mimoCredentials"),
  );
});
