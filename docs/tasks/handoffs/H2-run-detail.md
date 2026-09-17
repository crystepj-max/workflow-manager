# H2 · 多工作空间运行列表与 Logical Run 详情

> 执行顺序：2/3。该文件是交给独立 agent 的施工 handoff；现有 `LOC-016` 是运行看板语义的主要参考。

## 1. 目标

让用户从一个列表管理多个工作空间中的多个工作流任务，并在一个稳定的详情区内看懂“现在在哪一步、这一步产出了什么、是否被退回、下一步怎么处理”。同一个 Logical Run 的多轮返工必须显示为同一次运行的连续分段，不创建看似全新的任务来掩盖历史。

## 2. 当前基线与问题

- 正式 Dashboard 已能列出运行、按页浏览、选择单个 run、显示基础状态、只读画布、节点表、正式产物和日志。
- 当前列表主要展示 `taskId / workflow / status / phase / runId`，工作空间、结果类型、完成类型和返工历史没有形成稳定的用户视图。
- 当前详情中有画布、节点表、产物和日志，但信息分散；用户需要在上下区域之间来回寻找节点详情。
- 当前部分人工决策仍会显示可复制的 `wf_run` 命令文字；目标交互应是结构化决策卡，由 UI 提交选项和理由，再由既有运行协议续跑。
- Logical Run、快照修订、节点尝试、业务结果、控制事件、工作空间上下文已经有持久化来源；本任务优先消费现有数据，不重写运行语义。

## 3. 原型参考：必须逐项体验

### 3.1 运行列表

打开：

`http://127.0.0.1:4178/settings/workflow-visual?variant=A&theme=dark&view=runs&surface=settings`

逐项验证：

1. 列表按工作空间分组；示例中有三个空间、八条任务。
2. 使用空间筛选和“待处理 / 进行中 / 已完成”筛选，筛选后仍显示任务所属模板、状态、返工次数、最近更新时间。
3. 选择一条任务进入大工作区详情；返回后保留原分组、筛选和列表位置。
4. 列表中能区分“同一次运行 · 第 N 段”和真正不同的任务；不要把 `superseded` 记录当作新用户任务。

### 3.2 运行详情

原型详情在上述入口点击一条运行后打开（原型会把 URL 保持为 `view=runs`，详情是同一页面的工作区状态）。逐项验证：

1. 左侧是运行定位（工作空间、模板、当前阶段、状态）；中间只保留一个选中节点的详情区。
2. 使用“结果 / 检查 / 活动”页签切换，页面不同时重复展示同一节点的详情。
3. 选择第 1 次和第 2 次执行，分别看到对应输入、成果和退回意见。
4. 完整经过应能读出：实现第 1 次 → 审查退回 → 实现第 2 次 → 审查通过 → 测试 → UAT → 等待人工决定。
5. 点击“模拟退回”，输入意见并提交；时间线新增退回事件，下一轮实现出现，返工前已完成的下游结果标为“上一轮成果”，不能冒充当前轮结果。
6. 对等待人工决定的运行，显示“接受 / 增加预算 / 停止”等业务选项、理由输入和影响说明；提交后仍留在同一个 Logical Run。
7. 对 BLOCKED 运行，显示阻塞原因和修改当前 Run Provider/Model 的恢复入口；恢复后显示新 Snapshot Revision，历史修订仍可查看。
8. 展开多视角探索运行时，显示并行研究组、每个独立研究子任务的结果，以及汇总节点的输入来源。
9. 打开工作空间信息，查看 mode、repository、branch、当前/base HEAD、集成状态、活动锁和清理状态。

### 3.3 主题与窄屏

- 浅色运行页：
  `http://127.0.0.1:4178/settings/workflow-visual?variant=A&theme=light&view=runs&surface=workspace`
- 深色运行页：
  `http://127.0.0.1:4178/settings/workflow-visual?variant=A&theme=dark&view=runs&surface=workspace`
- 390×844：列表可切换到详情，当前节点、决策按钮和返回按钮不被遮挡；详情页不要求同时显示完整桌面画布和全部文字。

### 3.4 交互证据

- `/Users/chris/.codex/worktrees/9897/workflow-manager/packages/dsh-visual-workflow/prototypes/ui-workbench/evidence/v2-workspace-runs.png`
- `/Users/chris/.codex/worktrees/9897/workflow-manager/packages/dsh-visual-workflow/prototypes/ui-workbench/evidence/v2-run-dark.png`
- `/Users/chris/.codex/worktrees/9897/workflow-manager/packages/dsh-visual-workflow/prototypes/ui-workbench/evidence/v2-rework-history-dark.png`
- `/Users/chris/.codex/worktrees/9897/workflow-manager/packages/dsh-visual-workflow/prototypes/ui-workbench/evidence/v2-run-mobile-dark.png`

## 4. 需求范围

### 做

- 多工作空间运行列表：分组、空间筛选、状态筛选、结果/完成类型筛选、分页和返回位置保留。
- 一个 Logical Run 的详情工作区：生命周期、当前分段、快照修订、节点尝试、业务结果、完成类型、正式产物和活动记录。
- 一个详情出口：目录用于定位，详情正文只展示选中节点；“结果 / 检查 / 活动”页签在同一区域切换。
- 返工可读性：每个节点显示 attempt/round；历史记录按时间排序；退回意见跟随触发它的审查轮次；下游旧结果标记为上一轮成果。
- 扇出可读性：并行组、子任务、汇总输入和未完成子任务状态清楚可见。
- WAITING_HUMAN 结构化决策卡：选项、理由、确认影响和续跑结果；至少支持 `USER_ACCEPTED`、`ADD_BUDGET`、`STOP`。
- BLOCKED 恢复卡：显示阻塞原因、Provider/Model 修改、提交后生成的 Snapshot Revision 和恢复进度。
- 工作空间面板：mode、repository、branch、当前/base HEAD、集成状态、活动锁、清理状态。
- 保留暂停、立即中断、指导和恢复的既有运行控制语义；按钮名称必须对应实际 action。

### 不做

- 不修改执行引擎的重试、回环、返工上限或 Logical Run 生命周期语义。
- 不在运行页编辑工作流结构；模板编辑属于 H1。
- 不重新设计供应商/模型配置；BLOCKED 恢复只调用现有 `model_overrides` 续跑语义，内置模板的默认/覆盖/还原仍按共同约束执行。
- 不增加“成功/失败”二元业务模型；业务 Outcome、Lifecycle、Completion Type 必须分层展示。
- 不用新的 RPC 替代已有 `vwf.runs.list`、`vwf.logicalRuns.get`、`vwf.run.control` 和 `wf_run` 参数，除非先记录兼容性理由并单独交接。

## 5. 需求与现有任务的关系

### 既有语义权威

- [`docs/tasks/LOC-016-dashboard-logical-run-ui.md`](/Users/chris/.codex/worktrees/9897/workflow-manager/docs/tasks/LOC-016-dashboard-logical-run-ui.md)：Logical Run 详情、决策卡、工作空间面板、BLOCKED 恢复和筛选的既有定义。若独立 agent 实际施工该任务，应更新或引用 `LOC-016`，不要另造相互冲突的生命周期。
- [`docs/design/workflow-manager-v0.1-final-product-spec.md`](/Users/chris/.codex/worktrees/9897/workflow-manager/docs/design/workflow-manager-v0.1-final-product-spec.md) §3：Lifecycle / Node Business Outcome / Completion Type 三层结果模型。
- [`docs/design/workflow-design-principles.md`](/Users/chris/.codex/worktrees/9897/workflow-manager/docs/design/workflow-design-principles.md)：Logical Run、快照和追加式 Provider/Model 修订。
- [`docs/design/workspace-isolation.md`](/Users/chris/.codex/worktrees/9897/workflow-manager/docs/design/workspace-isolation.md)：工作空间字段和活动锁的含义。

### 生产源码入口

- `/Users/chris/.codex/worktrees/9897/workflow-manager/packages/dsh-visual-workflow/src/client.js`
  - `Dashboard`：约第 2467 行；现有 `vwf.runs.list`、`vwf.state`、`vwf.logicalRuns.get` 读取、分页、控制按钮、只读画布和产物/日志区域。
  - 现有详情基础只显示状态、阶段、节点表、正式产物和日志；新的详情应围绕这一组件重组，不在同一页面复制两套详情。
- `/Users/chris/.codex/worktrees/9897/workflow-manager/packages/dsh-visual-workflow/src/host.js`
  - `summary()`：约第 662 行，当前运行列表摘要。
  - `vwf.runs.list` / `vwf.runs.history`：约第 1680 行以后。
  - `vwf.logicalRuns.get`：约第 1696 行以后，返回 logical record 的完整 payload。
  - `vwf.run.control`：约第 1771 行以后，已有 `pause / interrupt / guidance`。
  - `wf_run` 的续跑参数：约第 2524 行以后，已有 `decision_id + user_choice`、`resume_paused` 和 `model_overrides` 语义。
- `/Users/chris/.codex/worktrees/9897/workflow-manager/packages/dsh-visual-workflow/tests/`
  - 重点查看 `runs-persistence.test.mjs`、`records-runtime.test.mjs`、`runtime-host.test.mjs`、`host.test.mjs` 和现有 Dashboard/client 测试，沿用字段和持久化断言。

## 6. 数据与接口要求

### 首选：只消费现有协议

1. 列表先读取 `vwf.runs.list`；通过 `logical_run_id` 和 `segment / segment_count / logical_state` 合并同一 Logical Run 的段位。
2. 选中一条运行后，再读取 `vwf.logicalRuns.get`，填充 `lifecycle`、`snapshots`、`node_attempts`、`business_outcomes`、`guidance`、`control_events`、`workspace` 等详情。
3. 暂停、立即中断和指导沿用 `vwf.run.control`。
4. 人工决策和恢复通过既有 `wf_run` 续跑参数；UI 层只负责将选项映射为 `decision_id / user_choice / model_overrides`，不拼接让用户复制的命令。
5. 运行日志、正式产物和节点结果必须标注来源分段和 attempt，避免当前轮与上一轮混淆。

### 工作空间分组的兼容处理

当前 `vwf.runs.list` 的摘要字段不一定直接包含完整 workspace。实现时先使用已有摘要和选中 Logical Run 的 `workspace`；如果列表分组无法在合理交互内完成：

- 优先做客户端缓存和惰性补齐，不新增 RPC。
- 若实测仍无法支持多空间列表，只允许对既有 `vwf.runs.list` 行增加只读 workspace 摘要字段，并在任务说明中列出字段、向后兼容方式和测试；不得借机改运行存储格式。

### 人工决策卡的交互边界

- `WAITING_HUMAN`：显示决策标题、当前节点、可选项、理由输入、提交前影响说明；提交后锁定按钮并显示续跑中。
- `BLOCKED`：显示可修复原因、当前快照、Provider/Model 修改前后值和“产生新修订、保留旧修订”的说明。
- `PAUSED`：显示暂停原因、已有 guidance、恢复入口；不要把暂停指导误标为人工业务结果。
- `STOP` 或用户主动停止后，详情仍可读，不能显示为“系统异常”。

## 7. 前后依赖

### 开工前

- 先阅读 `LOC-016` 和本 handoff，启动原型并完成 §3 的列表、返工、并行、决策和 BLOCKED 路径。
- 确认当前 host 的 `logicalRunPayload` 字段和实际样例；不根据截图猜字段名。
- 与 H1 对齐工作区头部、返回、只读画布和页签 token；若 H1 尚未完成，可先用现有组件，但交接时标出替换点。

### 对 H3 的输出

- 输出运行列表和详情的状态色、状态图标、页签、错误/空态、窄屏折叠规则。
- 输出“长内容只在详情区滚动、列表摘要截断”的统一规则，供角色页复用。

### 运行时依赖

- 如果发现 host 尚未暴露结构化决策提交入口，先把缺口登记为运行协议依赖；不要在 client 中伪造成功状态。
- 如果 BLOCKED 恢复需要的 provider/model 字段无法组成 `model_overrides`，以 `wf_run` schema 和 host 错误提示为准补齐最小适配。
- 如果 workspace 注册表或锁状态读取失败，显示明确的未知/不可用状态和重试，不显示过时缓存为当前事实。

## 8. 验收条件

- [ ] 同一列表可同时看到至少两个工作空间的多条任务，可按空间和状态筛选，返回后保留筛选位置。
- [ ] 同一 Logical Run 的多个 segment 只呈现为一个用户任务，并能从详情看到每一段和快照修订。
- [ ] 详情只有一个选中节点结果出口；结果、检查、活动使用页签切换，不出现上下重复详情。
- [ ] 返工路径能读出“实现 → 检查退回 → 实现 → 检查”，每轮成果与意见对应正确，旧下游结果有上一轮标识。
- [ ] 多视角扇出显示多个子任务、独立结果和汇总输入；部分未完成时不能伪装成汇总完成。
- [ ] WAITING_HUMAN 卡支持 `USER_ACCEPTED / ADD_BUDGET / STOP`，提交后同一 Logical Run 继续或结束，并保留控制事件。
- [ ] BLOCKED 卡支持当前 Run 的 Provider/Model 修改，恢复后出现新 Snapshot Revision，旧修订仍可查。
- [ ] 工作空间面板显示 mode、repository、branch、当前/base HEAD、集成、锁和清理状态；读取失败有可见错误。
- [ ] 结果、Lifecycle、Completion Type 分层显示；业务结果不是简单成功/失败徽标。
- [ ] 浅色/深色/390×844/键盘焦点均可读且可操作。
- [ ] 自动测试、浏览器证据、正式 DSH 真机 E2E 和人工验收状态分开记录。

## 9. 建议验证清单

```text
[ ] npm test
[ ] npm run validate
[ ] cd packages/dsh-visual-workflow && npm test
[ ] 真实 Chromium：三工作空间、多任务、空间/状态/结果筛选
[ ] 真实 Chromium：Logical Run 多段、返工、上一轮成果、扇出汇总
[ ] 真实 Chromium：WAITING_HUMAN 三种选项、BLOCKED 模型恢复、PAUSED 指导
[ ] 真实 Chromium：浅色、深色、390×844、键盘焦点和返回位置
[ ] 正式 DSH：至少一条真实 Logical Run 的人工决策/恢复 E2E（若运行环境可用）
[ ] 记录任何协议缺口，不以模拟数据成功替代真实运行验证
```

## 10. 交接产物

独立 agent 完成后应交回：运行列表和详情截图（浅色、深色、窄屏各至少一张）、字段到 UI 的映射表、控制动作到 RPC/续跑参数的映射表、真实或明确未完成的 E2E 证据、协议缺口、H3 可复用的状态 token，以及返工/扇出/人工决策的已知限制。
