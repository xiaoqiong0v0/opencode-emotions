/**
 * 面向用户的**配置引导文案**（纯函数、零 IO）：三类常见缺失（ffmpeg / 音频输入设备 / 云凭证）
 * 各给一段中文可操作提示——写清「缺什么、去哪配、怎么配」。
 *
 * 设计约束：
 * - 关键信息（哪缺、去哪配）放在**前 120 字符**内（TUI toast 截断口径：stderr 摘要
 *   `STDERR_SUMMARY_MAX=160` / NDJSON error 预览 `ERROR_TOAST_MAX=120`），完整版进日志；
 * - 全部为纯函数（platform/env/路径均可注入），便于离线单测；
 * - 错误经现有链路触达用户：runtime 抛错 → stderr / NDJSON `error` → TUI toast。
 */

import { isTermux } from "./platform.js";

/**
 * 未找到 ffmpeg 时的安装提示（按平台给出；Termux 优先）。
 * @param platform 目标平台
 * @param env 环境变量表（判定 Termux）
 * @returns 提示文本
 */
export function ffmpegInstallHints(platform: NodeJS.Platform, env: NodeJS.ProcessEnv = process.env): string {
  if (isTermux(env) || platform === "android") return "Termux：pkg install ffmpeg";
  switch (platform) {
    case "win32":
      return "Windows：winget install Gyan.FFmpeg（或 choco/scoop install ffmpeg）";
    case "darwin":
      return "macOS：brew install ffmpeg";
    default:
      return "Linux：apt install ffmpeg（Debian/Ubuntu）或 pacman -S ffmpeg（Arch）";
  }
}

/**
 * 不支持的采集平台（如 macOS）的可读错误：绝不静默落到 dshow。
 * @param platform 目标平台
 * @returns 中文说明
 */
export function unsupportedCapturePlatformGuidance(platform: NodeJS.Platform): string {
  return (
    `当前平台（${platform}）暂不支持语音采集：仅支持 Windows（dshow）、` +
    "Termux/Android（termux-api）与 Linux 桌面（PulseAudio/PipeWire，ALSA 回退）。"
  );
}

/**
 * Linux 采集依赖缺失/权限问题的专属提示。
 * @param problem 问题类型
 * @param detail 可选细节（命令输出）
 * @returns 中文可操作提示
 */
export function linuxCaptureGuidance(
  problem: "ffmpeg-missing" | "pulse-missing" | "no-permission",
  detail?: string,
): string {
  const suffix = detail ? `（${detail}）` : "";
  switch (problem) {
    case "ffmpeg-missing":
      return `Linux 未找到 ffmpeg：请执行 apt install ffmpeg（Debian/Ubuntu）或 pacman -S ffmpeg（Arch）${suffix}`;
    case "pulse-missing":
      return (
        `未检测到 PulseAudio/PipeWire（pactl info 失败）${suffix}：` +
        "可安装 pactl（apt install pulseaudio-utils）或改用 ALSA（arecord -l，ffmpeg -f alsa）。"
      );
    default:
      return (
        `无麦克风访问权限${suffix}：把当前用户加入 audio 组` +
        "（sudo usermod -aG audio $USER）后重新登录；或检查 /dev/snd 权限。"
      );
  }
}

/**
 * Linux 上两条枚举命令（pactl / arecord）都不可用时的错误。
 * @param pactlCause pactl 失败原因
 * @param arecordCause arecord 失败原因
 * @returns 中文可操作提示
 */
export function linuxAudioEnumerationFailedGuidance(pactlCause: string, arecordCause: string): string {
  return (
    `Linux 上无法枚举音频输入设备：pactl（${pactlCause}）与 arecord（${arecordCause}）均不可用。` +
    `${linuxCaptureGuidance("pulse-missing")} ` +
    "请安装：apt install pulseaudio-utils alsa-utils ffmpeg（或 pacman -S libpulse alsa-utils ffmpeg）。"
  );
}

/** `ffmpegMissingGuidance` 的入参。 */
export interface FfmpegMissingGuidanceInput {
  /** 目标平台（决定安装提示）。 */
  platform: NodeJS.Platform;
  /** 环境变量表（判定 Termux）。 */
  env: NodeJS.ProcessEnv;
  /** `FFMPEG_BIN` 的原始值（已 trim；未设置则不传）。 */
  override?: string;
  /** `FFMPEG_BIN` 已设置但指向的文件不存在。 */
  overrideProblem?: "missing-file";
  /** `ffmpeg-static` 解析到了路径但文件缺失（未跑 install 下载）。 */
  staticProblem?: "missing-file";
}

/**
 * ffmpeg 全链路不可用（或解析到的文件不存在）时的用户引导。
 *
 * 关键信息在前 120 字符内：缺什么（含具体原因）→ 三种修复方式（环境变量 / 系统安装 / 重装依赖）。
 * @param input 入参（见 {@link FfmpegMissingGuidanceInput}）
 * @returns 中文可操作提示
 */
export function ffmpegMissingGuidance(input: FfmpegMissingGuidanceInput): string {
  const { platform, env } = input;
  let reason: string;
  if (input.overrideProblem === "missing-file" && input.override) {
    reason = `FFMPEG_BIN=${input.override} 指向的文件不存在`;
  } else if (input.staticProblem === "missing-file") {
    reason = "ffmpeg-static 随附二进制缺失（安装时未下载成功）";
  } else {
    reason = "FFMPEG_BIN 未设置，PATH 与 ffmpeg-static 均不可用";
  }
  return (
    `未找到可用的 ffmpeg：${reason}。请任选其一修复：` +
    "① 设置环境变量 FFMPEG_BIN=<ffmpeg 路径>（Windows 系统环境变量，或启动 opencode 的 shell 环境）；" +
    `② 安装系统 ffmpeg（${ffmpegInstallHints(platform, env)}）；` +
    "③ 重装插件依赖（npm install，或 opencode plugin add @xiaoqiong0v0/opencode-emotions --force）后重试。"
  );
}

/**
 * 枚举音频设备时 ffmpeg 无法启动（spawn ENOENT/EACCES 等）时的用户引导。
 *
 * 与「枚举成功但 0 设备」严格区分：这里带可执行路径与底层原因，指向修复 ffmpeg 本身。
 * @param bin 尝试启动的 ffmpeg 可执行路径（写进文案，便于定位）
 * @param cause 底层原因（如 `ENOENT spawnSync ...`）
 * @returns 中文可操作提示
 */
export function ffmpegLaunchFailedGuidance(bin: string, cause: string): string {
  return (
    `无法启动 ffmpeg 枚举音频设备（路径=${bin}，原因=${cause}）。可尝试：` +
    "① 设置环境变量 FFMPEG_BIN 指向可运行的 ffmpeg；" +
    `② 安装系统 ffmpeg（${ffmpegInstallHints(process.platform, process.env)}）；` +
    "③ Windows 下检查该文件是否被杀毒软件/权限拦截。"
  );
}

/**
 * 枚举**成功**但音频输入设备为 0 个时的用户引导。
 *
 * 只有枚举成功且确实 0 设备才用本文案；ffmpeg 启动失败走 {@link ffmpegLaunchFailedGuidance}。
 * @param platform 目标平台（Linux 给 pactl/arecord/audio 组提示）
 * @returns 中文可操作提示
 */
export function noAudioDeviceGuidance(platform: NodeJS.Platform = process.platform): string {
  const listed = "③ 用 node dist/runtime/voice-runtime.js --list 查看设备列表；";
  const specify = '④ 用 --device "<设备名>" 或环境变量 VOICE_DEVICE 指定设备。';
  if (platform === "linux") {
    return (
      "未找到音频输入设备（枚举成功但结果为 0 个）。请检查：" +
      "① 系统麦克风是否已连接并启用；" +
      "② pactl list short sources / arecord -l 是否有 source；" +
      `${linuxCaptureGuidance("no-permission")} ` +
      specify
    );
  }
  return (
    "未找到音频输入设备（枚举成功但结果为 0 个）。请检查：" +
    "① 系统麦克风是否已连接并启用；" +
    "② Windows：设置 → 隐私和安全性 → 麦克风，允许桌面应用访问；" +
    listed +
    specify
  );
}

/**
 * 自动选到 monitor（输出回环）源时的提示：该源通常永远静音，建议显式指定麦克风。
 * @param device 选中的 source 名
 * @returns 中文可操作提示
 */
export function monitorSourceFallbackGuidance(device: string): string {
  return (
    `未找到真实输入源，自动选到了 monitor 监听源（${device}）——它是输出回环、通常永远静音。` +
    "请用 --device <麦克风 source 名> 或环境变量 VOICE_DEVICE 显式指定输入设备" +
    "（pactl list short sources 查看，排除 .monitor）。"
  );
}

/** `credentialGuidance` 的入参。 */
export interface CredentialGuidanceInput {
  /** provider 标签（如 `aliyun-qwen` / `MiMo`），写进「未配置 <provider> 凭证」。 */
  providerLabel: string;
  /** 配置文件绝对路径（`voiceConfigPath()`），写进「请在 … 填入」。 */
  configFile: string;
  /** 要填的配置键（如 `asr.credentials.apiKey`）。 */
  configKeys: string[];
  /** 对应环境变量名（如 `DASHSCOPE_API_KEY`）。 */
  envNames: string[];
  /** 附注（如凭证文件读取失败原因），放文案末尾。 */
  fileHint?: string;
}

/**
 * 云凭证缺失时的用户引导（阿里 / MiMo 通用模板）。
 *
 * 关键信息在前 120 字符内：缺什么（provider 凭证）→ 去哪配（配置文件绝对路径 + 键名）。
 * @param input 入参（见 {@link CredentialGuidanceInput}）
 * @returns 中文可操作提示
 */
export function credentialGuidance(input: CredentialGuidanceInput): string {
  const { providerLabel, configFile, configKeys, envNames, fileHint } = input;
  const hint = fileHint ? `（${fileHint}）` : "";
  return (
    `未配置 ${providerLabel} 凭证：请在 ${configFile} 的 ${configKeys.join(" / ")} 填入` +
    `（或设置环境变量 ${envNames.join("、")}）${hint}`
  );
}
