#!/usr/bin/env node
// 内置模板 → DSH 技能包安装（真源 templates/*.json；产物 <dshHome>/skills/<模板id>/）
//
// 背景：自定义模板走编辑器「保存闭环」自动产出技能包（host.js → generate.mjs user），
// 而**内置模板从来没有任何安装动作**——仓库内只生成到 .generated/<id>/SKILL.md，
// 不会进入 DSH 技能目录，于是内置工作流无法被会话按触发词调用。历史上唯一装过一次的
// wf-construction-full-feature 也随模板演进而过期（runbook 仍走旧通道、无 wf_run）。
//
// 本脚本把内置模板纳入与自定义模板同一条 writeUserSkill 链路：自包含技能包
// （SKILL.md + script.mjs + meta.json + 蓝图引用的角色），可重复执行、整目录原子换入。
//
// 用法：node scripts/install-builtin-skills.mjs [dshHome] [--pool[=<技能池目录>]]
//   缺省 dshHome = $DSH_HOME，再缺省 ~/.dsh
//   --pool 追加一个共享技能池作为安装目标（可重复）；不带值时用默认公共池 ~/.agents/skills。
//   池是跨 agent 共享的真源，装完池后需跑 agent-skill-bridge 把软链补到各 agent 目录。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import validatorCore from './validate-core.cjs'
import { writeUserSkill } from './generate.mjs'

const { validateBlueprint } = validatorCore
const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const DEFAULT_TEMPLATES_DIR = path.resolve(__dirname, '..', 'templates')

/** 正式内置 = templates/*.json；custom-seeds/ 是历史迁出的自定义种子，不算内置 */
export function listBuiltinBlueprintFiles(templatesDir = DEFAULT_TEMPLATES_DIR) {
  return fs.readdirSync(templatesDir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => path.join(templatesDir, f))
}

export function resolveSkillRoot(dshHome) {
  const home = dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'skills')
}

export const DEFAULT_SKILL_POOL = path.join(os.homedir(), '.agents', 'skills')

/**
 * 解析安装目标根：第一个是 DSH 技能目录，其后是 --pool 指定的共享技能池。
 * argv 形如 ['/tmp/dsh', '--pool', '--pool=/x/y']（位置参数至多一个，作为 dshHome）
 */
export function resolveInstallTargets(argv = []) {
  const pools = []
  let dshHome = ''
  for (const a of argv) {
    if (a === '--pool') pools.push(DEFAULT_SKILL_POOL)
    else if (a.startsWith('--pool=')) pools.push(a.slice('--pool='.length) || DEFAULT_SKILL_POOL)
    else if (!dshHome) dshHome = a
  }
  return [resolveSkillRoot(dshHome || undefined)].concat(pools)
}

/** 逐模板校验 + 安装；单个模板失败不影响其余，结果按模板返回 */
export function installBuiltinSkills({ templatesDir = DEFAULT_TEMPLATES_DIR, skillRoot } = {}) {
  if (!skillRoot) throw new Error('缺少 skillRoot')
  const results = []
  for (const file of listBuiltinBlueprintFiles(templatesDir)) {
    let bp
    try {
      bp = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (e) {
      results.push({ id: path.basename(file, '.json'), ok: false, error: '蓝图解析失败：' + e.message })
      continue
    }
    const v = validateBlueprint(bp)
    if (!v.ok) {
      results.push({ id: bp.id, ok: false, error: v.errors.map((e) => e.at + ' ' + e.message).join('；') })
      continue
    }
    const r = writeUserSkill(bp, skillRoot)
    results.push(r.ok ? { id: bp.id, ok: true, dir: r.dir } : { id: bp.id, ok: false, error: r.error })
  }
  return results
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const targets = resolveInstallTargets(process.argv.slice(2))
  let failed = false
  for (const skillRoot of targets) {
    fs.mkdirSync(skillRoot, { recursive: true })
    const results = installBuiltinSkills({ skillRoot })
    for (const r of results) {
      console.log((r.ok ? '✅ ' : '❌ ') + r.id + (r.ok ? ' → ' + r.dir : '：' + r.error))
    }
    const okCount = results.filter((r) => r.ok).length
    if (okCount !== results.length) failed = true
    console.log(okCount + '/' + results.length + ' 个内置模板技能包已就绪：' + skillRoot)
  }
  if (failed) process.exit(1)
  if (targets.length > 1) console.log('提示：共享技能池新增后需跑 agent-skill-bridge 补建各 agent 软链')
}
