# 需求分析摘要 · FIX-233（GitHub #233）

- 分析时间：2026-09-20T13:48:30Z
- 轨道判定：GitHub 可用（`gh` 已认证、可读写 crystepj-max/workflow-manager）→ **GitHub 轨道**；需求来源 = GitHub issue #233，发布去向 = 更新该 issue。
- 分析者：ZCode（requirements-analysis skill）

## 1. 分诊

- 分类：`bug`（沿用既有标签）；状态推进：`needs-triage` → 定义中 → 待确认。
- 冗余性：全仓检索「未绑定」文案与既有修复，登记册无 #233 登记、无在途同名分支/PR → 非重复。
- 关联票：#234（默认模型绑定过期 + 机器闸门缺段）同源不同案，报告者已显式分案；本任务与其验收边界写入规格 §4/§8。
- 阻塞关系：#213（v0.1 产品模式发布验收）前置。优先级 P1。
- 体量：**S**（根因实证、影响面单一、单会话可完成）。

## 2. 取证过程与根因

证据链（全部只读取证，未改产品文件）：

1. **报错文案定位**：「节点 X 未绑定 Agent（model.provider 必填）」只存在于 `dist/validate-core.cjs:811`；`requireModels` 分支**只读蓝图顶层 `bindings.models`**，不读 DSL 节点内联 `model`。
2. **templateId 链路**：`wf_run` → `findWorkflow`（`.generated` 生成物 + 覆盖层 `composeModelBindings`）→ `validatePipeline`（`ingestToDsl` → `sanitizeDsl` → `projectToBlueprint` → `validateBlueprint(requireModels=true)`）。
3. **形态误判**：`ingestToDsl`（`src/host.js:469-481`）把「顶层存在非空 `bindings.models`」当作蓝图落盘格式判据。`composeModelBindings` 对带覆盖层的模板双写内联 `model` + 顶层 `bindings.models`，产出混合形态 → 命中误判 → 整份对象被送入 `projectToVwf` 按**蓝图语义**重投影 → 仅 `bindings.models` 里有的节点（`evaluate`）保留绑定，其余节点内联 `model` 被丢弃。
4. **requireModels 拦截**：蓝图绑定里只剩 `evaluate` → 探索统筹/专家研究/综合分析 三节点报「未绑定 Agent + 未绑定模型」。
5. **逐字复现**：以产品同款 dist（2026-09-19 17:52 构建；产品 DSH 3080 于 2026-09-20 15:52 启动，`--profile web --port 3080`，经软链直用仓库包）+ 仓库 `.generated/wf-explore/vwf-dsl.json` + 本机真实覆盖层 `~/.dsh/visual-workflow/model-overrides/wf-explore.json`，完整模拟四步链路，报错与 issue 逐字一致。

对照实验：

| 输入形态 | ingestToDsl 分支 | 结果 |
|---|---|---|
| templateId + 覆盖层（本 bug） | hasBindings=true → projectToVwf | ✗ 三节点丢绑定，误报 |
| templateId 无覆盖层 | hasBindings=false → DSL 直传 | ✓ 通过 |
| 显式图 + 全量 bindings.models | projectToVwf | ✓ 通过（issue 所述绕过路径） |
| 显式 DSL + 部分 bindings.models | projectToVwf | ✗ 同根因丢内联模型（同入口，纳入修复范围） |

`.generated` 四套内置模板 + 两套历史模板内联模型均齐全、顶层均无 `bindings` → 无覆盖层时全部不受影响。本机仅 `wf-explore` 有覆盖层文件 → 仅它触发。

## 3. 对原票两处待确认项的回答

- 「根因未定」→ 已实证（见上）。
- 「是否同样影响 wf-construction-full-feature / wf-diagnose / wf-optimize」→ 本机不影响（无覆盖层文件）；bug 类别影响**任何带模型覆盖层的内置模板**，与 fan-out 无关。修复验收以「带覆盖层的任意内置模板」为口径。

## 4. 决策记录

无需要人工拍板的产品决策（修复取向为施工内部选择，用户可见行为唯一确定：误报消失、其余行为 0 变化）。默认值已在规格 §12 简述：修复取向推荐 A（收紧 `ingestToDsl` 判据）、优先级 P1、无人值守允许。

## 5. 落档

- 规格：`docs/tasks/specs/FIX-233-vwf-templateid-binding-loss/task-spec-V1.md`（V1，待确认）
- Definition Check：同目录 `definition-check.md`（全通过，未决产品事项 0）
- Issue：#233 正文更新为「任务基本信息（待确认）+ 三要素 + 成立性判定」，带 AI 免责声明
- 待人工确认基线后：registry 登记（FIX-233 / GitHub #233）、打 `ready-for-agent` + `sized-s`、Issue 状态改「已定义」、`validate:task-context` 门禁
