import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const root = '/Users/chris/.codex/worktrees/77ea/workflow-manager';
const mod = (p) => import(pathToFileURL(root + '/' + p));
const { compileBlueprint } = await mod('scripts/generate.mjs');
const { runGeneratedScript, makeAgentScript } = await mod('scripts/test/helpers/runtime-harness.mjs');
const { loadHost } = await mod('packages/dsh-visual-workflow/tests/helpers/load-host.mjs');
const { REPO, DSH_HOME, USER_DIR, SKILL_ROOT, makeFs, makeSubprocess, sandboxPolicy } = await mod('packages/dsh-visual-workflow/tests/helpers/fake-services.mjs');
const { recordsCommit, recordsList, recordsGet } = await mod('scripts/records-host.mjs');
const bp = (id) => JSON.parse(readFileSync(root + '/templates/' + id + '.json', 'utf8'));
const optimize = bp('wf-optimize'), diagnose = bp('wf-diagnose'), explore = bp('wf-explore'), construction = bp('wf-construction-full-feature');
async function run(b, table, args = {}) {
  return runGeneratedScript(compileBlueprint(b).script, { args, agent: makeAgentScript(table) });
}
async function settleInHost(b, value, id) {
  const input = structuredClone(b);
  input.id = 'review-probe';
  const compiled = compileBlueprint(input).script;
  const seed = {
    [REPO + '/scripts/validate-core.cjs']: readFileSync(root + '/scripts/validate-core.cjs', 'utf8'),
    [REPO + '/scripts/records-host.mjs']: readFileSync(root + '/scripts/records-host.mjs', 'utf8'),
    [USER_DIR + '/' + input.id + '.json']: JSON.stringify(input),
    [SKILL_ROOT + '/' + input.id + '/script.mjs']: compiled,
  };
  const dir = mkdtempSync('/tmp/wf-review-records-');
  const commands = { commit: recordsCommit, list: recordsList, get: recordsGet };
  const fs = makeFs(seed);
  const subprocess = makeSubprocess({ fs, compileScript: compiled, recordsHost: (cmd, arg) => commands[cmd]({ ...arg, records_dir: dir }) });
  const env = loadHost({ fs, subprocess, sandboxPolicy,
    workflowEngine: { start: () => ({ id: 'engine-' + id, result: Promise.resolve({ stopReason: 'completed', value, agentsStarted: 0 }) }) },
    agents: { requireInitiator: () => ({}) },
  });
  const out = await env.definedTools.find(t => t.name === 'wf_run').execute({ templateId: input.id, taskId: id });
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
  const raw = fs._files.get(DSH_HOME + '/visual-workflow/logical-runs/' + id + '.json');
  if (!raw) throw new Error('未生成逻辑记录：' + out);
  return { logical: JSON.parse(raw), records: recordsList({ records_dir: dir, logical_run_id: id }), dir };
}
const probes = [];
const technical = await run(optimize, { '目标确认': null });
probes.push({ id: 'technical-retry', status: technical.result.status, calls: technical.agentCalls.length, budgetUsed: technical.result.budgetUsed ?? null });
const blocked = await run(diagnose, { '缺陷诊断': { route: 'BLOCKED', root_cause: '', evidence: '测试环境暂时不可用', verified_head: 'head' } });
const blockedHost = await settleInHost(diagnose, blocked.result, 'blocked-probe');
probes.push({ id: 'recoverable-blocked', engine_status: blocked.result.status, node_outcome: blocked.result.results.diagnose.route, lifecycle: blockedHost.logical.lifecycle, terminal: blockedHost.logical.terminal });
const synthesis = { route: 'SYNTHESIS_READY', consensus: [], disagreements: [], evidence_map: '', open_gaps: [], synthesis_summary: '' };
const evaluation = { verdict: 'PASS', completion_type: 'EVALUATION_PASSED', why: '示例评估', summary_for_human: '摘要', current_state: '现状' };
const empty = await run(explore, {
  '探索统筹': { route: 'PLAN_READY', round_type: 'BROAD', research_question: '问题', expert_briefs: [], plan_summary: '无专家' },
  '综合分析': synthesis, '结论评估': evaluation,
});
probes.push({ id: 'zero-experts', status: empty.result.status, expert_calls: empty.agentCalls.filter(c => c.label.startsWith('专家研究')).length, research: empty.result.results.research });
const contradictory = await run(construction, {
  '实施前检查': { route: 'PASS', summary: '通过', blockers: '', baseline_version: 'V1' },
  '开发': { route: 'READY', summary: '完成', self_check: 'done' },
  '收敛审查': { route: 'APPROVE', verdict: 'REQUEST_CHANGES', summary: '阻断项未解决', blockers: '存在阻断项', verified_branch: 'dev-probe', verified_head: 'old-head' },
  '测试': { route: 'PASS', result: 'FAILED', reason: '仍失败', evidence: '', verified_branch: 'dev-probe', verified_head: 'different-old-head' },
  'UAT 准备': { route: 'READY_FOR_HUMAN', summary_for_human: '待验收', why: '准备完成', current_state: '待验收', details: '材料' },
}, { taskId: 'contradiction', work_branch: 'dev-probe', source_revision: 'actual-head' });
probes.push({ id: 'contradictory-verdict-and-head', status: contradictory.result.status, called: contradictory.agentCalls.map(c => c.label), review: contradictory.result.results.review, test: contradictory.result.results.test });
const normal = {
  '目标确认': { route: 'READY', summary: '冻结', contract_digest: 'contract-A' },
  '执行': { route: 'READY', summary: '修改', changed: 'a.md' },
  '评估': { route: 'PASS', summary: '通过', contract_digest: 'contract-B', gaps: '' },
  '收口': { status: 'DELIVERED', completion_type: 'USER_ACCEPTED', summary: '交付', followups: '' },
};
const drift = await run(optimize, normal);
probes.push({ id: 'contract-and-completion-drift', status: drift.result.status, contract_a: drift.result.results.confirm.contract_digest, contract_b: drift.result.results.evaluate.contract_digest, completion: drift.result.completion, decision: drift.result.control_event ?? null });
let evalCount = 0, execCount = 0;
const loop = await run(optimize, { ...normal,
  '执行': () => ({ route: 'READY', summary: '实现版本' + (++execCount), changed: 'a.md' }),
  '评估': () => ({ route: ++evalCount < 3 ? 'OPTIMIZE' : 'PASS', summary: '评估版本' + evalCount, contract_digest: 'contract-A', gaps: '' }),
  '收口': { status: 'DELIVERED', completion_type: 'EVALUATION_PASSED', summary: '交付', followups: '' },
});
const loopHost = await settleInHost(optimize, loop.result, 'loop-probe');
probes.push({ id: 'loop-attempt-loss', actual_calls: loop.agentCalls.length, actual_evaluations: evalCount, retained_evaluation: loop.result.results.evaluate,
  logical_attempts: loopHost.logical.node_attempts.length, logical_evaluations: loopHost.logical.node_attempts.filter(a => a.node === 'evaluate').length,
  stored_evaluation_revisions: loopHost.records.records.filter(r => r.record_id.endsWith(':evaluate')).length,
  record_dir: loopHost.dir,
});
const out = { baseline: '8e38d74955c67f0f196c93eb880cfef7cce71cbd', method: '真实编译器与宿主代码；代理、文件系统和引擎传输使用既有测试替身；不调用真实模型或外部服务', probes };
writeFileSync('/tmp/workflow-design-review-probes.json', JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out, null, 2));
