/**
 * Linux 采集后端（pulse → alsa 回退）的离线单测：分派、argv、枚举解析、回退决策与一次回退接线。
 * 不启动真实 ffmpeg / pactl / arecord（全部注入）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  PULSE_FALLBACK_WINDOW_MS,
  MicCapture,
  buildAlsaArgs,
  buildCaptureArgs,
  buildFfmpegCaptureArgs,
  buildPulseArgs,
  getDefaultPulseSource,
  isPulseStartupFailure,
  orderLinuxDevicesForDisplay,
  prioritizeMicrophoneDevices,
  resolveAlsaFallbackDevice,
  resolveDefaultLinuxDevice,
  resolveLinuxCaptureDevice,
  listLinuxAudioDevices,
  parseArecordDevices,
  parsePactlShortSources,
  parsePactlSources,
  resolveCaptureBackend,
  resolveCaptureDevice,
  shouldFallbackToAlsa,
} from "../dist/voice/capture.js";

test("resolveCaptureBackend：win32→dshow / termux→termux / linux→pulse / preferAlsa→alsa", () => {
  assert.equal(resolveCaptureBackend({ platform: "win32", isTermux: false }), "dshow");
  assert.equal(resolveCaptureBackend({ platform: "android", isTermux: false }), "termux");
  assert.equal(resolveCaptureBackend({ platform: "linux", isTermux: true }), "termux");
  assert.equal(resolveCaptureBackend({ platform: "linux", isTermux: false }), "pulse");
  assert.equal(resolveCaptureBackend({ platform: "linux", isTermux: false, preferAlsa: true }), "alsa");
});

test("resolveCaptureBackend：不支持的平台（darwin）给出可读错误，不静默走 dshow", () => {
  assert.throws(
    () => resolveCaptureBackend({ platform: "darwin", isTermux: false }),
    (err) => /darwin/.test(err.message) && /暂不支持/.test(err.message) && /Linux/.test(err.message),
  );
});

test("buildPulseArgs：精确 argv（逐项断言）", () => {
  assert.deepEqual(buildPulseArgs({ device: "alsa_input.usb-mic", sampleRate: 16000 }), [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "pulse",
    "-i",
    "alsa_input.usb-mic",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-f",
    "s16le",
    "-",
  ]);
});

test("buildAlsaArgs：精确 argv（device 缺省 default）", () => {
  assert.deepEqual(buildAlsaArgs({ device: "", sampleRate: 8000 }), [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "alsa",
    "-i",
    "default",
    "-ac",
    "1",
    "-ar",
    "8000",
    "-f",
    "s16le",
    "-",
  ]);
  assert.deepEqual(buildAlsaArgs({ device: "hw:1,0" }).slice(4, 7), ["alsa", "-i", "hw:1,0"]);
});

test("buildFfmpegCaptureArgs：dshow 与旧 buildCaptureArgs 逐参数等价", () => {
  assert.deepEqual(
    buildFfmpegCaptureArgs("dshow", "麦克风 (USB Audio)", 16000),
    buildCaptureArgs("麦克风 (USB Audio)", 16000),
  );
  assert.deepEqual(buildFfmpegCaptureArgs("pulse", ""), buildPulseArgs({ device: "" }));
});

test("resolveCaptureDevice：空/空白 → default；source 名与 hw:C,D 原样；dshow 不变", () => {
  assert.equal(resolveCaptureDevice("pulse", ""), "default");
  assert.equal(resolveCaptureDevice("pulse", "   "), "default");
  assert.equal(resolveCaptureDevice("alsa", "hw:0,0"), "hw:0,0");
  assert.equal(resolveCaptureDevice("pulse", "alsa_input.pci-0000_00_1f.3.analog-stereo"), "alsa_input.pci-0000_00_1f.3.analog-stereo");
  assert.equal(resolveCaptureDevice("dshow", ""), "");
});

test("parsePactlShortSources：正常/空/格式异常", () => {
  const normal = ["48\talsa_input.usb-mic\tmodule-alsa-card.c\ts16le 1ch 16000Hz\tSUSPENDED"].join("\n");
  assert.deepEqual(parsePactlShortSources(normal), [
    { name: "alsa_input.usb-mic", value: "alsa_input.usb-mic" },
  ]);
  assert.deepEqual(parsePactlShortSources(""), []);
  assert.deepEqual(parsePactlShortSources("garbage\n\nno-tabs-here"), []);
});

test("parsePactlSources：长格式取 Name + Description 作友好名", () => {
  const text = [
    "Source #48",
    "\tState: SUSPENDED",
    "\tName: alsa_input.usb-mic",
    "\tDescription: USB 麦克风",
    "",
    "Source #49",
    "\tName: alsa_output.monitor",
    "\tDescription: Monitor of Speakers",
  ].join("\n");
  assert.deepEqual(parsePactlSources(text), [
    { name: "USB 麦克风", value: "alsa_input.usb-mic" },
    { name: "Monitor of Speakers", value: "alsa_output.monitor" },
  ]);
});

test("parseArecordDevices：正常/多卡/无设备", () => {
  const text = [
    "**** List of CAPTURE Hardware Devices ****",
    "card 0: PCH [HDA Intel PCH], device 0: ALC257 Analog [ALC257 Analog]",
    "  Subdevices: 1/1",
    "  Subdevice #0: subdevice #0",
    "card 2: USB [USB Audio], device 1: USB Audio [USB Audio]",
  ].join("\n");
  assert.deepEqual(parseArecordDevices(text), [
    { name: "HDA Intel PCH ALC257 Analog", value: "hw:0,0" },
    { name: "USB Audio USB Audio", value: "hw:2,1" },
  ]);
  assert.deepEqual(parseArecordDevices("**** List of CAPTURE Hardware Devices ****\n"), []);
});

test("listLinuxAudioDevices：pactl 成功 → source 名 + 长格式描述", () => {
  const devices = listLinuxAudioDevices({
    spawn: (_bin, args) => {
      if (args[0] === "list" && args[1] === "short") {
        return { stdout: "48\talsa_input.usb-mic\tmod\tspec\tRUNNING\n", stderr: "", status: 0 };
      }
      return { stdout: "Source #48\n\tName: alsa_input.usb-mic\n\tDescription: USB 麦克风\n", stderr: "", status: 0 };
    },
  });
  assert.deepEqual(devices, [{ name: "USB 麦克风", value: "alsa_input.usb-mic" }]);
});

test("listLinuxAudioDevices：pactl 不可用 → 回退 arecord -l", () => {
  const calls = [];
  const devices = listLinuxAudioDevices({
    spawn: (bin, args) => {
      calls.push([bin, ...args]);
      if (bin === "pactl") return { stdout: "", stderr: "Connection refused", status: 1 };
      return {
        stdout: "card 1: USB [USB Audio], device 0: USB Audio [USB Audio]\n",
        stderr: "",
        status: 0,
      };
    },
  });
  assert.deepEqual(calls, [
    ["pactl", "list", "short", "sources"],
    ["arecord", "-l"],
  ]);
  assert.deepEqual(devices, [{ name: "USB Audio USB Audio", value: "hw:1,0" }]);
});

test("listLinuxAudioDevices：pactl 与 arecord 都失败 → 明确错误含两者与安装提示", () => {
  assert.throws(
    () =>
      listLinuxAudioDevices({
        spawn: (bin) => ({
          stdout: "",
          stderr: bin === "pactl" ? "Connection refused" : "arecord: not found",
          status: bin === "pactl" ? 1 : 127,
        }),
      }),
    (err) =>
      /pactl/.test(err.message) &&
      /arecord/.test(err.message) &&
      /pulseaudio-utils/.test(err.message) &&
      /alsa-utils/.test(err.message),
  );
});

test("listLinuxAudioDevices：pactl 空 + arecord 成功但无设备 → 空列表（交给无设备引导）", () => {
  const devices = listLinuxAudioDevices({
    spawn: (_bin, args) => ({
      stdout: args[0] === "-l" ? "**** List of CAPTURE Hardware Devices ****\n" : "",
      stderr: "",
      status: 0,
    }),
  });
  assert.deepEqual(devices, []);
});

test("isPulseStartupFailure：连接/设备类错误命中，普通错误不命中", () => {
  assert.equal(isPulseStartupFailure("Connection refused"), true);
  assert.equal(isPulseStartupFailure("No such file or directory"), true);
  assert.equal(isPulseStartupFailure("cannot open audio device"), true);
  assert.equal(isPulseStartupFailure("Invalid data found when processing input"), false);
});

test("shouldFallbackToAlsa：仅 pulse 启动失败回退一次；有音频/已回退/停止/超窗不回退", () => {
  const base = {
    backend: "pulse",
    fallbackAttempted: false,
    stopping: false,
    bytes: 0,
    elapsedMs: 200,
    stderr: "Connection refused",
  };
  assert.equal(shouldFallbackToAlsa(base), true);
  assert.equal(shouldFallbackToAlsa({ ...base, spawnError: true }), true);
  assert.equal(shouldFallbackToAlsa({ ...base, fallbackAttempted: true }), false, "只重试一次");
  assert.equal(shouldFallbackToAlsa({ ...base, bytes: 128 }), false, "已出音频不回退");
  assert.equal(shouldFallbackToAlsa({ ...base, stopping: true }), false);
  assert.equal(shouldFallbackToAlsa({ ...base, backend: "alsa" }), false);
  assert.equal(shouldFallbackToAlsa({ ...base, elapsedMs: PULSE_FALLBACK_WINDOW_MS + 1 }), false);
  assert.equal(shouldFallbackToAlsa({ ...base, stderr: "Invalid data" }), false);
});

/** 造一个可手动发事件的假子进程。 */
function fakeProc() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = () => {};
  return proc;
}

test("MicCapture：pulse 启动失败自动改试 alsa 仅一次；alsa 也失败后终止且诊断含两后端", () => {
  const calls = [];
  const procs = [];
  const capture = new MicCapture({
    device: "",
    platform: "linux",
    env: {},
    ffmpegBin: "ffmpeg",
    spawnCapture: (_bin, args) => {
      calls.push(args);
      const proc = fakeProc();
      procs.push(proc);
      return proc;
    },
  });
  const closes = [];
  capture.on("close", (code) => closes.push(code));
  capture.start();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 6), ["-hide_banner", "-loglevel", "error", "-f", "pulse", "-i"]);
  assert.equal(calls[0][6], "default");

  procs[0].stderr.emit("data", Buffer.from("Connection refused"));
  procs[0].emit("close", 1);
  assert.equal(calls.length, 2, "回退 alsa 一次");
  assert.deepEqual(calls[1].slice(0, 6), ["-hide_banner", "-loglevel", "error", "-f", "alsa", "-i"]);

  procs[1].stderr.emit("data", Buffer.from("cannot open audio device"));
  procs[1].emit("close", 1);
  assert.equal(calls.length, 2, "不得再次回退");
  assert.deepEqual(closes, [1], "只发一次 close");
  assert.equal(capture.isRunning, false);
  assert.match(capture.diagnostics, /PulseAudio/);
  assert.match(capture.diagnostics, /ALSA/);
  assert.match(capture.diagnostics, /均失败/);
});

// ---- 默认输入源解析（Linux：pactl get-default-source → 非 monitor 回退） ----

/** 造一个同时响应 get-default-source / list 的 pactl 假 spawn。 */
function stubPactlSpawn({ defaultSource = "", shortSources = "", longSources = "", arecord = "" } = {}) {
  const calls = [];
  const spawn = (bin, args) => {
    calls.push([bin, ...args]);
    if (bin !== "pactl") return { stdout: arecord, stderr: "", status: 0 };
    if (args[0] === "get-default-source") return { stdout: defaultSource, stderr: "", status: 0 };
    if (args[0] === "list" && args[1] === "short") return { stdout: shortSources, stderr: "", status: 0 };
    return { stdout: longSources, stderr: "", status: 0 };
  };
  return { calls, spawn };
}

const SHORT_MONITORS_FIRST = [
  "41\talsa_output.pci-hdmi3.HiFi__HDMI3__sink.monitor\tmod\tspec\tSUSPENDED",
  "42\talsa_output.pci-hdmi1.HiFi__HDMI1__sink.monitor\tmod\tspec\tSUSPENDED",
  "43\talsa_input.pci-HiFi__Mic1__source\tmod\tspec\tRUNNING",
  "44\talsa_input.usb-mic\tmod\tspec\tSUSPENDED",
].join("\n");

test("getDefaultPulseSource：有效值返回；占位/空/非 0/启动失败一律 undefined", () => {
  const ok = stubPactlSpawn({ defaultSource: "  alsa_input.pci-HiFi__Mic1__source\n" });
  assert.equal(getDefaultPulseSource({ spawn: ok.spawn }), "alsa_input.pci-HiFi__Mic1__source");
  assert.deepEqual(ok.calls, [["pactl", "get-default-source"]]);

  assert.equal(getDefaultPulseSource({ spawn: stubPactlSpawn({ defaultSource: "@DEFAULT_SOURCE@" }).spawn }), undefined);
  assert.equal(getDefaultPulseSource({ spawn: stubPactlSpawn({ defaultSource: "   " }).spawn }), undefined);
  assert.equal(getDefaultPulseSource({ spawn: () => ({ stdout: "x", status: 1 }) }), undefined);
  assert.equal(getDefaultPulseSource({ spawn: () => ({ error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }) }) }), undefined);
});

test("resolveDefaultLinuxDevice：默认源命中 → 直接用它，不再枚举设备", () => {
  const stub = stubPactlSpawn({
    defaultSource: "alsa_input.pci-HiFi__Mic1__source",
    shortSources: SHORT_MONITORS_FIRST,
  });
  const resolved = resolveDefaultLinuxDevice({ spawn: stub.spawn });
  assert.deepEqual(resolved, {
    value: "alsa_input.pci-HiFi__Mic1__source",
    fromDefaultSource: true,
    monitor: false,
  });
  assert.deepEqual(stub.calls, [["pactl", "get-default-source"]], "默认源有效时不应枚举");
});

test("resolveDefaultLinuxDevice：默认源缺失 → 跳过 monitor，取第一条真实输入源（保持相对顺序）", () => {
  const stub = stubPactlSpawn({ defaultSource: "", shortSources: SHORT_MONITORS_FIRST });
  const resolved = resolveDefaultLinuxDevice({ spawn: stub.spawn });
  assert.deepEqual(resolved, {
    value: "alsa_input.pci-HiFi__Mic1__source",
    fromDefaultSource: false,
    monitor: false,
  });
});

test("resolveDefaultLinuxDevice：默认源为占位符时同样回退到非 monitor", () => {
  const stub = stubPactlSpawn({ defaultSource: "@DEFAULT_SOURCE@", shortSources: SHORT_MONITORS_FIRST });
  assert.equal(resolveDefaultLinuxDevice({ spawn: stub.spawn })?.value, "alsa_input.pci-HiFi__Mic1__source");
});

test("resolveDefaultLinuxDevice：只有 monitor 时仍取第一条并标记 monitor=true", () => {
  const stub = stubPactlSpawn({
    defaultSource: "",
    shortSources: [
      "41\talsa_output.a.monitor\tmod\tspec\tSUSPENDED",
      "42\talsa_output.b.monitor\tmod\tspec\tSUSPENDED",
    ].join("\n"),
  });
  assert.deepEqual(resolveDefaultLinuxDevice({ spawn: stub.spawn }), {
    value: "alsa_output.a.monitor",
    fromDefaultSource: false,
    monitor: true,
  });
});

test("resolveDefaultLinuxDevice：无设备 → undefined", () => {
  const stub = stubPactlSpawn({ defaultSource: "", shortSources: "" });
  assert.equal(resolveDefaultLinuxDevice({ spawn: stub.spawn }), undefined);
});

test("resolveLinuxCaptureDevice：显式 device 最高优先，真实依赖链不触发任何 pactl/arecord 查询", () => {
  let spawned = 0;
  const resolved = resolveLinuxCaptureDevice({
    explicit: "  alsa_input.usb-mic  ",
    spawn: () => {
      spawned += 1;
      return { stdout: "alsa_input.other", stderr: "", status: 0 };
    },
  });
  assert.deepEqual(resolved, { value: "alsa_input.usb-mic", fromDefaultSource: false, monitor: false });
  assert.equal(spawned, 0, "显式指定时不得查询默认源/枚举");
});

test("prioritizeMicrophoneDevices：非 monitor 在前，各自保持原相对顺序", () => {
  const devices = [
    { name: "m1", value: "a.monitor" },
    { name: "mic1", value: "alsa_input.one" },
    { name: "m2", value: "b.monitor" },
    { name: "mic2", value: "alsa_input.two" },
  ];
  assert.deepEqual(prioritizeMicrophoneDevices(devices), [
    { name: "mic1", value: "alsa_input.one" },
    { name: "mic2", value: "alsa_input.two" },
    { name: "m1", value: "a.monitor" },
    { name: "m2", value: "b.monitor" },
  ]);
  assert.equal(devices[0].value, "a.monitor", "不得修改入参");
});

test("resolveAlsaFallbackDevice：pulse source 名换成 default；各种合法 ALSA 设备名原样保留", () => {
  assert.equal(resolveAlsaFallbackDevice(""), "default");
  assert.equal(resolveAlsaFallbackDevice("alsa_input.pci-HiFi__Mic1__source"), "default");
  assert.equal(resolveAlsaFallbackDevice("alsa_output.a.monitor"), "default");
  assert.equal(resolveAlsaFallbackDevice("bluez_input.XX_XX"), "default");
  for (const alsa of [
    "default",
    "pulse",
    "hw:1,0",
    "hw:CARD=PCH,DEV=0",
    "plughw:0,0",
    "plughw:CARD=PCH,DEV=0",
    "sysdefault:CARD=PCH",
    "front:CARD=PCH,DEV=0",
    "surround51:CARD=PCH,DEV=0",
    "iec958:CARD=PCH,DEV=0",
    "dmix:CARD=PCH,DEV=0",
  ]) {
    assert.equal(resolveAlsaFallbackDevice(alsa), alsa, `${alsa} 不应被改写`);
  }
});

test("orderLinuxDevicesForDisplay：默认源置顶 → 非 monitor → monitor（各自稳定）", () => {
  const devices = [
    { name: "m1", value: "a.monitor" },
    { name: "mic1", value: "alsa_input.one" },
    { name: "mic2", value: "alsa_input.two" },
    { name: "m2", value: "b.monitor" },
  ];
  assert.deepEqual(orderLinuxDevicesForDisplay(devices, "alsa_input.two"), [
    { name: "mic2", value: "alsa_input.two" },
    { name: "mic1", value: "alsa_input.one" },
    { name: "m1", value: "a.monitor" },
    { name: "m2", value: "b.monitor" },
  ]);
  assert.deepEqual(orderLinuxDevicesForDisplay(devices), prioritizeMicrophoneDevices(devices));
});

test("resolveDefaultLinuxDevice：pactl 只有 monitor 时先试 arecord，命中真实硬件设备", () => {
  const stub = stubPactlSpawn({
    defaultSource: "",
    shortSources: "41\talsa_output.a.monitor\tmod\tspec\tSUSPENDED",
    arecord: "card 1: USB [USB Audio], device 0: USB Audio [USB Audio]\n",
  });
  assert.deepEqual(resolveDefaultLinuxDevice({ spawn: stub.spawn }), {
    value: "hw:1,0",
    fromDefaultSource: false,
    monitor: false,
  });
  assert.ok(stub.calls.some((call) => call[0] === "arecord" && call[1] === "-l"), "应重试 arecord");
});

test("MicCapture：pulse source 名失败回退 alsa 时改用 default，不把 pulse source 名喂给 -f alsa", () => {
  const calls = [];
  const procs = [];
  const capture = new MicCapture({
    device: "alsa_input.pci-HiFi__Mic1__source",
    platform: "linux",
    env: {},
    ffmpegBin: "ffmpeg",
    spawnCapture: (_bin, args) => {
      calls.push(args);
      const proc = fakeProc();
      procs.push(proc);
      return proc;
    },
  });
  capture.start();
  assert.equal(calls[0][6], "alsa_input.pci-HiFi__Mic1__source");
  procs[0].stderr.emit("data", Buffer.from("Connection refused"));
  procs[0].emit("close", 1);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].slice(3, 7), ["-f", "alsa", "-i", "default"]);
});
