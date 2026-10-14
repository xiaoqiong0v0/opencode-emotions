/**
 * `voice-cli` 的参数解析（纯函数，可离线单测）。
 *
 * 与入口 `src/cli/voice-cli.ts` 分离，便于测试；只做「字符串数组 → 结构化命令」，
 * 不触 IO、不执行业务。支持 `--flag value` 与 `--flag=value` 两种写法。
 */

/** 解析结果。 */
export type CliCommand =
  | {
      kind: "speak";
      /** 待朗读文本（已去空白；空串视为缺失，由执行层报错）。 */
      text: string;
      emotion?: string;
      voice?: string;
      rate?: number;
      provider?: string;
      /** 是否后台播放（立即返回）。 */
      background: boolean;
    }
  | { kind: "devices" }
  | { kind: "status" }
  | { kind: "help" }
  /** 内部子命令：由 `speak --background` 以分离进程再调用，前台执行真正的合成+播放。 */
  | { kind: "play" }
  | { kind: "error"; message: string };

/** `speak` 选项名（供帮助/文档参考）。 */
export const SPEAK_FLAGS: readonly string[] = [
  "--text <text>",
  "--emotion <name>",
  "--voice <name>",
  "--rate <n>",
  "--provider <sapi|aliyun>",
  "--background",
];

/** 需要取值的选项短名 → 长名。 */
const VALUE_ALIASES: Readonly<Record<string, string>> = {
  "-t": "--text",
  "-e": "--emotion",
  "-v": "--voice",
  "-r": "--rate",
  "-p": "--provider",
};

/** 内部子命令名。 */
export const PLAY_COMMAND = "__play";

/**
 * 解析 `--flag=value` / `--flag`，返回名称与可选值。
 * @param token 单个参数
 * @returns 归一化后的选项名与值（无值的 boolean 选项 value 为 undefined）
 */
function splitFlag(token: string): { name: string; value?: string } {
  const eq = token.indexOf("=");
  if (eq === -1) return { name: token };
  return { name: token.slice(0, eq), value: token.slice(eq + 1) };
}

/**
 * 判断 token 是否「像选项」而非取值：`--x` 或 `-x`（字母开头）。
 * 负数字面量（如 `-4`、`-0.5`）不算选项，可作为取值。
 * @param token 待判定 token
 * @returns 像选项返回 true
 */
function isFlagLike(token: string): boolean {
  return token.startsWith("--") || /^-[A-Za-z]/.test(token);
}

/** 解析 `speak` 的参数。 */
function parseSpeak(tokens: readonly string[]): CliCommand {
  let text: string | undefined;
  let emotion: string | undefined;
  let voice: string | undefined;
  let provider: string | undefined;
  let rate: number | undefined;
  let background = false;

  for (let i = 0; i < tokens.length; i += 1) {
    const { name: rawName, value: inlineValue } = splitFlag(tokens[i]);
    const name = VALUE_ALIASES[rawName] ?? rawName;
    const takeValue = (): string | undefined => {
      if (inlineValue !== undefined) return inlineValue;
      const next = tokens[i + 1];
      if (next === undefined || isFlagLike(next)) return undefined;
      i += 1;
      return next;
    };
    switch (name) {
      case "--text":
        text = takeValue();
        break;
      case "--emotion":
        emotion = takeValue();
        break;
      case "--voice":
        voice = takeValue();
        break;
      case "--provider":
        provider = takeValue();
        break;
      case "--rate": {
        const raw = takeValue();
        if (raw === undefined) return { kind: "error", message: "--rate 需要一个数字" };
        const parsed = Number(raw);
        if (!Number.isFinite(parsed)) return { kind: "error", message: `--rate 不是合法数字：${raw}` };
        rate = parsed;
        break;
      }
      case "--background":
        background = true;
        break;
      default:
        // 未识别选项：忽略（容错），不报错
        break;
    }
  }

  const trimmed = (text ?? "").trim();
  if (trimmed.length === 0) return { kind: "error", message: "speak 需要 --text <文本>" };
  const command: CliCommand = { kind: "speak", text: trimmed, background };
  if (emotion !== undefined && emotion.trim().length > 0) command.emotion = emotion.trim();
  if (voice !== undefined && voice.trim().length > 0) command.voice = voice.trim();
  if (provider !== undefined && provider.trim().length > 0) command.provider = provider.trim();
  if (rate !== undefined) command.rate = rate;
  return command;
}

/**
 * 解析 CLI 参数数组。
 * @param argv 参数数组（不含 node 与脚本路径）
 * @returns 结构化命令；未知命令/非法参数返回 `kind:"error"`
 */
export function parseCliArgs(argv: readonly string[]): CliCommand {
  const tokens = argv.filter((token) => token.length > 0);
  if (tokens.length === 0) return { kind: "help" };
  const [head, ...rest] = tokens;
  const command = VALUE_ALIASES[head] ?? head;
  switch (command) {
    case "speak":
      return parseSpeak(rest);
    case "devices":
    case "status":
    case "help":
      return { kind: command };
    case PLAY_COMMAND:
      return { kind: "play" };
    case "-h":
    case "--help":
      return { kind: "help" };
    default:
      return { kind: "error", message: `未知命令：${head}（可用：speak / devices / status / help）` };
  }
}
