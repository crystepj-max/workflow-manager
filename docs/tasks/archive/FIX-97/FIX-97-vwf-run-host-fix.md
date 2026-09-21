# FIX-97 VWF 运行宿主三项修复

- 类型：FIX
- 远端：cnb#97
- 状态：等待验收
- 优先级：P1
- slug：vwf-run-host-fix
- 规格：docs/tasks/specs/FIX-97-vwf-run-host-fix/task-spec-V1.md
- 分支：fix/FIX-97-vwf-run-host-fix

## 一句话
修复可视化工作流运行底座的 3 个缺陷（产物目录错位 / 恢复被旧信号取消 / 任务编号被抹掉），让评价基线运行时可靠。

## 证据链
- 定义：任务规格 V1 + 定义检查（全过、未决 0）+ 需求分析（方案 A）+ 决策票 DT-01（采纳 A）
- 开发：host.js 三处补丁 + EB6/EB7/EB8 测试
- 测试：evaluation-baseline-runtime.test.mjs 全绿
- 验收：待合并后产品验收

## 关联
- 父功能：LOC-027 / WR-004（cnb#45，已合并）
