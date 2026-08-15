/**
 * dsh-init-command — DSH 插件，提供 `/init` 斜杠命令。
 *
 * `/init` 两阶段调用大模型为当前项目生成 `AGENTS.md`：
 *   1. 项目分析：发送两层目录结构，让模型判断项目类型与工具链（JSON）。
 *   2. 生成：把判断结果与目录结构嵌入提示词，生成 AGENTS.md 并写入工作区
 *      （提示词参考 opencode 的 /init 命令）。
 *
 * 已存在的 AGENTS.md 直接替换（旧内容作为改写参考）；`--dry-run` 只预览不写入。
 *
 * 可见性：阶段一实时流式显示（提示词为可折叠 notice 行，流块逐帧转发）；
 * 阶段二默认只显示思考过程（reasoning 流块实时可见，最终输出不进入会话），
 * 成功后追加完成信息 notice 与一条形如模型输出的成功状态消息，
 * `--dry-run` 时完整显示。
 *
 * 合成显示只写 step 层事件、不写 turn 边界：正数 turn 会与 agent 循环的
 * 编号冲突，turn 0 的 turn/end 又会被会话持久化读取路径拒绝加载；固定
 * turn 0 + 递增 step 两全（详见 lib/model.js 的 INIT_TURN）。所有事件类型
 * 都在会话恢复白名单内。
 *
 * 运行时零依赖（仅 Node 内置模块），无需构建即可从源码 / --patch / npm 加载。
 *
 * 用法：/init [--dry-run] [--git] [--commit] [--think] [--depth <n>] [--ignore <pattern>]
 *   --dry-run          预览将生成的 AGENTS.md 而不写入
 *   --git              额外 git 初始化：仓库不存在时 init、master → main、
 *                      按项目类型下载 github/gitignore 模板（已存在不覆盖）
 *   --commit           创建初始提交（隐式启用 --git）
 *   --think            阶段一改用思考模式（默认 reasoningEffort 'off'，更快更省 token）
 *   --depth <n>        目录树深度：1 = 仅顶层，2 = 两层（默认），-1 = 不限制
 *   --ignore <pattern> 额外跳过名字匹配的条目（可重复或逗号分隔）
 *
 * 模型路由（按优先级）：插件 config → 会话最近一次请求 → agent.options。
 *
 * 代码拆分：lib/tree.js（目录树）、lib/prompts.js（提示词）、
 * lib/model.js（LLM 调用与会话显示）、lib/gitignore.js（模板匹配/下载）、
 * lib/git.js（git 步骤）、lib/init.js（主流程）。
 */

import { executeInit } from './lib/init.js'
import { PLUGIN_NAME } from './lib/model.js'

export const name = PLUGIN_NAME

/** 必需服务：人类命令注册表 + LLM 服务。 */
export const inject = ['commands', 'llm']

/** 注册 `/init`；返回 register 的卸载函数（Cordis effect 约定）。 */
export function apply(ctx, config) {
  return ctx.commands.register({
    name: 'init',
    description: 'Generate an AGENTS.md guide for this project with the model',
    input: { hint: '[--dry-run] [--git] [--commit] [--think] [--depth <n>] [--ignore <pattern>]' },
    handler: invocation => executeInit(ctx, config, invocation),
  })
}

// —— 公共 API 再导出（保持单文件时代的外部接口不变）——

export { collectTree } from './lib/tree.js'
export {
  parseClassifiedJson,
  normalizeClassified,
  promptLineCount,
} from './lib/prompts.js'
export {
  INIT_TURN,
  nextInitStep,
  createAssembler,
  streamModelStage,
  resolveRoute,
} from './lib/model.js'
export { gitignoreTemplate, downloadGitignore } from './lib/gitignore.js'
export { renameMasterToMain, ensureGitRepo, applyGitSteps, commitInitial } from './lib/git.js'
