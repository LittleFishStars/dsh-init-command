/** --git / --commit 步骤：仓库初始化、master → main、.gitignore 落盘、初始提交。 */

import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { downloadGitignore, gitignoreTemplate } from './gitignore.js'
import { atomicWriteFile, exists } from './tree.js'

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
      await atomicWriteFile(target, result.text)
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
 * 创建初始提交：暂存 AGENTS.md（以及已存在的 .gitignore）并提交。
 * 失败（如未配置 git 身份）返回 false，由调用方汇报，不抛出。
 * @returns {Promise<boolean>} 是否成功创建提交。
 */
export async function commitInitial(root) {
  const files = ['AGENTS.md']
  if (await exists(path.join(root, '.gitignore'))) files.push('.gitignore')
  try {
    await runGit(['-C', root, 'add', '--', ...files], { timeout: 30000 })
    await runGit(['-C', root, 'commit', '-m', 'Add AGENTS.md via /init'], { timeout: 30000 })
    return true
  } catch {
    return false
  }
}
