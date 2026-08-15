/**
 * dsh-init-command 的真实运行时冒烟测试：通过 cordis.yml 启动一个
 * Loader 组合（agent + session + commands + llm + 本插件），与仓库中的
 * loader-composition 规范测试完全一致，然后驱动 `/init`。
 *
 * LLM 服务由 FakeLlm 提供（Service 子类，按消息内容区分两阶段返回），
 * 其余（agent、session、commands、Cordis Loader）全部为真实实现。
 *
 * 在已构建 lib/ 产物的 DeepSeek Harness 检出上运行：
 *
 *   mkdir -p node_modules && ln -s <harness>/packages/feedback/command-feedback/node_modules node_modules
 *   node scripts/smoke-loader.mjs
 *
 * 该符号链接用于解析裸的 `@deepseek-ai/*` 说明符；运行结束后请删除
 * `node_modules` 符号链接（它不属于插件的发布内容）。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as InitCommand from '../index.js'

const PLUGIN_URL = pathToFileURL(new URL('../index.js', import.meta.url).pathname).href
const { INIT_TURN } = InitCommand

const CLASSIFIED_JSON = '{"projectType": "Node.js web application", "languages": ["JavaScript"], "toolchain": ["npm"], "summary": "A demo app."}'
const GENERATED_MD = '# AGENTS.md\n\n## Project overview\n\nA demo app.\n'

/**
 * 冒烟用的假 LLM 服务：以 Service 身份挂载为 `ctx.llm`，按消息内容
 * 区分两阶段（判断 → JSON，生成 → AGENTS.md 文本）。
 */
class FakeLlm extends Service {
  constructor(ctx) {
    super(ctx, 'llm')
  }

  stream(options) {
    return (async function* () {
      const text = options.messages[0].content[0].text
      if (text.includes('Respond with ONLY a JSON')) {
        yield { type: 'text-delta', index: 0, text: CLASSIFIED_JSON }
      } else {
        // 生成阶段：先 reasoning 块再 text 块，验证阶段二默认只转发思考过程。
        yield { type: 'reasoning-delta', index: 0, text: 'Drafting the AGENTS.md structure...' }
        yield { type: 'text-delta', index: 1, text: GENERATED_MD }
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  }
}

const root = await mkdtemp(join(tmpdir(), 'dsh-init-command-smoke-'))
const context = new Context()
let failed = false

/** 注册一个会话记录着 `cwd` 的空闲 agent，与应用主干的做法一致。 */
function agent(ctx, cwd) {
  const scope = ctx.plugin(() => {})
  const id = SessionId('init-smoke-agent')
  const session = ctx.sessions.create(id, { meta: { cwd } })
  const inbox = new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} })
  let status = 'idle'
  const value = {
    id,
    options: { provider: 'smoke-provider', model: 'smoke-model' },
    session,
    inbox,
    ctx: scope.ctx,
    get status() { return status },
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel() { status = 'idle' },
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(value)
  return value
}

function check(label, condition, extra = '') {
  if (!condition) failed = true
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}${extra ? ` — ${extra}` : ''}`)
}

try {
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-commands'",
    "- name: '@deepseek-ai/dsh-llm'",
    `- name: '${PLUGIN_URL}'`,
    '',
  ].join('\n'))

  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map([
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-commands', CommandRuntime],
    ['@deepseek-ai/dsh-llm', FakeLlm],
    [PLUGIN_URL, InitCommand],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  }
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()

  const project = join(root, 'project')
  await mkdir(project)
  await writeFile(join(project, 'package.json'), JSON.stringify({
    name: 'smoke-app',
    scripts: { test: 'vitest run' },
  }))
  await mkdir(join(project, 'src'))

  const owner = agent(context, project)
  const signal = new AbortController().signal

  // 通过组合后的注册表可被发现，正如 UI 适配器所做的那样。
  const names = context.commands.list(owner).map(command => command.name)
  check('command is discoverable as /init', names.includes('init'), `listed: ${names.join(', ')}`)

  const created = await context.commands.execute(owner, '/init', signal)
  check('first /init succeeds', created?.result.kind === 'success', created?.result.text ?? '')
  check('model calls are recorded in the command result',
    created?.result.text.includes('Model calls:')
    && created.result.text.includes('1. classify')
    && created.result.text.includes('2. generate'),
    created?.result.text ?? '')
  const content = await readFile(join(project, 'AGENTS.md'), 'utf8')
  check('AGENTS.md was written with the model output', content === GENERATED_MD)

  // —— 实时流式写入（阶段一）：提示词与用户输入同等地位，模型输出逐块实时转发 ——
  const events = owner.session.events
  const userMessages = events.filter(event => event.type === 'user/message')
  const stageOneNotices = userMessages.filter(event => /^阶段 1：/.test(event.data.source.summary))
  check('prompts surface as collapsible notice context rows',
    stageOneNotices.length === 1
    && stageOneNotices.every(event => event.surfaceOp === 'append'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === 'dsh-init-command'
      && event.data.source.form === 'notice'
      && typeof event.data.source.summary === 'string'
      && /^阶段 1：.+（\d+ 行）$/.test(event.data.source.summary)),
    JSON.stringify(stageOneNotices.map(event => event.data.source)))
  // 阶段二默认只显示思考过程：追加阶段二提示词 notice（折叠行摘要），
  // reasoning 流块实时转发（text 块隐藏），最后追加一条简短的完成信息
  // notice（路径、字符数、预览方式）；完整 AGENTS.md 内容不进入会话。
  const stageTwoNotices = userMessages.filter(event => /^阶段 2：AGENTS\.md 生成/.test(event.data.source.summary))
  check('stage 2 prompt surfaces as a collapsible notice row',
    stageTwoNotices.length === 1
    && stageTwoNotices[0].surfaceOp === 'append'
    && stageTwoNotices[0].data.source.form === 'notice'
    && /^阶段 2：AGENTS\.md 生成（\d+ 行）$/.test(stageTwoNotices[0].data.source.summary)
    && stageTwoNotices[0].data.content[0].text.includes('Task: create an AGENTS.md'),
    JSON.stringify(stageTwoNotices.map(event => event.data.source)))
  const completionNotices = userMessages.filter(event => /^阶段 2：AGENTS\.md 已生成/.test(event.data.source.summary))
  check('stage 2 closes with a brief completion notice, not the content',
    completionNotices.length === 1
    && completionNotices[0].surfaceOp === 'append'
    && completionNotices[0].data.source.form === 'notice'
    && /^阶段 2：AGENTS\.md 已生成（\d+ 字符）$/.test(completionNotices[0].data.source.summary)
    && /AGENTS\.md 已生成：/.test(completionNotices[0].data.content[0].text)
    && !completionNotices[0].data.content[0].text.includes('# AGENTS.md'),
    JSON.stringify(completionNotices.map(event => event.data)))
  // 阶段二 step（step 2）只转发思考过程：reasoning 流块可见、text 块不进入
  // 会话；成功状态消息在完成 step（step 3）以 assistant/message 呈现（来源
  // 复用模型路由，满足持久化加载对 assistant/message 的来源校验）。
  const stepTwoChunks = events.filter(event => event.type === 'assistant/chunk' && event.data.step === 2)
  check('stage 2 streams only the reasoning, hiding the output',
    stepTwoChunks.length >= 2
    && stepTwoChunks.some(event => event.data.chunk.type === 'reasoning-delta')
    && !stepTwoChunks.some(event => event.data.chunk.type === 'text-delta'),
    JSON.stringify(stepTwoChunks.map(event => event.data.chunk)))
  const successMessages = events.filter(event => event.type === 'assistant/message' && event.data.step === 3)
  check('stage 2 closes with a formal success status message',
    successMessages.length === 1
    && successMessages[0].surfaceOp === 'append'
    && successMessages[0].data.message.role === 'assistant'
    && successMessages[0].data.message.source.kind === 'model'
    && successMessages[0].data.message.source.provider === 'smoke-provider'
    && successMessages[0].data.message.source.model === 'smoke-model'
    && /✅ \/init 完成：AGENTS\.md 已生成/.test(successMessages[0].data.message.content[0].text)
    && !successMessages[0].data.message.content[0].text.includes('# AGENTS.md'),
    JSON.stringify(successMessages.map(event => event.data)))
  const chunks = events.filter(event => event.type === 'assistant/chunk')
  check('model chunks streamed live as assistant/chunk',
    chunks.length >= 2 && chunks.some(event => event.data.chunk.type === 'text-delta'),
    `chunk events: ${chunks.length}`)
  // 合成显示不写 turn 边界：turn 0 的 turn/end 会被持久化读取路径按旧格式
  // 损坏拒绝（turn < 1），正数 turn 又会与 agent 循环编号冲突；只写
  // step 层事件即可驱动 GUI 流式渲染，且重启后历史安全加载。
  const turnStarts = events.filter(event => event.type === 'turn/start')
  const turnEnds = events.filter(event => event.type === 'turn/end')
  check('synthetic display writes no turn boundary events',
    turnStarts.length === 0 && turnEnds.length === 0,
    JSON.stringify({
      turnStarts: turnStarts.map(event => event.data),
      turnEnds: turnEnds.map(event => event.data),
    }))
  const stepStarts = events.filter(event => event.type === 'step/start')
  check('steps advance per visible model call', stepStarts.length === 3
    && stepStarts[0].data.step === 1 && stepStarts[1].data.step === 2 && stepStarts[2].data.step === 3
    && stepStarts.every(event => event.data.turn === INIT_TURN),
    JSON.stringify(stepStarts.map(event => event.data)))

  // 阶段一的提示词与模型输出、阶段二的提示词 notice、完成信息 notice 与
  // 成功状态消息进入模型可见的会话表面；生成内容本身不进入会话（只转发
  // 思考过程，内容直接写入文件）。
  const messages = owner.session.deriveMessages()
  check('prompts, stage-2 notices and outputs enter model-visible surface', messages.length === 5,
    `derived messages: ${messages.length}`)
  check('surface nodes rendered', owner.session.surface.nodes.length === 5)

  // 调用记录随 command/done 事件持久化到会话日志（白名单事件，恢复安全）。
  const done = owner.session.events.find(event => event.type === 'command/done')
  check('model calls persisted via command/done',
    done?.type === 'command/done' && typeof done.data.text === 'string' && done.data.text.includes('Model calls:'),
    JSON.stringify(done?.data ?? null))

  const second = await context.commands.execute(owner, '/init', signal)
  check('second /init directly replaces the existing AGENTS.md', second?.result.kind === 'success'
    && second.result.text.includes('Initialized'), second?.result.text ?? '')
  check('replaced content is the fresh model output', await readFile(join(project, 'AGENTS.md'), 'utf8') === GENERATED_MD)

  const dry = await context.commands.execute(owner, '/init --dry-run', signal)
  check('--dry-run reports without writing', dry?.result.kind === 'success' && dry.result.text.includes('dry run'))

  const help = await context.commands.execute(owner, '/init --help', signal)
  const helpMessage = owner.session.events.find(event => event.type === 'assistant/message'
    && typeof event.data.message.content[0]?.text === 'string'
    && event.data.message.content[0].text.startsWith('Usage: /init'))
  check('--help shows usage expanded in the session',
    help?.result.kind === 'success' && helpMessage !== undefined,
    help?.result.text ?? '')

  const depth = await context.commands.execute(owner, '/init --depth 1', signal)
  check('--depth 1 still succeeds', depth?.result.kind === 'success'
    && depth.result.text.includes('Initialized'), depth?.result.text ?? '')

  const bogus = await context.commands.execute(owner, '/init --bogus', signal)
  check('unknown flags are rejected', bogus?.result.kind === 'error' && bogus.result.text.includes('Unknown argument'))

  const forced = await context.commands.execute(owner, '/init --force', signal)
  check('removed --force is rejected as unknown', forced?.result.kind === 'error'
    && forced.result.text.includes('Unknown argument'), forced?.result.text ?? '')

  // 运行统计：默认模式每次 3 个 step（阶段一完整流式 + 阶段二思考过程 +
  // 完成 step），--dry-run 两阶段完整流式（2 个 step），--help 1 个 step
  // （帮助消息）；共 4 次完整运行 + 1 次帮助，step 号互不冲突
  // （1,2,3 → 4,5,6 → 7,8 → 9,10,11 → 12）。
  const stepStartsAll = owner.session.events.filter(event => event.type === 'step/start')
  check('repeated /init runs use disjoint steps',
    stepStartsAll.length === 12 && stepStartsAll.map(event => event.data.step).join(',') === '1,2,3,4,5,6,7,8,9,10,11,12',
    JSON.stringify(stepStartsAll.map(event => event.data)))
  check('all runs persist to the model-visible surface', owner.session.deriveMessages().length === 21,
    `derived messages: ${owner.session.deriveMessages().length}`)
  check('all surface nodes rendered', owner.session.surface.nodes.length === 21)
} catch (error) {
  failed = true
  console.error('SMOKE ERROR:', error)
} finally {
  await context.fiber.dispose()
  await rm(root, { recursive: true, force: true })
}

console.log(failed ? 'SMOKE FAILED' : 'SMOKE PASSED')
process.exit(failed ? 1 : 0)
