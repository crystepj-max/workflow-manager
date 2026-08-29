# Workflow Manager Roadmap

> 状态：2026-08-30 统一审查后重排  
> 当前主目标：把早期可运行的 VWF/DSH 工作流原型收敛为正式、可扩展、可审计的 Workflow Manager v0.1 产品底座。

## 1. 北极星

Workflow Manager 面向复杂软件研发与通用知识工作，目标不是“按顺序调用多个 Agent”，而是建立一套：

- 可配置：Workflow / Role / Provider / Model / Outcome / Gate 可声明；
- 可运行：Blueprint 经统一校验、生成与 Runtime 执行；
- 可干预：Human Decision、Pause、Interrupt、Guidance；
- 可恢复：BLOCKED、Snapshot Revision、Resume；
- 可追溯：Formal Record、Revision、Provenance、证据有效性；
- 可扩展：Built-in 给出正式标准，Custom Workflow/Role 保留开放能力。

DSH 是首个运行环境；Codex、Claude Code 等 Coding Agent 属于后续执行器扩展，不反向定义工作流产品模型。

## 2. 两条基线必须分开

### 2.1 当前 main 已实现基线

截至 2026-08-30，仓库已经具备：

- Blueprint → 统一校验/生成 → Skill 的单一事实源链；
- 可视化模板库、画布编辑器和配置面板；
- Built-in / Custom Role Library 基础能力（#58 / PR #61）；
- 受限 Fan-out 与聚合（#18 / PR #38）；
- 多 run 并行、同 taskId 互斥和人工门禁排队（#19 / PR #41、#44）；
- legacy engine-run 运行记录跨进程持久化（#40 / PR #50）；
- 开发/产品双轨规则已经进入 `AGENTS.md`，实施入口仍由 #53 完成；
- 当前 Skill / Chat 是正式执行入口。

这些能力仍运行在早期契约上：`success/failure` 二态路由、旧 run 状态字符串、旧 Built-in 模板/角色集合等。

### 2.2 v0.1 目标规格

权威目标规格：`docs/design/workflow-manager-v0.1-final-product-spec.md`。

v0.1 将正式收敛为：

- 四套 Built-in Workflow：建设 / 优化 / 诊断 / 探索；
- 12 个 Built-in Role；
- Business Outcome Routing + Completion Mapping；
- Formal Records / Revision / Provenance；
- Logical Run / Execution Segment / 固定 Lifecycle；
- Run Snapshot Revision（v0.1 运行中只允许 Provider / Model）；
- Human Decision；
- Pause / Interrupt / Guidance / Resume；
- 自动回退额度；
- Static Validation + Preflight Probe；
- Skill/Chat/未来插件入口共享同一 Logical Run Runtime。

目标规格不是“main 已完成能力清单”。任何施工都必须同时核对实际代码与目标规格。

## 3. v0.1 — Formal Workflow Foundation

v0.1 是当前最高优先级。实施总览：#76。

### Phase A — Blueprint、结果与证明契约

目标：先让框架能正确表达业务语义，再迁移模板。

- #71：全局工作流设计原则；
- #77：Business Outcome Routing + Completion Mapping；
- #72：Human Decision；
- #73：自动回退额度 / `countRound`；
- #78：Formal Records / Revision / Provenance；
- #69：多格式正式 Artifact，在 #78 模型上接入。

阶段出口：

- 合法业务结果不再伪装成 failure；
- Node Result 不携带 `next_node`；
- Proof 能绑定具体 Record Revision；
- Human Decision 与人工验收解耦；
- 回退额度由业务路径显式声明。

### Phase B — Logical Run Runtime

目标：用户看到的是一个完整、可恢复的 Run，而不是多次 engine start。

- #79：Logical Run / Execution Segment / Lifecycle / Snapshot Revision；
- #80：Pause / Interrupt / Run Guidance / Resume；
- #74：Preflight Probe；
- #40 已完成的持久化层作为实现基础，由 #79 升级为 Logical Run 持久化；
- #53：开发模式 / 产品模式双轨入口和正式发布闸门。

阶段出口：

- 一个 Logical Run 可跨人工等待、暂停、阻塞、模型切换继续；
- Provider / Model 修改生成 Snapshot Revision，仅影响当前 Run；
- READY / RUNNING / WAITING_HUMAN / PAUSED / BLOCKED / COMPLETED / STOPPED / FAILED 语义稳定；
- 运行前能够验证 Provider / Model 当前实际可用。

### Phase C — 正式 Built-in 资产与 Invocation

- #81：12 个正式 Built-in Role + 历史角色迁移；
- #82：四套正式 Built-in Workflow + 历史模板迁移 + Built-in Provider/Model Override；
- #83：Skill / Chat Invocation 接入统一 Logical Run Runtime。

正式四模板：

1. 建设：需求分析 → 方案设计 → 开发 → 独立审核 → 独立测试 → 人工验收 → 收口；
2. 优化：目标确认 → 执行 → 评估 → 收口；
3. 诊断：缺陷诊断 → 修复 → 审核 → 回归验证 → 收口；
4. 探索：探索统筹 → 专家研究 Fan-out → 综合分析 → 结论评估。

探索轮次已锁定：**总研究轮次最多 3 轮，包含首次 BROAD；自动 TARGETED 补充最多 2 轮。** 若使用 #73 的回退额度映射，则最多允许 2 次 `NEEDS_RESEARCH -> orchestrate` 自动回退。

历史 `default-workflow` / `dev-workflow-2-0` 迁为 Custom Workflow；`dispatcher` 迁为 Custom Role。

Draft PR #70 已关闭且未合并；`feat/multi-perspective-exploration` 仅作为 #81/#82 的实现素材，不得整包合入 main。

### Phase D — 产品呈现与 UI

- #75 负责正式信息架构和交互定稿；
- 当前模板库 + 画布编辑器可复用，但需要适配 Outcome、Completion、Snapshot、Human Decision、Logical Run Timeline、Guidance 和成果/证据视图；
- 当前 Skill / Chat 入口不因 UI 重构被废弃；未来插件“使用/运行”只能作为同一 Runtime 的 Invocation Adapter。

v0.1 是否要求完整 UI 重构进入首发，由 #75 拆分后按“发布必需 / 可后置”划界；底层契约不能等待 UI 决策才实施。

## 4. v0.1 发布门槛

只有以下条件同时满足，四套正式模板才可作为 Built-in 发布：

1. #77/#72/#73/#78 的契约和兼容迁移完成；
2. Logical Run、Snapshot Revision、持久化、Human Decision、Pause/Resume、Preflight 可真实工作；
3. 12 Roles 与四模板符合最终规格；
4. 旧 Built-in 资产安全迁为 Custom，不丢用户引用和历史；
5. Skill/Chat 能创建、恢复同一个 Logical Run；
6. `npm run validate`、相关包测试和回归测试全绿；
7. 开发模式验证不能作为发布证据；必须按 #53 切产品模式、重启 DSH、完成真实 E2E；
8. 四模板关键正常/回退/人工/不足路径均有 E2E 证据；
9. 产品文档、Roadmap、CONTEXT/历史文档的当前/目标边界清晰。

## 5. v0.2 — Product Interaction & Governance

在 v0.1 Runtime/资产模型稳定后，集中完成用户体验和治理能力，而不是继续扩大底层状态机。

候选主题：

- #75 拆出的模板库、编辑器、Run Dashboard / Timeline / 成果与证据 UI；
- Context Pointer：节点按需引用需求、设计、规则、Skill 和历史 Record；
- Responsibility / Permission / Evidence Contract；
- S / M / L 任务准入与风险分级；
- 多格式 Artifact 的更完整可视化和人工决策呈现；
- Provider/Model 推荐替代方案，但仍不默认静默 Failover。

## 6. v0.3 — 同一需求的多角色并行协作

在 Fan-out“同类子任务并行”之外，支持同一需求里的不同责任轨并行：

- 开发轨 / 测试轨 / Review 轨；
- 明确的交接版本和 Gate；
- 主控同步点；
- 失败只回到真正根因来源；
- 证据链仍通过 Formal Records 管理。

重点是职责协作，不是单纯提高并发数。

## 7. v0.4 — 多 Coding Agent 执行器

在 Workflow/Role/Run 契约稳定后，再把执行器从 DSH 扩展到 Codex、Claude Code 等：

- Workflow 语义不为单一执行器复制；
- Adapter 负责执行器差异；
- 权限、上下文、证据和生命周期由 Workflow Manager 保持统一；
- 新执行器必须通过同一行为/契约回归。

## 8. v0.5+ — 专业 Profile、动态规划与生态

候选：

- 专业领域 Profile / Role Packs；
- 更强的动态规划与任务分解；
- 跨项目/跨仓库协作；
- ACP 或其他协议适配；
- 独立分发、注册表、模板生态。

## 9. 独立分发：明确后置

早期 P2 Epic #6 已关闭为 superseded。

以下 Issue 保留，但不属于当前 v0.1 frontier：

- #21：独立仓库 + GitHub 分发；
- #45：包自包含边界；
- #46：构建产物策略；
- #47：独立分发下的仓库根解析；
- #48：仓库归属 / monorepo 去留。

它们必须在 #76 正式体系稳定后重新基于届时 main 取证；不得直接使用 2026-08-23 的目录与打包假设施工。

## 10. 外部兼容性

#35 是 Minke / DSH 版本兼容跟踪项，独立于正式 Workflow Runtime 设计。

- 若正式发布声明支持 Minke，则未解决的宿主兼容问题进入发布门槛；
- 若 v0.1 首发以原生 DSH 为支持宿主，则 #35 不阻塞 #76。

## 11. 已完成能力如何看待

历史已完成 Issue/PR 是“当前实现基线和回归资产”，不因为产品体系升级而删除历史：

- 工作区隔离、分支/HEAD 验证等可靠性能力继续保留；
- fanOut、多 run、持久化继续作为底层能力演进；
- 旧 `success/failure`、`AWAITING_HUMAN_*`、`FAILED_MAX_ROUNDS` 等属于兼容层，不再作为新设计目标；
- 旧 Built-in Workflow/Role 保留为迁移对象，不继续定义正式标准。

## 12. 版本开发与发布节奏

长期遵循 `AGENTS.md`：

```text
版本内开发
→ 开发模式快速迭代
→ 契约/测试/人工验收
→ 准备发布
→ 切产品模式
→ 重建正式产物
→ 完整重启 DSH
→ 真实 E2E
→ PR / Review / Merge / Tag / Release
```

产品模式验收失败必须回开发模式修复，再重新进行完整产品模式验收。

## 13. 当前优先级

```text
P0  #71/#77/#72/#73/#78   Blueprint + 结果/证据契约
 ↓
P0  #79/#80/#74/#53       Logical Run + Snapshot + 可恢复运行
 ↓
P0  #81/#82/#83           12 Roles + 四模板 + Skill Invocation
 ↓
P1  #75                    正式 UI/交互实施拆分
 ↓
P2  Context / Responsibility / 多角色协作
 ↓
P3  多执行器
 ↓
Later #21/#45-#48          独立分发
```

任何新 Issue 如果改变上述依赖，必须先更新本 Roadmap 或 #76，避免并行 Agent 按不同版本规划施工。
