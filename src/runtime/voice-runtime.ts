/**
 * 语音运行时命令行入口（纯 Node/TS，可独立运行）。
 *
 * 链路：麦克风采集（桌面 ffmpeg dshow / Termux termux-microphone-record）→ ASR（按 provider 工厂分流：
 * stream = 阿里云实时 WS 两方言；segment = 阿里 qwen3-asr-flash 同步按段 / MiMo mimo-v2.5-asr 按段）
 * → 情绪映射 → 打印每句/每段最终结果。
 * 也可用 `--wav <路径>` 以 WAV 文件代替麦克风（非交互自测，云端链路验证；stream 按帧模拟实时，
 * segment 把整个 WAV 作为一段发送）。
 *
 * 用法示例：
 *   node dist/runtime/voice-runtime.js --list
 *   node dist/runtime/voice-runtime.js --wav .tmp/scratch/rt-asr/models/.../test_wavs/0.wav
 *   node dist/runtime/voice-runtime.js --device "麦克风 (USB Audio)"
 *   node dist/runtime/voice-runtime.js --device "麦克风 (USB Audio)" --inject http://127.0.0.1:PORT/inject
 *   node dist/runtime/voice-runtime.js --provider mimo --wav sample.wav
 *
 * 配置来源（不写死）：`<配置目录>/emotions.jsonc`（配置目录 = `~/.config/opencode`）提供
 * provider/模型/语言/语言提示/热词表/上下文/VAD/设备/凭证；环境变量可覆盖；
 * 命令行 `--provider` / `--model` / `--language` / `--device` / `--credentials` 优先级最高。
 * 凭证解析：阿里系（含 aliyun-qwen-file）环境变量 `DASHSCOPE_API_KEY`/`DASHSCOPE_WORKSPACE_ID`
 * > 配置 `asr.credentials` > 默认 `<cwd>/.tmp/aliyun`；mimo 走 `resolveMimoApiKey`
 * （env `MIMO_API_KEY` > 配置 `asr.mimoCredentials`，与 TTS 的 `tts.mimoCredentials` 相互独立、无 workspace）。
 * 凭证只读、绝不打印；错误信息统一脱敏。
 */

import { createAsrClient, type AsrClient, type AsrResult, type AsrTransport } from "../voice/asr/index.js";
import { AUDIO_FRAME_MS } from "../voice/aliyun.js";
import { formatCaptureExitFailure, listAudioDevices, MicCapture } from "../voice/capture.js";
import { loadVoiceConfig, resolveAsrParams, resolveAsrProvider, voiceConfigPath } from "../voice/config.js";
import { defaultCredentialsPath, resolveCredentials, resolveMimoApiKey, ASR_MIMO_CREDENTIALS_CONFIG_PATH } from "../voice/credentials.js";
import { noAudioDeviceGuidance } from "../voice/guidance.js";
import { LEVEL_EVENT_INTERVAL_MS, rmsToLevel } from "../voice/meter.js";
import { annotationForVoiceEmotion } from "../voice/mapping.js";
import { isTermux } from "../voice/platform.js";
import { encodeEvent, type RuntimeEvent, type RuntimeFinal } from "../voice/ndjson.js";
import { readWavAsPcm16, silencePcm } from "../voice/wav.js";
import { createStopController } from "./stop-signal.js";

/** 采集统计打印间隔（毫秒）。 */
const STATS_INTERVAL_MS = 2000;
/** WAV 自测尾部静音时长（毫秒）：给服务端 VAD 触发断句。 */
const WAV_TAIL_SILENCE_MS = 1000;
/** WAV 自测发送完后的额外等待（毫秒）：等最终结果回传。 */
const WAV_TAIL_WAIT_MS = 1500;

/** 命令行选项。 */
interface CliOptions {
  list: boolean;
  help: boolean;
  json: boolean;
  device?: string;
  wav?: string;
  inject?: string;
  model?: string;
  language?: string;
  provider?: string;
  credentials?: string;
  seconds?: number;
}

/**
 * 解析命令行参数。
 * @param argv 去掉 node/脚本名后的参数
 * @returns 归一化选项
 * @throws Error 缺少参数值或未知选项
 */
function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    list: false,
    help: false,
    json: false,
  };
  const takeValue = (index: number, flag: string): string => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`选项 ${flag} 缺少参数值`);
    }
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--list":
        options.list = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--device":
        options.device = takeValue(i, arg);
        i += 1;
        break;
      case "--wav":
        options.wav = takeValue(i, arg);
        i += 1;
        break;
      case "--inject":
        options.inject = takeValue(i, arg);
        i += 1;
        break;
      case "--model":
        options.model = takeValue(i, arg);
        i += 1;
        break;
      case "--language":
        options.language = takeValue(i, arg);
        i += 1;
        break;
      case "--provider":
        options.provider = takeValue(i, arg);
        i += 1;
        break;
      case "--credentials":
        options.credentials = takeValue(i, arg);
        i += 1;
        break;
      case "--seconds":
        options.seconds = Number.parseFloat(takeValue(i, arg));
        i += 1;
        break;
      default:
        throw new Error(`未知选项：${arg}（用 --help 查看用法）`);
    }
  }
  return options;
}

/** 打印用法。 */
function printHelp(): void {
  const lines = [
    "语音运行时：麦克风 → 阿里云实时 ASR → 情绪映射 → 打印/注入",
    "",
    "用法：node dist/runtime/voice-runtime.js [选项]",
    "",
    "配置优先级：命令行 > 环境变量 > emotions.jsonc > 内置默认",
    `配置文件：${voiceConfigPath()}`,
    "",
    "选项：",
    "  --list                列出音频输入设备后退出",
    "  --device <名>         指定麦克风设备（默认取第一个；亦可用 VOICE_DEVICE）",
    "  --wav <路径>          用 WAV 文件代替麦克风（非交互自测）",
    "  --seconds <秒>        采集指定秒数后结束（默认一直采到 Ctrl+C）",
    "  --inject <url>        最终结果 POST {text, emotion, annotation} 到该 URL",
    "  --json                以 NDJSON 输出事件到 stdout（供插件解析；人类日志转 stderr）",
    "  --provider <名>       ASR provider：aliyun-qwen(默认) | aliyun-8k | aliyun-v2 | aliyun-qwen-file(按段) | mimo(按段)",
    "  --model <名>          模型名（默认用 provider 预设）",
    "  --language <语言>     识别语言（默认空 = 自动识别）",
    "  --credentials <路径>  凭证文件（优先级：本选项 > VOICE_ALIYUN_CREDENTIALS/ALIYUN_CREDENTIALS > emotions.jsonc 的 asr.credentials.path > 默认 <cwd>/.tmp/aliyun）",
    "  --help                显示本帮助",
  ];
  console.log(lines.join("\n"));
}

/** 打印本机音频输入设备。 */
function printDevices(): void {
  const devices = listAudioDevices();
  if (devices.length === 0) {
    // 枚举成功但确实 0 设备：给面向用户的检查引导（ffmpeg 启动失败会先抛错，不会走到这里）
    console.log(noAudioDeviceGuidance());
    return;
  }
  console.log("音频输入设备：");
  devices.forEach((device, index) => {
    const alt = device.alternativeName ? `（备用名：${device.alternativeName}）` : "";
    console.log(`  [${index}] ${device.name}${alt}`);
  });
}

/**
 * 运行时的输出通道：`--json` 时 stdout 只承载 NDJSON，人类日志一律转 stderr，
 * 保证 stdout 可被插件逐行解析（契约见 `voice/ndjson.ts`）。
 */
interface RuntimeOutput {
  /** 人类可读信息（json 模式写 stderr，不污染 stdout）。 */
  info(message: string): void;
  /** 结构化事件（仅 json 模式写 stdout）。 */
  event(event: RuntimeEvent): void;
  /** 一条最终结果（json → NDJSON `final`；否则人类可读行）。 */
  final(result: RuntimeFinal): void;
  /** 错误（json → NDJSON `error`；否则 stderr）。 */
  error(message: string): void;
}

/**
 * 创建输出通道。
 * @param json 是否 `--json`（NDJSON）模式
 * @returns 输出通道
 */
function createOutput(json: boolean): RuntimeOutput {
  return {
    info(message: string): void {
      if (json) console.error(message);
      else console.log(message);
    },
    event(event: RuntimeEvent): void {
      if (json) process.stdout.write(encodeEvent(event));
    },
    final(result: RuntimeFinal): void {
      if (json) {
        process.stdout.write(encodeEvent({ type: "final", ...result }));
        return;
      }
      console.log(result.annotation ? `${result.text}  ${result.annotation}` : result.text);
    },
    error(message: string): void {
      if (json) process.stdout.write(encodeEvent({ type: "error", message }));
      else console.error(message);
    },
  };
}

/**
 * 解析要使用的设备名（入参已含「命令行 / 环境变量 / 配置」综合结果）。
 * @param explicit 显式设备名（空串/undefined 表示自动）
 * @returns 设备友好名
 * @throws Error 无可用设备
 */
function resolveDevice(explicit?: string): string {
  if (explicit && explicit.trim().length > 0) return explicit;
  // Termux 无 dshow 设备、采集走 termux-microphone-record；设备名仅占位（由采集器忽略）
  if (isTermux()) return "termux";
  const first = listAudioDevices()[0];
  if (!first) {
    // 枚举成功但 0 设备：给检查/指定设备的引导（ffmpeg 启动失败会先从 listAudioDevices 抛错）
    throw new Error(noAudioDeviceGuidance());
  }
  return first.name;
}

/**
 * 计算 16bit PCM 分片的平方和（用于累计 RMS）。
 * @param buf PCM 字节
 * @returns 平方和
 */
function sumOfSquares(buf: Buffer): number {
  const count = Math.floor(buf.length / 2);
  let sum = 0;
  for (let i = 0; i < count; i += 1) {
    const sample = buf.readInt16LE(i * 2) / 32768;
    sum += sample * sample;
  }
  return sum;
}

/**
 * 延时。
 * @param ms 毫秒
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

/**
 * 把 PCM 按实时节奏（每 frameMs 发一帧）喂给客户端，模拟真实麦克风（仅 stream 自测用）。
 * @param client ASR 客户端
 * @param pcm PCM 字节
 * @param sampleRate 采样率
 * @param frameMs 每帧毫秒
 */
async function feedRealtime(
  client: AsrClient,
  pcm: Buffer,
  sampleRate: number,
  frameMs: number,
): Promise<void> {
  const frameBytes = Math.floor((sampleRate * frameMs) / 1000) * 2;
  for (let offset = 0; offset < pcm.length; offset += frameBytes) {
    client.feed(pcm.subarray(offset, offset + frameBytes));
    await delay(frameMs);
  }
}

/**
 * POST 一条最终结果到注入 URL（失败仅告警，不影响主流程）。
 * @param url 注入地址
 * @param payload 结果载荷
 */
async function injectResult(
  url: string,
  payload: { text: string; emotion: string; annotation: string },
): Promise<void> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      console.error(`[注入失败] HTTP ${response.status}`);
    }
  } catch (err) {
    console.error(`[注入异常] ${(err as Error).message}`);
  }
}

/**
 * WAV 自测：
 * - stream：读取 WAV → 按实时节奏喂入 → 尾静音 → finish（模拟麦克风，行为不变）。
 * - segment：整个 WAV 作为**一段**直接喂入 → finish（无麦克风自测链路，一次 HTTP）。
 * @param client ASR 客户端
 * @param path WAV 路径
 * @param out 输出通道
 * @param sampleRate 目标采样率（来自 provider 预设）
 * @param transport 传输分类（决定喂入方式）
 */
async function runWav(
  client: AsrClient,
  path: string,
  out: RuntimeOutput,
  sampleRate: number,
  transport: AsrTransport,
): Promise<void> {
  const pcm = readWavAsPcm16(path, sampleRate);
  out.info(`WAV 自测：${path}（${pcm.length} 字节 PCM，${sampleRate}Hz 单声道）`);
  if (transport === "segment") {
    client.feed(pcm);
    await client.finish();
    return;
  }
  await feedRealtime(client, pcm, sampleRate, AUDIO_FRAME_MS);
  client.feed(silencePcm(WAV_TAIL_SILENCE_MS, sampleRate));
  await delay(WAV_TAIL_WAIT_MS);
  await client.finish();
}

/**
 * 麦克风模式：采集 → 喂流，按优雅停止（SIGINT/SIGTERM/stdin `stop`）或 `--seconds` 结束。
 *
 * 采集期间**并行**两路定时输出（都在同一事件循环内、无共享可变状态竞争）：
 * - 采集统计（stderr，`STATS_INTERVAL_MS`，人类日志）；
 * - **电平事件**（NDJSON `level`，`LEVEL_EVENT_INTERVAL_MS` 节流＝10Hz，供 TUI 槽位盲文音量列）：
 *   按「自上次上报以来的窗口」结算 RMS（不是自采集开始的累计平均，否则电平不会回落），
 *   经 `rmsToLevel` 归一后上行；**只在采集激活期间发**（停止控制器 resolve 即停表，`done` 之后不再发）。
 *
 * **就绪口径**：`ready` 改在**首个数据包到达**时才发（旧实现在采集启动前就发，采集进程挂掉时
 * 用户仍看到「在听」）。**异常口径**：采集进程非 0/异常信号退出或 0 字节音频 ⇒ 抛可识别错误
 * （由 `main` 统一发 `error` 并以退出码 1 结束），绝不停留在「假 ready + level:0」状态。
 * @param client ASR 客户端
 * @param device 设备名
 * @param seconds 采集秒数（可选）
 * @param out 输出通道
 * @param sampleRate 采集采样率（来自 provider 预设）
 * @param model 模型名（`ready` 事件回显）
 */
async function runMic(
  client: AsrClient,
  device: string,
  seconds: number | undefined,
  out: RuntimeOutput,
  sampleRate: number,
  model: string,
): Promise<void> {
  const capture = new MicCapture({ device, sampleRate });
  const stop = createStopController({ seconds });
  let capturedBytes = 0;
  let sampleCount = 0;
  let squareSum = 0;
  // 电平上报窗口（自上次上报以来的采样数 / 平方和，每次上报后清零）
  let windowSamples = 0;
  let windowSquareSum = 0;
  let readyAnnounced = false;
  /** 本进程主动停止（由 `capture.stop()` 触发的 close 不算失败）。 */
  let intentionalStop = false;
  /** 首个失败原因（只记一次，避免 error/close 双写）。 */
  let failure: string | null = null;
  /** 电平定时器（首个数据包后启动：保证事件顺序为 `ready` → `level`，且采集未就绪时无 0 电平刷屏）。 */
  let levelTimer: NodeJS.Timeout | undefined;

  /** 记录失败并收敛停止等待（幂等）。 */
  const fail = (message: string): void => {
    if (failure !== null || intentionalStop) return;
    failure = message;
    stop.finish();
  };

  capture.on("data", (chunk: Buffer) => {
    capturedBytes += chunk.length;
    if (!readyAnnounced) {
      readyAnnounced = true;
      // 首包 = 采集链路真的在工作：此刻才宣告 ready，并开始上报电平
      out.event({ type: "ready", model });
      levelTimer = setInterval(() => {
        const rms = windowSamples > 0 ? Math.sqrt(windowSquareSum / windowSamples) : 0;
        windowSamples = 0;
        windowSquareSum = 0;
        try {
          // 尽力而为：stdout 写失败 / 上一行未 flush 都**只丢这一帧**，绝不让采集与识别中断
          out.event({ type: "level", level: rmsToLevel(rms) });
        } catch {
          // 忽略：电平是可选视觉信息，不值得为此中断链路
        }
      }, LEVEL_EVENT_INTERVAL_MS);
    }
    const count = Math.floor(chunk.length / 2);
    const sum = sumOfSquares(chunk);
    sampleCount += count;
    squareSum += sum;
    windowSamples += count;
    windowSquareSum += sum;
    client.feed(chunk);
  });
  capture.on("error", (error: Error) => {
    fail(`采集失败：${error.message}`);
  });
  capture.on("close", (code: number | null) => {
    if (intentionalStop) return;
    // 非 0/异常信号退出，或 0 字节：一律按失败上报（不得继续发 level、不得悬挂）
    const message = formatCaptureExitFailure(code, capturedBytes, capture.diagnostics);
    if (message !== null) {
      fail(message);
      return;
    }
    // 退出码 0 且有音频：采集自然结束，等同于停止
    stop.finish();
  });

  try {
    capture.start();
  } catch (err) {
    // 启动期抛错（ffmpeg 路径解析/spawn）：先摘掉停止通道监听，避免 stdin 句柄把进程拖住
    stop.dispose();
    throw err;
  }
  out.info(`采集中：device=${device}（Ctrl+C 结束${seconds ? `，或 ${seconds}s 后` : ""}）`);

  const statsTimer = setInterval(() => {
    const rms = sampleCount > 0 ? Math.sqrt(squareSum / sampleCount) : 0;
    out.info(`[采集] 采样数=${sampleCount} RMS=${rms.toFixed(5)}`);
  }, STATS_INTERVAL_MS);

  try {
    await stop.stopped;
  } finally {
    // 先停表再停采集：失败/正常路径都不再发 level
    clearInterval(statsTimer);
    if (levelTimer !== undefined) clearInterval(levelTimer);
    stop.dispose();
  }
  intentionalStop = true;
  capture.stop();
  if (failure !== null) throw new Error(failure);
  await client.finish();
}

/**
 * 主流程。
 */
async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (options.list) {
    printDevices();
    return;
  }

  const config = loadVoiceConfig();
  const provider = resolveAsrProvider(options.provider ?? config.asr.provider);
  const model = options.model?.trim() || config.asr.model.trim() || provider.model;
  const device = options.device ?? config.device;
  const asrParams = resolveAsrParams(provider, {
    language: options.language ?? config.asr.language,
    languageHints: config.asr.languageHints,
    vocabularyId: config.asr.vocabularyId,
    context: config.asr.context,
  });
  if (asrParams.ignored.length > 0) {
    // 「debug 日志」：本项目 logger 无 debug 级别，退化到 stderr（--json 时不影响 stdout）
    console.error(`[ASR] provider=${provider.id} 忽略不支持的参数：${asrParams.ignored.join("、")}`);
  }
  const language = asrParams.language;

  // 凭证分流：mimo 走 resolveMimoApiKey（env MIMO_API_KEY > asr.mimoCredentials，与 tts.mimoCredentials 相互独立、无 workspace）；
  // 其余 provider（含 aliyun-qwen-file 按段）沿用 resolveCredentials（env > asr.credentials > 凭证文件）。
  let credentials: { workspace: string; apiKey: string } | undefined;
  let mimoApiKey: string | undefined;
  if (provider.id === "mimo") {
    mimoApiKey = resolveMimoApiKey({ config: config.asr.mimoCredentials, configPath: ASR_MIMO_CREDENTIALS_CONFIG_PATH });
  } else {
    credentials = resolveCredentials({
      config: config.asr.credentials,
      cliPath: options.credentials,
      defaultPath: defaultCredentialsPath(),
      section: "asr",
      providerLabel: provider.id,
    });
  }
  const out = createOutput(options.json);
  const onFinal = (result: AsrResult): void => {
    const text = result.text.trim();
    if (text.length === 0) return;
    const annotation = annotationForVoiceEmotion(result.emotion);
    out.final({ text, emotion: result.emotion, annotation: annotation ?? "" });
    if (options.inject) {
      void injectResult(options.inject, {
        text,
        emotion: result.emotion,
        annotation: annotation ?? "",
      });
    }
  };

  // 按 provider 工厂分流（stream=阿里 WS 两方言；segment=阿里按段 / MiMo 按段），运行时只依赖 AsrClient 接口
  const client = createAsrClient({
    preset: provider,
    model,
    language,
    languageHints: asrParams.languageHints,
    vocabularyId: asrParams.vocabularyId,
    context: asrParams.context,
    vad: { threshold: config.vad.threshold, silenceDurationMs: config.vad.silenceDurationMs },
    credentials,
    mimoApiKey,
    onResult: (result: AsrResult) => {
      if (result.isFinal) onFinal(result);
    },
    onError: (message: string) => {
      if (options.json) out.error(message);
      else console.error(`[ASR 错误] ${message}`);
    },
  });

  try {
    await client.connect();
    out.info(
      `ASR 已连接：provider=${provider.id} model=${model} language=${language || "自动"}${
        options.wav ? "（WAV 自测）" : ""
      }`,
    );
    if (options.wav) {
      // WAV 自测无采集进程：连接成功即「就绪」
      out.event({ type: "ready", model });
      await runWav(client, options.wav, out, provider.sampleRate, client.transport);
    } else {
      // 麦克风模式：`ready` 由 runMic 在**首包到达**时发（采集进程异常退出则绝不发）
      await runMic(client, resolveDevice(device), options.seconds, out, provider.sampleRate, model);
    }
  } finally {
    client.close();
  }

  out.event({ type: "done" });
  if (client.errorMessage) {
    if (options.json) out.error(client.errorMessage);
    else console.error(`[voice-runtime] 结束（有错误）：${client.errorMessage}`);
    process.exitCode = 1;
  }
}

void main().catch((err: Error) => {
  const message = err.message;
  console.error(`[voice-runtime] ${message}`);
  // --json 模式：致命错误（ffmpeg/设备/凭证缺失等配置引导）也走 NDJSON error，
  // TUI toast 直接展示文案；stderr 行保留供日志与 runtimeExited 摘要兜底。
  if (process.argv.includes("--json")) {
    process.stdout.write(encodeEvent({ type: "error", message }));
  }
  process.exitCode = 1;
});
