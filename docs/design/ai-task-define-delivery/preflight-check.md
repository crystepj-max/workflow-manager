# 实施前检查清单（M2）

> 交付从「已定义」开工前的硬门禁。权威流程见 `single-task-delivery-m2.md`。  
> 机械检查：`node scripts/ai-task-preflight-check.mjs <issue-basics.md> <task-spec.md> [--run-baseline Vn]`

## 检查表

- [ ] 当前状态 = **已定义**
- [ ] 无人值守许可 = **允许**
- [ ] 需求基线版本已填写（如 V1）
- [ ] 任务规格位置指向可读的本地规格文件
- [ ] 本地规格版本号与 Issue「需求基线版本」一致
- [ ] （若已启动 Run）Run 绑定版本与 Issue 一致
- [ ] 前置依赖 = **无**（V0.1；有依赖则阻断自动交付）
- [ ] 规格中未决产品事项 = **0** / Definition Check 已通过声明存在
- [ ] 优先级 ∈ {P0, P1, P2}
- [ ] 定义时间已填写

## 失败动作

```text
任务状态 → 执行受阻
Run → BLOCKED
记录明确原因
释放并发名额
停止施工（禁止跳过门禁）
```
