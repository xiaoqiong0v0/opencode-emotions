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
  isPulseStartupFailure,
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
