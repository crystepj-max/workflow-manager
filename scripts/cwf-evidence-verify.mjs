#!/usr/bin/env node
// 证据链机器校验引擎（契约 §8.3 九项呈递/签收前校验；M2 验收三态）
// 用法：node scripts/cwf-evidence-verify.mjs <runDir>
//   accept / conditional_pass 均要求 review approve + test pass（有条件通过 ≠ 知情接受未达标）
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

// 存在性分层（CHORE-110 / 契约 §8.3）：这四类前置引用允许缺失，缺失须在
// assembled.evidence_gaps 声明并经人工知情批准；dev_handoff 与 checkpoint 恒必填。
const MISSABLE = {
  requirements_baseline: 'requirements_baseline_ref',
  design_package: 'design_package_ref',
  review_proof: 'review_proof_ref',
  test_proof: 'test_proof_ref',
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

export function verifyEvidenceChain(runDir, { live = null } = {}) {
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
    if (field === 'integration_checkpoint' || field === 'evidence_gaps') continue
    const rt = field.replace(/_ref$/, '')
    records[rt] = existsSync(join(runDir, ref)) ? loadJson(join(runDir, ref)) : null
  }

  // 存在性分层（CHORE-110）：缺失集合取自引用有无（盘上事实，不由会话声明路线），
  // 与 evidence_gaps 键集合必须精确相等；已声明缺失的记录使对应校验转 N/A，
  // 但已存在的记录一律照原九项校验，不得借分层绕过。
  const gapDecl = refs.evidence_gaps && typeof refs.evidence_gaps === 'object' ? refs.evidence_gaps : null
  const missingRefs = Object.entries(MISSABLE).filter(([, refField]) => !refs[refField]).map(([rt]) => rt)
  const declared = gapDecl ? Object.keys(gapDecl) : []
  const na = (rt) => missingRefs.includes(rt) && declared.includes(rt)

  // ① record_type 与产生 Stage 映射正确（§8.1）
  const badMap = Object.entries(records)
    .filter(([rt, r]) => r && (r.record_type !== rt || r.run?.stage !== STAGE_MAP[rt]))
    .map(([rt, r]) => `${rt}(实际 ${r.record_type}/${r.run?.stage})`)
  check('①', 'record_type 与 Stage 映射', badMap.length === 0, badMap.join('; ') || 'ok')

  const review = records.review_proof, test = records.test_proof
  const dev = records.dev_handoff, design = records.design_package
  const baseline = records.requirements_baseline

  // ② review approve + test pass（M2：conditional_pass 同样要求）；
  // 已声明缺失的一侧转 N/A，其责任由 ⑪ 的人工知情批准承担（CHORE-110）
  {
    const okR = na('review_proof') || review?.payload?.verdict === 'approve'
    const okT = na('test_proof') || test?.payload?.verdict === 'pass'
    const ok = okR && okT
    const naNote = [na('review_proof') && 'review 已声明缺失', na('test_proof') && 'test 已声明缺失'].filter(Boolean).join(' + ')
    check('②', 'review approve 且 test pass（缺失侧转 N/A）', ok,
      ok ? (naNote ? `N/A：${naNote}` : 'ok') : `review=${review?.payload?.verdict} test=${test?.payload?.verdict}`)
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

  // ⑤ baseline confirmed 且无残留 gaps（已声明缺失 ⇒ N/A）
  {
    const ok5 = na('requirements_baseline')
      || (baseline?.payload?.status === 'confirmed' && (baseline.payload.gaps || []).length === 0)
    check('⑤', 'baseline confirmed 且无残留 gaps（缺失转 N/A）', ok5,
      ok5 ? (na('requirements_baseline') ? 'N/A：baseline 已声明缺失' : 'ok')
        : `status=${baseline?.payload?.status} gaps=${(baseline?.payload?.gaps || []).length}`)
  }

  // ⑥ design package_ready；过门必带 Decision Record 且 chosen ∈ 呈递候选集（已声明缺失 ⇒ N/A）
  let ok6 = na('design_package') || design?.payload?.outcome === 'package_ready'
  let detail6 = na('design_package') ? 'N/A：design 已声明缺失' : (ok6 ? 'ok' : `outcome=${design?.payload?.outcome}`)
  if (ok6 && design?.payload?.decision_required) {
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
  check('⑥', 'design package_ready 且过门已决（缺失转 N/A）', ok6, detail6)

  // ⑦ dev handoff_ready
  const ok7 = dev?.payload?.outcome === 'handoff_ready'
  check('⑦', 'dev handoff_ready', ok7, ok7 ? 'ok' : `outcome=${dev?.payload?.outcome}`)

  // ⑧ 验收映射与基线验收标准逐条完整无重复对应（test 或 baseline 已声明缺失 ⇒ N/A）
  if (na('test_proof') || na('requirements_baseline')) {
    const naSide = [na('test_proof') && 'test', na('requirements_baseline') && 'baseline'].filter(Boolean).join('/')
    check('⑧', '验收映射完整无重复（缺失转 N/A）', true, `N/A：${naSide} 已声明缺失`)
  } else if (!test || !baseline) {
    // 引用缺失但未在 evidence_gaps 声明：判失败而非崩在此处——否则 ⑩ 的「漏报」永远没机会报
    const undeclared = [['test_proof', test], ['requirements_baseline', baseline]].filter(([, r]) => !r).map(([rt]) => rt)
    check('⑧', '验收映射完整无重复（accept/conditional_pass 场景全 pass）', false,
      `记录不可解析且未声明缺失：${undeclared.join('/')}（⑩ 将同时判失败）`)
  } else {
    const want = baseline?.payload?.acceptance || []
    const mapping = (test?.payload?.acceptance_mapping || []).map(m => m.acceptance_item)
    const dup = mapping.filter((m, i) => mapping.indexOf(m) !== i)
    const missing = want.filter(w => !mapping.includes(w))
    const extra = mapping.filter(m => !want.includes(m))
    let ok8 = missing.length === 0 && extra.length === 0 && dup.length === 0
    let detail8 = ok8 ? 'ok' : `missing=${missing.length} extra=${extra.length} dup=${dup.length}`
    if (ok8) {
      const notPass = (test.payload.acceptance_mapping || []).filter(m => m.result !== 'pass')
      ok8 = notPass.length === 0
      if (!ok8) detail8 = `非 pass 结果 ${notPass.length} 项`
    }
    check('⑧', '验收映射完整无重复（accept/conditional_pass 场景全 pass）', ok8, detail8)
  }

  // ⑨ review/test 产生者异于 dev 且独立会话标志为真（异源自证禁令 + 自声明缺一不可）；
  // 只对本 Run 实际存在的 proof 生效——已声明缺失的一侧由 ⑪ 的人工知情批准担责
  {
    const present = [['review_proof', review], ['test_proof', test]].filter(([, r]) => r)
    const bad9 = []
    for (const [rt, r] of present) {
      if (!dev) { bad9.push(`${rt} 无法比对：dev_handoff 缺失`); continue }
      if (r.produced_by === dev.produced_by) bad9.push(`${rt} 与 dev 同源（${r.produced_by}）`)
      if (r.payload?.independent_session !== true) bad9.push(`${rt} independent_session≠true`)
    }
    check('⑨', '现存 review/test 与 dev 异源且独立会话标志为真', bad9.length === 0,
      bad9.length ? bad9.join('; ') : (present.length === 0 ? 'N/A：无独立评审/测试记录（须见 ⑪ 知情批准）' : 'ok'))
  }

  // ⑩ 缺失引用与 evidence_gaps 精确配对（CHORE-110：多报＝谎称缺失，漏报＝静默绕过）
  {
    const undeclared = missingRefs.filter(rt => !declared.includes(rt))
    const phantom = declared.filter(rt => !missingRefs.includes(rt))
    const illegal = declared.filter(rt => !(rt in MISSABLE))
    const ok10 = undeclared.length === 0 && phantom.length === 0 && illegal.length === 0
    check('⑩', '缺失引用与 evidence_gaps 精确配对', ok10, ok10
      ? (missingRefs.length ? `已声明缺失 ${missingRefs.join('/')}` : '五类引用齐全，不得声明缺失')
      : `未声明缺失=${undeclared.join('/') || '-'} 多报=${phantom.join('/') || '-'} 非法键=${illegal.join('/') || '-'}`)
  }

  // ⑪ 每条缺失声明须经人工知情批准，且批准人不得是产生本验收记录的会话（契约 §5 禁 AI 代签）
  {
    const bad11 = []
    for (const rt of declared) {
      const g = gapDecl[rt] || {}
      if (!String(g.reason || '').trim()) bad11.push(`${rt} 缺 reason`)
      if (!String(g.acknowledged_by || '').trim()) bad11.push(`${rt} 缺 acknowledged_by`)
      else if (g.acknowledged_by === ap.produced_by) bad11.push(`${rt} acknowledged_by=本记录 produced_by（${ap.produced_by}）——代签`)
      if (!g.acknowledged_at) bad11.push(`${rt} 缺 acknowledged_at`)
    }
    check('⑪', '缺失声明均经人工知情批准（禁代签）', bad11.length === 0,
      bad11.length ? bad11.join('; ') : (declared.length ? 'ok' : '无缺失声明'))
  }

  // ⑫ 轻量档已签收时，签署须有可核对来源（否则 decided_by 只是不可核对的断言）
  {
    const decided = ap.payload?.status === 'decided'
    const needs = declared.length > 0 && decided
    const ok12 = !needs || Boolean(String(ap.payload?.decided_by_evidence || '').trim())
    check('⑫', '轻量档签署带可核对来源', ok12, ok12
      ? (needs ? 'ok' : 'N/A（无缺失声明或尚未签收）')
      : `evidence_gaps 非空且 status=decided，但缺 decided_by_evidence（decided_by=${ap.payload?.decided_by}）`)
  }

  return { ok: checks.every(c => c.ok), checks }
}

function main() {
  const args = process.argv.slice(2)
  const runDir = args[0]
  if (!runDir) {
    console.error('用法: node scripts/cwf-evidence-verify.mjs <runDir>')
    process.exit(2)
  }
  if (args.includes('--decision') && args[args.indexOf('--decision') + 1] === 'user_accepted') {
    console.error('M2：已废弃 --decision user_accepted。有条件通过请用 conditional_pass（仍要求审查通过+测试通过，并在 feedback 记录优化意见）。')
    process.exit(2)
  }
  const result = verifyEvidenceChain(runDir)
  console.log(JSON.stringify(result, null, 2))
  process.exit(result.ok ? 0 : 1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
