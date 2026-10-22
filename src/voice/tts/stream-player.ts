/**
 * **流式 PCM 播放器**：把「从 stdin 读入裸 PCM（s16le 单声道）边收边放」与具体平台解耦。
 *
 * 与 `player.ts`（播本地文件）互补：本模块只负责「能吃 stdin 的命令」。
 * 候选（取第一个可用）：
 * - Windows：**内置 waveOut 播放器**（`pwsh`/`powershell` + `Add-Type` 内联 C# 调 winmm
 *   `waveOutOpen`/`Prepare`/`Write`/`Reset`/`Close`，环形队列边读边播、零外部依赖）→ 其次 `ffplay`
 * - Linux：`aplay -f S16_LE -r <sr> -c1 -t raw -` → `paplay --raw --format=s16le …` →
 *   `play`(sox) `-t raw -b 16 -e signed -r <sr> -c 1 -` → `ffplay … -i -`
 * - macOS / Termux：`play`(sox) → `ffplay`（`play-audio` 只能放文件，不能流式）
 * - 显式覆盖：环境变量 `TTS_PLAYER`（仅当取值为已知的流式播放器 id 时生效）
 *
 * 探测为纯函数式（`isAvailable` 可注入），便于离线单测；**无可用时返回 null**（由 `audio-sink.ts`
 * 决定回退到「按句分段临时 WAV 顺序播放」或报清晰错误）。
 */

import { commandExists, isTermux, POWERSHELL_BINS } from "../platform.js";

// 显式覆盖播放器的环境变量：单源在 `player.ts`（文件播放器与流式播放器共用同一 `TTS_PLAYER`）。
export { ENV_TTS_PLAYER } from "./player.js";
import { ENV_TTS_PLAYER } from "./player.js";

/** 流式播放器 id。 */
export const STREAM_PLAYER_IDS = ["waveout", "aplay", "paplay", "sox-play", "ffplay"] as const;
export type StreamPlayerId = (typeof STREAM_PLAYER_IDS)[number];

/** `TTS_PLAYER` 可能写的别名 → 流式播放器 id。 */
const STREAM_PLAYER_ALIASES: Readonly<Record<string, StreamPlayerId>> = {
  waveout: "waveout",
  winmm: "waveout",
  aplay: "aplay",
  paplay: "paplay",
  play: "sox-play",
  sox: "sox-play",
  "sox-play": "sox-play",
  ffplay: "ffplay",
};

/** Windows 内置播放器候选可执行文件（`POWERSHELL_BINS` 单源：`pwsh` 7 优先、回退 Windows PowerShell 5.1）。 */
const WAVEOUT_BINS = POWERSHELL_BINS;
/** 裸 PCM 声道数（与 CosyVoice 流式输出一致：单声道）。 */
const WAVEOUT_CHANNELS = 1;
/** 编译产物缓存键（改动内联 C# 时须同步递增，避免命中旧 DLL）。 */
const WAVEOUT_CACHE_KEY = "v2";
/**
 * waveOut 预读缓冲参数（内联 C#）：**40ms/块 × 最多 4 块 ≈ 160ms 队列上限**。
 * - 队列过深（旧值 8×16KB≈2.7s@24kHz）→ CLI 被杀后 stdin EOF，孙进程把已排队音频播完 = 长尾音；
 * - 过浅 → stdin 到达抖动时欠载断续。40ms/块（24kHz 单声道 ≈1.9KB）syscall 开销可忽略，
 *   4 块=160ms 既满足「EOF 后 ~150ms 内静音」又留一个块的抖动余量。
 */
const WAVEOUT_CHUNK_MS = 40;
/** waveOut 队列深度（块数）；与 `WAVEOUT_CHUNK_MS` 相乘即预读上限。 */
const WAVEOUT_MAX_PENDING = 4;

/**
 * Windows 内置 waveOut 播放器的 PowerShell 脚本（前缀）。
 *
 * 机制：`Add-Type` 内联 C# 声明 winmm P/Invoke；`Play(sampleRate, channels)` 从 **stdin** 读裸 PCM，
 * 以**小缓冲有界队列**（≤{@link WAVEOUT_MAX_PENDING} 个 `WAVEHDR`，每块 ≈{@link WAVEOUT_CHUNK_MS}ms，
 * 合计 ≈160ms 预读）边读边 `waveOutWrite`，**连续无间隙**；EOF（CLI 被杀 → stdin 断）后只把
 * 这 ≈160ms 内已排队的缓冲播完即退出（消长尾音）；Ctrl+C 经 `Console.CancelKeyPress` 同样先
 * Reset+Close 再退出。优先把 C# 编译成临时 DLL 缓存复用（首句更快），失败则退回内存编译（仍可用）。
 * 由 `buildWaveOutScript()` 追加 `exit [WaveOutRaw]::Play(<sr>, <ch>)` 后作为 `pwsh -Command` 传入。
 */
export const WAVEOUT_SCRIPT = `$ErrorActionPreference = 'Stop'
$src = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

public static class WaveOutRaw
{
    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    public struct WAVEFORMATEX
    {
        public ushort wFormatTag;
        public ushort nChannels;
        public uint nSamplesPerSec;
        public uint nAvgBytesPerSec;
        public ushort nBlockAlign;
        public ushort wBitsPerSample;
        public ushort cbSize;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct WAVEHDR
    {
        public IntPtr lpData;
        public uint dwBufferLength;
        public uint dwBytesRecorded;
        public IntPtr dwUser;
        public uint dwFlags;
        public uint dwLoops;
        public IntPtr lpNext;
        public IntPtr reserved;
    }

    const int WAVE_MAPPER = -1;
    const uint WHDR_DONE = 0x00000001;
    static IntPtr g_hwo = IntPtr.Zero;

    [DllImport("winmm.dll")] static extern int waveOutOpen(out IntPtr hwo, int uDeviceID, ref WAVEFORMATEX pwfx, IntPtr dwCallback, IntPtr dwInstance, int fdwOpen);
    [DllImport("winmm.dll")] static extern int waveOutPrepareHeader(IntPtr hwo, IntPtr pwh, int cbwh);
    [DllImport("winmm.dll")] static extern int waveOutUnprepareHeader(IntPtr hwo, IntPtr pwh, int cbwh);
    [DllImport("winmm.dll")] static extern int waveOutWrite(IntPtr hwo, IntPtr pwh, int cbwh);
    [DllImport("winmm.dll")] static extern int waveOutReset(IntPtr hwo);
    [DllImport("winmm.dll")] static extern int waveOutClose(IntPtr hwo);

    static readonly int HdrSize = Marshal.SizeOf(typeof(WAVEHDR));

    public static int Play(int sampleRate, int channels)
    {
        if (sampleRate <= 0 || channels <= 0) { Console.Error.WriteLine("bad args"); return 2; }
        WAVEFORMATEX fmt = new WAVEFORMATEX();
        fmt.wFormatTag = 1; fmt.nChannels = (ushort)channels; fmt.nSamplesPerSec = (uint)sampleRate;
        fmt.wBitsPerSample = 16; fmt.nBlockAlign = (ushort)(channels * 2);
        fmt.nAvgBytesPerSec = (uint)(sampleRate * channels * 2); fmt.cbSize = 0;
        IntPtr hwo;
        int rc = waveOutOpen(out hwo, WAVE_MAPPER, ref fmt, IntPtr.Zero, IntPtr.Zero, 0);
        if (rc != 0) { Console.Error.WriteLine("waveOutOpen rc=" + rc); return 3; }
        g_hwo = hwo;
        Console.CancelKeyPress += delegate(object s, ConsoleCancelEventArgs e) {
            e.Cancel = true;
            try { waveOutReset(g_hwo); waveOutClose(g_hwo); } catch {}
            Environment.Exit(0);
        };

        int blockAlign = channels * 2;
        // 小缓冲分块喂：块大小按时长算（≈${WAVEOUT_CHUNK_MS}ms），队列深度 ${WAVEOUT_MAX_PENDING} 块
        // （≈160ms 上限）——CLI 被杀后 stdin EOF，孙进程只把已排队的 ≈160ms 播完即退出（消长尾音）；
        // 块不小于 blockAlign 且对齐到 blockAlign，避免拆散采样点。
        int chunk = sampleRate * channels * 2 * ${WAVEOUT_CHUNK_MS} / 1000;
        if (chunk < blockAlign) chunk = blockAlign;
        else chunk -= chunk % blockAlign;
        int maxPending = ${WAVEOUT_MAX_PENDING};
        var pending = new List<IntPtr[]>();
        var stdin = Console.OpenStandardInput();
        byte[] readBuf = new byte[chunk];
        int carry = 0;
        bool failed = false;
        try
        {
            while (true)
            {
                for (int i = pending.Count - 1; i >= 0; i--)
                {
                    WAVEHDR h = (WAVEHDR)Marshal.PtrToStructure(pending[i][1], typeof(WAVEHDR));
                    if ((h.dwFlags & WHDR_DONE) != 0)
                    {
                        waveOutUnprepareHeader(hwo, pending[i][1], HdrSize);
                        Marshal.FreeHGlobal(pending[i][0]);
                        Marshal.FreeHGlobal(pending[i][1]);
                        pending.RemoveAt(i);
                    }
                }
                if (pending.Count >= maxPending) { Thread.Sleep(2); continue; }
                int n = stdin.Read(readBuf, carry, readBuf.Length - carry);
                if (n <= 0) break;
                int total = carry + n;
                int usable = total - (total % blockAlign);
                if (usable <= 0) { carry = total; continue; }
                IntPtr data = Marshal.AllocHGlobal(usable);
                Marshal.Copy(readBuf, 0, data, usable);
                IntPtr hdr = Marshal.AllocHGlobal(HdrSize);
                WAVEHDR hh = new WAVEHDR();
                hh.lpData = data; hh.dwBufferLength = (uint)usable;
                Marshal.StructureToPtr(hh, hdr, false);
                waveOutPrepareHeader(hwo, hdr, HdrSize);
                waveOutWrite(hwo, hdr, HdrSize);
                pending.Add(new IntPtr[] { data, hdr });
                carry = total - usable;
                if (carry > 0) Buffer.BlockCopy(readBuf, usable, readBuf, 0, carry);
            }
            while (pending.Count > 0)
            {
                for (int i = pending.Count - 1; i >= 0; i--)
                {
                    WAVEHDR h = (WAVEHDR)Marshal.PtrToStructure(pending[i][1], typeof(WAVEHDR));
                    if ((h.dwFlags & WHDR_DONE) != 0)
                    {
                        waveOutUnprepareHeader(hwo, pending[i][1], HdrSize);
                        Marshal.FreeHGlobal(pending[i][0]);
                        Marshal.FreeHGlobal(pending[i][1]);
                        pending.RemoveAt(i);
                    }
                }
                if (pending.Count > 0) Thread.Sleep(5);
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("play error: " + ex.Message);
            failed = true;
        }
        finally
        {
            foreach (var p in pending)
            {
                waveOutUnprepareHeader(hwo, p[1], HdrSize);
                Marshal.FreeHGlobal(p[0]);
                Marshal.FreeHGlobal(p[1]);
            }
            waveOutReset(hwo);
            waveOutClose(hwo);
        }
        return failed ? 1 : 0;
    }
}
'@

$dll = Join-Path $env:TEMP 'oc-tts-waveout-${WAVEOUT_CACHE_KEY}.dll'
if (-not (Test-Path $dll)) {
    $tmp = "$dll.$PID"
    try { Add-Type -TypeDefinition $src -OutputAssembly $tmp -OutputType Library; Move-Item -Force $tmp $dll } catch { if (Test-Path $tmp) { Remove-Item -Force $tmp -ErrorAction SilentlyContinue } }
}
if (Test-Path $dll) {
    try { Add-Type -Path $dll } catch { Add-Type -TypeDefinition $src }
} else {
    Add-Type -TypeDefinition $src
}`;

/**
 * 生成内置 waveOut 播放器的完整脚本（追加采样率/声道与退出码）。
 * @param sampleRate 采样率（Hz）
 * @param channels 声道数
 * @returns 可传给 `pwsh -Command` 的脚本
 */
export function buildWaveOutScript(sampleRate: number, channels = WAVEOUT_CHANNELS): string {
  return `${WAVEOUT_SCRIPT}\nexit [WaveOutRaw]::Play(${sampleRate}, ${channels})`;
}

/** 一次流式播放的启动命令（stdin 为裸 PCM）。 */
export interface StreamCommand {
  /** 可执行文件名或绝对路径。 */
  bin: string;
  /** argv（不含可执行文件本身）。 */
  args: string[];
}

/** 流式播放器定义。 */
interface StreamDefinition {
  id: StreamPlayerId;
  /** 按顺序探测的可执行文件（第一个可用者胜出）。 */
  bins: readonly string[];
  /** 由选中的可执行文件与采样率构造启动命令。 */
  build: (bin: string, sampleRate: number) => StreamCommand;
}

/** 各流式播放器的参数构造（裸 s16le / 单声道 / stdin）。 */
const DEFINITIONS: Readonly<Record<StreamPlayerId, StreamDefinition>> = {
  waveout: {
    id: "waveout",
    bins: WAVEOUT_BINS,
    build: (bin, sr) => ({ bin, args: ["-NoProfile", "-NonInteractive", "-Command", buildWaveOutScript(sr)] }),
  },
  aplay: {
    id: "aplay",
    bins: ["/usr/bin/aplay", "aplay"],
    build: (bin, sr) => ({ bin, args: ["-q", "-f", "S16_LE", "-r", String(sr), "-c", "1", "-t", "raw", "-"] }),
  },
  paplay: {
    id: "paplay",
    bins: ["/usr/bin/paplay", "paplay"],
    build: (bin, sr) => ({ bin, args: ["--raw", "--format=s16le", `--rate=${sr}`, "--channels=1"] }),
  },
  "sox-play": {
    id: "sox-play",
    bins: ["play"],
    build: (bin, sr) => ({ bin, args: ["-q", "-t", "raw", "-b", "16", "-e", "signed", "-r", String(sr), "-c", "1", "-"] }),
  },
  ffplay: {
    id: "ffplay",
    bins: ["ffplay"],
    build: (bin, sr) => ({
      bin,
      args: ["-hide_banner", "-loglevel", "error", "-f", "s16le", "-ar", String(sr), "-ac", "1", "-nodisp", "-autoexit", "-i", "-"],
    }),
  },
};

/** 选中的流式播放器。 */
export interface SelectedStreamPlayer {
  /** 播放器 id。 */
  id: string;
  /** 实际使用的可执行文件。 */
  bin: string;
  /** 目标采样率（Hz）。 */
  sampleRate: number;
  /** 构造启动命令。 */
  launcher: () => StreamCommand;
}

/** 选择选项（可注入以便单测）。 */
export interface SelectStreamPlayerOptions {
  /** PCM 采样率（Hz）。 */
  sampleRate: number;
  /** 目标平台；默认 `process.platform`。 */
  platform?: NodeJS.Platform;
  /** 环境变量表；默认 `process.env`。 */
  env?: NodeJS.ProcessEnv;
  /** 可执行文件可用性探测；默认按 PATH/绝对路径判定。 */
  isAvailable?: (bin: string) => boolean;
}

/**
 * 按平台给出**候选顺序**（不含可用性探测）。
 * @param platform 目标平台
 * @param env 环境变量表（判定 Termux）
 * @returns 候选定义数组
 */
function candidateDefinitions(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): StreamDefinition[] {
  if (platform === "win32") return [DEFINITIONS.waveout, DEFINITIONS.ffplay];
  if (platform === "darwin") return [DEFINITIONS["sox-play"], DEFINITIONS.ffplay];
  if (platform === "android" || isTermux(env)) return [DEFINITIONS["sox-play"], DEFINITIONS.ffplay];
  return [DEFINITIONS.aplay, DEFINITIONS.paplay, DEFINITIONS["sox-play"], DEFINITIONS.ffplay];
}

/**
 * 选择一个可用的**流式**播放器；无可用时返回 null（不抛错，交由调用方回退）。
 *
 * `TTS_PLAYER` 仅在取值为已知流式 id（`waveout`/`aplay`/`paplay`/`sox`/`play`/`ffplay`）时生效；
 * 指向文件型播放器（如 `play-audio`/`soundplayer`/`afplay`）时对流式**不生效**（回退分段播放）。
 * @param options 选项
 * @returns 选中的流式播放器；无可用返回 null
 */
export function selectStreamPlayer(options: SelectStreamPlayerOptions): SelectedStreamPlayer | null {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const isAvailable = options.isAvailable ?? ((bin: string) => commandExists(bin, env, platform));
  const overrideRaw = env[ENV_TTS_PLAYER]?.trim().toLowerCase();
  const overrideId = overrideRaw ? STREAM_PLAYER_ALIASES[overrideRaw] : undefined;

  // 显式指定了 TTS_PLAYER 但不是已知流式 id（如文件型 play-audio/soundplayer/afplay）：
  // 对流式不生效 → 返回 null，交由 audio-sink 回退分段播放。
  if (overrideRaw && !overrideId) return null;
  const candidates = overrideId ? [DEFINITIONS[overrideId]] : candidateDefinitions(platform, env);
  for (const candidate of candidates) {
    for (const bin of candidate.bins) {
      if (isAvailable(bin)) {
        return {
          id: candidate.id,
          bin,
          sampleRate: options.sampleRate,
          launcher: () => candidate.build(bin, options.sampleRate),
        };
      }
    }
  }
  return null;
}
