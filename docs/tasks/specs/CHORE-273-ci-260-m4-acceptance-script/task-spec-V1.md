# CI 可信度 M4 机械验收：为 CI 提供可对账环境（完整克隆 + main 引用）

| 元数据 | 值 |
|---|---|
| 需求基线版本 | V1 |
| 对应 Issue | github#273（本地轨道 `CHORE-273`） |
| 父票 | github#260 / `CHORE-260`（本票为其规格 §5 子票 4） |
| 优先级 | P1 |
| 前置依赖 | 无 |
| 无人值守许可 | 允许（判据为 CI 上 `validate` ③ 段的真实运行输出） |
| 定义时间 | 2026-09-21T06:25:14Z |
| 当前状态 | 本地已定义 |
| 分类 / 体量 | 质量收敛 ｜ sized-s（取证先行） |

## 1. 目标与判据

**目标**：消除 CHORE-260 机制表 **M4**——`M4 机械验收脚本通过` 在 CI 上失败。

**判据**：CI `validate` 的 ③ 段输出 `✅ 引擎层测试全绿`。

## 2. 取证（父票要求「先取证再动手」，本票严格执行）

### 2.1 先纠正一项既有误判

父票把 M4 记为「待定位」，本会话早前又一度据两次 run 推断为「间歇性（flaky）」。**两者都不准确**。回看全部可用数据，M4 是**由事件类型决定**的确定性失败：

| CI 触发 | 场景 | M4 |
|---|---|---|
| `push` → `main`（`f0d95202`） | 本地有 `main` | **无 M4** |
| `pull_request`（PR #263 / #265 / #269） | PR merge ref | **有 M4** |
| `push` → `main`（`f089e4b6`） | 本地有 `main` | **无 M4** |

### 2.2 CI 侧取回完整输出（临时诊断分支）

`scripts/validate.mjs:113` 的 `summarizeTestFailure` 会把失败明细裁剪，故先在临时诊断分支 `diag/ci-260-m4-probe` 上取回原始输出：

```
===== 1) 直接跑 M4 检查脚本 =====
M4 检查失败：
 - 报告须含批次前对账段（CHORE-73）

===== 2) 报告原文 =====
【批次前对账（CHORE-73）】
对账失败（不阻塞批次）：Command failed: git -C ... log main --date=iso-strict --format=%H%x09%aI%x09%s
fatal: ambiguous argument 'main': unknown revision or path not in the working tree.

===== 3) 直接探 reconcilePlan =====
PLAN THREW: Error: Command failed: git ... log main ...

===== 4) git 环境 =====
shallow=true
git rev-parse --verify main        → fatal: Needed a single revision
git rev-parse --verify origin/main → fatal: Needed a single revision
```

### 2.3 根因（证据链闭合）

1. `actions/checkout@v4` 默认 **`fetch-depth: 1`**（浅克隆）；PR 事件下 checkout 的是 merge ref；
2. 于是 `main` 与 `origin/main` 引用**都不存在**（`shallow=true`，两个 `rev-parse` 均失败）；
3. `registry-reconcile.mjs:46` 的 `collectMergeFacts(repo, baseRef)` 首行即执行 `git log main ...`（**未捕获**）→ 抛 `fatal: ambiguous argument 'main'`；
4. `ai-task-scheduled-trigger.mjs:133` 的 catch 把它降级为 `对账失败（不阻塞批次）：…`（这是**产品明确设计的降级文案**，line 113 注释即声明「对账失败不阻塞批次」）；
5. `ai-task-scheduled-m4-check.mjs:95` 的断言要求 `/【批次前对账（CHORE-73）】/ && /对账：/`——**降级文案不含「对账：」**，故失败。

**结论**：这不是被测产品缺陷，而是 **CI 环境欠缺对账所需的前提**（完整历史 + 主干引用）。

## 3. 修法

在 `.github/workflows/validate.yml` 提供可对账环境：

```yaml
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0          # 对账需读主干合并历史
      - name: 确保 main 引用可用（对账读主干事实所需）
        run: git rev-parse --verify --quiet main || git fetch --no-tags origin main:refs/heads/main
```

- **不改任何测试断言**——保持机械验收原有的检查力（仍严格要求对账段含成功结论）；
- **不改产品代码**——`collectMergeFacts` 的 fail-fast 与 trigger 的「不阻塞批次」降级均保留原语义；
- 该步骤幂等：`main` 已存在（push 场景）时不执行 fetch。

### 修法验证（同一诊断分支）

```
===== 2) 报告原文 =====        【批次前对账（CHORE-73）】/ 对账：账实一致，无需回写
===== 3) =====                  PLAN OK toMerge=0 suspicious=17
===== 4) =====                  shallow=false
—— ③ 引擎层测试 ——              ✅ 引擎层测试全绿
```

## 4. 验收标准

| 编号 | 标准 | 判据 |
|---|---|---|
| AC-1 | CI 引擎层全绿 | CI `validate` ③ 段输出 `✅ 引擎层测试全绿` |
| AC-2 | 对账真实走成功路径 | CI 日志中报告为「对账：…」而非「对账失败（不阻塞批次）」 |
| AC-3 | 断言检查力不削弱 | `ai-task-scheduled-m4-check.mjs` 的断言相对父提交零 diff |
| AC-4 | 产品行为不变 | `registry-reconcile.mjs` / `ai-task-scheduled-trigger.mjs` 相对父提交零 diff |
| AC-5 | push 场景不回归 | `main` 场景本就通过；新增步骤在该场景为 no-op（幂等） |

## 5. 不做

- 不放宽 M4 检查脚本的断言（**不把「对账失败」也算通过**——那等于用降级分支伪装绿）。
- 不改 `collectMergeFacts` 的 fail-fast（把「主干不可得」静默当「账实一致」会产生**假绿**，比红灯更危险）。
- 不动 M6 / M7。

未决产品事项：0
