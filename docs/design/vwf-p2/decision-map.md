# P2 决策地图（issue #6 · wayfinder）

## Destination

插件产品化：`dsh plugin add` 可安装、模板跨会话持久、支持动态拆解节点、多工作流并行互不串扰。

## Decisions so far（2026-08-16 全部决断）

- ✅ D1 = **B 受限版「并行子任务节点」**（#9 关闭）：fan-out 节点声明 items 来源，编译为 pipeline/parallel；C 完整动态拆解保留扩展位（同构运行时）。
- ✅ D2 = **阶段式 A→B→C**（#10 关闭）：开发期本地 link（`dsh plugin --profile web add link:`）；稳定后独立仓库 github: 分发；最终注册表。目标 profile=web。
- ✅ D3 = **A storageDomain 宿主域**（#11 关闭）：workflow 域 backend:json（$HOME/.dsh/storages），tables={workflows,runs}。
- ✅ D4 = **A+B 组合 + 三约束**（#12 关闭）：同图多 issue + 多图并行；人工门禁串行裁决、同 taskId 互斥、closeout 串行或 worktree。
- ✅ D5 = **C vwf.script + 平台 workflow 工具**（#13 关闭）：正式执行路径；wf_run 条件注册保留；不实例化引擎。

## Not yet specified

（无——全部决断完成，转入 OpenSpec：specs/vwf-p2/proposal.md）

## Out of scope

- 桌面客户端；跨机器同步模板库；修改 harness 核心；拖拽画布/车道布线（体验层，后置）
