/**
 * ASR 客户端统一抽象：stream（WebSocket 实时）与 segment（整段 HTTP）两类传输共用。
 *
 * - 结果/错误经构造参数里的 `onResult` / `onError` 回调上报（与原 `AliyunAsrOptions` 口径一致）；
 *   segment 客户端只产 `isFinal: true` 的整段结果（无 partial）。
 * - `AsrResult` 原定义在 `voice/aliyun.ts`，为让 segment 客户端与工厂共用而收敛到本模块，
 *   `aliyun.ts` 继续再导出（既有导入路径不变）。
 */

import type { VoiceEmotion } from "../mapping.js";

/** 一条识别结果。 */
export interface AsrResult {
  /** 识别文本；partial 为预览，final 为句末/整段完整文本。 */
  text: string;
  /** 是否句末/整段最终结果。 */
  isFinal: boolean;
  /** 情绪标签（7 类之一）；本次结果未携带时为空串。 */
  emotion: VoiceEmotion | "";
}

/** ASR 传输分类：stream=WebSocket 实时（realtime/inference 两方言）；segment=整段音频→HTTP→文本。 */
export type AsrTransport = "stream" | "segment";

/**
 * ASR 客户端统一接口（connect → feed* → finish；close 兜底）。
 * 结果与错误事件不在此接口上，而是各实现构造参数的 `onResult`/`onError` 回调。
 */
export interface AsrClient {
  /** 传输分类（工厂/运行时按此分流自测与收尾行为）。 */
  readonly transport: AsrTransport;
  /** 已脱敏的错误文本（空串表示无错误）。 */
  readonly errorMessage: string;
  /** 是否已结束（收到结束事件 / 错误 / finish 超时 / close）。 */
  readonly isFinished: boolean;
  /**
   * 建立会话：stream 打开 WS 并下发首个控制消息；segment 无持久连接，直接 resolve。
   * @param timeoutMs 等待握手的超时（毫秒，仅 stream 的 inference 使用）
   * @returns 就绪后 resolve
   * @throws Error 握手失败（已脱敏）
   */
  connect(timeoutMs?: number): Promise<void>;
  /**
   * 喂入 PCM（s16le）。stream 按帧发 WS；segment 缓冲到段边界后整段送 HTTP。
   * @param pcm PCM 字节流
   */
  feed(pcm: Buffer): void;
  /**
   * 结束输入并等待收尾：stream 发结束消息等服务端结束事件；segment 冲刷剩余缓冲并等全部在途/排队请求完成。
   * @param timeoutMs 等待上限（毫秒，仅 stream 使用）
   */
  finish(timeoutMs?: number): Promise<void>;
  /** 关闭/中止：stream 关 WS；segment abort 进行中的 HTTP 并清空缓冲（幂等）。 */
  close(): void;
}
