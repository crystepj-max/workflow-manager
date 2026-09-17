# Requirements Analysis · FIX-76（M5 调度器内建登记册对账）

## 1. 背景

M5 夜间批次调度器把"筛选/排序/补位"确定性规则下沉到脚本。其候选采集（`ai-task-candidate-collect.mjs`）产出的候选列表，是后续并发拉起独立会话的唯一输入。候选采集中有一道依赖闸门：依赖任务未合并则排除。

实测与代码审查发现，这道闸门只查登记册 `status`，不查主干 git 事实。而登记册是"投影"，合并事实在 git 历史里，两者靠会话自觉同步，存在滞后窗口。滞后期间，依赖已合并但登记未回写的任务会被整批误排除——这正是 LOC-028 的成因，且在 M5 新链路上会因 `collectLocalCandidates` 的早排除而再次复现。

## 2. 用户/系统需求

| 需求 | 来源 | 说明 |
|---|---|---|
| 依赖判定结合 git 事实 | CHORE-73 规格 §3 | 「依赖任务在登记册已合并，或主干有合并痕迹，即视为满足」 |
| 不破坏既有采集闸门 | 现有测试 `ai-task-candidate-collect-m5.test.mjs` | 状态/run/黑名单/环境组/先导逻辑保持不变 |
| 对账失败不阻断采集 | 稳健性 | `collectMergeFacts` 依赖 git，异常时退化而非崩溃 |

## 3. 现状代码事实

- `registry-reconcile.mjs` 已导出 `collectMergeFacts(repo, baseRef)`：扫描 `main` 提交信息尾部任务号与收口标签 `task/<id>/v*`，返回 `Map<taskId, {commit, mergedAt, via}>`。
- `collectLocalCandidates` 第 99–106 行仅用 `dep.status !== STATUS_MERGED` 判依赖，未消费 `collectMergeFacts`。
- CHORE-73 在 `ai-task-execution-plan.mjs` 的 `assessCandidate` 实现了「看事实」，但 dispatcher 链路先过 `collectLocalCandidates`，依赖未满足者已被早排除，execution-plan 层永远到不了。

## 4. 方案对比

| 方案 | 做法 | 优点 | 风险 |
|---|---|---|---|
| A. 在 candidate-collect 层修（**选定**） | `collectLocalCandidates` 入口算一次 `collectMergeFacts`，依赖判定改双源 | 直击早排除根因；改动最小；与 CHORE-73 规划一致 | 需确认 `collectMergeFacts` 在采集上下文的性能（已复用，成本可忽略） |
| B. 仅依赖 execution-plan 层 | 不动 candidate-collect，指望下游 assessCandidate 纠正 | 改动最少 | 早排除已发生，下游无机会纠正；无效 |
| C. 总控提示词手动对账 | 现状止血方式 | 已验证可行 | 依赖人肉执行，易漏；非根治 |

选定 **方案 A**：与 DT-01 裁定一致。

## 5. 假设与约束

- 假设：依赖任务的 `task_id` 与登记册 `deps` 中记录一致（legacy_id 已在 `byId` 之外另处理，本任务不改）。
- 约束：不引入新依赖、不改 `collectMergeFacts` 签名（仅调用）；不触碰账本写入路径。
- 约束：保持 `ai-task-candidate-collect.mjs` 的「只读、不建现场、不改登记册」职责。

## 6. 验收链路

- 单测：在 `ai-task-candidate-collect-m5.test.mjs` 增加「依赖有 git 合并痕迹、登记未回写 → 依赖方进入候选」用例，以及「依赖无痕迹且未合并 → 仍排除」用例。
- 全量回归：现有测试套件通过（CHORE-73 验收标准含 638/638 全绿基线，本改动不应引入回归）。
