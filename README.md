# workflow-manager

面向复杂软件研发与通用知识工作的 **AI 协作工作流系统**。

Workflow Manager 不只是“按顺序调用 Agent”。它希望把 Workflow、Role、模型、人工决策、运行快照、正式成果和验证证据组织成一个可配置、可运行、可干预、可恢复、可追溯的协作系统。

当前以 DeepSeek Harness（DSH）作为首个运行环境。Codex、Claude Code 等 Coding Agent 属于后续执行器扩展，不反向定义 Workflow Manager 的产品模型。

## 当前状态

项目处于 **v0.1 正式工作流体系收敛阶段**。

必须区分两件事：

- **当前 main 已实现基线**：现有 Blueprint/Skill/VWF Runtime 能力；
- **v0.1 目标规格**：正在按 #76–#83 实施的正式 Workflow/Run/Role 模型。

目标规格不是“main 已经具备”的能力清单。实现、Review 和验收必须同时核对实际代码与目标规格。

权威目标规格：[`docs/design/workflow-manager-v0.1-final-product-spec.md`](./docs/design/workflow-manager-v0.1-final-product-spec.md)  
完整版本规划：[`roadmap.md`](./roadmap.md)

## 当前 main 已具备

截至 2026-08-30，已经形成的可用底座包括：

- `templates/*.json` Blueprint 作为具体 Workflow 的唯一事实源；
- 单一校验/生成链和行为回归；
- 可视化模板库、画布编辑器和配置面板；
- 保存 Blueprint 后生成/更新可运行 Skill；
- Built-in / Custom Role Library 基础能力（#58 / PR #61）；
- Git worktree 工作隔离与验证分支/HEAD 留痕；
- 测试、审核、人工门禁与失败回路；
- 受限 Fan-out 与结果聚合（#18 / PR #38）；
- 多 run 并行、同 taskId 互斥、人工门禁排队（#19 / PR #41、#44）；
- legacy engine-run 运行历史跨 DSH 重启持久化（#40 / PR #50）；
- DSH 静态组合包产品形态；
- 版本内开发模式 / 发布前产品模式的长期双轨规则。

这些能力仍包含早期契约，例如 `success/failure` 二态业务路由、`AWAITING_HUMAN_*` / `FAILED_MAX_ROUNDS` 等字符串状态，以及旧 Built-in Workflow/Role 集合。它们是当前兼容基线，不是 v0.1 新设计目标。

## v0.1 正式目标

### 四套正式 Built-in Workflow

1. **建设 · 完整功能开发**  
   需求分析 → 方案设计 → 开发 → 独立审核 → 独立测试 → 人工验收 → 收口
2. **优化 · 快速迭代**  
   目标确认 → 执行 → 评估 → 收口
3. **诊断 · 缺陷修复**  
   缺陷诊断 → 修复 → 审核 → 回归验证 → 收口
4. **探索 · 多视角探索**  
   探索统筹 → 专家研究 Fan-out → 综合分析 → 结论评估

探索模板总研究轮次最多 **3 轮（包含首次 BROAD）**；自动 TARGETED 补充最多 2 轮。

历史 `default-workflow` 和 `dev-workflow-2-0` 将迁移为 Custom Workflow，不继续作为系统正式标准。

### 12 个正式 Built-in Role

通用能力：

- `requirements` — 需求分析
- `designer` — 方案设计
- `dev` — 开发
- `review` — 审核
- `test` — 测试
- `evaluator` — 评估
- `accept` — 验收助手
- `closeout` — 收口

专业能力：

- `diagnose` — 缺陷诊断
- `orchestrator` — 探索统筹
- `researcher` — 专家研究
- `synthesizer` — 综合分析

旧 `dispatcher` 迁移为 Custom Role。

### 统一 Runtime/契约

v0.1 的核心升级包括：

- Business Outcome Routing：合法业务结果不再伪装成 failure；
- Completion Mapping：终态业务原因来自节点结构化结果；
- Formal Records / Revision / Provenance；
- Logical Run / Execution Segment；
- 固定 Lifecycle：`READY / RUNNING / WAITING_HUMAN / PAUSED / BLOCKED / COMPLETED / STOPPED / FAILED`；
- Run Snapshot Revision；v0.1 运行中只允许修改 Provider / Model；
- Human Decision；
- Pause / Interrupt / Run Guidance / Resume；
- `maxRounds` 统一为自动回退额度，回退路径通过 `countRound` 决定是否消耗；
- Static Validation + Provider/Model Preflight Probe；
- Skill/Chat/未来插件入口共享同一 Logical Run Runtime。

## 单一事实源架构

当前实现仍遵循：

```text
templates/<id>.json
   │
   │  生成 / 校验
   ▼
.generated/<id>/
   ├── script.mjs
   ├── vwf-dsl.json
   ├── SKILL.md
   └── meta.json
   │
   ├─ VWF：可视化编辑 / 保存 / 运行观测
   └─ DSH：生成 Skill 执行
```

约束：

- 人工只修改 Blueprint 或对应权威规则文件；
- `.generated/` 是生成物，不作为人工修改源；
- 同一 Blueprint 不允许多套业务解释；
- Blueprint / Contract 变更必须有行为回归保护；
- v0.1 Runtime 升级必须向后兼容现有 Custom Workflow，不能要求所有用户资产一次性迁移后才能运行。

## 当前实施主线

```text
#71 全局原则
  ↓
#77 Outcome Routing / Completion
#72 Human Decision
#73 自动回退额度
#78 Formal Records / Provenance
  ↓
#79 Logical Run / Snapshot / Lifecycle
#80 Pause / Guidance / Resume
#74 Preflight Probe
  ↓
#81 12 Roles
#82 四正式 Built-in Workflows
#83 Skill/Chat Invocation
  ↓
#75 UI/交互实施拆分
```

实施总览：#76。

Draft PR #70 已关闭且未合并。`feat/multi-perspective-exploration` 分支只作为 #81/#82 的素材库，不得整包直接合入 main。

## 独立分发后置

早期 P2 Epic #6 已关闭为 superseded。以下课题继续保留，但不属于当前 v0.1 frontier：

- #21 独立仓库 + GitHub 分发；
- #45–#48 独立分发相关决策。

这些 Issue 必须在正式 Workflow/Runtime/资产边界稳定后重新基于届时 main 取证，不能直接按旧目录和打包假设实施。

## 外部兼容性

#35 跟踪 Minke / DSH 版本兼容问题。它与 Workflow Runtime 产品设计分离：只有当某个版本明确把 Minke 列为支持宿主时，才进入该版本发布门槛。

## 常用命令

```bash
npm run generate   # templates/*.json → .generated/<id>/
npm run validate   # 蓝图校验 + 测试 + 重生成一致性检查
npm test           # 引擎层行为与契约测试
```

发布前还必须遵循 `AGENTS.md` 的开发模式 / 产品模式双轨：开发态验证不是发布证据，正式发布必须重建产物、完整重启 DSH 并执行真实 E2E。

## 目录

| 路径 | 说明 |
|---|---|
| `templates/` | 当前具体 Workflow Blueprint，唯一事实源 |
| `.generated/` | 生成物，禁止手改 |
| `scripts/` | 编译、校验、行为测试与生成流程 |
| `packages/dsh-visual-workflow/` | 可视化编辑与运行观测入口 |
| `dsh/` | DSH 侧角色与 Skill 真源 |
| `docs/design/` | 当前/目标 Contract 与设计文档 |
| `docs/research/` | 调研结论 |
| `specs/` | 已形成的规格 / OpenSpec |
| `wayfinder/` | 决策地图与历史决策 |
| `AGENTS.md` | 项目共同硬规则 |
| `CONTEXT.md` | 当前实现领域术语；目标语义以 v0.1 最终规格为准 |
| `roadmap.md` | 产品 / 架构路线图 |

## 文档权威性

不同类型文档承担不同职责：

1. `AGENTS.md`：项目共同硬规则；
2. `docs/design/workflow-manager-v0.1-final-product-spec.md`：v0.1 正式产品目标规格；
3. `CONTEXT.md`：当前实现术语与兼容语义；
4. `templates/`：当前 main 中具体 Workflow 的唯一事实源；
5. `roadmap.md`：版本顺序和实施依赖；
6. GitHub Issue / PR：施工范围、迁移和验收状态；
7. `main`：实际已经进入产品基线的实现。

当目标规格与当前实现不同，这是正常的“迁移中状态”；Agent 必须明确自己是在维护兼容基线还是实施 v0.1 目标，不能把两者静默混合。

过时设计应显式标记 Historical / Superseded / Deferred，而不是继续作为新施工依据。

## 路线图

```text
v0.1  Formal Workflow Foundation
      Blueprint / Outcome / Formal Records / Logical Run / Snapshot / 12 Roles / 四模板
  ↓
v0.2  Product Interaction & Governance
      UI / Context / Responsibility / Permission / Evidence / S-M-L
  ↓
v0.3  同一需求多角色协作
  ↓
v0.4  多 Coding Agent 执行器
  ↓
v0.5+ 专业 Profile / 动态规划 / 协议与生态
  ↓
Later  独立分发（#21 / #45–#48 重新评估）
```

详见 [`roadmap.md`](./roadmap.md)。
