# CI 可信度 M6 挂钟依赖：断言改为业务事实 + 阈值可注入

| 元数据 | 值 |
|---|---|
| 需求基线版本 | V1 |
| 对应 Issue | github#276（本地轨道 `CHORE-276`） |
| 父票 | github#260 / `CHORE-260`（本票为其规格 §5 子票 5） |
| 优先级 | P2 |
| 前置依赖 | 无 |
| 无人值守许可 | 允许（判据为本地双态验证 + 注入对照实验，均可机器复现） |
| 定义时间 | 2026-09-21T11:01:55Z |
| 当前状态 | 本地已定义 |
| 分类 / 体量 | 质量收敛 ｜ sized-m |

## 1. 目标与判据

**目标**：消除 CHORE-260 机制表 **M6**——闸门内的挂钟硬阈值。它们**当前未红**，但会在 2 核 CI runner 上把偶发慢变成假失败。

**为何必须在设为「必需状态检查」前解决**：假超时会让 `validate` 变成**误报源**；一旦设为必需检查，误报会直接阻塞合并，比红灯更伤信任。

**判据**：
1. 目标文件在默认环境下全绿；
2. 挂钟阈值改为可注入后，**注入极端值能复现超时**（证明注入真实生效，而非摆设）。

## 2. 现状（4 处）

| # | 位置 | 形态 | 处置 |
|---|---|---|---|
| 1 | `scripts/test/ai-task-night-dispatch-m5.test.mjs:137` | `assert.ok(elapsed < 20_000, …)` | **改为业务事实断言** |
| 2 | 同文件 `:67` | `spawnSync(…, { timeout: 60_000 })` | 可注入 + 默认给足余量 |
| 3 | 同文件 `:130` | `watchdogMinutes: 0.03`（≈1.8s） | 保留（夹具输入），加注释 |
| 4 | `packages/dsh-visual-workflow/tests/evaluation-baseline-runtime.test.mjs:48` | `until(…, ms = 8000)` + 5ms 轮询 | 上界与轮询均可注入 |

**关键发现**：`scripts/ai-task-dispatcher.mjs:490` 原本已有 `entry.watchdogFired = true`，但**从未被任何代码读取**——是死代码。这说明「看门狗是否触发」这一业务事实没有出口，因此用例只能靠挂钟间接推断。

## 3. 修法

### 3.1 把业务事实变成可断言输出（① 治本）

`ai-task-dispatcher.mjs`：

```js
const watchdogFired = new Set()   // 与 children/launched 并列
// watchdogFire(taskId) 内：
watchdogFired.add(taskId)         // 原为 entry.watchdogFired = true（死字段）
// real 模式输出新增：
watchdogFired: [...watchdogFired],
```

测试断言随之从「耗时 < 20s」改为直接验证事实：

```js
assert.deepEqual(out.watchdogFired, ['FIX-A'], '看门狗须记录触发事实')
```

**为何更精确**：会话 `hang: true` 时看门狗是唯一终止手段，故「看门狗触发」既是**必要条件**也是**充分条件**；而挂钟阈值只是它的一个概率性代理。

### 3.2 阈值可注入（② 消除环境敏感）

| 环境变量 | 默认 | 覆盖对象 |
|---|---|---|
| `VWF_TEST_TIMEOUT_MS` | `120_000`（原 60_000） | 调度器子进程硬超时（仅兜底「测试挂死」） |
| `VWF_TEST_UNTIL_MS` | `30_000`（原 8_000） | EB 运行时测试的轮询上界 |
| `VWF_TEST_POLL_MS` | `5` | EB 运行时测试的轮询间隔 |

### 3.3 `watchdogMinutes: 0.03` 保留

它只是「让看门狗尽快触发」的**夹具输入**，不是断言。依赖 3.1 的业务事实断言后，其数值不再承担时序判定职责（已加注释说明）。

## 4. 验收标准

| 编号 | 标准 | 判据 |
|---|---|---|
| AC-1 | M5 调度测试全绿 | `node --test scripts/test/ai-task-night-dispatch-m5.test.mjs` → 6/6 |
| AC-2 | EB 运行时测试全绿 | `cd packages/dsh-visual-workflow && node --test tests/evaluation-baseline-runtime.test.mjs` → 9/9 |
| AC-3 | 看门狗改为业务断言 | 该文件内已无 `elapsed <` / `Date.now() - t0` 形态的挂钟断言 |
| AC-4 | **注入真实生效**（对照实验） | `VWF_TEST_UNTIL_MS=1` → 出现 `until 超时：…`；`VWF_TEST_TIMEOUT_MS=1` → 6 项全失败 |
| AC-5 | 看门狗事实可观测 | dispatcher 输出含 `watchdogFired`，且用例在会话恒挂时能断言到它 |
| AC-6 | 控制流/语义不变 | `ai-task-dispatcher.mjs` 无新增分支或行为改变，仅新增输出字段 + 移除死字段 |

## 5. 不做

- **不删除检查意图**：挂钟断言换成更精确的业务事实断言，不是放宽检查。
- 不动 dispatcher 的控制流与调度语义。
- 不在本票处理 M7（基准产物）。

未决产品事项：0
