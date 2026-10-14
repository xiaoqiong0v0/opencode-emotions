/**
 * `voice_cli` 工具定义（由 **server 入口** `src/emotions.ts` 的 `tool` 钩子注册）。
 *
 * 背景：opencode 对**一个 npm 包只解析一个 server 入口**（`exports["./server"]` / `main`）。
 * 原先 `voice_cli` 由**独立的第二个 server 插件** `src/tts-tool.ts` 注册，npm 安装时不会被加载
 * ⇒ 把工具定义抽到这个 lib，与情绪命令共用同一个 server 入口，使 npm 安装后命令与工具**都生效**。
 *
 * 形态（照本机 `stats-command.js` 模式）：只注册一个工具，`args` 是**完整 CLI 参数串**，
 * `execute` 把它拼成一条命令交给 `exec` 运行构建产物 `dist/cli/voice-cli.js`，
 * 返回 `{ title, output }`。工具本身不含业务逻辑，能力全在 CLI（`src/cli/voice-cli.ts`）。
 *
 * 本地化：工具描述在**插件加载时**按 `emotions.jsonc` 的 `toolLanguage` 生成（词表见 `src/lib/i18n.ts`）。
 * 非阻塞：CLI 的 `speak` 走 `--background`（分离子进程播放），`exec` 立即拿到确认并返回，
 * 不阻塞模型回合（并发/进程模型见 docs/ASYNC.md）。
 */

import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { tool } from "@opencode-ai/plugin";
import type { ToolDefinition } from "@opencode-ai/plugin";
import type { Logger } from "@xiaoqiong0v0/opencode-plugin-logger";

import { DEFAULT_LANGUAGE, getPhrases, type Phrases } from "../lib/i18n.js";
import { loadVoiceConfig } from "./config.js";

const execP = promisify(exec);

/** 工具名（CLI 风格）。 */
const TOOL_NAME = "voice_cli";
/** CLI 产物相对其所在目录的路径（非插件产物一律置于子目录，避免被当插件自动加载）。 */
const CLI_RELATIVE_PATH = join("cli", "voice-cli.js");
/** CLI 脚本路径覆盖环境变量。 */
const ENV_CLI_SCRIPT = "VOICE_CLI_SCRIPT";
/** 允许的大输出缓冲（与 stats-command 一致）。 */
const MAX_BUFFER = 64 * 1024 * 1024;

/** exec 抛错对象的最小结构（typed 便于取 stdout/stderr）。 */
interface ExecError {
  message: string;
  stdout?: string;
  stderr?: string;
}

/**
 * 解析 `voice-cli.js` 的绝对路径：环境变量覆盖 > `<cwd>/dist/cli/` > 本模块**同级**的 `cli/`。
 *
 * CLI 产物位于 `dist/cli/`（子目录，非插件），镜像后落在 `.opencode/plugin/cli/`；该顶层目录的每个
 * `.js` 才会被 opencode 当插件自动 import，子目录不被扫描——故 CLI 只从构建产物 `dist/` 取用。
 * 本模块位于 `dist/voice/tool.js`（镜像后 `.opencode/plugin/voice/tool.js`），其父目录即 `dist/`
 * （镜像后 `.opencode/plugin/`），故同级 `cli/` 与 `cwd/dist/cli/` 两种口径都能命中。
 * @returns CLI 脚本路径（候选都不存在时返回首选，便于错误信息定位）
 */
export function resolveCliPath(): string {
  const override = process.env[ENV_CLI_SCRIPT];
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
 * 构建 `voice_cli` 工具（加载时本地化描述，`execute` 透传参数串给 CLI）。
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
      async execute(a) {
        let extra = (a.args ?? "").trim();
        if (extra.length === 0) extra = "help";
        // 朗读统一走后台播放（CLI 立即返回），保持「不卡回合」；其余子命令本就快速
        if (/^speak\b/.test(extra) && !/--background\b/.test(extra)) extra = `${extra} --background`;

        // 两段式兜底：优先 PATH 上的 node；找不到时用当前进程的可执行文件（如 Bun）
        const attempts = [
          { label: "node", cmd: `node "${cliPath}" ${extra}` },
          { label: process.execPath, cmd: `"${process.execPath}" "${cliPath}" ${extra}` },
        ];
        const failures: string[] = [];
        for (const { label, cmd } of attempts) {
          try {
            const { stdout } = await execP(cmd, { maxBuffer: MAX_BUFFER, windowsHide: true });
            log.tool(TOOL_NAME, { args: extra });
            return { title: `voice ${extra}`, output: stdout.trim() };
          } catch (err) {
            const e = err as ExecError;
            const detail = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim();
            failures.push(`${label}: ${e.message}${detail ? "\n" + detail : ""}`);
          }
        }
        log.error(`${TOOL_NAME} 执行失败`, new Error(failures.join("\n")));
        return { title: "voice_cli failed", output: `Execution failed: ${failures.join("\n")}` };
      },
    }),
  };
}
