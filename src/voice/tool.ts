/**
 * `emotions_cli` 工具定义（由 **server 入口** `src/emotions.ts` 的 `tool` 钩子注册）。
 *
 * 背景：opencode 对**一个 npm 包只解析一个 server 入口**（`exports["./server"]` / `main`）。
 * 原先该工具由**独立的第二个 server 插件** `src/tts-tool.ts` 注册，npm 安装时不会被加载
 * ⇒ 把工具定义抽到这个 lib，与情绪命令共用同一个 server 入口，使 npm 安装后命令与工具**都生效**。
 * 命名对齐包名 `opencode-emotions`（工具 `emotions_cli`、CLI `emotions-cli`），避免与其它插件重名。
 *
 * 形态（照本机 `stats-command.js` 模式）：只注册一个工具，`args` 是**完整 CLI 参数串**。
 *
 * **不经 shell（2026-10-22 审计修复）**：旧实现用 `exec("node <cli> <args>")`——参数经 cmd/sh 解析，
 * `&`/`|`/`>` 会被当命令分隔符、`%USERNAME%`/`$HOME` 被展开、引号被吞，且 Windows 命令行有 8191 上限
 * （9000 字正文必失败）。现改为：① 自建**无 shell 语义**的分词（只处理引号/空白，不做变量展开与通配）；
 * ② `spawn(bin, [cliPath, ...args])` 且 `shell:false`；③ `speak --text <长文本>` 改写为
 * `--text-stdin`，正文经 **stdin** 传给 CLI（彻底绕开 argv 长度上限）。错误带退出码与 stderr 摘要；
 * 超时/宿主取消（`ToolContext.abort`）都会 kill 子进程。
 *
 * 本地化：工具描述在**插件加载时**按 `emotions.jsonc` 的 `toolLanguage` 生成（词表见 `src/lib/i18n.ts`）。
 * 非阻塞：CLI 的 `speak` 走 `--background`（分离子进程播放），`execute` 立即拿到确认并返回，
 * 不阻塞模型回合（并发/进程模型见 docs/ASYNC.md）。
 * **F10 联动（2026-10-22）**：该会话自动朗读开启时 `execute` **拦截 `speak`**（不执行 CLI、返回 i18n 提示，
 * 防与自动朗读叠播）；判定纯函数 {@link shouldInterceptSpeakForAutoRead}，状态经 `readAutoTts(sessionID)`
 * 读 TUI F10 写的同一份每会话状态文件。
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { tool } from "@opencode-ai/plugin";
import type { ToolContext, ToolDefinition } from "@opencode-ai/plugin";
import type { Logger } from "@xiaoqiong0v0/opencode-plugin-logger";

import { DEFAULT_LANGUAGE, getPhrases, type Phrases } from "../lib/i18n.js";
import { loadVoiceConfig } from "./config.js";
import { readAutoTts } from "./auto-tts.js";

/** 工具名（CLI 风格；与包名对齐）。 */
const TOOL_NAME = "emotions_cli";
/** CLI 产物相对其所在目录的路径（非插件产物一律置于子目录，避免被当插件自动加载）。 */
const CLI_RELATIVE_PATH = join("cli", "emotions-cli.js");
/** CLI 脚本路径覆盖环境变量（新名）。 */
const ENV_CLI_SCRIPT = "EMOTIONS_CLI_SCRIPT";
/** CLI 脚本路径覆盖环境变量（旧名，向后兼容）。 */
const LEGACY_ENV_CLI_SCRIPT = "VOICE_CLI_SCRIPT";
/** 工具超时环境变量（毫秒；非法/缺失用默认值，供测试压缩等待时间）。 */
const ENV_TOOL_TIMEOUT_MS = "EMOTIONS_CLI_TIMEOUT_MS";
/** 默认工具超时（毫秒）：`speak --background` 秒回、`devices` 枚举 ffmpeg 也不应超过此值。 */
export const DEFAULT_TOOL_TIMEOUT_MS = 15_000;
/** stdout/stderr 各自的收集上限（字符）：超出部分丢弃并标记截断，防一次失败回灌巨量上下文。 */
const MAX_OUTPUT_CHARS = 1024 * 1024;
/** 错误摘要里 stderr/stdout 的预览长度。 */
const ERROR_PREVIEW_CHARS = 300;
/** 标题里参数串的预览长度。 */
const TITLE_PREVIEW_CHARS = 80;
/** 正文改走 stdin 的 CLI 选项（`speak --text-stdin`，由 `src/voice/cli.ts` 解析）。 */
export const TEXT_STDIN_FLAG = "--text-stdin";

/** 单次子进程执行结果。 */
interface SpawnOutcome {
  /** 退出码（被信号终止时为 null）。 */
  code: number | null;
  /** 终止信号（正常退出为 null）。 */
  signal: NodeJS.Signals | null;
  /** stdout（已按上限截断）。 */
  stdout: string;
  /** stderr（已按上限截断）。 */
  stderr: string;
  /** 是否因超时被 kill。 */
  timedOut: boolean;
  /** 是否因宿主取消（AbortSignal）被 kill。 */
  aborted: boolean;
  /** spawn 本身失败（如 ENOENT）。 */
  error?: NodeJS.ErrnoException;
  /** stdout/stderr 是否有截断。 */
  truncated: boolean;
}

/** 分词后的一次 CLI 调用：argv 与（可选）stdin 正文。 */
export interface CliInvocation {
  /** 传给 CLI 的参数数组（不含 node 与脚本路径）。 */
  args: string[];
  /** 走 stdin 的正文（仅 `speak --text <text>` 被改写时有值）。 */
  stdinText?: string;
}

/**
 * 解析 `emotions-cli.js` 的绝对路径：环境变量覆盖 > `<cwd>/dist/cli/` > 本模块**同级**的 `cli/`。
 *
 * CLI 产物位于 `dist/cli/`（子目录，非插件），镜像后落在 `.opencode/plugin/cli/`；该顶层目录的每个
 * `.js` 才会被 opencode 当插件自动 import，子目录不被扫描——故 CLI 只从构建产物 `dist/` 取用。
 * 本模块位于 `dist/voice/tool.js`（镜像后 `.opencode/plugin/voice/tool.js`），其父目录即 `dist/`
 * （镜像后 `.opencode/plugin/`），故同级 `cli/` 与 `cwd/dist/cli/` 两种口径都能命中。
 * @returns CLI 脚本路径（候选都不存在时返回首选，便于错误信息定位）
 */
export function resolveCliPath(): string {
  const override = process.env[ENV_CLI_SCRIPT] ?? process.env[LEGACY_ENV_CLI_SCRIPT];
  if (override && existsSync(override)) return override;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(process.cwd(), "dist", CLI_RELATIVE_PATH),
    // 本模块位于 `<根>/dist/voice/`（镜像后 `.opencode/plugin/voice/`），CLI 在其父目录的 `cli/` 下
    join(here, "..", CLI_RELATIVE_PATH),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

/**
 * 安全读取工具文案语言（`toolLanguage`）的文案表（配置读取失败时回退默认语言，绝不影响插件加载）。
 * @returns 文案表
 */
function safePhrases(): Phrases {
  try {
    return getPhrases(loadVoiceConfig().toolLanguage);
  } catch {
    return getPhrases(DEFAULT_LANGUAGE);
  }
}

/**
 * **F10 开启时的模型 `speak` 拦截判定**（2026-10-22 用户拍板，纯函数便于单测）：
 * 参数串以 `speak` 开头（词边界 `\b`，`help`/`devices`/`status` 等不拦；含 `--follow`/`--background` 变体）
 * **且**该会话自动朗读为开 → 拦截（不执行 CLI，避免模型语音与自动朗读叠播）。
 * @param extra 归一化后的 CLI 参数串（trim；空串已被上游补成 `help`）
 * @param autoReadEnabled 该会话 `readAutoTts(sessionID)` 的结果
 * @returns 是否拦截
 */
export function shouldInterceptSpeakForAutoRead(extra: string, autoReadEnabled: boolean): boolean {
  return /^speak\b/.test(extra) && autoReadEnabled;
}

/**
 * 判断 token 是否「像选项」（与 CLI 解析器 `isFlagLike` 同口径：`--x` 或 `-字母`）。
 * 负数字面量（`-4`）不算选项，可作为取值。
 * @param token 待判定 token
 * @returns 像选项 true
 */
function looksLikeFlag(token: string): boolean {
  return token.startsWith("--") || /^-[A-Za-z]/.test(token);
}

/**
 * 把模型给的参数串切成 argv 数组（**无 shell 语义**）。
 *
 * 只处理：空白分隔、单/双引号包裹、`\"`/`\\` 与反斜杠转义空白/引号。**不做**变量展开、通配、
 * 管道/重定向解释——`&`/`%USERNAME%`/`$HOME` 等原样成为 argv 字符（这正是修复注入/文本损坏的关键）。
 * 反斜杠仅在「后接空白/引号/反斜杠」时当转义，避免破坏 Windows 路径（`C:\a\b`）。
 * @param input 参数串
 * @returns argv token 数组
 * @throws Error 引号未闭合（调用方转成可见失败信息）
 */
export function tokenizeArgs(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let hasToken = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
        hasToken = true;
        continue;
      }
      if (quote === '"' && ch === "\\" && (input[i + 1] === '"' || input[i + 1] === "\\")) {
        current += input[i + 1];
        i += 1;
        hasToken = true;
        continue;
      }
      current += ch;
      hasToken = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasToken) {
        tokens.push(current);
        current = "";
        hasToken = false;
      }
      continue;
    }
    if (ch === "\\") {
      const next = input[i + 1];
      if (next !== undefined && /[\s"'\\]/.test(next)) {
        current += next;
        i += 1;
        hasToken = true;
        continue;
      }
    }
    current += ch;
    hasToken = true;
  }
  if (quote !== null) throw new Error("参数串引号未闭合");
  if (hasToken) tokens.push(current);
  return tokens;
}

/**
 * 把 `speak --text <正文>` 改写为 `speak --text-stdin`，正文改走 stdin（长度安全、无 argv 上限）。
 *
 * - 非 `speak` / 含 `--follow`（正文本来就按行走 stdin）/ 已带 `--text-stdin` / 用 `--text-file` 时原样返回；
 * - 多个 `--text` 取最后一个（与 CLI「后写覆盖」一致），其余文本选项移除，避免两个正文来源并存。
 * @param tokens 分词后的 argv
 * @returns 实际传给 CLI 的 argv + 可选 stdin 正文
 */
export function prepareInvocation(tokens: string[]): CliInvocation {
  if (tokens[0] !== "speak") return { args: tokens };
  if (tokens.includes("--follow") || tokens.includes(TEXT_STDIN_FLAG)) return { args: tokens };
  if (tokens.some((token) => token === "--text-file" || token.startsWith("--text-file="))) {
    return { args: tokens };
  }
  let lastText: string | undefined;
  const args: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--text" || token === "-t") {
      const value = tokens[i + 1];
      if (value !== undefined && !looksLikeFlag(value)) {
        lastText = value;
        i += 1;
      } else {
        args.push(token);
      }
      continue;
    }
    if (token.startsWith("--text=")) {
      lastText = token.slice("--text=".length);
      continue;
    }
    if (token.startsWith("-t=")) {
      lastText = token.slice("-t=".length);
      continue;
    }
    args.push(token);
  }
  if (lastText === undefined) return { args: tokens };
  // 插在 `speak` 之后：参数顺序对 CLI 解析无影响，保持可读性
  args.splice(1, 0, TEXT_STDIN_FLAG);
  return { args, stdinText: lastText };
}

/**
 * 读取工具超时（环境变量可注入，便于单测把等待压到毫秒级）。
 * @returns 超时毫秒（非法/缺失 → {@link DEFAULT_TOOL_TIMEOUT_MS}）
 */
function resolveTimeoutMs(): number {
  const raw = process.env[ENV_TOOL_TIMEOUT_MS];
  if (typeof raw !== "string" || raw.trim().length === 0) return DEFAULT_TOOL_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : DEFAULT_TOOL_TIMEOUT_MS;
}

/**
 * 截断预览（错误摘要/标题用）。
 * @param text 原文
 * @param max 最大字符数
 * @returns 预览
 */
function preview(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 执行 CLI 子进程（**不经 shell**）：`spawn(bin, argv, { shell:false })`，正文经 stdin 写入。
 *
 * 错误/超时/取消都会 settle（不会悬挂）；stdout/stderr 各自有上限，超出标记截断。
 * 超时与 `AbortSignal` 都会 kill 子进程。
 * @param bin 可执行文件
 * @param argv 完整参数（含脚本路径）
 * @param stdinText 写入 stdin 的正文（undefined = 只关闭 stdin）
 * @param abortSignal 宿主取消信号（`ToolContext.abort`）
 * @returns 执行结果
 */
function runCli(
  bin: string,
  argv: string[],
  stdinText: string | undefined,
  abortSignal: AbortSignal | undefined,
): Promise<SpawnOutcome> {
  const timeoutMs = resolveTimeoutMs();
  return new Promise<SpawnOutcome>((resolveOutcome) => {
    let settled = false;
    let timedOut = false;
    let aborted = abortSignal?.aborted === true;
    let truncated = false;
    let stdout = "";
    let stderr = "";
    let child: ChildProcess;
    const append = (current: string, chunk: string): string => {
      if (current.length >= MAX_OUTPUT_CHARS) {
        truncated = true;
        return current;
      }
      const next = current + chunk;
      if (next.length > MAX_OUTPUT_CHARS) {
        truncated = true;
        return next.slice(0, MAX_OUTPUT_CHARS);
      }
      return next;
    };
    const finish = (outcome: SpawnOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveOutcome(outcome);
    };
    let timer: ReturnType<typeof setTimeout>;
    try {
      child = spawn(bin, argv, {
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        signal: abortSignal,
      });
    } catch (err) {
      // spawn 同步失败（极少见；异步失败走 error 事件）
      resolveOutcome({
        code: null,
        signal: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        aborted: false,
        error: err as NodeJS.ErrnoException,
        truncated: false,
      });
      return;
    }
    timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        // 子进程已退出/无法 kill：交给 close/error 收尾
      }
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr = append(stderr, chunk);
    });
    // stdin EPIPE（子进程提前退出）不得变成未处理 error 炸宿主
    child.stdin?.on("error", () => undefined);
    if (child.stdin) {
      if (stdinText !== undefined) child.stdin.write(stdinText);
      child.stdin.end();
    }
    child.once("error", (err: NodeJS.ErrnoException) => {
      aborted = aborted || err.name === "AbortError";
      finish({
        code: null,
        signal: null,
        stdout,
        stderr,
        timedOut,
        aborted,
        error: err,
        truncated,
      });
    });
    child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
      aborted = aborted || abortSignal?.aborted === true;
      finish({ code, signal, stdout, stderr, timedOut, aborted, truncated });
    });
  });
}

/**
 * 把一次失败结果格式化为可读摘要（带退出码/信号/超时/取消 + stderr 预览）。
 * @param label 尝试的可执行文件名
 * @param outcome 执行结果
 * @returns 失败摘要
 */
function describeFailure(label: string, outcome: SpawnOutcome): string {
  let reason: string;
  if (outcome.aborted) reason = "已取消（宿主中断）";
  else if (outcome.timedOut) reason = `超时（${resolveTimeoutMs()}ms，已 kill 子进程）`;
  else if (outcome.error) reason = `${outcome.error.code ?? "spawn error"}: ${outcome.error.message}`;
  else reason = `exit=${outcome.code ?? "-"}${outcome.signal ? ` signal=${outcome.signal}` : ""}`;
  const detail = `${outcome.stderr.trim() || outcome.stdout.trim()}`;
  const tail = detail.length > 0 ? `\n${preview(detail, ERROR_PREVIEW_CHARS)}` : "";
  const cut = outcome.truncated ? "\n(output truncated)" : "";
  return `${label}: ${reason}${tail}${cut}`;
}

/**
 * 构建 `emotions_cli` 工具（加载时本地化描述，`execute` 透传参数串给 CLI）。
 * @param log 插件日志器（与 server 入口共用同一实例/命名空间）
 * @returns `Hooks.tool` 形态的工具表
 */
export function createVoiceTool(log: Logger): Record<string, ToolDefinition> {
  const phrases = safePhrases();
  const cliPath = resolveCliPath();

  return {
    [TOOL_NAME]: tool({
      description: phrases.tool.description,
      args: {
        args: tool.schema.string().optional().describe(phrases.tool.args),
      },
      async execute(a, context: ToolContext) {
        let extra = (a.args ?? "").trim();
        if (extra.length === 0) extra = "help";
        // **F10 开启时拦截模型 speak**（2026-10-22 用户拍板）：该会话自动朗读开着 → **不 exec CLI**
        // （防模型语音与自动朗读叠播），直接返回 i18n 提示。server 进程读的是与 TUI F10 同一份
        // **每会话状态文件**（`readAutoTts`，读失败/缺文件=关=不拦，安全降级）；无需懒重置
        // （TUI 首见重置负责，server 侧读到缺文件天然是关）。
        // 只拦 `speak`（含 --follow/--background 变体），help/devices/status 不拦；
        // **auto-read 自身不经此工具**（`auto-read.ts` 直接 spawn CLI 派生 worker），不会自拦。
        const sid = context?.sessionID ?? "";
        if (shouldInterceptSpeakForAutoRead(extra, readAutoTts(sid))) {
          log.info(`speak intercepted (auto-read on): session=${sid || "-"} args=${extra}`);
          // 文案 execute 时**现取**（toolLanguage 可能在加载后被改，不用 createVoiceTool 的加载期缓存表）
          return { title: "emotions speak skipped", output: safePhrases().tool.speakSkippedAutoRead };
        }
        // 分词（无 shell）→ 长正文改走 stdin → 朗读统一补 `--background`（CLI 立即返回，不卡回合）
        let invocation: CliInvocation;
        try {
          invocation = prepareInvocation(tokenizeArgs(extra));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.warn(`${TOOL_NAME} 参数解析失败：${message}`);
          return { title: "emotions_cli failed", output: `Execution failed: ${message}` };
        }
        const isSpeak = invocation.args[0] === "speak";
        if (isSpeak && !invocation.args.includes("--background")) invocation.args.push("--background");

        // 两段式兜底：优先 PATH 上的 node；**仅在 ENOENT**（可执行文件不存在）时用当前进程（Bun 宿主）
        const attempts: Array<{ label: string; bin: string }> = [{ label: "node", bin: "node" }];
        if (process.execPath !== "node") attempts.push({ label: process.execPath, bin: process.execPath });
        const failures: string[] = [];
        for (let index = 0; index < attempts.length; index += 1) {
          const attempt = attempts[index];
          const outcome = await runCli(
            attempt.bin,
            [cliPath, ...invocation.args],
            invocation.stdinText,
            context?.abort,
          );
          const canRetry = outcome.error?.code === "ENOENT" && index < attempts.length - 1;
          if (canRetry) continue;
          const ok = !outcome.error && !outcome.timedOut && !outcome.aborted && outcome.code === 0;
          if (ok) {
            log.tool(TOOL_NAME, { args: extra });
            if (outcome.stderr.trim().length > 0) {
              log.warn(`${TOOL_NAME} stderr: ${preview(outcome.stderr.trim(), ERROR_PREVIEW_CHARS)}`);
            }
            return { title: `emotions ${preview(extra, TITLE_PREVIEW_CHARS)}`, output: outcome.stdout.trim() };
          }
          failures.push(describeFailure(attempt.label, outcome));
          break;
        }
        log.error(`${TOOL_NAME} 执行失败`, new Error(failures.join("\n")));
        return { title: "emotions_cli failed", output: `Execution failed: ${failures.join("\n")}` };
      },
    }),
  };
}
