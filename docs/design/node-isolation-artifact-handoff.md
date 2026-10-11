# 隔离节点的运行文件交接

本文说明本次候选的运行适配；交付状态以关联 PR 和实际 main 为准。

## 目录与职责

| 位置 | 使用者与用途 | 节点权限 |
|---|---|---|
| `candidate_path` / `source_path` | 业务文件，沿用角色能力 | 按既有角色配置 |
| `evidence/<node>/artifacts-<attempt>/` | 本次调用的声明产物和 `STATE.md` | 当前节点可写 |
| `inputs/<node>/artifacts-<attempt>/` | 声明输入与活动冻结基线的逐字节副本 | 当前节点只读 |
| `<执行现场>/<runDir>` | 宿主交接后的正式 Run 材料、冻结副本与清单 | 由宿主核验、写入 |

每次调用分配新的产物目录。节点缺少必需输出时，不能使用上一调用的同名文件完成本次提交。输入副本只包含蓝图声明的文件及当前活动冻结基线；其他节点的私有证据不被复制。

## 调用顺序

1. 路由适配从宿主绑定执行现场、Task 标识、`runDir` 和活动基线，并准备输入副本。
2. 输入基线的字节摘要必须等于已冻结引用；缺失、越界或摘要不同均在节点启动前拒绝。
3. 提示中的产物目录、`STATE.md` 与输入引用改为本节点的实际路径，业务源码路径沿用原能力配置。
4. 隔离 worker 完成后，宿主只交接 `output.files` 声明的文件及可选 `STATE.md`。必需文件缺失、非普通文件或源/目标路径包含符号链接时拒绝交接。
5. 宿主确认交接后才返回节点完成结果，编排再请求真实字节冻结和产物清单核验。

`node-artifacts.mjs` 负责文件交接；`node-provider-core.cjs` 负责调用先后；`artifact-manifest.cjs` 的文件/摘要核验经受管 Node 子进程执行。插件环境仅加载协议与闸门逻辑。恢复段继续登记材料核验，`workflow/end` 不得提前丢弃待决结果；材料记录随逻辑运行保存并回载。

## 强制边界

活动输入目录加入外层 Seatbelt 的只读规则，不能出现在写入根中。DSH 进程及其子进程继续使用默认拒绝的外层文件和网络策略。内部工具继承该策略，避免 macOS 中重复启动 `sandbox-exec`；没有非隔离回退。

文件交接用于 Run 材料归档；外部交付动作仍使用既有 `publish` 授权。角色的业务源码、候选写入能力保持其原有配置。

## 相称检查

- `scripts/test/node-artifacts.test.mjs`：真实文件交接、基线冻结、摘要、声明范围、缺失与符号链接拒绝、真实 macOS 只读边界，以及路由→worker→宿主交接的组合检查。
- `scripts/test/node-provider-core.test.mjs`：完成结果等待宿主交接。
- `packages/dsh-visual-workflow/tests/evaluation-baseline-runtime.test.mjs`：冻结恢复段保留缺失材料的 BLOCKED 结论。
- 发布前运行 `npm run release:verify`，再从正式安装路径完整重启产品 DSH 做实际工作流验证。机器检查不代替人工决定。
