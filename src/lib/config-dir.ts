/**
 * 显式解析 opencode 配置目录（用户级配置根，零依赖）。
 *
 * 解析顺序：**显式注入 > 环境变量（调用方指定名） > os.homedir()/.config/opencode**。
 * **严禁**按插件文件位置（import.meta.url）上溯或 `process.cwd()` 推算根目录——
 * 本地插件可能被其它项目复用，且 opencode 加载插件时 cwd 不定；配置目录只与用户主目录有关。
 * 默认目录按 homedir() 结果缓存；环境变量每次现读，便于运行期切换。
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** 配置目录相对家目录的路径段（Windows 同样使用该路径）。 */
const CONFIG_DIR_SEGMENTS = [".config", "opencode"] as const;

/** 默认配置目录缓存；null 表示尚未解析。 */
let cachedDefaultDir: string | null = null;

/** resolveConfigDir 的解析选项。 */
export interface ResolveConfigDirOptions {
  /** 显式注入的目录；非空字符串时最优先（供测试隔离）。 */
  injected?: string | null;
  /** 覆盖用环境变量名（单个）；其值为非空字符串时优先于默认目录。 */
  envName?: string | null;
  /** 覆盖用环境变量名（按优先级顺序取第一个非空值）；优先于 `envName`，用于新旧名兼容。 */
  envNames?: readonly string[] | null;
}

/**
 * 解析 opencode 配置目录（显式注入 > 环境变量 > 默认配置目录）。
 * 环境变量可给一组（`envNames`，按顺序取第一个非空），也可给单个（`envName`）。
 * @param options 解析选项
 * @returns 配置目录绝对路径（默认即 `<homedir>/.config/opencode`）
 */
export function resolveConfigDir(options: ResolveConfigDirOptions = {}): string {
  const { injected = null, envName = null, envNames = null } = options;
  if (typeof injected === "string" && injected.length > 0) return injected;
  const names = envNames ?? (typeof envName === "string" && envName.length > 0 ? [envName] : []);
  for (const name of names) {
    const fromEnv = process.env[name];
    if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  }
  if (cachedDefaultDir === null) cachedDefaultDir = join(homedir(), ...CONFIG_DIR_SEGMENTS);
  return cachedDefaultDir;
}
