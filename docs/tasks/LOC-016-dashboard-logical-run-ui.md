# LOC-016 · 运行看板 Logical Run / 决策卡 / 工作区 UI

## 任务基本信息

| 字段 | 值 |
|---|---|
| 任务标识 | `LOC-016` |
| 需求来源 | 会话录入 |
| 来源定位 | 2026-09-11 会话：开发计划表 v2（W4，#75 UI 适配） |
| 任务名称 | 运行看板 Logical Run 决策卡与工作区 UI |
| 任务类型 | 完整功能开发 |
| 优先级 | P2（L 级；发布必需/可后置拆分在 Definition Check 定） |
| 当前状态 | 本地已定义 |
| 需求基线版本 | V1 |
| 前置依赖 | LOC-011/012/013 定稿（Outcome/Completion 筛选需模板枚举定稿）；#80 落地形态（Guidance/恢复交互） |
| 施工环境组 | LOC-016 |
| 施工环境角色 | 独立 |
| 无人值守许可 | 允许 |
| 任务规格位置 | 本卡三要素即基线；建议 Definition Check 时按"发布必需 / 可后置"拆分排序 |
| 定义时间 | 2026-09-11 |
| GitHub 同步 | 待补 issue |

## 摘要（三要素速览）

### 任务目标

看板与插件 UI 从旧引擎状态升级为三层结果模型呈现（Lifecycle / Node Business Outcome / Completion Type），让人工决策、恢复、隔离状态在界面内完成而不是复制命令。数据侧已就绪：`vwf.logicalRuns.get` RPC 与 logical-runs 持久化（#79）、workspace context 入档（#93）均已落地，客户端目前只显示"第 N 段"徽标。

### 涉及范围

- 做：① Logical Run 详情视图：时间线 / 执行分段 / 快照修订 / 节点业务结果 / 完成类型（消费 `vwf.logicalRuns.get`）；② 结构化人工决策卡：选项点选 + 理由输入 → `decision_id + user_choice` 续跑（替代当前"复制 wf_run 命令"文本）；③ 工作区面板：mode / repository / branch / 当前与 base HEAD / 集成状态 / 活动锁 / 清理状态；④ BLOCKED 恢复引导：改模型表单 → `model_overrides` 续跑同一逻辑运行；⑤ Outcome / Completion 筛选。
- 不做：编辑器改造（LOC-001/005 范围）；新 RPC 与数据契约变更（只消费既有）；Runtime 语义改动。

### 验收标准

- [ ] WAITING_HUMAN 决策卡点选后同一 Run 续跑成功（真机 E2E，含 USER_ACCEPTED / ADD_BUDGET / STOP 与业务 Result）
- [ ] BLOCKED Run 经 UI 修改 Provider/Model 后恢复同一逻辑运行并产生新 Snapshot Revision（真机）
- [ ] Logical Run 视图字段与持久化摘要逐项一致（时间线/分段/快照/业务结果/完成类型）
- [ ] 工作区面板显示与 workspace 注册表实况一致（含集成状态与活动锁）
- [ ] zh/en 文案齐全；插件包测试绿；LOC-005 parity 门禁通过；dist 一致

## 详细规格

产品语义：`docs/design/workflow-manager-v0.1-final-product-spec.md` §3（三层结果模型）/ §11（UI 边界，#75）；呈现要求：一个 Logical Run 跨多段执行仍显示为一个 Run。i18n 沿用 `dist/locales/<locale>.json` 机制。

## 变更记录

| 时间 | 状态 | 说明 |
|---|---|---|
| 2026-09-11 | 本地已定义 | 基线 V1 经用户会话指令确认（开发计划表 v2 落卡） |
