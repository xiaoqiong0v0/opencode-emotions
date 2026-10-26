/**
 * 按段（segment）ASR 客户端基类：整段音频 → HTTP → 文本。
 *
 * 分段策略（本仓库无本地 VAD 实现，服务端 VAD 参数只对 stream 生效，故按段自建**最小能量静音切段**）：
 * - 复用 `config.vad` 两个键：`silenceDurationMs` 直接作为「连续静音多久算一句结束」；
 *   `threshold` 沿用其「越高越抗噪」的单调语义，但**不再乘比例当线性 RMS**——改为映射到 **dBFS**、
 *   且能量按 **30ms 短帧**逐帧判定（见 {@link thresholdToDbfs} 与文件头「能量标定」）。
 * - **底噪自适应门限**（2026-10-24，推翻固定 -35 dBFS 的旧标定）：本机麦克风底噪实测 RMS 0.03~0.05
 *   （≈ -30~-26 dBFS，**高于旧门限 -35 dBFS**）⇒ 旧实现逐帧都判「有语音」、`silenceMs` 恒 0，
 *   说话中永不切段（只能等时长上限或停止冲刷），静音段还会被送去识别产生幻听文本。
 *   现按「最近 5s 的 30ms 帧 p10 滑动分位」算实际门限（见 {@link computeGateDbfs} 与
 *   {@link NOISE_WINDOW_MS}）：冷启动偏低能自愈、说话期间 p10 仍贴底噪不漂移。
 * - 段边界：出现「已检测到语音 + 连续静音 ≥ silenceDurationMs」→ 切段；
 *   另有时长上限 {@link DEFAULT_MAX_SEGMENT_MS}（12s）与体积上限（10MB base64 红线）强制切段兜底。
 * - 「检测到语音」需**连续 {@link VOICE_CONFIRM_FRAMES} 帧**越过门限（150ms）才置真，单帧/孤立尖峰不算；
 *   确认前的帧仍留在缓冲里（不丢句首 150ms），`silenceMs` 只统计**置真之后**的静音。
 * - 纯静音缓冲（从未检测到语音）在 finish/静音切段时**丢弃不发送**（识别结果必为空，省一次请求）。
 *
 * 10MB base64 红线：发送前把 PCM 打包为 WAV 并按 data URL 估算体积，超限则把该段 PCM
 * **均分切开后顺序发送**、各切片结果分别产出（不丢段）。
 *
 * 并发：单线程事件循环 + 串行 drain（同一时刻至多一个在途 HTTP）；`close()` abort 在途请求。
 * 并发契约登记见 docs/ASYNC.md 交互点 ⑮。
 */

import createLogger from "@xiaoqiong0v0/opencode-plugin-logger";
import type { Logger } from "@xiaoqiong0v0/opencode-plugin-logger";

import { DEFAULT_VAD_MARGIN_DB, DEFAULT_VAD_SILENCE_MS, DEFAULT_VAD_THRESHOLD, VAD_MARGIN_MAX_DB, VAD_MARGIN_MIN_DB } from "../config.js";
import { redact } from "../credentials.js";
// 能量口径（RMS→dBFS）单源在 `voice/level.ts`（TTS 首尾静音裁剪复用同一口径）；此处再导出保持既有导入路径。
import { pcmRms, rmsToDbfs } from "../level.js";
import { buildWav, WAV_HEADER_BYTES } from "../wav.js";
import type { AsrClient, AsrResult, AsrTransport } from "./types.js";

export { pcmRms, rmsToDbfs };

/** 诊断日志（与其它模块同一份插件日志；未启用时是空实现）。 */
const log: Logger = createLogger("asr-segment");

/** 两家按段 provider 共同的 base64 输入体积红线（10MB；阿里 qwen3-asr-flash 与 MiMo 官方一致）。 */
export const MAX_BASE64_BYTES = 10 * 1024 * 1024;
/** WAV data URL 前缀（`data:audio/wav;base64,`）。 */
export const WAV_DATA_URL_PREFIX = "data:audio/wav;base64,";
/** 默认单段最长时长（毫秒）：12s，控制单次请求延迟与缓冲上界（连续说话时的兜底切段）。 */
export const DEFAULT_MAX_SEGMENT_MS = 12000;
/**
 * 能量判定短帧长度（毫秒）。
 *
 * 根因（2026-10-22 审计实测）：采集回调是 **500ms/块**，旧实现按**整块平均 RMS** 与门限比较，
 * 真实语声（说话块平均 RMS 实测 0.03~0.04）被整窗平均摊薄到门限（0.05）以下 ⇒ 整段静默丢弃。
 * 语音在 20~40ms 尺度上近似平稳、在 500ms 尺度上被停顿稀释，故改按短帧判定（30ms 约一帧清音周期）。
 */
export const ENERGY_FRAME_MS = 30;
/**
 * `vad.threshold=0`（最灵敏）对应的短帧门限（dBFS）。
 * 这是**配置基线**的下界；实际门限还会被底噪自适应抬升（见 {@link computeGateDbfs}），
 * 并同样夹在 [{@link ENERGY_DBFS_MIN}, {@link ENERGY_DBFS_MAX}] 内。
 */
export const ENERGY_DBFS_MIN = -50;
/**
 * `vad.threshold=1`（最抗噪）对应的短帧门限（dBFS）：RMS≈0.1，只能被近距离大声说话越过。
 * 也是自适应门限的上界（本机底噪可到 -26 dBFS，再高就没法用固定映射兜住）。
 */
export const ENERGY_DBFS_MAX = -20;
/**
 * 底噪滑动窗口长度（毫秒）：维护最近 5s 的 30ms 帧能量，取低分位作 `noiseDbfs`。
 *
 * 为什么用滑动分位（2026-10-25 一手实测，推翻同日「冷启动标定 + 只降不升」）：
 * - 冷启动瞬间常是**数字静音**（实测 `noise=-73.4`），一次性标定会把它锁死；「只降不升」
 *   又让它永远升不回真实环境底噪（≈-32）⇒ 门限停在 -35（比底噪还低）⇒ 噪声帧全被判语音、
 *   `silenceMs` 恒 0、停顿切段永不成立（只能等 12s 兜底）。
 * - 滑动窗口会自然把冷启动的低值淘汰出去（5s 内自愈到真实底噪）；低分位（p10）在持续说话
 *   期间仍贴底噪、不被语声 p50 带跑。
 */
export const NOISE_WINDOW_MS = 5000;
/** 底噪滑动窗口容量（帧）：`ceil(5000/30)=167`。 */
export const NOISE_WINDOW_FRAMES = Math.ceil(NOISE_WINDOW_MS / ENERGY_FRAME_MS);
/**
 * 底噪分位（p10）：取低分位而非均值——窗口内即使语声占多数，停顿/轻音帧仍落在最低 10%，
 * 比均值更接近真实环境底噪，且不会被语声 p50 抬走。
 */
export const NOISE_WINDOW_PERCENTILE = 0.1;
/**
 * 计算底噪分位所需的最少帧数（≈1s，34 帧）：不足时 `noiseDbfs = null`，退回配置基线门限。
 * 理由：起录即说话的短录音若用几帧语声算 p10，会把门限抬到语声附近、整句漏检；
 * 1s 足够让窗口包含停顿/轻音，又不至于让短按说话被误判。
 */
export const NOISE_WINDOW_MIN_FRAMES = Math.ceil(1000 / ENERGY_FRAME_MS);
/**
 * 分位重算节流（帧）：每 10 帧（300ms）排序重算一次，避免逐帧排序（167 帧窗口）。
 * 门限最多滞后 300ms，远小于 `silenceDurationMs` 与 12s 兜底，不影响切段判定。
 */
export const NOISE_RECALC_FRAMES = 10;
/**
 * 自适应门限相对底噪估计的最小余量（dB）：门限必须比底噪高，否则底噪会被判成语音。
 *
 * 标定（2026-10-24 本机 30ms 帧级实测）：底噪 p10=-32.9 / p99=-27.6 / max=-25.6 dBFS，
 * 正常语声 p50=-16.8 / p90=-12.1 dBFS（SNR≈15dB）。8dB 余量下噪声误判 0%、语音命中 72%；
 * 6dB 余量下误判 0.6%、命中 81%（漏判句首的代价由 {@link VOICE_CONFIRM_FRAMES} 的 150ms 连续确认补回）。
 */
export const NOISE_MARGIN_DB = 6;
/**
 * 语音确认所需**连续**越门限帧数：5×{@link ENERGY_FRAME_MS}=150ms。
 *
 * 为什么需要：余量下调到 6dB 后门限更贴近底噪，单帧噪声尖峰可能越门限；要求连续 150ms 都越门限
 * 才能把段标记为「有语音」，可挡住孤立尖峰（否则会把纯噪声段送去识别）。
 * 注意：确认期间的帧**照常留在缓冲里**，`hasVoice` 置真后整段仍包含句首这 150ms。
 */
export const VOICE_CONFIRM_FRAMES = 5;
/** 底噪记账下界（dBFS）：纯数字静音 RMS=0 → -Infinity，统一按该值记账，避免 -Infinity 进日志/运算。 */
export const NOISE_FLOOR_DBFS = -100;
/** 门限变化达到该幅度（dB）才写一行 info 日志（避免逐帧刷屏；门限随窗口移动时每 3dB 约一条）。 */
export const GATE_LOG_STEP_DB = 3;
/** 单段 HTTP 超时（毫秒）。 */
export const SEGMENT_HTTP_TIMEOUT_MS = 60000;
/**
 * 帧级 VAD 诊断日志的节流窗口（毫秒）：每满 ~2s 汇总输出一行 p50/p90/max/above，
 * 用于定位「说话帧电平 vs 门限」的关系，避免逐帧刷屏。
 */
export const VAD_DIAG_INTERVAL_MS = 2000;
/** 识别结果日志里展示的文本前缀字符数（只用于诊断，不截断实际结果）。 */
export const ASR_RESULT_PREVIEW_CHARS = 20;

/**
 * 按 base64 体积红线反推允许的 WAV 原始字节上限（含 44 字节头与 data URL 前缀的余量）。
 * @param maxBase64Bytes base64 编码后的体积上限（默认 10MB）
 * @returns WAV 文件（头+数据）允许的最大字节数
 */
export function maxWavBytesForBase64(maxBase64Bytes: number = MAX_BASE64_BYTES): number {
  return Math.max(WAV_HEADER_BYTES, Math.floor(((maxBase64Bytes - WAV_DATA_URL_PREFIX.length) * 3) / 4));
}

/**
 * 把 `vad.threshold`（[0,1]，**越高越抗噪**，保持原单调语义）映射为**配置基线**短帧 dBFS 门限。
 *
 * 2026-10-24 更正：旧注释称「本机静音底噪 -69~-64 dBFS」已被实测推翻——本机底噪 RMS 0.03~0.05
 * （≈ -30~-26 dBFS），高于默认映射的 -35 dBFS。故该映射只是**下限基线**，实际门限还须经
 * {@link computeGateDbfs} 按底噪估计抬升（且最终仍夹在 [-50, -20] dBFS）。
 * @param threshold vad.threshold（越界夹到 [0,1]；非有限值回退默认阈值）
 * @returns 配置基线短帧门限（dBFS）
 */
export function thresholdToDbfs(threshold: number): number {
  const normalized = Number.isFinite(threshold)
    ? Math.min(1, Math.max(0, threshold))
    : DEFAULT_VAD_THRESHOLD;
  return ENERGY_DBFS_MIN + normalized * (ENERGY_DBFS_MAX - ENERGY_DBFS_MIN);
}

/**
 * 把 `vad.marginDb` 夹到 [{@link VAD_MARGIN_MIN_DB}, {@link VAD_MARGIN_MAX_DB}]；非有限值回落 {@link NOISE_MARGIN_DB}。
 * @param value 原始余量（dB，可能未配置）
 * @returns 可直接参与门限计算的余量（dB）
 */
export function clampVadMarginDb(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_VAD_MARGIN_DB;
  return Math.min(VAD_MARGIN_MAX_DB, Math.max(VAD_MARGIN_MIN_DB, value));
}

/**
 * 计算**实际短帧门限**：配置基线、底噪估计 + 余量取较大者，再夹到 [-50, -20] dBFS。
 *
 * 公式：`gate = clamp(max(thresholdToDbfs(配置), noiseDbfs + NOISE_MARGIN_DB), -50, -20)`。
 * 底噪低时回落配置值（不会被噪声估计压低到误触发）；底噪高时抬到噪声之上（不再把底噪判成语音），
 * 上下界保证极端情况下门限仍可用。
 * @param thresholdDbfs 配置基线门限（dBFS，见 {@link thresholdToDbfs}）
 * @param noiseDbfs 当前底噪估计（dBFS）
 * @returns 实际门限（dBFS）
 */
export function computeGateDbfs(thresholdDbfs: number, noiseDbfs: number, marginDb: number = NOISE_MARGIN_DB): number {
  const desired = Math.max(thresholdDbfs, noiseDbfs + marginDb);
  return Math.min(ENERGY_DBFS_MAX, Math.max(ENERGY_DBFS_MIN, desired));
}

/**
 * 按字节上限把 PCM 均分成多段（每段不超过 maxBytes，且保持 16bit 采样点对齐）。
 * @param pcm s16le 字节流
 * @param maxBytes 单段最大字节数
 * @returns 切分后的段数组（空输入返回空数组；不超限时返回 [pcm]）
 */
export function splitPcmByMaxBytes(pcm: Buffer, maxBytes: number): Buffer[] {
  if (pcm.length === 0) return [];
  const limit = Math.max(2, Math.floor(maxBytes / 2) * 2);
  if (pcm.length <= limit) return [pcm];
  const parts = Math.ceil(pcm.length / limit);
  const partLen = Math.ceil(pcm.length / parts / 2) * 2; // 按采样点对齐的均分长度
  const out: Buffer[] = [];
  for (let offset = 0; offset < pcm.length; offset += partLen) {
    out.push(pcm.subarray(offset, Math.min(offset + partLen, pcm.length)));
  }
  return out;
}

/** 段识别结果（由具体 provider 的 HTTP 响应解析而来）。 */
export interface SegmentTranscript {
  /** 整段识别文本。 */
  text: string;
  /** 情绪标签（7 类之一）；provider 不支持时为空串。 */
  emotion: AsrResult["emotion"];
}

/** 分段客户端构造参数（具体 provider 再补自己的凭证/端点字段）。 */
export interface SegmentAsrOptions {
  /** 采集采样率（决定 WAV 头与体积估算；PCM 均为 s16le 单声道）。 */
  sampleRate: number;
  /** VAD 覆盖（沿用 config.vad 键：threshold 越高越抗噪、silenceDurationMs 句尾静音、marginDb 底噪余量）。 */
  vad?: { threshold?: number; silenceDurationMs?: number; marginDb?: number };
  /** 单段最长时长（毫秒，默认 {@link DEFAULT_MAX_SEGMENT_MS}）。 */
  maxSegmentMs?: number;
  /** base64 体积红线（默认 {@link MAX_BASE64_BYTES}）。 */
  maxBase64Bytes?: number;
  /** 识别结果回调（segment 只产 `isFinal: true`）。 */
  onResult: (result: AsrResult) => void;
  /** 错误回调（已脱敏）。 */
  onError?: (message: string) => void;
  /** fetch 实现（测试可注入 mock；默认全局 fetch）。 */
  fetchImpl?: typeof fetch;
  /** 日志实现（默认模块级插件日志；测试可注入以捕获 `[vad]`/`[asr]` 行）。 */
  logger?: Logger;
  /** 时钟（毫秒；默认 `Date.now`，测试可注入以驱动诊断窗口节流）。 */
  now?: () => number;
}

/**
 * 按段 ASR 客户端基类：缓冲 → 静音/超限切段 → 串行逐段 HTTP → 整段 final 结果。
 * 子类只需实现 {@link SegmentAsrClientBase.submitSegment}（发一段 WAV、解析文本/情绪）。
 */
export abstract class SegmentAsrClientBase implements AsrClient {
  readonly transport: AsrTransport = "segment";
  protected readonly sampleRate: number;
  protected readonly fetchImpl: typeof fetch;
  /** 配置基线门限（dBFS；由 vad.threshold 单调映射，见 thresholdToDbfs）。 */
  private readonly baseGateDbfs: number;
  /** 实际短帧门限（dBFS；随底噪估计自适应，见 computeGateDbfs）。 */
  private gateDbfs: number;
  /** 上一次写门限日志时的门限（用于按 GATE_LOG_STEP_DB 节流）。 */
  private lastLoggedGateDbfs: number;
  /**
   * 底噪估计（dBFS）；`null` = 窗口帧数不足 {@link NOISE_WINDOW_MIN_FRAMES}，退回配置基线门限。
   */
  private noiseDbfs: number | null = null;
  /** 底噪滑动窗口环形缓冲（容量 {@link NOISE_WINDOW_FRAMES}，值为已按下界夹取的帧 dBFS）。 */
  private readonly noiseWindow: number[] = new Array<number>(NOISE_WINDOW_FRAMES).fill(NOISE_FLOOR_DBFS);
  /** 环形缓冲写指针（下一个写入位置）。 */
  private noiseWindowIndex = 0;
  /** 环形缓冲有效帧数（上限为容量）。 */
  private noiseWindowCount = 0;
  /** 距上次分位重算的帧数（按 {@link NOISE_RECALC_FRAMES} 节流）。 */
  private noiseFramesSinceRecalc = 0;
  private readonly silenceDurationMs: number;
  private readonly maxSegmentMs: number;
  private readonly maxWavBytes: number;
  /** 自适应门限相对底噪的余量（dB；来自 vad.marginDb，未给则用 {@link NOISE_MARGIN_DB}）。 */
  private readonly marginDb: number;
  private readonly onResult: (result: AsrResult) => void;
  private readonly onError: ((message: string) => void) | undefined;
  /** 日志实现（默认模块级插件日志）。 */
  private readonly logger: Logger;
  /** 时钟（毫秒；诊断窗口节流与测试注入共用）。 */
  private readonly now: () => number;

  /** 当前段缓冲（未切段的 PCM 分片）。 */
  private chunks: Buffer[] = [];
  private bufferedBytes = 0;
  /** 已切段、待发送的队列（串行 drain）。 */
  private queue: Buffer[] = [];
  /** 连续静音累计（毫秒）：只统计 `hasVoice` 置真之后的帧。 */
  private silenceMs = 0;
  /** 当前段是否检测到过语音（须连续 {@link VOICE_CONFIRM_FRAMES} 帧越门限）。 */
  private hasVoice = false;
  /** 连续越门限帧计数（低于门限即清零；用于语音确认，见 {@link VOICE_CONFIRM_FRAMES}）。 */
  private voiceStreak = 0;
  /** 诊断窗口内各帧 dBFS（已按 {@link NOISE_FLOOR_DBFS} 记账下界夹取）。 */
  private diagFrames: number[] = [];
  /** 诊断窗口内越门限帧数。 */
  private diagAboveCount = 0;
  /** 诊断窗口起始时刻（毫秒；null = 尚无帧）。 */
  private diagWindowStartMs: number | null = null;
  /** 当前段（未切段）累计帧数与越门限帧数（诊断/切段日志用）。 */
  private segmentFrames = 0;
  private segmentAboveCount = 0;
  /** 在途 HTTP 的取消器。 */
  private controller: AbortController | null = null;
  /** 是否已 close（abort 并不再处理任何段）。 */
  private closed = false;
  /** finish() 是否已调用（不再接受 feed）。 */
  private accepting = true;
  /** drain 循环在途 Promise（finish 据此等待全部段完成）。 */
  private drainPromise: Promise<void> | null = null;
  private lastError = "";
  private finished = false;

  /**
   * @param options 分段客户端构造参数
   */
  constructor(options: SegmentAsrOptions) {
    this.sampleRate = options.sampleRate;
    this.fetchImpl = options.fetchImpl ?? fetch;
    const threshold = options.vad?.threshold ?? DEFAULT_VAD_THRESHOLD;
    const silence = options.vad?.silenceDurationMs ?? DEFAULT_VAD_SILENCE_MS;
    this.baseGateDbfs = thresholdToDbfs(threshold);
    // 底噪窗口帧数不足下限（<1s）时先用配置基线判定；满足下限后切换到滑动分位门限。
    this.gateDbfs = this.baseGateDbfs;
    this.lastLoggedGateDbfs = this.baseGateDbfs;
    this.silenceDurationMs = Math.max(1, silence);
    this.maxSegmentMs = Math.max(1000, options.maxSegmentMs ?? DEFAULT_MAX_SEGMENT_MS);
    this.maxWavBytes = maxWavBytesForBase64(options.maxBase64Bytes ?? MAX_BASE64_BYTES);
    this.marginDb = clampVadMarginDb(options.vad?.marginDb);
    this.onResult = options.onResult;
    this.onError = options.onError;
    this.logger = options.logger ?? log;
    this.now = options.now ?? Date.now;
  }

  /** 已脱敏的错误文本（空串表示无错误）。 */
  get errorMessage(): string {
    return this.lastError;
  }

  /** 是否已结束（finish 完成全部段、或 close）。 */
  get isFinished(): boolean {
    return this.finished;
  }

  /** 当前实际短帧门限（dBFS；诊断/测试用，随底噪滑动分位双向变化，见 {@link computeGateDbfs}）。 */
  get currentGateDbfs(): number {
    return this.gateDbfs;
  }

  /**
   * 提交一段 WAV 给云端并解析结果（子类实现：拼请求体、发 HTTP、解析响应）。
   * @param wav 完整 WAV 字节（16bit 单声道）
   * @param signal 取消信号（close/超时触发）
   * @returns 整段识别结果
   * @throws Error 网络失败 / HTTP 非 2xx / 响应解析失败（错误文本须已脱敏）
   */
  protected abstract submitSegment(wav: Buffer, signal: AbortSignal): Promise<SegmentTranscript>;

  /**
   * 按段 POST JSON 样板（两家子类共用）：POST → 非 2xx 取正文片段 → JSON.parse。
   * 错误一律经 `redact()` 脱敏后抛出；子类只负责构造请求体与解析响应纯函数。
   * @param url 端点 URL
   * @param apiKey API Key（仅用于 `Authorization` 头与脱敏，绝不外显）
   * @param body 请求体对象（内部 `JSON.stringify`）
   * @param signal 取消信号
   * @param label 错误文案前缀（如「MiMo ASR」「阿里按段 ASR」）
   * @returns 已 `JSON.parse` 的响应对象
   * @throws Error 网络失败 / HTTP 非 2xx / 响应解析失败（已脱敏）
   */
  protected async postJson(
    url: string,
    apiKey: string,
    body: unknown,
    signal: AbortSignal,
    label: string,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(redact(`${label} 请求失败：${message}`, apiKey));
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(redact(`${label} 返回 ${response.status}：${detail.slice(0, 200)}`, apiKey));
    }
    try {
      return await response.json();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(redact(`${label} 响应解析失败：${message}`, apiKey));
    }
  }

  /** 按段 HTTP 无持久连接：直接 resolve（保持与 stream 客户端相同的调用序列）。 */
  connect(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * 喂入 PCM：更新能量/静音统计，达到段边界（静音/时长/体积）即切段入队并触发串行发送。
   * @param pcm s16le 字节流
   */
  feed(pcm: Buffer): void {
    if (pcm.length === 0 || !this.accepting || this.closed) return;
    this.chunks.push(pcm);
    this.bufferedBytes += pcm.length;
    this.updateVoiceState(pcm);
    if (this.shouldCut()) this.cutCurrent();
  }

  /**
   * 结束输入：冲刷剩余缓冲为最后一段，串行发送全部排队段并等待完成。
   * @returns 全部段处理完成后 resolve
   */
  async finish(): Promise<void> {
    if (!this.accepting) {
      // 已 finish 过：等待既有 drain（若有）后返回
      await this.drainPromise;
      return;
    }
    this.accepting = false;
    // 窗口帧数不足 1s 的短录音：**保持配置基线门限**（gate 初值即 thresholdToDbfs(配置)），
    // 不拿末段语声补算分位——否则会把 300ms 语声当底噪、抬门限后把这段语音当静音丢弃。
    if (this.bufferedBytes > 0) this.cutCurrent();
    await this.ensureDrain();
    this.finished = true;
  }

  /** 中止：abort 在途 HTTP、清空缓冲/队列、置 finished（幂等）。 */
  close(): void {
    this.closed = true;
    this.accepting = false;
    this.finished = true;
    const controller = this.controller;
    this.controller = null;
    if (controller) controller.abort();
    this.chunks = [];
    this.bufferedBytes = 0;
    this.queue = [];
  }

  /**
   * 按当前块更新语音/静音状态：**按 30ms 短帧逐帧**结算（不是整块平均）。
   *
   * 这样既不会被 500ms 的停顿把你一句短话「平均掉」，静音计时也精确到帧（`silenceDurationMs`
   * 不再被量化成整块时长）。每帧先写入底噪滑动窗口并（节流）重算门限，再用当前门限判定语音。
   * @param pcm 本块 PCM
   */
  private updateVoiceState(pcm: Buffer): void {
    const frameBytes = Math.max(2, Math.floor((this.sampleRate * ENERGY_FRAME_MS) / 1000) * 2);
    for (let offset = 0; offset < pcm.length; offset += frameBytes) {
      const frame = pcm.subarray(offset, Math.min(offset + frameBytes, pcm.length));
      const frameMs = (Math.floor(frame.length / 2) / this.sampleRate) * 1000;
      const frameDbfs = rmsToDbfs(pcmRms(frame));
      this.pushNoiseFrame(frameDbfs);
      this.judgeFrame(frameDbfs, frameMs);
    }
  }

  /**
   * 把一帧能量写入底噪滑动窗口，并按 {@link NOISE_RECALC_FRAMES} 节流重算 p10 门限。
   *
   * 环形缓冲写满后自动覆盖最旧帧 ⇒ 冷启动的低值（数字静音）最多 5s 就被淘汰，
   * 门限随真实环境底噪回升；持续说话时低分位仍落在停顿/轻音帧上，不会被语声 p50 带跑。
   * @param frameDbfs 当前帧能量（dBFS；低于记账下界按 {@link NOISE_FLOOR_DBFS} 记）
   */
  private pushNoiseFrame(frameDbfs: number): void {
    const observed = Math.max(NOISE_FLOOR_DBFS, frameDbfs);
    this.noiseWindow[this.noiseWindowIndex] = observed;
    this.noiseWindowIndex = (this.noiseWindowIndex + 1) % NOISE_WINDOW_FRAMES;
    this.noiseWindowCount = Math.min(NOISE_WINDOW_FRAMES, this.noiseWindowCount + 1);
    this.noiseFramesSinceRecalc += 1;
    // 帧数不足下限（≈1s）：保持 noiseDbfs=null，用配置基线判定，避免拿几帧语声当底噪
    if (this.noiseWindowCount < NOISE_WINDOW_MIN_FRAMES) return;
    // 节流：每 10 帧（300ms）排序重算一次，避免逐帧对 167 帧排序
    if (this.noiseFramesSinceRecalc < NOISE_RECALC_FRAMES && this.noiseDbfs !== null) return;
    this.noiseFramesSinceRecalc = 0;
    this.recomputeNoise();
  }

  /**
   * 用滑动窗口的 p10 更新底噪估计与门限（`noiseDbfs = null` 时退回配置基线）。
   *
   * 为什么用滑动分位（2026-10-25）：冷启动偏低能自愈（5s 窗口淘汰旧值）、说话期间 p10
   * 仍贴底噪不漂移；门限在窗口达到下限前保持配置基线，无需一次性标定与重放。
   */
  private recomputeNoise(): void {
    if (this.noiseWindowCount === 0) return;
    const frames = this.noiseWindow.slice(0, this.noiseWindowCount).sort((a, b) => a - b);
    const index = Math.min(
      frames.length - 1,
      Math.max(0, Math.floor((frames.length - 1) * NOISE_WINDOW_PERCENTILE)),
    );
    this.noiseDbfs = Math.max(NOISE_FLOOR_DBFS, frames[index]);
    this.recomputeGate("windowed");
  }

  /**
   * 按当前底噪估计重算门限；变化达到 {@link GATE_LOG_STEP_DB} 才写一行 info 日志（不逐帧刷屏）。
   * @param reason 触发原因（固定 `windowed`：滑动窗口分位）
   */
  private recomputeGate(reason: "windowed"): void {
    if (this.noiseDbfs === null) return;
    const previous = this.gateDbfs;
    const next = computeGateDbfs(this.baseGateDbfs, this.noiseDbfs, this.marginDb);
    this.gateDbfs = next;
    // 门限上抬 ≥3dB：此前按较低门限判出的「有语音」很可能只是环境底噪（冷启动数字静音被淘汰、
    // 环境变吵），重置当前段的语音态，避免把纯噪声段送去识别。这里不是逐帧重放：缓冲保留，
    // 真正的持续语声会在 150ms 内重新确认，句首不丢。
    if (next - previous >= GATE_LOG_STEP_DB) {
      this.hasVoice = false;
      this.voiceStreak = 0;
      this.silenceMs = 0;
    }
    if (Math.abs(next - this.lastLoggedGateDbfs) < GATE_LOG_STEP_DB) return;
    this.logger.info(
      `asr gate: reason=${reason} noiseDbfs=${this.noiseDbfs.toFixed(1)} oldGateDbfs=${this.lastLoggedGateDbfs.toFixed(1)} newGateDbfs=${next.toFixed(1)} thresholdDbfs=${this.baseGateDbfs.toFixed(1)} marginDb=${this.marginDb.toFixed(1)}`,
    );
    this.lastLoggedGateDbfs = next;
  }

  /**
   * 用当前门限判定单帧：连续 {@link VOICE_CONFIRM_FRAMES} 帧越门限才算「有语音」；
   * 越门限帧清零静音计时，低于门限的帧累加静音时长（仅在 `hasVoice` 置真之后累计）。
   * @param frameDbfs 帧能量（dBFS）
   * @param frameMs 帧时长（毫秒）
   */
  private judgeFrame(frameDbfs: number, frameMs: number): void {
    const above = frameDbfs >= this.gateDbfs;
    if (above) {
      this.voiceStreak += 1;
      if (this.voiceStreak >= VOICE_CONFIRM_FRAMES) this.hasVoice = true;
      if (this.hasVoice) this.silenceMs = 0;
    } else {
      // 单帧/孤立尖峰不足以确认语音：低于门限即把连续计数清零
      this.voiceStreak = 0;
      if (this.hasVoice) this.silenceMs += frameMs;
    }
    this.segmentFrames += 1;
    if (above) this.segmentAboveCount += 1;
    this.recordDiagnosticFrame(frameDbfs, above);
  }

  /**
   * 记录一帧到诊断窗口；满 {@link VAD_DIAG_INTERVAL_MS}（或窗口内帧数达到该时长的帧数）即输出一行。
   * 时间由注入的 {@link SegmentAsrClientBase.now} 决定，因此测试可用假时钟驱动窗口节流。
   * @param frameDbfs 帧能量（dBFS；-Infinity 按 {@link NOISE_FLOOR_DBFS} 记账）
   * @param above 是否越过当前门限
   */
  private recordDiagnosticFrame(frameDbfs: number, above: boolean): void {
    const now = this.now();
    if (this.diagWindowStartMs === null) this.diagWindowStartMs = now;
    this.diagFrames.push(Math.max(NOISE_FLOOR_DBFS, frameDbfs));
    if (above) this.diagAboveCount += 1;
    const framesPerWindow = Math.ceil(VAD_DIAG_INTERVAL_MS / ENERGY_FRAME_MS);
    if (now - this.diagWindowStartMs < VAD_DIAG_INTERVAL_MS && this.diagFrames.length < framesPerWindow) return;
    this.flushDiagnosticWindow();
  }

  /**
   * 输出并清空当前诊断窗口：
   * `[vad] gate=… noise=… threshold=… frames p50=… p90=… max=… above=…% hasVoice=… silenceMs=…`。
   */
  private flushDiagnosticWindow(): void {
    const frames = this.diagFrames;
    if (frames.length === 0) return;
    const sorted = [...frames].sort((a, b) => a - b);
    const percentile = (q: number): number =>
      sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)))];
    const abovePct = Math.round((this.diagAboveCount / frames.length) * 100);
    const noise = this.noiseDbfs === null ? "null" : this.noiseDbfs.toFixed(1);
    this.logger.info(
      `[vad] gate=${this.gateDbfs.toFixed(1)} noise=${noise} threshold=${this.baseGateDbfs.toFixed(1)} frames p50=${percentile(0.5).toFixed(1)} p90=${percentile(0.9).toFixed(1)} max=${sorted[sorted.length - 1].toFixed(1)} above=${abovePct}% hasVoice=${this.hasVoice} silenceMs=${Math.round(this.silenceMs)}`,
    );
    this.diagFrames = [];
    this.diagAboveCount = 0;
    this.diagWindowStartMs = this.now();
  }

  /** 是否达到切段条件：静音句尾（须已检出语音）/ 时长上限 / 体积上限。 */
  private shouldCut(): boolean {
    if (this.bufferedBytes === 0) return false;
    if (this.hasVoice && this.silenceMs >= this.silenceDurationMs) return true;
    const durationMs = (Math.floor(this.bufferedBytes / 2) / this.sampleRate) * 1000;
    if (durationMs >= this.maxSegmentMs) return true;
    if (this.bufferedBytes >= this.maxWavBytes - WAV_HEADER_BYTES) return true;
    return false;
  }

  /** 把当前缓冲切成一段入队；纯静音（未检出语音）直接丢弃，其余唤醒串行 drain。 */
  private cutCurrent(): void {
    const pcm = Buffer.concat(this.chunks);
    this.chunks = [];
    this.bufferedBytes = 0;
    this.silenceMs = 0;
    const hadVoice = this.hasVoice;
    this.hasVoice = false;
    this.voiceStreak = 0;
    const frames = this.segmentFrames;
    const abovePct = frames > 0 ? Math.round((this.segmentAboveCount / frames) * 100) : 0;
    this.segmentFrames = 0;
    this.segmentAboveCount = 0;
    if (pcm.length === 0 || !hadVoice) return; // 纯静音段不发送（识别必为空）
    const durSec = (Math.floor(pcm.length / 2) / this.sampleRate).toFixed(1);
    this.logger.info(`[asr] segment submit dur=${durSec}s frames=${frames} above=${abovePct}%`);
    this.queue.push(pcm);
    void this.ensureDrain();
  }

  /**
   * 启动/复用串行 drain：同一时刻至多一个在途 HTTP，队列清空后 resolve。
   * finally 里兜底复查队列，覆盖「循环已退出、finally 微任务尚未执行」极窄窗口内新入队的段。
   * @returns 队列清空且无在途请求后 resolve
   */
  private ensureDrain(): Promise<void> {
    if (!this.drainPromise) {
      this.drainPromise = this.drain().finally(() => {
        this.drainPromise = null;
        if (this.queue.length > 0 && !this.closed) void this.ensureDrain();
      });
    }
    return this.drainPromise;
  }

  /** drain 主循环：按入队顺序逐段发送；单段失败记错误后继续下一段（不丢后续）。 */
  private async drain(): Promise<void> {
    while (this.queue.length > 0 && !this.closed) {
      const pcm = this.queue.shift();
      if (!pcm) break;
      await this.sendSegment(pcm);
    }
  }

  /**
   * 发送一段 PCM：打包 WAV、按 10MB 红线切分后顺序提交，各切片结果分别产出。
   * @param pcm 该段 PCM
   */
  private async sendSegment(pcm: Buffer): Promise<void> {
    const wav = buildWav(pcm, this.sampleRate);
    const parts = wav.length > this.maxWavBytes ? splitPcmByMaxBytes(pcm, this.maxWavBytes - WAV_HEADER_BYTES) : [pcm];
    for (const part of parts) {
      if (this.closed) return;
      const controller = new AbortController();
      this.controller = controller;
      const timer = setTimeout(() => controller.abort(), SEGMENT_HTTP_TIMEOUT_MS);
      try {
        const transcript = await this.submitSegment(buildWav(part, this.sampleRate), controller.signal);
        if (this.closed) return; // close() 期间返回的结果不再上报
        const text = transcript.text.trim();
        if (text.length === 0) {
          this.logger.info('[asr] segment result len=0 text="" empty');
          continue;
        }
        this.logger.info(`[asr] segment result len=${text.length} text=${text.slice(0, ASR_RESULT_PREVIEW_CHARS)}`);
        this.onResult({ text, isFinal: true, emotion: transcript.emotion });
      } catch (err) {
        if (this.closed) return; // abort/关闭期间静默收尾
        const message = err instanceof Error ? err.message : String(err);
        this.recordError(message);
      } finally {
        clearTimeout(timer);
        if (this.controller === controller) this.controller = null;
      }
    }
  }

  /**
   * 记录脱敏后的错误并回调。
   * @param message 原始错误文本（子类应已脱敏）
   */
  protected recordError(message: string): void {
    this.lastError = message;
    this.onError?.(message);
  }
}
