/** @jsxImportSource @opentui/solid */
/**
 * opencode-voice TUI 插件（**单插件**，承担 UI + 运行时管理 + 分发）。
 *
 * 背景：spike 已证实 TUI 插件自带 `api.client`（OpencodeClient），注入无需 server 插件，
 * 故旧 `voice-server`（HTTP 网关 + session-tracker + process-manager）整套删除。
 *
 * 能力：
 * - 在 `session_prompt_right` 渲染**单个**状态指示 `[🎙 状态][注入|输入][F8/F9]`（如 `🎙 ● 注入 F8/F9` / `🎙 ○ 输入 F8/F9`）：
 *   一眼看出麦克风状态（●开 / ○关 / ⏳启动中）+ 当前模式 + 可切换的两个热键（第三段恒为 `F8/F9`）；
 * - 两个**点按开关**热键（不能按住：长按会键重复且松键不上报，见 spike 结论）：
 *   - `F8` = 模式 A「语音注入」：识别结果经 `client.session.prompt` 变成一条带 🎙 标记的新消息；
 *   - `F9` = 模式 B「语音输入」：识别结果经 `client.tui.appendPrompt` 增量追加进输入框，由用户编辑后发送；
 * - 运行时：`child_process.spawn` 起 `dist/runtime/voice-runtime.js --json`，按行读其 stdout 的 NDJSON
 *   （契约见 `voice/ndjson.ts`），按当前模式分发；`api.ui.toast` 给可见反馈。
 *
 * 进程边界：TUI 运行在 Bun 宿主内，通过相对导入复用 `voice/ndjson.js` 的契约解析（同一构建产物内相对解析）。
 * 装载：`tui.json` 的 `plugin` 指向**编译产物**（`.opencode/plugin/tui.js`，即镜像后的 `dist/tui.js`）。
 * 构建：`.tsx` **不参与主 `tsc` 构建**，由 `scripts/build-tui.mjs` 用**宿主同款 Babel 链**
 *   （`babel-preset-solid` universal + `@babel/preset-typescript`）编译成 `dist/tui.js`——
 *   必须走 Solid 编译（JSX 会被包成 `createElement`/`insert`/`setProp` + `effect` 的响应式结构）；
 *   若改用 `tsc` 的 `jsx()` 产物，props/children 不会被包成访问器，槽位将失去响应式。
 * i18n：全部面向用户的文案取自 `lib/i18n.ts` 词表，语言来自 `emotions.jsonc` 的 `language`。
 * 健壮性：所有异常一律 catch，绝不影响 opencode；子进程异常退出时复位开关、可再次热键重启。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";

import { createSignal } from "solid-js";

import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui";

import { DEFAULT_LANGUAGE, format, getPhrases, type Phrases } from "./lib/i18n.js";
import { loadVoiceConfig } from "./voice/config.js";
import { NdjsonLineSplitter, parseEventLine, type RuntimeFinal } from "./voice/ndjson.js";
import {
  formatSlotSegments,
  INPUT_KEY,
  INPUT_KEY_LABEL,
  INJECT_KEY,
  INJECT_KEY_LABEL,
  type MicState,
  type SlotColorRole,
  type SlotMode,
  type SlotSegment,
} from "./voice/slot.js";

/** 文件来源插件必须导出 id。 */
const PLUGIN_ID = "voice-tui";
/** 模式 A 命令名。 */
const CMD_MODE_A = "voice.inject.toggle";
/** 模式 B 命令名。 */
const CMD_MODE_B = "voice.input.toggle";
/** 运行时脚本相对 cwd 的路径片段。 */
const RUNTIME_SCRIPT = ["dist", "runtime", "voice-runtime.js"] as const;
/** Node 可执行文件环境变量（默认 PATH 上的 node）。 */
const NODE_BIN_ENV = "VOICE_NODE_BIN";
/** 运行时脚本路径环境变量（默认 <cwd>/dist/runtime/voice-runtime.js）。 */
const SCRIPT_ENV = "VOICE_RUNTIME_SCRIPT";
/** 默认 Node 可执行文件名。 */
const DEFAULT_NODE_BIN = "node";
/** 注入消息前缀标记（标识来源于语音）。 */
const INJECT_MARKER = "🎙";
/** 等待子进程 spawn 的超时（毫秒）。 */
const SPAWN_TIMEOUT_MS = 5000;
/** 停止子进程时等待其退出的上限（毫秒）。 */
const STOP_TIMEOUT_MS = 2000;
/** toast 里预览文本的最大长度。 */
const PREVIEW_LEN = 24;

/** 模式标识（与槽位渲染共用）。 */
type VoiceMode = SlotMode;

/** 槽位分段可用的 theme 颜色键（核对自 `@opencode-ai/plugin` `dist/tui.d.ts` 的 `TuiThemeCurrent`）。 */
type SlotThemeKey = "primary" | "accent" | "success" | "warning" | "info" | "textMuted";

/** 模式 → 固定颜色键：注入=`warning`、输入=`primary`（模式描述与「激活热键」共用）。 */
const MODE_THEME_KEY: Record<VoiceMode, SlotThemeKey> = {
  inject: "warning",
  input: "primary",
};

/** 麦克风状态 → 图标/字形颜色键：开=`success`、启动中=`info`、关=`textMuted`。 */
const MIC_THEME_KEY: Record<MicState, SlotThemeKey> = {
  on: "success",
  starting: "info",
  off: "textMuted",
};

/** 把任意错误转为简短字符串。 */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 截断文本用于 toast 预览。 */
function preview(text: string): string {
  return text.length > PREVIEW_LEN ? `${text.slice(0, PREVIEW_LEN)}…` : text;
}

/** 延时。 */
function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

/** 读取当前语言文案（配置读取失败回退默认，绝不影响 TUI）。 */
function safePhrases(): Phrases {
  try {
    return getPhrases(loadVoiceConfig().language);
  } catch {
    return getPhrases(DEFAULT_LANGUAGE);
  }
}

/**
 * 等待子进程成功 spawn（`error` 或超时则 reject）。
 * @param child 子进程
 * @param timeoutMs 超时毫秒
 * @returns 成功时 resolve
 */
function waitForSpawn(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolveSpawn, rejectSpawn) => {
    let settled = false;
    const settle = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) rejectSpawn(err);
      else resolveSpawn();
    };
    const timer = setTimeout(() => settle(new Error(`启动超时（${timeoutMs}ms 内未收到 spawn 事件）`)), timeoutMs);
    child.once("spawn", () => settle());
    child.once("error", (err: Error) => settle(err));
  });
}

/**
 * 读取当前会话 id。
 * @param api 宿主注入的 TUI API
 * @returns 当前处于会话路由时的 sessionID；否则 undefined
 */
function currentSessionID(api: TuiPluginApi): string | undefined {
  try {
    const current = api.route.current;
    if (current.name === "session" && "params" in current && current.params) {
      const sessionID = (current.params as { sessionID?: unknown }).sessionID;
      if (typeof sessionID === "string" && sessionID.length > 0) return sessionID;
    }
  } catch {
    // 路由不可用时视为无会话
  }
  return undefined;
}

/**
 * 组合注入/追加正文：有标注时前置 `emoji(等级/3)`。
 * @param result 识别结果
 * @returns 正文
 */
function composeBody(result: RuntimeFinal): string {
  const annotation = result.annotation.trim();
  return annotation ? `${annotation} ${result.text}` : result.text;
}

const tui: TuiPlugin = async (api: TuiPluginApi) => {
  const phrases = safePhrases();
  const [injectOn, setInjectOn] = createSignal(false);
  const [inputOn, setInputOn] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  // 当前展示的模式（开/关都保留；默认「输入」），用于单个槽位指示的模式位
  const [mode, setMode] = createSignal<VoiceMode>("input");

  let child: ChildProcess | null = null;
  let splitter = new NdjsonLineSplitter();
  let toggling = false;
  let stopping = false;
  let disposed = false;
  /** 子进程 stderr 的最后一行（运行时会周期性打采集统计，故只留存末行备查，不回显）。 */
  let lastStderr = "";

  /** 模式是否开启。 */
  const isOn = (target: VoiceMode): boolean => (target === "inject" ? injectOn() : inputOn());
  /** 是否已有开关开启（等价于运行时应存在）。 */
  const anyOn = (): boolean => injectOn() || inputOn();
  /** 是否已有存活的子进程。 */
  const childAlive = (): boolean => child !== null && child.exitCode === null && !child.killed;
  /** 模式对应的完整标签。 */
  const modeLabel = (target: VoiceMode): string =>
    target === "inject" ? phrases.label.inject : phrases.label.input;

  /** 弹 toast（安全包装，dispose 后静默）。 */
  const toast = (variant: "info" | "success" | "warning" | "error", message: string): void => {
    if (disposed) return;
    try {
      api.ui.toast({ variant, title: phrases.toast.title, message });
    } catch {
      // 宿主 UI 不可用时忽略
    }
  };

  /** 子进程结束/异常时复位开关并提示（主动停止时不提示）。 */
  const handleChildGone = (reason: string): void => {
    child = null;
    splitter = new NdjsonLineSplitter();
    if (stopping) return;
    setInjectOn(false);
    setInputOn(false);
    const detail = lastStderr ? `；stderr：${preview(lastStderr)}` : "";
    toast("error", format(phrases.toast.runtimeExited, { reason, detail }));
  };

  /** 处理一条 NDJSON 事件。 */
  const handleEvent = (event: ReturnType<typeof parseEventLine>): void => {
    if (!event) return;
    switch (event.type) {
      case "ready":
        toast("info", phrases.toast.ready);
        break;
      case "final":
        void dispatch(event);
        break;
      case "error":
        toast("warning", format(phrases.toast.runtimeError, { message: preview(event.message) }));
        break;
      case "done":
        break;
      default:
        break;
    }
  };

  /** stdout 分片 → 完整行 → 事件。 */
  const onStdout = (chunk: string): void => {
    for (const line of splitter.push(chunk)) handleEvent(parseEventLine(line));
  };

  /** 启动语音运行时（单实例；等 `spawn` 事件确认）。 */
  const startRuntime = async (): Promise<void> => {
    if (childAlive()) return;
    const script = process.env[SCRIPT_ENV] || resolve(process.cwd(), ...RUNTIME_SCRIPT);
    const bin = process.env[NODE_BIN_ENV] || DEFAULT_NODE_BIN;

    let spawned: ChildProcess;
    try {
      spawned = spawn(bin, [script, "--json"], {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      throw new Error(`无法启动 ${bin}：${errText(err)}`);
    }

    child = spawned;
    splitter = new NdjsonLineSplitter();
    lastStderr = "";
    spawned.stdout?.setEncoding("utf8");
    spawned.stdout?.on("data", (chunk: string) => onStdout(chunk));
    spawned.stderr?.on("data", (chunk: Buffer) => {
      const text = String(chunk).trimEnd();
      if (text.length > 0) lastStderr = text.split(/\r?\n/).filter((line) => line.length > 0).at(-1) ?? lastStderr;
    });
    spawned.on("error", (err: Error) => handleChildGone(`进程错误：${err.message}`));
    spawned.on("exit", (code: number | null, signal: NodeJS.Signals | null) =>
      handleChildGone(`code=${code ?? "-"} signal=${signal ?? "-"}`),
    );

    await waitForSpawn(spawned, SPAWN_TIMEOUT_MS);
  };

  /** 停止语音运行时并等待其退出。 */
  const stopRuntime = async (): Promise<void> => {
    const current = child;
    if (!current || current.exitCode !== null) {
      child = null;
      return;
    }
    stopping = true;
    const exited = new Promise<void>((resolveExit) => current.once("exit", () => resolveExit()));
    try {
      current.kill();
    } catch (err) {
      console.error(`[voice] 停止子进程失败：${errText(err)}`);
    }
    await Promise.race([exited, delay(STOP_TIMEOUT_MS)]);
    stopping = false;
    if (child === current) child = null;
  };

  /** 按当前模式分发一条最终结果。 */
  const dispatch = async (result: RuntimeFinal): Promise<void> => {
    const body = composeBody(result);
    if (injectOn()) {
      const sessionID = currentSessionID(api);
      if (!sessionID) {
        toast("warning", phrases.toast.notInSession);
        return;
      }
      try {
        const response = await api.client.session.prompt({
          sessionID,
          noReply: false,
          parts: [{ type: "text", text: `${INJECT_MARKER} ${body}` }],
        });
        if (response.error) {
          toast("error", format(phrases.toast.injectFailed, { message: preview(JSON.stringify(response.error)) }));
        } else {
          toast("success", format(phrases.toast.injected, { text: preview(result.text) }));
        }
      } catch (err) {
        toast("error", format(phrases.toast.injectException, { message: errText(err) }));
      }
      return;
    }
    if (inputOn()) {
      try {
        await api.client.tui.appendPrompt({ text: ` ${body} ` });
        toast("success", format(phrases.toast.appended, { text: preview(result.text) }));
      } catch (err) {
        toast("error", format(phrases.toast.appendFailed, { message: errText(err) }));
      }
    }
  };

  /** 切换某模式（点按开关；两种模式互斥）。 */
  const toggleMode = async (target: VoiceMode): Promise<void> => {
    if (toggling) return;
    toggling = true;
    setBusy(true);
    const label = modeLabel(target);
    const next = !isOn(target);
    setMode(target);
    try {
      if (target === "inject") {
        setInjectOn(next);
        if (next) setInputOn(false);
      } else {
        setInputOn(next);
        if (next) setInjectOn(false);
      }

      if (next) {
        if (!childAlive()) {
          try {
            await startRuntime();
            toast("success", format(phrases.toast.modeOn, { label }));
          } catch (err) {
            if (target === "inject") setInjectOn(false);
            else setInputOn(false);
            toast("error", format(phrases.toast.startFailed, { message: errText(err) }));
          }
        } else {
          toast("info", format(phrases.toast.switched, { label }));
        }
      } else if (!anyOn()) {
        await stopRuntime();
        toast("info", format(phrases.toast.modeOff, { label }));
      } else {
        toast("info", format(phrases.toast.switched, { label: modeLabel(target === "inject" ? "input" : "inject") }));
      }
    } finally {
      toggling = false;
      setBusy(false);
    }
  };

  // dispose：停止子进程、复位状态，避免留下孤儿进程。
  api.lifecycle.onDispose(() => {
    disposed = true;
    void stopRuntime();
  });

  // 常驻 UI：输入框右侧**单个**状态指示 `🎙 状态 模式 热键`（开/关/启动中一目了然）。
  // 分段配色：图标/字形随麦克风状态；模式描述与其激活热键用模式色；非激活热键/分隔符用暗色；
  // 关闭态（无激活模式）整体转暗色（图标/字形取 `textMuted`、模式描述与两键也取 `textMuted`）。
  api.slots.register({
    order: 0,
    slots: {
      session_prompt_right() {
        const theme = api.theme.current;
        /** 当前麦克风状态。 */
        const mic = (): MicState => (busy() ? "starting" : anyOn() ? "on" : "off");
        /** 当前分段（响应式：随状态/模式/开关变化重算；定宽填充见 `slot.ts`）。 */
        const segments = (): SlotSegment[] =>
          formatSlotSegments(phrases, { mic: mic(), mode: mode(), injectOn: injectOn(), inputOn: inputOn() });
        /** 分段角色 → theme 颜色（颜色只在渲染层选定）。 */
        const colorOf = (role: SlotColorRole): (typeof theme)["text"] => {
          const active = injectOn() || inputOn();
          switch (role) {
            case "icon":
            case "glyph":
              return theme[MIC_THEME_KEY[mic()]];
            case "mode":
              return active ? theme[MODE_THEME_KEY[mode()]] : theme.textMuted;
            case "keyActive":
              return theme[MODE_THEME_KEY[mode()]];
            case "keyInactive":
            case "separator":
            default:
              return theme.textMuted;
          }
        };
        /**
         * 第 i 段的**响应式取值**：内联调用 `segments()` 返回一个**具体分段值**（文本 + 配色角色）。
         * 依赖信号（`busy/injectOn/inputOn/mode`），故在渲染表达式中内联调用即保持响应式。
         */
        const seg = (i: number): SlotSegment => segments()[i] ?? { text: "", role: "separator" };
        // 静态结构 + 响应式内容：固定 6 个 `<text>`（顺序同 `formatSlotSegments`：图标/字形/模式/F8/分隔/F9），
        // 不再用 `<For>` 逐段重建，避免分段数组变化时节点被销毁/重建造成的闪烁。
        // **props 一律内联求值为具体值**：`fg` 传 `colorOf(...)` 得到的 `RGBA`、children 传字符串。
        // 切勿把访问器函数（`() => color`）当 prop 值传入——Solid 会包成 `Cell`，原生 `fg` setter
        // 只接受 `ArrayBufferView`（RGBA），收到 `Cell` 即抛 `ERR_INVALID_ARG_TYPE`（启动崩溃根因）。
        return (
          <>
            <text fg={colorOf(seg(0).role)}>{seg(0).text}</text>
            <text fg={colorOf(seg(1).role)}>{seg(1).text}</text>
            <text fg={colorOf(seg(2).role)}>{seg(2).text}</text>
            <text fg={colorOf(seg(3).role)}>{seg(3).text}</text>
            <text fg={colorOf(seg(4).role)}>{seg(4).text}</text>
            <text fg={colorOf(seg(5).role)}>{seg(5).text}</text>
          </>
        );
      },
    },
  });

  // 热键：F8=语音注入开关，F9=语音输入开关（均为点按，无冲突）。
  api.keymap.registerLayer({
    priority: 1000,
    commands: [
      {
        name: CMD_MODE_A,
        title: format(phrases.command.injectTitle, { key: INJECT_KEY_LABEL }),
        desc: phrases.command.injectDesc,
        category: "Voice",
        run() {
          void toggleMode("inject");
        },
      },
      {
        name: CMD_MODE_B,
        title: format(phrases.command.inputTitle, { key: INPUT_KEY_LABEL }),
        desc: phrases.command.inputDesc,
        category: "Voice",
        run() {
          void toggleMode("input");
        },
      },
    ],
    bindings: [
      { key: INJECT_KEY, cmd: CMD_MODE_A },
      { key: INPUT_KEY, cmd: CMD_MODE_B },
    ],
  });
};

const plugin: TuiPluginModule & { id: string } = {
  id: PLUGIN_ID,
  tui,
};

export default plugin;
