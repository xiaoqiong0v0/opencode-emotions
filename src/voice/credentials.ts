/**
 * 阿里云百炼（DashScope）凭证解析：凭证文件读取、脱敏、以及「环境变量 > 配置 > 默认路径」的优先级合并。
 *
 * 安全约定：**凭证只读，绝不打印/回显**；对外错误文本统一经 `redact()` 抹除密钥。
 * 凭证文件兼容「第 1 行 workspaceid、第 2 行 apikey」的既有格式（空行忽略）。
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** 凭证。 */
export interface Credentials {
  /** 业务空间 ID。 */
  workspace: string;
  /** API Key（绝不对外输出）。 */
  apiKey: string;
}

/** API Key 环境变量（最高优先级）。 */
export const ENV_API_KEY = "DASHSCOPE_API_KEY";
/** 业务空间 ID 环境变量。 */
export const ENV_WORKSPACE_ID = "DASHSCOPE_WORKSPACE_ID";
/** 凭证文件路径环境变量（优先）。 */
export const ENV_CREDENTIALS_PATH = "VOICE_ALIYUN_CREDENTIALS";
/** 凭证文件路径环境变量（旧名，兼容保留）。 */
export const LEGACY_ENV_CREDENTIALS_PATH = "ALIYUN_CREDENTIALS";
/** 默认凭证文件相对当前工作目录的路径段。 */
export const DEFAULT_CREDENTIALS_SEGMENTS = [".tmp", "aliyun"] as const;

/** emotions.jsonc 的 `asr.credentials` 节。 */
export interface CredentialFileConfig {
  /** 凭证文件路径；空 = 用默认路径。 */
  path?: string;
  /** 直接给出的 API Key（低于环境变量、高于凭证文件）。 */
  apiKey?: string;
  /** 直接给出的业务空间 ID。 */
  workspaceId?: string;
}

/** resolveCredentials 的选项。 */
export interface ResolveCredentialsOptions {
  /** 配置中的 `asr.credentials` 节。 */
  config?: CredentialFileConfig;
  /** 环境变量表（默认 process.env，可注入便于测试）。 */
  env?: NodeJS.ProcessEnv;
  /** 命令行显式传入的凭证路径（最高优先）。 */
  cliPath?: string;
  /** 兜底默认路径（缺省 `<cwd>/.tmp/aliyun`）。 */
  defaultPath?: string;
  /** 文件读取器（测试可注入以隔离 IO）。 */
  readFile?: (path: string) => Credentials;
}

/** 取非空去空白字符串，否则 undefined。 */
function trimOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * 默认凭证文件绝对路径。
 * @param cwd 当前工作目录（缺省 process.cwd()）
 * @returns `<cwd>/.tmp/aliyun`
 */
export function defaultCredentialsPath(cwd: string = process.cwd()): string {
  return resolve(cwd, ...DEFAULT_CREDENTIALS_SEGMENTS);
}

/**
 * 读取凭证文件（第 1 行 workspaceid、第 2 行 apikey；空行忽略）。
 * @param path 文件路径
 * @returns 凭证
 * @throws Error 读取失败或行数不足（错误信息不含文件内容）
 */
export function loadCredentials(path: string): Credentials {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "unknown";
    throw new Error(`读取凭证文件失败（${code}）：${path}`);
  }
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length < 2) {
    throw new Error("凭证文件格式错误：需要第 1 行 workspaceid、第 2 行 apikey");
  }
  return { workspace: lines[0], apiKey: lines[1] };
}

/**
 * 把文本中出现的密钥替换为 `***`，供安全打印。
 * @param text 原始文本
 * @param secrets 需要抹除的敏感串
 * @returns 脱敏后的文本
 */
export function redact(text: string, ...secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("***");
  }
  return out;
}

/**
 * 按优先级解析凭证：**环境变量 > 配置 > 凭证文件 > 默认路径**（逐字段合并）。
 *
 * - apiKey：`DASHSCOPE_API_KEY` > 配置 `apiKey` > 凭证文件；workspace 同理（`DASHSCOPE_WORKSPACE_ID`）。
 * - 凭证文件路径：命令行 `cliPath` > 环境变量 `VOICE_ALIYUN_CREDENTIALS`/`ALIYUN_CREDENTIALS` > 配置 `path` > `defaultPath`。
 * - 仅当任一字段最终缺失时才尝试读取文件；文件读取失败不立即抛出，而是作为提示附在最终缺失错误中。
 * @param options 解析选项
 * @returns 解析后的凭证
 * @throws Error 无法解析出 apiKey / workspaceId（信息不含密钥，仅含路径提示）
 */
export function resolveCredentials(options: ResolveCredentialsOptions = {}): Credentials {
  const env = options.env ?? process.env;
  const config = options.config ?? {};
  const directApiKey = trimOrUndefined(env[ENV_API_KEY]) ?? trimOrUndefined(config.apiKey);
  const directWorkspace = trimOrUndefined(env[ENV_WORKSPACE_ID]) ?? trimOrUndefined(config.workspaceId);

  let fileCreds: Credentials | undefined;
  let fileError: string | undefined;
  if (!directApiKey || !directWorkspace) {
    const envPath = trimOrUndefined(env[ENV_CREDENTIALS_PATH]) ?? trimOrUndefined(env[LEGACY_ENV_CREDENTIALS_PATH]);
    const path =
      trimOrUndefined(options.cliPath) ?? envPath ?? trimOrUndefined(config.path) ?? options.defaultPath ?? defaultCredentialsPath();
    const readFile = options.readFile ?? loadCredentials;
    try {
      fileCreds = readFile(path);
    } catch (err) {
      // 读取失败（缺失/格式错）不立即抛出：直填值可能已足够；错误信息仅含路径、不含密钥
      fileError = err instanceof Error ? err.message : String(err);
    }
  }

  const apiKey = directApiKey ?? fileCreds?.apiKey ?? "";
  const workspace = directWorkspace ?? fileCreds?.workspace ?? "";
  const hint = fileError ? `（凭证文件读取失败：${fileError}）` : "";
  if (!apiKey) {
    throw new Error(
      `未找到 API Key：请配置 asr.credentials（apiKey/path）或设置环境变量 ${ENV_API_KEY}${hint}`,
    );
  }
  if (!workspace) {
    throw new Error(
      `未找到 workspaceId：请配置 asr.credentials（workspaceId/path）或设置环境变量 ${ENV_WORKSPACE_ID}${hint}`,
    );
  }
  return { apiKey, workspace };
}
