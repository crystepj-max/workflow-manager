# CI 可信度 M3 治理区布局：测试夹具不再落进 /tmp 豁免区

| 元数据 | 值 |
|---|---|
| 需求基线版本 | V1 |
| 对应 Issue | github#264（本地轨道 `CHORE-264`） |
| 父票 | github#260 / `CHORE-260`（本票为其规格 §5 子票 2） |
| 优先级 | P0 |
| 前置依赖 | 无 |
| 无人值守许可 | 允许（判据为两种 TMPDIR 下的真实测试输出，可机器验证） |
| 定义时间 | 2026-09-21T04:39:11Z |
| 当前状态 | 本地已定义 |
| 分类 / 体量 | 质量收敛 ｜ sized-s |

## 1. 目标与判据

**目标**：消除 CHORE-260 机制表 **M3**——`validate-workspace-context.test.mjs` 的 4 个治理区用例在 Linux（`os.tmpdir()` = `/tmp`）上失败、在 macOS 上通过的**环境性差异**。

**判据**：该文件在 `TMPDIR=/tmp` 与默认环境下**均为 7/7**。

## 2. 现状与根因

- **现象**：CI 上 4 项失败——`V-3：主检出不得被当成治理区工作区（D-2/D-3/D-4）`、`V-4：工作树内运行仍校验该工作树自身`、`V-5：外部运行时工作区（.codex/worktrees）只计警告不计失败`、`V-8 / R-8：D-10 无法核验的终态任务一律显式标注，且不计失败`；本机 macOS 全绿。
- **根因**：`scripts/validate-workspace.mjs:50` 的 `EXEMPT_ABS_PREFIXES = ['/private/tmp/', '/tmp/']` 把 `/tmp` 全域划为**例外区**（`scopeOfPath` → `'external'`，违规只计警告）；而夹具以 `os.tmpdir()` 为根建临时仓库——macOS 落在 `/var/folders/…`（判治理区，用例通过），Linux 落在 `/tmp`（判例外区，4 个用例失败）。
- **本票复现**：
  ```bash
  TMPDIR=/tmp node --test scripts/test/validate-workspace-context.test.mjs
  # 修复前：7 tests / 3 pass / 4 fail（与 CI 输出逐项一致）
  ```

## 3. 修法

夹具根从 `os.tmpdir()` 改为**平台无关的确定路径**——仓库内被 Git 忽略的 `.scratch/ws-ctx-fixtures/`：

```js
const FIXTURE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.scratch', 'ws-ctx-fixtures')
// fixture()：fs.mkdirSync(FIXTURE_ROOT, { recursive: true })
//            const base = fs.mkdtempSync(path.join(FIXTURE_ROOT, 'ws-ctx-'))
```

- 夹具不再落进任何豁免前缀或豁免区段，判定稳定为**治理区**。
- 用例内构造的「例外区」样本（`…/.codex/worktrees/…`）仍由 `EXEMPT_PATH_SEGMENTS` 命中，**V-5 的语义不受影响**。
- 顺带移除因此不再使用的 `node:os` import。
- **不改产品代码**，不删豁免前缀（父票明令禁止「删豁免修绿」）。

## 4. 验收标准

| 编号 | 标准 | 判据 |
|---|---|---|
| AC-1 | Linux 语义下全绿 | `env TMPDIR=/tmp node --test scripts/test/validate-workspace-context.test.mjs` → 7/7 |
| AC-2 | 默认环境不回归 | 同命令去掉 `TMPDIR=/tmp` → 7/7 |
| AC-3 | 例外区语义未被削弱 | 「例外区只计警告」用例（V-5）在 AC-1 / AC-2 两种条件下均通过 |
| AC-4 | 产品行为不变 | `scripts/validate-workspace.mjs` 与 `scripts/workspace-convention-core.cjs` 相对父提交零 diff |
| AC-5 | 无工作区残留 | 跑完整文件后 `git status` 无新增未跟踪项（夹具落在已忽略的 `.scratch/`） |

## 5. 不做

- 不动豁免前缀 / 区段常量，不通过放宽防护「修绿」。
- 不动该测试文件的用例语义、断言与其他代码。
- 不在本票处理 M2 / M4 / M6 / M7（父票其余子票各自独立）。

未决产品事项：0
