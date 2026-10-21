# M2｜单任务交付（定义外置）

> **里程碑**：M2
> **产品拍板**：改造「建设 · 完整功能开发」——定义外置，交付从「已定义」开工；自动返工上限 **3**；验收严格三态。
> **调用入口**：正式内置蓝图 `wf-construction-full-feature` 及其生成 Skill（`npm run install:builtin-skills` 安装）；DSH 轨道命令序列见 `docs/runbooks/construction-dsh/runbook.md`。不新建第二套交付入口。
> **公共契约**：`public-task-contract.md`
> **证据底物**：可继续使用建设交接包 schema（`handoff.schema.json`）；产品可见主链以本文为准。

---

## 1. 产品可见主链

```text
实施前检查
  ↓
开发
  ↓
收敛审查
  ↓
测试
  ↓
生成 UAT 验收卡
  ↓
WAITING_HUMAN（等待验收）
  ↓
人工：通过 / 退回 / 有条件通过
  ↓
收口 / 返回开发 / 收口并沉淀下一轮定义输入
```

**禁止**：在交付主链内重做需求分析决策闭环或方案设计人工门。定义阶段已由「需求分析」完成。

---

## 2. 实施前检查（硬门禁）

全部通过才可进入开发；任一失败 → Run `BLOCKED`，写明原因并停止。Multica Task 状态仍由 Multica 管理，不由门禁或本地登记册改写。

| # | 检查项 | 失败语义 |
|---|---|---|
| 1 | Multica Task 属于预期 project，当前状态为 `todo` 或 `in_progress` | Task 不匹配或状态不可开工 |
| 2 | Task 的 `dev-flow.definition.v1` 已定义且允许无人值守 | 定义或授权缺失 |
| 3 | 需求基线版本与仓库内 `spec_ref` 一致且可读 | 版本不一致或规格缺失 |
| 4 | Run 绑定版本（若已提供）与 Task 定义一致 | Run 不得静默换版 |
| 5 | 环境组 / 角色合法，Definition Check 通过，未决事项为 0 | 定义材料或环境信息不完整 |
| 6 | `dev-flow.dependencies.v1` 存在；所有依赖在 Multica 同时满足 `status=done` 和 `status_category=done` | 依赖未确认完成 |

机械入口：`scripts/construction-preflight-gate.mjs`。必须显式指定 Multica profile/workspace；缺少 Task 元数据、依赖数据或服务不可用时 fail-closed，不回退到本地 `registry.json`、`BOARD.md` 或任务卡。

通过后将已定义规格导入为已确认需求基线证据，并写入说明性施工包；两者均不构成新的产品决策门。建设状态、负责人、依赖和执行历史通过 Multica 管理；`.agent-runs/` 只保存本地阶段证据。

## 3. 开发 / 审查 / 测试

- **开发**：只按当前需求基线 + 本地任务规格施工；发现必须改变产品结果才能继续 → `BLOCKED：需要重新定义`（不消耗自动返工额度）。
- **收敛审查**：独立会话；阻断项 = 0 才通过；优化建议不阻断。
- **测试**：覆盖主路径、验收条件、边界异常、受影响已有能力、本轮修复项。
- **失败返工**：审查或测试失败 → 返回开发 → 再审查 → 再测试；计入自动返工。

---

## 4. 自动返工上限

`auto_rework_limit = 3`（产品拍板；与 `rollback_budget` 默认 3 对齐）。

达到上限仍不通过 → `BLOCKED`，记录失败节点、已返工次数、未解决问题、建议人工查看内容。

人工验收退回后的新一轮交付，重新拥有最多 3 轮自动返工。

**机制落点（LOC-030 统一受阻生命周期）**：蓝图以 `control.maxRoundsExhausted = "BLOCKED"` 声明本语义（仅建设模板）。额度耗尽时脚本返回 `status=BLOCKED` 与 `termination={business_outcome, lifecycle:"BLOCKED", reason_code:"AUTO_REWORK_EXHAUSTED", resumable:true, resume_node:<返工目标节点>}`，宿主映射为生命周期 `BLOCKED`（非终态、`terminal=false`）并释放并发名额，不再挂 `WAITING_HUMAN`。恢复同一 Run：同 taskId + `wf_run entry=<termination.resume_node>`（恢复前重检阻塞条件）；人工退回（REJECT）触发的恢复自动重置返工额度。`dev` 输出 `NEED_REDEFINE` 时 `reason_code=NEEDS_REDEFINE`、`resumable=false`：不可原样恢复，基线重定义后重新发起（派生新 Run 并保留旧 Run）。历史无终止描述的 DONE 保留 legacy 标记，不改写为已验证完成。

---

## 5. UAT 验收卡 → 等待验收

模板：`uat-card-template.md`。每个主要功能切片至少一个 UAT 点。

**验收项执行时机（硬规则）**：每条验收项必须声明「执行时机」——**裁决前可观测** 或 **收口后观测**。

- 「收口后观测」项（只有当收口/合并之后才可能产生结果：主检出已包含本修复、工作区已删除、主检出自跑全绿等）集中在卡片的「收口后复核」区，**不得**混入人工裁决所依据的清单，也**不得**作为裁决前置；
- 一张卡必须至少有一项「裁决前可观测」项作为裁决依据；若全部验收项都无法在裁决前观测，属需求定义不完整 → 退回定义阶段，不得进入等待验收；
- 违反本规则会让交付操作者照单执行时得到**假红灯**（2026-09-15 LOC-023 实测：合并前主检出跑的仍是修复前脚本，UAT 第 2、3 步结构性不可能绿）。

自动阶段完成后：

- Multica Task 按项目流程进入 `in_review`
- Run → `WAITING_HUMAN`
- 释放 Execution Plan 并发名额（M3 消费；本里程碑只保证语义就绪）
- **AI 不代签**；无操作则继续等待

---

## 6. 人工验收严格三态

| 展示 | 机器字段（交接包） | 流转 |
|---|---|---|
| 验收通过 | `accept`（产品常量 ACCEPT） | 收口 → 已完成 |
| 验收退回 | `reject`（REJECT） | 保持基线；返回开发 → 审查 → 测试 → 新 UAT → 再等人 |
| 有条件通过 | `conditional_pass`（CONDITIONAL_PASS） | 本任务收口；优化意见写入 feedback / leftovers，作为**下一轮定义输入**；**不改**当前基线 |

**废弃**：用历史 `user_accepted`（知情接受未达标）表达「有条件通过」。二者语义不同。

**裁决依据范围**：人工裁决**只取**「执行时机 = 裁决前可观测」的验收项。「收口后观测」项**不是**裁决前置，也不构成新的第四种验收态——三态语义不因此改变。

跨日恢复：必须从原 Run 的 `WAITING_HUMAN` 继续，不得新建丢失上下文的 Run。

---

## 7. 收口

- `accept` / `conditional_pass` → 写 closeout、归档本地证据、按仓库规则开/合 PR，并按 Multica 项目流程更新 Task 状态
- `conditional_pass` 的优化意见必须保留在收口遗留事项中，供下次「做需求分析」摄入
- `reject` 不得收口
- 收口后：对该任务 `mark-completed`；若同施工环境组**全部成员已完成** → `maybe-cleanup` 清理工作区（未齐则保留）
- **收口后复核（「收口后观测」项的执行）**：收口合并完成后，由**执行体（AI）立即执行**卡上「收口后复核」区的各项，并把执行时间、命令、实际结果与结论**回填**到该区与收口摘要；**不得留空、不得静默跳过**。
  - 复核失败 → 如实记录：属真缺陷 → **另立任务**（不在本轮静默修）；属环境/时机不成立 → 写明原因与后续触发条件，列入已知限制；
  - 本条不新增主链状态机节点——它是收口动作的内容，不是新的 Run 阶段。

---

## 8. M2 明确不做

- Execution Plan / 批量 / 定时（M3/M4）——批量**不管**分支与工作区
- 批量侧自动接续有依赖任务（依赖串行由**单任务启动**门禁完成）
- 新建平行的第二套交付 Skill 入口
