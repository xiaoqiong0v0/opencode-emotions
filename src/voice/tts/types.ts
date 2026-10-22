/**
 * 语音输出（TTS）的 provider 契约与配置解析。
 *
 * 设计要点：
 * - provider 只负责「后台开始一次朗读」与「停止」，并发/打断由 provider 自身保证（见 docs/ASYNC.md）；
 * - 配置优先级：工具参数 > 环境变量 > emotions.jsonc 文件配置 > 常量默认值；
 * - 纯函数（clampRate / resolveTtsConfig）与 IO 解耦，便于离线单测。
 */

import type { CredentialFileConfig } from "../credentials.js";
import { resolveEmotionInstruction } from "./emotion.js";
import { DEFAULT_STREAM_MIN_CHARS, normalizeStreamMinChars } from "./stream.js";

/** TTS 文件配置切片（来自 `<配置目录>/emotions.jsonc` 的 `tts` 节）。 */
export interface TtsFileDefaults {
  provider?: string;
  voice?: string;
  rate?: number;
  instruction?: string;
  pitch?: number;
  volume?: number;
  format?: string;
  sampleRate?: number;
  model?: string;
  /** 流式送文的最小缓冲阈值（首次发送前需缓冲的字符数；非负整数）。 */
  streamMinChars?: number;
}

/** provider 选择环境变量（默认 sapi）。 */
export const ENV_PROVIDER = "TTS_PROVIDER";
/** 音色环境变量（空 = provider 默认音色）。 */
export const ENV_VOICE = "TTS_VOICE";
/** 语速环境变量（SAPI 范围 -10..10）。 */
export const ENV_RATE = "TTS_RATE";
/** 风格/情感指令环境变量（仅 CosyVoice）。 */
export const ENV_INSTRUCTION = "TTS_INSTRUCTION";
/** 音高环境变量（仅 CosyVoice）。 */
export const ENV_PITCH = "TTS_PITCH";
/** 音量环境变量（0..100）。 */
export const ENV_VOLUME = "TTS_VOLUME";
/** 输出格式环境变量（仅 CosyVoice）。 */
export const ENV_FORMAT = "TTS_FORMAT";
/** 采样率环境变量（仅 CosyVoice）。 */
export const ENV_SAMPLE_RATE = "TTS_SAMPLE_RATE";
/** 模型名环境变量（仅 CosyVoice）。 */
export const ENV_MODEL = "TTS_MODEL";
/** 流式最小缓冲阈值环境变量（首次发送前需缓冲的字符数）。 */
export const ENV_STREAM_MIN_CHARS = "TTS_STREAM_MIN_CHARS";
/** 默认 provider。 */
export const DEFAULT_PROVIDER = "sapi";
/** 默认语速。 */
export const DEFAULT_RATE = 0;
/** 语速下界（SAPI 约定）。 */
export const MIN_RATE = -10;
/** 语速上界（SAPI 约定）。 */
export const MAX_RATE = 10;
/** 音色为空时对外的占位标签。 */
export const DEFAULT_VOICE_LABEL = "默认";
/** 风格指令默认（空 = 不下发）。 */
export const DEFAULT_INSTRUCTION = "";
/** 音高默认（0 = 未指定 → provider 默认）。 */
export const DEFAULT_PITCH = 0;
/** 音量默认（0 = 未指定 → provider 默认）。 */
export const DEFAULT_VOLUME = 0;
/** 输出格式默认（空 = provider 默认）。 */
export const DEFAULT_FORMAT = "";
/** 采样率默认（0 = provider 默认）。 */
export const DEFAULT_SAMPLE_RATE = 0;
/** 模型名默认（空 = provider 默认）。 */
export const DEFAULT_MODEL = "";

/** 一次朗读请求（工具入参 / CLI 参数）。 */
export interface TtsRequest {
  /** 待朗读文本（非空）。 */
  text: string;
  /** 音色名；省略/空串 = provider 默认音色。 */
  voice?: string;
  /** 语速；省略 = 环境变量/默认值。 */
  rate?: number;
  /** 情绪名（happy/sad/…，可为别名）；映射为 CosyVoice 风格指令，sapi 忽略。 */
  emotion?: string;
  /** provider 覆盖（sapi/aliyun/termux）；省略 = 环境变量/文件配置/默认。 */
  provider?: string;
}

/** 解析后的朗读参数（`voice` 空串表示用 provider 默认音色）。 */
export interface ResolvedTtsOptions {
  text: string;
  voice: string;
  rate: number;
  /** 风格/情感/方言指令（仅 CosyVoice）。 */
  instruction: string;
  /** 音高（0 = 未指定；仅 CosyVoice）。 */
  pitch: number;
  /** 音量 [0,100]（0 = 未指定）。 */
  volume: number;
  /** 输出格式（空 = provider 默认）。 */
  format: string;
  /** 采样率（0 = provider 默认）。 */
  sampleRate: number;
  /** 模型名（空 = provider 默认）。 */
  model: string;
  /** 流式送文的最小缓冲阈值（首次发送前需缓冲的字符数；非负整数，默认 5）。 */
  streamMinChars: number;
  /** 云端凭证配置（仅云 provider 需要；缺省用默认路径/环境变量）。 */
  credentials?: CredentialFileConfig;
  /** MiMo 专用 API Key（仅 provider=mimo；由 speak() 按 env `MIMO_API_KEY` > `tts.mimoCredentials.apiKey` 解析后传入）。 */
  mimoApiKey?: string;
}

/** 某一 provider 支持的参数集合（用于忽略不支持项并记日志）。 */
export interface TtsParamSupport {
  voice: boolean;
  rate: boolean;
  volume: boolean;
  pitch: boolean;
  instruction: boolean;
  format: boolean;
  sampleRate: boolean;
  model: boolean;
}

/** 各 provider 的参数能力表。 */
export const TTS_PROVIDER_CAPABILITIES: Readonly<Record<string, TtsParamSupport>> = {
  sapi: {
    voice: true,
    rate: true,
    volume: true,
    pitch: false,
    instruction: false,
    format: false,
    sampleRate: false,
    model: false,
  },
  aliyun: {
    voice: true,
    rate: true,
    volume: true,
    pitch: true,
    instruction: true,
    format: true,
    sampleRate: true,
    model: true,
  },
  termux: {
    // Android 系统 TTS：仅支持语速（映射到 -r）；音色/音高/风格等由系统决定
    voice: false,
    rate: true,
    volume: false,
    pitch: false,
    instruction: false,
    format: false,
    sampleRate: false,
    model: false,
  },
  mimo: {
    // 小米 MiMo（OpenAI 兼容 SSE 流式）：音色走预置列表；rate 无原生参数，
    // 非 0 时并入 user 风格指令文本（见 mimo.ts resolveMimoParams）；format/sampleRate 固定 pcm16/24000
    voice: true,
    rate: true,
    volume: false,
    pitch: false,
    instruction: true,
    format: false,
    sampleRate: false,
    model: true,
  },
};

/** 解析后的完整配置（provider + 朗读参数）。 */
export interface ResolvedTtsConfig extends ResolvedTtsOptions {
  provider: string;
}

/** 一次朗读的启动结果（不代表播放已完成）。 */
export interface SpeakResult {
  provider: string;
  voice: string;
  rate: number;
  /** 云 TTS 任务 ID（供外部记录/取消；本地 provider 无）。 */
  taskId?: string;
  /** 播放真正结束（成功或失败）时 settle 的 Promise；调用方可 `await` 以保持进程存活。 */
  done?: Promise<void>;
}

/** TTS provider 契约。 */
export interface TtsProvider {
  /** provider 标识（如 sapi / aliyun）。 */
  readonly name: string;
  /**
   * 是否支持 **follow 常驻模式**（CLI `speak --follow`：从 stdin 按行读文本，对同一 provider 实例
   * 连续 speak；EOF 收尾）。仅本地可常驻发声子进程的 provider 实现（现仅 sapi）；
   * undefined/false 时 CLI `--follow` 报清晰错误，auto-read 走按块 spawn 旧路径。
   */
  readonly followSupport?: boolean;
  /**
   * 后台开始朗读：立即返回，不等待播放完成；内部负责打断上一次未完成的朗读。
   * @param options 解析后的朗读参数
   * @returns 本次朗读的启动结果
   */
  speak(options: ResolvedTtsOptions): SpeakResult;
  /** 停止当前朗读并清理子进程/连接（幂等，可重复调用）。 */
  stop(): void;
  /**
   * 当前**真正发声**的子进程 PID（孙进程，如 sapi 的 PowerShell）。
   *
   * 时序契约：`speak()` 是**同步返回**的、发声子进程在 `speak()` 内已 spawn ⇒ 调用方在
   * `speak()` 返回后读一次即可拿到 PID（CLI `registerPlaybackLifecycle` 据此补写 `tts-playback`
   * 的 `playerPid`，供跨进程打断杀孙进程——Windows `TerminateProcess` 不杀子孙）。
   * follow 模式下同理：`followStart()` 同步 spawn 常驻发声子进程 ⇒ 返回后 `activePlayerPid()`
   * 即其 PID（worker CLI 启动时一次写盘登记）。
   * 缺省不实现＝该 provider 无独立发声子进程（aliyun/mimo 流式 waveOut 靠 stdin EOF 自退，无需登记）。
   * @returns 子进程 PID；无存活发声子进程时 undefined
   */
  activePlayerPid?(): number | undefined;
  /**
   * follow 模式：启动常驻发声子进程（同步返回；仅 `followSupport === true` 的 provider 实现）。
   * 不打断语义由实现负责（sapi：先 `stop()` 杀旧子进程再 spawn）；行文本经 `followLine()` 送入。
   * @param options 解析后的朗读参数（voice/rate/volume 等；`text` 忽略——正文走 stdin 行）
   */
  followStart?(options: ResolvedTtsOptions): void;
  /**
   * follow 模式：送入一行待朗读文本（不含换行；写方保证）。
   * 常驻子进程已死/未启动时抛错（调用方据此停止该消息的朗读）。
   * @param text 一行文本（非空）
   */
  followLine?(text: string): void;
  /**
   * follow 模式收尾：关闭常驻子进程的输入流（EOF）并等待其退出（冲刷尾音；有界超时后强杀）。
   * 幂等：子进程已退出/未启动时立即 resolve。
   * @returns 常驻子进程退出后 resolve（超时强杀后同样 resolve）
   */
  followEnd?(): Promise<void>;
}

/**
 * 把语速夹到合法区间；非法（NaN/非有限）时回退到 fallback。
 * @param value 原始语速
 * @param fallback 非法时的回退值
 * @returns 区间内的整数语速
 */
export function clampRate(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  const rounded = Math.trunc(value);
  if (rounded < MIN_RATE) return MIN_RATE;
  if (rounded > MAX_RATE) return MAX_RATE;
  return rounded;
}

/**
 * 从环境变量解析可选数字。
 * @param raw 环境变量原始值
 * @returns 有限数字；缺失/非法时返回 undefined
 */
function parseNumberEnv(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * 夹取到区间；非法（NaN/非有限）时回退 fallback（不取整，供浮点语速/音高使用）。
 * @param value 原始值
 * @param min 下界
 * @param max 上界
 * @param fallback 非法时的回退值
 * @returns 区间内的数字
 */
function clampFinite(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * 合并「工具参数 / 环境变量 / 文件配置 / 默认值」得到最终配置。
 * @param request 工具入参
 * @param env 环境变量表（默认 process.env，可注入便于测试）
 * @param fileDefaults emotions.jsonc 的 tts 节（缺省为空，便于单测）
 * @returns 解析后的配置
 */
export function resolveTtsConfig(
  request: TtsRequest,
  env: NodeJS.ProcessEnv = process.env,
  fileDefaults: TtsFileDefaults = {},
): ResolvedTtsConfig {
  const provider = (
    request.provider?.trim() ||
    env[ENV_PROVIDER]?.trim() ||
    fileDefaults.provider?.trim() ||
    DEFAULT_PROVIDER
  ).toLowerCase();
  const voice = request.voice?.trim() || env[ENV_VOICE]?.trim() || fileDefaults.voice?.trim() || "";
  const rate = clampFinite(
    request.rate ?? parseNumberEnv(env[ENV_RATE]) ?? fileDefaults.rate ?? DEFAULT_RATE,
    MIN_RATE,
    MAX_RATE,
    DEFAULT_RATE,
  );
  // 情绪优先映射为风格指令；`--emotion` 显式给出时覆盖 env/文件中的 instruction
  const instruction =
    resolveEmotionInstruction(request.emotion) ||
    env[ENV_INSTRUCTION]?.trim() ||
    fileDefaults.instruction?.trim() ||
    DEFAULT_INSTRUCTION;
  const pitch = parseNumberEnv(env[ENV_PITCH]) ?? fileDefaults.pitch ?? DEFAULT_PITCH;
  const volume = parseNumberEnv(env[ENV_VOLUME]) ?? fileDefaults.volume ?? DEFAULT_VOLUME;
  const format = env[ENV_FORMAT]?.trim() || fileDefaults.format?.trim() || DEFAULT_FORMAT;
  const sampleRate = parseNumberEnv(env[ENV_SAMPLE_RATE]) ?? fileDefaults.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const model = env[ENV_MODEL]?.trim() || fileDefaults.model?.trim() || DEFAULT_MODEL;
  const streamMinChars = normalizeStreamMinChars(
    parseNumberEnv(env[ENV_STREAM_MIN_CHARS]) ?? fileDefaults.streamMinChars ?? DEFAULT_STREAM_MIN_CHARS,
  );
  return {
    provider,
    text: request.text,
    voice,
    rate,
    instruction,
    pitch,
    volume,
    format,
    sampleRate,
    model,
    streamMinChars,
  };
}

/**
 * 找出「已设置但该 provider 不支持」的参数键名（供调用方记一条日志后忽略，不报错）。
 * @param provider provider 标识
 * @param options 解析后的朗读参数
 * @returns 被忽略的键名列表（未知 provider 返回空）
 */
export function ignoredTtsParams(provider: string, options: ResolvedTtsOptions): string[] {
  const caps = TTS_PROVIDER_CAPABILITIES[provider];
  if (!caps) return [];
  const checks: Array<[keyof TtsParamSupport, boolean]> = [
    ["pitch", options.pitch !== 0],
    ["instruction", options.instruction.length > 0],
    ["format", options.format.length > 0],
    ["sampleRate", options.sampleRate !== 0],
    ["model", options.model.length > 0],
  ];
  return checks.filter(([key, isSet]) => isSet && !caps[key]).map(([key]) => key);
}
