# CHORE-262 · 本地任务卡

## 任务基本信息

| 字段 | 值 |
|---|---|
| 任务标识 | `CHORE-262` |
| 远端 issue | github#262 |
| 需求来源 | 会话录入：CHORE-260 施工顺序第 1 步（M5 回归） |
| 来源定位 | `github#260` 规格 §5 子票 1；机制清单 M5 |
| 任务名称 | CI 可信度 M5 回归修复：降级告警断言收敛 |
| 任务类型 | 维护性（编号类型 CHORE） |
| 优先级 | P0 |
| 定义时间 | 2026-09-21T04:29:24Z |
| 当前状态 | 本地已定义 |
| 需求基线版本 | V1 |
| 前置依赖 | 无 |
| 施工环境组 | 待定 |
| 施工环境角色 | 独立 |
| 无人值守许可 | 允许 |
| 任务规格位置 | `docs/tasks/specs/CHORE-262-ci-260-m5-warning-assert/task-spec-V1.md` |
| GitHub 同步 | synced#262 |

> 取值约束：`无人值守许可` 只写枚举原值，`GitHub 同步` 只写 `pending` / `synced#N` / `not-applicable`。

## 摘要

未决产品事项：0

### 问题

CHORE-260 机制表 M5：`local-task-registry.test.mjs` 的「gh 不可达时降级 TMP 并告警；全程不产出 cnb# 形式的号（验收 2）」在 CI 上失败，错误原文 `AssertionError: Expected values to be strictly equal`。

**根因（父票 CHORE-260 已实证，本票复核确认）**：该用例断言 `warnings.length === 1`；而 FIX-245 在 `allocate` 的降级路径上新增了「未识别到 agent 身份」告警（`scripts/local-task-registry.mjs:443`，宿主无指纹时触发），同一路径因此产生第二条**正交**告警，打破断言。

**本票复现**：macOS 上 `env -u CLIENT_INFO_IDE_TYPE -u AI_AGENT_NAME node --test scripts/test/local-task-registry.test.mjs` → 16 项中 1 项红；带宿主指纹同命令 → 16 项全绿。故该失败只在无指纹环境暴露（本机默认绿、CI runner 恒红）。

### 处置

把该用例断言由「告警总数恰好 1 条」改为「**降级告警本身**恰好 1 条」（过滤后计数），保留「降级只告警一次」的原意，不再被正交的身份告警打破。**不改产品代码。**

### 本票不做

- 不改 `allocate` 的告警数量或文案（产品侧「每进程只告警一次」被父票规格明确排除在单独修法之外）。
- 不动该测试文件的其他用例，不动任何周边代码。
