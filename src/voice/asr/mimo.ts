/**
 * 小米 MiMo 按段（segment）ASR 客户端：OpenAI 兼容 `chat/completions`，整段 WAV 一次请求。
 *
 * 官方文档事实（上一任务已核，与 TTS 同端点/同鉴权）：
 * - `POST https://api.xiaomimimo.com/v1/chat/completions`，头 `Authorization: Bearer <MIMO_API_KEY>`，国内直连。
 * - `model: "mimo-v2.5-asr"`；user 消息
 *   `content: [{type:"input_audio", input_audio:{data:"data:audio/wav;base64,<b64>"}}]`
 *   （wav=`audio/wav`、mp3=`audio/mpeg`；**base64 后 ≤10MB**，与阿里按段同一红线）。
 * - `extra_body: {asr_options:{language:"auto"|"zh"|"en"}}`（不传=auto）——OpenAI SDK 的
 *   `extra_body` 会把键合并进 JSON 根，**线上即根级 `asr_options`**（与 DashScope 兼容模式同构），故按根级下发。
 * - 文本取返回 `choices[0].message.content`（非流式）；**无情绪输出**（preset `supportsEmotion:false`）。
 * - 采样率无强制（ASR 模型自适应），用 preset `sampleRate` 决定采集率即可。
 *
 * 语言口径（映射成单值）：`asr.language` 若已是 zh/en 直接用；否则看 `languageHints`
 * （含 zh→zh、含 en→en）；都不命中 → `auto`（不依赖具体语种）。
 * 凭证：`resolveMimoApiKey`（env `MIMO_API_KEY` > `asr.mimoCredentials.apiKey`，与 TTS 的 `tts.mimoCredentials` 相互独立），
 * 键值绝不打印/回显，错误统一经 `redact()` 脱敏。
 */

import { redact } from "../credentials.js";
import { MIMO_API_URL } from "../tts/mimo.js";
import { WAV_DATA_URL_PREFIX, SegmentAsrClientBase, type SegmentAsrOptions, type SegmentTranscript } from "./segment.js";

/** MiMo ASR 默认模型。 */
export const DEFAULT_MIMO_ASR_MODEL = "mimo-v2.5-asr";
/** MiMo ASR 可下发的语言值（官方仅此三种）。 */
export type MimoAsrLanguage = "auto" | "zh" | "en";

/** MiMo 按段客户端构造参数。 */
export interface MimoAsrOptions extends SegmentAsrOptions {
  /** MiMo API Key（仅鉴权与脱敏，绝不外显）。 */
  apiKey: string;
  /** 模型名（默认 {@link DEFAULT_MIMO_ASR_MODEL}）。 */
  model?: string;
  /** 识别语言（单值；由工厂按口径映射后传入）。 */
  language?: MimoAsrLanguage;
  /** 覆盖端点 URL（测试用）。 */
  url?: string;
}

/**
 * 把「识别语言 + 语言提示」映射为 MiMo 支持的单值（口径见文件头）。
 * @param language 识别语言（`asr.language`）
 * @param hints 语言提示（`asr.languageHints`，provider 能力位放行后）
 * @returns `zh` / `en` / `auto`
 */
export function mapMimoAsrLanguage(language: string, hints: readonly string[]): MimoAsrLanguage {
  const lang = language.trim().toLowerCase();
  if (lang === "zh" || lang === "en") return lang;
  const normalized = hints.map((hint) => hint.trim().toLowerCase());
  if (normalized.includes("zh")) return "zh";
  if (normalized.includes("en")) return "en";
  return "auto";
}

/**
 * 构造 MiMo ASR 请求体（纯函数，便于单测；非流式）。
 * @param params 模型 / data URL / 语言
 * @returns POST JSON 体（根级 `asr_options.language`，见文件头 extra_body 口径）
 */
export function buildMimoAsrRequestBody(params: { model: string; dataUrl: string; language: MimoAsrLanguage }): Record<string, unknown> {
  return {
    model: params.model,
    messages: [
      {
        role: "user",
        content: [{ type: "input_audio", input_audio: { data: params.dataUrl } }],
      },
    ],
    asr_options: { language: params.language },
  };
}

/** chat 响应的最小结构（只取文本）。 */
interface MimoAsrResponse {
  choices?: Array<{ message?: { content?: unknown } }>;
  error?: { message?: unknown };
}

/**
 * 从响应 JSON 解出整段文本（纯函数，便于单测；无情绪）。
 * @param payload 已 JSON.parse 的响应对象
 * @returns 整段识别结果（emotion 恒为空串）
 * @throws Error 响应结构不符
 */
export function parseMimoAsrResponse(payload: unknown): SegmentTranscript {
  if (!payload || typeof payload !== "object") throw new Error("MiMo ASR 响应不是对象");
  const body = payload as MimoAsrResponse;
  const message = body.choices?.[0]?.message;
  if (!message) {
    const apiMessage = typeof body.error?.message === "string" ? body.error.message : "";
    throw new Error(`MiMo ASR 响应缺少 choices[0].message${apiMessage ? `：${apiMessage}` : ""}`);
  }
  const text = typeof message.content === "string" ? message.content : "";
  return { text, emotion: "" };
}

/** MiMo 按段（mimo-v2.5-asr）客户端。 */
export class MimoAsrClient extends SegmentAsrClientBase {
  private readonly url: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly language: MimoAsrLanguage;

  /**
   * @param options MiMo 按段构造参数
   */
  constructor(options: MimoAsrOptions) {
    super(options);
    this.url = options.url ?? MIMO_API_URL;
    this.apiKey = options.apiKey;
    this.model = options.model?.trim() || DEFAULT_MIMO_ASR_MODEL;
    this.language = options.language ?? "auto";
  }

  /**
   * 提交一段 WAV：打包 data URL → POST 非流式 chat/completions → 解析文本。
   * @param wav 完整 WAV 字节
   * @param signal 取消信号
   * @returns 整段识别结果（无情绪）
   * @throws Error 网络失败 / HTTP 非 2xx / 响应解析失败（已脱敏）
   */
  protected async submitSegment(wav: Buffer, signal: AbortSignal): Promise<SegmentTranscript> {
    const body = buildMimoAsrRequestBody({
      model: this.model,
      dataUrl: `${WAV_DATA_URL_PREFIX}${wav.toString("base64")}`,
      language: this.language,
    });
    const payload = await this.postJson(this.url, this.apiKey, body, signal, "MiMo ASR");
    try {
      return parseMimoAsrResponse(payload);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(redact(message, this.apiKey));
    }
  }
}
