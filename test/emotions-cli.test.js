/**
 * 语音 CLI / 情绪指令 / i18n / 槽位指示 的离线单测（不触发真实播放、网络或设备枚举）。
 *
 * 覆盖：emotion→instruction 映射与别名、resolveTtsConfig 的情绪/provider 覆盖、
 * 语言解析与词表选择、槽位单词条形态、CLI 参数解析（含 --text-file；auto_tts 已移除）、
 * config 的 uiLanguage/toolLanguage 字段。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileP = promisify(execFile);

import {
  EMOTION_INSTRUCTIONS,
  normalizeEmotion,
  resolveEmotionInstruction,
} from "../dist/voice/tts/emotion.js";
import { resolveTtsConfig } from "../dist/voice/tts/types.js";
import { DEFAULT_LANGUAGE, LANGUAGES, format, getPhrases, resolveLanguage } from "../dist/lib/i18n.js";
import {
  AUTO_READ_KEY,
  INJECT_KEY,
  INPUT_KEY,
  METER_IDLE_GLYPH,
  METER_LEVEL_FRAMES,
  METER_SPINNER_FRAMES,
  MIC_ICON,
  displayWidth,
  formatSlotIndicator,
  formatSlotSegments,
  meterGlyph,
} from "../dist/voice/slot.js";
import { LEVEL_EVENT_INTERVAL_MS, LEVEL_FULL_SCALE_RMS, rmsToLevel } from "../dist/voice/meter.js";
import { PLAY_COMMAND, parseCliArgs } from "../dist/voice/cli.js";
import { registerPlaybackLifecycle } from "../dist/cli/emotions-cli.js";
import {
  clearPlayback,
  PLAYBACK_OWNERLESS_KEY,
  PLAYBACK_SESSION_ENV,
  readPlayback,
} from "../dist/voice/playback-state.js";
import {
  CONFIG_FILE_NAME,
  DEFAULT_VOICE_CONFIG,
  ENV_LANGUAGE,
  ENV_TOOL_LANGUAGE,
  ENV_UI_LANGUAGE,
  loadVoiceConfig,
} from "../dist/voice/config.js";

test("emotion：规范情绪与别名映射为 CosyVoice 风格指令", () => {
  assert.equal(resolveEmotionInstruction("happy"), "用开心的语气说");
  assert.equal(resolveEmotionInstruction(" HAPPY "), "用开心的语气说", "大小写/空白不敏感");
  assert.equal(resolveEmotionInstruction("great"), resolveEmotionInstruction("happy"), "族名 great → happy");
  assert.equal(resolveEmotionInstruction("anger"), resolveEmotionInstruction("angry"), "族名 anger → angry");
  assert.equal(resolveEmotionInstruction("confusion"), resolveEmotionInstruction("confused"), "族名 confusion → confused");
  assert.equal(resolveEmotionInstruction("sigh"), resolveEmotionInstruction("speechless"), "别名 sigh → speechless");
  assert.equal(resolveEmotionInstruction("neutral"), "", "neutral 不加指令");
  assert.equal(resolveEmotionInstruction(""), "");
  assert.equal(resolveEmotionInstruction(undefined), "");
  assert.equal(resolveEmotionInstruction("bogus"), "", "未知情绪不加指令（不报错）");

  assert.equal(normalizeEmotion("great"), "happy");
  assert.equal(normalizeEmotion("Neutral"), "neutral");
  assert.equal(normalizeEmotion("nope"), undefined);
  assert.equal(normalizeEmotion(undefined), undefined);
  assert.equal(EMOTION_INSTRUCTIONS.neutral, "", "neutral 显式映射为空指令");
  assert.equal(EMOTION_INSTRUCTIONS.speechless.length > 0, true);
});

test("resolveTtsConfig：--emotion 覆盖 instruction，neutral/缺省回退配置", () => {
  assert.equal(resolveTtsConfig({ text: "hi", emotion: "happy" }, { TTS_INSTRUCTION: "用四川话" }).instruction, "用开心的语气说");
  assert.equal(resolveTtsConfig({ text: "hi" }, { TTS_INSTRUCTION: "用四川话" }).instruction, "用四川话");
  assert.equal(
    resolveTtsConfig({ text: "hi", emotion: "neutral" }, { TTS_INSTRUCTION: "用四川话" }).instruction,
    "用四川话",
    "neutral 回退到配置指令",
  );
  assert.equal(resolveTtsConfig({ text: "hi", emotion: "sad" }, {}, { instruction: "x" }).instruction, "用悲伤的语气说");
});

test("resolveTtsConfig：provider 参数优先于环境变量与文件", () => {
  assert.equal(resolveTtsConfig({ text: "hi", provider: "Aliyun" }, { TTS_PROVIDER: "sapi" }).provider, "aliyun");
  assert.equal(resolveTtsConfig({ text: "hi" }, { TTS_PROVIDER: "aliyun" }).provider, "aliyun");
});

test("i18n：语言解析与归一化", () => {
  assert.equal(DEFAULT_LANGUAGE, "en");
  assert.deepEqual([...LANGUAGES], ["zh", "en"]);
  assert.equal(resolveLanguage("en"), "en");
  assert.equal(resolveLanguage("EN"), "en");
  assert.equal(resolveLanguage("zh-CN"), "zh", "区域码归一化");
  assert.equal(resolveLanguage(" zh_Hans "), "zh");
  assert.equal(resolveLanguage("fr"), "en", "不支持的语言回退默认 en");
  assert.equal(resolveLanguage(undefined), "en");
  assert.equal(resolveLanguage(""), "en");
});

test("i18n：中英文案不同且插值可用", () => {
  const zh = getPhrases("zh");
  const en = getPhrases("en");
  assert.notEqual(zh.tool.description, en.tool.description);
  // 槽位模式文案（slot.modeInject/modeInput）已随「删除模式描述段」整体移除，此处改比对模式完整名（仍锁「中英不同」）
  assert.notEqual(zh.label.inject, en.label.inject);
  assert.notEqual(zh.cli.help, en.cli.help);
  assert.equal(format(zh.toast.injected, { text: "abc" }), "已注入：abc");
  assert.equal(format(en.toast.modeOn, { label: "Voice inject" }), "Voice inject enabled (listening)");
  assert.equal(format("no {x} here", {}), "no {x} here", "缺失变量保留原样");
  // 空文本跳过文案（CLI speak 入口空文本分支，中英齐备且互不相同）
  assert.notEqual(zh.cli.speakSkipped, en.cli.speakSkipped);
  assert.match(zh.cli.speakSkipped, /空/);
  assert.match(en.cli.speakSkipped, /empty/i);
  // follow 不支持文案（中英齐备、带 {provider} 占位符）
  assert.notEqual(zh.cli.followUnsupported, en.cli.followUnsupported);
  assert.match(format(zh.cli.followUnsupported, { provider: "aliyun" }), /aliyun/);
  assert.match(format(en.cli.followUnsupported, { provider: "aliyun" }), /aliyun/);
  // help 提及 --follow 用法（中英）
  assert.match(zh.cli.help, /--follow/);
  assert.match(en.cli.help, /--follow/);
});

test("i18n：auto_tts 已从模型可见面移除（工具描述/参数/帮助均不含），F10 命令与 toast 文案齐备", () => {
  for (const lang of LANGUAGES) {
    const { tool, cli, command, toast } = getPhrases(lang);
    // 模型不能再看到 auto_tts（开关独占于 F10 热键）
    assert.doesNotMatch(tool.description, /auto_tts/);
    assert.doesNotMatch(tool.args, /auto_tts/);
    assert.doesNotMatch(cli.help, /auto_tts/);
    // CLI 帮助仍指向新入口名（而非旧 voice-cli）
    assert.match(cli.help, /emotions-cli/);
    assert.doesNotMatch(cli.help, /^Usage: voice-cli/m);
    // F10 命令标题带 {key} 占位符、说明与开关 toast 文案非空
    assert.match(command.autoTtsTitle, /\{key\}/);
    assert.ok(command.autoTtsDesc.length > 0, `${lang}: autoTtsDesc 非空`);
    assert.ok(toast.autoReadOn.length > 0 && toast.autoReadOff.length > 0 && toast.autoReadFailed.length > 0, `${lang}: 自动朗读 toast 文案齐备`);
    assert.ok(toast.autoReadChildSession.length > 0, `${lang}: 子会话不自动朗读 toast 文案非空`);
  }
});

/** meter 段（盲文音量列）状态构造器：三态 + 电平 + 帧索引（缺省 0），供下面各槽位用例复用。 */
const meterState = (phase, level = 0, frame = 0) => ({ phase, level, frame });

test("slot：单个指示符形态（🎙 恒静态 + 1 列盲文音量列 + 图标贴键成组 ↧F8/⤉F9 + 末端 F10 喇叭段；无模式文字段）", () => {
  const zh = getPhrases("zh");
  const en = getPhrases("en");
  // 2026-10-21 用户指令（第十批）：删 ●/○/⏳ 圆圈段，改为「图标紧贴键位成组」。
  // 同日（第十一批）：恢复 🎙 麦克风段于最前；输入组图标 ⇥(U+21E5)→↧(U+21A7)（⇥ 与 F8 重叠；↧ 仍窄计 1 列）。
  // 2026-10-22（第十三批，推翻第十二批/第八批的 emoji 帧轮播）：`🎙 ` **恒静态**，其后恒 1 列**盲文音量列**；
  // 三态各取一个字形：idle→空白、connecting→spinner 首帧 ⠋、listening→电平档（0→⠁、满→⠿）。
  assert.equal(formatSlotIndicator(zh, { mode: "inject", meter: meterState("idle") }), "🎙  ↧F8/⤉F9 🔊 F10");
  assert.equal(formatSlotIndicator(zh, { mode: "input", meter: meterState("connecting") }), "🎙 ⠋↧F8/⤉F9 🔊 F10");
  assert.equal(formatSlotIndicator(zh, { mode: "input", meter: meterState("listening", 1) }), "🎙 ⠿↧F8/⤉F9 🔊 F10");
  assert.equal(formatSlotIndicator(zh, { mode: "input", meter: meterState("listening", 0) }), "🎙 ⠁↧F8/⤉F9 🔊 F10");
  assert.equal(formatSlotIndicator(en, { mode: "input", meter: meterState("idle") }), "🎙  ↧F8/⤉F9 🔊 F10", "英文与中文同串（分段全为常量文本）");
  // mic 段与旧「共用格」的区别：mic 段文本永远不变（idle/connecting/listening 三态下第 1 段都是 `🎙 `）
  for (const phase of ["idle", "connecting", "listening"]) {
    assert.equal(formatSlotSegments(zh, { mode: "input", meter: meterState(phase), injectOn: false, inputOn: false, autoReadOn: false })[0].text, `${MIC_ICON} `, `${phase}：mic 段恒为 🎙（不做 emoji 动画）`);
  }
  // 键位语义沿用第八批对调（F8=输入、F9=注入）；显示仍按物理键序，图标 ↧ 配 F8、⤉ 配 F9
  assert.equal(INJECT_KEY, "f9");
  assert.equal(INPUT_KEY, "f8");
  assert.equal(AUTO_READ_KEY, "f10");
});

test("slot：显示宽度口径（与渲染库 string-width@7 一致）", () => {
  assert.equal(displayWidth("↧"), 1, "歧义宽度箭头（U+21A7，原 ⇥ U+21E5 的替换字形）按窄计");
  assert.equal(displayWidth("⤉"), 1, "歧义宽度箭头（U+21C9）按窄计");
  assert.equal(displayWidth("⏳"), 2, "emoji 计双列（⏳ 已从槽位移除，此断言锁住「emoji 双列」口径 = 弃用 emoji 的证据）");
  assert.equal(displayWidth("🔊"), 2, "emoji 计双列");
  assert.equal(displayWidth("🎙"), 2, "emoji 计双列（常驻麦克风图标）");
  assert.equal(displayWidth("🎙 "), 3, "🎙 段 = 图标 2 + 其后必留空格 1（防重叠）");
  // 第十三批 meter 列选型依据：盲文块（U+2800–U+28FF）EA=Neutral ⇒ **恒 1 列**、单色可着色、无字形差异
  assert.equal(displayWidth("⠿"), 1, "盲文电平条满档 ⠿（U+283F）按窄计 1 列");
  assert.equal(displayWidth("⠋"), 1, "盲文 spinner 首帧 ⠋（U+280B）按窄计 1 列");
  assert.equal(displayWidth(METER_IDLE_GLYPH), 1, "meter 关态空白也占 1 列（占位保宽）");
  assert.equal(displayWidth("↧F8"), 3, "输入组：图标 1 + F8 2");
  assert.equal(displayWidth("⤉F9"), 3, "注入组：图标 1 + F9 2");
  assert.equal(displayWidth("注入"), 4, "CJK 计双列");
  assert.equal(displayWidth("Inject"), 6, "ASCII 计单列");
  assert.equal(displayWidth("Input"), 5);
  assert.equal(displayWidth(" "), 1);
  // 2026-10-21 手机字形查证：VS15（U+FE0E 文本呈现选择符）在本口径下计 0 宽，
  // 因此「⏳+FE0E」仍算 2 列——补空格口径不会因它改变，故 VS15 无法修手机端宽度错位（详见 docs §15.4）。
  assert.equal(displayWidth("\uFE0E"), 0, "VS15 文本呈现选择符计 0 宽");
  assert.equal(displayWidth("\u23F3\uFE0E"), 2, "⏳+VS15 仍按 2 列（本插件口径不变）");
});

test("slot：任意 meter 三态 × 电平 × 帧索引 × 模式 × 语言，拼接总宽恒定（第十三批 meter 列 ⇒ 17 → 18）", () => {
  const phases = ["idle", "connecting", "listening"];
  const modes = ["inject", "input"];
  // 覆盖**越界与非法**：level > 1 / 负 / NaN / +Infinity；frame 超界 / 负数 / NaN ⇒ 都不许改变宽度（也不许抛）
  const levels = [0, 0.001, 0.16, 0.5, 0.999, 1, 1.5, 6, -1, Number.NaN, Number.POSITIVE_INFINITY];
  const frames = [0, 1, 5, 9, 10, 23, -1, -10, Number.NaN];
  for (const lang of LANGUAGES) {
    const phrases = getPhrases(lang);
    const widths = new Set();
    for (const phase of phases) {
      for (const level of levels) {
        for (const frame of frames) {
          for (const mode of modes) {
            widths.add(displayWidth(formatSlotIndicator(phrases, { mode, meter: meterState(phase, level, frame) })));
          }
        }
      }
    }
    assert.equal(widths.size, 1, `${lang}：各状态拼接宽度应恒定，实得 ${[...widths]}`);
    assert.equal([...widths][0], 18, `${lang}：恒定总宽必须 = 18`);
  }
  // 末端 F10 段为固定串（前置空格 + 🔊 + 空格 + F10 = 7 列），不随状态变 ⇒ 总宽恒定不被破坏
  assert.equal(displayWidth(" 🔊 F10"), 7, "追加段固定 7 列");
  // 宽度口径（第十三批）：3（`🎙 ` 恒静态 = emoji 2 + 空格 1）+ 1（meter 盲文列）+ 3（↧F8）+ 1（/）+ 3（⤉F9）+ 7（🔊 F10）= 18
  assert.equal(displayWidth(formatSlotIndicator(getPhrases("zh"), { mode: "inject", meter: meterState("listening", 1) })), 18, "zh 总宽 = 18（第十三批新增 1 列 meter）");
  assert.equal(displayWidth(formatSlotIndicator(getPhrases("en"), { mode: "inject", meter: meterState("connecting", 0, 3) })), 18, "en 总宽 = 18（分段与语言无关）");
  // 分段文本与语言无关 ⇒ 中/英总宽相等
  assert.equal(
    displayWidth(formatSlotIndicator(getPhrases("zh"), { mode: "inject", meter: meterState("idle") })),
    displayWidth(formatSlotIndicator(getPhrases("en"), { mode: "inject", meter: meterState("idle") })),
    "总宽与语言无关",
  );
});

test("slot：分段配色角色（6 段：文本拼接与颜色分离；🎙 恒静态 + meter 盲文音量列 + 激活模式的「图标+键位」整组高亮=模式唯一表达、末端朗读段按开关亮/暗）", () => {
  const zh = getPhrases("zh");
  const on = formatSlotSegments(zh, { mode: "inject", meter: meterState("listening", 1), injectOn: true, inputOn: false, autoReadOn: false });
  assert.equal(on.length, 6, "分段数：🎙 + meter + ↧F8 + / + ⤉F9 + 🔊F10 共 6 段（第十三批新增 meter 列）");
  assert.equal(
    on.map((segment) => segment.text).join(""),
    "🎙 ⠿↧F8/⤉F9 🔊 F10",
    "分段拼接等于纯文本（在听·满电平：meter 列为 ⠿）",
  );
  assert.deepEqual(
    on.map((segment) => segment.role),
    ["mic", "meter", "keyInactive", "separator", "keyActive", "autoReadInactive"],
    "注入激活 → ⤉F9 整组（第 5 段）高亮、↧F8 整组（第 3 段）暗色、朗读关暗色；第 1 段角色恒 mic、第 2 段恒 meter",
  );
  // mic 段：文本与角色**恒不变**（第十三批起不做 emoji 动画，只作语音功能的静态标记）
  assert.equal(on[0].text, "🎙 ", "mic 段：恒 `🎙 `（emoji + 尾随空格，防重叠）");
  assert.equal(on[0].role, "mic", "mic 段：角色恒 `mic`（渲染层取中性色 accent，不随模式/朗读开关变）");
  assert.equal(on[1].role, "meter", "meter 列：角色恒 `meter`（渲染层按三态静态取色：在听 accent、连接中/关 textMuted）");
  // 显示顺序按物理键序恒定：第 3 段恒为 ↧F8、第 5 段恒为 ⤉F9
  assert.equal(on[2].text, "↧F8", "物理顺序：第 3 段恒为 ↧F8（图标贴键、无空格；2026-10-21 ⇥→↧）");
  assert.equal(on[4].text, "⤉F9", "物理顺序：第 5 段恒为 ⤉F9（图标贴键、无空格）");
  const off = formatSlotSegments(zh, { mode: "input", meter: meterState("idle"), injectOn: false, inputOn: false, autoReadOn: false });
  assert.equal(off.map((segment) => segment.text).join(""), "🎙  ↧F8/⤉F9 🔊 F10", "关态：meter 列为空白（mic 段仍显 🎙 ）");
  assert.deepEqual(
    off.map((segment) => segment.role),
    ["mic", "meter", "keyInactive", "separator", "keyInactive", "autoReadInactive"],
    "关闭态：两组都暗色、朗读段也暗色（第 1 段 mic、第 2 段 meter 角色不变）",
  );
  const connecting = formatSlotSegments(zh, { mode: "input", meter: meterState("connecting", 0, 1), injectOn: false, inputOn: true, autoReadOn: true });
  assert.deepEqual(
    connecting.map((s) => s.role),
    ["mic", "meter", "keyActive", "separator", "keyInactive", "autoReadActive"],
    "输入激活 → ↧F8 整组（第 3 段）高亮、⤉F9 暗色；连接中：meter 列为 spinner；朗读开启：末端段激活色（独立于模式开关）",
  );
  // 连接中：由盲文 spinner 表达「还在连、别急着说」（旧的 ⏳ 字形 / busy 角色已随第十三批删除）
  assert.equal(connecting[1].text, "⠙", "连接中：meter 取 spinner 第 1 帧 ⠙（帧索引驱动，宽度恒 1）");
});

test("slot：自动朗读末端段两态（文本恒定只换角色；任意状态下总宽恒定）", () => {
  const zh = getPhrases("zh");
  const base = { mode: "inject", meter: meterState("listening", 0.5), injectOn: true, inputOn: false };
  const segOn = formatSlotSegments(zh, { ...base, autoReadOn: true })[5];
  const segOff = formatSlotSegments(zh, { ...base, autoReadOn: false })[5];
  assert.equal(segOn.text, " 🔊 F10", "激活态指示串=追加段原样（前置空格分隔）");
  assert.equal(segOff.text, segOn.text, "开关不改文本（灰/亮仅换配色角色，宽度不受影响）");
  assert.equal(segOn.role, "autoReadActive", "自动朗读激活：亮色角色");
  assert.equal(segOff.role, "autoReadInactive", "未激活：暗色角色");
  // 宽度恒定：任意 meter 三态 × 电平 × 帧索引 × 模式 × 注入/输入开关 × 朗读开关，分段拼接总宽都等于定值
  // （第十三批：原「任意组合等宽」断言**没有放松**，只是把 mic 维度换成 meter 三态并加上电平/帧索引两维，定值 17 → 18）
  const widthOf = (state) => displayWidth(formatSlotSegments(zh, state).map((s) => s.text).join(""));
  const expected = widthOf({ mode: "inject", meter: meterState("idle"), injectOn: false, inputOn: false, autoReadOn: false });
  for (const phase of ["idle", "connecting", "listening"]) {
    for (const level of [0, 0.5, 1, 1.7]) {
      for (const frame of [0, 3, 10, -2]) {
        for (const mode of ["inject", "input"]) {
          for (const injectOn of [true, false]) {
            for (const inputOn of [true, false]) {
              for (const autoReadOn of [true, false]) {
                const state = { mode, meter: meterState(phase, level, frame), injectOn, inputOn, autoReadOn };
                const tag = `${phase}/${level}/${frame}/${mode}/inject=${injectOn}/input=${inputOn}/${autoReadOn}`;
                assert.equal(widthOf(state), expected, `宽度恒定：${tag}`);
                const segments = formatSlotSegments(zh, state);
                // 第 1 段（mic）在全组合下恒为 `🎙 ` / 角色 mic；第 2 段（meter）角色恒 meter、字形恒 1 列
                assert.equal(segments[0].text, "🎙 ", `mic 段恒静态：${tag}`);
                assert.equal(segments[0].role, "mic", `mic 段角色恒定：${tag}`);
                assert.equal(segments[1].role, "meter", `meter 段角色恒定：${tag}`);
                assert.equal(displayWidth(segments[1].text), 1, `meter 段字形恒 1 列：${tag} → ${segments[1].text}`);
              }
            }
          }
        }
      }
    }
  }
  assert.equal(expected, 18, "定值宽度 = 18（第十三批：🎙 恒静态 3 + meter 盲文列 1 + 其余常量段）");
});

test("meter：meterGlyph 三态取字 + 电平分档 / 帧取模边界（第十三批：动画只用盲文、不用 emoji）", () => {
  // idle：空白占位（仍占 1 列），忽略 level / frame
  for (const [level, frame] of [[0, 0], [1, 3], [-5, -1], [Number.NaN, Number.NaN]]) {
    assert.equal(meterGlyph({ phase: "idle", level, frame }), METER_IDLE_GLYPH, `idle：level=${level}/frame=${frame} 一律空白`);
    assert.equal(displayWidth(meterGlyph({ phase: "idle", level, frame })), 1, "idle 空白恒占 1 列");
  }
  // connecting：spinner 帧取模（含超界 / 负数 / 非有限，都不抛错）
  const spinCount = METER_SPINNER_FRAMES.length;
  assert.ok(spinCount >= 2, "spinner 帧集合至少两帧");
  for (const frame of [0, 1, spinCount - 1, spinCount, spinCount + 1, -1, -spinCount, Number.NaN]) {
    const expected = Number.isFinite(frame) ? ((Math.trunc(frame) % spinCount) + spinCount) % spinCount : 0;
    assert.equal(meterGlyph({ phase: "connecting", level: 0, frame }), METER_SPINNER_FRAMES[expected], `connecting：frame=${frame} → 取模第 ${expected} 帧`);
  }
  // listening：电平分档（0 → 第 0 档、1 → 最后一档），档位随电平单调不减；忽略 frame（电平驱动、不用定时器）
  const levelCount = METER_LEVEL_FRAMES.length;
  assert.equal(meterGlyph({ phase: "listening", level: 0, frame: 0 }), METER_LEVEL_FRAMES[0], "listening：level=0 → 第 0 档");
  assert.equal(meterGlyph({ phase: "listening", level: 1, frame: 0 }), METER_LEVEL_FRAMES[levelCount - 1], "listening：level=1 → 最后一档");
  assert.equal(meterGlyph({ phase: "listening", level: 1, frame: 7 }), METER_LEVEL_FRAMES[levelCount - 1], "listening：忽略 frame");
  const idxOf = (level) => METER_LEVEL_FRAMES.indexOf(meterGlyph({ phase: "listening", level, frame: 0 }));
  assert.ok(idxOf(0.2) <= idxOf(0.4) && idxOf(0.4) <= idxOf(0.8), "listening：电平越大档位越高（单调不减）");
  // 越界 / 非法电平：>1 归最后一档；负 / NaN / Infinity 归第 0 档
  assert.equal(meterGlyph({ phase: "listening", level: 2.5, frame: 0 }), METER_LEVEL_FRAMES[levelCount - 1], "level 超界 clamp 到最后一档");
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(meterGlyph({ phase: "listening", level: bad, frame: 0 }), METER_LEVEL_FRAMES[0], `非法电平 ${bad} → 第 0 档`);
  }
});

test("meter：全部可能字形（spinner 每帧 / level 每档 / idle 空白）displayWidth 恒为 1，且槽位第 2 段只取这些字形", () => {
  const zh = getPhrases("zh");
  const glyphs = [METER_IDLE_GLYPH, ...METER_SPINNER_FRAMES, ...METER_LEVEL_FRAMES];
  for (const glyph of glyphs) {
    assert.equal(displayWidth(glyph), 1, `meter 字形 ${JSON.stringify(glyph)} 必须恒 1 列（盲文 EA=Neutral / 空白）`);
  }
  // 接线检查：formatSlotSegments 的 meter 段永远取集合内某个字形 ⇒ 恒 1 列、总宽不受换字影响
  for (const phase of ["idle", "connecting", "listening"]) {
    for (const level of [0, 0.35, 1]) {
      for (const frame of [0, 4, 9]) {
        const seg = formatSlotSegments(zh, { mode: "input", meter: meterState(phase, level, frame), injectOn: false, inputOn: false, autoReadOn: false })[1];
        assert.equal(glyphs.includes(seg.text), true, `meter 段字形取自集合：${phase}/${level}/${frame} → ${seg.text}`);
        assert.equal(displayWidth(seg.text), 1, `meter 段恒 1 列：${phase}/${level}/${frame}`);
      }
    }
  }
});

test("rmsToLevel：0 / 负 / NaN / Infinity / 超界 clamp 与单调性（第十三批：电平归一化纯函数）", () => {
  assert.equal(LEVEL_FULL_SCALE_RMS > 0, true, "满量程 RMS 为正数");
  assert.equal(LEVEL_EVENT_INTERVAL_MS, 100, "level 事件节流间隔 = 100ms（10Hz）");
  assert.equal(rmsToLevel(0), 0);
  assert.equal(rmsToLevel(-0.5), 0, "负 RMS → 0");
  assert.equal(rmsToLevel(Number.NaN), 0, "NaN → 0");
  assert.equal(rmsToLevel(Number.POSITIVE_INFINITY), 0, "Infinity 非有限 → 0（采集异常不许让音量列乱跳）");
  assert.equal(rmsToLevel(LEVEL_FULL_SCALE_RMS), 1, "满量程 → 1");
  assert.equal(rmsToLevel(LEVEL_FULL_SCALE_RMS * 3), 1, "超界 clamp 到 1");
  assert.equal(rmsToLevel(LEVEL_FULL_SCALE_RMS / 2), 0.5, "线性映射");
  // 恒在 [0,1] 且单调不减
  let prev = -1;
  for (const rms of [0, 0.005, 0.01, 0.02, 0.04, 0.06, 0.08, 0.12, 0.5, 1]) {
    const level = rmsToLevel(rms);
    assert.ok(level >= 0 && level <= 1, `level 越界：rms=${rms} → ${level}`);
    assert.ok(level >= prev, `非单调：rms=${rms} → ${level} < 前值 ${prev}`);
    prev = level;
  }
  // 端到端口径一致：满量程 RMS 渲染成电平条最高档
  assert.equal(
    meterGlyph({ phase: "listening", level: rmsToLevel(LEVEL_FULL_SCALE_RMS), frame: 0 }),
    METER_LEVEL_FRAMES[METER_LEVEL_FRAMES.length - 1],
    "rmsToLevel → meterGlyph 口径贯通",
  );
});

test("CLI 解析：speak 选项、别名、= 写法与各类子命令", () => {
  assert.deepEqual(parseCliArgs(["speak", "--text", "你好", "--emotion", "happy"]), {
    kind: "speak",
    text: "你好",
    emotion: "happy",
    background: false,
    follow: false,
  });

  const full = parseCliArgs(["speak", "-t", "hi", "-e", "sad", "-v", "v1", "-r", "-4", "-p", "aliyun", "--background"]);
  assert.equal(full.kind, "speak");
  assert.equal(full.text, "hi");
  assert.equal(full.emotion, "sad");
  assert.equal(full.voice, "v1");
  assert.equal(full.rate, -4);
  assert.equal(full.provider, "aliyun");
  assert.equal(full.background, true);
  assert.equal(full.follow, false);

  assert.equal(parseCliArgs(["speak", "--text=你好"]).text, "你好", "支持 --flag=value");
  assert.equal(parseCliArgs(["speak", "--text=x", "--rate", "2.5"]).rate, 2.5);

  assert.deepEqual(parseCliArgs(["devices"]), { kind: "devices" });
  assert.deepEqual(parseCliArgs(["status"]), { kind: "status" });
  assert.deepEqual(parseCliArgs(["help"]), { kind: "help" });
  assert.deepEqual(parseCliArgs([]), { kind: "help" });
  assert.deepEqual(parseCliArgs(["-h"]), { kind: "help" });
  assert.deepEqual(parseCliArgs(["--help"]), { kind: "help" });
  assert.deepEqual(parseCliArgs([PLAY_COMMAND]), { kind: "play" });

  // 容错：未知选项忽略、未知命令/缺文本/非法数字报错
  assert.equal(parseCliArgs(["speak", "--text", "x", "--unknown", "1"]).kind, "speak");
  assert.equal(parseCliArgs(["speak"]).kind, "error");
  assert.equal(parseCliArgs(["speak", "--text", "x", "--rate", "abc"]).kind, "error");
  assert.equal(parseCliArgs(["bogus"]).kind, "error");
});

test("CLI 解析：--follow 常驻模式（单独可用；与 --text/--text-file/--background 互斥）", () => {
  const follow = parseCliArgs(["speak", "--follow"]);
  assert.equal(follow.kind, "speak");
  assert.equal(follow.follow, true);
  assert.equal(follow.text, "", "正文走 stdin，text 恒空");
  assert.equal(follow.background, false);

  // 带 provider/voice/rate/emotion 透传（provider 走 TTS_PROVIDER 解析链，CLI 参数可覆盖）
  const withOpts = parseCliArgs(["speak", "--follow", "--provider", "sapi", "--rate", "2", "--emotion", "happy"]);
  assert.equal(withOpts.follow, true);
  assert.equal(withOpts.provider, "sapi");
  assert.equal(withOpts.rate, 2);
  assert.equal(withOpts.emotion, "happy");

  // 互斥
  const withText = parseCliArgs(["speak", "--follow", "--text", "hi"]);
  assert.equal(withText.kind, "error");
  assert.match(withText.message, /--follow 与 --text 互斥/);
  const withFile = parseCliArgs(["speak", "--follow", "--text-file", "a.txt"]);
  assert.equal(withFile.kind, "error");
  assert.match(withFile.message, /--follow 与 --text-file 互斥/);
  const withBg = parseCliArgs(["speak", "--follow", "--background"]);
  assert.equal(withBg.kind, "error");
  assert.match(withBg.message, /--follow 与 --background 互斥/);
});

test("CLI 解析：--text-file 作为正文来源（可无 --text）", () => {
  const fromFile = parseCliArgs(["speak", "--text-file", "/tmp/a.txt", "--background"]);
  assert.equal(fromFile.kind, "speak");
  assert.equal(fromFile.text, "", "未给 --text 时 text 为空串");
  assert.equal(fromFile.textFile, "/tmp/a.txt");
  assert.equal(fromFile.background, true);

  const both = parseCliArgs(["speak", "--text", "hi", "--text-file=a.txt"]);
  assert.equal(both.text, "hi");
  assert.equal(both.textFile, "a.txt", "支持 --text-file=value");
});

test("CLI 解析：auto_tts 子命令已移除（视为未知命令报错，无任何旁路）", () => {
  // 任意参数组合都不再产出 autoTts 命令，统一落入未知命令分支
  for (const arg of ["on", "off", "status", "bogus"]) {
    assert.equal(parseCliArgs(["auto_tts", arg]).kind, "error", `auto_tts ${arg} 不再被识别`);
  }
  assert.equal(parseCliArgs(["auto_tts"]).kind, "error", "裸 auto_tts 也报错");
  const result = parseCliArgs(["auto_tts", "on"]);
  assert.equal(result.kind, "error");
  // 报错信息里的「可用命令」清单不再包含 auto_tts
  assert.match(result.message, /未知命令：auto_tts/);
  assert.match(result.message, /可用：speak \/ devices \/ status \/ help/);
});

/**
 * 入口保护回归：CLI 产物虽在子目录（不被自动加载），仍保留入口保护以防日后误置顶层。
 * 若模块顶层无条件执行 main()，被 import 时会以空参数跑一次 CLI 并打印 help。
 * 断言方式：子进程 import 产物，要求 stdout/stderr 全空（同进程 import 难以隔离输出）。
 */
test("emotions-cli 入口保护：被 import 时不执行 main、不打印任何内容", async () => {
  const cliUrl = new URL("../dist/cli/emotions-cli.js", import.meta.url).href;
  const script =
    `const m = await import(${JSON.stringify(cliUrl)});` +
    `if (typeof m.main !== "function" || typeof m.isDirectEntry !== "function") throw new Error("main/isDirectEntry 未导出");`;
  const { stdout, stderr } = await execFileP(process.execPath, ["--input-type=module", "-e", script]);
  assert.equal(stdout, "", "import 不应产生 stdout（回归：曾在插件加载时打印 help）");
  assert.equal(stderr, "", "import 不应产生 stderr");
});

test("CLI speak：--text-file 为空白 → 直接跳过（exit 0、不报错、不触发 provider）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cli-empty-"));
  const file = join(dir, "empty.txt");
  writeFileSync(file, " \n", "utf8");
  try {
    const cliPath = fileURLToPath(new URL("../dist/cli/emotions-cli.js", import.meta.url));
    // 回归（用户实测）：空白 --text-file 曾走到 provider → sapi 抛「text 不能为空」→ exit 1 + Speech failed。
    // 修复后：resolve 后空文本直接跳过（exit 0，stdout 为跳过文案，stderr 无 Speech failed）。
    const { stdout } = await execFileP(process.execPath, [cliPath, "speak", "--text-file", file], { windowsHide: true });
    assert.match(stdout, /朗读跳过|Skipped speaking/, "输出跳过文案（随 toolLanguage）");
    assert.doesNotMatch(stdout, /已开始朗读|Started speaking/, "不进入朗读");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI speak --follow：provider 不支持 follow → i18n 报错 exit 1（aliyun/mimo）", async () => {
  const cliPath = fileURLToPath(new URL("../dist/cli/emotions-cli.js", import.meta.url));
  for (const provider of ["aliyun", "mimo"]) {
    let error;
    try {
      await execFileP(process.execPath, [cliPath, "speak", "--follow", "--provider", provider], {
        windowsHide: true,
        // stdin 立即 EOF：即便能力位检查意外放行也不会挂等（正常应先报错退出）
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      error = err;
    }
    assert.ok(error, `${provider}: 应 exit 非 0`);
    assert.equal(error.code, 1, `${provider}: exit 1`);
    assert.match(
      error.stderr,
      /does not support --follow|不支持 --follow/,
      `${provider}: stderr 为 i18n 的 follow 不支持文案（随 toolLanguage）`,
    );
    assert.doesNotMatch(error.stdout ?? "", /Started speaking|已开始朗读/, "不进入朗读");
  }
});

test("CLI 登记：env EMOTIONS_SESSION_ID → tts-playback 条目带 sessionID；缺省/空白为无主", () => {
  const dir = mkdtempSync(join(tmpdir(), "cli-playback-"));
  const prev = process.env[PLAYBACK_SESSION_ENV];
  try {
    // 场景 1：auto-read 派生 CLI 时注入的 env（带空白，登记时 trim）→ 多条目 map 键=会话 ID
    process.env[PLAYBACK_SESSION_ENV] = " ses_env_1 ";
    registerPlaybackLifecycle({ provider: "sapi" }, { dataDir: dir });
    let entry = readPlayback("ses_env_1", { dataDir: dir });
    assert.equal(entry.sessionID, "ses_env_1", "env 值 trim 后写入条目（会话归属）");
    assert.equal(entry.pid, process.pid);
    assert.equal(entry.provider, "sapi");
    assert.equal(entry.kind, "speak");
    clearPlayback(process.pid, { dataDir: dir });

    // 场景 2：env 为纯空白 → 视为未设置（无主：落哨兵键 `_`，任何消息可打断）
    process.env[PLAYBACK_SESSION_ENV] = "   ";
    registerPlaybackLifecycle({ provider: "sapi" }, { dataDir: dir });
    entry = readPlayback(PLAYBACK_OWNERLESS_KEY, { dataDir: dir });
    assert.equal(entry.sessionID, undefined);
    assert.equal("sessionID" in entry, false, "空白 env 不写键 → 无主条目");
    clearPlayback(process.pid, { dataDir: dir });

    // 场景 3：未设置（手动 speak/工具路径）→ 无主，与旧格式同口径
    delete process.env[PLAYBACK_SESSION_ENV];
    registerPlaybackLifecycle({ provider: "sapi" }, { dataDir: dir });
    entry = readPlayback(PLAYBACK_OWNERLESS_KEY, { dataDir: dir });
    assert.equal("sessionID" in entry, false, "无 env → 无主条目（有意兼容：可被任意消息打断）");
  } finally {
    if (prev === undefined) delete process.env[PLAYBACK_SESSION_ENV];
    else process.env[PLAYBACK_SESSION_ENV] = prev;
    clearPlayback(process.pid, { dataDir: dir });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI 开播前清场带 env sessionID（跨会话混音：三处无裸 stopPlayback() 全清）", () => {
  // 手法同 tui-diagnostics/emotions-hook：读构建产物文本做接线断言——三处清场（speak/follow/__play）
  // 必须带 env 会话（B 会话开播不杀 A 会话）；裸 stopPlayback() = 停全部条目 = 跨会话误杀回归
  const src = readFileSync(fileURLToPath(new URL("../dist/cli/emotions-cli.js", import.meta.url)), "utf8");
  const code = src
    .split("\n")
    .filter((line) => {
      const head = line.trim();
      return !head.startsWith("*") && !head.startsWith("//") && !head.startsWith("/*");
    })
    .join("\n");
  assert.deepEqual(code.match(/stopPlayback\(\s*\)/g) ?? [], [], "存在裸 stopPlayback()：B 会话开播会杀 A 会话");
  const scoped = code.match(/stopPlayback\(\{\s*sessionID/g) ?? [];
  assert.equal(scoped.length, 3, "三处清场（speak/follow/__play）都带 sessionID（本会话隔离）");
  const envBound = code.match(/process\.env\[PLAYBACK_SESSION_ENV\]/g) ?? [];
  assert.ok(envBound.length >= 3, "清场与登记的 sessionID 都来自 env EMOTIONS_SESSION_ID 机制");
});

test("config：语言拆两键 uiLanguage/toolLanguage（默认 en / 旧键兜底 / 环境变量覆盖）", () => {
  assert.equal(ENV_UI_LANGUAGE, "VOICE_UI_LANGUAGE");
  assert.equal(ENV_TOOL_LANGUAGE, "VOICE_TOOL_LANGUAGE");
  assert.equal(ENV_LANGUAGE, "VOICE_LANGUAGE");
  assert.equal(DEFAULT_VOICE_CONFIG.uiLanguage, "en");
  assert.equal(DEFAULT_VOICE_CONFIG.toolLanguage, "en");
  const dir = mkdtempSync(join(tmpdir(), "voice-lang-"));
  try {
    writeFileSync(join(dir, CONFIG_FILE_NAME), `{ "language": "en" }`, "utf8");
    let cfg = loadVoiceConfig({ configDir: dir, env: {} });
    assert.deepEqual([cfg.uiLanguage, cfg.toolLanguage], ["en", "en"], "旧键兜底两者");
    cfg = loadVoiceConfig({ configDir: dir, env: { VOICE_UI_LANGUAGE: "zh" } });
    assert.deepEqual([cfg.uiLanguage, cfg.toolLanguage], ["zh", "en"], "新环境变量各自覆盖");
    writeFileSync(join(dir, CONFIG_FILE_NAME), `{ "uiLanguage": "xx" }`, "utf8");
    cfg = loadVoiceConfig({ configDir: dir, env: {} });
    assert.equal(cfg.uiLanguage, "en", "非法语言回退默认 en");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
