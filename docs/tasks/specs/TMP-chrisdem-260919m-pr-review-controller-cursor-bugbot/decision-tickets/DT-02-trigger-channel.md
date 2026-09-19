# DT-02 · 触发通道：评论 `@cursor review` vs 官方 API `POST /bugbot/review`

**性质**：产品选择。本任务书范围＝"把触发评论正文前缀换为 `@cursor review`"，故**已按评论通道实现**；API 通道作更稳备选呈递。

## 背景与关键不确定性

- 评论通道：Bugbot 触发靠 PR 评论里出现 `@cursor review`，官方明确支持。但**评论由谁发出**是否被接受，官方零承诺；且 Team/Enterprise 有按 SCM username 匹配的 Bugbot 席位 allowlist/blocklist，`github-actions[bot]` 在 allowlist 模式下几乎必然不在名单 → 表现为"评论发了、没反应、不报错"的静默失效。现有架构已用**独立触发身份 Secret**（非 actions 身份）发评论，正是这一风险的规避姿态。
- API 通道：`POST https://api.cursor.com/bugbot/review`，用 Team Admin API Key（`admin:*` scope），身份=团队 Key，不依赖任何评论者身份、不受席位/名单影响，异步起评审；限流 30 次/分钟/团队；返回 request_id（可做闭环证据）。未连接/未启用仓库会显式 `400 Bad Request`（比评论方式更可观测）。

## 选项

| 选项 | 内容 | 收益 | 代价 / 风险 |
|---|---|---|---|
| **(a) 评论触发 + 独立触发身份**（当前实现） | Controller 用 `PR_REVIEW_TRIGGER_TOKEN` 身份发 `@cursor review` | 改动最小、与 Codex 时代架构同构、无需新增 API 依赖 | 依赖"该 PAT 身份被 Bugbot 接受"，官方未确认，可能静默失效 |
| (b) 改调官方 API 触发 | Controller 直接 `POST /bugbot/review`（`prUrl`） | 不依赖评论者身份、显式报错、有 request_id 可审计 | 需 `admin:*` API Key Secret；改触发实现；限流/计费口径不同；偏离本任务书范围 |
| (c) 双通道 | 评论为主、失败即回退 API | 韧性最高 | 复杂、两套语义并存、额度归属更难对齐 |

## 推荐

**先按 (a) 做一次真实冒烟**：用户配好 Cursor 集成、关自动评审（`manualTriggerOnly`）、配 `PR_REVIEW_TRIGGER_TOKEN`（一个已连接该仓库、且在 Bugbot 名单内的账号 PAT）后，在开放 PR 上先发 `cursor review verbose=true` 观察加载了哪些规则、有无响应。
- 若 Bugbot 确实起评审 → 维持 (a)，成本最低。
- 若"发了评论但无评审、无报错"= 命中身份静默失效 → 转 (b)，把触发换成 API（与 Codex 当时"用独立身份 Secret"的处置同构，只是这次直接走不依赖评论者身份的官方 API）。

即：**(a) 起步，(b) 作为身份被拒时的确定退路**；不预置 (c)。

## 待产品/用户填写

- 冒烟结果：____（起评审 / 静默失效 / 报错）
- 决策：____（维持 a / 转 b / 其他）
- 裁定人 / 时间：____
