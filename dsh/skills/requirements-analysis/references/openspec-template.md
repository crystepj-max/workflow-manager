# OpenSpec Proposal 模板

L 型需求（size = sized-l）在 wayfinder 拆出决策地图后，必须按本模板产出 OpenSpec 提案，落盘到 `specs/<slug>/proposal.md`。

- `slug`：需求主题的 snake_case 短名（如 `order-service-split`）
- 变更清单（Changes）里的路径为相对仓库根的路径，只写模块/目录级别，不写具体行号（易过期）

## 模板

```markdown
## OpenSpec

<!-- 本提案的全局唯一标识，如 order-service-split -->

## Problem Statement

<!-- 用户当前面临的问题，从用户视角描述，不涉及方案。 -->
<!-- 例：订单服务耦合支付、库存、物流逻辑，单次发布需要三端联调，线上事故定位困难。 -->

## Proposed Solution

<!-- 解决方案的高层描述，从用户视角说明改完后体验/行为如何变化。 -->
<!-- 例：将订单系统拆分为订单、支付、库存、物流四个独立服务，服务间通过事件异步通信，各服务独立发布。 -->

## Changes

<!-- 文件/模块级变更清单，逐条列出：路径 + 变更类型 + 一句话说明 -->
<!-- change-type: create | modify | delete -->

- `services/order/`: modify — 订单核心逻辑收敛，移除对支付/库存的直接调用
- `services/payment/`: create — 新建支付服务，承接支付流程
- `services/inventory/`: create — 新建库存服务，承接库存扣减
- `services/logistics/`: create — 新建物流服务，承接履约跟踪
- `shared/events/`: create — 事件总线与领域事件定义

## Test Plan

<!-- 如何验证本提案落地成功：可操作、可验证、可复现的验证步骤 -->
<!-- 例：四服务各自独立部署后可互相通过事件完成一单完整下单链路；单服务故障不影响其他服务下单查询。 -->

## Risks & Open Questions

<!-- 风险与尚未决断的问题；标出哪些阻塞实施、哪些可并行 -->
<!-- 例：[阻塞] 支付回调幂等方案未定；[可并行] 库存热 key 的缓存策略 -->
```

## 使用要点

- **先 wayfinder 后 OpenSpec**：地图的决策工单逐条解决、路径清晰后，才把结论综合进 proposal；不跳过探路直接写方案
- **Changes 只列模块级**：不写具体文件行号或代码片段，避免过期
- **Test Plan 必须可执行**：验收标准要能对应到验证步骤，与三要素中的「验收标准」保持一致口径
- **Open Questions 要标阻塞关系**：区分「阻塞实施」与「可并行」，供后续 to-tickets 拆任务时排依赖
