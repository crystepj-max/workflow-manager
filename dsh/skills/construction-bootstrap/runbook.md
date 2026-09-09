# 建设工作流 · 单任务交付 Runbook（M2）

> **产品主链权威**：`docs/design/ai-task-define-delivery/single-task-delivery-m2.md`  
> **公共契约**：`docs/design/ai-task-define-delivery/public-task-contract.md`  
> 证据底物与交接包字段仍可对照 Portable Contract / `handoff.schema.json`；**产品行为以 M2 文档为准**。

> **脚本路径**：`$CWF_ASSETS/cwf-*.mjs`——安装态 = `<SKILL_DIR>/assets`，源仓库开发 = `scripts`。实施前检查：`node scripts/ai-task-preflight-check.mjs`（安装态亦在 assets）。

常量：`auto_rework_limit = 3`（与 `rollback_budget` 默认 3 对齐，产品拍板）。

---

## 0. Run 引导

**GitHub 轨道（远程可用）**

```bash
node "$CWF_ASSETS/cwf-run-init.mjs" <issue编号> <run_id>
```

**本地轨道（GitHub 不可用）——不访问远程，以本地 main 为基线**

```bash
node "$CWF_ASSETS/cwf-run-init.mjs" <任务标识> <run_id> --local-base
# 示例：node scripts/cwf-run-init.mjs LOC-001 loc-001-r1 --local-base
```

- 任务标识取 `LOC-<序号>`（小写后可直接作 run_id：`loc-001-r1`）。
- `--local-base` 等价于 `--no-fetch`：跳过 `git fetch`，基线 = 本地 `main` 当前提交，`run.json` 记录 `base_ref_kind = local`。
- 同一 run_id 复用时，若上次是远程基线、这次请求本地基线（或反之），脚本拒绝静默复用。

- 产出独立分支 / worktree / `.agent-runs/<run_id>/run.json`。
- 在 run.json 记录绑定的**需求基线版本**（与 Issue 当前版本一致）；之后不得静默换版。
- **之后全部工作在该 worktree 内进行**。

---

## 1. 实施前检查（产品节点；硬门禁）

1. 从 **Issue（GitHub 轨道）或本地任务卡 `docs/tasks/<任务标识>-<slug>.md`（本地轨道）** 读取：任务标识、当前状态、无人值守许可、需求基线版本、前置依赖、施工环境组、施工环境角色、任务规格位置、优先级、定义时间。
2. 读取本地任务规格全文。
3. 执行机械检查：

```bash
node "$CWF_ASSETS/ai-task-preflight-check.mjs" <issue-basics快照.md> <task-spec路径> \
  --run-baseline <Run绑定版本> \
  [--env-store <环境组登记目录>]
```

4. **失败**：Issue/任务卡 → 执行受阻；Run → `BLOCKED`；写明原因；**停止**（不进入开发）。
5. **通过后解析施工环境**（批量调度不得代劳）：

```bash
node "$CWF_ASSETS/ai-task-workspace-env.mjs" resolve \
  --store <环境组登记目录> --task <任务标识> --env <施工环境组> \
  --role <独立|成员> --deps <无|依赖列表> [--repo <仓>] [--work-root <根>]
```

   - 角色「独立」→ 新建分支 + 独立工作区并登记环境组；
   - 角色「成员」→ 沿用同组现场（前置未完成则受阻，串行等待）。
6. 环境就绪后：
   - Issue → 交付中；Run → `RUNNING`；
   - 将已定义规格导入为已确认 `requirements_baseline`（`status=confirmed`，注明「定义外置导入，不再呈递基线确认门」）；
   - 写入说明性 `design_package`：`outcome=package_ready`，摘要写明「定义阶段已外置；本包仅作证据链底物，非新的产品方案决策」——**不得**再开 design 人工决策门；
   - 进入开发（之后全部工作在该工作区内进行）。

---

## 2. 开发

1. 只按需求基线 + 本地任务规格施工；在 Run worktree 内实施。
2. 完成时写 `dev_handoff`（`handoff_ready` / `blocked` / `requirements_issue` 等）。
3. 若继续施工必须改变用户体验 / 范围 / 业务规则 / 验收 / 产品风险 → **不得自行决定**；`BLOCKED：需要重新定义`（不消耗自动返工额度）。
4. `blocked`（可恢复外部条件）→ `hold`，条件恢复后重入开发。

---

## 3. 收敛审查

1. **独立会话**执行；`produced_by` 异于 dev；`independent_session=true`。
2. 检查：需求完整性、范围正确性、已确认决策未被改变、质量与回归风险、是否具备测试/UAT 条件。
3. 阻断项 = 0 → 推进测试；否则 `request_changes` → 单边回退开发（耗自动返工额度）：

```bash
node "$CWF_ASSETS/cwf-record.mjs" rollback <runDir> dev
```

4. 额度耗尽（已用满 3）→ `BLOCKED` / 升级人工；保留原专业结果。

> M2 交付中：需求类根因默认升级为「需要重新定义」受阻，而不是在交付链内重开需求分析会话。

---

## 4. 测试

1. 独立会话；输入 = 审查通过的 HEAD。
2. 覆盖：主路径、验收条件、边界异常、受影响已有功能、本轮修复项。
3. `pass` → UAT 准备；`fail` → 回退开发（耗额度）→ 再审查 → 再测试；`blocked` → hold。

---

## 5. UAT 准备 → 等待验收

1. 按 `<SKILL_DIR>/assets/ai-task-define-delivery/uat-card-template.md`（源码态为 `docs/design/ai-task-define-delivery/uat-card-template.md`）生成验收卡（落盘到 run 目录，如 `uat-card.md`）。
2. Integration Checkpoint：

```bash
node "$CWF_ASSETS/cwf-checkpoint.mjs" .agent-runs/<run_id>
```

3. 组装并写入 `acceptance_package`（`status=awaiting_decision`）。
4. 证据链校验：

```bash
node "$CWF_ASSETS/cwf-evidence-verify.mjs" .agent-runs/<run_id>
```

5. Issue（GitHub 轨道）/ 本地任务卡（本地轨道）→ **等待验收**；Run → **`WAITING_HUMAN`**；呈递 UAT 卡与验收包。**AI 不代签**。
   本地轨道同步登记册（合并门禁要求此状态）：

```bash
node scripts/local-task-registry.mjs set --task <任务标识> --status 等待验收 --branch <工作分支>
```
6. 无人工操作 → 保持等待（跨日从**原 Run**恢复，禁止另起丢失上下文的新 Run）。

---

## 6. 人工验收（严格三态）

裁决前重跑 checkpoint + evidence-verify。回填 `status=decided` + `decision` + `decided_by/at` + `verified_branch/head`。

| 人工结果 | `decision` | 动作 |
|---|---|---|
| 验收通过 | `accept` | 进入收口 |
| 验收退回 | `reject` | 人工回退（不耗自动额度）→ 开发 → 审查 → 测试 → 新 UAT → 再 `WAITING_HUMAN`；**基线不变** |
| 有条件通过 | `conditional_pass` | **必须** `feedback` 写优化意见 → 进入收口；优化意见进遗留/下一轮定义输入；**不改基线** |

退回示例：

```bash
node "$CWF_ASSETS/cwf-record.mjs" rollback .agent-runs/<run_id> dev \
  --by human --decided-by <验收人> --reason "acceptance reject: <摘要>"
```

---

## 7. 收口

1. 仅 `accept` / `conditional_pass` 可收口；`reject` 禁止。
2. `closeout_summary`：`acceptance_outcome` 与验收包 `decision` 一致；`conditional_pass` 时 `leftovers` 收录优化意见。
3. 本任务标记环境组完成，并仅在**同组全部完成**时清理工作区：

```bash
node "$CWF_ASSETS/ai-task-workspace-env.mjs" mark-completed \
  --store <环境组登记目录> --env <施工环境组> --task <任务标识>
node "$CWF_ASSETS/ai-task-workspace-env.mjs" maybe-cleanup \
  --store <环境组登记目录> --env <施工环境组>
```

4. **合并成果**（务必先跑一遍门禁，冲突时脚本会中止且不改动主干）：

   - **GitHub 轨道**：按仓库规则开 PR 并合并；Issue → 已完成。
   - **本地轨道**（GitHub 不可用）：合并回本地主干，一任务一提交：

```bash
node scripts/local-task-merge.mjs --task <任务标识> --branch <工作分支> \
  --decision accept|conditional_pass [--scope <范围>] [--feedback <优化意见>] \
  --run-id <run_id> [--mirror <镜像远程名>] [--dry-run]
```

   门禁（任一不满足即中止）：验收结果为 `accept`/`conditional_pass`；登记册状态为「等待验收」；任务卡与规格版本一致；任务分支确有新增提交；主干与任务工作区均无未提交改动；任务分支并入主干无冲突。

   通过后自动完成：一任务一提交 → 打标签 `task/<loc-001>/<v1>` → 任务卡与规格归档至 `docs/tasks/archive/<任务标识>/` 并**随同一提交入库** → 登记册状态改「已合并」、记录合并提交 → 重写看板 → 可选推送镜像仓库。

   🔴 工作区与分支**暂不删除**，保留供 GitHub 恢复后补 PR；`GitHub 同步` 保持 `pending`。

5. 归档：

```bash
node "$CWF_ASSETS/cwf-record.mjs" archive .agent-runs/<run_id>
```

6. **本地轨道收尾**：把「有条件通过」的优化意见登记为新的候选任务（分配新的 `LOC-` 号），不改已合并基线：

```bash
node scripts/local-task-registry.mjs allocate --name "<优化任务名>" --source 会话录入
node scripts/local-task-registry.mjs board
```

---

## 通用规则

- 路由：proceed / rollback（耗额度，上限 3）/ await-human / hold / escalate。
- 技术重试、挂起、人工退回触发的返工：**不消耗**自动返工额度（人工退回后新一轮交付重新拥有 3 轮）。
- 禁止：AI 代签、篡改证据制造通过、交付中重开定义/方案产品决策门、用 `user_accepted` 冒充有条件通过。
