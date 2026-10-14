# 异步交互点清单（ASYNC）

> 登记「代码里一眼看不出的」并发契约：共享状态 · 保护手段 · 顺序契约 · 失败/取消/超时。
> 维护：新增异步 ⇒ 同批加行；改动异步 ⇒ 同步改对应行；删除 ⇒ 同步删。

## 一、并发概览

| 项 | 内容 |
|---|---|
| 并发模型 | 单线程事件循环（Node / Bun）；并发来自子进程 stdout 事件、WebSocket 回调、定时器、宿主热键回调 |
| 并发边界清单 | ① ffmpeg 采集 stdout → ASR 喂流；② WS 收消息 vs `finish()` 等待；③ WAV 自测的节奏定时器；④ 采集统计定时器；⑤ SIGINT 收尾；⑥ **TUI 插件**：子进程生命周期 vs 热键开关；⑦ TUI：stdout 事件回调 vs 分发；⑧ TUI：并发 dispatch（连续 final）；⑨ **TTS**：工具 → CLI 前台 → 分离 `__play` 播放进程；⑩ **TTS**：CosyVoice 合成/播放 vs 连续 `speak`；⑪ **TTS CLI**：`exec` 前台与分离 `__play` 的进程边界 |
| 守护措施 | `docs/ASYNC.md` + 技能门禁脚本 `check_async_inventory.py`（改了异步代码必须同批改本清单） |

## 二、并发交互点

| # | 交互点 | 位置 | 共享状态 | 访问方式 | 保护手段 | 顺序契约 | 失败·取消·超时 | 验证方式 |
|---|---|---|---|---|---|---|---|---|
| 1 | ffmpeg 采集回调 vs WS 发送 | `src/runtime/voice-runtime.ts`（`capture.on("data")`）、`src/voice/aliyun.ts` `feed()` | `AliyunAsrClient` 的 `ws` 连接、`finished`/`started` 标志、`protocol` | 采集回调读 `finished`/`started`/`readyState` 并写 WS | 单线程事件循环（发送动作同步、无 await 交错）；`feed()` 发送前检查 `readyState===OPEN && started && !finished`；realtime 发 base64 JSON、inference 发裸二进制帧 | `connect()` resolve 后才允许 `feed()`：realtime 在 WS open 并发出 `session.update` 后 resolve；inference 在收到 `task-started` 后 resolve | WS 未连接 → 记录错误并停发；采集异常只上报，不自动 `finish`（由 runtime 顺序控制） | 非交互自测跑通；`errorMessage` 断言；`test/asr-payload.test.js` 校验两种协议消息体 |
| 2 | WS 收消息回调 vs `connect()`/`finish()` 等待 | `src/voice/aliyun.ts` `handleMessage()`/`connect()`/`finish()` | `finished`、`started`、`lastError`、`completeDeferred`、`startDeferred` | 收消息回调写；`connect()`/`finish()` 读/等待 | 单线程；`markFinished()` 幂等（先判 `finished`）；`startDeferred`/`completeDeferred` 单次 settle，超时定时器在 settle 时清除 | realtime：服务端保证 `session.finished` 晚于所有转录事件。inference：`task-started` 必早于任何 `result-generated`，`task-finished` 晚于全部结果；调用方保证 `finish()` 在 `feed()` 全部完成后调用 | 错误事件/`task-failed`/`session.finished`/`task-finished` 都会 settle；`connect()` 等待 `task-started` 超时（默认 10s，仅 inference）、`finish()` 超时（默认 20s）均解除等待并记 `lastError` | 自测中 `finish()` 不挂起；错误路径拿到脱敏信息 |
| 3 | WAV 实时节奏定时器（顺序 await 循环） | `src/runtime/voice-runtime.ts` `feedRealtime()` | 无（仅本地循环变量） | 无并发写 | 顺序 `await`，无交错 | 每 100ms 发一帧；尾静音发完并 `delay` 后才 `finish()` | 循环内 `feed()` 失败由 #1 处理 | 自测打印文本+情绪 |
| 4 | 采集统计定时器（每 2s）读取累计值 | `src/runtime/voice-runtime.ts` `setInterval` | 累计 `samples`/`sumSq` | 采集回调写、定时器读 | 单线程；读写均为同步短操作，无 await 交错 | 无序（仅展示，`--json` 时写 stderr） | 定时器在停止时 `clearInterval` | stderr 末行回显于插件退出提示 |
| 5 | SIGINT 收尾 vs 采集/ASR | `src/runtime/voice-runtime.ts` `waitForStop()` | 采集进程、客户端 | 一次性 handler | 单线程；`done` 标志保证只收尾一次 | 先 `capture.stop()` 再 `client.finish()`（确保 `finish()` 前不再 `feed()`） | `finish()` 自带超时；超时/错误仍退出 | 手动 Ctrl+C（由用户） |
| 6 | TUI：子进程生命周期 vs 热键开关 | `src/tui.tsx` `toggleMode()` / `startRuntime()` / `stopRuntime()` / `handleChildGone()` | `child`、`splitter`、`lastStderr`、`injectOn`/`inputOn`/`busy` 信号、`toggling`/`stopping` | 热键 `run()` 与子进程 `spawn`/`error`/`exit` 回调读/写 | 单线程；`toggling` 同步布尔守门拦住并发切换；`stopRuntime()` 先置 `stopping=true` 再 `kill()`，`exit` 回调据此不误报；`dispose` 复位且不再 toast | `startRuntime()` 等 `spawn` 事件后才 resolve；单实例由 `childAlive()` + 同步赋值保证；两模式互斥 | spawn 失败/超时 → reject → toast 并复位开关；子进程异常退出 → 复位开关、可热键重启；`dispose` 主动 `stop()`（2s 上限） | 单测（ndjson 解析）+ 手动 UI（由用户） |
| 7 | TUI：stdout 事件回调 vs 分发 | `src/tui.tsx` `onStdout()` / `handleEvent()` / `dispatch()` | `splitter` 行缓冲；`injectOn`/`inputOn` 信号（读） | `stdout` 的 `data` 回调写缓冲并读信号；热键回调写信号 | 单线程；`NdjsonLineSplitter` 只被该 `data` 回调访问；分发时读取模式快照 | 行按到达顺序处理；模式以 `dispatch()` 当次读取为准（不缓存旧模式） | `parseEventLine` 非法返回 null 即跳过；`session.prompt`/`tui.appendPrompt` 各自 try/catch + toast；不在会话路由时忽略该结果 | 离线单测：分片行重组 + 事件解析（`test/ndjson.test.js`） |
| 8 | TUI：并发 dispatch（连续 `final` 未等前一个完成） | `src/tui.tsx` `dispatch()` | 无共享可变状态（仅读信号、弹 toast） | 每个 `final` 各自 `void dispatch()` 并发 | 不阻塞事件循环；不共享可变缓冲 | **不保证注入/追加顺序**（每条独立成条目）；如需严格顺序须引入队列（当前不做） | 单条失败仅 toast，不影响后续条目 | 代码审查 |
| 9 | TTS：工具 → CLI 前台 → 分离 `__play` 播放进程 | `src/voice/tool.ts` `execute`、`src/cli/voice-cli.ts` `runSpeak()`/`runPlay()`、`src/voice/tts/sapi.ts` `speak()`/`stop()`/`spawnPlayer()`、`src/voice/tts/index.ts` `speak()`/`stopAll()` | 工具进程**不持有** provider；`__play` 进程内 `SapiProvider.child`（单实例；provider 注册表按名缓存） | `exec` 读前台 CLI 的 stdout；前台 CLI 校验后 `spawn(detached,...).unref()`；`__play` 内同步读/写 provider 状态 | 前台 CLI 校验通过才派生 `__play`（分离 + unref；参数经 base64 环境变量传递，不落命令行/不含密钥）；`__play` 内 `speak()` 先 `stop()` 再 spawn | 前台立即返回（不等待播放）；播放由 `__play` 进程内串行（同进程内新 `speak` 打断上一条） | spawn ENOENT → 回退下一候选（`pwsh`→`powershell`）；前台只报启动/校验错误，播放期错误仅记日志；**跨进程不保证打断**（每次工具调用各起一个 `__play`） | 单测（配置/脚本/注册表/CLI 解析）+ 分离进程存活自测（由模型）；真实播放（由用户） |
| 10 | TTS：CosyVoice WebSocket 合成/播放 vs 连续 `speak` / dispose | `src/cli/voice-cli.ts` `runPlay()`、`src/voice/tts/aliyun.ts` `speak()`/`stop()`/`synthesize()`/`play()`/`cleanupTemp()`、`src/voice/tts/index.ts` `speak()`/`stopAll()` | `__play` 进程内 `AliyunProvider.ws`、`player` 子进程、`tmpDir`、`activeToken` | `speak` 同步读/写；WS `message`/`error`/`close` 与子进程 `exit`/`error` 回调写 | 单线程；`speak()` 先 `stop()`（置 `activeToken=""` 并关连接/杀播放进程）；`run()` 在每个 `await` 后比对 `activeToken`，不匹配即中止；`cleanupTemp` 幂等 | 同进程内新朗读先停止上一条；合成（收 `task-finished`）完成后才转码/落盘/播放 | 合成整体 30s 超时；WS `error`/提前 `close` 结束等待并报错；播放进程 ENOENT 回退候选；失败仅记日志（前台已返回）；拼接顺序 `run-task`→`task-started`→`continue-task`→`finish-task`→`task-finished` | 单测（参数桩 / run·continue·finish 消息构造 / 忽略判定）+ 云合成本地落文件自测（由模型）；真实播放（由用户） |
| 11 | TTS：`exec` 前台 CLI 与分离 `__play` 的进程边界 | `src/cli/voice-cli.ts` `runSpeak()`（`--background` 分支）、`src/voice/tool.ts` `execute` | `process.env[OC_VOICE_PLAY]`（base64 载荷，进程间单向传递） | 前台写环境变量后 `spawn`；`__play` 启动时读一次 | 参数经环境变量而非命令行（无密钥、无注入面）；`__play` 分离 + `unref` 使父进程不被拖住 | 前台先完成 provider/凭证校验，再派生 `__play` | 派生失败（spawn 异常）由前台报错；`__play` 内失败只记日志；前台立即退出，`exec` 随即返回 | 分离进程存活自测 + `exec` 中文/emoji 透传自测（由模型） |

## 三、不变量

- 任一时刻 `AliyunAsrClient.finished` 只会由 `false` 变 `true` 一次；`markFinished()` 生效后不再发任何消息。
- `feed()` 之后若无调用方顺序控制，不会自动触发 `session.finish`；即 `finish` 必须是发送序列的最后一个动作。
- 任何对外错误文本（`errorMessage` / 日志）都不包含 apikey（统一经 `redact()` 脱敏）。
- `--json` 模式下，`voice-runtime` 的 **stdout 只输出 NDJSON 行**，人类可读日志一律走 stderr（插件据此逐行解析）。
- TUI 插件同一时刻至多持有一个存活 `voice-runtime` 子进程；`startRuntime()` 只在 `spawn` 事件后返回成功。
- 两个模式（`injectOn` / `inputOn`）互斥；都关闭时子进程必须被停止（`dispose` 亦如此）。
- TTS 在同一 `__play` 进程内至多持有一个存活的朗读子进程/连接：新的 `speak` 必先打断同进程内的上一条。**跨进程不保证**：工具每次调用各派生一个独立 `__play`，两条并发朗读不会互相打断；opencode 退出也不再主动 `stop`（分离进程无跨进程句柄）。
- 云 TTS（`aliyun`）provider 同一时刻至多持有一个 WebSocket 与一个播放子进程；`activeToken` 被 `stop()` 变更后，进行中的合成/播放回调不得再落盘或播放。
- 凭证（`apiKey`/`workspace`）只用于握手与脱敏，**绝不写入日志、错误文本或临时文件**。

## 四、变更记录

- 2026-10-13：初建清单（语音运行时 CLI：采集 + 阿里云实时 ASR + 情绪映射；含既有 voice-input 插件交互点）。
- 2026-10-13：`voice-input.ts` 演进为 `voice-server.ts`（新增 `/start`·`/stop`·`/status` 与子进程管理，注入正文改 `annotation` 格式）；交互点 ⑥ 迁址，新增 ⑦（子进程生命周期）⑧（TUI 轮询）。
- 2026-10-13：**重写为单 TUI 插件**。删除 server 插件那套（`voice-server`/`session-tracker`/HTTP 网关/`process-manager`）与 TUI 轮询；交互点 ⑥⑦⑧ 改为「TUI 子进程生命周期 vs 热键」「stdout 回调 vs 分发」「并发 dispatch」；新增不变量（stdout 仅 NDJSON、单子进程、模式互斥）。
- 2026-10-13：新增**语音输出**（server 插件 `tts-tool` + `src/voice/tts/*`）。交互点 ⑨「TTS 后台朗读子进程 vs 连续 `speak` / dispose」；新增不变量（TTS 单活跃子进程 + dispose 清理）。
- 2026-10-13：**配置化 + 双协议 ASR**。`AliyunAsrClient` 泛化：realtime（qwen，base64 JSON）与 inference（paraformer，`run-task`→`task-started`→裸二进制→`finish-task`）。交互点 ① 增加 `started` 门控与按协议分包、② 增加 `connect()` 等待 `task-started` 与 `task-failed`/`task-finished` settle；参数全部来自 `voice.jsonc` 配置（删除阿里云不存在的 `prefix_padding_ms`）。
- 2026-10-13：**凭证可配 + ASR 语种/语料 + CosyVoice TTS**。凭证解析（env > 配置 > 文件 > 默认路径）抽到 `src/voice/credentials.ts`；ASR 增 `languageHints`/`vocabularyId`/`context`（按 provider 能力过滤，`resolveAsrParams`）；`aliyun` TTS 由占位改为 CosyVoice WebSocket provider。新增交互点 ⑩（CosyVoice 合成/播放 vs 连续 speak/dispose）与两条不变量。
- 2026-10-14：**TTS 改 CLI 风格 + 情绪 + i18n + 槽位单词条**。新增 `src/cli/voice-cli.ts`（CLI 入口，`speak --background` 派生分离 `__play` 进程）；`voice_cli` 工具改由 `exec` 调用 CLI。交互点 ⑨⑩ 改为「CLI 前台 / 分离 `__play`」口径，新增 ⑪；不变量改为「同进程内打断、跨进程不保证、dispose 不再 stop」。新增不变量：`speak` 参数经 base64 环境变量在进程间传递（不落命令行）。
- 2026-10-14：**两个 server 插件合并为一个**。`voice_cli` 工具定义由 `src/tts-tool.ts` 移到 `src/voice/tool.ts`（`createVoiceTool()`），改由唯一 server 入口 `src/emotions.ts` 的 `tool` 钩子注册（原先独立 server 插件在 npm 安装时不被加载）。交互点 ⑨⑪ 的 `execute` 位置同步改址；并发契约本身不变（工具进程仍不持有 provider）。
