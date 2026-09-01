# Epic #102 建设工作流 · 可执行验收手册

> 适用范围：验收建设工作流 Portable Contract（v0.1.8）、DSH Bootstrap Profile、证据链引擎、External Profile（PR #139 合并后）与两个真实 dogfood Run 的证据链。
> 执行环境：macOS / zsh、bash、git、gh、Node.js。本手册命令不含行内注释，可直接整行复制到 zsh 执行。

## 0. 环境引导（必须先做）

不要 checkout main（可能被其他 worktree 占用）。为验收单独建 worktree：

```bash
cd /Users/chris/workspace/workflow-manager
git fetch origin main
git worktree add .scratch/worktrees/accept-main --detach origin/main
cd .scratch/worktrees/accept-main
```

清理（全部验收完成后执行）：

```bash
cd /Users/chris/workspace/workflow-manager
git worktree remove --force .scratch/worktrees/accept-main
git branch -D dev-cwf-accept-demo-01
```

下文所有相对路径命令均在 `accept-main` 目录内执行；E 层证据用主检出的绝对路径。

## A. 静态资产完整性

```bash
git ls-tree -r HEAD --name-only | grep -E "construction|cwf-"
grep "版本" docs/design/construction-workflow-portable-contract.md | head -1
ls docs/runbooks/
```

预期：20+ 个交付物（契约、schema、7 示例、skill 三件套、4 个 cwf 脚本、5 个测试套件）；版本行含 v0.1.8；`docs/runbooks/` 含 `construction-external/`（PR #139 合并后）。

## B. 契约语义审读（人工）

读 `docs/design/construction-workflow-portable-contract.md`，逐条认可或不认可：

| 判定点 | 位置 | 预期 |
|---|---|---|
| 主链七阶段顺序固定 | §2 | requirements→design→dev→review→test→acceptance→closeout |
| 回退一次一条边、按根因、优先级上游 | §4.1 | 有根因路由表与优先级 |
| 额度耗尽行为 | §4.3 | WAITING_HUMAN + MAX_ROUNDS_REACHED，不篡改原结果 |
| Decision ≠ Acceptance | §5.1 | 对照表成立（方向取舍 vs 成果签收） |
| AI 不代签 | §5.4 | 禁止事项明确 |
| #105 可消费性 | §9.5 | 11 项逐项有小节映射 |

预期：六条全部认可。不认可处即 finding。

## C. 机械校验强度

```bash
node scripts/cwf-validate.mjs docs/design/construction-workflow/handoff.schema.json docs/design/construction-workflow/examples/*.json
node scripts/cwf-validate.mjs docs/design/construction-workflow/handoff.schema.json /Users/chris/workspace/workflow-manager/.agent-runs/cwf-123-01/requirements_baseline.json /Users/chris/workspace/workflow-manager/.agent-runs/cwf-123-01/design_package.json /Users/chris/workspace/workflow-manager/.agent-runs/cwf-123-01/dev_handoff.a2.json /Users/chris/workspace/workflow-manager/.agent-runs/cwf-123-01/review_proof.a7.json /Users/chris/workspace/workflow-manager/.agent-runs/cwf-123-01/test_proof.a7.json /Users/chris/workspace/workflow-manager/.agent-runs/cwf-123-01/acceptance_package.a7.json /Users/chris/workspace/workflow-manager/.agent-runs/cwf-123-01/closeout_summary.a7.json
```

预期：示例 7 个全部 valid；cwf-123-01 六类记录全部 valid。
反例自测：把任一记录的 `verified_head` 置空再跑应 invalid，证明校验器在拦。

## D. 工具链端到端演练（只读外的轻量写操作）

```bash
cd /Users/chris/workspace/workflow-manager
node .scratch/worktrees/accept-main/scripts/cwf-run-init.mjs 999 cwf-accept-demo-01
node .scratch/worktrees/accept-main/scripts/cwf-run-init.mjs 999 cwf-accept-demo-01
```

预期：worktree + run.json 生成；幂等重跑（同 run_id 同参数）输出 reused=true。

```bash
cd .scratch/worktrees/dev-cwf-accept-demo-01
node ../../../../../accept-main/scripts/cwf-record.mjs rollback .agent-runs/cwf-accept-demo-01 dev
```

说明：rollback 需要真实 git 分支环境，演练 Run 的 worktree 满足；预期额度 1/3 入账。

## E. 真实 Run 证据审计

```bash
ls /Users/chris/workspace/workflow-manager/.agent-runs/cwf-105-bootstrap-01/
ls /Users/chris/workspace/workflow-manager/.agent-runs/cwf-123-01/
cat /Users/chris/workspace/workflow-manager/.agent-runs/cwf-105-bootstrap-01/run.json
```

预期：两目录各含七类记录 + run.json + index.json；cwf-105 的 run.json 含 rollback_history（含 rejected 标记）与 budget_adjustments；cwf-123 的 rollback_history 含 requirements 根因回退（基线 v1→v2）。

## F. 流程纪律实证（人工核对 PR 历史）

- PR #115 / #125 / #132 / #139 的 review 讨论：每轮意见有逐条回复、无代签、收口评论在案；
- 人工门：#105/#123/#104 的基线确认与验收均由 crystepj-max 完成（human_confirmation / decided_by 字段）。

预期：全部属实。

## G. External Profile 就绪检查（PR #139 合并后）

```bash
ls docs/runbooks/construction-external/
grep -c "^### " docs/runbooks/construction-external/runbook.md
node scripts/cwf-run-init.mjs --help
```

预期：两文件存在；小节数 10；脚本报用法提示。

---

## 验收记录表（执行者填写）

| 层 | 结果（通过/差异） | 证据/备注 |
|---|---|---|
| A 静态资产 | | |
| B 契约语义 | | |
| C 机械校验 | | |
| D 工具链演练 | | |
| E 证据审计 | | |
| F 流程纪律 | | |
| G External Profile | | |

验收人：__________　日期：__________　结论：通过 / 不通过（附差异说明）
