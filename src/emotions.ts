/**
 * opencode-emotions 插件入口（V1 形态：默认导出 `{ id, server }`）。
 *
 * 钩子：
 * - `config`：注册全部情绪命令（含别名）。
 * - `chat.message`：解析消息并就地改写首个 text part 的 `.text` 为可见情绪标注；
 *   对已带标注的文本（无参数命令空参替换会残留尾部空格）只清理尾部空白。
 * 所有异常一律 catch，绝不抛出影响会话。
 */

import type { Hooks, Plugin } from "@opencode-ai/plugin";
import createLogger from "@xiaoqiong0v0/opencode-plugin-logger";
import type { Logger } from "@xiaoqiong0v0/opencode-plugin-logger";

import { EMOTION_COMMANDS, commandTemplate } from "./lib/commands.js";
import { rewriteEmotion, trimAnnotationTail } from "./lib/parser.js";

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

/** V1 server 工厂：返回 config 与 chat.message 钩子。 */
const server: Plugin = async (): Promise<Hooks> => {
  log.loaded();
  return {
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
        const rewritten = rewriteEmotion(first.text);
        if (rewritten !== null) {
          first.text = rewritten;
          log.hook("chat.message", `已改写情绪标注：${rewritten.slice(0, 40)}`);
          return;
        }
        // 未命中符号：仅当文本以情绪标注开头时清理尾部空白（无参数命令产出 `😊(2/3) `）
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
