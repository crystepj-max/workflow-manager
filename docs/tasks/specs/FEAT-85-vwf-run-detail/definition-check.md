# Definition Check · FEAT-85 多工作空间运行列表与 Logical Run 详情落地

## 检查元数据

| 项 | 值 |
|---|---|
| 任务名称 | 多工作空间运行列表与 Logical Run 详情落地 |
| 任务标识 | `FEAT-85`（远端 cnb#85） |
| 拟确认基线版本 | V1 |
| 检查人（Agent） | 克里斯（WorkBuddy 会话） |
| 检查时间 | 2026-09-17T13:03:00Z |
| 未决产品事项数 | 0 |

---

## 9.1 目标与范围

- [x] 用户问题明确 —— 规格 §2（多空间管理不了 / 一次运行看不懂 / 返工历史被掩盖 / 决策要手抄命令）
- [x] 需求目标明确 —— 规格 §3（五个目标）
- [x] 非目标明确 —— 规格 §4（6 条，含不改执行引擎、不用新 RPC）
- [x] 修改范围明确 —— 规格 §7（10 项）
- [x] 不修改范围明确 —— 规格 §8
- [x] 修改前状态明确 —— 规格 §5，含现有 RPC 清单与「`LOC-016` 实现存在于未合并分支」这一前序事实
- [x] 修改后状态明确 —— 规格 §6

## 9.2 规则与边界

- [x] 主要业务规则明确 —— 规格 §9（11 条硬规则）
- [x] 主要用户路径明确 —— 规格 §10（9 步）
- [x] 关键边界场景明确 —— 规格 §11（9 类）
- [x] 关键异常场景明确 —— 规格 §11 含读取失败、提交路径不可用、字段缺失三类
- [x] 对已有功能的影响明确 —— 规格 §8 明确不动执行引擎与存储格式
- [x] 已知风险明确 —— 规格 §17（6 项，含与 `LOC-016` 的实现重复风险）

## 9.3 决策完整性

- [x] 所有会影响产品结果的人工决策均已完成 —— 规格 §12 六项均有确认人与时间
- [x] 不存在「施工时再决定」的产品问题 —— 与 `LOC-016` 的关系已由人工裁定；`DT-01` 阻塞项的处置规则已在 §11/§17 定义为「受阻交出」，属已定义的边界行为
- [x] 未决产品事项数量为 0

## 9.4 任务组织

- [x] 如需求复杂，已完成必要的功能切片拆分 —— 规格 §13；H1/H2/H3 三切片
- [x] 每个子任务均可独立 UAT —— 运行列表与详情不依赖编辑器改造
- [x] 前置依赖已明确填写「无」或具体任务 —— 规格 §14「无」；两项前序事实（`LOC-016` 分支、`DT-01`）已明确列为「非依赖但必须处理」
- [x] 优先级已确定 —— P1

## 9.5 验收

- [x] 每个主要功能有明确验收条件 —— 规格 §15 V-1～V-12
- [x] 已能形成主要 UAT 场景 —— 规格 §16 UAT-01～UAT-07
- [x] 验收标准可以通过真实操作判断 —— 均为可观察行为
- [x] 每条验收项均已声明执行时机 —— UAT-01～06 为「裁决前可观测」，UAT-07 为「收口后观测」
- [x] 「收口后观测」项已写明执行者与结果回填位置 —— UAT-07 已写明；失败处置为如实记录，若确认两套实现并存则不得静默结案

## 9.6 无人值守

- [x] 已明确「无人值守许可」—— 允许
- [x] 若允许无人值守，不存在必须在施工过程中由人选择的产品问题 —— 唯一的未决项（`DT-01` 阻塞决策卡提交路径）**不是施工中需要人选择的产品问题**，而是已定义好的边界行为：做出界面 → 交出缺口 → 标记受阻。规格 §11 逐条给出期望行为。

---

## 结论

- [x] **全部通过** → 状态可改为「本地已定义」，呈递人工确认基线
- [ ] **未通过**

未通过项：

1. （无）

---

## 检查依据与限制说明

### 依据

- `docs/tasks/handoffs/H2-run-detail.md`；`docs/tasks/handoffs/README.md` §0/§2。
- `docs/tasks/LOC-016-dashboard-logical-run-ui.md` 与 `docs/tasks/specs/LOC-016-logical-run-ui/decision-tickets/DT-01-ui-resume-attribution.md`（状态 **open**）。
- `docs/design/workflow-manager-v0.1-final-product-spec.md` §3（Lifecycle / Node Business Outcome / Completion Type 三层结果模型）。
- `docs/design/workflow-design-principles.md`（Logical Run、快照、追加式 Provider/Model 修订）。
- `docs/design/workspace-isolation.md`（工作空间字段与活动锁含义）。
- 仓库事实：`git merge-base --is-ancestor dev-loc-016-r1 main` → 未并入；`git diff --stat main...dev-loc-016-r1` → `packages/dsh-visual-workflow/src/client.js` +1319 行、`src/host.js` 77 行、`tests/client.smoke.mjs` +535 行、新增 `tests/logical-run.test.mjs`、`locales/en.json` 与 `zh.json` 各 109 行。`.agent-runs/loc-016-r1/run.json` stage=`human_acceptance`、attempt=11、`rollback_used`=3。

### 限制

1. **本任务被人工裁定为接受范围重叠**（与 `LOC-016`）。定义阶段已把重叠后果显式写入规格 §4/§8/§14/§17/§18 与 UAT-07，不隐藏该事实；但**分歧裁决结论不在本规格内预设**，须在施工与收口阶段产出。
2. 规格中「修改前状态」的字段清单（`vwf.runs.list` 摘要是否含完整 workspace）来自 handoff 描述，**未在当前宿主上逐字段实测**；施工方须在开工时以真实样例确认，不根据截图猜字段名。
3. 本任务与 FEAT-84 / FEAT-86 可能并行施工，三者共享 `src/client.js`；并发度由人工在启动批次时决定，机器依赖不设置，合并顺序固定为 FEAT-84 → FEAT-85 → FEAT-86。
