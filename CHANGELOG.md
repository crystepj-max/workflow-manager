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
| 2026-09-12 | LOC-017 | 验收通过后合并入本地主分支（`f592902`，tag `task/loc-017/v2`）并按约定完成收口：证据 11 文件归档主检出、生成证据摘要、删工作区留分支、prune 兜底 |
| 2026-09-12 | — | P1 ③ 落地：登记册新增 `evidence_expires_at` / `evidence_cleared_at` / `branch_retained` 三字段（合并时自动按合并时间 + 7 天起算保留期）；校验项 D-9/D-10 转为实际判定（D-10 首跑即揪出 5 个早期任务「标记保留分支但分支已不存在」的登记失真） |
| 2026-09-12 | — | 决策三执行：`decision-map.md` 与 `requirements-analysis.md` 迁入 `docs/design/vwf-p2/`（git mv 保历史）；3 个原型残留移除跟踪。D-6 转通过 |
| 2026-09-13 | — | **P2 全量落地**：新增 `scripts/workspace-paths.mjs`（路径解析唯一入口：主检出锚定 + 相邻容器布局）；`cwf-run-init.mjs` 工作树改落相邻容器、产物锚定主检出（嵌套在结构上不可能再发生）；`local-task-merge.mjs` 归档扩为三件套并追加 prune 兜底；新增 `scripts/task-runs-cleanup.mjs`（到期清理，默认只读预演）；runbook 与收口角色文档同步两阶段口径 |
| 2026-09-13 | — | 存量收敛收尾：三个待判定工作树逐一核实内容已在 main 后收口（`cwf-131-01` 证据 22 文件补归档）；`ws-cwf-159-01` 指针错乱目录移入回收区；`.agent-runs` 18 项违规命名归位（D-5 清零）；分支治理 50 → 28（删 22 个：领先 0 / 内容已核实进 main / 远端镜像有备份）；`validate:workspace` 接入 `npm run validate` 阻断路径。**11 项工作区校验全部通过** |
