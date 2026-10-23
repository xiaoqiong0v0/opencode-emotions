/**
 * 语音运行时 stdout 的 NDJSON 输出契约（`--json` 模式）与解析工具。
 *
 * 约定：`--json` 时 stdout 只写本契约的 JSON 行（一行一个事件），人类可读日志一律走 stderr；
 * TUI 插件按行解析后据此分发（注入 / 追加）。契约与本模块独立于进程，便于离线单测。
 *
 * 事件类型（`type` 判别）：
 * - `ready`：运行时已连上 ASR（附带模型名）；
 * - `final`：一句最终识别结果（注入/追加的数据源）；
 * - `level`：麦克风电平（采集期间的节流上行，`level ∈ [0,1]`，供槽位盲文音量列渲染）；
 * - `progress`：启动阶段进度（如 ffmpeg 运行时自愈；低频、仅提示用，不承载业务数据）；
 * - `error`：运行时错误（已脱敏）；
 * - `done` ：运行时结束（正常或异常）。
 */

/** 一条最终识别结果（注入/追加的数据源）。 */
export interface RuntimeFinal {
  /** 识别文本（非空）。 */
  text: string;
  /** 原始情绪标签（7 类之一）；无则空串。 */
  emotion: string;
  /** 统一标注 `emoji(等级/3)`；中性/未知为空串。 */
  annotation: string;
}

/** stdout 事件联合（按 `type` 判别）。 */
export type RuntimeEvent =
  | { type: "ready"; model: string }
  | { type: "final"; text: string; emotion: string; annotation: string }
  | { type: "level"; level: number }
  | { type: "progress"; stage: string; message: string }
  | { type: "error"; message: string }
  | { type: "done" };

/** 判断值是否为非数组对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 仅当值为字符串时返回，否则 null。 */
function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * 把事件编码为一行 NDJSON（末尾含换行）。
 * @param event 事件对象
 * @returns JSON 行字符串
 */
export function encodeEvent(event: RuntimeEvent): string {
  return `${JSON.stringify(event)}\n`;
}

/**
 * 解析一行 NDJSON 为事件；空行 / 非法 JSON / 未知或字段不合法时返回 null（调用方跳过）。
 * @param line 单行文本（两端空白会被去除）
 * @returns 事件对象或 null
 */
export function parseEventLine(line: string): RuntimeEvent | null {
  const raw = line.trim();
  if (raw.length === 0) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(data) || typeof data.type !== "string") return null;
  switch (data.type) {
    case "ready":
      return { type: "ready", model: asString(data.model) ?? "" };
    case "final": {
      const text = asString(data.text);
      if (text === null || text.length === 0) return null;
      return {
        type: "final",
        text,
        emotion: asString(data.emotion) ?? "",
        annotation: asString(data.annotation) ?? "",
      };
    }
    case "level": {
      // 电平事件：level 必须是**有限数值**；非数值 / NaN / Infinity ⇒ 丢弃整条事件（返回 null，绝不抛）
      if (typeof data.level !== "number" || !Number.isFinite(data.level)) return null;
      return { type: "level", level: data.level };
    }
    case "progress":
      return {
        type: "progress",
        stage: asString(data.stage) ?? "",
        message: asString(data.message) ?? "",
      };
    case "error":
      return { type: "error", message: asString(data.message) ?? "未知错误" };
    case "done":
      return { type: "done" };
    default:
      return null;
  }
}

/**
 * 增量行分割器：把任意分片的 stdout 文本切成完整行（处理跨分片的半行）。
 *
 * 与 `parseEventLine` 同属契约层，供 TUI 插件复用；可离线单测。
 */
export class NdjsonLineSplitter {
  private buffer = "";

  /**
   * 喂入一段文本，返回其中所有完整行（去掉 `\n` 与行尾 `\r`）。
   * @param chunk 任意分片文本
   * @returns 完整行数组（不含换行符）
   */
  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines: string[] = [];
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      lines.push(this.buffer.slice(0, index).replace(/\r$/, ""));
      this.buffer = this.buffer.slice(index + 1);
      index = this.buffer.indexOf("\n");
    }
    return lines;
  }

  /**
   * 取出缓冲区中不足一行的残留文本并清空（流结束时使用）。
   * @returns 残留文本
   */
  flush(): string {
    const rest = this.buffer;
    this.buffer = "";
    return rest;
  }
}
