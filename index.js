/**
 * dsh-init-command — DSH 插件，提供 `/init` 斜杠命令。
 *
 * `/init` 通过两阶段大模型调用为当前项目生成 `AGENTS.md`：
 *
 *   1. 收集项目两层目录结构，作为第一条消息发送给大模型，让其判断
 *      项目类型与使用的工具链（输出结构化 JSON）。
 *   2. 把判断结果（项目类型、语言、工具链）与目录结构一起嵌入提示词
 *      再次调用大模型（提示词参考 opencode 的 /init 命令），生成
 *      `AGENTS.md` 内容并写入工作区。
 *
 * `AGENTS.md` 已存在时直接替换（旧内容会提供给模型作为改写参考）；
 * `--dry-run` 只预览生成内容而不写入。
 *
 * 生成内容在会话中的可见性：
 *
 *   - 阶段一（项目分析）始终实时写入会话日志，在 GUI 中像普通对话一样
 *     实时显示：提示词以 `user/message` 事件追加，来源标记为插件注入的
 *     `notice` 上下文——GUI 渲染为可折叠行：默认收起，只显示一行摘要
 *     （阶段与行数），点击展开完整提示词；发送给模型的也正是这段文本，
 *     角色同为 user，在模型侧与用户输入地位完全一致；模型的每个流块
 *     （text / reasoning）实时转发为 `assistant/chunk` 事件，GUI 按帧
 *     实时渲染，效果与思考过程一致；结束（或失败）后追加
 *     `assistant/message`、`step/end`；默认关闭思考模式
 *     （`reasoningEffort: 'off'`，仅当路由模型支持时，见
 *     {@link supportsReasoningEffort}），`--think` 恢复提供方默认行为；
 *   - 阶段二（AGENTS.md 生成）默认只输出完成信息：模型输出以
 *     silent 模式（见 {@link streamModelStage}）运行，不追加提示词、
 *     流块等会话事件，`AGENTS.md` 内容直接写入文件；生成成功后追加
 *     一条完成信息 notice 与一条形如模型正式输出的成功状态消息
 *     （见 {@link appendCompletionNotice}），让阶段二在会话中也有
 *     可见输出；只有 `--dry-run` 时才与阶段一一样完整显示，便于预览。
 *
 * 合成显示只写 step 层事件，不写 `turn/start`/`turn/end`：agent 循环在
 * 构造时读取日志中最近一次 `turn/start` 并在内存中缓存自己的下一轮
 * 编号（lastTurn + 1），运行中按该计数分配、不回头读取日志，因此任何
 * 正数 turn 都可能与后续 agent 回合冲突；而 turn 0 的 `turn/end` 会被
 * 会话持久化读取路径按旧格式损坏拒绝（`turn < 1` 一律视为 malformed
 * pre-react-loop turn/end），导致重启后历史无法加载。不写 turn 边界则
 * 两全：step 仍以固定 turn 0 作为坐标（GUI 按 step 渲染流式输出），
 * 持久化读取路径不出现任何 turn 事件，重启后依旧安全加载。step 随
 * 每次调用递增（1,2 → 3,4 …），多次 `/init` 互不冲突。所有事件类型
 * 都在会话恢复白名单（`KNOWN_SESSION_EVENT_TYPES`）内。
 *
 * 本模块运行时零依赖（仅使用 Node 内置模块）：LLM 调用通过
 * `ctx.llm.stream()` 服务完成，消息与流块按 `@deepseek-ai/dsh-llm` 的
 * 词汇结构手写构造，因此该 bundle 从源码、`--patch` 覆盖层或 npm/git
 * 安装加载都无需任何构建步骤。
 *
 * 用法：
 *   /init             生成 AGENTS.md（已存在时直接替换，旧内容作为改写参考）；
 *                     会话中显示完成信息与成功状态，完整内容仅 --dry-run 可见
 *   /init --dry-run   预览将生成的 AGENTS.md 而不写入
 *   /init --think     阶段一（项目分析）使用思考模式；默认不思考
 *                     （reasoningEffort 'off'，分类更快更省 token）
 *   /init --git       额外执行 git 初始化：仓库不存在时 `git init`、默认
 *                     分支为 master 时重命名为 main、按项目类型从
 *                     github/gitignore 下载合适的 .gitignore（已存在时
 *                     不覆盖）；与 --dry-run 组合时只提示将做什么。
 *
 * 模型路由（按优先级）：插件 config.provider/model → 会话最近一次请求
 * 使用的 provider/model → agent.options.provider/model。
 */

import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { get as httpsGet } from 'node:https'
import path from 'node:path'
import { promisify } from 'node:util'

export const name = 'dsh-init-command'

/** 必需服务：人类命令注册表 + LLM 服务。 */
export const inject = ['commands', 'llm']

const USAGE = 'Usage: /init [--dry-run] [--git] [--think]'

/** 目录树中跳过的顶层条目。 */
const TREE_IGNORE = new Set(['.git', 'node_modules', '.DS_Store'])

/** 顶层最多列出的条目数，超出部分折叠为计数行。 */
const MAX_TOP_LEVEL_ENTRIES = 120
/** 每个子目录最多列出的条目数，超出部分折叠为计数行。 */
const MAX_DIR_ENTRIES = 40

/**
 * /init 合成显示使用的坐标 turn 编号。合成显示只写 step 层事件，不写
 * `turn/start`/`turn/end`：agent 循环在构造时读取日志中最近一次
 * `turn/start` 并在内存中缓存自己的下一轮编号（lastTurn + 1），运行中
 * 按该计数分配、不回头读取日志，任何正数 turn 都可能与后续 agent 回合
 * 冲突；而 turn 0 的 `turn/end` 会被会话持久化读取路径按旧格式损坏
 * 拒绝（`turn < 1` 一律视为 malformed pre-react-loop turn/end），导致
 * 重启后历史无法加载。因此不写 turn 边界事件，只以固定 turn 0 作为
 * step 层事件的坐标（step 号见 {@link nextInitStep}），多次调用之间
 * 互不冲突。
 */
export const INIT_TURN = 0

/**
 * 计算下一次 /init 可用的 step 号：turn 0 中已出现过的最大 step + 1。
 * 首次调用为 1，第二次调用为 3，依此类推。
 * @param {object} session - 接收命令的 agent 的会话。
 * @returns {number} 下一个可用的 step 号。
 */
export function nextInitStep(session) {
  let max = 0
  for (const event of session.events) {
    if (event.type === 'step/end' && event.data.turn === INIT_TURN && event.data.step > max) {
      max = event.data.step
    }
  }
  return max + 1
}

/**
 * 递归收集两层目录树（第一层全部条目 + 每个子目录的第二层条目），
 * 返回文本行数组。
 * @param {string} root - 项目目录。
 * @returns {Promise<string[]>} 树的行文本（目录以 `/` 结尾）。
 */
export async function collectTree(root) {
  const lines = [path.basename(root) + '/']
  const top = await listEntries(root, MAX_TOP_LEVEL_ENTRIES)
  for (const entry of top) {
    lines.push(entry.isDirectory ? `${entry.name}/` : entry.name)
    if (!entry.isDirectory) continue
    const children = await listEntries(path.join(root, entry.name), MAX_DIR_ENTRIES)
    for (const child of children) lines.push(`  ${child.isDirectory ? `${child.name}/` : child.name}`)
  }
  return lines
}

/**
 * 列出目录条目（排序、过滤噪音与隐藏项、按上限折叠）。
 * @param {string} dir - 目录路径。
 * @param {number} max - 最多返回的条目数。
 * @returns {Promise<Array<{ name: string, isDirectory: boolean }>>} 条目列表。
 */
async function listEntries(dir, max) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const visible = entries
    .filter(entry => !TREE_IGNORE.has(entry.name) && !entry.name.startsWith('.'))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(entry => ({ name: entry.name, isDirectory: entry.isDirectory() }))
  if (visible.length <= max) return visible
  return [...visible.slice(0, max), { name: `… (${visible.length - max} more entries)`, isDirectory: false }]
}

/**
 * 构造一条 user 角色消息（与 `@deepseek-ai/dsh-llm` 的 Message 形状一致）。
 * @param {string} text - 消息文本。
 * @returns {{ id: string, role: 'user', content: Array<{ type: 'text', text: string }>, source: { kind: 'plugin', plugin: string } }}
 */
function userMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'dsh-init-command' },
  }
}

/**
 * 与 `@deepseek-ai/dsh-llm` 的 `BlockAssembler` 语义一致的迷你组装器
 * （零依赖手写）：按流顺序累积内容块，容忍只有 delta 的协议。
 * @returns {{
 *   push(chunk: object): void,
 *   text(): string,
 *   blocks(): Array<object>,
 *   usage: object | undefined,
 *   finish: { kind: string },
 * }}
 */
export function createAssembler() {
  const partials = new Map()
  const order = []
  let usage
  let finish
  const ensure = (index, blockType) => {
    let partial = partials.get(index)
    if (partial === undefined) {
      partial = { blockType, text: '', toolCallId: undefined, toolCallName: undefined, toolCallArguments: '', block: undefined }
      partials.set(index, partial)
      order.push(index)
    }
    return partial
  }
  return {
    push(chunk) {
      switch (chunk.type) {
        case 'block-start': {
          if (!partials.has(chunk.index)) {
            order.push(chunk.index)
            partials.set(chunk.index, { blockType: chunk.blockType, text: '', toolCallArguments: '', block: undefined })
          }
          return
        }
        case 'text-delta':
        case 'reasoning-delta': {
          const partial = ensure(chunk.index, chunk.type === 'text-delta' ? 'text' : 'reasoning')
          if (partial.block) return
          partial.text += chunk.text
          return
        }
        case 'tool-call-delta': {
          const partial = ensure(chunk.index, 'tool-call')
          if (partial.block) return
          partial.toolCallId = chunk.id
          if (chunk.name !== undefined) partial.toolCallName = chunk.name
          partial.toolCallArguments += chunk.argumentsDelta
          return
        }
        case 'block-end': {
          const partial = ensure(chunk.index, chunk.block.type)
          if (partial.block) return
          partial.block = chunk.block
          return
        }
        case 'usage':
          usage = chunk.usage
          return
        case 'finish':
          finish = chunk.reason
          return
      }
    },
    /** 全部 text 块的拼接文本（不含 reasoning），与旧 `collectText` 一致。 */
    text() {
      return order
        .map(index => partials.get(index))
        .filter(partial => partial.blockType === 'text')
        .map(partial => partial.text)
        .join('')
    },
    /** 按流顺序组装完整内容块（text / reasoning / tool-call）。 */
    blocks() {
      return order.map((index) => {
        const partial = partials.get(index)
        if (partial.block) return partial.block
        switch (partial.blockType) {
          case 'text': return { type: 'text', text: partial.text }
          case 'reasoning': return { type: 'reasoning', text: partial.text }
          case 'tool-call': return {
            type: 'tool-call',
            id: partial.toolCallId ?? `call-${index}`,
            name: partial.toolCallName ?? '',
            arguments: partial.toolCallArguments,
          }
          default: throw new Error(`cannot assemble incomplete block of type "${partial.blockType}"`)
        }
      })
    },
    get usage() { return usage },
    get finish() { return finish ?? { kind: 'stop' } },
  }
}

/**
 * 把终止原因转换为错误消息；正常终止（stop）返回 undefined。
 * @param {{ kind: string, failure?: { message?: string } } | undefined} finish - 终止原因。
 * @param {boolean} [tolerateTruncation] - 为 true 时 `max-tokens` 截断不视为
 *   失败（调用方用已收集的文本继续，例如分类阶段解析 JSON）。
 * @returns {string | undefined} 错误消息，正常时返回 undefined。
 */
function finishError(finish, tolerateTruncation = false) {
  if (finish === undefined) return 'the model stream ended without a finish reason'
  switch (finish.kind) {
    case 'stop':
      return undefined
    case 'aborted':
      return 'Init cancelled.'
    case 'max-tokens':
      return tolerateTruncation
        ? undefined
        : 'the model output was truncated by its token limit; writing an incomplete AGENTS.md is not useful, retry /init'
    case 'tool-calls':
      return 'the model unexpectedly requested a tool call'
    case 'error':
      return finish.failure?.message ?? 'the model call failed'
    default:
      return `the model call ended with unknown reason "${String(finish.kind)}"`
  }
}

/**
 * 执行一次 LLM 调用并把全过程实时写入会话日志，返回完整文本。
 * `silent` 模式下不写入任何会话事件（见下方 options）。
 *
 * 事件顺序（与 agent 循环一致，silent 模式下全部跳过）：
 * `step/start` → `user/message`（提示词，来源为插件注入的
 * `notice` 上下文，GUI 折叠显示一行摘要、点击展开完整提示词）→
 * `assistant/chunk`*（逐块实时转发，GUI 按帧渲染，如同思考过程）→
 * `assistant/message`（正常终止时，携带 usage 与来源 chunk 序号）→
 * `step/end`。
 *
 * 合成显示不写 `turn/start`/`turn/end`（见 {@link INIT_TURN} 的说明）：
 * turn 0 的 `turn/end` 会被会话持久化读取路径按旧格式损坏拒绝，任何
 * 正数 turn 又可能与 agent 循环自己的编号冲突；只写 step 层事件即可
 * 完整驱动 GUI 的流式渲染，且重启后历史安全加载。调用失败（流错误、
 * 中止、抛异常）时不追加 `assistant/message`，只关闭 step：已流出的
 * 部分在 GUI 中按 interrupted 渲染，错误原因进入命令结果文本。
 *
 * @param {object} ctx - Cordis 上下文（携带 llm 服务）。
 * @param {object} session - 接收命令的 agent 的会话（`invocation.agent.session`）。
 * @param {object} invocation - 命令调用负载（提供 signal）。
 * @param {{ provider: string, model: string }} route - 模型路由。
 * @param {number} step - 本次调用在 turn 0 中的 step 号（见 {@link nextInitStep}）。
 * @param {string} prompt - 发送给模型的 user 消息文本（同时以可折叠上下文行显示）。
 * @param {{ label?: string, temperature?: number, reasoningEffort?: string, tolerateTruncation?: boolean, silent?: boolean }} [options] -
 *   `label` 用于折叠行的摘要（阶段说明），`temperature` 与 `reasoningEffort`
 *   为附加调用参数（`reasoningEffort` 例如 `'off'` 可关闭思考模式），
 *   `tolerateTruncation` 为 true 时 max-tokens 截断不视为失败；`silent`
 *   为 true 时完全不写会话日志——不追加提示词、
 *   流块与 step 开合事件，调用静默执行，返回文本由调用方直接使用（例如
 *   写入文件），默认 /init 的生成阶段即此模式；该模式下调用方通常在
 *   成功后自行追加一条完成信息（见 {@link appendCompletionNotice}），
 *   让阶段二在会话中仍有可见输出。
 * @returns {Promise<{ text: string, blocks: Array<object>, usage?: object, finish: { kind: string } }>} 模型输出。
 */
export async function streamModelStage(ctx, session, invocation, route, step, prompt, options = {}) {
  const { label = 'Init', temperature, reasoningEffort, tolerateTruncation = false, silent = false } = options
  // silent 模式：不向会话日志追加任何事件（提示词、流块、step 开合），
  // 调用在会话中完全不可见，只有返回文本与调用记录（命令结果）可追溯。
  const visible = !silent
  if (visible) {
    session.append('step/start', { turn: INIT_TURN, step })
    // 提示词以插件注入的 notice 上下文进入对话流：GUI 默认折叠为一行摘要，
    // 点击展开完整提示词；发送给模型的也正是这段文本（见下方 llm.stream
    // 的 messages），在模型侧与用户输入地位完全一致。
    session.append('user/message', {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: prompt }],
      source: {
        kind: 'plugin',
        plugin: 'dsh-init-command',
        form: 'notice',
        summary: `${label}（${promptLineCount(prompt)} 行）`,
      },
    }, { surfaceOp: 'append' })
  }
  const assembler = createAssembler()
  const chunkSeqs = []
  let finish
  let thrown
  try {
    const stream = ctx.llm.stream({
      provider: route.provider,
      model: route.model,
      messages: [userMessage(prompt)],
      ...temperature === undefined ? {} : { temperature },
      ...reasoningEffort === undefined ? {} : { reasoningEffort },
      ...invocation.signal === undefined ? {} : { signal: invocation.signal },
    })
    for await (const chunk of stream) {
      // 实时转发：每个 chunk 作为 assistant/chunk 事件追加，GUI 收到后
      // 立即按帧渲染，效果与思考过程的实时输出一致。
      if (visible) {
        chunkSeqs.push(session.append('assistant/chunk', { turn: INIT_TURN, step, chunk }).seq)
      }
      assembler.push(chunk)
    }
    finish = assembler.finish
    // 正常终止（stop / max-tokens）时组装最终 assistant 消息；错误与中止
    // 只留下流式块，GUI 依据 step/end 边界把已输出部分渲染为 interrupted。
    if (visible && (finish?.kind === 'stop' || finish?.kind === 'max-tokens')) {
      session.append('assistant/message', {
        turn: INIT_TURN,
        step,
        message: {
          id: randomUUID(),
          role: 'assistant',
          content: assembler.blocks(),
          source: { kind: 'model', provider: route.provider, model: route.model },
        },
        ...assembler.usage === undefined ? {} : { usage: assembler.usage },
      }, { surfaceOp: 'append', sourceEventSeqs: chunkSeqs })
    }
  } catch (error) {
    thrown = error
  } finally {
    if (visible) {
      session.append('step/end', { turn: INIT_TURN, step })
    }
  }
  if (thrown !== undefined) throw thrown
  const error = finishError(finish, tolerateTruncation)
  if (error !== undefined) throw new Error(error)
  const text = assembler.text()
  // 宽容模式下允许空输出：调用方（分类阶段）会把无法解析的内容降级
  // 为 unknown 项目类型继续流程，而不是让整个 /init 失败。
  if (text.trim().length === 0 && !tolerateTruncation) {
    throw new Error('the model returned empty output')
  }
  return { text, blocks: assembler.blocks(), usage: assembler.usage, finish: assembler.finish }
}

/** 阶段一提示词：让模型根据目录结构判断项目类型与工具链。 */
function classifyPrompt(treeText) {
  return [
    'You are a senior software engineer analyzing a repository. Given the two-level directory structure below, determine the project type and the toolchain it uses.',
    '',
    treeText,
    '',
    'Respond with ONLY a JSON object in this exact shape (no markdown, no commentary):',
    '{"projectType": "<short project type, e.g. Node.js web application>", "languages": ["<language>", ...], "toolchain": ["<tool or framework>", ...], "summary": "<one-sentence summary of the project>"}',
  ].join('\n')
}

/**
 * 从模型输出中宽容地解析 JSON：剥离 markdown 围栏与前后噪音，
 * 截取第一个 `{` 到最后一个 `}` 之间的内容。
 * @param {string} text - 模型输出。
 * @returns {unknown} 解析结果；解析失败返回 null。
 */
export function parseClassifiedJson(text) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
}

/**
 * 把判断结果规整为字符串字段（宽容处理缺失/类型错误）。
 * @param {unknown} value - 模型返回的 JSON。
 * @returns {{ projectType: string, languages: string, toolchain: string, summary: string }}
 */
export function normalizeClassified(value) {
  const record = /** @type {Record<string, unknown>} */ (typeof value === 'object' && value !== null ? value : {})
  const stringOf = (key, fallback) => typeof record[key] === 'string' && record[key].trim().length > 0
    ? record[key].trim()
    : fallback
  const listOf = key => Array.isArray(record[key])
    ? record[key].filter(item => typeof item === 'string' && item.trim().length > 0).join(', ')
    : ''
  return {
    projectType: stringOf('projectType', 'unknown'),
    languages: listOf('languages'),
    toolchain: listOf('toolchain'),
    summary: stringOf('summary', ''),
  }
}

/** 阶段二提示词：参考 opencode 的 /init 命令，嵌入判断结果生成 AGENTS.md。 */
function generatePrompt(treeText, profile, existing) {
  const detail = [
    `- Project type: ${profile.projectType}`,
    `- Languages: ${profile.languages.length > 0 ? profile.languages : 'not identified'}`,
    `- Toolchain: ${profile.toolchain.length > 0 ? profile.toolchain : 'not identified'}`,
    ...profile.summary.length > 0 ? [`- Summary: ${profile.summary}`] : [],
  ].join('\n')
  return [
    'You are a software engineering expert with many years of programming experience.',
    '',
    'The project has been analyzed as follows:',
    detail,
    '',
    'Repository structure (two levels):',
    treeText,
    ...existing === undefined
      ? []
      : ['', 'The current AGENTS.md content (rewrite it, keeping everything that is still accurate):', existing],
    '',
    'Task: create an AGENTS.md file for this project. AGENTS.md is a file intended to be read by AI coding agents, who know nothing about the project. Write it strictly from the information above — do not invent files, commands, or conventions that the structure does not support. Use the natural language that is mainly used in the project\'s comments and documentation (fall back to English when it cannot be determined).',
    '',
    'Include these sections in this order:',
    '1. Project overview',
    '2. Build and test commands',
    '3. Code style guidelines',
    '4. Testing instructions',
    '5. Security considerations',
    '6. AI agent guidelines — must include a rule that the agent reviews and corrects this AGENTS.md after completing every task, so the file stays accurate as the project evolves',
    '',
    'Output only the AGENTS.md content as plain text — no markdown code fence, no commentary before or after.',
  ].join('\n')
}

/**
 * 解析模型路由：插件配置 → 会话最近一次请求 → agent 选项。
 * @param {object | undefined} config - 插件配置（可选 provider/model）。
 * @param {object | undefined} agent - 接收命令的 agent 句柄。
 * @returns {{ provider: string, model: string } | undefined} 路由；不可用时返回 undefined。
 */
export function resolveRoute(config, agent) {
  if (typeof config?.provider === 'string' && config.provider.length > 0
    && typeof config?.model === 'string' && config.model.length > 0) {
    return { provider: config.provider, model: config.model }
  }
  const latest = agent?.session?.requestHeader?.()?.config
  if (typeof latest?.provider === 'string' && latest.provider.length > 0
    && typeof latest?.model === 'string' && latest.model.length > 0) {
    return { provider: latest.provider, model: latest.model }
  }
  if (typeof agent?.options?.provider === 'string' && agent.options.provider.length > 0
    && typeof agent?.options?.model === 'string' && agent.options.model.length > 0) {
    return { provider: agent.options.provider, model: agent.options.model }
  }
  return undefined
}

/**
 * 探测路由模型是否支持指定的 reasoning effort（如 `'off'` 关闭思考）。
 * 通过 llm 服务的 `resolveCallConfig` 预检：纯能力解析，不发起模型调用、
 * 无 token 消耗。服务未暴露该方法（如测试用的 fake llm）时视为支持。
 * 任何探测失败（模型不支持 reasoning、能力查询不可用等）都按不支持
 * 处理，由调用方放弃传参——不支持思考开关的模型因此不会收到
 * `UNSUPPORTED_REASONING_EFFORT` 错误，只是保持其默认行为。
 * @param {object} ctx - Cordis 上下文（携带 llm 服务）。
 * @param {{ provider: string, model: string }} route - 模型路由。
 * @param {AbortSignal | undefined} signal - 取消信号。
 * @param {string} effort - 要探测的 effort 标识（如 `'off'`）。
 * @returns {Promise<boolean>} 路由模型是否支持该 effort。
 */
async function supportsReasoningEffort(ctx, route, signal, effort) {
  if (typeof ctx.llm.resolveCallConfig !== 'function') return true
  try {
    await ctx.llm.resolveCallConfig(
      { provider: route.provider, model: route.model, reasoningEffort: effort },
      signal,
    )
    return true
  } catch {
    return false
  }
}

/** @returns {Promise<boolean>} `file` 是否作为常规文件存在。 */
async function exists(file) {
  try {
    return (await stat(file)).isFile()
  } catch {
    return false
  }
}

/**
 * `--git` 的 .gitignore 模板匹配表：`[模板名, 命中关键词数组]`，按优先
 * 顺序检查（靠前的模板先命中）。模板名必须是 github/gitignore 仓库顶层
 * 的真实文件名；关键词不含空格时为分词精确匹配，含空格时为整体短语
 * 匹配（大小写不敏感）。
 */
const GITIGNORE_TEMPLATES = [
  ['Nextjs', ['next.js', 'nextjs', 'next']],
  ['Nestjs', ['nestjs', 'nest.js', 'nest']],
  ['Deno', ['deno']],
  ['bun', ['bun']],
  ['Angular', ['angular']],
  ['Node', ['node.js', 'nodejs', 'node', 'javascript', 'typescript', 'npm', 'yarn', 'pnpm', 'webpack', 'vite', 'react', 'vue', 'svelte', 'express', 'nuxt', 'electron']],
  ['Flutter', ['flutter']],
  ['Dart', ['dart']],
  ['Swift', ['swift', 'ios']],
  ['Objective-C', ['objective-c', 'objc', 'objective c']],
  ['Kotlin', ['kotlin']],
  ['Android', ['android']],
  ['Java', ['java', 'spring', 'spring boot', 'spring framework', 'jvm', 'hibernate']],
  ['Gradle', ['gradle']],
  ['Maven', ['maven']],
  ['Scala', ['scala']],
  ['Clojure', ['clojure']],
  ['Dotnet', ['c#', 'csharp', '.net', 'dotnet', 'asp.net', 'aspnet']],
  ['VisualStudio', ['visual studio', 'vs.net', 'msbuild']],
  ['C++', ['c++', 'cpp']],
  ['C', ['c', 'c language']],
  ['Go', ['go', 'golang']],
  ['Rust', ['rust', 'cargo']],
  ['Python', ['python', 'django', 'flask', 'fastapi', 'jupyter', 'pandas', 'numpy', 'scikit-learn']],
  ['Ruby', ['ruby']],
  ['Rails', ['rails', 'ruby on rails']],
  ['PHP', ['php']],
  ['Laravel', ['laravel']],
  ['WordPress', ['wordpress']],
  ['Symfony', ['symfony']],
  ['Yii', ['yii']],
  ['CodeIgniter', ['codeigniter']],
  ['CakePHP', ['cakephp']],
  ['Drupal', ['drupal']],
  ['Magento', ['magento']],
  ['Joomla', ['joomla']],
  ['Composer', ['composer']],
  ['Elixir', ['elixir', 'phoenix']],
  ['Erlang', ['erlang']],
  ['Haskell', ['haskell']],
  ['OCaml', ['ocaml']],
  ['Lua', ['lua']],
  ['Luau', ['luau']],
  ['Raku', ['raku', 'perl6']],
  ['Perl', ['perl']],
  ['R', ['r']],
  ['Julia', ['julia']],
  ['Zig', ['zig']],
  ['Nim', ['nim']],
  ['D', ['d']],
  ['Delphi', ['delphi', 'pascal']],
  ['Fortran', ['fortran']],
  ['Ada', ['ada']],
  ['CommonLisp', ['common lisp', 'lisp']],
  ['Scheme', ['scheme']],
  ['Smalltalk', ['smalltalk']],
  ['Coq', ['coq']],
  ['Agda', ['agda']],
  ['Idris', ['idris']],
  ['Lean', ['lean']],
  ['Racket', ['racket']],
  ['Elisp', ['elisp', 'emacs']],
  ['TeX', ['tex', 'latex']],
  ['GitBook', ['gitbook']],
  ['Jekyll', ['jekyll']],
  ['GitHubPages', ['github pages', 'gh-pages']],
  ['Firebase', ['firebase']],
  ['Terraform', ['terraform', 'hcl']],
  ['Packer', ['packer']],
  ['ChefCookbook', ['chef', 'chef cookbook']],
  ['JENKINS_HOME', ['jenkins']],
  ['Unity', ['unity', 'unity3d']],
  ['UnrealEngine', ['unreal engine', 'unreal', 'ue4', 'ue5']],
  ['Godot', ['godot']],
  ['Qt', ['qt']],
  ['ROS', ['ros']],
  ['Processing', ['processing']],
  ['LabVIEW', ['labview']],
  ['KiCad', ['kicad']],
  ['CMake', ['cmake']],
  ['SCons', ['scons']],
  ['CUDA', ['cuda']],
  ['Gleam', ['gleam']],
  ['Haxe', ['haxe']],
  ['Nix', ['nix']],
  ['Ballerina', ['ballerina']],
  ['Actionscript', ['actionscript', 'action script']],
  ['VBA', ['vba']],
  ['Xojo', ['xojo']],
  ['Sass', ['sass', 'scss']],
  ['Salesforce', ['salesforce', 'apex']],
  ['Solidity-Remix', ['solidity']],
  ['Grails', ['grails']],
  ['PlayFramework', ['play framework']],
  ['ZendFramework', ['zend framework', 'zend']],
  ['Phalcon', ['phalcon']],
  ['Prestashop', ['prestashop']],
  ['TurboGears2', ['turbogears']],
  ['FuelPHP', ['fuelphp']],
  ['ExpressionEngine', ['expression engine']],
  ['CraftCMS', ['craft cms', 'craftcms']],
  ['Concrete5', ['concrete5']],
  ['OpenCart', ['opencart']],
  ['Textpattern', ['textpattern']],
  ['Typo3', ['typo3']],
  ['EPiServer', ['episerver']],
  ['FlaxEngine', ['flax engine']],
  ['SolidWorks', ['solidworks']],
  ['Eagle', ['eagle']],
  ['ModelSim', ['modelsim']],
  ['Modelica', ['modelica']],
  ['Lilypond', ['lilypond']],
  ['IGORPro', ['igor']],
  ['TwinCAT3', ['twincat']],
  ['VVVV', ['vvvv']],
  ['Waf', ['waf']],
  ['Yeoman', ['yeoman']],
  ['Zephir', ['zephir']],
  ['Katalon', ['katalon']],
  ['TestComplete', ['testcomplete']],
  ['LangChain', ['langchain']],
  ['MoonBit', ['moonbit']],
  ['Nanoc', ['nanoc']],
  ['Leiningen', ['leiningen']],
  ['GWT', ['gwt', 'google web toolkit']],
  ['ExtJs', ['extjs']],
  ['Gcov', ['gcov']],
  ['HIP', ['hip']],
  ['IAR', ['iar']],
  ['Opa', ['opa']],
  ['PureScript', ['purescript']],
  ['Qooxdoo', ['qooxdoo']],
  ['Sdcc', ['sdcc']],
  ['Stella', ['stella']],
  ['SugarCRM', ['sugarcrm']],
  ['AppEngine', ['app engine', 'google app engine', 'appengine']],
  ['ArchLinuxPackages', ['arch linux', 'archlinux']],
  ['Autotools', ['autotools', 'automake', 'autoconf']],
  ['CFWheels', ['cfwheels']],
  ['DM', ['dm']],
  ['JBoss', ['jboss', 'wildfly']],
  ['OracleForms', ['oracle forms']],
  ['Plone', ['plone']],
  ['SketchUp', ['sketchup']],
]

/**
 * 根据项目分析结果（语言、工具链、项目类型）匹配 github/gitignore 的
 * 模板名；无匹配时返回 undefined。
 * @param {{ projectType: string, languages: string, toolchain: string }} profile - 规整后的项目画像。
 * @returns {string | undefined} 模板名（如 'Node'），无匹配时 undefined。
 */
export function gitignoreTemplate(profile) {
  const candidates = [profile.languages, profile.toolchain, profile.projectType]
    .filter(Boolean)
    .map(value => value.toLowerCase())
  const tokens = new Set(candidates.flatMap(text => text.split(/[^a-z0-9.#+-]+/u).filter(Boolean)))
  const phrases = candidates.join(' ')
  for (const [template, aliases] of GITIGNORE_TEMPLATES) {
    for (const alias of aliases) {
      if (alias.includes(' ')) {
        if (phrases.includes(alias)) return template
      } else if (tokens.has(alias)) {
        return template
      }
    }
  }
  return undefined
}

/**
 * 用 node:https 发起 GET 请求并返回状态码与响应文本（零依赖，无需
 * 全局 fetch）。
 * @param {string} url - 请求地址。
 * @param {{ ca?: string | Buffer }} [options] - 附加 https 请求选项（如系统 CA）。
 * @returns {Promise<{ status: number, text: string }>} 响应。
 */
function httpGetText(url, options = {}) {
  return new Promise((resolve, reject) => {
    const request = httpsGet(url, options, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        text: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    request.setTimeout(15000, () => request.destroy(new Error('request timed out')))
    request.on('error', reject)
  })
}

/** 常见系统 CA 证书包路径（与 curl 等系统工具使用的信任库一致）。 */
const SYSTEM_CA_BUNDLES = [
  '/etc/ssl/certs/ca-certificates.crt',
  '/etc/pki/tls/certs/ca-bundle.crt',
  '/etc/ssl/ca-bundle.pem',
  '/etc/pki/tls/cacert.pem',
  '/etc/ssl/cert.pem',
]

/** 读取第一个可用的系统 CA 证书包；不可用时返回 undefined。 */
async function loadSystemCa() {
  for (const file of SYSTEM_CA_BUNDLES) {
    try {
      return await readFile(file, 'utf8')
    } catch {
      // 尝试下一个候选路径。
    }
  }
  return undefined
}

/** TLS 证书校验失败的错误码（首次请求失败时触发系统 CA 回退）。 */
const TLS_VERIFY_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID',
])

/**
 * 默认下载器：先用 Node 内置 CA 库请求；若因证书校验失败（例如本机
 * 使用系统信任库的代理/MITM 环境，Node 内置 CA 不包含其根证书）则读取
 * 系统 CA 证书包重试一次——仍然校验证书，只是信任库与 curl 等系统工具
 * 一致。
 * @param {string} url - 请求地址。
 * @returns {Promise<{ status: number, text: string }>} 响应。
 */
async function fetchGitignore(url) {
  try {
    return await httpGetText(url)
  } catch (error) {
    if (!TLS_VERIFY_CODES.has(error?.code)) throw error
    const ca = await loadSystemCa()
    if (ca === undefined) throw error
    return await httpGetText(url, { ca })
  }
}

/**
 * 从 github/gitignore 仓库（默认分支 main）下载指定模板的 .gitignore
 * 内容。`fetcher` 可注入（测试用），默认走 node:https，并在证书校验
 * 失败时回退到系统 CA 信任库（见 {@link fetchGitignore}）。
 * @param {string} template - 模板名（如 'Node'）。
 * @param {(url: string) => Promise<{ status: number, text: string }>} [fetcher] - 请求函数。
 * @returns {Promise<{ ok: boolean, status: number, text?: string }>} 结果。
 */
export async function downloadGitignore(template, fetcher = fetchGitignore) {
  const url = `https://raw.githubusercontent.com/github/gitignore/main/${encodeURIComponent(template)}.gitignore`
  const response = await fetcher(url)
  return { ok: response.status === 200, status: response.status, text: response.text }
}

/** 在 root 下运行 git 命令（-C root …）。 */
const runGit = promisify(execFile).bind(null, 'git')

/**
 * 若当前分支为 master 则重命名为 main。已有提交时用 `git branch -m`；
 * 尚未提交（unborn 分支）时退回 `git symbolic-ref`。
 * @param {string} root - 仓库目录。
 * @returns {Promise<boolean>} 是否发生了重命名。
 */
export async function renameMasterToMain(root) {
  let current
  try {
    const { stdout } = await runGit(['-C', root, 'branch', '--show-current'], { timeout: 30000 })
    current = stdout.trim()
  } catch {
    return false
  }
  if (current !== 'master') return false
  try {
    await runGit(['-C', root, 'branch', '-m', 'main'], { timeout: 30000 })
    return true
  } catch {
    try {
      await runGit(['-C', root, 'symbolic-ref', 'HEAD', 'refs/heads/main'], { timeout: 30000 })
      return true
    } catch {
      return false
    }
  }
}

/**
 * 确保 root 下存在 git 仓库：不存在时 `git init`，并把 master 默认分支
 * 重命名为 main（见 {@link renameMasterToMain}）。
 * @param {string} root - 项目目录。
 * @returns {Promise<{ status: 'initialized' | 'exists' | 'skipped-inside-parent' | 'no-git', toplevel?: string, renamed?: boolean }>}
 *   仓库状态；`skipped-inside-parent` 表示项目位于某个父仓库内（不新建
 *   嵌套仓库），`no-git` 表示系统未安装 git。
 */
export async function ensureGitRepo(root) {
  let toplevel
  try {
    const { stdout } = await runGit(['-C', root, 'rev-parse', '--show-toplevel'], { timeout: 30000 })
    toplevel = path.resolve(stdout.trim())
  } catch {
    toplevel = undefined
  }
  if (toplevel !== undefined) {
    if (toplevel !== path.resolve(root)) {
      return { status: 'skipped-inside-parent', toplevel }
    }
    return { status: 'exists', renamed: await renameMasterToMain(root) }
  }
  try {
    await runGit(['-C', root, 'init'], { timeout: 30000 })
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'no-git' }
    throw error
  }
  return { status: 'initialized', renamed: await renameMasterToMain(root) }
}

/**
 * 执行 `--git` 的完整流程：确保仓库存在（必要时初始化）、master → main、
 * 按项目类型从 github/gitignore 下载 .gitignore（已存在时不覆盖）。
 * 每一步都通过返回值中的文本行汇报，不抛出（下载失败只记一行说明）。
 * @param {string} root - 项目目录。
 * @param {{ projectType: string, languages: string, toolchain: string }} profile - 项目画像。
 * @param {{ fetcher?: (url: string) => Promise<{ status: number, text: string }> }} [options] - 可注入下载函数（测试用）。
 * @returns {Promise<string[]>} 描述各步骤结果的文本行。
 */
export async function applyGitSteps(root, profile, options = {}) {
  const lines = []
  const repo = await ensureGitRepo(root)
  if (repo.status === 'no-git') {
    lines.push('git is not installed; skipped git init, branch rename and .gitignore download')
    return lines
  }
  if (repo.status === 'skipped-inside-parent') {
    lines.push(`project is inside an existing git repository at ${repo.toplevel}; git init and branch rename skipped`)
    return lines
  }
  lines.push(repo.status === 'initialized' ? 'initialized a new git repository' : 'git repository already exists')
  if (repo.renamed) lines.push('renamed the default branch master → main')

  const template = gitignoreTemplate(profile)
  if (template === undefined) {
    lines.push('no matching .gitignore template in github/gitignore for this project type; skipped')
    return lines
  }
  const target = path.join(root, '.gitignore')
  if (await exists(target)) {
    lines.push(`.gitignore already exists; not overwriting (template ${template})`)
    return lines
  }
  try {
    const result = await downloadGitignore(template, options.fetcher)
    if (result.ok) {
      await writeFile(target, result.text, 'utf8')
      lines.push(`downloaded .gitignore from github/gitignore (${template})`)
    } else {
      lines.push(`could not download ${template}.gitignore from github/gitignore (HTTP ${result.status}); skipped`)
    }
  } catch (error) {
    lines.push(`could not download .gitignore: ${error instanceof Error ? error.message : String(error)}`)
  }
  return lines
}

/**
 * 解析 `/init` 参数。
 * @param {string} rawInput - 命令名之后的原文文本。
 * @returns {{ dryRun: boolean, git: boolean, think: boolean } | string} 解析出的标志，
 *   或遇到未知参数时的用法错误消息。
 */
function parseArgs(rawInput) {
  const args = rawInput.trim().split(/\s+/u).filter(Boolean)
  const flags = { dryRun: false, git: false, think: false }
  for (const arg of args) {
    if (arg === '--dry-run') {
      flags.dryRun = true
    } else if (arg === '--git') {
      flags.git = true
    } else if (arg === '--think') {
      flags.think = true
    } else {
      return `Unknown argument "${arg}". ${USAGE}`
    }
  }
  return flags
}

/** 提示词的非空行数（用于折叠行摘要）。 */
export function promptLineCount(text) {
  return text.split('\n').filter(line => line.trim().length > 0).length
}

/**
 * 把提示词压缩为单行摘要：非空行数 + 首行截断。
 * @param {string} text - 完整提示词。
 * @returns {string} 摘要。
 */
function promptSummaryOf(text) {
  const lines = text.split('\n').filter(line => line.trim().length > 0)
  const first = lines[0] ?? ''
  const trimmed = first.length > 80 ? `${first.slice(0, 77)}…` : first
  return `${lines.length} lines (${trimmed})`
}

/**
 * 把两次模型调用渲染为对话历史可读的记录块。它随命令结果（
 * `command/done` 事件）一起持久化到会话日志——这是仓库外插件安全
 * 记录自定义信息的方式：直接 `session.append()` 自定义事件类型会被
 * 会话恢复路径（`KNOWN_SESSION_EVENT_TYPES` 白名单）拒绝加载，而
 * `command/done` 属于白名单事件，恢复安全且在 GUI 中可见。
 * @param {Array<{ stage: string, route: { provider: string, model: string }, prompt: string, result: string }>} calls - 调用记录。
 * @returns {string} 记录文本块。
 */
function formatModelCalls(calls) {
  const lines = calls.map((call, index) => {
    const prompt = promptSummaryOf(call.prompt)
    return `${index + 1}. ${call.stage} — ${call.route.provider}/${call.route.model} — prompt: ${prompt} — result: ${call.result}`
  })
  return ['Model calls:', ...lines].join('\n')
}

/**
 * 追加阶段二的完成 step（默认模式）：`AGENTS.md` 生成内容不进入会话
 * （silent 流式调用，见 {@link streamModelStage}），成功后写入两条可见
 * 输出——一条插件 notice（折叠行摘要：阶段与字符数）与一条形如模型
 * 正式输出的成功状态消息。事件序列与阶段一的合成显示一致：
 * `step/start` → `user/message`（notice 上下文，GUI 默认折叠为一行摘要、
 * 点击展开完整文本）→ `assistant/message`（成功状态）→ `step/end`；
 * 不写 turn 边界（见 {@link INIT_TURN}），step 号与阶段二流式调用共用。
 *
 * 成功状态消息以 `assistant/message` 呈现，来源复用本次模型路由
 * （kind 为 model 并携带 provider/model）：会话持久化加载路径要求
 * `assistant/message` 必须携带 model 来源（插件来源会在重启时被拒绝
 * 加载），该形状也让 GUI 按模型正式输出渲染。文本由插件合成，非模型
 * 生成，仅作状态汇报。
 * @param {object} session - 接收命令的 agent 的会话。
 * @param {number} step - 阶段二的 step 号（`nextInitStep` 之后递增得到）。
 * @param {{ provider: string, model: string }} route - 本次 /init 的模型路由。
 * @param {{ summary: string, text: string }} notice - 完成信息 notice：
 *   `summary` 为折叠行摘要（GUI 默认只显示这一行），`text` 为展开后的完整文本。
 * @param {string} success - 成功状态消息文本（以 assistant 消息呈现）。
 */
function appendCompletionNotice(session, step, route, notice, success) {
  session.append('step/start', { turn: INIT_TURN, step })
  session.append('user/message', {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: notice.text }],
    source: {
      kind: 'plugin',
      plugin: 'dsh-init-command',
      form: 'notice',
      summary: notice.summary,
    },
  }, { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: INIT_TURN,
    step,
    message: {
      id: randomUUID(),
      role: 'assistant',
      content: [{ type: 'text', text: success }],
      source: { kind: 'model', provider: route.provider, model: route.model },
    },
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: INIT_TURN, step })
}

/**
 * 执行 `/init` 两阶段流程：收集目录树 → 判断项目类型 → 生成 AGENTS.md。
 *
 * 阶段一通过 {@link streamModelStage} 实时写入会话日志：提示词以
 * user 消息完整显示（与用户输入同等地位），模型的流块逐块实时转发
 * （GUI 按帧渲染，效果与思考过程一致）；阶段一默认关闭思考模式
 * （`reasoningEffort: 'off'`，仅当路由模型支持时；`--think` 恢复提供方
 * 默认行为）。阶段二默认 silent 流式执行，
 * 生成内容直接写入文件、不进入会话，成功后追加完成信息 notice 与
 * 一条形如模型正式输出的成功状态消息（{@link appendCompletionNotice}），
 * 只有 `--dry-run` 时才与阶段一一样完整显示。调用记录（阶段、路由、
 * 提示词摘要、结果）仍随命令结果写入对话历史，详见
 * {@link formatModelCalls}。
 *
 * `--git` 时在写入 AGENTS.md 后执行 {@link applyGitSteps}：初始化 git
 * 仓库（如缺失）、默认分支 master → main、按项目类型从 github/gitignore
 * 下载 .gitignore（已存在时不覆盖）；`--dry-run` 组合下只提示将做什么。
 * @param {object} ctx - Cordis 上下文（携带 commands 与 llm 服务）。
 * @param {object | undefined} config - 插件配置。
 * @param {object} invocation - 命令注册表传入的调用负载。
 * @returns {Promise<{ kind: 'success' | 'error', text: string }>} 命令结果。
 */
async function executeInit(ctx, config, invocation) {
  const parsed = parseArgs(invocation.rawInput)
  if (typeof parsed === 'string') return { kind: 'error', text: parsed }

  const root = invocation.agent?.session?.header?.cwd ?? process.cwd()
  const target = path.join(root, 'AGENTS.md')

  const existing = await exists(target)
  if (invocation.signal?.aborted) {
    return { kind: 'error', text: 'Init cancelled.' }
  }

  const route = resolveRoute(config, invocation.agent)
  if (route === undefined) {
    return {
      kind: 'error',
      text: 'No provider/model available for /init. Configure provider and model on the plugin row, route one request in this session, or set agent options.',
    }
  }

  const session = invocation.agent.session
  const existingContent = existing
    ? await readFile(target, 'utf8').catch(() => undefined)
    : undefined

  // 阶段一：发送两层目录结构，让模型判断项目类型与工具链。
  // 默认关闭思考模式（--think 时保持提供方默认行为）：分类任务简单，
  // 不思考更省时省 token；仅当路由模型支持 'off' 时才传参（见
  // supportsReasoningEffort），不支持思考开关的模型保持其默认行为。
  // 宽容截断：不设置 maxTokens，由适配器默认上限决定；若使用思考模式，
  // reasoning 输出可能占满预算，只要已收集的文本仍可解析出 JSON 就
  // 继续（解析失败则降级 unknown）。
  const treeLines = await collectTree(root)
  const treeText = treeLines.join('\n')
  const noThink = !parsed.think && await supportsReasoningEffort(ctx, route, invocation.signal, 'off')
  /** @type {Array<{ stage: string, route: { provider: string, model: string }, prompt: string, result: string }>} */
  const calls = []
  let step = nextInitStep(session)
  let profile
  try {
    const raw = await streamModelStage(ctx, session, invocation, route, step++, classifyPrompt(treeText), {
      label: '阶段 1：项目分析',
      temperature: 0,
      tolerateTruncation: true,
      ...noThink ? { reasoningEffort: 'off' } : {},
    })
    profile = normalizeClassified(parseClassifiedJson(raw.text))
    const tags = [profile.languages, profile.toolchain].filter(Boolean).map(tag => `[${tag}]`).join(' ')
    calls.push({
      stage: 'classify',
      route,
      prompt: classifyPrompt(treeText),
      result: `${profile.projectType} ${tags}`.trim(),
    })
  } catch (error) {
    return {
      kind: 'error',
      text: `Could not classify the project: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  if (invocation.signal?.aborted) {
    return { kind: 'error', text: 'Init cancelled.' }
  }

  // 阶段二：把项目类型嵌入提示词，生成 AGENTS.md 内容。
  // 默认静默生成（silent 模式）：模型输出不进入会话日志，直接写入文件，
  // 只在成功后追加一条简短完成信息（见下方 appendCompletionNotice）；
  // --dry-run 时与阶段一一样完整流式显示，便于预览。
  let content
  try {
    const generated = await streamModelStage(ctx, session, invocation, route, step, generatePrompt(treeText, profile, existingContent), {
      label: '阶段 2：AGENTS.md 生成',
      silent: !parsed.dryRun,
    })
    content = generated.text
    calls.push({
      stage: 'generate',
      route,
      prompt: generatePrompt(treeText, profile, existingContent),
      result: `AGENTS.md (${content.length} chars)${parsed.dryRun ? ' (dry run, not written)' : ''}`,
    })
  } catch (error) {
    // 生成失败时仍把已完成的调用记录附在错误文本里，方便排查。
    const record = calls.length > 0 ? `\n\n${formatModelCalls(calls)}` : ''
    return {
      kind: 'error',
      text: `Could not generate AGENTS.md: ${error instanceof Error ? error.message : String(error)}${record}`,
    }
  }

  const modelCalls = formatModelCalls(calls)
  // --git 的说明行：dry-run 只提示将做什么，不执行任何写入。
  let gitLines = []
  if (parsed.git && parsed.dryRun) {
    const template = gitignoreTemplate(profile)
    gitLines = [template === undefined
      ? '--git skipped (dry run): would initialize a git repository and download a matching .gitignore'
      : `--git skipped (dry run): would initialize a git repository and download ${template}.gitignore`]
  }
  const gitText = gitLines.length > 0 ? `\n\nGit: ${gitLines.join('; ')}` : ''
  if (parsed.dryRun) {
    return {
      kind: 'success',
      text: `Generated AGENTS.md for ${root} (dry run, nothing written):\n\n${content}${gitText}\n\n${modelCalls}`,
    }
  }
  if (invocation.signal?.aborted) {
    return { kind: 'error', text: 'Init cancelled.' }
  }

  try {
    await mkdir(root, { recursive: true })
    await writeFile(target, content, 'utf8')
  } catch (error) {
    return {
      kind: 'error',
      text: `Could not write ${target}: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  // 阶段二默认不在会话中展示 AGENTS.md 内容（silent 流式调用），但追加
  // 一条完成信息 notice 与一条形如模型正式输出的成功状态消息，让阶段二
  // 在会话中也有可见输出；完整内容只有 --dry-run 才会流式显示（见上方
  // 阶段二的 streamModelStage 调用）。
  if (!parsed.dryRun) {
    appendCompletionNotice(session, step, route, {
      summary: `阶段 2：AGENTS.md 已生成（${content.length} 字符）`,
      text: `AGENTS.md 已生成：${target}（${content.length} 字符）。完整内容未显示，运行 /init --dry-run 可完整预览。`,
    }, [
      `✅ /init 完成：AGENTS.md 已生成`,
      `文件：${target}（${content.length} 字符）`,
      `项目类型：${profile.projectType}`,
      `完整内容未显示，运行 /init --dry-run 可完整预览。`,
    ].join('\n'))
  }

  // —— --git：初始化 git 仓库（如缺失）、master → main、下载 .gitignore ——
  if (parsed.git) {
    if (invocation.signal?.aborted) {
      return { kind: 'error', text: 'Init cancelled.' }
    }
    gitLines = await applyGitSteps(root, profile)
  }
  const finalGitText = gitLines.length > 0 ? `\n\nGit: ${gitLines.join('; ')}` : ''
  return {
    kind: 'success',
    text: `Initialized ${target} (${profile.projectType}). Review the generated AGENTS.md and adjust it to your conventions.${finalGitText}\n\n${modelCalls}`,
  }
}

/**
 * 为每个组合的人类命令适配器注册 `/init`。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 上下文；注册是
 *   effect，会在本插件卸载时自动撤销。
 * @param {object | undefined} config - 插件配置（可选 provider/model）。
 */
export function apply(ctx, config) {
  ctx.commands.register({
    name: 'init',
    description: 'Generate an AGENTS.md guide for this project with the model',
    input: { hint: '[--dry-run] [--git] [--think]' },
    handler: invocation => executeInit(ctx, config, invocation),
  })
}
