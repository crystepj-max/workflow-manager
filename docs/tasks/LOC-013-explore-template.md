# LOC-013 · 探索 · 多视角正式模板与专家 scratch 隔离

## 任务基本信息

| 字段 | 值 |
|---|---|
| 任务标识 | `LOC-013` |
| 需求来源 | 会话录入 |
| 来源定位 | 2026-09-11 会话：开发计划表 v2（W2，#82 探索） |
| 任务名称 | 探索多视角正式模板与专家 scratch 隔离 |
| 任务类型 | 完整功能开发 |
| 优先级 | P1 |
| 当前状态 | 本地已定义 |
| 需求基线版本 | V1 |
| 前置依赖 | LOC-008（targeted 重算消费依赖失效） |
| 施工环境组 | LOC-013 |
| 施工环境角色 | 独立 |
| 无人值守许可 | 允许 |
| 任务规格位置 | 本卡三要素即基线；实施前如需细化，按 Vn→Vn+1 流程升版 |
| 定义时间 | 2026-09-11 |
| GitHub 同步 | 待补 issue |

## 摘要（三要素速览）

### 任务目标

按规格 §9.4 新增 `templates/explore.json` 并补齐 fanout worker scratch 接线：探索统筹 → 专家研究 Fan-out（3–5）→ 综合分析 → 结论评估。总研究轮次最多 3 轮（含首次 BROAD），最多 2 次自动 `NEEDS_RESEARCH → 统筹` 回退（初次执行不计额度）；第 3 轮仍 `NEEDS_RESEARCH` 时保留该 Outcome 并进入 `WAITING_HUMAN + MAX_ROUNDS_REACHED`，不得为结束流程改写成 `PASS / INSUFFICIENT`；`INSUFFICIENT` 是合法完成类型。

### 涉及范围

- 做：新蓝图（评估节点 `PASS / NEEDS_RESEARCH / INSUFFICIENT`；`NEEDS_RESEARCH → 统筹` 回退边额度语义按规格）；`scripts/generate.mjs` fanout 节点接入 `assembleWorkerContext`（共享冻结 source + 每专家独立 scratch，经 `vwf.workspace.writeWorker/readWorker` 读写，第一轮专家互不可见）；后续研究只做 TARGETED，新证据仅触发依赖它的 Synthesis / Evaluation 重算（消费 LOC-008 `dependsOnStaleInputs`）；行为与隔离测试。
- 不做：Closeout Agent（规格明确不增加）；多数投票式综合；探索 Prompt 素材之外整包 cherry-pick 旧 PR #70（success/failure 路由、旧 10-role registry、旧数量测试禁用）。

### 验收标准

- [ ] 轮次预算 E2E：第 3 轮仍 NEEDS_RESEARCH → `WAITING_HUMAN`，Human Decision 展示三轮研究历史与未解决缺口，原 Outcome 保留
- [ ] 专家 scratch 互不可读（E2E：Expert A 读 Expert B scratch 被拒；aggregator 仍可消费正式结果）
- [ ] 新证据后仅依赖旧证据集合的 Synthesis / Evaluation 被标 stale 并重算，未依赖的兄弟专家结果保留
- [ ] `INSUFFICIENT` 正确落 `completion.type`
- [ ] 正常 / NEEDS_RESEARCH 回退 / 额度耗尽转人工 / INSUFFICIENT 四路径测试绿；`npm run generate`、`npm run validate` 全绿

## 详细规格

产品语义：`docs/design/workflow-manager-v0.1-final-product-spec.md` §9.4（轮次预算已锁定）；workspace 默认 `ISOLATED_READ` + 共享冻结 source + per-worker scratch（`docs/design/workspace-isolation.md` §2/§5/§6.4）；素材边界见 `docs/design/workflow-manager-v0.1-final-product-spec.md` §10。

## 变更记录

| 时间 | 状态 | 说明 |
|---|---|---|
| 2026-09-11 | 本地已定义 | 基线 V1 经用户会话指令确认（开发计划表 v2 落卡） |
