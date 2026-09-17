# H1 · 编排台工作流模板编辑器

> 执行顺序：1/3。该文件是交给独立 agent 的施工 handoff；不是正式 `LOC-*` 任务卡。

## 1. 目标

把“模板编辑”从小设置弹窗中的长表单改成一个可定位、可回退、可理解的编排台。用户在查看分支、回环、扇出和结果去向时，右侧配置栏滚动不会把画布带走；用户先按业务词理解步骤，再在需要时展开技术细节。

## 2. 当前基线与问题

- 正式入口仍是小尺寸设置弹窗，适合找模板和看摘要；完整画布应在新的大工作区打开。
- 当前生产组件已有 `Editor`、`Canvas`、`NodeInspector`、JSON 编辑、实时校验和历史栈，但页面结构仍需要按 A 编排台收口。
- 正式编辑器已经有撤销和反撤销按钮，方向分别为左箭头 `↶` 和右箭头 `↷`；改造时必须保留禁用态、连续输入合并和“撤销后产生新修改即清空重做分支”的行为。
- 正式页面已有“选中节点 → 供应商与模型”，支持修改模型。本任务不重新设计这个入口。
- 内置模板的模型设置属于既定边界：每个节点有默认/覆盖状态，支持单节点还原和全部还原；自定义模板无需增加这层默认/覆盖交互。

## 3. 原型参考：必须逐项体验

### 3.1 页面入口

启动后打开：

`http://127.0.0.1:4178/settings/workflow-visual?variant=A&theme=light&view=library&surface=settings`

操作：

1. 在流程库中打开一个内置模板，确认模板名称、来源和只读提示。
2. 点击“编辑”或“查看并验收”，进入大工作区；关闭后应回到原列表位置。
3. 再打开个人模板，确认列表仍按“内置 / 我的”分组；“新建模板”可选择从零搭建或复制已有模板。

### 3.2 画布与配置栏

打开：

`http://127.0.0.1:4178/settings/workflow-visual?variant=A&theme=dark&view=editor&surface=workspace`

依次验证：

1. 点击“实现任务”“检查结果”等节点，右侧只显示当前节点详情。
2. 在右侧配置栏滚动到底部，中央画布仍保持可见、可拖动和可缩放；画布有独立滚动条，不与整个工作区共用长页面滚动。
3. 在节点详情中先看“任务 / 负责角色 / 交付内容”，再打开“结果与去向”“高级设置”；底层字段名、JSON、表达式只出现在高级层。
4. 在“诊断与修复”中选择检查节点，查看“检查通过、修复仍有问题、原判断不成立、暂时无法继续”等多种业务结果和各自去向；不要把它压缩成成功/失败两个按钮。
5. 在“多视角探索”中展开并行研究组：看到多个独立研究子节点、各自报告，以及全部完成后进入汇总；“补充研究”可以回到“安排研究”。
6. 打开“连接清单”，逐条看到普通业务路由、业务回环和调用重试；调用重试要和业务返工分开标识。

### 3.3 历史和保存

1. 修改节点名称或结果去向，点击 `↶` 查看撤销，点击 `↷` 查看反撤销。
2. 撤销后输入新的修改，确认旧的重做记录被清除。
3. 关闭工作区时对未保存改动给出继续编辑、放弃修改、保存并返回的明确选择。
4. 保存后返回流程库重新打开，节点名称、连接和已保存配置保持一致。

### 3.4 主题与窄屏

1. 浅色入口：
   `http://127.0.0.1:4178/settings/workflow-visual?variant=A&theme=light&view=editor&surface=workspace`
2. 深色入口：
   `http://127.0.0.1:4178/settings/workflow-visual?variant=A&theme=dark&view=editor&surface=workspace`
3. 用 390×844 视口验证：流程、配置两个区域可切换；不能把桌面画布缩成不可读的小图，顶部主要操作和底部保存操作不能被遮挡。

### 3.5 交互证据

- `/Users/chris/.codex/worktrees/9897/workflow-manager/packages/dsh-visual-workflow/prototypes/ui-workbench/evidence/v2-parallel-research.png`
- `/Users/chris/.codex/worktrees/9897/workflow-manager/packages/dsh-visual-workflow/prototypes/ui-workbench/evidence/v2-rework-history-dark.png`
- `/Users/chris/.codex/worktrees/9897/workflow-manager/packages/dsh-visual-workflow/prototypes/ui-workbench/evidence/v2-run-dark.png`（运行页沿用相同工作区表面，可用于对照）
- `/Users/chris/.codex/worktrees/9897/workflow-manager/packages/dsh-visual-workflow/prototypes/ui-workbench/evidence/v2-roles-mobile-dark.png`（窄屏表面和对比度参考）

## 4. 需求范围

### 做

- 保留“小设置入口 → 大工作区”的两层表面。
- 大工作区使用 A 编排台：左侧步骤/定位区，中间路线画布，右侧单一节点配置栏。
- 画布、右侧配置栏、连接清单分别滚动；工作区头部、保存和返回操作保持可见。
- 业务文案优先：步骤、负责角色、输入、交付内容、结果与去向。技术名词放入“高级设置 / JSON”并给出可理解的说明。
- 展示多种结果路由、业务回环、扇出和汇总，不依赖“成功/失败”二元模型。
- 保留从零创建、复制已有模板、个人模板列表、内置模板结构只读等既有行为。
- 保留撤销/反撤销的现有历史语义与按钮可见性。
- 保留正式节点模型入口；内置节点的默认/覆盖/还原作为兼容检查项，不给自定义模板增加同层级要求。
- 浅色、深色、键盘焦点、Escape 关闭和窄屏布局都达到同一可读性。

### 不做

- 不改工作流执行引擎、编译器、模板业务语义或回环计数规则。
- 不新增自定义模板的模型默认/覆盖/全部还原产品规则。
- 不把运行详情、人工决策、BLOCKED 恢复逻辑塞入编辑器；这些属于 H2。
- 不重做角色存储、角色引用、供应商注册或模型列表后端；角色表面属于 H3。
- 不以原型中的示例运行、个人模板或角色内容作为生产数据。

## 5. 推荐实现落点

### 生产源码

- `/Users/chris/.codex/worktrees/9897/workflow-manager/packages/dsh-visual-workflow/src/client.js`
  - `Canvas`：约第 633 行，复用现有节点、边、缩放和只读能力。
  - `NodeInspector`：约第 1091 行，整理为“基础 / 结果与去向 / 高级”渐进披露。
  - `Editor`：约第 1882 行，负责编辑状态、校验、历史、保存和工作区布局。
  - 现有 `.vwf-editor-dialog`、`.vwf-editor-body`、`.vwf-editor`、`.vwf-inspector` 样式约第 139–190 行；优先拆出可读的布局 token，避免新增第二套滚动容器。
  - 编辑器挂载和返回路径约第 3037 行以后；确认 dialog close、未保存提示和焦点回收。
- `/Users/chris/.codex/worktrees/9897/workflow-manager/packages/dsh-visual-workflow/src/host.js`
  - 默认只消费现有模板、校验和模型 override RPC；若不需要数据契约变化，不修改 host。

### 已有设计/实现参考

- [`packages/dsh-visual-workflow/docs/editor-toolbar-actions/README.md`](/Users/chris/.codex/worktrees/9897/workflow-manager/packages/dsh-visual-workflow/docs/editor-toolbar-actions/README.md)：撤销/重做、工具栏按钮和测试证据。
- [`packages/dsh-visual-workflow/docs/issue-54-editor-global-layer/README.md`](/Users/chris/.codex/worktrees/9897/workflow-manager/packages/dsh-visual-workflow/docs/issue-54-editor-global-layer/README.md)：编辑器全局层和截图参考。
- [`packages/dsh-visual-workflow/docs/issue-56-canvas-anti-overlap/README.md`](/Users/chris/.codex/worktrees/9897/workflow-manager/packages/dsh-visual-workflow/docs/issue-56-canvas-anti-overlap/README.md)：画布分支、连线和节点避让参考。
- [`packages/dsh-visual-workflow/docs/issue-57-toolbar-layout/README.md`](/Users/chris/.codex/worktrees/9897/workflow-manager/packages/dsh-visual-workflow/docs/issue-57-toolbar-layout/README.md)：工具栏、窄屏和布局参考。
- [`packages/dsh-visual-workflow/docs/issue-58-role-library/README.md`](/Users/chris/.codex/worktrees/9897/workflow-manager/packages/dsh-visual-workflow/docs/issue-58-role-library/README.md)：角色库入口和节点角色选择参考。
- [`packages/dsh-visual-workflow/docs/editor-edge-color-contrast/README.md`](/Users/chris/.codex/worktrees/9897/workflow-manager/packages/dsh-visual-workflow/docs/editor-edge-color-contrast/README.md)：连线颜色和对比度参考。
- [`docs/tasks/LOC-014-builtin-model-override.md`](/Users/chris/.codex/worktrees/9897/workflow-manager/docs/tasks/LOC-014-builtin-model-override.md)：内置逐节点默认/覆盖/还原范围；自定义模板不扩展该范围。
- [`docs/design/workflow-manager-v0.1-final-product-spec.md`](/Users/chris/.codex/worktrees/9897/workflow-manager/docs/design/workflow-manager-v0.1-final-product-spec.md) §11：UI 边界和复杂度分层。

## 6. 前后依赖

### 开工前

- 读取本文件和共同资料；确认当前分支基于主线最新可用提交。
- 启动原型并实际走完 §3 的节点、回环、扇出、保存和窄屏路径。
- 确认当前正式 `client.js` 的模型入口仍是逐节点入口；只把内置默认/覆盖/还原列为兼容验收，不改变自定义模板范围。

### 对其他 handoff 的输出

- 输出稳定的工作区容器、头部、返回/保存行为、画布只读模式和详情页签样式，供 H2 复用。
- 输出主题 token、断点和焦点样式，供 H3 统一角色页和运行页。

### 可能的实现阻塞

- 如果画布与 inspector 仍共享父级滚动，先解决容器高度和 `min-height: 0`，不要通过缩小字体掩盖问题。
- 如果生产模板中存在连接但节点配置没有对应结果选项，先以模板定义和校验器为准补齐渲染，不自行删除连接。
- 如果内置模型还原接口与当前 client 状态不一致，沿用 `vwf.workflows.modelOverride.get/save/clear`，记录为模型依赖问题，不把它扩展为自定义模板功能。

## 7. 验收条件

- [ ] 小设置入口可打开大工作区，关闭后保留原列表、筛选和滚动位置。
- [ ] 右侧配置栏滚到底部时，中央画布仍可见、可选节点、可缩放和可查看连接。
- [ ] 业务文案能在不阅读 JSON 的情况下完成新增节点、配置角色、配置交付内容和设置结果去向。
- [ ] 至少验证一个多结果模板、一个有业务回环的模板、一个扇出后汇总的模板；连接清单不漏边。
- [ ] 调用重试、业务回环、返工轮次使用不同标签和说明。
- [ ] `↶` / `↷` 的禁用态、撤销后新修改清空重做分支、JSON 与画布共用历史均通过。
- [ ] 内置模板节点结构不能编辑；内置节点可进入已有供应商/模型设置，并能验证默认/覆盖/单节点还原/全部还原。自定义模板无需默认/覆盖入口。
- [ ] 浅色和深色无“深色背景 + 深色字”；正文对比度目标至少 4.5:1，控件边界/图标至少 3:1。
- [ ] 390×844 下无横向溢出，焦点不被底部操作条遮挡，Escape 能关闭当前工作区或对话框。
- [ ] 自动测试、浏览器截图和必要的正式 DSH 验收分别记录，不用原型截图替代生产验收。

## 8. 建议验证清单

```text
[ ] npm test
[ ] npm run validate
[ ] cd packages/dsh-visual-workflow && npm test
[ ] 真实 Chromium：浅色编辑器、深色编辑器、内置只读、个人模板、从零创建
[ ] 真实 Chromium：多结果、回环、扇出/汇总、撤销/反撤销、未保存返回
[ ] 真实 Chromium：390×844，键盘 Tab / Shift+Tab / Escape
[ ] 记录正式 DSH 路径、截图、浏览器尺寸和是否通过人工验收
```

## 9. 交接产物

独立 agent 完成后应交回：变更文件清单、测试结果、至少一张浅色和一张深色编辑器截图、一张窄屏截图、已知限制、H2/H3 需要复用的 token/组件名，以及“模型范围未扩展到自定义模板”的确认。
