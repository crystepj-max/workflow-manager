# LOC-019 · 内置模板默认模型 DeepSeek 化与异源强弱要求

## 任务基本信息

| 字段 | 值 |
|---|---|
| 任务标识 | `LOC-019` |
| 需求来源 | 会话录入 |
| 来源定位 | 2026-09-13 LOC-014 产品 UAT 验证反馈（用户会话决策） |
| 任务名称 | 内置模板默认模型 DeepSeek 化与异源强弱要求 |
| 任务类型 | 完整功能开发 |
| 优先级 | P1 |
| 当前状态 | 定义中 |
| 需求基线版本 | —（未定稿，走需求分析后定版） |
| 前置依赖 | 无 |
| 施工环境组 | 待分配 |
| 施工环境角色 | 独立 |
| 无人值守许可 | 待定（定稿时确认） |
| 任务规格位置 | 本卡三要素即基线；定稿时按 Vn 流程出详细规格 |
| 定义时间 | 2026-09-13 |
| GitHub 同步 | pending |

## 摘要（三要素速览）

### 任务目标

四套正式内置模板的默认模型绑定全部 DeepSeek 化（开箱即用：DSH 首次启动必须配 DeepSeek APIKEY），异源约束支持**强/弱**两档并可配置；异源要求的相邻节点用不同 model 兜底差异化。

### 涉及范围

- 做：
  1. `templates/*.json` 四套内置模板 `bindings.models` 默认值调整：provider 全部 `deepseek-official`，model 默认 `deepseek-flash`（DeepSeek V4.1 Flash，用户环境已确认有效）；**有异源要求的相邻下一个节点** model 默认 `deepseek-v4-flash`（差异化兜底）；
  2. 异源要求分**强/弱**两档：强 = provider 必须不同（现状）；弱 = 允许相同 provider、不同 model。construction-full-feature 与 diagnose **调整为弱要求**；
  3. 内核异源判定支持弱要求（model 级比较），校验管道同步；
  4. 异源强/弱要求的 **UI 配置入口**（编辑器工作流控制区，与 heteroCheck 开关并列）。
- 不做：运行中异源切换；非内置模板的批量迁移；#79 运行中模型修订路径。

### 验收标准

- [ ] 四套内置模板默认绑定：provider 全 `deepseek-official`、model 全 `deepseek-flash`；异源相邻节点为 `deepseek-v4-flash`（逐模板映射表见详细规格）
- [ ] construction-full-feature / diagnose 的 heteroCheck 为弱要求；同 provider 不同 model 通过校验与运行
- [ ] 强/弱要求可在编辑器 UI 配置并持久化到蓝图
- [ ] 异源违规用例：强要求同 provider 拒绝；弱要求同 provider 不同 model 放行、同 provider 同 model 拒绝
- [ ] 插件包测试 + 根目录 `npm test`、`npm run validate` 全绿

## 详细规格（待需求分析定稿）

未决点（进入需求分析会话时逐项关闭）：
1. "相邻的下一个节点"逐模板映射表（construction-full-feature：dev→review；diagnose：fix→review？需按边表确认）；
2. 弱要求在内核的判定语义（model 不同即满足？与 Outcome Routing 的交互）；
3. UI 配置形态（三态：关/强/弱？）与蓝图 schema 字段（heteroCheck.mode: strong|weak）；
4. 模板真源变更是否同步 `.generated` 产物与已发布 skill（#53 双轨口径）。

## 变更记录

| 时间 | 状态 | 说明 |
|---|---|---|
| 2026-09-13 | 定义中 | 用户在 LOC-014 产品 UAT 反馈中提出并给出核心决策（provider/model 默认值、异源强弱、两模板调弱、UI 配置）；待需求分析会话定稿基线 |
