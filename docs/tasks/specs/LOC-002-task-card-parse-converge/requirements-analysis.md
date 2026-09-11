# 需求分析摘要 — LOC-002 任务卡解析与状态词汇收敛

- 来源：会话录入（本会话架构评审候选 2）；GitHub 不可用 → 本地轨道。
- 证据复核于 main（df32b17）：`field()` ×3 逐字重复（20 调用点）；版本解析 6 级 vs 3 级已漂移；
  状态字面量重抄（等待验收/已合并/本地已定义）；`parseDeps` 已单源无需收敛。
- 关键决策：范围 = 方案二（解析收敛 + 状态词汇搭车，不含候选 3）——用户 2026-09-09 拍板；
  版本语义取 preflight 6 级并集（超集方向零破坏）。
- 行为差异声明：唯一行为变化 = merge 侧版本解析变宽；preflight 门禁语义、CLI 退出码不变。
- 后续观察项（不在本任务）：候选 3 preflight 结构化 interface；`assess()` 硬编码
  `--run-baseline V1`；登记册 CLI `--slug` 参数未生效（newRecord 恒由名称 slugify）。
- 施工环境：本会话隔离 worktree `.scratch/worktrees/dev-projection-converge-01`，
  施工分支基于 main 新建；不触碰 LOC-001 在途文件。
