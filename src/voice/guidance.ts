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
      return "Linux：apt install ffmpeg（或 dnf/pacman 安装 ffmpeg）";
  }
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
 * @returns 中文可操作提示
 */
export function noAudioDeviceGuidance(): string {
  return (
    "未找到音频输入设备（枚举成功但结果为 0 个）。请检查：" +
    "① 系统麦克风是否已连接并启用；" +
    "② Windows：设置 → 隐私和安全性 → 麦克风，允许桌面应用访问；" +
    "③ 用 node dist/runtime/voice-runtime.js --list 查看设备列表；" +
    '④ 用 --device "<设备名>" 或环境变量 VOICE_DEVICE 指定设备。'
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
