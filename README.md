# workflow-manager

面向复杂软件研发的 **AI 协作工作流系统**。

Workflow Manager 不只负责“按顺序调用 Agent”。它希望解决更核心的问题：在一个真实软件研发任务里，让正确的角色在正确阶段获得最小且权威的上下文，明确自己的责任与权限，用可验证证据完成交接，并把范围变更、最终验收、合并发布等关键决策保留给人。

当前以 DSH 作为首个运行环境，后续再逐步支持 Codex、Claude Code 等 Coding Agent。跨 Agent 是执行能力，不是项目最高层目标。

## 项目目标

项目长期围绕五类能力演进：

1. **Context Pointer（上下文指针）**：节点按需引用需求、设计、项目规则、角色规则、Skill 与历史证据，而不是复制整份项目知识。
2. **责任与证据契约**：每个角色明确输入、输出、非目标、可修改范围和必须提交的验证证据。
3. **人工授权边界**：局部开发 / 测试 / 审核尽量自主推进；范围变化、高风险实施、最终验收、合并发布等动作由人授权。
4. **多角色协作**：不仅支持多个独立任务并行，还要支持同一需求中的开发轨、测试轨等不同责任角色并行并在 Gate 汇合。
5. **执行器可替换**：协作规则稳定后，同一 Workflow 可以逐步交给不同 Coding Agent 执行。

完整版本规划见 [`roadmap.md`](./roadmap.md)。

## 当前已具备

截至 2026-08-25，项目已经具备第一阶段可用底座：

- Blueprint 作为具体 Workflow 的唯一事实源；
- 单一编译与校验语义；
- runtime harness 行为回归；
- DSH / vwf 双入口统一；
- 可视化模板库与编辑器；
- 保存 Blueprint 后同步生成可运行 Skill；
- 工作分支隔离与验证分支 / HEAD 留痕；
- 测试、审核、人工验收与失败打回；
- 多 run 并行、同 taskId 互斥、人工门禁排队；
- `fanOut` 受限并行子任务与结果聚合；
- DSH 静态组合包基础安装形态；
- 默认工作流与角色自包含分发。

当前下一阶段重点不是继续扩大量执行器或独立分发，而是补齐 **上下文、责任、权限、证据和同需求多角色协作**。

## 协作模型

```text
权威上下文
需求 / 设计 / AGENTS / 决策 / Skill / 历史证据
        │
        ▼
协作契约
责任 / 输入 / 输出 / Evidence / 权限 / Gate / 状态
        │
        ▼
协作执行
开发轨 / 测试轨 / Review / 人工裁决 / 汇合
        │
        ▼
执行器
DSH / Codex / Claude Code / Other Agent
```

核心原则：

> **上下文 → 责任 → 权限 → 证据 → 协作 → 执行器。**

## 单一事实源架构

具体 Workflow 仍以 Blueprint 为唯一事实源：

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
   ├─ vwf：可视化编辑 / 保存 / 运行观测
   └─ DSH：生成 Skill 执行
```

约束：

- 人工只修改 Blueprint 或对应的权威规则文件；
- `.generated/` 永远是生成物，不作为人工修改源；
- 同一 Blueprint 不允许由多套不同业务语义解释；
- Workflow / Contract 变更必须有行为回归保护。

## 当前与下一阶段

| 能力 | 状态 |
|---|---|
| Blueprint / 编译 / 校验 / 行为测试 | ✅ 已完成基线 |
| 可视化编辑与 Skill 闭环 | ✅ 已完成基线 |
| 工作分支隔离 / Review / 人工门禁 | ✅ 已完成基线 |
| 多 run 并行 | ✅ 已完成（#19） |
| fanOut 同类子任务并行 | ✅ 已完成（#18 / PR #38） |
| 运行历史跨进程恢复 | ⚠️ Reality Reconciliation（#40 当前 GitHub 状态仍为 open） |
| 节点级 Context Pointer | ⏳ v0.2 |
| 责任 / 权限 / Evidence 正式契约 | ⏳ v0.2 |
| S / M / L 实施准入 | ⏳ v0.2 |
| 同一需求多角色并行协作 | ⏳ v0.3 |
| Codex / Claude Code 等执行器 | ⏳ v0.4 |
| ACP / 动态规划 / 独立分发 | 后置 |

## 常用命令

```bash
npm run generate   # templates/*.json → .generated/<id>/
npm run validate   # 蓝图校验 + 测试 + 重生成一致性检查
npm test           # 引擎层行为与契约测试
```

## 目录

| 路径 | 说明 |
|---|---|
| `templates/` | 具体 Workflow Blueprint，唯一事实源 |
| `.generated/` | 生成物，禁止手改 |
| `scripts/` | 编译、校验、行为测试与生成流程 |
| `packages/dsh-visual-workflow/` | 可视化编辑与运行观测入口 |
| `dsh/` | DSH 侧角色与 Skill 真源 |
| `docs/design/` | 当前契约与设计文档 |
| `docs/research/` | 调研结论 |
| `specs/` | 已形成的规格 / OpenSpec |
| `wayfinder/` | 决策地图与历史决策 |
| `AGENTS.md` | 项目共同规则 |
| `CONTEXT.md` | 项目统一术语 |
| `roadmap.md` | 产品 / 架构路线图 |

## 文档权威性

当文档、Issue 和实际实现存在冲突时，不允许默默选一个继续施工。

当前约定：

1. `AGENTS.md`：项目共同硬规则；
2. `CONTEXT.md`：统一术语；
3. `docs/design/`：当前 Contract / 设计语义；
4. `templates/`：具体 Workflow 的唯一事实源；
5. `specs/` / `wayfinder/`：需求、设计决策与历史上下文；
6. GitHub Issue / PR：施工与验收状态；
7. `main`：实际已经进入产品基线的实现。

发现冲突时先做 Reality Reconciliation，再继续实现。过时设计应显式标记 Historical / Superseded，而不是继续作为 Agent 上下文。

## 开发指引

1. 新增或修改 Workflow：修改 `templates/` 中 Blueprint → 生成 → `npm run validate` → 用生成 Skill 或 vwf 做行为验证。
2. 修改协作规则：同时检查 Contract、角色、行为测试与文档是否需要同步，不允许只改其中一份解释。
3. 大型需求先完成需求分析和决策收敛；后续 Roadmap 将把 S / M / L 实施准入正式纳入 Workflow。
4. 新增执行器前，优先确认现有协作契约是否已经能够表达该执行器需要承担的责任；不要为了某个 Agent 新复制一套 Workflow。

## 路线图原则

当前资源优先级：

```text
v0.1 可信基线与现实对账
  ↓
v0.2 Context / Responsibility / Authorization / Evidence
  ↓
v0.3 同需求多角色协作
  ↓
v0.4 多 Coding Agent 执行器
  ↓
v0.5+ 专业 Profile / ACP / 动态规划 / 分发
```

详见 [`roadmap.md`](./roadmap.md)。
