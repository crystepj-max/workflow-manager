---
id: R-04
title: DSH skill 发现与触发词路由机制
type: research
labels: [wayfinder:research]
status: closed
assignee:
blocked-by: []
resolved: 2026-08-19（charting 会话内联调研，子代理基础设施故障）
---

## Question

DSH 宿主如何发现 `dsh/skills/*/SKILL.md` 并据触发词路由？——FR-6/NFR-3 要求生成出的 skill 能被 harness 加载识别、`displayName`（中文）/`name`（英文）/别名都能路由到同一 `templateId`；规格风险 3 明确「实现时须验证触发词路由生效」。

## 范围

- 本仓库先例：`dsh/skills/requirements-analysis/SKILL.md` 如何在会话中被发现/加载（对照本会话技能目录里确有 `requirements-analysis`）。
- 在 DSH 源码处（`/Users/chris/.npm/_npx/1e7f6d9597241db0`）查 skill 目录约定：扫描路径、SKILL.md 格式要求（name/description/触发词）、是否支持别名、生成 skill 落 `dsh/skills/<id>/SKILL.md` 是否需要额外注册。
- 结论：FR-6 的触发词路由（中文名/英文名/别名 → 同一 templateId）在该机制下成立吗？有无命名冲突风险（如与现有 skill 重名）？

## 产物

`docs/research/skill-discovery.md`：机制说明 + 证据（路径/行号）+ FR-6 可行性结论。

## 阻塞

无（立即派发）。

## Resolution（2026-08-19）

机制落盘 `docs/research/skill-discovery.md`。要点：默认发现根 = 项目 `.dsh/skills`/`.agents/skills` + `~/.dsh/skills`/`~/.agents/skills` + 自定义 + bundled——**仓库 `dsh/skills/` 不是发现根**，生成 skill 须配套安装步骤（仿 install-requirements-analysis.sh 装 `~/.agents/skills/`）或改用 `.dsh/skills`；name 须 kebab-case、frontmatter 必填 name+description；**无 harness 级别名**，中文名/别名只能进 description（模型侧语义匹配，软路由）；会话目录启动快照（热刷新路径存在但非默认）；与现有 `dev-workflow-2-0` 技能重名冲突风险须在生成器防重名。FR-6 可行但有前置。
