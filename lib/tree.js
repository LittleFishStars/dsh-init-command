/** 项目目录结构：目录树收集、文件存在性检查与原子写。 */

import { randomUUID } from 'node:crypto'
import { readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** 目录树中跳过的顶层条目。 */
const TREE_IGNORE = new Set(['.git', 'node_modules', '.DS_Store'])

/** 顶层最多列出的条目数，超出部分折叠为计数行。 */
const MAX_TOP_LEVEL_ENTRIES = 120
/** 每个子目录最多列出的条目数，超出部分折叠为计数行。 */
const MAX_DIR_ENTRIES = 40

/** 无额外忽略项时的空集合。 */
const EMPTY_IGNORE = new Set()

/**
 * 收集目录树为文本行（目录以 `/` 结尾），支持深度与额外忽略项。
 * @param {string} root - 项目目录。
 * @param {{ depth?: number, ignore?: string[] }} [options]
 *   `depth` 收集深度：1 = 仅顶层，2 = 两层（默认），-1 = 不限制；
 *   `ignore` 额外跳过名字精确匹配的条目（在 TREE_IGNORE 基础上）。
 * @returns {Promise<string[]>} 树的行文本。
 */
export async function collectTree(root, options = {}) {
  const { depth = 2, ignore = [] } = options
  const lines = [path.basename(root) + '/']
  await collectLevel(root, depth, new Set(ignore), 1, lines)
  return lines
}

/** 递归收集一层条目并下钻子目录（maxDepth -1 表示不限制深度）。 */
async function collectLevel(dir, maxDepth, extraIgnore, level, lines) {
  if (maxDepth !== -1 && level > maxDepth) return
  const maxEntries = level === 1 ? MAX_TOP_LEVEL_ENTRIES : MAX_DIR_ENTRIES
  const entries = await listEntries(dir, maxEntries, extraIgnore)
  // 并行收集每个子目录的下钻文本，再按条目顺序拼装，保证输出稳定。
  const children = await Promise.all(entries.map(entry =>
    entry.isDirectory && (maxDepth === -1 || level < maxDepth)
      ? collectInto(path.join(dir, entry.name), maxDepth, extraIgnore, level + 1)
      : null,
  ))
  const indent = '  '.repeat(level - 1)
  entries.forEach((entry, index) => {
    lines.push(`${indent}${entry.isDirectory ? `${entry.name}/` : entry.name}`)
    const sub = children[index]
    if (sub === null) return
    for (const line of sub) lines.push(line)
  })
}

/** 收集以 dir 为根的子树的文本行（不含 dir 自身）。 */
async function collectInto(dir, maxDepth, extraIgnore, level) {
  const lines = []
  await collectLevel(dir, maxDepth, extraIgnore, level, lines)
  return lines
}

/** 列出目录条目：过滤噪音、隐藏项与额外忽略项，排序、按上限折叠。 */
async function listEntries(dir, max, extraIgnore = EMPTY_IGNORE) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const visible = entries
    .filter(entry => !TREE_IGNORE.has(entry.name) && !extraIgnore.has(entry.name) && !entry.name.startsWith('.'))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(entry => ({ name: entry.name, isDirectory: entry.isDirectory() }))
  if (visible.length <= max) return visible
  return [...visible.slice(0, max), { name: `… (${visible.length - max} more entries)`, isDirectory: false }]
}

/** @returns {Promise<boolean>} `file` 是否作为常规文件存在。 */
export async function exists(file) {
  try {
    return (await stat(file)).isFile()
  } catch {
    return false
  }
}

/**
 * 原子写文件：先写同目录临时文件再 rename 替换，避免进程崩溃留下截断内容。
 * 写入或替换失败时清理临时文件并抛出。
 */
export async function atomicWriteFile(target, content) {
  const tmp = `${target}.${randomUUID()}.tmp`
  await writeFile(tmp, content, 'utf8')
  try {
    await rename(tmp, target)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {})
    throw error
  }
}
