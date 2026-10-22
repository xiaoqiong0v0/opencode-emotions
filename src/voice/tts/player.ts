/**
 * 音频**播放器抽象**：把「播放一个本地音频文件」与具体平台解耦。
 *
 * 候选/探测对齐 opencode-sound-notify 的做法：
 * - Windows：PowerShell `System.Media.SoundPlayer`（`pwsh` 优先，回退 `powershell`）；WAV 路径经环境变量传入（无注入面）
 * - macOS：`afplay`
 * - Termux（Android）：`play-audio`（绝对路径 `$PREFIX/bin/play-audio`，默认前缀
 *   `/data/data/com.termux/files/usr`），带音频流参数 `-s <stream>`；找不到时明确提示 `pkg install play-audio`
 * - Linux：`/usr/bin/paplay` → `/usr/bin/aplay`（按绝对路径探测，取第一个存在且可执行的）
 * - 显式覆盖：环境变量 `TTS_PLAYER`（可用播放器 id，或任意命令名 → 以 `<bin> <file>` 调用）
 * - 音频流：环境变量 `TTS_STREAM`（`media`/`alarm`/`notification`/`ring`/`system`/`voice`，默认 `media`；仅 Termux `play-audio` 用到）
 *
 * 探测为纯函数式（`isAvailable` 可注入），便于离线单测；找不到任何播放器时抛**清晰错误**并提示可装什么。
 */

import { commandExists, isTermux, POWERSHELL_BINS, termuxExecutable } from "../platform.js";

// 复用/对外沿用：`isTermux` 与 `commandExists` 的实现已抽到 `../platform.js`，
// 这里转出以保持既有导入路径（player.ts / tts/index.ts / 单测）不变。
export { commandExists, isTermux };

/** Windows SoundPlayer 脚本（WAV 路径经环境变量传入，无注入面）。 */
export const SOUNDPLAYER_SCRIPT = `$ErrorActionPreference='Stop'; (New-Object System.Media.SoundPlayer $env:OC_TTS_WAV).PlaySync()`;
/** 传给 SoundPlayer 子进程的 WAV 路径环境变量。 */
export const ENV_SOUNDPLAYER_WAV = "OC_TTS_WAV";
/** 显式覆盖播放器的环境变量。 */
export const ENV_TTS_PLAYER = "TTS_PLAYER";
/** 音频流类型环境变量（仅 Termux `play-audio` 生效）。 */
export const ENV_TTS_STREAM = "TTS_STREAM";
/** 默认音频流类型。 */
export const DEFAULT_TTS_STREAM = "media";

/** Termux 播放器命令名。 */
const TERMUX_PLAYER = "play-audio";

/** Windows 播放器候选可执行文件（`POWERSHELL_BINS` 单源：`pwsh` 7 优先、回退 Windows PowerShell 5.1）。 */
const SOUNDPLAYER_BINS = POWERSHELL_BINS;
/** Linux 播放器候选（绝对路径，按顺序取第一个存在且可执行的；与 sound-notify 一致）。 */
const LINUX_BINS = ["/usr/bin/paplay", "/usr/bin/aplay"] as const;

/** 一次播放的启动命令。 */
export interface PlayerCommand {
  /** 可执行文件名或路径。 */
  bin: string;
  /** argv（不含可执行文件本身）。 */
  args: string[];
  /** 需并入子进程环境的额外变量（如 SoundPlayer 的 WAV 路径）。 */
  env?: NodeJS.ProcessEnv;
}

/** 播放命令构造器：给定音频文件路径，产出启动命令。 */
export type PlayerLauncher = (file: string) => PlayerCommand;

/** 一个候选播放器定义。 */
interface PlayerDefinition {
  /** 播放器标识（供 `TTS_PLAYER` 选择与错误提示）。 */
  id: string;
  /** 按顺序探测的可执行文件（第一个可用者胜出）。 */
  bins: readonly string[];
  /** 由选中的可执行文件与音频文件构造启动命令。 */
  build: (bin: string, file: string) => PlayerCommand;
  /** 未找到时给用户的安装提示（错误信息聚合用）。 */
  installHint?: string;
}

/** 解析音频流类型：`TTS_STREAM` 去空白；空/未设回退默认 `media`。 */
function resolveStream(env: NodeJS.ProcessEnv): string {
  const raw = env[ENV_TTS_STREAM];
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  return DEFAULT_TTS_STREAM;
}

/**
 * 构造 Termux 播放器定义（绝对路径 + 音频流参数）。
 * @param env 环境变量表（读取 `PREFIX` / `TTS_STREAM`）
 * @returns 候选定义（bin 为绝对路径，探测交给 isAvailable）
 */
function termuxDefinition(env: NodeJS.ProcessEnv): PlayerDefinition {
  const stream = resolveStream(env);
  return {
    id: TERMUX_PLAYER,
    bins: [termuxExecutable(env, TERMUX_PLAYER)],
    build: (bin, file) => ({ bin, args: stream ? ["-s", stream, file] : [file] }),
    installHint: `Termux 未找到 ${TERMUX_PLAYER}，请执行：pkg install ${TERMUX_PLAYER}`,
  };
}

/** 播放器定义表（id → 定义；Termux `play-audio` 依赖环境变量，不在此静态表内）。 */
const DEFINITIONS: Readonly<Record<string, PlayerDefinition>> = {
  soundplayer: {
    id: "soundplayer",
    bins: SOUNDPLAYER_BINS,
    build: (bin, file) => ({
      bin,
      args: ["-NoProfile", "-NonInteractive", "-Command", SOUNDPLAYER_SCRIPT],
      env: { [ENV_SOUNDPLAYER_WAV]: file },
    }),
  },
  paplay: { id: "paplay", bins: [LINUX_BINS[0]], build: (bin, file) => ({ bin, args: [file] }) },
  aplay: { id: "aplay", bins: [LINUX_BINS[1]], build: (bin, file) => ({ bin, args: [file] }) },
  afplay: { id: "afplay", bins: ["afplay"], build: (bin, file) => ({ bin, args: [file] }) },
};

/** 选中的播放器（含实际可执行文件）。 */
export interface SelectedPlayer {
  /** 播放器标识。 */
  id: string;
  /** 实际使用的可执行文件。 */
  bin: string;
  /** 构造启动命令。 */
  launcher: PlayerLauncher;
}

/** 选择选项（可注入以便单测）。 */
export interface SelectPlayerOptions {
  /** 目标平台；默认 `process.platform`。 */
  platform?: NodeJS.Platform;
  /** 环境变量表；默认 `process.env`。 */
  env?: NodeJS.ProcessEnv;
  /** 可执行文件可用性探测；默认按 PATH/PATHEXT 查找（绝对路径按可执行文件判定）。 */
  isAvailable?: (bin: string) => boolean;
}

/**
 * 按平台/显式覆盖给出**候选顺序**（不含可用性探测）。Termux（`android` 平台或 Termux 环境变量）只走 `play-audio`。
 * @param platform 目标平台
 * @param env 环境变量表
 * @returns 候选播放器定义
 */
function candidateDefinitions(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): PlayerDefinition[] {
  const override = env[ENV_TTS_PLAYER]?.trim();
  if (override) {
    // `play-audio` 需按环境变量解析绝对路径，单独构造
    if (override.toLowerCase() === TERMUX_PLAYER) return [termuxDefinition(env)];
    const known = DEFINITIONS[override.toLowerCase()];
    if (known) return [known];
    // 未知 id：当作可执行文件名，以 `<bin> <file>` 调用
    return [{ id: override, bins: [override], build: (bin, file) => ({ bin, args: [file] }) }];
  }
  if (platform === "win32") return [DEFINITIONS.soundplayer];
  if (platform === "darwin") return [DEFINITIONS.afplay];
  if (platform === "android" || isTermux(env)) return [termuxDefinition(env)];
  return [DEFINITIONS.paplay, DEFINITIONS.aplay];
}

/**
 * 选择一个可用播放器。
 * @param options 选项（平台/env/探测，均可注入）
 * @returns 选中的播放器
 * @throws Error 无任何可用播放器（错误文本含平台、已尝试候选与安装提示）
 */
export function selectPlayer(options: SelectPlayerOptions = {}): SelectedPlayer {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const isAvailable = options.isAvailable ?? ((bin: string) => commandExists(bin, env, platform));
  const candidates = candidateDefinitions(platform, env);
  const tried: string[] = [];
  const hints: string[] = [];
  for (const candidate of candidates) {
    for (const bin of candidate.bins) {
      if (isAvailable(bin)) {
        return { id: candidate.id, bin, launcher: (file: string) => candidate.build(bin, file) };
      }
    }
    tried.push(candidate.id);
    if (candidate.installHint) hints.push(candidate.installHint);
  }
  const termux = platform === "android" || isTermux(env);
  const hintPart = hints.length > 0 ? ` 安装建议：${hints.join("；")}。` : "";
  const linuxHint = !termux && platform === "linux" ? " 常见：pulseaudio-utils 提供 /usr/bin/paplay、alsa-utils 提供 /usr/bin/aplay。" : "";
  throw new Error(
    `未找到可用的音频播放器（平台=${platform}${termux ? ", Termux" : ""}）。已尝试：${tried.join(", ")}。` +
      `${hintPart}${linuxHint}` +
      `可用环境变量 ${ENV_TTS_PLAYER} 指定播放器，${ENV_TTS_STREAM} 设置音频流（默认 ${DEFAULT_TTS_STREAM}）。`,
  );
}
