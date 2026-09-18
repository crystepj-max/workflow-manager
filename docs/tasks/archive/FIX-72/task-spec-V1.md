# 本地任务规格 · FIX-72 编号迁移收尾（工作区命名核心与闸门认新前缀）

> **注意**：本规格遵守 CHORE-36 拟确立的「验收项执行时机」规则（该任务挂起未合并，本规格自愿先行）：每条 UAT 场景标注执行时机——`裁决前可观测` 或 `收口后观测`。

## 1. 任务元数据

| 元数据 | 值 |
|---|---|
| 需求基线版本 | V1 |
| 对应来源 | cnb#72（FIX-72）；需求分析全文见同目录 `requirements-analysis.md` |
| 优先级 | P1 |
| 前置依赖 | 无 |
| 无人值守许可 | **允许**（硬约束见 §9 规则 R-4：不动他人活跃现场；登记册改动即时提交） |
| 定义时间 | 2026-09-16T06:00:00Z（ approx） |
| 当前状态 | 待确认（待人工确认基线后转「本地已定义」） |

## 2. 任务目标（Goal）

把 2026-09-16 编号迁移（d34f618）的收尾缺口闭合：工作区命名核心与闸门认新前缀（FEAT/FIX/CHORE）、闸门适配「CNB 合并」收口形态、历史账目按事实回填、决策五与新规的口径冲突显式收敛。交付后，**任何用新号开工的任务在正常交付节奏下 `npm run validate` 应为绿**（CHORE-36 因此解挂）。

## 3. 背景与根因（一句话）

迁移只改了「账本」（登记册/编号/定义入库），没改「门口的尺子」（`workspace-convention-core.cjs` 的两条正则与闸门 D-3/D-5/D-8 的判定），且未定义新号任务的命名形态；闸门同时未适配 CNB 合并这一新收口形态。

## 4. 实测基线（2026-09-16 13:45，main == cnb/main @ 98dad77，主干干净）

`node scripts/validate-workspace.mjs` → ❌ 4 项：D-3（fix-65 现场命名）、D-5（`chore-36-r1`）、D-8（10 个任务无归档）、D-10（7 条 branch_retained=true 但分支不存在）；⚠️ 1 项永久误报（决策五 vs `docs/tasks/specs/`）。全文见 `requirements-analysis.md` §2。

## 5. 功能范围（Scope · 应做）

1. **命名核心认新前缀**：`scripts/workspace-convention-core.cjs` 的 `TASK_ID_RE` 扩为 `(?:LOC|CWF|FEAT|FIX|CHORE)-\d+`，`RUN_ID_RE` 扩为 `(?:loc|cwf|feat|fix|chore)-\d+(?:-s\d+)?-r\d+`；同步既有钉死断言（`scripts/test/workspace-convention-core.test.mjs`）并补正/负例。
2. **D-8 轻量归档形态**：`scripts/validate-workspace.mjs` 的 D-8 认可「轻量归档」（`evidence-summary.json` + 指向 CNB 的任务卡存根，`evidence-summary` 须含 merge commit 与 remote 指针）为**远程收口任务**的合格归档；**本地收口任务仍要求全套三件套**（语义分层，不改既有判定）。
3. **D-8 警告条件更新**：`docs/tasks/specs/` 不再触发「决策五废弃目录」警告；该警告改为仅在 `docs/tasks/archive/` 出现同名目录漂移时触发。
4. **轻量归档回填**：为 10 个 CNB 合并任务（LOC-024..027、029..033、FIX-69）本地补建归档（脚本批量生成 + 逐个核对 merge commit 与 CNB#n 对应关系）。
5. **branch_retained 事实回填**：LOC-024..027、029..031（7 条，分支已删除 → `false`）；LOC-032/033/FIX-69 核对分支实况后同样处理（R-9：只按已存在事实回填）。
6. **决策五范围收窄**：`docs/design/workspace-directory-convention-instance-workflow-manager.md` 决策五条目追加范围说明（不改写原决策正文，符合 R-7）；D-8 警告文案同步。
7. **协调事项登记**：在 FIX-65 票面/评论与看板备注中写明「其工作区按新基准应由属主重建为 `dev-fix-65-r1`」——**本任务不执行该重建**。

## 6. 不修改范围（Out of Scope）

- 不动 FIX-65 的工作区/分支（他人活跃现场；无污染规则）。
- 不动 64KB 编译预算问题（FIX-65 主题）。
- 不改 `cwf-run-init` 的 `dev-<run_id>` 派生（已兼容新基准）。
- 不改 D-1/D-2/D-4/D-6/D-7/D-9 判定语义。
- 不改写任何已接受决策的正文（只追加范围说明）。
- LOC-028（非终态）不处置。

## 7. 已确认的关键决策及原因

| 决策 | 选择 | 理由 | 确认人 | 日期 |
|---|---|---|---|---|
| 命名基准 | A 单轨延伸（run_id=`<type>-<n>-r<n>`，分支=`dev-<run_id>`） | 命名单轨单射；生成器零改动；消灭三屋不一致 | 松哥 | 2026-09-16 |
| 归档缺口 | C 轻量归档+远程指针（本地收口=全套三件套，远程收口=存根+摘要） | 本地可考、契约语义分层、成本可控 | 松哥 | 2026-09-16 |
| 决策五冲突 | A 收窄决策五范围（specs/ 复位为定义家） | 新规刚落地不二迁；不改写原决策只追加说明 | 松哥 | 2026-09-16 |
| D-10 回填 | 按事实回填 `branch_retained=false`（R-9，LOC-005 先例） | 纯事实操作，无产品分歧 | 松哥 | 2026-09-16 |

决策票：`decision-tickets/DT-01-naming-and-archive-closure.md`（已关闭决策记录）。

## 8. 规则（施工期硬约束）

| 规则 | 内容 |
|---|---|
| R-1 | 全程只读校验器原则不变：`validate-workspace.mjs` 保持零写入 |
| R-2 | 正则扩展必须同时更新 `workspace-convention-core.test.mjs` 的钉死断言与正/负例，禁止只改实现 |
| R-3 | 轻量归档的 `evidence-summary.json` 必须含：`task_id`、`status: 已合并`、`merge.commit`（与登记册逐字一致）、`remote_ref: cnb#<n>`、`archive_form: lightweight-remote` |
| R-4 | 不动他人活跃现场（FIX-65）；登记册为最热并发写点——**每次状态/字段推进单独成提交，提交后复查** |
| R-5 | 回填一律以登记册与 git 实况为准，禁止编造 merge commit 或 CNB 号（R-9） |

## 9. 边界场景

| 场景 | 预期 |
|---|---|
| 未来 FEAT/CHORE 号任务的 run 目录与工作区 | D-3/D-5 正常判定（正例测试覆盖 `feat-1-r1`、`chore-36-r1`、`fix-72-r1`） |
| 小写旧号目录（`loc-014-r1`） | 仍合法（向后兼容，不回退） |
| 大写混合或畸形（`Fix-65-r1`、`fix65-r1`） | 仍判非法（负例） |
| 本地收口任务缺全套三件套 | 仍失败（轻量形态只豁免远程收口任务） |
| 远程收口任务的轻量归档缺 merge commit 或 CNB 指针 | 失败（轻量≠无凭据） |

## 10. 已知限制

- 决策五原文不改写，只在实例文档追加范围说明——读原文不读追注的人可能仍按旧口径理解（已用加粗追注降低风险）。
- 轻量归档不含规格正文，规格细节必须到 CNB#n 查看；若 CNB 侧 issue 被清理，这部分历史不可恢复（已在存根中记录风险）。
- FIX-65 重建现场依赖其属主执行，本任务无法保证时点；在其重建前 D-3 对该工作区仍报失败——**这不是本任务的验收失败**（见 UAT-03 的豁免口径）。

## 11. 验收标准（Acceptance）

- [ ] V-1 `workspace-convention-core.cjs`：`isTaskId` 对 `FIX-72`/`CHORE-36`/`FEAT-1` 为 true、对 `fix65`/`fix-65-x` 为 false；`isRunId` 对 `chore-36-r1`/`fix-65-r1`/`loc-014-r1` 为 true、对 `Fix-65-r1`/`fix-65-compile-output-size` 为 false（正/负例进测试）。
- [ ] V-2 `node scripts/validate-workspace.mjs` 在回填完成后：D-5 通过（`chore-36-r1` 合法）；D-10 通过（无「保留分支但分支不存在」条目）。
- [ ] V-3 D-8 通过：10 个任务均有轻量归档且抽查 3 个的 `merge.commit` 与登记册逐字一致、`remote_ref` 与 cnb#n 对应。
- [ ] V-4 D-8 警告不再对 `docs/tasks/specs/` 触发；实例文档决策五条目含加粗追注且原文未被改写（`git diff` 逐字核对）。
- [ ] V-5 本地收口语义不放松：构造一个缺全套三件套的**本地收口**任务（无 remote/轻量标记），D-8 仍失败（负例测试）。
- [ ] V-6 轻量归档缺凭据（缺 merge commit 或 CNB 指针）时 D-8 失败（负例测试）。
- [ ] V-7 既有测试全绿：`npm test`（工作区内，`env -u NODE_OPTIONS`）0 失败；新增断言的正/负例均在其中。
- [ ] V-8 `npm run validate` 与 `npm run release:verify` 通过（FIX-65 现场若尚未重建，D-3 的该项失败按 §10 已知限制豁免，须在收口摘要中如实记录）。
- [ ] V-9 FIX-65 票面/看板已写明协调事项；本任务全程未改动 `fix-65-compile-output-size` 工作区（`git worktree list` + 该目录 `git status` 取证）。
- [ ] V-10 登记册回填与提交一一对应：每个改动批次单独成提交，`git log` 可逐条追溯。

## 12. UAT 场景

### UAT-01 新号 Run 目录被闸门接受【裁决前可观测】
- 前置条件：CHORE-36 工作区在制或其 run 目录存在。
- 操作：`node scripts/validate-workspace.mjs`。
- 预期：D-5 通过，明细中不再出现 `chore-36-r1 ← 非 TASK_ID / RUN_ID`。

### UAT-02 回填后账实一致【裁决前可观测】
- 操作：抽查任一轻量归档的 `evidence-summary.json`，对照登记册 `merge.commit` 与 cnb 远端。
- 预期：三处逐字一致。

### UAT-03 FIX-65 现场协调【收口后观测（依赖属主重建时点）】
- 操作：FIX-65 属主把工作区重建为 `dev-fix-65-r1` 后，复跑校验器。
- 预期：D-3 通过；若属主尚未重建，D-3 的该项失败按 §10 豁免记录，不阻塞本任务收口。

### UAT-04 CHORE-36 解挂【收口后观测】
- 操作：CHORE-36 会话按其 blocked 交接包的重入四步重入，复跑闸门。
- 预期：D-3/D-5 对其现场全绿，`npm run validate` 通过。

## 13. 风险

- 并发写入登记册（已两次事故）：靠 R-4 的即时提交纪律缓解。
- CNB issue 内容缺失时轻量存根的信息量有限（已列为已知限制）。

## 14. 版本历史

| 版本 | 日期 | 变更摘要 | 确认人 |
|---|---|---|---|
| V1 | 2026-09-16 | 初版：三张决策卡关闭（命名基准 A / 归档缺口 C / 决策五 A）；D-10 事实回填随任务执行 | 松哥 |
