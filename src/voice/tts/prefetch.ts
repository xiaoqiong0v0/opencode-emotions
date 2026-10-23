/**
 * **自动朗读下一单元预取**（2026-10-22 第十四批，句间停顿优化·预取；
 * 2026-10-23 第十五批改为**边合成边交播**）。
 *
 * 背景（实测见 `.tmp/scratch/gap-analysis.md` 与用户 2026-10-23 实测日志）：现有播放单元 = 一个 CLI 进程
 * 「冷启动 + 合成 + 播放」，每单元重启约 1.65s（CLI 0.30s + TTFB 0.78s + 播放器就绪 0.57s）。
 * 第十四批让第 N+1 句在第 N 句播放期间**先合成落盘**；但合成**整段完成**才交播——长单元（105 字、
 * 合成 6s+）比上一句播放（3s）更久时，交播点仍要空等剩余合成时间（用户实测句间停顿 ≈4s）。
 *
 * 管线（合成与播放解耦，两进程各司其职，**不复制 provider 合成逻辑**）：
 * 1. `PrefetchUnit.start()` **同时**派生两个子进程：
 *    - `emotions-cli speak --text-file <t> --pcm-out <wav>`：provider 照常合成，`PcmFileSink` 只落盘
 *      （16bit PCM + WAV 容器，含同一套首尾静音裁剪）、**不播、不登记 `tts-playback`**；
 *    - `emotions-cli speak --pcm-file <wav> --pcm-follow`：立即预热播放器（打开设备，不写音频 ⇒ 无声），
 *      等 stdin 的 `go` 后**跟随文件增长**边到边读（见 `runPlayGrowingPcmFile`）。
 * 2. 第 N 句播完（CLI 退出 = 音频放完）→ `play()` 写 `go` → 第 N+1 句**立即**开始播放**已到达的部分**，
 *    不等整段合成完成；合成结束（成功/失败）后父进程再写控制行 `done`/`abort` 收尾。
 *
 * 顺序/取消/失败（并发契约见 `docs/ASYNC.md` 交互点 ⑳）：
 * - **严格顺序**：`play()` 只由播放链在上一单元退出后调用；播放进程在 `go` 之前不写任何音频；
 * - **打断即弃**：`cancel()` kill 两个子进程 + 删文件，幂等；子进程都登记进 auto-read 的
 *   `activeChildren`（`interrupt(sessionID)` / dispose 直接 kill，`cancel` 是兜底）；
 * - **失败降级**：合成在**交播前**失败/超时 ⇒ `play()` 返回 false，调用方退回**串行** `speak`
 *   （该句照常合成播放，不丢句、不阻塞后续）；
 * - **写端异常**：交播后合成失败/超时/被异常终止 ⇒ 播放进程按「已播部分 + 明确错误」退出
 *   （{@link PCM_PLAY_EXIT_PARTIAL}），**不重读**（避免重复），父进程记 warn；
 * - **防双播（硬约束）**：「是否已出声」只认**可判定的事实**——退出码 0（播完）/3（已播部分）必然
 *   已出声，stdout 标记仅作补充证据（可能丢/晚）；只有退出码 1（契约=从未起播）才允许串行重读，
 *   其余未知（如 `null`）一律按「已出声」处理并报错——**宁可漏播，也不重播**；
 * - **磁盘有界**：`PcmFileSink` **写盘不限**（单元正文 ≤ {@link DRAIN_MERGE_MAX_CHARS}，音频天然有界），
 *   播完/失败/取消即删文件；不再按 32MB/120s 截断（截断会让长单元在播放中途失败）。
 */

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Logger } from "@xiaoqiong0v0/opencode-plugin-logger";

import { autoTtsDataDir, TTS_TMP_DIR_NAME, type AutoTtsOptions } from "../auto-tts.js";
import { PLAYBACK_SESSION_ENV } from "../playback-state.js";
import {
  AWAIT_GO_LINE,
  PCM_FILE_FLAG,
  PCM_FOLLOW_ABORT_LINE,
  PCM_FOLLOW_DONE_LINE,
  PCM_FOLLOW_FLAG,
  PCM_OUT_FLAG,
  PCM_PLAY_EXIT_NOT_STARTED,
  PCM_PLAY_EXIT_PARTIAL,
  PCM_PLAY_STARTED_MARKER,
} from "../cli.js";

/** 预取深度默认值（1=只预取下一单元）。 */
export const PREFETCH_DEPTH_DEFAULT = 1;
/** 预取深度上限（本实现只支持 1；>1 一律夹到 1，避免多路并发合成抢带宽/CPU）。 */
export const PREFETCH_DEPTH_MAX = 1;
/** 预取深度环境变量（`0` 关闭；未设置=默认 1）。 */
export const ENV_PREFETCH_DEPTH = "TTS_PREFETCH_DEPTH";
/**
 * 单次预取合成超时（毫秒）：超时 kill 合成进程。
 * 交播前超时 ⇒ 该单元退回串行；交播后超时 ⇒ 播放进程按「已播部分 + 明确错误」收尾（不重读）。
 */
export const PREFETCH_TIMEOUT_MS = 30_000;
/** 预取播放进程 stderr 收集上限（字符数，防无界增长）。 */
export const PREFETCH_STDERR_LIMIT = 2048;

/**
 * 归一化预取深度：非法/缺失 → {@link PREFETCH_DEPTH_DEFAULT}，否则夹到 `[0, PREFETCH_DEPTH_MAX]`。
 * @param value 原始值
 * @returns 实际深度（0 = 关闭）
 */
export function normalizePrefetchDepth(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return PREFETCH_DEPTH_DEFAULT;
  const truncated = Math.trunc(value);
  return Math.min(PREFETCH_DEPTH_MAX, Math.max(0, truncated));
}

/**
 * 从环境变量解析预取深度（生产接线用；解析失败按默认值，不阻塞朗读）。
 * @param env 环境变量表（默认 process.env）
 * @returns 预取深度（0 = 关闭）
 */
export function resolvePrefetchDepth(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[ENV_PREFETCH_DEPTH]?.trim();
  if (!raw) return PREFETCH_DEPTH_DEFAULT;
  const parsed = Number(raw);
  return normalizePrefetchDepth(Number.isFinite(parsed) ? parsed : undefined);
}

/** 预取单元所需依赖（全部可注入以便离线单测）。 */
export interface PrefetchDeps {
  /** CLI 产物路径（`emotions-cli.js`）。 */
  cliPath: string;
  /** 派生 CLI 用的 Node 可执行文件。 */
  spawnBin: string;
  /** 派生函数（默认 `child_process.spawn`；测试注入假 child）。 */
  spawnFn: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  /** 插件日志器。 */
  log: Logger;
  /** 数据目录选项（临时 PCM/正文落在 `<dataDir>/tts/`）。 */
  paths: AutoTtsOptions;
  /** 子进程归属登记（供 `interrupt(sessionID)` 按会话 kill）。 */
  attach: (child: ChildProcess) => void;
  /** 子进程退出/错误后摘除归属。 */
  detach: (child: ChildProcess) => void;
  /** 合成超时（毫秒）；缺省 {@link PREFETCH_TIMEOUT_MS}。 */
  timeoutMs?: number;
}

/** 预取单元内部状态（日志/排查用）。 */
export type PrefetchState = "idle" | "synth" | "ready" | "playing" | "failed" | "cancelled";

/** 模块内自增序号（仅用于临时文件名防碰撞；跨消息靠 uuid）。 */
let prefetchSeq = 0;

/**
 * 把消息 id 规整为安全文件名片段。
 * @param id 原始 id
 * @returns 安全片段
 */
function sanitizeId(id: string): string {
  return id.replace(/[^\w.-]/g, "_");
}

/**
 * 一个**边合成边交播**的朗读单元。
 *
 * 生命周期：`new → start()（合成 + 预热播放进程并行）→ ready → play()（go → done/abort）→ 清理`；
 * 任一步失败/`cancel()` 都会 kill 子进程并删除临时文件（幂等）。
 */
export class PrefetchUnit {
  /** 该单元正文（从待读队列提前摘走的那段，顺序不可变）。 */
  readonly text: string;
  private readonly messageID: string;
  private readonly sessionID: string;
  private readonly deps: PrefetchDeps;
  private readonly pcmPath: string;
  private readonly textPath: string;
  private readonly readyPromise: Promise<boolean>;
  private resolveReady!: (ok: boolean) => void;
  private readySettled = false;
  /** 合成进程结束（`true`=退出码 0）。交播后据此写 `done`/`abort`。 */
  private readonly synthExit: Promise<boolean>;
  private resolveSynth!: (ok: boolean) => void;
  private synthSettled = false;
  private synthOk = false;
  private state: PrefetchState = "idle";
  private started = false;
  private cancelled = false;
  private synth: ChildProcess | null = null;
  private playChild: ChildProcess | null = null;
  private playExit: Promise<number | null> | null = null;
  /** 播放进程是否已打印「开始出声」标记（**补充证据**：标记可能丢/晚，主判据是退出码）。 */
  private playStarted = false;
  private timer: NodeJS.Timeout | undefined;

  /**
   * @param deps 依赖（CLI 路径/派生函数/日志/临时目录/子进程归属）
   * @param text 待朗读正文（非空；调用方已 trim）
   * @param messageID 消息 id（文件名与日志）
   * @param sessionID 消息所属会话 id（env `EMOTIONS_SESSION_ID`，跨会话打断隔离）
   */
  constructor(deps: PrefetchDeps, text: string, messageID: string, sessionID: string) {
    this.deps = deps;
    this.text = text;
    this.messageID = messageID;
    this.sessionID = sessionID;
    const dir = join(autoTtsDataDir(deps.paths), TTS_TMP_DIR_NAME);
    const base = `${sanitizeId(messageID)}-${prefetchSeq++}-${randomUUID()}`;
    this.pcmPath = join(dir, `${base}.pcm.wav`);
    this.textPath = join(dir, `${base}.txt`);
    this.readyPromise = new Promise<boolean>((resolve) => {
      this.resolveReady = resolve;
    });
    this.synthExit = new Promise<boolean>((resolve) => {
      this.resolveSynth = resolve;
    });
  }

  /** 当前状态（日志/单测断言）。 */
  get status(): PrefetchState {
    return this.state;
  }

  /** 播放进程已就绪（可交播）时为 true；合成**不必**完成。 */
  get ready(): Promise<boolean> {
    return this.readyPromise;
  }

  /**
   * 启动预取：写正文临时文件 → **并行**派生「只合成不出声」与「跟随增长播放」两个 CLI。
   *
   * 播放进程与合成同时启动，使 `prewarm()`（打开设备/加载编译缓存）与合成重叠——交播点只需
   * 写 `go`，不再为进程冷启动/设备就绪额外等待。
   * 幂等（重复调用无副作用）；失败走 `fail()`（ready=false + 清理）。
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.state = "synth";
    try {
      mkdirSync(join(autoTtsDataDir(this.deps.paths), TTS_TMP_DIR_NAME), { recursive: true });
      writeFileSync(this.textPath, this.text, "utf8");
    } catch (err) {
      this.fail("写预取正文失败", err);
      return;
    }
    this.startPlayer();
    this.startSynth();
    this.deps.log.info(`自动朗读预取开始：message=${this.messageID} len=${this.text.length}`);
  }

  /**
   * 交播：给预热好的播放进程写 `go` → 等合成结束 → 写 `done`/`abort` 收尾。
   *
   * **不等整段合成完成**：`go` 一写，播放进程立即开始播放已落盘的部分（跟随文件增长）。
   * 调用方必须先保证**上一单元已播完**（本类不做顺序判定，只负责「不早于 go 出声」）。
   * @returns `true`=本句已由预取进程播放（含播放中写端异常：**不再重读**以免重复）；
   *   `false`=预取进程**确定从未起播**（退出码 {@link PCM_PLAY_EXIT_NOT_STARTED}）⇒ 调用方必须
   *   退回串行 `speak` 且**只重试一次**；无法确认时按已播处理（**绝不双播**）
   */
  async play(): Promise<boolean> {
    if (this.cancelled || this.failedState()) return false;
    const ok = await this.readyPromise;
    if (!ok || this.cancelled || this.failedState()) return false;
    // 合成在交播前就失败：整句退回串行（此时还没出声，重读不会重复）
    if (this.synthSettled && !this.synthOk) {
      this.cancel();
      return false;
    }
    const child = this.playChild;
    const exited = this.playExit;
    if (!child?.stdin || !exited) return false;
    this.state = "playing";
    try {
      child.stdin.write(`${AWAIT_GO_LINE}\n`);
    } catch (err) {
      this.deps.log.warn(`自动朗读预取交播失败：message=${this.messageID}`, err as Error);
      this.cancel();
      return false;
    }
    // 合成可能仍在进行（正常路径）：播放端已在跟随增长读，这里只等写端收尾信号
    const synthOk = await this.synthExit;
    try {
      child.stdin.write(`${synthOk ? PCM_FOLLOW_DONE_LINE : PCM_FOLLOW_ABORT_LINE}\n`);
      child.stdin.end();
    } catch {
      // stdin 已断（播放进程提前退出）：等 exited 结算即可
    }
    const code = await exited;
    this.cleanupFiles();
    if (code === PCM_PLAY_EXIT_PARTIAL) {
      this.deps.log.warn(
        `自动朗读预取写端异常，本单元只播出已到达部分（不重读）：message=${this.messageID}`,
      );
      return true;
    }
    if (code !== 0) {
      this.deps.log.warn(`自动朗读预取播放进程异常退出：message=${this.messageID} code=${code ?? "-"}`);
    }
    // ★ 防双播判定：只认**可判定的事实**。标记可能丢/晚（曾被当成「从未起播」而重播 → 双播），
    //   退出码 0（正常播完）/3（已播部分后写端异常）由 CLI 契约保证**必然已出声**。
    if (this.cancelled) {
      // 已取消/被打断：语义=丢弃，绝不重读（否则会在打断后再出声一次）
      return true;
    }
    if (this.playStarted || code === 0) return true;
    if (code === PCM_PLAY_EXIT_NOT_STARTED) {
      // 契约上的「从未起播」= 唯一可以安全重试的情形；调用方（playPrefetched）只重试一次
      return false;
    }
    // 未知（`null`/其它退出码）：无法证明没出声 ⇒ 按已播处理并报错，宁可漏播也不重播
    this.deps.log.warn(
      `自动朗读预取播放进程退出码未知（${code ?? "-"}），无法确认是否已出声：message=${this.messageID}` +
        "（按已播处理，不重播以防双播）",
    );
    return true;
  }

  /**
   * 取消：kill 合成/播放子进程、删临时文件、ready 置 false（幂等；打断/开关关/dispose 共用）。
   * 已交播（正在出声）时 kill 播放进程 = 立即静音（残余 ≤ waveOut 预读 ≈160ms）。
   */
  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.state = "cancelled";
    this.clearTimer();
    this.killChild(this.synth);
    this.killChild(this.playChild);
    this.synth = null;
    this.playChild = null;
    // 解开可能仍在等合成结束的 `play()`（否则打断后 drain 会挂在这里）
    this.settleSynth(false);
    this.settleReady(false);
    this.cleanupFiles();
    this.deps.log.info(`自动朗读预取消：message=${this.messageID} len=${this.text.length}`);
  }

  /** 派生**只合成不出声**的 CLI（`--pcm-out`）。 */
  private startSynth(): void {
    let child: ChildProcess;
    try {
      child = this.deps.spawnFn(
        this.deps.spawnBin,
        [this.deps.cliPath, "speak", "--text-file", this.textPath, PCM_OUT_FLAG, this.pcmPath],
        {
          stdio: ["ignore", "ignore", "pipe"],
          windowsHide: true,
          env: { ...process.env, [PLAYBACK_SESSION_ENV]: this.sessionID },
        },
      );
    } catch (err) {
      this.fail("派生预取合成进程失败", err);
      return;
    }
    this.synth = child;
    this.deps.attach(child);
    const stderr = this.collectStderr(child);
    const timeoutMs = this.deps.timeoutMs ?? PREFETCH_TIMEOUT_MS;
    this.timer = setTimeout(() => {
      this.deps.log.warn(`自动朗读预取超时：message=${this.messageID} timeoutMs=${timeoutMs}`);
      this.killChild(child);
      this.settleSynth(false);
      // 交播前超时：整句退回串行；交播后超时：播放进程会收到 abort，按已播部分收尾。
      // 用状态而非 stdout 标记判定「是否已交播」（标记可能丢/晚，不能作为控制依据）。
      if (this.state !== "playing") this.fail("预取合成超时");
    }, timeoutMs);
    this.timer.unref?.();
    child.once("exit", (code) => {
      this.deps.detach(child);
      if (this.synth === child) this.synth = null;
      this.clearTimer();
      const ok = code === 0;
      this.settleSynth(ok);
      if (this.cancelled) return;
      if (ok) return;
      const detail = stderr.snippet() ? ` stderr=${stderr.snippet()}` : "";
      if (this.state === "playing") {
        // 已开始边播边合成：交给播放进程按「已播部分 + 明确错误」收尾（不得静默当完整）
        this.deps.log.warn(
          `自动朗读预取合成未完成（播放按已到达部分收尾）：message=${this.messageID} code=${code ?? "-"}${detail}`,
        );
        return;
      }
      this.fail(`预取合成进程退出码=${code ?? "-"}${detail}`);
    });
    child.once("error", (err) => {
      this.deps.detach(child);
      if (this.synth === child) this.synth = null;
      this.settleSynth(false);
      if (this.cancelled || this.state === "playing") return;
      this.fail("预取合成进程错误", err);
    });
  }

  /** 派生**跟随增长播放**的 CLI（`--pcm-file --pcm-follow`），并立即预热播放器。 */
  private startPlayer(): void {
    let child: ChildProcess;
    try {
      child = this.deps.spawnFn(
        this.deps.spawnBin,
        [this.deps.cliPath, "speak", PCM_FILE_FLAG, this.pcmPath, PCM_FOLLOW_FLAG],
        {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          env: { ...process.env, [PLAYBACK_SESSION_ENV]: this.sessionID },
        },
      );
    } catch (err) {
      this.fail("派生预取播放进程失败", err);
      return;
    }
    this.playChild = child;
    this.deps.attach(child);
    const stderr = this.collectStderr(child);
    // stdout 只认「开始出声」标记（播放进程在真正写音频前打印）；用于区分「没起播」与「播完」
    child.stdout?.setEncoding("utf8");
    let stdoutBuf = "";
    child.stdout?.on("data", (chunk: string) => {
      if (this.playStarted) return;
      stdoutBuf += chunk;
      if (stdoutBuf.includes(PCM_PLAY_STARTED_MARKER)) this.playStarted = true;
    });
    this.playExit = new Promise<number | null>((resolve) => {
      let settled = false;
      const settle = (code: number | null): void => {
        if (settled) return;
        settled = true;
        resolve(code);
      };
      // 用 close（stdio 已读尽）而非 exit：确保「开始出声」标记先于结算送达，避免误判「未起播」
      child.once("close", (code) => {
        this.deps.detach(child);
        if (this.playChild === child) this.playChild = null;
        if (!this.cancelled && code !== 0 && code !== PCM_PLAY_EXIT_PARTIAL) {
          const snippet = stderr.snippet();
          this.deps.log.warn(
            `自动朗读预取播放进程退出：message=${this.messageID} code=${code ?? "-"}` + (snippet ? ` stderr=${snippet}` : ""),
          );
        }
        settle(code);
      });
      child.once("error", (err) => {
        this.deps.detach(child);
        if (this.playChild === child) this.playChild = null;
        this.deps.log.warn(`自动朗读预取播放进程错误：message=${this.messageID}`, err);
        settle(null);
      });
    });
    this.state = "ready";
    this.settleReady(true);
  }

  /**
   * 失败收尾：kill 残留子进程、删文件、ready 置 false（幂等）。
   * @param reason 日志原因
   * @param err 可选异常
   */
  private fail(reason: string, err?: unknown): void {
    if (this.cancelled || this.state === "failed") return;
    this.clearTimer();
    this.killChild(this.synth);
    this.killChild(this.playChild);
    this.synth = null;
    this.playChild = null;
    this.state = "failed";
    this.settleSynth(false);
    this.cleanupFiles();
    this.settleReady(false);
    const detail = err instanceof Error ? `: ${err.message}` : "";
    this.deps.log.warn(`自动朗读预取失败（该单元退回串行）：message=${this.messageID} reason=${reason}${detail}`);
  }

  /** 收取子进程 stderr（有界；退出日志带片段）。 */
  private collectStderr(child: ChildProcess): { snippet: () => string } {
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < PREFETCH_STDERR_LIMIT) stderr += chunk;
    });
    return { snippet: () => stderr.trim().slice(0, 200) };
  }

  /** 是否已进入失败终态（方法形式避免 TS 跨 await 的类型收窄）。 */
  private failedState(): boolean {
    return this.state === "failed";
  }

  /** 结算合成结果（只结算一次）。 */
  private settleSynth(ok: boolean): void {
    if (this.synthSettled) return;
    this.synthSettled = true;
    this.synthOk = ok;
    this.resolveSynth(ok);
  }

  /** 结算 ready（只结算一次）。 */
  private settleReady(ok: boolean): void {
    if (this.readySettled) return;
    this.readySettled = true;
    this.resolveReady(ok);
  }

  /** 清理定时器（幂等）。 */
  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /** kill 一个子进程（已退出/无权限静默）。 */
  private killChild(child: ChildProcess | null): void {
    if (!child) return;
    try {
      child.kill();
    } catch {
      // 已退出/无权限忽略
    }
  }

  /** 删除临时正文与 PCM 文件（静默失败；Windows 上播放器未释放句柄时留给系统清理）。 */
  private cleanupFiles(): void {
    for (const path of [this.textPath, this.pcmPath]) {
      try {
        rmSync(path, { force: true });
      } catch {
        // 删除失败忽略（系统临时目录会定期清理）
      }
    }
  }
}
