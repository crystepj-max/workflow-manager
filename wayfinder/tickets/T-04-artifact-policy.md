---
id: T-04
title: 生成物策略：gitignore vs 入库+新鲜度
type: grilling
labels: [wayfinder:grilling]
status: closed
assignee: charting-session-2026-08-19
blocked-by: []
resolved: 2026-08-19（grilling 一轮确认，T-02 S2/S3 预决大方向）
---

## Question

生成物（生成的 skill 包装、编译脚本、vwf 注册文件）**入库还是 gitignore**？——规格 NFR-1 默认 gitignore，风险 5 留了「团队选择提交生成物则 validate 加新鲜度 diff 检查（归入 FR-9）」的口子。

## 待决策点

- 两案对比：gitignore（源唯一、仓库干净，但 CI 无法直接对拍产物、需在 validate 里现生成验证）vs 入库+新鲜度检查（CI 可直接 diff，但每次改蓝图都产生产物 diff 噪音、需规范「只编辑蓝图」纪律）。
- 对 CI（FR-4/FR-9）的具体影响：validate 里「幂等重生成」怎么落地（生成到临时目录比对？原地重生成后 git diff？）。
- NFR-1「只读、改动即重建」在所选方案下的执行机制（README 约定？校验脚本？）。

## 备注

HITL：grilling 票，是仓库政策偏好，用户拍板。结论影响 FR-4 validate 与 FR-9 CI 细化（见地图 Not yet specified）。

## Resolution（2026-08-19，grilling 一轮全确认）

**大方向**（T-02 S2/S3 已定，本票正式确认）：生成物 gitignore + 重生成，**不入库**。
**落地（用户全部采纳推荐）**：① **Q1 目录** = 根级 `.generated/<id>/`（四件套 script.mjs/vwf-dsl.json/SKILL.md/meta.json，结构沿用 T-02 原型 out/；点开头 = 自动生成惯例）；② **Q2 validate 集成** = 编译全部蓝图到 `.generated.check/`（gitignore）与 `.generated/` 逐文件比对，不一致即失败（提示「生成物过期或手改，请重跑 generate」）；零污染、不依赖 git；CI 可加 `git diff --exit-code .generated/` 兜底；③ **Q3 只读三层** = gitignore（防误提交）+ validate 重生成 diff（防手改，真正的保障）+ 产物头部注释与 README（防呆）；不做运行时只读；④ **Q4 边界** = 用户 skill/蓝图（`~/.dsh/...`）为宿主运行时产物天然不入库；风险 5 的「提交生成物 + 新鲜度检查」路线**关闭**，FR-9 不再需要该检查（重生成 diff 即新鲜度保障）。
**移交**：T-03 Q5 的「内置生成物目录」= `.generated/`，host.js 双根加载（`.generated/` + `~/.dsh/visual-workflow/templates/`）接口闭合。
