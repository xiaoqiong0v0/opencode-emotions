/**
 * 多语言（i18n）词表与语言解析（纯函数，零依赖、无 IO）。
 *
 * 语言来自 `<配置目录>/emotions.jsonc`，拆为两个独立键（默认均 `en`，旧键 `language` 兜底两者）：
 * - `uiLanguage` → TUI 槽位指示、toast、命令标题等**面向用户的 UI 文案**；
 * - `toolLanguage` → server 插件在**加载时**本地化工具描述（注册给模型）与 `voice-cli --help`。
 *
 * 约定：所有面向用户/模型的文案**必须集中在本表**，禁止在调用处散落硬编码；
 * 带变量的文案用 `{name}` 占位符，经 `format()` 填充。
 */

/** 受支持的语言标识。 */
export type Language = "zh" | "en";

/** 全部受支持语言。 */
export const LANGUAGES: readonly Language[] = ["zh", "en"];

/** 默认语言（未知值回退目标，与 `uiLanguage`/`toolLanguage` 的内置默认一致）。 */
export const DEFAULT_LANGUAGE: Language = "en";

/**
 * 把任意输入归一化为受支持语言（大小写、区域/分隔符不敏感：`zh-CN`→`zh`、`EN`→`en`）。
 * 未知或空值回退到 `DEFAULT_LANGUAGE`（现为 `en`，与内置默认保持一致）。
 * @param raw 原始值（可来自配置/环境变量）
 * @returns 受支持语言
 */
export function resolveLanguage(raw: string | undefined): Language {
  if (typeof raw !== "string") return DEFAULT_LANGUAGE;
  const base = raw.trim().toLowerCase().split(/[-_]/)[0];
  return (LANGUAGES as readonly string[]).includes(base) ? (base as Language) : DEFAULT_LANGUAGE;
}

/**
 * 用 `{name}` 占位符填充模板；未提供的变量原样保留。
 * @param template 含占位符的模板
 * @param vars 变量表
 * @returns 填充后的文本
 */
export function format(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match,
  );
}

/** server 插件工具文案。 */
export interface ToolPhrases {
  /** 工具对模型可见的说明。 */
  description: string;
  /** `args` 参数说明。 */
  args: string;
}

/** voice-cli 文案。 */
export interface CliPhrases {
  /** `help` 全文。 */
  help: string;
  /** 朗读已开始的确认文案（占位符：provider/voice/rate/emotion）。 */
  speakStarted: string;
  /** 朗读失败前缀（占位符：message）。 */
  speakFailed: string;
  /** 无音频输入设备。 */
  noDevices: string;
  /** 设备列表标题。 */
  devicesHeader: string;
}

/** 槽位指示文案。 */
export interface SlotPhrases {
  /** 模式「注入」。 */
  modeInject: string;
  /** 模式「输入」。 */
  modeInput: string;
}

/** 模式标签（完整名，用于 toast/命令标题）。 */
export interface LabelPhrases {
  /** 语音注入。 */
  inject: string;
  /** 语音输入。 */
  input: string;
}

/** toast 文案。 */
export interface ToastPhrases {
  title: string;
  ready: string;
  runtimeError: string;
  runtimeExited: string;
  injected: string;
  injectFailed: string;
  injectException: string;
  notInSession: string;
  appended: string;
  appendFailed: string;
  switched: string;
  modeOn: string;
  modeOff: string;
  startFailed: string;
}

/** 命令（keymap command）文案。 */
export interface CommandPhrases {
  injectTitle: string;
  injectDesc: string;
  inputTitle: string;
  inputDesc: string;
}

/** 单语言的完整文案表。 */
export interface Phrases {
  tool: ToolPhrases;
  cli: CliPhrases;
  slot: SlotPhrases;
  label: LabelPhrases;
  toast: ToastPhrases;
  command: CommandPhrases;
}

/** 中文帮助文本。 */
const HELP_ZH = [
  "语音 CLI（opencode-emotions）",
  "",
  "用法：voice-cli <命令> [选项]",
  "",
  "命令：",
  "  speak --text <文本> [--emotion <情绪>] [--voice <音色>] [--rate <语速>] [--provider <sapi|aliyun>] [--background]",
  "        合成语音并播放；--background 立即返回（后台播放）。",
  "  devices  列出本机音频输入设备",
  "  status   查看解析后的语音配置（含语言）",
  "  help     显示本帮助",
  "",
  "情绪（--emotion，映射为 CosyVoice 风格指令；sapi 忽略）：",
  "  happy | sad | angry | fearful | disgusted | surprised | confused | speechless | neutral",
  "  别名：anger / annoyed / mad / furious / rage、confusion / puzzled、sigh / meh / helpless、",
  "        great / excited / good / nice / ok / fine、calm / plain、fear / afraid、disgust、surprise",
  "  neutral 或省略 = 不加风格指令",
  "",
  "配置：<配置目录>/emotions.jsonc（tts.*、uiLanguage/toolLanguage）；环境变量 TTS_*、VOICE_UI_LANGUAGE/VOICE_TOOL_LANGUAGE（旧名 VOICE_LANGUAGE 兜底两者）可覆盖。",
].join("\n");

/** 英文帮助文本。 */
const HELP_EN = [
  "Voice CLI (opencode-emotions)",
  "",
  "Usage: voice-cli <command> [options]",
  "",
  "Commands:",
  "  speak --text <text> [--emotion <name>] [--voice <name>] [--rate <n>] [--provider <sapi|aliyun>] [--background]",
  "        Synthesize and play; --background returns immediately (plays in background).",
  "  devices  List local audio input devices",
  "  status   Show resolved voice config (incl. language)",
  "  help     Show this help",
  "",
  "Emotions (--emotion, mapped to a CosyVoice style instruction; ignored by sapi):",
  "  happy | sad | angry | fearful | disgusted | surprised | confused | speechless | neutral",
  "  Aliases: anger / annoyed / mad / furious / rage, confusion / puzzled, sigh / meh / helpless,",
  "           great / excited / good / nice / ok / fine, calm / plain, fear / afraid, disgust, surprise",
  "  neutral or omitted = no style instruction",
  "",
  "Config: <config-dir>/emotions.jsonc (tts.*, uiLanguage/toolLanguage); env TTS_* and VOICE_UI_LANGUAGE/VOICE_TOOL_LANGUAGE (legacy VOICE_LANGUAGE as fallback for both) override.",
].join("\n");

/** 全语言文案表（键必须与 `Phrases` 完全一致，缺键由类型检查拦截）。 */
export const PHRASES: Readonly<Record<Language, Phrases>> = {
  zh: {
    tool: {
      description:
        "语音 CLI：把文字合成为语音播放（speak）、列出音频输入设备（devices）、查看当前配置（status）。" +
        '当用户要求「说出来 / 念出来 / 朗读 / 用语音回答」时，调用 `speak --text "<文本>"`' +
        "（可用 `--emotion <情绪>` 指定语气、`--voice <音色>`、`--rate <语速>`）。" +
        "`args` 为完整 CLI 参数串；省略或传 `help` 显示用法。",
      args: 'CLI 参数串，例如 `speak --text "你好" --emotion happy`；也可用 `devices` / `status` / `help`。省略则显示用法。',
    },
    cli: {
      help: HELP_ZH,
      speakStarted: "已开始朗读（provider={provider}, voice={voice}, rate={rate}, emotion={emotion}）",
      speakFailed: "朗读失败：{message}",
      noDevices: "未发现音频输入设备（Windows 需 ffmpeg dshow 可用）",
      devicesHeader: "音频输入设备：",
    },
    slot: { modeInject: "注入", modeInput: "输入" },
    label: { inject: "语音注入", input: "语音输入" },
    toast: {
      title: "语音",
      ready: "语音运行时已连接，开始说话",
      runtimeError: "语音运行时错误：{message}",
      runtimeExited: "语音运行时已退出（{reason}）{detail}，可再次按热键重启",
      injected: "已注入：{text}",
      injectFailed: "注入失败：{message}",
      injectException: "注入异常：{message}",
      notInSession: "当前不在会话中，无法注入（已忽略本次结果）",
      appended: "已追加到输入框：{text}",
      appendFailed: "追加失败：{message}",
      switched: "已切换到{label}",
      modeOn: "{label}已开启（正在监听）",
      modeOff: "{label}已关闭",
      startFailed: "启动语音运行时失败：{message}",
    },
    command: {
      injectTitle: "语音：注入开关 ({key})",
      injectDesc: "识别结果作为新消息注入当前会话",
      inputTitle: "语音：输入开关 ({key})",
      inputDesc: "识别结果追加到输入框，自行编辑后发送",
    },
  },
  en: {
    tool: {
      description:
        "Voice CLI: synthesize text to speech (speak), list audio input devices (devices), show resolved config (status). " +
        'When the user asks to read something aloud / answer with voice, call `speak --text "<text>"` ' +
        "(optionally `--emotion <name>`, `--voice <name>`, `--rate <n>`). " +
        "`args` is the raw CLI argument string; omit it or pass `help` to see usage.",
      args: 'Raw CLI argument string, e.g. `speak --text "hello" --emotion happy`; also `devices` / `status` / `help`. Omit to show usage.',
    },
    cli: {
      help: HELP_EN,
      speakStarted: "Started speaking (provider={provider}, voice={voice}, rate={rate}, emotion={emotion})",
      speakFailed: "Speech failed: {message}",
      noDevices: "No audio input device found (Windows requires ffmpeg dshow)",
      devicesHeader: "Audio input devices:",
    },
    slot: { modeInject: "Inject", modeInput: "Input" },
    label: { inject: "Voice inject", input: "Voice input" },
    toast: {
      title: "Voice",
      ready: "Voice runtime connected. Start speaking.",
      runtimeError: "Voice runtime error: {message}",
      runtimeExited: "Voice runtime exited ({reason}){detail}. Press the hotkey again to restart.",
      injected: "Injected: {text}",
      injectFailed: "Injection failed: {message}",
      injectException: "Injection error: {message}",
      notInSession: "Not in a session; cannot inject (result ignored).",
      appended: "Appended to prompt: {text}",
      appendFailed: "Append failed: {message}",
      switched: "Switched to {label}",
      modeOn: "{label} enabled (listening)",
      modeOff: "{label} disabled",
      startFailed: "Failed to start voice runtime: {message}",
    },
    command: {
      injectTitle: "Voice: inject toggle ({key})",
      injectDesc: "Inject the transcript as a new message into the current session",
      inputTitle: "Voice: input toggle ({key})",
      inputDesc: "Append the transcript to the prompt for editing",
    },
  },
};

/**
 * 取指定语言的文案表。
 * @param lang 语言
 * @returns 文案表（未知语言回退默认）
 */
export function getPhrases(lang: Language): Phrases {
  return PHRASES[lang] ?? PHRASES[DEFAULT_LANGUAGE];
}
