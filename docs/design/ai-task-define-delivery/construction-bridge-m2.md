# M1 → M2 建设桥接（定义外置 · 已接线）

> **M1**：契约 + 定义入口预留。  
> **M2**：交付主链已按任务书改造——从「已定义」开工。权威：`single-task-delivery-m2.md`。

---

## 对照

| 维度 | M1 之前 / 过渡 | M2（现行） |
|---|---|---|
| 定义位置 | 建设主链内 requirements | 外置「需求分析」→「已定义」 |
| 交付起点 | 从 requirements 开始 | 实施前检查 → 开发 → … |
| 方案设计人工门 | design 条件门在主链内 | **不在**交付主链；定义阶段已决策 |
| 自动返工上限 | 3 | **3**（产品拍板） |
| 人工验收 | accept / reject / user_accepted | accept / reject / **conditional_pass** |

---

## M2 已完成接线

1. 建设 Skill / runbook：产品可见主链改为实施前检查起跳；已定义任务跳过重新定义。
2. 实施前检查读取公共契约字段（脚本 + 清单）。
3. 交接包验收枚举迁移为严格三态；废弃 `user_accepted` 表达有条件通过。
4. `auto_rework_limit = 3` 与建设 `rollback_budget` 默认对齐并在文档明示。

## 纪律

- 发现建设 Portable Contract 旧七阶段措辞与本文冲突时：**产品行为以 `single-task-delivery-m2.md` + `public-task-contract.md` 为准**。
- 证据链可继续写入 baseline / design 类记录作为底物，但 design 记录在 M2 仅为「定义外置说明」，不得再开产品决策门。
