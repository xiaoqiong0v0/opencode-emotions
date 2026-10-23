/**
 * 小米 MiMo TTS provider（OpenAI 兼容 `chat/completions` SSE 流式）——**流式**实现。
 *
 * 接入方式（官方文档，2026-10 核）：
 *   `POST https://api.xiaomimimo.com/v1/chat/completions`，头 `Authorization: Bearer <MIMO_API_KEY>`；
 *   `messages`：**目标文本放 `role:"assistant"`**，风格指令放 `role:"user"`（自然语言，可选）；
 *   `audio: { format: "pcm16", voice: "<预置音色>" }`，`stream: true`。
 *   流式响应为 SSE：每个 chunk `choices[0].delta.audio.data` = base64 的 **PCM16LE 24kHz 单声道**；
 *   结束标记 `data: [DONE]`。**无** aliyun 那种 `continue-task` 追加协议。
 *
 * 增量策略（选定 **a：单请求、全量文本、流式播放**，并在此说明理由）：
 * - auto-read（`src/voice/auto-read.ts`）为每个增量块**各起一次 CLI 子进程**并串行等待退出，
 *   单次 `speak()` 调用拿到的即该块的完整文本；provider 契约亦规定「新 speak 打断上一条」。
 * - 故本 provider 一次 POST 带整段文本、SSE 音频边到边写 sink；同任务跨进程的顺序拼播由
 *   auto-read 的串行队列保证，provider **不自建待播队列**（不采用方案 b），避免与打断语义冲突。
 * - `streamMinChars` 语义不受影响：它作用于 auto-read 的增量分块（阈值口径在彼处），本 provider 不丢文本。
 *
 * 流式播放：base64 → 裸 PCM 字节直接写 AudioSink（采样率固定 24000，与官方示例一致）；
 * 无 stdin 播放器时回退分段（单请求单段，`SegmentedSink` 的 30s 安全上限兜底切分）。
 *
 * 安全：凭证只读、绝不打印；错误文本统一经 `redact()` 脱敏。并发/打断契约见 docs/ASYNC.md 交互点 ⑭。
 */

import { randomBytes, randomUUID } from "node:crypto";

import createLogger from "@xiaoqiong0v0/opencode-plugin-logger";
import type { Logger } from "@xiaoqiong0v0/opencode-plugin-logger";

import { mimoKeyMissingError, redact } from "../credentials.js";
import { createProviderSink, type AudioSink } from "./audio-sink.js";
import type { ResolvedTtsOptions, SpeakResult, TtsProvider } from "./types.js";

/** provider 标识。 */
export const MIMO_PROVIDER_NAME = "mimo";
/** 默认 MiMo TTS 模型（官方在售；可被 `tts.model` 覆盖）。 */
export const DEFAULT_MIMO_MODEL = "mimo-v2.5-tts";
/** 默认音色（官方中文场景建议默认「冰糖」；可被 `tts.voice` 覆盖）。 */
export const DEFAULT_MIMO_VOICE = "冰糖";
/** OpenAI 兼容端点。 */
export const MIMO_API_URL = "https://api.xiaomimimo.com/v1/chat/completions";
/** 流式输出格式（PCM16LE；官方流式仅此格式产出裸 PCM）。 */
export const MIMO_STREAM_FORMAT = "pcm16";
/** 输出采样率（Hz；官方流式固定 24kHz 单声道）。 */
export const MIMO_SAMPLE_RATE = 24000;
/** 合成整体超时（毫秒）。 */
export const MIMO_SYNTH_TIMEOUT_MS = 60000;
/** 语速提示：正语速并入风格指令（MiMo 无原生语速参数）。 */
export const MIMO_RATE_HINT_FAST = "请用稍快的语速说";
/** 语速提示：负语速并入风格指令。 */
export const MIMO_RATE_HINT_SLOW = "请用稍慢的语速说";

/** 解析后的 MiMo 合成参数。 */
export interface MimoParams {
  model: string;
  voice: string;
  /** 风格指令（user 消息；可能合并了语速提示；空串 = 不下发 user 消息）。 */
  instruction: string;
}

/** chat 消息（仅本接口用到的两种角色）。 */
export interface MimoMessage {
  role: "user" | "assistant";
  content: string;
}

/** SSE chunk 的最小结构（仅取音频增量）。 */
interface MimoDeltaChunk {
  choices?: Array<{ delta?: { audio?: { data?: unknown } } }>;
}

/**
 * 把配置解析为 MiMo 参数（空值回退默认；非 0 语速并入风格指令）。
 *
 * 语速口径：MiMo 无原生语速参数，`rate`（SAPI 惯例 -10..10，0 中性）非 0 时转成
 * 「请用稍快/稍慢的语速说」并入 user 风格指令文本（capabilities 的 `rate: true` 即指此口径）。
 * @param options 解析后的朗读参数
 * @returns MiMo 参数
 */
export function resolveMimoParams(options: ResolvedTtsOptions): MimoParams {
  const parts: string[] = [];
  const instruction = options.instruction.trim();
  if (instruction.length > 0) parts.push(instruction);
  if (Number.isFinite(options.rate) && options.rate > 0) parts.push(MIMO_RATE_HINT_FAST);
  else if (Number.isFinite(options.rate) && options.rate < 0) parts.push(MIMO_RATE_HINT_SLOW);
  return {
    model: options.model.trim() || DEFAULT_MIMO_MODEL,
    voice: options.voice.trim() || DEFAULT_MIMO_VOICE,
    instruction: parts.join("；"),
  };
}

/**
 * 构造 chat `messages`（纯函数）：风格指令放 `role:"user"`，目标文本放 `role:"assistant"`。
 * @param text 待朗读文本
 * @param instruction 风格指令（空 = 不生成 user 消息）
 * @returns 消息数组
 */
export function buildMimoMessages(text: string, instruction: string): MimoMessage[] {
  const messages: MimoMessage[] = [];
  const style = instruction.trim();
  if (style.length > 0) messages.push({ role: "user", content: style });
  messages.push({ role: "assistant", content: text });
  return messages;
}

/**
 * 构造完整请求体（纯函数，便于单测）。
 * @param params MiMo 参数 + 正文
 * @returns POST JSON 体（`stream: true`，`audio.format` 固定 pcm16）
 */
export function buildMimoRequestBody(params: { model: string; voice: string; text: string; instruction: string }): Record<string, unknown> {
  return {
    model: params.model,
    stream: true,
    audio: { format: MIMO_STREAM_FORMAT, voice: params.voice },
    messages: buildMimoMessages(params.text, params.instruction),
  };
}

/**
 * 从一个 SSE chunk 的 JSON 载荷解出音频字节（纯函数）。
 * @param payload 已 JSON.parse 的 chunk 对象
 * @returns base64 解码后的 PCM 字节；无音频增量时返回 null
 */
export function extractMimoAudioPcm(payload: unknown): Buffer | null {
  if (!payload || typeof payload !== "object") return null;
  const choices = (payload as MimoDeltaChunk).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const data = choices[0]?.delta?.audio?.data;
  if (typeof data !== "string" || data.length === 0) return null;
  return Buffer.from(data, "base64");
}

/** streamMimoPcm 的选项。 */
export interface StreamMimoPcmOptions {
  /** API Key（仅用于鉴权头与错误脱敏，绝不外显）。 */
  apiKey: string;
  /** 请求体（`buildMimoRequestBody` 的产物）。 */
  body: Record<string, unknown>;
  /** 取消信号（`stop()` / 超时触发）。 */
  signal: AbortSignal;
  /** fetch 实现（测试可注入 mock；默认全局 fetch）。 */
  fetchImpl?: typeof fetch;
  /** 音频帧回调（裸 PCM，按到达顺序）。 */
  onAudio: (chunk: Buffer) => void;
}

/**
 * 发起一次流式 MiMo TTS 请求，逐行解析 SSE 并把 base64 音频解成 PCM 回调。
 * @param options 请求选项（含可注入 fetch）
 * @returns 流结束（`[DONE]` 或正文耗尽）时 resolve
 * @throws Error 网络失败 / HTTP 非 2xx（错误文本经 `redact` 脱敏，不含密钥）
 */
export async function streamMimoPcm(options: StreamMimoPcmOptions): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(MIMO_API_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(redact(`MiMo TTS 请求失败：${message}`, options.apiKey));
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(redact(`MiMo TTS 返回 ${response.status}：${detail.slice(0, 200)}`, options.apiKey));
  }
  const body = response.body;
  if (!body) throw new Error("MiMo TTS 响应无正文流");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  /** 处理一行 SSE；返回 false 表示已收到 `[DONE]`、可提前结束。 */
  const handleLine = (line: string): boolean => {
    const trimmed = line.replace(/\r$/, "");
    if (!trimmed.startsWith("data:")) return true;
    const payload = trimmed.slice(5).trim();
    if (payload.length === 0) return true;
    if (payload === "[DONE]") return false;
    let json: unknown;
    try {
      json = JSON.parse(payload);
    } catch {
      return true; // 非法 chunk 跳过（不中断整流）
    }
    const pcm = extractMimoAudioPcm(json);
    if (pcm && pcm.length > 0) options.onAudio(pcm);
    return true;
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!handleLine(line)) return;
      newline = buffer.indexOf("\n");
    }
  }
  if (buffer.length > 0) handleLine(buffer);
}

/** MiMo TTS provider（SSE 流式；单实例，新 speak 打断旧朗读）。 */
export class MiMoProvider implements TtsProvider {
  readonly name = MIMO_PROVIDER_NAME;
  /** SSE 音频帧本就经 AudioSink 落地 ⇒ 支持只合成不出声（预取）。 */
  readonly pcmOutputSupport = true;
  private readonly log: Logger = createLogger("tts-mimo");
  private sink: AudioSink | null = null;
  private params: MimoParams | null = null;
  private apiKey: string | null = null;
  private controller: AbortController | null = null;
  private activeToken = "";

  /**
   * 后台流式合成并播放：立即返回（不等待播放完成）；内部先打断上一次。
   * @param options 解析后的朗读参数（含 `mimoApiKey`）
   * @returns 本次朗读的启动结果（含 `taskId` 与 `done`）
   * @throws Error 文本为空 / API Key 缺失 / 无可用播放路径
   */
  speak(options: ResolvedTtsOptions): SpeakResult {
    if (options.text.trim().length === 0) {
      throw new Error("text 不能为空");
    }
    const apiKey = options.mimoApiKey?.trim();
    if (!apiKey) {
      // 与 credentials.resolveMimoApiKey 同一引导文案单源（mimoKeyMissingError），此处为 speak 已解析后的兜底
      throw mimoKeyMissingError();
    }
    const params = resolveMimoParams(options);
    // 音频落地：有 sinkFactory（只合成不出声）时用它；否则在发起时**同步**选定播放路径，
    // 无任何可用路径立刻抛清晰错误（不静默）
    const sink = createProviderSink(options, MIMO_SAMPLE_RATE, this.log);
    this.stop();
    const token = randomBytes(8).toString("hex");
    this.activeToken = token;
    this.params = params;
    this.apiKey = apiKey;
    this.sink = sink;
    const done = this.run(options.text, token).catch((err: unknown) => {
      this.log.error("MiMo 合成/播放失败", err instanceof Error ? err : String(err));
    });
    return { provider: this.name, voice: params.voice, rate: options.rate, taskId: randomUUID(), done };
  }

  /** 打断：abort 进行中的 HTTP/SSE 请求、中断播放（幂等）。 */
  stop(): void {
    this.activeToken = "";
    const controller = this.controller;
    this.controller = null;
    if (controller) controller.abort();
    const sink = this.sink;
    this.sink = null;
    if (sink) sink.abort();
    this.params = null;
    this.apiKey = null;
  }

  /**
   * 完整流程：单请求送全文 → SSE 音频到达即写 sink → 流结束后等播放完成。
   * @param text 正文
   * @param token 本次调用令牌（被打断则中止）
   */
  private async run(text: string, token: string): Promise<void> {
    const sink = this.sink;
    const params = this.params;
    const apiKey = this.apiKey;
    if (!sink || !params || !apiKey) return;
    const controller = new AbortController();
    this.controller = controller;
    const timer = setTimeout(() => controller.abort(), MIMO_SYNTH_TIMEOUT_MS);
    try {
      await streamMimoPcm({
        apiKey,
        body: buildMimoRequestBody({ model: params.model, voice: params.voice, text, instruction: params.instruction }),
        signal: controller.signal,
        onAudio: (chunk: Buffer) => {
          if (this.activeToken === token) sink.write(chunk);
        },
      });
      if (this.activeToken !== token) return;
      // 分段回退：单请求收齐后落成一段（流式为无操作；超长由 SegmentedSink 安全上限兜底）
      sink.boundary();
      await sink.end();
    } catch (err) {
      if (this.activeToken !== token) return; // 被 stop() 打断：静默收尾，不记错误
      sink.abort();
      throw err;
    } finally {
      clearTimeout(timer);
      if (this.controller === controller) this.controller = null;
    }
  }
}
