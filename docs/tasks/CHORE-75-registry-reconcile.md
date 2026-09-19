# CHORE-75 · 本地任务卡

## 任务基本信息

| 字段 | 值 |
|---|---|
| 任务标识 | `CHORE-75` |
| 远端 issue | cnb#75（编号由 CNB 远端发号） |
| 需求来源 | 会话录入 |
| 来源定位 | 2026-09-16 CHORE-36 重入实测（第 4 次同型现象）；2026-09-19 账实盘点补充范围收敛与 stash 条文承接 |
| 任务名称 | 开工与收口纪律护栏：工作区命名、账实识别与规则分发对齐 |
| 任务类型 | 维护性（编号类型 CHORE） |
| 优先级 | P1 |
| 当前状态 | 定义中 |
| 需求基线版本 | V1 |
| 前置依赖 | 无 |
| 施工环境组 | 待定 |
| 施工环境角色 | 独立 |
| 无人值守许可 | 允许 |
| 任务规格位置 | `docs/tasks/specs/CHORE-75-registry-reconcile/task-spec-V1.md`（入库） |
| 定义时间 | 待人工确认 |
| GitHub 同步 | pending |

> 说明（不进机器解析字段）：
> - `无人值守许可 = 允许` 的依据：护栏前移、对账识别补齐与纪律条文落盘，施工中无需要人取舍的产品问题。
> - 取值约束：`无人值守许可` 只能写枚举原值，`GitHub 同步` 只能写 `pending` / `synced#N` / `not-applicable`，附加自然语言会导致实施前检查失败。

## 摘要（三要素速览）

### 任务目标

把开工与收口的两道护栏从「事后检查 + 人工回填」前移到「产生违规的那一刻就拦住」，并补上对账脚本认不出真实工作的盲区，让账实不符不再周期性复发。

### 涉及范围

- 做：
  - 开工护栏：`cwf-run-init` / 环境登记拒绝或纠正非规范工作区命名（把 D-3 检查前移）
  - 收口护栏：CNB 合并流程强制产出轻量归档
  - 补 `registry-reconcile` 识别盲区——使其能认出「分支自建未合并的工作」与「经 CNB PR 合入但无尾注的提交」
  - 落盘 `stash@{1}` 遗留的 4 行开工纪律条文（三条 SKILL.md），并同步安装态副本
- 不做：
  - 不重做 `registry-reconcile` 的例行对账集成（已被 CHORE-73 + FIX-76 覆盖）
  - 不改动 FIX-72 已修好的命名尺子本身
  - 不触碰 FEAT-84/85/86 相关的工作流 UI 交互（由 ZCODE 推进）

### 验收标准

1. 以非规范命名启动环境登记时被拒绝或自动纠正；规范命名不受影响。
2. 经 CNB 合并请求收口的任务具备轻量归档产物；缺失时有显式红灯。
3. `registry-reconcile` 能识别上述两类事实且输出可见，既有对账结果不回归。
4. 4 行纪律条文逐字落于对应 SKILL.md，安装态副本同步。
5. 既有测试全绿，新增用例覆盖 1–3。

## 关键证据（2026-09-19 实测）

| 项 | 实测结果 |
|---|---|
| 命名尺子 | FIX-72 已修好（`TASK_ID_RE` / `RUN_ID_RE` 认 FEAT/FIX/CHORE），缺口在用尺子的人 |
| 违规现场 | `fix-65-compile-output-size`、`chore-73-registry-reconcile` 等非 `dev-<run_id>` 工作区，D-3 两次转红 |
| 归档缺口 | LOC-024..033、FIX-65/66、CHORE-73 等 13+ 个任务缺归档，D-8 四次转红，每次人工回填 |
| 对账盲区 | `registry-reconcile.mjs` 只认「主干 merge commit 尾注」；分支自建工作与无尾注的 CNB 合并均不可见——#76/#77/CHORE-38 状态滞后的直接根因 |
| stash 条文 | `stash@{1}` 三条 SKILL.md 新增 37 行，**未落地恰好 4 行**（逐字原文见规格 §5） |

## 关联

- `wayfinder/tickets/SYNC-02-cnb-issue-inventory.md`（账实盘点与范围收敛依据）
- `wayfinder/tickets/SYNC-03-closeout-gap-and-stash-audit.md`（stash 审计与根因）
- `docs/tasks/specs/CHORE-73-registry-reconcile/`（对账脚本本体）
- CHORE-106（收口 close-task 动作实现，与本票互补：本票管识别与纪律，CHORE-106 管关闭动作）
