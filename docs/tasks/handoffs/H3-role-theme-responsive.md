# H3 · 角色库、主题和窄屏可用性收口

> 执行顺序：3/3。该文件是交给独立 agent 的施工 handoff；角色数据和执行语义不在本任务内。

## 1. 目标

解决两个直接的使用问题：用户无法快速分辨内置角色和自定义角色；职责很长的自定义角色会把列表撑爆。同时把编辑器、运行详情和角色管理收敛到同一套浅色/深色语义色、排版、焦点和窄屏规则，避免“深色背景配深色字”或按钮被遮挡。

## 2. 当前基线与问题

- 正式角色管理已有内置/自定义分区、来源 badge、内置只读、自定义编辑/复制/删除和角色详情。
- 现有角色行仍可能把完整职责、简介和操作挤在一行；长职责需要两行摘要 + 独立详情滚动。
- 原型已验证 4,537 字职责和连续长串时列表不横向溢出；这一行为要落到正式组件和真实角色数据，而不是只保留截图。
- 主题变量已经分散在 `client.js` 与 DSH alias 中；本任务需统一 token 命名和语义，不重新选择一套与 A 编排台冲突的美术方向。

## 3. 原型参考：必须逐项体验

### 3.1 角色列表

打开：

`http://127.0.0.1:4178/settings/workflow-visual?variant=A&theme=light&view=roles&surface=settings`

逐项验证：

1. 看到“内置角色”和“自定义角色”两个分区，并有来源 badge；内置角色没有编辑按钮，只能查看或复制为自定义。
2. 在自定义区打开“体验检查员”，确认名称、来源、两行简介和操作按钮互不挤压。
3. 对没有简介但职责很长的角色，列表只展示两行截断摘要；点击“查看详情”后，完整职责在独立滚动区域内展示。
4. 自定义角色可以编辑、复制、删除；删除前显示引用数量和受影响模板。内置角色不提供删除。

### 3.2 浅色、深色和窄屏

- 浅色角色页：
  `http://127.0.0.1:4178/settings/workflow-visual?variant=A&theme=light&view=roles&surface=settings`
- 深色角色页：
  `http://127.0.0.1:4178/settings/workflow-visual?variant=A&theme=dark&view=roles&surface=settings`
- 窄屏角色页：将上面任一地址放入 390×844 视口；列表操作应折行但不横向溢出，详情弹层可独立滚动，关闭按钮和焦点始终可见。
- 对照 H1/H2：
  `http://127.0.0.1:4178/settings/workflow-visual?variant=A&theme=dark&view=editor&surface=workspace`
  `http://127.0.0.1:4178/settings/workflow-visual?variant=A&theme=dark&view=runs&surface=workspace`

### 3.3 交互证据

- `/Users/chris/.codex/worktrees/9897/workflow-manager/packages/dsh-visual-workflow/prototypes/ui-workbench/evidence/v2-roles-light.png`
- `/Users/chris/.codex/worktrees/9897/workflow-manager/packages/dsh-visual-workflow/prototypes/ui-workbench/evidence/v2-personal-templates.png`
- `/Users/chris/.codex/worktrees/9897/workflow-manager/packages/dsh-visual-workflow/prototypes/ui-workbench/evidence/v2-roles-mobile-dark.png`
- `/Users/chris/.codex/worktrees/9897/workflow-manager/packages/dsh-visual-workflow/prototypes/ui-workbench/evidence/v2-run-mobile-dark.png`
- `/Users/chris/.codex/worktrees/9897/workflow-manager/packages/dsh-visual-workflow/prototypes/ui-workbench/evidence/v2-run-dark.png`

## 4. 需求范围

### 做

- 角色列表明确显示“内置 / 自定义”来源，分区或筛选结果在标题和行内均可识别。
- 内置角色只读，可查看完整内容或复制生成自定义角色；自定义角色可编辑、复制、删除并显示引用阻塞。
- 角色摘要独立于完整职责：优先使用显式 summary；没有 summary 时从职责生成两行、可读的摘要；连续长串需要断词或换行。
- 完整职责放在详情对话框或侧栏的独立滚动区域，列表高度不随全文无限增长。
- 统一编辑器、运行页和角色页的浅色/深色语义 token：画布、表面、正文、次要正文、强调、状态、边框、焦点和遮罩成对定义。
- 校验正文至少 4.5:1、非文本控件至少 3:1；状态同时使用文字和图标/形状，不只依赖颜色。
- 适配 390×844 及常见桌面宽度；弹层有安全边距，按钮能折行，详情内容内部滚动。
- 支持键盘 Tab/Shift+Tab、可见焦点、Escape 关闭、打开详情后的焦点回收和真实 label。

### 不做

- 不修改角色存储、角色内容、角色引用关系、删除规则和 host RPC 语义。
- 不新增角色权限层或把内置角色改成可直接编辑。
- 不改 H1/H2 的业务路由、运行状态、模型 override 或模板数据。
- 不以降低正文字号、隐藏文字或降低对比度来解决窄屏拥挤。
- 不重新引入初版 B/C 视觉方向；本任务沿用 A 编排台的雾蓝语义系统。

## 5. 推荐实现落点

### 生产源码

- `/Users/chris/.codex/worktrees/9897/workflow-manager/packages/dsh-visual-workflow/src/client.js`
  - `RoleManager`：约第 1595 行以后，已有列表、详情、创建/编辑/复制/删除和引用阻塞处理。
  - `NodeInspector`：约第 1091 行，复用角色来源 badge 和摘要规则，避免节点角色选择与角色库含义不一致。
  - 顶部 CSS 约第 139–242 行，已有 `.vwf-role-*`、`.vwf-editor-*` 和 scrollbar 样式；将颜色、边框、焦点和响应式规则整理为 A 的语义 token。
- `/Users/chris/.codex/worktrees/9897/workflow-manager/packages/dsh-visual-workflow/src/host.js`
  - 默认不改 `vwf.roles`、`vwf.roles.get/create/update/remove/usage` RPC；只有实际数据缺口才提交最小兼容改动。

### 既有角色参考

- [`specs/issue-81-built-in-roles/requirements-analysis.md`](/Users/chris/.codex/worktrees/9897/workflow-manager/specs/issue-81-built-in-roles/requirements-analysis.md)：内置只读、自定义编辑/复制和动态角色列表语义。
- [`packages/dsh-visual-workflow/docs/issue-58-role-library/README.md`](/Users/chris/.codex/worktrees/9897/workflow-manager/packages/dsh-visual-workflow/docs/issue-58-role-library/README.md)：角色库入口、截图和已有 UI 约束。
- [`packages/dsh-visual-workflow/prototypes/ui-workbench/DESIGN.md`](/Users/chris/.codex/worktrees/9897/workflow-manager/packages/dsh-visual-workflow/prototypes/ui-workbench/DESIGN.md)：A 的颜色、字体、圆角、间距和 WCAG 目标。
- [`packages/dsh-visual-workflow/prototypes/ui-workbench/REVIEW-2.md`](/Users/chris/.codex/worktrees/9897/workflow-manager/packages/dsh-visual-workflow/prototypes/ui-workbench/REVIEW-2.md)：长职责和 390×844 的浏览器检查记录。
- [WCAG 2.2 文本对比度](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)：正文对比度依据。
- [WCAG 2.2 非文本对比度](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html)：图标、边界和控件依据。
- [WCAG 2.2 焦点不被遮挡](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html)：窄屏和键盘焦点依据。

## 6. 前后依赖

### 开工前

- 先阅读 H1/H2，确认最终工作区头部、状态色、按钮尺寸、页签和滚动边界；若 H1/H2 尚未合并，使用它们的 handoff 约定，不另造 token。
- 启动原型，完成长职责、内置/自定义、浅色/深色、390×844 和键盘路径。
- 读取真实 `vwf.roles` 数据，至少准备一个内置角色、一个有简介的自定义角色和一个无简介长职责角色作为浏览器验证样例。

### 对 H1/H2 的输出

- 一份可复用的 A 主题 token 表（浅/深色值、文字层级、状态色、焦点色、边界色）。
- 角色详情弹层/侧栏的滚动和焦点管理实现，可供 H1/H2 的长结果、活动和错误详情复用。
- 一份 390×844 的断点检查表，标明哪些区域折叠、哪些区域保留固定操作。

### 允许的最小数据依赖

- 如果真实角色没有 summary，客户端可从 content 生成显示摘要，但不能写回或覆盖角色原文。
- 如果某个状态色在 DSH alias 中不存在，新增 token 时要同时提供浅色/深色值和对比度证据；不要在单一主题里硬编码黑色/白色。
- 如果内置/自定义 badge 缺字段，按 `builtin` 布尔语义映射；不要通过角色名猜来源。

## 7. 验收条件

- [ ] 角色列表一眼能区分内置与自定义；内置只读、可复制，自定义可编辑/删除并显示引用阻塞。
- [ ] 长职责不会撑爆列表；列表摘要最多两行，完整文本在独立滚动详情中可读，连续长串不会造成横向溢出。
- [ ] 编辑器、运行页、角色页使用同一套 A 语义 token；浅色和深色都不存在低对比度文字。
- [ ] 普通文字对比度至少 4.5:1，非文本控件至少 3:1；状态同时有文字和图形提示。
- [ ] 390×844 下设置入口、角色列表、详情弹层和编辑表单均可操作，无横向滚动；主要操作不被工具条遮挡。
- [ ] 键盘可以到达筛选、查看、编辑、复制、删除、关闭和保存；焦点可见，Escape 关闭详情并回收焦点。
- [ ] 角色 RPC 和内置/自定义业务语义没有被视觉改造误改。
- [ ] 真实浏览器截图、对比度测量、自动测试和人工验收状态分别记录。

## 8. 建议验证清单

```text
[ ] npm test
[ ] npm run validate
[ ] cd packages/dsh-visual-workflow && npm test
[ ] 真实 Chromium：内置/自定义分区、长职责、详情滚动、引用阻塞
[ ] 真实 Chromium：浅色、深色、编辑器/运行页/角色页 token 一致
[ ] 真实 Chromium：390×844，无横向溢出，详情和按钮可操作
[ ] 真实 Chromium：Tab / Shift+Tab / Escape / 可见焦点
[ ] 记录对比度测量方法、工具、截图和人工可读性结论
```

## 9. 交接产物

独立 agent 完成后应交回：角色页浅色/深色/窄屏截图、token 表、长职责前后对照、键盘路径记录、对比度测量、变更文件、未解决的宿主 alias 问题，以及 H1/H2 可直接复用的组件或 class 名称。

