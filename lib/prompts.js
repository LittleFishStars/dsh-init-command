/** 两阶段提示词构造、分类结果解析与调用记录格式化。 */

/** 阶段一提示词：让模型根据目录结构判断项目类型与工具链。 */
export function classifyPrompt(treeText) {
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
export function generatePrompt(treeText, profile, existing) {
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
export function formatModelCalls(calls) {
  const lines = calls.map((call, index) => {
    const prompt = promptSummaryOf(call.prompt)
    return `${index + 1}. ${call.stage} — ${call.route.provider}/${call.route.model} — prompt: ${prompt} — result: ${call.result}`
  })
  return ['Model calls:', ...lines].join('\n')
}
