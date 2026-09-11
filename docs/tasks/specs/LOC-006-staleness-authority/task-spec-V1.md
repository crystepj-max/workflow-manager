# 生成产物 staleness 单一权威与孤儿清理

| 元数据 | 值 |
|---|---|
| 需求基线版本 | V1 |
| 对应 Issue | （GitHub 恢复后补建） |
| 优先级 | P2 |
| 前置依赖 | 无 |
| 无人值守许可 | 允许 |
| 定义时间 | 2026-09-09T16:05:00Z |
| 当前状态 | 待确认（本地轨道） |

## 1. 需求背景
架构评审候选 6：「生成产物 map ↔ 目录」的比对在 generate CLI（main 内 prev/files 比对）与 validate 步骤②（内存 vs 磁盘 mismatch）各写一遍且方向语义微妙不同；写盘只增不删——删除蓝图后 `.generated/<id>/` 永久残留，每次 generate 报缺失、validate 永远红，检测到了却无环节自愈。

## 2. 用户问题
删蓝图后校验永远红灯且无法自愈；「为什么红灯」要读两份不完全等价的比对实现才能解释。

## 3. 目标
比对逻辑单一实现（一个 helper 供两处共用）；generate 写盘后按 files map 清理孤儿产物目录——删蓝图从「永久红灯」变「自动收敛」。

## 4. 非目标
- 不改 `.generated` 产物格式与蓝图 schema
- 不给宿主侧磁盘优先路径加 staleness 检查（维持 validate 步骤②兜底语义）
- 不做交互式确认（prune 静默执行并在输出中列出）

## 5. 修改前
validate.mjs:46-53 一份 mismatch 循环；generate.mjs main():975-987 一份 prev/files 循环；writeAll 只 mkdir+write。

## 6. 修改后
generate.mjs 导出 `compareGeneratedFiles(files, outDir)`（返回 { missing, extra, changed }）与 `pruneGenerated(files, outDir)`（删除目录名不在 map 内的产物目录）；main 写盘后调用 prune 并在输出列出；validate 步骤② 改用 compareGeneratedFiles。

## 7. 功能范围
1. generate.mjs：导出两个 helper；main 接入 prune。
2. validate.mjs：步骤② 改用共用 helper。
3. 新增直测：diff 三态（新增/缺失/内容不一致）+ prune 只删不在 map 的目录。

## 8. 不修改范围
蓝图与模板、生成物内容、宿主、LOC-001 在途文件。

## 9. 业务规则
1. prune 只作用于 `.generated/` 下、且目录名不在当前 files map 的目录；不递出该根、不碰文件。
2. validate 步骤② 的红线判定语义不变（缺失/不一致仍红）；`extra`（磁盘多出）在 generate 侧由 prune 收敛、在 validate 侧仅报告不判红（维持现有红线口径不变）。
3. 幂等：连跑两次 generate，第二次完全无改动无 prune 输出。

## 10. 用户操作路径
删蓝图 → `npm run generate`（输出「清理孤儿产物：…」）→ `npm run validate` 恢复绿。

## 11. 异常和边界场景
- `.generated` 不存在：首跑只生成不清理。
- 目录名不在任何蓝图且含非产物文件：仍整目录移除（.generated 本为生成物目录，仓库规则禁手改）。

## 12. 已确认的关键决策及原因

| 决策主题 | 选择 | 原因 | 确认人 | 确认时间 |
|---|---|---|---|---|
| prune 归属 | generate 写盘后静默执行 + 输出列出 | 自愈而非报错；无人工确认需求（产物可再生） | Agent（施工方式） | 2026-09-09 |
| 发布轨道 / 无人值守 / 优先级 | 本地轨道 / 允许 / P2 | 同前 | 用户（批量授权） | 2026-09-09 |

## 13. 功能切片关系
单切片。前置依赖：无。

## 14. 前置依赖说明
```text
前置依赖：无
```

## 15. 验收条件
- [ ] 两处 diff 循环归一：validate.mjs 与 generate.mjs 均调用 `compareGeneratedFiles`（grep 无独立比对循环）
- [ ] 直测覆盖 diff 三态 + prune 行为 + 幂等
- [ ] 人为造孤儿目录 → generate 清理且输出列出 → validate 恢复绿
- [ ] `npm test`、`npm run validate` 全绿

## 16. UAT 场景
### UAT-01 孤儿自愈验收
- 操作：在 worktree 造一个假蓝图生成后删除蓝图再 generate；预期孤儿目录被清理、validate 绿。

## 17. 风险
prune 误删——限定根目录 + map 比对 + 直测护栏。

## 18. 已知限制
宿主磁盘优先路径仍不做 staleness 检查（维持既有兜底分工）。

## 19. 版本历史

| 版本 | 日期 | 变更摘要 | 确认人 |
|---|---|---|---|
| V1 | 2026-09-09 | 初版基线 | 用户（批量授权） |
