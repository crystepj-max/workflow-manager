# preflight 资格校验结构化接口化

| 元数据 | 值 |
|---|---|
| 需求基线版本 | V1 |
| 对应 Issue | （GitHub 恢复后补建） |
| 优先级 | P2 |
| 前置依赖 | LOC-002 |
| 无人值守许可 | 允许 |
| 定义时间 | 2026-09-09T16:05:00Z |
| 当前状态 | 待确认（本地轨道） |

## 1. 需求背景
架构评审候选 3：preflight（交付开工硬门禁，179 行）只能以子进程 + 退出码消费（import 即执行并 exit），结构化结果被最大调用方 execution-plan 丢弃并用 module 自行重解析字段。

## 2. 用户问题
批量调度每个候选启动一次 Node 冷启动子进程；校验规则只能 spawn 间接测试；stderr 文本成了隐性契约。

## 3. 目标
校验逻辑成为可导入 module：`runPreflight(...)` 返回结构化结果（ok / failures / 字段提取结果）；CLI 退为薄 adapter，退出码与 stderr 语义不变；execution-plan 批量筛选改进程内 import。

## 4. 非目标
- 不改 preflight 的校验规则本身；不改 `--run-baseline V1` 在 assess 的硬编码语义（已知限制，另行登记）
- 不改 m2-check 的子进程硬门禁形态（产品语义保留）
- 不动 scheduled-trigger

## 5. 修改前
preflight 顶层脚本无 main guard，import 即执行；execution-plan `assess()` spawnSync 每候选一次并自行 `field()` 重读 issue 文件。

## 6. 修改后
preflight 文件内导出 `runPreflight`（async，含原有全部规则与结构化返回），CLI 逻辑置于 main guard；execution-plan 进程内调用并直接消费结构化结果（删除其对 issue 文件的二次读取）。

## 7. 功能范围
1. preflight：export `runPreflight(issuePath, specPath, opts)` + main guard 化 CLI。
2. execution-plan：`assess()` 改 import 调用；spawnSync 调用删除。
3. 测试：新增 runPreflight 直测；既有测试不改断言。

## 8. 不修改范围
校验规则、退出码契约（0/1/2）、stderr 文案、m2-check、trigger、LOC-001 在途文件。

## 9. 业务规则
1. CLI 行为逐字节兼容：通过 = stdout JSON + exit 0；受阻 = stderr 列表 + stdout JSON + exit 1；用法错误 exit 2。
2. `runPreflight` 不调用 `process.exit`；结果对象即 CLI 现有 JSON 结构（+failures）。
3. m2-check 继续以子进程调用 preflight（独立进程硬门禁语义）。

## 10. 用户操作路径
无用户可见变化；开发者以 `import { runPreflight }` 直测校验规则。

## 11. 异常和边界场景
- 文件缺失：runPreflight 返回 ok:false + failures（不抛出）；CLI 路径同现状。
- preflight 顶层原有 `await import('./ai-task-workspace-env.mjs')`：移入 runPreflight 内保持惰性。

## 12. 已确认的关键决策及原因

| 决策主题 | 选择 | 原因 | 确认人 | 确认时间 |
|---|---|---|---|---|
| module 形态 | preflight 文件内导出 + main guard（不新建文件） | 分发清单零变化；单文件语义完整 | Agent（施工方式，§2.2） | 2026-09-09 |
| execution-plan 消费方式 | 进程内 import | 消除冷启动与双份解析；行为等价 | Agent（施工方式，§2.2） | 2026-09-09 |
| 发布轨道 | 本地轨道 | GitHub 停用 | 用户 | 2026-09-09 |
| 无人值守 / 优先级 | 允许 / P2 | 机械重构、验收机械可判定 | 用户（批量授权） | 2026-09-09 |

## 13. 功能切片关系
单切片；前置依赖 LOC-002（同文件演进，栈式分支）。

## 14. 前置依赖说明
```text
前置依赖：LOC-002
```

## 15. 验收条件
- [ ] worktree 内 `node -e "import('./scripts/ai-task-preflight-check.mjs').then(m=>console.log(typeof m.runPreflight))"` 输出 function 且进程不退出
- [ ] `runPreflight` 直测覆盖通过 / 受阻 / 文件缺失三态
- [ ] execution-plan 源码无 `spawnSync(...preflight...)`；m3 批量测试不改断言全绿
- [ ] preflight-local-track 全部既有测试不改断言全绿
- [ ] `npm test` 与 `npm run validate` 全绿

## 16. UAT 场景
### UAT-01 接口化机械验收
- 操作：上述验收条件逐条执行；预期全部满足。

## 17. 风险
preflight 顶层逻辑 main guard 化的回归风险——以既有 7 项 spawn 测试 + 新直测护栏。

## 18. 已知限制
`--run-baseline V1` 硬编码与 `definedAt` 默认值问题保持现状（属产品语义，另行登记）。

## 19. 版本历史

| 版本 | 日期 | 变更摘要 | 确认人 |
|---|---|---|---|
| V1 | 2026-09-09 | 初版基线 | 用户（批量授权） |
