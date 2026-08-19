# 05 · 真实 issue 端到端试跑

## 目标
用 P0 原型对一个真实 GitHub issue（本仓库，含三要素）全流程试跑：
- 默认模板「开发工作流 2.0」，models 按异源分配（dev=deepseek v4-pro / review=kimi k3 / kimi 不可用走 DeepSeek 兜底）
- 全程验证：调度 schema 闸门 → 开发（分支/提交）→ 测试（按图分流）→ 审核 → 人工验收暂停（用户裁决）→ 收口（推送/合并 PR/关闭 issue）
- 产出：`.agent-runs/<task>/` 六份报告 + STATE.md；issue 关闭

## 验收
- 验收标准 4 + 5 全绿：报告齐全、人工门禁生效、PR/issue 收口闭环、异源分配生效
- 记录试跑发现并回填（README/子任务）

## 依赖
04
