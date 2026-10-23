/**
 * `emotions_cli` 工具「F10 开启时拦截模型 speak」判定单测（纯函数，零 IO、不 exec 任何进程）。
 *
 * 覆盖（2026-10-22）：只拦以 `speak` 开头（词边界）的参数串——含 `--follow`/`--background` 变体；
 * `help`/`devices`/`status` 等非 speak 子命令不拦；`speaky` 这类**无词边界**前缀不拦；
 * 开关为关时一切不拦（拦截条件 = speak ∧ autoReadEnabled）。
 * 状态读取与文案取词在 execute 接线层（tool.ts，读每会话状态文件 + safePhrases 现取），
 * 本文件只验证判定纯函数 `shouldInterceptSpeakForAutoRead` 的口径。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createVoiceTool,
  prepareInvocation,
  shouldInterceptSpeakForAutoRead,
  tokenizeArgs,
} from "../dist/voice/tool.js";

test("shouldInterceptSpeakForAutoRead：speak 系（含 --follow/--background）+ 开关开 → 拦", () => {
  assert.equal(shouldInterceptSpeakForAutoRead("speak --text \"你好\"", true), true);
  assert.equal(shouldInterceptSpeakForAutoRead("speak", true), true);
  assert.equal(shouldInterceptSpeakForAutoRead("speak --follow --provider sapi", true), true);
  assert.equal(shouldInterceptSpeakForAutoRead("speak --text hi --background", true), true);
});

test("shouldInterceptSpeakForAutoRead：开关关 → 一切不拦", () => {
  assert.equal(shouldInterceptSpeakForAutoRead("speak --text \"你好\"", false), false);
});

test("shouldInterceptSpeakForAutoRead：非 speak 子命令不拦（help/devices/status/空）", () => {
  for (const args of ["help", "devices", "status", "", "speakx --text a"]) {
    assert.equal(shouldInterceptSpeakForAutoRead(args, true), false, `不拦：${JSON.stringify(args)}`);
  }
});

test("shouldInterceptSpeakForAutoRead：词边界——`speaky` 前缀不误拦；只认串首 speak", () => {
  assert.equal(shouldInterceptSpeakForAutoRead("speaky --text a", true), false, "speaky 无词边界不拦");
  assert.equal(shouldInterceptSpeakForAutoRead("help speak", true), false, "speak 不在串首不拦");
});

// ==================== 无 shell 执行（2026-10-22 审计修复：exec → spawn + stdin） ====================

/** 最小日志桩（工具层只调用 info/warn/error/tool）。 */
const logStub = {
  info() {},
  warn() {},
  error() {},
  tool() {},
};

/**
 * 建隔离环境：临时配置目录 + 假 CLI 脚本（退出前把 argv/stdin 作为 JSON 打到 stdout）。
 * @param {string} body 脚本主体（可读 stdin/argv）
 * @returns {{ dir: string, cleanup: () => void }}
 */
function withFakeCli(body) {
  const dir = mkdtempSync(join(tmpdir(), "voice-tool-"));
  const script = join(dir, "fake-cli.mjs");
  writeFileSync(script, body, "utf8");
  const previousScript = process.env.EMOTIONS_CLI_SCRIPT;
  const previousConfig = process.env.EMOTIONS_CONFIG_DIR;
  const previousTimeout = process.env.EMOTIONS_CLI_TIMEOUT_MS;
  process.env.EMOTIONS_CLI_SCRIPT = script;
  process.env.EMOTIONS_CONFIG_DIR = join(dir, "config");
  delete process.env.EMOTIONS_CLI_TIMEOUT_MS;
  return {
    dir,
    script,
    cleanup() {
      if (previousScript === undefined) delete process.env.EMOTIONS_CLI_SCRIPT;
      else process.env.EMOTIONS_CLI_SCRIPT = previousScript;
      if (previousConfig === undefined) delete process.env.EMOTIONS_CONFIG_DIR;
      else process.env.EMOTIONS_CONFIG_DIR = previousConfig;
      if (previousTimeout === undefined) delete process.env.EMOTIONS_CLI_TIMEOUT_MS;
      else process.env.EMOTIONS_CLI_TIMEOUT_MS = previousTimeout;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const ECHO_SCRIPT = `
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
process.stdout.write(JSON.stringify({
  argv: process.argv.slice(2),
  stdin: Buffer.concat(chunks).toString("utf8"),
}));
`;

test("tokenizeArgs：只处理引号/空白，不做变量/通配/运算符展开", () => {
  assert.deepEqual(tokenizeArgs('speak --text "a & b | c > d < e"'), ["speak", "--text", "a & b | c > d < e"]);
  assert.deepEqual(tokenizeArgs("speak --text 'x %USERNAME% $HOME ;'"), ["speak", "--text", "x %USERNAME% $HOME ;"]);
  assert.deepEqual(tokenizeArgs('speak --text "他说 \\"你好\\""'), ["speak", "--text", '他说 "你好"']);
  assert.deepEqual(tokenizeArgs("speak --text-file C:\\a\\b.txt"), ["speak", "--text-file", "C:\\a\\b.txt"]);
  assert.deepEqual(tokenizeArgs("  speak   --background  "), ["speak", "--background"]);
  assert.throws(() => tokenizeArgs('speak --text "未闭合'), /引号未闭合/);
});

test("prepareInvocation：speak --text 改走 stdin；--text-file/--follow/--text-stdin 原样", () => {
  assert.deepEqual(prepareInvocation(["speak", "--text", "hi"]), {
    args: ["speak", "--text-stdin"],
    stdinText: "hi",
  });
  assert.deepEqual(prepareInvocation(["speak", "-t", "hi", "--emotion", "happy"]), {
    args: ["speak", "--text-stdin", "--emotion", "happy"],
    stdinText: "hi",
  });
  assert.deepEqual(prepareInvocation(["speak", "--text-file", "a.txt"]), { args: ["speak", "--text-file", "a.txt"] });
  assert.deepEqual(prepareInvocation(["speak", "--follow"]), { args: ["speak", "--follow"] });
  assert.deepEqual(prepareInvocation(["status"]), { args: ["status"] });
});

test("emotions_cli execute：特殊字符 + 中英混排 + 9000 字正文经 stdin 原样传达（不经 shell）", async () => {
  const env = withFakeCli(ECHO_SCRIPT);
  try {
    const tool = createVoiceTool(logStub)["emotions_cli"];
    const text = `A & B | C > D < E %USERNAME% $HOME ; \` " ' 中英混排 ${"汉".repeat(9000)}`;
    const args = `speak --text "${text.replaceAll('"', '\\"')}" --emotion happy`;
    const result = await tool.execute({ args }, { sessionID: "", abort: new AbortController().signal });
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.stdin, text, "正文必须逐字符原样（无变量展开/引号丢失/长度截断）");
    assert.deepEqual(parsed.argv, ["speak", "--text-stdin", "--emotion", "happy", "--background"]);
  } finally {
    env.cleanup();
  }
});

test("emotions_cli execute：`& echo INJECTED` 成为普通 argv，不执行额外命令", async () => {
  const env = withFakeCli(ECHO_SCRIPT);
  try {
    const tool = createVoiceTool(logStub)["emotions_cli"];
    const result = await tool.execute(
      { args: 'speak --text "hello" & echo INJECTED' },
      { sessionID: "", abort: new AbortController().signal },
    );
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.stdin, "hello");
    assert.deepEqual(parsed.argv, ["speak", "--text-stdin", "&", "echo", "INJECTED", "--background"]);
  } finally {
    env.cleanup();
  }
});

/** 假 CLI：把自身 pid 写到脚本同目录 `pid.txt`，然后永久挂起。 */
const SLEEPER_SCRIPT = `
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
writeFileSync(join(dirname(fileURLToPath(import.meta.url)), "pid.txt"), String(process.pid));
process.stdout.write("pid=" + process.pid + "\\n");
setInterval(() => {}, 1000);
`;

/**
 * 等待子进程真正消失（Windows 的 kill 是异步的，留一点收敛时间）。
 * @param {string} pidFile pid 文件路径
 * @returns {Promise<number>} 子进程 pid
 */
async function waitForPidFile(pidFile) {
  for (let i = 0; i < 50; i += 1) {
    try {
      const pid = Number(readFileSync(pidFile, "utf8"));
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch {
      // 尚未写入
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`未等到 pid 文件：${pidFile}`);
}

/**
 * 断言进程已被终止（ESRCH/无效 pid）；留少量时间让操作系统回收。
 * @param {number} pid 进程 id
 */
async function assertKilled(pid) {
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.throws(() => process.kill(pid, 0), /ESRCH|invalid|not found/i, "子进程必须已被 kill");
}

test("emotions_cli execute：超时会 kill 子进程（带退出状态摘要）", async () => {
  const env = withFakeCli(SLEEPER_SCRIPT);
  try {
    process.env.EMOTIONS_CLI_TIMEOUT_MS = "300";
    const tool = createVoiceTool(logStub)["emotions_cli"];
    const started = Date.now();
    const result = await tool.execute({ args: "status" }, { sessionID: "", abort: new AbortController().signal });
    assert.ok(Date.now() - started < 5000, "超时后必须 settle，不得悬挂");
    assert.match(result.output, /超时（300ms，已 kill 子进程）/);
    const pid = await waitForPidFile(join(env.dir, "pid.txt"));
    await assertKilled(pid);
  } finally {
    env.cleanup();
  }
});

test("emotions_cli execute：宿主取消（AbortSignal）会 kill 子进程并返回已取消", async () => {
  const env = withFakeCli(SLEEPER_SCRIPT);
  try {
    const controller = new AbortController();
    const tool = createVoiceTool(logStub)["emotions_cli"];
    // 先等子进程真的起来（写 pid 文件），再模拟宿主取消
    const running = tool.execute({ args: "status" }, { sessionID: "", abort: controller.signal });
    const pid = await waitForPidFile(join(env.dir, "pid.txt"));
    controller.abort();
    const result = await running;
    assert.match(result.output, /已取消（宿主中断）/);
    await assertKilled(pid);
  } finally {
    env.cleanup();
  }
});
