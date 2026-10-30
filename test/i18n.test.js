/**
 * 运行时错误文案本地化（`lib/i18n` 的 runtimeErrorText / runtimeErrorShortText）单元测试。
 *
 * 修复前：错误文案硬编码中文（`ndjson.exitCodeReason` 返回「未检测到麦克风」、TUI 直接展示
 * runtime 的中文 message），`uiLanguage=en` 时用户仍看到中文。现在 `code` 稳定、文案按语言渲染。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { format, getPhrases, runtimeErrorShortText, runtimeErrorText } from "../dist/lib/i18n.js";

/** 常见 CJK 统一表意文字（用于断言 en 文案不含中文）。 */
const CJK = /[\u4e00-\u9fff]/;

/** 运行时稳定错误码（与 `voice/ndjson.ts` 常量对齐）。 */
const RUNTIME_ERROR_CODES = [
  "no-input-device",
  "mic-silent",
  "ffmpeg-unavailable",
  "capture-failed",
  "asr-connect-failed",
  "asr-failed",
  "credentials-missing",
];

test("runtimeErrorText：每个 code 在 zh/en 下都有完整文案（修复前无此分组/函数）", () => {
  for (const code of RUNTIME_ERROR_CODES) {
    const zh = runtimeErrorText(code, "zh", "DETAIL");
    const en = runtimeErrorText(code, "en", "DETAIL");
    assert.ok(zh.length > 0, `${code} zh 文案不能为空`);
    assert.ok(en.length > 0, `${code} en 文案不能为空`);
    assert.match(zh, CJK, `${code} zh 必须含中文`);
    assert.doesNotMatch(en, CJK, `${code} en 不得含中文`);
    assert.notEqual(zh, en, `${code} 两种语言必须不同`);
    assert.doesNotMatch(zh, /\{message\}/, `${code} zh 模板占位符必须被填充`);
    assert.doesNotMatch(en, /\{message\}/, `${code} en 模板占位符必须被填充`);
  }
});

test("no-input-device：短句 + 完整可操作说明（三条检查项 + --list）", () => {
  const zh = runtimeErrorText("no-input-device", "zh");
  assert.match(zh, /未检测到音频输入设备/);
  assert.match(zh, /①.*②.*③/s, "必须给出三条检查项");
  assert.match(zh, /--list/);
  assert.equal(runtimeErrorShortText("no-input-device", "zh"), "未检测到麦克风");

  const en = runtimeErrorText("no-input-device", "en");
  assert.match(en, /No audio input device/i);
  assert.match(en, /\(1\).*\(2\).*\(3\)/s, "en 必须给出三条检查项");
  assert.match(en, /--list/);
  assert.equal(runtimeErrorShortText("no-input-device", "en"), "No microphone detected");
});

test("mic-silent / ffmpeg-unavailable：关键修复信息在文案里（zh/en）", () => {
  assert.match(runtimeErrorText("mic-silent", "zh"), /RMS≈0/);
  assert.match(runtimeErrorText("mic-silent", "en"), /RMS≈0/);
  for (const lang of ["zh", "en"]) {
    const ffmpeg = runtimeErrorText("ffmpeg-unavailable", lang);
    assert.match(ffmpeg, /FFMPEG_BIN/, `${lang} 必须提示 FFMPEG_BIN`);
    assert.match(ffmpeg, /HTTPS_PROXY|proxy|代理/i, `${lang} 必须提示代理/网络`);
  }
});

test("capture-failed / asr-connect-failed / asr-failed：detail 插值正确（zh/en）", () => {
  for (const lang of ["zh", "en"]) {
    const phrases = getPhrases(lang).runtimeError;
    assert.equal(
      runtimeErrorText("capture-failed", lang, "boom"),
      format(phrases.captureFailed, { message: "boom" }),
    );
    assert.equal(
      runtimeErrorText("asr-connect-failed", lang, "boom"),
      format(phrases.asrConnectFailed, { message: "boom" }),
    );
    assert.equal(runtimeErrorText("asr-failed", lang, "boom"), format(phrases.asrFailed, { message: "boom" }));
    assert.match(runtimeErrorText("capture-failed", lang, "boom"), /boom/);
  }
});

test("未知 code / null：兜底 runtimeError 模板（message 插入，zh/en）", () => {
  for (const lang of ["zh", "en"]) {
    const template = getPhrases(lang).toast.runtimeError;
    assert.equal(runtimeErrorText("some-new-code", lang, "boom"), format(template, { message: "boom" }));
    assert.equal(runtimeErrorText(null, lang, "boom"), format(template, { message: "boom" }));
    // 空 detail ⇒ 模板尾部裸冒号被清理（`formatMessage()` 契约：`…错误：{message}` → `…错误`）
    const bare = format(template, { message: "" });
    const empty = runtimeErrorText(undefined, lang);
    assert.equal(empty, bare.replace(/[\s:：]+$/, ""), "空 detail 只清理尾部冒号/空白，正文不变");
    assert.doesNotMatch(empty, /[\s:：]$/, "空 detail 时不得留裸冒号");
    assert.ok(empty.length > 0 && empty.length < bare.length, "兜底文案仍非空（只少了分隔符）");
    assert.equal(runtimeErrorShortText("some-new-code", lang), null, "未知 code 没有短句");
  }
});
