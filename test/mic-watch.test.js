/**
 * 麦克风「无声提示」判定单测（`dist/voice/mic-watch.js`）。
 *
 * 契约：自首次 observe 起算观察窗口，窗口内取 RMS 峰值；窗口到时峰值 < 阈值 ⇒
 * **整个生命周期只返回一次 true**（runtime 据此只发一条 warning）。时间由调用方传入，测试无需真等待。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createSilenceWatch,
  MIC_SILENCE_WARNING,
  SILENCE_PROBE_MS,
  SILENCE_RMS_THRESHOLD,
} from "../dist/voice/mic-watch.js";

test("低 RMS 序列：窗口到期只告警一次（之后持续静音也不再重复）", () => {
  const watch = createSilenceWatch();
  // 首块起算，窗口内一直是 0（模拟静音/选错设备）
  assert.equal(watch.observe(0, 1000), false, "窗口未到不告警");
  assert.equal(watch.observe(0, 1000 + SILENCE_PROBE_MS - 1), false, "窗口差 1ms 仍不告警");
  assert.equal(watch.observe(0, 1000 + SILENCE_PROBE_MS), true, "窗口内峰值≈0 ⇒ 告警一次");
  for (let i = 1; i <= 5; i += 1) {
    assert.equal(watch.observe(0, 1000 + SILENCE_PROBE_MS + i * 100), false, "后续静音不得重复告警");
  }
});

test("正常音量序列：窗口内出现过响亮采样 ⇒ 永不告警", () => {
  const watch = createSilenceWatch();
  assert.equal(watch.observe(0.02, 0), false);
  assert.equal(watch.observe(0, SILENCE_PROBE_MS), false, "峰值高于阈值 ⇒ 不告警");
  assert.equal(watch.observe(0, SILENCE_PROBE_MS * 3), false, "已判定过的窗口不再告警");
});

test("阈值与窗口可注入：边界值按「严格小于阈值」判定", () => {
  const silent = createSilenceWatch({ probeMs: 10, thresholdRms: 0.01 });
  assert.equal(silent.observe(0.0099, 0), false);
  assert.equal(silent.observe(0.0099, 10), true, "峰值 < 阈值 ⇒ 告警");

  const loud = createSilenceWatch({ probeMs: 10, thresholdRms: 0.01 });
  assert.equal(loud.observe(0.01, 0), false);
  assert.equal(loud.observe(0.01, 10), false, "峰值 == 阈值 ⇒ 不算静音");
});

test("常量口径：3s 窗口、1e-4 阈值、文案含检查项", () => {
  assert.equal(SILENCE_PROBE_MS, 3000);
  assert.equal(SILENCE_RMS_THRESHOLD, 1e-4);
  assert.match(MIC_SILENCE_WARNING, /麦克风似乎没有声音/);
  assert.match(MIC_SILENCE_WARNING, /静音|增益|设备/);
});
