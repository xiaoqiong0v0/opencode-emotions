/**
 * TUI 诊断埋点回归测试（F10 自动朗读全链路）。
 *
 * 测试对象是**构建产物** `dist/tui.js`（由 `scripts/build-tui.mjs` 以宿主同款 Babel 链编译）：
 * 产物依赖宿主重写 `@opentui/solid`/`solid-js`，无法在 node 里 import，故这里只**读文本断言**——
 * 保证四处埋点（registerLayer、命令入口、toggle 入口、写结果）与 logger 接线
 * 不会因为后续改动被悄悄删掉。只读不执行、不写任何文件。
 * （原 init/reset 与 slot session_id 两处一次性排障埋点已按审计结论删除，见 docs/changes 同日审计清理；
 * 本轮为定位「切会话后灯读旧会话」重新加 indicator 埋点，契约是**会话 id 值变才打**、低噪。）
 * 另覆盖 **2026-10-21 第七批**两条修复的产物接线：每会话首见懒重置（init 不再全清、两触点各一次）
 * 与 onDispose 遍历本窗口会话停播（修退出后 TTS 孤儿继续播）。
 * 另覆盖 **2026-10-22 根因修复**的产物接线：运行时脚本以 `import.meta.url` 推出的**产物自身位置**为锚点
 * （Babel 必须保留该表达式，否则静默退回 cwd 拼法、家目录启动即 spawn 必死）与 stderr **关键行**进 toast、
 * 全量尾部进日志（修「只显 Node.js 版本号」）。行为级用例见 `test/runtime-diagnostics.test.js`。
 * 另覆盖 **2026-10-22 会话级中断请求水位**（修「F10 中断后剩余文本继续播」）：两处中断出口
 * （F10 双态中断、F8/F9 barge-in）都原子写 `interrupt-req` 且写在 `stopPlayback` 之前、不碰开关文件
 * （行为侧的消费见 `test/auto-tts.test.js` 的「会话级中断请求」组）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** TUI 产物绝对路径（仓库根/dist/tui.js）。 */
const TUI_JS = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "tui.js");

/** 读取 TUI 产物源码文本（只读一次由调用方缓存，测试里直接调用即可）。 */
function tuiSource() {
  return readFileSync(TUI_JS, "utf8");
}

/** 只取**代码行**（滤掉注释行——doc/行注释里允许出现调用示例或演进说明的旧函数名文本）。 */
function tuiCode() {
  return tuiSource()
    .split("\n")
    .filter((line) => {
      const head = line.trim();
      return !head.startsWith("*") && !head.startsWith("//") && !head.startsWith("/*");
    })
    .join("\n");
}

test("TUI 产物接线 plugin-logger（日志名 emotions-tui）", () => {
  const src = tuiSource();
  assert.ok(
    src.includes(`from "@xiaoqiong0v0/opencode-plugin-logger"`),
    "产物未从 @xiaoqiong0v0/opencode-plugin-logger 导入 createLogger（TUI 侧诊断日志会整条消失）",
  );
  assert.ok(src.includes(`createLogger(LOG_NAME)`) || src.includes(`createLogger("emotions-tui")`), "产物缺少 createLogger 调用");
  assert.ok(src.includes('const LOG_NAME = "emotions-tui"'), "诊断日志名必须是 emotions-tui（与其它插件同一份日志文件）");
});

test("F10 四处埋点片段齐全（registerLayer、命令入口、toggle 入口、写结果）", () => {
  const src = tuiSource();
  /** 片段 → 该埋点必须同时出现的关键变量。 */
  const markers = [
    { head: "keymap layer registered:", keys: ["commands=", "bindings=", "autoTtsCmd="] },
    { head: "f10 command run:", keys: ["cmd="] },
    { head: "f10 toggle: sessionID=", keys: ["now=", "last=", "accepted="] },
    { head: "f10 write ", keys: ["path="] },
  ];
  for (const { head, keys } of markers) {
    assert.ok(src.includes(head), `缺少埋点片段：${head}`);
    const at = src.indexOf(head);
    // 埋点为单行文案：在同一行内检查关键变量，避免片段与变量落到不同条日志
    const line = src.slice(at, src.indexOf("\n", at));
    for (const key of keys) {
      assert.ok(line.includes(key), `埋点「${head}」缺少变量 ${key}（该行：${line.trim()}）`);
    }
  }
});

test("子会话与无会话分支各有独立埋点（不靠『没有写日志』反推原因）", () => {
  const src = tuiSource();
  assert.ok(src.includes("f10 toggle skip: no session route"), "缺少「不在会话路由」埋点");
  assert.ok(src.includes("childSession") && src.includes("skip=true"), "缺少「子会话跳过」埋点");
});

test("写失败仍保留 error toast（埋点只加日志、不改失败分支）", () => {
  const src = tuiSource();
  const writeAt = src.indexOf("f10 write ");
  assert.ok(writeAt > 0, "缺少写结果埋点");
  const tail = src.slice(writeAt, writeAt + 400);
  assert.ok(tail.includes("autoReadFailed"), "写失败分支的 error toast 丢失");
});

test("槽位读键路由优先（与 F10 写路径同源；props 仅兜底+响应依赖）", () => {
  const src = tuiSource();
  // 读写同源：读键以路由 currentSessionID(api) 为准，props 仅兜底并作为响应依赖
  // （props 优先且宿主传陈旧/非响应值时，切会话后灯会读旧会话状态——多会话实测现象）
  assert.ok(src.includes("const routeSid = currentSessionID(api)"), "槽位读键缺少路由取值 routeSid");
  assert.ok(src.includes("const sid = routeSid || fromProps ||"), "槽位读键不是路由优先（routeSid || props 兜底）");
  assert.ok(src.includes("readAutoTts(sid)"), "槽位读键未走同源 sid");
  // 旧的 props 优先表达式必须绝迹（产物连注释一起查：上一版注释里也写过该表达式）
  assert.ok(
    !src.includes('readAutoTts(props.session_id || currentSessionID(api) || "")'),
    "旧读路径（props 优先）残留",
  );
  // 读兜底不得动写路径：toggle 仍用 currentSessionID(api) 取值
  assert.ok(src.includes("const next = !readAutoTts(sessionID);"), "F10 写路径的读值被误改");
});

test("指示求值带会话 id 变化诊断（indicator session=，值变才打）", () => {
  const src = tuiSource();
  // 锚在代码形态（模板串插值），避开注释里的同名片段（产物保留注释）
  const at = src.indexOf("indicator session=${");
  assert.ok(at > 0, "缺少指示会话 id 诊断埋点（切会话是否重算无从取证）");
  // 埋点为单行文案：同一行内检查两源变量
  const line = src.slice(at, src.indexOf("\n", at));
  for (const key of ["route=", "props="]) {
    assert.ok(line.includes(key), `埋点「indicator session=」缺少变量 ${key}（该行：${line.trim()}）`);
  }
  // 低噪契约：与模块级 lastIndicatorSid 比较，值变才打（否则每次求值刷屏）
  assert.ok(src.includes("lastIndicatorSid"), "缺少 lastIndicatorSid 比较（诊断未做值变过滤）");
});

test("F8/F9/F10 打断带 sessionID（无裸 stopPlayback()，跨会话不误杀）", () => {
  // 只看代码行（滤掉注释行——doc 注释里允许出现调用示例文本）
  const code = tuiCode();
  // 裸调用 = 无条件停任意播放（另一窗口新会话的消息杀本会话播放的根因形态），必须绝迹
  assert.deepEqual(code.match(/stopPlayback\(\s*\)/g) ?? [], [], "存在裸 stopPlayback()：跨会话误杀回归");
  // 三处打断（toggleMode 的 F8/F9、toggleAutoRead 的 **F10 双态中断**〔2026-10-22 新增〕、F10 关闭）都必须传 sessionID（允许换行）
  const scoped = code.match(/stopPlayback\(\{\s*sessionID/g) ?? [];
  assert.equal(scoped.length, 3, "三处 stopPlayback 都必须带 sessionID（当前会话隔离）");
  // dispose 的批量停走会话遍历（不在这两处之列，见下方 onDispose 用例）
  assert.ok(code.includes("stopPlaybackForSessions(touchedSessions)"), "dispose 批量停未走逐会话遍历");
});

test("每会话首见懒重置接线（init 不再全清 base；两触点各一次；touchedSessions 模块级只增）", () => {
  const code = tuiCode();
  // 旧「TUI init 调 resetAutoTtsState() 清整个 base」在多窗口混音场景会误删先开窗口已激活的开关
  // （日志实锤：14:16:29 A=on → 开 B 窗 init 全清 → 14:17:09 A 再按读 off 又写 on），必须绝迹
  assert.deepEqual(
    code.match(/resetAutoTtsState\s*\(/g) ?? [],
    [],
    "init 全清回归：生产不得再调用 resetAutoTtsState()（仅测试/人工维护用）",
  );
  // 两个触点：指示读 autoReadOn 求值 + F10 toggleAutoRead 入口，各调一次
  const touch = code.match(/resetAutoTtsSessionOnce\(touchedSessions/g) ?? [];
  assert.equal(touch.length, 2, "两个触点（指示读 + F10 入口）各一次懒重置");
  assert.ok(
    code.includes("const touchedSessions = new Set"),
    "缺少模块级 touchedSessions 集合（首见语义无处记录）",
  );
});

test("运行时脚本以**产物自身位置**为锚点（Babel 产物保留 import.meta.url，修 cwd 根因）", () => {
  const code = tuiCode();
  // ① 锚点必须真的落到产物里（Babel 若把 import.meta 转掉，SELF_DIR 恒为 null、又回老 bug）
  assert.ok(
    code.includes("selfDirFromModuleUrl(import.meta.url)"),
    "产物缺少 import.meta.url 锚点（Babel 未保留 import.meta，脚本路径会退回 cwd 拼法）",
  );
  assert.ok(code.includes("resolveRuntimeScript({"), "产物未调用 resolveRuntimeScript（解析逻辑没接线）");
  assert.ok(code.includes('from "./lib/runtime-diagnostics.js"'), "产物缺少 runtime-diagnostics 相对导入");
  // ② 旧根因形态不得复活：直接拿 cwd 拼 dist/runtime/voice-runtime.js 当唯一口径
  assert.ok(!/resolve\(process\.cwd\(\),\s*\.\.\.RUNTIME_SCRIPT\)/.test(code), "产物仍残留 cwd 相对拼路径");
  // ③ 诊断埋点与失败闸门：来源/存在性/候选 + 不存在时先报错（不 spawn 必死进程）
  //    marker 用英文 `runtime script not found`（2026-10-30 第二十二批起诊断/闸门日志统一英文，
  //    与 TUI 用户文案解耦：日志关键字不随 uiLanguage 变）
  for (const marker of ["scriptSource=", "scriptExists=", "selfDir=", "candidates=", "runtime script not found"]) {
    assert.ok(code.includes(marker), `startRuntime 诊断/闸门缺少 ${marker}`);
  }
});

test("stderr 关键行进 toast、全量尾部进日志（修「只显 Node.js 版本号」）", () => {
  const code = tuiCode();
  assert.ok(
    code.includes("summarizeRuntimeFailure("),
    "toast 未走 summarizeRuntimeFailure（error 事件 message / stderr 尾部原因会丢）",
  );
  assert.ok(code.includes("lastErrorMessage"), "未接线 NDJSON error 事件 message（真实原因优先级不够）");
  assert.ok(code.includes("runtime exited: reason="), "缺少退出日志（全量 stderr 尾部无处可查）");
  assert.ok(code.includes("stderrForLog()"), "退出/失败日志未带 stderr 全量尾部");
  assert.ok(!code.includes("lastStderr"), "旧的「只存末行」状态应已清除");
});

test("onDispose 停本窗口会话播放（stopRuntime 之外遍历 touchedSessions 逐会话停，修退出孤儿）", () => {
  const src = tuiSource();
  const at = src.indexOf("api.lifecycle.onDispose");
  assert.ok(at > 0, "缺少 onDispose 注册");
  // 回调体（到下一个同级结构前的窗口）：既有 stopRuntime 保留 + 新增逐会话停播
  const block = src.slice(at, at + 700);
  assert.ok(block.includes("stopRuntime()"), "onDispose 丢了既有 stopRuntime()（语音输入子进程会孤儿）");
  assert.ok(
    block.includes("stopPlaybackForSessions(touchedSessions)"),
    "onDispose 未遍历本窗口 touchedSessions 停播（TTS CLI worker + PowerShell 孙进程退出后继续播的根因）",
  );
});

test("半双工静音门接在 dispatch 最前（丢弃路径不 toast/不注入/不 appendPrompt，归属只复用 helper）", () => {
  const code = tuiCode();
  const at = code.indexOf("const dispatch = async");
  assert.ok(at > 0, "找不到 RuntimeFinal 分发入口 dispatch");
  const head = code.slice(at, at + 4000);
  // ① 归属口径**复用** helper，不另造：读的是 isInterruptablePlaybackActive，门条件走纯函数
  assert.ok(head.includes("isInterruptablePlaybackActive("), "静音门未复用会话归属判活 helper（另造口径风险）");
  assert.ok(head.includes("shouldDropAsrFinal("), "静音门纯函数未接线");
  assert.ok(head.includes("PLAYBACK_OWNERLESS_KEY"), "无会话路由时未退化为「只算无主」口径");
  assert.ok(head.includes("asr gate drop:"), "缺少丢弃日志（吞掉用户话却无从取证）");
  // ② 门必须在消费正文之前（composeBody 之后就已进入注入/追加分支）
  assert.ok(
    head.indexOf("shouldDropAsrFinal(") < head.indexOf("composeBody(result)"),
    "静音门判定晚于正文组合，final 可能已被消费",
  );
  // 静音门必须早于宽限/模式决策（播放期间说话先被门拦下，不走宽限投递）
  const gateInvoke = head.indexOf("shouldDropAsrFinal(");
  const decisionInvoke = head.indexOf("resolveFinalDelivery(");
  assert.ok(gateInvoke >= 0 && decisionInvoke > gateInvoke, "静音门未接在 resolveFinalDelivery 之前");
  // ③ 丢弃分支体内不得有任何可见反馈或消费动作
  const gateAt = head.indexOf("shouldDropAsrFinal(");
  const dropBlock = head.slice(gateAt, head.indexOf("return", gateAt));
  for (const banned of ["toast(", "appendPrompt", "session.prompt"]) {
    assert.ok(!dropBlock.includes(banned), `丢弃分支不应出现 ${banned}（静音门只丢不播报）`);
  }
  // ④ 尾音窗口起点是本 TUI 进程内闭包变量，活跃时刷新为当刻（不缓存 playback 状态）
  assert.ok(code.includes("lastInterruptableActiveAt"), "缺少尾音窗口起点状态");
  assert.ok(
    head.includes("if (playbackActive) lastInterruptableActiveAt = gateNow"),
    "判活为真时未刷新尾音窗口起点（连续播放会把尾巴截早）",
  );
  assert.ok(!code.includes("readPlayback("), "静音门不得直接读 playback 状态文件（须走 helper 归属门）");
  // ⑤ 相对导入接线（tsc 产物在 dist/voice/asr-gate.js）
  assert.ok(code.includes('from "./voice/asr-gate.js"'), "产物缺少 asr-gate 相对导入");
});

test("两处中断出口都写会话级中断请求水位（F10 双态中断 + F8/F9 barge-in；写在停播之前、不碰开关文件）", () => {
  const code = tuiCode();
  // 相对导入接线（tsc 产物在 dist/voice/auto-tts.js；TUI 与 server 两进程靠文件同步，无共享内存）
  assert.ok(
    code.includes('writeInterruptRequest } from "./voice/auto-tts.js"'),
    "产物缺少 writeInterruptRequest 导入（跨进程中断水位整条链会消失）",
  );
  // 接线点数量钉死=2：F10 中断分支 + toggleMode barge-in（F10「关闭」分支只写开关文件，不进水位）
  assert.equal((code.match(/writeInterruptRequest\(/g) ?? []).length, 2, "中断水位写入点必须恰好两处");

  // ① F10 双态中断分支：无论 stopPlayback 是否杀中都写（补「单元间隙杀空」与「杀后重生」缺口）
  const f10At = code.indexOf("if (isInterruptablePlaybackActive(sessionID)) {");
  assert.ok(f10At > 0, "找不到 F10 双态中断分支");
  const f10Block = code.slice(f10At, code.indexOf("api.state.session.get", f10At));
  assert.ok(
    f10Block.includes("writeInterruptRequest(sessionID)"),
    "F10 中断分支未写会话级中断请求（剩余文本继续播的根因未被拦）",
  );
  assert.ok(
    f10Block.indexOf("writeInterruptRequest(sessionID)") < f10Block.indexOf("stopPlayback({"),
    "水位必须写在 stopPlayback 之前（停播抛异常时中断意图也已落盘）",
  );
  assert.ok(!f10Block.includes("writeAutoTts("), "F10 中断分支不得写开关文件（双态语义：只停声、不拨开关）");
  assert.ok(
    /f10 interrupt:[^\n]*interruptReq=\$\{interruptReq\}[^\n]*toggled=false/.test(f10Block),
    "F10 中断埋点缺少 interruptReq=（水位是否落盘无从取证）",
  );

  // ② F8/F9 barge-in：有会话路由才写（取不到会话则不写，保持「无主」语义）
  const modeAt = code.indexOf("const interruptSession = currentSessionID(api);");
  assert.ok(modeAt > 0, "找不到 F8/F9 barge-in 入口");
  const modeBlock = code.slice(modeAt, code.indexOf("f8f9 interrupt: stopped=", modeAt));
  assert.ok(
    /if \(interruptSession\) writeInterruptRequest\(interruptSession\);/.test(modeBlock),
    "F8/F9 barge-in 未写水位，或未做「取不到会话则不写」门",
  );
  assert.ok(
    modeBlock.indexOf("writeInterruptRequest") < modeBlock.indexOf("stopPlayback({"),
    "F8/F9 水位必须写在 stopPlayback 之前",
  );
});

test("停止后 final 宽限投递接线（2026-10-24）：关闭先记录、dispatch 走统一决策、丢弃必有日志", () => {
  const code = tuiCode();
  // ① 决策纯函数已接线（宽限常量/口径在 asr-gate.ts，单测见 test/asr-gate.test.js）
  assert.ok(code.includes("resolveFinalDelivery("), "dispatch 未接 resolveFinalDelivery（停止后的 final 仍会被静默丢）");
  // 类型导入会被 Babel 擦除，故只断言**运行时代码**：决策调用必须真的收到最近关闭记录
  assert.ok(code.includes("lastClosed: lastClosedMode"), "dispatch 未把最近关闭记录传给 resolveFinalDelivery");

  // ② 关闭时**先记录再停 runtime**：否则优雅停止期间冲刷出的 final 看不到记录
  const recordAt = code.indexOf("lastClosedMode = {");
  assert.ok(recordAt > 0, "关闭分支未记录 lastClosedMode");
  const stopAt = code.indexOf("await stopRuntime()", recordAt);
  assert.ok(stopAt > recordAt, "必须先记录再 stopRuntime（冲刷 final 在 stopRuntime 内到达）");
  const recordBlock = code.slice(recordAt, stopAt);
  for (const key of ["mode: target", "sessionID: currentSessionID(api)", "at: Date.now()"]) {
    assert.ok(recordBlock.includes(key), `关闭记录缺少 ${key}`);
  }

  // ③ 决策在正文组合/消费之前；投递分支按 decision.mode，不再直接用当前开关
  const decisionAt = code.indexOf("resolveFinalDelivery(");
  const dispatchBlock = code.slice(decisionAt, decisionAt + 3000);
  assert.ok(
    decisionAt < code.indexOf("composeBody(result)", decisionAt),
    "分发决策晚于正文组合（丢弃路径应先判、不做无用功）",
  );
  assert.ok(dispatchBlock.includes('decision.mode === "inject"'), "注入分支未按决策模式执行");
  const afterDecision = dispatchBlock.slice(dispatchBlock.indexOf("if (!decision.delivered)"));
  assert.ok(!/if \(injectOn\(\)\)/.test(afterDecision), "决策之后不得再按当前 injectOn() 分叉");
  assert.ok(!/if \(inputOn\(\)\)/.test(afterDecision), "决策之后不得再按当前 inputOn() 分叉");
  assert.ok(dispatchBlock.includes("const sessionID = gateSessionID"), "宽限注入须沿用 final 归属会话（同一个 sessionID）");
  // 停止进行中必须把 stopping 传进决策（慢回包不受 3s 截断）；Babel 可能输出简写 `stopping`
  const decisionCall = dispatchBlock.slice(0, dispatchBlock.indexOf("});") + 3);
  assert.ok(/\bstopping\b/.test(decisionCall), "dispatch 未把 stopping 传给 resolveFinalDelivery");

  // ④ 丢弃日志含 session / 模式 / ageMs / 文本预览（与静音门同为 20 字）
  const dropAt = code.indexOf("asr final drop:");
  assert.ok(dropAt > 0, "缺少 final 丢弃日志（静默丢弃无法取证）");
  const dropLine = code.slice(dropAt, code.indexOf("\n", dropAt));
  for (const key of ["reason=", "session=", "mode=", "ageMs=", "text=", "ASR_GATE_PREVIEW_LEN"]) {
    assert.ok(dropLine.includes(key), `丢弃日志缺少 ${key}`);
  }
  assert.ok(code.includes("const ASR_GATE_PREVIEW_LEN = 20;"), "丢弃日志预览长度须与静音门一致（20 字）");
});
