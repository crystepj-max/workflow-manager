# 工作流 UI 独立施工 handoff

> 这组文档把一次性原型拆成三个可由独立 agent 逐个完成的施工包。
> `H1 / H2 / H3` 是 handoff 编号，不是正式 `LOC-*` 任务编号，也不替代正式任务规格、Issue 或人工验收。

## 0. 先读这组共同约束

### 当前产品基线

- 正式界面已经是“选中节点 → 供应商与模型”，并支持修改模型。
- 本轮不再把模型设置拆成“整套工作流一个供应商和模型”。
- **只有内置工作流**需要补“默认 / 覆盖”状态，以及按节点还原或全部还原为默认的能力；自定义模板不要求这层交互。
- 三个 handoff 都必须保留上述模型范围，不要把自定义模板的模型默认/覆盖扩展带入施工。
- 一次性原型只提供交互参考，编辑、运行、角色和模型示例均在内存中，不能把原型数据当成生产数据或已验收能力。

### 共同原型入口

启动命令（仓库根目录）：

```bash
npm run prototype:ui
```

原型服务默认地址为 `http://127.0.0.1:4178`；端口被占用时以终端输出为准。

| 入口 | URL |
|---|---|
| 小尺寸设置入口 / 流程库 | `http://127.0.0.1:4178/settings/workflow-visual?variant=A&theme=light&view=library&surface=settings` |
| 编排台编辑器 | `http://127.0.0.1:4178/settings/workflow-visual?variant=A&theme=dark&view=editor&surface=workspace` |
| 运行列表与运行详情 | `http://127.0.0.1:4178/settings/workflow-visual?variant=A&theme=dark&view=runs&surface=settings` |
| 角色管理 | `http://127.0.0.1:4178/settings/workflow-visual?variant=A&theme=light&view=roles&surface=settings` |
| 初版对照 | 在上述 URL 追加 `version=1` |

原型中应按“流程库 → 打开工作区 → 返回”的真实操作顺序体验。大工作区打开后，底层小设置弹窗保持位置但不可操作；关闭工作区后回到原列表和筛选位置。

### 共同参考资料

| 资料 | 用途 |
|---|---|
| [`packages/dsh-visual-workflow/prototypes/ui-workbench/README.md`](/Users/chris/.codex/worktrees/9897/workflow-manager/packages/dsh-visual-workflow/prototypes/ui-workbench/README.md) | 原型启动方式、体验顺序、数据与生产边界 |
| [`packages/dsh-visual-workflow/prototypes/ui-workbench/REVIEW-2.md`](/Users/chris/.codex/worktrees/9897/workflow-manager/packages/dsh-visual-workflow/prototypes/ui-workbench/REVIEW-2.md) | 本轮用户问题逐项回应、真实模板连接与原型检查记录 |
| [`packages/dsh-visual-workflow/prototypes/ui-workbench/DESIGN.md`](/Users/chris/.codex/worktrees/9897/workflow-manager/packages/dsh-visual-workflow/prototypes/ui-workbench/DESIGN.md) | A 编排台的视觉、布局、文案、对比度和窄屏原则 |
| [`packages/dsh-visual-workflow/prototypes/ui-workbench/prototype-v2.js`](/Users/chris/.codex/worktrees/9897/workflow-manager/packages/dsh-visual-workflow/prototypes/ui-workbench/prototype-v2.js) | 可操作原型逻辑；只读参考，不直接复制为生产实现 |
| [`packages/dsh-visual-workflow/prototypes/ui-workbench/prototype-v2.css`](/Users/chris/.codex/worktrees/9897/workflow-manager/packages/dsh-visual-workflow/prototypes/ui-workbench/prototype-v2.css) | 原型样式、浅色/深色语义色和响应式断点 |
| [`docs/design/workflow-manager-v0.1-final-product-spec.md`](/Users/chris/.codex/worktrees/9897/workflow-manager/docs/design/workflow-manager-v0.1-final-product-spec.md) | v0.1 目标规格；区分目标与当前实现 |
| [`docs/design/workflow-design-principles.md`](/Users/chris/.codex/worktrees/9897/workflow-manager/docs/design/workflow-design-principles.md) | Logical Run、快照和 Provider/Model 修订的长期语义 |
| [`docs/design/plugin-layer.md`](/Users/chris/.codex/worktrees/9897/workflow-manager/docs/design/plugin-layer.md) | 插件 client/host 边界和 RPC 约束 |
| [`docs/design/workspace-isolation.md`](/Users/chris/.codex/worktrees/9897/workflow-manager/docs/design/workspace-isolation.md) | 工作空间、仓库、分支、锁和清理状态的业务含义 |
| [`docs/tasks/LOC-014-builtin-model-override.md`](/Users/chris/.codex/worktrees/9897/workflow-manager/docs/tasks/LOC-014-builtin-model-override.md) | 内置模板逐节点 Provider/Model 覆盖、还原和自定义模板边界 |

### 推荐施工顺序与隔离环境

用户要求由另一个独立 agent 逐个完成。建议顺序如下：

1. **H1 编排台编辑器**：先冻结共享工作区骨架和视觉 token。
2. **H2 运行详情**：复用 H1 的只读画布、标题栏和详情页签，接入 Logical Run 真实数据。
3. **H3 角色、主题与窄屏**：在 H1/H2 的表面结构稳定后统一完成角色长文本、浅深色和无障碍收口。

推荐每项使用一个独立 worktree（路径约定来自 [`docs/design/workspace-directory-convention-instance-workflow-manager.md`](/Users/chris/.codex/worktrees/9897/workflow-manager/docs/design/workspace-directory-convention-instance-workflow-manager.md)）：

| Handoff | 分支 | worktree |
|---|---|---|
| H1 | `codex/vwf-editor-workbench` | `/Users/chris/workspace/workflow-manager-worktrees/vwf-editor-workbench` |
| H2 | `codex/vwf-run-detail` | `/Users/chris/workspace/workflow-manager-worktrees/vwf-run-detail` |
| H3 | `codex/vwf-role-theme-responsive` | `/Users/chris/workspace/workflow-manager-worktrees/vwf-role-theme-responsive` |

每个 agent 开工时先记录 `git rev-parse --show-toplevel`、当前基线提交和 `git status --short`；不要覆盖主 worktree 中未提交的原型改动。提交、推送、创建或合并 PR 需按项目规则另行授权。

独立 agent 可在确认基线后使用下面的命令模板（`<base>` 替换为项目负责人确认的提交或分支；本轮没有代替负责人创建 worktree）：

```bash
BASE=<base>
git worktree add -b codex/vwf-editor-workbench /Users/chris/workspace/workflow-manager-worktrees/vwf-editor-workbench "$BASE"
# 或按 H2 / H3 替换分支名和目录：
# codex/vwf-run-detail       /Users/chris/workspace/workflow-manager-worktrees/vwf-run-detail
# codex/vwf-role-theme-responsive /Users/chris/workspace/workflow-manager-worktrees/vwf-role-theme-responsive
cd /Users/chris/workspace/workflow-manager-worktrees/<handoff-directory>
git rev-parse --show-toplevel
git status --short
```

## 1. 通用需求实现模板

每个独立任务完成前，应把下面结构补入自己的任务卡或 PR 描述：

1. **目标与用户影响**：用户现在遇到什么问题，完成后能做什么。
2. **范围 / 非范围**：把本 handoff 的做与不做逐项勾掉；不因实现方便扩大范围。
3. **用户路径**：从小设置入口进入，写出每一步看到的界面和返回行为。
4. **数据与接口**：列出消费的现有 RPC / 数据字段；新增字段必须说明兼容性和原因。
5. **状态矩阵**：空数据、加载、保存中、未保存、错误、只读、待人工决定、窄屏和深浅主题。
6. **验收条件**：可观察行为，不用“代码已改”作为验收。
7. **验证证据**：自动测试、真实浏览器截图/录屏、必要的正式 DSH 运行验证分开记录。
8. **交接说明**：已实施、未实施、风险、后续依赖和人工验收入口。

## 2. 三项之间的依赖判断

| 依赖 | 结论 |
|---|---|
| H1 → H2 | 推荐依赖。H2 可先用现有 Dashboard 施工，但最终应复用 H1 的画布和工作区表面，避免两套布局语义。 |
| H2 → H3 | H3 的主题 token 可早做，但角色详情和窄屏收口应在 H1/H2 的最终结构上验证。 |
| H1/H2 → 模型 override | 不是 H1/H2 的新功能。正式模型入口已存在；仅需保留内置工作流逐节点默认/覆盖/还原的既有范围。 |
| H2 → Runtime | H2 只消费 Logical Run 与现有控制协议；不得为了 UI 重写执行引擎语义。 |
| H3 → Role host API | 角色数据和内置/自定义权限已有 host RPC；H3 默认不改角色存储和角色引用语义。 |

三份具体施工单见：

- [H1 编排台工作流模板编辑器](./H1-editor-workbench.md)
- [H2 运行列表与 Logical Run 详情](./H2-run-detail.md)
- [H3 角色、主题与窄屏可用性](./H3-role-theme-responsive.md)
