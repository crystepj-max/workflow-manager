# Workflow Manager Roadmap

> 状态：2026-08-30 并行开发计划同步版  
> 当前主目标：先建立可 Dogfood 的“建设 · 完整功能开发”双执行 Profile，再用 DSH / Cursor / Codex 并行完成 Workflow Manager v0.1 正式底座。

## 1. 北极星

Workflow Manager 面向复杂软件研发与通用知识工作，目标不是“按顺序调用多个 Agent”，而是建立一套：

- 可配置：Workflow / Role / Provider / Model / Outcome / Gate 可声明；
- 可运行：Blueprint 经统一校验、生成与 Runtime 执行；
- 可干预：Human Decision、Pause、Interrupt、Guidance；
- 可恢复：BLOCKED、Snapshot Revision、Resume；
- 可追溯：Formal Record、Revision、Provenance、证据有效性；
- 可隔离：Logical Run 拥有独立 Workspace / Resource / Integration 上下文；
- 可扩展：Built-in 给出正式标准，Custom Workflow/Role 保留开放能力。

DSH 是首个正式运行环境。v0.1 同时提供 Codex/Cursor 的**项目 Dogfood External Profile**，使非 DSH Agent 能执行同一建设工作流；这不等于提前交付 v0.4 的通用多执行器产品能力。

## 2. 三条基线必须分开

### 2.1 当前 main 已实现基线

截至 2026-08-30，仓库已经具备：

- Blueprint → 统一校验/生成 → Skill 的单一事实源链；
- 可视化模板库、画布编辑器和配置面板；
- Built-in / Custom Role Library 基础能力（#58 / PR #61）；
- 受限 Fan-out 与聚合（#18 / PR #38）；
- Git worktree 工作隔离、验证分支/HEAD 留痕（#14/#23/#27）；
- 多 run 并行、同 taskId 互斥和人工门禁排队（#19 / PR #41、#44）；
- legacy engine-run 运行记录跨进程持久化（#40 / PR #50）；
- 开发/产品双轨长期规则；
- 当前 Skill / Chat 正式执行入口。

这些能力仍运行在早期契约上：`success/failure` 二态路由、旧 run 状态字符串、旧 Built-in 模板/角色集合等。

### 2.2 v0.1 正式产品目标

权威目标规格：`docs/design/workflow-manager-v0.1-final-product-spec.md`。

v0.1 正式收敛为：

- 四套 Built-in Workflow：建设 / 优化 / 诊断 / 探索；
- 12 个 Built-in Role；
- Business Outcome Routing + Completion Mapping；
- Formal Records / Revision / Provenance；
- Workspace / Resource / Integration Isolation；
- Logical Run / Execution Segment / 固定 Lifecycle；
- Run Snapshot Revision（v0.1 运行中只允许 Provider / Model）；
- Human Decision；
- Pause / Interrupt / Guidance / Resume；
- 自动回退额度；
- Static Validation + Preflight Probe；
- Skill/Chat/未来插件入口共享同一 Logical Run Runtime。

### 2.3 v0.1 Dogfood Bootstrap

为了让项目本身尽早使用新“建设”工作流开发后续 Issue，#102–#105 允许在完整 Runtime 尚未完成时先交付：

```text
#103 Construction Portable Contract
          |
     +----+----+
     |         |
     v         v
#104 External  #105 DSH-native
Codex/Cursor   Bootstrap
```

约束：

- 只有一份建设业务语义；
- Bootstrap 缺失能力必须显式 shim/manual handoff；
- worktree/branch/verified HEAD 从第一天就必须执行；
- #105 随正式 Runtime 落地删除 shim，最终成为 #82 的建设 Built-in；
- #104 是 repo-local Dogfood Runbook，不是 v0.4 Executor SDK。

详细调度：`docs/design/v0.1-parallel-development-plan.md`。

## 3. v0.1 — Formal Workflow Foundation

实施总览：#76。

### Bootstrap — 建设工作流先行

- #102：建设双执行 Profile 总 Epic；
- #103：Portable Contract，Cursor 优先；
- #104：Codex/Cursor External Profile，Cursor 主责；
- #105：DSH-native Bootstrap / Formal Convergence，DSH 主责。

Dogfood 首批候选：Cursor→#81、Codex→#73、DSH→#53。

### Phase A — Blueprint、结果与证明契约

- #71：全局工作流设计原则——已完成（PR #85）；
- #77：Business Outcome Routing + Completion Mapping；分析树 #86–#92；
- #72：Human Decision；分析树 #94–#101；
- #73：自动回退额度 / `countRound`；
- #78：Formal Records / Revision / Provenance；
- #69：多格式正式 Artifact，在 #78 模型上接入。

当前约束：#77 的 #86、#72 的 #94 未毕业前，不跳过决策直接做全面实现。

阶段出口：

- 合法业务结果不再伪装成 failure；
- Node Result 不携带 `next_node`；
- Proof 能绑定具体 Record Revision；
- Human Decision 与人工验收在业务身份上解耦，但共享受控等待/恢复能力按最终决策实现；
- 回退额度由业务路径显式声明。

### Phase B — Workspace + Logical Run Runtime

顺序核心：

```text
#78 Provenance
   ↓
#93 Workspace / Resource / Integration Isolation
   ↓
#79 Logical Run / Lifecycle / Snapshot
   ↓
#80 Guidance / Resume
#74 Preflight
```

任务：

- #93：Workspace Provider/Mode、worktree/sandbox、worker scratch、资源隔离/锁、Integration Checkpoint、cleanup；
- #79：Logical Run / Execution Segment / Lifecycle / Snapshot Revision；**Blocked by #93 稳定数据契约**；
- #80：Pause / Interrupt / Run Guidance / Resume；
- #74：Preflight Probe；
- #40 已完成 persistence 作为 #79 的演进基础，不重新打开；
- #53：开发模式 / 产品模式双轨入口和最终发布闸门。

阶段出口：

- 多个 Logical Run 同仓并行时状态、配置、文件、运行资源、最终集成互不静默干扰；
- 一个 Logical Run 可跨人工等待、暂停、阻塞、模型切换继续；
- Provider / Model 修改生成 Snapshot Revision，仅影响当前 Run；
- READY / RUNNING / WAITING_HUMAN / PAUSED / BLOCKED / COMPLETED / STOPPED / FAILED 语义稳定；
- Preflight 能真实验证当前 Provider / Model。

### Phase C — 正式 Built-in 资产与 Invocation

- #81：12 个正式 Built-in Role + 历史角色迁移；
- #82：四套正式 Built-in Workflow + 历史模板迁移 + Built-in Provider/Model Override；
- #83：Skill / Chat Invocation 接入统一 Logical Run Runtime。

正式四模板：

1. 建设：需求分析 → 方案设计 → 开发 → 独立审核 → 独立测试 → 人工验收 → 收口；
2. 优化：目标确认 → 执行 → 评估 → 收口；
3. 诊断：缺陷诊断 → 修复 → 审核 → 回归验证 → 收口；
4. 探索：探索统筹 → 专家研究 Fan-out → 综合分析 → 结论评估。

建设模板第一优先，必须消费 #102/#103/#105，不从零重新实现。

Workspace 默认：

- 建设：`ISOLATED_WRITE`；
- 优化：Git/file 修改 `ISOLATED_WRITE`，非 Git `SANDBOX`；
- 诊断：从诊断开始 `ISOLATED_WRITE`；
- 探索：`ISOLATED_READ` + shared frozen source + per-worker scratch。

探索总研究轮次最多 3 轮（含首次 BROAD）；最多 2 次自动 `NEEDS_RESEARCH -> orchestrate`。

历史 `default-workflow` / `dev-workflow-2-0` 迁为 Custom Workflow；`dispatcher` 迁为 Custom Role。

Draft PR #70 已关闭且未合并；仅作为 #81/#82 探索素材，不得 reopen/rebase 或整包 cherry-pick。

### Phase D — 产品呈现与 UI

- #75 负责正式信息架构和交互定稿；
- 模板库 + 画布编辑器复用，但适配 Outcome、Completion、Snapshot、Workspace、Human Decision、Logical Run Timeline、Guidance、成果/证据；
- 当前 Skill / Chat 入口不因 UI 重构被废弃；
- 插件未来入口只能进入同一 Invocation/Runtime。

v0.1 是否包含完整 UI 重构，由 #75 拆分为“发布必需 / 可后置”；底层契约不等待 UI 才施工。

## 4. DSH / Cursor / Codex 当前并行策略

具体每个 Issue 排班见 `docs/design/v0.1-parallel-development-plan.md`。当前最高层队列：

```text
Codex  : #77/#86-#92 -> #77 implementation -> #73 -> #78 -> #93 core
DSH    : #72/#94-#101 -> #105 -> #53 dogfood -> #72 runtime -> #93 integration -> #79 -> #80 -> #74 -> #83
Cursor : #103 -> #104 -> #81 dogfood -> #69 -> #82 construction/assets -> #75 UI
```

活动 Issue 标签：

- `generic-agent`：优先 Codex/Cursor；
- `dsh-cordis`：优先 DSH；
- 两者都有：External core + DSH integration/E2E，使用独立 Run/worktree 合流。

同一 Issue 同一时刻只有一个主责 Agent。

## 5. v0.1 发布门槛

四套正式模板作为 Built-in 发布前至少满足：

1. #77/#72/#73/#78 契约和兼容迁移完成；
2. #93 Workspace/Resource/Integration Isolation 完成；
3. #79/#80/#74 Runtime 可真实工作；
4. 12 Roles 与四模板符合最终规格；
5. 建设 Bootstrap 已收敛，不存在 DSH/External 两份业务语义；
6. 旧 Built-in 资产安全迁为 Custom，不丢用户引用和历史；
7. Skill/Chat 能创建、恢复同一个 Logical Run；
8. `npm run validate`、包测试、行为/迁移/并行回归全绿；
9. 开发模式/External Dogfood 不能作为发布证据；必须按 #53 切产品模式、重启 DSH、真实 E2E；
10. 四模板关键正常/回退/人工/不足路径有 E2E；
11. 多 Run 同仓并行、Integration Checkpoint、Proof 版本绑定有 E2E；
12. Current/Target 文档边界清晰。

## 6. v0.2 — Product Interaction & Governance

在 v0.1 Runtime/资产稳定后，集中完善：

- #75 拆出的模板库、编辑器、Run Dashboard / Timeline / 成果与证据 UI；
- Context Pointer；
- Responsibility / Permission / Evidence Contract；
- S / M / L 准入与风险分级；
- 多格式 Artifact 可视化；
- Provider/Model 推荐替代方案，但不静默 Failover。

## 7. v0.3 — 同一需求多角色并行协作

在 Fan-out 同类子任务并行之外，支持：

- 开发轨 / 测试轨 / Review 轨；
- 明确交接版本和 Gate；
- 主控同步点；
- 失败返回真正根因来源；
- 证据链由 Formal Records 管理。

## 8. v0.4 — 产品化多 Coding Agent 执行器

v0.1 #104 只解决本仓库 Dogfood。v0.4 再正式产品化 Codex/Claude Code/其他执行器：

- Workflow 语义不为执行器复制；
- Adapter 负责执行器差异；
- 权限、上下文、证据、生命周期统一；
- 新执行器通过同一契约回归。

## 9. v0.5+ — 专业 Profile、动态规划与生态

候选：专业领域 Role Packs、更强动态规划、跨项目/跨仓库、ACP/其他协议、独立分发和模板生态。

## 10. 独立分发：明确后置

#21 / #45–#48 全部 Deferred。必须等 #76 正式体系稳定后重新基于届时 main 取证，不使用 2026-08-23 的旧打包/目录假设施工。

## 11. 外部兼容性

#35 独立跟踪 Minke / DSH 兼容。若 v0.1 明确支持 Minke，则进入发布门槛；否则不阻塞 #76。

## 12. 历史能力如何看待

已完成 Issue/PR 是当前实现基线和回归资产：

- #14 worktree、#19 multi-run、#23/#27 verified HEAD 必须进入 #93/#78 回归；
- #18 Fan-out、#40 persistence、#58 Role Library 在原能力上演进；
- `success/failure`、`AWAITING_HUMAN_*`、`FAILED_MAX_ROUNDS` 属兼容层；
- #3/#6/#64–#68 是 Historical/Superseded，不再作为施工入口。

## 13. 版本开发与发布节奏

长期遵循 `AGENTS.md`：

```text
版本内开发
→ 开发模式 / External Profile 快速迭代
→ 契约/测试/人工验收
→ 准备发布
→ 切 DSH 产品模式
→ 重建正式产物
→ 完整重启 DSH
→ 真实 E2E
→ PR / Review / Merge / Tag / Release
```

产品模式验收失败必须回开发模式修复，再重新执行完整产品模式验收。

## 14. 当前优先级

```text
P0  #103 -> #104/#105        建设工作流先 Dogfood
 ||
P0  #77/#86-#92             Outcome 决策/实现
P0  #72/#94-#101            Human Decision 决策/实现
 ↓
P0  #73/#78/#69             rollback + Records/Artifact
 ↓
P0  #93 -> #79              Workspace -> Logical Run
 ↓
P0  #80/#74/#53             可恢复运行 + Probe + 发布闸门
 ↓
P0  #81/#82/#83             Roles + 四模板 + Invocation
 ↓
P1  #75                     UI/交互
 ↓
Later #21/#45-#48           独立分发
```

任何新 Issue 如果改变上述依赖，必须先更新本 Roadmap、#76 或 `v0.1-parallel-development-plan.md`，避免并行 Agent 按不同版本规划施工。
