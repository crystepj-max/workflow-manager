# 变更日志

> 约定：**合并时**追加一行，格式 `日期 · TASK_ID · 一句话影响`。
> 权威：`docs/design/workspace-directory-convention.md` §1.9（变更记录分层）。交付事件的唯一存放位置。
>
> 说明：本文件于 2026-09-12 建立。此前的交付事件未回填（历史记录以 `docs/tasks/archive/` 与 git 历史为准）。

| 日期 | TASK_ID | 影响 |
|---|---|---|
| 2026-09-12 | — | 建立工作区目录组织约定：通用标准模板 + workflow-manager 实例化说明（`docs/design/workspace-directory-convention*.md`）；新增只读校验器 `scripts/validate-workspace.mjs`（D-1~D-10）与纯逻辑 core + 单测 |
| 2026-09-12 | LOC-011 / LOC-012 / LOC-015 | 按暂停期口径完成收口：归档 Run 证据（9+9+25 文件）→ 生成证据摘要 → 删除工作区、保留分支 → `worktree prune` 兜底。三任务归档三件套齐备，终态工作区残留归零 |
| 2026-09-12 | LOC-001 / LOC-010 | 归档缺口补救（两任务规格此前仅存在于 `.scratch/`）：LOC-001 补任务卡 + 规格 V1/V2 全版本 + 定义检查 + 证据摘要（标注 `no_run_evidence`）；LOC-010（已取消）补任务卡 + 规格 V1 + 证据摘要，其摘要记录了唯一一次人工 `reject` 裁决 |
| 2026-09-12 | — | 归档位置统一到 `docs/tasks/archive/<TASK_ID>/`（决策五方案甲）：并入原 `docs/tasks/specs/` 全部 17 个文件后删除该目录；补齐 LOC-002..007 任务卡；新增证据摘要生成器 `scripts/workspace-evidence-summary.mjs`；校验器 D-8 由「2 件」升级为「三件套」并新增 `specs/` 残留告警 |
| 2026-09-12 | — | 登记册数据卫生：清除 `LOC-002.worktree` 悬空引用、`LOC-015.worktree` 已删工作区残留引用，`spec_path` 改指 `archive/` |
