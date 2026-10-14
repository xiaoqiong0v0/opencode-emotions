/**
 * TTS provider 注册表与统一入口（`speak` / `stopAll`）。
 *
 * provider 选择来自 `TTS_PROVIDER`（默认 sapi）；工具层只调用本模块，不感知具体 provider。
 * provider 按名缓存为单实例，保证「单个活跃朗读」的并发/打断状态唯一（见 docs/ASYNC.md）。
 */

import createLogger from "@xiaoqiong0v0/opencode-plugin-logger";
import type { Logger } from "@xiaoqiong0v0/opencode-plugin-logger";

import { loadVoiceConfig, type VoiceConfig } from "../config.js";
import { AliyunProvider } from "./aliyun.js";
import { SapiProvider } from "./sapi.js";
import { ignoredTtsParams, resolveTtsConfig, type SpeakResult, type TtsProvider, type TtsRequest } from "./types.js";

export * from "./types.js";
export * from "./emotion.js";
export { SAPI_SCRIPT, SapiProvider, buildSapiEnv } from "./sapi.js";
export { AliyunProvider } from "./aliyun.js";

const log: Logger = createLogger("tts");

/** speak 调用选项（便于测试注入）。 */
export interface SpeakOptions {
  /** 环境变量表（默认 process.env）。 */
  env?: NodeJS.ProcessEnv;
  /** 预加载的语音配置；缺省从 emotions.jsonc 读取（测试可注入以隔离 IO）。 */
  config?: VoiceConfig;
}

/** 已创建的 provider 实例（按名缓存，保证并发/打断状态唯一）。 */
const registry = new Map<string, TtsProvider>();

/**
 * 按名创建 provider。
 * @param name provider 标识
 * @returns provider 实例
 * @throws 未知 provider 时抛错
 */
function createProvider(name: string): TtsProvider {
  switch (name) {
    case "sapi":
      return new SapiProvider();
    case "aliyun":
      return new AliyunProvider();
    default:
      throw new Error(`未知 TTS provider：${name}（可用：sapi、aliyun）`);
  }
}

/**
 * 获取（并按名缓存）provider 实例。
 * @param name provider 标识
 * @returns provider 实例
 */
export function getProvider(name: string): TtsProvider {
  const cached = registry.get(name);
  if (cached) return cached;
  const created = createProvider(name);
  registry.set(name, created);
  return created;
}

/**
 * 解析配置并后台开始一次朗读（立即返回，不等待播放完成）。
 * @param request 工具入参
 * @param options 调用选项（env / 预加载配置）；缺省读取 emotions.jsonc
 * @returns 本次朗读的启动结果
 * @throws 配置非法 / provider 未实现时抛错
 */
export function speak(request: TtsRequest, options: SpeakOptions = {}): SpeakResult {
  const env = options.env ?? process.env;
  const config = options.config ?? loadVoiceConfig({ env });
  const resolved = resolveTtsConfig(request, env, config.tts);
  const provider = getProvider(resolved.provider);
  const ignored = ignoredTtsParams(resolved.provider, resolved);
  if (ignored.length > 0) {
    log.info(`provider=${resolved.provider} 忽略不支持的参数：${ignored.join(", ")}`);
  }
  log.info(
    `speak provider=${resolved.provider} voice=${resolved.voice || "默认"} rate=${resolved.rate} len=${resolved.text.length}`,
  );
  return provider.speak({
    text: resolved.text,
    voice: resolved.voice,
    rate: resolved.rate,
    instruction: resolved.instruction,
    pitch: resolved.pitch,
    volume: resolved.volume,
    format: resolved.format,
    sampleRate: resolved.sampleRate,
    model: resolved.model,
    credentials: config.asr.credentials,
  });
}

/**
 * 停止全部 provider 的当前朗读（用于插件 dispose）。
 */
export function stopAll(): void {
  for (const provider of registry.values()) {
    try {
      provider.stop();
    } catch (err) {
      log.warn(`停止 ${provider.name} 失败`, err as Error);
    }
  }
}
