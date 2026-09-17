// LOC-038：三入口一致、逐种拒绝、模型不能覆盖、服务与资格分离
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { runPreflight, strictDefinitionCheck } from '../ai-task-preflight-check.mjs'
import {
  runConstructionPreflightGate,
  mapPreflightNodeOutput,
  resolveTaskCardPath,
  resolveSpecPath,
  mechanicalConstructionPreflight,
} from '../construction-preflight-gate.mjs'
import { compileBlueprint } from '../generate.mjs'
import { runGeneratedScript, makeAgentScript } from './helpers/runtime-harness.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const constructionBp = JSON.parse(fs.readFileSync(path.join(root, 'templates/wf-construction-full-feature.json'), 'utf8'))
const preflightCli = path.join(root, 'scripts/ai-task-preflight-check.mjs')
const gateCli = path.join(root, 'scripts/construction-preflight-gate.mjs')

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'loc038-'))
}

const DEF_CHECK = `# Definition Check

| 未决产品事项 | 0 |

- [x] 全部通过
`

const SPEC_V1 = `# 任务规格 V1

**版本**：V1

未决产品事项：0
`

function writeTask(dir, fields, specText = SPEC_V1) {
  const rows = Object.entries(fields).map(([k, v]) => `| ${k} | ${v} |`).join('\n')
  const basicsPath = path.join(dir, 'task-basics.md')
  const specPath = path.join(dir, 'task-spec-V1.md')
  fs.writeFileSync(basicsPath, `# 任务基本信息\n\n| 字段 | 值 |\n|---|---|\n${rows}\n`)
  fs.writeFileSync(specPath, specText)
  fs.writeFileSync(path.join(dir, 'definition-check.md'), DEF_CHECK)
  return { basicsPath, specPath }
}

const LEGAL_GITHUB = {
  任务名称: '合法任务',
  任务类型: '完整功能开发',
  优先级: 'P1',
  当前状态: '已定义',
  需求基线版本: 'V1',
  前置依赖: '无',
  施工环境组: 'LOC-T',
  施工环境角色: '独立',
  无人值守许可: '允许',
  任务规格位置: 'task-spec-V1.md',
  定义时间: '2026-09-16T00:00:00Z',
}

const LEGAL_LOCAL = {
  ...LEGAL_GITHUB,
  当前状态: '本地已定义',
  任务标识: 'LOC-901',
  需求来源: '本地文档',
  'GitHub 同步': 'pending',
}

test('strictDefinitionCheck：未勾选项必须失败', () => {
  const bad = strictDefinitionCheck('- [ ] 未勾选\n- [x] 已勾选')
  assert.equal(bad.ok, false)
  const good = strictDefinitionCheck(DEF_CHECK)
  assert.equal(good.ok, true)
})

test('UAT-01：三入口（CLI / gate / mechanical 钩子）同一合法输入结论一致', async () => {
  const dir = tmpdir()
  const { basicsPath, specPath } = writeTask(dir, LEGAL_LOCAL)
  const cli = execFileSync(process.execPath, [preflightCli, basicsPath, specPath, '--run-baseline', 'V1', '--repo', dir], { encoding: 'utf8' })
  const cliJson = JSON.parse(cli.slice(cli.indexOf('{')))
  assert.equal(cliJson.ok, true)

  const gate = await runConstructionPreflightGate({ issuePath: basicsPath, specPath, runBaseline: 'V1', repo: dir })
  assert.equal(gate.route, 'PASS')

  const mech = await mechanicalConstructionPreflight('construction-preflight', { args: { issuePath: basicsPath, specPath, runBaseline: 'V1' }, repo: dir })
  assert.equal(mech.route, 'PASS')
  assert.deepEqual(gate.reasons.map((r) => r.code).sort(), mech.reasons.map((r) => r.code).sort())
})

test('UAT-02：逐种拒绝——版本冲突/缺许可/未勾选 Definition Check 均 BLOCKED', async () => {
  const dir = tmpdir()
  const badVersion = writeTask(dir, { ...LEGAL_LOCAL, 需求基线版本: 'V2' })
  const r1 = await runPreflight(badVersion.basicsPath, badVersion.specPath, { runBaseline: 'V1', repo: dir })
  assert.equal(r1.ok, false)
  assert.ok(r1.reasons.some((x) => x.code === 'PREFLIGHT_VERSION_MISMATCH'))

  const dir2 = tmpdir()
  const badPerm = writeTask(dir2, { ...LEGAL_LOCAL, 无人值守许可: '不允许' })
  const r2 = await runPreflight(badPerm.basicsPath, badPerm.specPath, { repo: dir2 })
  assert.equal(r2.ok, false)

  const dir3 = tmpdir()
  const { basicsPath, specPath } = writeTask(dir3, LEGAL_LOCAL)
  fs.writeFileSync(path.join(dir3, 'definition-check.md'), '- [ ] 未勾选\n')
  const r3 = await runPreflight(basicsPath, specPath, { repo: dir3 })
  assert.equal(r3.ok, false)
  assert.ok(r3.reasons.some((x) => x.code === 'PREFLIGHT_DEF_CHECK_INCOMPLETE'))
})

test('UAT-03：建设模板 preflight 机械节点不调用 agent；预填 BLOCKED 不被 agent PASS 覆盖', async () => {
  const { script } = compileBlueprint(constructionBp)
  const blocked = mapPreflightNodeOutput({ ok: false, failures: ['测试阻断'], reasons: [{ code: 'TEST', field: null, source: 'test', message: '测试阻断' }], fields: null })
  const agent = makeAgentScript({
    '/实施前检查/': { route: 'PASS', summary: '模型企图放行', blockers: '', baseline_version: 'V1' },
  })
  const run = await runGeneratedScript(script, {
    args: { taskId: 't', results: { preflight: blocked } },
    agent,
  })
  assert.equal(run.agentCalls.length, 0, 'preflight 不得调用 agent')
  assert.equal(run.result.status, 'BLOCKED')
  assert.equal(run.result.results.preflight.route, 'BLOCKED')
})

test('UAT-03：机械 PASS 合法任务 preflight 零 agent 调用并进入 dev', async () => {
  const dir = tmpdir()
  const { basicsPath, specPath } = writeTask(dir, LEGAL_GITHUB)
  const passGate = await runConstructionPreflightGate({ issuePath: basicsPath, specPath, repo: dir })
  const { script } = compileBlueprint(constructionBp)
  const agent = makeAgentScript({
    开发: { route: 'READY', summary: 'ok', blockers: '', self_check: 'ok' },
    收敛审查: { route: 'APPROVE', verdict: 'APPROVE', summary: 'ok', blockers: '无', verified_branch: 'dev2/t', verified_head: 'h1', candidate_sha256: 'c1' },
    测试: { route: 'PASS', result: 'PASSED', reason: 'ok', evidence: 'e1', verified_branch: 'dev2/t', verified_head: 'h2', candidate_sha256: 'c2' },
    'UAT 准备': { route: 'READY_FOR_HUMAN', summary_for_human: 's', why: 'w', current_state: 'c', details: 'd' },
  })
  const run = await runGeneratedScript(script, {
    args: { taskId: 't', issuePath: basicsPath, specPath, results: { preflight: passGate } },
    agent,
  })
  const preflightCalls = run.agentCalls.filter((c) => /实施前检查/.test(c.label))
  assert.equal(preflightCalls.length, 0)
  assert.ok(run.agentCalls.some((c) => c.label.startsWith('开发')), '应通过 preflight 进入 dev')
  assert.equal(run.result.status, 'WAITING_HUMAN')
})

test('resolveTaskCardPath：仓库内 LOC-038 卡可解析', () => {
  const p = resolveTaskCardPath('LOC-038', root)
  assert.ok(p && fs.existsSync(p))
  const spec = resolveSpecPath(p, root)
  assert.ok(spec && fs.existsSync(spec))
})

test('mapPreflightNodeOutput：保留 reasons 结构', () => {
  const out = mapPreflightNodeOutput({
    ok: false,
    failures: ['x'],
    reasons: [{ code: 'C', field: 'f', source: 's', message: 'm' }],
    fields: null,
  })
  assert.equal(out.route, 'BLOCKED')
  assert.equal(out.reasons[0].code, 'C')
})
