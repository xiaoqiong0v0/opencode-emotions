/**
 * 采集后端选择与 Termux 命令拼装的离线单测（不启动 ffmpeg / termux-microphone-record）。
 *
 * 覆盖：后端选择（android 平台或 Termux 环境变量）、分块时长解析（默认/越界夹取）、
 * `termux-microphone-record` 参数拼装、桌面 dshow 参数不变。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CAPTURE_CHANNELS,
  CAPTURE_SAMPLE_RATE,
  DEFAULT_TERMUX_CHUNK_SECONDS,
  MAX_TERMUX_CHUNK_SECONDS,
  MIN_TERMUX_CHUNK_SECONDS,
  TERMUX_CHUNK_SECONDS_ENV,
  buildCaptureArgs,
  buildTermuxRecordArgs,
  formatCaptureExitFailure,
  listAudioDevices,
  resolveTermuxChunkSeconds,
  selectCaptureBackend,
} from "../dist/voice/capture.js";

test("selectCaptureBackend：Termux 环境或 android 平台走 termux，其余走 ffmpeg", () => {
  assert.equal(selectCaptureBackend("linux", {}), "ffmpeg");
  assert.equal(selectCaptureBackend("win32", { PREFIX: "/usr" }), "ffmpeg");
  assert.equal(selectCaptureBackend("linux", { TERMUX_VERSION: "0.118" }), "termux");
  assert.equal(selectCaptureBackend("linux", { PREFIX: "/data/data/com.termux/files/usr" }), "termux");
  assert.equal(selectCaptureBackend("android", {}), "termux");
});

test("resolveTermuxChunkSeconds：默认 2 秒、合法值生效、越界夹取、非法回退", () => {
  assert.equal(DEFAULT_TERMUX_CHUNK_SECONDS, 2);
  assert.equal(resolveTermuxChunkSeconds({}), 2);
  assert.equal(resolveTermuxChunkSeconds({ [TERMUX_CHUNK_SECONDS_ENV]: "3" }), 3);
  assert.equal(resolveTermuxChunkSeconds({ [TERMUX_CHUNK_SECONDS_ENV]: "0.5" }), MIN_TERMUX_CHUNK_SECONDS);
  assert.equal(resolveTermuxChunkSeconds({ [TERMUX_CHUNK_SECONDS_ENV]: "9999" }), MAX_TERMUX_CHUNK_SECONDS);
  assert.equal(resolveTermuxChunkSeconds({ [TERMUX_CHUNK_SECONDS_ENV]: "0" }), DEFAULT_TERMUX_CHUNK_SECONDS);
  assert.equal(resolveTermuxChunkSeconds({ [TERMUX_CHUNK_SECONDS_ENV]: "abc" }), DEFAULT_TERMUX_CHUNK_SECONDS);
});

test("buildTermuxRecordArgs：按官方 -h 拼出 file/limit/encoder/rate/channels", () => {
  assert.deepEqual(buildTermuxRecordArgs("/tmp/a.opus", "opus", 2, CAPTURE_SAMPLE_RATE, CAPTURE_CHANNELS), [
    "-f",
    "/tmp/a.opus",
    "-l",
    "2",
    "-e",
    "opus",
    "-r",
    "16000",
    "-c",
    "1",
  ]);
  assert.deepEqual(buildTermuxRecordArgs("/tmp/b.aac", "aac", 5, 8000, 1), [
    "-f",
    "/tmp/b.aac",
    "-l",
    "5",
    "-e",
    "aac",
    "-r",
    "8000",
    "-c",
    "1",
  ]);
});

test("buildCaptureArgs：桌面 dshow 采集命令保持不变（16k mono s16le → stdout）", () => {
  assert.deepEqual(buildCaptureArgs("麦克风 (USB Audio)"), [
    "-hide_banner",
    "-nostdin",
    "-f",
    "dshow",
    "-i",
    "audio=麦克风 (USB Audio)",
    "-f",
    "s16le",
    "-ar",
    "16000",
    "-ac",
    "1",
    "-",
  ]);
  assert.deepEqual(buildCaptureArgs("dev", 8000).slice(-6, -1), ["s16le", "-ar", "8000", "-ac", "1"]);
});

test("listAudioDevices：spawnSync 失败（ENOENT）不再被吞——抛错带可执行路径与原因", () => {
  const enoent = Object.assign(new Error("spawnSync C:\\cache\\ffmpeg.exe ENOENT"), { code: "ENOENT" });
  assert.throws(
    () =>
      listAudioDevices({
        bin: "C:\\cache\\ffmpeg.exe",
        spawn: () => ({ stdout: "", stderr: "", error: enoent }),
      }),
    (err) =>
      err.message.includes("C:\\cache\\ffmpeg.exe") &&
      /ENOENT/.test(err.message) &&
      /无法启动 ffmpeg 枚举音频设备/.test(err.message) &&
      /FFMPEG_BIN/.test(err.message),
  );
});

test("listAudioDevices：spawn 成功 → 从 stderr 解析 dshow 音频设备", () => {
  const stderr = [
    "[dshow @ 000001] DirectShow video devices (some may be both video and audio devices)",
    '[dshow @ 000001]  "麦克风 (USB Audio)" (audio)',
    '[dshow @ 000001]     Alternative name "@device_cm_{GUID}\\wave_{GUID}"',
  ].join("\n");
  const devices = listAudioDevices({
    bin: "C:\\ok\\ffmpeg.exe",
    spawn: () => ({ stdout: "", stderr, error: null }),
  });
  assert.equal(devices.length, 1);
  assert.equal(devices[0].name, "麦克风 (USB Audio)");
  assert.equal(devices[0].alternativeName, "@device_cm_{GUID}\\wave_{GUID}");
});

test("formatCaptureExitFailure：非 0 退出/0 字节都算失败，正常 EOF 不算", () => {
  // 审计实测的 Windows 退出码（0xFFFFFFFB 的有符号化）
  const abnormal = formatCaptureExitFailure(4294967291, 0, "Could not find audio device");
  assert.ok(abnormal !== null);
  assert.match(abnormal, /未采集到任何音频/);
  assert.match(abnormal, /4294967291/);
  assert.match(abnormal, /Could not find audio device/, "错误文本带 stderr 摘要");

  assert.match(formatCaptureExitFailure(0, 0, ""), /未采集到任何音频/, "0 字节同样算失败");
  assert.match(formatCaptureExitFailure(1, 4096, "boom"), /采集进程异常退出/);
  assert.equal(formatCaptureExitFailure(0, 4096, ""), null, "退出码 0 且有音频 = 正常结束");
});
