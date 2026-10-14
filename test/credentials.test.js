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

test("resolveCredentials：缺 apiKey/workspaceId 抛错且信息不含密钥", () => {
  const { reader } = trackingReader({});
  assert.throws(
    () => resolveCredentials({ env: {}, defaultPath: "D:/missing", readFile: reader }),
    (err) => /未找到 API Key/.test(err.message) && !/DASHSCOPE_API_KEY=/.test(err.message),
  );
  assert.throws(
    () => resolveCredentials({ env: { DASHSCOPE_API_KEY: "sk-secret" }, defaultPath: "D:/missing", readFile: reader }),
    (err) => /未找到 workspaceId/.test(err.message) && !err.message.includes("sk-secret"),
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
