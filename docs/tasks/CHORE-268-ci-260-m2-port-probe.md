# CHORE-268 · 本地任务卡

## 任务基本信息

| 字段 | 值 |
|---|---|
| 任务标识 | `CHORE-268` |
| 远端 issue | github#268 |
| 需求来源 | 会话录入：CHORE-260 施工顺序第 3 步（M2 端口核验） |
| 来源定位 | `github#260` 规格 §5 子票 3；机制清单 M2 |
| 任务名称 | CI 可信度 M2 端口核验：测试注入确定性探针，不依赖宿主机 lsof |
| 任务类型 | 维护性（编号类型 CHORE） |
| 优先级 | P1 |
| 定义时间 | 2026-09-21T06:06:53Z |
| 当前状态 | 本地已定义 |
| 需求基线版本 | V1 |
| 前置依赖 | 无 |
| 施工环境组 | 待定 |
| 施工环境角色 | 独立 |
| 无人值守许可 | 允许 |
| 任务规格位置 | `docs/tasks/specs/CHORE-268-ci-260-m2-port-probe/task-spec-V1.md` |
| GitHub 同步 | synced#268 |

> 取值约束：`无人值守许可` 只写枚举原值，`GitHub 同步` 只写 `pending` / `synced#N` / `not-applicable`。

## 摘要

未决产品事项：0

### 问题

CHORE-260 机制表 M2：`dev-plugin.test.mjs` 的 2 个用例在 CI 上失败，错误原文 `❌ 无法核验端口 19527 占用情况；已停止，避免误判。`——本机 macOS 通过、Linux runner 必失败。

**根因**：`scripts/dev-plugin.mjs:44` 的 `lsofBin` 取宿主机 `lsof`；`:164` `listeningProcesses()` 在 spawn 失败时返回 `null`；`:330` `resolvePortState()` 依 **fail-closed 设计**（正确的产品行为）直接中止，且在模块顶层（`:536`）执行。

**真正的缺口（比父票陈述更精确）**：测试侧 `fakeLsof()` 替身**早已存在**，其余用例**都已注入** `VWF_DEV_LSOF_BIN`——**唯独这 2 个用例漏了注入**，于是退化为依赖宿主机工具：有 `lsof` 时真实扫描恰好返回「端口空闲」而通过，runner 无 `lsof` 时必然中止。

**本票复现**：未修改的代码 + 强制 `VWF_DEV_LSOF_BIN=/nonexistent/lsof` → 16 项中 2 项失败，与 CI 清单逐项吻合。

### 处置

在 `baseEnv()` 中**默认注入**确定性的空监听探针，使「不依赖宿主机工具」成为默认行为；已显式注入的用例经 `...extra` 覆盖，行为不变。**不改产品代码**，不放宽 fail-closed，也不在 CI 装 `lsof`。

### 本票不做

- 不动 `dev-plugin.mjs`（fail-closed 正确，问题在测试未自足）。
- 不动该测试文件的其余用例与断言。
