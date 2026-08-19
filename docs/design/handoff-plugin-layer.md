# 插件层交接：T-IMP-06/07 实现说明（创造模式会话用）

> 本文档供**新会话（创造模式 / cordis preset）**实施 vwf 插件改造时使用。
> 前置：引擎层已完成并提交（`d0060ca`）——生成器/校验器/断言/契约全部就绪，**插件层只剩 host.js 接入**。
> 决策依据：wayfinder 地图 T-02/T-03/T-04/T-06（`wayfinder/MAP.md`）+ 契约 `docs/design/blueprint-schema.md`。

## 0. 前置资产（已就绪，直接使用）

| 资产 | 位置 | 说明 |
|---|---|---|
| 生成器（内置） | `scripts/generate.mjs` | `npm run generate` → `.generated/<id>/{script.mjs, vwf-dsl.json, SKILL.md, meta.json}` |
| 生成器（用户 skill） | `scripts/generate.mjs user <蓝图json> <skillDir>` | **已实现**：校验 + 生成自包含三件套（SKILL.md/script.mjs/meta.json）到 `<skillDir>/<id>/` |
| 校验器 | `scripts/validate-blueprint.mjs` | 规则全集含**异源硬规则 7**（T-06 已实现，返回 `{ok, errors, warnings}`） |
| 内置蓝图 | `templates/dev-workflow-2-0.json` | 7 节点/12 边，bindings dev=deepseek-official/v4-pro、review=kimi-coding/k3（真异源） |
| 等价断言 | `scripts/equivalence.mjs` | 10 项断言（CI 用） |
| 测试 | `scripts/test/` | 32 测试全绿（含异源 T1-T5、generateUserSkill） |

## 1. T-IMP-06 · host.js 双根加载 + 用户模板落盘闭环（FR-2/FR-3，AC-2/AC-3）

### 1.1 现状代码地图（`packages/dsh-visual-workflow/src/host.js`）

| 位置 | 现状 | 改造目标 |
|---|---|---|
| L29-74 | `TEMPLATES` 硬编码内置模板 | **废除**，改目录加载 |
| L421-431 | `userWorkflows` 内存 Map；`findWorkflow`/`listWorkflows` | 改用户目录扫描 |
| L442-451 | `vwf.workflows.save`（仅内存 set）/ `remove`（仅 delete） | 落盘 + 撞名拒绝 + skill 同步 |
| L453 | `vwf.validate` → `validateDsl` | 叠加异源校验（T-IMP-07） |
| L526-595 | workflowEngine 接线 / `wf_run` 工具 | 不动（仅确认双根对 `findWorkflow` 生效） |

### 1.2 目标行为（T-03 决策）

- **双根加载**：内置 = `.generated/<id>/vwf-dsl.json`（生成物，仓库根；CI 先 `npm run generate`）；用户 = `~/.dsh/visual-workflow/templates/<id>.json`（蓝图 JSON，宿主数据根 `~/.dsh` 下新建 `visual-workflow/templates/`）。
- **`list`**：合并双根，`builtin: true`（.generated/）与 `false`（用户目录）区分；按 id 字母序；用户条目的 `dsl` 字段 = 蓝图→vwf DSL 投影（见 1.3）。
- **`save`**：`{ id, dsl }` → ① 蓝图级校验（结构 + **异源**）；② 判定：目标 id 已在内置 → 拒绝（「内置模板只读」）；目标 id 已存在用户目录且请求携带的「当前编辑 id」≠ 目标 id → 拒绝（「已存在，请改名」，T-03 撞名语义）；否则 ③ sanitize 后写 `<id>.json` 到用户目录 ④ **spawn 生成器 user 子命令**同步生成 skill 到 `~/.dsh/skills/<id>/`（save 即闭环）。
- **`remove`**：仅用户模板可删（删蓝图 + 同步删 `~/.dsh/skills/<id>/`）；内置拒绝。
- **`findWorkflow`**：内置优先（沿用），用户目录兜底。

### 1.3 蓝图 → vwf DSL 投影（host 内联，~20 行）

host 是 Cordis 动态插件（plain JS、**无 import**，host.js:18-19），不能复用 `scripts/generate.mjs` 的 ESM 导出。两个方案：
- **A（推荐）**：host 内联 `projectToVwf`（映射：`id` / `name=displayName` / `description` / `entry` / `control.maxRounds`；节点注入 `model=bindings.models[nodeId]`；保留 `output`/`manualCheck`；剔除增强字段 `onMaxRounds/heteroCheck/verifyBranch`）——投影逻辑与 `scripts/generate.mjs` 的 `projectToVwf` 保持一致（已在引擎层测试覆盖，host 内联版按同样行为实现）。
- B：save 时把 `vwf-dsl.json` 也写进用户目录（`~/.dsh/visual-workflow/generated/<id>/`）——多一份生成物，不推荐（双份来源）。

### 1.4 spawn 生成器（save 的 skill 同步）

host 侧经 `ctx.get('fs')`/子进程能力调用：

```bash
node <repo>/scripts/generate.mjs user ~/.dsh/visual-workflow/templates/<id>.json ~/.dsh/skills
```

- 生成器内部会先跑校验（含异源），失败 exit 1 并输出错误——save 应捕获并回传错误。
- **实现前用 `cordis_inspect_query` 确认** host 可用的进程/命令服务（fs 服务的能力边界），不要凭名字猜 API（cordis-plugin-development 纪律）。
- `~/.dsh/skills/` 是用户级 skill 发现根（R-04 已核实）——新会话即可通过触发词调用（`displayName`/`id`）。

### 1.5 验证路径（创造模式会话内）

1. `npm run generate`（先产出 `.generated/`）→ `cordis_run` 激活插件。
2. RPC 冒烟：`vwf.workflows.list`（应见内置 `dev-workflow-2-0`，builtin=true）。
3. `vwf.workflows.save`：新蓝图（无 dev/review 的简单模板）→ list 出现（builtin=false）；重启宿主（或重新激活插件）后 list 仍在（**AC-3 落盘**）；`~/.dsh/skills/<id>/SKILL.md` 存在（save 即闭环）。
4. 撞名：save 同名内置 → 拒绝；同名用户（另存为）→ 拒绝提示改名。
5. `remove` 用户模板 → 蓝图与 skill 同步消失；remove 内置 → 拒绝。
6. 现有 `packages/dsh-visual-workflow/tests/`（host.test.mjs/client.smoke.mjs）回归——save/list/remove RPC 链路的既有测试需按新语义更新（撞名/内置只读用例）。

## 2. T-IMP-07 · 异源校验接入（FR-8，AC-8；v2 生效但 v1 实现）

### 2.1 引擎侧（已完成 ✅）

`scripts/validate-blueprint.mjs` 规则 7（T-06 契约）：
- 含 dev+review 节点的蓝图一律校验（全局强制）；无则跳过（T5）。
- dev/review 任一缺 `bindings.models` → 拒（「无法证明异源，请显式配置」）（T4）。
- 完全同模型（provider+model 相同）→ 拒（消息含实际值与修复指引）（T1）。
- 同 provider 不同 model → 通过 + `warnings`（弱异源）（T2）。
- 不同 provider → 通过无警告（T3）。
- 测试：`validate-blueprint.test.mjs` T1-T5 已绿（31 测试含）。

### 2.2 host 接入（本次会话唯一剩余）

- `vwf.workflows.save`：保存前除 `validateDsl` 外，叠加异源检查（**内联轻量实现** ~10 行：读 `dsl.nodes` 是否有 dev/review → 比较 `bindings.models.dev/review`，返回 `{ok:false, errors:[{at:'bindings.models', message:...}]}` 沿用 errors 结构）。host 无法 import 引擎校验器，异源判定逻辑简单，内联即可（与引擎侧行为一致，用例以引擎测试为参照）。
- `vwf.validate`（L453）：同样叠加（过渡期双保险，规格 FR-8）。
- **T6 用例**（update 路径同 save）在 host 层补测：save 同蓝图两次（第二次=更新自身）——异源违规蓝图在两次调用均被拒。

## 3. 创造模式工作流建议

1. 本会话选**创造模式（cordis preset）**——具备 cordis_inspect/define/run/stop/undefine 工具与 `cordis-plugin-development` skill（自动挂载）。
2. 按 skill 纪律：**先 `cordis_inspect_list` + `cordis_inspect_query` 确认** host 的 fs/子进程服务与 `harness.handle` RPC 注册方式，再动手；不凭名字猜 API。
3. 改造用 `cordis_define` 定义新版本 → `cordis_run` 激活验证 → 失败用 `cordis_inspect_self` 看诊断。
4. host.js 是 P0 动态原型（`apply(ctx)` 形态），改造保持 plain JS、无 import；注意 `ctx.get('fs')` 判空（host.js:24-27 现状）。
5. 完成后把最终 host.js 落回仓库（生成物不受 NFR-1 约束——插件是源码不是生成物）。

## 4. 验收标准（完成后自检）

- AC-2：vwf 从目录加载模板（`.generated/` + 用户目录），host.js 无硬编码 `TEMPLATES`。
- AC-3：save 落盘后重启宿主仍可 list；remove 同步删文件与 skill。
- AC-8：全同 provider 模板 save 被拒（含「dev/review 同 provider/模型相同」类错误）；推荐异源分配（dev=deepseek-official/v4-pro、review=kimi-coding/k3）save 通过。
- 回归：`npm test`（引擎层 32 测试）+ `npm run validate` 全绿；`packages/dsh-visual-workflow/tests/` 更新后全绿。

## 5. 收口提醒

- 插件层完成后：T-IMP-11（等价验收收口：checklist 勾选 + 旧 mjs 退役）→ 可安排。
- v1 全部完成后建议提交并回归 `npm run validate`（CI 已配置）。
