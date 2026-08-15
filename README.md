# dsh-init-command

一个 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 插件，添加 `/init` 斜杠命令，用大模型为当前项目生成 `AGENTS.md` 文件。

`/init` 采用两阶段模型调用：

1. **项目分析**：插件收集项目**两层目录结构**，连同分析提示词一起发送给大模型，让模型判断项目类型与使用的工具链（语言、框架、构建工具等），输出结构化 JSON。
2. **生成 AGENTS.md**：把判断结果（项目类型、语言、工具链、一句话简介）与两层目录结构嵌入提示词，再次调用大模型生成 `AGENTS.md` 内容并写入工作区。这一步的提示词参考了 [opencode 的 /init 命令](https://github.com/anomalyco/opencode)（其 fork [kimi-cli 的 init 提示词](https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/prompts/init.md)），要求模型按实际项目内容编写，包含 Project overview、Build and test commands、Code style guidelines、Testing instructions、Security considerations、AI agent guidelines 等小节，并使用项目自身注释/文档的主要语言。其中 **AI agent guidelines** 小节强制包含一条规则：**每次完成任务后修正 AGENTS.md**，让文件随项目演进保持准确。

### 会话可见性（阶段一实时显示，阶段二默认显示思考过程、隐藏最终输出）

- **阶段一（项目分析）始终实时显示**：提示词以一条 user 消息进入对话流，来源标记为插件注入的 `notice` 上下文——GUI 渲染为可折叠行：默认收起只显示一行摘要（阶段与行数），点击展开完整提示词；发送给模型的也正是这段文本，在模型侧与用户输入地位完全一致。模型的每个流块（正文与 reasoning）逐块转发为 `assistant/chunk` 事件，GUI 按帧实时渲染，效果与思考过程一致
- **阶段二（AGENTS.md 生成）默认只显示思考过程**：阶段二提示词同样以可折叠 notice 行进入会话，模型的 **reasoning 流块实时转发可见**（思考过程一目了然），但 `AGENTS.md` 的正文输出不进入会话日志——text 流块被过滤、也不追加最终 `assistant/message`，内容直接写入文件；生成成功后追加一条完成信息（notice 折叠行：路径、字符数）与一条形如模型正式输出的成功状态消息（`assistant/message` 呈现，文本由插件合成：文件、字符数、项目类型与 `--dry-run` 预览提示）；只有 `--dry-run` 时才与阶段一一样完整流式显示正文，便于预览
- **全程可追溯**：阶段一的提示词、输出、token 用量与阶段二的提示词、思考过程、完成信息、成功状态消息以标准会话事件呈现；调用记录（阶段、路由、提示词摘要、结果）随命令结果持久化，重启后依旧安全加载（全部事件类型都在会话恢复白名单 `KNOWN_SESSION_EVENT_TYPES` 内）

实现上，合成显示只写 step 层事件，**不写 `turn/start`/`turn/end`**：agent 循环在构造时读取日志中最近一次 `turn/start` 并在内存中缓存自己的下一轮编号（`lastTurn + 1`），运行中按该计数分配、不回头读取日志，任何正数 turn 都可能与后续 agent 回合冲突；而 turn 0 的 `turn/end` 会被会话持久化读取路径按旧格式损坏拒绝（`turn < 1` 一律视为 malformed pre-react-loop turn/end），导致重启后历史无法加载。不写 turn 边界则两全：step 仍以固定 turn 0 作为坐标（GUI 按 step 渲染流式输出），持久化读取路径不出现任何 turn 事件，重启后依旧安全加载。step 随每次调用递增（1,2 → 3,4 …），多次 `/init` 互不冲突。

## 功能

- **两阶段 LLM 生成**：先判断、后生成，判断结果作为上下文嵌入生成提示词，避免模型凭空猜测项目类型
- **阶段一默认不思考**：项目分类任务简单，默认以 `reasoningEffort: 'off'` 关闭思考模式，更快更省 token（仅当路由模型支持时才传参，不支持思考开关的模型保持其默认行为）；需要思考时加 `--think`
- **默认直接写文件**：阶段二（生成）默认只显示思考过程，`AGENTS.md` 正文不输出到对话、直接写入工作区，会话中追加完成信息与成功状态消息；`--dry-run` 时正文完整流式预览
- **阶段一实时流式显示**：项目分析的提示词以可折叠的上下文行呈现（默认收起显示一行摘要，点击展开完整提示词），模型的流块逐块实时转发，GUI 按帧渲染——效果与思考过程一致，全程可见
- **两层目录结构**：自动收集项目根目录及每个子目录的条目（过滤 `.git`、`node_modules` 等噪音，超限自动折叠），作为模型判断的依据
- **已存在直接替换**：`AGENTS.md` 已存在时直接覆盖（旧内容会提供给模型作为改写参考，只保留仍准确的部分），无需额外参数
- **`--dry-run` 预览**：调用模型生成内容但不写文件，可先查看 `/init` 会写入什么
- **`--git` 初始化仓库**：生成 `AGENTS.md` 后额外执行 git 初始化——仓库不存在时 `git init`；默认分支为 `master` 时重命名为 `main`；按项目类型从 [github/gitignore](https://github.com/github/gitignore) 下载合适的 `.gitignore`（已存在时不覆盖；无匹配模板时跳过并说明）
- **模型调用写入对话历史**：阶段一的完整对话（提示词、流式输出、token 用量）与阶段二的提示词、思考过程、完成信息、成功状态消息作为标准会话事件持久化，重启后安全加载；两次调用随命令结果（`command/done` 事件）附带摘要（阶段、provider/model、提示词行数与首行摘要、模型结果）。事件类型全部位于会话恢复白名单（`KNOWN_SESSION_EVENT_TYPES`）内——直接 `session.append()` 自定义事件类型会被会话恢复路径拒绝加载，而仓库外插件无法把自定义类型注册进白名单
- **模型路由自动回退**：插件配置 → 会话最近一次请求 → agent 选项
- **零依赖**：插件只使用 Node 内置模块，通过 `ctx.llm.stream()` 服务调用模型，无需构建即可从源码、`--patch` 覆盖层或 npm/git 安装加载
- **生命周期正确**：命令注册是 Cordis effect，插件卸载时 `/init` 自动注销

## 安装

### 方式一：作为 bundle 安装（推荐）

在包含本插件目录的路径下执行：

```sh
dsh plugin --profile <profile-name> add ./dsh-init-command
```

DSH 会把它作为 bundle 装入 profile（`dsh.profile.bundles`），插件行由包内的 `cordis.patch.yml` 提供。验证并启动：

```sh
dsh --profile <profile-name> --dump-config   # 应出现 "# == dsh-init-command" 层
dsh --profile <profile-name>
```

也可以先 `pnpm pack` 生成 tarball 后 `dsh plugin --profile <name> add ./dsh-init-command-0.1.0.tgz`，或发布到 npm 后按包名安装。

### 方式二：本地 patch 加载

从 DSH 源码仓库运行时，可直接用 `--patch` 挂载本插件的源码（路径需为绝对路径）：

```sh
pnpm dsh web --patch /path/to/dsh-init-command/cordis.patch.yml
```

如果直接引用插件文件而非 bundle 包名，把 `cordis.patch.yml` 中的 `name: dsh-init-command` 改成插件文件的绝对路径（如 `/path/to/dsh-init-command/index.js`）。

## 配置

`/init` 需要可用的模型路由，按以下优先级解析（满足其一即可）：

1. 插件行的 `config`（推荐，最明确）：

   ```yaml
   # cordis.patch.yml 或 profile 的 patch 层
   - insert:
       - id: init
         name: dsh-init-command
         config:
           provider: deepseek
           model: deepseek-chat
   ```

2. 会话最近一次请求使用的 provider/model（`session.requestHeader().config`）
3. agent 选项（`agent.options.provider` / `agent.options.model`）

三者都不可用时，`/init` 会返回明确错误，不会调用模型。

## 使用

在 DSH Web UI 或任意命令适配器的输入框中输入：

| 命令 | 行为 |
| --- | --- |
| `/init` | 两阶段调用模型，在工作区根目录生成或替换 `AGENTS.md`（已存在时直接覆盖，旧内容作为改写参考）；阶段二默认显示思考过程、正文直接写入文件，会话中追加完成信息与成功状态消息（完整内容用 `--dry-run` 预览）；阶段一默认关闭思考模式 |
| `/init --dry-run` | 调用模型生成内容但不写文件，两阶段完整流式预览 |
| `/init --think` | 阶段一（项目分析）改用模型的思考模式；默认不思考（更快更省 token） |
| `/init --git` | 生成 `AGENTS.md` 后额外执行 git 初始化：仓库不存在时 `git init`、默认分支 `master` → `main`、按项目类型从 [github/gitignore](https://github.com/github/gitignore) 下载 `.gitignore`（已存在时不覆盖） |
| `/init --git --dry-run` | 组合使用：只提示将做什么（初始化仓库、下载哪个模板），不执行任何写入 |

示例输出（`--git`）：

```
Initialized /home/user/project/AGENTS.md (Node.js web application). Review the generated AGENTS.md and adjust it to your conventions.

Git: initialized a new git repository; renamed the default branch master → main; downloaded .gitignore from github/gitignore (Node)

Model calls:
1. classify — deepseek/deepseek-chat — prompt: 14 lines (You are a senior software engineer analyzing a repo...) — result: Node.js web application [JavaScript] [npm]
2. generate — deepseek/deepseek-chat — prompt: 26 lines (You are a software engineering expert...) — result: AGENTS.md (1234 chars)
```

生成的文件是模型的初稿：命令、目录结构等信息均来自两层目录结构，请审阅后按项目实际约定调整。

## 目录结构

```
dsh-init-command/
├── package.json            # npm 清单，声明 dsh.bundle（patch 层）
├── cordis.patch.yml        # 插入插件行的 patch 层
├── index.js                # 插件入口：注册 /init，再导出公共 API
├── lib/
│   ├── tree.js             # 两层目录树收集与文件存在性检查
│   ├── prompts.js          # 两阶段提示词、分类解析、调用记录格式化
│   ├── model.js            # LLM 流式调用与会话可见性（组装器、路由、step 显示）
│   ├── gitignore.js        # .gitignore 模板匹配与下载（node:https + 系统 CA 回退）
│   ├── git.js              # --git 步骤（仓库初始化、master → main、落盘）
│   └── init.js             # /init 主流程（两阶段调用、写入 AGENTS.md）
├── scripts/
│   └── smoke-loader.mjs    # 真实 Loader 组合冒烟测试（需要 DSH 源码环境）
├── test/
│   └── init.test.js        # 单元测试（node:test，零依赖，mock LLM 服务）
└── README.md
```

## 开发与测试

单元测试（无需 DSH 仓库，LLM 服务为 mock）：

```sh
npm test
```

冒烟测试（在已构建 `lib/` 产物的 DSH 源码检出上运行，验证插件在真实 Cordis Loader 组合中工作；LLM 服务为 `Service` 子类 fake，agent/session/commands 均为真实实现）：

```sh
mkdir -p node_modules && ln -s <harness>/packages/feedback/command-feedback/node_modules node_modules
node scripts/smoke-loader.mjs
rm node_modules   # 该符号链接仅用于测试，不属于发布内容
```

## AI 声明

- 本项目（代码与文档，含本 README）在开发过程中使用了 AI 辅助编程工具（如 DeepSeek Harness）协助编写，并经过人工审阅与调整。
- 本插件通过 `/init` 生成的所有 `AGENTS.md` 内容均为大模型输出（模型初稿）：其中命令、目录结构等信息来自项目实际的两层目录结构，请在审阅后按项目实际约定调整再使用。

## 许可证

MIT，见 [LICENSE](./LICENSE)。
