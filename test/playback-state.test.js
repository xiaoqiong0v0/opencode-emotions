/**
 * 播放状态文件与「按 PID 停止」的离线单测（**不真杀任何进程**，kill/isAlive/now 全注入）。
 *
 * 覆盖：读写/原子写、清除需 pid 匹配、TTL 防 PID 复用、pid<=1 与自身 pid 跳过、
 * 已退出/无权限的静默降级、以及命中时的 SIGTERM→SIGKILL 升级；
 * **双 PID（playerPid）**：新格式 roundtrip、旧格式（无 playerPid）兼容、stopPlayback 对
 * `pid`+`playerPid` 双目标各自过红线后都杀（消「杀父不杀孙」）；
 * **会话隔离（sessionID）**：roundtrip/旧格式无键、跨会话不杀不清、同会话照杀、
 * **方案 A（2026-11-02）**：按会话停跳过无主条目、只有无参全清才停无主。
 * **多条目 map（2026-10-21 第五批，跨会话混音）**：两会话并行 upsert 互不覆盖、按会话停只停
 * 本会话、无参停全部（含无主）、旧单条格式读作无主键 `_`、clearPlayback 删含该 pid 的多条目、
 * 读时顺带清 TTL 陈旧条目并落盘。
 * **TUI 退出停播（2026-10-21 第七批）**：`stopPlaybackForSessions()` 逐会话各停一次（mock 注入断言）、
 * 单会话抛错不中断其余、空 id 跳过、接真 stopPlayback 时每会话条目各杀一次。
 * **F10 双态中断判活 + ASR 静音门（2026-10-22）**：`isInterruptablePlaybackActive()` 只看本会话+无主
 * （禁碰其他会话）、playerPid 存活也算、空 sessionID=全部条目；
 * **审计 P1 后口径**：存活优先（`pid`/`playerPid` 探测；EPERM 视为存活）——新鲜但判死 ⇒ 不活跃且清理，
 * 探测抛错 ⇒ fail-open（不阻断），仅无 pid 的条目用 ≤15s 短 TTL。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  classifyPlaybackEntry,
  clearPlayback,
  isInterruptablePlaybackActive,
  playbackStatePath,
  readPlayback,
  stopPlayback,
  stopPlaybackForSessions,
  writePlayback,
  PLAYBACK_FRESH_TTL_MS,
  PLAYBACK_OWNERLESS_KEY,
  PLAYBACK_TTL_MS,
} from "../dist/voice/playback-state.js";

/** 建一个隔离的临时配置目录。 */
function tempConfigDir() {
  return mkdtempSync(join(tmpdir(), "playback-state-"));
}

/**
 * 构造一条状态。
 * startedAt 用当前时间（默认时钟下保持「新鲜」——读写会顺带清 TTL 陈旧条目；
 * 需要陈旧态的用例显式传 startedAt 覆盖）。
 */
function entry(overrides = {}) {
  return { pid: 4242, provider: "aliyun", taskId: "t-1", startedAt: Date.now(), kind: "speak", ...overrides };
}

test("playback-state：路径、原子写、读取、pid 匹配才清除", () => {
  const dir = tempConfigDir();
  try {
    assert.equal(playbackStatePath({ dataDir: dir }), join(dir, "tts-playback"));
    assert.deepEqual(readPlayback(undefined, { dataDir: dir }), {}, "缺文件 → 空 map");

    const written = entry();
    assert.equal(writePlayback(written, { dataDir: dir }), true);
    // 无主条目（无 sessionID）落哨兵键 `_`；taskId undefined 经 JSON 往返省略，deepEqual 需一致
    assert.deepEqual(readPlayback(undefined, { dataDir: dir }), { [PLAYBACK_OWNERLESS_KEY]: written });
    assert.deepEqual(readPlayback(PLAYBACK_OWNERLESS_KEY, { dataDir: dir }), written);

    // pid 不匹配：不删除
    clearPlayback(9999, { dataDir: dir });
    assert.notEqual(readPlayback(PLAYBACK_OWNERLESS_KEY, { dataDir: dir }), undefined);
    // pid 匹配：删除
    clearPlayback(4242, { dataDir: dir });
    assert.deepEqual(readPlayback(undefined, { dataDir: dir }), {}, "清后空 map（文件已删）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stopPlayback：命中存活进程 → SIGTERM 并清状态", () => {
  const dir = tempConfigDir();
  try {
    writePlayback(entry(), { dataDir: dir });
    const signals = [];
    const stopped = stopPlayback({
      dataDir: dir,
      now: () => 2000,
      isAlive: () => true,
      kill: (pid, sig) => signals.push([pid, sig]),
    });
    assert.equal(stopped, true);
    assert.deepEqual(signals, [[4242, "SIGTERM"]]);
    assert.equal(existsSync(playbackStatePath({ dataDir: dir })), false, "停后清状态");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stopPlayback：陈旧记录（超 TTL）不杀、清状态", () => {
  const dir = tempConfigDir();
  try {
    writePlayback(entry({ startedAt: 1000 }), { dataDir: dir });
    let killed = false;
    const stopped = stopPlayback({
      dataDir: dir,
      now: () => 1000 + PLAYBACK_TTL_MS + 1,
      isAlive: () => true,
      kill: () => {
        killed = true;
      },
    });
    assert.equal(stopped, false);
    assert.equal(killed, false);
    assert.deepEqual(readPlayback(undefined, { dataDir: dir }), {}, "陈旧条目已被清");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stopPlayback：进程已退出 → 静默降级并清状态", () => {
  const dir = tempConfigDir();
  try {
    writePlayback(entry(), { dataDir: dir });
    let killed = false;
    const stopped = stopPlayback({
      dataDir: dir,
      now: () => 2000,
      isAlive: () => false,
      kill: () => {
        killed = true;
      },
    });
    assert.equal(stopped, false);
    assert.equal(killed, false);
    assert.deepEqual(readPlayback(undefined, { dataDir: dir }), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stopPlayback：pid<=1 或自身 pid → 不杀（红线）", () => {
  const dir = tempConfigDir();
  try {
    let killed = false;
    writePlayback(entry({ pid: 1 }), { dataDir: dir });
    assert.equal(stopPlayback({ dataDir: dir, now: () => 2000, isAlive: () => true, kill: () => (killed = true) }), false);
    assert.equal(killed, false);

    writePlayback(entry({ pid: process.pid }), { dataDir: dir });
    assert.equal(stopPlayback({ dataDir: dir, now: () => 2000, isAlive: () => true, kill: () => (killed = true) }), false);
    assert.equal(killed, false);

    assert.equal(stopPlayback({ dataDir: dir, now: () => 2000, isAlive: () => true }), false, "无记录 → false");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stopPlayback：损坏的状态文件 → 视为无记录", () => {
  const dir = tempConfigDir();
  try {
    assert.deepEqual(readPlayback(undefined, { dataDir: dir }), {});
    assert.equal(stopPlayback({ dataDir: dir, now: () => 2000, isAlive: () => true, kill: () => {} }), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("playback-state：playerPid 可选字段——新格式 roundtrip、旧格式兼容、非法值忽略", () => {
  const dir = tempConfigDir();
  try {
    // 新格式：带 playerPid（真正发声的孙进程）
    const withPlayer = entry({ playerPid: 5555 });
    assert.equal(writePlayback(withPlayer, { dataDir: dir }), true);
    assert.deepEqual(readPlayback(undefined, { dataDir: dir }), { [PLAYBACK_OWNERLESS_KEY]: withPlayer });
    assert.match(readFileSync(playbackStatePath({ dataDir: dir }), "utf8"), /"playerPid":5555/, "文件含 playerPid");

    // 旧格式（无 playerPid）：读出对象不带该键（向后兼容，不破坏旧读者）
    writeFileSync(playbackStatePath({ dataDir: dir }), JSON.stringify(entry()), "utf8");
    const legacy = readPlayback(PLAYBACK_OWNERLESS_KEY, { dataDir: dir });
    assert.equal(legacy.playerPid, undefined, "旧格式不新增键");
    assert.equal(legacy.pid, 4242);

    // 非法 playerPid（0 / 负数 / 字符串）一律忽略
    for (const bad of [0, -3, "77"]) {
      writeFileSync(playbackStatePath({ dataDir: dir }), JSON.stringify({ ...entry(), playerPid: bad }), "utf8");
      assert.equal(readPlayback(PLAYBACK_OWNERLESS_KEY, { dataDir: dir }).playerPid, undefined, `非法 playerPid=${String(bad)} 被忽略`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stopPlayback：带 playerPid → 两个 PID 都 TERM（双杀，消 Windows 杀父不杀孙）", () => {
  const dir = tempConfigDir();
  try {
    writePlayback(entry({ playerPid: 4343 }), { dataDir: dir });
    const signals = [];
    const stopped = stopPlayback({
      dataDir: dir,
      now: () => 2000,
      isAlive: () => true,
      kill: (pid, sig) => signals.push([pid, sig]),
    });
    assert.equal(stopped, true);
    assert.deepEqual(signals, [
      [4242, "SIGTERM"],
      [4343, "SIGTERM"],
    ], "CLI pid 与发声孙进程 playerPid 都收到 SIGTERM");
    assert.equal(existsSync(playbackStatePath({ dataDir: dir })), false, "停后清状态");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("playback-state：sessionID roundtrip——新格式带会话归属、旧格式无键兼容、非法值忽略", () => {
  const dir = tempConfigDir();
  try {
    // 新格式：带 sessionID（auto-read 派生 CLI 经 env 注入 → CLI 登记带入）→ 键=会话 ID
    const owned = entry({ sessionID: "ses_a" });
    assert.equal(writePlayback(owned, { dataDir: dir }), true);
    assert.deepEqual(readPlayback("ses_a", { dataDir: dir }), owned);
    assert.deepEqual(readPlayback(undefined, { dataDir: dir }), { ses_a: owned });
    assert.match(readFileSync(playbackStatePath({ dataDir: dir }), "utf8"), /"sessionID":"ses_a"/, "文件含 sessionID");

    // 旧格式（无 sessionID）：读出对象不带该键（= 无主播放，任何消息可打断），落哨兵键
    writeFileSync(playbackStatePath({ dataDir: dir }), JSON.stringify(entry()), "utf8");
    const legacy = readPlayback(PLAYBACK_OWNERLESS_KEY, { dataDir: dir });
    assert.equal(legacy.sessionID, undefined, "旧格式不新增键（同 playerPid 口径）");
    assert.equal(legacy.pid, 4242);

    // 非法 sessionID（空串/数字）一律忽略 → 按无主读
    for (const bad of ["", 7]) {
      writeFileSync(playbackStatePath({ dataDir: dir }), JSON.stringify({ ...entry(), sessionID: bad }), "utf8");
      assert.equal(readPlayback(PLAYBACK_OWNERLESS_KEY, { dataDir: dir }).sessionID, undefined, `非法 sessionID=${String(bad)} 被忽略`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stopPlayback：带 sessionID——跨会话不杀不清、同会话照杀（修跨会话误杀）", () => {
  const dir = tempConfigDir();
  try {
    const target = entry({ sessionID: "ses_a" });
    writePlayback(target, { dataDir: dir });
    const signals = [];
    // 跨会话（另一窗口新会话的消息）：不发信号、不清状态——条目仍归 ses_a
    const skipped = stopPlayback({
      dataDir: dir,
      sessionID: "ses_b",
      now: () => 2000,
      isAlive: () => true,
      kill: (pid, sig) => signals.push([pid, sig]),
    });
    assert.equal(skipped, false, "跨会话 → false");
    assert.deepEqual(signals, [], "跨会话零信号（不误杀）");
    assert.deepEqual(readPlayback("ses_a", { dataDir: dir }), target, "条目保留（不动别会话的播放）");
    // 同会话：照停（现红线流程）+ 清状态
    const stopped = stopPlayback({
      dataDir: dir,
      sessionID: "ses_a",
      now: () => 2000,
      isAlive: () => true,
      kill: (pid, sig) => signals.push([pid, sig]),
    });
    assert.equal(stopped, true, "同会话 → 停");
    assert.deepEqual(signals, [[4242, "SIGTERM"]]);
    assert.equal(existsSync(playbackStatePath({ dataDir: dir })), false, "停后清状态");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stopPlayback：带 sessionID 而条目无主 → 跳过（方案 A：不杀、不清、返回 false）", () => {
  const dir = tempConfigDir();
  try {
    // 手动 CLI / 未注入会话的播放：无主条目。按会话停不再触碰它（旧口径会照杀）。
    const ownerless = entry();
    writePlayback(ownerless, { dataDir: dir });
    const signals = [];
    const stopped = stopPlayback({
      dataDir: dir,
      sessionID: "ses_any",
      now: () => 2000,
      isAlive: () => true,
      kill: (pid, sig) => signals.push([pid, sig]),
    });
    assert.equal(stopped, false, "无主条目 → 不发信号（false）");
    assert.deepEqual(signals, [], "按会话停零信号");
    assert.deepEqual(readPlayback(PLAYBACK_OWNERLESS_KEY, { dataDir: dir }), ownerless, "无主条目保留");
    assert.equal(existsSync(playbackStatePath({ dataDir: dir })), true, "状态文件未被清");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stopPlayback：无参或 sessionID 空 → 停全部条目（dispose/全清语义）", () => {
  const dir = tempConfigDir();
  try {
    // 无参：条目即便带 sessionID 也停（dispose/清场 = 全清）；**无主条目也只有这里才停**
    writePlayback(entry({ sessionID: "ses_a", pid: 111 }), { dataDir: dir });
    writePlayback(entry({ pid: 222 }), { dataDir: dir });
    let signals = [];
    assert.equal(
      stopPlayback({ dataDir: dir, now: () => 2000, isAlive: () => true, kill: (pid, sig) => signals.push([pid, sig]) }),
      true,
      "无参 → 停全部");
    assert.deepEqual(
      signals.map(([pid]) => pid).sort((a, b) => a - b),
      [111, 222],
      "有主 + 无主条目都被停",
    );
    assert.equal(existsSync(playbackStatePath({ dataDir: dir })), false, "全清后状态文件删除");

    // sessionID 为空白（等价无参）：同样停全部
    writePlayback(entry({ sessionID: "ses_a" }), { dataDir: dir });
    signals = [];
    assert.equal(
      stopPlayback({
        dataDir: dir,
        sessionID: "   ",
        now: () => 2000,
        isAlive: () => true,
        kill: (pid, sig) => signals.push([pid, sig]),
      }),
      true,
      "空 sessionID → 停全部",
    );
    assert.deepEqual(signals, [[4242, "SIGTERM"]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stopPlayback：playerPid 逐 PID 过红线——自身/重复/已退出只影响对应目标", () => {
  const dir = tempConfigDir();
  try {
    // playerPid 指向自身（红线）→ 只杀 pid
    writePlayback(entry({ playerPid: process.pid }), { dataDir: dir });
    let signals = [];
    assert.equal(
      stopPlayback({ dataDir: dir, now: () => 2000, isAlive: () => true, kill: (pid, sig) => signals.push([pid, sig]) }),
      true,
    );
    assert.deepEqual(signals, [[4242, "SIGTERM"]], "自身 playerPid 被红线挡下");

    // playerPid 与 pid 相同 → 去重只杀一次
    writePlayback(entry({ playerPid: 4242 }), { dataDir: dir });
    signals = [];
    assert.equal(
      stopPlayback({ dataDir: dir, now: () => 2000, isAlive: () => true, kill: (pid, sig) => signals.push([pid, sig]) }),
      true,
    );
    assert.deepEqual(signals, [[4242, "SIGTERM"]], "相同 PID 去重");

    // pid 已退出、playerPid 仍存活 → 仍杀 playerPid（旧格式此时会漏杀孙进程）
    writePlayback(entry({ playerPid: 4343 }), { dataDir: dir });
    signals = [];
    assert.equal(
      stopPlayback({
        dataDir: dir,
        now: () => 2000,
        isAlive: (pid) => pid === 4343,
        kill: (pid, sig) => signals.push([pid, sig]),
      }),
      true,
    );
    assert.deepEqual(signals, [[4343, "SIGTERM"]], "只杀存活目标");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("多条目 map：两会话并行 upsert 互不覆盖、同会话重写只顶本键", () => {
  const dir = tempConfigDir();
  try {
    assert.equal(writePlayback(entry({ sessionID: "ses_a", pid: 111 }), { dataDir: dir }), true);
    assert.equal(writePlayback(entry({ sessionID: "ses_b", pid: 222 }), { dataDir: dir }), true);
    const all = readPlayback(undefined, { dataDir: dir });
    assert.deepEqual(Object.keys(all).sort(), ["ses_a", "ses_b"], "两会话键并存");
    assert.equal(all.ses_a.pid, 111, "A 会话条目未被 B 的写入覆盖（混音前提）");
    assert.equal(all.ses_b.pid, 222);

    // 同会话重写 = upsert 单键（单会话互斥：新播顶旧播），其它键不动
    assert.equal(writePlayback(entry({ sessionID: "ses_a", pid: 333 }), { dataDir: dir }), true);
    assert.equal(readPlayback("ses_a", { dataDir: dir }).pid, 333, "本键被顶掉");
    assert.equal(readPlayback("ses_b", { dataDir: dir }).pid, 222, "其它键不动");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stopPlayback：按会话停只停本会话（跨会话混音），无参停全部", () => {
  const dir = tempConfigDir();
  try {
    writePlayback(entry({ sessionID: "ses_a", pid: 111 }), { dataDir: dir });
    writePlayback(entry({ sessionID: "ses_b", pid: 222 }), { dataDir: dir });

    // A 会话打断：只杀 A 的 pid，B 的条目保留（B 会话继续播 = 跨会话混音）
    const signalsA = [];
    assert.equal(
      stopPlayback({ dataDir: dir, sessionID: "ses_a", now: () => 2000, isAlive: () => true, kill: (pid, sig) => signalsA.push([pid, sig]) }),
      true,
    );
    assert.deepEqual(signalsA, [[111, "SIGTERM"]], "只杀本会话 PID");
    assert.equal(readPlayback("ses_a", { dataDir: dir }), undefined, "本会话条目已清");
    assert.equal(readPlayback("ses_b", { dataDir: dir }).pid, 222, "跨会话条目保留（不误杀）");

    // 无参：停全部剩余条目（dispose/全清）
    const signalsAll = [];
    assert.equal(
      stopPlayback({ dataDir: dir, now: () => 2000, isAlive: () => true, kill: (pid, sig) => signalsAll.push([pid, sig]) }),
      true,
    );
    assert.deepEqual(signalsAll, [[222, "SIGTERM"]]);
    assert.equal(existsSync(playbackStatePath({ dataDir: dir })), false, "全停后文件删除");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stopPlayback 方案 A 四条边界：按会话只停本会话、跳过无主；无参全清停无主", () => {
  const dir = tempConfigDir();
  try {
    // `_`（无主）+ ses_a + ses_b 三键并存
    const ownerless = entry({ pid: 111 });
    writePlayback(ownerless, { dataDir: dir });
    writePlayback(entry({ sessionID: "ses_a", pid: 222 }), { dataDir: dir });
    writePlayback(entry({ sessionID: "ses_b", pid: 333 }), { dataDir: dir });
    const signals = [];
    const stop = (sessionID) =>
      stopPlayback({
        dataDir: dir,
        ...(sessionID === undefined ? {} : { sessionID }),
        now: () => 2000,
        isAlive: () => true,
        kill: (pid, sig) => signals.push([pid, sig]),
      });

    // ① 带 sessionID=ses_a 且条目 ses_a → 正常停；无主与 ses_b 不动
    assert.equal(stop("ses_a"), true, "本会话条目 → 停");
    assert.deepEqual(signals, [[222, "SIGTERM"]], "只杀 ses_a");
    assert.deepEqual(readPlayback(PLAYBACK_OWNERLESS_KEY, { dataDir: dir }), ownerless, "无主条目保留");
    assert.equal(readPlayback("ses_b", { dataDir: dir }).pid, 333, "ses_b 保留");

    // ② 带 sessionID=ses_x 且条目无主 → 跳过（不杀不清、无其它命中 → false）
    signals.length = 0;
    assert.equal(stop("ses_x"), false, "无主条目被跳过 → false");
    assert.deepEqual(signals, [], "零信号");
    assert.deepEqual(readPlayback(PLAYBACK_OWNERLESS_KEY, { dataDir: dir }), ownerless, "无主条目仍保留");

    // ③ 带 sessionID=ses_a 且条目 ses_b → 跳过（跨会话既有行为不变）
    signals.length = 0;
    assert.equal(stop("ses_a"), false, "跨会话条目被跳过 → false");
    assert.deepEqual(signals, [], "零信号");
    assert.equal(readPlayback("ses_b", { dataDir: dir }).pid, 333, "ses_b 仍保留");

    // ④ 无参 → 停全部（含无主 `_`）
    signals.length = 0;
    assert.equal(stop(undefined), true, "无参 → 停全部");
    assert.deepEqual(
      signals.map(([pid]) => pid).sort((a, b) => a - b),
      [111, 333],
      "剩余的无主 + ses_b 都被停",
    );
    assert.equal(existsSync(playbackStatePath({ dataDir: dir })), false, "全清后状态文件删除");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("旧单条格式兼容：读作无主键 `_`（按会话停跳过、仅全清停）；带 sessionID 的旧条目键归一", () => {
  const dir = tempConfigDir();
  try {
    // 旧单条格式（顶层有数值 pid、无 sessionID）→ 无主键；按会话停不再触碰它
    const legacyPlain = entry({ pid: 4242 });
    writeFileSync(playbackStatePath({ dataDir: dir }), JSON.stringify(legacyPlain), "utf8");
    const all = readPlayback(undefined, { dataDir: dir });
    assert.deepEqual(Object.keys(all), [PLAYBACK_OWNERLESS_KEY], "旧格式 → 无主键");
    assert.deepEqual(all[PLAYBACK_OWNERLESS_KEY], legacyPlain);
    const signals = [];
    assert.equal(
      stopPlayback({ dataDir: dir, sessionID: "ses_any", now: () => 2000, isAlive: () => true, kill: (pid, sig) => signals.push([pid, sig]) }),
      false,
      "无主旧条目按会话停跳过",
    );
    assert.deepEqual(signals, [], "按会话停零信号");
    assert.deepEqual(readPlayback(PLAYBACK_OWNERLESS_KEY, { dataDir: dir }), legacyPlain, "无主旧条目保留");
    // 显式全清才停无主旧条目
    assert.equal(
      stopPlayback({ dataDir: dir, now: () => 2000, isAlive: () => true, kill: (pid, sig) => signals.push([pid, sig]) }),
      true,
      "无参全清停无主旧条目",
    );
    assert.deepEqual(signals, [[4242, "SIGTERM"]]);

    // 旧单条格式带 sessionID（第三批格式）→ 键仍为无主键 `_`（规格：旧单条一律视为无主条目）；
    // entry 内 sessionID 字段保留 → 归属门按字段仍保护跨会话（不降级为任意可杀）
    const legacyOwned = entry({ sessionID: "ses_a" });
    writeFileSync(playbackStatePath({ dataDir: dir }), JSON.stringify(legacyOwned), "utf8");
    const map = readPlayback(undefined, { dataDir: dir });
    assert.deepEqual(Object.keys(map), [PLAYBACK_OWNERLESS_KEY], "旧单条一律落无主键");
    assert.deepEqual(map[PLAYBACK_OWNERLESS_KEY], legacyOwned, "sessionID 字段保留（归属门仍按字段保护）");
    assert.equal(readPlayback("ses_a", { dataDir: dir }), undefined, "无主键不挂会话键下");
    const skipSignals = [];
    assert.equal(
      stopPlayback({ dataDir: dir, sessionID: "ses_b", now: () => 2000, isAlive: () => true, kill: (pid, sig) => skipSignals.push([pid, sig]) }),
      false,
      "带 sessionID 的旧条目：字段归属门仍挡跨会话",
    );
    assert.deepEqual(skipSignals, [], "跨会话零信号");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clearPlayback：删含该 pid 的条目（可能多条，含 playerPid 匹配）", () => {
  const dir = tempConfigDir();
  try {
    // 同一 pid 出现在两个键（旧格式迁移/异常残留场景）→ 一并删除，避免孤儿条目
    writePlayback(entry({ pid: 4242 }), { dataDir: dir });
    writePlayback(entry({ sessionID: "ses_a", pid: 4242 }), { dataDir: dir });
    assert.equal(Object.keys(readPlayback(undefined, { dataDir: dir })).length, 2);
    clearPlayback(4242, { dataDir: dir });
    assert.deepEqual(readPlayback(undefined, { dataDir: dir }), {}, "含该 pid 的条目全删、文件移除");

    // playerPid 匹配也算「含该 pid」
    writePlayback(entry({ sessionID: "ses_a", pid: 111, playerPid: 999 }), { dataDir: dir });
    clearPlayback(999, { dataDir: dir });
    assert.equal(readPlayback("ses_a", { dataDir: dir }), undefined, "playerPid 命中也删");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TTL：读取时顺带清陈旧条目并落盘", () => {
  const dir = tempConfigDir();
  try {
    const fresh = entry({ sessionID: "ses_a" });
    writeFileSync(
      playbackStatePath({ dataDir: dir }),
      JSON.stringify({ ses_a: fresh, ses_old: entry({ sessionID: "ses_old", startedAt: 1 }) }),
      "utf8",
    );
    const all = readPlayback(undefined, { dataDir: dir });
    assert.deepEqual(Object.keys(all), ["ses_a"], "陈旧条目被清、新鲜条目保留");
    // 落盘：文件里也不再有陈旧条目
    assert.deepEqual(JSON.parse(readFileSync(playbackStatePath({ dataDir: dir }), "utf8")), { ses_a: fresh });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stopPlaybackForSessions：逐会话各调 stop 一次（mock 注入断言），返回实际停到的会话、空 id 跳过", () => {
  const calls = [];
  const stop = (options) => {
    calls.push(options.sessionID);
    return options.sessionID !== "ses_noop";
  };
  const stopped = stopPlaybackForSessions(["ses_a", "ses_noop", "ses_b", "", "   "], stop);
  assert.deepEqual(calls, ["ses_a", "ses_noop", "ses_b"], "每个非空会话恰好调一次（空/空白跳过、不调）");
  assert.deepEqual(stopped, ["ses_a", "ses_b"], "返回实际发出终止信号的会话（按入参顺序）");
});

test("stopPlaybackForSessions：单会话 stop 抛错不中断其余会话（dispose 路径绝不抛）", () => {
  const calls = [];
  const stop = (options) => {
    calls.push(options.sessionID);
    if (options.sessionID === "ses_b") throw new Error("boom");
    return true;
  };
  let returned;
  assert.doesNotThrow(() => {
    returned = stopPlaybackForSessions(["ses_a", "ses_b", "ses_c"], stop);
  }, "抛错必须被隔离（onDispose 不能炸）");
  assert.deepEqual(calls, ["ses_a", "ses_b", "ses_c"], "失败会话之后仍继续停其余会话");
  assert.deepEqual(returned, ["ses_a", "ses_c"]);
});

test("stopPlaybackForSessions：接真 stopPlayback——每个会话条目各杀一次（TUI 退出停本窗口会话）", () => {
  const dir = tempConfigDir();
  try {
    writePlayback(entry({ sessionID: "ses_a", pid: 111, playerPid: 211 }), { dataDir: dir });
    writePlayback(entry({ sessionID: "ses_b", pid: 222 }), { dataDir: dir });
    writePlayback(entry({ sessionID: "ses_other", pid: 333 }), { dataDir: dir });
    const killed = [];
    const stopped = stopPlaybackForSessions(["ses_a", "ses_b", "ses_missing"], (options) =>
      stopPlayback({
        dataDir: dir,
        now: () => Date.now(),
        isAlive: () => true,
        kill: (pid, sig) => killed.push([options.sessionID, pid, sig]),
        ...options,
      }),
    );
    // 每个目标会话各杀一次：ses_a 双 PID（CLI+孙进程）、ses_b 单 PID；ses_missing 无条目 → 不在返回值
    assert.deepEqual(
      killed.map(([sid, pid]) => `${sid}:${pid}`).sort(),
      ["ses_a:111", "ses_a:211", "ses_b:222"],
      "遍历内每个会话条目各杀一次，pid/playerPid 都覆盖",
    );
    assert.deepEqual(stopped.sort(), ["ses_a", "ses_b"]);
    assert.equal(readPlayback("ses_other", { dataDir: dir }) !== undefined, true, "未遍历的会话条目不动");
    assert.equal(readPlayback("ses_a", { dataDir: dir }), undefined, "停过的会话条目已清");
    assert.equal(readPlayback("ses_b", { dataDir: dir }), undefined, "停过的会话条目已清");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ==================== isInterruptablePlaybackActive（F10 双态中断判活，2026-10-22） ====================

test("判活：本会话条目存活 → true；只有其它会话条目 → false（禁碰其他会话）", () => {
  const dir = tempConfigDir();
  try {
    // NOW 用真实时钟基准：loadMap 每次读取顺带清 TTL 陈旧条目，固定小数值会被当陈旧先清掉
    const NOW = Date.now();
    const opts = (isAlive) => ({ dataDir: dir, now: () => NOW, isAlive });
    writePlayback(entry({ sessionID: "ses_a", pid: 111, startedAt: NOW }), { dataDir: dir });
    assert.equal(isInterruptablePlaybackActive("ses_a", NOW, opts(() => true)), true);
    assert.equal(isInterruptablePlaybackActive("ses_b", NOW, opts(() => true)), false,
      "ses_b 无自己/无主的条目：其它会话在播不算本会话可中断");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("判活：无主条目（键 _）对任何会话都算；playerPid 存活也算；死条目清理；空 sessionID=全部条目", () => {
  const dir = tempConfigDir();
  try {
    const NOW = Date.now();
    writePlayback(entry({ pid: 222, playerPid: 333, startedAt: NOW }), { dataDir: dir }); // 无主
    assert.equal(
      isInterruptablePlaybackActive("ses_x", NOW, { dataDir: dir, now: () => NOW, isAlive: (pid) => pid === 333 }),
      true,
      "无主条目 + 仅 playerPid 存活 → true",
    );
    writePlayback(entry({ sessionID: "ses_other", pid: 444, startedAt: NOW }), { dataDir: dir });
    // 新口径（审计 P1）：新鲜 ≠ 活跃——pid/playerPid 都判死 ⇒ 不活跃，且无主条目被清理
    assert.equal(
      isInterruptablePlaybackActive("ses_x", NOW, { dataDir: dir, now: () => NOW, isAlive: () => false }),
      false,
      "新鲜但进程已死 → 不活跃（修「静默吞语音」）",
    );
    assert.deepEqual(
      Object.keys(readPlayback(undefined, { dataDir: dir, now: () => NOW })),
      ["ses_other"],
      "死掉的无主条目已清理；其它会话条目不动",
    );
    // 空 sessionID 口径：全部条目都算（与无参 stop 停全部同口径）
    assert.equal(
      isInterruptablePlaybackActive("", NOW, { dataDir: dir, now: () => NOW, isAlive: () => true }),
      true,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("判活：新鲜但 pid 已死 → 不活跃且条目被清理（修最长 30min 静默吞语音）", () => {
  const dir = tempConfigDir();
  try {
    const NOW = Date.now();
    writePlayback(entry({ sessionID: "ses_a", pid: 111, startedAt: NOW }), { dataDir: dir });
    assert.equal(
      isInterruptablePlaybackActive("ses_a", NOW, { dataDir: dir, now: () => NOW, isAlive: () => false }),
      false,
      "条目新鲜（<PLAYBACK_FRESH_TTL_MS）但 pid 已死 ⇒ 不阻断（fail-open 到不丢语音）",
    );
    assert.deepEqual(readPlayback(undefined, { dataDir: dir, now: () => NOW }), {}, "死条目已被清理并落盘");
    assert.equal(
      isInterruptablePlaybackActive("ses_a", NOW, { dataDir: dir, now: () => NOW, isAlive: () => false }),
      false,
      "再次判定不残留阻断",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("判活：探测抛错 → 不阻断（fail-open），且不清理无法判定的条目", () => {
  const dir = tempConfigDir();
  try {
    const NOW = Date.now();
    writePlayback(entry({ sessionID: "ses_a", pid: 111, startedAt: NOW }), { dataDir: dir });
    const throwing = () => {
      throw new Error("probe unavailable");
    };
    assert.equal(
      isInterruptablePlaybackActive("ses_a", NOW, { dataDir: dir, now: () => NOW, isAlive: throwing }),
      false,
      "探测失败/无法判定 → 不阻断（丢语音比多一次回声更不可接受）",
    );
    assert.equal(readPlayback("ses_a", { dataDir: dir, now: () => NOW }) !== undefined, true,
      "无法判定时不清理（避免误删可能仍在播的条目）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("判活：无 pid 的条目——短 TTL 内 fresh、超过即 dead（classifyPlaybackEntry）", () => {
  const NOW = Date.now();
  const noPid = { provider: "aliyun", startedAt: NOW, kind: "speak" };
  assert.ok(PLAYBACK_FRESH_TTL_MS > 0 && PLAYBACK_FRESH_TTL_MS <= 15_000, "短 TTL 必须 ≤15s");
  assert.equal(classifyPlaybackEntry(noPid, NOW, () => true), "fresh", "无 pid + 短窗口内 → 视为新鲜");
  assert.equal(
    classifyPlaybackEntry(noPid, NOW + PLAYBACK_FRESH_TTL_MS + 1, () => true),
    "dead",
    "无 pid + 超过短 TTL → 不活跃",
  );
  // 防御：外部/旧格式写入的无 pid 条目在 loadMap 即被丢弃 ⇒ 门不会因此阻断
  const dir = tempConfigDir();
  try {
    writeFileSync(
      playbackStatePath({ dataDir: dir }),
      JSON.stringify({ ses_a: { provider: "aliyun", startedAt: NOW, kind: "speak" } }),
      "utf8",
    );
    assert.equal(
      isInterruptablePlaybackActive("ses_a", NOW, { dataDir: dir, now: () => NOW, isAlive: () => true }),
      false,
      "无 pid 的非法条目被丢弃，不阻断语音",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("判活：正常播放中不误判（存活条目连续两次判活 → true，条目保留）", () => {
  const dir = tempConfigDir();
  try {
    const NOW = Date.now();
    writePlayback(entry({ sessionID: "ses_a", pid: 111, playerPid: 222, startedAt: NOW }), { dataDir: dir });
    assert.equal(isInterruptablePlaybackActive("ses_a", NOW, { dataDir: dir, now: () => NOW, isAlive: (pid) => pid === 222 }), true);
    assert.equal(isInterruptablePlaybackActive("ses_a", NOW, { dataDir: dir, now: () => NOW, isAlive: (pid) => pid === 222 }), true);
    assert.equal(readPlayback("ses_a", { dataDir: dir, now: () => NOW }) !== undefined, true, "正常播放条目不得被清理");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("判活：陈旧条目（超 TTL）已被 loadMap 清除 → false（与杀进程红线同口径，防 PID 复用误判）", () => {
  const dir = tempConfigDir();
  try {
    const NOW = Date.now();
    writePlayback(entry({ sessionID: "ses_a", pid: 111, startedAt: NOW - PLAYBACK_TTL_MS - 1 }), { dataDir: dir });
    assert.equal(
      isInterruptablePlaybackActive("ses_a", NOW, { dataDir: dir, now: () => NOW, isAlive: () => true }),
      false,
      "超 TTL 的条目读取时即清除，不算活跃",
    );
    assert.deepEqual(readPlayback(undefined, { dataDir: dir, now: () => NOW }), {}, "陈旧条目已被清并落盘");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("判活：无状态文件/空 map → false；nowMs 缺省走 Date.now 口径（存活条目为真）", () => {
  const dir = tempConfigDir();
  try {
    assert.equal(isInterruptablePlaybackActive("ses_a", undefined, { dataDir: dir, isAlive: () => true }), false,
      "缺文件 → 无条目 → false");
    writePlayback(entry({ sessionID: "ses_a", pid: 111 }), { dataDir: dir }); // startedAt=Date.now()
    assert.equal(isInterruptablePlaybackActive("ses_a", undefined, { dataDir: dir, isAlive: () => true }), true,
      "nowMs 缺省：pid 存活 → true");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("按会话停命中无主条目：INFO 取证行存在，且无主条目不再被停（方案 A）", async () => {
  const { readFileSync } = await import("node:fs");
  // 日志走文件（默认关闭）+ 无注入点：按本仓既有先例（emotions-hook.test.js）断言产物源码。
  const code = readFileSync(new URL("../dist/voice/playback-state.js", import.meta.url), "utf8");
  assert.match(code, /skipped ownerless stop: requestedBy=/, "按会话停跳过无主条目必须留 INFO 取证行");
  assert.match(
    code,
    /skipped ownerless stop: requestedBy=\$\{wanted\} provider=\$\{entry\.provider\} pid=\$\{entry\.pid\}/,
    "取证行字段：requestedBy/provider/pid（单行）",
  );
  assert.doesNotMatch(code, /stopping\s+ownerless entry:/, "旧 WARN 取证行已删除");
  assert.match(code, /if \(wanted\.length > 0 && !owned\)/, "仅按会话停（wanted 非空）才跳过无主；显式全清不跳过");
  assert.match(code, /skipped cross-session stop: session=/, "既有跨会话跳过 info 行保持");

  const dir = tempConfigDir();
  try {
    const ownerless = entry({ pid: 111 });
    writePlayback(ownerless, { dataDir: dir }); // 无主条目（键 `_`）
    const signals = [];
    assert.equal(
      stopPlayback({ dataDir: dir, sessionID: "ses_b", now: () => 2000, isAlive: () => true, kill: (pid, sig) => signals.push([pid, sig]) }),
      false,
      "按会话停不再连带无主条目（无其它命中 → false）",
    );
    assert.deepEqual(signals, [], "无主条目零信号");
    assert.deepEqual(readPlayback(PLAYBACK_OWNERLESS_KEY, { dataDir: dir }), ownerless, "无主条目保留");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
