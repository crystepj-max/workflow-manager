#!/usr/bin/env node
// 证据链机器校验引擎（契约 §8.3 九项呈递/签收前校验）
// 用法：node scripts/cwf-evidence-verify.mjs <runDir> [--decision user_accepted]
//   默认校验 accept 路径；--decision user_accepted 启用知情接受例外（②⑧ 放宽，feedback 必填）
// 输出逐项 JSON 判定；exit 0 全部通过，exit 1 任一失败

import { execFileSync } from 'node:child_process'
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

function liveState(runDir, run) {
  // Proof 绑定比对的实况源：不信任 run.json 可变缓存（§7.3）。
  // 归档态检测（PR #132 Review）：run 已归档到主检出时实况分支 ≠ run.work_branch，
  // 不得拿主检出的 HEAD/分支去比对开发期 proof——回退 run.json 历史值
  const wt = join(runDir, '..', '..')
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: wt, encoding: 'utf-8' }).trim()
    if (branch !== run.work_branch) return null
    return {
      head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: wt, encoding: 'utf-8' }).trim(),
      branch,
    }
  } catch {
    return null
  }
}

function liveTarget(runDir, run) {
  // 实况 target HEAD（防 checkpoint 过期：自记录后 target 再前进须拦截）
  const wt = join(runDir, '..', '..')
  try {
    execFileSync('git', ['fetch', 'origin', run.base_ref], { cwd: wt, stdio: 'pipe' })
    return execFileSync('git', ['rev-parse', `origin/${run.base_ref}`], { cwd: wt, encoding: 'utf-8' }).trim()
  } catch {
    return null // 离线/归档态：跳过实况比对
  }
}

function loadJson(p) {
  return JSON.parse(readFileSync(p, 'utf-8'))
}

export function verifyEvidenceChain(runDir, { relaxedUserAccepted = false, live = null } = {}) {
  // live：实况 HEAD/branch 注入（测试）或缺省从 git 读取——Proof 绑定比对以实况为准，不信任 run.json 缓存
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
    // 例外可达性（PR #132 Review）：签收在引擎校验之后，feedback 由 schema 在签收写入时强制——
    // 此处只放行证据链并提示该强制点，不得在 awaiting 态要求 feedback
    check('②', 'user_accepted 例外：允许 fail/blocked 证据链知情接受', true, '放行；签收写入时 schema 强制 feedback（§3.6）')
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
    && [...workspaces][0] === run.workspace_id
  check('③', '同 Run/workspace lineage', okLineage, okLineage ? 'ok' : `run_id=${[...runIds]} ws=${[...workspaces]} br=${[...branches]}`)

  // ④ Proof HEAD/branch 与实况一致（§7.3）：不信任 run.json 缓存
  const liveNow = live || liveState(runDir, run)
  const refHead = liveNow ? liveNow.head : run.current_head
  const refBranch = liveNow ? liveNow.branch : run.work_branch
  const badHead = []
  for (const [rt, r] of [['review_proof', review], ['test_proof', test]]) {
    if (r && (r.payload?.verified_head !== refHead || r.payload?.verified_branch !== refBranch)) {
      badHead.push(`${rt}(head=${r.payload?.verified_head} ≠ 实况 ${refHead})`)
    }
  }
  if (liveNow && run.current_head !== liveNow.head) {
    badHead.push(`run.json current_head(${run.current_head}) 落后于实况——先 reverify`)
  }
  // 同项附带 Integration Checkpoint 条件不变量与实况复核（§7.3）：引擎不经 schema，此处直验
  const ckpt = refs.integration_checkpoint
  if (!ckpt || typeof ckpt !== 'object') {
    badHead.push('integration_checkpoint 缺失')
  } else {
    if (ckpt.target_advanced === true && ckpt.proofs_state !== 'rerun_completed') {
      badHead.push('checkpoint target 已前进但 proofs_state≠rerun_completed（受影响 Proof 未重跑）')
    }
    // checkpoint 实况复核：自记录后 target 再前进 / 声称未前进但实况已前进 → 拒绝
    const liveT = live && 'targetHead' in live ? live.targetHead : liveTarget(runDir, run)
    if (liveT) {
      if (ckpt.target_head_at_check !== liveT) {
        badHead.push(`checkpoint 过期：target 自记录（${ckpt.target_head_at_check}）后又前进（现 ${liveT}）——重新执行 checkpoint`)
      } else if (ckpt.target_advanced === false && liveT !== run.base_commit) {
        badHead.push('checkpoint 称未前进但实况 target 已前进')
      }
    }
  }
  check('④', 'Proof 绑定实况 HEAD/branch 且 checkpoint 条件不变量成立', badHead.length === 0, badHead.join('; ') || 'ok')

  // ⑤ baseline confirmed 且无残留 gaps
  const ok5 = baseline?.payload?.status === 'confirmed' && (baseline.payload.gaps || []).length === 0
  check('⑤', 'baseline confirmed 且无残留 gaps', ok5, ok5 ? 'ok' : `status=${baseline?.payload?.status} gaps=${(baseline?.payload?.gaps || []).length}`)

  // ⑥ design package_ready；过门必带 Decision Record 且 chosen ∈ 呈递候选集
  let ok6 = design?.payload?.outcome === 'package_ready'
  let detail6 = ok6 ? 'ok' : `outcome=${design?.payload?.outcome}`
  if (ok6 && design.payload.decision_required) {
    if (!design.payload.decision) {
      ok6 = false; detail6 = '命中条件门但无 Decision Record'
    } else if (!design.payload.decision_request) {
      ok6 = false; detail6 = '命中条件门但缺 decision_request（呈递候选集丢失）'
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

  // ⑨ review/test 产生者异于 dev 且独立会话标志为真（异源自证禁令 + 自声明缺一不可）
  const ok9 = review && test && dev
    && review.produced_by !== dev.produced_by && test.produced_by !== dev.produced_by
    && review.payload?.independent_session === true && test.payload?.independent_session === true
  check('⑨', 'review/test 与 dev 异源且独立会话标志为真', Boolean(ok9), ok9 ? 'ok' : `produced_by(review=${review?.produced_by} test=${test?.produced_by} dev=${dev?.produced_by}) independent_session(review=${review?.payload?.independent_session} test=${test?.payload?.independent_session})`)

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
