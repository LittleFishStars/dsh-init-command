/**
 * dsh-init-command 插件的测试。使用 Node 内置的 node:test 运行器：
 * `npm test`（零依赖）。
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { promisify } from 'node:util'
import {
  INIT_TURN,
  apply,
  applyGitSteps,
  collectTree,
  createAssembler,
  downloadGitignore,
  gitignoreTemplate,
  name,
  nextInitStep,
  normalizeClassified,
  parseClassifiedJson,
  promptLineCount,
  renameMasterToMain,
  resolveRoute,
  streamModelStage,
} from '../index.js'

const execFileAsync = promisify(execFile)

/** @type {string} 所有测试共享的临时目录 */
let scratch

before(async () => {
  scratch = await mkdtemp(path.join(os.tmpdir(), 'dsh-init-command-'))
})

after(async () => {
  await rm(scratch, { recursive: true, force: true })
})

const CLASSIFIED_JSON = '{"projectType": "Node.js web application", "languages": ["JavaScript"], "toolchain": ["npm"], "summary": "A demo app."}'
const GENERATED_MD = '# AGENTS.md\n\n## Project overview\n\nA demo app.\n'
const GENERATED_REASONING = 'Drafting the AGENTS.md from the analyzed structure...'

/**
 * 构造一个记录每次调用参数的 fake `ctx.llm`：根据消息内容区分两阶段，
 * 判断阶段返回 JSON，生成阶段返回 reasoning 块 + AGENTS.md 文本。可通过
 * 选项覆盖输出与终止原因（模拟截断/失败场景）。流的块形状与真实适配器
 * 一致：block-start → reasoning/text-delta → block-end → usage → finish。
 */
function fakeLlm({
  classifyOutput = CLASSIFIED_JSON,
  classifyFinish = { kind: 'stop' },
  generateOutput = GENERATED_MD,
  generateFinish = { kind: 'stop' },
  includeUsage = true,
} = {}) {
  const calls = []
  // 判断阶段：纯 text 流；生成阶段：先 reasoning 块再 text 块（验证
  // reasoningOnly 模式只转发思考过程、隐藏最终输出）。
  const streamFor = (text, withReasoning) => withReasoning
    ? [
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: GENERATED_REASONING },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: GENERATED_REASONING } },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text },
      { type: 'block-end', index: 1, block: { type: 'text', text } },
      ...includeUsage ? [{ type: 'usage', usage: { inputTokens: 10, outputTokens: 20 } }] : [],
    ]
    : [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text },
      { type: 'block-end', index: 0, block: { type: 'text', text } },
      ...includeUsage ? [{ type: 'usage', usage: { inputTokens: 10, outputTokens: 20 } }] : [],
    ]
  return {
    calls,
    stream(options) {
      calls.push(options)
      return (async function* () {
        const text = options.messages[0].content[0].text
        if (text.includes('Respond with ONLY a JSON')) {
          yield* streamFor(classifyOutput, false)
          yield { type: 'finish', reason: classifyFinish }
        } else {
          yield* streamFor(generateOutput, true)
          yield { type: 'finish', reason: generateFinish }
        }
      })()
    },
  }
}

/**
 * 构造一个行为接近真实 Session 的 fake：`events` 返回实时日志（真实
 * Session 每次访问返回包含最新追加的不可变快照），`append` 按
 * `seq = log.length` 契约追加并返回事件。
 */
function fakeSession(cwd, seed = []) {
  const log = [...seed]
  return {
    header: { cwd },
    requestHeader: () => undefined,
    get events() {
      return log
    },
    append(type, data, opts) {
      const event = { type, seq: log.length, time: Date.now(), data, ...opts }
      log.push(event)
      return event
    },
    log,
  }
}

/** 捕获 `apply` 完成的注册，并返回可调用的处理器。 */
function captureRegistration(llm) {
  /** @type {any} */
  let registered
  const ctx = {
    commands: {
      register(definition) {
        registered = definition
        return () => {}
      },
    },
    llm,
  }
  apply(ctx, undefined)
  assert.ok(registered, 'apply 必须注册一个命令')
  return registered
}

/** 为某个项目目录构造一个最小的 CommandInvocation 形状的负载。 */
function invocation(cwd, rawInput = '', agentOverrides = {}) {
  return {
    rawInput,
    agent: {
      session: fakeSession(cwd),
      options: { provider: 'deepseek', model: 'deepseek-chat' },
      ...agentOverrides,
    },
    signal: new AbortController().signal,
  }
}

test('插件元数据', () => {
  assert.equal(name, 'dsh-init-command')
})

test('apply 注册 /init 命令', () => {
  const command = captureRegistration(fakeLlm())
  assert.equal(command.name, 'init')
  assert.ok(command.description.length > 0)
  assert.equal(typeof command.handler, 'function')
  assert.equal(command.input.hint, '[--dry-run] [--git] [--think]')
})

test('两阶段调用：先判断项目类型，再嵌入提示词生成 AGENTS.md', async () => {
  const project = path.join(scratch, 'two-stage')
  const llm = fakeLlm()
  const command = captureRegistration(llm)
  const inv = invocation(project)

  const result = await command.handler(inv)

  assert.equal(result.kind, 'success')
  assert.match(result.text, /Initialized .*AGENTS\.md/)

  // 两次 LLM 调用：判断 + 生成。
  assert.equal(llm.calls.length, 2)
  const [classifyCall, generateCall] = llm.calls
  // 阶段一：发送两层目录结构，要求输出 JSON。
  assert.match(classifyCall.messages[0].content[0].text, /Respond with ONLY a JSON/)
  assert.match(classifyCall.messages[0].content[0].text, /two-stage\//)
  // 阶段一默认关闭思考模式（fake llm 无 resolveCallConfig，视为支持 'off'）；
  // 阶段二保持提供方默认，不传 reasoningEffort。
  assert.equal(classifyCall.reasoningEffort, 'off')
  assert.equal('reasoningEffort' in generateCall, false)
  // 阶段二：项目类型已嵌入提示词。
  assert.match(generateCall.messages[0].content[0].text, /Project type: Node\.js web application/)
  assert.match(generateCall.messages[0].content[0].text, /Languages: JavaScript/)
  assert.match(generateCall.messages[0].content[0].text, /Toolchain: npm/)
  assert.match(generateCall.messages[0].content[0].text, /1\. Project overview/)
  assert.match(generateCall.messages[0].content[0].text, /6\. AI agent guidelines/)
  // AI agent guidelines 小节必须要求：每次完成任务后修正 AGENTS.md。
  assert.match(generateCall.messages[0].content[0].text, /corrects this AGENTS\.md after completing every task/)

  // 模型调用记录随命令结果写入对话历史。
  assert.match(result.text, /Model calls:/)
  assert.match(result.text, /1\. classify — deepseek\/deepseek-chat/)
  assert.match(result.text, /Node\.js web application \[JavaScript\] \[npm\]/)
  assert.match(result.text, /2\. generate — deepseek\/deepseek-chat/)
  assert.match(result.text, /AGENTS\.md \(\d+ chars\)/)

  // 写入的是第二阶段生成的完整内容。
  assert.equal(await readFile(path.join(project, 'AGENTS.md'), 'utf8'), GENERATED_MD)

  // —— 实时流式写入：阶段一完整显示，阶段二只显示思考过程（reasoning 流块
  // 实时转发、最终输出不进入会话），成功后追加完成信息 ——
  const events = inv.agent.session.log
  const types = events.map(event => event.type)
  // 三个阶段 step：阶段一完整流式（step 1）、阶段二思考过程（step 2）、
  // 完成信息（step 3）；合成显示不写 turn/start、turn/end（turn 0 的
  // turn/end 会被持久化读取路径按旧格式损坏拒绝，正数 turn 又会与 agent
  // 循环编号冲突）。
  assert.equal(types.filter(type => type === 'turn/start').length, 0)
  assert.equal(types.filter(type => type === 'turn/end').length, 0)
  assert.deepEqual(events.filter(event => event.type === 'step/start').map(event => event.data.step), [1, 2, 3])
  assert.deepEqual(events.filter(event => event.type === 'step/end').map(event => event.data.step), [1, 2, 3])
  // 三条 user 消息（都是插件注入的 notice 上下文，GUI 折叠显示一行摘要）：
  // 阶段一提示词、阶段二提示词、阶段二完成信息。
  const userMessages = events.filter(event => event.type === 'user/message')
  assert.equal(userMessages.length, 3)
  assert.equal(userMessages[0].surfaceOp, 'append')
  assert.equal(userMessages[0].data.content[0].text, classifyCall.messages[0].content[0].text)
  assert.deepEqual(userMessages[0].data.source, {
    kind: 'plugin',
    plugin: 'dsh-init-command',
    form: 'notice',
    summary: `阶段 1：项目分析（${promptLineCount(classifyCall.messages[0].content[0].text)} 行）`,
  })
  // 阶段二提示词 notice：内容与发送给模型的生成提示词一致。
  assert.equal(userMessages[1].data.content[0].text, generateCall.messages[0].content[0].text)
  assert.deepEqual(userMessages[1].data.source, {
    kind: 'plugin',
    plugin: 'dsh-init-command',
    form: 'notice',
    summary: `阶段 2：AGENTS.md 生成（${promptLineCount(generateCall.messages[0].content[0].text)} 行）`,
  })
  // assistant/chunk：阶段一 5 个全部转发（block-start、text-delta、block-end、
  // usage、finish）；阶段二 reasoningOnly 只转发 reasoning 块与 usage/finish
  // （共 5 个），text 块不进入会话。
  const chunks = events.filter(event => event.type === 'assistant/chunk')
  assert.equal(chunks.length, 10)
  assert.deepEqual(chunks.map(event => event.data.turn), Array(10).fill(INIT_TURN))
  assert.deepEqual(chunks.map(event => event.data.step), [1, 1, 1, 1, 1, 2, 2, 2, 2, 2])
  const stepOneChunks = chunks.filter(event => event.data.step === 1)
  assert.deepEqual(stepOneChunks.map(event => event.data.chunk.type), ['block-start', 'text-delta', 'block-end', 'usage', 'finish'])
  // 阶段二（step 2）只转发思考过程：reasoning 块实时可见，text 块被隐藏。
  const stepTwoChunks = chunks.filter(event => event.data.step === 2)
  assert.deepEqual(stepTwoChunks.map(event => event.data.chunk.type), ['block-start', 'reasoning-delta', 'block-end', 'usage', 'finish'])
  assert.deepEqual(stepTwoChunks.map(event => event.data.chunk.blockType ?? event.data.chunk.block?.type), ['reasoning', undefined, 'reasoning', undefined, undefined])
  assert.ok(!stepTwoChunks.some(event => event.data.chunk.type === 'text-delta'))
  // assistant/message 只有两条：阶段一模型输出（step 1）与合成的成功状态
  // 消息（step 3）——生成的 AGENTS.md 内容不进入会话。
  const assistantMessages = events.filter(event => event.type === 'assistant/message')
  assert.equal(assistantMessages.length, 2)
  // assistant/message 携带组装好的内容、模型来源与 usage。
  assert.equal(assistantMessages[0].surfaceOp, 'append')
  assert.equal(assistantMessages[0].data.message.role, 'assistant')
  assert.equal(assistantMessages[0].data.message.content[0].text, CLASSIFIED_JSON)
  assert.deepEqual(assistantMessages[0].data.message.source, { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' })
  assert.equal(assistantMessages[0].data.usage.inputTokens, 10)
  // sourceEventSeqs 完整覆盖来源 chunk。
  assert.deepEqual(
    assistantMessages[0].sourceEventSeqs,
    stepOneChunks.map(event => event.seq),
  )

  // 阶段二完成信息 notice：只报告路径、字符数与预览方式，不包含 AGENTS.md 内容。
  const completion = userMessages[2]
  assert.equal(completion.surfaceOp, 'append')
  assert.match(completion.data.content[0].text, /^AGENTS\.md 已生成：.+（\d+ 字符）。/)
  assert.match(completion.data.content[0].text, /--dry-run/)
  assert.ok(!completion.data.content[0].text.includes('# AGENTS.md'))
  assert.deepEqual(completion.data.source, {
    kind: 'plugin',
    plugin: 'dsh-init-command',
    form: 'notice',
    summary: `阶段 2：AGENTS.md 已生成（${GENERATED_MD.length} 字符）`,
  })
  // 成功状态消息：以 assistant/message 呈现（来源复用模型路由——会话持久化
  // 加载路径要求 assistant/message 必须携带 model 来源），文本由插件合成，
  // 是形如模型正式输出的成功汇报，不包含 AGENTS.md 内容。
  const success = assistantMessages[1]
  assert.equal(success.surfaceOp, 'append')
  assert.equal(success.data.turn, INIT_TURN)
  assert.equal(success.data.step, 3)
  assert.equal(success.data.message.role, 'assistant')
  assert.deepEqual(success.data.message.source, { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' })
  assert.equal(success.data.usage, undefined)
  assert.match(success.data.message.content[0].text, /✅ \/init 完成：AGENTS\.md 已生成/)
  assert.match(success.data.message.content[0].text, /Node\.js web application/)
  assert.match(success.data.message.content[0].text, /--dry-run/)
  assert.ok(!success.data.message.content[0].text.includes('# AGENTS.md'))
  // 完成 step 是最后一个事件：step 3 正常关闭。
  assert.equal(events.at(-1).type, 'step/end')
  assert.deepEqual(events.at(-1).data, { turn: INIT_TURN, step: 3 })
})

test('已存在的 AGENTS.md 直接替换，旧内容作为改写参考传给模型', async () => {
  const project = path.join(scratch, 'replace')
  const target = path.join(project, 'AGENTS.md')
  await mkdir(project, { recursive: true })
  await writeFile(target, 'stale old content\n', 'utf8')
  const llm = fakeLlm()
  const command = captureRegistration(llm)

  const result = await command.handler(invocation(project))

  assert.equal(result.kind, 'success')
  assert.match(result.text, /Initialized .*AGENTS\.md/)
  const generateText = llm.calls[1].messages[0].content[0].text
  assert.match(generateText, /current AGENTS\.md content/)
  assert.match(generateText, /stale old content/)
  assert.equal(await readFile(target, 'utf8'), GENERATED_MD)
})

test('--dry-run 预览内容而不写入', async () => {
  const project = path.join(scratch, 'dry')
  const target = path.join(project, 'AGENTS.md')
  await mkdir(project, { recursive: true })
  await writeFile(target, 'old\n', 'utf8')
  const llm = fakeLlm()
  const command = captureRegistration(llm)
  const inv = invocation(project, '--dry-run')

  const result = await command.handler(inv)

  assert.equal(result.kind, 'success')
  assert.match(result.text, /dry run/)
  assert.match(result.text, /## Project overview/)
  assert.match(result.text, /Model calls:/)
  assert.match(result.text, /2\. generate — .*dry run, not written/)
  assert.equal(await readFile(target, 'utf8'), 'old\n')
  // --dry-run 时阶段二与阶段一一样完整流式显示（两条 notice、13 个 chunk、
  // 两条 assistant 消息），便于预览。
  const events = inv.agent.session.log
  assert.equal(events.filter(event => event.type === 'user/message').length, 2)
  assert.equal(events.filter(event => event.type === 'step/start').length, 2)
  // 阶段一 5 个 chunk + 阶段二 8 个 chunk（reasoning 块 + text 块 + usage + finish）。
  assert.equal(events.filter(event => event.type === 'assistant/chunk').length, 13)
  assert.equal(events.filter(event => event.type === 'assistant/message').length, 2)
  // 阶段二完整流式时 text 块也可见（与默认模式的 reasoningOnly 相反）。
  const stepTwoChunks = events
    .filter(event => event.type === 'assistant/chunk')
    .filter(event => event.data.step === 2)
  assert.ok(stepTwoChunks.some(event => event.data.chunk.type === 'text-delta'))
})

test('未知参数（含已取消的 --force）报用法错误', async () => {
  const llm = fakeLlm()
  const command = captureRegistration(llm)
  for (const raw of ['--bogus', '--force']) {
    const result = await command.handler(invocation(scratch, raw))
    assert.equal(result.kind, 'error')
    assert.match(result.text, /Unknown argument/)
    assert.equal(llm.calls.length, 0)
  }
})

test('--think 阶段一使用思考模式（不传 reasoningEffort，保持提供方默认）', async () => {
  const project = path.join(scratch, 'think')
  const llm = fakeLlm()
  const command = captureRegistration(llm)

  const result = await command.handler(invocation(project, '--think'))

  assert.equal(result.kind, 'success')
  assert.equal(await readFile(path.join(project, 'AGENTS.md'), 'utf8'), GENERATED_MD)
  // --think 时不传 reasoningEffort：阶段一恢复提供方默认（思考）行为。
  assert.equal('reasoningEffort' in llm.calls[0], false)
})

test('路由模型不支持 reasoning effort 时阶段一自动降级（不传参）', async () => {
  const project = path.join(scratch, 'no-reasoning')
  const llm = fakeLlm()
  llm.resolveCallConfig = async () => {
    throw new Error('provider "p" model "m" does not support reasoning effort "off"')
  }
  const command = captureRegistration(llm)

  const result = await command.handler(invocation(project))

  assert.equal(result.kind, 'success')
  // 探测失败 → 放弃传 reasoningEffort，模型保持其默认行为。
  assert.equal('reasoningEffort' in llm.calls[0], false)
})

test('路由模型支持 reasoning effort 时阶段一默认关闭思考', async () => {
  const project = path.join(scratch, 'reasoning-off')
  const llm = fakeLlm()
  llm.resolveCallConfig = async () => ({ provider: 'deepseek', model: 'deepseek-chat' })
  const command = captureRegistration(llm)

  const result = await command.handler(invocation(project))

  assert.equal(result.kind, 'success')
  assert.equal(llm.calls[0].reasoningEffort, 'off')
  // 阶段二不受影响：不传 reasoningEffort。
  assert.equal('reasoningEffort' in llm.calls[1], false)
})

test('无可用模型路由时报错', async () => {
  const llm = fakeLlm()
  const command = captureRegistration(llm)
  const result = await command.handler(invocation(scratch, '', {
    session: { header: { cwd: scratch } },
    options: {},
  }))
  assert.equal(result.kind, 'error')
  assert.match(result.text, /No provider\/model available/)
})

test('模型流错误时返回错误结果，且 step 正常关闭', async () => {
  const project = path.join(scratch, 'llm-error')
  const llm = fakeLlm({ classifyOutput: '' })
  // 让判断阶段返回错误终止：替换 stream 返回 finish error。
  llm.stream = options => (async function* () {
    yield { type: 'finish', reason: { kind: 'error', failure: { message: 'boom' } } }
  })()
  const command = captureRegistration(llm)
  const inv = invocation(project)

  const result = await command.handler(inv)

  assert.equal(result.kind, 'error')
  assert.match(result.text, /Could not classify the project: boom/)
  // 失败时 step 仍然关闭；合成显示不写 turn 边界事件。
  const events = inv.agent.session.log
  assert.equal(events.filter(event => event.type === 'step/start').length, 1)
  assert.equal(events.filter(event => event.type === 'step/end').length, 1)
  assert.equal(events.filter(event => event.type === 'turn/start').length, 0)
  assert.equal(events.filter(event => event.type === 'turn/end').length, 0)
  // 错误终止不追加 assistant/message（已输出的部分由 GUI 按 interrupted 渲染）。
  assert.equal(events.filter(event => event.type === 'assistant/message').length, 0)
})

test('模型输出无法解析为 JSON 时宽容降级', async () => {
  const project = path.join(scratch, 'bad-json')
  const llm = fakeLlm({ classifyOutput: '```json\n{"projectType": "Go service"}\n```' })
  const command = captureRegistration(llm)

  const result = await command.handler(invocation(project))

  assert.equal(result.kind, 'success')
  const generateText = llm.calls[1].messages[0].content[0].text
  assert.match(generateText, /Project type: Go service/)
})

test('分类阶段 max-tokens 截断但 JSON 完整时继续生成', async () => {
  const project = path.join(scratch, 'truncated-classify')
  const llm = fakeLlm({ classifyFinish: { kind: 'max-tokens' } })
  const command = captureRegistration(llm)

  const result = await command.handler(invocation(project))

  assert.equal(result.kind, 'success')
  assert.match(result.text, /Node\.js web application/)
  // 不设置 maxTokens：调用不携带该参数（由适配器默认上限决定）。
  assert.equal('maxTokens' in llm.calls[0], false)
  const generateText = llm.calls[1].messages[0].content[0].text
  assert.match(generateText, /Project type: Node\.js web application/)
})

test('分类阶段截断且无法解析时降级为 unknown 继续', async () => {
  const project = path.join(scratch, 'truncated-garbage')
  const llm = fakeLlm({
    classifyOutput: 'truncated garbage without json',
    classifyFinish: { kind: 'max-tokens' },
  })
  const command = captureRegistration(llm)

  const result = await command.handler(invocation(project))

  assert.equal(result.kind, 'success')
  const generateText = llm.calls[1].messages[0].content[0].text
  assert.match(generateText, /Project type: unknown/)
})

test('生成阶段 max-tokens 截断时报错且不写文件', async () => {
  const project = path.join(scratch, 'truncated-generate')
  const llm = fakeLlm({ generateFinish: { kind: 'max-tokens' } })
  const command = captureRegistration(llm)

  const result = await command.handler(invocation(project))

  assert.equal(result.kind, 'error')
  assert.match(result.text, /Could not generate AGENTS\.md/)
  assert.match(result.text, /truncated/)
  // 已完成的分类调用仍记录在错误文本里。
  assert.match(result.text, /Model calls:/)
  assert.match(result.text, /1\. classify/)
  await assert.rejects(readFile(path.join(project, 'AGENTS.md'), 'utf8'), { code: 'ENOENT' })
})

test('collectTree 收集两层目录并折叠超限条目', async () => {
  const project = path.join(scratch, 'tree')
  await mkdir(path.join(project, 'src', 'utils'), { recursive: true })
  await mkdir(path.join(project, 'docs'), { recursive: true })
  await writeFile(path.join(project, 'package.json'), '{}')
  await writeFile(path.join(project, 'src', 'main.js'), '')
  await writeFile(path.join(project, 'src', 'utils', 'fmt.js'), '')
  await writeFile(path.join(project, 'docs', 'guide.md'), '')
  await writeFile(path.join(project, 'README.md'), '')

  const lines = await collectTree(project)

  assert.equal(lines[0], 'tree/')
  assert.ok(lines.includes('package.json'))
  assert.ok(lines.includes('README.md'))
  assert.ok(lines.includes('src/'))
  assert.ok(lines.includes('  main.js'))
  assert.ok(lines.includes('  utils/'))
  assert.ok(lines.includes('docs/'))
  // .git、node_modules 等噪音被跳过。
  assert.ok(!lines.some(line => line.includes('.git')))
})

test('parseClassifiedJson 剥离 markdown 围栏并容错', () => {
  assert.deepEqual(parseClassifiedJson(CLASSIFIED_JSON), JSON.parse(CLASSIFIED_JSON))
  assert.deepEqual(parseClassifiedJson(`prefix\n${CLASSIFIED_JSON}\nsuffix`), JSON.parse(CLASSIFIED_JSON))
  assert.equal(parseClassifiedJson('not json'), null)
})

test('normalizeClassified 规整缺失字段', () => {
  assert.deepEqual(normalizeClassified(JSON.parse(CLASSIFIED_JSON)), {
    projectType: 'Node.js web application',
    languages: 'JavaScript',
    toolchain: 'npm',
    summary: 'A demo app.',
  })
  assert.deepEqual(normalizeClassified(null), {
    projectType: 'unknown',
    languages: '',
    toolchain: '',
    summary: '',
  })
})

test('resolveRoute 依次回退：config → 会话最近请求 → agent 选项', () => {
  const agent = {
    options: { provider: 'agent-provider', model: 'agent-model' },
    session: { requestHeader: () => ({ config: { provider: 'session-provider', model: 'session-model' } }) },
  }
  assert.deepEqual(resolveRoute({ provider: 'cfg', model: 'm' }, agent), { provider: 'cfg', model: 'm' })
  assert.deepEqual(resolveRoute(undefined, agent), { provider: 'session-provider', model: 'session-model' })
  assert.deepEqual(resolveRoute(undefined, { options: { provider: 'p', model: 'm' } }), { provider: 'p', model: 'm' })
  assert.equal(resolveRoute(undefined, { options: {} }), undefined)
})

test('nextInitStep 从 1 开始，并随已关闭的 step 递增（多次 /init 不冲突）', () => {
  const session = fakeSession('/tmp/x')
  assert.equal(nextInitStep(session), 1)
  // 模拟一次完整 /init：turn 0 坐标下关闭 step 1、2（不写 turn 边界）。
  session.append('step/start', { turn: INIT_TURN, step: 1 })
  session.append('step/end', { turn: INIT_TURN, step: 1 })
  session.append('step/start', { turn: INIT_TURN, step: 2 })
  session.append('step/end', { turn: INIT_TURN, step: 2 })
  assert.equal(nextInitStep(session), 3)
})

test('createAssembler 组装 text/reasoning/tool-call 块并容忍纯 delta 流', () => {
  const assembler = createAssembler()
  assembler.push({ type: 'block-start', index: 0, blockType: 'reasoning' })
  assembler.push({ type: 'reasoning-delta', index: 0, text: 'think' })
  assembler.push({ type: 'block-end', index: 0, block: { type: 'reasoning', text: 'think' } })
  assembler.push({ type: 'block-start', index: 1, blockType: 'text' })
  assembler.push({ type: 'text-delta', index: 1, text: 'hello ' })
  assembler.push({ type: 'text-delta', index: 1, text: 'world' })
  assembler.push({ type: 'block-end', index: 1, block: { type: 'text', text: 'hello world' } })
  assembler.push({ type: 'usage', usage: { inputTokens: 5, outputTokens: 9 } })
  assembler.push({ type: 'finish', reason: { kind: 'stop' } })
  assert.deepEqual(assembler.blocks(), [
    { type: 'reasoning', text: 'think' },
    { type: 'text', text: 'hello world' },
  ])
  // text() 只拼接 text 块，不含 reasoning。
  assert.equal(assembler.text(), 'hello world')
  assert.deepEqual(assembler.usage, { inputTokens: 5, outputTokens: 9 })
  assert.equal(assembler.finish.kind, 'stop')

  // 纯 delta 流（无 block-start/end）：按 delta 类型推断块类型。
  const deltaOnly = createAssembler()
  deltaOnly.push({ type: 'text-delta', index: 0, text: 'plain' })
  assert.deepEqual(deltaOnly.blocks(), [{ type: 'text', text: 'plain' }])

  // tool-call 增量。
  const tools = createAssembler()
  tools.push({ type: 'tool-call-delta', index: 0, id: 'call-1', name: 'read', argumentsDelta: '{"a"' })
  tools.push({ type: 'tool-call-delta', index: 0, id: 'call-1', argumentsDelta: ':1}' })
  assert.deepEqual(tools.blocks(), [
    { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"a":1}' },
  ])
})

test('streamModelStage 直接调用时实时写入提示词、流块与 step 开合（不写 turn 边界）', async () => {
  const llm = fakeLlm()
  const session = fakeSession('/tmp/x')
  const route = { provider: 'deepseek', model: 'deepseek-chat' }
  const signal = new AbortController().signal
  const prompt = 'Analyze this repo.'
  const inv = { signal }

  const output = await streamModelStage({ llm }, session, inv, route, nextInitStep(session), prompt, {
    label: '测试阶段',
    temperature: 0,
  })

  // 提示词不含分类标记，走生成分支（reasoning 块 + text 块）。
  assert.equal(output.text, GENERATED_MD)
  assert.deepEqual(output.blocks.map(block => block.type), ['reasoning', 'text'])
  assert.equal(llm.calls[0].temperature, 0)
  const types = session.log.map(event => event.type)
  assert.deepEqual(
    types.filter(type => ['step/start', 'user/message', 'assistant/message', 'step/end'].includes(type)),
    ['step/start', 'user/message', 'assistant/message', 'step/end'],
  )
  // 合成显示不写 turn 边界：turn 0 的 turn/end 会被持久化读取路径拒绝。
  assert.equal(types.filter(type => type === 'turn/start').length, 0)
  assert.equal(types.filter(type => type === 'turn/end').length, 0)
  // 提示词作为插件注入的 notice 上下文：内容与发送给模型的一致，
  // 折叠行摘要携带阶段标签与行数。
  const userMessage = session.log.find(event => event.type === 'user/message')
  assert.equal(userMessage.data.content[0].text, prompt)
  assert.deepEqual(userMessage.data.source, {
    kind: 'plugin',
    plugin: 'dsh-init-command',
    form: 'notice',
    summary: `测试阶段（${promptLineCount(prompt)} 行）`,
  })
  // step/end 正常关闭。
  assert.equal(session.log.at(-1).type, 'step/end')
  assert.deepEqual(session.log.at(-1).data, { turn: INIT_TURN, step: 1 })
})

test('streamModelStage silent 模式不写入任何会话事件', async () => {
  const llm = fakeLlm()
  const session = fakeSession('/tmp/x')
  const route = { provider: 'deepseek', model: 'deepseek-chat' }
  const inv = { signal: new AbortController().signal }

  const output = await streamModelStage({ llm }, session, inv, route, nextInitStep(session), 'Generate AGENTS.md.', {
    label: '静默阶段',
    silent: true,
  })

  // 静默模式仍返回完整文本，但提示词、流块、step 开合都不写入日志。
  assert.equal(output.text, GENERATED_MD)
  assert.equal(session.log.length, 0)
})

test('gitignoreTemplate 按语言/工具链/项目类型匹配模板', () => {
  assert.equal(gitignoreTemplate({ projectType: 'Node.js web application', languages: 'JavaScript', toolchain: 'npm' }), 'Node')
  assert.equal(gitignoreTemplate({ projectType: 'Frontend app', languages: 'TypeScript', toolchain: 'Next.js' }), 'Nextjs')
  assert.equal(gitignoreTemplate({ projectType: 'Go service', languages: 'Go', toolchain: '' }), 'Go')
  assert.equal(gitignoreTemplate({ projectType: 'Python data pipeline', languages: 'Python', toolchain: 'pip' }), 'Python')
  assert.equal(gitignoreTemplate({ projectType: 'Backend', languages: 'Java', toolchain: 'Spring Boot' }), 'Java')
  assert.equal(gitignoreTemplate({ projectType: 'Mobile app', languages: 'Kotlin', toolchain: 'Android SDK' }), 'Kotlin')
  assert.equal(gitignoreTemplate({ projectType: 'Web service', languages: 'C#', toolchain: '.NET' }), 'Dotnet')
  assert.equal(gitignoreTemplate({ projectType: 'iOS app', languages: 'Swift', toolchain: 'Xcode' }), 'Swift')
  assert.equal(gitignoreTemplate({ projectType: 'Desktop', languages: 'C++', toolchain: 'CMake' }), 'C++')
  assert.equal(gitignoreTemplate({ projectType: 'Legacy system', languages: 'COBOL', toolchain: 'z/OS' }), undefined)
})

test('downloadGitignore 请求 github/gitignore 并返回内容', async () => {
  const urls = []
  const fetcher = async url => {
    urls.push(url)
    return { status: 200, text: 'node_modules/\n' }
  }

  const ok = await downloadGitignore('Node', fetcher)

  assert.equal(ok.ok, true)
  assert.equal(ok.text, 'node_modules/\n')
  assert.equal(urls[0], 'https://raw.githubusercontent.com/github/gitignore/main/Node.gitignore')

  const missing = await downloadGitignore('Node', async () => ({ status: 404, text: '' }))
  assert.equal(missing.ok, false)
  assert.equal(missing.status, 404)
})

test('renameMasterToMain 把 master 重命名为 main（未提交与已提交仓库）', async () => {
  const unborn = path.join(scratch, 'rename-unborn')
  await mkdir(unborn, { recursive: true })
  await execFileAsync('git', ['-C', unborn, '-c', 'init.defaultBranch=master', 'init'])
  assert.equal(await renameMasterToMain(unborn), true)
  const unbornHead = await execFileAsync('git', ['-C', unborn, 'symbolic-ref', '--short', 'HEAD'])
  assert.equal(unbornHead.stdout.trim(), 'main')
  // 已是 main 时不再重命名。
  assert.equal(await renameMasterToMain(unborn), false)

  const committed = path.join(scratch, 'rename-committed')
  await mkdir(committed, { recursive: true })
  await execFileAsync('git', ['-C', committed, '-c', 'init.defaultBranch=master', 'init'])
  await execFileAsync('git', ['-C', committed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-m', 'init'])
  assert.equal(await renameMasterToMain(committed), true)
  const committedBranch = await execFileAsync('git', ['-C', committed, 'branch', '--show-current'])
  assert.equal(committedBranch.stdout.trim(), 'main')
})

test('applyGitSteps 初始化仓库、重命名分支并下载 .gitignore', async () => {
  const project = path.join(scratch, 'git-steps')
  await mkdir(project, { recursive: true })
  const fetcher = async () => ({ status: 200, text: 'node_modules/\n' })
  const profile = { projectType: 'Node.js web application', languages: 'JavaScript', toolchain: 'npm' }

  const lines = await applyGitSteps(project, profile, { fetcher })

  const text = lines.join('; ')
  assert.match(text, /initialized a new git repository/)
  assert.match(text, /downloaded \.gitignore from github\/gitignore \(Node\)/)
  assert.equal(await readFile(path.join(project, '.gitignore'), 'utf8'), 'node_modules/\n')
  const head = await execFileAsync('git', ['-C', project, 'symbolic-ref', '--short', 'HEAD'])
  assert.equal(head.stdout.trim(), 'main')
})

test('applyGitSteps 不覆盖已存在的 .gitignore，未知类型不下载', async () => {
  const project = path.join(scratch, 'git-steps-existing')
  await mkdir(project, { recursive: true })
  await writeFile(path.join(project, '.gitignore'), 'custom\n', 'utf8')
  const fetcher = async () => ({ status: 200, text: 'node_modules/\n' })
  const profile = { projectType: 'Node.js web application', languages: 'JavaScript', toolchain: 'npm' }

  const lines = await applyGitSteps(project, profile, { fetcher })

  assert.match(lines.join('; '), /\.gitignore already exists/)
  assert.equal(await readFile(path.join(project, '.gitignore'), 'utf8'), 'custom\n')

  const unknown = path.join(scratch, 'git-steps-unknown')
  await mkdir(unknown, { recursive: true })
  const unknownLines = await applyGitSteps(
    unknown,
    { projectType: 'Legacy mainframe', languages: 'COBOL', toolchain: '' },
    { fetcher },
  )
  assert.match(unknownLines.join('; '), /no matching \.gitignore template/)
  await assert.rejects(readFile(path.join(unknown, '.gitignore'), 'utf8'), { code: 'ENOENT' })
})

test('applyGitSteps 项目位于父仓库内时不新建嵌套仓库', async () => {
  const parent = path.join(scratch, 'parent-repo')
  const child = path.join(parent, 'sub')
  await mkdir(child, { recursive: true })
  await execFileAsync('git', ['-C', parent, 'init'])

  const lines = await applyGitSteps(
    child,
    { projectType: 'Node.js', languages: 'JavaScript', toolchain: 'npm' },
    { fetcher: async () => ({ status: 200, text: 'x\n' }) },
  )

  assert.match(lines.join('; '), /inside an existing git repository/)
  await assert.rejects(readFile(path.join(child, '.gitignore'), 'utf8'), { code: 'ENOENT' })
})

test('/init --git 初始化仓库、master → main 并跳过无匹配的 .gitignore', async () => {
  const project = path.join(scratch, 'init-git')
  const llm = fakeLlm({
    classifyOutput: '{"projectType": "Legacy mainframe system", "languages": ["COBOL"], "toolchain": ["z/OS"]}',
  })
  const command = captureRegistration(llm)

  const result = await command.handler(invocation(project, '--git'))

  assert.equal(result.kind, 'success')
  assert.match(result.text, /Git: .*initialized a new git repository/)
  assert.match(result.text, /no matching \.gitignore template/)
  assert.equal(await readFile(path.join(project, 'AGENTS.md'), 'utf8'), GENERATED_MD)
  const head = await execFileAsync('git', ['-C', project, 'symbolic-ref', '--short', 'HEAD'])
  assert.equal(head.stdout.trim(), 'main')
})

test('/init --git --dry-run 只提示将做什么而不执行任何写入', async () => {
  const project = path.join(scratch, 'init-git-dry')
  const llm = fakeLlm()
  const command = captureRegistration(llm)

  const result = await command.handler(invocation(project, '--git --dry-run'))

  assert.equal(result.kind, 'success')
  assert.match(result.text, /dry run/)
  assert.match(result.text, /--git skipped \(dry run\): would initialize a git repository and download Node\.gitignore/)
  await assert.rejects(readFile(path.join(project, 'AGENTS.md'), 'utf8'), { code: 'ENOENT' })
  await assert.rejects(readFile(path.join(project, '.git', 'HEAD'), 'utf8'), { code: 'ENOENT' })
})
