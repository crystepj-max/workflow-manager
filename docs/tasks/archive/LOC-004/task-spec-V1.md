# 运行记录 store 收敛双持久化管线

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
架构评审候选 4：host.js 中 runs（L423-540 区域）与 logicalRuns（L542-850 区域）各自实现同一条持久化管线——单飞行写队列、启动回载（含等 fs 重试循环）、淘汰、水合逐字同构；`fs === undefined` 守卫散布 20+ 处。#79 第二个消费者已付过复制税。

## 2. 用户问题
第三类运行记录接入时要再抄一遍管线；写队列/回载语义改动要改两处，漏一处即行为分叉。

## 3. 目标
一个「运行记录 store」内部 module 吞掉双 Map + 合并写 + 回载 + 淘汰 + 水合；存储介质成为可替换 adapter（落盘 / 内存）；runs 与 logicalRuns 变为同一 store 的两个实例。

## 4. 非目标
- 不改任何 `vwf.*` RPC interface、事件流语义、落盘文件格式与容量策略数值
- 不动 client.js（LOC-001 在途）；不合并 runs 与 logicalRuns 的业务语义（两者仍是两个实例）

## 5. 修改前
`persist/drainWrite/writeRun`（467-490 一带）与 `requestLogicalPersist/drainLogicalWrite/writeLogicalRun`（770-792 一带）逐字同构；`loadRuns`/`loadLogicalRuns` 双份回载含相同重试循环。

## 6. 修改后
`createRunRecordStore({ storage, … })` 内部工厂：实例各自持有内存态与文件名映射，写队列/回载/淘汰/水合实现一次；runs 与 logicalRuns 各建一个实例；散布的 fs 判空收进 store。

## 7. 功能范围
仅 `packages/dsh-visual-workflow/src/host.js` 内部重构 + 既有测试护栏；如 store 逻辑需要独立直测，允许在 tests/ 新增针对 store 行为的用例（经宿主 interface 或最小导出）。

## 8. 不修改范围
RPC 注册面、事件订阅、落盘目录/格式、LOV-001 在途文件、动态闭包双模式探测逻辑。

## 9. 业务规则
1. 对外 interface（vwf.state / vwf.runs.list / vwf.runs.history / vwf.logicalRuns.get 等）返回结构逐字节不变。
2. 落盘文件路径、命名、合并写时序（单飞行 + 尾写补写）语义不变。
3. 淘汰策略（容量 50 淘汰最旧）数值与语义不变。

## 10. 用户操作路径
无用户可见变化（纯内部深化）；验收 = 既有测试全绿 + release:verify。

## 11. 异常和边界场景
- fs 服务不可用：维持现状（明确报错 / 仅终端留痕语义不变）。
- 启动回载竞速：logicalRuns 水合时序（runsHydration）不变。

## 12. 已确认的关键决策及原因

| 决策主题 | 选择 | 原因 | 确认人 | 确认时间 |
|---|---|---|---|---|
| store 形态 | host.js 闭包内工厂（非独立文件） | vm 沙箱约束下 host 本就单文件闭包；内部分 seam 即可测试 | Agent（施工方式） | 2026-09-09 |
| 发布轨道 / 无人值守 / 优先级 | 本地轨道 / 允许 / P2 | GitHub 停用；机械重构 | 用户（批量授权） | 2026-09-09 |

## 13. 功能切片关系
单切片。前置依赖：无（host.js 区域与 LOC-002/003 不相交；分支基于投影收口分支，避免同文件交叉）。

## 14. 前置依赖说明
```text
前置依赖：无
```

## 15. 验收条件
- [ ] 单飞行写队列/回载/淘汰/水合的实现各只剩一处（grep 双份函数名消失）
- [ ] runs-persistence / host / logical-run 三个测试文件不改断言全绿
- [ ] 动态闭包双半 ≤ 80KB
- [ ] `npm test`、`npm run validate`、`npm run release:verify` 全绿
- [ ] 改动不触碰 client.js 与 LOC-001 在途文件

## 16. UAT 场景
### UAT-01 机械验收
- 操作：逐条执行验收条件；预期全部满足。

## 17. 风险
host.js 单闭包重构复杂度高——以三大测试文件（128 项）为护栏小步重构。

## 18. 已知限制
产品 DSH 真实环境 E2E 属人工验收步骤（双轨规矩），机器闸门不替代。

## 19. 版本历史

| 版本 | 日期 | 变更摘要 | 确认人 |
|---|---|---|---|
| V1 | 2026-09-09 | 初版基线 | 用户（批量授权） |
