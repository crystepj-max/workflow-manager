# CI 可信度 M2 端口核验：测试注入确定性探针，不依赖宿主机 lsof

| 元数据 | 值 |
|---|---|
| 需求基线版本 | V1 |
| 对应 Issue | github#268（本地轨道 `CHORE-268`） |
| 父票 | github#260 / `CHORE-260`（本票为其规格 §5 子票 3） |
| 优先级 | P1 |
| 前置依赖 | 无 |
| 无人值守许可 | 允许（判据为「探针不可用」条件下 `dev-plugin.test.mjs` 的真实通过数） |
| 定义时间 | 2026-09-21T06:06:53Z |
| 当前状态 | 本地已定义 |
| 分类 / 体量 | 质量收敛 ｜ sized-s |

## 1. 目标与判据

**目标**：消除 CHORE-260 机制表 **M2**——`dev-plugin.test.mjs` 中 2 个用例依赖宿主机 `lsof`，在无该工具的 CI runner 上必失败。

**判据**：把探针强制置为不可用（等价于 runner 环境）后，`dev-plugin.test.mjs` **16/16**。

## 2. 现状与根因

- **现象**：CI ③ 段两项失败，错误原文 `AssertionError: ❌ 无法核验端口 19527 占用情况；已停止，避免误判。`
- **根因**：`scripts/dev-plugin.mjs:44` 的 `lsofBin` 取 `process.env.VWF_DEV_LSOF_BIN || (existsSync('/usr/sbin/lsof') ? '/usr/sbin/lsof' : 'lsof')`；`:164` `listeningProcesses()` 经 `inspect()` spawn 该二进制，**spawn 失败或非 0 退出即返回 `null`**；`:330` `resolvePortState()` 依 fail-closed 设计对 `null` 直接 `fail(...)`，模块顶层（`:536`）即执行。
- **真正的缺口（比父票描述更精确）**：测试文件中 `fakeLsof()` 替身**早已存在**，且**其余用例都已注入** `VWF_DEV_LSOF_BIN`——**唯独失败的那两个用例漏了注入**，于是退化为依赖宿主机真实 `lsof`：有 `lsof` 的机器上真实扫描恰好返回「端口空闲」而通过，无 `lsof` 的 runner 上必然 fail-closed。
- **本票复现**（对照实验）：在未修改的代码上，外层强制 `VWF_DEV_LSOF_BIN=/nonexistent/lsof` 运行 → 16 项中 **2 项失败**（`start：按固定端口启动…`、`start：.agent-runs 下唯一 Run 可推断命名空间…`），与 CI 失败清单逐项一致。

## 3. 修法

在 `baseEnv()` 中**默认注入**确定性的空监听探针，使「不依赖宿主机工具」成为默认行为，而非逐用例的记忆负担：

```js
function baseEnv(extra = {}) {
  return {
    ...process.env,
    VWF_DEV_DSH_PORT: TEST_PORT,
    DSH_HOME: undefined,
    VWF_DEV_LSOF_BIN: defaultLsofProbe(),   // 默认替身；需要特定监听结果的用例在 extra 里覆盖
    ...extra,
  }
}
// defaultLsofProbe()：惰性创建一个空监听结果的假 lsof，全文件共用，process exit 时清理
```

- 漏注入的两个用例**自动修复**，无需逐用例改动。
- 已显式传 `VWF_DEV_LSOF_BIN` 的用例由 `...extra` 覆盖，**行为不变**（含 `stop --all`、端口占用、实例发现等场景）。
- **不改产品代码**：`dev-plugin.mjs` 的 fail-closed 是**正确的产品行为**（宁可停止也不误判），问题只在测试未自足。

## 4. 验收标准

| 编号 | 标准 | 判据 |
|---|---|---|
| AC-1 | runner 等价条件下全绿 | `env VWF_DEV_LSOF_BIN=/nonexistent/lsof node --test scripts/test/dev-plugin.test.mjs` → 16/16（修复前 14/16） |
| AC-2 | 默认环境不回归 | 同命令去掉环境变量 → 16/16 |
| AC-3 | 既有探针场景未被削弱 | 「端口被占用报错」「实例发现」「stop --all」等显式注入用例仍在上述两者中通过 |
| AC-4 | 产品行为不变 | `scripts/dev-plugin.mjs` 相对父提交零 diff（保留 fail-closed） |
| AC-5 | 无同类遗漏 | 全仓仅 `dev-plugin.test.mjs` 引用 `dev-plugin.mjs`，已核 |

## 5. 不做

- 不改 `dev-plugin.mjs`：**不为「测试能过」而放宽 fail-closed**，也不在 CI 侧安装 `lsof`（那会把测试通过继续绑在环境上）。
- 不动该测试文件的其余用例与断言。
- 不在本票处理 M4 / M6 / M7。

未决产品事项：0
