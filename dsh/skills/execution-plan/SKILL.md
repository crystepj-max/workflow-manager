---
name: execution-plan
description: "已退役的本地 Execution Plan 副本；当前任务筛选、状态与执行历史由 Multica/dev-flow 管理。"
---

# Execution Plan（历史副本，已退役）

此文件仅为迁移前的追溯材料，不应安装、触发或作为当前任务流程说明。旧版本从本地 `registry.json` / `BOARD.md` 读取任务，并依赖 GitHub Task 标签；这些任务源和写入路径已退役。

当前任务身份、状态、负责人、项目、依赖和执行历史从 Multica 获取。需要批次执行时使用项目级 `dev-flow` 的 `execution-plan` Skill；当前单任务施工门禁使用 `scripts/construction-preflight-gate.mjs`，从显式指定的 Multica profile/workspace 读取 Task 与依赖。

不得把本文件中的旧状态、旧命令或批次输入用于当前开工；Multica 不可用或元数据缺失时应停止并报告，不得回退到本地登记册。
