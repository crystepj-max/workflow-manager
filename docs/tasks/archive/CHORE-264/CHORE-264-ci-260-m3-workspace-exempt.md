# CHORE-264 · 本地任务卡

## 任务基本信息

| 字段 | 值 |
|---|---|
| 任务标识 | `CHORE-264` |
| 远端 issue | github#264 |
| 需求来源 | 会话录入：CHORE-260 施工顺序第 2 步（M3 治理区布局） |
| 来源定位 | `github#260` 规格 §5 子票 2；机制清单 M3 |
| 任务名称 | CI 可信度 M3 治理区布局：测试夹具不再落进 /tmp 豁免区 |
| 任务类型 | 维护性（编号类型 CHORE） |
| 优先级 | P0 |
| 定义时间 | 2026-09-21T04:39:11Z |
| 当前状态 | 本地已定义 |
| 需求基线版本 | V1 |
| 前置依赖 | 无 |
| 施工环境组 | 待定 |
| 施工环境角色 | 独立 |
| 无人值守许可 | 允许 |
| 任务规格位置 | `docs/tasks/specs/CHORE-264-ci-260-m3-workspace-exempt/task-spec-V1.md` |
| GitHub 同步 | synced#264 |

> 取值约束：`无人值守许可` 只写枚举原值，`GitHub 同步` 只写 `pending` / `synced#N` / `not-applicable`。

## 摘要

未决产品事项：0

### 问题

CHORE-260 机制表 M3：`validate-workspace-context.test.mjs` 的 4 个治理区用例在 CI 上失败（`治理区违规仍应报出` / `D-2 应报出目录名 ≠ 分支名` / `治理区 B 的违规应仍判失败` / 断言得到 `[]`），而本机 macOS 上全绿。

**根因（父票已实证，本票复核）**：`scripts/validate-workspace.mjs:50` 的 `EXEMPT_ABS_PREFIXES = ['/private/tmp/', '/tmp/']` 把 `/tmp` 全域划为**例外区**（违规只计警告、不计失败）；而测试夹具以 `os.tmpdir()` 为根建临时仓库——macOS 的 `os.tmpdir()` 是 `/var/folders/…`（**不在**豁免前缀内，判治理区，用例通过），Linux runner 的 `os.tmpdir()` 就是 `/tmp`（**落在**豁免前缀内，违规全体降级为警告，4 个用例失败）。

**本票复现**：`TMPDIR=/tmp node --test scripts/test/validate-workspace-context.test.mjs` → 7 项中 **4 项失败**，与 CI 输出逐项吻合；默认环境 7/7 绿。

### 处置

夹具根改为**平台无关、确定不在豁免区**的路径（仓库内被 Git 忽略的 `.scratch/ws-ctx-fixtures/`），不再依赖宿主 `tmpdir()`；顺带移除因此失效的 `node:os` import。**不改产品代码**，不删豁免前缀。

### 本票不做

- 不动 `EXEMPT_ABS_PREFIXES` / `EXEMPT_PATH_SEGMENTS`——删豁免会削弱真实防护，父票明令禁止。
- 不动该测试文件的用例语义、断言与周边代码。
