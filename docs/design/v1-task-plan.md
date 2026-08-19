# v1 实施任务清单（三要素化，dev-workflow-2.0 dispatch 输入）

> 来源：`docs/工作流统一引擎需求规格.md`（FR/AC）+ wayfinder 地图（`wayfinder/MAP.md`，T-01~T-07 决策）。
> 每项含三要素（任务目标 / 涉及范围 / 验收标准）——可直接作为 dev-workflow-2.0 的 dispatch 输入。
> 分层：**引擎层**（纯 node，普通模式）· **插件层**（Cordis，创造模式会话）· **收口层**。

## v1 任务

### T-IMP-01 根基建（FR-4）· AC-4 · 引擎层
- **目标**：建立根级工程骨架。
- **范围**：根 `package.json`（workspaces → `packages/*`）、根 `README.md`（指向 dsh/ 与 packages/，含工作流开发指引）、根 `.gitignore` 补充（`.generated/`、`.generated.check/`、`*.tmpdir/` 已有）。
- **验收**：`npm install` 在根可用；README 链接有效；git status 不显示 `.generated/`。

### T-IMP-02 蓝图落库（FR-1/AC-1）· 引擎层
- **目标**：dev-workflow-2.0 蓝图成为仓库单一事实源。
- **范围**：`templates/dev-workflow-2-0.json`（自 `.scratch/schema-prototype` GOOD 提升，字段符合 `docs/design/blueprint-schema.md`，含全部增强字段与 output.files）；删除 `workflows/`（归 FR-5，见 T-IMP-08）。
- **验收**：蓝图过校验器零错误；字段覆盖契约 §2 全集。

### T-IMP-03 校验器模块化（FR-4/T-01）· 引擎层
- **目标**：T-01 校验规则全集成为可复用模块。
- **范围**：`scripts/validate-blueprint.mjs`（蓝图级规则 + DSL 结构规则 + 异源规则[v2 标注]，规则来自契约 §3；错误 `errors[]` 结构）。
- **验收**：T-01 原型 19 项断言场景全过（提升为正式测试）。

### T-IMP-04 生成器正式化（FR-2/AC-2/T-02/T-04）· 引擎层
- **目标**：单编译器生成器 + 幂等 + 产物契约。
- **范围**：`scripts/generate.mjs`（遍历 `templates/*.json` → `.generated/<id>/{script.mjs, vwf-dsl.json, SKILL.md, meta.json}`；重生成内存比对幂等；`--user-dir` 预留[T-07]）。
- **验收**：AC-2（目录加载可执行 + skill 可生成 + 幂等无 diff）；T-02 原型验证结论保持。

### T-IMP-05 等价断言（T-05/AC-1/NFR-3）· 引擎层
- **目标**：2.0 等价验收自动化。
- **范围**：`scripts/equivalence.test.mjs`（10 项静态断言：入口四态/拓扑/折叠/manualCheck/轮次+归因/闸门/异源/文件/角色/三要素 schema）；`docs/design/equivalence-checklist.md`（8 维度人工勾选清单）。
- **验收**：断言全绿 = AC-1 等价成立；清单文档就绪。

### T-IMP-06 vwf 插件改造（FR-2/FR-3/AC-2/AC-3/T-03）· 插件层（创造模式）
- **目标**：host.js 双根加载 + 用户模板落盘闭环。
- **范围**：废除硬编码 `TEMPLATES` → 扫 `.generated/`（内置）+ `~/.dsh/visual-workflow/templates/`（用户）；`save` 写 `<id>.json`（sanitize 后）+ 撞名拒绝（更新自身允许、内置只读）+ 同步生成 `~/.dsh/skills/<id>/`（自包含四件套）；`remove` 仅用户 + 同步删 skill；`list` id 字母序 + builtin。
- **验收**：AC-3（重启后 list 仍在）；撞名/内置只读用例过；save 后 `~/.dsh/skills/<id>/SKILL.md` 存在。

### T-IMP-07 异源校验集成（FR-8/T-06，v2 标注）· 引擎层+插件层
- **目标**：save/update/validate 三处异源强制（v2 生效）。
- **范围**：校验器规则 7（T-06：弱异源放行+同模型拒+缺绑定拒）；host.js save/validate 接入；6 测试用例（AC-8）。
- **验收**：AC-8 正反例过（T1/T4 拒，T2/T3 过，T5 跳过，T6 同 save）。

### T-IMP-08 文档修链与 gold-band 清理（FR-5/FR-6/AC-5）· 引擎层
- **目标**：单一入口 + 无死链。
- **范围**：删根 `SKILL.md`/`workflows/*.json`/`profiles/*`/`evals/evals.json`；`dsh/README.md:5,55` 与 mjs 注释改链；《工作流状态机》六→七；《开发工作流优化设计》死链 → `templates/`；`src/prompts` → `dsh/roles/`。
- **验收**：AC-5（grep 无残留）；AC-6 文档部分。

### T-IMP-09 runbook 与状态机更新（T-05 Q5/FR-6）· 引擎层
- **目标**：主会话驱动新契约。
- **范围**：生成 skill 的 SKILL.md runbook 模板补 `FAILED_AT_*` 驱动说明 + `AWAITING_HUMAN_<id>` 新契约（T-05 Q3/Q5）；生成器 skill 包装同步。
- **验收**：runbook 覆盖全部返回状态；生成产物自洽。

### T-IMP-10 根 validate 与 CI（FR-4/AC-4/T-04）· 引擎层
- **目标**：一键验证 + PR 阻断。
- **范围**：根 `validate` 脚本 = 蓝图校验 + 包测试 + 重生成比对（`.generated.check/` 临时目录 diff）；GitHub Actions（push/PR 跑 validate）。
- **验收**：AC-4（npm run validate 全绿；PR 阻断）。

### T-IMP-11 v1 收口等价验收（T-05/AC-1）· 收口层
- **目标**：AC-1/NFR-3 成立。
- **范围**：`equivalence-checklist.md` 8 维度人工勾选 + 断言全绿 + 旧 mjs 退役（删 `dsh/workflow/dev-workflow-2.0.mjs`，入口由生成 skill 承接）。
- **验收**：清单全勾 + 断言全绿；触发词路由实测（FR-6 软路由验证）。

### T-IMP-12 .scratch 治理（FR-10/AC-10）· 引擎层
- **目标**：分层清晰。
- **范围**：设计稿迁 `docs/design/`（含原型 README 结论提炼）；编译产物确认 gitignore；部署临时产物归位。
- **验收**：AC-10（git status 干净、.gitignore 覆盖）。

## v2 任务（T-06/T-07 决策已锁，实现另行排期）

- T-IMP-13 异源 enforcement 收口（T-06 全部用例进 CI）
- T-IMP-14 对话式创作 skill（T-07：workflow-template-authoring + 门禁 3 轮 + fork + 重建覆盖断言）
- T-IMP-15 CI 细化：多模板回归（FR-9）

## 执行顺序与依赖

```
T-IMP-01 → T-IMP-02 → T-IMP-03/04（并行基础）→ T-IMP-05 → T-IMP-10（validate 集成）
T-IMP-06（创造模式，依赖 02/04 产物）→ T-IMP-07 → T-IMP-09
T-IMP-08/12（独立，随时）→ T-IMP-11（收口，最后）
```
