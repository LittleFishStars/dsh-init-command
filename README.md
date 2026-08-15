# dsh-init-command

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

一个 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 插件：添加 `/init` 斜杠命令，用大模型为当前项目生成 `AGENTS.md`。

`/init` 两阶段调用大模型：

1. **项目分析**：收集项目**两层目录结构**，连同提示词发送给模型，让其判断项目类型与工具链（语言、框架、构建工具等），输出结构化 JSON。
2. **生成 AGENTS.md**：把判断结果与目录结构嵌入提示词（参考 [opencode 的 /init](https://github.com/anomalyco/opencode) 及其 fork [kimi-cli](https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/prompts/init.md)），生成并写入 `AGENTS.md`——要求模型按实际项目内容编写（Project overview、Build and test commands、Code style guidelines、Testing instructions、Security considerations、AI agent guidelines 等小节，并使用项目自身注释/文档的主要语言）。其中 **AI agent guidelines** 小节强制包含一条规则：**每次完成任务后修正 AGENTS.md**，让文件随项目演进保持准确。

## 功能

- **两阶段 LLM 生成**：先判断、后生成，判断结果作为上下文嵌入生成提示词，避免模型凭空猜测
- **阶段二显示思考过程、隐藏最终输出**：生成阶段默认只转发模型的 reasoning 流块（思考过程实时可见），`AGENTS.md` 正文直接写入文件、不进入会话；`--dry-run` 时完整流式预览
- **阶段一默认不思考**：分类任务简单，默认以 `reasoningEffort: 'off'` 关闭思考模式（仅当路由模型支持时才传参），更快更省 token；需要思考时加 `--think`
- **两层目录结构**：自动收集项目根目录及每个子目录的条目（过滤 `.git`、`node_modules` 等噪音，超限自动折叠），作为模型判断的依据；`--depth` 可调深度（`-1` 不限制），`--ignore` 可额外跳过指定条目
- **已存在直接替换**：`AGENTS.md` 已存在时直接覆盖，旧内容提供给模型作为改写参考
- **`--git` 初始化仓库**：仓库不存在时 `git init`、默认分支 `master` → `main`、按项目类型从 [github/gitignore](https://github.com/github/gitignore) 下载 `.gitignore`（已存在不覆盖；无匹配模板时跳过并说明）
- **`--commit` 初始提交**：生成后创建初始 git 提交（隐式启用 `--git`）
- **模型路由自动回退**：插件配置 → 会话最近一次请求 → agent 选项
- **零依赖、无需构建**：仅使用 Node 内置模块，可从源码、`--patch` 覆盖层或 npm/git 安装加载；命令注册是 Cordis effect，插件卸载时自动注销

## 安装

### 方式一：作为 bundle 安装（推荐）

在包含本插件目录的路径下执行：

```sh
dsh plugin --profile <profile-name> add ./dsh-init-command
```

DSH 会把插件作为 bundle 装入 profile（`dsh.profile.bundles`），插件行由包内的 `cordis.patch.yml` 提供。验证并启动：

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

三者都不可用时，`/init` 返回明确错误，不会调用模型。

## 使用

在 DSH Web UI 或任意命令适配器的输入框中输入：

| 命令 | 行为 |
| --- | --- |
| `/init` | 两阶段调用模型，在工作区根目录生成或替换 `AGENTS.md`（已存在时直接覆盖，旧内容作为改写参考）；阶段二默认显示思考过程、正文直接写入文件，会话中追加完成信息与成功状态消息；阶段一默认关闭思考模式 |
| `/init --dry-run` | 调用模型生成内容但不写文件，两阶段完整流式预览 |
| `/init --think` | 阶段一（项目分析）改用模型的思考模式；默认不思考（更快更省 token） |
| `/init --git` | 生成 `AGENTS.md` 后额外执行 git 初始化：仓库不存在时 `git init`、默认分支 `master` → `main`、按项目类型从 [github/gitignore](https://github.com/github/gitignore) 下载 `.gitignore`（已存在时不覆盖） |
| `/init --commit` | 生成 `AGENTS.md` 后创建初始 git 提交（隐式启用 `--git`）；未配置 git 身份时只提示、不失败 |
| `/init --depth <n>` | 目录树收集深度：`1` 仅顶层、`2` 两层（默认）、`-1` 不限制 |
| `/init --ignore <pattern>` | 额外跳过名字匹配的条目（可重复使用或用逗号分隔多个） |
| `/init --help` | 显示用法与全部参数说明（`-h` 亦可） |
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

## 会话可见性

- **阶段一（项目分析）完整显示**：提示词以插件注入的 `notice` 上下文进入对话流（GUI 渲染为可折叠行：默认收起显示一行摘要、点击展开全文），发送给模型的也正是这段文本；模型的每个流块（正文与 reasoning）实时转发为 `assistant/chunk` 事件，GUI 按帧渲染，效果与思考过程一致
- **阶段二（生成）只显示思考过程**：阶段二提示词同样为可折叠 notice 行；reasoning 流块实时转发可见，text 流块被过滤、不追加最终 `assistant/message`——`AGENTS.md` 正文不进入会话、直接写入文件；成功后追加完成信息（notice 折叠行：路径、字符数）与一条形如模型输出的成功状态消息；`--dry-run` 时与阶段一一样完整显示
- **全程可追溯**：提示词、流块、token 用量、完成信息、成功状态均为标准会话事件，随会话持久化、重启后安全加载；两次调用记录（阶段、路由、提示词摘要、结果）随命令结果（`command/done`）写入对话历史。事件类型全部位于会话恢复白名单 `KNOWN_SESSION_EVENT_TYPES` 内——直接 `session.append()` 自定义事件类型会被恢复路径拒绝加载
- **实现细节**：合成显示只写 step 层事件、不写 `turn/start`/`turn/end`——正数 turn 会与 agent 循环的编号冲突，turn 0 的 `turn/end` 又会被会话持久化读取路径拒绝（`turn < 1` 视为 malformed pre-react-loop）；固定 turn 0 + 递增 step 两全，多次 `/init` 互不冲突

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
