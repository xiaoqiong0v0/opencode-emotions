/**
 * 语音配置：从 `<配置目录>/emotions.jsonc` 读取，环境变量可覆盖，首次缺失时写一份带注释的默认。
 *
 * 配置文件名与插件/项目同名（`opencode-emotions` → `emotions.jsonc`），与同级插件的配置命名约定一致
 * （`browser-tool.jsonc` / `sound-notify.jsonc` / `plugin-logger.jsonc`）。
 * 旧名 `voice.jsonc` 兼容：新名缺失而旧名存在时**原样复制**为新名（保留旧文件，不删）。
 * 配置目录 = `resolveConfigDir()`（`<homedir>/.config/opencode`；可用环境变量 `EMOTIONS_CONFIG_DIR` 覆盖，兼容旧名 `VOICE_CONFIG_DIR`）。
 * 读取失败（文件损坏/类型不符）**静默降级到默认值**，绝不影响插件运行。
 * 优先级：环境变量 > 配置文件 > 内置默认。
 *
 * 文案语言拆为两个独立键：`uiLanguage`（TUI 槽位/toast/命令标题）与 `toolLanguage`（工具描述 + `voice-cli --help`）；
 * 旧键 `language` 向后兼容——新键缺 → 用 `language` → 再缺用 `en`；环境变量同构（新名缺 → 旧名 → 文件值）。
 *
 * ASR provider 是「预设」：`aliyun-qwen` 走 OpenAI-realtime 风格协议（16k、7 类情绪）；
 * `aliyun-8k` / `aliyun-v2` 走 DashScope inference 协议（run-task；8k 3 类情绪 / v2 无情绪）。
 * 协议字段依据阿里云百炼官方文档（见 README 与 docs）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { resolveConfigDir } from "../lib/config-dir.js";
import { DEFAULT_LANGUAGE, resolveLanguage, type Language } from "../lib/i18n.js";
import { parseJsonc } from "../lib/jsonc.js";
import {
  DEFAULT_PROVIDER as DEFAULT_TTS_PROVIDER,
  DEFAULT_RATE as DEFAULT_TTS_RATE,
  MAX_RATE as TTS_RATE_MAX,
  MIN_RATE as TTS_RATE_MIN,
} from "./tts/types.js";

/** 覆盖配置目录的环境变量名（新名，与插件同名前缀）。 */
export const ENV_CONFIG_DIR = "EMOTIONS_CONFIG_DIR";
/** 覆盖配置目录的环境变量名（旧名，向后兼容读取）。 */
export const LEGACY_ENV_CONFIG_DIR = "VOICE_CONFIG_DIR";
/** 配置文件名（与插件/项目同名）。 */
export const CONFIG_FILE_NAME = "emotions.jsonc";
/** 旧配置文件名（向后兼容：新名缺失时原样复制过来，旧文件保留）。 */
export const LEGACY_CONFIG_FILE_NAME = "voice.jsonc";

/** 设备名覆盖环境变量。 */
export const ENV_DEVICE = "VOICE_DEVICE";
/** TUI 文案语言覆盖环境变量（zh/en）。 */
export const ENV_UI_LANGUAGE = "VOICE_UI_LANGUAGE";
/** 工具文案语言覆盖环境变量（zh/en）。 */
export const ENV_TOOL_LANGUAGE = "VOICE_TOOL_LANGUAGE";
/** 旧文案语言覆盖环境变量（向后兼容：两个新环境变量名都缺省时兜底两者）。 */
export const ENV_LANGUAGE = "VOICE_LANGUAGE";
/** ASR provider 覆盖环境变量。 */
export const ENV_ASR_PROVIDER = "VOICE_ASR_PROVIDER";
/** ASR 模型覆盖环境变量。 */
export const ENV_ASR_MODEL = "VOICE_ASR_MODEL";
/** 识别语言覆盖环境变量（空 = 自动）。 */
export const ENV_ASR_LANGUAGE = "VOICE_ASR_LANGUAGE";
/** VAD 阈值覆盖环境变量。 */
export const ENV_VAD_THRESHOLD = "VOICE_VAD_THRESHOLD";
/** VAD 句尾静音覆盖环境变量。 */
export const ENV_VAD_SILENCE_MS = "VOICE_VAD_SILENCE_MS";
/** ASR 语言提示覆盖环境变量（逗号分隔）。 */
export const ENV_ASR_LANGUAGE_HINTS = "VOICE_ASR_LANGUAGE_HINTS";
/** ASR 热词表 ID 覆盖环境变量。 */
export const ENV_ASR_VOCABULARY_ID = "VOICE_ASR_VOCABULARY_ID";
/** ASR 领域上下文覆盖环境变量。 */
export const ENV_ASR_CONTEXT = "VOICE_ASR_CONTEXT";

/** ASR provider 标识。 */
export type AsrProviderId = "aliyun-qwen" | "aliyun-8k" | "aliyun-v2";
/** ASR 传输协议：realtime（qwen）/ inference（paraformer run-task）。 */
export type AsrProtocol = "realtime" | "inference";

/** provider 预设（协议/默认模型/采样率/是否带情绪）。 */
export interface AsrProviderPreset {
  id: AsrProviderId;
  protocol: AsrProtocol;
  model: string;
  sampleRate: number;
  /** 是否返回情绪标签（qwen 7 类 / 8k-v2 3 类）。 */
  supportsEmotion: boolean;
  /** 是否支持 paraformer v2 专有参数（max_sentence_silence 等）。 */
  extendedV2: boolean;
  /** 是否支持 `language_hints`（paraformer 系）。 */
  supportsLanguageHints: boolean;
  /** 是否支持热词表 `vocabulary_id`（paraformer 系）。 */
  supportsVocabulary: boolean;
  /** 是否支持领域上下文 `input.context`（当前无 provider 支持，见调研）。 */
  supportsContext: boolean;
}

/** 全部 provider 预设。 */
export const ASR_PROVIDER_PRESETS: Readonly<Record<AsrProviderId, AsrProviderPreset>> = {
  "aliyun-qwen": {
    id: "aliyun-qwen",
    protocol: "realtime",
    model: "qwen3-asr-flash-realtime",
    sampleRate: 16000,
    supportsEmotion: true,
    extendedV2: false,
    supportsLanguageHints: false,
    supportsVocabulary: false,
    supportsContext: false,
  },
  "aliyun-8k": {
    id: "aliyun-8k",
    protocol: "inference",
    model: "paraformer-realtime-8k-v2",
    sampleRate: 8000,
    supportsEmotion: true,
    extendedV2: false,
    supportsLanguageHints: true,
    supportsVocabulary: true,
    supportsContext: false,
  },
  "aliyun-v2": {
    id: "aliyun-v2",
    protocol: "inference",
    model: "paraformer-realtime-v2",
    sampleRate: 16000,
    supportsEmotion: false,
    extendedV2: true,
    supportsLanguageHints: true,
    supportsVocabulary: true,
    supportsContext: false,
  },
};

/** 默认 provider。 */
export const DEFAULT_ASR_PROVIDER: AsrProviderId = "aliyun-qwen";
/** 默认识别语言（空 = 自动识别，多语言）。 */
export const DEFAULT_ASR_LANGUAGE = "";
/** VAD 阈值默认（调高更抗噪）；范围 [-1,1]。 */
export const DEFAULT_VAD_THRESHOLD = 0.5;
/** VAD 句尾静音默认（毫秒）。 */
export const DEFAULT_VAD_SILENCE_MS = 800;
/** VAD 阈值范围。 */
export const VAD_THRESHOLD_MIN = -1;
export const VAD_THRESHOLD_MAX = 1;
/** VAD 句尾静音范围（毫秒）。 */
export const VAD_SILENCE_MIN = 200;
export const VAD_SILENCE_MAX = 6000;
/** ASR 语言提示默认（空 = 不下发）。 */
export const DEFAULT_ASR_LANGUAGE_HINTS: readonly string[] = [];
/** ASR 热词表 ID 默认（空 = 不下发）。 */
export const DEFAULT_ASR_VOCABULARY_ID = "";
/** ASR 领域上下文默认（空 = 不下发）。 */
export const DEFAULT_ASR_CONTEXT = "";
/** TTS 风格/情感/方言指令默认（空 = 不下发；仅 CosyVoice）。 */
export const DEFAULT_TTS_INSTRUCTION = "";
/** TTS 音高默认（0 = 未指定 → provider 默认；CosyVoice 范围 [0.5,2]）。 */
export const DEFAULT_TTS_PITCH = 0;
/** TTS 音量默认（0 = 未指定 → provider 默认；范围 [0,100]）。 */
export const DEFAULT_TTS_VOLUME = 0;
/** TTS 输出格式默认（空 = provider 默认；CosyVoice 可选 pcm/wav/mp3/opus）。 */
export const DEFAULT_TTS_FORMAT = "";
/** TTS 采样率默认（0 = 未指定 → provider 默认）。 */
export const DEFAULT_TTS_SAMPLE_RATE = 0;
/** 云 TTS 模型名默认（空 = provider 默认，如 cosyvoice-v2）。 */
export const DEFAULT_TTS_MODEL = "";

/** 单条识别语言合法值（qwen3-asr-flash-realtime 文档）。空串表示自动识别。 */
export const ASR_LANGUAGES: readonly string[] = [
  "zh", "yue", "en", "ja", "ko", "de", "fr", "ru", "es", "pt", "it", "ar",
  "hi", "id", "th", "tr", "uk", "vi", "cs", "da", "fil", "fi", "is", "ms",
  "no", "pl", "sv",
];

/** paraformer `language_hints` 支持的子集（不支持的语种将不下发该提示）。 */
export const PARAFORMER_LANGUAGES: readonly string[] = ["zh", "en", "ja", "yue", "ko", "de", "fr", "ru"];

/** ASR 凭证配置（解析优先级见 `resolveCredentials`）。 */
export interface AsrCredentialsConfig {
  /** 凭证文件路径（1 行 workspaceid / 2 行 apikey）；空 = 用默认路径。 */
  path: string;
  /** 直接给出的 API Key（低于环境变量、高于凭证文件）。 */
  apiKey: string;
  /** 直接给出的业务空间 ID。 */
  workspaceId: string;
}

/** 完整语音配置。 */
export interface VoiceConfig {
  /** TUI UI 文案语言（槽位指示、toast、命令标题）。 */
  uiLanguage: Language;
  /** 工具文案语言（`voice_cli` 工具描述 + `voice-cli --help`）。 */
  toolLanguage: Language;
  /** 音频输入设备友好名；空 = 自动取第一个输入设备。 */
  device: string;
  asr: {
    /** provider 预设。 */
    provider: AsrProviderId;
    /** 模型名；空 = 用 provider 预设模型。 */
    model: string;
    /** 识别语言；空 = 自动识别。 */
    language: string;
    /** 语言提示（paraformer `language_hints`）；不支持的 provider 会忽略。 */
    languageHints: string[];
    /** 热词表 ID（paraformer `vocabulary_id`）；不支持的 provider 会忽略。 */
    vocabularyId: string;
    /** 领域上下文/语料（inference `input.context`）；当前无 provider 支持，会忽略。 */
    context: string;
    /** 云端凭证。 */
    credentials: AsrCredentialsConfig;
  };
  vad: {
    /** 语音活动检测阈值 [-1,1]。 */
    threshold: number;
    /** 句尾静音判定毫秒 [200,6000]。 */
    silenceDurationMs: number;
  };
  tts: {
    /** 合成后端。 */
    provider: string;
    /** 音色名；空 = 系统默认。 */
    voice: string;
    /** 语速；SAPI [-10,10]（0 中性），CosyVoice [0.5,2]（0 = 未指定 → 1.0）。 */
    rate: number;
    /** 风格/情感/方言指令；仅 CosyVoice 支持。 */
    instruction: string;
    /** 音高；仅 CosyVoice，[0.5,2]（0 = 未指定 → 1.0）。 */
    pitch: number;
    /** 音量 [0,100]（0 = 未指定 → provider 默认）。 */
    volume: number;
    /** 输出格式；仅 CosyVoice（pcm/wav/mp3/opus）。 */
    format: string;
    /** 采样率；仅 CosyVoice（8000/16000/22050/24000/44100/48000，0 = provider 默认）。 */
    sampleRate: number;
    /** 模型名；空 = provider 默认（CosyVoice = cosyvoice-v2）。 */
    model: string;
  };
}

/** 内置默认配置。 */
export const DEFAULT_VOICE_CONFIG: VoiceConfig = {
  uiLanguage: DEFAULT_LANGUAGE,
  toolLanguage: DEFAULT_LANGUAGE,
  device: "",
  asr: {
    provider: DEFAULT_ASR_PROVIDER,
    model: "",
    language: DEFAULT_ASR_LANGUAGE,
    languageHints: [],
    vocabularyId: DEFAULT_ASR_VOCABULARY_ID,
    context: DEFAULT_ASR_CONTEXT,
    credentials: { path: "", apiKey: "", workspaceId: "" },
  },
  vad: { threshold: DEFAULT_VAD_THRESHOLD, silenceDurationMs: DEFAULT_VAD_SILENCE_MS },
  tts: {
    provider: DEFAULT_TTS_PROVIDER,
    voice: "",
    rate: DEFAULT_TTS_RATE,
    instruction: DEFAULT_TTS_INSTRUCTION,
    pitch: DEFAULT_TTS_PITCH,
    volume: DEFAULT_TTS_VOLUME,
    format: DEFAULT_TTS_FORMAT,
    sampleRate: DEFAULT_TTS_SAMPLE_RATE,
    model: DEFAULT_TTS_MODEL,
  },
};

/**
 * 首次运行写入的默认配置模板（JSONC，带注释）。
 * 与 `DEFAULT_VOICE_CONFIG` 必须等价——由单测断言防漂移。
 */
export const DEFAULT_CONFIG_TEMPLATE = `// emotions.jsonc —— opencode-emotions 语音配置
// 修改后重启 opencode（或重新按热键）生效。环境变量可覆盖同名项（见 README）。
{
  // TUI UI 文案语言（槽位指示、toast、命令标题）：en（默认）| zh（改后重启 opencode 生效）
  "uiLanguage": "en",
  // 工具文案语言（voice_cli 工具描述 + voice-cli --help）：en（默认）| zh（改后重启 opencode 生效）
  "toolLanguage": "en",
  // 旧键 language 已拆成上面两键；两者缺省时回退 language，再缺省用 en（一般无需再写）
  // 音频输入设备友好名；留空 = 自动取第一个输入设备（可用 voice-runtime --list 查看）
  "device": "",
  "asr": {
    // aliyun-qwen(默认,16k,7类情绪) | aliyun-8k(8k,3类) | aliyun-v2(16k,无情绪)
    "provider": "aliyun-qwen",
    // 模型名；留空 = 按 provider 预设自动选择
    "model": "",
    // 识别语言；留空 = 自动识别（多语言）。可选 zh/yue/en/ja/ko/de/fr/ru ...
    "language": "",
    // 语言提示（paraformer language_hints）；仅 aliyun-8k / aliyun-v2 支持，其余忽略
    "languageHints": [],
    // 热词表 ID（paraformer vocabulary_id）；仅 aliyun-8k / aliyun-v2 支持，其余忽略
    "vocabularyId": "",
    // 领域上下文/语料（run-task input.context）；当前无 provider 支持，始终忽略
    "context": "",
    // 云端凭证；优先级：环境变量(DASHSCOPE_API_KEY/DASHSCOPE_WORKSPACE_ID) > 此处 apiKey/workspaceId > path 文件 > 默认 .tmp/aliyun
    "credentials": {
      "path": "",
      "apiKey": "",
      "workspaceId": ""
    }
  },
  "vad": {
    // 语音活动检测阈值 [-1,1]；越高越抗噪、越低越灵敏（易误触发）
    "threshold": 0.5,
    // 句尾静音判定毫秒 [200,6000]
    "silenceDurationMs": 800
  },
  "tts": {
    // sapi(默认,本机 Windows SAPI) | aliyun(阿里云 CosyVoice)
    "provider": "sapi",
    // 音色名；留空 = provider 默认
    "voice": "",
    // 语速；sapi [-10,10]（0 中性），aliyun CosyVoice [0.5,2]（0 = 未指定 → 1.0）
    "rate": 0,
    // 风格/情感/方言指令（仅 aliyun CosyVoice；sapi 忽略）
    "instruction": "",
    // 音高 [0.5,2]（仅 aliyun CosyVoice；0 = 未指定 → 1.0；sapi 忽略）
    "pitch": 0,
    // 音量 [0,100]（0 = 未指定 → provider 默认）
    "volume": 0,
    // 输出格式（仅 aliyun CosyVoice：pcm/wav/mp3/opus；留空 = wav）
    "format": "",
    // 采样率（仅 aliyun CosyVoice：8000/16000/22050/24000/44100/48000；0 = 22050）
    "sampleRate": 0,
    // 云 TTS 模型名；留空 = provider 默认（CosyVoice = cosyvoice-v2）
    "model": ""
  }
}
`;

/** loadVoiceConfig 的选项。 */
export interface LoadVoiceConfigOptions {
  /** 配置目录；缺省按 `EMOTIONS_CONFIG_DIR`（兼容旧名 `VOICE_CONFIG_DIR`）/ 默认目录解析。 */
  configDir?: string;
  /** 环境变量表（默认 process.env，可注入便于测试）。 */
  env?: NodeJS.ProcessEnv;
}

/**
 * 解析 provider 预设；未知标识回退到默认 provider。
 * @param id provider 标识
 * @returns provider 预设
 */
export function resolveAsrProvider(id: string): AsrProviderPreset {
  const preset = ASR_PROVIDER_PRESETS[id as AsrProviderId];
  return preset ?? ASR_PROVIDER_PRESETS[DEFAULT_ASR_PROVIDER];
}

/** 用户请求的 ASR 增强参数（来自配置文件/环境变量）。 */
export interface AsrRequestedParams {
  language: string;
  languageHints: string[];
  vocabularyId: string;
  context: string;
}

/** 按 provider 能力过滤后的 ASR 参数；`ignored` 为被忽略的键名。 */
export interface ResolvedAsrParams extends AsrRequestedParams {
  ignored: string[];
}

/**
 * 按 provider 能力过滤 ASR 增强参数（纯函数，便于参数桩单测）。
 *
 * - `language`：所有 provider 都支持（realtime 走 `input_audio_transcription.language`），一律保留；
 * - `languageHints` / `vocabularyId`：仅 paraformer（aliyun-8k / aliyun-v2）支持；
 * - `context`：当前**无 provider 支持**（qwen3-asr-flash-realtime 与 paraformer 均不支持），始终忽略。
 * 被忽略的键名收集到 `ignored`，由调用方记一条日志（不报错）。
 * @param preset provider 预设
 * @param requested 用户配置
 * @returns 过滤后的参数 + 被忽略键名
 */
export function resolveAsrParams(preset: AsrProviderPreset, requested: AsrRequestedParams): ResolvedAsrParams {
  const ignored: string[] = [];
  const hints = requested.languageHints.map((hint) => hint.trim()).filter((hint) => hint.length > 0);
  if (hints.length > 0 && !preset.supportsLanguageHints) ignored.push("languageHints");
  if (requested.vocabularyId.length > 0 && !preset.supportsVocabulary) ignored.push("vocabularyId");
  if (requested.context.length > 0 && !preset.supportsContext) ignored.push("context");
  return {
    language: requested.language,
    languageHints: preset.supportsLanguageHints ? hints : [],
    vocabularyId: preset.supportsVocabulary ? requested.vocabularyId : "",
    context: preset.supportsContext ? requested.context : "",
    ignored,
  };
}

/**
 * 计算配置文件绝对路径。
 * @param options 选项（configDir/env）
 * @returns `<配置目录>/emotions.jsonc`
 */
export function voiceConfigPath(options: LoadVoiceConfigOptions = {}): string {
  const dir = options.configDir ?? resolveConfigDir({ envNames: [ENV_CONFIG_DIR, LEGACY_ENV_CONFIG_DIR] });
  return join(dir, CONFIG_FILE_NAME);
}

/**
 * 计算旧配置文件（`voice.jsonc`）的绝对路径，仅用于向后兼容迁移与文档提示。
 * @param options 选项（configDir）
 * @returns `<配置目录>/voice.jsonc`
 */
export function legacyVoiceConfigPath(options: { configDir?: string } = {}): string {
  const dir = options.configDir ?? resolveConfigDir({ envNames: [ENV_CONFIG_DIR, LEGACY_ENV_CONFIG_DIR] });
  return join(dir, LEGACY_CONFIG_FILE_NAME);
}

/**
 * 加载语音配置：旧名迁移 → 文件缺失则写默认，读取失败静默降级，最后叠加环境变量。
 * @param options 选项（configDir/env）
 * @returns 归一化后的配置
 */
export function loadVoiceConfig(options: LoadVoiceConfigOptions = {}): VoiceConfig {
  const env = options.env ?? process.env;
  const path = voiceConfigPath({ ...options, env });
  let fileConfig: VoiceConfig;
  if (!existsSync(path)) {
    // 旧文件名迁移成功则直接读新文件（保留用户已改的值）；否则写一份默认
    if (migrateLegacyConfig(path)) fileConfig = readConfigFile(path);
    else {
      writeDefaultConfig(path);
      fileConfig = DEFAULT_VOICE_CONFIG;
    }
  } else {
    fileConfig = readConfigFile(path);
  }
  return applyEnvOverrides(fileConfig, env);
}

/**
 * 向后兼容迁移：目标 `emotions.jsonc` 不存在而旧 `voice.jsonc` 存在时，把旧文件**原样复制**为目标
 * （不改用户任何配置值，**保留旧文件**）。复制失败（无权限/目录不可建）返回 false，由调用方回落写默认。
 * @param targetPath 目标配置文件绝对路径
 * @returns 是否完成迁移
 */
function migrateLegacyConfig(targetPath: string): boolean {
  const legacyPath = legacyVoiceConfigPath({ configDir: dirname(targetPath) });
  if (legacyPath === targetPath || !existsSync(legacyPath)) return false;
  try {
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, readFileSync(legacyPath, "utf8"), "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * 读取并归一化配置文件；任何失败都静默返回默认配置。
 * @param path 配置文件路径
 * @returns 归一化配置
 */
function readConfigFile(path: string): VoiceConfig {
  try {
    return normalizeConfig(parseJsonc(readFileSync(path, "utf8")));
  } catch {
    return DEFAULT_VOICE_CONFIG;
  }
}

/**
 * 尽力写一份默认配置；失败（无权限/目录不可建）静默忽略。
 * @param path 目标路径
 */
function writeDefaultConfig(path: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, DEFAULT_CONFIG_TEMPLATE, "utf8");
  } catch {
    // 写默认失败不应影响启动
  }
}

/** 判断值是否为非数组对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 仅接受字符串，否则返回 fallback。 */
function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/** 仅接受有限数字，否则返回 fallback。 */
function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** 仅接受字符串数组（逐项去空白、丢弃空串），否则返回 fallback。 */
function asStringArray(value: unknown, fallback: readonly string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/** 夹取到区间。 */
function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** 校验 provider 标识。 */
function asProvider(value: unknown): AsrProviderId {
  return typeof value === "string" && value in ASR_PROVIDER_PRESETS
    ? (value as AsrProviderId)
    : DEFAULT_ASR_PROVIDER;
}

/**
 * 把任意解析结果归一化为完整配置（缺字段/类型不符逐项回退默认）。
 * @param raw 解析结果
 * @returns 完整配置
 */
function normalizeConfig(raw: unknown): VoiceConfig {
  if (!isRecord(raw)) return DEFAULT_VOICE_CONFIG;
  const asr = isRecord(raw.asr) ? raw.asr : {};
  const vad = isRecord(raw.vad) ? raw.vad : {};
  const tts = isRecord(raw.tts) ? raw.tts : {};
  const credentials = isRecord(asr.credentials) ? asr.credentials : {};
  // 语言回退链：新键（缺失/非字符串）→ 旧键 language → 内置默认 en；新键给了非法字符串则按 resolveLanguage 归一（→ en）
  const legacyLanguage = resolveLanguage(asString(raw.language, DEFAULT_VOICE_CONFIG.uiLanguage));
  return {
    uiLanguage: resolveLanguage(asString(raw.uiLanguage, legacyLanguage)),
    toolLanguage: resolveLanguage(asString(raw.toolLanguage, legacyLanguage)),
    device: asString(raw.device, DEFAULT_VOICE_CONFIG.device),
    asr: {
      provider: asProvider(asr.provider),
      model: asString(asr.model, DEFAULT_VOICE_CONFIG.asr.model),
      language: asString(asr.language, DEFAULT_VOICE_CONFIG.asr.language),
      languageHints: asStringArray(asr.languageHints, DEFAULT_VOICE_CONFIG.asr.languageHints),
      vocabularyId: asString(asr.vocabularyId, DEFAULT_VOICE_CONFIG.asr.vocabularyId),
      context: asString(asr.context, DEFAULT_VOICE_CONFIG.asr.context),
      credentials: {
        path: asString(credentials.path, DEFAULT_VOICE_CONFIG.asr.credentials.path),
        apiKey: asString(credentials.apiKey, DEFAULT_VOICE_CONFIG.asr.credentials.apiKey),
        workspaceId: asString(credentials.workspaceId, DEFAULT_VOICE_CONFIG.asr.credentials.workspaceId),
      },
    },
    vad: {
      threshold: clamp(asNumber(vad.threshold, DEFAULT_VAD_THRESHOLD), VAD_THRESHOLD_MIN, VAD_THRESHOLD_MAX),
      silenceDurationMs: clamp(
        asNumber(vad.silenceDurationMs, DEFAULT_VAD_SILENCE_MS),
        VAD_SILENCE_MIN,
        VAD_SILENCE_MAX,
      ),
    },
    tts: {
      provider: asString(tts.provider, DEFAULT_VOICE_CONFIG.tts.provider),
      voice: asString(tts.voice, DEFAULT_VOICE_CONFIG.tts.voice),
      rate: clamp(asNumber(tts.rate, DEFAULT_VOICE_CONFIG.tts.rate), TTS_RATE_MIN, TTS_RATE_MAX),
      instruction: asString(tts.instruction, DEFAULT_VOICE_CONFIG.tts.instruction),
      pitch: asNumber(tts.pitch, DEFAULT_VOICE_CONFIG.tts.pitch),
      volume: asNumber(tts.volume, DEFAULT_VOICE_CONFIG.tts.volume),
      format: asString(tts.format, DEFAULT_VOICE_CONFIG.tts.format),
      sampleRate: asNumber(tts.sampleRate, DEFAULT_VOICE_CONFIG.tts.sampleRate),
      model: asString(tts.model, DEFAULT_VOICE_CONFIG.tts.model),
    },
  };
}

/**
 * 用环境变量覆盖配置（仅非空值生效）。
 * @param config 基础配置
 * @param env 环境变量表
 * @returns 覆盖后的配置
 */
function applyEnvOverrides(config: VoiceConfig, env: NodeJS.ProcessEnv): VoiceConfig {
  const out: VoiceConfig = {
    uiLanguage: config.uiLanguage,
    toolLanguage: config.toolLanguage,
    device: config.device,
    asr: { ...config.asr },
    vad: { ...config.vad },
    tts: { ...config.tts },
  };
  const text = (name: string): string | undefined => {
    const value = env[name];
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
  };
  const numeric = (name: string): number | undefined => {
    const value = text(name);
    if (value === undefined) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  const device = text(ENV_DEVICE);
  if (device !== undefined) out.device = device;
  // 旧环境变量 VOICE_LANGUAGE 兜底两者；新名优先级高于旧名
  const legacyEnvLanguage = text(ENV_LANGUAGE);
  const ui = text(ENV_UI_LANGUAGE) ?? legacyEnvLanguage;
  if (ui !== undefined) out.uiLanguage = resolveLanguage(ui);
  const tool = text(ENV_TOOL_LANGUAGE) ?? legacyEnvLanguage;
  if (tool !== undefined) out.toolLanguage = resolveLanguage(tool);
  const provider = text(ENV_ASR_PROVIDER);
  if (provider !== undefined) out.asr.provider = asProvider(provider);
  const model = text(ENV_ASR_MODEL);
  if (model !== undefined) out.asr.model = model;
  const language = text(ENV_ASR_LANGUAGE);
  if (language !== undefined) out.asr.language = language;
  const hints = text(ENV_ASR_LANGUAGE_HINTS);
  if (hints !== undefined) {
    out.asr.languageHints = hints
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  const vocabularyId = text(ENV_ASR_VOCABULARY_ID);
  if (vocabularyId !== undefined) out.asr.vocabularyId = vocabularyId;
  const context = text(ENV_ASR_CONTEXT);
  if (context !== undefined) out.asr.context = context;
  const threshold = numeric(ENV_VAD_THRESHOLD);
  if (threshold !== undefined) out.vad.threshold = clamp(threshold, VAD_THRESHOLD_MIN, VAD_THRESHOLD_MAX);
  const silence = numeric(ENV_VAD_SILENCE_MS);
  if (silence !== undefined) out.vad.silenceDurationMs = clamp(silence, VAD_SILENCE_MIN, VAD_SILENCE_MAX);

  const ttsProvider = text("TTS_PROVIDER");
  if (ttsProvider !== undefined) out.tts.provider = ttsProvider;
  const ttsVoice = text("TTS_VOICE");
  if (ttsVoice !== undefined) out.tts.voice = ttsVoice;
  const ttsRate = numeric("TTS_RATE");
  if (ttsRate !== undefined) out.tts.rate = clamp(ttsRate, TTS_RATE_MIN, TTS_RATE_MAX);
  const ttsInstruction = text("TTS_INSTRUCTION");
  if (ttsInstruction !== undefined) out.tts.instruction = ttsInstruction;
  const ttsPitch = numeric("TTS_PITCH");
  if (ttsPitch !== undefined) out.tts.pitch = ttsPitch;
  const ttsVolume = numeric("TTS_VOLUME");
  if (ttsVolume !== undefined) out.tts.volume = ttsVolume;
  const ttsFormat = text("TTS_FORMAT");
  if (ttsFormat !== undefined) out.tts.format = ttsFormat;
  const ttsSampleRate = numeric("TTS_SAMPLE_RATE");
  if (ttsSampleRate !== undefined) out.tts.sampleRate = ttsSampleRate;
  const ttsModel = text("TTS_MODEL");
  if (ttsModel !== undefined) out.tts.model = ttsModel;

  return out;
}
