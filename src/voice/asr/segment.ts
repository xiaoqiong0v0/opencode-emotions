/**
 * 按段（segment）ASR 客户端基类：整段音频 → HTTP → 文本。
 *
 * 分段策略（本仓库无本地 VAD 实现，服务端 VAD 参数只对 stream 生效，故按段自建**最小能量静音切段**）：
 * - 复用 `config.vad` 两个键：`silenceDurationMs` 直接作为「连续静音多久算一句结束」；
 *   `threshold` 沿用其「越高越抗噪」的单调语义，但**不再乘比例当线性 RMS**——改为映射到 **dBFS**、
 *   且能量按 **30ms 短帧**逐帧判定（见 {@link thresholdToDbfs} 与文件头「能量标定」）。
 * - 段边界：出现「已检测到语音 + 连续静音 ≥ silenceDurationMs」→ 切段；
 *   另有时长上限 {@link DEFAULT_MAX_SEGMENT_MS} 与体积上限（10MB base64 红线）强制切段兜底。
 * - 纯静音缓冲（从未检测到语音）在 finish/静音切段时**丢弃不发送**（识别结果必为空，省一次请求）。
 *
 * 10MB base64 红线：发送前把 PCM 打包为 WAV 并按 data URL 估算体积，超限则把该段 PCM
 * **均分切开后顺序发送**、各切片结果分别产出（不丢段）。
 *
 * 并发：单线程事件循环 + 串行 drain（同一时刻至多一个在途 HTTP）；`close()` abort 在途请求。
 * 并发契约登记见 docs/ASYNC.md 交互点 ⑮。
 */

import { DEFAULT_VAD_SILENCE_MS, DEFAULT_VAD_THRESHOLD } from "../config.js";
import { redact } from "../credentials.js";
// 能量口径（RMS→dBFS）单源在 `voice/level.ts`（TTS 首尾静音裁剪复用同一口径）；此处再导出保持既有导入路径。
import { pcmRms, rmsToDbfs } from "../level.js";
import { buildWav, WAV_HEADER_BYTES } from "../wav.js";
import type { AsrClient, AsrResult, AsrTransport } from "./types.js";

export { pcmRms, rmsToDbfs };

/** 两家按段 provider 共同的 base64 输入体积红线（10MB；阿里 qwen3-asr-flash 与 MiMo 官方一致）。 */
export const MAX_BASE64_BYTES = 10 * 1024 * 1024;
/** WAV data URL 前缀（`data:audio/wav;base64,`）。 */
export const WAV_DATA_URL_PREFIX = "data:audio/wav;base64,";
/** 默认单段最长时长（毫秒）：60s，远低于阿里 5 分钟上限，控制单次请求延迟与缓冲上界。 */
export const DEFAULT_MAX_SEGMENT_MS = 60000;
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
 * 标定：本机静音底噪 RMS 0.00035~0.00061（≈ -69~-64 dBFS），-50 dBFS（RMS≈0.0032）仍明显高于底噪。
 */
export const ENERGY_DBFS_MIN = -50;
/**
 * `vad.threshold=1`（最抗噪）对应的短帧门限（dBFS）：RMS≈0.1，只能被近距离大声说话越过。
 */
export const ENERGY_DBFS_MAX = -20;
/** 单段 HTTP 超时（毫秒）。 */
export const SEGMENT_HTTP_TIMEOUT_MS = 60000;

/**
 * 按 base64 体积红线反推允许的 WAV 原始字节上限（含 44 字节头与 data URL 前缀的余量）。
 * @param maxBase64Bytes base64 编码后的体积上限（默认 10MB）
 * @returns WAV 文件（头+数据）允许的最大字节数
 */
export function maxWavBytesForBase64(maxBase64Bytes: number = MAX_BASE64_BYTES): number {
  return Math.max(WAV_HEADER_BYTES, Math.floor(((maxBase64Bytes - WAV_DATA_URL_PREFIX.length) * 3) / 4));
}

/**
 * 把 `vad.threshold`（[0,1]，**越高越抗噪**，保持原单调语义）映射为短帧 RMS 的 dBFS 门限。
 *
 * 标定依据（2026-10-22 本机实测）：静音底噪 RMS 0.00035~0.00061（≈ -69~-64 dBFS）；
 * 说话时 **500ms 采集块平均** RMS 0.03~0.04（≈ -30~-28 dBFS），30ms 短帧通常再高 6~12dB。
 * 映射区间取 [-50, -20] dBFS：默认 0.5 → **-35 dBFS（RMS≈0.0178）**，
 * 既让 0.035 平均 RMS 的语声稳定越过门限（回归用例锁定），又把 -64 dBFS 的底噪挡在门外；
 * 调到 1 → -20 dBFS（需大声/近距离），调到 0 → -50 dBFS（更灵敏但仍高于底噪）。
 * @param threshold vad.threshold（越界夹到 [0,1]；非有限值回退默认阈值）
 * @returns 短帧门限（dBFS）
 */
export function thresholdToDbfs(threshold: number): number {
  const normalized = Number.isFinite(threshold)
    ? Math.min(1, Math.max(0, threshold))
    : DEFAULT_VAD_THRESHOLD;
  return ENERGY_DBFS_MIN + normalized * (ENERGY_DBFS_MAX - ENERGY_DBFS_MIN);
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
  /** VAD 覆盖（沿用 config.vad 键：threshold 越高越抗噪、silenceDurationMs 句尾静音）。 */
  vad?: { threshold?: number; silenceDurationMs?: number };
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
}

/**
 * 按段 ASR 客户端基类：缓冲 → 静音/超限切段 → 串行逐段 HTTP → 整段 final 结果。
 * 子类只需实现 {@link SegmentAsrClientBase.submitSegment}（发一段 WAV、解析文本/情绪）。
 */
export abstract class SegmentAsrClientBase implements AsrClient {
  readonly transport: AsrTransport = "segment";
  protected readonly sampleRate: number;
  protected readonly fetchImpl: typeof fetch;
  /** 短帧能量门限（dBFS；由 vad.threshold 单调映射，见 thresholdToDbfs）。 */
  private readonly energyDbfs: number;
  private readonly silenceDurationMs: number;
  private readonly maxSegmentMs: number;
  private readonly maxWavBytes: number;
  private readonly onResult: (result: AsrResult) => void;
  private readonly onError: ((message: string) => void) | undefined;

  /** 当前段缓冲（未切段的 PCM 分片）。 */
  private chunks: Buffer[] = [];
  private bufferedBytes = 0;
  /** 已切段、待发送的队列（串行 drain）。 */
  private queue: Buffer[] = [];
  /** 连续静音累计（毫秒）。 */
  private silenceMs = 0;
  /** 当前段是否检测到过语音。 */
  private hasVoice = false;
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
    this.energyDbfs = thresholdToDbfs(threshold);
    this.silenceDurationMs = Math.max(1, silence);
    this.maxSegmentMs = Math.max(1000, options.maxSegmentMs ?? DEFAULT_MAX_SEGMENT_MS);
    this.maxWavBytes = maxWavBytesForBase64(options.maxBase64Bytes ?? MAX_BASE64_BYTES);
    this.onResult = options.onResult;
    this.onError = options.onError;
  }

  /** 已脱敏的错误文本（空串表示无错误）。 */
  get errorMessage(): string {
    return this.lastError;
  }

  /** 是否已结束（finish 完成全部段、或 close）。 */
  get isFinished(): boolean {
    return this.finished;
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
   * 不再被量化成整块时长）；帧级判定口径见 `thresholdToDbfs` 的标定数据。
   * @param pcm 本块 PCM
   */
  private updateVoiceState(pcm: Buffer): void {
    const frameBytes = Math.max(2, Math.floor((this.sampleRate * ENERGY_FRAME_MS) / 1000) * 2);
    for (let offset = 0; offset < pcm.length; offset += frameBytes) {
      const frame = pcm.subarray(offset, Math.min(offset + frameBytes, pcm.length));
      const frameMs = (Math.floor(frame.length / 2) / this.sampleRate) * 1000;
      if (rmsToDbfs(pcmRms(frame)) >= this.energyDbfs) {
        this.hasVoice = true;
        this.silenceMs = 0;
      } else {
        this.silenceMs += frameMs;
      }
    }
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
    if (pcm.length === 0 || !hadVoice) return; // 纯静音段不发送（识别必为空）
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
        if (text.length > 0) {
          this.onResult({ text, isFinal: true, emotion: transcript.emotion });
        }
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
