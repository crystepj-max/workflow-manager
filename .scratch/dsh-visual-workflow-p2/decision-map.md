# P2 决策地图（issue #6 · wayfinder）

## Destination

插件产品化：`dsh plugin add` 可安装、模板跨会话持久、支持动态拆解节点、多工作流并行互不串扰。

## Decisions so far

（暂无——决策工单见下）

## Not yet specified（frontier，全部未阻塞可认领）

- [ ] D1 AiDynamic 节点的 DSH 映射与取舍
- [ ] D2 组合包打包与分发形态
- [ ] D3 模板/运行记录持久化模型
- [ ] D4 多工作流并行语义与边界
- [ ] D5 执行链路正式化（workflowEngine 服务挂载问题）

## Out of scope

- 桌面客户端
- 跨机器同步模板库
- 修改 harness 核心代码
- 拖拽画布/车道级布线（体验层，P2 不做，可另立）

## 跟踪规则

认领 = 在工单 issue 里 assign 自己；解决 = 工单评论记录「决定 + 理由 + 影响面」并关闭，同时在本文件 Decisions so far 追加一行索引。全部决断后：产出 OpenSpec 提案 → to-tickets 拆执行任务。
