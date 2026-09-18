# 内置角色职责矩阵与模板节点绑定对照（LOC-033 / WR-013）

> 本文是 LOC-033 交付的 AC-01 底物：12 个内置角色的职责矩阵 + 四模板节点绑定对照。
> 业务规则权威 = `docs/tasks/specs/role-boundaries/task-spec-V1.md` §9；优先级 = 宿主安全与授权 → 节点场景契约 → 角色通用能力（通用角色不得覆盖节点基线）。
> 角色清单唯一事实源 = `dsh/roles/builtin-roles.json`；固定文件名、Git 要求、输出枚举、路径与任务完成条件放 Node/上下文，不放角色。

## 1. 十二内置角色职责矩阵

| 角色 | 核心职责 | 允许 | 不做（边界） | 独立性要求 |
|---|---|---|---|---|
| requirements | 把原始诉求加工成三要素齐全的需求基线 | 读原始输入、提取目标/范围/验收、列待澄清项 | 不写代码、不做方案设计、不编写测试、不进入实施 | 不替使用者做业务取舍 |
| designer | 把已确认需求转化为可实施方案（路径/取舍/风险） | 现状勘察、拆解路径、列备选与推荐 | 不实现方案、不写测试、不重定义需求范围、不进入实施 | 保留为定义/自定义工作流资产，不删除 |
| dev | 按目标/范围/验收实现需求 | 必要自测与实现相关测试（含 tdd 方式） | 不自签独立测试证明；不对规范/质量下裁决；不做最终验收；不做合并收口 | 独立测试证明必须由独立会话/测试角色出具 |
| review | 对实现做规范符合性与代码质量双轴审查 | 独立判断、给出 APPROVE / REQUEST_CHANGES / COMMENT_ONLY | 不实施修复、不写测试、不修改候选、不做人工验收 | 与开发异源独立，不护短 |
| test | 对实现做运行态验证与证据判定 | 写测试与验证证据、给出 PASSED / FAILED / BLOCKED | 不修改业务代码、不解决业务源码冲突（发现即回开发/集成）、不做验收 | 独立于开发；报告名以节点契约为准 |
| evaluator | 依节点评价契约独立评估「够不够 / 要不要再来一轮」 | 按节点契约裁决取值评估 | 不内置评价枚举、不重新执行被评估工作、不重写成果、不做人工门禁 | 服从节点给定裁决与评价标准 |
| accept | 对照验收标准做最终核验并整理人工验收材料 | 整理节点契约要求的验收材料（建设为 uat-card.md / acceptance-summary.md） | 不修改业务代码、不实施修复、不补测试、不代签人工决定 | 唯一必须由人签字的环节；建设按严格三态 ACCEPT / REJECT / CONDITIONAL_PASS，二态不得覆盖 |
| closeout | 验收通过后的一致性收口与交接产物汇总 | 整理已冻结事实、按节点声明执行推送/合并/清理 | 不实施修复、不重新验收、不改写前序结论；外部执行机制归 WR-014 | 只整理事实，不伪造合并/关闭结果 |
| diagnose | 故障复现、根因假说与支持/反驳证据收集 | 取证、列候选假说、按证据收敛 | 不实施修复、不下质量裁决、不做最终验收；未验证推测不得写成已确认根因 | 把握度与证据质量一致，弱证据不得标 HIGH |
| orchestrator | 设计研究方案与专家任务书 | 定核心问题、判研究条件、设计互补视角 | 不执行具体研究、不做综合、不下评估裁决；不为专家创建永久角色 | 完成取值随节点契约（探索模板 PLAN_READY） |
| researcher | 按任务书以指定视角独立取证 | 区分证据层级、主动找反证、输出观点卡 | 不做跨专家综合、不下评估裁决、不预设结论 | 首轮认知隔离；confidence 随节点契约（探索模板 high / medium / low）；报告名随节点声明 |
| synthesizer | 把多份独立判断整合为可决策的观点地图 | 识别共识/分歧/关键假设、保留分歧 | 不重新执行研究、不拼接报告、不多数投票、不下评估裁决 | 不消除真实分歧，不虚增同源证据权重 |

兼容角色 `dispatcher`（builtin:false）不在内置 12 角色之列，随模板打包分发。

## 2. 四模板节点绑定对照

### 2.1 wf-construction-full-feature（完整功能开发）

| 节点 | 角色（profile） | 场景契约要点（节点提供，角色不猜） |
|---|---|---|
| preflight | evaluator | 实施前硬门禁；PASS / BLOCKED |
| dev | dev | 隔离 worktree（路径/分支以运行上下文与 run.json 为准）；自测允许，独立测试证明归测试节点；READY / NEED_REDEFINE / BLOCKED |
| review | review | 独立会话收敛审查；route 与 verdict 成对一致（CONTRACT_INCONSISTENT 拦截） |
| test | test | 只审同一候选；独立运行验证；产物 test-report.md |
| uat | accept | 严格三态 ACCEPT / REJECT / CONDITIONAL_PASS；产物 uat-card.md + acceptance-summary.md；不代签 |
| closeout | closeout | 仅对人工验收通过的成果收口；status=DELIVERED |

### 2.2 wf-optimize（优化 · 快速迭代）

| 节点 | 角色（profile） | 场景契约要点 |
|---|---|---|
| confirm | requirements | 生成并冻结 evaluation contract；contract_digest 为真实 SHA-256 |
| execute | dev | 最小必要修改；**不设 Git 前置**（不要求 dispatch-result / worktree / 分支 / PR）；READY / RECONFIRM_REQUIRED / BLOCKED |
| evaluate | evaluator | 只依冻结契约评估；PASS / OPTIMIZE / CONFIRM |
| closeout | closeout | 区分 EVALUATION_PASSED / USER_ACCEPTED |

### 2.3 wf-diagnose（诊断 · 缺陷修复）

| 节点 | 角色（profile） | 场景契约要点 |
|---|---|---|
| diagnose | diagnose | 先复现后结论；证据不足且不可复现即 BLOCKED，不猜根因 |
| fix | dev | 只针对根因最小修复，以 feedback signal 为验收基准 |
| review | review | 四选一：APPROVE / FIX_ISSUES / ROOT_CAUSE_REFUTED / BLOCKED |
| regression | test | 回归产物 = 节点声明的 regression-report.md（不套用其他模板报告名）；发现业务源码冲突记录后回修复节点 |
| closeout | closeout | 保留诊断/修复/审核/回归四类记录 |

### 2.4 wf-explore（探索 · 多视角探索）

| 节点 | 角色（profile） | 场景契约要点 |
|---|---|---|
| orchestrate | orchestrator | route=PLAN_READY；3–5 份专家任务书；BROAD / TARGETED |
| research | researcher | 认知隔离 + 独立 scratch；confidence=high / medium / low（小写，节点 schema 枚举）；报告名 research-\<expert_id\>.md 由节点声明 |
| synthesize | synthesizer | 共识 / 分歧 / 证据地图；不多数投票 |
| evaluate | evaluator | verdict=PASS / NEEDS_RESEARCH / INSUFFICIENT；INSUFFICIENT 是合法完成 |

## 3. 一致性维护

- 角色 `.md` 正文不得硬编码节点应提供的文件名、Git 要求、输出枚举、路径与完成条件；示例必须标注「以节点契约为准」。
- 模板节点 goal 变更时同步更新本文对照表；`scripts/test/role-compiled-prompt.test.mjs` 对四模板实际编译注入的 prompt 做快照校验（AC-04），不只对 Markdown 做关键词检查。
- 与 WR-002 的裁决表保持一致；权限字段由 WR-018 拥有，文案不得声称已实现权限隔离；closeout 外部执行机制归 WR-014。
