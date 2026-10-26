/**
 * 麦克风采集：产出 16kHz/单声道/16bit PCM（s16le）分片，事件 `data` 交给 ASR 喂流。
 *
 * 后端（`data` 事件载荷/`start`·`stop` 接口保持一致，调用方无感）：
 * - **dshow**（Windows）：`ffmpeg -f dshow` 从系统音频输入设备直接取裸 PCM；
 * - **pulse**（Linux 桌面首选）：`ffmpeg -f pulse`，优先 PulseAudio/PipeWire；
 * - **alsa**（Linux 桌面回退）：`ffmpeg -f alsa`，pulse 启动失败时自动改试一次；
 * - **termux**（Termux/Android）：系统无可用 ffmpeg 音频输入设备，改用 **`termux-microphone-record`**。
 *   该命令没有裸 PCM 编码器，只能录成压缩文件（优先 `opus`，失败退 `aac`）——故采用
 *   **分块录制 → ffmpeg 解码为 16k 单声道 s16le → 连续喂 ASR**（分块顺序解码，跨块拼成连续流）。
 *   需 `pkg install termux-api` 且手机安装 **Termux:API 应用**；缺任一则清晰报错。
 *
 * 采集进程（子进程）与 ASR 客户端并发运行；共享状态与顺序契约见 docs/ASYNC.md。
 */

import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decodeToPcm, resolveFfmpegPath } from "./ffmpeg.js";
import {
  ffmpegLaunchFailedGuidance,
  linuxAudioEnumerationFailedGuidance,
  unsupportedCapturePlatformGuidance,
} from "./guidance.js";
import { commandExists, isTermux, termuxExecutable } from "./platform.js";

/** 采集采样率（Hz）：与阿里云实时 ASR 要求一致。 */
export const CAPTURE_SAMPLE_RATE = 16000;
/** 采集声道数：单声道。 */
export const CAPTURE_CHANNELS = 1;

/** stderr 诊断信息保留的最大字符数。 */
const STDERR_TAIL_CHARS = 2000;

/** 采集后端：Windows dshow / Linux pulse→alsa / Termux termux-microphone-record。 */
export type CaptureBackend = "dshow" | "termux" | "pulse" | "alsa";
/** 走 ffmpeg 的后端（Termux 之外）。 */
export type FfmpegCaptureBackend = Exclude<CaptureBackend, "termux">;

/** Linux 音频设备缺省取值（PulseAudio 默认 source / ALSA 默认设备）。 */
export const DEFAULT_LINUX_AUDIO_DEVICE = "default";
/** `pactl get-default-source` 未设置默认源时可能返回的占位符（不可当作真实 source 名）。 */
const PACTL_DEFAULT_SOURCE_PLACEHOLDER = "@DEFAULT_SOURCE@";
/** pulse 启动失败后允许自动回退 alsa 的时间窗（毫秒）：仅「启动即失败」才算。 */
export const PULSE_FALLBACK_WINDOW_MS = 3000;

/** Termux 录音命令名（`$PREFIX/bin/termux-microphone-record`）。 */
export const TERMUX_MIC_BIN = "termux-microphone-record";
/** Termux 分块时长环境变量（秒）。 */
export const TERMUX_CHUNK_SECONDS_ENV = "VOICE_TERMUX_CHUNK_SECONDS";
/** Termux 分块时长默认值（秒）。 */
export const DEFAULT_TERMUX_CHUNK_SECONDS = 2;
/** Termux 分块时长下界（秒）。 */
export const MIN_TERMUX_CHUNK_SECONDS = 1;
/** Termux 分块时长上界（秒）。 */
export const MAX_TERMUX_CHUNK_SECONDS = 60;
/** Termux 录音编码器候选（优先 opus：Ogg 可增量、延迟低；失败退 aac）。 */
export const TERMUX_MIC_ENCODERS: readonly string[] = ["opus", "aac"];
/** Termux 录音采样率（Hz）：固定 16k 采集，再由 ffmpeg 重采样到 ASR provider 目标采样率。 */
export const TERMUX_RECORD_SAMPLE_RATE = 16000;
/** 等待 `-l` 自动停止的额外余量（毫秒）。 */
const TERMUX_RECORD_MARGIN_MS = 400;
/** Termux 录音/解码失败时对用户的安装提示。 */
export const TERMUX_MIC_HINT = `请执行 pkg install termux-api，并在手机上安装 Termux:API 应用（命令 ${TERMUX_MIC_BIN}）`;

/**
 * 判定采集进程退出是否属「异常失败」，并生成给用户的错误文本。
 *
 * 口径（2026-10-22 审计根因）：采集进程以**非 0 退出码 / 异常信号**结束，或整段**0 字节音频**，
 * 都不能当作「用户没说话」——必须上报 `error` 并以非 0 退出码结束。旧行为只在 stderr 打一行
 * `[采集结束] 退出码=…` 后继续等信号（假 `ready` + `level:0` 刷屏 + 永久挂住）。
 * @param code 采集子进程退出码（null = 被信号/未知）
 * @param bytes 本次已采集的 PCM 字节数
 * @param diagnostics 采集进程 stderr 尾部（诊断用，调用方已限长）
 * @returns 失败文本；正常结束（退出码 0 且读到过音频）返回 null
 */
export function formatCaptureExitFailure(
  code: number | null,
  bytes: number,
  diagnostics: string,
): string | null {
  const codeLabel = code === null ? "signal/unknown" : String(code);
  const detail = diagnostics.trim().slice(-800);
  if (bytes === 0) {
    return `未采集到任何音频（采集进程退出码=${codeLabel}）${detail ? `；stderr：${detail}` : ""}`;
  }
  if (code !== 0) {
    return `采集进程异常退出（退出码=${codeLabel}，已采集 ${bytes} 字节）${detail ? `；stderr：${detail}` : ""}`;
  }
  return null;
}

/** 音频输入设备。 */
export interface AudioDevice {
  /** 友好名（Windows 即喂给 ffmpeg dshow 的名字；Linux 为 description）。 */
  name: string;
  /** dshow 备用名（可能为空）。 */
  alternativeName?: string;
  /** 传给采集后端的**取值**（Linux：pulse source 名或 `hw:C,D`；Windows 缺省=name）。 */
  value?: string;
}

/** MicCapture 事件表（供类型化 on/emit 使用）。 */
export interface MicCaptureEventMap {
  data: [chunk: Buffer];
  error: [error: Error];
  close: [code: number | null];
}

/** MicCapture 配置。 */
export interface MicCaptureOptions {
  /** 设备友好名；Termux 后端忽略（系统无 dshow 设备）。 */
  device: string;
  /** 采集采样率（Hz）；缺省 CAPTURE_SAMPLE_RATE，按 ASR provider 预设传入。 */
  sampleRate?: number;
  /** 目标平台；默认 `process.platform`（可注入以便单测）。 */
  platform?: NodeJS.Platform;
  /** 环境变量表；默认 `process.env`（可注入以便单测）。 */
  env?: NodeJS.ProcessEnv;
  /** ffmpeg 可执行路径（测试注入；缺省 `resolveFfmpegPath()`）。 */
  ffmpegBin?: string;
  /** 采集子进程 spawn 注入（测试用；缺省 `node:child_process` 的 `spawn`）。 */
  spawnCapture?: typeof spawn;
}

/**
 * 选择采集后端（纯函数）。
 *
 * 分派规则：Termux（`android` 平台或 Termux 环境）→ `termux`；`win32` → `dshow`；
 * `linux`（非 Termux）→ `pulse`；`preferAlsa` 时 → `alsa`（pulse 回退/显式指定）。
 * 其它平台（如 `darwin`）**明确抛错**，绝不静默走 dshow。
 * @param input 平台 / 是否 Termux / 是否强制 ALSA
 * @returns 后端标识
 * @throws Error 不支持的平台
 */
export function resolveCaptureBackend(input: {
  platform: NodeJS.Platform;
  isTermux: boolean;
  preferAlsa?: boolean;
}): CaptureBackend {
  const { platform, isTermux: termux, preferAlsa = false } = input;
  if (termux || platform === "android") return "termux";
  if (platform === "win32") return "dshow";
  if (platform === "linux") return preferAlsa ? "alsa" : "pulse";
  throw new Error(unsupportedCapturePlatformGuidance(platform));
}

/**
 * `resolveCaptureBackend` 的环境版包装（保留旧签名）。
 * @param platform 目标平台
 * @param env 环境变量表（判定 Termux）
 * @returns 后端标识
 * @throws Error 不支持的平台
 */
export function selectCaptureBackend(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): CaptureBackend {
  return resolveCaptureBackend({ platform, isTermux: isTermux(env) });
}

/**
 * 解析 Termux 分块时长（秒）：环境变量 `VOICE_TERMUX_CHUNK_SECONDS`，非法/越界回退并夹取。
 * @param env 环境变量表
 * @returns 分块秒数
 */
export function resolveTermuxChunkSeconds(env: NodeJS.ProcessEnv): number {
  const raw = env[TERMUX_CHUNK_SECONDS_ENV];
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TERMUX_CHUNK_SECONDS;
  return Math.min(MAX_TERMUX_CHUNK_SECONDS, Math.max(MIN_TERMUX_CHUNK_SECONDS, parsed));
}

/**
 * 构造 `termux-microphone-record` 的分块录制参数（纯函数，便于单测）。
 *
 * 选项依据 Termux API 官方 `-h`：`-f <file>` / `-l <秒,0=不限>` / `-e <aac|amr_wb|amr_nb|opus>` /
 * `-b <kbps>` / `-r <Hz>` / `-c <声道>`。这里固定写出目标采样率/声道，由 ffmpeg 后续统一重采样。
 * @param file 录音输出文件路径
 * @param encoder 编码器（opus/aac/…）
 * @param seconds 录制秒数（>0）
 * @param sampleRate 采样率（Hz）
 * @param channels 声道数
 * @returns argv（不含可执行文件本身）
 */
export function buildTermuxRecordArgs(
  file: string,
  encoder: string,
  seconds: number,
  sampleRate: number,
  channels: number,
): string[] {
  return [
    "-f",
    file,
    "-l",
    String(seconds),
    "-e",
    encoder,
    "-r",
    String(sampleRate),
    "-c",
    String(channels),
  ];
}

/**
 * 从 ffmpeg `-list_devices` 的 stderr 文本解析 dshow 音频设备。
 * @param text ffmpeg 输出文本
 * @returns 设备列表
 */
function parseDshowDevices(text: string): AudioDevice[] {
  const devices: AudioDevice[] = [];
  const nameRe = /"([^"]+)"\s*\(audio\)/g;
  const altRe = /Alternative name "([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = nameRe.exec(text)) !== null) {
    devices.push({ name: match[1] });
  }
  let index = 0;
  while ((match = altRe.exec(text)) !== null) {
    if (devices[index]) devices[index].alternativeName = match[1];
    index += 1;
  }
  return devices;
}

/** `listAudioDevices` 的 `spawnSync` 返回值最小结构（仅本函数需要的字段；测试可注入）。 */
export interface DeviceSpawnResult {
  /** stdout 文本（`encoding: "utf8"`）。 */
  stdout?: string | Buffer | null;
  /** stderr 文本（`encoding: "utf8"`；dshow 设备列表在这里）。 */
  stderr?: string | Buffer | null;
  /** 启动失败（ENOENT/EACCES 等）——**不许吞**，必须转成明确错误上报。 */
  error?: NodeJS.ErrnoException | null;
  /** 退出码（`spawnSync` 提供；注入测试可省略，省略按 0 处理）。 */
  status?: number | null;
}

/** `listAudioDevices` 的可注入依赖（便于离线单测；生产走默认真 spawnSync/resolveFfmpegPath）。 */
export interface ListAudioDevicesOptions {
  /** 显式 ffmpeg 可执行路径（跳过 `resolveFfmpegPath` 解析；测试注入）。 */
  bin?: string;
  /** `spawnSync` 注入（测试注入）。 */
  spawn?: (bin: string, args: string[], options: { encoding: "utf8" }) => DeviceSpawnResult;
  /** 目标平台；默认 `process.platform`（可注入）。 */
  platform?: NodeJS.Platform;
  /** 环境变量表（判定 Termux）；默认 `process.env`。 */
  env?: NodeJS.ProcessEnv;
}

/** Linux 设备枚举的可注入依赖。 */
export interface LinuxAudioDevicesOptions {
  /** `spawnSync` 注入（无 shell）。 */
  spawn?: (bin: string, args: string[], options: { encoding: "utf8" }) => DeviceSpawnResult;
  /** pactl 可执行名/路径；默认 `pactl`。 */
  pactlBin?: string;
  /** arecord 可执行名/路径；默认 `arecord`。 */
  arecordBin?: string;
}

/** 命令是否成功（无 spawn 错误且退出码为 0/未知）。 */
function commandSucceeded(result: DeviceSpawnResult): boolean {
  return !result.error && (result.status === undefined || result.status === 0);
}

/** 取命令输出文本（stdout + stderr）。 */
function commandText(result: DeviceSpawnResult): string {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

/**
 * 解析 `pactl list short sources`（制表符分隔：index/name/driver/spec/state）。
 * @param text 命令输出
 * @returns 设备列表（description 暂用 source 名）
 */
export function parsePactlShortSources(text: string): AudioDevice[] {
  const devices: AudioDevice[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const fields = line.split("\t");
    if (fields.length < 2) continue;
    const name = fields[1]?.trim();
    if (!name) continue;
    devices.push({ name, value: name });
  }
  return devices;
}

/**
 * 解析 `pactl list sources`（长格式，取 Name/Description 供友好名）。
 * @param text 命令输出
 * @returns 设备列表（value=source 名，name=description）
 */
export function parsePactlSources(text: string): AudioDevice[] {
  const devices: AudioDevice[] = [];
  let name: string | undefined;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const nameMatch = /^Name:\s*(.+)$/.exec(line);
    if (nameMatch) {
      name = nameMatch[1].trim();
      continue;
    }
    const descMatch = /^Description:\s*(.+)$/.exec(line);
    if (descMatch && name) {
      devices.push({ name: descMatch[1].trim() || name, value: name });
      name = undefined;
    }
  }
  return devices;
}

/**
 * 解析 `arecord -l`：`card 0: PCH [HDA Intel PCH], device 0: ALC257 Analog [ALC257 Analog]`。
 * @param text 命令输出
 * @returns 设备列表（value=`hw:C,D`）
 */
export function parseArecordDevices(text: string): AudioDevice[] {
  const devices: AudioDevice[] = [];
  const re = /^card\s+(\d+):\s*([^\[]+?)\s*\[([^\]]*)\],\s*device\s+(\d+):\s*([^\[]+?)\s*\[([^\]]*)\]/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const [, cardIndex, cardName, cardLabel, deviceIndex, deviceName, deviceLabel] = match;
    const value = `hw:${cardIndex},${deviceIndex}`;
    const description = [cardLabel || cardName, deviceLabel || deviceName]
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .join(" ");
    devices.push({ name: description || value, value });
  }
  return devices;
}

/**
 * 枚举 Linux 音频输入设备：`pactl list short sources` 优先，失败回退 `arecord -l`。
 *
 * 两者都不可用（命令不存在/非 0）时抛明确错误（含安装命令）。pactl 成功但 0 source
 * 且 arecord 成功但 0 设备 ⇒ 返回空列表（由调用方给「无设备」引导）。
 * @param options 可注入依赖
 * @returns 设备列表
 * @throws Error 两种枚举命令都不可用
 */
export function listLinuxAudioDevices(options: LinuxAudioDevicesOptions = {}): AudioDevice[] {
  const spawn =
    options.spawn ?? ((target: string, argv: string[], opts: { encoding: "utf8" }) => spawnSync(target, argv, opts));
  const pactlBin = options.pactlBin ?? "pactl";
  const arecordBin = options.arecordBin ?? "arecord";

  const pactl = spawn(pactlBin, ["list", "short", "sources"], { encoding: "utf8" });
  let pactlCause = "";
  if (commandSucceeded(pactl)) {
    const sources = parsePactlShortSources(commandText(pactl));
    if (sources.length > 0) {
      // 短格式没有 description：再取一次长格式补友好名（失败则用 source 名兜底）
      const long = spawn(pactlBin, ["list", "sources"], { encoding: "utf8" });
      const descriptions = new Map<string, string>();
      if (commandSucceeded(long)) {
        for (const device of parsePactlSources(commandText(long))) {
          if (device.value) descriptions.set(device.value, device.name);
        }
      }
      return sources.map((source) => ({
        name: descriptions.get(source.value ?? source.name) ?? source.name,
        value: source.value,
      }));
    }
  } else {
    pactlCause = describeCommandFailure(pactl);
  }

  const arecord = spawn(arecordBin, ["-l"], { encoding: "utf8" });
  if (commandSucceeded(arecord)) return parseArecordDevices(commandText(arecord));

  throw new Error(linuxAudioEnumerationFailedGuidance(pactlCause || "无可用 source", describeCommandFailure(arecord)));
}

/** 默认输入源查询的可注入依赖。 */
export interface DefaultPulseSourceOptions {
  /** `spawnSync` 注入（测试注入）。 */
  spawn?: (bin: string, args: string[], options: { encoding: "utf8" }) => DeviceSpawnResult;
  /** pactl 可执行名/路径；默认 `pactl`。 */
  pactlBin?: string;
}

/**
 * 查询系统默认输入源（`pactl get-default-source`）。
 *
 * 命令缺失 / 非 0 退出 / 输出为空 / 输出为 `@DEFAULT_SOURCE@` 占位符时返回 undefined（不抛错、不阻断）。
 * @param options 可注入依赖
 * @returns 有效默认 source 名；无有效默认源时 undefined
 */
export function getDefaultPulseSource(options: DefaultPulseSourceOptions = {}): string | undefined {
  const spawn =
    options.spawn ?? ((target: string, argv: string[], opts: { encoding: "utf8" }) => spawnSync(target, argv, opts));
  const pactlBin = options.pactlBin ?? "pactl";
  const result = spawn(pactlBin, ["get-default-source"], { encoding: "utf8" });
  if (!commandSucceeded(result)) return undefined;
  const value = `${result.stdout ?? ""}`.trim();
  if (value.length === 0 || value === PACTL_DEFAULT_SOURCE_PLACEHOLDER) return undefined;
  return value;
}

/**
 * 是否为 PulseAudio/PipeWire 的 monitor（输出回环）源。
 * @param name source 名（或设备取值）
 * @returns monitor 源 true
 */
export function isMonitorSource(name: string): boolean {
  return name.trim().toLowerCase().endsWith(".monitor");
}

/** 已知 ALSA PCM 设备名前缀（`CARD=`/`DEV=` 形态另由正则判定）。 */
const ALSA_DEVICE_PREFIXES: readonly string[] = [
  "hw:",
  "plughw:",
  "sysdefault:",
  "default:",
  "front:",
  "rear:",
  "center_lfe:",
  "side:",
  "surround40:",
  "surround41:",
  "surround50:",
  "surround51:",
  "surround71:",
  "iec958:",
  "spdif:",
  "dmix:",
  "dsnoop:",
  "pulse:",
];

/** 无冒号的 ALSA 设备名（精确匹配）。 */
const ALSA_DEVICE_EXACT: readonly string[] = ["default", "pulse"];

/**
 * 是否为 ALSA PCM 设备名（避免 pulse 回退时把合法 ALSA 名误降级为 `default`）。
 * @param name 设备取值
 * @returns ALSA 设备名 true
 */
export function isAlsaDeviceName(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length === 0) return false;
  if (ALSA_DEVICE_EXACT.includes(trimmed)) return true;
  if (/(?:^|[:,])\s*(?:CARD|DEV)\s*=/i.test(trimmed)) return true;
  return ALSA_DEVICE_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

/**
 * 稳定重排设备：真实输入源在前、monitor 源在后，各自保持原相对顺序。
 * @param devices 原始设备列表
 * @returns 重排后的新数组（不修改入参）
 */
export function prioritizeMicrophoneDevices(devices: readonly AudioDevice[]): AudioDevice[] {
  const real: AudioDevice[] = [];
  const monitors: AudioDevice[] = [];
  for (const device of devices) {
    const value = device.value ?? device.name;
    (isMonitorSource(value) ? monitors : real).push(device);
  }
  return [...real, ...monitors];
}

/**
 * `--list` 展示排序：系统默认源置顶，其余真实输入源次之、monitor 源最后（各组保持原相对顺序）。
 * @param devices 原始设备列表
 * @param defaultSource 系统默认 source 名（无则仅做 monitor 后置）
 * @returns 排序后的新数组（不修改入参）
 */
export function orderLinuxDevicesForDisplay(
  devices: readonly AudioDevice[],
  defaultSource?: string,
): AudioDevice[] {
  const prioritized = prioritizeMicrophoneDevices(devices);
  if (!defaultSource) return prioritized;
  const index = prioritized.findIndex((device) => (device.value ?? device.name) === defaultSource);
  if (index <= 0) return prioritized;
  const [selected] = prioritized.splice(index, 1);
  return [selected, ...prioritized];
}

/** 默认 Linux 设备解析的可注入依赖。 */
export interface LinuxDefaultDeviceOptions extends LinuxAudioDevicesOptions {
  /** 默认源查询注入（测试）；缺省走 `getDefaultPulseSource`。 */
  getDefaultSource?: () => string | undefined;
  /** 设备枚举注入（测试）；缺省走 `listLinuxAudioDevices`。 */
  listDevices?: () => AudioDevice[];
}

/** 默认 Linux 设备解析结果。 */
export interface LinuxDefaultDevice {
  /** 传给 ffmpeg 的取值（pulse source 名）。 */
  value: string;
  /** 是否来自系统默认源（`pactl get-default-source`）。 */
  fromDefaultSource: boolean;
  /** 是否为 monitor 回环源（采集可能静音）。 */
  monitor: boolean;
}

/**
 * 解析 Linux 默认输入设备（调用方未显式指定 device 时使用）。
 *
 * 优先级：① `pactl get-default-source` 有效 → 用它；② 否则枚举列表中的真实输入源（非 `.monitor`）
 * 取第一条；③ 列表只有 monitor → 仍取第一条（`monitor=true`，由调用方提示）。
 * @param options 可注入依赖
 * @returns 解析结果；确实无设备时 undefined
 */
export function resolveDefaultLinuxDevice(
  options: LinuxDefaultDeviceOptions = {},
): LinuxDefaultDevice | undefined {
  const defaultSource = options.getDefaultSource
    ? options.getDefaultSource()
    : getDefaultPulseSource({ spawn: options.spawn, pactlBin: options.pactlBin });
  if (defaultSource) {
    return { value: defaultSource, fromDefaultSource: true, monitor: isMonitorSource(defaultSource) };
  }
  const devices = options.listDevices
    ? options.listDevices()
    : listLinuxAudioDevices({
        spawn: options.spawn,
        pactlBin: options.pactlBin,
        arecordBin: options.arecordBin,
      });
  let first = prioritizeMicrophoneDevices(devices)[0];
  // pactl 只有 monitor 时，再试一次 arecord 的真实硬件设备（pactl 有 source 时原枚举不会走 arecord）
  if (first && options.listDevices === undefined && isMonitorSource(first.value ?? first.name)) {
    const spawn =
      options.spawn ??
      ((target: string, argv: string[], opts: { encoding: "utf8" }) => spawnSync(target, argv, opts));
    const alsaFirst = prioritizeMicrophoneDevices(
      tryArecordDevices(spawn, options.arecordBin ?? "arecord"),
    )[0];
    if (alsaFirst && !isMonitorSource(alsaFirst.value ?? alsaFirst.name)) first = alsaFirst;
  }
  if (!first) return undefined;
  const value = first.value ?? first.name;
  return { value, fromDefaultSource: false, monitor: isMonitorSource(value) };
}

/** Linux 采集设备解析的可注入依赖。 */
export interface LinuxCaptureDeviceOptions extends LinuxDefaultDeviceOptions {
  /** 显式设备（config.device / `--device` / `VOICE_DEVICE`）；非空则原样使用。 */
  explicit?: string;
}

/**
 * 解析 Linux 采集设备：显式指定最高优先（且不触发默认源查询 / 枚举），否则走默认解析。
 * @param options 可注入依赖与显式设备
 * @returns 解析结果；确实无设备时 undefined
 */
export function resolveLinuxCaptureDevice(
  options: LinuxCaptureDeviceOptions = {},
): LinuxDefaultDevice | undefined {
  const explicit = options.explicit?.trim() ?? "";
  if (explicit.length > 0) {
    return { value: explicit, fromDefaultSource: false, monitor: isMonitorSource(explicit) };
  }
  return resolveDefaultLinuxDevice(options);
}

/**
 * pulse 自动回退 ALSA 时换算设备取值：已是 ALSA 设备名形态则原样保留，
 * 只把 pulse source 名（如 `alsa_input.*` / `*.monitor`）换算成 `default`。
 * @param device 当前设备取值（pulse source 名 / ALSA 设备名 / `default`）
 * @returns 可传给 `-f alsa` 的取值
 */
export function resolveAlsaFallbackDevice(device: string): string {
  const trimmed = device.trim();
  if (trimmed.length === 0) return DEFAULT_LINUX_AUDIO_DEVICE;
  return isAlsaDeviceName(trimmed) ? trimmed : DEFAULT_LINUX_AUDIO_DEVICE;
}

/**
 * 尽力枚举 `arecord -l` 设备（失败返回空数组，不抛错；用于 monitor-only 时的二次尝试）。
 * @param spawn 注入的 spawnSync
 * @param arecordBin arecord 可执行名/路径
 * @returns 硬件输入设备列表
 */
function tryArecordDevices(
  spawn: (bin: string, args: string[], options: { encoding: "utf8" }) => DeviceSpawnResult,
  arecordBin: string,
): AudioDevice[] {
  const result = spawn(arecordBin, ["-l"], { encoding: "utf8" });
  return commandSucceeded(result) ? parseArecordDevices(commandText(result)) : [];
}

/**
 * 命令失败原因（写进引导文案）。
 * @param result spawnSync 结果
 * @returns 原因文本
 */
function describeCommandFailure(result: DeviceSpawnResult): string {
  if (result.error) {
    const errno = result.error as NodeJS.ErrnoException;
    return errno.code ? `${errno.code} ${errno.message}` : errno.message;
  }
  const stderr = `${result.stderr ?? ""}`.trim().split(/\r?\n/).slice(-1)[0];
  return `退出码=${result.status ?? "unknown"}${stderr ? `：${stderr}` : ""}`;
}

/**
 * 枚举音频输入设备（按平台分派）：Windows dshow / Linux pactl→arecord / Termux 空列表。
 *
 * `spawnSync` 启动失败（ffmpeg 不存在/无权限）**不再静默吞掉**：抛出带可执行路径与底层原因的
 * 明确错误（引导文案见 `guidance.ts`），让真因浮出，而不是解析出空列表后误报「无音频输入设备」。
 * @param options 可注入依赖（bin/spawn/platform/env；缺省用生产实现）
 * @returns 设备列表（枚举成功但确实没有设备时为空数组）
 * @throws Error ffmpeg/枚举命令无法启动，或平台不支持
 */
export function listAudioDevices(options: ListAudioDevicesOptions = {}): AudioDevice[] {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (isTermux(env) || platform === "android") return [];
  if (platform === "linux") return listLinuxAudioDevices({ spawn: options.spawn });
  if (platform !== "win32") throw new Error(unsupportedCapturePlatformGuidance(platform));
  const args = ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"];
  const bin = options.bin ?? resolveFfmpegPath();
  const spawn = options.spawn ?? ((target, argv, opts) => spawnSync(target, argv, opts));
  const result = spawn(bin, args, { encoding: "utf8" });
  if (result.error) {
    const errno = result.error as NodeJS.ErrnoException;
    const cause = errno.code ? `${errno.code} ${errno.message}` : errno.message;
    throw new Error(ffmpegLaunchFailedGuidance(bin, cause));
  }
  const text = `${result.stderr ?? ""}${result.stdout ?? ""}`;
  return parseDshowDevices(text);
}

/**
 * 构造 ffmpeg 采集参数（桌面 dshow 后端）。
 * @param device 设备友好名
 * @param sampleRate 目标采样率（Hz）；缺省 CAPTURE_SAMPLE_RATE
 * @returns ffmpeg 参数数组
 */
export function buildCaptureArgs(device: string, sampleRate: number = CAPTURE_SAMPLE_RATE): string[] {
  return [
    "-hide_banner",
    "-nostdin",
    "-f",
    "dshow",
    "-i",
    `audio=${device}`,
    "-f",
    "s16le",
    "-ar",
    String(sampleRate),
    "-ac",
    String(CAPTURE_CHANNELS),
    "-",
  ];
}

/**
 * 解析 Linux 采集设备取值：空/纯空白 → `default`，其余原样（source 名或 `hw:C,D`）。
 * @param backend 采集后端（仅 pulse/alsa 生效；Windows/Termux 原样返回）
 * @param device 配置的设备
 * @returns 实际传给 ffmpeg 的取值
 */
export function resolveCaptureDevice(backend: CaptureBackend, device: string): string {
  if (backend !== "pulse" && backend !== "alsa") return device;
  const trimmed = device.trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_LINUX_AUDIO_DEVICE;
}

/**
 * Linux PulseAudio/PipeWire 采集参数。
 * @param input 设备与采样率（采样率缺省 CAPTURE_SAMPLE_RATE）
 * @returns ffmpeg argv（不含可执行文件）
 */
export function buildPulseArgs(input: { device: string; sampleRate?: number }): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "pulse",
    "-i",
    resolveCaptureDevice("pulse", input.device),
    "-ac",
    String(CAPTURE_CHANNELS),
    "-ar",
    String(input.sampleRate ?? CAPTURE_SAMPLE_RATE),
    "-f",
    "s16le",
    "-",
  ];
}

/**
 * Linux ALSA 采集参数（pulse 回退）。
 * @param input 设备与采样率（设备缺省 `default`）
 * @returns ffmpeg argv（不含可执行文件）
 */
export function buildAlsaArgs(input: { device: string; sampleRate?: number }): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "alsa",
    "-i",
    resolveCaptureDevice("alsa", input.device),
    "-ac",
    String(CAPTURE_CHANNELS),
    "-ar",
    String(input.sampleRate ?? CAPTURE_SAMPLE_RATE),
    "-f",
    "s16le",
    "-",
  ];
}

/**
 * 按后端构造 ffmpeg 采集参数（dshow 走原实现，语义不变）。
 * @param backend ffmpeg 后端
 * @param device 设备名/取值
 * @param sampleRate 采样率
 * @returns ffmpeg argv
 */
export function buildFfmpegCaptureArgs(
  backend: FfmpegCaptureBackend,
  device: string,
  sampleRate: number = CAPTURE_SAMPLE_RATE,
): string[] {
  if (backend === "pulse") return buildPulseArgs({ device, sampleRate });
  if (backend === "alsa") return buildAlsaArgs({ device, sampleRate });
  return buildCaptureArgs(device, sampleRate);
}

/**
 * pulse 启动失败是否属于「连接/设备不可用」类（据此决定自动回退 ALSA）。
 * @param stderr ffmpeg stderr 尾部
 * @returns 命中 true
 */
export function isPulseStartupFailure(stderr: string): boolean {
  return /connection refused|failed to connect|no such file|cannot open|could not open|no such device|permission denied|device or resource busy/i.test(
    stderr,
  );
}

/** 后端回退决策入参。 */
export interface PulseFallbackDecision {
  /** 当前后端。 */
  backend: CaptureBackend;
  /** 是否已回退过（保证只重试一次）。 */
  fallbackAttempted: boolean;
  /** 用户是否已请求停止。 */
  stopping: boolean;
  /** 本次尝试是否收到过音频字节。 */
  bytes: number;
  /** 启动耗时（毫秒）。 */
  elapsedMs: number;
  /** stderr 尾部。 */
  stderr: string;
  /** 子进程是否启动失败（spawn error）。 */
  spawnError?: boolean;
}

/**
 * 是否应从 pulse 自动回退 ALSA（纯函数）。
 *
 * 只回退一次；仅 pulse 后端、未在停止中、尚未回退过，且属于「spawn 失败」或
 * 「启动窗口内 0 字节退出 + stderr 命中连接/设备错误」。
 * @param input 决策入参
 * @returns 需要回退 true
 */
export function shouldFallbackToAlsa(input: PulseFallbackDecision): boolean {
  if (input.backend !== "pulse" || input.fallbackAttempted || input.stopping) return false;
  if (input.bytes > 0) return false;
  if (input.spawnError === true) return true;
  return input.elapsedMs <= PULSE_FALLBACK_WINDOW_MS && isPulseStartupFailure(input.stderr);
}

/** 麦克风采集器（EventEmitter，事件见 MicCaptureEventMap）。 */
export class MicCapture extends EventEmitter {
  private process: ChildProcess | null = null;
  private readonly device: string;
  private readonly sampleRate: number;
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;
  private readonly backend: CaptureBackend;
  private readonly termuxChunkSeconds: number;
  private readonly ffmpegBin: string | undefined;
  private readonly spawnCapture: typeof spawn;
  private stderrTail = "";
  private running = false;
  private stopping = false;
  private termuxEncoderIndex = 0;
  private waitTimer: NodeJS.Timeout | null = null;
  private waitResolve: (() => void) | null = null;
  /** 当前 ffmpeg 尝试的后端（回退后变 alsa）。 */
  private activeBackend: FfmpegCaptureBackend | null = null;
  /** 是否已回退过 ALSA（保证只重试一次）。 */
  private fallbackAttempted = false;
  /** 本次尝试已收到的 PCM 字节数。 */
  private attemptBytes = 0;
  /** 本次尝试的启动时刻（毫秒）。 */
  private attemptStartedAt = 0;
  /** 尝试序号：旧进程的迟到事件直接丢弃。 */
  private attemptToken = 0;

  /**
   * @param options 采集配置
   */
  constructor(options: MicCaptureOptions) {
    super();
    this.device = options.device;
    this.sampleRate = options.sampleRate ?? CAPTURE_SAMPLE_RATE;
    this.platform = options.platform ?? process.platform;
    this.env = options.env ?? process.env;
    this.backend = selectCaptureBackend(this.platform, this.env);
    this.termuxChunkSeconds = resolveTermuxChunkSeconds(this.env);
    this.ffmpegBin = options.ffmpegBin;
    this.spawnCapture = options.spawnCapture ?? spawn;
  }

  /** 采集是否进行中。 */
  get isRunning(): boolean {
    return this.running;
  }

  /** ffmpeg/录音命令 stderr 的尾部（诊断用，最多 2000 字符）。 */
  get diagnostics(): string {
    return this.stderrTail;
  }

  /**
   * 启动采集；重复调用抛错。
   * @throws Error 已在运行
   */
  start(): void {
    if (this.running) {
      throw new Error("采集已在运行，不能重复启动");
    }
    this.running = true;
    this.stopping = false;
    this.stderrTail = "";
    this.fallbackAttempted = false;
    if (this.backend === "termux") {
      void this.runTermuxLoop();
      return;
    }
    this.startFfmpegBackend(this.backend);
  }

  /**
   * 启动一次 ffmpeg 采集尝试（pulse 失败可由此回退 alsa）。
   * @param backend ffmpeg 后端
   * @param deviceOverride 本次尝试的设备取值（缺省用配置设备）
   */
  private startFfmpegBackend(backend: FfmpegCaptureBackend, deviceOverride?: string): void {
    this.activeBackend = backend;
    this.attemptBytes = 0;
    this.attemptStartedAt = Date.now();
    this.attemptToken += 1;
    const token = this.attemptToken;
    const bin = this.ffmpegBin ?? resolveFfmpegPath();
    const proc = this.spawnCapture(
      bin,
      buildFfmpegCaptureArgs(backend, deviceOverride ?? this.device, this.sampleRate),
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    this.process = proc;

    let settled = false;
    const finish = (code: number | null, err: Error | null): void => {
      if (settled || token !== this.attemptToken) return;
      settled = true;
      this.handleFfmpegExit(code, err, token);
    };

    proc.stdout?.on("data", (chunk: Buffer) => {
      if (token !== this.attemptToken) return;
      this.attemptBytes += chunk.length;
      this.emit("data", chunk);
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      if (token !== this.attemptToken) return;
      this.appendStderr(chunk.toString());
    });
    proc.on("error", (err: Error) => finish(null, err));
    proc.on("close", (code: number | null) => finish(code, null));
  }

  /**
   * 处理一次 ffmpeg 尝试的结束：pulse 启动失败 → 自动回退 ALSA **一次**；否则按原路径收尾。
   * @param code 退出码
   * @param err spawn 错误
   * @param token 尝试序号
   */
  private handleFfmpegExit(code: number | null, err: Error | null, token: number): void {
    if (token !== this.attemptToken) return;
    this.process = null;
    const backend = this.activeBackend;
    const elapsedMs = Date.now() - this.attemptStartedAt;
    if (backend !== null && shouldFallbackToAlsa({
      backend,
      fallbackAttempted: this.fallbackAttempted,
      stopping: this.stopping,
      bytes: this.attemptBytes,
      elapsedMs,
      stderr: this.stderrTail,
      spawnError: err !== null,
    })) {
      this.fallbackAttempted = true;
      this.appendStderr(
        `\n[采集] PulseAudio 启动失败${err ? `（${err.message}）` : ""}，已自动改用 ALSA 重试一次\n`,
      );
      this.startFfmpegBackend("alsa", resolveAlsaFallbackDevice(this.device));
      return;
    }
    if (this.fallbackAttempted && backend === "alsa" && err === null && this.attemptBytes === 0) {
      this.appendStderr("\n[采集] PulseAudio 与 ALSA 两种后端均失败（pulse 已回退 alsa 一次）\n");
    }
    this.running = false;
    if (err) {
      const suffix = this.fallbackAttempted ? "；已尝试 pulse 与 alsa 两种后端" : "";
      this.emit("error", new Error(`${err.message}${suffix}`));
    }
    this.emit("close", code);
  }

  /** 停止采集（ffmpeg 直接结束；Termux 先停止录音再收尾）；未运行时无操作。 */
  stop(): void {
    if (!this.running) return;
    this.stopping = true;
    if (this.backend !== "termux") {
      this.process?.kill();
      return;
    }
    // Termux：唤醒等待并请求停止当前录音（忽略「未在录音」类错误）
    this.signalWait();
    try {
      spawnSync(termuxExecutable(this.env, TERMUX_MIC_BIN), ["-q"], { encoding: "utf8" });
    } catch {
      // -q 失败不影响：录音会由 -l 上限自行停止
    }
  }

  /**
   * 记录 stderr 尾部（诊断用）。
   * @param text stderr 文本
   */
  private appendStderr(text: string): void {
    if (text.length === 0) return;
    this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL_CHARS);
  }

  /**
   * 可被 `stop()` 提前唤醒的等待。
   * @param ms 毫秒
   */
  private wait(ms: number): Promise<void> {
    if (this.stopping) return Promise.resolve();
    return new Promise<void>((resolveWait) => {
      this.waitResolve = resolveWait;
      this.waitTimer = setTimeout(() => {
        this.waitTimer = null;
        this.waitResolve = null;
        resolveWait();
      }, ms);
    });
  }

  /** 唤醒进行中的 `wait()`（幂等）。 */
  private signalWait(): void {
    if (this.waitTimer) {
      clearTimeout(this.waitTimer);
      this.waitTimer = null;
    }
    const resolveWait = this.waitResolve;
    this.waitResolve = null;
    if (resolveWait) resolveWait();
  }

  /**
   * Termux 分块录制：启动录制（`-l` 自动停）→ 等待分块时长 → 兜底 `-q`。
   * @param micBin 录音命令绝对路径
   * @param file 输出文件
   * @param encoder 编码器
   */
  private recordChunk(micBin: string, file: string, encoder: string): Promise<void> {
    return new Promise<void>((resolveRecord, rejectRecord) => {
      let proc: ChildProcess;
      try {
        proc = spawn(
          micBin,
          buildTermuxRecordArgs(file, encoder, this.termuxChunkSeconds, TERMUX_RECORD_SAMPLE_RATE, CAPTURE_CHANNELS),
          { stdio: ["ignore", "ignore", "pipe"] },
        );
      } catch (err) {
        rejectRecord(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      proc.stderr?.on("data", (chunk: Buffer) => this.appendStderr(chunk.toString()));
      proc.on("error", (err: Error) => rejectRecord(err));
      proc.on("close", () => {
        // termux-microphone-record 启动即返回（录音由系统后台进行）
        void this.wait(this.termuxChunkSeconds * 1000 + TERMUX_RECORD_MARGIN_MS).then(() => {
          try {
            spawnSync(micBin, ["-q"], { encoding: "utf8" });
          } catch {
            // 忽略：可能已被 -l 停止
          }
          resolveRecord();
        });
      });
    });
  }

  /**
   * 采集一个分块并解码为 16k 单声道 PCM；opus 失败自动退 aac 且锁定可用编码器。
   * @param micBin 录音命令绝对路径
   * @returns PCM 字节
   */
  private async captureChunk(micBin: string): Promise<Buffer> {
    let lastError: Error | null = null;
    for (let index = this.termuxEncoderIndex; index < TERMUX_MIC_ENCODERS.length; index += 1) {
      const encoder = TERMUX_MIC_ENCODERS[index];
      const file = join(tmpdir(), `oc-mic-${randomUUID()}.${encoder}`);
      try {
        await this.recordChunk(micBin, file, encoder);
        const bytes = readFileSync(file);
        if (bytes.length === 0) throw new Error(`录音为空文件（encoder=${encoder}）`);
        // 统一重采样到 ASR provider 目标采样率（16k 或 8k），与桌面 ffmpeg 后端一致
        const pcm = await decodeToPcm(bytes, encoder, TERMUX_RECORD_SAMPLE_RATE, this.sampleRate, CAPTURE_CHANNELS);
        this.termuxEncoderIndex = index; // 锁定可用编码器，后续分块直接复用
        return pcm;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      } finally {
        try {
          rmSync(file, { force: true });
        } catch {
          // 忽略临时文件清理失败
        }
      }
    }
    const detail = lastError ? `：${lastError.message}` : "";
    throw new Error(
      `Termux 录音失败（已试编码器 ${TERMUX_MIC_ENCODERS.join(", ")}）${detail}；${TERMUX_MIC_HINT}`,
    );
  }

  /** Termux 采集主循环：分块录制 → 解码 → 发 `data`；结束发一次 `close`。 */
  private async runTermuxLoop(): Promise<void> {
    const micBin = termuxExecutable(this.env, TERMUX_MIC_BIN);
    if (!commandExists(micBin, this.env, this.platform)) {
      this.emit("error", new Error(`未找到 ${TERMUX_MIC_BIN}：${TERMUX_MIC_HINT}`));
      this.running = false;
      this.emit("close", null);
      return;
    }
    let code: number | null = 0;
    try {
      while (!this.stopping) {
        const pcm = await this.captureChunk(micBin);
        if (pcm.length > 0) this.emit("data", pcm);
      }
    } catch (err) {
      // 用户主动停止时可能拿到不完整分块，不视为错误
      if (!this.stopping) {
        this.emit("error", err instanceof Error ? err : new Error(String(err)));
        code = 1;
      }
    } finally {
      this.running = false;
      this.emit("close", code);
    }
  }

  /** 类型化 `on`（事件名与参数由 MicCaptureEventMap 约束）。 */
  override on<K extends keyof MicCaptureEventMap>(
    event: K,
    listener: (...args: MicCaptureEventMap[K]) => void,
  ): this;
  override on(event: string | symbol, listener: (...args: unknown[]) => void): this;
  override on(event: string | symbol, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener);
  }
}
