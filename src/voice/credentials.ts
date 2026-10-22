/**
 * 阿里云百炼（DashScope）/ MiMo 凭证解析：凭证文件读取、脱敏、以及「环境变量 > 配置 > 默认路径」的优先级合并。
 *
 * 安全约定：**凭证只读，绝不打印/回显**；对外错误文本统一经 `redact()` 抹除密钥。
 * 凭证文件兼容「第 1 行 workspaceid、第 2 行 apikey」的既有格式（空行忽略）。
 * 缺失时的报错是**面向用户的配置引导**（缺什么、去哪配、怎么配）：带
 * `voiceConfigPath()` 真实绝对路径 + 配置键 + 环境变量名（文案模板见 `guidance.ts`）。
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { voiceConfigPath } from "./config.js";
import { credentialGuidance } from "./guidance.js";

/** 凭证。 */
export interface Credentials {
  /** 业务空间 ID。 */
  workspace: string;
  /** API Key（绝不对外输出）。 */
  apiKey: string;
}

/** API Key 环境变量（最高优先级）。 */
export const ENV_API_KEY = "DASHSCOPE_API_KEY";
/** MiMo API Key 环境变量（仅 provider=mimo；最高优先级）。 */
export const ENV_MIMO_API_KEY = "MIMO_API_KEY";
/** 业务空间 ID 环境变量。 */
export const ENV_WORKSPACE_ID = "DASHSCOPE_WORKSPACE_ID";
/** 凭证文件路径环境变量（优先）。 */
export const ENV_CREDENTIALS_PATH = "VOICE_ALIYUN_CREDENTIALS";
/** 凭证文件路径环境变量（旧名，兼容保留）。 */
export const LEGACY_ENV_CREDENTIALS_PATH = "ALIYUN_CREDENTIALS";
/** 默认凭证文件相对当前工作目录的路径段。 */
export const DEFAULT_CREDENTIALS_SEGMENTS = [".tmp", "aliyun"] as const;

/**
 * 计算错误引导里展示的配置文件路径：显式传入优先，缺省用 `voiceConfigPath()`（失败降级为文件名）。
 * @param explicit 调用方显式传入的路径（可空）
 * @returns 配置文件绝对路径（或降级占位）
 */
function resolveConfigFile(explicit?: string): string {
  const trimmed = explicit?.trim();
  if (trimmed) return trimmed;
  try {
    return voiceConfigPath();
  } catch {
    return "emotions.jsonc";
  }
}

/** emotions.jsonc 的凭证节（`asr.credentials` 或 `tts.credentials`，二者形状相同、各自独立）。 */
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
  /** 传入的凭证配置（`asr.credentials` 或 `tts.credentials` 之一；两侧各自调用、互不影响）。 */
  config?: CredentialFileConfig;
  /** 环境变量表（默认 process.env，可注入便于测试）。 */
  env?: NodeJS.ProcessEnv;
  /** 命令行显式传入的凭证路径（最高优先）。 */
  cliPath?: string;
  /** 兜底默认路径（缺省 `<cwd>/.tmp/aliyun`）。 */
  defaultPath?: string;
  /** 文件读取器（测试可注入以隔离 IO）。 */
  readFile?: (path: string) => Credentials;
  /** 错误引导里的 provider 标签（如 `aliyun-qwen`；缺省「阿里云」）。 */
  providerLabel?: string;
  /** 配置节名（`asr` / `tts`），决定错误引导里展示的配置键前缀（缺省 `asr`）。 */
  section?: "asr" | "tts";
  /** 错误引导里的配置文件路径（缺省 `voiceConfigPath()`）。 */
  configFile?: string;
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
  const providerLabel = options.providerLabel ?? "阿里云";
  const section = options.section ?? "asr";
  const configFile = resolveConfigFile(options.configFile);
  const hint = fileError ? `凭证文件读取失败：${fileError}` : undefined;
  if (!apiKey) {
    throw new Error(
      credentialGuidance({
        providerLabel,
        configFile,
        configKeys: [`${section}.credentials.apiKey`],
        envNames: [ENV_API_KEY],
        fileHint: hint,
      }),
    );
  }
  if (!workspace) {
    throw new Error(
      credentialGuidance({
        providerLabel,
        configFile,
        configKeys: [`${section}.credentials.workspaceId`],
        envNames: [ENV_WORKSPACE_ID],
        fileHint: hint,
      }),
    );
  }
  return { apiKey, workspace };
}

/** MiMo 凭证配置路径（TTS 侧默认提示文案；ASR 侧用 {@link ASR_MIMO_CREDENTIALS_CONFIG_PATH}）。 */
export const DEFAULT_MIMO_CREDENTIALS_CONFIG_PATH = "tts.mimoCredentials.apiKey";
/** MiMo 凭证配置路径（ASR 侧提示文案，与 TTS 侧相互独立）。 */
export const ASR_MIMO_CREDENTIALS_CONFIG_PATH = "asr.mimoCredentials.apiKey";

/**
 * 构造「MiMo API Key 缺失」的引导错误。
 *
 * `resolveMimoApiKey` 与 `MiMoProvider.speak`（speak 已解析后的兜底）**共用本单源文案**，
 * 避免两处模板漂移。
 * @param configKey 配置键路径（缺省 TTS 侧 `tts.mimoCredentials.apiKey`）
 * @param configFile 配置文件路径（缺省 `voiceConfigPath()`）
 * @returns 待抛出的 Error（信息不含密钥）
 */
export function mimoKeyMissingError(
  configKey: string = DEFAULT_MIMO_CREDENTIALS_CONFIG_PATH,
  configFile?: string,
): Error {
  return new Error(
    credentialGuidance({
      providerLabel: "MiMo",
      configFile: resolveConfigFile(configFile),
      configKeys: [configKey],
      envNames: [ENV_MIMO_API_KEY],
    }),
  );
}

/** resolveMimoApiKey 的选项。 */
export interface ResolveMimoApiKeyOptions {
  /** 传入的 MiMo 凭证配置（`asr.mimoCredentials` 或 `tts.mimoCredentials` 之一；只需 apiKey，无 workspace）。 */
  config?: { apiKey?: string };
  /** 环境变量表（默认 process.env，可注入便于测试）。 */
  env?: NodeJS.ProcessEnv;
  /** 错误提示里的配置**键**路径（缺省 `tts.mimoCredentials.apiKey`；ASR 调用方传 `asr.mimoCredentials.apiKey`）。 */
  configPath?: string;
  /** 错误提示里的配置**文件**路径（缺省 `voiceConfigPath()`）。 */
  configFile?: string;
}

/**
 * 解析 MiMo API Key：**环境变量 > 配置**（键路径由 `configPath` 指定），无 workspace 要求。
 * ASR/TTS 各传自己那组 `mimoCredentials`（两组相互独立、互不回退）；与阿里云 `resolveCredentials` 相互独立。
 * @param options 解析选项
 * @returns MiMo API Key
 * @throws Error 两级都缺失时抛错（信息不含密钥，带 `voiceConfigPath()` 真实路径 + 配置键 + 环境变量引导）
 */
export function resolveMimoApiKey(options: ResolveMimoApiKeyOptions = {}): string {
  const env = options.env ?? process.env;
  const apiKey = trimOrUndefined(env[ENV_MIMO_API_KEY]) ?? trimOrUndefined(options.config?.apiKey);
  if (!apiKey) {
    const configKey = options.configPath ?? DEFAULT_MIMO_CREDENTIALS_CONFIG_PATH;
    throw mimoKeyMissingError(configKey, options.configFile);
  }
  return apiKey;
}
