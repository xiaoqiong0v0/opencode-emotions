/**
 * 句间停顿优化·预取（2026-10-22 第十四批）离线单测：
 * 预取深度归一化、WAV 只读头、PCM 落盘 sink（上限/裁剪/清理）、参数解析、交播闸门顺序。
 *
 * 「修复前如何红」：这些能力（`--pcm-out`/`--pcm-file`/`PcmFileSink`）修复前**不存在**，
 * 导入即失败；`runPlayPcmFile` 的「预热阶段不登记、不写音频」在旧实现里无从谈起（旧 CLI 只有
 * 合成+播放一体），因此本文件断言的是新增契约本身。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { buildWavHeader, parseWav, readWavHeader, WAV_HEADER_BYTES } from "../dist/voice/wav.js";
import { PcmFileSink } from "../dist/voice/tts/audio-sink.js";
import {
  normalizePrefetchDepth,
  PREFETCH_DEPTH_DEFAULT,
  PREFETCH_DEPTH_MAX,
  resolvePrefetchDepth,
} from "../dist/voice/tts/prefetch.js";
import {
  AWAIT_GO_LINE,
  PCM_FOLLOW_ABORT_LINE,
  PCM_PLAY_EXIT_PARTIAL,
  PCM_FILE_FLAG,
  PCM_OUT_FLAG,
  parseCliArgs,
} from "../dist/voice/cli.js";
import { runPlayPcmFile } from "../dist/cli/emotions-cli.js";
import { splitDrainUnitSpans, splitDrainUnits } from "../dist/voice/auto-read.js";

/** 轮询等待条件成立（跟随模式的读写是异步/跨轮询交互的）。 */
async function waitFor(predicate, timeoutMs = 2000, label = "条件") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`waitFor 超时：${label}`);
}

/** 生成一段「立即有声」的 s16le 方波（避开首尾静音裁剪）。 */
function loudPcm(samples) {
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) buf.writeInt16LE(i % 2 === 0 ? 8000 : -8000, i * 2);
  return buf;
}

/** 临时目录注册（用例结束清理）。 */
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "oc-prefetch-test-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** 记录调用的假 sink（只实现 AudioSink 契约）。 */
function fakeSink() {
  const writes = [];
  let aborted = false;
  let prewarmed = 0;
  const sink = {
    kind: "stream",
    id: "fake",
    write: (chunk) => writes.push(chunk.length),
    boundary: () => {},
    end: async () => {},
    abort: () => {
      aborted = true;
    },
    trimStats: () => ({ inputMs: 0, emittedMs: 0, leadingTrimmedMs: 0, trailingTrimmedMs: 0 }),
    prewarm: () => {
      prewarmed += 1;
    },
  };
  return {
    sink,
    writes,
    get aborted() {
      return aborted;
    },
    get prewarmed() {
      return prewarmed;
    },
  };
}

test("normalizePrefetchDepth / resolvePrefetchDepth：默认 1、0 关闭、>1 夹到 1、非法回默认", () => {
  assert.equal(PREFETCH_DEPTH_DEFAULT, 1);
  assert.equal(PREFETCH_DEPTH_MAX, 1);
  assert.equal(normalizePrefetchDepth(undefined), 1);
  assert.equal(normalizePrefetchDepth(Number.NaN), 1);
  assert.equal(normalizePrefetchDepth(-3), 0);
  assert.equal(normalizePrefetchDepth(0), 0);
  assert.equal(normalizePrefetchDepth(5), 1);
  assert.equal(resolvePrefetchDepth({}), 1);
  assert.equal(resolvePrefetchDepth({ TTS_PREFETCH_DEPTH: "0" }), 0);
  assert.equal(resolvePrefetchDepth({ TTS_PREFETCH_DEPTH: "9" }), 1);
  assert.equal(resolvePrefetchDepth({ TTS_PREFETCH_DEPTH: "abc" }), 1);
});

test("readWavHeader：只读头即可拿到采样率/data 区间（不加载 data）", () => {
  const { dir, cleanup } = tempDir();
  try {
    const pcm = loudPcm(240);
    const path = join(dir, "a.wav");
    writeFileSync(path, Buffer.concat([buildWavHeader(pcm.length, 24000), pcm]));
    const info = readWavHeader(path);
    assert.equal(info.sampleRate, 24000);
    assert.equal(info.channels, 1);
    assert.equal(info.bitsPerSample, 16);
    assert.equal(info.dataOffset, WAV_HEADER_BYTES);
    assert.equal(info.dataBytes, pcm.length);
  } finally {
    cleanup();
  }
});

test("PcmFileSink：写标准 WAV（头长度回填、走静音裁剪、abort 删文件）", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const path = join(dir, "out.wav");
    const sink = new PcmFileSink(path, 24000);
    const pcm = loudPcm(2400);
    sink.write(pcm.subarray(0, 1000));
    sink.write(pcm.subarray(1000));
    await sink.end();
    assert.equal(sink.bytesWritten, pcm.length);
    const parsed = parseWav(readFileSync(path));
    assert.equal(parsed.sampleRate, 24000);
    assert.equal(parsed.bitsPerSample, 16);
    assert.equal(parsed.data.length, pcm.length);

    const path2 = join(dir, "abort.wav");
    const sink2 = new PcmFileSink(path2, 24000);
    sink2.write(pcm);
    sink2.abort();
    assert.equal(existsSync(path2), false, "abort 必须删除半成品文件");
  } finally {
    cleanup();
  }
});

test("PcmFileSink：超过上限即失败并删除半成品（有界，不无界增长）", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const path = join(dir, "cap.wav");
    // 上限只保留给病态防御/单测；生产默认不限（边合成边播不能被截断）
    const sink = new PcmFileSink(path, 24000, { maxBytes: 1000 });
    sink.write(loudPcm(2000));
    await assert.rejects(() => sink.end(), /超过上限/);
    assert.equal(existsSync(path), false);
  } finally {
    cleanup();
  }
});

test("PcmFileSink：预取落盘路径同样执行首尾静音裁剪（不绕过 silence-trim）", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const bytesPerMs = (24000 * 2) / 1000; // 48 字节/毫秒（24kHz 16bit 单声道）
    const path = join(dir, "trim.wav");
    const sink = new PcmFileSink(path, 24000);
    const leading = Buffer.alloc(200 * bytesPerMs); // 200ms 首部静音
    const voice = loudPcm(200 * 24); // 200ms 有声
    const trailing = Buffer.alloc(400 * bytesPerMs); // 400ms 尾部静音
    const all = Buffer.concat([leading, voice, trailing]);
    // 分块喂入（跨块帧对齐不应影响判定）
    for (let i = 0; i < all.length; i += 4096) sink.write(all.subarray(i, i + 4096));
    await sink.end();

    const parsed = parseWav(readFileSync(path));
    const stats = sink.trimStats();
    const emittedMs = parsed.data.length / bytesPerMs;
    assert.ok(stats.leadingTrimmedMs >= 190, `首部静音应被裁掉（实际 ${stats.leadingTrimmedMs}ms）`);
    assert.ok(stats.trailingTrimmedMs >= 290, `尾部静音应被裁到只剩保护余量（实际 ${stats.trailingTrimmedMs}ms）`);
    assert.ok(stats.trailingTrimmedMs <= 310, `尾部保护余量约 100ms（实际裁 ${stats.trailingTrimmedMs}ms）`);
    assert.ok(Math.abs(stats.inputMs - 800) <= 11, `输入时长约 800ms（实际 ${stats.inputMs}ms）`);
    assert.ok(
      emittedMs >= 280 && emittedMs <= 320,
      `落盘 data 约 200ms 语声 + 100ms 保护余量（实际 ${emittedMs.toFixed(1)}ms）`,
    );
    assert.ok(parsed.data.length < all.length, "落盘必须比原始 PCM 短（确实裁掉了静音）");
  } finally {
    cleanup();
  }
});

test("runPlayPcmFile 跟随模式：头到达即预热（go 之前），go 之后才写音频/登记", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const pcm = loudPcm(960);
    const path = join(dir, "prewarm.wav");
    writeFileSync(path, Buffer.concat([buildWavHeader(pcm.length, 24000), pcm]));
    const control = new PassThrough();
    const fake = fakeSink();
    let registerCount = 0;
    const running = runPlayPcmFile(
      { kind: "speak", text: "", background: false, follow: false, pcmFile: path, pcmFollow: true },
      {
        createSink: () => fake.sink,
        controlStream: control,
        followPollMs: 5,
        registerPlayback: () => {
          registerCount += 1;
        },
        clearPlayback: () => {},
        announceStart: () => {},
      },
    );
    // 未写 go：头已读到 ⇒ 已完成预热；但不得写音频/登记在播（否则半双工门误判）
    await waitFor(() => fake.prewarmed === 1, 1000, "go 之前预热");
    assert.equal(fake.writes.length, 0, "go 之前不得写任何音频");
    assert.equal(registerCount, 0, "go 之前不得登记 tts-playback");

    control.write(`${AWAIT_GO_LINE}\n`);
    await waitFor(() => fake.writes.length > 0, 1000, "go 之后写入音频");
    assert.equal(registerCount, 1, "交播点才登记");
    control.write("done\n");
    control.end();
    assert.equal(await running, 0);
    assert.equal(fake.writes.reduce((sum, n) => sum + n, 0), pcm.length, "完整播放全部 data");
  } finally {
    cleanup();
  }
});

test("runPlayPcmFile 跟随模式：写端 abort ⇒ 退出码 3、只播已到达部分、明确报错不重读", async () => {
  const { dir, cleanup } = tempDir();
  const stderrChunks = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    stderrChunks.push(String(chunk));
    return true;
  };
  try {
    const pcm = loudPcm(4800); // 200ms @24kHz
    const path = join(dir, "grow.wav");
    // 头先落盘、data 后到（模拟合成进程仍在写）
    writeFileSync(path, buildWavHeader(pcm.length, 24000));
    const control = new PassThrough();
    const fake = fakeSink();
    let registerCount = 0;
    let clearCount = 0;
    const running = runPlayPcmFile(
      { kind: "speak", text: "", background: false, follow: false, pcmFile: path, pcmFollow: true },
      {
        createSink: () => fake.sink,
        controlStream: control,
        followPollMs: 5,
        registerPlayback: () => {
          registerCount += 1;
        },
        clearPlayback: () => {
          clearCount += 1;
        },
        announceStart: () => {},
      },
    );
    control.write(`${AWAIT_GO_LINE}\n`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // 分两次追加（跟随读必须只读已落盘的完整采样点）
    writeFileSync(path, Buffer.concat([readFileSync(path), pcm.subarray(0, 4800)]));
    await waitFor(() => fake.writes.length > 0, 1000, "首批音频");
    writeFileSync(path, Buffer.concat([readFileSync(path), pcm.subarray(4800)]));
    await waitFor(
      () => fake.writes.reduce((sum, n) => sum + n, 0) === pcm.length,
      1000,
      "全部音频到达",
    );
    const writesAtAbort = [...fake.writes];
    control.write(`${PCM_FOLLOW_ABORT_LINE}\n`);
    control.end();

    const code = await running;
    assert.equal(code, PCM_PLAY_EXIT_PARTIAL, "写端异常且已播部分 ⇒ 退出码 3");
    assert.equal(fake.aborted, true, "必须中断 sink（不得把异常当完整播完）");
    assert.deepEqual(fake.writes, writesAtAbort, "已读字节不得重读（顺序/数量都不得变化）");
    assert.equal(fake.writes.reduce((sum, n) => sum + n, 0), pcm.length, "只播已到达部分，且每个字节一次");
    const stderr = stderrChunks.join("");
    assert.ok(stderr.includes("写端异常"), `stderr 必须有明确错误（实际：${stderr.trim()}）`);
    assert.ok(stderr.includes("不会重读"), "错误信息必须说明不重读（避免重复）");
    assert.equal(registerCount, 1, "交播后登记一次");
    assert.equal(clearCount, 1, "退出前清理登记");
  } finally {
    process.stderr.write = originalWrite;
    cleanup();
  }
});

test("runPlayPcmFile 跟随模式：写入播放器抛错且已播部分 ⇒ 退出码 3（回 1 会被当未起播而重读=双播）", async () => {
  const { dir, cleanup } = tempDir();
  const stderrChunks = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    stderrChunks.push(String(chunk));
    return true;
  };
  try {
    // 1s 音频（96000B > 单次 64KB 读块）⇒ 第一次写成功，第二次写抛错
    const pcm = loudPcm(48000);
    const path = join(dir, "throw.wav");
    writeFileSync(path, Buffer.concat([buildWavHeader(pcm.length, 24000), pcm]));
    const control = new PassThrough();
    const writes = [];
    let aborted = false;
    const sink = {
      kind: "stream",
      id: "fake",
      write: (chunk) => {
        if (writes.length > 0) throw new Error("播放器写入失败");
        writes.push(chunk.length);
      },
      boundary: () => {},
      end: async () => {},
      abort: () => {
        aborted = true;
      },
      trimStats: () => ({ inputMs: 0, emittedMs: 0, leadingTrimmedMs: 0, trailingTrimmedMs: 0 }),
      prewarm: () => {},
    };
    const running = runPlayPcmFile(
      { kind: "speak", text: "", background: false, follow: false, pcmFile: path, pcmFollow: true },
      {
        createSink: () => sink,
        controlStream: control,
        followPollMs: 5,
        registerPlayback: () => {},
        clearPlayback: () => {},
        announceStart: () => {},
      },
    );
    control.write(`${AWAIT_GO_LINE}\n`);
    const code = await running;
    assert.equal(writes.length, 1, "首个读块已写入（已出声）");
    assert.equal(aborted, true, "异常必须中断 sink");
    assert.equal(code, PCM_PLAY_EXIT_PARTIAL, "已出声后异常 ⇒ 3（绝不能是 1=从未起播，否则调用方重读=双播）");
  } finally {
    process.stderr.write = originalWrite;
    cleanup();
  }
});

test("runPlayPcmFile 静态模式：复用 assertPlayableHeader 后仍拒绝空 data 区", async () => {
  const { dir, cleanup } = tempDir();
  const stderrChunks = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    stderrChunks.push(String(chunk));
    return true;
  };
  try {
    const path = join(dir, "empty.wav");
    writeFileSync(path, buildWavHeader(0, 24000));
    let sinkCreated = 0;
    const code = await runPlayPcmFile(
      { kind: "speak", text: "", background: false, follow: false, pcmFile: path, awaitGo: false },
      {
        createSink: () => {
          sinkCreated += 1;
          return fakeSink().sink;
        },
        registerPlayback: () => {},
        clearPlayback: () => {},
        announceStart: () => {},
      },
    );
    assert.equal(code, 1, "静态模式 data 区为空必须失败");
    assert.equal(sinkCreated, 0, "头校验失败不得创建/预热 sink");
    assert.ok(stderrChunks.join("").includes("data 区为空"), "错误信息应说明 data 区为空");
  } finally {
    process.stderr.write = originalWrite;
    cleanup();
  }
});

test("splitDrainUnitSpans：句间空白不错位，原文消费终点与剩余文本一致", () => {
  const merged = "第一句话。  第二句话。还没完";
  const { units, carry } = splitDrainUnitSpans(merged);
  assert.deepEqual(units.map((u) => u.text), ["第一句话。第二句话。"]);
  assert.equal(merged.slice(0, units[0].end), "第一句话。  第二句话。");
  assert.equal(units[0].end, "第一句话。  第二句话。".length);
  assert.equal(merged.slice(units[0].end), "还没完");
  assert.equal(carry, "还没完");
  // 与不带偏移的既有函数同口径
  assert.deepEqual(splitDrainUnits(merged), { units: ["第一句话。第二句话。"], carry: "还没完" });
});

test("parseCliArgs：--pcm-out / --pcm-file / --await-go 及互斥", () => {
  const out = parseCliArgs(["speak", "--text", "你好", PCM_OUT_FLAG, "a.wav"]);
  assert.equal(out.kind, "speak");
  assert.equal(out.pcmOut, "a.wav");
  assert.equal(out.text, "你好");

  const fromFile = parseCliArgs(["speak", "--text-file", "t.txt", PCM_OUT_FLAG, "a.wav"]);
  assert.equal(fromFile.pcmOut, "a.wav");
  assert.equal(fromFile.textFile, "t.txt");

  const play = parseCliArgs(["speak", PCM_FILE_FLAG, "a.wav", "--await-go"]);
  assert.equal(play.pcmFile, "a.wav");
  assert.equal(play.awaitGo, true);
  assert.equal(play.text, "");

  const playNoGate = parseCliArgs(["speak", PCM_FILE_FLAG, "a.wav"]);
  assert.equal(playNoGate.awaitGo, false);

  // 跟随增长模式：隐含交播闸门（--pcm-follow 只能配 --pcm-file）
  const follow = parseCliArgs(["speak", PCM_FILE_FLAG, "a.wav", "--pcm-follow"]);
  assert.equal(follow.kind, "speak");
  assert.equal(follow.pcmFollow, true);
  assert.equal(follow.awaitGo, false);
  assert.equal(parseCliArgs(["speak", "--pcm-follow", "--text", "x"]).kind, "error");

  assert.equal(parseCliArgs(["speak", "--follow", PCM_OUT_FLAG, "a.wav"]).kind, "error");
  assert.equal(parseCliArgs(["speak", "--text", "x", "--background", PCM_OUT_FLAG, "a.wav"]).kind, "error");
  assert.equal(parseCliArgs(["speak", PCM_FILE_FLAG, "a.wav", "--text", "x"]).kind, "error");
  assert.equal(parseCliArgs(["speak", "--await-go", "--text", "x"]).kind, "error");
  assert.equal(parseCliArgs(["speak", PCM_OUT_FLAG]).kind, "error");
});

test("runPlayPcmFile：闸门前不登记/不写音频，放行后才写（预取不得让门误判在播）", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const pcm = loudPcm(480);
    const path = join(dir, "play.wav");
    writeFileSync(path, Buffer.concat([buildWavHeader(pcm.length, 24000), pcm]));
    const fake = fakeSink();
    let registerCount = 0;
    let clearCount = 0;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const running = runPlayPcmFile(
      { kind: "speak", text: "", background: false, follow: false, pcmFile: path, awaitGo: true },
      {
        createSink: () => fake.sink,
        awaitGo: () => gate,
        registerPlayback: () => {
          registerCount += 1;
        },
        clearPlayback: () => {
          clearCount += 1;
        },
        announceStart: () => {},
      },
    );
    // 等一个宏任务：预热已完成、但闸门未放行
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(fake.prewarmed, 1, "必须先预热播放器");
    assert.equal(registerCount, 0, "闸门前不得登记 tts-playback（否则预取会被判为正在播放）");
    assert.equal(fake.writes.length, 0, "闸门前不得写任何音频");
    release(true);
    assert.equal(await running, 0);
    assert.equal(registerCount, 1, "交播点才登记");
    assert.equal(clearCount, 1, "结束后清理登记");
    assert.equal(fake.writes.length > 0, true);
    assert.equal(fake.writes.reduce((sum, n) => sum + n, 0), pcm.length);
  } finally {
    cleanup();
  }
});

test("runPlayPcmFile：闸门未放行（stdin 先 EOF）⇒ 不播、不登记、退出 0", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const pcm = loudPcm(120);
    const path = join(dir, "skip.wav");
    writeFileSync(path, Buffer.concat([buildWavHeader(pcm.length, 24000), pcm]));
    const fake = fakeSink();
    let registerCount = 0;
    const code = await runPlayPcmFile(
      { kind: "speak", text: "", background: false, follow: false, pcmFile: path, awaitGo: true },
      {
        createSink: () => fake.sink,
        awaitGo: async () => false,
        registerPlayback: () => {
          registerCount += 1;
        },
        clearPlayback: () => {},
      },
    );
    assert.equal(code, 0);
    assert.equal(registerCount, 0);
    assert.equal(fake.writes.length, 0);
    assert.equal(fake.aborted, true);
  } finally {
    cleanup();
  }
});

test("AWAIT_GO_LINE：交播协议常量为 go（父子进程共用的唯一口径）", () => {
  assert.equal(AWAIT_GO_LINE, "go");
});
