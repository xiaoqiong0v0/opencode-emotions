/**
 * 本地 TTS provider（sapi / termux）的 `done` 契约测试（2026-10-22 审计修复）。
 *
 * 修复前：`SapiProvider.speak()` / `TermuxProvider.speak()` 只返回 `{provider, voice, rate}`、没有 `done`；
 * CLI `runSpeak` 的 `await (result.done ?? Promise.resolve())` 立即通过 ⇒ `clearPlayback()` 在**开播瞬间**
 * 删掉 `tts-playback` 条目 ⇒ 播放期间 F8/F9/F10 与 ASR 半双工门都找不到它（无法打断、可叠播）。
 * 本文件断言：
 * 1. `done` 只在子进程**真正退出**后 settle；非 0 退出 reject 可识别错误；
 * 2. 播放中 `stop()`/新一次 `speak()` 能杀掉旧子进程，且不误伤新一条（旧 `done` resolve、新 `done` 独立）；
 * 3. `tts-playback` 条目在播放期间存在、`done` 后由 CLI 清理。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { awaitPlayback, registerPlaybackLifecycle } from "../dist/cli/emotions-cli.js";
import { clearPlayback, PLAYBACK_OWNERLESS_KEY, readPlayback } from "../dist/voice/playback-state.js";
import { PLAYBACK_SESSION_ENV } from "../dist/voice/playback-state.js";
import { SapiProvider } from "../dist/voice/tts/sapi.js";
import { TermuxProvider } from "../dist/voice/tts/termux.js";

/** 完整的 ResolvedTtsOptions（provider 入参契约）。 */
function fullOptions(overrides = {}) {
  return {
    text: "你好",
    voice: "",
    rate: 0,
    instruction: "",
    pitch: 0,
    volume: 0,
    format: "",
    sampleRate: 0,
    model: "",
    streamMinChars: 5,
    ...overrides,
  };
}

/** 构造假子进程（EventEmitter；由测试显式触发 exit）。 */
function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.killed = false;
  child.exitCode = null;
  child.stdin = new EventEmitter();
  child.stdin.writable = true;
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.kill = () => {
    child.killed = true;
    child.exitCode = 0;
    child.emit("exit", 0, null);
  };
  return child;
}

/** 可控 spawn：记录每次派生的子进程，测试自己决定何时 exit。 */
function makeSpawn() {
  const children = [];
  let seq = 0;
  const spawnFn = () => {
    seq += 1;
    const child = fakeChild(40_000 + seq);
    children.push(child);
    return child;
  };
  return { children, spawnFn };
}

/** 让事件循环转一圈（用于断言「尚未 settle」）。 */
function tick(ms = 20) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("sapi：done 在子进程退出后才 resolve（修复前没有 done，CLI 立即清登记）", async () => {
  const { children, spawnFn } = makeSpawn();
  const provider = new SapiProvider({ platform: "win32", spawn: spawnFn });
  const result = provider.speak(fullOptions());
  assert.ok(result.done instanceof Promise, "speak() 必须返回 done");
  let settled = false;
  result.done.then(() => {
    settled = true;
  });
  await tick();
  assert.equal(settled, false, "子进程还活着时 done 不得 settle");
  children[0].emit("exit", 0, null);
  await result.done;
  assert.equal(settled, true, "子进程退出后 done resolve");
  assert.equal(provider.activePlayerPid(), undefined, "退出后不再暴露 playerPid");
});

test("sapi：非 0 退出 → done reject 可识别错误（失败不再静默）", async () => {
  const { children, spawnFn } = makeSpawn();
  const provider = new SapiProvider({ platform: "win32", spawn: spawnFn });
  const result = provider.speak(fullOptions());
  children[0].emit("exit", 3, null);
  await assert.rejects(result.done, /SAPI 播放失败（退出码=3）/);
});

test("sapi：播放中 stop 杀掉当前子进程且不误伤下一条（各自 done 独立）", async () => {
  const { children, spawnFn } = makeSpawn();
  const provider = new SapiProvider({ platform: "win32", spawn: spawnFn });
  const first = provider.speak(fullOptions({ text: "第一条" }));
  const firstChild = children[0];
  const second = provider.speak(fullOptions({ text: "第二条" }));
  assert.equal(firstChild.killed, true, "新一次 speak 必须先杀掉旧子进程");
  await first.done; // 有意打断 ⇒ resolve（不 reject）
  const secondChild = children[1];
  assert.equal(provider.activePlayerPid(), secondChild.pid, "当前发声子进程应为第二条");

  let secondSettled = false;
  second.done.then(() => {
    secondSettled = true;
  });
  firstChild.emit("exit", 1, null); // 迟到的旧进程退出不得影响新一条
  await tick();
  assert.equal(secondSettled, false, "旧进程退出不得让新一条的 done settle");
  secondChild.emit("exit", 0, null);
  await second.done;
  assert.equal(provider.activePlayerPid(), undefined);
});

test("termux：done 同样绑定 termux-tts-speak 子进程退出", async () => {
  const { children, spawnFn } = makeSpawn();
  const provider = new TermuxProvider({
    env: { TERMUX_VERSION: "0.118" },
    platform: "linux",
    isAvailable: () => true,
    spawn: spawnFn,
  });
  const result = provider.speak(fullOptions());
  assert.ok(result.done instanceof Promise);
  let settled = false;
  result.done.then(() => {
    settled = true;
  });
  await tick();
  assert.equal(settled, false);
  children[0].emit("exit", 0, null);
  await result.done;
  assert.equal(settled, true);
});

test("tts-playback：播放期间条目存在，done 后由 CLI 清理（修复前条目在开播瞬间被删）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tts-done-"));
  const prevSession = process.env[PLAYBACK_SESSION_ENV];
  delete process.env[PLAYBACK_SESSION_ENV];
  const { children, spawnFn } = makeSpawn();
  const provider = new SapiProvider({ platform: "win32", spawn: spawnFn });
  try {
    const result = provider.speak(fullOptions());
    registerPlaybackLifecycle(result, { dataDir: dir });
    assert.ok(
      readPlayback(PLAYBACK_OWNERLESS_KEY, { dataDir: dir }),
      "开播后 tts-playback 条目必须存在（播放期间可被 F8/F9/F10 与半双工门看到）",
    );

    const waiting = awaitPlayback(result, { dataDir: dir });
    // 子进程尚未退出 ⇒ done 未 settle ⇒ 条目仍在
    await tick();
    assert.ok(
      readPlayback(PLAYBACK_OWNERLESS_KEY, { dataDir: dir }),
      "播放未结束时不得清条目",
    );

    children[0].emit("exit", 0, null);
    await waiting;
    assert.equal(
      readPlayback(PLAYBACK_OWNERLESS_KEY, { dataDir: dir }),
      undefined,
      "done 之后必须清理条目（不留死条目）",
    );
  } finally {
    clearPlayback(process.pid, { dataDir: dir });
    if (prevSession === undefined) delete process.env[PLAYBACK_SESSION_ENV];
    else process.env[PLAYBACK_SESSION_ENV] = prevSession;
    rmSync(dir, { recursive: true, force: true });
  }
});
