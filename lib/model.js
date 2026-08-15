/** LLM 流式调用与会话可见性：组装器、模型路由、step 合成显示。 */

import { randomUUID } from 'node:crypto'
import { promptLineCount } from './prompts.js'

/** 插件名（会话事件 source 标记；与 index.js 的 `name` 保持一致）。 */
export const PLUGIN_NAME = 'dsh-init-command'

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
/** 构造一条 user 角色消息（与 `@deepseek-ai/dsh-llm` 的 Message 形状一致）。 */
function userMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: PLUGIN_NAME },
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
 * reasoningOnly 模式下转发的块：只转发 reasoning 相关的流块与 usage/finish，
 * 跳过 text / tool-call 块——思考过程实时可见，最终输出不进入会话。
 */
function isReasoningChunk(chunk) {
  switch (chunk.type) {
    case 'block-start':
      return chunk.blockType === 'reasoning'
    case 'reasoning-delta':
      return true
    case 'block-end':
      return chunk.block?.type === 'reasoning'
    case 'usage':
    case 'finish':
      return true
    default:
      return false
  }
}

/**
 * 执行一次 LLM 调用；visible 时把全过程实时写入会话日志，silent 时不写
 * 任何会话事件、只返回文本。
 *
 * visible 事件序列：`step/start` → `user/message`（提示词，notice 上下文，
 * GUI 折叠为一行摘要）→ `assistant/chunk`*（逐块实时转发）→
 * `assistant/message`（正常终止时，携带 usage 与来源 chunk 序号）→
 * `step/end`。`reasoningOnly` 时只转发 reasoning 流块且不追加
 * `assistant/message`（思考过程可见、最终输出不进会话）。不写 turn 边界
 * （见 {@link INIT_TURN}）；调用失败时不追加 `assistant/message`，只关闭
 * step，已流出部分在 GUI 中按 interrupted 渲染。
 *
 * @param {object} ctx - Cordis 上下文（携带 llm 服务）。
 * @param {object} session - 接收命令的 agent 的会话。
 * @param {object} invocation - 命令调用负载（提供 signal）。
 * @param {{ provider: string, model: string }} route - 模型路由。
 * @param {number} step - 本次调用在 turn 0 中的 step 号。
 * @param {string} prompt - 发送给模型的 user 消息文本。
 * @param {{ label?: string, temperature?: number, reasoningEffort?: string, tolerateTruncation?: boolean, silent?: boolean, reasoningOnly?: boolean }} [options]
 *   `label` 用于折叠行摘要；`silent` 为 true 时不写任何会话事件；
 *   `reasoningOnly` 为 true 时只转发 reasoning 流块、不追加最终消息
 *   （阶段二默认模式，成功后由调用方追加完成信息，见
 *   {@link appendCompletionNotice}）。
 * @returns {Promise<{ text: string, blocks: Array<object>, usage?: object, finish: { kind: string } }>}
 */
export async function streamModelStage(ctx, session, invocation, route, step, prompt, options = {}) {
  const {
    label = 'Init',
    temperature,
    reasoningEffort,
    tolerateTruncation = false,
    silent = false,
    reasoningOnly = false,
  } = options
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
        plugin: PLUGIN_NAME,
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
      // reasoningOnly 时只转发 reasoning 流块（思考过程实时可见），
      // text / tool-call 块不进入会话（最终输出被隐藏）。
      if (visible && (!reasoningOnly || isReasoningChunk(chunk))) {
        chunkSeqs.push(session.append('assistant/chunk', { turn: INIT_TURN, step, chunk }).seq)
      }
      assembler.push(chunk)
    }
    finish = assembler.finish
    blocks = assembler.blocks()
    // 正常终止才组装最终消息；错误/中止只留流式块，由 GUI 按 interrupted 渲染。
    // reasoningOnly 模式不追加最终消息：内容只在返回值里，由调用方直接写文件。
    if (visible && !reasoningOnly && (finish?.kind === 'stop' || finish?.kind === 'max-tokens')) {
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
export async function supportsReasoningEffort(ctx, route, signal, effort) {
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
export function appendCompletionNotice(session, step, route, notice, success) {
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
