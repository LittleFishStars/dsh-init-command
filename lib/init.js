/** /init 主流程：两阶段模型调用、写入 AGENTS.md、--git 收尾。 */

import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { applyGitSteps, commitInitial } from './git.js'
import { gitignoreTemplate } from './gitignore.js'
import {
  appendNoticeStep,
  nextInitStep,
  resolveRoute,
  streamModelStage,
  supportsReasoningEffort,
} from './model.js'
import {
  classifyPrompt,
  formatModelCalls,
  generatePrompt,
  normalizeClassified,
  parseClassifiedJson,
} from './prompts.js'
import { atomicWriteFile, collectTree, exists } from './tree.js'

const USAGE = 'Usage: /init [--dry-run] [--git] [--commit] [--think] [--depth <n>] [--ignore <pattern>] [--desc <text>] [--help]'

const HELP = [
  USAGE,
  '',
  'Flags:',
  '  --dry-run           preview the generated AGENTS.md without writing',
  '  --git               initialize a git repo (if missing), rename master → main,',
  '                      download a matching .gitignore from github/gitignore',
  '  --commit            create an initial git commit with AGENTS.md (implies --git)',
  '  --think             enable thinking for stage 1 (project analysis)',
  '  --depth <n>         directory tree depth: 1 = top level, 2 = two levels (default), -1 = unlimited',
  '  --ignore <pattern>  skip entries whose name matches (repeatable or comma-separated)',
  '  --desc <text>       describe the project when the directory is empty (place it last;',
  '                      consumes the rest of the line)',
  '  --help, -h          show this help',
].join('\n')

/** 合成消息的来源回退（无可用模型路由时）：占位 provider/model 满足持久化校验。 */
const FALLBACK_SOURCE = { provider: 'dsh', model: 'init-help' }

/**
 * 展示 `/init` 帮助。命令结果卡片会把多行文本折叠成一行摘要（点击展开，
 * 见 DSH 的 GenericCommandCard），因此按合成 step 的模式把帮助写进会话：
 * 以 `assistant/message` 完整展开显示。
 */
function showHelp(config, invocation) {
  const session = invocation.agent?.session
  if (session) {
    const route = resolveRoute(config, invocation.agent) ?? FALLBACK_SOURCE
    appendNoticeStep(session, nextInitStep(session), route, {
      summary: '帮助：/init 用法',
      text: '下面是 /init 命令的完整用法（命令结果卡片会折叠多行文本，故在此展开显示）。',
    }, HELP)
  }
  return { kind: 'success', text: '帮助已在上方展开显示。' }
}

/**
 * 目录为空时向用户询问项目内容（注明此项目还未制作），不调用模型。
 * 用户可用 `/init --desc "<项目描述>"` 提供内容，或先创建项目文件再重试。
 */
function askForProject(config, invocation) {
  const session = invocation.agent?.session
  if (session) {
    const route = resolveRoute(config, invocation.agent) ?? FALLBACK_SOURCE
    const ask = [
      '项目目录为空——此项目还未制作。',
      '',
      '请提供项目内容后再生成 AGENTS.md，任选其一：',
      '· 运行 /init --desc "<项目描述>" 描述项目（例如：Node.js Web 服务，Express + SQLite，提供用户认证 API）；',
      '· 或先在目录中创建项目文件，再运行 /init。',
    ].join('\n')
    appendNoticeStep(session, nextInitStep(session), route, {
      summary: '项目目录为空：此项目还未制作',
      text: '项目目录为空——此项目还未制作。请用 /init --desc "<项目描述>" 提供项目内容，或先创建项目文件后再运行 /init。',
    }, ask)
  }
  return { kind: 'success', text: '项目目录为空，此项目还未制作——请提供项目内容（见上方说明）。' }
}

/** 解析 `/init` 参数；遇到未知参数或参数缺值返回用法错误消息。 */
function parseArgs(rawInput) {
  const args = rawInput.trim().split(/\s+/u).filter(Boolean)
  const flags = { dryRun: false, git: false, commit: false, think: false, help: false, depth: undefined, ignore: [], desc: undefined }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--dry-run') {
      flags.dryRun = true
    } else if (arg === '--git') {
      flags.git = true
    } else if (arg === '--commit') {
      flags.commit = true
    } else if (arg === '--think') {
      flags.think = true
    } else if (arg === '--help' || arg === '-h') {
      flags.help = true
    } else if (arg === '--depth') {
      const value = args[++index]
      if (value === undefined || !/^-?\d+$/u.test(value)) {
        return `--depth requires an integer (-1 for unlimited). ${USAGE}`
      }
      flags.depth = Number(value)
    } else if (arg === '--ignore') {
      const value = args[++index]
      if (value === undefined) {
        return `--ignore requires a pattern (repeatable or comma-separated). ${USAGE}`
      }
      flags.ignore.push(...value.split(',').map(part => part.trim()).filter(Boolean))
    } else if (arg === '--desc') {
      // 描述可含空格：取剩余全部参数，故 --desc 应放在最后。
      const value = args.slice(index + 1).join(' ').trim()
      if (value.length === 0) {
        return `--desc requires a project description (place it last). ${USAGE}`
      }
      flags.desc = value
      index = args.length
    } else {
      return `Unknown argument "${arg}". ${USAGE}`
    }
  }
  return flags
}
/**
 * 执行 `/init` 流程：收集目录树 → （目录为空时询问用户，或基于 --desc 直接
 * 生成规划稿）→ 判断项目类型 → 生成 AGENTS.md。阶段一实时流式显示，默认
 * 关闭思考模式（`--think` 恢复提供方默认）；阶段二默认只显示思考过程
 * （reasoning 流块实时可见，最终输出不进入会话、直接写文件，成功后追加
 * 完成信息，见 {@link appendNoticeStep}），`--dry-run` 时完整流式显示。
 * `--git`/`--commit` 时写入后执行 git 步骤（{@link applyGitSteps}、
 * {@link commitInitial}；与 `--dry-run` 组合只提示）。
 * `--depth`/`--ignore` 控制目录树收集（见 {@link collectTree}）。
 * @returns {Promise<{ kind: 'success' | 'error', text: string }>} 命令结果。
 */
export async function executeInit(ctx, config, invocation) {
  const parsed = parseArgs(invocation.rawInput)
  if (typeof parsed === 'string') return { kind: 'error', text: parsed }
  if (parsed.help) return showHelp(config, invocation)
  // --commit 隐式启用 --git（需要仓库才能提交）。
  const git = parsed.git || parsed.commit

  const root = invocation.agent?.session?.header?.cwd ?? process.cwd()
  const target = path.join(root, 'AGENTS.md')

  const existing = await exists(target)
  if (invocation.signal?.aborted) {
    return { kind: 'error', text: 'Init cancelled.' }
  }

  const session = invocation.agent.session
  const treeLines = await collectTree(root, { depth: parsed.depth, ignore: parsed.ignore })
  const treeText = treeLines.join('\n')
  const isEmpty = treeLines.length === 1

  // 目录为空且未提供描述：向用户询问项目内容（注明此项目还未制作）。
  if (isEmpty && parsed.desc === undefined) {
    return askForProject(config, invocation)
  }

  const route = resolveRoute(config, invocation.agent)
  if (route === undefined) {
    return {
      kind: 'error',
      text: 'No provider/model available for /init. Configure provider and model on the plugin row, route one request in this session, or set agent options.',
    }
  }

  const existingContent = existing
    ? await readFile(target, 'utf8').catch(() => undefined)
    : undefined

  /** @type {Array<{ stage: string, route: { provider: string, model: string }, prompt: string, result: string }>} */
  const calls = []
  let step = nextInitStep(session)
  let profile
  if (isEmpty) {
    // 空目录 + --desc：跳过分类（没有目录结构可分析），项目画像直接来自
    // 用户描述；生成时注明项目尚未制作（见 generatePrompt 的 notImplemented）。
    profile = {
      projectType: '未制作项目（基于用户描述）',
      languages: '',
      toolchain: '',
      summary: parsed.desc,
    }
    calls.push({
      stage: 'describe',
      route,
      prompt: parsed.desc,
      result: `user-provided project description (${parsed.desc.length} chars)`,
    })
  } else {
    // 阶段一：让模型判断项目类型。默认关闭思考（--think 恢复），仅当路由
    // 模型支持时才传 reasoningEffort；宽容截断——JSON 解析失败则降级 unknown。
    const classifyText = classifyPrompt(treeText)
    const noThink = !parsed.think && await supportsReasoningEffort(ctx, route, invocation.signal, 'off')
    try {
      const raw = await streamModelStage(ctx, session, invocation, route, step++, classifyText, {
        label: '阶段 1：项目分析',
        temperature: 0,
        tolerateTruncation: true,
        ...noThink ? { reasoningEffort: 'off' } : {},
      })
      profile = normalizeClassified(parseClassifiedJson(raw.text))
      // 用户提供的 --desc 覆盖分类得出的一句话简介。
      if (parsed.desc !== undefined) profile.summary = parsed.desc
      const tags = [profile.languages, profile.toolchain].filter(Boolean).map(tag => `[${tag}]`).join(' ')
      calls.push({
        stage: 'classify',
        route,
        prompt: classifyText,
        result: `${profile.projectType} ${tags}`.trim(),
      })
    } catch (error) {
      // 流中途被取消（signal 中止）时统一返回 Init cancelled.，而不是模型报错。
      if (invocation.signal?.aborted) return { kind: 'error', text: 'Init cancelled.' }
      return {
        kind: 'error',
        text: `Could not classify the project: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }
  if (invocation.signal?.aborted) {
    return { kind: 'error', text: 'Init cancelled.' }
  }

  // 阶段二：生成 AGENTS.md。默认只显示思考过程（reasoningOnly：reasoning
  // 流块实时可见，最终输出不进入会话、直接写文件）；--dry-run 时完整流式显示。
  let content
  try {
    const generateText = generatePrompt(treeText, profile, existingContent, { notImplemented: isEmpty })
    const generated = await streamModelStage(ctx, session, invocation, route, step, generateText, {
      label: '阶段 2：AGENTS.md 生成',
      reasoningOnly: !parsed.dryRun,
    })
    content = generated.text
    calls.push({
      stage: 'generate',
      route,
      prompt: generateText,
      result: `AGENTS.md (${content.length} chars)${parsed.dryRun ? ' (dry run, not written)' : ''}`,
    })
  } catch (error) {
    // 流中途被取消时统一返回 Init cancelled.。
    if (invocation.signal?.aborted) return { kind: 'error', text: 'Init cancelled.' }
    // 生成失败时仍把已完成的调用记录附在错误文本里，方便排查。
    const record = calls.length > 0 ? `\n\n${formatModelCalls(calls)}` : ''
    return {
      kind: 'error',
      text: `Could not generate AGENTS.md: ${error instanceof Error ? error.message : String(error)}${record}`,
    }
  }

  const modelCalls = formatModelCalls(calls)
  // --git / --commit 的说明行：dry-run 只提示将做什么，不执行任何写入。
  let gitLines = []
  if (git && parsed.dryRun) {
    const template = gitignoreTemplate(profile)
    gitLines = [template === undefined
      ? '--git skipped (dry run): would initialize a git repository and download a matching .gitignore'
      : `--git skipped (dry run): would initialize a git repository and download ${template}.gitignore`]
    if (parsed.commit) {
      gitLines.push('--commit skipped (dry run): would create an initial git commit with AGENTS.md')
    }
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
    await atomicWriteFile(target, content)
  } catch (error) {
    return {
      kind: 'error',
      text: `Could not write ${target}: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  // 默认模式不展示 AGENTS.md 内容（阶段二 step 只含提示词与思考过程），
  // 追加完成信息与成功状态消息（见 appendNoticeStep），用下一个 step。
  if (!parsed.dryRun) {
    appendNoticeStep(session, step + 1, route, {
      summary: `阶段 2：AGENTS.md 已生成（${content.length} 字符）`,
      text: `AGENTS.md 已生成：${target}（${content.length} 字符）。`,
    }, [
      `✅ /init 完成：AGENTS.md 已生成`,
      `文件：${target}（${content.length} 字符）`,
      `项目类型：${profile.projectType}`,
    ].join('\n'))
  }

  // —— --git / --commit：初始化仓库（如缺失）、master → main、下载 .gitignore、
  // 创建初始提交 ——
  if (git) {
    if (invocation.signal?.aborted) {
      return { kind: 'error', text: 'Init cancelled.' }
    }
    gitLines = await applyGitSteps(root, profile)
    if (parsed.commit) {
      if (await commitInitial(root)) {
        gitLines.push('created an initial git commit with AGENTS.md')
      } else {
        gitLines.push('could not create the initial commit (configure git user.name/user.email and retry)')
      }
    }
  }
  const finalGitText = gitLines.length > 0 ? `\n\nGit: ${gitLines.join('; ')}` : ''
  return {
    kind: 'success',
    text: `Initialized ${target} (${profile.projectType}). Review the generated AGENTS.md and adjust it to your conventions.${finalGitText}\n\n${modelCalls}`,
  }
}
