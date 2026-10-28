/**
 * ffmpeg 可执行文件解析的离线单测（不启动真 ffmpeg，`-version` 校验一律注入）。
 *
 * 契约（2026-10-28 第十九批，**纯自包含**）：`FFMPEG_BIN`（显式设置且 `-version` 真执行通过）
 * → `ffmpeg-static`（存在且真执行通过）→ 抛带引导的错。**不再回落到系统 PATH**（Termux 例外）。
 * 修复前行为：PATH 命中即用（`isOnPath("ffmpeg")` 分支排在 ffmpeg-static 之前）⇒ 下面「PATH 不得入选」
 * 「FFMPEG_BIN 失效后不得落 PATH」两例在旧实现上必红。
 */

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import {
  FFMPEG_ENV,
  FFMPEG_PROBE_TIMEOUT_MS,
  buildPcmDecodeArgs,
  ffmpegInstallHints,
  resetFfmpegProbeCache,
  resolveFfmpegPath,
} from "../dist/voice/ffmpeg.js";

/** 校验通过（退出码 0）。 */
const OK = () => 0;
/** 校验失败（退出码非 0）。 */
const BAD = () => 1;

beforeEach(() => {
  resetFfmpegProbeCache();
});

test("resolveFfmpegPath：FFMPEG_BIN 最优先（存在且 -version 通过）", () => {
  const resolved = resolveFfmpegPath({
    env: { [FFMPEG_ENV]: "  /opt/ffmpeg  " },
    platform: "linux",
    staticPath: () => "/static/ffmpeg",
    exists: () => true,
    probe: OK,
  });
  assert.equal(resolved, "/opt/ffmpeg", "环境变量值应去空白后返回");
});

test("resolveFfmpegPath：PATH 上有 ffmpeg 也不得被选中（纯自包含）", () => {
  assert.throws(
    () =>
      resolveFfmpegPath({
        env: {},
        platform: "linux",
        isOnPath: (bin) => bin === "ffmpeg",
        staticPath: () => null,
        exists: () => false,
        probe: OK,
      }),
    /未找到可用的 ffmpeg/,
    "旧实现会返回 PATH 的 `ffmpeg`（假阳性），新契约必须抛错",
  );
});

test("resolveFfmpegPath：FFMPEG_BIN 指向不存在的文件 → 跳过并走自包含二进制（不落 PATH）", () => {
  const resolved = resolveFfmpegPath({
    env: { [FFMPEG_ENV]: "C:\\broken\\ffmpeg.exe" },
    platform: "win32",
    isOnPath: (bin) => bin === "ffmpeg",
    staticPath: () => "C:\\pkg\\ffmpeg.exe",
    exists: (path) => path === "C:\\pkg\\ffmpeg.exe",
    probe: OK,
  });
  assert.equal(resolved, "C:\\pkg\\ffmpeg.exe", "失效的 FFMPEG_BIN 必须跳过，且不得回落到 PATH");
});

test("resolveFfmpegPath：FFMPEG_BIN 存在但 -version 失败 → 视为不可用，走自包含二进制", () => {
  const resolved = resolveFfmpegPath({
    env: { [FFMPEG_ENV]: "/opt/ffmpeg" },
    platform: "linux",
    staticPath: () => "/static/ffmpeg",
    exists: () => true,
    probe: (bin) => (bin === "/opt/ffmpeg" ? 1 : 0),
  });
  assert.equal(resolved, "/static/ffmpeg");
});

test("resolveFfmpegPath：裸命令名 FFMPEG_BIN 也需真执行通过", () => {
  assert.equal(
    resolveFfmpegPath({
      env: { [FFMPEG_ENV]: "ffmpeg-custom" },
      platform: "linux",
      staticPath: () => null,
      exists: () => false,
      probe: (bin) => (bin === "ffmpeg-custom" ? 0 : 1),
    }),
    "ffmpeg-custom",
  );
});

test("resolveFfmpegPath：ffmpeg-static 存在但 -version 失败 → 不可用，抛错点名校验失败", () => {
  assert.throws(
    () =>
      resolveFfmpegPath({
        env: {},
        platform: "linux",
        staticPath: () => "/static/ffmpeg",
        exists: () => true,
        probe: BAD,
      }),
    (err) =>
      /未找到可用的 ffmpeg/.test(err.message) &&
      /-version 校验失败/.test(err.message) &&
      err.message.includes(FFMPEG_ENV),
  );
});

test("resolveFfmpegPath：ffmpeg-static 解析到但文件缺失（未跑下载脚本）→ 抛带引导的错", () => {
  assert.throws(
    () =>
      resolveFfmpegPath({
        env: {},
        platform: "win32",
        staticPath: () => "C:\\pkg\\ffmpeg.exe",
        exists: () => false,
        probe: OK,
      }),
    (err) =>
      /未找到可用的 ffmpeg/.test(err.message) &&
      /随附二进制缺失/.test(err.message) &&
      err.message.includes(FFMPEG_ENV) &&
      /重装插件依赖/.test(err.message),
  );
});

test("resolveFfmpegPath：win32 防御——静态路径缺 .exe 后缀但补全后存在 → 返回补全名", () => {
  const resolved = resolveFfmpegPath({
    env: {},
    platform: "win32",
    staticPath: () => "C:\\pkg\\ffmpeg",
    exists: (path) => path === "C:\\pkg\\ffmpeg.exe",
    probe: OK,
  });
  assert.equal(resolved, "C:\\pkg\\ffmpeg.exe");
});

test("resolveFfmpegPath：真执行校验有 memo（同进程第二次不重复 spawn）", () => {
  let calls = 0;
  const probe = () => {
    calls += 1;
    return 0;
  };
  const options = {
    env: {},
    platform: "linux",
    staticPath: () => "/static/ffmpeg",
    exists: () => true,
    probe,
  };
  assert.equal(resolveFfmpegPath(options), "/static/ffmpeg");
  assert.equal(resolveFfmpegPath(options), "/static/ffmpeg");
  assert.equal(calls, 1, "第二次解析必须命中校验 memo");
  assert.equal(FFMPEG_PROBE_TIMEOUT_MS, 3000);
});

test("resolveFfmpegPath：Termux 例外——用系统 ffmpeg，不触发自包含下载", () => {
  let staticCalls = 0;
  const resolved = resolveFfmpegPath({
    env: { TERMUX_VERSION: "0.118" },
    platform: "linux",
    isOnPath: () => true,
    staticPath: () => {
      staticCalls += 1;
      return "/static/ffmpeg";
    },
    exists: () => false,
    probe: () => {
      throw new Error("Termux 不做自包含真执行校验");
    },
  });
  assert.equal(resolved, "ffmpeg");
  assert.equal(staticCalls, 0, "Termux 不得走 ffmpeg-static（无 Android 预编译二进制）");
});

test("resolveFfmpegPath：三者都无 → 抛错（不引导安装系统 ffmpeg，改引导自包含修复）", () => {
  assert.throws(
    () =>
      resolveFfmpegPath({
        env: {},
        platform: "linux",
        isOnPath: () => false,
        staticPath: () => null,
        exists: () => false,
        probe: OK,
      }),
    (err) =>
      /未找到可用的 ffmpeg/.test(err.message) &&
      /HTTPS_PROXY/.test(err.message) &&
      /重装插件依赖/.test(err.message),
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
      probe: () => {
        throw new Error("Termux 不做自包含真执行校验");
      },
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
