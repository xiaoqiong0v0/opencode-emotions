/**
 * 面向用户配置引导文案的离线单测（三类缺失各至少 1 条）：
 * ffmpeg 缺失 / 音频输入设备为空 / 云凭证未配置。
 *
 * 断言口径与 toast 截断对齐：关键信息（哪缺、去哪配）必须落在**前 120 字符**内。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  credentialGuidance,
  ffmpegInstallHints,
  ffmpegLaunchFailedGuidance,
  ffmpegMissingGuidance,
  noAudioDeviceGuidance,
} from "../dist/voice/guidance.js";

test("ffmpegMissingGuidance：三类修复方式齐全，关键信息在前 120 字符内", () => {
  const msg = ffmpegMissingGuidance({ platform: "win32", env: {} });
  assert.match(msg, /未找到可用的 ffmpeg/);
  assert.match(msg, /FFMPEG_BIN/);
  assert.match(msg, /winget install Gyan\.FFmpeg/);
  assert.match(msg, /重装插件依赖/);
  // toast 口径：哪缺 + 怎么配（环境变量）在前 120 字符
  assert.match(msg.slice(0, 120), /未找到可用的 ffmpeg/);
  assert.match(msg.slice(0, 120), /FFMPEG_BIN/);
});

test("ffmpegMissingGuidance：override 指向不存在的文件 → 文案点名该路径", () => {
  const msg = ffmpegMissingGuidance({
    platform: "win32",
    env: {},
    override: "C:\\bad\\ffmpeg.exe",
    overrideProblem: "missing-file",
  });
  assert.match(msg, /C:\\bad\\ffmpeg\.exe/);
  assert.match(msg.slice(0, 120), /指向的文件不存在/);
});

test("ffmpegMissingGuidance：ffmpeg-static 二进制缺失 → 文案点名随附二进制未下载", () => {
  const msg = ffmpegMissingGuidance({ platform: "linux", env: {}, staticProblem: "missing-file" });
  assert.match(msg, /随附二进制缺失/);
  assert.match(msg, /apt install ffmpeg/);
});

test("ffmpegLaunchFailedGuidance：带可执行路径与底层原因", () => {
  const msg = ffmpegLaunchFailedGuidance("C:\\cache\\ffmpeg.exe", "ENOENT spawnSync C:\\cache\\ffmpeg.exe");
  assert.match(msg, /C:\\cache\\ffmpeg\.exe/);
  assert.match(msg, /ENOENT/);
  assert.match(msg, /FFMPEG_BIN/);
});

test("noAudioDeviceGuidance：指向麦克风权限、--list、--device/VOICE_DEVICE，关键信息在前 120 字符内", () => {
  const msg = noAudioDeviceGuidance();
  assert.match(msg, /未找到音频输入设备（枚举成功但结果为 0 个）/);
  assert.match(msg, /麦克风/);
  assert.match(msg, /voice-runtime\.js --list/);
  assert.match(msg, /VOICE_DEVICE/);
  assert.match(msg.slice(0, 120), /未找到音频输入设备/);
  assert.match(msg.slice(0, 120), /麦克风/);
});

test("credentialGuidance：点名 provider、配置文件绝对路径、配置键与环境变量（前 120 字符含去哪配）", () => {
  const msg = credentialGuidance({
    providerLabel: "aliyun-qwen",
    configFile: "C:/Users/me/.config/opencode/emotions.jsonc",
    configKeys: ["asr.credentials.apiKey"],
    envNames: ["DASHSCOPE_API_KEY"],
    fileHint: "凭证文件读取失败：ENOENT",
  });
  assert.match(msg, /未配置 aliyun-qwen 凭证/);
  assert.match(msg, /C:\/Users\/me\/\.config\/opencode\/emotions\.jsonc/);
  assert.match(msg, /asr\.credentials\.apiKey/);
  assert.match(msg, /DASHSCOPE_API_KEY/);
  assert.match(msg, /凭证文件读取失败/);
  const head = msg.slice(0, 120);
  assert.match(head, /未配置 aliyun-qwen 凭证/);
  assert.match(head, /emotions\.jsonc/);
});

test("ffmpegInstallHints 仍从 guidance 导出且按平台分流（供 ffmpeg.ts 复用）", () => {
  assert.match(ffmpegInstallHints("win32", {}), /winget/);
  assert.match(ffmpegInstallHints("linux", { TERMUX_VERSION: "x" }), /pkg install ffmpeg/);
});
