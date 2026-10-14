/**
 * 语音 CLI / 情绪指令 / i18n / 槽位指示 的离线单测（不触发真实播放、网络或设备枚举）。
 *
 * 覆盖：emotion→instruction 映射与别名、resolveTtsConfig 的情绪/provider 覆盖、
 * 语言解析与词表选择、槽位单词条形态、CLI 参数解析、config 的 uiLanguage/toolLanguage 字段。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

import {
  EMOTION_INSTRUCTIONS,
  normalizeEmotion,
  resolveEmotionInstruction,
} from "../dist/voice/tts/emotion.js";
import { resolveTtsConfig } from "../dist/voice/tts/types.js";
import { DEFAULT_LANGUAGE, LANGUAGES, format, getPhrases, resolveLanguage } from "../dist/lib/i18n.js";
import {
  GLYPH_SEGMENT_WIDTH,
  INJECT_KEY,
  INPUT_KEY,
  displayWidth,
  formatSlotIndicator,
  formatSlotSegments,
  modeSegmentWidth,
} from "../dist/voice/slot.js";
import { PLAY_COMMAND, parseCliArgs } from "../dist/voice/cli.js";
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
  assert.notEqual(zh.slot.modeInject, en.slot.modeInject);
  assert.notEqual(zh.cli.help, en.cli.help);
  assert.equal(format(zh.toast.injected, { text: "abc" }), "已注入：abc");
  assert.equal(format(en.toast.modeOn, { label: "Voice inject" }), "Voice inject enabled (listening)");
  assert.equal(format("no {x} here", {}), "no {x} here", "缺失变量保留原样");
});

test("slot：单个指示符形态（状态+模式+两热键恒显 F8/F9；可变段定宽填充）", () => {
  const zh = getPhrases("zh");
  const en = getPhrases("en");
  assert.equal(formatSlotIndicator(zh, { mic: "on", mode: "inject" }), "🎙 ●  注入 F8/F9");
  assert.equal(formatSlotIndicator(zh, { mic: "off", mode: "input" }), "🎙 ○  输入 F8/F9");
  assert.equal(formatSlotIndicator(zh, { mic: "starting", mode: "inject" }), "🎙 ⏳ 注入 F8/F9");
  assert.equal(formatSlotIndicator(en, { mic: "on", mode: "input" }), "🎙 ●  Input  F8/F9");
  assert.equal(INJECT_KEY, "f8");
  assert.equal(INPUT_KEY, "f9");
});

test("slot：显示宽度口径（与渲染库 string-width@7 一致）", () => {
  assert.equal(displayWidth("●"), 1, "歧义宽度字形按窄计");
  assert.equal(displayWidth("○"), 1);
  assert.equal(displayWidth("⏳"), 2, "emoji 计双列");
  assert.equal(displayWidth("🎙"), 2);
  assert.equal(displayWidth("注入"), 4, "CJK 计双列");
  assert.equal(displayWidth("Inject"), 6, "ASCII 计单列");
  assert.equal(displayWidth("Input"), 5);
  assert.equal(displayWidth(" "), 1);
});

test("slot：任意 mic 状态 × 模式 × 语言，拼接总宽恒定", () => {
  const micStates = ["on", "off", "starting"];
  const modes = ["inject", "input"];
  assert.equal(GLYPH_SEGMENT_WIDTH, 3, "Wg = 状态字形段（含尾随空格）最大宽度");
  assert.equal(modeSegmentWidth(getPhrases("zh")), 5, "Wl(zh)");
  assert.equal(modeSegmentWidth(getPhrases("en")), 7, "Wl(en)");
  for (const lang of LANGUAGES) {
    const phrases = getPhrases(lang);
    const widths = new Set();
    for (const mic of micStates) {
      for (const mode of modes) {
        widths.add(displayWidth(formatSlotIndicator(phrases, { mic, mode })));
      }
    }
    assert.equal(widths.size, 1, `${lang}：各状态拼接宽度应恒定，实得 ${[...widths]}`);
  }
  // 不同语言各自恒定（绝对宽度可不同：中/英文模式名长度不同）
  assert.notEqual(
    displayWidth(formatSlotIndicator(getPhrases("zh"), { mic: "on", mode: "inject" })),
    displayWidth(formatSlotIndicator(getPhrases("en"), { mic: "on", mode: "inject" })),
  );
});

test("slot：分段配色角色（文本拼接与颜色分离；热键按激活态高亮）", () => {
  const zh = getPhrases("zh");
  const on = formatSlotSegments(zh, { mic: "on", mode: "inject", injectOn: true, inputOn: false });
  assert.equal(
    on.map((segment) => segment.text).join(""),
    "🎙 ●  注入 F8/F9",
    "分段拼接等于纯文本（含定宽填充）",
  );
  assert.deepEqual(
    on.map((segment) => segment.role),
    ["icon", "glyph", "mode", "keyActive", "separator", "keyInactive"],
    "注入激活：F8 高亮、F9 暗色",
  );
  const off = formatSlotSegments(zh, { mic: "off", mode: "input", injectOn: false, inputOn: false });
  assert.equal(off.map((segment) => segment.text).join(""), "🎙 ○  输入 F8/F9");
  assert.deepEqual(
    off.map((segment) => segment.role),
    ["icon", "glyph", "mode", "keyInactive", "separator", "keyInactive"],
    "关闭态：两键都暗色",
  );
  assert.deepEqual(
    formatSlotSegments(zh, { mic: "on", mode: "input", injectOn: false, inputOn: true }).map((s) => s.role),
    ["icon", "glyph", "mode", "keyInactive", "separator", "keyActive"],
    "输入激活：F9 高亮、F8 暗色",
  );
});

test("CLI 解析：speak 选项、别名、= 写法与各类子命令", () => {
  assert.deepEqual(parseCliArgs(["speak", "--text", "你好", "--emotion", "happy"]), {
    kind: "speak",
    text: "你好",
    emotion: "happy",
    background: false,
  });

  const full = parseCliArgs(["speak", "-t", "hi", "-e", "sad", "-v", "v1", "-r", "-4", "-p", "aliyun", "--background"]);
  assert.equal(full.kind, "speak");
  assert.equal(full.text, "hi");
  assert.equal(full.emotion, "sad");
  assert.equal(full.voice, "v1");
  assert.equal(full.rate, -4);
  assert.equal(full.provider, "aliyun");
  assert.equal(full.background, true);

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

/**
 * 入口保护回归：CLI 产物虽在子目录（不被自动加载），仍保留入口保护以防日后误置顶层。
 * 若模块顶层无条件执行 main()，被 import 时会以空参数跑一次 CLI 并打印 help。
 * 断言方式：子进程 import 产物，要求 stdout/stderr 全空（同进程 import 难以隔离输出）。
 */
test("voice-cli 入口保护：被 import 时不执行 main、不打印任何内容", async () => {
  const cliUrl = new URL("../dist/cli/voice-cli.js", import.meta.url).href;
  const script =
    `const m = await import(${JSON.stringify(cliUrl)});` +
    `if (typeof m.main !== "function" || typeof m.isDirectEntry !== "function") throw new Error("main/isDirectEntry 未导出");`;
  const { stdout, stderr } = await execFileP(process.execPath, ["--input-type=module", "-e", script]);
  assert.equal(stdout, "", "import 不应产生 stdout（回归：曾在插件加载时打印 help）");
  assert.equal(stderr, "", "import 不应产生 stderr");
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
