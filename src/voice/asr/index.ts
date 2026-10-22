/**
 * ASR 客户端工厂：按 provider 预设分流到 stream（阿里 WS 两方言）或 segment（阿里按段 / MiMo 按段）。
 * 运行时只依赖 {@link AsrClient} 接口，不再直接 `new AliyunAsrClient`。
 */

import { AliyunAsrClient, type AliyunAsrOptions } from "../aliyun.js";
import type { AsrProviderPreset } from "../config.js";
import { AliyunFileAsrClient, DEFAULT_FILE_ASR_MODEL, type AliyunFileAsrOptions } from "./aliyun-file.js";
import { MimoAsrClient, DEFAULT_MIMO_ASR_MODEL, mapMimoAsrLanguage, type MimoAsrOptions } from "./mimo.js";
import type { AsrClient, AsrResult } from "./types.js";

export { AliyunFileAsrClient, buildAliyunFileAsrBody, buildFileAsrUrl, parseAliyunFileResponse, DEFAULT_FILE_ASR_MODEL } from "./aliyun-file.js";
export { MimoAsrClient, buildMimoAsrRequestBody, mapMimoAsrLanguage, parseMimoAsrResponse, DEFAULT_MIMO_ASR_MODEL } from "./mimo.js";
export {
  SegmentAsrClientBase,
  maxWavBytesForBase64,
  pcmRms,
  splitPcmByMaxBytes,
  DEFAULT_MAX_SEGMENT_MS,
  ENERGY_VAD_SCALE,
  MAX_BASE64_BYTES,
  WAV_DATA_URL_PREFIX,
} from "./segment.js";
export type { SegmentAsrOptions, SegmentTranscript } from "./segment.js";
export type { AsrClient, AsrResult, AsrTransport } from "./types.js";

/** 工厂的构造参数（凭证按 provider 需求二选一：阿里需 workspace+apiKey；MiMo 只需 apiKey）。 */
export interface CreateAsrClientOptions {
  /** provider 预设（决定传输分类与默认模型）。 */
  preset: AsrProviderPreset;
  /** 模型名（空串时各客户端回落自己的默认）。 */
  model: string;
  /** 识别语言（空 = 自动）。 */
  language: string;
  /** 语言提示（paraformer `language_hints` / MiMo zh·en 映射）。 */
  languageHints: string[];
  /** 热词表 ID（仅 paraformer stream provider 使用）。 */
  vocabularyId: string;
  /** 领域上下文（当前无 provider 支持）。 */
  context: string;
  /** VAD 覆盖（stream 下发服务端；segment 用于本地能量切段）。 */
  vad: { threshold: number; silenceDurationMs: number };
  /** 阿里云凭证（stream 与 `aliyun-qwen-file` 必需）。 */
  credentials?: { workspace: string; apiKey: string };
  /** MiMo API Key（仅 `mimo`；由 `resolveMimoApiKey` 从 `asr.mimoCredentials` 解析后传入）。 */
  mimoApiKey?: string;
  /** 识别结果回调。 */
  onResult: (result: AsrResult) => void;
  /** 错误回调（已脱敏）。 */
  onError?: (message: string) => void;
}

/**
 * 按 provider 预设创建 ASR 客户端。
 * @param options 工厂参数
 * @returns 满足 {@link AsrClient} 的客户端实例
 * @throws Error 凭证缺失（阿里未给 credentials / MiMo 未给 mimoApiKey）
 */
export function createAsrClient(options: CreateAsrClientOptions): AsrClient {
  const { preset } = options;
  if (preset.id === "mimo") {
    const apiKey = options.mimoApiKey?.trim();
    if (!apiKey) throw new Error("创建 MiMo ASR 客户端缺少 API Key（应由 resolveMimoApiKey 解析后传入）");
    const mimoOptions: MimoAsrOptions = {
      apiKey,
      model: options.model.trim() || DEFAULT_MIMO_ASR_MODEL,
      language: mapMimoAsrLanguage(options.language, options.languageHints),
      sampleRate: preset.sampleRate,
      vad: options.vad,
      onResult: options.onResult,
      onError: options.onError,
    };
    return new MimoAsrClient(mimoOptions);
  }
  if (preset.id === "aliyun-qwen-file") {
    const credentials = options.credentials;
    if (!credentials) throw new Error("创建阿里按段 ASR 客户端缺少凭证（应由 resolveCredentials 解析后传入）");
    const fileOptions: AliyunFileAsrOptions = {
      workspace: credentials.workspace,
      apiKey: credentials.apiKey,
      model: options.model.trim() || DEFAULT_FILE_ASR_MODEL,
      language: options.language,
      sampleRate: preset.sampleRate,
      vad: options.vad,
      onResult: options.onResult,
      onError: options.onError,
    };
    return new AliyunFileAsrClient(fileOptions);
  }
  // stream（realtime / inference 两种 WS 方言）：沿用原 AliyunAsrClient，行为不变
  const credentials = options.credentials;
  if (!credentials) throw new Error("创建阿里实时 ASR 客户端缺少凭证（应由 resolveCredentials 解析后传入）");
  const streamOptions: AliyunAsrOptions = {
    workspace: credentials.workspace,
    apiKey: credentials.apiKey,
    protocol: preset.protocol,
    model: options.model,
    sampleRate: preset.sampleRate,
    language: options.language,
    languageHints: options.languageHints,
    vocabularyId: options.vocabularyId,
    context: options.context,
    vad: options.vad,
    extendedV2: preset.extendedV2,
    onResult: options.onResult,
    onError: options.onError,
  };
  return new AliyunAsrClient(streamOptions);
}
