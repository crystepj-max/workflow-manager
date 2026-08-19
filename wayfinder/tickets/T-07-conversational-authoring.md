---
id: T-07
title: 对话式创作会话契约（v2）
type: grilling
labels: [wayfinder:grilling]
status: closed
assignee: charting-session-2026-08-19
blocked-by: [T-01]
resolved: 2026-08-19（grilling 两轮全树确认；Q3 前补充 FR-7 出处）
---

## Question

FR-7 对话式新增/修改模板的**会话契约**是什么？——用户在会话用自然语言描述，AI 写蓝图 JSON 入 `templates/`，跑生成器重生成双入口，过 `validate` 才接受；修改只编辑蓝图（NFR-1）、禁止编辑生成物。

## 待决策点

- 交互流程：用户在哪个入口发起（DSH 会话内？vwf 图形界面？）？新增 vs 修改如何区分？「接受前 validate 门禁」失败时如何反馈与迭代？
- 蓝图编写契约：AI 编写蓝图的依据（T-01 定稿的 schema 文档）、编辑生成物的检测/拦截机制（怎么算「编辑了生成物」——校验脚本 diff？）。
- 与 T-03 的交互：会话内新建模板落盘 `templates/` 后，vwf 侧如何感知（目录加载天然可见？）。
- 验收对应 AC-7：会话描述→蓝图→validate 通过→双入口生成→人工只编辑蓝图（生成物改了会被重建覆盖）。

## 备注

HITL：grilling 票；阻塞于 T-01（schema 须稳定并文档化，规格风险 2）。v2 执行。

## Resolution（2026-08-19，grilling 两轮全树确认）

**落盘模型（Q1）**：统一走 T-03 闭环（不另开通道）——会话内创作调用与 `vwf.save` 相同的「蓝图接受管线」（门禁 → 落宿主目录 `~/.dsh/visual-workflow/templates/` → 同步生成 `~/.dsh/skills/<id>/` skill）；共享/版本化 = 显式发布动作（复制到仓库 `templates/` + 重生成 + git）。规格字面「写入 templates/」由发布动作满足。
**生成物保护（Q2）**：流程约定（runbook 明令只编辑蓝图）+ gitignore/头部注释（T-04）+ 重生成 diff 检测 + `generate` 覆盖恢复；不做运行时写拦截。
**入口形态（Q3）**：专用 skill（`workflow-template-authoring`）承载「分诊（新增/修改）→ 按蓝图契约写作 → validate 门禁 → 落盘 → 生成 → 汇报」，内部调用生成器 CLI 与校验器（复用 T-02 产物，与 T-03 save 管线共用接受逻辑）；CLI 保持无交互。
**门禁迭代（Q4）**：按错误消息自修，上限 3 轮；超限呈错误清单转人工。
**修改语义（Q5）**：内置只读——修改内置 = fork 新 id（撞名拒，T-03 语义）；用户模板直接改（更新自身）；改后同门禁 + 重生成（宿主 skill 联动重建）。
**验收（Q6，AC-7 细化）**：会话演练（真实描述 → 全流程留痕）+ 自动化断言（门禁拦截非法蓝图 / 3 轮自修终止 / fork 内置 / 生成物重建覆盖手改——改生成物 → 重跑 generate → 内容恢复一致）。
