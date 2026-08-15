/** 项目目录结构：两层目录树收集与文件存在性检查。 */

import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'

/** 目录树中跳过的顶层条目。 */
const TREE_IGNORE = new Set(['.git', 'node_modules', '.DS_Store'])

/** 顶层最多列出的条目数，超出部分折叠为计数行。 */
const MAX_TOP_LEVEL_ENTRIES = 120
/** 每个子目录最多列出的条目数，超出部分折叠为计数行。 */
const MAX_DIR_ENTRIES = 40
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
/** @returns {Promise<boolean>} `file` 是否作为常规文件存在。 */
export async function exists(file) {
  try {
    return (await stat(file)).isFile()
  } catch {
    return false
  }
}
