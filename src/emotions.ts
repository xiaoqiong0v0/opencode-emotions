/**
 * opencode-emotions **唯一 server 入口**（V1 形态：默认导出 `{ id, server }`）。
 *
 * 极性来源：命令（本插件，`/angry` 等）+ 语音（TUI 插件注入），统一渲染为 `emoji(等级/3)`；
 * 手动符号解析（`!`/`?`/`...`/`666`）已移除（见 docs/设计-情绪输入插件.md）。
 *
 * 为什么只有一个 server 入口：opencode 对**一个 npm 包只解析一个 server 入口**
 * （`exports["./server"]` / `main`）。原先 `emotions_cli` 由第二个 server 插件 `src/tts-tool.ts`
 * 注册，npm 安装时不会被加载 ⇒ 现将工具定义抽到 `src/voice/tool.ts`，与命令共用本入口。
 *
 * 钩子：
 * - `config`：注册全部情绪主命令（不含别名）。
 * - `tool`：注册 CLI 风格工具 `emotions_cli`（定义见 `src/voice/tool.ts`）。
 * - `event`：助手消息**增量流式为主**（`message.part.delta`，完成事件仅作回退）时按自动朗读开关
 *   （由 TUI 的 F10 切换）触发自动朗读（见 `src/voice/auto-read.ts`）。
 * - `chat.message`：仅清理「以情绪标注开头」文本的尾部空白
 *   （无参数命令模板空参替换会残留尾部空格，如 `😊(2/3) ` → `😊(2/3)`），不改写正文语义。
 * 所有异常一律 catch，绝不抛出影响会话。
 */

import type { Hooks, Plugin } from "@opencode-ai/plugin";
import createLogger from "@xiaoqiong0v0/opencode-plugin-logger";
import type { Logger } from "@xiaoqiong0v0/opencode-plugin-logger";

import { EMOTION_COMMANDS, commandTemplate } from "./lib/commands.js";
import { trimAnnotationTail } from "./lib/parser.js";
import { createAutoReader, type PartLike } from "./voice/auto-read.js";
import { stopPlayback } from "./voice/playback-state.js";
import { createVoiceTool, resolveCliPath } from "./voice/tool.js";
import { resolveFollowSupport, resolvePcmOutputSupport } from "./voice/tts/index.js";
import { resolvePrefetchDepth } from "./voice/tts/prefetch.js";

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

/** `chat.message` 入参的会话归属候选（运行时可能出现在非类型声明的字段上）。 */
export interface ChatMessageInputLike {
  sessionID?: unknown;
  messageID?: unknown;
  properties?: { sessionID?: unknown; messageID?: unknown } | undefined;
  message?: { sessionID?: unknown; messageID?: unknown } | undefined;
}

/** 缺归属 warn 的进程内一次性标记（防每条消息刷屏；单测可注入独立 state）。 */
const missingSessionWarnState = { warned: false };

/** 用户消息打断的可注入依赖（单测用 spy 断言「缺归属不调用任何停止入口」）。 */
export interface UserMessageInterruptDeps {
  /** 停止播放（默认 `stopPlayback`）。 */
  stop?: (options: { sessionID: string }) => unknown;
  /** 自动朗读打断（默认 `autoReader.interrupt`）。 */
  interrupt?: (sessionID: string) => void;
  /** 告警输出（默认插件 logger）。 */
  warn?: (message: string, err?: Error | string) => void;
  /** 「只记一次 warn」状态（默认模块级，单测传新对象隔离）。 */
  warnState?: { warned: boolean };
}

/**
 * 解析 `chat.message` 入参的会话 id：`sessionID` → `properties.sessionID` → `message.sessionID`。
 * 逐级回落，任一非空白字符串即返回（trim 后）。
 * @param input 钩子入参（可能缺字段）
 * @returns 会话 id；全部缺失/空白 → undefined
 */
export function resolveChatSessionID(input: ChatMessageInputLike | undefined): string | undefined {
  const candidates = [input?.sessionID, input?.properties?.sessionID, input?.message?.sessionID];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate.trim();
  }
  return undefined;
}

/**
 * 列出钩子入参上实际存在的字段名（缺归属 warn 的诊断信息）。
 * @param input 钩子入参
 * @returns 逗号分隔字段名；无字段 → `(none)`
 */
function describeAvailableFields(input: ChatMessageInputLike | undefined): string {
  if (!input || typeof input !== "object") return "(none)";
  const names = Object.keys(input as Record<string, unknown>);
  return names.length > 0 ? names.join(",") : "(none)";
}

/**
 * 用户发消息时的打断（barge-in）：**归属缺失一律跳过（fail-safe）**，绝不隐式全清。
 *
 * 缺归属时只记一次 warn（含入参可用字段名）并返回 false：不调 `stopPlayback`、不调 `interrupt`，
 * 避免另一会话/无归属事件把当前会话正在播的 TTS 杀在句中。
 * @param input 钩子入参（会话 id 按 {@link resolveChatSessionID} 逐级回落）
 * @param autoReader 自动朗读实例（`interrupt` 按会话收窄）
 * @param deps 可注入依赖（单测）
 * @returns 是否执行了打断（false = 缺归属跳过）
 */
export function interruptOnUserMessage(
  input: ChatMessageInputLike | undefined,
  autoReader: { interrupt(sessionID?: string): void } | undefined,
  deps: UserMessageInterruptDeps = {},
): boolean {
  const warn = deps.warn ?? ((message: string, err?: Error | string) => log.warn(message, err));
  const sessionID = resolveChatSessionID(input);
  if (!sessionID) {
    const state = deps.warnState ?? missingSessionWarnState;
    if (!state.warned) {
      state.warned = true;
      warn(`chat.message 缺少会话归属，已跳过打断（可用字段：${describeAvailableFields(input)}）`);
    }
    return false;
  }
  const stop = deps.stop ?? ((options: { sessionID: string }) => stopPlayback(options));
  try {
    stop({ sessionID });
  } catch (err) {
    warn("打断播放失败", err as Error);
  }
  const interrupt = deps.interrupt ?? ((sid: string) => autoReader?.interrupt(sid));
  interrupt(sessionID);
  return true;
}

/**
 * 把全部情绪主命令就地注册到 opencode 配置（只注册主命令，不含别名）。
 * @param cfg opencode 配置对象（会被就地修改）
 */
function registerCommands(cfg: CommandConfig): void {
  const commands: Record<string, RegisteredCommand> = cfg.command ?? {};
  for (const command of EMOTION_COMMANDS) {
    const template = commandTemplate(command);
    commands[command.name] = { description: `情绪命令：${command.name}`, template };
  }
  cfg.command = commands;
}

/** V1 server 工厂：返回 config / tool / event / chat.message 钩子。 */
const server: Plugin = async (input): Promise<Hooks> => {
  log.loaded();
  // 工具注册单独兜底：即便失败也只跳过 tool 钩子，不影响情绪命令
  let voiceTool: Hooks["tool"];
  try {
    voiceTool = createVoiceTool(log);
  } catch (err) {
    log.error("emotions_cli 工具注册失败", err as Error);
  }
  // 自动朗读：单独兜底；失败只跳过 event 钩子
  let autoReader: ReturnType<typeof createAutoReader> | undefined;
  try {
    autoReader = createAutoReader({
      log,
      cliPath: resolveCliPath(),
      // provider follow 能力（sapi=true）：drain 用 `speak --follow` 常驻 worker（每消息 1 次 spawn），
      // 非 follow provider 退回按块 spawn CLI（句对齐粒度）。解析失败按 false 降级。
      followSupport: resolveFollowSupport(),
      // 句间停顿优化（2026-10-22 第十四批）：provider 支持只合成不出声（mimo/aliyun）时启用下一单元预取；
      // depth 默认 1，env `TTS_PREFETCH_DEPTH=0` 可关闭（解析失败按默认，不阻塞朗读）。
      prefetchSupport: resolvePcmOutputSupport(),
      prefetchDepth: resolvePrefetchDepth(),
      // message.updated 只带 info（不含 parts）：用 client 取回 { info, parts }
      fetchParts: async (sessionID, messageID) => {
        const response = await input.client.session.message({ path: { id: sessionID, messageID } });
        return (response.data?.parts ?? []) as PartLike[];
      },
      // 角色未知时惰性补取（part/delta 事件先于 message.updated 到达的兜底；只读 assistant）
      fetchMessageRole: async (sessionID, messageID) => {
        const response = await input.client.session.message({ path: { id: sessionID, messageID } });
        const role = (response.data?.info as { role?: string } | undefined)?.role;
        return typeof role === "string" ? role : undefined;
      },
      // 子会话判定（单飞去重在 auto-read 内部保证）：按 sessionID 取 Session，看 parentID 是否有值。
      // 字段依据：@opencode-ai/sdk Session.parentID?: string（dist/gen/types.gen.d.ts:469）；
      // client.session.get 返回 Session（SessionGetResponses 200: Session，types.gen.d.ts:1913，url "/session/{id}"）。
      fetchIsChildSession: async (sessionID) => {
        const response = await input.client.session.get({ path: { id: sessionID } });
        const parentID = (response.data as { parentID?: string } | undefined)?.parentID;
        return typeof parentID === "string" && parentID.length > 0;
      },
    });
  } catch (err) {
    log.error("自动朗读初始化失败", err as Error);
  }
  return {
    ...(voiceTool ? { tool: voiceTool } : {}),
    // 宿主 dispose：清场——取消全部会话的待读队列/预取（kill 合成与预热子进程、删缓冲）/朗读子进程。
    // 单独入口（不是 `interrupt()` 无参）以免与「消息级打断」混淆；异常绝不抛出。
    dispose: async () => {
      try {
        autoReader?.dispose();
      } catch (err) {
        log.warn("dispose 清理自动朗读失败", err as Error);
      }
    },
    ...(autoReader
      ? {
          event: async ({ event }) => {
            try {
              autoReader?.handleEvent(event);
            } catch (err) {
              log.error("event 钩子处理失败", err as Error);
            }
          },
        }
      : {}),
    config: async (cfg) => {
      try {
        registerCommands(cfg as unknown as CommandConfig);
        log.hook("config", `已注册 ${EMOTION_COMMANDS.length} 个情绪命令（仅主命令）`);
      } catch (err) {
        log.error("config 钩子注册命令失败", err as Error);
      }
    },
    "chat.message": async (input, output) => {
      try {
        // 打断（barge-in）：用户一发送消息，立刻停掉正在播放的 TTS（按共享状态文件里的 PID 终止），
        // 并对**本会话**在途消息置打断水位（清其待读队列、停其朗读；水位语义见 auto-read `interrupt`）。
        // **带 sessionID 按会话隔离**（2026-10-21 修跨会话误杀；2026-11-02 修「缺归属隐式全清」）：
        // 会话 id 按 input.sessionID → properties.sessionID → message.sessionID 逐级回落；
        // **仍取不到 → 只记一次 warn 并跳过**（return），绝不把 undefined 传下去触发全清。
        if (!interruptOnUserMessage(input as ChatMessageInputLike, autoReader)) return;
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
