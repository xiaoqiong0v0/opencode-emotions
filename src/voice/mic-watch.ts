/**
 * 麦克风**无声提示**的判定逻辑（纯函数/纯状态机，时间可注入，便于离线单测）。
 *
 * 背景：设备枚举成功、采集进程也在出流，但用户选错设备 / 系统静音 / 增益为 0 时，
 * 运行时仍然「假装在听」。这里在采集开始后的观察窗口内跟踪 RMS 峰值，窗口结束时若峰值
 * 仍低于阈值就**只报一次** warning（`{type:"warning"}` + stderr 一行），避免刷屏。
 *
 * 与 `voice/meter.ts` 的分工：meter 只做电平归类渲染，本模块只做一次性告警判定，互不依赖。
 */

/** 观察窗口时长（毫秒）：自首个采样块起算。 */
export const SILENCE_PROBE_MS = 3000;
/** 判定「没有声音」的 RMS 阈值（16bit 归一化后；安静房间的底噪通常远高于此）。 */
export const SILENCE_RMS_THRESHOLD = 1e-4;
/**
 * 静音告警的**内部**中文文案（日志/诊断用；用户可见文案按 `uiLanguage` 由
 * `lib/i18n.ts` 的 `runtimeErrorText(MIC_SILENT_CODE, …)` 渲染）。
 */
export const MIC_SILENCE_WARNING = "麦克风似乎没有声音（RMS≈0），请检查静音、增益或是否选错设备";

/** 观察器配置（全部可注入；缺省用上面的常量）。 */
export interface SilenceWatchOptions {
  /** 观察窗口时长（毫秒）。 */
  probeMs?: number;
  /** 判定阈值（RMS）。 */
  thresholdRms?: number;
}

/** 静音观察器。 */
export interface SilenceWatch {
  /**
   * 喂入一个采样块的 RMS（与当前时刻）。
   * @param rms 该块 RMS（已归一化）
   * @param nowMs 当前时刻（毫秒）
   * @returns 需要告警时 true（**整个生命周期最多一次**）
   */
  observe(rms: number, nowMs: number): boolean;
}

/**
 * 创建静音观察器。
 *
 * 窗口起点取**首次 observe 的时刻**（首个采样块到达才真正开始采集）；
 * 窗口内记录 RMS 峰值，窗口到时（`nowMs - startMs >= probeMs`）判定一次：
 * 峰值 < 阈值 ⇒ 返回 true 并置位，之后无论再喂什么都不再返回 true。
 * @param options 观察窗口配置
 * @returns 观察器
 */
export function createSilenceWatch(options: SilenceWatchOptions = {}): SilenceWatch {
  const probeMs = options.probeMs ?? SILENCE_PROBE_MS;
  const thresholdRms = options.thresholdRms ?? SILENCE_RMS_THRESHOLD;
  let startMs: number | null = null;
  let maxRms = 0;
  let notified = false;

  return {
    observe(rms: number, nowMs: number): boolean {
      if (notified) return false;
      if (startMs === null) startMs = nowMs;
      if (Number.isFinite(rms) && rms > maxRms) maxRms = rms;
      if (nowMs - startMs < probeMs) return false;
      // 窗口结束：无论结果如何都只判定一次（避免静音时每块都告警）
      notified = true;
      return maxRms < thresholdRms;
    },
  };
}
