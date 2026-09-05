# 建设 · 完整功能开发 · External Profile Runbook（Codex / Cursor 共用）

> **M2 产品主链权威**：`docs/design/ai-task-define-delivery/single-task-delivery-m2.md`（定义外置，从已定义开工）。  
> **语义纪律**：证据底物仍引用建设 Portable Contract；**产品行为以 M2 + 公共任务契约为准**。本 runbook 只做工具映射。

自动返工上限：**3**。验收三态：`accept` / `reject` / `conditional_pass`（禁止 `user_accepted` 冒充有条件通过）。

## 0. 实施前检查

```bash
node scripts/ai-task-preflight-check.mjs <issue-basics.md> <task-spec.md> --run-baseline <Vn>
```

未通过 → 执行受阻 / BLOCKED，停止。通过后导入已确认基线证据 + 说明性 design 包（非产品决策门），再进入开发。

## 开发 → 审查 → 测试

与 DSH Profile 相同：独立审查/测试；失败回退开发（耗额度，上限 3）。

## UAT → 等待验收

生成 UAT 验收卡（模板见 `docs/design/ai-task-define-delivery/uat-card-template.md`），组装验收包：

```bash
node scripts/cwf-checkpoint.mjs .agent-runs/<run_id>
node scripts/cwf-record.mjs write .agent-runs/<run_id> acceptance_package assembled.json --produced-by <你的会话标识> --stage human_acceptance
node scripts/cwf-evidence-verify.mjs .agent-runs/<run_id>
```

Issue → 等待验收；Run → WAITING_HUMAN。呈递用户裁决：**通过 / 退回 / 有条件通过**。AI 不代签。

有条件通过：`decision=conditional_pass` + `feedback` 优化意见 → 收口（`acceptance_outcome=conditional_pass`，leftovers 保留意见）。

退回：人工 rollback 回开发，基线不变，重新跑到新 UAT。

## 收口

```bash
node scripts/cwf-record.mjs archive .agent-runs/<run_id>
```

## 返工额度

```bash
node scripts/cwf-record.mjs rollback .agent-runs/<run_id> <dev|design|requirements>            # 自动回退（耗额度）
```

自动额度默认 3；耗尽挂起升级人工。
