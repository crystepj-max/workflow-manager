# wf_run 按 templateId 启动误报「节点未绑定 Agent」（覆盖层合成混合形态被误判为蓝图落盘格式）

| 元数据 | 值 |
|---|---|
| 需求基线版本 | V1 |
| 对应 Issue | #233 |
| 优先级 | P1 |
| 前置依赖 | 无 |
| 无人值守许可 | 允许（实现 + 机器闸门；产品模式真机 E2E 属 #213 发布验收链，另见 §16） |
| 定义时间 | 2026-09-20T14:14:56Z |
| 当前状态 | 已定义（人工确认基线 V1，2026-09-20） |
| 分类 / 体量 | bug ｜ sized-s |

## 1. 需求背景

2026-09-20 产品模式 UAT（#82 首轮，Run `explore-74-probe-text`）中发现：`wf_run` 仅传 `templateId=wf-explore` 时校验器报「探索统筹 / 专家研究 / 综合分析 未绑定 Agent」，而同一份模板显式传图（带 `bindings.models`）可通过。该问题阻塞 #213（v0.1 产品模式发布验收）的「四套正式 Built-in 模板经 Skill / `wf_run` 入口级验收」前置。

本机存在用户模型覆盖层 `~/.dsh/visual-workflow/model-overrides/wf-explore.json`（仅覆盖 `evaluate`，源自 #234 所述「默认绑定过期后的人工兜底」）。

## 2. 用户问题

一句话：带模型覆盖层的内置模板无法用 `templateId` 正常起跑，每次都要显式传整份图绕过。

## 3. 目标

`wf_run --templateId <内置模板>` 与显式传图行为等价：模板默认绑定 + 用户覆盖层合成后的完整绑定不再丢失，校验按真实形态通过；「未绑定 Agent」误报消失。

## 4. 非目标

- 不解决「模板默认绑定指向已删除配置」（#234，独立任务）。
- 不新增「模板默认绑定 vs 当前可用模型」机器闸门检查段（#234 要求 2）。
- 不改变模型覆盖层语义（LOC-014 §9：覆盖只改 provider/model、精确键优先、$default 兜底）。
- 不放松 `requireModels` 校验强度。
- 不改运行前模型探针（#74）的 BLOCKED + `model_overrides` 恢复语义。

## 5. 修改前

带覆盖层的内置模板经 `templateId` 启动：校验阶段误报「节点 X 未绑定 Agent / 未绑定模型」（X = 覆盖层未覆盖的节点）；仅显式传全量绑定图可绕过。无覆盖层的模板不受影响。

## 6. 修改后

同一操作校验通过，四节点绑定 = 蓝图默认内联模型 + `evaluate` 覆盖生效；流程继续走既有编译 / 探针 / 引擎链路。用户可见差异仅「误报消失」，其余行为为 0 变化。

## 7. 功能范围

- 收紧 `packages/dsh-visual-workflow/src/host.js` `ingestToDsl` 的「蓝图落盘格式」判据，使「DSL 形态 + 顶层 `bindings.models` 双写」的混合形态不再被误送 `projectToVwf` 重投影（推荐取向，施工可按回归用例调整为等效内部方案，见 §12）。
- 以单测固化：合成链（`findWorkflow` + `composeModelBindings`）→ `validatePipeline` 全链不再丢绑定。
- 覆盖同根因入口：显式传 DSL 但仅携带部分 `bindings.models` 时，未被覆盖节点的内联 `model` 不再丢失。
- 按 AGENTS.md 双轨约束重建 `dist/`（产品 profile 以 link 方式直用仓库包，产品加载的是 dist）。

## 8. 不修改范围

- `dist/projection-core.cjs` 的投影语义（蓝图 → DSL 重建规则）不动；`composeModelBindings` 的双写契约与 LOC-014 规格注释保持一致。
- 内置模板蓝图（`templates/*.json`）与 `.generated/` 生成物不改动。
- 编辑器保存闭环落盘形态（双写）维持现状。
- 其余三套内置模板及两套历史模板的任何内容。

## 9. 业务规则

- 覆盖层只作用于 provider/model，键语义与 `#79 model_overrides` 对齐（节点 id 精确优先、`$default` 兜底）；合成为运行链路一部分（LOC-014 规格 §9）。
- 每个可执行节点必须有 Agent（`model.provider`）与模型（`model.model`）；`requireModels=true` 的校验强度不得回退。
- 显式传图（DSL 形态 / 蓝图落盘形态）的既有支持不回退。
- 「未绑定」报错文案与触发条件保持：只对真实缺绑定的图报错。

## 10. 用户操作路径

主路径：模型在产品 DSH 会话中调用 `wf_run`，仅传 `templateId=wf-explore`（无 `dsl`、无 `bindings`）→ 修改后校验通过，运行进入既有流程（编译 → 探针 → 引擎执行 / 按设计暂停）。

## 11. 异常和边界场景

- 无覆盖层的模板：`hasBindings=false` 分支保持 DSL 直传，行为不变。
- 显式蓝图落盘格式（带 `displayName` + 全量 `bindings.models`）：必须仍走 `projectToVwf` 投影，行为不变。
- 显式 DSL + 部分 `bindings.models` + 节点内联 `model`：修改后不得丢内联模型（本修复新增锁定点）。
- 覆盖层含 `$default` 或覆盖全部节点：合成结果全节点有绑定，校验通过（与显式全量绑定图等价）。
- 覆盖层文件坏 JSON / 非法结构：维持「忽略并留痕、不阻断加载」（LOC-014 §11 现状）。
- 真实缺绑定的自定义图：仍被 `requireModels` 拦截并报「未绑定 Agent / 未绑定模型」。
- 绑定指向未配置模型：不在校验期报「未绑定」；由运行前探针按 #74 语义 BLOCKED（非本 bug 复发，UAT 时须与 #234 边界区分）。

## 12. 已确认的关键决策及原因

| 决策主题 | 选择 | 原因 | 确认人 | 确认时间 |
|---|---|---|---|---|
| 修复取向 | 推荐 A：收紧 `ingestToDsl` 蓝图形态判据（保混合形态内联模型） | 用户可见行为与 B/C 等价，属施工内部选择；B 与 LOC-014 双写契约冲突、C 改内核投影语义牵连最广，均不作首选 | Agent（§2.2 内部决策，不需产品拍板） | 2026-09-20 |
| 与 #234 的边界 | 默认绑定过期与机器闸门段全部留在 #234 | 两票已由报告者显式分案；本任务验收不得依赖「默认绑定全部可用」 | Agent（依 issue #234 原文） | 2026-09-20 |
| 无人值守许可 | 允许（实现 + 机器闸门） | 复现已固化、验收可机器判定；无施工中须人工选择的产品问题。产品模式真机 E2E 按 AGENTS.md 属发布证据链，由 #213 验收流程承担 | Agent（默认值，基线确认时随栈呈递） | 2026-09-20 |
| 优先级 | P1 | 阻塞 #213（v0.1 发布验收）前置；与 FIX-225/226 同档 | Agent | 2026-09-20 |

未决产品事项：0。

## 13. 功能切片关系

单切片任务，不拆分。体量判定依据：根因已实证（复现脚本 + 对照实验）、影响面单一（vwf 宿主校验/合成链）、单执行会话可完成。

## 14. 前置依赖说明

```text
前置依赖：无
```

## 15. 验收条件

- [ ] AC-01 带覆盖层回归：`wf-explore` + 现实覆盖层（仅 `evaluate`）合成后经 `validatePipeline` 校验通过；四节点绑定 = 蓝图默认 + `evaluate` 覆盖生效（新增单测固化 findWorkflow→composeModelBindings→validatePipeline 全链）。
- [ ] AC-02 无覆盖层模板不回归：`wf-construction-full-feature` / `wf-diagnose` / `wf-optimize`（及 `default-workflow` / `dev-workflow-2-0`）templateId 形态校验保持通过。
- [ ] AC-03 显式传图不回归：显式 DSL / 蓝图落盘格式（`displayName` + 全量 `bindings.models`）既有用例全部保持通过，蓝图形态仍正确走 `projectToVwf`。
- [ ] AC-04 部分绑定显式图：显式 DSL 携带部分 `bindings.models` 且节点带内联 `model` → 内联模型不丢失（新增用例锁定同根因入口）。
- [ ] AC-05 校验强度不放松：构造真实缺绑定的图仍被拦截（`tests/host.test.mjs:433-434` 语义不回退）。
- [ ] AC-06 机器闸门：仓库 `npm run generate && npm run validate` 与插件包 `npm test` 全部通过，无新增失败项。
- [ ] AC-07 dist 一致性：`src/` 改动后重建 `dist/`，`dist-fresh` 测试通过；产品加载形态与源码同步。

## 16. UAT 场景

### UAT-01 带覆盖层的内置模板 templateId 起跑（产品模式真机）

- 验收目的：确认产品 DSH 真实安装路径加载的 dist 上，误报消失、绑定合成正确。
- 前置条件：
  1. 按 AGENTS.md 关闭开发 DSH，完整重启产品 DSH（3080），确认正式插件从真实安装路径加载；
  2. 本机存在 `~/.dsh/visual-workflow/model-overrides/wf-explore.json`（如已清理则临时构造仅含 `evaluate` 的覆盖文件）。
- 操作步骤：
  1. `wf_run` 仅传 `templateId=wf-explore`；
  2. 观察校验阶段输出与运行进入的下一阶段。
- 预期结果：
  1. 不再出现「探索统筹 / 专家研究 / 综合分析 未绑定 Agent」；
  2. 若绑定指向未配置模型 → 按设计进入探针 BLOCKED + `model_overrides` 恢复路径（属 #74/#234 语义，不算本 bug 复发）；若绑定可用 → 正常进入编译/引擎执行。
- 建议人工关注：UAT 结论与 #234 的真机验证是否互相混淆（绑定「是否存在并可用」属 #234）。

## 17. 风险

- 判据收紧的反向回归：若存在「无 `displayName` 但确为蓝图落盘格式」的旧数据输入，可能被改判为 DSL 直传——以保存闭环既有用例兜底，施工时先盘点 `ingestToDsl` 全部真实调用方。
- dist 与 src 漂移：产品 profile 以 link 直用仓库包，改 `src/` 必须重建 `dist/` 并重启产品 DSH 才生效（AGENTS.md 双轨约束）；漏重建会出现「修了但真机依旧」的假象。
- 与 #234 验收耦合：真机上绑定可用性由 #234 管，本任务 UAT 若遇 `MODEL_NOT_CONFIGURED`/探针 BLOCKED 不得误判为本 bug。

## 18. 已知限制

- 本修复不验证「模板默认绑定是否指向现存配置」（#234 要求 1/2 不在本范围）。
- 编辑器保存闭环的落盘形态维持 LOC-014 双写现状，混合形态在编辑器内的展示不变。

## 19. 版本历史

| 版本 | 日期 | 变更摘要 | 确认人 |
|---|---|---|---|
| V1 | 2026-09-20 | 初版基线（根因实证 + 影响面核对 + 验收口径）；人工确认 2026-09-20 | crystepj-max |
