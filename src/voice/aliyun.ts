/**
 * 阿里云百炼（Model Studio）实时 ASR 客户端，支持两种协议：
 *
 * 1. **realtime**（`qwen3-asr-flash-realtime`，7 类情绪）——OpenAI-realtime 风格：
 *    connect → `session.update` → `input_audio_buffer.append`(base64)* → `session.finish`
 *    服务端事件（`type` 判别）：`...transcription.text`（partial）/`...completed`（final）/
 *    `...failed` / `error` / `session.finished`；情绪字段 `emotion` 位于转录事件中。
 * 2. **inference**（`paraformer-realtime-v2` / `-8k-v2`）——DashScope 推理协议：
 *    connect → `run-task` → 收 `task-started` 后发**裸二进制音频帧** → `finish-task`
 *    服务端事件（`header.event` 判别）：`task-started` / `result-generated`（`payload.output.sentence`）/
 *    `task-finished` / `task-failed`。
 *
 * 字段依据阿里云百炼官方文档；**不使用** `prefix_padding_ms`（该参数不存在）。
 * 凭证只读、绝不打印/回显；所有对外错误文本统一经 `redact()` 脱敏。
 * 并发契约见 docs/ASYNC.md。
 */

import { randomBytes, randomUUID } from "node:crypto";

import WebSocket from "ws";

import { DEFAULT_VAD_SILENCE_MS, DEFAULT_VAD_THRESHOLD, PARAFORMER_LANGUAGES, type AsrProtocol } from "./config.js";
import { redact } from "./credentials.js";
import type { VoiceEmotion } from "./mapping.js";

export { loadCredentials, redact, resolveCredentials, type Credentials } from "./credentials.js";

/** 默认模型（realtime 协议）。 */
export const DEFAULT_MODEL = "qwen3-asr-flash-realtime";
/** realtime 端点模板（百炼华北2 北京 MaaS 专属域名）。 */
export const REALTIME_URL_TEMPLATE = "wss://{workspace}.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime";
/** inference 端点模板（paraformer 固定路径）。 */
export const INFERENCE_URL_TEMPLATE = "wss://{workspace}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference";
/** 默认采样率（qwen 实时要求 16k）。 */
export const ASR_SAMPLE_RATE = 16000;
/** 每包音频时长（毫秒）：约 100ms，与官方推荐一致。 */
export const AUDIO_FRAME_MS = 100;
/** `connect()` 等待 `task-started` 的默认超时（毫秒，仅 inference 协议）。 */
export const DEFAULT_START_TIMEOUT_MS = 10000;
/** `finish()` 等待结束事件的默认超时（毫秒）。 */
export const DEFAULT_FINISH_TIMEOUT_MS = 20000;

/** 一条识别结果。 */
export interface AsrResult {
  /** 识别文本；partial 为预览，final 为句末完整文本。 */
  text: string;
  /** 是否句末最终结果。 */
  isFinal: boolean;
  /** 情绪标签（7 类之一）；本次结果未携带时为空串。 */
  emotion: VoiceEmotion | "";
}

/** server_vad 可选覆盖参数（不含 `prefix_padding_ms`——阿里云无此参数）。 */
export interface VadOptions {
  /** VAD 阈值；越高越抗噪。 */
  threshold?: number;
  /** 句尾静音判定毫秒。 */
  silenceDurationMs?: number;
}

/** 解析后的 VAD 参数。 */
export interface ResolvedVad {
  threshold: number;
  silenceDurationMs: number;
}

/** 客户端配置。 */
export interface AliyunAsrOptions {
  workspace: string;
  apiKey: string;
  /** 传输协议；默认 `realtime`。 */
  protocol?: AsrProtocol;
  /** 模型名，默认 DEFAULT_MODEL（realtime）。 */
  model?: string;
  /** 覆盖端点 URL，默认按 workspace 拼接。 */
  url?: string;
  /** 采样率，默认 ASR_SAMPLE_RATE。 */
  sampleRate?: number;
  /** 识别语言；空串 = 自动识别（不下发 language）。 */
  language?: string;
  /** 语言提示（paraformer `language_hints`）；仅支持该参数的 provider 会收到。 */
  languageHints?: string[];
  /** 热词表 ID（paraformer `vocabulary_id`）；仅支持该参数的 provider 会收到。 */
  vocabularyId?: string;
  /** 领域上下文/语料（inference `input.context`）；仅支持该参数的 provider 会收到。 */
  context?: string;
  /** VAD 覆盖参数。 */
  vad?: VadOptions;
  /** 是否下发 paraformer v2 专有参数（`max_sentence_silence` 等）。 */
  extendedV2?: boolean;
  /** 识别结果回调。 */
  onResult: (result: AsrResult) => void;
  /** 错误回调（已脱敏）。 */
  onError?: (message: string) => void;
  /** 服务端会话结束回调。 */
  onComplete?: () => void;
}

/** 服务端消息的最小结构（只取所需字段，覆盖两种协议）。 */
interface ServerMessage {
  type?: string;
  text?: string;
  stash?: string;
  transcript?: string;
  emotion?: string;
  error?: { code?: string; message?: string };
  header?: { event?: string; error_code?: string; error_message?: string };
  payload?: {
    output?: {
      sentence?: {
        text?: string;
        sentence_end?: boolean;
        /** paraformer 3 类情绪标签。 */
        emo_tag?: string;
      };
    };
  };
}

/** paraformer 3 类情绪 → 7 类标签的桥接映射（positive/negative/neutral）。 */
const PARAFORMER_EMOTION: Readonly<Record<string, VoiceEmotion>> = {
  positive: "happy",
  negative: "sad",
  neutral: "neutral",
};

/**
 * 按 workspace 与模型拼接 realtime 端点。
 * @param workspace 业务空间 ID
 * @param model 模型名
 * @returns 完整 wss URL
 */
export function buildRealtimeUrl(workspace: string, model: string): string {
  const base = REALTIME_URL_TEMPLATE.replace("{workspace}", workspace);
  return `${base}?model=${encodeURIComponent(model)}`;
}

/**
 * 按 workspace 拼接 inference 端点。
 * @param workspace 业务空间 ID
 * @returns 完整 wss URL
 */
export function buildInferenceUrl(workspace: string): string {
  return INFERENCE_URL_TEMPLATE.replace("{workspace}", workspace);
}

/**
 * 归一化 VAD 参数（缺省取配置默认）。
 * @param vad 可选覆盖
 * @returns 完整 VAD 参数
 */
export function resolveVad(vad: VadOptions = {}): ResolvedVad {
  return {
    threshold: vad.threshold ?? DEFAULT_VAD_THRESHOLD,
    silenceDurationMs: vad.silenceDurationMs ?? DEFAULT_VAD_SILENCE_MS,
  };
}

/**
 * 构造 realtime 协议的 `session.update` 消息（纯函数，便于单测）。
 * 不包含 `prefix_padding_ms`；`language` 为空时不下发 `language`（自动识别）。
 * @param params 采样率 / 语言 / VAD
 * @returns 完整消息体
 */
export function buildSessionUpdate(params: {
  sampleRate: number;
  language: string;
  vad?: VadOptions;
}): Record<string, unknown> {
  const vad = resolveVad(params.vad);
  return {
    type: "session.update",
    session: {
      modalities: ["text"],
      input_audio_format: "pcm",
      sample_rate: params.sampleRate,
      input_audio_transcription: params.language ? { language: params.language } : {},
      turn_detection: {
        type: "server_vad",
        threshold: vad.threshold,
        silence_duration_ms: vad.silenceDurationMs,
      },
    },
  };
}

/**
 * 构造 inference 协议的 `run-task` 消息（纯函数，便于单测）。
 * 不包含 `prefix_padding_ms`；`max_sentence_silence` 来自 VAD，`language_hints`/`vocabulary_id`/`context`
 * 仅应在 provider 支持时由调用方传入（`resolveAsrParams` 已过滤，故此处不再二次校验）。
 * @param params 模型 / 采样率 / 语言 / 语言提示 / 热词表 / 上下文 / VAD / taskId / 是否下发 v2 专有参数
 * @returns 完整消息体
 */
export function buildRunTask(params: {
  model: string;
  sampleRate: number;
  language: string;
  languageHints?: string[];
  vocabularyId?: string;
  context?: string;
  vad?: VadOptions;
  taskId: string;
  extendedV2: boolean;
}): Record<string, unknown> {
  const vad = resolveVad(params.vad);
  const explicitHints = (params.languageHints ?? []).filter((hint) => PARAFORMER_LANGUAGES.includes(hint));
  const hints =
    explicitHints.length > 0
      ? explicitHints
      : params.language && PARAFORMER_LANGUAGES.includes(params.language)
        ? [params.language]
        : [];
  const parameters: Record<string, unknown> = {
    format: "pcm",
    sample_rate: params.sampleRate,
    disfluency_removal_enabled: false,
  };
  if (hints.length > 0) parameters.language_hints = hints;
  if (params.vocabularyId) parameters.vocabulary_id = params.vocabularyId;
  if (params.extendedV2) {
    parameters.semantic_punctuation_enabled = false;
    parameters.max_sentence_silence = vad.silenceDurationMs;
  }
  const input: Record<string, unknown> = {};
  if (params.context) input.context = params.context;
  return {
    header: { action: "run-task", task_id: params.taskId, streaming: "duplex" },
    payload: {
      task_group: "audio",
      task: "asr",
      function: "recognition",
      model: params.model,
      input,
      parameters,
    },
  };
}

/** 阿里云实时 ASR 客户端（start→feed*→finish；按协议分派消息格式）。 */
export class AliyunAsrClient {
  private ws: WebSocket | null = null;
  private readonly options: AliyunAsrOptions;
  private readonly protocol: AsrProtocol;
  private readonly url: string;
  private readonly sampleRate: number;
  private readonly frameBytes: number;
  private readonly taskId: string;
  private lastError = "";
  private finished = false;
  private started = false;
  private completeDeferred: (() => void) | null = null;
  private startDeferred: { resolve: () => void; reject: (err: Error) => void } | null = null;

  /**
   * @param options 客户端配置
   */
  constructor(options: AliyunAsrOptions) {
    this.options = options;
    this.protocol = options.protocol ?? "realtime";
    this.sampleRate = options.sampleRate ?? ASR_SAMPLE_RATE;
    this.frameBytes = Math.floor((this.sampleRate * AUDIO_FRAME_MS) / 1000) * 2;
    this.taskId = randomUUID();
    const model = options.model ?? DEFAULT_MODEL;
    this.url =
      options.url ??
      (this.protocol === "realtime" ? buildRealtimeUrl(options.workspace, model) : buildInferenceUrl(options.workspace));
  }

  /** 已脱敏的错误文本（空串表示无错误）。 */
  get errorMessage(): string {
    return this.lastError;
  }

  /** 是否已结束（收到结束事件 / 错误 / finish 超时）。 */
  get isFinished(): boolean {
    return this.finished;
  }

  /**
   * 建立连接并下发首个控制消息（realtime 的 `session.update` / inference 的 `run-task`）。
   * inference 协议在收到 `task-started` 后才 resolve；超时则 reject。
   * @param timeoutMs 等待 `task-started` 的超时（毫秒，仅 inference），默认 DEFAULT_START_TIMEOUT_MS
   * @returns 连接就绪后 resolve
   * @throws Error 握手失败（已脱敏）
   */
  connect(timeoutMs: number = DEFAULT_START_TIMEOUT_MS): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url, { headers: this.buildHeaders() });
      this.ws = ws;
      let settled = false;
      let startTimer: ReturnType<typeof setTimeout> | undefined;
      const settle = (err?: Error): void => {
        if (settled) return;
        settled = true;
        if (startTimer) clearTimeout(startTimer);
        this.startDeferred = null;
        if (err) reject(err);
        else resolve();
      };

      ws.on("open", () => {
        try {
          if (this.protocol === "realtime") {
            this.started = true;
            this.sendEvent(buildSessionUpdate(this.sessionParams()));
            settle();
          } else {
            this.sendRaw(
              buildRunTask({
                model: this.options.model ?? DEFAULT_MODEL,
                sampleRate: this.sampleRate,
                language: this.options.language ?? "",
                languageHints: this.options.languageHints,
                vocabularyId: this.options.vocabularyId,
                context: this.options.context,
                vad: this.options.vad,
                taskId: this.taskId,
                extendedV2: this.options.extendedV2 ?? false,
              }),
            );
            startTimer = setTimeout(() => {
              const message = this.sanitize(`等待 task-started 超时（${timeoutMs}ms）`);
              this.recordError(message);
              settle(new Error(message));
            }, timeoutMs);
            this.startDeferred = {
              resolve: () => {
                this.started = true;
                settle();
              },
              reject: (err: Error) => settle(err),
            };
          }
        } catch (err) {
          settle(err as Error);
        }
      });
      ws.on("message", (data: WebSocket.RawData) => this.handleMessage(data));
      ws.on("error", (err: Error) => {
        const message = this.sanitize(err.message);
        this.recordError(message);
        settle(new Error(message));
      });
      ws.on("close", () => {
        this.ws = null;
      });
    });
  }

  /**
   * 喂入 PCM；内部按 ~100ms 分包。realtime 用 base64 JSON，inference 用裸二进制帧。
   * @param pcm PCM 字节流
   */
  feed(pcm: Buffer): void {
    if (pcm.length === 0 || this.finished || !this.started) return;
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      this.recordError("WebSocket 未连接，无法发送音频");
      return;
    }
    for (let offset = 0; offset < pcm.length; offset += this.frameBytes) {
      const chunk = pcm.subarray(offset, offset + this.frameBytes);
      if (chunk.length === 0) continue;
      if (this.protocol === "realtime") {
        this.sendEvent({ type: "input_audio_buffer.append", audio: chunk.toString("base64") });
      } else {
        ws.send(chunk);
      }
    }
  }

  /**
   * 发送结束消息并等待结束事件（或错误 / 超时）。
   * realtime 发 `session.finish` 等 `session.finished`；inference 发 `finish-task` 等 `task-finished`。
   * @param timeoutMs 等待上限（毫秒），默认 DEFAULT_FINISH_TIMEOUT_MS
   */
  finish(timeoutMs: number = DEFAULT_FINISH_TIMEOUT_MS): Promise<void> {
    if (this.finished) return Promise.resolve();
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      this.markFinished();
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.recordError(`等待结束事件超时（${timeoutMs}ms）`);
        this.markFinished();
      }, timeoutMs);
      this.completeDeferred = () => {
        clearTimeout(timer);
        resolve();
      };
      if (this.protocol === "realtime") {
        this.sendEvent({ type: "session.finish" });
      } else {
        this.sendRaw({
          header: { action: "finish-task", task_id: this.taskId, streaming: "duplex" },
          payload: { input: {} },
        });
      }
    });
  }

  /** 关闭连接；已关闭时无操作。 */
  close(): void {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    try {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    } catch {
      // 关闭阶段的异常不影响主流程
    }
  }

  /** 构造握手请求头。 */
  private buildHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.options.apiKey}`,
      "X-DashScope-WorkSpace": this.options.workspace,
    };
  }

  /** session.update 所需的参数切片。 */
  private sessionParams(): { sampleRate: number; language: string; vad?: VadOptions } {
    return {
      sampleRate: this.sampleRate,
      language: this.options.language ?? "",
      vad: this.options.vad,
    };
  }

  /**
   * 发送一条带 event_id 的 JSON 消息（realtime 协议）。
   * @param body 除 event_id 外的消息体
   */
  private sendEvent(body: Record<string, unknown>): void {
    this.sendRaw({ event_id: `event_${randomBytes(16).toString("hex")}`, ...body });
  }

  /**
   * 发送一条 JSON 文本帧。
   * @param body 消息体
   */
  private sendRaw(body: Record<string, unknown>): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(body));
  }

  /**
   * 解析并分发服务端消息（按协议分派）。
   * @param raw 原始消息
   */
  private handleMessage(raw: WebSocket.RawData): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed === null) return;
    const message = parsed as ServerMessage;
    if (this.protocol === "realtime") this.handleRealtime(message);
    else this.handleInference(message);
  }

  /**
   * 分发 realtime 协议事件。
   * @param message 服务端消息
   */
  private handleRealtime(message: ServerMessage): void {
    switch (message.type) {
      case "conversation.item.input_audio_transcription.text": {
        const text = `${message.text ?? ""}${message.stash ?? ""}`;
        if (text.length > 0) this.emitResult(text, false, message.emotion);
        break;
      }
      case "conversation.item.input_audio_transcription.completed":
        this.emitResult(message.transcript ?? "", true, message.emotion);
        break;
      case "conversation.item.input_audio_transcription.failed":
      case "error":
        this.fail(message.error?.code, message.error?.message);
        break;
      case "session.finished":
        this.markFinished();
        break;
      default:
        break;
    }
  }

  /**
   * 分发 inference 协议事件。
   * @param message 服务端消息
   */
  private handleInference(message: ServerMessage): void {
    const event = message.header?.event;
    switch (event) {
      case "task-started":
        this.startDeferred?.resolve();
        break;
      case "result-generated": {
        const sentence = message.payload?.output?.sentence;
        if (!sentence) break;
        const text = sentence.text ?? "";
        if (text.length > 0) {
          const emotion = sentence.emo_tag ? PARAFORMER_EMOTION[sentence.emo_tag] ?? "" : "";
          this.emitResult(text, sentence.sentence_end === true, emotion);
        }
        break;
      }
      case "task-finished":
        this.markFinished();
        break;
      case "task-failed":
        this.fail(message.header?.error_code, message.header?.error_message);
        break;
      default:
        break;
    }
  }

  /**
   * 产出识别结果。
   * @param text 文本
   * @param isFinal 是否句末
   * @param emotion 情绪标签
   */
  private emitResult(text: string, isFinal: boolean, emotion: string | undefined): void {
    const label = (emotion ?? "").trim().toLowerCase() as VoiceEmotion | "";
    this.options.onResult({ text, isFinal, emotion: label });
  }

  /**
   * 处理服务端错误：脱敏记录并结束等待。
   * @param code 错误码
   * @param message 错误信息
   */
  private fail(code: string | undefined, message: string | undefined): void {
    const detail = `${code ?? ""} ${message ?? "未知错误"}`.trim();
    this.recordError(detail);
    this.startDeferred?.reject(new Error(this.sanitize(detail)));
    this.markFinished();
  }

  /**
   * 记录脱敏后的错误并回调。
   * @param detail 原始错误文本
   */
  private recordError(detail: string): void {
    const message = this.sanitize(detail);
    this.lastError = message;
    this.options.onError?.(message);
  }

  /** 幂等结束：解除 finish() 等待并回调 onComplete。 */
  private markFinished(): void {
    if (this.finished) return;
    this.finished = true;
    const deferred = this.completeDeferred;
    this.completeDeferred = null;
    if (deferred) deferred();
    this.options.onComplete?.();
  }

  /**
   * 抹除文本中的密钥。
   * @param text 原始文本
   * @returns 脱敏文本
   */
  private sanitize(text: string): string {
    return redact(text, this.options.apiKey);
  }
}
