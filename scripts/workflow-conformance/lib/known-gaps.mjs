// LOC-042：已知产品缺口登记（expected failure，不 skip 冒充 PASS）
// 每条映射 WR/LOC、接口、固定输入与预期；修复后由控制夹具转绿并从此表移除或标 fixed。
export const KNOWN_GAPS = [
  {
    probe_id: 'recoverable-blocked',
    wr: 'WR-009',
    loc: 'LOC-028',
    interface: 'blocked-lifecycle / host logical-run',
    symptom: '专业 BLOCKED 节点 outcome 与宿主 lifecycle COMPLETED/terminal 不一致',
    expected_in_probe: 'engine_status=DONE 且 lifecycle.state=COMPLETED',
  },
  {
    probe_id: 'zero-experts',
    wr: 'WR-010',
    loc: 'LOC-033',
    interface: 'wf-explore orchestrate → research fanout',
    symptom: '0 名专家仍 DONE，未机械校验专家人数',
    expected_in_probe: 'expert_calls=0 且 status=DONE',
  },
  {
    probe_id: 'contradictory-verdict-and-head',
    wr: 'WR-002',
    loc: 'LOC-025',
    interface: 'review/test output.consistency',
    symptom: '矛盾 route/verdict 或不同 verified_head 仍进入 WAITING_HUMAN',
    expected_in_probe: 'status=WAITING_HUMAN 且 review.route≠review.verdict 配对',
    fixed_by: 'LOC-025',
    fixed_expectation: 'CONTRACT_INCONSISTENT 或 WAITING_HUMAN 前拦截',
  },
  {
    probe_id: 'contract-and-completion-drift',
    wr: 'WR-008',
    loc: 'LOC-030',
    interface: 'optimize evaluate.contract_digest vs closeout.completion_type',
    symptom: '评价契约 A/B 漂移仍 USER_ACCEPTED',
    expected_in_probe: 'contract_a≠contract_b 且 completion.type=USER_ACCEPTED',
  },
  {
    probe_id: 'loop-attempt-loss',
    wr: 'WR-020',
    loc: 'LOC-029',
    interface: 'records-host / logical-run node_attempts',
    symptom: '多次评估调用折叠为少量逻辑 attempt',
    expected_in_probe: 'actual_evaluations > logical_evaluations',
  },
  {
    probe_id: 'feedback-handoff',
    wr: 'WR-001',
    loc: 'LOC-024',
    interface: 'optimize execute inputs / evaluation-report.md',
    symptom: '第二次执行未收到评估缺口与报告引用',
    expected_in_probe: 'evaluation_gap_in_second_execute_prompt=false',
    fixed_by: 'LOC-024',
    fixed_expectation: '第二次执行 prompt 含 GAP 标记与 evaluation-report.md',
  },
  {
    probe_id: 'technical-retry',
    wr: 'WR-011',
    loc: 'LOC-031',
    interface: 'generate.mjs technical budget / iM',
    symptom: '持续无效输出直至 AGENT_CAP',
    expected_in_probe: 'calls=1000 FAILED_AGENT_CAP',
    fixed_by: 'LOC-031',
    fixed_expectation: '≤3 次调用后技术预算停止',
  },
]

export function gapForProbe(probeId) {
  return KNOWN_GAPS.find((g) => g.probe_id === probeId) || null
}
