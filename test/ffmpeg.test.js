/**
 * ffmpeg 可执行文件解析兜底链的离线单测（不启动 ffmpeg）。
 *
 * 覆盖：`FFMPEG_BIN` 优先 → PATH `ffmpeg` → `ffmpeg-static`（可选依赖）→ 清晰报错（含用户引导）。
 * 通过注入 env/platform/isOnPath/staticPath/exists 覆盖各分支，避免依赖本机是否装 ffmpeg。
 * 2026-10-22：每级都做存在性校验——解析到但文件不存在（如缓存安装未跑下载脚本）→ 继续下一级。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  FFMPEG_ENV,
  buildPcmDecodeArgs,
  ffmpegInstallHints,
  resolveFfmpegPath,
} from "../dist/voice/ffmpeg.js";

test("resolveFfmpegPath：FFMPEG_BIN 最优先（压过 PATH 与 ffmpeg-static）", () => {
  const resolved = resolveFfmpegPath({
    env: { [FFMPEG_ENV]: "  /opt/ffmpeg  " },
    platform: "linux",
    isOnPath: () => true,
    staticPath: () => "/static/ffmpeg",
    exists: () => true,
  });
  assert.equal(resolved, "/opt/ffmpeg", "环境变量值应去空白后直接返回");
});

test("resolveFfmpegPath：FFMPEG_BIN 指向的文件不存在 → 不再盲信，落到 PATH", () => {
  const resolved = resolveFfmpegPath({
    env: { [FFMPEG_ENV]: "C:\\broken\\ffmpeg.exe" },
    platform: "win32",
    isOnPath: (bin) => bin === "ffmpeg",
    staticPath: () => null,
    exists: () => false,
  });
  assert.equal(resolved, "ffmpeg", "FFMPEG_BIN 失效时应继续下一级（PATH）");
});

test("resolveFfmpegPath：FFMPEG_BIN 为裸命令名且在 PATH 上 → 可用（不要求 existsSync 命中）", () => {
  const resolved = resolveFfmpegPath({
    env: { [FFMPEG_ENV]: "ffmpeg-custom" },
    platform: "linux",
    isOnPath: (bin) => bin === "ffmpeg-custom",
    staticPath: () => null,
    exists: () => false,
  });
  assert.equal(resolved, "ffmpeg-custom");
});

test("resolveFfmpegPath：PATH 的 ffmpeg 优先于 ffmpeg-static", () => {
  const resolved = resolveFfmpegPath({
    env: {},
    platform: "linux",
    isOnPath: (bin) => bin === "ffmpeg",
    staticPath: () => "/static/ffmpeg",
    exists: () => true,
  });
  assert.equal(resolved, "ffmpeg", "PATH 命中返回命令名，交给 spawn 解析");
});

test("resolveFfmpegPath：PATH 无、ffmpeg-static 存在则用它", () => {
  const resolved = resolveFfmpegPath({
    env: {},
    platform: "win32",
    isOnPath: () => false,
    staticPath: () => "C:\\pkg\\ffmpeg.exe",
    exists: () => true,
  });
  assert.equal(resolved, "C:\\pkg\\ffmpeg.exe");
});

test("resolveFfmpegPath：ffmpeg-static 解析到但文件缺失（未跑下载脚本）→ 抛带引导的错", () => {
  assert.throws(
    () =>
      resolveFfmpegPath({
        env: {},
        platform: "win32",
        isOnPath: () => false,
        staticPath: () => "C:\\pkg\\ffmpeg.exe",
        exists: () => false,
      }),
    (err) =>
      /未找到可用的 ffmpeg/.test(err.message) &&
      /随附二进制缺失/.test(err.message) &&
      err.message.includes(FFMPEG_ENV) &&
      /winget/.test(err.message) &&
      /重装插件依赖/.test(err.message),
  );
});

test("resolveFfmpegPath：win32 防御——静态路径缺 .exe 后缀但补全后存在 → 返回补全名", () => {
  const resolved = resolveFfmpegPath({
    env: {},
    platform: "win32",
    isOnPath: () => false,
    staticPath: () => "C:\\pkg\\ffmpeg",
    exists: (path) => path === "C:\\pkg\\ffmpeg.exe",
  });
  assert.equal(resolved, "C:\\pkg\\ffmpeg.exe");
});

test("resolveFfmpegPath：三者都无 → 抛错并附当前平台安装提示", () => {
  assert.throws(
    () =>
      resolveFfmpegPath({ env: {}, platform: "linux", isOnPath: () => false, staticPath: () => null, exists: () => false }),
    /未找到可用的 ffmpeg/,
  );
  const win = ffmpegInstallHints("win32", {});
  assert.match(win, /winget/);
  assert.equal(ffmpegInstallHints("darwin", {}), "macOS：brew install ffmpeg");
  assert.match(ffmpegInstallHints("linux", {}), /apt install ffmpeg/);
});

test("resolveFfmpegPath / ffmpegInstallHints：Termux 优先给 pkg install ffmpeg", () => {
  assert.match(ffmpegInstallHints("linux", { TERMUX_VERSION: "0.118" }), /pkg install ffmpeg/);
  assert.match(ffmpegInstallHints("android", {}), /pkg install ffmpeg/);
  try {
    resolveFfmpegPath({
      env: { TERMUX_VERSION: "0.118" },
      platform: "linux",
      isOnPath: () => false,
      staticPath: () => null,
      exists: () => false,
    });
    assert.fail("应当抛错");
  } catch (err) {
    assert.match(err.message, /pkg install ffmpeg/);
    assert.match(err.message, new RegExp(FFMPEG_ENV));
  }
});

test("buildPcmDecodeArgs：PCM 输入需显式裸流参数，压缩输入自动探测", () => {
  assert.deepEqual(buildPcmDecodeArgs("opus", 16000, 16000, 1), [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    "pipe:0",
    "-f",
    "s16le",
    "-ar",
    "16000",
    "-ac",
    "1",
    "pipe:1",
  ]);
  assert.ok(buildPcmDecodeArgs("pcm", 8000, 16000, 1).includes("s16le"), "pcm 输入显式声明 s16le");
});
