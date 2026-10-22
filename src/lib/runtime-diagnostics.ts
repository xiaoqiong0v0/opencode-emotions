/**
 * 语音运行时子进程的**路径解析**与 **stderr 摘要**（纯逻辑，可注入依赖，便于单测）。
 *
 * 为什么单独成模块：这两件事都是「TUI 插件 → 子进程」边界的诊断口径，`src/tui.tsx` 是
 * Babel 预编译产物（依赖宿主重写 import），无法在 node 里 import 做行为级单测；把逻辑
 * 抽到这里后，`npm test` 直接测 `dist/lib/runtime-diagnostics.js`。
 *
 * 根因背景（2026-10-22）：旧实现把运行时脚本按 **cwd 相对**拼（`resolve(process.cwd(),
 * "dist","runtime","voice-runtime.js")`）。用户在家目录启动 opencode 时 cwd 下没有 `dist/`，
 * spawn 出的 node 立即 `Cannot find module` 退出（code=1），且 toast 只显 stderr 末行
 * （`Node.js v24.16.0`）——既起不来又看不出为什么。
 * 现改为：**以插件产物自身位置为主锚点**（`import.meta.url` → `dist/tui.js` 所在目录 →
 * 同级 `runtime/voice-runtime.js`，镜像布局 `.opencode/plugin/` 同理），cwd 拼法降级为兜底。
 */

import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 运行时脚本文件名（单源）。 */
const RUNTIME_SCRIPT_NAME = "voice-runtime.js";
/** 相对**插件产物自身目录**的运行时脚本路径段（`dist/` 与镜像后的 `.opencode/plugin/` 同构）。 */
export const RUNTIME_RELATIVE_TO_SELF: readonly string[] = ["runtime", RUNTIME_SCRIPT_NAME];
/** 相对 **cwd** 的运行时脚本路径段（仅兜底：cwd 不定正是历史根因）。 */
export const RUNTIME_RELATIVE_TO_CWD: readonly string[] = ["dist", "runtime", RUNTIME_SCRIPT_NAME];
/** stderr 摘要的最大长度（toast 用；超出截断加省略号）。 */
export const STDERR_SUMMARY_MAX = 160;

/** 脚本解析来源：`env`=环境变量覆盖、`self`=插件产物自身位置、`cwd`=工作目录兜底、`none`=候选都不存在。 */
export type RuntimeScriptSource = "env" | "self" | "cwd" | "none";

/** `resolveRuntimeScript` 的入参（全部可注入，保证纯逻辑可单测）。 */
export interface ResolveRuntimeScriptInput {
  /** 环境变量 `VOICE_RUNTIME_SCRIPT` 的原始值（空串/空白视为未设置）。 */
  envScript?: string | null;
  /** 插件产物自身目录（`selfDirFromModuleUrl` 的结果；不可用时传 `null`）。 */
  selfDir?: string | null;
  /** 当前工作目录（仅用于兜底候选与环境变量的相对归一）。 */
  cwd: string;
  /** 存在性检查（默认 `fs.existsSync`；测试注入以覆盖各分支）。 */
  exists?: (path: string) => boolean;
}

/** `resolveRuntimeScript` 的结果。 */
export interface RuntimeScriptResolution {
  /** 最终采用的脚本路径（绝对路径，`source="none"` 时为最可疑的首选候选）。 */
  script: string;
  /** 采用来源。 */
  source: RuntimeScriptSource;
  /** 采用路径是否存在（`env` 覆盖不把关存在性，故可能为 `false`）。 */
  exists: boolean;
  /** 按解析顺序列出的候选绝对路径（供诊断日志一眼看清问题）。 */
  candidates: string[];
}

/**
 * 由模块 URL 字符串推导**插件产物所在目录**。
 *
 * 只接受可靠形态：`file:` URL（Node/Bun 常规）或已是绝对路径的字符串；
 * 虚拟命名空间（如 `plugin:`/`bun:`）一律返回 `null`，交由调用方走兜底。
 * @param moduleUrl `import.meta.url` 的原始值（可空）
 * @returns 产物目录绝对路径；不可靠或缺失时 `null`
 */
export function selfDirFromModuleUrl(moduleUrl?: string | null): string | null {
  const raw = typeof moduleUrl === "string" ? moduleUrl.trim() : "";
  if (!raw) return null;
  try {
    if (/^file:/i.test(raw)) return dirname(fileURLToPath(raw));
    if (isAbsolute(raw)) return dirname(raw);
    return null;
  } catch {
    // 非法 URL（fileURLToPath 会抛 ERR_INVALID_URL / 非 file 协议）⇒ 视为不可用
    return null;
  }
}

/**
 * 解析运行时脚本路径：**环境变量 > 插件产物自身位置 > cwd 兜底**。
 *
 * 规则：
 * - `envScript` 有值即**优先采用**（相对值按 `cwd` 归一为绝对路径），但不把关存在性——尊重显式覆盖；
 * - 自身锚点解析出的路径存在 ⇒ 采用 `self`（修根因的主路径，不再依赖 cwd）；
 * - 自身锚点不可用或不存在 ⇒ 尝试 cwd 拼法（`cwd`，仅兜底，调用方需记录其被使用）；
 * - 都不存在 ⇒ `source="none"`，返回首选候选（自身锚点优先，否则 cwd 拼法）供调用方带绝对路径报错。
 * @param input 入参见 {@link ResolveRuntimeScriptInput}
 * @returns 解析结果（含来源与全部候选，便于日志）
 */
export function resolveRuntimeScript(input: ResolveRuntimeScriptInput): RuntimeScriptResolution {
  const exists = input.exists ?? existsSync;
  const cwd = input.cwd;
  const envRaw = typeof input.envScript === "string" ? input.envScript.trim() : "";
  const selfScript = input.selfDir ? join(input.selfDir, ...RUNTIME_RELATIVE_TO_SELF) : null;
  const cwdScript = resolve(cwd, ...RUNTIME_RELATIVE_TO_CWD);

  const candidates: string[] = [];
  if (envRaw) candidates.push(resolve(cwd, envRaw));
  if (selfScript) candidates.push(selfScript);
  candidates.push(cwdScript);

  if (envRaw) {
    const script = resolve(cwd, envRaw);
    return { script, source: "env", exists: exists(script), candidates };
  }
  if (selfScript && exists(selfScript)) {
    return { script: selfScript, source: "self", exists: true, candidates };
  }
  if (exists(cwdScript)) {
    return { script: cwdScript, source: "cwd", exists: true, candidates };
  }
  return { script: selfScript ?? cwdScript, source: "none", exists: false, candidates };
}

/**
 * 从子进程 stderr 里挑**最有信息量的一行**用于 toast。
 *
 * Node 崩溃输出的末行是版本横幅（`Node.js v24.16.0`），旧实现只取末行 ⇒ 用户只看到版本号。
 * 现口径：优先含错误标记的行（`Cannot find module` 等）→ 其次首个非噪声行 → 最后退化首行；
 * 全量 stderr 由调用方留存于日志。
 * @param stderr stderr 缓冲文本（可含多行）
 * @param maxLength 摘要最大长度（默认 {@link STDERR_SUMMARY_MAX}）
 * @returns 单行摘要；空输入返回空串
 */
export function pickStderrSummary(stderr: string, maxLength: number = STDERR_SUMMARY_MAX): string {
  const lines = toLines(stderr);
  if (lines.length === 0) return "";
  const errorLine = lines.find((line) => STDERR_ERROR_MARKERS.some((marker) => line.toLowerCase().includes(marker)));
  const chosen = errorLine ?? lines.find((line) => !isNoiseLine(line)) ?? lines[0];
  return chosen.length > maxLength ? `${chosen.slice(0, maxLength)}…` : chosen;
}

/** stderr 里优先采信的错误标记（小写包含匹配）。 */
const STDERR_ERROR_MARKERS: readonly string[] = [
  "cannot find module",
  "cannot find package",
  "cannot use import statement",
  "unknown file extension",
  "module_not_found",
  "err_",
  "enoent",
  "eacces",
  "eperm",
  "permission denied",
  "no such file",
  "is not defined",
  "syntaxerror",
  "referenceerror",
  "typeerror",
];

/**
 * 切分为去空白的非空行。
 * @param text 原始文本
 * @returns 行数组（保序）
 */
function toLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * 判断是否为无信息量的框架行（Node 内部路径、版本横幅、`^`、`at ...` 栈帧、缩进的属性行等）。
 * @param line 已 trim 的行
 * @returns 是否噪声
 */
function isNoiseLine(line: string): boolean {
  if (/^node:/i.test(line)) return true;
  if (/^node\.js v/i.test(line)) return true;
  if (/^\^+$/.test(line)) return true;
  if (/^at\s/i.test(line)) return true;
  if (/^require stack:/i.test(line)) return true;
  if (/^throw\b/i.test(line)) return true;
  // Node 错误对象展开的属性行（`code: 'MODULE_NOT_FOUND',` 等）：已被 trim，形态是 key: value
  if (/^(code|errno|syscall|path|url|stack)\s*:/i.test(line)) return true;
  return false;
}
