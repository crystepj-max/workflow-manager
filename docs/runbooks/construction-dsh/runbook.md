# 建设 · 完整功能开发 · DSH 轨道 Runbook

> **定位**：本文件只给 **DSH 轨道的操作序列**——按什么顺序敲哪些命令、现场纪律是什么。
> **产品主链语义权威**：`docs/design/ai-task-define-delivery/single-task-delivery-m2.md`（阶段、返工上限 3、验收严格三态、定义外置）。
> **证据与记录语义权威**：`docs/design/construction-workflow-portable-contract.md`（含 §8.3 呈递/签收前证据链校验 ①–⑫、§7.3 Integration Checkpoint）。
> **现场布局权威**：`docs/design/workspace-directory-convention.md` + 本仓实例化说明（worktree 锚定、路径派生、决策六）。
> **执行 Profile**：正式内置蓝图 `templates/wf-construction-full-feature.json` → 生成 `.generated/wf-construction-full-feature/`，安装态 skill `wf-construction-full-feature`。
> 本 runbook **不复制**上述语义；冲突时以上述权威为准。

**脚本路径**：本 runbook 全部命令使用工程真源 `scripts/<名称>.mjs`，在仓库根或本 Run 的 worktree 内执行。
常量：`auto_rework_limit = 3`（与 `rollback_budget` 默认 3 对齐，产品拍板）。

---

## 0. Run 引导

```bash
# GitHub 轨道（远程可用）
node scripts/cwf-run-init.mjs <issue编号> <run_id>

# 本地轨道（GitHub 不可用）——不访问远程，以本地 main 为基线
node scripts/cwf-run-init.mjs <任务标识> <run_id> --local-base
```

- 产出独立分支 / worktree / `.agent-runs/<run_id>/run.json`。
  **路径一律由 `scripts/workspace-paths.mjs` 派生，不得自行拼接**（约定 §1.4/§1.6）：
  worktree = `<主检出父目录>/<仓库名>-worktrees/<分支名>/`（相邻容器，**不在仓库内**）；
  运行目录 = **主检出**的 `.agent-runs/<run_id>/`（产物锚定主检出，不写进工作树——工作树才是可随时丢弃的目录）。
  任一工作树内执行 `cwf-run-init.mjs` 都得到同一套路径：锚点是主检出（`--git-common-dir`），不是当前目录。
- `--local-base` 等价于 `--no-fetch`：`run.json` 记 `base_ref_kind = local`。同一 run_id 复用时，远程/本地基线互相切换会被拒绝，不静默复用。
- run.json 绑定**需求基线版本**（与 Issue/任务卡当前版本一致）；之后不得静默换版。
- **之后全部工作在该 worktree 内进行**；任何 git / npm 命令一律 `git -C <worktree>` 或先 `cd <worktree>`，并核对 `git rev-parse --abbrev-ref HEAD` = `run.json.work_branch`，不一致即停（不得在主检出或别的 worktree 里"顺手"执行）。**本条只约束「在哪里干活」；「产物写到哪里」由上面的锚定规则约束（写主检出）。**
- 同时登记本任务的**插件命名空间**（= run_id）与**开发 DSH 固定端口**：写在 `run.json.env_resources` 的 `plugin_namespace` 与 `dev_dsh_port`。
- **开发 DSH 是唯一实例，端口固定 9527**（约定 §决策六）。运行期一切 DSH 开发操作都在这一实例上，不为每个 Run 分配独占 Home：

```bash
npm run dev:plugin -- start --task <run_id>   # 确保 9527 在跑，并登记本任务为当前激活任务
npm run dev:plugin                            # status：固定地址 / 运行状态 / 当前激活任务 / 插件注册名
npm run dev:plugin -- stop --task <run_id>    # 登记本任务插件「已停用并注销」（收口回收的前置）
```

  - **同一时刻只允许一个任务激活插件**：上一个任务仍激活时，`start` 会重启开发环境清空其动态插件（DSH 重启是清空动态插件的唯一可靠手段），并提示「停掉了谁、现在跑的是谁」。
  - **插件注册名必须带任务命名空间前缀**（`<run_id>-vwf-<哈希>`），禁止裸名；`--task` 缺省时由 `.agent-runs/` 下唯一登记的 Run 推断，多于一个即报错不猜。
  - **固定端口被其他进程占用时报错并指名占用者**，脚本不会自动改端口。
- **taskId / workspace 键必须带 Run 命名空间**：以 `run.json.task_id_namespace`（= run_id）为前缀，如 `cwf-185-01-uat-01`；不得用无前缀裸名，避免与其他任务撞名。插件注册名同源遵守此规则。

---

## 1. 实施前检查（硬门禁，先于建 Run 之后、开发之前）

```bash
node scripts/ai-task-preflight-check.mjs <issue-basics快照.md> <task-spec路径> \
  --run-baseline <Run绑定版本> [--env-store <环境组登记目录>]
```

检查项与失败语义见 `single-task-delivery-m2.md` §2 与 `preflight-check.md`。**失败** → Issue/任务卡 执行受阻、Run `BLOCKED`、写明原因并**停止**，不进入开发。

通过后解析施工环境（**批量调度不得代劳**）：

```bash
node scripts/ai-task-workspace-env.mjs resolve \
  --store <环境组登记目录> --task <任务标识> --env <施工环境组> \
  --role <独立|成员> --deps <无|依赖列表> [--repo <仓>] [--work-root <根>]
```

角色「独立」→ 新建分支 + 独立工作区并登记环境组；「成员」→ 沿用同组现场（前置未完成则受阻串行等待）。随后按 M2 §2 将已定义规格导入为已确认 `requirements_baseline`（注明定义外置导入，不再呈递基线确认门）、写入说明性 `design_package`（`outcome=package_ready`，仅证据链底物），**不得**再开 design 人工决策门。

---

## 2. 起跑主链（引擎驱动）

实施前检查通过后，用正式内置模板起跑，节点顺序、出边路由、回退额度、人工挂起均由引擎按蓝图执行：

- **首选** `wf_run`：`templateId = wf-construction-full-feature`，`taskId` 带 Run 命名空间前缀；本次运行即同一 Logical Run，可续跑、暂停、指导。
- **回退**（仅 `wf_run` 不可用时）：用 `workflow` 工具执行 `.generated/wf-construction-full-feature/script.mjs` + `meta.json`，并**在会话输出中显式提示本次运行记录退化为单段、无完成类型、不可从看板续跑**，不得声称记录完整。
- 状态机语义（`WAITING_HUMAN` / `AWAITING_HUMAN_<id>` / `FAILED_ITEM_CAP` / 额度耗尽 `MAX_ROUNDS_REACHED` 等）与续跑 args 以生成 skill 的 `runbook` 节与 `docs/design/blueprint-schema.md` §2.4、§6 为准。

> **退役说明**：旧 Bootstrap Profile 由 controller 会话逐节点解释专业结果并手工路由（原 runbook §3/§4 与旧 §6.3/§6.4 小节）。该 shim 已随 #77（业务结果路由）、#72/#118（受控人工决策）、#73（`countRound` 额度）落地而退役，**不得再按会话手工路由替代引擎**。九项 shim 的逐项收敛记录见 `docs/design/construction-workflow-portable-contract.md` §9.6。

---

## 3. 回退与额度记账（人工退回 / 引擎外手工回退时）

```bash
node scripts/cwf-record.mjs rollback <runDir> dev            # 自动返工：耗额度，上限 3
node scripts/cwf-record.mjs rollback <runDir> dev \
  --by human --decided-by <验收人> --reason "acceptance reject: <摘要>"   # 人工退回：不耗额度
```

技术重试、挂起、人工退回触发的返工**不消耗**自动返工额度；人工退回后新一轮交付重新拥有 3 轮。

---

## 4. UAT 准备 → 呈递等待验收

1. 按 `docs/design/ai-task-define-delivery/uat-card-template.md` 生成验收卡（落 run 目录 `uat-card.md`）。
   每条验收项必须声明**执行时机**（`裁决前可观测` / `收口后观测`）；「收口后观测」项写进卡片「收口后复核」区，**不得**混入裁决清单或作为裁决前置。一张卡至少一项「裁决前可观测」项，全不可观测属定义不完整 → 退回定义阶段。规则出处：`single-task-delivery-m2.md` §5、`public-task-contract.md` §6.2。
2. Integration Checkpoint，再组装 `acceptance_package`（`status=awaiting_decision`）：

```bash
node scripts/cwf-checkpoint.mjs .agent-runs/<run_id>
node scripts/cwf-evidence-verify.mjs .agent-runs/<run_id>
```

3. 交接包 schema 校验由 `cwf-record` / `formal-records` 写入时自动调用（内核 `scripts/cwf-validate.mjs`，无独立 CLI）。证据链校验（§8.3 ①–⑫，含 CHORE-110 的存在性分层 ⑩–⑫）**任一不满足即不得呈递或签收**。
4. Issue / 本地任务卡 → **等待验收**；Run → `WAITING_HUMAN`；呈递 UAT 卡与验收包，**AI 不代签**。
   本地轨道同步登记册（合并门禁要求此状态）：

```bash
node scripts/local-task-registry.mjs set --task <任务标识> --status 等待验收 --branch <工作分支>
```

5. 无人工操作 → 保持等待；跨日从**原 Run** 恢复，禁止另起丢失上下文的新 Run。

---

## 5. 人工验收（严格三态）

**裁决前重跑** `cwf-checkpoint.mjs` + `cwf-evidence-verify.mjs`（§7.3 要求 Proof 绑定当前 HEAD，target 前进则重跑受影响的 Proof）。回填 `status=decided` + `decision` + `decided_by/at` + `verified_branch/head`。

三态语义与流转以 `single-task-delivery-m2.md` §6 为准：`accept` 收口 / `reject` 人工回退（不耗额度，**基线不变**）/ `conditional_pass` 必须 `feedback` 写优化意见后收口，意见进遗留与下一轮定义输入，**不改基线**。**禁止**用历史 `user_accepted` 表达有条件通过。

---

## 6. 收口

仅 `accept` / `conditional_pass` 可收口，`reject` 禁止。`closeout_summary` 的 `acceptance_outcome` 与验收包 `decision` 一致；`conditional_pass` 时 `leftovers` 收录优化意见。

**6.1 环境回收**（决策六：单实例 + 任务命名隔离；在清理 worktree 之前）。**不删除任何「Home」**——开发 DSH 只有唯一实例，共享 Home 必须保留：

```bash
npm run dev:plugin -- stop --task <run_id>              # 先 cordis_stop + cordis_undefine 之后执行
node scripts/cwf-env-recycle.mjs recycle .agent-runs/<run_id> \
  --report .agent-runs/<run_id>/cleanup-report.md
node scripts/cwf-env-recycle.mjs plan .agent-runs/<run_id>   # 只读预演，不改动任何文件
```

回收**以「激活登记里已有本任务的『已停用注销』记录」为门禁**，没有即拒绝（exit 1）并打印应执行的确切命令。停不掉时用 `npm run dev:plugin -- stop --task <run_id> --unresolved "<原因>"` 如实登记，此时回收照旧放行，但该原因进入报告与遗留事项，**不得谎报为已回收**。只清本任务命名空间精确匹配的项（`tasks/<run_id>/`、`workspaces/records/<run_id>/`、登记册本任务条目）；属「运行记录」范畴的文件只列出不删除。**回收失败不阻塞合并主路径**，但脚本输出必须原样进入 `closeout_summary.leftovers` / `cleanup-report.md` 后续事项。

**6.2 环境组收敛**（仅同组全部完成时清理工作区）：

```bash
node scripts/ai-task-workspace-env.mjs mark-completed --store <目录> --env <组> --task <任务标识>
node scripts/ai-task-workspace-env.mjs maybe-cleanup  --store <目录> --env <组>
```

**6.3 合并成果**（先跑门禁，冲突即中止且不改主干）：

- **GitHub 轨道**：按仓库规则开 PR 并合并；Issue → 已完成。
- **本地轨道**：一任务一提交合并回本地主干：

```bash
node scripts/local-task-merge.mjs --task <任务标识> --branch <工作分支> \
  --decision accept|conditional_pass [--scope <范围>] [--feedback <优化意见>] \
  --run-id <run_id> [--mirror <镜像远程名>] [--dry-run]
```

门禁清单与合并后自动动作见 `docs/design/ai-task-define-delivery/local-track-offline-mode.md` §7.1/§7.4。**删工作区、留分支**（阶段一口径，决策 0001 §6 / 约定 §1.7.1）：工作区可再生、分支不可再生；删除不带 `--force`，工作区脏则拒绝并只登记遗留项，不阻塞合并；删除后追加 `git worktree prune` 兜底注销失效登记。

**6.4 收口后复核**：合并完成后由**执行体（AI）立即**执行验收卡「收口后复核」区各项，把执行时间 / 命令 / 实际结果 / 结论回填该区与 `closeout_summary`；**不得留空、不得静默跳过**。失败如实记录：属真缺陷 → 另立任务（不在本轮静默修）；属环境或时机不成立 → 写明原因与后续触发条件。本条是收口动作的内容，**不新增主链阶段或状态**。

> 前置顺序：`closeout_summary` 需在**删除工作区之前**写入（`cwf-record` 对 `run.work_branch` 有「实际检出必须存在」的血缘守卫；工作区已删则需临时 `git worktree add` 重建检出再写）。

**6.5 归档与证据保留**（`local-task-merge` 已自动完成三件套归档，以下仅用于未走合并脚本或需单独重跑）：

```bash
node scripts/cwf-record.mjs archive .agent-runs/<run_id>
node scripts/task-runs-cleanup.mjs            # 只读预演（默认）
node scripts/task-runs-cleanup.mjs --apply    # 执行清理（摘要缺失的项会被拒绝）
```

证据明细按登记册 `evidence_expires_at`（合并时间 + 7 天）保留，到期后清理（决策二）。

**6.6 本地轨道收尾**：把「有条件通过」的优化意见登记为新的候选任务（分配新号），不改已合并基线：

```bash
node scripts/local-task-registry.mjs allocate --name "<优化任务名>" --source 会话录入
node scripts/local-task-registry.mjs board
```

---

## 通用禁止项

AI 代签人工验收、篡改证据制造通过、交付中重开定义/方案产品决策门、用 `user_accepted` 冒充有条件通过、用会话手工路由替代引擎的 Outcome 路由、谎报环境回收或工作区清理结果。
