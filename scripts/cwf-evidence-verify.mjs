#!/usr/bin/env node
// 证据链机器校验引擎（契约 §8.3 九项呈递/签收前校验）
// 用法：node scripts/cwf-evidence-verify.mjs <runDir> [--decision user_accepted]
//   默认校验 accept 路径；--decision user_accepted 启用知情接受例外（②⑧ 放宽，feedback 必填）
// 输出逐项 JSON 判定；exit 0 全部通过，exit 1 任一失败

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const STAGE_MAP = {
  requirements_baseline: 'requirements',
  design_package: 'design',
  dev_handoff: 'dev',
  review_proof: 'review',
  test_proof: 'test',
}

function loadJson(p) {
  return JSON.parse(readFileSync(p, 'utf-8'))
}

export function verifyEvidenceChain(runDir, { relaxedUserAccepted = false } = {}) {
  const checks = []
  const check = (id, name, ok, detail) => checks.push({ id, name, ok, detail })

  const run = loadJson(join(runDir, 'run.json'))
  const index = loadJson(join(runDir, 'index.json'))
  const apFile = index.acceptance_package
  if (!apFile || !existsSync(join(runDir, apFile))) {
    check('chain', '验收包存在', false, 'index.json 无 acceptance_package 指向')
    return { ok: false, checks }
  }
  const ap = loadJson(join(runDir, apFile))
  const refs = ap.payload?.assembled || {}
  const records = {}
  for (const [field, ref] of Object.entries(refs)) {
    if (field === 'integration_checkpoint') continue
    const rt = field.replace(/_ref$/, '')
    records[rt] = existsSync(join(runDir, ref)) ? loadJson(join(runDir, ref)) : null
  }

  // ① record_type 与产生 Stage 映射正确（§8.1）
  const badMap = Object.entries(records)
    .filter(([rt, r]) => r && (r.record_type !== rt || r.run?.stage !== STAGE_MAP[rt]))
    .map(([rt, r]) => `${rt}(实际 ${r.record_type}/${r.run?.stage})`)
  check('①', 'record_type 与 Stage 映射', badMap.length === 0, badMap.join('; ') || 'ok')

  const review = records.review_proof, test = records.test_proof
  const dev = records.dev_handoff, design = records.design_package
  const baseline = records.requirements_baseline

  // ② review approve + test pass（user_accepted 例外放宽）
  if (relaxedUserAccepted) {
    const okFb = typeof ap.payload?.feedback === 'string' && /\S/.test(ap.payload.feedback)
    check('②', 'user_accepted 例外：feedback 非空说明差异', okFb, okFb ? 'ok' : 'feedback 缺失')
  } else {
    const ok = review?.payload?.verdict === 'approve' && test?.payload?.verdict === 'pass'
    check('②', 'review approve 且 test pass', ok, ok ? 'ok' : `review=${review?.payload?.verdict} test=${test?.payload?.verdict}`)
  }

  // ③ 同 Run / 同 workspace lineage
  const all = [baseline, design, dev, review, test, ap].filter(Boolean)
  const runIds = new Set(all.map(r => r.run?.run_id))
  const workspaces = new Set(all.map(r => r.run?.workspace_id))
  const branches = new Set(all.map(r => r.run?.work_branch))
  const okLineage = runIds.size === 1 && workspaces.size === 1 && branches.size === 1
    && [...runIds][0] === run.run_id && [...branches][0] === run.work_branch
  check('③', '同 Run/workspace lineage', okLineage, okLineage ? 'ok' : `run_id=${[...runIds]} ws=${[...workspaces]} br=${[...branches]}`)

  // ④ Proof HEAD/branch 与当前一致（§7.3）
  const badHead = []
  for (const [rt, r] of [['review_proof', review], ['test_proof', test]]) {
    if (r && (r.payload?.verified_head !== run.current_head || r.payload?.verified_branch !== run.work_branch)) {
      badHead.push(`${rt}(head=${r.payload?.verified_head})`)
    }
  }
  check('④', 'Proof 绑定当前 HEAD/branch', badHead.length === 0, badHead.join('; ') || 'ok')

  // ⑤ baseline confirmed 且无残留 gaps
  const ok5 = baseline?.payload?.status === 'confirmed' && (baseline.payload.gaps || []).length === 0
  check('⑤', 'baseline confirmed 且无残留 gaps', ok5, ok5 ? 'ok' : `status=${baseline?.payload?.status} gaps=${(baseline?.payload?.gaps || []).length}`)

  // ⑥ design package_ready；过门必带 Decision Record 且 chosen ∈ 呈递候选集
  let ok6 = design?.payload?.outcome === 'package_ready'
  let detail6 = ok6 ? 'ok' : `outcome=${design?.payload?.outcome}`
  if (ok6 && design.payload.decision_required) {
    if (!design.payload.decision) {
      ok6 = false; detail6 = '命中条件门但无 Decision Record'
    } else if (design.payload.decision_request) {
      const names = design.payload.decision_request.options.map(o => o.name)
      if (!names.includes(design.payload.decision.chosen)) {
        ok6 = false; detail6 = `chosen(${design.payload.decision.chosen}) 不在呈递候选集 ${names}`
      }
    }
  }
  check('⑥', 'design package_ready 且过门已决', ok6, detail6)

  // ⑦ dev handoff_ready
  const ok7 = dev?.payload?.outcome === 'handoff_ready'
  check('⑦', 'dev handoff_ready', ok7, ok7 ? 'ok' : `outcome=${dev?.payload?.outcome}`)

  // ⑧ 验收映射与基线验收标准逐条完整无重复对应
  const want = baseline?.payload?.acceptance || []
  const mapping = (test?.payload?.acceptance_mapping || []).map(m => m.acceptance_item)
  const dup = mapping.filter((m, i) => mapping.indexOf(m) !== i)
  const missing = want.filter(w => !mapping.includes(w))
  const extra = mapping.filter(m => !want.includes(m))
  let ok8 = missing.length === 0 && extra.length === 0 && dup.length === 0
  let detail8 = ok8 ? 'ok' : `missing=${missing.length} extra=${extra.length} dup=${dup.length}`
  if (ok8 && !relaxedUserAccepted) {
    const notPass = (test.payload.acceptance_mapping || []).filter(m => m.result !== 'pass')
    ok8 = notPass.length === 0
    if (!ok8) detail8 = `非 pass 结果 ${notPass.length} 项`
  }
  check('⑧', '验收映射完整无重复（accept 场景全 pass）', ok8, detail8)

  // ⑨ review/test 产生者异于 dev（异源自证禁令）
  const ok9 = review && test && dev
    && review.produced_by !== dev.produced_by && test.produced_by !== dev.produced_by
  check('⑨', 'review/test 与 dev 异源（produced_by）', Boolean(ok9), ok9 ? 'ok' : `review=${review?.produced_by} test=${test?.produced_by} dev=${dev?.produced_by}`)

  return { ok: checks.every(c => c.ok), checks }
}

function main() {
  const args = process.argv.slice(2)
  const runDir = args[0]
  if (!runDir) {
    console.error('用法: node scripts/cwf-evidence-verify.mjs <runDir> [--decision user_accepted]')
    process.exit(2)
  }
  const relaxedUserAccepted = args.includes('--decision') && args[args.indexOf('--decision') + 1] === 'user_accepted'
  const result = verifyEvidenceChain(runDir, { relaxedUserAccepted })
  console.log(JSON.stringify(result, null, 2))
  process.exit(result.ok ? 0 : 1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
