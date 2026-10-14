/**
 * opencode-emotions **唯一 server 入口**（V1 形态：默认导出 `{ id, server }`）。
 *
 * 极性来源：命令（本插件，`/angry` 等）+ 语音（TUI 插件注入），统一渲染为 `emoji(等级/3)`；
 * 手动符号解析（`!`/`?`/`...`/`666`）已移除（见 docs/设计-情绪输入插件.md）。
 *
 * 为什么只有一个 server 入口：opencode 对**一个 npm 包只解析一个 server 入口**
 * （`exports["./server"]` / `main`）。原先 `voice_cli` 由第二个 server 插件 `src/tts-tool.ts`
 * 注册，npm 安装时不会被加载 ⇒ 现将工具定义抽到 `src/voice/tool.ts`，与命令共用本入口。
 *
 * 钩子：
 * - `config`：注册全部情绪命令（含别名）。
 * - `tool`：注册 CLI 风格工具 `voice_cli`（定义见 `src/voice/tool.ts`）。
 * - `chat.message`：仅清理「以情绪标注开头」文本的尾部空白
 *   （无参数命令模板空参替换会残留尾部空格，如 `😊(2/3) ` → `😊(2/3)`），不改写正文语义。
 * 所有异常一律 catch，绝不抛出影响会话。
 */

import type { Hooks, Plugin } from "@opencode-ai/plugin";
import createLogger from "@xiaoqiong0v0/opencode-plugin-logger";
import type { Logger } from "@xiaoqiong0v0/opencode-plugin-logger";

import { EMOTION_COMMANDS, commandTemplate } from "./lib/commands.js";
import { trimAnnotationTail } from "./lib/parser.js";
import { createVoiceTool } from "./voice/tool.js";

/** V1 插件标识（本地文件插件必须导出 id）。 */
const PLUGIN_ID = "emotions";

const log: Logger = createLogger(PLUGIN_ID);

/** 写入 opencode 配置的命令条目。 */
interface RegisteredCommand {
  description: string;
  template: string;
}

/** 命令注册所需的配置切片。 */
interface CommandConfig {
  command?: Record<string, RegisteredCommand>;
}

/** text part 的最小结构（只取改写所需字段，避免绑定 SDK Part 联合类型）。 */
interface TextPartLike {
  type?: string;
  text?: string;
}

/**
 * 把全部情绪命令（含别名）就地注册到 opencode 配置。
 * @param cfg opencode 配置对象（会被就地修改）
 */
function registerCommands(cfg: CommandConfig): void {
  const commands: Record<string, RegisteredCommand> = cfg.command ?? {};
  for (const command of EMOTION_COMMANDS) {
    const template = commandTemplate(command);
    for (const name of [command.name, ...command.aliases]) {
      commands[name] = { description: `情绪命令：${name}`, template };
    }
  }
  cfg.command = commands;
}

/** V1 server 工厂：返回 config / tool / chat.message 钩子。 */
const server: Plugin = async (): Promise<Hooks> => {
  log.loaded();
  // 工具注册单独兜底：即便失败也只跳过 tool 钩子，不影响情绪命令
  let voiceTool: Hooks["tool"];
  try {
    voiceTool = createVoiceTool(log);
  } catch (err) {
    log.error("voice_cli 工具注册失败", err as Error);
  }
  return {
    ...(voiceTool ? { tool: voiceTool } : {}),
    config: async (cfg) => {
      try {
        registerCommands(cfg as unknown as CommandConfig);
        log.hook("config", `已注册 ${EMOTION_COMMANDS.length} 个情绪命令（含别名）`);
      } catch (err) {
        log.error("config 钩子注册命令失败", err as Error);
      }
    },
    "chat.message": async (_input, output) => {
      try {
        const parts = output?.parts as ReadonlyArray<TextPartLike> | undefined;
        if (!Array.isArray(parts)) return;
        // 只处理首个 text part
        const first = parts.find((part) => part?.type === "text");
        if (!first || typeof first.text !== "string") return;
        // 命令产出以情绪标注开头；空参命令会残留尾部空白，这里统一清理
        const trimmed = trimAnnotationTail(first.text);
        if (trimmed === first.text) return;
        first.text = trimmed;
        log.hook("chat.message", `已清理标注尾部空白：${trimmed.slice(0, 40)}`);
      } catch (err) {
        log.error("chat.message 钩子改写失败", err as Error);
      }
    },
  };
};

export default { id: PLUGIN_ID, server };
