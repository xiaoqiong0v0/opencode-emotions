/**
 * `emotions-cli` 的参数解析（纯函数，可离线单测）。
 *
 * 与入口 `src/cli/emotions-cli.ts` 分离，便于测试；只做「字符串数组 → 结构化命令」，
 * 不触 IO、不执行业务。支持 `--flag value` 与 `--flag=value` 两种写法。
 */

/** 解析结果。 */
export type CliCommand =
  | {
      kind: "speak";
      /** 内联文本（已去空白）；与 `textFile` 二选一（都缺则报错；`follow` 时二者必须都缺）。 */
      text: string;
      /** 文本文件路径（优先于 `text`；用于长文本/避免命令行注入）。 */
      textFile?: string;
      /**
       * 正文从 **stdin** 读取（`--text-stdin`；工具层长文本/特殊字符走此通道，绕开 argv 长度上限）。
       * 与 `--text`/`--text-file`/`--follow` 互斥；CLI 读完 stdin 后按普通 `text` 处理。
       */
      textStdin?: boolean;
      emotion?: string;
      voice?: string;
      rate?: number;
      provider?: string;
      /** 是否后台播放（立即返回）。 */
      background: boolean;
      /**
       * 是否 follow 常驻模式：从 stdin 按行读 UTF-8 文本连续朗读（每行一块），EOF 收尾退出。
       * 与 `--text`/`--text-file`/`--background` 互斥；provider 不支持 follow 时运行时报清晰错误。
       */
      follow: boolean;
      /**
       * **只合成不出声**：把 16bit PCM（WAV 容器）写到该路径，不播放、不登记 `tts-playback`。
       * 供自动朗读预取下一单元使用；与 `--follow`/`--background`/`--pcm-file` 互斥。
       */
      pcmOut?: string;
      /**
       * **播放已有的 PCM 文件**（`--pcm-out` 的产物）：经音频 sink 播放。跳过「开播前 stopPlayback」
       * ——预取进程在上一个单元还在播时预热，不能反过来杀掉它。
       */
      pcmFile?: string;
      /**
       * 与 `--pcm-file` 搭配：先预热播放器，再阻塞等待 stdin 上一行 `go` 才开始写音频。
       * 保证「N+1 的音频不得早于 N 播放」；stdin 先 EOF ⇒ 不播、退出 0。
       */
      awaitGo?: boolean;
      /**
       * 与 `--pcm-file` 搭配：**跟随增长播放**（边合成边交播）——拿 `go` 后按文件当前长度读取，
       * 未到写端结束时轮询等待新字节；写端用 stdin 控制行 {@link PCM_FOLLOW_DONE_LINE} /
       * {@link PCM_FOLLOW_ABORT_LINE} 收尾。
       */
      pcmFollow?: boolean;
    }
  | { kind: "devices" }
  | { kind: "status" }
  | { kind: "help" }
  /** 内部子命令：由 `speak --background` 以分离进程再调用，前台执行真正的合成+播放。 */
  | { kind: "play" }
  | { kind: "error"; message: string };

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

/** `speak` 的**只合成不出声**开关（预取用；与 `tts/prefetch.ts` 共用同一字面量）。 */
export const PCM_OUT_FLAG = "--pcm-out";
/** `speak` 的**播放 PCM 文件**开关（预取交播用）。 */
export const PCM_FILE_FLAG = "--pcm-file";
/** `--pcm-file` 的交播闸门：预热后等 stdin 一行 `go` 再出声。 */
export const AWAIT_GO_FLAG = "--await-go";
/** 交播闸门放行行内容。 */
export const AWAIT_GO_LINE = "go";
/**
 * `--pcm-file` 的**跟随增长**开关（预取·边合成边交播，2026-10-23 第十五批）：
 * 播放端从 `data` 区当前长度起边到边读，**不等整段合成完成**；写端用控制行收尾。
 * 隐含交播闸门（先等 {@link AWAIT_GO_LINE}，再读文件），与 `--await-go` 同时给出时只按本模式处理。
 */
export const PCM_FOLLOW_FLAG = "--pcm-follow";
/** 跟随模式控制行：写端**正常结束**（播放端读到当前 EOF 后收尾退出 0）。 */
export const PCM_FOLLOW_DONE_LINE = "done";
/** 跟随模式控制行：写端**异常结束**（播放端按「已播部分 + 明确错误」退出，不假装完整）。 */
export const PCM_FOLLOW_ABORT_LINE = "abort";
/**
 * `--pcm-file` 退出码：**写端异常但已播出一部分**——调用方不得重读（会重复），只记明确错误。
 * （0=完整播完；1=从未起播/失败；3=已播部分后写端异常）
 */
export const PCM_PLAY_EXIT_PARTIAL = 3;
/**
 * `--pcm-file` 退出码：**从未起播**（文件/头/设备/闸门之前就失败）——调用方**唯一**可以安全
 * 串行重读的情形。0/3 都必然已出声，绝不能据此重播（防双播硬约束）。
 */
export const PCM_PLAY_EXIT_NOT_STARTED = 1;
/**
 * `speak --pcm-file` 在**真正开始写音频**前打印到 stdout 的标记行。
 * 预取方据此区分「播放器从未起播（应降级串行）」与「已出声后异常（不得重读，避免重复）」。
 */
export const PCM_PLAY_STARTED_MARKER = "OC_PCM_PLAY_STARTED";

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
  let textFile: string | undefined;
  let textStdin = false;
  let emotion: string | undefined;
  let voice: string | undefined;
  let provider: string | undefined;
  let rate: number | undefined;
  let background = false;
  let follow = false;
  let pcmOut: string | undefined;
  let pcmFile: string | undefined;
  let awaitGo = false;
  let pcmFollow = false;

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
      case "--text-file":
        textFile = takeValue();
        break;
      case "--text-stdin":
        textStdin = true;
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
      case "--follow":
        follow = true;
        break;
      case PCM_OUT_FLAG: {
        const raw = takeValue();
        if (raw === undefined || raw.trim().length === 0) return { kind: "error", message: `${PCM_OUT_FLAG} 需要一个文件路径` };
        pcmOut = raw.trim();
        break;
      }
      case PCM_FILE_FLAG: {
        const raw = takeValue();
        if (raw === undefined || raw.trim().length === 0) return { kind: "error", message: `${PCM_FILE_FLAG} 需要一个文件路径` };
        pcmFile = raw.trim();
        break;
      }
      case AWAIT_GO_FLAG:
        awaitGo = true;
        break;
      case PCM_FOLLOW_FLAG:
        pcmFollow = true;
        break;
      default:
        // 未识别选项：忽略（容错），不报错
        break;
    }
  }

  const trimmed = (text ?? "").trim();
  const file = textFile?.trim();
  // 纯播放已有 PCM：不接受任何正文来源，也不进后台/follow/只合成模式
  if (pcmFile !== undefined) {
    if (
      follow ||
      background ||
      pcmOut !== undefined ||
      textStdin ||
      trimmed.length > 0 ||
      (file !== undefined && file.length > 0)
    ) {
      return { kind: "error", message: `${PCM_FILE_FLAG} 与正文来源/--follow/--background/${PCM_OUT_FLAG} 互斥` };
    }
    const playCommand: CliCommand = { kind: "speak", text: "", background: false, follow: false, pcmFile, awaitGo };
    if (pcmFollow) playCommand.pcmFollow = true;
    return playCommand;
  }
  if (pcmFollow) return { kind: "error", message: `${PCM_FOLLOW_FLAG} 只能与 ${PCM_FILE_FLAG} 搭配` };
  if (awaitGo) return { kind: "error", message: `${AWAIT_GO_FLAG} 只能与 ${PCM_FILE_FLAG} 搭配` };
  if (pcmOut !== undefined && (follow || background)) {
    return { kind: "error", message: `${PCM_OUT_FLAG} 与 --follow/--background 互斥` };
  }
  if (textStdin && (trimmed.length > 0 || (file !== undefined && file.length > 0) || follow)) {
    return { kind: "error", message: "--text-stdin 与 --text/--text-file/--follow 互斥" };
  }
  if (follow) {
    // follow 模式正文走 stdin 行：与 --text/--text-file/--background 互斥（--background 载荷是单段文本）
    if (trimmed.length > 0) return { kind: "error", message: "--follow 与 --text 互斥（正文从 stdin 按行读取）" };
    if (file !== undefined && file.length > 0) {
      return { kind: "error", message: "--follow 与 --text-file 互斥（正文从 stdin 按行读取）" };
    }
    if (background) return { kind: "error", message: "--follow 与 --background 互斥（follow 自身即常驻前台）" };
    const followCommand: CliCommand = { kind: "speak", text: "", background: false, follow: true };
    if (emotion !== undefined && emotion.trim().length > 0) followCommand.emotion = emotion.trim();
    if (voice !== undefined && voice.trim().length > 0) followCommand.voice = voice.trim();
    if (provider !== undefined && provider.trim().length > 0) followCommand.provider = provider.trim();
    if (rate !== undefined) followCommand.rate = rate;
    return followCommand;
  }
  if (trimmed.length === 0 && (file === undefined || file.length === 0) && !textStdin) {
    return { kind: "error", message: "speak 需要 --text <文本> / --text-file <路径> / --text-stdin 或 --follow" };
  }
  const command: CliCommand = { kind: "speak", text: trimmed, background, follow: false };
  if (textStdin) command.textStdin = true;
  if (file !== undefined && file.length > 0) command.textFile = file;
  if (pcmOut !== undefined) command.pcmOut = pcmOut;
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
