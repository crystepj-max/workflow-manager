// LOC-028：人工接受完成必须具备真实决定与版本来源（WR-005）
// decision_ref 只能由宿主真实人工交互签发；运行时与宿主双重校验。

export const ACTOR_SOURCE_HOST = 'host_ui'
const ALLOWED_ACTOR_SOURCES = new Set([ACTOR_SOURCE_HOST])

export function candidateDigest(ref) {
  const c = ref && ref.candidate_ref
  return (c && c.version && typeof c.version.content_sha256 === 'string' && c.version.content_sha256.trim())
    ? c.version.content_sha256.trim()
    : null
}

export function assertDecisionRef(ref, label = 'decision_ref') {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) throw new Error(`${label} 必须是对象`)
  for (const k of ['decision_id', 'logical_run_id', 'checkpoint_id', 'choice', 'actor_source', 'decided_at']) {
    if (typeof ref[k] !== 'string' || !ref[k].trim()) throw new Error(`${label}.${k} 必须是非空字符串`)
  }
  if (!ALLOWED_ACTOR_SOURCES.has(ref.actor_source)) {
    throw new Error(`${label}.actor_source 非法：${JSON.stringify(ref.actor_source)}（仅宿主人工交互可签发）`)
  }
  if (ref.candidate_ref !== undefined && ref.candidate_ref !== null) {
    const d = candidateDigest(ref)
    if (!d) throw new Error(`${label}.candidate_ref 缺少 version.content_sha256`)
  }
}

export function createDecisionRef({ decision_id, logical_run_id, checkpoint_id, candidate_ref, choice, actor_source = ACTOR_SOURCE_HOST, decided_at }) {
  if (!ALLOWED_ACTOR_SOURCES.has(actor_source)) throw new Error(`禁止伪造 actor_source：${JSON.stringify(actor_source)}`)
  const ref = {
    decision_id: String(decision_id),
    logical_run_id: String(logical_run_id),
    checkpoint_id: String(checkpoint_id || decision_id),
    candidate_ref: candidate_ref === undefined ? null : candidate_ref,
    choice: String(choice),
    actor_source,
    decided_at: decided_at || new Date().toISOString(),
  }
  assertDecisionRef(ref)
  return ref
}

export function verifyDecisionRef(ref, expected = {}) {
  try {
    assertDecisionRef(ref)
  } catch (e) {
    return { ok: false, reason: String(e.message || e) }
  }
  if (expected.logical_run_id && ref.logical_run_id !== String(expected.logical_run_id)) {
    return { ok: false, reason: `决定归属 Run 不匹配：期望 ${expected.logical_run_id}，实际 ${ref.logical_run_id}` }
  }
  if (expected.decision_id && ref.decision_id !== String(expected.decision_id)) {
    return { ok: false, reason: `decision_id 不匹配：期望 ${expected.decision_id}，实际 ${ref.decision_id}` }
  }
  if (expected.choice && ref.choice !== String(expected.choice)) {
    return { ok: false, reason: `决定选项不匹配：期望 ${expected.choice}，实际 ${ref.choice}` }
  }
  if (expected.candidate_ref) {
    const exp = candidateDigest({ candidate_ref: expected.candidate_ref })
    const act = candidateDigest(ref)
    if (exp && act !== exp) {
      return { ok: false, reason: '候选版本已变化，旧决定不能自动沿用' }
    }
  }
  return { ok: true }
}

/** 编译进 generate.mjs 产物：运行时内联 helpers（生成脚本不可 import） */
export function runtimeHelpersSource() {
  return [
    'const HC_ACTOR_HOST = ' + JSON.stringify(ACTOR_SOURCE_HOST) + ';',
    'function hcCandidateDigest(ref) {',
    '  const c = ref && ref.candidate_ref',
    '  return (c && c.version && typeof c.version.content_sha256 === "string" && c.version.content_sha256.trim()) ? c.version.content_sha256.trim() : null',
    '}',
    'function hcAssertDecisionRef(ref, label) {',
    '  if (!ref || typeof ref !== "object" || Array.isArray(ref)) throw new Error((label || "decision_ref") + " 必须是对象")',
    '  for (const k of ["decision_id","logical_run_id","checkpoint_id","choice","actor_source","decided_at"]) {',
    '    if (typeof ref[k] !== "string" || !ref[k].trim()) throw new Error((label || "decision_ref") + "." + k + " 必须是非空字符串")',
    '  }',
    '  if (ref.actor_source !== HC_ACTOR_HOST) throw new Error((label || "decision_ref") + ".actor_source 非法（仅宿主人工交互可签发）")',
    '  if (ref.candidate_ref != null && !hcCandidateDigest(ref)) throw new Error((label || "decision_ref") + ".candidate_ref 缺少 version.content_sha256")',
    '}',
    'function hcVerifyDecisionRef(ref, expected) {',
    '  try { hcAssertDecisionRef(ref) } catch (e) { return { ok: false, reason: String(e.message || e) } }',
    '  expected = expected || {}',
    '  if (expected.logical_run_id && ref.logical_run_id !== String(expected.logical_run_id)) return { ok: false, reason: "决定归属 Run 不匹配" }',
    '  if (expected.decision_id && ref.decision_id !== String(expected.decision_id)) return { ok: false, reason: "decision_id 不匹配" }',
    '  if (expected.choice && ref.choice !== String(expected.choice)) return { ok: false, reason: "决定选项不匹配" }',
    '  if (expected.candidate_ref) {',
    '    const exp = hcCandidateDigest({ candidate_ref: expected.candidate_ref })',
    '    const act = hcCandidateDigest(ref)',
    '    if (exp && act !== exp) return { ok: false, reason: "候选版本已变化，旧决定不能自动沿用" }',
    '  }',
    '  return { ok: true }',
    '}',
    'function hdHasBusinessOutcomes() {',
    '  return EDGES.some(function (e) {',
    '    if (!e || e.from !== HD_ID) return false',
    '    const id = e.result || (e.outcome !== undefined && e.outcome !== null && e.outcome !== "" ? String(e.outcome) : null)',
    '    return id && HD_CONTROL.indexOf(id) < 0',
    '  })',
    '}',
    'function hcVerifiedAcceptDecision() {',
    '  const ref = A.decision_ref',
    '  if (!ref) return { ok: false, reason: "缺少宿主签发的 decision_ref" }',
    '  const vrf = hcVerifyDecisionRef(ref, { logical_run_id: TASK, decision_id: A.decision_id, choice: "ACCEPT" })',
    '  if (!vrf.ok) return vrf',
    '  if (A.workspace_capability && ref.candidate_ref) {',
    '    const live = A.candidate_ref',
    '    if (!live) return { ok: false, reason: "缺少当前候选实况，无法核验 USER_ACCEPTED" }',
    '    const liveDig = hcCandidateDigest({ candidate_ref: live })',
    '    const decDig = hcCandidateDigest(ref)',
    '    if (liveDig && decDig && liveDig !== decDig) return { ok: false, reason: "成果在决定后已变化，须重新验收" }',
    '  }',
    '  return { ok: true, ref: ref }',
    '}',
    'const HC_CONSUMED = (function () {',
    '  const m = {}',
    '  if (A.consumed_decisions && typeof A.consumed_decisions === "object") {',
    '    for (const k of Object.keys(A.consumed_decisions)) m[k] = A.consumed_decisions[k]',
    '  }',
    '  return m',
    '})();',
  ].join('\n')
}
