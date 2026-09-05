#!/usr/bin/env node
/**
 * M1 契约/模板机械验收：不跑真实 skill 会话，只验证落档物与公共契约硬约束。
 * 用法：node scripts/ai-task-define-m1-check.mjs [fixturesDir]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const fixturesDir = path.resolve(process.argv[2] || path.join(root, 'scripts/test/fixtures/ai-task-define-m1'))

const errors = []
function fail(msg) { errors.push(msg) }
function ok(cond, msg) { if (!cond) fail(msg) }

function read(p) {
  return fs.readFileSync(p, 'utf8')
}

function mustExist(rel) {
  const p = path.join(root, rel)
  ok(fs.existsSync(p), `缺少文件: ${rel}`)
  return p
}

// --- 公共契约硬约束 ---
const contractPath = mustExist('docs/design/ai-task-define-delivery/public-task-contract.md')
if (fs.existsSync(contractPath)) {
  const c = read(contractPath)
  ok(/产品拍板[^\n]*3|auto_rework_limit\s*=\s*3|统一为 \*\*3\*\*/.test(c), '公共契约必须写明自动返工上限产品拍板为 3')
  ok(!/最多允许 \*\*2\*\*|最多 2 轮自动返工(?![\s\S]*产品拍板)/.test(c) || /产品拍板[^\n]*3/.test(c), '公共契约不得以 2 作为现行上限而不标注拍板覆盖')
  ok(/ACCEPT/.test(c) && /REJECT/.test(c) && /CONDITIONAL_PASS/.test(c), '公共契约必须含验收三态机器常量')
  ok(/已定义/.test(c) && /DEFINITION|DEFINING|DEFINED/.test(c), '公共契约必须含已定义状态')
  ok(/无人值守许可/.test(c), '公共契约必须含无人值守许可字段')
  ok(/前置依赖/.test(c), '公共契约必须含前置依赖字段')
}

// --- 模板齐全 ---
const requiredDocs = [
  'docs/design/ai-task-define-delivery/task-spec-template.md',
  'docs/design/ai-task-define-delivery/issue-basics-template.md',
  'docs/design/ai-task-define-delivery/definition-check.md',
  'docs/design/ai-task-define-delivery/baseline-change-v1-v2.md',
  'docs/design/ai-task-define-delivery/construction-bridge-m1.md',
  'dsh/skills/requirements-analysis/references/task-spec-template.md',
  'dsh/skills/requirements-analysis/references/issue-basics-template.md',
  'dsh/skills/requirements-analysis/references/definition-check.md',
  'dsh/skills/requirements-analysis/references/baseline-change-v1-v2.md',
]
for (const rel of requiredDocs) mustExist(rel)

const skill = read(mustExist('dsh/skills/requirements-analysis/SKILL.md'))
ok(/已定义/.test(skill), '需求分析 Skill 必须产出「已定义」')
ok(/Definition Check/.test(skill), '需求分析 Skill 必须含 Definition Check')
ok(/不新建第二套定义入口|唯一定义入口/.test(skill), 'Skill 必须声明不新建第二入口')
ok(/未决产品事项/.test(skill), 'Skill 必须要求未决事项为 0')

// --- 任务规格必备章节 ---
const SPEC_HEADINGS = [
  '## 1. 需求背景',
  '## 2. 用户问题',
  '## 3. 目标',
  '## 4. 非目标',
  '## 5. 修改前',
  '## 6. 修改后',
  '## 7. 功能范围',
  '## 8. 不修改范围',
  '## 9. 业务规则',
  '## 10. 用户操作路径',
  '## 11. 异常和边界场景',
  '## 12. 已确认的关键决策及原因',
  '## 13. 功能切片关系',
  '## 14. 前置依赖说明',
  '## 15. 验收条件',
  '## 16. UAT 场景',
  '## 17. 风险',
  '## 18. 已知限制',
  '## 19. 版本历史',
]

function assertSpec(file, label) {
  const body = read(file)
  for (const h of SPEC_HEADINGS) {
    ok(body.includes(h), `${label} 缺少章节: ${h}`)
  }
  ok(/需求基线版本\s*\|\s*V\d+/.test(body), `${label} 必须声明需求基线版本`)
  ok(/当前状态\s*\|\s*已定义/.test(body), `${label} 当前状态应为已定义`)
  ok(/未决产品事项|已确认的关键决策/.test(body), `${label} 应含决策落档`)
  // 未决为 0：示例不得残留「待决策」占位
  ok(!/待决策|TBD_PRODUCT|未决：是/.test(body), `${label} 不得残留未决产品事项占位`)
}

function assertIssueBasics(file, label) {
  const body = read(file)
  for (const f of ['任务名称', '任务类型', '优先级', '当前状态', '需求基线版本', '前置依赖', '无人值守许可', '任务规格位置', '定义时间']) {
    ok(body.includes(f), `${label} 缺少字段: ${f}`)
  }
  ok(/已定义/.test(body), `${label} 状态应为已定义`)
}

function assertDefinitionCheck(file, label) {
  const body = read(file)
  ok(/未决产品事项数\s*\|\s*0/.test(body), `${label} 未决产品事项数必须为 0`)
  ok(/全部通过/.test(body), `${label} 应有全部通过结论`)
  const unchecked = body.match(/^- \[ \] /gm) || []
  // 结论区可能保留模板 checkbox；要求目标与范围等主要项已勾选
  const checked = body.match(/^- \[x\] /gmi) || []
  ok(checked.length >= 20, `${label} 应勾选主要检查项（期望 ≥20，实际 ${checked.length}）`)
  ok(unchecked.length <= 5, `${label} 未勾选项过多（允许结论区少量未选模板项）: ${unchecked.length}`)
}

// --- fixtures ---
ok(fs.existsSync(fixturesDir), `fixtures 目录不存在: ${fixturesDir}`)
const simpleDir = path.join(fixturesDir, 'simple-clear-cache')
const complexDir = path.join(fixturesDir, 'complex-with-decisions')
ok(fs.existsSync(simpleDir), '缺少简单需求示例目录 simple-clear-cache')
ok(fs.existsSync(complexDir), '缺少复杂需求示例目录 complex-with-decisions')

if (fs.existsSync(simpleDir)) {
  assertSpec(path.join(simpleDir, 'task-spec-V1.md'), 'simple/task-spec')
  assertIssueBasics(path.join(simpleDir, 'issue-basics.md'), 'simple/issue-basics')
  assertDefinitionCheck(path.join(simpleDir, 'definition-check.md'), 'simple/definition-check')
}
if (fs.existsSync(complexDir)) {
  assertSpec(path.join(complexDir, 'task-spec-V1.md'), 'complex/task-spec')
  assertIssueBasics(path.join(complexDir, 'issue-basics.md'), 'complex/issue-basics')
  assertDefinitionCheck(path.join(complexDir, 'definition-check.md'), 'complex/definition-check')
  const decisions = read(path.join(complexDir, 'task-spec-V1.md'))
  ok(/无人值守/.test(decisions) && /决策/.test(decisions), '复杂示例必须体现已完成的产品决策（含无人值守）')
  ok(/UAT-01/.test(decisions) && /UAT-0?2|切片/.test(decisions), '复杂示例应体现可 UAT 切片或多项 UAT')
}

if (errors.length) {
  console.error('ai-task-define-m1-check FAILED:')
  for (const e of errors) console.error(' -', e)
  process.exit(1)
}
console.log('ai-task-define-m1-check PASSED')
console.log(JSON.stringify({
  contract: 'ok',
  templates: requiredDocs.length,
  fixtures: ['simple-clear-cache', 'complex-with-decisions'],
  auto_rework_limit: 3,
  acceptance_states: ['ACCEPT', 'REJECT', 'CONDITIONAL_PASS'],
}, null, 2))
