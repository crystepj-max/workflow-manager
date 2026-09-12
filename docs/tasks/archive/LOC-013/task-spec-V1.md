# 探索 · 多视角正式模板与专家 scratch 隔离（LOC-013）

| 元数据 | 值 |
|---|---|
| 需求基线版本 | V1 |
| 对应 Issue | 待补（本地轨道，GitHub 恢复后补建） |
| 优先级 | P1 |
| 前置依赖 | LOC-008（targeted 重算消费依赖失效判定） |
| 无人值守许可 | 允许 |
| 定义时间 | 2026-09-11T05:06:27Z |
| 当前状态 | 本地已定义 |

## 1. 需求背景

v0.1 四套正式 Built-in Workflow 中，建设已在 templates/（M2 交付版），优化/诊断已由 LOC-011/012 承接，探索（#82 拆分之四）尚未落卡。规格 §9.4 已把探索方法论与轮次预算全部锁定（BROAD 1 + TARGETED 2、最多 2 次自动 NEEDS_RESEARCH 回退、额度耗尽保留 Outcome 转人工）；引擎层 #77/#72/#73（业务结果路由、人工决策、回退额度）与 #93（共享冻结 source + per-worker scratch）内核均已落地，本卡是最后一块模板资产。

## 2. 用户问题

面对复杂开放问题，用户需要"多视角独立研究后综合与评估"的探索工作流，但当前模板库没有对应蓝图；且现有 fanout 各 worker 共享现场，第一轮专家的认知独立性没有隔离保障。

## 3. 目标

模板库出现"探索 · 多视角探索"内置模板：`templates/explore.json`（统筹 → 专家研究 Fan-out 3–5 → 综合分析 → 结论评估），按锁定轮次预算自动运行；命中第 3 轮仍 NEEDS_RESEARCH 时保留评估原结果并进入人工决策；专家第一轮 scratch 相互隔离、共享只读冻结 source。

## 4. 非目标

- 不增加 Closeout Agent（规格 §9.4 明确）；
- 不做多数投票式综合（Synthesis 构建共识/分歧/证据地图）；
- 不复用 Draft PR #70 的 success/failure 路由、旧 10-role registry 与旧数量测试（规格 §10 禁止整包 cherry-pick；仅允许选择性借鉴探索 Prompt / Schema 思路）；
- 不改 `scripts/workspace-isolation.mjs` 内核语义、不扩展 Container/Remote Provider；
- UI 呈现（归 LOC-016）。

## 5. 修改前

模板库只有建设一套新语义 Built-in（construction-full-feature）；fanout 各 worker 未接 `assembleWorkerContext`，无 per-worker scratch 隔离；无探索蓝图。

## 6. 修改后

新增 `templates/explore.json`（orchestrator → researcher fanout → synthesizer → evaluator 四角色链）进模板库；编译产物的 fanout 节点经 `assembleWorkerContext` 获得共享冻结 source + 独立 scratch；运行态按锁定预算自动回退、额度耗尽转人工；`INSUFFICIENT` 作为合法完成类型落 `completion.type`。

## 7. 功能范围

1. **蓝图**：四节点链 + 业务边（evaluator `outcomePath=$.verdict`，枚举 `PASS / NEEDS_RESEARCH / INSUFFICIENT`）+ technical 自环 + `NEEDS_RESEARCH → orchestrator` 回退边；
2. **fanout 隔离接线**：`scripts/generate.mjs` fanout 节点经宿主 RPC（`vwf.workspace.readSource / writeWorker / readWorker`，能力令牌校验）使用 `assembleWorkerContext` 产出 per-worker scratch；`source` 只读；
3. **轮次预算**：研究轮次计数含首次 BROAD（实现形式见业务规则 B3）；
4. **targeted 重算**：依赖旧证据集合的 Synthesis / Evaluation 在新证据产生后标 stale 并重算（消费 LOC-008 `dependsOnStaleInputs`；本卡落地后判定通道真实存在，不预实现 LOC-008 自身）。

## 8. 不修改范围

- 既有建设 / 优化 / 诊断模板与其蓝图；
- `validate-core.cjs` 走通性规则（业务 SCC 出口规则已就绪）；
- workspace 内核（#93）与 formal-records 内核（#78）；
- 编辑器 / 看板 UI。

## 9. 业务规则

- **B1 轮次预算（规格已锁定）**：总研究轮次 ≤ 3 且含首次 BROAD；自动流程上限 = R1 BROAD + R2 TARGETED + R3 TARGETED；最多 2 次自动 `NEEDS_RESEARCH → orchestrator`；第 3 轮后不得自动启动第 4 轮。
- **B2 额度语义**：`NEEDS_RESEARCH → orchestrator` 回退边 `countRound: true`，`control.maxRounds = 2`；初次执行不计额度由引擎保证（failure/technical 不入 budget，既有的 runtime-count-round 语义成立）。该边是唯一消耗额度的回退路径；其余（targeted 调整、technical 自环）`countRound: false`。
- **B3 轮次计数实现**：研究轮次 = orchestrator 被运行且结果落 `results.orchestrator` 的次数（BROAD 为第 1 次）；计数经运行 `history` 中该回退边的累计次数恢复（跨段可续跑）。评估在 R1/R2 NEEDS_RESEARCH 且额度可用时自动回退；R3 或额度耗尽时 `WAITING_HUMAN + MAX_ROUNDS_REACHED`，**不改写** evaluator 的 NEEDS_RESEARCH。
- **B4 决策材料**：额度耗尽人工决策包默认选项 `USER_ACCEPTED / ADD_BUDGET / STOP`（可由蓝图 `humanDecision.maxRoundsReachedOptions` 覆盖但不可删光）；包体展示三轮研究历史与未解决缺口（why / current_state / options / subsequent_effects）。
- **B5 专家隔离**：第一轮专家上下文隔离——`assembleWorkerContext` 只给 `source_path`（只读）+ 该专家 `scratch_path`，不列兄弟 scratch；读写仅限自己 scratch（`readWorkerFile/writeWorkerFile`）。
- **B6 INSUFFICIENT 合法完成**：evaluator `INSUFFICIENT → $end`；`completionPath=$.completion_type` 常量 `INSUFFICIENT`，`DONE` 时落 `completion.type=INSUFFICIENT`。
- **B7 targeted 增量**：`NEEDS_RESEARCH` 由 evaluator 的 `research_targets`（字符串数组）驱动；仅依赖旧证据集合的 Synthesis / Evaluation 标 stale 并重算，未依赖的兄弟专家结果保留。
- **B8 素材边界**：允许选择性复用 PR #70 的探索 Prompt / Schema 思路；禁止 reopen/rebase #70，禁止整包 cherry-pick 旧路由 / registry / 数量测试。

## 10. 用户操作路径

1. 用户在模板库选择"探索 · 多视角探索"并发起 Run（`wf_run` templateId=explore，taskId=<任务标识>，注入研究问题）；
2. 统筹产出专家任务书 → 专家 fanout 并行研究（各自独立 scratch）→ 综合分析 → 结论评估；
3. 评估 PASS → `$end`，完成类型 = 评估结果；评估 NEEDS_RESEARCH → 自动回统筹做 targeted 补充研究；
4. 第 3 轮仍 NEEDS_RESEARCH → 看板/调用方收到 `WAITING_HUMAN + MAX_ROUNDS_REACHED`，用户看到三轮研究历史与缺口，选择 USER_ACCEPTED（受控完成）/ ADD_BUDGET / STOP；
5. INSUFFICIENT → 正常完成，完成类型落 `INSUFFICIENT`。

## 11. 异常和边界场景

- **E1 第 3 轮 NEEDS_RESEARCH**：保留 evaluator 原 Outcome，转人工，不改写为 PASS/INSUFFICIENT（测试断言 `results.evaluator.verdict === 'NEEDS_RESEARCH'` 且状态 `WAITING_HUMAN`）。
- **E2 worker 越权读兄弟 scratch**：Expert A 经 RPC 读 Expert B scratch → 拒绝（能力令牌 + scratch 路径限域）；E2E 反例必测。
- **E3 技术失败**：worker / synthesizer / evaluator 技术失败沿各自 `on: technical` 自环重试，不进额度；无 technical 边时 `TECHNICAL_FAILURE`。
- **E4 fanout 部分失败**：按 `failOn`（默认 all；本卡采用 `failOn: 'any'` 或按规格取，实施时以剧本断言）走 failure，不伪装成业务 NEEDS_RESEARCH。
- **E5 中断恢复**：人工等待后按 `decision_id + user_choice` 续跑；研究轮次与 `budgetUsed` 从 history 恢复，不重复计数。
- **E6 只读违约**：对共享 source 写操作被拒（workspace 模式 ISOLATED_READ，`writeSourceFile` 拒绝）。

## 12. 已确认的关键决策及原因

| 决策主题 | 选择 | 原因 | 确认人 | 确认时间 |
|---|---|---|---|---|
| 轮次预算 | 总 3 轮含首次 BROAD；最多 2 次自动 NEEDS_RESEARCH 回退；第 3 轮后转人工 | 规格 §9.4/§14 已锁定，不重新议 | 规格定稿 | 2026-08-30 |
| 额度耗尽处理 | 保留原 Outcome + WAITING_HUMAN，不改写 PASS/INSUFFICIENT | 规格 §9.4 红线 | 规格定稿 | 2026-08-30 |
| 专家隔离 | 第一轮上下文隔离 + 独立 scratch | 规格 §9.4 + #93 §6.4 | 规格定稿 | 2026-08-30 |
| 素材来源 | 可选借鉴 PR #70 思路，禁整包 cherry-pick | 规格 §10 | 规格定稿 | 2026-08-30 |
| 无人值守许可 | 允许 | 用户落卡指令（开发计划表 v2 落卡批量授权）；基线 V1 确认 | 用户 | 2026-09-11 |

（未决产品事项 = 0；蓝图字段级取舍——节点 id 命名、schema 细节、goal 文案——属施工自由裁量，不改变产品结果。）

## 13. 功能切片关系

- 本切片：LOC-013 探索模板 + fanout scratch 接线（一张规格）。
- 兄弟切片：LOC-011（优化）、LOC-012（诊断）同为 #82 模板拆分，相互独立可并行；LOC-013 与 LOC-010（建设）无耦合。
- 拆分原则：最小可独立 UAT 的完整功能切片（一张探索模板 + 其专属隔离能力）。

## 14. 前置依赖说明

```text
前置依赖：LOC-008（Formal Records 运行时集成）——探索 targeted 重算的"依赖旧证据集合判定"消费 LOC-008 提供的 dependsOnStaleInputs 通道；LOC-008 未完成前，本卡 B7 的 stale 判定只能断言接口形态，不得假装已生效。
```

## 15. 验收条件

- [ ] 轮次预算 E2E：R3 仍 NEEDS_RESEARCH → `WAITING_HUMAN + MAX_ROUNDS_REACHED`，`results.evaluator.verdict` 原样保留，决策包含三轮历史与缺口、选项含 USER_ACCEPTED/ADD_BUDGET/STOP
- [ ] 专家隔离 E2E：Expert A 无法读 Expert B 的 scratch（反例断言拒绝）；aggregator / synthesizer 仍可消费各专家正式结果
- [ ] targeted 重算：新证据产生后，仅依赖旧证据集合的 Synthesis/Evaluation 标 stale 并重算；未依赖的兄弟专家结果保留（LOC-008 就绪后断言真实 stale，未就绪时断言接口调用形态）
- [ ] `INSUFFICIENT → $end` 且 `completion.type = INSUFFICIENT`
- [ ] 技术失败沿 `on: technical` 自环重试且不消耗额度
- [ ] `npm run generate`、`npm run validate` 全绿；新增行为测试（runtime harness 剧本）覆盖正常 / NEEDS_RESEARCH 回退 / 额度耗尽转人工 / INSUFFICIENT 四路径

## 16. UAT 场景

### UAT-01 正常完成（PASS）

- 验收目的：探索主路径可完成
- 前置条件：产品 DSH 产品模式；研究问题可一次性评估通过
- 操作步骤：wf_run templateId=explore 注入问题 → 等运行结束
- 预期结果：统筹 → 专家 fanout → 综合 → 评估 PASS → DONE；completion.type 落评估值；看板显示一个 Logical Run
- 建议人工关注：专家并行数 3–5、第一轮无交叉引用

### UAT-02 自动回退与额度耗尽转人工

- 验收目的：NEEDS_RESEARCH 自动回退 ≤ 2 次，R3 仍 NEEDS_RESEARCH 转人工
- 前置条件：构造需多轮研究的场景（或测试剧本模拟 evaluator 连续 NEEDS_RESEARCH）
- 操作步骤：发起 Run → 观察 R1→R2→R3
- 预期结果：R1/R2 自动回退（budgetUsed 1→2）；R3 停 WAITING_HUMAN + MAX_ROUNDS_REACHED，evaluator 原结果保留；按 decision_id + user_choice 可续跑（USER_ACCEPTED 完成 / ADD_BUDGET 再走 / STOP 停止）
- 建议人工关注：第 3 轮后不得自动启动第 4 轮

### UAT-03 专家 scratch 隔离

- 验收目的：第一轮专家认知独立
- 前置条件：fanout ≥ 2 专家
- 操作步骤：运行中由 Expert A 尝试读 Expert B scratch（测试剧本注入该行为）
- 预期结果：读取被拒（RPC 能力/路径限域报错）；各专家仅见共享只读 source + 自己 scratch
- 建议人工关注：source 只读（写入被拒）

### UAT-04 证据不足合法完成

- 验收目的：INSUFFICIENT 是合法完成类型
- 前置条件：构造证据不足场景
- 操作步骤：发起 Run → 评估 INSUFFICIENT
- 预期结果：正常 DONE，completion.type=INSUFFICIENT，不进入 FAILED
- 建议人工关注：结果如实标注"证据不足"而非伪装成功

## 17. 风险

- **R1 fanout × 业务路由交织**：fanout 节点本身禁 outcomePath（#89），NEEDS_RESEARCH 判定在 evaluator 单节点——蓝图必须让"专家并行结果"先聚合（failOn）再过 evaluator 出 verdict，避免把 fanout 结果直接当业务路由输入；施工时以剧本断言该边界。
- **R2 targeted 重算依赖 LOC-008**：LOC-008 未完成时 B7 只能到接口形态，验收条件中已降级为"断言接口调用形态"，不假装 stale 判定生效。
- **R3 无人值守下的轮次预算误计**：若轮次计数实现把 technical 重试也算研究轮次，会提前耗尽预算——业务规则 B2/B3 已排除（technical 不进 budget、轮次仅由 NEEDS_RESEARCH 回退边驱动），测试须断言。

## 18. 已知限制

- 专家数量 3–5 为产品口径，蓝图 fanout `items` 由 orchestrator 产出的任务书数组驱动，实际并行数由输入决定；
- 跨段恢复后的 `research_targets` 展示依赖 LOC-016 的 Logical Run 详情视图，本卡只保证数据落档。

## 19. 版本历史

| 版本 | 日期 | 变更摘要 | 确认人 |
|---|---|---|---|
| V1 | 2026-09-11 | 初版基线（自 LOC-013 任务卡三要素规格化；Definition Check 全过后人工确认） | 用户 |
