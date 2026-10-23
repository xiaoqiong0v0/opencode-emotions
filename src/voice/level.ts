/**
 * 16bit PCM 能量口径（RMS / dBFS）的**单源**纯函数。
 *
 * 用途：
 * - 按段 ASR 的能量静音切段（`src/voice/asr/segment.ts`，30ms 短帧判定）；
 * - TTS 输出的首尾静音裁剪（`src/voice/tts/silence-trim.ts`，同样 10ms 短帧判定）。
 *
 * 抽到本模块是为了让「静音判定」共用同一套口径（RMS→dBFS），不各写一份、
 * 也不让 TTS 依赖 ASR 模块（两条链路互不影响：本模块无状态、无 IO）。
 */

/**
 * 计算 16bit PCM 分片的 RMS（归一到 [0,1]，与 `config.vad.threshold` 的 [-1,1] 量级可比）。
 * @param pcm s16le 字节流（奇数尾字节忽略）
 * @returns RMS；空分片返回 0
 */
export function pcmRms(pcm: Buffer): number {
  const count = Math.floor(pcm.length / 2);
  if (count === 0) return 0;
  let sum = 0;
  for (let i = 0; i < count; i += 1) {
    const sample = pcm.readInt16LE(i * 2) / 32768;
    sum += sample * sample;
  }
  return Math.sqrt(sum / count);
}

/**
 * 把线性 RMS 转成 dBFS（满量程 1.0 = 0 dBFS）；0/负数返回 -Infinity。
 * @param rms 线性 RMS（[0,1]）
 * @returns dBFS（≤0；0 为 -Infinity）
 */
export function rmsToDbfs(rms: number): number {
  return rms > 0 ? 20 * Math.log10(rms) : Number.NEGATIVE_INFINITY;
}
