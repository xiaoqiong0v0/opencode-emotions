# opencode-emotions

OpenCode 插件：让用户用**极短符号**或**英文命令**表达情绪，插件把当前消息**可见地**改写为统一标注 `emoji(等级/3)`，让模型读到准确的情绪。零自然语言、免 i18n、无状态（只作用于当前这条消息）。

## 安装

```bash
npm install @xiaoqiong0v0/opencode-emotions
```

在 `opencode.jsonc` 的 `plugin` 数组中登记：

```jsonc
{
  "plugin": ["@xiaoqiong0v0/opencode-emotions"]
}
```

本地开发：`npm run publish:proj`（= `npm run build` + 把 `dist/` 整体镜像到 `.opencode/plugin/`）后重启 opencode 生效，详见下文「本地发布」。

## 用法

### 1. 符号（前缀/后缀）

在消息**开头**或**结尾**写一串符号（只认纯某一种符号，不能混写）：

| 符号（全/半角） | 情绪 | 最少个数 | 等级换算（封顶 3） | 1/3 | 2/3 | 3/3 |
|---|---|---|---|---|---|---|
| `!` / `！` | 怒 | 1 | `min(n, 3)` | 😠 | 😡 | 🤬 |
| `?` / `？` | 疑惑 | 1 | `min(n, 3)` | 😕 | 🤔 | 😵 |
| `...` / `。。。` | 无语 | 3 | `min(n-2, 3)` | 😐 | 😑 | 😮💨 |
| `666` | 非常好 | 3 | `min(n-2, 3)` | 🙂 | 😊 | 🤩 |

示例：

| 原始输入 | 归一化后 |
|---|---|
| `！！！测试` | `🤬(3/3) 测试` |
| `!!! 又崩了` | `🤬(3/3) 又崩了` |
| `又崩了 !!!` | `🤬(3/3) 又崩了` |
| `？？？ 这是啥` | `😵(3/3) 这是啥` |
| `... 算了` | `😐(1/3) 算了` |
| `..... 服了` | `😮💨(3/3) 服了` |
| `。。。算了` | `😐(1/3) 算了` |
| `666 这版真不错` | `🙂(1/3) 这版真不错` |
| `!!!`（只发符号） | `🤬(3/3)` |

规则要点：

- 开头**标点类**可直接接正文（`！！！测试`）；开头**数字类 `666`** 必须后跟空白或行尾（防 `666元`）。
- 结尾**不强制前置空格**，但**至少 2 个**（`崩溃了！！！` 有效；`好开心！` 单个不认）。
- 首尾同时出现取**开头**；正文中间的符号不认。
- 命中后符号被消耗，二次处理不再叠加（幂等）。

### 2. 情绪命令

| 命令 | 别名 | 标注 |
|---|---|---|
| `/annoyed` | `/meh` | 😠(1/3) |
| `/angry` | `/mad` | 😡(2/3) |
| `/furious` | `/rage` | 🤬(3/3) |
| `/confused` | `/puzzled` | 🤔(2/3) |
| `/speechless` | `/sigh` | 😑(2/3) |
| `/neutral` | `/calm` | 😐 |
| `/ok` | `/fine` `/okay` | 🙂(1/3) |
| `/happy` | `/good` `/nice` | 😊(2/3) |
| `/great` | `/awesome` | 🤩(3/3) |

例：`/angry 需求又改了` → `😡(2/3) 需求又改了`。无参数时只产生标注本身。

## 语音输出（`voice_cli` 工具 / `voice-cli` 命令）

由 **server 插件** `tts-tool` 提供 **CLI 风格**工具 `voice_cli`：模型在用户要求「说出来 / 念出来 / 朗读 / 用语音回答」时主动调用，把文字合成语音并对用户播放。
工具只接受一个参数 `args`（完整 CLI 参数串），内部执行 `node dist/cli/voice-cli.js <args>`（PATH 上找不到 `node` 时回退 `process.execPath`）。

> 为什么是 server 插件：`@opencode-ai/plugin/tui` 的 `TuiPluginModule` 声明 `server?: never`，TUI 插件无法注册工具；工具只能由 `{ id, server }` 的 server 插件提供。

**`voice_cli` 工具契约**（`args` 为命令串）：

| 子命令 | 说明 |
|---|---|
| `speak --text <t> [--emotion <e>] [--voice <v>] [--rate <n>] [--provider <p>]` | 合成并播放（工具会自动补 `--background`，立即返回、后台播放） |
| `devices` | 列出音频输入设备 |
| `status` | 查看解析后的配置（含 `language`） |
| `help`（或省略 `args`） | 显示用法 |

例：`speak --text "你好" --emotion happy`、`devices`、`status`、`help`。

**直接用 CLI**（`npm run build` 后；也可 `npm run voice-cli -- <args>`）：

```bash
node dist/cli/voice-cli.js help
node dist/cli/voice-cli.js status
node dist/cli/voice-cli.js devices
node dist/cli/voice-cli.js speak --text "你好" --emotion happy              # 前台播放（等到播完）
node dist/cli/voice-cli.js speak --text "你好" --emotion happy --background # 后台播放，立即返回
```

**情绪（`--emotion`）**：映射为 CosyVoice 的 `instruction`（`sapi` 忽略）。取值/别名与指令对照见 `docs/设计-语音输入注入.md` §13.1；`neutral` 或省略 = 不加风格指令。

**本地发布（`npm run publish:proj`）**：`npm run build` 产出 `dist/` 后，脚本把 `dist/` **整体镜像**到项目 `.opencode/plugin/`，并把 `.opencode/tui.json` 的 `plugin` 指向 `./plugin/tui.js`；重启 opencode 生效。**无需挑拣/改名**——`dist/` 的结构本身就是发布结构：

| `dist/` 顶层 | 说明 | 镜像后 |
|---|---|---|
| `emotions.js` | server 插件入口 | `.opencode/plugin/emotions.js` |
| `tts-tool.js` | server 插件入口（`voice_cli` 工具） | `.opencode/plugin/tts-tool.js` |
| `tui.js` | TUI 插件入口（由 `src/tui.tsx` 编译） | `.opencode/plugin/tui.js` |
| `cli/voice-cli.js` | CLI（非插件） | `.opencode/plugin/cli/` |
| `runtime/voice-runtime.js` | 语音运行时（非插件） | `.opencode/plugin/runtime/` |
| `lib/**`、`voice/**` | 依赖 | 对应子目录 |

> **顶层只放真插件**：opencode 会把 `.opencode/plugin/` 顶层的**每个 `.js`** 当插件自动 import；CLI、语音运行时等非插件产物一律进子目录（`cli/`、`runtime/`），子目录不被扫描。`publish:proj` **断言顶层只有插件入口**——出现 `voice-cli.js` / `voice-runtime.js` 之类会立即报错退出（防回归）。
> `tui.js` 由**宿主同款 Babel 链**（`babel-preset-solid` + `@babel/preset-typescript`，见 `scripts/build-tui.mjs`）编译：Solid 编译会把 JSX 包成 `createElement` / `insert` / `setProp` + `effect` 的**响应式**结构，而 `tsc` 的 `jsx()` 产物不会包裹 props/children（会失去响应式），故 `.tsx` **不进主 `tsc`**。产物保留裸 `@opentui/solid` / `solid-js` import，由宿主加载时重写为运行时模块 id。
> 语音运行时由 TUI 插件从 `<cwd>/dist/runtime/voice-runtime.js` 启动（可用 `VOICE_RUNTIME_SCRIPT` 覆盖）。
> CLI 路径解析：`VOICE_CLI_SCRIPT`（存在则用）> `<cwd>/dist/cli/voice-cli.js` > 由插件位置上溯的 `<仓库根>/dist/cli/voice-cli.js`。

**情绪与配置**：`tts.*` 见下方「语音配置」；也可用环境变量覆盖（`TTS_PROVIDER` / `TTS_VOICE` / `TTS_RATE` / `TTS_INSTRUCTION` / `TTS_PITCH` / `TTS_VOLUME` / `TTS_FORMAT` / `TTS_SAMPLE_RATE` / `TTS_MODEL`）。

**provider**：
- `sapi`（默认）：本机 Windows SAPI，仅支持 `voice` / `rate` / `volume`；`instruction` / `pitch` / `format` / `sampleRate` / `model` 会被**忽略并记一条日志**。
- `aliyun`：阿里云百炼 **CosyVoice**（WebSocket `run-task`），支持 `voice` / `rate` / `pitch` / `volume` / `format` / `sampleRate` / `instruction`（风格/情感/方言）等；默认模型 `cosyvoice-v2`、默认音色 `longxiaochun_v2`（**模型与音色版本须一致**：v2 模型配 v2 音色、v3 配 v3，混用报 `418`）。**凭证复用 `asr.credentials`**（同一 DashScope 账号），播放仅 Windows。

**音色**：SAPI 优先用 `pwsh`（PowerShell 7）——它能选择全部 OneCore 音色（`Microsoft Huihui` / `Microsoft Kangkang` / `Microsoft Yaoyao`）；仅有 Windows PowerShell 5.1 时只认 Desktop 音色（如 `Microsoft Huihui Desktop`），选不到时回落到默认音色。连读会打断上一条（同一时刻只播一条）。

## 语音配置（`emotions.jsonc`）

语音输入（ASR）与语音输出（TTS）统一从 **`<配置目录>/emotions.jsonc`** 读取，**不写死在代码里**。
配置文件名与插件/项目同名（`opencode-emotions` → `emotions.jsonc`），与同级插件的约定一致（`browser-tool.jsonc` / `sound-notify.jsonc` / `plugin-logger.jsonc`）。
配置目录 = `~/.config/opencode`（`os.homedir()/.config/opencode`）。**首次运行**若文件不存在，会自动写一份带注释的默认；读取失败静默降级为默认值。
**旧名兼容**：旧配置名 `voice.jsonc` 仍可用——若 `emotions.jsonc` 不存在而 `voice.jsonc` 存在，则把旧文件**原样复制**为 `emotions.jsonc`（**旧文件保留不删**，用户已改的值不动）。

**优先级**：命令行参数 > 环境变量 > `emotions.jsonc` > 内置默认。
**凭证优先级**：环境变量（`DASHSCOPE_API_KEY` / `DASHSCOPE_WORKSPACE_ID`）> 配置 `asr.credentials.apiKey`/`workspaceId` > 凭证文件 `asr.credentials.path` > 默认 `<cwd>/.tmp/aliyun`（凭证只读、绝不打印）。

| 键 | 默认值 | 含义 | 环境变量 |
|---|---|---|---|
| `language` | `zh` | 文案语言：`zh` / `en`。用于**工具描述**、TUI 槽位/toast、`voice-cli --help`（改后重启 opencode 生效） | `VOICE_LANGUAGE` |
| `device` | `""` | 音频输入设备友好名；空 = 自动取第一个输入设备 | `VOICE_DEVICE` |
| `asr.provider` | `aliyun-qwen` | ASR 预设：`aliyun-qwen`(16k,7类情绪,realtime) / `aliyun-8k`(8k,3类) / `aliyun-v2`(16k,无情绪) | `VOICE_ASR_PROVIDER` |
| `asr.model` | `""` | 模型名；空 = 按 provider 预设自动选择 | `VOICE_ASR_MODEL` |
| `asr.language` | `""` | 识别语言；**空 = 自动识别（多语言）**。可选 `zh/yue/en/ja/ko/de/fr/ru/...`（所有 provider 支持） | `VOICE_ASR_LANGUAGE` |
| `asr.languageHints` | `[]` | 语言提示（paraformer `language_hints`）；**仅 `aliyun-8k`/`aliyun-v2` 支持**，其余忽略 | `VOICE_ASR_LANGUAGE_HINTS`（逗号分隔） |
| `asr.vocabularyId` | `""` | 热词表 ID（paraformer `vocabulary_id`，需先用 VocabularyService 预建且 `target_model` 一致）；**仅 `aliyun-8k`/`aliyun-v2` 支持**，其余忽略 | `VOICE_ASR_VOCABULARY_ID` |
| `asr.context` | `""` | 领域上下文/语料（run-task `input.context`）；**当前无 provider 支持，始终忽略**（qwen3-asr-flash-realtime 与 paraformer 均不支持） | `VOICE_ASR_CONTEXT` |
| `asr.credentials.path` | `""` | 凭证文件（1 行 workspaceid / 2 行 apikey）；空 = 默认 `<cwd>/.tmp/aliyun` | `VOICE_ALIYUN_CREDENTIALS`（兼容旧名 `ALIYUN_CREDENTIALS`） |
| `asr.credentials.apiKey` | `""` | 直接给出的 API Key（**云 TTS 复用同一凭证**） | `DASHSCOPE_API_KEY` |
| `asr.credentials.workspaceId` | `""` | 直接给出的业务空间 ID | `DASHSCOPE_WORKSPACE_ID` |
| `vad.threshold` | `0.5` | 语音活动检测阈值 `[-1,1]`；**越高越抗噪**、越低越灵敏（易误触发） | `VOICE_VAD_THRESHOLD` |
| `vad.silenceDurationMs` | `800` | 句尾静音判定毫秒 `[200,6000]` | `VOICE_VAD_SILENCE_MS` |
| `tts.provider` | `sapi` | 合成后端：`sapi`(本机 Windows SAPI) / `aliyun`(阿里云 CosyVoice) | `TTS_PROVIDER` |
| `tts.voice` | `""` | 音色名；空 = provider 默认（sapi 系统默认 / aliyun `longxiaochun_v2`） | `TTS_VOICE` |
| `tts.rate` | `0` | 语速；`sapi` `[-10,10]`（0 中性）、`aliyun` `[0.5,2]`（0 = 未指定 → 1.0） | `TTS_RATE` |
| `tts.instruction` | `""` | 风格/情感/方言指令（≤100 字）；**仅 `aliyun` 支持**，sapi 忽略 | `TTS_INSTRUCTION` |
| `tts.pitch` | `0` | 音高 `[0.5,2]`（0 = 未指定 → 1.0）；**仅 `aliyun` 支持**，sapi 忽略 | `TTS_PITCH` |
| `tts.volume` | `0` | 音量 `[0,100]`（0 = 未指定 → provider 默认）；sapi / aliyun 均支持 | `TTS_VOLUME` |
| `tts.format` | `""` | 输出格式 `pcm/wav/mp3/opus`（空 = wav）；**仅 `aliyun` 支持**，sapi 忽略 | `TTS_FORMAT` |
| `tts.sampleRate` | `0` | 采样率 `8000/16000/22050/24000/44100/48000`（0 = 22050）；**仅 `aliyun` 支持**，sapi 忽略 | `TTS_SAMPLE_RATE` |
| `tts.model` | `""` | 云 TTS 模型名（空 = `cosyvoice-v2`）；**仅 `aliyun` 支持**，sapi 忽略 | `TTS_MODEL` |

自定义配置目录：环境变量 `EMOTIONS_CONFIG_DIR`（兼容旧名 `VOICE_CONFIG_DIR`，两者同时设置时新名优先）。

**多语言（i18n）**：`language`（`zh` / `en`）控制**工具描述**（插件加载时本地化）、TUI 槽位指示/toast、`voice-cli --help`；词表集中在 `src/lib/i18n.ts`（新增语言只需在 `LANGUAGES` 与 `PHRASES` 各加一项，类型会强制补齐全部键）。

**抗噪**：阿里云无独立降噪参数，抗噪主要靠调高 `vad.threshold`（默认已从 0.2 调到 **0.5**）。`language` 留空走服务端自动语种检测，即可多语言。

## 已知限制

- **行首半角 `!` 会被 opencode shell 模式拦截**（光标在首字符时回车直接执行 shell，且不配置禁用）。行首请用**全角 `！`**；行尾半角/全角皆可。
- 残留误伤可能：`? 这是什么`（疑问句）、`666 元`（数字）等仍可能被识别；token 规则已尽量收窄，无法 100% 消除，误判时可改用命令或改写措辞。
- 无语族认**半角 `.` 与全角 `。`**（两者完全等价，各字符按 1 计：3 个=1/3、4 个=2/3、5 个及以上=3/3；单个不认）；全角省略号 `……` / `…` **不识别**，保持原文。

## 开发

```bash
npm install
npm run build        # 清空 dist/ → tsc 编译 src/**（不含 .tsx）→ Babel 链编译 dist/tui.js
npm test             # 构建后跑单元测试（node --test）
npm run publish:proj # build + 镜像 dist/ → .opencode/plugin/（并指向编译后的 tui.js）
```

**产物与发布结构**（顶层只放插件入口，其余进子目录）：

```
dist/
  emotions.js          # server 插件入口（源：src/emotions.ts）
  tts-tool.js          # server 插件入口（源：src/tts-tool.ts）
  tui.js               # TUI 插件入口（源：src/tui.tsx，经 Babel 链编译）
  cli/voice-cli.js     # CLI（源：src/cli/voice-cli.ts）
  runtime/voice-runtime.js  # 语音运行时（源：src/runtime/voice-runtime.ts）
  lib/**
  voice/**
```
