# FIX-233｜wf_run 按 templateId 启动误报「节点未绑定 Agent」（覆盖层合成混合形态被误判为蓝图落盘格式）

## 任务基本信息

| 字段 | 值 |
|---|---|
| 任务标识 | FIX-233（远端锚点：GitHub Issue #233） |
| 需求来源 | github-issue |
| 来源定位 | GitHub Issue #233 原始报告（2026-09-20，#82 产品模式 UAT 首轮顺带发现） |
| 任务名称 | wf_run 按 templateId 启动误报「节点未绑定 Agent」（覆盖层合成混合形态被误判为蓝图落盘格式） |
| 任务类型 | 完整功能开发 |
| 分类 | bug |
| 体量 | S |
| 优先级 | P1（随 V1 基线一并确认） |
| 当前状态 | 已定义 |
| 需求基线版本 | V1（已确认基线；Definition Check 通过，未决产品事项 0） |
| 前置依赖 | 无 |
| 施工环境组 | FIX-233 |
| 施工环境角色 | 独立 |
| 无人值守许可 | 允许——实现 + 机器闸门可无人值守；产品模式真机 E2E 属 #213 发布验收链（随 V1 基线一并确认） |
| 任务规格位置 | `docs/tasks/specs/FIX-233-vwf-templateid-binding-loss/task-spec-V1.md` |
| 定义时间 | 2026-09-20T14:14:56Z |
| GitHub 同步 | synced#233 |

已登记进 `docs/tasks/registry.json`（`remote: GitHub #233`、`github_sync: #233`、`status: 已定义`），看板 `BOARD.md` 已重写。编号沿用 GitHub issue 号（FIX-<issue#>，同 FIX-225/226 先例），未走 CNB 发号。

## 摘要（三要素）

**目标：** `wf_run --templateId <内置模板>` 与显式传图行为等价——模板默认绑定 + 用户覆盖层合成后的完整绑定不再丢失，「未绑定 Agent」误报消失。

**范围：** 做——收紧 `ingestToDsl` 蓝图形态判据（推荐取向，施工可调等效内部方案）；单测固化合成→校验全链；锁定同根因入口（显式 DSL + 部分 `bindings.models`）；按双轨约束重建 `dist/`。不做——#234（默认绑定过期 + 机器闸门段）、覆盖层语义、`requireModels` 校验强度、探针 BLOCKED 语义、模板蓝图内容、保存闭环落盘形态。

**验收标准：**

- [ ] AC-01：带覆盖层的 `wf-explore` 经 templateId 校验通过，绑定 = 蓝图默认 + `evaluate` 覆盖生效（新增全链单测）。
- [ ] AC-02：无覆盖层的其余内置模板 templateId 形态不回归。
- [ ] AC-03：显式传图（DSL / 蓝图落盘格式）既有路径不回归。
- [ ] AC-04：显式 DSL + 部分 `bindings.models` 不再丢内联模型（新增用例锁定同根因入口）。
- [ ] AC-05：真实缺绑定的图仍被 `requireModels` 拦截（校验强度不放松）。
- [ ] AC-06：`npm run generate && npm run validate` 与插件包 `npm test` 全部通过，无新增失败项。
- [ ] AC-07：`dist/` 重建后 `dist-fresh` 通过，产品加载形态与源码同步。

## 成立性判定（本会话复核结论）

**成立，根因已实证（原票「根因未定」闭合）。** 证据链：报错源头 `dist/validate-core.cjs:809-817`（requireModels 只读蓝图顶层 `bindings.models`）→ 误判分支 `src/host.js:469-481`（`ingestToDsl` 把「顶层非空 `bindings.models`」当蓝图落盘格式判据）→ 混合形态来源 `src/host.js:417-433`（`composeModelBindings` 双写内联 `model` + 顶层 `bindings.models`，LOC-014）→ `projectToVwf` 按蓝图语义重投影，仅覆盖过的节点（`evaluate`）保留绑定，其余节点内联模型被丢弃 → 三节点误报。

2026-09-20 以产品同款 dist（2026-09-19 17:52 构建；产品 DSH 3080 经 profile 软链直用仓库包）+ 仓库 `.generated` 生成物 + 本机真实覆盖层完整模拟四步链路，报错与本票逐字一致。对照：去掉覆盖层 → `hasBindings=false` → 通过；显式全量 `bindings.models` → 通过（即原票所述绕过路径）。

对原票待确认项的回答：其余三套内置模板本机不受影响（无覆盖层文件、`.generated` 内联模型齐全）；bug 类别影响**任何带模型覆盖层的内置模板**，与 fan-out 无关。嫌疑中 LOC-014 合成链成立；LOC-019 相关默认值过期已由 #234 单独立案。

## 与 #234 的边界

绑定「形态正确、校验通过」属本票；绑定「指向的模型是否真实存在/可用」属 #234。真机上修复后若遇探针 `MODEL_NOT_CONFIGURED`/BLOCKED，是 #74 设计语义，不算本 bug 复发。

## 详细规格

完整需求以本地任务规格为准（见上表「任务规格位置」，含 §11 边界场景、§15 验收条件、§16 UAT）。实质变更走 Vn→Vn+1 流程。

## 变更记录

| 时间 | 状态 | 说明 |
|---|---|---|
| 2026-09-20T13:48:30Z | 待确认 | 需求分析完成：根因实证复现 + 影响面核对（对照实验）；规格 V1 + Definition Check 落盘（未决产品事项 0）；issue 正文更新为「待确认」+ 根因判定，打 `sized-s` |
| 2026-09-20T14:14:56Z | 已定义 | 用户确认基线 V1。登记册登记（`remote: GitHub #233`、`github_sync: #233`）、看板重写、issue 正文状态改「已定义」并写入定义时间、打 `ready-for-agent`。🟡 规格与任务卡落盘于工作区，入库需一次 docs 提交（待授权） |
