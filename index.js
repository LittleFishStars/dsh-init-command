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
 * 阶段二默认 silent（内容直接写文件），成功后追加完成信息 notice 与一条
 * 形如模型输出的成功状态消息，`--dry-run` 时完整显示。
 *
 * 合成显示只写 step 层事件、不写 turn 边界：正数 turn 会与 agent 循环的
 * 编号冲突，turn 0 的 turn/end 又会被会话持久化读取路径拒绝加载；固定
 * turn 0 + 递增 step 两全（详见 {@link INIT_TURN}）。所有事件类型都在
 * 会话恢复白名单内。
 *
 * 运行时零依赖（仅 Node 内置模块），无需构建即可从源码 / --patch / npm 加载。
 *
 * 用法：/init [--dry-run] [--git] [--think]
 *   --dry-run  预览将生成的 AGENTS.md 而不写入
 *   --think    阶段一改用思考模式（默认 reasoningEffort 'off'，更快更省 token）
 *   --git      额外 git 初始化：仓库不存在时 init、master → main、
 *              按项目类型下载 github/gitignore 模板（已存在不覆盖）
 *
 * 模型路由（按优先级）：插件 config → 会话最近一次请求 → agent.options。
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
 * 合成显示的固定坐标 turn。
 *
 * 只写 step 层事件、不写 turn 边界：正数 turn 会与 agent 循环的编号冲突；
 * turn 0 的 turn/end 会被会话持久化读取路径拒绝加载（turn < 1 视为
 * malformed），重启后历史无法恢复。固定 turn 0 + 递增 step 两全。
 */
export const INIT_TURN = 0

/** 下一次 /init 可用的 step 号：turn 0 中已出现过的最大 step + 1（首次为 1）。 */
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
 * 收集两层目录树（顶层全部条目 + 每个子目录的第二层条目）为文本行。
 * @returns {Promise<string[]>} 目录以 `/` 结尾的行。
 */
export async function collectTree(root) {
  const lines = [path.basename(root) + '/']
  const top = await listEntries(root, MAX_TOP_LEVEL_ENTRIES)
  // 子目录条目并行读取，再按顶层顺序拼装，保证输出稳定。
  const children = await Promise.all(top.map(entry =>
    entry.isDirectory ? listEntries(path.join(root, entry.name), MAX_DIR_ENTRIES) : null,
  ))
  top.forEach((entry, index) => {
    lines.push(entry.isDirectory ? `${entry.name}/` : entry.name)
    const sub = children[index]
    if (sub === null) return
    for (const child of sub) lines.push(`  ${child.isDirectory ? `${child.name}/` : child.name}`)
  })
  return lines
}

/** 列出目录条目：过滤噪音与隐藏项、排序、按上限折叠。 */
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

/** 构造一条 user 角色消息（与 `@deepseek-ai/dsh-llm` 的 Message 形状一致）。 */
function userMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: name },
  }
}

/**
 * 与 `@deepseek-ai/dsh-llm` 的 `BlockAssembler` 语义一致的迷你组装器
 * （零依赖手写）：按流顺序累积内容块，容忍只有 delta 的协议。
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
          ensure(chunk.index, chunk.blockType)
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
 * 终止原因 → 错误消息；正常终止（stop）返回 undefined。
 * @param {boolean} [tolerateTruncation] - max-tokens 截断不视为失败（分类阶段继续解析）。
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
 * 执行一次 LLM 调用；visible 时把全过程实时写入会话日志，silent 时不写
 * 任何会话事件、只返回文本。
 *
 * visible 事件序列：`step/start` → `user/message`（提示词，notice 上下文，
 * GUI 折叠为一行摘要）→ `assistant/chunk`*（逐块实时转发）→
 * `assistant/message`（正常终止时，携带 usage 与来源 chunk 序号）→
 * `step/end`。不写 turn 边界（见 {@link INIT_TURN}）；调用失败时不追加
 * `assistant/message`，只关闭 step，已流出部分在 GUI 中按 interrupted 渲染。
 *
 * @param {object} ctx - Cordis 上下文（携带 llm 服务）。
 * @param {object} session - 接收命令的 agent 的会话。
 * @param {object} invocation - 命令调用负载（提供 signal）。
 * @param {{ provider: string, model: string }} route - 模型路由。
 * @param {number} step - 本次调用在 turn 0 中的 step 号。
 * @param {string} prompt - 发送给模型的 user 消息文本。
 * @param {{ label?: string, temperature?: number, reasoningEffort?: string, tolerateTruncation?: boolean, silent?: boolean }} [options]
 *   `label` 用于折叠行摘要；`silent` 为 true 时不写任何会话事件（生成阶段
 *   默认，成功后由调用方追加完成信息，见 {@link appendCompletionNotice}）。
 * @returns {Promise<{ text: string, blocks: Array<object>, usage?: object, finish: { kind: string } }>}
 */
export async function streamModelStage(ctx, session, invocation, route, step, prompt, options = {}) {
  const { label = 'Init', temperature, reasoningEffort, tolerateTruncation = false, silent = false } = options
  const visible = !silent
  if (visible) {
    session.append('step/start', { turn: INIT_TURN, step })
    // 提示词以 notice 上下文进入对话流：GUI 默认折叠为一行摘要，点击展开；
    // 发送给模型的也正是这段文本，在模型侧与用户输入地位一致。
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
  let blocks
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
      if (visible) {
        chunkSeqs.push(session.append('assistant/chunk', { turn: INIT_TURN, step, chunk }).seq)
      }
      assembler.push(chunk)
    }
    finish = assembler.finish
    blocks = assembler.blocks()
    // 正常终止才组装最终消息；错误/中止只留流式块，由 GUI 按 interrupted 渲染。
    if (visible && (finish?.kind === 'stop' || finish?.kind === 'max-tokens')) {
      session.append('assistant/message', {
        turn: INIT_TURN,
        step,
        message: {
          id: randomUUID(),
          role: 'assistant',
          content: blocks,
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
  // 宽容模式允许空输出：分类阶段会把无法解析的内容降级为 unknown 继续。
  if (text.trim().length === 0 && !tolerateTruncation) {
    throw new Error('the model returned empty output')
  }
  return { text, blocks, usage: assembler.usage, finish: assembler.finish }
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
 * 截取第一个 `{` 到最后一个 `}` 之间的内容；失败返回 null。
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

/** 把判断结果规整为字符串字段（宽容处理缺失/类型错误）。 */
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

/** 从配置对象提取 provider/model 对；字段缺失或为空时返回 undefined。 */
function routeOf(value) {
  if (typeof value?.provider === 'string' && value.provider.length > 0
    && typeof value?.model === 'string' && value.model.length > 0) {
    return { provider: value.provider, model: value.model }
  }
  return undefined
}

/** 解析模型路由：插件配置 → 会话最近一次请求 → agent 选项。 */
export function resolveRoute(config, agent) {
  return routeOf(config)
    ?? routeOf(agent?.session?.requestHeader?.()?.config)
    ?? routeOf(agent?.options)
}

/**
 * 探测路由模型是否支持指定 reasoning effort（如 'off'）。
 * 通过 `resolveCallConfig` 预检（纯能力解析，无 token 消耗）；服务未暴露
 * 该方法（如 fake llm）或探测失败时按不支持处理，由调用方放弃传参——
 * 不支持的模型因此不会收到 UNSUPPORTED_REASONING_EFFORT 错误。
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
 * .gitignore 模板匹配表：[模板名, 关键词数组]，按顺序检查（靠前的先命中）。
 * 模板名必须是 github/gitignore 仓库顶层的真实文件名；关键词不含空格为
 * 分词精确匹配，含空格为整体短语匹配（大小写不敏感）。
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

/** 按语言/工具链/项目类型匹配 github/gitignore 模板名；无匹配返回 undefined。 */
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

/** 响应体大小上限（.gitignore 模板远小于此）。 */
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

/** 用 node:https 发起 GET 请求，返回状态码与响应文本（零依赖）。 */
function httpGetText(url, options = {}) {
  return new Promise((resolve, reject) => {
    const request = httpsGet(url, options, (response) => {
      const chunks = []
      let size = 0
      response.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_RESPONSE_BYTES) {
          request.destroy(new Error('response body exceeded 2 MiB limit'))
          return
        }
        chunks.push(chunk)
      })
      response.on('error', reject)
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
 * 默认下载器：先用 Node 内置 CA 库请求；若证书校验失败（如本机使用系统
 * 信任库的代理/MITM 环境，Node 内置 CA 不含其根证书）则读取系统 CA 包
 * 重试一次——仍然校验证书，只是信任库与 curl 等系统工具一致。
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
 * 从 github/gitignore（main 分支）下载指定模板；`fetcher` 可注入（测试用），
 * 默认走 node:https 并在证书校验失败时回退系统 CA（见 {@link fetchGitignore}）。
 */
export async function downloadGitignore(template, fetcher = fetchGitignore) {
  const url = `https://raw.githubusercontent.com/github/gitignore/main/${encodeURIComponent(template)}.gitignore`
  const response = await fetcher(url)
  return { ok: response.status === 200, status: response.status, text: response.text }
}

/** 在 root 下运行 git 命令（-C root …）。 */
const runGit = promisify(execFile).bind(null, 'git')

/**
 * 若当前分支为 master 则重命名为 main：已有提交用 `git branch -m`，
 * 尚未提交（unborn）退回 `git symbolic-ref`。
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
 * 确保 root 下存在 git 仓库：缺失时 `git init`，并把 master 分支重命名为
 * main（见 {@link renameMasterToMain}）。
 * @returns {Promise<{ status: 'initialized' | 'exists' | 'skipped-inside-parent' | 'no-git', toplevel?: string, renamed?: boolean }>}
 *   `skipped-inside-parent`：项目位于父仓库内，不新建嵌套仓库；`no-git`：系统无 git。
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
 * 执行 `--git` 全流程：确保仓库存在（必要时初始化）、master → main、
 * 下载 .gitignore（已存在不覆盖）。每步以文本行汇报，不抛出。
 * @param {{ fetcher?: (url: string) => Promise<{ status: number, text: string }> }} [options] - 可注入下载函数（测试用）。
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

/** 解析 `/init` 参数；遇到未知参数返回用法错误消息。 */
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

/** 文本的非空行（供提示词行数统计与单行摘要共用）。 */
function nonEmptyLines(text) {
  return text.split('\n').filter(line => line.trim().length > 0)
}

/** 提示词的非空行数（用于折叠行摘要）。 */
export function promptLineCount(text) {
  return nonEmptyLines(text).length
}

/** 把提示词压缩为单行摘要：非空行数 + 首行截断。 */
function promptSummaryOf(text) {
  const lines = nonEmptyLines(text)
  const first = lines[0] ?? ''
  const trimmed = first.length > 80 ? `${first.slice(0, 77)}…` : first
  return `${lines.length} lines (${trimmed})`
}

/**
 * 把两次模型调用渲染为命令结果里的记录块。随 `command/done` 事件持久化
 * （白名单事件，恢复安全且 GUI 可见；直接 append 自定义事件类型会被
 * 会话恢复路径拒绝加载）。
 */
function formatModelCalls(calls) {
  const lines = calls.map((call, index) => {
    const prompt = promptSummaryOf(call.prompt)
    return `${index + 1}. ${call.stage} — ${call.route.provider}/${call.route.model} — prompt: ${prompt} — result: ${call.result}`
  })
  return ['Model calls:', ...lines].join('\n')
}

/**
 * 追加阶段二的完成 step（默认模式）：一条完成信息 notice（折叠行摘要）
 * 与一条形如模型正式输出的成功状态消息。事件序列与阶段一一致：
 * `step/start` → `user/message`（notice）→ `assistant/message` → `step/end`；
 * 不写 turn 边界（见 {@link INIT_TURN}）。
 *
 * 成功状态消息以 `assistant/message` 呈现且来源复用模型路由：持久化加载
 * 路径要求 `assistant/message` 必须携带 model 来源（插件来源会被拒绝）。
 * 文本由插件合成，非模型生成，仅作状态汇报。
 * @param {{ summary: string, text: string }} notice - 完成信息：summary 为折叠行摘要，text 为展开文本。
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
 * 阶段一实时流式显示，默认关闭思考模式（`--think` 恢复提供方默认）；
 * 阶段二默认 silent（内容直接写文件，成功后追加完成信息，见
 * {@link appendCompletionNotice}），`--dry-run` 时完整流式显示。
 * `--git` 时写入后执行 {@link applyGitSteps}（与 `--dry-run` 组合只提示）。
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

  // 阶段一：让模型判断项目类型。默认关闭思考（--think 恢复），仅当路由
  // 模型支持时才传 reasoningEffort；宽容截断——JSON 解析失败则降级 unknown。
  const treeLines = await collectTree(root)
  const treeText = treeLines.join('\n')
  const classifyText = classifyPrompt(treeText)
  const noThink = !parsed.think && await supportsReasoningEffort(ctx, route, invocation.signal, 'off')
  /** @type {Array<{ stage: string, route: { provider: string, model: string }, prompt: string, result: string }>} */
  const calls = []
  let step = nextInitStep(session)
  let profile
  try {
    const raw = await streamModelStage(ctx, session, invocation, route, step++, classifyText, {
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
      prompt: classifyText,
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

  // 阶段二：生成 AGENTS.md。默认 silent（内容直接写文件），--dry-run 时完整流式显示。
  let content
  try {
    const generateText = generatePrompt(treeText, profile, existingContent)
    const generated = await streamModelStage(ctx, session, invocation, route, step, generateText, {
      label: '阶段 2：AGENTS.md 生成',
      silent: !parsed.dryRun,
    })
    content = generated.text
    calls.push({
      stage: 'generate',
      route,
      prompt: generateText,
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

  // 默认模式不展示 AGENTS.md 内容，但追加完成信息与成功状态消息（见 appendCompletionNotice）。
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

/** 注册 `/init`；返回 register 的卸载函数（Cordis effect 约定）。 */
export function apply(ctx, config) {
  return ctx.commands.register({
    name: 'init',
    description: 'Generate an AGENTS.md guide for this project with the model',
    input: { hint: '[--dry-run] [--git] [--think]' },
    handler: invocation => executeInit(ctx, config, invocation),
  })
}
