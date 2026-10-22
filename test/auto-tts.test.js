/**
 * 自动朗读（auto_tts）的离线单测：
 * - **每会话目录**状态文件 `<root>/<sessionID>/auto-tts`（内容 `on`/`off`）读写与默认值（不触碰真实目录）；
 * - 状态根默认路径（`~/.opencode/plugins-cache/opencode-emotions`，dataDir 注入隔离）；
 * - `resetAutoTtsState()`：清整个 base 目录（所有会话子目录 + 旧版平铺遗留文件）、保留 tts-playback/tts、幂等
 *   （**2026-10-21 起生产不再调用**，仅测试/人工全量清；TUI 改每会话首见懒重置）；
 * - **每会话首见懒重置（2026-10-21 第七批，修多窗口 init 全清误删）**：`resetAutoTtsSession()`
 *   只删本会话目录不动其它/幂等；`resetAutoTtsSessionOnce(touched, sid)` 首见删、再见不删、
 *   空/非法 sid 不入集合不重置（touchedSessions 语义经注入 Set 直测）；
 * - **F10 键重复抑制**（`shouldAcceptAutoTtsToggle` 尾沿静默：一次按住只切换一次）；
 * - **按 sessionID 分会话开关**（A 开 B 关互不影响、每会话独立目录/文件）；
 * - 正文抽取只含 text part（排除 reasoning/thinking）；
 * - 触发器：助手消息完成 + 开关开启才朗读、按消息 id 去重、非助手/未完成消息忽略；
 * - **流式增量**：`message.part.delta` 驱动朗读（text-start 登记类型、reasoning delta 过滤、
 *   tainted part 快照兜底无重复）、角色惰性补取（assistant 续流式 / user 绝不读）、摘要不读、
 *   完成时每消息一条诊断汇总（`自动朗读汇总：… session=… path=stream|fallback|skip …`）；
 * - **子会话硬跳过**：注入 `fetchIsChildSession` 返回 true → 无论开关开没开都不读；
 * - 派生 bin：默认 `node`、env `VOICE_NODE_BIN` 可覆盖、deps 注入优先；
 * - 子进程 stderr / 非零退出 → warn 带片段（注入假 child）；
 * - **凑批合并 + 句对齐切分（2026-10-21 真修）**：drain 在途期间入队的块合并后按 `splitSentences()`
 *   切句（多句连读 ≤ `DRAIN_MERGE_MAX_CHARS`、未完尾巴 carry 至句尾/完成、单句超上限才句内硬切），
 *   `splitDrainUnits()` 纯函数直测 + drain 集成（argv 次数 + text-file 内容）；
 * - **interrupt 水位（按会话收窄，2026-10-21 第四批）**：`interrupt(sessionID)` 只停本会话——队列/水位/
 *   子进程 kill 三项都按会话过滤，跨会话不受影响；无参 `interrupt()` = 全清（回归）；同消息被打断后
 *   delta/快照丢弃、完成不补读（置 seen），下一条消息正常；
 * - **空文本**：纯空白块/空正文不派生、不报错；
 * - **sapi follow worker（deps.followSupport=true）**：首块 spawn 1 次 `speak --follow`、后续 0 次 spawn
 *   （写 stdin 行）、finalize 关 stdin 等退出、worker 天折 → 写失败停读该消息（水位同语义）。
 * - **会话级中断请求水位（2026-10-22，修「F10 中断后剩余文本继续播」）**：`interrupt-req` 助手读写/
 *   非法降级/随会话目录清理；auto-read 在每个派发单元前同步读——命中（请求时刻严格大于消息开始时间）
 *   走与 `interrupt` 同一套打断执行体（置水位 + 清队列/carry + kill 本会话子进程）、完成不补读，
 *   未命中/相等边界/无文件一律放行，跨会话不误杀，晚于水位的新消息照常读。
 *
 * 触发测试用 `spawnEnabled:false`（不真正派生子进程），日志即观察点；
 * 派生细节（bin/stderr/退出码/合并内容）用注入的假 `spawnFn`。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  AUTO_TTS_DIR_SEGMENTS,
  AUTO_TTS_OFF_VALUE,
  AUTO_TTS_ON_VALUE,
  AUTO_TTS_RESET_KEEP_NAMES,
  AUTO_TTS_TOGGLE_QUIET_MS,
  INTERRUPT_REQ_FILE_NAME,
  autoTtsDataDir,
  autoTtsInterruptPath,
  autoTtsSeenPath,
  autoTtsStatePath,
  readAutoTts,
  readAutoTtsSeen,
  readInterruptRequest,
  resetAutoTtsSession,
  resetAutoTtsSessionOnce,
  resetAutoTtsState,
  shouldAcceptAutoTtsToggle,
  writeAutoTts,
  writeAutoTtsSeen,
  writeInterruptRequest,
} from "../dist/voice/auto-tts.js";
import {
  AUTO_READ_NODE_BIN_ENV,
  DRAIN_MERGE_MAX_CHARS,
  createAutoReader,
  extractReplyText,
  splitDrainUnits,
} from "../dist/voice/auto-read.js";
import { PLAYBACK_SESSION_ENV } from "../dist/voice/playback-state.js";

/** 建一个隔离的临时状态目录（dataDir 注入用）。 */
function tempDataDir() {
  return mkdtempSync(join(tmpdir(), "auto-tts-"));
}

/** 记录日志的假 logger。 */
function stubLogger() {
  const infos = [];
  const warns = [];
  return {
    infos,
    warns,
    loaded() {},
    info(msg) {
      infos.push(msg);
    },
    warn(msg) {
      warns.push(msg);
    },
    error() {},
    hook() {},
    tool() {},
  };
}

/** 等一个事件循环 tick（触发器是 fire-and-forget）。 */
function tick() {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

/** 构造一条「已完成的助手消息」事件（默认 sessionID=ses_1）。 */
function completedAssistantEvent(messageID, extra = {}, sessionID = "ses_1") {
  return {
    type: "message.updated",
    properties: {
      sessionID,
      info: { id: messageID, role: "assistant", time: { created: 1, completed: 2 }, ...extra },
    },
  };
}

/**
 * 构造假的 child_process.spawn：捕获 command/args/options，异步 emit stderr 与 exit。
 * @param {{ exitCode?: number|null, signal?: string|null, stderrText?: string }} outcome 退出结局
 * @returns {{ spawnFn: Function, calls: Array }} 派生函数与调用记录
 */
function fakeSpawn({ exitCode = 0, signal = null, stderrText = "" } = {}) {
  const calls = [];
  const spawnFn = (command, args, options) => {
    const child = new EventEmitter();
    child.killed = false;
    child.stderr = new EventEmitter();
    child.stderr.setEncoding = () => {};
    child.kill = () => {
      child.killed = true;
    };
    calls.push({ command, args, options, child });
    setImmediate(() => {
      if (stderrText.length > 0) child.stderr.emit("data", stderrText);
      child.emit("exit", exitCode, signal);
    });
    return child;
  };
  return { spawnFn, calls };
}

test("auto-tts 状态：每会话目录 + on/off 单值，write(true)→文件含 on 且 read=true；write(false)→off", () => {
  const dir = tempDataDir();
  try {
    assert.equal(readAutoTts("ses_a", { dataDir: dir }), false, "缺文件时任意会话读为 false（默认关）");
    assert.equal(autoTtsStatePath("ses_a", { dataDir: dir }), join(dir, "ses_a", "auto-tts"));
    assert.equal(autoTtsSeenPath("ses_a", { dataDir: dir }), join(dir, "ses_a", "auto-tts-seen"));

    // 回归（用户实测 F10 bug）：写 true 后文件里必须出现内容，且 read 返回 true
    assert.equal(writeAutoTts("ses_a", true, { dataDir: dir }), true);
    assert.equal(readFileSync(autoTtsStatePath("ses_a", { dataDir: dir }), "utf8"), AUTO_TTS_ON_VALUE);
    assert.equal(readAutoTts("ses_a", { dataDir: dir }), true);

    // 写 false：键移除语义回归——内容变 off、read 返回 false（文件仍在，便于排查）
    assert.equal(writeAutoTts("ses_a", false, { dataDir: dir }), true);
    assert.equal(readFileSync(autoTtsStatePath("ses_a", { dataDir: dir }), "utf8"), AUTO_TTS_OFF_VALUE);
    assert.equal(readAutoTts("ses_a", { dataDir: dir }), false);

    // 非法内容容错为关（不炸）
    writeFileSync(autoTtsStatePath("ses_a", { dataDir: dir }), "garbage", "utf8");
    assert.equal(readAutoTts("ses_a", { dataDir: dir }), false, "非法内容按关降级");

    // 空/非法 sessionID 拒绝写入（防路径穿越），读一律 false/空集
    assert.equal(writeAutoTts("", true, { dataDir: dir }), false);
    assert.equal(writeAutoTts("../evil", true, { dataDir: dir }), false, "含路径分隔符的 id 拒绝");
    assert.equal(readAutoTts("", { dataDir: dir }), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auto-tts：按 sessionID 分会话开关（每会话独立目录文件，A 开 B 关互不影响）", () => {
  const dir = tempDataDir();
  try {
    assert.equal(writeAutoTts("ses_a", true, { dataDir: dir }), true);
    assert.equal(writeAutoTts("ses_b", false, { dataDir: dir }), true, "关闭未开启的会话也返回 true（幂等）");
    assert.equal(readAutoTts("ses_a", { dataDir: dir }), true);
    assert.equal(readAutoTts("ses_b", { dataDir: dir }), false);
    assert.equal(readFileSync(autoTtsStatePath("ses_a", { dataDir: dir }), "utf8"), AUTO_TTS_ON_VALUE);
    assert.equal(readFileSync(autoTtsStatePath("ses_b", { dataDir: dir }), "utf8"), AUTO_TTS_OFF_VALUE);

    // 再开 B：A 不受影响（目录天然隔离，无读-改-写竞争面）
    assert.equal(writeAutoTts("ses_b", true, { dataDir: dir }), true);
    assert.equal(readAutoTts("ses_a", { dataDir: dir }), true);
    assert.equal(readAutoTts("ses_b", { dataDir: dir }), true);

    // 关 A：B 保留
    assert.equal(writeAutoTts("ses_a", false, { dataDir: dir }), true);
    assert.equal(readAutoTts("ses_a", { dataDir: dir }), false);
    assert.equal(readAutoTts("ses_b", { dataDir: dir }), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auto-tts：会话数据根默认 ~/.opencode/plugins-cache/opencode-emotions（对齐 file-tool 布局）", () => {
  // 默认根 = homedir + .opencode/plugins-cache/opencode-emotions（对齐先例 plugins-cache/file-tool）
  const expected = join(homedir(), ".opencode", "plugins-cache", "opencode-emotions");
  assert.deepEqual([...AUTO_TTS_DIR_SEGMENTS], [".opencode", "plugins-cache", "opencode-emotions"]);
  assert.equal(autoTtsDataDir(), expected);
  assert.equal(autoTtsStatePath("ses_abc"), join(expected, "ses_abc", "auto-tts"));
  assert.equal(autoTtsSeenPath("ses_abc"), join(expected, "ses_abc", "auto-tts-seen"));
});

test("auto-tts：已朗读消息 id 按会话读写（滚动保留，会话间隔离）", () => {
  const dir = tempDataDir();
  try {
    assert.deepEqual([...readAutoTtsSeen("ses_1", { dataDir: dir })], [], "缺文件为空集");
    const seen = new Set(["a", "b", "c"]);
    writeAutoTtsSeen("ses_1", seen, { dataDir: dir });
    assert.deepEqual([...readAutoTtsSeen("ses_1", { dataDir: dir })], ["a", "b", "c"]);
    assert.deepEqual([...readAutoTtsSeen("ses_2", { dataDir: dir })], [], "另一会话不受影响");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resetAutoTtsState：清整个 base（所有会话目录 + 旧版平铺遗留），保留 tts-playback/tts，幂等（生产不再调用，语义保留）", () => {
  // 2026-10-21 起 TUI 改每会话首见懒重置（本函数生产不再调用）——全量清语义原样保留（测试/人工维护），
  // 故本用例不断言调用方、只锁函数行为。
  const dir = tempDataDir();
  try {
    writeAutoTts("ses_a", true, { dataDir: dir });
    writeAutoTts("ses_b", true, { dataDir: dir });
    writeAutoTtsSeen("ses_a", new Set(["m1", "m2"]), { dataDir: dir });
    // 旧版平铺遗留文件（单文件 JSON map 时代）应被顺手清掉
    writeFileSync(join(dir, "auto-tts"), '{"ses_a":true}', "utf8");
    writeFileSync(join(dir, "auto-tts-seen"), "m_old", "utf8");
    // base 根保留清单：播放 PID 瞬态文件与临时正文目录不触碰
    writeFileSync(join(dir, "tts-playback"), "{}", "utf8");
    mkdirSync(join(dir, "tts"), { recursive: true });
    writeFileSync(join(dir, "tts", "tmp.txt"), "body", "utf8");

    assert.equal(resetAutoTtsState({ dataDir: dir }), true, "删除返回 true");
    assert.equal(existsSync(autoTtsStatePath("ses_a", { dataDir: dir })), false, "会话开关目录已删");
    assert.equal(existsSync(autoTtsStatePath("ses_b", { dataDir: dir })), false, "会话开关目录已删");
    assert.equal(existsSync(autoTtsSeenPath("ses_a", { dataDir: dir })), false, "会话去重目录已删");
    assert.equal(existsSync(join(dir, "auto-tts")), false, "旧版平铺开关文件已清");
    assert.equal(existsSync(join(dir, "auto-tts-seen")), false, "旧版平铺去重文件已清");
    assert.equal(existsSync(join(dir, "tts-playback")), true, "tts-playback 不触碰");
    assert.equal(existsSync(join(dir, "tts", "tmp.txt")), true, "tts/ 临时目录不触碰");
    assert.equal(readAutoTts("ses_a", { dataDir: dir }), false, "重置后读为 false（清全表）");
    assert.equal(readAutoTts("ses_b", { dataDir: dir }), false, "重置后读为 false（清全表）");

    // 幂等：再删一次不抛错、返回 false（只剩保留清单）
    assert.equal(resetAutoTtsState({ dataDir: dir }), false, "幂等：干净目录返回 false");
    assert.doesNotThrow(() => resetAutoTtsState({ dataDir: dir }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resetAutoTtsSession：只删本会话目录（开关+去重），不动其它会话与 base 保留项，幂等/非法 sid 不动", () => {
  const dir = tempDataDir();
  try {
    writeAutoTts("ses_a", true, { dataDir: dir });
    writeAutoTtsSeen("ses_a", new Set(["m1", "m2"]), { dataDir: dir });
    writeAutoTts("ses_b", true, { dataDir: dir });
    writeAutoTtsSeen("ses_b", new Set(["m3"]), { dataDir: dir });
    writeFileSync(join(dir, "tts-playback"), "{}", "utf8");
    mkdirSync(join(dir, "tts"), { recursive: true });

    assert.equal(resetAutoTtsSession("ses_a", { dataDir: dir }), true, "首次删除返回 true");
    assert.equal(existsSync(autoTtsStatePath("ses_a", { dataDir: dir })), false, "本会话开关已删（随目录）");
    assert.equal(existsSync(autoTtsSeenPath("ses_a", { dataDir: dir })), false, "本会话去重已删（随目录）");
    assert.equal(readAutoTts("ses_b", { dataDir: dir }), true, "**其它会话开关不动**（多窗口核心：不误清先开窗口）");
    assert.deepEqual([...readAutoTtsSeen("ses_b", { dataDir: dir })], ["m3"], "其它会话去重不动");
    assert.equal(existsSync(join(dir, "tts-playback")), true, "base 根保留项 tts-playback 不碰");
    assert.equal(existsSync(join(dir, "tts")), true, "base 根保留项 tts/ 不碰");

    assert.equal(resetAutoTtsSession("ses_a", { dataDir: dir }), false, "幂等：目录不存在返回 false");
    assert.doesNotThrow(() => resetAutoTtsSession("ses_a", { dataDir: dir }), "幂等不抛错");

    // 空/非法 sid（防路径穿越）：不动任何文件
    assert.equal(resetAutoTtsSession("", { dataDir: dir }), false);
    assert.equal(resetAutoTtsSession("../evil", { dataDir: dir }), false);
    assert.equal(readAutoTts("ses_b", { dataDir: dir }), true, "非法 sid 未误删其它会话");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resetAutoTtsSessionOnce：本进程首见删该会话（从关开始）、再见不删（保住已激活开关），touched 只增", () => {
  const dir = tempDataDir();
  try {
    writeAutoTts("ses_a", true, { dataDir: dir });
    writeAutoTts("ses_b", true, { dataDir: dir });
    const touched = new Set();

    // 首见：删该会话目录并入集合 → 读为关
    assert.equal(resetAutoTtsSessionOnce(touched, "ses_a", { dataDir: dir }), true, "首见返回 true");
    assert.equal(readAutoTts("ses_a", { dataDir: dir }), false, "首见后读为关（从关开始）");
    assert.deepEqual([...touched], ["ses_a"], "首见会话入集合");
    assert.equal(readAutoTts("ses_b", { dataDir: dir }), true, "另一会话不受首见重置影响");

    // 再见（用户已按 F10 激活）：不删——保住本窗口已激活的开关
    assert.equal(writeAutoTts("ses_a", true, { dataDir: dir }), true);
    assert.equal(resetAutoTtsSessionOnce(touched, "ses_a", { dataDir: dir }), false, "再见返回 false");
    assert.equal(readAutoTts("ses_a", { dataDir: dir }), true, "再见不删（开关保住）");

    // 另一会话的首见只重置自己（后开窗口语义）
    assert.equal(resetAutoTtsSessionOnce(touched, "ses_b", { dataDir: dir }), true, "ses_b 首见");
    assert.equal(readAutoTts("ses_b", { dataDir: dir }), false, "ses_b 被重置为关");
    assert.equal(readAutoTts("ses_a", { dataDir: dir }), true, "ses_a 的开关仍保住");
    assert.deepEqual([...touched].sort(), ["ses_a", "ses_b"], "集合只增");

    // 空/非法 sid：不入集合、不重置（每次调用都返回 false，不记触碰）
    assert.equal(resetAutoTtsSessionOnce(touched, "", { dataDir: dir }), false);
    assert.equal(resetAutoTtsSessionOnce(touched, "../evil", { dataDir: dir }), false);
    assert.ok(!touched.has("") && !touched.has("../evil"), "非法 sid 未入集合");
    assert.equal(readAutoTts("ses_a", { dataDir: dir }), true, "非法 sid 调用未产生副作用");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shouldAcceptAutoTtsToggle：尾沿静默抑制键重复（一次按住只切换一次），间隔≥窗口的点按仍生效", () => {
  // 首次事件（last=0）恒接受
  assert.equal(shouldAcceptAutoTtsToggle(1_000_000, 0), true);
  // 模拟按住 F10：首个按下接受；OS 重复延迟（~500ms）后的连发事件（每 ~33ms 一个）全部吞掉——
  // 调用方对每个事件（含被吞的）都把窗口起点刷新为当前时刻，整串按住事件只产生一次切换
  let last = 0; // 初始无历史事件
  const events = [1_000_000, 1_000_500, 1_000_533, 1_000_566, 1_001_000, 1_001_500];
  const accepted = [];
  for (const now of events) {
    if (shouldAcceptAutoTtsToggle(now, last)) accepted.push(now);
    last = now;
  }
  assert.deepEqual(accepted, [1_000_000], "整串按住事件只接受第一个");
  // 松开静默 ≥ 窗口后的下一次点按重新生效
  const quiet = events.at(-1) + AUTO_TTS_TOGGLE_QUIET_MS;
  assert.equal(shouldAcceptAutoTtsToggle(quiet, events.at(-1)), true, "静默满窗口后接受");
  // 快速连按（< 窗口间隔）只算一次
  assert.equal(shouldAcceptAutoTtsToggle(events.at(-1) + 300, events.at(-1)), false);
});

test("extractReplyText：只取可见正文（排除 reasoning），跳过空/ignored，按换行连接", () => {
  const parts = [
    { type: "reasoning", text: "思考中……" },
    { type: "text", text: "第一段" },
    { type: "tool", text: "not-a-text-part" },
    { type: "text", text: "   " },
    { type: "text", text: "第二段", ignored: true },
    { type: "text", text: "第三段" },
  ];
  assert.equal(extractReplyText(parts), "第一段\n第三段");
  assert.equal(extractReplyText([]), "");
  assert.equal(extractReplyText([{ type: "reasoning", text: "只有思考" }]), "", "无 text part 时为空");
});

test("interrupt-req 助手：写/读会话级中断水位（时间戳单值；缺文件/非法内容/非法 sid 一律 0）", () => {
  const dir = tempDataDir();
  try {
    assert.equal(autoTtsInterruptPath("ses_a", { dataDir: dir }), join(dir, "ses_a", INTERRUPT_REQ_FILE_NAME));
    assert.equal(readInterruptRequest("ses_a", { dataDir: dir }), 0, "缺文件=无请求");
    assert.equal(writeInterruptRequest("ses_a", 1234567, { dataDir: dir }), true, "合法 sid + 正时间戳 → 写成功");
    assert.equal(readFileSync(autoTtsInterruptPath("ses_a", { dataDir: dir }), "utf8"), "1234567", "内容=时间戳单值");
    assert.equal(readInterruptRequest("ses_a", { dataDir: dir }), 1234567);

    // 非法内容/非正数/超出有限范围一律按「无请求」读 0（绝不抛错——读点在派发单元的关键路径上）
    for (const bad of ["", "   ", "garbage", "0", "-5", "1e999"]) {
      writeFileSync(autoTtsInterruptPath("ses_a", { dataDir: dir }), bad, "utf8");
      assert.equal(readInterruptRequest("ses_a", { dataDir: dir }), 0, `非法内容 ${JSON.stringify(bad)} 应读 0`);
    }

    // 空/非法 sessionID：拒写（false，防路径穿越）、读 0
    assert.equal(writeInterruptRequest("", 1, { dataDir: dir }), false);
    assert.equal(writeInterruptRequest("../evil", 1, { dataDir: dir }), false, "含路径分隔符的 id 拒绝");
    assert.equal(readInterruptRequest("", { dataDir: dir }), 0);
    assert.equal(readInterruptRequest("../evil", { dataDir: dir }), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("interrupt-req 水位语义：缺省取当前时刻、后写覆盖（单调前移）、会话间互不影响、非法时间戳回退当刻", () => {
  const dir = tempDataDir();
  try {
    const before = Date.now();
    assert.equal(writeInterruptRequest("ses_a", undefined, { dataDir: dir }), true);
    const first = readInterruptRequest("ses_a", { dataDir: dir });
    assert.ok(first >= before && first <= Date.now(), `缺省时间戳应为当前时刻（实际 ${first}）`);

    assert.equal(writeInterruptRequest("ses_a", 5000, { dataDir: dir }), true);
    assert.equal(readInterruptRequest("ses_a", { dataDir: dir }), 5000, "后写覆盖前写（水位前移）");
    assert.equal(readInterruptRequest("ses_b", { dataDir: dir }), 0, "另一会话不受影响（每会话一键）");

    // 非法时间戳（非有限/非正）回退当前时刻，绝不落 0（0=无请求，会把中断意图吞掉）
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(writeInterruptRequest("ses_a", bad, { dataDir: dir }), true);
      assert.ok(readInterruptRequest("ses_a", { dataDir: dir }) > 0, `非法入参 ${bad} 应回退当前时刻`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("interrupt-req 清理：resetAutoTtsSession 随会话目录一并删（不进 keep 清单），不动其它会话与 tts-playback/tts", () => {
  const dir = tempDataDir();
  try {
    // 口径钉死：水位文件在**会话目录内**，靠整目录删除清理；keep 清单只管 base 根的 playback/tts
    assert.deepEqual([...AUTO_TTS_RESET_KEEP_NAMES].sort(), ["tts", "tts-playback"], "keep 清单不得含 interrupt-req");
    writeAutoTts("ses_a", true, { dataDir: dir });
    writeInterruptRequest("ses_a", 111, { dataDir: dir });
    writeAutoTts("ses_b", true, { dataDir: dir });
    writeInterruptRequest("ses_b", 222, { dataDir: dir });
    writeFileSync(join(dir, "tts-playback"), "{}", "utf8");
    mkdirSync(join(dir, "tts"), { recursive: true });

    assert.equal(resetAutoTtsSession("ses_a", { dataDir: dir }), true);
    assert.equal(readInterruptRequest("ses_a", { dataDir: dir }), 0, "本会话水位已随目录清掉");
    assert.equal(existsSync(autoTtsStatePath("ses_a", { dataDir: dir })), false, "开关文件同批清");
    assert.equal(readInterruptRequest("ses_b", { dataDir: dir }), 222, "另一会话水位不动");
    assert.equal(existsSync(join(dir, "tts-playback")), true, "tts-playback 不触碰");
    assert.equal(existsSync(join(dir, "tts")), true, "tts/ 不触碰");

    // 全量清（测试/人工维护路径）同样覆盖水位文件
    assert.equal(resetAutoTtsState({ dataDir: dir }), true);
    assert.equal(readInterruptRequest("ses_b", { dataDir: dir }), 0, "resetAutoTtsState 后水位为 0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auto-read 会话级中断请求：命中（请求时刻严格大于消息开始）→ 拦下后续单元、置水位、完成不补读", async () => {
  const dir = tempDataDir();
  try {
    writeAutoTts("ses_1", true, { dataDir: dir });
    const log = stubLogger();
    const fallbacks = [];
    const reader = createAutoReader({
      log,
      cliPath: "/fake/emotions-cli.js",
      fetchParts: async (s, m) => {
        fallbacks.push(`${s}/${m}`);
        return [{ type: "text", text: "回退不应读" }];
      },
      paths: { dataDir: dir },
      configDir: dir,
      streamMinChars: 5,
      spawnEnabled: false,
    });
    // 消息开始时间取事件里的 time.created（权威值），便于用固定时间戳构造水位
    reader.handleEvent(roleEvent("msg_r", "assistant", "ses_1", 1_000));
    reader.handleEvent(partEvent("msg_r", "第一句话来了啊。", { sessionID: "ses_1" }));
    await tick();
    assert.equal(spokeFor(log, "msg_r"), 1, "前置：首单元已派生");

    // 中断请求（TUI 写）：请求时刻 5_000 > 开始 1_000 ⇒ 命中
    writeInterruptRequest("ses_1", 5_000, { dataDir: dir });
    reader.handleEvent(partEvent("msg_r", "第一句话来了啊。第二句话来了。", { sessionID: "ses_1" }));
    await tick();
    assert.equal(spokeFor(log, "msg_r"), 1, "命中后不再派生下一单元");
    assert.ok(
      log.infos.some((l) => l.includes("自动朗读命中中断请求：message=msg_r session=ses_1 req=5000 started=1000")),
      "命中日志带 req/started（实测取证口径）",
    );
    assert.ok(
      log.infos.some((l) => l.includes("自动朗读已打断：messages=1 session=ses_1")),
      "命中走 interrupt 同一套打断执行体",
    );

    // 后续快照/delta 一律丢弃，完成不补读（水位语义）
    reader.handleEvent(partEvent("msg_r", "第一句话来了啊。第二句话来了。第三句。", { sessionID: "ses_1" }));
    reader.handleEvent(completedAssistantEvent("msg_r", {}, "ses_1"));
    await tick();
    assert.equal(spokeFor(log, "msg_r"), 1, "被打断消息不再派生");
    assert.deepEqual(fallbacks, [], "命中消息不走回退整段读");
    assert.equal(readAutoTtsSeen("ses_1", { dataDir: dir }).has("msg_r"), true, "命中消息 seen 封口");

    // 会话级水位不影响**之后开始**的新消息（开始时间 > 请求时刻 ⇒ 放行；开关没变、后续照读）
    reader.handleEvent(roleEvent("msg_next", "assistant", "ses_1", 9_000));
    reader.handleEvent(partEvent("msg_next", "这是新的一条消息。", { sessionID: "ses_1" }));
    await tick();
    assert.equal(spokeFor(log, "msg_next"), 1, "晚于水位的消息照常朗读");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auto-read 会话级中断请求：未命中（请求早于消息开始）与相等边界 → 照常放行", async () => {
  const dir = tempDataDir();
  try {
    writeAutoTts("ses_1", true, { dataDir: dir });
    const log = stubLogger();
    const reader = createAutoReader({
      log,
      cliPath: "/fake/emotions-cli.js",
      fetchParts: async () => [{ type: "text", text: "不应整段" }],
      paths: { dataDir: dir },
      configDir: dir,
      streamMinChars: 5,
      spawnEnabled: false,
    });
    // ① 请求早于消息开始（5_000 < 9_000）⇒ 放行
    writeInterruptRequest("ses_1", 5_000, { dataDir: dir });
    reader.handleEvent(roleEvent("msg_old_req", "assistant", "ses_1", 9_000));
    reader.handleEvent(partEvent("msg_old_req", "第一句话来了啊。", { sessionID: "ses_1" }));
    await tick();
    assert.equal(spokeFor(log, "msg_old_req"), 1, "旧请求不误杀后开始的消息");

    // ② 相等边界（请求时刻 === 消息开始）⇒ 放行（语义钉死「开始时间 < 请求时间」才停）
    reader.handleEvent(roleEvent("msg_eq", "assistant", "ses_1", 5_000));
    reader.handleEvent(partEvent("msg_eq", "另一条同样时刻的消息。", { sessionID: "ses_1" }));
    await tick();
    assert.equal(spokeFor(log, "msg_eq"), 1, "相等不算命中（严格大于）");

    // ③ 无水位文件（读 0）⇒ 放行
    rmSync(autoTtsInterruptPath("ses_1", { dataDir: dir }), { force: true });
    reader.handleEvent(roleEvent("msg_none", "assistant", "ses_1", 9_000));
    reader.handleEvent(partEvent("msg_none", "没有请求文件的消息。", { sessionID: "ses_1" }));
    await tick();
    assert.equal(spokeFor(log, "msg_none"), 1, "无请求文件照常朗读");
    assert.ok(!log.infos.some((l) => l.includes("命中中断请求")), "未命中不打命中日志");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auto-read 会话级中断请求：命中只 kill 本会话在途 worker、清本会话队列，跨会话照常写行", async () => {
  const dir = tempDataDir();
  try {
    writeAutoTts("ses_1", true, { dataDir: dir });
    writeAutoTts("ses_2", true, { dataDir: dir });
    const log = stubLogger();
    const { spawnFn, calls } = workerSpawn();
    const reader = createAutoReader({
      log,
      cliPath: "/fake/emotions-cli.js",
      fetchParts: async () => [{ type: "text", text: "不应读" }],
      paths: { dataDir: dir },
      configDir: dir,
      streamMinChars: 5,
      followSupport: true,
      spawnBin: "node",
      spawnFn,
    });
    reader.handleEvent(roleEvent("msg_a", "assistant", "ses_1", 1_000));
    reader.handleEvent(partEvent("msg_a", "第一句话。", { sessionID: "ses_1" }));
    reader.handleEvent(roleEvent("msg_b", "assistant", "ses_2", 1_000));
    reader.handleEvent(partEvent("msg_b", "另一会话第一句。", { sessionID: "ses_2" }));
    await tick();
    assert.equal(calls.length, 2, "两会话各起一个 worker");

    // 只对 ses_1 写中断请求 ⇒ 时间+会话两道范围都只覆盖 msg_a
    writeInterruptRequest("ses_1", 5_000, { dataDir: dir });
    reader.handleEvent(partEvent("msg_a", "第一句话。第二句话。", { sessionID: "ses_1" }));
    reader.handleEvent(partEvent("msg_b", "另一会话第一句。第二句到了。", { sessionID: "ses_2" }));
    await tick();
    assert.equal(calls[0].child.killed, true, "本会话在途 worker 被 kill");
    assert.deepEqual(calls[0].lines, ["第一句话。\n"], "本会话第二单元不再写入（队列同批被清）");
    assert.equal(calls[1].child.killed, false, "跨会话 worker 不动");
    assert.deepEqual(calls[1].lines, ["另一会话第一句。\n", "第二句到了。\n"], "跨会话照常写行（不误杀）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auto-read follow worker：worker 活着但会话有中断请求 → 不再写行、停读该消息（补杀空缺口）", async () => {
  const dir = tempDataDir();
  try {
    writeAutoTts("ses_1", true, { dataDir: dir });
    const { spawnFn, calls } = workerSpawn();
    const log = stubLogger();
    const reader = createAutoReader({
      log,
      cliPath: "/fake/emotions-cli.js",
      fetchParts: async () => [{ type: "text", text: "不应回退整段" }],
      paths: { dataDir: dir },
      configDir: dir,
      streamMinChars: 5,
      followSupport: true,
      spawnBin: "node",
      spawnFn,
    });
    reader.handleEvent(roleEvent("msg_w", "assistant", "ses_1", 1_000));
    reader.handleEvent(partEvent("msg_w", "第一句话。"));
    await tick();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].lines, ["第一句话。\n"], "前置：首行已写入");

    // 中断请求：worker **没死**（写行本不会失败），旧链路拦不住 ⇒ 靠水位拦
    writeInterruptRequest("ses_1", 5_000, { dataDir: dir });
    reader.handleEvent(partEvent("msg_w", "第一句话。第二句话。"));
    await tick();
    assert.equal(calls.length, 1, "命中后不再派生新 worker");
    assert.deepEqual(calls[0].lines, ["第一句话。\n"], "第二行不写 stdin（拦在投递前）");
    assert.equal(calls[0].child.killed, true, "命中即 kill 本会话 worker");
    reader.handleEvent(completedAssistantEvent("msg_w", {}, "ses_1"));
    await tick();
    assert.equal(calls.length, 1, "完成不补读");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auto-read 回退整段读：命中中断请求 → 不 spawn、汇总 skip skipReason=interrupted", async () => {
  const dir = tempDataDir();
  try {
    writeAutoTts("ses_1", true, { dataDir: dir });
    const { spawnFn, calls } = fakeSpawn();
    const log = stubLogger();
    const reader = createAutoReader({
      log,
      cliPath: "/fake/emotions-cli.js",
      fetchParts: async () => [{ type: "text", text: "整段回退正文。" }],
      paths: { dataDir: dir },
      configDir: dir,
      spawnFn,
    });
    // 只过了完成事件（无 part 增量）⇒ 走 runFallback；开始时间=created 1_000
    writeInterruptRequest("ses_1", 5_000, { dataDir: dir });
    reader.handleEvent(completedAssistantEvent("msg_fb", { time: { created: 1_000, completed: 2_000 } }, "ses_1"));
    await tick();
    assert.equal(calls.length, 0, "回退 spawn 前命中水位 → 不派生");
    assert.ok(
      log.infos.some((l) => l.includes("message=msg_fb") && l.includes("path=skip") && l.includes("skipReason=interrupted")),
      "回退命中按 skip 汇总（与 interrupt 同口径）",
    );
    assert.equal(readAutoTtsSeen("ses_1", { dataDir: dir }).has("msg_fb"), true, "命中消息 seen 封口");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auto-read 触发器：开关开启 + 助手完成才朗读，且按消息 id 去重", async () => {
  const dir = tempDataDir();
  try {
    const log = stubLogger();
    const calls = [];
    const reader = createAutoReader({
      log,
      cliPath: "/fake/emotions-cli.js",
      fetchParts: async (sessionID, messageID) => {
        calls.push([sessionID, messageID]);
        return [
          { type: "reasoning", text: "思考" },
          { type: "text", text: "你好世界" },
        ];
      },
      paths: { dataDir: dir },
      configDir: dir,
      spawnBin: "node",
      spawnEnabled: false,
    });

    // 开关默认 off：不应朗读
    reader.handleEvent(completedAssistantEvent("msg_1"));
    await tick();
    assert.equal(calls.length, 0, "auto_tts 关闭时不取 parts");
    assert.equal(log.infos.length, 0);

    // 打开后：朗读一次（触发 + 汇总各一条 info）
    writeAutoTts("ses_1", true, { dataDir: dir });
    reader.handleEvent(completedAssistantEvent("msg_2"));
    await tick();
    assert.deepEqual(calls, [["ses_1", "msg_2"]]);
    assert.equal(log.infos.length, 2);
    assert.match(log.infos[0], /自动朗读/);
    assert.match(log.infos[0], /len=4/);
    assert.match(log.infos[1], /自动朗读汇总：message=msg_2 session=ses_1 path=fallback/, "回退路径打汇总（含 session）");

    // 同一消息重复事件：去重
    reader.handleEvent(completedAssistantEvent("msg_2"));
    await tick();
    assert.equal(calls.length, 1, "同一消息 id 不重复朗读");
    assert.equal(log.infos.length, 2);

    // 非助手消息 / 未完成 / 非 message.updated：忽略
    reader.handleEvent({
      type: "message.updated",
      properties: { sessionID: "ses_1", info: { id: "msg_3", role: "user", time: { completed: 2 } } },
    });
    reader.handleEvent({
      type: "message.updated",
      properties: { sessionID: "ses_1", info: { id: "msg_4", role: "assistant", time: { created: 1 } } },
    });
    reader.handleEvent({ type: "session.idle", properties: { sessionID: "ses_1" } });
    reader.handleEvent(null);
    await tick();
    assert.equal(calls.length, 1, "忽略的非目标事件不触发");

    // 去重记录已持久化（含 msg_2）
    assert.equal(readAutoTtsSeen("ses_1", { dataDir: dir }).has("msg_2"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auto-read 分会话：A 会话开、B 会话关 → 只读 A 的消息", async () => {
  const dir = tempDataDir();
  try {
    const log = stubLogger();
    const calls = [];
    const reader = createAutoReader({
      log,
      cliPath: "/fake/emotions-cli.js",
      fetchParts: async (sessionID, messageID) => {
        calls.push([sessionID, messageID]);
        return [{ type: "text", text: "你好世界" }];
      },
      paths: { dataDir: dir },
      configDir: dir,
      spawnEnabled: false,
    });

    writeAutoTts("ses_A", true, { dataDir: dir });
    writeAutoTts("ses_B", false, { dataDir: dir });

    reader.handleEvent(completedAssistantEvent("msg_a", {}, "ses_A"));
    reader.handleEvent(completedAssistantEvent("msg_b", {}, "ses_B"));
    await tick();
    assert.deepEqual(calls, [["ses_A", "msg_a"]], "只读 A 会话的消息；B 会话关 → 不读");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auto-read 子会话硬跳过：无论 map 开没开都不读（fallback 路径 + 汇总带 session/skipReason）", async () => {
  const dir = tempDataDir();
  try {
    const log = stubLogger();
    const calls = [];
    const childCalls = [];
    const reader = createAutoReader({
      log,
      cliPath: "/fake/emotions-cli.js",
      fetchParts: async (sessionID, messageID) => {
        calls.push([sessionID, messageID]);
        return [{ type: "text", text: "不应回退读" }];
      },
      fetchIsChildSession: async (sessionID) => {
        childCalls.push(sessionID);
        return sessionID === "ses_child";
      },
      paths: { dataDir: dir },
      configDir: dir,
      spawnEnabled: false,
    });

    // 子会话：map 开了也不读
    writeAutoTts("ses_child", true, { dataDir: dir });
    writeAutoTts("ses_parent", true, { dataDir: dir });

    reader.handleEvent(completedAssistantEvent("msg_c", {}, "ses_child"));
    // 等子会话判定补取完成
    await tick();
    await tick();
    assert.deepEqual(childCalls, ["ses_child"], "子会话单飞判定一次");
    assert.equal(calls.length, 0, "子会话不取 parts、不朗读");
    const skipSummary = log.infos.find((l) => l.includes("自动朗读汇总") && l.includes("msg_c"));
    assert.ok(skipSummary, "子会话跳过时仍打汇总");
    assert.match(skipSummary, /session=ses_child path=skip/);
    assert.match(skipSummary, /skipReason=child/);

    // 父会话：正常读
    reader.handleEvent(completedAssistantEvent("msg_p", {}, "ses_parent"));
    await tick();
    await tick();
    assert.deepEqual(calls, [["ses_parent", "msg_p"]], "父会话正常回退读");
    assert.equal(readAutoTtsSeen("ses_child", { dataDir: dir }).has("msg_c"), false, "子会话消息不写入其 seen");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auto-read 子会话硬跳过：增量路径（part/delta）在判定期间 fail-closed，判定后父会话恢复", async () => {
  const dir = tempDataDir();
  try {
    const log = stubLogger();
    const childFetches = [];
    let resolveChild;
    const childPromise = new Promise((resolve) => {
      resolveChild = resolve;
    });
    const reader = createAutoReader({
      log,
      cliPath: "/fake/emotions-cli.js",
      fetchParts: async () => [{ type: "text", text: "不应回退" }],
      fetchIsChildSession: async (sessionID) => {
        childFetches.push(sessionID);
        return childPromise; // 挂起直到手动 resolve
      },
      paths: { dataDir: dir },
      configDir: dir,
      streamMinChars: 5,
      spawnEnabled: false,
    });

    writeAutoTts("ses_x", true, { dataDir: dir });
    // 角色直接置为 assistant（跳过角色门，专注子会话门）
    reader.handleEvent({
      type: "message.updated",
      properties: { sessionID: "ses_x", info: { id: "msg_x", role: "assistant", time: { created: 1 } } },
    });
    reader.handleEvent({
      type: "message.part.updated",
      properties: { part: { id: "p1", type: "text", sessionID: "ses_x", messageID: "msg_x", text: "你好世界啊。" } },
    });
    await tick();
    assert.equal(
      log.infos.filter((l) => l.includes("自动朗读（测试模式）") || l.includes("自动朗读已触发")).length,
      0,
      "未知期间 fail-closed：不读",
    );
    assert.deepEqual(childFetches, ["ses_x"], "单飞判定");

    // 判定为父会话 → 后续快照恢复（句对齐：快照须含句末标点才会派生）
    resolveChild(false);
    await tick();
    reader.handleEvent({
      type: "message.part.updated",
      properties: { part: { id: "p1", type: "text", sessionID: "ses_x", messageID: "msg_x", text: "你好世界啊。" } },
    });
    await tick();
    assert.equal(
      log.infos.filter((l) => l.includes("自动朗读（测试模式）") || l.includes("自动朗读已触发")).length,
      1,
      "父会话恢复后快照兜底读出",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auto-read 派生 bin：默认 node、env VOICE_NODE_BIN 可覆盖、deps 注入优先", async () => {
  const dir = tempDataDir();
  const prevEnv = process.env[AUTO_READ_NODE_BIN_ENV];
  try {
    writeAutoTts("ses_1", true, { dataDir: dir });
    // 默认：无 env 覆盖 → "node"
    delete process.env[AUTO_READ_NODE_BIN_ENV];
    {
      const { spawnFn, calls } = fakeSpawn();
      const log = stubLogger();
      const reader = createAutoReader({
        log,
        cliPath: "/fake/emotions-cli.js",
        fetchParts: async () => [{ type: "text", text: "你好世界啊" }],
        paths: { dataDir: dir },
        configDir: dir,
        spawnFn,
      });
      reader.handleEvent(completedAssistantEvent("msg_bin_1"));
      await tick();
      assert.equal(calls.length, 1);
      assert.equal(calls[0].command, "node", "默认派生 bin 是 PATH 上的 node");
    }
    // env 覆盖
    process.env[AUTO_READ_NODE_BIN_ENV] = "custom-node";
    {
      const { spawnFn, calls } = fakeSpawn();
      const log = stubLogger();
      const reader = createAutoReader({
        log,
        cliPath: "/fake/emotions-cli.js",
        fetchParts: async () => [{ type: "text", text: "你好世界啊" }],
        paths: { dataDir: dir },
        configDir: dir,
        spawnFn,
      });
      reader.handleEvent(completedAssistantEvent("msg_bin_2"));
      await tick();
      assert.equal(calls[0].command, "custom-node", "env 可覆盖默认 node");
    }
    // deps.spawnBin 优先于 env
    {
      const { spawnFn, calls } = fakeSpawn();
      const log = stubLogger();
      const reader = createAutoReader({
        log,
        cliPath: "/fake/emotions-cli.js",
        fetchParts: async () => [{ type: "text", text: "你好世界啊" }],
        paths: { dataDir: dir },
        configDir: dir,
        spawnBin: "deps-bin",
        spawnFn,
      });
      reader.handleEvent(completedAssistantEvent("msg_bin_3"));
      await tick();
      assert.equal(calls[0].command, "deps-bin", "deps 注入优先于 env");
    }
  } finally {
    if (prevEnv === undefined) delete process.env[AUTO_READ_NODE_BIN_ENV];
    else process.env[AUTO_READ_NODE_BIN_ENV] = prevEnv;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auto-read 派生：非零退出或有 stderr → warn 带片段；exit 0 无输出不 warn", async () => {
  const dir = tempDataDir();
  try {
    writeAutoTts("ses_1", true, { dataDir: dir });
    // 场景 1：非零退出 + stderr → warn（带片段与 code）
    {
      const { spawnFn, calls } = fakeSpawn({ exitCode: 1, stderrText: "Error: boom\n" });
      const log = stubLogger();
      const reader = createAutoReader({
        log,
        cliPath: "/fake/emotions-cli.js",
        fetchParts: async () => [{ type: "text", text: "你好世界啊" }],
        paths: { dataDir: dir },
        configDir: dir,
        spawnFn,
      });
      reader.handleEvent(completedAssistantEvent("msg_warn_1"));
      await tick();
      assert.equal(calls.length, 1);
      assert.equal(log.warns.length, 1, "非零退出必须 warn");
      assert.match(log.warns[0], /code=1/);
      assert.match(log.warns[0], /boom/, "warn 带 stderr 片段");
      assert.match(log.warns[0], /node/, "warn 带 bin 便于排查");
    }
    // 场景 2：exit 0 但有 stderr → 仍 warn
    {
      const { spawnFn } = fakeSpawn({ exitCode: 0, stderrText: "provider warning: soft\n" });
      const log = stubLogger();
      const reader = createAutoReader({
        log,
        cliPath: "/fake/emotions-cli.js",
        fetchParts: async () => [{ type: "text", text: "你好世界啊" }],
        paths: { dataDir: dir },
        configDir: dir,
        spawnFn,
      });
      reader.handleEvent(completedAssistantEvent("msg_warn_2"));
      await tick();
      assert.equal(log.warns.length, 1, "有 stderr 即便 exit 0 也 warn");
      assert.match(log.warns[0], /soft/);
    }
    // 场景 3：exit 0 且无 stderr → 不 warn（正常播放不刷日志）
    {
      const { spawnFn } = fakeSpawn({ exitCode: 0 });
      const log = stubLogger();
      const reader = createAutoReader({
        log,
        cliPath: "/fake/emotions-cli.js",
        fetchParts: async () => [{ type: "text", text: "你好世界啊" }],
        paths: { dataDir: dir },
        configDir: dir,
        spawnFn,
      });
      reader.handleEvent(completedAssistantEvent("msg_warn_3"));
      await tick();
      assert.equal(log.warns.length, 0, "正常退出不 warn");
      assert.equal(log.infos.filter((line) => line.includes("已触发")).length, 1);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auto-read 触发器：空正文（仅 reasoning）不朗读", async () => {
  const dir = tempDataDir();
  try {
    writeAutoTts("ses_1", true, { dataDir: dir });
    const log = stubLogger();
    const reader = createAutoReader({
      log,
      cliPath: "/fake/emotions-cli.js",
      fetchParts: async () => [{ type: "reasoning", text: "只有思考" }],
      paths: { dataDir: dir },
      configDir: dir,
      spawnEnabled: false,
    });
    reader.handleEvent(completedAssistantEvent("msg_empty"));
    await tick();
    assert.equal(log.infos.filter((line) => line.includes("自动朗读")).length, 0, "无可见正文不朗读");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 一条 `message.part.updated` 事件（默认 text part；`id` 稳定以模拟同一 part 的全量快照）。 */
function partEvent(messageID, text, extra = {}) {
  const { id, ...rest } = extra;
  return {
    type: "message.part.updated",
    properties: {
      part: {
        id: id ?? `p-${messageID}-${rest.type ?? "text"}`,
        type: "text",
        sessionID: "ses_1",
        messageID,
        text,
        ...rest,
      },
    },
  };
}

/** 一条 `message.part.delta` 事件（文本流式的真正增量通道；payload 无 part）。 */
function deltaEvent(messageID, partID, delta, extra = {}) {
  return {
    type: "message.part.delta",
    properties: { sessionID: "ses_1", messageID, partID, field: "text", delta, ...extra },
  };
}

/**
 * 一条 `message.updated`（带角色，但未完成）事件。
 * @param {number} created 服务端 `time.created`（**会话级中断水位**比较的「消息开始时间」，默认 1）
 */
function roleEvent(messageID, role, sessionID = "ses_1", created = 1) {
  return {
    type: "message.updated",
    properties: { sessionID, info: { id: messageID, role, time: { created } } },
  };
}

/** 统计「已派生朗读」日志条数（只数触发行，不含「自动朗读汇总」/「角色补取」诊断行）。 */
function spokeCount(log) {
  return log.infos.filter((l) => l.includes("自动朗读（测试模式）") || l.includes("自动朗读已触发")).length;
}

/** 最后一条「已派生朗读」日志。 */
function lastSpoke(log) {
  return log.infos
    .filter((l) => l.includes("自动朗读（测试模式）") || l.includes("自动朗读已触发"))
    .at(-1);
}

/**
 * 指定消息的「已派生朗读」日志条数（临时文件名内含 messageID，可按消息归属计数）。
 * @param {object} log 假 logger
 * @param {string} messageId 消息 id
 * @returns {number} 该消息的派生次数
 */
function spokeFor(log, messageId) {
  return log.infos.filter(
    (l) =>
      (l.includes("自动朗读（测试模式）") || l.includes("自动朗读已触发")) &&
      l.includes(messageId),
  ).length;
}

test("auto-read 增量：阈值未达标不发送、达标后缓冲、句尾对齐才派生（句切分，2026-10-21 真修）", async () => {
  const dir = tempDataDir();
  try {
    writeAutoTts("ses_1", true, { dataDir: dir });
    const log = stubLogger();
    const calls = [];
    const reader = createAutoReader({
      log,
      cliPath: "/fake/emotions-cli.js",
      fetchParts: async (s, m) => {
        calls.push([s, m]);
        return [{ type: "text", text: "整段" }];
      },
      paths: { dataDir: dir },
      configDir: dir,
      streamMinChars: 5,
      spawnBin: "node",
      spawnEnabled: false,
    });

    // 角色未知：增量被忽略（避免把用户消息读出来；本例未注入 fetchMessageRole → 不补取）
    reader.handleEvent(partEvent("msg_1", "未知。"));
    await tick();
    assert.equal(spokeCount(log), 0);

    reader.handleEvent(roleEvent("msg_1", "assistant"));
    // 累计 < 5 字：缓冲、不朗读（阈值防开头卡顿）
    reader.handleEvent(partEvent("msg_1", "你好"));
    await tick();
    assert.equal(spokeCount(log), 0, "2 字 < 阈值 5：不发");
    reader.handleEvent(partEvent("msg_1", "你好世界"));
    await tick();
    assert.equal(spokeCount(log), 0, "累计 4 字 < 阈值 5：仍不发");

    // 累计达标但仍无句末标点：分块器已送出 → drain carry（未完句不派生，块边界等句尾）
    reader.handleEvent(partEvent("msg_1", "你好世界啊"));
    await tick();
    assert.equal(spokeCount(log), 0, "达标但未完句：carry 不派生（句对齐）");

    // 句子补完 → 整句一个单元派生
    reader.handleEvent(partEvent("msg_1", "你好世界啊，今天。"));
    await tick();
    assert.equal(spokeCount(log), 1, "句末标点到达 → 整句派生");
    assert.match(lastSpoke(log), /len=9/);

    // 下一句：先到的部分 carry，句尾才派生
    reader.handleEvent(partEvent("msg_1", "你好世界啊，今天。明天"));
    await tick();
    assert.equal(spokeCount(log), 1, "新句未完：仍 carry");
    reader.handleEvent(partEvent("msg_1", "你好世界啊，今天。明天天气。"));
    await tick();
    assert.equal(spokeCount(log), 2, "第二句完成 → 派生");
    assert.match(lastSpoke(log), /len=5/);

    // reasoning part 与 user 角色均忽略
    reader.handleEvent(partEvent("msg_1", "你好世界啊，今天。明天天气。", { type: "reasoning" }));
    reader.handleEvent(roleEvent("msg_9", "user"));
    reader.handleEvent(partEvent("msg_9", "用户说的。"));
    await tick();
    assert.equal(spokeCount(log), 2);

    // 完成：已无未读文本 → 不再追加（不触发 fetchParts 回退）
    reader.handleEvent(completedAssistantEvent("msg_1"));
    await tick();
    assert.equal(spokeCount(log), 2);
    assert.equal(calls.length, 0, "已增量朗读的消息不再整段读");
    assert.equal(readAutoTtsSeen("ses_1", { dataDir: dir }).has("msg_1"), true);

    // 完成后增量已 seen → 忽略
    reader.handleEvent(partEvent("msg_1", "你好世界啊，今天。明天天气。"));
    await tick();
    assert.equal(spokeCount(log), 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auto-read 增量：完成时补读未达阈值缓冲；interrupt 水位——同消息不再读、下一条正常", async () => {
  const dir = tempDataDir();
  try {
    writeAutoTts("ses_1", true, { dataDir: dir });
    const log = stubLogger();
    const reader = createAutoReader({
      log,
      cliPath: "/fake/emotions-cli.js",
      fetchParts: async () => [{ type: "text", text: "不应回退" }],
      paths: { dataDir: dir },
      configDir: dir,
      streamMinChars: 5,
      spawnEnabled: false,
    });

    assert.doesNotThrow(() => reader.interrupt(), "无在途消息时 interrupt 安全（不置位任何消息）");
    // ① 正常完成：未达阈值的缓冲在完成时补读（旧行为保留）
    reader.handleEvent(roleEvent("msg_a", "assistant"));
    reader.handleEvent(partEvent("msg_a", "短"));
    await tick();
    reader.handleEvent(partEvent("msg_a", "短文"));
    await tick();
    assert.equal(spokeCount(log), 0, "未完/未达阈值不读");
    reader.handleEvent(completedAssistantEvent("msg_a"));
    await tick();
    assert.equal(spokeCount(log), 1, "完成时补读未达阈值的缓冲");
    assert.match(lastSpoke(log), /len=2/, "短文（2 字）");

    // ② interrupt 水位：同一条消息被打断后，增量丢弃、完成不补读（置 seen 防回退整段重读）
    reader.handleEvent(roleEvent("msg_b", "assistant"));
    reader.handleEvent(partEvent("msg_b", "短文"));
    await tick();
    reader.interrupt();
    reader.handleEvent(partEvent("msg_b", "短文内容增")); // 打断后的快照：丢弃
    reader.handleEvent(deltaEvent("msg_b", "p-msg_b-text", "继续补充")); // 打断后的增量：丢弃
    reader.handleEvent(completedAssistantEvent("msg_b"));
    await tick();
    assert.equal(spokeCount(log), 1, "被打断的消息：delta/快照丢弃、完成不补读");
    assert.equal(readAutoTtsSeen("ses_1", { dataDir: dir }).has("msg_b"), true, "打断消息置 seen（防回退整段重读）");

    // ③ 下一条消息（新 messageID）不受影响
    reader.handleEvent(roleEvent("msg_c", "assistant"));
    reader.handleEvent(partEvent("msg_c", "新消息"));
    await tick();
    reader.handleEvent(completedAssistantEvent("msg_c"));
    await tick();
    assert.equal(spokeCount(log), 2, "interrupt 不影响下一条消息");
    assert.match(lastSpoke(log), /len=3/, "新消息（3 字）正常补读");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("interrupt(sessionID)：只停本会话——队列只清本会话、水位只置本会话，另一会话照常朗读", async () => {
  const dir = tempDataDir();
  try {
    writeAutoTts("ses_1", true, { dataDir: dir });
    writeAutoTts("ses_2", true, { dataDir: dir });
    const log = stubLogger();
    const fallbacks = [];
    const reader = createAutoReader({
      log,
      cliPath: "/fake/emotions-cli.js",
      fetchParts: async (s, m) => {
        fallbacks.push(`${s}/${m}`);
        return [{ type: "text", text: "回退不应读" }];
      },
      paths: { dataDir: dir },
      configDir: dir,
      streamMinChars: 5,
      spawnEnabled: false,
    });

    // 两会话各推进到「第一单元已投递（drain 挂起在 await）、第二句块在队列未派生」：
    // 第一条 partEvent 使句单元同步派生并挂起 drain，第二条把新句块推入队列（active 守门不重启 drain）
    reader.handleEvent(roleEvent("msg_a", "assistant", "ses_1"));
    reader.handleEvent(partEvent("msg_a", "第一句话来了啊。", { sessionID: "ses_1" }));
    reader.handleEvent(partEvent("msg_a", "第一句话来了啊。第二句话来了。", { sessionID: "ses_1" }));
    reader.handleEvent(roleEvent("msg_b", "assistant", "ses_2"));
    reader.handleEvent(partEvent("msg_b", "第二条消息来了。", { sessionID: "ses_2" }));
    reader.handleEvent(partEvent("msg_b", "第二条消息来了。继续补充内容。", { sessionID: "ses_2" }));
    assert.equal(spokeFor(log, "msg_a"), 1, "前置：msg_a 第一单元已派生");
    assert.equal(spokeFor(log, "msg_b"), 1, "前置：msg_b 第一单元已派生");

    // 打断**只针对 ses_1**
    reader.interrupt("ses_1");
    assert.ok(
      log.infos.some((l) => l.includes("自动朗读已打断：messages=1 session=ses_1")),
      "打断日志带 session 且只计本会话在途消息",
    );
    await tick();
    // ① 队列：本会话队列被清（第二单元不再播）；另一会话队列原样（第二单元照播）
    assert.equal(spokeFor(log, "msg_a"), 1, "本会话队列已清：待播第二单元不再派生");
    assert.equal(spokeFor(log, "msg_b"), 2, "跨会话队列不受影响：第二单元照常派生");

    // ② 水位：本会话消息后续快照丢弃、完成不补读（seen 封口、不走回退）；
    //    另一会话消息水位未置位 → 新快照照常朗读、完成正常置 seen
    reader.handleEvent(partEvent("msg_a", "第一句话来了啊。第二句话来了。第三句话又来了。", { sessionID: "ses_1" }));
    reader.handleEvent(completedAssistantEvent("msg_a", {}, "ses_1"));
    reader.handleEvent(partEvent("msg_b", "第二条消息来了。继续补充内容。再补一句新内容。", { sessionID: "ses_2" }));
    reader.handleEvent(completedAssistantEvent("msg_b", {}, "ses_2"));
    await tick();
    assert.equal(spokeFor(log, "msg_a"), 1, "本会话：打断后快照丢弃、完成不补读");
    assert.equal(spokeFor(log, "msg_b"), 3, "跨会话：打断后新快照仍朗读（水位未被误置）");
    assert.equal(readAutoTtsSeen("ses_1", { dataDir: dir }).has("msg_a"), true, "本会话打断消息 seen 封口");
    assert.equal(readAutoTtsSeen("ses_2", { dataDir: dir }).has("msg_b"), true, "跨会话消息正常完成去重");
    assert.deepEqual(fallbacks, [], "两条消息都未走回退整段读");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("interrupt(sessionID)：只 kill 本会话朗读子进程；无参 interrupt 全杀（全清回归）", async () => {
  const dir = tempDataDir();
  try {
    writeAutoTts("ses_1", true, { dataDir: dir });
    writeAutoTts("ses_2", true, { dataDir: dir });
    const log = stubLogger();
    const spawned = [];
    // 假子进程**不 emit exit**（kill 只置 killed）：进程保持「存活」，才能断言归属过滤；
    // 真实路径 exit 回调负责从 activeChildren 摘除（既有行为不回退）
    const spawnFn = (command, args, options) => {
      const child = new EventEmitter();
      child.killed = false;
      child.kill = () => {
        child.killed = true;
      };
      child.stderr = new EventEmitter();
      child.stderr.setEncoding = () => {};
      spawned.push({ command, args, options, child });
      return child;
    };
    const reader = createAutoReader({
      log,
      cliPath: "/fake/emotions-cli.js",
      fetchParts: async () => [{ type: "text", text: "回退不应读" }],
      paths: { dataDir: dir },
      configDir: dir,
      streamMinChars: 5,
      spawnFn,
    });
    reader.handleEvent(roleEvent("msg_a", "assistant", "ses_1"));
    reader.handleEvent(partEvent("msg_a", "第一句话来了啊。", { sessionID: "ses_1" }));
    reader.handleEvent(roleEvent("msg_b", "assistant", "ses_2"));
    reader.handleEvent(partEvent("msg_b", "第二条消息来了。", { sessionID: "ses_2" }));
    assert.equal(spawned.length, 2, "两会话各派生一个朗读子进程");
    assert.equal(spawned[0].options.env[PLAYBACK_SESSION_ENV], "ses_1", "前置：子进程 env 带归属会话");
    assert.equal(spawned[1].options.env[PLAYBACK_SESSION_ENV], "ses_2", "前置：子进程 env 带归属会话");

    // ① 带 sessionID：只杀本会话子进程（修「A 会话发消息腰斩 B 会话朗读」的进程半边）
    reader.interrupt("ses_1");
    assert.equal(spawned[0].child.killed, true, "本会话子进程被 kill");
    assert.equal(spawned[1].child.killed, false, "跨会话子进程不被 kill");

    // ② 无参 = 全清回归（dispose/清场路径语义不变）
    reader.interrupt();
    assert.equal(spawned[1].child.killed, true, "无参 interrupt 全杀（残留子进程一并 kill）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("interrupt() 无参回归：全清——所有会话的在途消息都置水位（完成一律不补读）", async () => {
  const dir = tempDataDir();
  try {
    writeAutoTts("ses_1", true, { dataDir: dir });
    writeAutoTts("ses_2", true, { dataDir: dir });
    const log = stubLogger();
    const fallbacks = [];
    const reader = createAutoReader({
      log,
      cliPath: "/fake/emotions-cli.js",
      fetchParts: async (s, m) => {
        fallbacks.push(`${s}/${m}`);
        return [{ type: "text", text: "回退不应读" }];
      },
      paths: { dataDir: dir },
      configDir: dir,
      streamMinChars: 5,
      spawnEnabled: false,
    });
    reader.handleEvent(roleEvent("msg_a", "assistant", "ses_1"));
    reader.handleEvent(partEvent("msg_a", "第一条消息内容。", { sessionID: "ses_1" }));
    reader.handleEvent(roleEvent("msg_b", "assistant", "ses_2"));
    reader.handleEvent(partEvent("msg_b", "第二条消息内容。", { sessionID: "ses_2" }));
    assert.equal(spokeCount(log), 2, "前置：两会话各派生一次");

    reader.interrupt();
    assert.ok(
      log.infos.some((l) => l.includes("自动朗读已打断：messages=2") && !l.includes(" session=")),
      "无参打断不带 session 后缀且覆盖全部会话的在途消息",
    );

    // 两会话的在途消息都被水位置位：后续快照丢弃、完成不补读
    reader.handleEvent(partEvent("msg_a", "第一条消息内容。补一句啊。", { sessionID: "ses_1" }));
    reader.handleEvent(partEvent("msg_b", "第二条消息内容。补一句啊。", { sessionID: "ses_2" }));
    reader.handleEvent(completedAssistantEvent("msg_a", {}, "ses_1"));
    reader.handleEvent(completedAssistantEvent("msg_b", {}, "ses_2"));
    await tick();
    assert.equal(spokeFor(log, "msg_a"), 1, "ses_1 在途消息被打断：完成不补读");
    assert.equal(spokeFor(log, "msg_b"), 1, "ses_2 在途消息被打断：完成不补读");
    assert.equal(readAutoTtsSeen("ses_1", { dataDir: dir }).has("msg_a"), true);
    assert.equal(readAutoTtsSeen("ses_2", { dataDir: dir }).has("msg_b"), true);
    assert.deepEqual(fallbacks, [], "被打断的消息不走回退整段读");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auto-read 触发器：重启后（已持久化 id）不回放旧消息", async () => {
  const dir = tempDataDir();
  try {
    writeAutoTts("ses_1", true, { dataDir: dir });
    writeAutoTtsSeen("ses_1", new Set(["msg_old"]), { dataDir: dir });
    const log = stubLogger();
    const reader = createAutoReader({
      log,
      cliPath: "/fake/emotions-cli.js",
      fetchParts: async () => [{ type: "text", text: "复读" }],
      paths: { dataDir: dir },
      configDir: dir,
      spawnEnabled: false,
    });
    reader.handleEvent(completedAssistantEvent("msg_old"));
    await tick();
    assert.equal(log.infos.filter((line) => line.includes("自动朗读")).length, 0, "插件重启后不重读已持久化的消息");
    assert.equal(existsSync(autoTtsStatePath("ses_1", { dataDir: dir })), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auto-read 增量：队列未空时关闭开关 → 派生前复查，不再播下一段（F10 关即停）", async () => {
  const dir = tempDataDir();
  try {
    writeAutoTts("ses_1", true, { dataDir: dir });
    const log = stubLogger();
    const reader = createAutoReader({
      log,
      cliPath: "/fake/emotions-cli.js",
      fetchParts: async () => [{ type: "text", text: "不应被整段读" }],
      paths: { dataDir: dir },
      configDir: dir,
      streamMinChars: 5,
      spawnBin: "node",
      spawnEnabled: false,
    });

    // 建立角色，使增量朗读生效
    reader.handleEvent(roleEvent("msg_q", "assistant"));
    // 第一段（完整句）：达阈值且句尾对齐 → 同步发出（drain 进入 await，active=true）
    reader.handleEvent(partEvent("msg_q", "你好世界啊。"));
    assert.equal(spokeCount(log), 1, "第一段同步入播");
    // 第二段：在**同一次同步推进**里入队（drain 仍忙 → 排队，不立即播）
    reader.handleEvent(partEvent("msg_q", "你好世界啊。今天"));
    assert.equal(spokeCount(log), 1, "第二段仍在队列、尚未播放");
    // 关闭开关（模拟 F10）：排在第一段之后、发生在队列被消费之前
    writeAutoTts("ses_1", false, { dataDir: dir });

    // 让 drain 继续：派生前复查发现已关闭 → 清空队列/carry、不再播第二段
    await tick();
    assert.equal(spokeCount(log), 1, "关闭后队列里待播的下一段不再派生（只播过第一段）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auto-read delta 流式：text-start 登记类型 + part.delta 增量驱动 + 句尾派生，reasoning delta 不读", async () => {
  const dir = tempDataDir();
  try {
    writeAutoTts("ses_1", true, { dataDir: dir });
    const log = stubLogger();
    const calls = [];
    const reader = createAutoReader({
      log,
      cliPath: "/fake/emotions-cli.js",
      fetchParts: async (s, m) => {
        calls.push([s, m]);
        return [{ type: "text", text: "不应回退" }];
      },
      paths: { dataDir: dir },
      configDir: dir,
      streamMinChars: 5,
      spawnEnabled: false,
    });

    reader.handleEvent(roleEvent("msg_d", "assistant"));
    // text-start：空快照登记 part 类型（真实事件 text:""；类型供 delta 判定）
    reader.handleEvent(partEvent("msg_d", "", { id: "p_text" }));
    reader.handleEvent(deltaEvent("msg_d", "p_text", "你好"));
    reader.handleEvent(deltaEvent("msg_d", "p_text", "世界"));
    await tick();
    assert.equal(spokeCount(log), 0, "4 字 < 阈值：不发");
    reader.handleEvent(deltaEvent("msg_d", "p_text", "啊。"));
    await tick();
    assert.equal(spokeCount(log), 1, "累计 6 字达阈值且句尾到达：整句派生");
    assert.match(lastSpoke(log), /len=6/);

    reader.handleEvent(deltaEvent("msg_d", "p_text", "，继续。"));
    await tick();
    assert.equal(spokeCount(log), 2, "第二句完成 → 派生");
    assert.match(lastSpoke(log), /len=4/);

    // reasoning part 的 delta 不读（delta payload 无类型，靠 part 起始快照登记表过滤）
    reader.handleEvent(partEvent("msg_d", "推理", { id: "p_r", type: "reasoning" }));
    reader.handleEvent(deltaEvent("msg_d", "p_r", "思考过程"));
    await tick();
    assert.equal(spokeCount(log), 2, "reasoning delta 不读");

    // text-end 快照与已累计文本一致 → 不重复朗读
    reader.handleEvent(partEvent("msg_d", "你好世界啊。，继续。", { id: "p_text" }));
    await tick();
    assert.equal(spokeCount(log), 2, "text-end 快照不重复");

    reader.handleEvent(completedAssistantEvent("msg_d"));
    await tick();
    assert.equal(calls.length, 0, "已增量朗读的消息不走回退整段读");
    const summary = log.infos.find((l) => l.includes("自动朗读汇总"));
    assert.ok(summary, "完成时打一条汇总（每消息一条，防刷屏）");
    assert.match(summary, /message=msg_d session=ses_1 path=stream/);
    assert.match(summary, /parts=2/, "text-start 空快照 + text-end 快照");
    assert.match(summary, /deltas=5/, "4 个正文 delta + 1 个 reasoning delta（都计入事件数，reasoning 被类型过滤不读）");
    assert.match(summary, /roleMiss=0/);
    assert.match(summary, /chunks=2/);
    assert.match(summary, /chars=10/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auto-read 角色补取：未知角色惰性 fetchMessageRole（并发去重），tainted part 由快照兜底无重复", async () => {
  const dir = tempDataDir();
  try {
    writeAutoTts("ses_1", true, { dataDir: dir });
    const log = stubLogger();
    const roleCalls = [];
    const reader = createAutoReader({
      log,
      cliPath: "/fake/emotions-cli.js",
      fetchParts: async () => [{ type: "text", text: "不应回退" }],
      fetchMessageRole: async (s, m) => {
        roleCalls.push([s, m]);
        return "assistant";
      },
      paths: { dataDir: dir },
      configDir: dir,
      streamMinChars: 5,
      spawnEnabled: false,
    });

    // 角色未知期间：text-start 被角色门挡下并 taint 该 part；delta 全丢（不入文本、不送 TTS）
    reader.handleEvent(partEvent("msg_r", "", { id: "p1" }));
    reader.handleEvent(deltaEvent("msg_r", "p1", "你好世界啊"));
    await tick();
    assert.equal(spokeCount(log), 0, "角色未知期间不读");
    assert.deepEqual(roleCalls, [["ses_1", "msg_r"]], "并发去重：多个事件只补取一次");
    assert.match(log.infos.find((l) => l.includes("自动朗读角色补取")), /role=assistant/);

    // 补取后该 part 仍 tainted → delta 继续丢弃（保「前缀」不变式，无空洞）
    reader.handleEvent(deltaEvent("msg_r", "p1", "，继续"));
    await tick();
    assert.equal(spokeCount(log), 0, "tainted part 的 delta 一律丢弃");

    // text-end 快照：part 未 tainted 前无文本 → 整段一次发出（无重复、无丢失；句对齐需句末标点）
    reader.handleEvent(partEvent("msg_r", "你好世界啊，继续。", { id: "p1" }));
    await tick();
    assert.equal(spokeCount(log), 1);
    assert.match(lastSpoke(log), /len=9/, "快照兜底读出完整 9 字（含句号）");

    reader.handleEvent(completedAssistantEvent("msg_r"));
    await tick();
    const summary = log.infos.find((l) => l.includes("自动朗读汇总"));
    assert.match(summary, /message=msg_r session=ses_1 path=stream/);
    assert.match(summary, /roleMiss=1/, "text-start 计一次未命中；tainted 后 delta 不再进门");
    assert.match(summary, /deltas=2/);
    assert.match(summary, /chunks=1/);
    assert.match(summary, /chars=9/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auto-read 角色补取为 user：消息绝不读（增量与快照都挡下）", async () => {
  const dir = tempDataDir();
  try {
    writeAutoTts("ses_1", true, { dataDir: dir });
    const log = stubLogger();
    const reader = createAutoReader({
      log,
      cliPath: "/fake/emotions-cli.js",
      fetchParts: async () => [{ type: "text", text: "不应回退" }],
      fetchMessageRole: async () => "user",
      paths: { dataDir: dir },
      configDir: dir,
      streamMinChars: 5,
      spawnEnabled: false,
    });

    reader.handleEvent(partEvent("msg_u", "", { id: "p1" }));
    reader.handleEvent(deltaEvent("msg_u", "p1", "你好世界啊"));
    await tick();
    reader.handleEvent(partEvent("msg_u", "你好世界啊，用户说的", { id: "p1" }));
    await tick();
    assert.equal(spokeCount(log), 0, "user 消息绝不读");
    assert.match(log.infos.find((l) => l.includes("自动朗读角色补取")), /role=user/);
    // 补取后角色=user 已入表：后续 delta/快照仍全部挡下（角色门实时命中缓存）
    reader.handleEvent(deltaEvent("msg_u", "p1", "继续说"));
    reader.handleEvent(partEvent("msg_u", "你好世界啊，用户说的继续", { id: "p1" }));
    await tick();
    assert.equal(spokeCount(log), 0, "user 角色入表后依旧不读");
    // 注：真实事件里 user 消息不会带 role=assistant 的完成事件（completedAssistantMessage 校验 role），
    // 故不存在「user 消息经完成回退被读」的路径——回退只信完成事件自报的 assistant 角色。
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auto-read 摘要消息（summary）不读：增量与快照都跳过", async () => {
  const dir = tempDataDir();
  try {
    writeAutoTts("ses_1", true, { dataDir: dir });
    const log = stubLogger();
    const reader = createAutoReader({
      log,
      cliPath: "/fake/emotions-cli.js",
      fetchParts: async () => [{ type: "text", text: "摘要也不该回退读" }],
      paths: { dataDir: dir },
      configDir: dir,
      streamMinChars: 5,
      spawnEnabled: false,
    });

    reader.handleEvent({
      type: "message.updated",
      properties: { sessionID: "ses_1", info: { id: "msg_s", role: "assistant", summary: true, time: { created: 1 } } },
    });
    reader.handleEvent(partEvent("msg_s", "", { id: "p1" }));
    reader.handleEvent(deltaEvent("msg_s", "p1", "压缩摘要正文"));
    reader.handleEvent(partEvent("msg_s", "压缩摘要正文全量", { id: "p1" }));
    await tick();
    assert.equal(spokeCount(log), 0, "摘要消息不朗读（压缩过程不发声）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * 假 spawn：**不自动退出**（由测试手动 `child.emit("exit")`），并在 spawn 当刻读走 `--text-file`
 * 内容（`spawnSpeak` 播完会删文件）——用于断言合并后的 argv 次数与每块正文。
 * @returns {{ spawnFn: Function, calls: Array }} 派生函数与调用记录（含 content/child）
 */
function heldSpawn() {
  const calls = [];
  const spawnFn = (command, args, options) => {
    const child = new EventEmitter();
    child.killed = false;
    child.stderr = new EventEmitter();
    child.stderr.setEncoding = () => {};
    child.kill = () => {
      child.killed = true;
    };
    let content = "";
    try {
      content = readFileSync(args[3], "utf8");
    } catch {
      // 文件应总在（writeFileSync 先于 spawn）；读不到按空处理由断言暴露
    }
    calls.push({ command, args, options, child, content });
    return child;
  };
  return { spawnFn, calls };
}

/**
 * 构造 follow worker 的假 `spawnFn`：child 带可写 stdin（捕获写入行），不自动退出
 * （由测试手动 emit exit 模拟 worker 生命周期）。
 * @returns {{ spawnFn: Function, calls: Array }} 派生函数与调用记录（含 lines/state/child）
 */
function workerSpawn() {
  const calls = [];
  const spawnFn = (command, args, options) => {
    const child = new EventEmitter();
    child.killed = false;
    child.stderr = new EventEmitter();
    child.stderr.setEncoding = () => {};
    child.kill = () => {
      child.killed = true;
    };
    const lines = [];
    const state = { ended: false };
    child.stdin = {
      writable: true,
      write(chunk) {
        if (state.ended || child.killed) return false;
        lines.push(chunk);
        return true;
      },
      end() {
        state.ended = true;
      },
      on() {},
      once() {},
      off() {},
    };
    calls.push({ command, args, options, child, lines, state });
    return child;
  };
  return { spawnFn, calls };
}

test("auto-read 凑批合并+句对齐：drain 在途期间入队的块合并后整句派生（argv 次数 + text-file 内容）", async () => {
  const dir = tempDataDir();
  try {
    writeAutoTts("ses_1", true, { dataDir: dir });
    const { spawnFn, calls } = heldSpawn();
    const log = stubLogger();
    const reader = createAutoReader({
      log,
      cliPath: "/fake/emotions-cli.js",
      fetchParts: async () => [{ type: "text", text: "不应回退" }],
      paths: { dataDir: dir },
      configDir: dir,
      streamMinChars: 5,
      spawnBin: "node",
      spawnFn,
    });

    reader.handleEvent(roleEvent("msg_m", "assistant"));
    // 首句完整 → 同步 spawn 第一次（held 不退出 → drain 占住 active，模拟 sapi 冷启动）
    reader.handleEvent(partEvent("msg_m", "这里是第一段。"));
    assert.equal(calls.length, 1, "首句立即单独派生");
    assert.equal(calls[0].content, "这里是第一段。");
    // drain 在途期间继续入队 3 块（真实场景：spawn 期间 delta 持续到达）
    reader.handleEvent(partEvent("msg_m", "这里是第一段。今天"));
    reader.handleEvent(partEvent("msg_m", "这里是第一段。今天天气"));
    reader.handleEvent(partEvent("msg_m", "这里是第一段。今天天气很好。"));
    assert.equal(calls.length, 1, "队列中的 3 块尚未派生（drain 在途）");
    // 首块结束 → drain 继续：3 块**合并**、句对齐后 1 次 spawn 读完整句（而非逐块 3 次冷启动）
    calls[0].child.emit("exit", 0, null);
    await tick();
    assert.equal(calls.length, 2, "队列 3 块合并为 1 次 spawn");
    assert.equal(calls[1].content, "今天天气很好。", "text-file 内容 = 合并后按句对齐的完整单元");
    const spawnedLog = log.infos.find((l) => l.includes("自动朗读已触发") && l.includes("len=7"));
    assert.ok(spawnedLog, "合并派生的日志 len=7（整句）");
    calls[1].child.emit("exit", 0, null);
    await tick();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("splitDrainUnits（纯函数）：多句连读 ≤ 上限、尾巴 carry、单句超上限才句内硬切", () => {
  // 多句连读：完整句按序连读成一个单元（≤ maxChars），未完尾巴 carry
  assert.deepEqual(splitDrainUnits("你好。世界。尾", 2000), { units: ["你好。世界。"], carry: "尾" });
  // 尾巴为空
  assert.deepEqual(splitDrainUnits("只有一句。", 2000), { units: ["只有一句。"], carry: "" });
  // 超上限在句边界断开（两个单元，不硬切句内）
  const twoSentences = `${"甲".repeat(8)}。${"乙".repeat(8)}。`;
  assert.deepEqual(splitDrainUnits(twoSentences, 10), { units: [`${"甲".repeat(8)}。`, `${"乙".repeat(8)}。`], carry: "" });
  // 单句超上限：唯一句内硬切场景（无句号的长 run 由 drain 的 carry 兜底覆盖，这里测有标点的超长句）
  const longSentence = `${"丙".repeat(25)}。`;
  const { units: hardUnits, carry: hardCarry } = splitDrainUnits(longSentence, 10);
  assert.equal(hardCarry, "");
  assert.deepEqual(hardUnits, [`${"丙".repeat(10)}`, `${"丙".repeat(10)}`, `${"丙".repeat(5)}。`]);
  // 完整性：所有单元按序拼接 = 原文（去句间空白后）
  const joined = hardUnits.join("");
  assert.equal(joined, longSentence);
});

test("auto-read 句对齐：无标点尾巴 carry 至消息完成才派生（末尾无标点不丢文本）", async () => {
  const dir = tempDataDir();
  try {
    writeAutoTts("ses_1", true, { dataDir: dir });
    const { spawnFn, calls } = heldSpawn();
    const log = stubLogger();
    const reader = createAutoReader({
      log,
      cliPath: "/fake/emotions-cli.js",
      fetchParts: async () => [{ type: "text", text: "不应回退" }],
      paths: { dataDir: dir },
      configDir: dir,
      streamMinChars: 5,
      spawnBin: "node",
      spawnFn,
    });
    reader.handleEvent(roleEvent("msg_t", "assistant"));
    // 达阈值但无句号：不派生（carry）
    reader.handleEvent(partEvent("msg_t", "没有句号的开头"));
    await tick();
    assert.equal(calls.length, 0, "未完句 carry，不派生");
    // 完成：carry 作为最终单元冲出（消息末尾无标点也不丢文本）
    reader.handleEvent(completedAssistantEvent("msg_t"));
    await tick();
    assert.equal(calls.length, 1, "done 时冲出 carry 尾段");
    assert.equal(calls[0].content, "没有句号的开头");
    calls[0].child.emit("exit", 0, null);
    await tick();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auto-read 无标点超长尾巴：carry 超 DRAIN_MERGE_MAX_CHARS 时句内硬切（防攒到 done）", async () => {
  const dir = tempDataDir();
  try {
    writeAutoTts("ses_1", true, { dataDir: dir });
    const { spawnFn, calls } = heldSpawn();
    const log = stubLogger();
    const reader = createAutoReader({
      log,
      cliPath: "/fake/emotions-cli.js",
      fetchParts: async () => [{ type: "text", text: "不应回退" }],
      paths: { dataDir: dir },
      configDir: dir,
      streamMinChars: 5,
      spawnBin: "node",
      spawnFn,
    });
    assert.equal(DRAIN_MERGE_MAX_CHARS, 2000, "上限口径");
    reader.handleEvent(roleEvent("msg_long", "assistant"));
    // 单快照 2500 字无标点：merge 时整块进 carry（>2000）→ 立即硬切 2000 出头，余 500 继续 carry
    reader.handleEvent(partEvent("msg_long", "长".repeat(2500)));
    await tick();
    assert.equal(calls.length, 1, "超长无标点尾巴触发句内硬切");
    assert.equal(calls[0].content, "长".repeat(2000), "硬切头 2000 字");
    calls[0].child.emit("exit", 0, null);
    await tick();
    // 完成：剩余 500 字 carry 作为最终单元冲出
    reader.handleEvent(completedAssistantEvent("msg_long"));
    await tick();
    assert.equal(calls.length, 2, "done 冲出剩余尾巴");
    assert.equal(calls[1].content, "长".repeat(500));
    calls[1].child.emit("exit", 0, null);
    await tick();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auto-read follow worker：首块 spawn 1 次 --follow、后续 0 次 spawn、写行有序、finalize 关 stdin 等退出", async () => {
  const dir = tempDataDir();
  try {
    writeAutoTts("ses_1", true, { dataDir: dir });
    const { spawnFn, calls } = workerSpawn();
    const log = stubLogger();
    const reader = createAutoReader({
      log,
      cliPath: "/fake/emotions-cli.js",
      fetchParts: async () => [{ type: "text", text: "不应回退" }],
      paths: { dataDir: dir },
      configDir: dir,
      streamMinChars: 5,
      followSupport: true,
      spawnBin: "node",
      spawnFn,
    });
    reader.handleEvent(roleEvent("msg_w", "assistant"));
    reader.handleEvent(partEvent("msg_w", "第一句话。"));
    await tick();
    assert.equal(calls.length, 1, "首句派生 worker（1 次 spawn）");
    assert.deepEqual(calls[0].args.slice(1), ["speak", "--follow"], "argv 为 speak --follow");
    assert.deepEqual(calls[0].lines, ["第一句话。\n"], "首行写入 stdin（含换行）");
    const startLogs = log.infos.filter((l) => l.includes("自动朗读 worker 启动"));
    assert.equal(startLogs.length, 1, "worker 启动 info 只打一条（info 低噪）");
    assert.match(startLogs[0], /message=msg_w/);
    // 后续句：不再 spawn，直接写行（顺序=句序）
    reader.handleEvent(partEvent("msg_w", "第一句话。第二句话。"));
    reader.handleEvent(partEvent("msg_w", "第一句话。第二句话。第三句话。"));
    await tick();
    assert.equal(calls.length, 1, "后续块不 spawn（复用同一 worker）");
    assert.deepEqual(calls[0].lines, ["第一句话。\n", "第二句话。\n", "第三句话。\n"], "行按句序写入");
    // finalize：done → drain 终态收敛关 worker：stdin.end + 等退出（冲刷尾音）
    reader.handleEvent(completedAssistantEvent("msg_w"));
    await tick();
    assert.equal(calls[0].state.ended, true, "finalize 关 stdin（EOF 收尾）");
    calls[0].child.emit("exit", 0, null);
    await tick();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auto-read follow worker 天折：写失败 → 停读该消息（水位同语义、置 seen 不补读），下一条正常", async () => {
  const dir = tempDataDir();
  try {
    writeAutoTts("ses_1", true, { dataDir: dir });
    const { spawnFn, calls } = workerSpawn();
    const log = stubLogger();
    const reader = createAutoReader({
      log,
      cliPath: "/fake/emotions-cli.js",
      fetchParts: async () => [{ type: "text", text: "不应回退整段" }],
      paths: { dataDir: dir },
      configDir: dir,
      streamMinChars: 5,
      followSupport: true,
      spawnBin: "node",
      spawnFn,
    });
    reader.handleEvent(roleEvent("msg_x", "assistant"));
    reader.handleEvent(partEvent("msg_x", "第一句话。"));
    await tick();
    assert.equal(calls.length, 1);
    // worker 中途异常退出（非 interrupt：killed=false）
    calls[0].child.emit("exit", 0, null);
    await tick();
    // 后续块：writeWorkerLine 抛（dead）→ warn + 置 interrupted + 清队列/carry（C 水位同语义）
    reader.handleEvent(partEvent("msg_x", "第一句话。第二句话。"));
    await tick();
    assert.equal(calls.length, 1, "worker 死后不再派生新 worker/块");
    assert.ok(
      log.warns.some((w) => w.includes("停止该消息朗读")),
      "写失败 warn（停止该消息朗读）",
    );
    // 完成不补读（水位语义）：置 seen 封口、无新 spawn
    reader.handleEvent(completedAssistantEvent("msg_x"));
    await tick();
    assert.equal(calls.length, 1);
    assert.equal(readAutoTtsSeen("ses_1", { dataDir: dir }).has("msg_x"), true, "停读消息置 seen（不回退整段重读）");
    // 下一条消息（新 messageID）不受影响：派生新 worker
    reader.handleEvent(roleEvent("msg_y", "assistant"));
    reader.handleEvent(partEvent("msg_y", "这是一条新消息。"));
    await tick();
    assert.equal(calls.length, 2, "下一条消息正常派生新 worker");
    assert.deepEqual(calls[1].lines, ["这是一条新消息。\n"]);
    reader.handleEvent(completedAssistantEvent("msg_y"));
    await tick();
    assert.equal(calls[1].state.ended, true, "下一条 finalize 同样关 stdin");
    calls[1].child.emit("exit", 0, null);
    await tick();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auto-read 空文本：纯空白块/空正文不 spawn、不报错（消「text 不能为空」异常退出）", async () => {
  const dir = tempDataDir();
  try {
    writeAutoTts("ses_1", true, { dataDir: dir });
    const { spawnFn, calls } = fakeSpawn();
    const log = stubLogger();
    const reader = createAutoReader({
      log,
      cliPath: "/fake/emotions-cli.js",
      fetchParts: async () => [{ type: "text", text: "   " }],
      paths: { dataDir: dir },
      configDir: dir,
      streamMinChars: 5,
      spawnFn,
    });

    // 增量路径：5 个空格达阈值 → 块为纯空白 → spawnSpeak 直接跳过（不写临时文件、不派生）
    reader.handleEvent(roleEvent("msg_e", "assistant"));
    reader.handleEvent(partEvent("msg_e", "", { id: "p1" }));
    reader.handleEvent(deltaEvent("msg_e", "p1", "     "));
    await tick();
    assert.equal(calls.length, 0, "纯空白块不派生子进程");
    assert.equal(spokeCount(log), 0);
    assert.equal(log.warns.length, 0, "不报错（无「text 不能为空」子进程异常退出）");

    // 回退路径：可见正文 trim 后为空 → 不读（另一条消息，无任何 part 事件）
    reader.handleEvent(completedAssistantEvent("msg_e2"));
    await tick();
    assert.equal(calls.length, 0, "空正文回退也不派生");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auto-read 派生 env：spawnSpeak 注入 EMOTIONS_SESSION_ID=<消息 sessionID>（CLI 登记会话归属）", async () => {
  const dir = tempDataDir();
  try {
    writeAutoTts("ses_42", true, { dataDir: dir });
    const { spawnFn, calls } = fakeSpawn();
    const log = stubLogger();
    const reader = createAutoReader({
      log,
      cliPath: "/fake/emotions-cli.js",
      fetchParts: async () => [{ type: "text", text: "你好世界啊" }],
      paths: { dataDir: dir },
      configDir: dir,
      spawnFn,
    });
    reader.handleEvent(completedAssistantEvent("msg_env_speak", {}, "ses_42"));
    await tick();
    assert.equal(calls.length, 1, "回退路径派生 1 次");
    assert.equal(
      calls[0].options.env[PLAYBACK_SESSION_ENV],
      "ses_42",
      "spawnSpeak 按消息 sessionID 注入 env（非 ses_1 才能证明取自事件而非硬编码）",
    );
    // 显式 env 必须仍继承进程环境（PATH 大小写随平台，按大写比对）
    assert.ok(
      Object.keys(calls[0].options.env).some((key) => key.toUpperCase() === "PATH"),
      "显式 env 仍继承进程环境（PATH）",
    );
    calls[0].child.emit("exit", 0, null);
    await tick();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auto-read 派生 env：follow worker 注入 EMOTIONS_SESSION_ID=<消息 sessionID>（跨会话误杀修复的写入侧）", async () => {
  const dir = tempDataDir();
  try {
    writeAutoTts("ses_1", true, { dataDir: dir });
    const { spawnFn, calls } = workerSpawn();
    const log = stubLogger();
    const reader = createAutoReader({
      log,
      cliPath: "/fake/emotions-cli.js",
      fetchParts: async () => [{ type: "text", text: "不应回退" }],
      paths: { dataDir: dir },
      configDir: dir,
      streamMinChars: 5,
      followSupport: true,
      spawnBin: "node",
      spawnFn,
    });
    reader.handleEvent(roleEvent("msg_env_w", "assistant"));
    reader.handleEvent(partEvent("msg_env_w", "第一句话。"));
    await tick();
    assert.equal(calls.length, 1, "首句派生 worker");
    assert.equal(
      calls[0].options.env[PLAYBACK_SESSION_ENV],
      "ses_1",
      "spawnWorker 按消息 sessionID 注入 env → worker CLI 登记的 tts-playback 带会话归属",
    );
    // 显式 env 必须仍继承进程环境（PATH 大小写随平台，按大写比对）
    assert.ok(
      Object.keys(calls[0].options.env).some((key) => key.toUpperCase() === "PATH"),
      "显式 env 仍继承进程环境（PATH）",
    );
    // 收尾：finalize 关 stdin、worker 退出（避免测试残留）
    reader.handleEvent(completedAssistantEvent("msg_env_w"));
    await tick();
    assert.equal(calls[0].state.ended, true);
    calls[0].child.emit("exit", 0, null);
    await tick();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
