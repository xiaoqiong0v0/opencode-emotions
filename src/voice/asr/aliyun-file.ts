/**
 * 阿里云按段（segment）ASR 客户端：qwen3-asr-flash **同步** OpenAI 兼容接口。
 *
 * 官方文档（2026-10-19 webfetch 核，
 * https://help.aliyun.com/zh/model-studio/qwen-asr-api-reference）：
 * - 端点：`POST https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions`
 * - 请求体：`model` + `messages`（user 消息 `content:[{type:"input_audio", input_audio:{data: dataURL}}]`）
 *   + `stream:false` + `asr_options:{language?, enable_itn}`（cURL 示例即根级 asr_options）。
 * - 输入：Base64 Data URL（`data:audio/wav;base64,`），**编码后 ≤10MB**、录音 **≤5 分钟**。
 * - 响应（非流式）：`choices[0].message.content`（文本）+
 *   `choices[0].message.annotations[0].{language, emotion}`——emotion 为 7 类
 *   （surprised/neutral/happy/sad/disgusted/angry/fearful），与 `VoiceEmotion` 对齐。
 *
 * 选同步而非异步 task 提交+轮询：官方对 qwen3-asr-flash 明确提供同步短音频接口且支持 base64
 * （异步 filetrans 仅收公网 URL，麦克风 PCM 无法直接用），无需轮询、延迟即一次 RTT + 推理。
 * 凭证只读、绝不打印；错误文本统一经 `redact()` 脱敏。
 */

import { redact } from "../credentials.js";
import { isVoiceEmotion, type VoiceEmotion } from "../mapping.js";
import { WAV_DATA_URL_PREFIX, SegmentAsrClientBase, type SegmentAsrOptions, type SegmentTranscript } from "./segment.js";

/** 默认模型（同步按段识别；非 realtime 变体）。 */
export const DEFAULT_FILE_ASR_MODEL = "qwen3-asr-flash";
/** 按段端点模板（百炼华北2 北京 MaaS 专属域名 + OpenAI 兼容路径）。 */
export const FILE_ASR_URL_TEMPLATE = "https://{workspace}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions";

/** 阿里按段客户端构造参数。 */
export interface AliyunFileAsrOptions extends SegmentAsrOptions {
  /** 业务空间 ID（拼专属域名）。 */
  workspace: string;
  /** API Key（仅鉴权与脱敏，绝不外显）。 */
  apiKey: string;
  /** 模型名（默认 {@link DEFAULT_FILE_ASR_MODEL}）。 */
  model?: string;
  /** 识别语言；空串 = 不下发（自动识别）。 */
  language?: string;
  /** 覆盖端点 URL（测试/换地域用）。 */
  url?: string;
}

/**
 * 按 workspace 拼按段（OpenAI 兼容）端点。
 * @param workspace 业务空间 ID
 * @returns 完整 https URL
 */
export function buildFileAsrUrl(workspace: string): string {
  return FILE_ASR_URL_TEMPLATE.replace("{workspace}", workspace);
}

/**
 * 构造 qwen3-asr-flash 同步请求体（纯函数，便于单测；与官方 cURL 示例同构）。
 * @param params 模型 / data URL / 语言（空 = 不下发）
 * @returns POST JSON 体（`stream:false`；`asr_options.enable_itn` 恒为 false）
 */
export function buildAliyunFileAsrBody(params: { model: string; dataUrl: string; language?: string }): Record<string, unknown> {
  const asrOptions: Record<string, unknown> = { enable_itn: false };
  const language = params.language?.trim();
  if (language) asrOptions.language = language;
  return {
    model: params.model,
    messages: [
      {
        role: "user",
        content: [{ type: "input_audio", input_audio: { data: params.dataUrl } }],
      },
    ],
    stream: false,
    asr_options: asrOptions,
  };
}

/** chat 响应的最小结构（只取文本与情绪标注）。 */
interface AliyunFileResponse {
  choices?: Array<{
    message?: {
      content?: unknown;
      annotations?: Array<{ emotion?: unknown; type?: unknown }>;
    };
  }>;
  error?: { message?: unknown };
}

/**
 * 从响应 JSON 解出整段文本与情绪（纯函数，便于单测）。
 * 兼容 `content` 为字符串或分片数组（防御性处理）。
 * @param payload 已 JSON.parse 的响应对象
 * @returns 整段识别结果
 * @throws Error 响应结构不符
 */
export function parseAliyunFileResponse(payload: unknown): SegmentTranscript {
  if (!payload || typeof payload !== "object") throw new Error("阿里按段 ASR 响应不是对象");
  const body = payload as AliyunFileResponse;
  const message = body.choices?.[0]?.message;
  if (!message) {
    const apiMessage = typeof body.error?.message === "string" ? body.error.message : "";
    throw new Error(`阿里按段 ASR 响应缺少 choices[0].message${apiMessage ? `：${apiMessage}` : ""}`);
  }
  let text = "";
  if (typeof message.content === "string") text = message.content;
  else if (Array.isArray(message.content)) {
    text = message.content
      .map((item) => (item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string" ? (item as { text: string }).text : ""))
      .join("");
  }
  const rawEmotion = message.annotations?.[0]?.emotion;
  const normalized = typeof rawEmotion === "string" ? rawEmotion.trim().toLowerCase() : "";
  const emotion: VoiceEmotion | "" = isVoiceEmotion(normalized) ? normalized : "";
  return { text, emotion };
}

/** 阿里按段（qwen3-asr-flash 同步）客户端。 */
export class AliyunFileAsrClient extends SegmentAsrClientBase {
  private readonly url: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly language: string;

  /**
   * @param options 阿里按段构造参数
   */
  constructor(options: AliyunFileAsrOptions) {
    super(options);
    this.url = options.url ?? buildFileAsrUrl(options.workspace);
    this.apiKey = options.apiKey;
    this.model = options.model?.trim() || DEFAULT_FILE_ASR_MODEL;
    this.language = options.language ?? "";
  }

  /**
   * 提交一段 WAV：打包 data URL → POST 同步接口 → 解析文本/情绪。
   * @param wav 完整 WAV 字节
   * @param signal 取消信号
   * @returns 整段识别结果
   * @throws Error 网络失败 / HTTP 非 2xx / 响应解析失败（已脱敏）
   */
  protected async submitSegment(wav: Buffer, signal: AbortSignal): Promise<SegmentTranscript> {
    const body = buildAliyunFileAsrBody({
      model: this.model,
      dataUrl: `${WAV_DATA_URL_PREFIX}${wav.toString("base64")}`,
      language: this.language,
    });
    const payload = await this.postJson(this.url, this.apiKey, body, signal, "阿里按段 ASR");
    try {
      return parseAliyunFileResponse(payload);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(redact(message, this.apiKey));
    }
  }
}
