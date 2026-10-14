/**
 * 语音运行时命令行入口（纯 Node/TS，可独立运行）。
 *
 * 链路：麦克风采集（ffmpeg-static）→ 阿里云实时 ASR → 情绪映射 → 打印每句最终结果。
 * 也可用 `--wav <path>` 以 WAV 文件代替麦克风（非交互自测，云端链路验证）。
 *
 * 用法示例：
 *   node dist/runtime/voice-runtime.js --list
 *   node dist/runtime/voice-runtime.js --wav .tmp/scratch/rt-asr/models/.../test_wavs/0.wav
 *   node dist/runtime/voice-runtime.js --device "麦克风 (USB Audio)"
 *   node dist/runtime/voice-runtime.js --device "麦克风 (USB Audio)" --inject http://127.0.0.1:8799/inject
 *
 * 配置来源（不写死）：`<配置目录>/emotions.jsonc`（配置目录 = `~/.config/opencode`）提供
 * provider/模型/语言/语言提示/热词表/上下文/VAD/设备/凭证；环境变量可覆盖；
 * 命令行 `--provider` / `--model` / `--language` / `--device` / `--credentials` 优先级最高。
 * 凭证解析：环境变量 `DASHSCOPE_API_KEY`/`DASHSCOPE_WORKSPACE_ID` > 配置 `asr.credentials` > 默认 `<cwd>/.tmp/aliyun`。
 * 凭证只读、绝不打印；错误信息统一脱敏。
 */

import { AliyunAsrClient, AUDIO_FRAME_MS, type AsrResult } from "../voice/aliyun.js";
import { listAudioDevices, MicCapture } from "../voice/capture.js";
import { loadVoiceConfig, resolveAsrParams, resolveAsrProvider, voiceConfigPath } from "../voice/config.js";
import { defaultCredentialsPath, resolveCredentials } from "../voice/credentials.js";
import { annotationForVoiceEmotion } from "../voice/mapping.js";
import { encodeEvent, type RuntimeEvent, type RuntimeFinal } from "../voice/ndjson.js";
import { readWavAsPcm16, silencePcm } from "../voice/wav.js";

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
    "  --provider <名>       ASR provider：aliyun-qwen(默认) | aliyun-8k | aliyun-v2",
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
    console.log("未找到音频输入设备");
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
  const first = listAudioDevices()[0];
  if (!first) {
    throw new Error("未找到音频输入设备（可用 --list 查看）");
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
 * 把 PCM 按实时节奏（每 frameMs 发一帧）喂给客户端，模拟真实麦克风。
 * @param client ASR 客户端
 * @param pcm PCM 字节
 * @param sampleRate 采样率
 * @param frameMs 每帧毫秒
 */
async function feedRealtime(
  client: AliyunAsrClient,
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
 * WAV 自测：读取 WAV → 按实时节奏喂入 → 尾静音 → finish。
 * @param client ASR 客户端
 * @param path WAV 路径
 * @param out 输出通道
 * @param sampleRate 目标采样率（来自 provider 预设）
 */
async function runWav(client: AliyunAsrClient, path: string, out: RuntimeOutput, sampleRate: number): Promise<void> {
  const pcm = readWavAsPcm16(path, sampleRate);
  out.info(`WAV 自测：${path}（${pcm.length} 字节 PCM，${sampleRate}Hz 单声道）`);
  await feedRealtime(client, pcm, sampleRate, AUDIO_FRAME_MS);
  client.feed(silencePcm(WAV_TAIL_SILENCE_MS, sampleRate));
  await delay(WAV_TAIL_WAIT_MS);
  await client.finish();
}

/**
 * 麦克风模式：采集 → 喂流，按 Ctrl+C 或 --seconds 结束。
 * @param client ASR 客户端
 * @param device 设备名
 * @param seconds 采集秒数（可选）
 * @param out 输出通道
 * @param sampleRate 采集采样率（来自 provider 预设）
 */
async function runMic(
  client: AliyunAsrClient,
  device: string,
  seconds: number | undefined,
  out: RuntimeOutput,
  sampleRate: number,
): Promise<void> {
  const capture = new MicCapture({ device, sampleRate });
  let sampleCount = 0;
  let squareSum = 0;

  capture.on("data", (chunk: Buffer) => {
    sampleCount += Math.floor(chunk.length / 2);
    squareSum += sumOfSquares(chunk);
    client.feed(chunk);
  });
  capture.on("error", (error: Error) => {
    console.error(`[采集错误] ${error.message}`);
  });
  capture.on("close", (code: number | null) => {
    console.error(`[采集结束] ffmpeg 退出码=${code}`);
  });

  capture.start();
  out.info(`采集中：device=${device}（Ctrl+C 结束${seconds ? `，或 ${seconds}s 后` : ""}）`);

  const statsTimer = setInterval(() => {
    const rms = sampleCount > 0 ? Math.sqrt(squareSum / sampleCount) : 0;
    out.info(`[采集] 采样数=${sampleCount} RMS=${rms.toFixed(5)}`);
  }, STATS_INTERVAL_MS);

  await waitForStop(seconds);
  clearInterval(statsTimer);
  capture.stop();
  if (sampleCount === 0 && capture.diagnostics) {
    console.error("未采集到任何 PCM 数据，ffmpeg stderr 尾部：");
    console.error(capture.diagnostics.trim());
  }
  await client.finish();
}

/**
 * 等待停止信号：Ctrl+C 或到达指定秒数。
 * @param seconds 采集秒数（可选）
 */
function waitForStop(seconds?: number): Promise<void> {
  return new Promise<void>((resolveWait) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      process.off("SIGINT", finish);
      resolveWait();
    };
    process.on("SIGINT", finish);
    if (seconds && seconds > 0) {
      setTimeout(finish, seconds * 1000);
    }
  });
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

  const credentials = resolveCredentials({
    config: config.asr.credentials,
    cliPath: options.credentials,
    defaultPath: defaultCredentialsPath(),
  });
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

  const client = new AliyunAsrClient({
    workspace: credentials.workspace,
    apiKey: credentials.apiKey,
    protocol: provider.protocol,
    model,
    sampleRate: provider.sampleRate,
    language,
    languageHints: asrParams.languageHints,
    vocabularyId: asrParams.vocabularyId,
    context: asrParams.context,
    vad: { threshold: config.vad.threshold, silenceDurationMs: config.vad.silenceDurationMs },
    extendedV2: provider.extendedV2,
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
    out.event({ type: "ready", model });
    if (options.wav) {
      await runWav(client, options.wav, out, provider.sampleRate);
    } else {
      await runMic(client, resolveDevice(device), options.seconds, out, provider.sampleRate);
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
  console.error(`[voice-runtime] ${err.message}`);
  process.exitCode = 1;
});
