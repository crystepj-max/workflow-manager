#!/usr/bin/env node
// WFM-77：只读核对内置技能安装态；不依赖运行中的 DSH，不写 .generated/ 或安装目录。
// 清单与 install-builtin-skills.mjs 一致：generateUserSkill 三件套 + 蓝图引用角色。
// 用法：node scripts/installed-skill-audit.mjs [dshHome] [--pool[=<目录>]] [--format text|json]
// 退出码：FAIL = 1；PASS / 显式 SKIP = 0。SKIP 不代表安装态已通过。
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { collectBuiltinRoles, generateUserSkill } from './generate.mjs'
import { DEFAULT_TEMPLATES_DIR, listBuiltinBlueprintFiles, resolveInstallTargets } from './install-builtin-skills.mjs'
import validatorCore from './validate-core.cjs'

const sha256 = (content) => createHash('sha256').update(content).digest('hex')

function expectedPackages(templatesDir) {
  const packages = []
  for (const file of listBuiltinBlueprintFiles(templatesDir)) {
    const bp = JSON.parse(fs.readFileSync(file, 'utf8'))
    const validation = validatorCore.validateBlueprint(bp)
    if (!validation.ok) throw new Error(path.basename(file) + '：' + validation.errors.map(e => e.at + ' ' + e.message).join('；'))
    const files = generateUserSkill(bp)
    for (const [rel, content] of collectBuiltinRoles(bp)) files.set(rel, content)
    packages.push({ id: bp.id, files })
  }
  if (!packages.length) throw new Error('未发现正式内置蓝图：' + templatesDir)
  return packages
}

function listInstalledFiles(dir, io, prefix = '') {
  const files = []
  for (const entry of io.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix + entry.name
    if (entry.isDirectory()) files.push(...listInstalledFiles(path.join(dir, entry.name), io, rel + '/'))
    else files.push(rel)
  }
  return files.sort()
}

function firstDifference(expected, actual) {
  const wanted = expected.toString('utf8').split('\n')
  const installed = actual.toString('utf8').split('\n')
  for (let i = 0; i < Math.max(wanted.length, installed.length); i++) {
    if (wanted[i] === installed[i]) continue
    let column = 0
    while (column < Math.min(wanted[i]?.length || 0, installed[i]?.length || 0) && wanted[i][column] === installed[i][column]) column++
    const start = Math.max(0, column - 70)
    const clip = value => value === undefined ? '<EOF>' : (start ? '…' : '') + value.slice(start, start + 180) + (value.length > start + 180 ? '…' : '')
    return { line: i + 1, column: column + 1, expected: clip(wanted[i]), actual: clip(installed[i]) }
  }
  return null
}

function auditRoot(skillRoot, packages, io) {
  const result = { skillRoot, status: 'PASS', checkedFiles: 0, changes: [], skipReasons: [] }
  try {
    if (!io.statSync(skillRoot).isDirectory()) throw new Error('安装位置不是目录')
    // stat 可读不等于目录可列出；权限不足必须显式跳过。
    io.readdirSync(skillRoot)
  } catch (error) {
    return { ...result, status: 'SKIP', skipReasons: ['安装位置不可达：' + (error.code || error.message)] }
  }
  for (const { id, files } of packages) {
    const dir = path.join(skillRoot, id)
    let installed = []
    try {
      const stat = io.statSync(dir)
      if (!stat.isDirectory()) {
        result.changes.push({ template: id, file: '.', kind: 'not-directory', installedMtime: stat.mtime.toISOString() })
        continue
      }
      installed = listInstalledFiles(dir, io)
    } catch (error) {
      if (error.code !== 'ENOENT') {
        result.skipReasons.push(id + ' 安装目录不可读取：' + (error.code || error.message))
        continue
      }
    }
    const actualFiles = new Set(installed)
    for (const [file, content] of files) {
      const expected = Buffer.from(content, 'utf8')
      if (!actualFiles.has(file)) {
        result.changes.push({ template: id, file, kind: 'missing', installedMtime: null, expectedSha256: sha256(expected) })
        continue
      }
      try {
        const abs = path.join(dir, file)
        const stat = io.statSync(abs)
        const actual = io.readFileSync(abs)
        result.checkedFiles++
        if (!actual.equals(expected)) result.changes.push({
          template: id, file, kind: 'changed', installedMtime: stat.mtime.toISOString(),
          expectedSha256: sha256(expected), installedSha256: sha256(actual), diff: firstDifference(expected, actual),
        })
      } catch (error) {
        result.skipReasons.push(id + '/' + file + ' 不可读取：' + (error.code || error.message))
      }
    }
    // 只检查正式内置目录内部；同一技能根中的用户技能不属于本闸门。
    for (const file of installed) {
      if (files.has(file)) continue
      let installedMtime = null
      try { installedMtime = io.lstatSync(path.join(dir, file)).mtime.toISOString() } catch (error) {
        result.skipReasons.push(id + '/' + file + ' 元数据不可读取：' + (error.code || error.message))
      }
      result.changes.push({ template: id, file, kind: 'extra', installedMtime })
    }
  }
  result.status = result.changes.length ? 'FAIL' : result.skipReasons.length ? 'SKIP' : 'PASS'
  return result
}

/** io 只用于注入安装态读取，夹具不读取真实 HOME；权威源始终从当前生成器重生成。 */
export function auditInstalledSkills({ templatesDir = DEFAULT_TEMPLATES_DIR, skillRoots = resolveInstallTargets(), io = fs } = {}) {
  let packages
  try { packages = expectedPackages(templatesDir) } catch (error) {
    return { status: 'FAIL', ok: false, sourceError: '权威源不可生成：' + error.message, results: [] }
  }
  const roots = [...new Set(skillRoots.map(root => path.resolve(root)))]
  if (!roots.length) return { status: 'SKIP', ok: false, skipReason: '未指定安装位置', results: [] }
  const results = roots.map(root => auditRoot(root, packages, io))
  const status = results.some(r => r.status === 'FAIL') ? 'FAIL' : results.some(r => r.status === 'SKIP') ? 'SKIP' : 'PASS'
  return {
    status, ok: status === 'PASS',
    manifest: packages.map(({ id, files }) => ({ template: id, files: [...files.keys()].sort() })),
    results,
  }
}

function renderText(out) {
  const lines = ['—— 内置技能安装态核对：' + out.status + ' ——']
  if (out.sourceError) lines.push('❌ ' + out.sourceError)
  if (out.skipReason) lines.push('⏭️ ' + out.skipReason)
  for (const result of out.results) {
    lines.push(result.status + ' ' + result.skillRoot + '（已读取 ' + result.checkedFiles + ' 个文件）')
    for (const reason of result.skipReasons) lines.push('  ⏭️ ' + reason)
    for (const change of result.changes) {
      lines.push('  ❌ ' + change.template + '/' + change.file + ' [' + change.kind + '] 安装 mtime=' + (change.installedMtime || '<missing>'))
      if (change.expectedSha256) lines.push('     expected sha256=' + change.expectedSha256)
      if (change.installedSha256) lines.push('     installed sha256=' + change.installedSha256)
      if (change.diff) {
        lines.push('     L' + change.diff.line + ' expected: ' + JSON.stringify(change.diff.expected))
        lines.push('     L' + change.diff.line + ' installed: ' + JSON.stringify(change.diff.actual))
      }
    }
  }
  if (out.status === 'SKIP') lines.push('⏭️ 安装态未完整核对；SKIP 不等于通过，产品验收前须在真实安装位置补跑。')
  if (out.status === 'FAIL') lines.push('❌ 安装态与权威源不一致或权威源无效；确认目标后通过 install:builtin-skills 重装，再重跑本段。')
  if (out.status === 'PASS') lines.push('✅ 所有目标的正式内置技能包与当前权威源逐文件一致。')
  return lines.join('\n')
}

function main(argv) {
  const targetArgs = []
  let format = 'text'
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--format' && ['text', 'json'].includes(argv[i + 1])) format = argv[++i]
    else if (arg === '--pool' || arg.startsWith('--pool=')) targetArgs.push(arg)
    else if (!arg.startsWith('-') && !targetArgs.some(value => !value.startsWith('-'))) targetArgs.push(arg)
    else throw new Error('未知参数：' + arg)
  }
  const out = auditInstalledSkills({ skillRoots: resolveInstallTargets(targetArgs) })
  console.log(format === 'json' ? JSON.stringify(out, null, 2) : renderText(out))
  return out.status === 'FAIL' ? 1 : 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)) } catch (error) {
    console.error('❌ 内置技能安装态核对无法执行：' + error.message)
    process.exitCode = 1
  }
}
