#!/usr/bin/env node
/**
 * 任务上下文完整性门禁：任务规格与任务卡是否真的在仓库里。
 *
 * 背景：任务卡与登记册已入库，但任务规格曾留在被 Git 忽略的 `.scratch/`，
 * 干净检出或远端克隆后规格不存在，实施前检查必然失败，却要等到开工那一刻才发现。
 * 本门禁把检查提前到「状态推进 / 提交前」，让问题在最早的环节暴露。
 *
 * 检查项（活跃任务 = 未合并、未取消）：
 *   1. 必须有远端 issue 号 —— 任务不能只活在某台机器的本地文件里；
 *   2. 已具备开工资格的任务（本地已定义 / 交付中 / 等待验收 / 执行受阻）必须有任务规格；
 *   3. 规格路径不得指向不入库的目录（.scratch / .agent-runs / .generated）；
 *   4. 规格文件必须真实存在，且已被 Git 跟踪（否则克隆后拿不到）；
 *   5. 已具备开工资格的任务必须有任务卡，且已入库。
 *
 * CLI: node scripts/validate-task-spec-sync.mjs [--repo <path>]
 * 退出码：0 = 通过；1 = 存在违规
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

import { loadRegistry } from './local-task-registry.mjs'

// 这些目录被 .gitignore 忽略，登记册里的任何路径都不得指向它们
const FORBIDDEN_DIRS = ['.scratch/', '.agent-runs/', '.generated/', '.workbuddy/', 'node_modules/']
// 具备开工资格的状态：这些状态必须有完整、可复制的任务上下文
const STARTABLE_STATUSES = new Set(['已定义', '本地已定义', '交付中', '等待验收', '执行受阻'])
const CLOSED_STATUSES = new Set(['已合并', '已取消'])

export function collectViolations(repo) {
  const registry = loadRegistry(repo)
  const tracked = new Set(
    execFileSync('git', ['-C', repo, 'ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean),
  )
  const violations = []

  for (const t of registry.tasks) {
    if (CLOSED_STATUSES.has(t.status)) continue
    const id = t.task_id

    if (!t.remote || t.remote === 'pending' || t.remote === 'none') {
      violations.push({ task_id: id, rule: 'remote', message: '缺少远端 issue 号（任务只存在于本地，换机即失联）' })
    }

    const startable = STARTABLE_STATUSES.has(t.status)
    const specPath = t.spec_path

    if (startable && !specPath) {
      violations.push({
        task_id: id,
        rule: 'spec-required',
        message: `状态「${t.status}」已具备开工资格，但没有任务规格`,
      })
    }

    if (specPath) {
      if (FORBIDDEN_DIRS.some((d) => specPath.startsWith(d) || specPath.includes(`/${d}`))) {
        violations.push({
          task_id: id,
          rule: 'spec-location',
          message: `任务规格指向不入库的目录：${specPath}`,
        })
      } else if (!fs.existsSync(path.join(repo, specPath))) {
        violations.push({ task_id: id, rule: 'spec-missing', message: `任务规格文件不存在：${specPath}` })
      } else if (!tracked.has(specPath)) {
        violations.push({
          task_id: id,
          rule: 'spec-untracked',
          message: `任务规格未入库（克隆后拿不到）：${specPath}`,
        })
      }
    }

    if (startable) {
      const dir = path.join(repo, 'docs', 'tasks')
      const card = fs.existsSync(dir)
        ? fs.readdirSync(dir).find((f) => f.startsWith(`${id}-`) && f.endsWith('.md'))
        : null
      if (!card) {
        violations.push({ task_id: id, rule: 'card-missing', message: '缺少任务卡（docs/tasks/<任务号>-<slug>.md）' })
      } else if (!tracked.has(path.join('docs', 'tasks', card))) {
        violations.push({ task_id: id, rule: 'card-untracked', message: `任务卡未入库：docs/tasks/${card}` })
      }
    }
  }
  return violations
}

function main() {
  const i = process.argv.indexOf('--repo')
  const repo = path.resolve(i >= 0 ? process.argv[i + 1] : process.cwd())
  const violations = collectViolations(repo)
  if (violations.length === 0) {
    console.log('任务上下文完整性检查通过：规格与任务卡均已入库，活跃任务均有远端锚点。')
    return
  }
  console.error(`任务上下文完整性检查失败（${violations.length} 项）：`)
  for (const v of violations) console.error(`  - ${v.task_id} [${v.rule}] ${v.message}`)
  process.exitCode = 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
