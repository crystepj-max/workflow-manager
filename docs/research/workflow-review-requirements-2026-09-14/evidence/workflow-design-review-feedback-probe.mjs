import { readFileSync, writeFileSync } from 'node:fs';
import { compileBlueprint } from '/Users/chris/.codex/worktrees/77ea/workflow-manager/scripts/generate.mjs';
import { makeAgentScript, runGeneratedScript } from '/Users/chris/.codex/worktrees/77ea/workflow-manager/scripts/test/helpers/runtime-harness.mjs';
const root = '/Users/chris/.codex/worktrees/77ea/workflow-manager';
const b = JSON.parse(readFileSync(root + '/templates/wf-optimize.json', 'utf8'));
let n = 0;
const a = makeAgentScript({
  '目标确认': { route: 'READY', summary: '冻结', contract_digest: 'c1' },
  '执行': { route: 'READY', summary: '执行', changed: 'a.md' },
  '评估': () => ({ route: ++n === 1 ? 'OPTIMIZE' : 'PASS', summary: '评估', contract_digest: 'c1', gaps: 'ONLY_IN_EVALUATOR_RESULT_473' }),
  '收口': { status: 'DELIVERED', completion_type: 'EVALUATION_PASSED', summary: '完成', followups: '' },
});
const r = await runGeneratedScript(compileBlueprint(b).script, { args: {}, agent: a });
const xs = r.agentCalls.filter(x => x.label === '执行');
const report = {
  id: 'feedback-handoff', execute_calls: xs.length,
  evaluation_gap_in_second_execute_prompt: xs[1].prompt.includes('ONLY_IN_EVALUATOR_RESULT_473'),
  explicit_evaluation_report_reference_in_second_execute_prompt: xs[1].prompt.includes('evaluation-report.md'),
  status: r.result.status,
};
const file = '/tmp/workflow-design-review-probes.json';
const all = JSON.parse(readFileSync(file, 'utf8'));
all.probes = all.probes.filter(p => p.id !== report.id);
all.probes.push(report);
writeFileSync(file, JSON.stringify(all, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
