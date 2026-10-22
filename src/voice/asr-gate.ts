/**
 * **半双工静音门**：TTS 播放期间**丢弃** ASR final，掐断「朗读 → 麦克风 → 转文字 → 注入 → 再朗读」回环。
 *
 * 为什么需要（一手证据）：本机 AEC（回声消除）实测 **unsupported**——麦克风采集流录到了默认输出设备
 * 正在播放的 TTS，播放窗能量为独立基线的 **19.2 倍（25.7 dB）**，远超 3 倍（≈10 dB）判据；原始 dshow
 * 采集路径上没有生效的 AEC（报告：`.tmp/scratch/aec-probe-report.md`，2026-10-22）。
 * 故按既定口径走「播放时闭嘴」的**半双工**兜底：**识别照常跑**，只在**分发层**不消费结果
 * （runtime / ffmpeg 层不做任何静音，避免把「听不见」做进采集链）。
 *
 * 会话归属口径**只复用** `playback-state.ts` 的 `isInterruptablePlaybackActive(sessionID)`
 * （与 `stopPlayback`、F10 双态中断同一道归属门：只看**本会话键 + 无主 `_`** 条目，其它会话一律不算）。
 * 本模块**不读状态文件、不自造归属判断**，只承载「活跃 ∪ 尾音窗口」这一条纯条件，便于单测。
 *
 * 尾音窗口（{@link ASR_GATE_TAIL_MS}）：每次判活为真把窗口起点刷新为当刻，之后
 * `now - lastActiveAt < tailMs` 内仍算活跃——覆盖播放结束后的尾音与房间混响
 * （waveOut 队列约 160ms 预读 + 实测混响），避免「刚停就把剩下的尾音录进去」。
 *
 * 半双工代价（**预期行为，非缺陷**）：播放期间用户说话会被吞掉；要先说则按 F8/F9 或 F10
 * （两者都会 `stopPlayback` 停播，门随之自动释放）。
 */

/**
 * 播放结束后的**尾音缓冲**窗口（毫秒）：此窗口内的 ASR final 仍被丢弃。
 * 取值依据：内置 waveOut 播放器 EOF 后只播完已排队的 ≈160ms（`docs/ASYNC.md` 不变量），
 * 加上房间混响与「刚停就开口」的说话起始，500ms 足够覆盖且不至于把用户下一句吞太久。
 */
export const ASR_GATE_TAIL_MS = 500;

/**
 * 门条件：这条 ASR final 是否应当**丢弃**（播放活跃，或播放刚结束仍在尾音窗口内）。
 *
 * 纯函数、无副作用；活跃判定由调用方经 `isInterruptablePlaybackActive` 得出后传入，
 * 本函数不读状态文件、不认识会话（归属口径不在这里）。
 * @param playbackActive 本会话（或无主）当前是否有可中断的活跃播放
 * @param lastActiveAt 上一次判活为真的时刻（毫秒时间戳；`0`/非有限值 = 本进程从未观察到活跃）
 * @param now 当前时刻（毫秒时间戳）
 * @param tailMs 尾音窗口长度（毫秒；缺省 {@link ASR_GATE_TAIL_MS}，`<=0` 表示关闭尾音窗口）
 * @returns true = 丢弃该条 final；false = 照常分发
 */
export function shouldDropAsrFinal(
  playbackActive: boolean,
  lastActiveAt: number,
  now: number,
  tailMs: number = ASR_GATE_TAIL_MS,
): boolean {
  // 正在播：无条件丢（尾音窗口无关）
  if (playbackActive) return true;
  // 从未活跃过 / 非法时刻：没有可覆盖的尾巴，放行
  if (!Number.isFinite(lastActiveAt) || lastActiveAt <= 0) return false;
  if (!Number.isFinite(now) || !Number.isFinite(tailMs) || tailMs <= 0) return false;
  // 严格小于：恰好经过 tailMs 即放行；时钟回拨（now < lastActiveAt）差值为负 ⇒ 仍判在窗口内丢弃（保守取向）
  return now - lastActiveAt < tailMs;
}
