---
id: T-03
title: 模板持久化与目录布局
type: grilling
labels: [wayfinder:grilling]
status: closed
assignee: charting-session-2026-08-19
blocked-by: [R-02]
resolved: 2026-08-19（grilling 三轮设计树走完，用户逐项确认）
---

## Question

FR-3 落地形态：蓝图存哪里、vwf 的 save/list/remove 如何基于目录工作？

## 待决策点

- 目录布局：规格建议 `templates/`（现有 `workflows/` 重定位至此）。内置蓝图与用户蓝图同目录还是分目录？用户模板写入仓库 `templates/` 是否合理（vs 独立用户目录——规格留了口子「或用户模板目录」）？
- save/list/remove 语义：`userWorkflows` Map（仅内存，L421-429）改为目录读写后——save 的写入格式（单文件 JSON）、list 的排序/过滤、remove 是否只删用户文件（内置只读）；id 冲突与覆盖策略（同名用户模板覆盖内置？拒绝？）。
- 与 NFR-1/T-04 的交互：用户模板若入库，gitignore 怎么处理（用户模板是源、不入 gitignore；生成物才 ignore）。
- 「图形新增 → 跨会话 → 同步文字版」闭环（FR-3 目的）对布局的隐含要求。

## 备注

HITL：grilling 票，与用户确认目录/冲突/覆盖策略偏好。依赖 R-02 的现有语义事实。

## Resolution（2026-08-19，grilling 三轮全树确认）

**目录布局（Q1 双轨）**：内置蓝图 = 仓库 `templates/`（版本化分发）；用户模板 = 宿主目录 `~/.dsh/visual-workflow/templates/`（跨会话、不污染版本库；`~/.dsh` 为宿主统一数据根，storages/storageDomain 归 P2，v1 走文件系统）。
**save/update/remove 语义（Q2/Q2b/Q3/Q6）**：save 写单文件 `<id>.json`（sanitize 后）；`save` 携带当前编辑模板 id——相同 = 更新自身（允许），不同且目标已存在（内置或用户）= **拒绝并提示改名**（用户自定义方案）；内置任何写操作拒绝；remove 仅删用户模板，内置拒绝；list 合并双根、id 字母序 + `builtin` 标志。
**文字版同步（Q4/Q4b 用户方案）**：**save 即闭环**——保存用户模板时同步调用生成器编译，写自包含技能目录 `~/.dsh/skills/<id>/`（SKILL.md + script.mjs + meta.json，仿 dev-workflow-2-0 技能包形态，落 R-04 确认的用户级发现根）；update 重编译覆盖；remove 同步删除 skill 与蓝图。零额外动作实现「图形新增 → 跨会话 → 文字版可用」。
**共享发布（Q4c）**：仓库「显式发布」保留为**可选动作**（复制到仓库 `templates/` + 重生成 + git），与本机闭环解耦。
**宿主加载接口（Q5）**：host.js 废除硬编码 TEMPLATES，改扫双根 = 内置生成物目录 + 宿主用户目录；内置生成物目录的**具体位置与 gitignore 归属归 T-04**。
**workflows/ 处置（Q6）**：不重定位（gold-band 旧 DSL 与新蓝图不同构），v1 由新蓝图 `templates/dev-workflow-2-0.json` 取代，旧文件随 FR-5 删除。
**对 R-04 的演进**：用户模板的 skill 安装问题由 save 联动天然解决（无需手动安装步骤）。
