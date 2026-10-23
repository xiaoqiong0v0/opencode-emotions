/**
 * 语音运行时的「优雅停止」通道（信号 / 秒数上限 / 父进程 stdin）。
 *
 * 为什么需要 stdin 通道（2026-10-22 审计根因）：TUI 正常停止走 `child.kill()`（默认 SIGTERM），
 * 而 **Windows 上 Node 无法捕获 SIGTERM**（`process.on("SIGTERM")` 永不触发，kill 等价
 * `TerminateProcess`）——只注册信号处理器并不能让 win32 的 TUI 收尾，于是 segment 链路的最后
 * 一整段被 `close()` 清掉、每次停止都丢最后一句。故：
 * - **POSIX**：SIGINT / SIGTERM 都走同一条优雅收尾；
 * - **win32**：额外注册 SIGBREAK（Ctrl+Break 可捕获）；TUI 场景改用 **stdin 上的 `stop` 行**
 *   （或父进程关闭 stdin 的 EOF）触发，`kill()` 降级为超时兜底（见 `src/tui.tsx` `stopRuntime`）。
 *   stdin 通道**只对被 pipe 的 stdin 启用**（Node 里是 `net.Socket`）：`stdio:"ignore"`/继承的
 *   null 设备会立即 EOF，若也当作停止会让脚本化调用一启动就退出（审计脚本实测）。
 *
 * 收敛语义：任一来源先到即 `resolve`，**幂等**（重复信号/数据/EOF 只算一次），并立即摘除全部
 * 监听与定时器（防止 `--seconds` 的残留定时器把进程拖到秒数结束）。
 */

import { Socket } from "node:net";

/** stdin 停止令牌（父进程写入该行即请求优雅停止）。 */
export const STOP_STDIN_TOKEN = "stop";

/**
 * stdin 停止通道所需的最小结构（`process.stdin` 与测试注入的 Readable 都满足）。
 * 只声明用到的成员，避免把 Node 的重载签名带进可注入依赖。
 */
export interface StopStdin {
  /** 是否交互终端（TTY 下不启用 stdin 通道，避免打字被当作停止）。 */
  readonly isTTY?: boolean;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
  /** 释放 stdin 句柄引用（停止后不再拖住事件循环）。 */
  pause?(): unknown;
  unref?(): void;
}

/** 停止控制器选项（全部可注入，便于离线单测）。 */
export interface StopControllerOptions {
  /** 秒数上限（有限正数才生效；到点自动收尾）。 */
  seconds?: number;
  /** stdin 停止通道；缺省 `process.stdin`，传 `null` 关闭该通道。 */
  stdin?: StopStdin | null;
  /** 信号集合；缺省 {@link platformStopSignals}（win32 = SIGINT/SIGTERM/SIGBREAK）。 */
  signals?: readonly NodeJS.Signals[];
  /** 目标平台；缺省 `process.platform`（仅用于默认信号集合）。 */
  platform?: NodeJS.Platform;
}

/** 停止控制器（`stopped` 等待、`finish` 主动触发、`dispose` 只清理不触发）。 */
export interface StopController {
  /** 任一停止来源到达（或调用 `finish()`）后 resolve；多次触发只 resolve 一次。 */
  readonly stopped: Promise<void>;
  /** 主动请求停止（幂等；采集异常退出等内部路径也用它收敛等待）。 */
  finish(): void;
  /** 摘除监听与定时器（不 resolve；正常路径由 `finish()` 内部调用）。 */
  dispose(): void;
}

/**
 * 按平台给出可捕获的停止信号集合。
 * @param platform 目标平台（默认 `process.platform`）
 * @returns 信号名数组（win32 追加 SIGBREAK；POSIX 用 SIGINT/SIGTERM）
 */
export function platformStopSignals(platform: NodeJS.Platform = process.platform): NodeJS.Signals[] {
  if (platform === "win32") return ["SIGINT", "SIGTERM", "SIGBREAK"];
  // POSIX：SIGHUP 也按优雅收尾处理（终端/会话关闭等同于停止）
  return ["SIGINT", "SIGTERM", "SIGHUP"];
}

/**
 * 创建停止控制器：注册信号 / （非 TTY 时）stdin 令牌与 EOF / 可选秒数定时器。
 * @param options 可注入选项
 * @returns 停止控制器
 */
export function createStopController(options: StopControllerOptions = {}): StopController {
  const stdin = options.stdin === undefined ? (process.stdin as unknown as StopStdin) : options.stdin;
  const signals = options.signals ?? platformStopSignals(options.platform);
  const cleanups: Array<() => void> = [];
  let finished = false;
  let disposed = false;
  let timer: NodeJS.Timeout | undefined;
  let resolveStopped: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });

  /** 摘除全部监听/定时器（幂等，绝不抛错）。 */
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    if (timer !== undefined) clearTimeout(timer);
    for (const cleanup of cleanups.splice(0)) {
      try {
        cleanup();
      } catch {
        // 清理失败忽略：不得因收尾动作打断主流程
      }
    }
  };

  /** 请求停止（幂等）。 */
  const finish = (): void => {
    if (finished) return;
    finished = true;
    dispose();
    resolveStopped();
  };

  for (const signal of signals) {
    const handler = (): void => finish();
    try {
      process.on(signal, handler);
      cleanups.push(() => process.off(signal, handler));
    } catch {
      // 该平台不认识这个信号名：跳过（不影响其它来源）
    }
  }

  // stdin 通道：TUI/脚本 spawn 时 stdio 为 pipe（非 TTY，Node 侧是 net.Socket）⇒ 接受 "stop" 行；
  // 父进程退出（EOF）同样收尾。显式注入的 stdin 不受此限制（单测用）。
  const stdinIsPipe = options.stdin !== undefined || stdin instanceof Socket;
  if (stdin && stdin.isTTY !== true && stdinIsPipe) {
    const stream = stdin;
    const onData = (...args: unknown[]): void => {
      const chunk = args[0];
      if (String(chunk).trim().toLowerCase() === STOP_STDIN_TOKEN) finish();
    };
    const onEnd = (): void => finish();
    try {
      stream.on("data", onData);
      stream.on("end", onEnd);
      stream.on("close", onEnd);
      cleanups.push(() => {
        stream.removeListener("data", onData);
        stream.removeListener("end", onEnd);
        stream.removeListener("close", onEnd);
        // 释放 stdin 引用：否则父进程保持管道打开时本进程无法自然退出
        try {
          stream.pause?.();
        } catch {
          // 忽略
        }
        try {
          stream.unref?.();
        } catch {
          // 忽略
        }
      });
    } catch {
      // stdin 不可读（已被别处接管等）：仅依赖信号/秒数
    }
  }

  if (typeof options.seconds === "number" && Number.isFinite(options.seconds) && options.seconds > 0) {
    timer = setTimeout(finish, options.seconds * 1000);
  }

  return { stopped, finish, dispose };
}
