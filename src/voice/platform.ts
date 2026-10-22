/**
 * 跨平台运行时探测与环境无关的命令查找（供采集、播放、TTS provider 复用）。
 *
 * - `isTermux()`：判定是否运行在 Termux（Android 终端）；
 * - `termuxExecutable()`：按 `$PREFIX` 拼出 Termux 内可执行文件的绝对路径；
 * - `commandExists()`：零依赖实现 `which`（Windows 走 `PATHEXT`，绝对路径直接判定）。
 *
 * 全部为纯函数（env/platform 可注入），便于离线单测。原先内联在 `tts/player.ts`，
 * 因 Termux 采集后端与 TTS provider 也需要同一判定而抽到本模块统一复用。
 */

import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

/** Termux 默认前缀目录（`PREFIX` 缺省时使用）。 */
export const TERMUX_PREFIX = "/data/data/com.termux/files/usr";
/**
 * Windows PowerShell 可执行文件候选（`pwsh` 7 优先；回退 Windows PowerShell 5.1）。
 * SAPI 合成 / SoundPlayer 文件播放 / waveOut 流式播放三处共用（单源，防顺序口径漂移）。
 */
export const POWERSHELL_BINS: readonly string[] = ["pwsh", "powershell"];

/**
 * 判定是否运行在 Termux（Android 终端）：`TERMUX_VERSION` 非空 或 `PREFIX` 含 `com.termux`。
 * @param env 环境变量表
 * @returns Termux true
 */
export function isTermux(env: NodeJS.ProcessEnv = process.env): boolean {
  if (typeof env.TERMUX_VERSION === "string" && env.TERMUX_VERSION.trim().length > 0) return true;
  return typeof env.PREFIX === "string" && env.PREFIX.includes("com.termux");
}

/**
 * 解析 Termux 前缀目录（`PREFIX` 去空白与尾斜杠；缺省用默认前缀）。
 * @param env 环境变量表
 * @returns 前缀目录（不含尾斜杠）
 */
export function termuxPrefix(env: NodeJS.ProcessEnv = process.env): string {
  const raw = typeof env.PREFIX === "string" && env.PREFIX.trim().length > 0 ? env.PREFIX.trim() : TERMUX_PREFIX;
  return raw.replace(/\/+$/, "");
}

/**
 * 拼接 Termux 内可执行文件的绝对路径（用正斜杠，跨宿主一致）。
 * @param env 环境变量表（读取 `PREFIX`）
 * @param name 命令名（如 `play-audio` / `termux-tts-speak`）
 * @returns `${PREFIX}/bin/<name>`
 */
export function termuxExecutable(env: NodeJS.ProcessEnv, name: string): string {
  return `${termuxPrefix(env)}/bin/${name}`;
}

/**
 * 判断是否为可执行文件（存在、是普通文件、具可执行位）。
 *
 * 兼容 Windows「应用执行别名」（如 `WindowsApps\pwsh.exe`）：这类文件 `statSync` 会抛 `EACCES`，
 * 但 `accessSync(X_OK)` 可用；`stat` 失败时回退按可访问性判定（目录通常可 stat，不受影响）。
 * @param path 文件路径
 * @returns 可执行 true
 */
export function isExecutableFile(path: string): boolean {
  try {
    if (statSync(path).isFile()) {
      accessSync(path, constants.X_OK);
      return true;
    }
    return false;
  } catch {
    try {
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * 判断命令是否可在 PATH 上找到（零依赖实现 `which`）。
 * @param bin 命令名（含路径分隔符或为绝对路径时按路径判定）
 * @param env 环境变量表（读取 PATH / PATHEXT）
 * @param platform 目标平台（Windows 需尝试 `PATHEXT` 扩展名）
 * @returns 可用 true
 */
export function commandExists(
  bin: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (isAbsolute(bin) || bin.includes("/") || bin.includes("\\")) return isExecutableFile(bin);
  const pathVar = env.PATH ?? env.Path ?? env.path ?? "";
  const dirs = pathVar.split(delimiter).filter((dir) => dir.length > 0);
  const exts = platform === "win32" ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      if (ext.length > 0 && isExecutableFile(join(dir, bin + ext))) return true;
    }
    if (isExecutableFile(join(dir, bin))) return true;
  }
  return false;
}
