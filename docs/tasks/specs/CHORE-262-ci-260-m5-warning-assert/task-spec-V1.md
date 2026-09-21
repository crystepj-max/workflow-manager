# CI 可信度 M5 回归修复：降级告警断言收敛

| 元数据 | 值 |
|---|---|
| 需求基线版本 | V1 |
| 对应 Issue | github#262（本地轨道 `CHORE-262`） |
| 父票 | github#260 / `CHORE-260`（本票为其规格 §5 子票 1） |
| 优先级 | P0 |
| 前置依赖 | 无 |
| 无人值守许可 | 允许（判据为双环境下的真实测试输出，可机器验证） |
| 定义时间 | 2026-09-21T04:29:24Z |
| 当前状态 | 本地已定义 |
| 分类 / 体量 | 质量收敛 ｜ sized-xs |

## 1. 目标与判据

**目标**：消除 CHORE-260 机制表 **M5**——`local-task-registry.test.mjs` 的降级告警用例在宿主无指纹环境下失败（CI runner 恒无指纹，故 CI 恒红）。

**判据**：该文件在**有宿主指纹**与**无宿主指纹**两种环境下均 **16/16** 通过。

## 2. 现状与根因

- **现象**：CI `validate` ③ 段报 `scripts/test/local-task-registry.test.mjs:179:1` 失败，错误原文 `AssertionError: Expected values to be strictly equal`。
- **根因**（父票已实证、本票复核）：该用例断言 `warnings.length === 1`（意在证明「降级只告警一次、无额外噪声」）；而 FIX-245 在 `allocate` 降级路径上新增「未识别到 agent 身份」告警（`scripts/local-task-registry.mjs:443`），同一路径因此产生**第二条正交告警**。
- **环境相关性**：macOS 会自报宿主指纹（`CLIENT_INFO_IDE_TYPE`），身份告警不触发 → 本机默认 16/16 绿；CI runner 无指纹 → 16/15 → 红。故该失败此前被误判为「既存失败、非本票引入」。
- **本票复现**：
  ```bash
  env -u CLIENT_INFO_IDE_TYPE -u AI_AGENT_NAME node --test scripts/test/local-task-registry.test.mjs
  # 修复前：16 tests / 15 pass / 1 fail
  ```

## 3. 修法

把断言由「告警**总数**」改为「**降级告警**计数」：

```js
// 断言「恰好一条降级告警」：同一路径还可能出现正交的「未识别到 agent 身份」告警
// （宿主无指纹时由 FIX-245 引入），故按降级告警本身计数，不再对告警总数设死值（CHORE-260 · M5）。
const degradeWarnings = warnings.filter((w) => /已降级为临时号/.test(w))
assert.equal(degradeWarnings.length, 1)
```

- 保留原意：降级路径**恰好产生一条降级告警**。
- **不改产品代码**，不通过放宽产品行为或删告警「修绿」。
- 该用例原 `assert.match(warnings[0], /已降级为临时号/)` 的语义被过滤后计数覆盖，故一并收拢为单条断言。

## 4. 验收标准

| 编号 | 标准 | 判据 |
|---|---|---|
| AC-1 | 无指纹环境全绿 | `env -u CLIENT_INFO_IDE_TYPE -u AI_AGENT_NAME node --test scripts/test/local-task-registry.test.mjs` → 16/16 |
| AC-2 | 有指纹环境不回归 | 同命令去掉两个 `-u` → 16/16 |
| AC-3 | 相邻用例不受影响 | `node --test scripts/test/agent-identity.test.mjs` → 9/9 |
| AC-4 | 产品行为不变 | `scripts/local-task-registry.mjs` 相对父提交 **零 diff** |

## 5. 不做

- 不改 `allocate` 的告警数量、文案或触发条件（产品侧「每进程只告警一次」被父票规格排除在单独修法之外）。
- 不动该测试文件的其他用例，不动任何周边代码。
- 不在本票处理 M3 / M2 / M4 / M6 / M7（父票其余子票各自独立）。

未决产品事项：0
