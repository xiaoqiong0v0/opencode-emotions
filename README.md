# opencode-emotions

OpenCode 插件：用**极简英文命令**（`/angry` 等）表达情绪，命令输出即带统一标注 `emoji(等级/3)`，让模型读到准确的情绪。零自然语言、免 i18n、无状态。
另含 **TUI 插件**：把「语音输入」识别出的文本 + 情绪，以**同一套标注**注入会话或输入框。
（早期的手动符号入口 `!`/`?`/`...`/`666` 已移除，见 `docs/设计-情绪输入插件.md`。）

## 安装与生效

### 推荐：`opencode plugin`（自动安装 + 改写配置）

```bash
opencode plugin @xiaoqiong0v0/opencode-emotions           # 写入项目 .opencode/ 配置
opencode plugin @xiaoqiong0v0/opencode-emotions --global  # 写入全局配置目录
```

该命令会安装 npm 包，并按包内入口**自动改写**两处配置：server 入口 → `opencode.json(c)` 的 `plugin`，tui 入口 → `tui.json` 的 `plugin`。

### 手动：在配置里写包名

server 插件（情绪命令）——`opencode.json(c)`：

```jsonc
{
  "plugin": ["@xiaoqiong0v0/opencode-emotions"]
}
```

TUI 插件（语音输入 UI + 热键）——`tui.json`：

```jsonc
{
  "plugin": ["@xiaoqiong0v0/opencode-emotions"]
}
```

改完**重启 opencode** 生效。

### 需要先 `npm install` 吗？

不需要。opencode 启动时会按配置里的**包名**自动把插件安装到自己的包缓存（`~/.cache/opencode/packages`）。
`npm install @xiaoqiong0v0/opencode-emotions` 仅在你想在别处直接 `import` 本包时才需要。

### 包内入口如何被解析

- **server 插件** = `package.json` 的 `exports["./server"]`，缺省回退 `main` → `dist/emotions.js`；
- **TUI 插件** = `exports["./tui"]` → `dist/tui.js`。

> 依据（opencode v1.18.25 源码）：`packages/opencode/src/plugin/shared.ts` `resolvePackageEntrypoint()`、`packages/opencode/src/plugin/loader.ts` `resolve()`、`packages/opencode/src/cli/cmd/plug.ts`（`opencode plugin` 按 `exports["./server"]`/`main`/`exports["./tui"]` 判定要写哪些配置）。

## 依赖体积（含 `ffmpeg-static`）

- **`ffmpeg-static`（写在 `dependencies`）**：npm 安装时会**下载**一个预编译 ffmpeg 二进制到 `node_modules/ffmpeg-static`（Windows `ffmpeg.exe` 实测 **≈ 79 MB**），用于语音采集与云 TTS 转码。代价是首次安装的网络流量与磁盘占用；可用环境变量 `FFMPEG_BIN` 指向系统自带 ffmpeg 以绕开随附二进制。
- `ffmpeg-static` 自身按 **GPL-3.0-or-later** 分发（与本包 MIT 许可相互独立）。
- `ws`：ASR/TTS 的 WebSocket 客户端（体积小）。

> 只用情绪命令、不用语音的用户也会因 `dependencies` 拉入 `ffmpeg-static`（opencode 自动安装 `--production` 依赖）。

## 用法：情绪命令

消息以 `/` 触发命令，命令输出即为标注（可接你写的正文）：

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

例：`/angry 需求又改了` → `😡(2/3) 需求又改了`；无参数时只产生标注本身（`/great` → `🤩(3/3)`）。

> 早期的手动符号入口（`!`/`？`/`...`/`666`）已**移除**：语音来源已能自动给出情绪，符号冗余且有误伤（`? 这是什么`、`666 元`）与硬限制（行首半角 `!` 被 shell 模式拦截）。原因与影响见 `docs/changes/设计-情绪输入插件.20261014.md`。

## 语音输入（TUI 插件）

TUI 插件在会话输入框右侧渲染一个状态指示（`🎙 ● 注入 F8/F9`），并用两个**点按**热键控制连续语音输入：

| 热键 | 模式 | 行为 |
|---|---|---|
| `F8` | 注入 | 识别结果作为**新消息**发进当前会话（带 `🎙` 标记 + 情绪标注） |
| `F9` | 输入 | 识别结果**追加进输入框**，由你编辑后发送 |

两模式互斥；都关闭时停止后台语音运行时。ASR 依赖 DashScope 凭证与 ffmpeg，识别出的情绪映射为同一 `emoji(等级/3)` 标注。TUI 槽位/热键的 API **官方未公开**、跨版本可能变（详见 `docs/设计-语音输入注入.md`）。

## 语音输出（`voice_cli` 工具 / `voice-cli` 命令）

由**唯一的 server 插件入口** `emotions`（`dist/emotions.js`）通过 `tool` 钩子提供 **CLI 风格**工具 `voice_cli`（工具定义在 `src/voice/tool.ts`）：模型在用户要求「说出来 / 念出来 / 朗读 / 用语音回答」时主动调用，把文字合成语音并对用户播放。
工具只接受一个参数 `args`（完整 CLI 参数串），内部执行 `node dist/cli/voice-cli.js <args>`（PATH 上找不到 `node` 时回退 `process.execPath`）。

> 为什么由 server 插件提供：`@opencode-ai/plugin/tui` 的 `TuiPluginModule` 声明 `server?: never`，TUI 插件无法注册工具；工具只能由 `{ id, server }` 的 server 插件提供。现与情绪命令**合并进同一个 server 入口**——一个 npm 包只解析一个 server 入口（`exports["./server"]` / `main`），合并后 npm 安装时命令与 `voice_cli` **都生效**。

**`voice_cli` 工具契约**（`args` 为命令串）：

| 子命令 | 说明 |
|---|---|
| `speak --text <t> [--emotion <e>] [--voice <v>] [--rate <n>] [--provider <p>]` | 合成并播放（工具会自动补 `--background`，立即返回、后台播放） |
| `devices` | 列出音频输入设备 |
| `status` | 查看解析后的配置（含 `uiLanguage`/`toolLanguage`） |
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
| `emotions.js` | **唯一 server 插件入口**（情绪命令 + `voice_cli` 工具） | `.opencode/plugin/emotions.js` |
| `tui.js` | TUI 插件入口（由 `src/tui.tsx` 编译） | `.opencode/plugin/tui.js` |
| `cli/voice-cli.js` | CLI（非插件） | `.opencode/plugin/cli/` |
| `runtime/voice-runtime.js` | 语音运行时（非插件） | `.opencode/plugin/runtime/` |
| `lib/**`、`voice/**` | 依赖 | 对应子目录 |

> **顶层只放真插件**：opencode 会把 `.opencode/plugin/` 顶层的**每个 `.js`** 当插件自动 import；CLI、语音运行时等非插件产物一律进子目录（`cli/`、`runtime/`），子目录不被扫描。`publish:proj` **断言顶层只有插件入口**——出现 `voice-cli.js` / `voice-runtime.js` 之类会立即报错退出（防回归）。
> `tui.js` 由**宿主同款 Babel 链**（`babel-preset-solid` + `@babel/preset-typescript`，见 `scripts/build-tui.mjs`）编译：Solid 编译会把 JSX 包成 `createElement` / `insert` / `setProp` + `effect` 的**响应式**结构，而 `tsc` 的 `jsx()` 产物不会包裹 props/children（会失去响应式），故 `.tsx` **不进主 `tsc`**。产物保留裸 `@opentui/solid` / `solid-js` import，由宿主加载时重写为运行时模块 id。
> 语音运行时由 TUI 插件从 `<cwd>/dist/runtime/voice-runtime.js` 启动（可用 `VOICE_RUNTIME_SCRIPT` 覆盖）。
> CLI 路径解析：`VOICE_CLI_SCRIPT`（存在则用）> `<cwd>/dist/cli/voice-cli.js` > 工具模块同级（`dist/voice/` 或镜像后 `.opencode/plugin/voice/`）的 `../cli/voice-cli.js`。

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
| `uiLanguage` | `en` | **TUI UI 文案**语言：`zh` / `en`。用于槽位指示、toast、命令标题（改后重启 opencode 生效）；缺省回退旧键 `language` | `VOICE_UI_LANGUAGE`（旧名 `VOICE_LANGUAGE` 兜底） |
| `toolLanguage` | `en` | **工具文案**语言：`zh` / `en`。用于 `voice_cli` 工具描述（插件加载时本地化）与 `voice-cli --help`；缺省回退旧键 `language` | `VOICE_TOOL_LANGUAGE`（旧名 `VOICE_LANGUAGE` 兜底） |
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

**多语言（i18n）**：文案语言拆为两个独立键——`uiLanguage`（TUI 槽位指示/toast/命令标题）与 `toolLanguage`（**工具描述**，插件加载时本地化 + `voice-cli --help`）；均 `zh` / `en`（内置默认 `en`）。旧键 `language` 向后兼容：新键缺 → 用 `language` → 再缺用 `en`（环境变量同理：`VOICE_UI_LANGUAGE`/`VOICE_TOOL_LANGUAGE` 缺省时旧名 `VOICE_LANGUAGE` 兜底两者）。词表集中在 `src/lib/i18n.ts`（新增语言只需在 `LANGUAGES` 与 `PHRASES` 各加一项，类型会强制补齐全部键）。

**抗噪**：阿里云无独立降噪参数，抗噪主要靠调高 `vad.threshold`（默认已从 0.2 调到 **0.5**）。`asr.language` 留空走服务端自动语种检测，即可多语言。

## 已知限制

- **手动符号入口已移除**：`!!!`/`？？？`/`...`/`666` 不再触发标注；请改用命令（`/angry` 等）。
- 情绪命令需**真正触发命令**（消息以 `/` 开头）才生效；命令不产出额外模型回合。
- **npm 安装会拉入 `ffmpeg-static`（≈79 MB 下载）**，见上文「依赖体积」。

## 开发

```bash
npm install
npm run build        # 清空 dist/ → tsc 编译 src/**（不含 .tsx）→ Babel 链编译 dist/tui.js
npm test             # 构建后跑单元测试（node --test）
npm run publish:proj # build + 镜像 dist/ → .opencode/plugin/（并指向编译后的 tui.js）
```

`publish:proj` 是**本地开发**路径（镜像到本项目 `.opencode/plugin/`，重启 opencode 生效），与下面的 npm 发布是两条互不影响的路径。

### 发布（由维护者执行）

```bash
npm version patch              # 或 minor / major：升 version 并打 git tag
npm publish --access public    # scoped 包必须显式 --access public
```

`prepublishOnly` 会在发布前自动 `npm run build`。发布前可用 `npm pack --dry-run` 校对将入包的产物（本包 `files` = `dist` + `README.md`；`package.json` / `LICENSE` 由 npm 自动带入）。

**产物与发布结构**（顶层只放插件入口，其余进子目录）：

```
dist/
  emotions.js          # 唯一 server 插件入口（源：src/emotions.ts；情绪命令 + voice_cli 工具）
  tui.js               # TUI 插件入口（源：src/tui.tsx，经 Babel 链编译）
  cli/voice-cli.js     # CLI（源：src/cli/voice-cli.ts）
  runtime/voice-runtime.js  # 语音运行时（源：src/runtime/voice-runtime.ts）
  lib/**               # 命令表 / 标注工具 / i18n 等
  voice/**             # 语音能力（含 voice_cli 工具定义 voice/tool.ts）
```

## 许可证

MIT，见 `LICENSE`。`ffmpeg-static` 为独立依赖，按其自身 **GPL-3.0-or-later** 许可分发。
