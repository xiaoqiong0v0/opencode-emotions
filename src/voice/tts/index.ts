/**
 * TTS provider 注册表与统一入口（`speak` / `stopAll`）。
 *
 * provider 选择来自 `TTS_PROVIDER`（默认 sapi）；工具层只调用本模块，不感知具体 provider。
 * provider 按名缓存为单实例，保证「单个活跃朗读」的并发/打断状态唯一（见 docs/ASYNC.md）。
 */

import createLogger from "@xiaoqiong0v0/opencode-plugin-logger";
import type { Logger } from "@xiaoqiong0v0/opencode-plugin-logger";

import { loadVoiceConfig, type VoiceConfig } from "../config.js";
import { resolveMimoApiKey } from "../credentials.js";
import type { AudioSink } from "./audio-sink.js";
import { AliyunProvider } from "./aliyun.js";
import { MiMoProvider } from "./mimo.js";
import { SapiProvider } from "./sapi.js";
import { TermuxProvider } from "./termux.js";
import { ignoredTtsParams, resolveTtsConfig, DEFAULT_VOICE_LABEL, type SpeakResult, type TtsProvider, type TtsRequest } from "./types.js";

export * from "./types.js";
export * from "./emotion.js";
export { FOLLOW_EXIT_TIMEOUT_MS, SAPI_FOLLOW_SCRIPT, SAPI_SCRIPT, SapiProvider, buildSapiEnv, buildSapiFollowEnv } from "./sapi.js";
export {
  AliyunProvider,
  buildCosyVoiceCancelTask,
  buildCosyVoiceContinueTask,
  buildCosyVoiceFinishTask,
  buildCosyVoiceRunTask,
  buildTtsUrl,
  normalizeWavHeader,
  resolveCosyVoiceParams,
  supportsInstruction,
  MAX_CONTINUE_CHARS,
  MAX_TOTAL_CHARS,
  STREAM_FORMAT,
} from "./aliyun.js";
export {
  DEFAULT_MIMO_MODEL,
  DEFAULT_MIMO_VOICE,
  MIMO_API_URL,
  MIMO_PROVIDER_NAME,
  MIMO_SAMPLE_RATE,
  MIMO_STREAM_FORMAT,
  MiMoProvider,
  buildMimoMessages,
  buildMimoRequestBody,
  extractMimoAudioPcm,
  resolveMimoParams,
  streamMimoPcm,
  type MimoMessage,
  type MimoParams,
  type StreamMimoPcmOptions,
} from "./mimo.js";
export {
  createStreamChunker,
  normalizeStreamMinChars,
  DEFAULT_STREAM_MIN_CHARS,
  type StreamChunker,
  type StreamChunkerOptions,
} from "./stream.js";
export { TermuxProvider, buildTermuxTtsArgs, mapTermuxRate, TERMUX_TTS_BIN } from "./termux.js";
export {
  DEFAULT_TTS_STREAM,
  ENV_TTS_PLAYER,
  ENV_TTS_STREAM,
  commandExists,
  isTermux,
  selectPlayer,
  type PlayerCommand,
  type SelectedPlayer,
  type SelectPlayerOptions,
} from "./player.js";
export {
  buildWavHeader,
  createAudioSink,
  createProviderSink,
  PcmFileSink,
  selectAudioStrategy,
  MAX_SEGMENT_SECONDS,
  PCM_BITS,
  PCM_CHANNELS,
  WAV_HEADER_BYTES,
  type AudioSink,
  type AudioStrategy,
  type PcmFileSinkOptions,
  type SelectAudioStrategyOptions,
  type SinkSourceOptions,
} from "./audio-sink.js";
export { splitSentences, type SentenceSplit } from "./sentences.js";
export {
  buildWaveOutScript,
  selectStreamPlayer,
  STREAM_PLAYER_IDS,
  WAVEOUT_SCRIPT,
  type SelectedStreamPlayer,
  type SelectStreamPlayerOptions,
  type StreamCommand,
} from "./stream-player.js";

const log: Logger = createLogger("tts");

/** speak 调用选项（便于测试注入）。 */
export interface SpeakOptions {
  /** 环境变量表（默认 process.env）。 */
  env?: NodeJS.ProcessEnv;
  /** 预加载的语音配置；缺省从 emotions.jsonc 读取（测试可注入以隔离 IO）。 */
  config?: VoiceConfig;
  /**
   * 自定义音频落地（仅 CLI `speak --pcm-out` 使用）：给定采样率返回 sink。
   * 缺省走正常播放路径（流式/分段）。
   */
  sinkFactory?: (sampleRate: number) => AudioSink;
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
    case "termux":
      return new TermuxProvider();
    case "mimo":
      return new MiMoProvider();
    default:
      throw new Error(`未知 TTS provider：${name}（可用：sapi、aliyun、termux、mimo）`);
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
 * 按当前解析链（env → config → 默认）判定 provider 是否支持 follow 常驻模式。
 * 供生产接线（server 插件把结果传给 auto-read 决定 spawn worker 还是按块 spawn CLI）。
 * 解析失败一律按 false 降级（回旧路径，不阻塞朗读）。
 * @param env 环境变量表（默认 process.env）
 * @param config 预加载配置；缺省读 emotions.jsonc
 * @returns 支持 follow 返回 true
 */
export function resolveFollowSupport(env: NodeJS.ProcessEnv = process.env, config?: VoiceConfig): boolean {
  try {
    const cfg = config ?? loadVoiceConfig({ env });
    const resolved = resolveTtsConfig({ text: "" }, env, cfg.tts);
    return getProvider(resolved.provider).followSupport === true;
  } catch {
    return false;
  }
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
    `speak provider=${resolved.provider} voice=${resolved.voice || DEFAULT_VOICE_LABEL} rate=${resolved.rate} len=${resolved.text.length}`,
  );
  // MiMo 专用凭证：仅 provider=mimo 时按 env MIMO_API_KEY > tts.mimoCredentials.apiKey 解析（缺失即抛清晰错误）
  const mimoApiKey =
    resolved.provider === "mimo" ? resolveMimoApiKey({ env, config: config.tts.mimoCredentials }) : undefined;
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
    streamMinChars: resolved.streamMinChars,
    credentials: config.tts.credentials,
    mimoApiKey,
    sinkFactory: options.sinkFactory,
  });
}

/**
 * 按当前解析链判定 provider 是否支持**只合成不出声**（`speak --pcm-out`，预取依赖它）。
 * 供生产接线（server 插件把结果传给 auto-read 决定是否启用下一单元预取）。
 * 解析失败/未知 provider 一律按 false 降级（回串行路径，不阻塞朗读）。
 * @param env 环境变量表（默认 process.env）
 * @param config 预加载配置；缺省读 emotions.jsonc
 * @returns 支持 PCM 输出返回 true
 */
export function resolvePcmOutputSupport(env: NodeJS.ProcessEnv = process.env, config?: VoiceConfig): boolean {
  try {
    const cfg = config ?? loadVoiceConfig({ env });
    const resolved = resolveTtsConfig({ text: "" }, env, cfg.tts);
    return getProvider(resolved.provider).pcmOutputSupport === true;
  } catch {
    return false;
  }
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
