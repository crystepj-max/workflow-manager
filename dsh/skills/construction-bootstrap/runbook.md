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
  **路径一律由 `scripts/workspace-paths.mjs` 派生，不得自行拼接**（约定 §1.4/§1.6）：
  · worktree = `<主检出父目录>/<仓库名>-worktrees/<分支名>/`（相邻容器，**不在仓库内**）；
  · 运行目录 = **主检出**的 `.agent-runs/<run_id>/`（产物锚定主检出，不写进工作树——
    这样工作树才是可随时丢弃的目录）。
  任一工作树内执行 `cwf-run-init.mjs` 都得到同一套路径：锚点是主检出（`--git-common-dir`），
  不是当前目录。
- 在 run.json 记录绑定的**需求基线版本**（与 Issue 当前版本一致）；之后不得静默换版。
- **之后全部工作在该 worktree 内进行**；任何 git / npm 命令一律 `git -C <worktree>` 或先 `cd <worktree>` 并核对 `git rev-parse --abbrev-ref HEAD` = `run.json.work_branch`，不一致即停（不得在主检出或别的 worktree 里"顺手"执行）。**这条只约束「在哪里干活」；「产物写到哪里」由上一条锚定规则约束（写主检出）。**
- 同时登记本任务的**插件命名空间**（= run_id）与**开发 DSH 固定端口**（9527）：写在
  `run.json.env_resources` 的 `plugin_namespace` 与 `dev_dsh_port` 两个字段。
- **开发 DSH 是唯一实例，端口固定 9527**（约定 §决策六）。运行期一切 DSH 开发操作都在这一实例上，
  不再为每个 Run 分配独占 Home；启动或切换任务：

```bash
npm run dev:plugin -- start --task <run_id>     # 确保 9527 在跑，并把本任务登记为当前激活任务
npm run dev:plugin                              # status：固定地址 / 运行状态 / 当前激活任务 / 插件注册名
npm run dev:plugin -- stop --task <run_id>      # 登记本任务插件「已停用并注销」（收口回收的前置）
```

  - **同一时刻只允许一个任务激活插件**。若登记表里上一个任务仍是激活态，`start` 会**重启开发环境**
    来清空它的动态插件（DSH 重启即清空全部动态插件，这是 shell 侧唯一可靠手段——动态包绑定定义它的
    会话，脚本无权停用他人会话的包），并明确提示「停掉了谁、现在跑的是谁」。
  - **插件注册名必须带任务命名空间前缀**（`<run_id>-vwf-<哈希>`），禁止裸名；`--task` 缺省时由
    `.agent-runs/` 下唯一登记的 Run 推断，多于一个即报错，不猜。
  - **固定端口被其他进程占用时报错并指名占用者，脚本不会自动改端口**（否则又回到「每次都要查地址」）。
- **taskId / workspace 键必须带 Run 命名空间**：以 `run.json.task_id_namespace`（= run_id）为前缀，如 `cwf-185-01-uat-01`；不得使用无前缀裸名，避免与其他任务撞名。插件注册名同源遵守此规则。

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
3. **环境回收**（决策六：单实例 + 任务命名隔离；在清理 worktree 之前）：先停用并注销本任务的动态 Package，再清掉本任务在开发 Home 内独占的登记与工作区记录。**不删除任何「Home」**——开发 DSH 只有唯一实例，共享 Home 必须保留：

```bash
npm run dev:plugin -- stop --task <run_id>          # 先 cordis_stop + cordis_undefine 之后执行
node "$CWF_ASSETS/cwf-env-recycle.mjs" recycle .agent-runs/<run_id> \
  --report .agent-runs/<run_id>/cleanup-report.md
```

   - 回收**以「激活登记里已有本任务的『已停用注销』记录」为门禁**；没有该记录即拒绝（exit 1），并打印应执行的确切命令。
   - 停不掉时（归属它的会话已消失）用 `npm run dev:plugin -- stop --task <run_id> --unresolved "<原因>"` 如实登记；此时回收**照旧放行**，但该原因会进入报告与遗留事项，**不得谎报为已回收**。
   - 只清本任务命名空间精确匹配的项：`tasks/<run_id>/`（旧独占 Home 遗留）、`workspaces/records/<run_id>/`、工作区登记册中本任务的条目。同属本任务但属「运行记录」范畴的文件只列出、不删除。
   - **回收失败不阻塞合并主路径**，但脚本输出必须原样进入 `closeout_summary.leftovers` / `cleanup-report.md` 后续事项。
   - 需要预演时用只读命令（不改动任何文件）：

```bash
node "$CWF_ASSETS/cwf-env-recycle.mjs" plan .agent-runs/<run_id>
```

4. 本任务标记环境组完成，并仅在**同组全部完成**时清理工作区：

```bash
node "$CWF_ASSETS/ai-task-workspace-env.mjs" mark-completed \
  --store <环境组登记目录> --env <施工环境组> --task <任务标识>
node "$CWF_ASSETS/ai-task-workspace-env.mjs" maybe-cleanup \
  --store <环境组登记目录> --env <施工环境组>
```
5. **合并成果**（务必先跑一遍门禁，冲突时脚本会中止且不改动主干）：

   - **GitHub 轨道**：按仓库规则开 PR 并合并；Issue → 已完成。
   - **本地轨道**（GitHub 不可用）：合并回本地主干，一任务一提交：

```bash
node scripts/local-task-merge.mjs --task <任务标识> --branch <工作分支> \
  --decision accept|conditional_pass [--scope <范围>] [--feedback <优化意见>] \
  --run-id <run_id> [--mirror <镜像远程名>] [--dry-run]
```

   门禁（任一不满足即中止）：验收结果为 `accept`/`conditional_pass`；登记册状态为「等待验收」；任务卡与规格版本一致；任务分支确有新增提交；主干与任务工作区均无未提交改动；任务分支并入主干无冲突。

   通过后自动完成：一任务一提交 → 打标签 `task/<loc-001>/<v1>` → **归档三件套**（任务卡 + 规格终版 + 证据摘要）至 `docs/tasks/archive/<任务标识>/` 并**随同一提交入库**（证据明细若仍在工作树内，脚本会先按锚定规则复制到主检出再生成摘要）→ 登记册状态改「已合并」、记录合并提交与证据保留期 → 重写看板 → `git worktree prune` 兜底注销失效登记 → 可选推送镜像仓库。

   🔴 工作区与分支**暂不删除**（阶段一口径），保留供 GitHub 恢复后补 PR；`GitHub 同步` 保持 `pending`。**再强调一次这个不对称**：工作区可再生（`git worktree add` 从分支重建），分支不可再生（补登 PR 的唯一载体），所以暂停期只留分支不保留工作区。删除工作区时用 `scripts/workspace-paths.mjs` 派生的路径，并在删除后追加 `git worktree prune`。

6. 归档（**`local-task-merge` 已自动完成，此步仅用于未走合并脚本或需要单独重跑时**）：

```bash
node "$CWF_ASSETS/cwf-record.mjs" archive .agent-runs/<run_id>
```

   证据明细按登记册 `evidence_expires_at`（合并时间 + 7 天）保留，到期后由清理动作删除：

```bash
node scripts/task-runs-cleanup.mjs            # 只读预演（默认）
node scripts/task-runs-cleanup.mjs --apply    # 执行清理（摘要缺失的项会被拒绝）
```

7. **本地轨道收尾**：把「有条件通过」的优化意见登记为新的候选任务（分配新的 `LOC-` 号），不改已合并基线：

```bash
node scripts/local-task-registry.mjs allocate --name "<优化任务名>" --source 会话录入
node scripts/local-task-registry.mjs board
```

---

## 统一受阻 / 恢复 / 完成生命周期（LOC-030）

Run 的受阻与完成看 `wf_run` 返回的 `termination`（显式终止描述），技术执行段结束不自动等于业务完成：

- `status=BLOCKED`（生命周期 `BLOCKED`，**非终态**，`terminal=false`）：外部条件暂缺或自动返工额度耗尽，不冒充成功也不挂人工决策，同时释放并发名额。恢复同一 Run：同 taskId + `wf_run entry=<termination.resume_node>`，恢复前先重检阻塞条件；恢复不改变快照、基线或已确认节点（不重复已确认节点）。
- 原因码：`BUSINESS_BLOCKED`=环境/资料/权限暂缺（条件恢复后恢复）；`AUTO_REWORK_EXHAUSTED`=自动返工 3 轮耗尽（人工退回 REJECT 后新一轮交付自动重置额度）；`NEEDS_REDEFINE`=基线需重定义（`resumable=false`，不可原样恢复——完成重定义后重新发起，派生新 Run 并保留旧 Run 原样）。
- `COMPLETION_MISSING`：脚本 DONE 但无有效业务完成映射，宿主不记 `COMPLETED`，补证后从 `resume_node` 恢复。
- `DONE` → `COMPLETED` 仅当完成目标且材料有效（收口 `completion_type` 映射齐全）；探索类 `INSUFFICIENT` 是受控完成但显式标注证据不足。历史无终止描述的 DONE 保留 legacy 标记，不改写为已验证完成。

---

## 通用规则

- 路由：proceed / rollback（耗额度，上限 3）/ await-human / hold / escalate。
- 技术重试、挂起、人工退回触发的返工：**不消耗**自动返工额度（人工退回后新一轮交付重新拥有 3 轮）。
- 禁止：AI 代签、篡改证据制造通过、交付中重开定义/方案产品决策门、用 `user_accepted` 冒充有条件通过。
