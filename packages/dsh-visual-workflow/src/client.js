// ─────────────────────────────────────────────────────────────────────────────
// visual-workflow · CLIENT 半（pkg-20，编辑模块 Gold-Band 对齐版）
//
// 参考 Gold-Band《工作流编辑器》（web/src/components/WorkflowEditor.tsx +
// workflowGraph.ts）对 pkg-19 的编辑模块做整体改造：
//
//  画布（对应 ReactFlow 画布 + workflowGraph 布局）
//   - 自动分层布局（success 主链最长路分层，LR），节点保持安全间距且不可手拖；
//     回退边与跨节点边统一走上方外围车道，标签随车道路径避让节点内容
//   - 节点卡片 220x66（圆角 14、label + 类型小字、入口徽标）、$end 虚线圆形
//     终止节点、左右连接把手；边带流动虚线动画 + 箭头；成功/业务 outcome 边
//     标签为蓝色（outcome 边标签显示 outcome 名）、失败为红色、技术重试为
//     中性灰、选中为主文字色加粗
//   - 交互：首次打开/重置时纵横居中；点选节点/边；从源把手拖出连线落到目标
//     节点建边；右键画布弹出「添加结束节点」菜单；滚轮缩放（指针锚定）+
//     空白区域四向拖动 + 缩放控件
//
//  配置面板（对应右侧 Inspector 340px 栏）
//   - 工作流控制：打回上限 maxRounds
//   - 节点表单：节点 ID（失焦/回车提交、IME 合成保护、非法字符清洗+去重）、
//     显示名、角色（vwf.roles 数据源）、Agent/模型（vwf.models 数据源，换
//     Agent 重置模型）、节点目标、结果判定方式三态（不启用 / AI 输出验证 /
//     人工 check，互斥切换同 Gold-Band）、JSON 输出约束（2s 防抖 + 失焦提交 +
//     美化按钮 + 非法 JSON 不写入）、成功表达式
//   - 边表单：边类型四态（成功 / 失败 / 技术重试 / 业务 outcome + countRound）、
//     目标 / when 条件（仅 success 边）/ 删除边；on 与 outcome 互斥清理与
//     validate-core 边规则同构
//   - 保存校验：校验失败弹窗列问题 → 关闭后逐字段标红 + 画布红圈 + 定位首个
//     问题节点；画布/JSON 双 tab 实时互同步；变更后防抖实时校验状态行
//
//  宿主形态：设置→工作流 section 内为「模板库 + 运行看板」，点「编辑」打开
//  原生顶层 <dialog> 编辑工作区（相对浏览器窗口居中），不再依附设置页布局。
//
//  pkg-4（视觉复核反馈修订）：
//  - 撤销 pkg-3 的配置页内联画布编辑（快速调整 tab），恢复「已保存工作流列表
//    → 点编辑弹抽屉」的原始形态
//  - 纵向滚动条定位到画布内部（canvas-wrap overflow + 常显滚动条样式），
//    取消页面级滚动容器
//  - 保留：画布工具栏文档流一行（不遮挡入口节点）、边标签按类型与 outcome 名
//    如实显示（when 悬停 title 可见）
//
//  运行约束：动态客户端闭包（plain JS、无 JSX/import；React/host/styles 为
//  注入符号；计时器走 ctx.timeout/ctx.interval——inject: ['slots','timer']）。
// ─────────────────────────────────────────────────────────────────────────────

return {
  name: 'visual-workflow-client',
  inject: ['slots', 'timer'],
  buildSchemaTemplate: buildSchemaTemplate,
  COND_RE: conditionRegex(),
  edgeKind: edgeKind,
  applyEdgeKind: applyEdgeKind,
  edgeLabelText: edgeLabelText,
  routingNameOf: routingNameOf,
  normalizeRoutingName: normalizeRoutingName,
  routingPathOf: routingPathOf,
  enumerableValues: enumerableValues,
  routingCandidates: routingCandidates,
  routingValuesOf: routingValuesOf,
  applyRoutingWrite: applyRoutingWrite,
  routingEdgeStatus: routingEdgeStatus,
  // 校验内核副本的最小导出（LOC-005 parity 门禁）：纯函数、零运行时行为变更，
  // 仅暴露给 tests/graph-semantics-parity 与内核权威侧同输入对拍。
  isStructuralEdge: isStructuralEdge,
  isRollbackEdge: isRollbackEdge,
  deriveEntryCandidates: deriveEntryCandidates,
  ingestEditorJson: ingestEditorJson,
  // 角色来源与显示摘要（FEAT-86）：纯函数、只读，导出供单测锁定
  // 「按 builtin 字段判定来源」与「摘要不写回原文」两条业务规则。
  roleOriginOf: roleOriginOf,
  roleSummaryOf: roleSummaryOf,
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return

    // ── i18n：文案不进闭包。启动时按当前语言向宿主拉取 locales/<locale>.json ──
    let localeService
    try { localeService = ctx.get('locale') } catch (e) { localeService = undefined }
    const isEn = () => {
      try {
        const snap = localeService && localeService.getSnapshot ? localeService.getSnapshot() : null
        return !!(snap && String(snap.active || '').toLowerCase().indexOf('en') === 0)
      } catch (e) { return false }
    }
    let messages = {}
    const t = (key, vars) => {
      let s = messages[key]
      if (s == null) s = key
      if (vars) for (const k of Object.keys(vars)) s = String(s).split('{' + k + '}').join(String(vars[k]))
      return s
    }

    styles.insert(`
/* ── A 编排台语义 token（FEAT-86）──────────────────────────────────────────
   契约来源：prototypes/ui-workbench/DESIGN.md「视觉系统 · A · 雾蓝编排台」六色
   基础色表 + 状态/边框/焦点/遮罩语义。浅色为默认值，深色在
   body[data-ds-dark-theme] 成对覆盖（与 DSH 自身主题机制同源，不另造开关）。
   组件样式只引用 --vwf-*：不再各自书写 DSH alias + 单一主题兜底色——那正是
   「深色背景配深色字」的成因（alias 缺失时落到只对一种主题成立的硬编码值）。
   对比度口径：正文 ≥ 4.5:1，非文本控件边界与焦点 ≥ 3:1；采样点与实测见
   tests/theme-token.test.mjs 与 .agent-runs/feat-86-r1 的对比度证据。 */
/* @vwf-token-light */
:root {
  --vwf-canvas: #F1F4FA;
  --vwf-surface: #FFFFFF;
  --vwf-text: #1D2B43;
  --vwf-text-2: #58677E;
  --vwf-text-3: #5F6E85;
  --vwf-accent: #3D53B6;
  --vwf-accent-on: #FFFFFF;
  --vwf-accent-surface: #E8ECFF;
  --vwf-border: rgba(29, 43, 67, 0.14);
  --vwf-border-strong: rgba(29, 43, 67, 0.30);
  --vwf-border-ctl: #7C8BA3;
  --vwf-focus: #3D53B6;
  --vwf-mask: rgba(16, 24, 39, 0.32);
  --vwf-ok: #1F7A4D;
  --vwf-err: #B3261E;
  --vwf-warn: #8A5A00;
  --vwf-info: #2F5CA8;
}
/* @vwf-token-light-end */
/* @vwf-token-dark */
body[data-ds-dark-theme], :root[data-ds-dark-theme] {
  --vwf-canvas: #101827;
  --vwf-surface: #182338;
  --vwf-text: #EDF2FF;
  --vwf-text-2: #ACB9D1;
  --vwf-text-3: #93A2BD;
  --vwf-accent: #B3C1FF;
  --vwf-accent-on: #101827;
  --vwf-accent-surface: #293759;
  --vwf-border: rgba(237, 242, 255, 0.14);
  --vwf-border-strong: rgba(237, 242, 255, 0.30);
  --vwf-border-ctl: #7E8FAE;
  --vwf-focus: #B3C1FF;
  --vwf-mask: rgba(0, 0, 0, 0.56);
  --vwf-ok: #6FD19A;
  --vwf-err: #FF938C;
  --vwf-warn: #F0B84E;
  --vwf-info: #8FB8FF;
}
/* @vwf-token-dark-end */
/* 非颜色 token（间距 / 尺寸）：与主题无关，单处定义 */
:root { --vwf-safe-gap:clamp(12px, 3vw, 32px); }
.vwf-root { display:flex; flex-direction:column; gap:12px; font-size:13px; color:var(--vwf-text); }
/* 画布与嵌入层的滚动条统一由本作用域承担（原按容器逐个列举；角色详情、引用位置
   与角色管理滚动区一并纳入，不新增分叉规则）。 */
.vwf-root ::-webkit-scrollbar { width:10px; height:10px; }
.vwf-root ::-webkit-scrollbar-thumb { background:var(--vwf-border-strong); border-radius:99px; border:2px solid transparent; background-clip:padding-box; }
.vwf-root ::-webkit-scrollbar-track { background:transparent; }
/* 可见焦点（V-6 / WCAG 2.2 焦点不被遮挡）：键盘到达的控件都必须有可见焦点环。
   作用域限本插件根节点，不外溢到宿主其它界面。 */
.vwf-root :focus-visible { outline:2px solid var(--vwf-focus); outline-offset:2px; }
.vwf-input:focus-visible, .vwf-select:focus-visible, .vwf-textarea:focus-visible { outline-offset:0; border-color:var(--vwf-focus); }
.vwf-row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
/* 业务结果取值行（LOC-001 V2）：取值 / 状态图标 / 操作必须在同一行。
   .vwf-input 默认 width:100%，在 flex 行里会把后两者挤到下一行，这里改为可伸缩宽度。 */
.vwf-routing-row { flex-wrap:nowrap; gap:6px; }
.vwf-routing-row .vwf-input { flex:1 1 auto; min-width:0; width:auto; }
.vwf-routing-row .vwf-btn, .vwf-routing-badge { flex:0 0 auto; white-space:nowrap; }
.vwf-routing-badge { cursor:help; font-size:12px; line-height:1; }
.vwf-spacer { flex:1; }
.vwf-muted { color:var(--vwf-text-2); font-size:12px; }
.vwf-muted-sm { color:var(--vwf-text-3); font-size:11px; }
.vwf-tabs { display:flex; gap:4px; border-bottom:1px solid var(--vwf-border); }
.vwf-tab { padding:7px 14px; border:1px solid transparent; border-radius:8px 8px 0 0; cursor:pointer; color:var(--vwf-text-2); font-size:13px; background:transparent; }
.vwf-tab.on { color:var(--vwf-accent); border-color:var(--vwf-border); border-bottom-color:transparent; background:var(--vwf-surface); }
/* 页签计数（原型 nav-tab .count）：待处理运行数不随筛选与分页消失 */
.vwf-tab .vwf-badge { margin-left:6px; }
.vwf-card { border:1px solid var(--vwf-border); border-radius:12px; background:var(--vwf-surface); overflow:hidden; }
.vwf-card-head { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:10px 14px; border-bottom:1px solid var(--vwf-border); flex-wrap:wrap; }
.vwf-card-title { font-size:14px; font-weight:600; color:var(--vwf-text); }
/* 控件边界（按钮 / 输入 / 下拉）用 ≥3:1 的 --vwf-border-ctl；卡片、分隔线等
   装饰性边界用 --vwf-border，避免整屏描边过重（V-4 非文本对比度）。 */
.vwf-btn { padding:6px 12px; border-radius:8px; border:1px solid var(--vwf-border-ctl); background:transparent; color:var(--vwf-text); cursor:pointer; font-size:12px; line-height:1.4; }
.vwf-btn:hover:not(:disabled) { background:var(--vwf-accent-surface); border-color:var(--vwf-accent); }
.vwf-btn:disabled { opacity:.45; cursor:not-allowed; }
.vwf-btn.primary { border-color:var(--vwf-accent); background:var(--vwf-accent); color:var(--vwf-accent-on); }
.vwf-btn.danger { color:var(--vwf-err); }
.vwf-btn.danger:hover:not(:disabled) { background:var(--vwf-err); border-color:var(--vwf-err); color:var(--vwf-accent-on); }
/* 画布顶部删除操作保持完整红色；禁用态不用透明度混色，避免在深色画布上发黑。 */
.vwf-canvas-toolbar .vwf-btn.danger,
.vwf-canvas-toolbar .vwf-btn.danger:disabled { color:var(--vwf-err); opacity:1; -webkit-text-fill-color:currentColor; }
.vwf-btn.ghost { border-color:transparent; background:transparent; }
.vwf-btn.sm { padding:3px 10px; font-size:12px; border-radius:99px; }
.vwf-badge { display:inline-block; padding:1px 8px; border-radius:99px; font-size:10px; border:1px solid var(--vwf-border-strong); color:var(--vwf-text-2); }
.vwf-badge.accent { color:var(--vwf-accent); border-color:currentColor; }
.vwf-list { display:flex; flex-direction:column; gap:8px; }
.vwf-list-item { display:flex; align-items:center; gap:10px; padding:10px 12px; border:1px solid var(--vwf-border); border-radius:10px; background:var(--vwf-canvas); }
.vwf-list-item:hover { border-color:var(--vwf-border-strong); }
.vwf-list-name { font-weight:600; font-size:13px; }
.vwf-list-desc { color:var(--vwf-text-2); font-size:11px; margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:520px; }
.vwf-field { display:flex; flex-direction:column; gap:4px; margin-top:10px; }
.vwf-field-label { display:flex; align-items:center; gap:5px; font-size:12px; font-weight:500; color:var(--vwf-text-2); }
.vwf-field-label .req { color:var(--vwf-err); }
.vwf-field-label.err { color:var(--vwf-err); }
.vwf-help { display:inline-flex; align-items:center; justify-content:center; width:14px; height:14px; border-radius:99px; border:1px solid var(--vwf-border-strong); color:var(--vwf-text-3); font-size:9px; cursor:help; }
.vwf-input, .vwf-select, .vwf-textarea { padding:6px 9px; border:1px solid var(--vwf-border-ctl); border-radius:8px; background:var(--vwf-surface); color:var(--vwf-text); font:inherit; font-size:12px; width:100%; box-sizing:border-box; }
.vwf-select { appearance:auto; }
.vwf-textarea { resize:vertical; line-height:1.5; }
.vwf-mono { font-family:var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Consolas, monospace); }
.vwf-input.err, .vwf-select.err, .vwf-textarea.err { border-color:var(--vwf-err); }
.vwf-err-line { color:var(--vwf-err); font-size:11px; margin-top:2px; overflow-wrap:anywhere; }
.vwf-ok-line { color:var(--vwf-ok); font-size:11px; margin-top:2px; }
.vwf-section { border:1px solid var(--vwf-border); border-radius:10px; background:var(--vwf-surface); padding:10px 12px; margin-top:10px; }
.vwf-subsection { border:1px solid var(--vwf-border); border-radius:8px; background:var(--vwf-canvas); padding:10px 12px; margin-top:10px; }
.vwf-editor-dialog { --vwf-editor-safe-gap:var(--vwf-safe-gap); position:fixed; inset:var(--vwf-editor-safe-gap); z-index:900; width:min(1440px, calc(100vw - var(--vwf-editor-safe-gap) - var(--vwf-editor-safe-gap))); height:min(920px, calc(100vh - var(--vwf-editor-safe-gap) - var(--vwf-editor-safe-gap))); max-width:none; max-height:none; margin:auto; padding:0; border:1px solid var(--vwf-border); border-radius:18px; background:var(--vwf-surface); color:var(--vwf-text); box-shadow:0 24px 80px rgba(0,0,0,.48); overflow:hidden; }
.vwf-editor-dialog[open] { display:flex; flex-direction:column; }
.vwf-editor-dialog::backdrop { background:var(--vwf-mask); backdrop-filter:blur(2px); }
.vwf-editor-head { display:flex; align-items:center; gap:10px; padding:12px 16px; border-bottom:1px solid var(--vwf-border); flex:0 0 auto; }
.vwf-editor-msg { flex:0 0 auto; max-height:min(320px, 38vh); margin:10px 16px 0; white-space:pre-wrap; }
/* 结果条分级呈现（UAT-02 反馈）：## 一级=整体结论，### 二级=逐节点一行；✅/❌/⚠️/➖ 决定色调 */
.vwf-msg-line.l1 { font-weight:600; font-size:13px; margin:2px 0 3px; }
.vwf-msg-line.l2 { padding-left:10px; }
.vwf-msg-line.l3 { padding-left:26px; }
.vwf-msg-line.ok { color:var(--dsw-alias-state-success-primary, #3fb950); }
.vwf-msg-line.bad { color:var(--dsw-alias-state-error-primary, #f85149); }
.vwf-msg-line.warn { color:var(--dsw-alias-state-warn-primary, #f59e0b); }
.vwf-msg-line.muted { color:var(--dsw-alias-label-tertiary, #8a8a8a); }
/* 大工作区（A 编排台）——FEAT-84：外层不再承担页面级滚动。
   改造前 .vwf-editor-body 是 overflow:auto 的共享滚动容器，画布行按内容撑高，
   配置栏一滚就把画布带出视口。现在外层只负责定高与裁剪，三个直接网格项
   （步骤定位 / 画布 / 节点配置栏）各自滚动，互不带动；连接信息走弹窗（V-13）。 */
.vwf-editor-body { flex:1; min-height:0; overflow:hidden; position:relative; overscroll-behavior:contain; }
/* 绝对定位（inset）而不是 height:100% 或 flex 拉伸：列向 flex 派生的高度在 Chromium 里
   不构成百分比可解析的「确定高度」，网格行 minmax(0,1fr) 会退化为 max-content——
   实测内容被撑到 2151px 而容器只有 675px，随后被 overflow:hidden 裁掉（配置栏滚不动、
   画布被推出视口）。inset 给出确定高度，三个滚动区才真正各自生效。 */
.vwf-editor { position:absolute; inset:12px 16px; display:grid; grid-template-columns:minmax(0,224px) minmax(0,1fr) minmax(0,368px); grid-template-rows:minmax(0,1fr); grid-template-areas:"nav canvas config"; gap:12px; align-items:stretch; min-width:0; min-height:0; }
/* 窄屏：流程 / 配置两个区域切换，不把桌面画布压成不可读小图（规格 §11）。
   断点与 matchMedia 使用同一阈值（900px），保证 CSS 与 JS 判定一致。 */
/* 窄屏（≤900px）：流程 / 配置两个区域切换，纯 CSS 驱动（与 JS 无关，matchMedia 缺失也不会错位）。
   未参与当前 grid-template-areas 的网格项必须显式 display:none——否则会被自动放置进隐式行，
   把版面撑坏（实测：配置栏落进隐式行后，切换按钮被拉到 330px 高、画布宽度归零）。 */
.vwf-pane-switch { display:none; }
@media (max-width: 900px) {
  .vwf-pane-switch { display:flex; gap:6px; position:absolute; top:12px; left:16px; right:16px; z-index:3; }
  .vwf-editor { grid-template-columns:minmax(0,1fr); inset:54px 16px 12px; }
  .vwf-editor.pane-flow { grid-template-rows:auto minmax(0,1fr); grid-template-areas:"nav" "canvas"; }
  .vwf-editor.pane-config { grid-template-rows:minmax(0,1fr); grid-template-areas:"config"; }
  .vwf-editor.pane-flow .vwf-inspector { display:none; }
  .vwf-editor.pane-config .vwf-nav-col, .vwf-editor.pane-config .vwf-canvas-col { display:none; }
  /* 步骤定位转为横向位置条：保留步骤方位感，不再占据半个屏幕宽 */
  .vwf-nav-col { flex-direction:row; align-items:stretch; }
  .vwf-nav-col .vwf-wb-steps-body { display:flex; flex-direction:row; gap:6px; overflow-x:auto; overflow-y:hidden; padding:8px 10px; }
  .vwf-wb-step { flex:0 0 auto; min-width:132px; }
}
.vwf-canvas-col { grid-area:canvas; min-width:0; min-height:0; display:flex; flex-direction:column; }
.vwf-canvas-col > .vwf-card { flex:1; min-height:0; display:flex; flex-direction:column; }
.vwf-canvas-wrap { position:relative; height:560px; overflow:auto; display:flex; border-top:1px solid var(--dsw-alias-border-l2, #333); background:var(--dsw-alias-bg-base, #181818); overscroll-behavior:contain; }
/* 工作区内画布由网格行定高，自身滚动；min-height:0 是网格子项能真正收缩的前提 */
.vwf-editor-dialog .vwf-canvas-host { flex:1; min-height:0; display:flex; flex-direction:column; }
.vwf-editor .vwf-canvas-wrap { flex:1; min-height:0; height:auto; background:var(--vwf-wb-canvas); }
.vwf-canvas-stage { flex:0 0 auto; width:max-content; height:max-content; box-sizing:border-box; margin:auto; padding:24px; cursor:grab; }
.vwf-canvas-stage:active { cursor:grabbing; }
/* 画布工具栏：文档流内一行（不再悬浮遮挡入口节点）；窄屏允许提示换行增高 */
.vwf-canvas-toolbar { display:flex; gap:8px; row-gap:6px; align-items:center; flex-wrap:wrap; padding:8px 12px; border-top:1px solid var(--vwf-border); background:var(--vwf-surface); }
.vwf-canvas-toolbar .vwf-btn { flex:0 0 auto; min-height:28px; white-space:nowrap; }
.vwf-toolbar-hint { flex:1 1 240px; min-width:180px; margin-left:2px; line-height:1.45; overflow-wrap:anywhere; }
/* 画布顶部操作按钮组：图标圆形 + 文案，与 Gold-Band 交互形态一致 */
.vwf-toolbar-actions { display:inline-flex; align-items:stretch; border:1px solid var(--vwf-border-ctl); border-radius:999px; background:var(--vwf-canvas); overflow:hidden; }
.vwf-toolbar-action { display:inline-flex; align-items:center; gap:6px; padding:3px 10px; border:0; background:transparent; color:var(--vwf-text); cursor:pointer; font-size:12px; white-space:nowrap; }
.vwf-toolbar-action + .vwf-toolbar-action { border-left:1px solid var(--vwf-border); }
.vwf-toolbar-action:hover:not(:disabled) { background:var(--vwf-accent-surface); }
.vwf-toolbar-action .vwf-toolbar-action-icon { display:inline-flex; align-items:center; justify-content:center; width:22px; height:22px; border-radius:999px; background:var(--vwf-accent-surface); color:var(--vwf-accent); font-size:13px; }
.vwf-toolbar-action.danger,
.vwf-toolbar-action.danger:disabled { color:var(--vwf-err); opacity:1; -webkit-text-fill-color:currentColor; }
.vwf-toolbar-action.danger:hover:not(:disabled) { background:var(--vwf-accent-surface); }
.vwf-toolbar-action:disabled { cursor:not-allowed; }
/* 显示名历史撤销/重做按钮组 */
.vwf-history-group { display:inline-flex; border:1px solid var(--vwf-border-ctl); border-radius:999px; background:var(--vwf-canvas); overflow:hidden; }
.vwf-history-group .vwf-history-btn { border:0; border-radius:0; background:transparent; font-size:14px; min-width:28px; padding:3px 8px; color:var(--vwf-text); }
.vwf-history-group .vwf-history-btn:disabled { opacity:.45; cursor:not-allowed; }
.vwf-svg { display:block; user-select:none; touch-action:none; }
.vwf-menu { position:absolute; z-index:20; min-width:160px; padding:4px; border:1px solid var(--vwf-border); border-radius:10px; background:var(--vwf-surface); box-shadow:0 8px 28px rgba(0,0,0,.4); }
.vwf-menu-item { display:block; width:100%; text-align:left; padding:7px 10px; border:0; border-radius:7px; background:transparent; color:var(--vwf-text); font-size:12px; cursor:pointer; }
.vwf-menu-item:hover { background:var(--vwf-accent-surface); }
.vwf-zoom { position:absolute; right:10px; bottom:10px; z-index:5; display:flex; flex-direction:column; border:1px solid var(--vwf-border-ctl); border-radius:10px; overflow:hidden; background:var(--vwf-surface); }
.vwf-zoom button { width:30px; height:30px; border:0; border-bottom:1px solid var(--vwf-border); background:transparent; color:var(--vwf-text-2); cursor:pointer; font-size:14px; }
.vwf-zoom button:last-child { border-bottom:0; }
.vwf-zoom button:hover { background:var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.08)); }
/* 大工作区语义 token（FEAT-84 共享契约冻结在 prototypes/ui-workbench/DESIGN.md 的 A 编排台）：
   宿主 --dsw-alias-* 优先，缺失时按 A 方向浅色板兜底；深色由 prefers-color-scheme 覆盖同一组变量。
   工作区内一律引用 --vwf-wb-*，避免「深色背景 + 深色字」这类跨主题错配。 */
.vwf-editor-dialog {
  --vwf-wb-canvas:var(--dsw-alias-bg-base, #F1F4FA);
  --vwf-wb-surface:var(--dsw-alias-bg-layer-1, #FFFFFF);
  --vwf-wb-surface-2:var(--dsw-alias-bg-layer-2, #FFFFFF);
  --vwf-wb-text:var(--dsw-alias-label-primary, #1D2B43);
  --vwf-wb-text-2:var(--dsw-alias-label-secondary, #58677E);
  --vwf-wb-accent:var(--dsw-alias-brand-primary, #3D53B6);
  --vwf-wb-accent-text:var(--dsw-alias-brand-text, var(--dsw-alias-brand-primary, #3D53B6));
  --vwf-wb-accent-soft:var(--dsw-alias-brand-fill-soft, #E8ECFF);
  --vwf-wb-border:var(--dsw-alias-border-l2, #C3CCDD);
  --vwf-wb-border-strong:var(--dsw-alias-border-l3, #8E9CB8);
  /* 控件边界（按钮 / 输入 / 可点行）：契约目标 ≥3:1。宿主 border-l3 优先（宿主按自身主题
     给值），兜底在浅色下实测对 #FFFFFF 3.30:1、对画布 #F1F4FA 3.30:1 */
  --vwf-wb-border-control:var(--dsw-alias-border-l3, #7088A8);
}
@media (prefers-color-scheme: dark) {
  .vwf-editor-dialog {
    --vwf-wb-canvas:var(--dsw-alias-bg-base, #101827);
    --vwf-wb-surface:var(--dsw-alias-bg-layer-1, #182338);
    --vwf-wb-surface-2:var(--dsw-alias-bg-layer-2, #182338);
    --vwf-wb-text:var(--dsw-alias-label-primary, #EDF2FF);
    --vwf-wb-text-2:var(--dsw-alias-label-secondary, #ACB9D1);
    --vwf-wb-accent:var(--dsw-alias-brand-primary, #B3C1FF);
    --vwf-wb-accent-text:var(--dsw-alias-brand-text, var(--dsw-alias-brand-primary, #B3C1FF));
    --vwf-wb-accent-soft:var(--dsw-alias-brand-fill-soft, #293759);
    --vwf-wb-border:var(--dsw-alias-border-l2, #3A4A6B);
    --vwf-wb-border-strong:var(--dsw-alias-border-l3, #52658C);
    /* 深色控件边界：兜底实测对 #182338 4.26:1、对 #101827 4.82:1、对强调底 #293759 3.20:1 */
    --vwf-wb-border-control:var(--dsw-alias-border-l3, #8E9CB8);
  }
}
/* 工作区键盘焦点：焦点可见且不被滚动容器裁掉（WCAG 2.2 焦点不被遮挡）。
   第二个选择器用 :is() 提起优先级：工作区内的页签/按钮/目录行等元素选择器在本文件末尾
   的通用焦点规则里带上了类，若不提权会被那条规则按顺序覆盖成设置面板的强调色。 */
.vwf-editor-dialog :focus-visible,
.vwf-editor-dialog :is(a, button, input, select, textarea, summary, [tabindex]):focus-visible { outline:2px solid var(--vwf-wb-accent); outline-offset:2px; }
/* 右侧节点配置栏：网格项自身滚动（不再 position:sticky + height:100% 依附父级滚动） */
.vwf-inspector { grid-area:config; min-width:0; min-height:0; overflow:auto; padding:12px; overscroll-behavior:contain; scroll-padding-bottom:12px; }
.vwf-nav-col { grid-area:nav; min-width:0; min-height:0; display:flex; flex-direction:column; gap:12px; }
.vwf-wb-steps-card { flex:1 1 auto; min-height:0; display:flex; flex-direction:column; }
.vwf-wb-steps-body, .vwf-wb-conn-body { flex:1; min-height:0; overflow:auto; padding:8px 10px; overscroll-behavior:contain; scroll-padding-bottom:12px; }
.vwf-wb-step, .vwf-wb-conn-row { width:100%; text-align:left; border:1px solid var(--vwf-wb-border-control); background:var(--vwf-wb-surface); color:var(--vwf-wb-text); cursor:pointer; font:inherit; font-size:12px; }
.vwf-wb-step { display:flex; align-items:center; gap:8px; padding:8px 10px; border-radius:10px; }
.vwf-wb-step + .vwf-wb-step, .vwf-wb-conn-row + .vwf-wb-conn-row { margin-top:6px; }
.vwf-wb-step:hover { border-color:var(--vwf-wb-border-strong); }
.vwf-wb-step.on { border-color:var(--vwf-wb-accent); background:var(--vwf-wb-accent-soft); color:var(--vwf-wb-text); }
.vwf-wb-step-seq { flex:0 0 auto; min-width:20px; height:20px; padding:0 4px; display:inline-flex; align-items:center; justify-content:center; border-radius:6px; background:var(--vwf-wb-surface-2); border:1px solid var(--vwf-wb-border); color:var(--vwf-wb-text-2); font-size:11px; font-weight:700; font-variant-numeric:tabular-nums; }
.vwf-wb-step.on .vwf-wb-step-seq { border-color:var(--vwf-wb-accent); color:var(--vwf-wb-accent-text); }
.vwf-wb-step-label { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600; }
.vwf-wb-step-role { flex:0 0 auto; color:var(--vwf-wb-text-2); font-size:11px; max-width:88px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.vwf-wb-conn-row { display:flex; flex-direction:column; gap:2px; padding:7px 9px; border-radius:9px; }
.vwf-wb-step:hover, .vwf-wb-conn-row:hover, .vwf-wb-outcome-row:hover { border-color:var(--vwf-wb-border-strong); }
.vwf-wb-conn-row.on { border-color:var(--vwf-wb-accent); }
.vwf-wb-conn-route { overflow-wrap:anywhere; }
.vwf-wb-conn-meta { color:var(--vwf-wb-text-2); font-size:11px; overflow-wrap:anywhere; }
.vwf-wb-conn-kind { flex:0 0 auto; font-size:10px; padding:1px 7px; border-radius:99px; border:1px solid currentColor; white-space:nowrap; }
.vwf-wb-conn-kind.normal { color:var(--dsw-alias-state-success-primary, #1F7A4D); }
.vwf-wb-conn-kind.loop { color:var(--dsw-alias-state-warn-primary, #9A6100); }
.vwf-wb-conn-kind.retry { color:var(--vwf-wb-text-2); }
.vwf-wb-conn-group { font-size:11px; font-weight:700; letter-spacing:.04em; color:var(--vwf-wb-text-2); margin:10px 0 2px; }
.vwf-wb-conn-group:first-child { margin-top:0; }
.vwf-wb-legend { display:flex; flex-direction:column; gap:3px; padding:8px 10px; border-top:1px solid var(--vwf-wb-border); background:var(--vwf-wb-surface-2); }
.vwf-wb-legend-line { font-size:11px; color:var(--vwf-wb-text-2); overflow-wrap:anywhere; }
.vwf-wb-legend-line b { color:var(--vwf-wb-text); }
/* 配置栏三段 tab（V-11，对齐原型 inspector）：第一档是业务词，高级设置 / JSON 不切过去就不渲染内容；
   档位带校验错误时标 ⚠ 并自动切到该档（错误不被隐藏在未选中的档里）。 */
.vwf-wb-tabs { border:1px solid var(--vwf-wb-border); border-radius:10px; background:var(--vwf-wb-surface); margin-top:10px; }
.vwf-wb-tabbar { display:flex; flex-wrap:wrap; gap:16px; padding:0 12px; border-bottom:1px solid var(--vwf-wb-border); position:sticky; top:0; z-index:1; background:var(--vwf-wb-surface); border-radius:10px 10px 0 0; }
.vwf-wb-tab { padding:10px 0; border:0; border-bottom:2px solid transparent; background:transparent; color:var(--vwf-wb-text-2); cursor:pointer; font:inherit; font-size:12px; }
.vwf-wb-tab.on { color:var(--vwf-wb-accent-text); border-bottom-color:var(--vwf-wb-accent); font-weight:600; }
.vwf-wb-tab-err { margin-left:4px; color:var(--dsw-alias-state-error-primary, #e5484d); }
.vwf-wb-tabpanel { padding:11px; }
/* 连接信息弹窗（V-13）：逐条列出全部连接，自身滚动 */
.vwf-conn-dialog { width:min(760px, 94vw); }
/* 工作区内的表单控件与按钮统一使用控件边界色（宿主 border token 服务于宿主表面，
   工作区表面是 A 编排台调色板，V-8 的边界目标按工作区计量） */
.vwf-editor-dialog :is(.vwf-input, .vwf-select, .vwf-textarea):not(.err),
.vwf-editor-dialog .vwf-btn:not(.primary):not(.ghost):not(.danger),
.vwf-editor-dialog .vwf-toolbar-actions,
.vwf-editor-dialog .vwf-card,
.vwf-editor-dialog .vwf-section,
.vwf-editor-dialog .vwf-subsection,
.vwf-editor-dialog .vwf-canvas-toolbar { border-color:var(--vwf-wb-border-control); }
/* 画布面与 SVG 语义色收口到工作区 token：宿主 token 缺失时，预置兜底是纯深色一套，
   与工作区浅色表面相撞会出现「浅底浅字」（实测画布节点名 1.11:1）。作用域限定在
   大工作区，运行看板的只读画布不受影响（属 FEAT-85 范围）。 */
.vwf-editor-dialog .vwf-canvas-wrap { background:var(--vwf-wb-canvas); }
.vwf-editor-dialog .vwf-canvas-toolbar,
.vwf-editor-dialog .vwf-zoom { background:var(--vwf-wb-surface-2); }
.vwf-editor-dialog .vwf-zoom button { color:var(--vwf-wb-text-2); }
.vwf-editor-dialog .vwf-node-card { fill:var(--vwf-wb-surface); stroke:var(--vwf-wb-border-control); }
.vwf-editor-dialog .vwf-node-label { fill:var(--vwf-wb-text); }
.vwf-editor-dialog .vwf-node-kind { fill:var(--vwf-wb-text-2); }
.vwf-editor-dialog .vwf-node-seq { fill:var(--vwf-wb-accent-text); }
.vwf-editor-dialog .vwf-node-seq-badge { fill:var(--vwf-wb-surface); stroke:var(--vwf-wb-accent); }
.vwf-editor-dialog .vwf-entry-badge { fill:var(--vwf-wb-surface); stroke:var(--vwf-wb-border-control); }
.vwf-editor-dialog .vwf-entry-badge-text { fill:var(--vwf-wb-text-2); }
.vwf-editor-dialog .vwf-handle { fill:var(--vwf-wb-text-2); stroke:var(--vwf-wb-surface); }
.vwf-wb-readonly { display:flex; gap:6px; align-items:flex-start; margin-top:8px; padding:8px 10px; border:1px solid var(--vwf-wb-border); border-radius:9px; background:var(--vwf-wb-surface-2); color:var(--vwf-wb-text-2); font-size:11px; }
.vwf-wb-outcome-row { display:flex; flex-direction:column; gap:3px; padding:8px 10px; border:1px solid var(--vwf-wb-border-control); border-radius:9px; background:var(--vwf-wb-surface-2); margin-top:6px; }
.vwf-wb-outcome-name { font-weight:600; }
.vwf-wb-outcome-to { color:var(--vwf-wb-text-2); font-size:11px; overflow-wrap:anywhere; }
/* 工作区固定小节：画布与配置栏内部不再出现页面级滚动条 */
.vwf-wb-pane-tab { padding:6px 14px; border:1px solid var(--vwf-wb-border-control); border-radius:999px; background:var(--vwf-wb-surface); color:var(--vwf-wb-text); cursor:pointer; font:inherit; font-size:12px; }
.vwf-wb-pane-tab.on { border-color:var(--vwf-wb-accent); background:var(--vwf-wb-accent-soft); font-weight:600; }
/* V-5：空态与浮层表面同样只引用语义 token —— 原先的宿主 alias + 深色兜底
   （#1e1e1e / #9a9a9a）会在浅色页面上落成一块深灰，正是「一灰一白」的第二个来源。 */
.vwf-empty { display:grid; place-items:center; min-height:120px; border:1px dashed var(--vwf-border-strong); border-radius:10px; color:var(--vwf-text-2); font-size:12px; padding:16px; text-align:center; }
.vwf-dialog-mask { position:fixed; inset:0; z-index:950; background:var(--vwf-mask); display:flex; align-items:center; justify-content:center; }
.vwf-dialog { width:min(520px, 92vw); max-height:80vh; display:flex; flex-direction:column; border:1px solid var(--vwf-border); border-radius:14px; background:var(--vwf-surface); color:var(--vwf-text); box-shadow:0 24px 64px rgba(0,0,0,.5); padding:16px; gap:10px; }
.vwf-confirm-mask { position:fixed; inset:0; z-index:960; background:var(--vwf-mask); display:flex; align-items:center; justify-content:center; }
.vwf-confirm { width:min(360px, 90vw); display:flex; flex-direction:column; gap:14px; border:1px solid var(--vwf-border); border-radius:14px; background:var(--vwf-surface); color:var(--vwf-text); box-shadow:0 24px 64px rgba(0,0,0,.5); padding:18px; }
.vwf-confirm-title { font-size:14px; font-weight:600; color:var(--vwf-text); }
.vwf-confirm-actions { display:flex; justify-content:flex-end; gap:8px; }
.vwf-dialog-title { font-size:15px; font-weight:600; }
.vwf-dialog-desc { font-size:12px; color:var(--vwf-text-2); overflow-wrap:anywhere; }
.vwf-dialog-issues { max-height:300px; overflow:auto; display:flex; flex-direction:column; gap:6px; border:1px solid var(--vwf-border); border-radius:10px; padding:10px; background:var(--vwf-canvas); }
.vwf-dialog-issue { padding:6px 10px; border-radius:8px; background:var(--vwf-surface); color:var(--vwf-err); font-size:12px; }
/* ── 角色库管理（issue-58；FEAT-86 收口：来源可辨识 / 两行摘要 / 独立滚动详情 / 窄屏）── */
/* FEAT-100 V-1：角色库成为设置页的独立页签，列表内联在页签里（.vwf-role-tab）；
   .vwf-role-mgr 只承载详情 / 表单浮层，因此弹层安全边距与内部滚动约束不变。 */
.vwf-role-tab { display:flex; flex-direction:column; gap:10px; }
.vwf-role-mgr { width:min(780px, 94vw); max-height:calc(100vh - 2 * var(--vwf-safe-gap)); display:flex; flex-direction:column; border:1px solid var(--vwf-border); border-radius:14px; background:var(--vwf-surface); color:var(--vwf-text); box-shadow:0 24px 64px rgba(0,0,0,.5); padding:16px; gap:12px; overflow:hidden; }
.vwf-role-mgr-body { flex:1; min-height:0; overflow:auto; display:flex; flex-direction:column; gap:10px; overscroll-behavior:contain; }
.vwf-role-section-title { font-size:13px; font-weight:600; color:var(--vwf-accent); margin-top:6px; }
.vwf-role-count { color:var(--vwf-text-3); font-weight:400; font-size:11px; }
.vwf-role-row { display:flex; flex-wrap:wrap; align-items:center; gap:6px 10px; padding:8px 10px; border:1px solid var(--vwf-border); border-radius:10px; background:var(--vwf-canvas); }
.vwf-role-row-main { display:flex; flex-wrap:wrap; align-items:center; gap:8px; min-width:0; flex:1 1 auto; }
.vwf-role-row .vwf-role-name { font-weight:600; font-size:13px; color:var(--vwf-text); overflow-wrap:anywhere; }
/* 列表摘要最多两行（V-2）：行高与列表高度不随职责全文增长；连续长串断词或换行，
   不产生横向溢出。摘要为显示层生成，不写回角色原文（规格 §9）。 */
.vwf-role-summary { flex:1 1 100%; min-width:0; color:var(--vwf-text-2); font-size:11px; line-height:1.5; display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; overflow:hidden; overflow-wrap:anywhere; word-break:break-word; }
.vwf-role-actions { display:flex; flex-wrap:wrap; gap:6px; margin-left:auto; }
/* 完整职责的独立滚动区：列表之外单独滚动，键盘可进入（tabindex=0） */
.vwf-role-content { white-space:pre-wrap; font-size:11px; line-height:1.55; max-height:min(340px, 40vh); overflow:auto; overscroll-behavior:contain; border:1px solid var(--vwf-border); border-radius:8px; padding:10px; background:var(--vwf-canvas); overflow-wrap:anywhere; word-break:break-word; }
.vwf-role-refs { display:flex; flex-direction:column; gap:6px; max-height:min(200px, 28vh); overflow:auto; border:1px solid var(--vwf-border); border-radius:8px; padding:8px 10px; background:var(--vwf-canvas); font-size:11px; }
.vwf-role-ref-line { color:var(--vwf-text-2); overflow-wrap:anywhere; }
.vwf-role-empty { padding:14px; border:1px dashed var(--vwf-border-strong); border-radius:10px; color:var(--vwf-text-2); font-size:12px; text-align:center; overflow-wrap:anywhere; }
.vwf-status { font-size:11px; }
.vwf-status.ok { color:var(--vwf-ok); }
.vwf-status.err { color:var(--vwf-err); }
.vwf-status.warn { color:var(--vwf-warn); }
.vwf-code { white-space:pre-wrap; font-family:var(--dsw-font-family-mono, ui-monospace, monospace); font-size:11px; opacity:.9; max-height:320px; overflow:auto; border:1px solid var(--vwf-border); border-radius:8px; padding:10px; background:var(--vwf-canvas); overflow-wrap:anywhere; }
.vwf-table { width:100%; border-collapse:collapse; font-size:11px; }
.vwf-table th, .vwf-table td { text-align:left; padding:4px 8px; border-bottom:1px solid var(--vwf-border); overflow-wrap:anywhere; }
.vwf-table .vwf-fanout-group td { padding-top:9px; font-weight:600; color:var(--vwf-accent); background:var(--vwf-canvas); }
.vwf-json-edit { width:100%; height:520px; box-sizing:border-box; resize:none; font-family:var(--dsw-font-family-mono, ui-monospace, monospace); font-size:11px; line-height:1.6; }
/* ── 窄屏（V-5）：弹层安全边距、按钮折行、详情内部滚动；不缩字号、不隐文字 ── */
@media (max-width: 480px) {
  .vwf-role-mgr { width:100%; padding:12px; }
  .vwf-role-row-main, .vwf-role-actions { flex:1 1 100%; margin-left:0; }
  .vwf-role-actions .vwf-btn { flex:1 1 auto; min-height:28px; }
  .vwf-canvas-toolbar .vwf-btn, .vwf-role-tab > .vwf-row .vwf-btn { flex:1 1 auto; }
}
/* ── SVG 画布 ── */
.vwf-edge-flow { stroke-dasharray:3 17; animation:vwf-dash 3.6s linear infinite; }
@keyframes vwf-dash { to { stroke-dashoffset:-20; } }
.vwf-edge-hit { stroke:transparent; stroke-width:16; fill:none; }
.vwf-node-card { fill:var(--vwf-surface); stroke:var(--vwf-border-strong); stroke-width:1; }
.vwf-node-kind { fill:var(--vwf-text-3); font-size:10px; letter-spacing:.14em; text-transform:uppercase; }
.vwf-node-label { fill:var(--vwf-text); font-size:13px; font-weight:500; }
.vwf-node-seq { fill:var(--vwf-accent); font-size:11px; font-weight:700; font-variant-numeric:tabular-nums; }
.vwf-node-seq-badge { fill:var(--vwf-surface); stroke:var(--vwf-accent); stroke-width:1; }
.vwf-handle { fill:var(--vwf-text-3); stroke:var(--vwf-surface); stroke-width:2; }
/* 节点左右连接把手（拖出/落入连线的源与目标指示）：默认隐藏，节点悬停时显示，
   避免没有对应边的节点右侧出现无意义灰点（验收反馈）。 */
.vwf-handle { opacity:0; pointer-events:none; transition:opacity .12s ease; }
/* 悬停高亮：把手以强调色圆环醒目显示，避免与边起点圆点（同类槽位）混淆而不可见 */
g:hover > .vwf-handle { opacity:1; pointer-events:auto; fill:var(--vwf-accent); stroke:var(--vwf-surface); stroke-width:3; filter:drop-shadow(0 0 4px var(--vwf-accent)); }
.vwf-handle-src { cursor:crosshair; }
.vwf-handle-src:hover { fill:var(--dsw-alias-brand-primary, #4d9fff); }
.vwf-entry-badge { fill:var(--dsw-alias-bg-layer-1, #1e1e1e); stroke:var(--dsw-alias-border-l3, #444); }
.vwf-entry-badge-text { fill:var(--dsw-alias-label-secondary, #9a9a9a); font-size:10px; }
/* ── 滚动条常显样式（画布内纵向滚动 + 工作区四个独立滚动区 + 弹窗） ── */
.vwf-canvas-wrap::-webkit-scrollbar, .vwf-editor-body::-webkit-scrollbar, .vwf-inspector::-webkit-scrollbar, .vwf-wb-steps-body::-webkit-scrollbar, .vwf-wb-conn-body::-webkit-scrollbar, .vwf-dialog-issues::-webkit-scrollbar { width:10px; height:10px; }
.vwf-canvas-wrap::-webkit-scrollbar-thumb, .vwf-editor-body::-webkit-scrollbar-thumb, .vwf-inspector::-webkit-scrollbar-thumb, .vwf-wb-steps-body::-webkit-scrollbar-thumb, .vwf-wb-conn-body::-webkit-scrollbar-thumb, .vwf-dialog-issues::-webkit-scrollbar-thumb { background:var(--dsw-alias-border-l3, #444); border-radius:99px; border:2px solid transparent; background-clip:padding-box; }
.vwf-canvas-wrap::-webkit-scrollbar-track, .vwf-editor-body::-webkit-scrollbar-track, .vwf-inspector::-webkit-scrollbar-track, .vwf-wb-steps-body::-webkit-scrollbar-track, .vwf-wb-conn-body::-webkit-scrollbar-track, .vwf-dialog-issues::-webkit-scrollbar-track { background:transparent; }
/* ── FEAT-85 运行列表与 Logical Run 详情 ──────────────────────────────────
   排版基线对齐 DESIGN.md 的 A 编排台：正文 14px、说明 12px、圆角 8/12、
   间距 4/8/12/16；状态同时给语义色与文字（不靠颜色单独承载含义）。
   V-5 主题一致：运行列表与流程库同处设置面板，一律引用 --vwf-*；运行详情与模板
   编辑同处大工作区层，一律引用 --vwf-wb-*（宿主 alias 优先，见 .vwf-editor-dialog）。
   原先列表/详情直接写宿主 alias + 深色兜底（#1e1e1e / #9a9a9a / #4d9fff），在浅色
   页面上会落成深灰底或不可见文字——这就是两页「一灰一白」的来源。 */
.vwf-filters { display:flex; flex-wrap:wrap; gap:8px 12px; padding:10px 14px 4px; }
.vwf-filter { display:flex; flex-direction:column; gap:2px; min-width:150px; flex:1 1 150px; }
.vwf-filter .vwf-input { width:100%; }
.vwf-run-list { max-height:460px; overflow-y:auto; padding:4px 14px 8px; }
.vwf-run-group { margin-top:10px; }
.vwf-run-group-head { display:flex; align-items:center; gap:8px; margin:0 0 6px; font-size:12px; font-weight:600; color:var(--vwf-text-2); }
.vwf-run-row { display:block; width:100%; text-align:left; font-size:14px; cursor:pointer; margin-bottom:8px; padding:10px 12px; border:1px solid var(--vwf-border); border-radius:12px; background:var(--vwf-canvas); color:var(--vwf-text); }
.vwf-run-row:hover { border-color:var(--vwf-accent); background:var(--vwf-accent-surface); }
.vwf-run-row p { margin:4px 0; }
.vwf-run-row-note { font-size:12px; color:var(--vwf-text-2); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.vwf-run-row small { font-size:12px; color:var(--vwf-text-2); }
/* 详情在大工作区层内：外层只定高与裁剪，正文自身滚动（与编辑器三个滚动区同口径）。 */
.vwf-rd-scroll { position:absolute; inset:12px 16px; overflow:auto; overscroll-behavior:contain; scroll-padding-bottom:12px; }
.vwf-rd-main { display:grid; grid-template-columns:minmax(170px, 220px) 1fr; gap:12px; align-items:start; margin-top:8px; }
.vwf-rd-side { display:flex; flex-direction:column; gap:12px; }
.vwf-rd-body { min-width:0; }
.vwf-rd-kv { margin-top:4px; font-size:12px; }
.vwf-node-dir-row { display:flex; align-items:center; justify-content:space-between; gap:8px; width:100%; text-align:left; cursor:pointer; padding:6px 8px; margin-top:4px; border:1px solid transparent; border-radius:8px; background:transparent; color:var(--vwf-wb-text); font-size:13px; }
.vwf-node-dir-row:hover { background:var(--vwf-wb-accent-soft); }
.vwf-node-dir-row.selected { border-color:var(--vwf-wb-accent); background:var(--vwf-wb-accent-soft); }
.vwf-node-dir-label { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.vwf-sec { font-size:12px; font-weight:600; color:var(--vwf-wb-text); margin-top:8px; }
.vwf-note { margin-top:6px; padding:6px 10px; border-radius:8px; font-size:12px; border:1px solid var(--vwf-wb-border); background:var(--vwf-wb-surface-2); color:var(--vwf-wb-text-2); }
.vwf-note.warn { border-color:var(--vwf-warn); color:var(--vwf-wb-text); }
.vwf-tab-panel { padding:10px 2px 4px; font-size:14px; }
.vwf-fanout-item { margin-top:8px; padding:8px 10px; border:1px solid var(--vwf-wb-border); border-radius:8px; }
/* 键盘焦点可见（窄屏与键盘同等考虑）。工作区层内的同类元素由前面 .vwf-editor-dialog
   的 :is() 提权规则接管，用工作区自己的强调色；这里只服务设置面板。 */
.vwf-run-row:focus-visible, .vwf-node-dir-row:focus-visible, .vwf-tab:focus-visible, .vwf-btn:focus-visible,
.vwf-input:focus-visible, .vwf-textarea:focus-visible, .vwf-filter select:focus-visible { outline:2px solid var(--vwf-focus); outline-offset:2px; }
@media (max-width: 560px) {
  .vwf-rd-main { grid-template-columns:1fr; }
  .vwf-filter { flex:1 1 100%; }
  .vwf-run-list { max-height:none; }
}
@media (prefers-reduced-motion: reduce) { .vwf-run-row, .vwf-node-dir-row, .vwf-tab { transition:none; } }
`)

    const h = React.createElement

    // ── 图常量（对应 workflowGraph.ts）──────────────────────────────────────
    // 画布为自上而下布局（V-12）：NODE_W / NODE_H 是节点在屏幕上的宽高，
    // 下面的分层算法在「流向轴 = x」的抽象空间里计算（x = 步骤序号方向，y = 同级并排方向），
    // 出图前统一转置成屏幕坐标，因此常量在算法里分别落到另一条轴上。
    const NODE_W = 220
    const NODE_H = 66
    const TERM_W = 140
    const TERM_H = 44
    const NODE_SEP = 88
    const RANK_SEP = 116
    const EDGE_LANE_GAP = 82
    const EDGE_LANE_SEP = 38
    const EDGE_ROUTE_STUB = 34
    const EDGE_LABEL_H = 18
    const MARGIN_X = 56
    const MARGIN_Y = 64
    const CANVAS_PAD = 24
    const END_NODE = '$end'
    const HUMAN_DECISION_ID = '$human-decision'
    const STATUS_COLOR = { running: 'var(--vwf-accent)', pass: 'var(--vwf-ok)', fail: 'var(--vwf-err)', human: 'var(--vwf-warn)' }
    // 状态双通道（FEAT-86 / V-4）：形状与文字同时表达状态，不只用颜色。
    // 形状冗余编码色调分组——✓ 终态通过 / ✕ 终态失败 / ● 进行中 /
    // ! 等待人工或受阻（可恢复等待态）；灰度或色觉差异下仍可读出状态。
    const STATUS_SHAPE = { ok: '✓', err: '✕', run: '●', wait: '!' }
    const EDGE_OK = 'var(--vwf-accent)'
    const EDGE_FAIL = 'var(--vwf-err)'
    const EDGE_TECH = 'var(--vwf-text-3)'
    const EDGE_SELECTED = 'var(--vwf-text)'
    const ACCENT = 'var(--vwf-accent)'
    const SCHEMA_DEBOUNCE_MS = 2000
    const VALIDATE_DEBOUNCE_MS = 350

    function clone(x) { return JSON.parse(JSON.stringify(x)) }

    // ── 拓扑与布局（对应 workflowGraph.ts 的 successTopologyOrder /
    //    deriveEntryCandidateIds / computeBackwardLanes / layoutSuccessPath）──
    // 两级序号：主序号 = 前向最长路列（横轴 0…n）；同列多节点 = m.1…m.k（纵轴）。
    // `$human-decision` 为透明跳板：A→HD→B 在排版上等价于前向边 A→B（回退旁路除外）。
    // 基图邻接（不含 HD）：用于判断 HD 出边是否回指上游（如验收退回→开发）。
    function buildBaseForwardAdj(dsl, idSet) {
      const adj = new Map()
      idSet.forEach(id => adj.set(id, []))
      ;(dsl.edges || []).forEach(e => {
        if (!isStructuralEdge(e) || isRollbackEdge(e)) return
        if (e.from === e.to) return
        if (e.from === HUMAN_DECISION_ID || e.to === HUMAN_DECISION_ID) return
        if (!idSet.has(e.from) || !idSet.has(e.to)) return
        adj.get(e.from).push(e.to)
      })
      return adj
    }
    function canReachInAdj(adj, from, to) {
      if (from === to) return true
      const seen = new Set()
      const stack = [from]
      while (stack.length) {
        const id = stack.pop()
        if (seen.has(id)) continue
        seen.add(id)
        for (const next of (adj.get(id) || [])) {
          if (next === to) return true
          if (!seen.has(next)) stack.push(next)
        }
      }
      return false
    }
    // 排版用前向边对：真实节点↔真实节点/$end，含 HD 透传；跳过回退与「HD 出边回指上游」。
    function forEachLayoutForwardPair(dsl, idSet, visit) {
      const edges = dsl.edges || []
      const baseAdj = buildBaseForwardAdj(dsl, idSet)
      const hdOuts = edges.filter(e =>
        e && e.from === HUMAN_DECISION_ID && isStructuralEdge(e) && !isRollbackEdge(e) && e.to !== HUMAN_DECISION_ID
      )
      edges.forEach(e => {
        if (!isStructuralEdge(e) || isRollbackEdge(e)) return
        if (e.from === e.to) return
        if (e.from === HUMAN_DECISION_ID) return
        if (!idSet.has(e.from)) return
        if (e.to === HUMAN_DECISION_ID) {
          hdOuts.forEach(out => {
            if (out.to === END_NODE) { visit(e.from, out.to, out); return }
            if (!idSet.has(out.to)) return
            // 目标能到达起点 ⇒ 回退旁路（退回开发等），不参与主序号前进
            if (canReachInAdj(baseAdj, out.to, e.from)) return
            visit(e.from, out.to, out)
          })
          return
        }
        if (idSet.has(e.to) || e.to === END_NODE) {
          // 成功环：目标已能回到起点则不推进主序号，避免画布被横向撑爆
          if (e.to !== END_NODE && canReachInAdj(baseAdj, e.to, e.from)) return
          visit(e.from, e.to, e)
        }
      })
    }
    function successTopologyOrder(dsl) {
      const ids = (dsl.nodes || []).map(n => n && n.id).filter(Boolean)
      const idSet = new Set(ids)
      const adjacency = new Map()
      const indegree = new Map()
      ids.forEach(id => { adjacency.set(id, []); indegree.set(id, 0) })
      forEachLayoutForwardPair(dsl, idSet, (from, to) => {
        if (!idSet.has(to)) return
        adjacency.get(from).push(to)
        indegree.set(to, (indegree.get(to) || 0) + 1)
      })
      const queued = new Set()
      const queue = []
      const pushRoot = (id) => { if (!idSet.has(id) || queued.has(id)) return; queued.add(id); queue.push(id) }
      pushRoot(dsl.entry)
      ids.forEach(id => { if ((indegree.get(id) || 0) === 0) pushRoot(id) })
      const ordered = []
      const leftover = () => ids.filter(id => !queued.has(id))
      while (queue.length || leftover().length) {
        if (!queue.length) pushRoot(leftover()[0])
        const id = queue.shift()
        ordered.push(id)
        ;(adjacency.get(id) || []).forEach(next => {
          indegree.set(next, (indegree.get(next) || 0) - 1)
          if ((indegree.get(next) || 0) === 0) pushRoot(next)
        })
      }
      const order = new Map()
      ordered.forEach((id, i) => order.set(id, i))
      return order
    }

    function isBackwardEdge(from, to, order) {
      const s = order.get(from)
      const tt = order.get(to)
      return s !== undefined && tt !== undefined && tt < s
    }

    function normalizeEntry(dsl) {
      const candidates = deriveEntryCandidates(dsl)
      const entry = candidates.length === 1 ? candidates[0] : (dsl.entry || '')
      return dsl.entry === entry ? dsl : { ...dsl, entry }
    }

    function computeBackwardLanes(edges, order) {
      const lanes = new Map()
      edges.forEach((e, index) => {
        if (isBackwardEdge(e.from, e.to, order)) lanes.set(index, lanes.size)
      })
      return lanes
    }

    // 边避让：跨节点/回路边统一走上方正交车道；同标签位置的重复边也改走独立车道。
    // 边避让规则：
    //   - 从左往右且需要绕行（跨 1+ 节点）→ 往下绕行；
    //   - 从右往左（回退/失败）→ 往上绕行；
    //   - 无遮挡的前向边 → 直连。
    // 起点锚点在每个节点右边框上按「上绕 / 直连 / 下绕」从上到下占用；终点固定为目标
    // 节点左边框垂直居中。保证同节点多边起点不重叠（规则 5/6）。
    function computeEdgeRoutes(edges, pos, lanes) {
      const routes = new Map()
      const infos = []
      const laneCount = { up: 0, down: 0 }
      ;(edges || []).forEach((e, index) => {
        const a = pos[e.from]
        const b = pos[e.to]
        if (!a || !b) return
        const x1 = a.x + a.w
        const y1 = a.y + a.h / 2
        const x2 = b.x
        const y2 = b.y + b.h / 2
        const left = Math.min(x1, x2)
        const right = Math.max(x1, x2)
        const between = Object.keys(pos).map(id => ({ id, p: pos[id] })).filter(item => {
          const p = item.p
          if (item.id === e.from || item.id === e.to) return false
          return p.x < right && p.x + p.w > left
        })
        const backward = lanes.has(index)
        // 跨节点定义：前向边的水平区段内存在任一无关节点 → 下绕。
        const kind = backward ? 'up' : (between.length > 0 ? 'down' : 'direct')
        infos.push({ index, e, x1, y1, x2, y2, between, kind })
      })

      // 起点锚点固定 3 个槽位：上绕=上槽、直连=中槽、下绕=下槽；同类边共享同一槽位。
      const borderAnchor = (id, kind) => {
        const node = pos[id]
        if (!node) return 0
        const pad = 8
        const safeTop = node.y + pad
        const safeBottom = node.y + node.h - pad
        const slot = kind === 'up' ? 0 : kind === 'direct' ? 1 : 2
        return safeTop + (slot + 0.5) * ((safeBottom - safeTop) / 3)
      }

      // 平行直连边共享起点槽位与终点垂直居中，但曲线必须分离以免后画的 path 拦截点击。
      const parallelDirect = new Map()
      infos.forEach((info) => {
        if (info.kind !== 'direct') return
        const pk = info.e.from + '->' + info.e.to
        const list = parallelDirect.get(pk) || []
        list.push(info)
        parallelDirect.set(pk, list)
      })

      infos.forEach((info) => {
        const { index, e, x1, x2, y1, y2, between, kind } = info
        const yStart = borderAnchor(e.from, kind)
        const yEnd = y2
        if (kind === 'direct') {
          const pk = e.from + '->' + e.to
          const list = parallelDirect.get(pk) || []
          const parallelIndex = list.indexOf(info)
          const parallelCount = list.length
          routes.set(index, { kind, yStart, yEnd, routed: false, parallelIndex, parallelCount })
          return
        }
        const lane = kind === 'up' ? laneCount.up++ : laneCount.down++
        const boundaryTop = Math.min(y1, y2, ...between.map(item => item.p.y))
        const boundaryBottom = Math.max(y1, y2, ...between.map(item => item.p.y + item.p.h))
        const laneY = kind === 'up'
          ? boundaryTop - EDGE_LANE_GAP - lane * EDGE_LANE_SEP
          : boundaryBottom + EDGE_LANE_GAP + lane * EDGE_LANE_SEP
        routes.set(index, {
          kind,
          yStart,
          yEnd,
          routed: true,
          laneY,
          channelStart: x1 + EDGE_ROUTE_STUB,
          channelEnd: x2 - EDGE_ROUTE_STUB,
          labelX: (x1 + EDGE_ROUTE_STUB + x2 - EDGE_ROUTE_STUB) / 2,
          labelY: laneY,
        })
      })
      return routes
    }

    // 分层布局：前向结构边（含 HD 透传）最长路定主序号；同列按拓扑序定子序号并堆叠。
    // 抽象空间里 x = 流向轴（主序号前进方向）、y = 同级并排轴；出图前转置为屏幕坐标，
    // 于是入口落在顶部、流程自上而下展开，同一主序号的兄弟步骤左右并排（V-12）。
    function layoutGraph(dsl, extraTerminals) {
      const nodeIds = (dsl.nodes || []).map(n => n.id).filter(Boolean)
      const idSet = new Set(nodeIds)
      const order = successTopologyOrder(dsl)
      const terminalIds = []
      ;(dsl.edges || []).forEach(e => { if (e.to === END_NODE && terminalIds.indexOf(END_NODE) < 0) terminalIds.push(END_NODE) })
      ;(extraTerminals || []).forEach(id => { if (terminalIds.indexOf(id) < 0) terminalIds.push(id) })
      const allIds = nodeIds.concat(terminalIds)
      // 抽象尺寸：w = 沿流向的占用（转置后成为节点高度），h = 同级并排的占用（成为节点宽度）
      const sizeOf = (id) => id === END_NODE ? { w: TERM_H, h: TERM_W } : { w: NODE_H, h: NODE_W }

      // 主序号（rank）：前向边最长路；回退边 / HD 回指上游不把目标拉到更右
      const rank = {}
      allIds.forEach(id => { rank[id] = 0 })
      let changed = true
      let guard = 0
      while (changed && guard++ < 100) {
        changed = false
        forEachLayoutForwardPair(dsl, idSet, (from, to) => {
          if (!(idSet.has(to) || to === END_NODE)) return
          if (rank[from] + 1 > (rank[to] || 0)) { rank[to] = rank[from] + 1; changed = true }
        })
      }
      // $end 也可能只被非透传 failure 边指向；补一次直接边（非 rollback 结构边）
      ;(dsl.edges || []).forEach(e => {
        if (!e || e.to !== END_NODE || !idSet.has(e.from)) return
        if (isRollbackEdge(e)) return
        if (!isStructuralEdge(e) && isBackwardEdge(e.from, e.to, order)) return
        if (rank[e.from] + 1 > (rank[END_NODE] || 0)) rank[END_NODE] = rank[e.from] + 1
      })

      const layers = new Map()
      allIds.forEach(id => {
        const r = rank[id] || 0
        if (!layers.has(r)) layers.set(r, [])
        layers.get(r).push(id)
      })
      const ranks = Array.from(layers.keys()).sort((a, b) => a - b)
      ranks.forEach(r => layers.get(r).sort((a, b) => (order.get(a) || 0) - (order.get(b) || 0)))

      // 两级序号标签：单列单节点 → "m"；同列多个 → "m.1"…"m.k"（$end 不标业务序号）
      const seqLabels = {}
      ranks.forEach(r => {
        const ids = layers.get(r).filter(id => id !== END_NODE)
        if (ids.length === 1) {
          seqLabels[ids[0]] = String(r)
        } else {
          ids.forEach((id, i) => { seqLabels[id] = r + '.' + (i + 1) })
        }
      })

      // 每层高度与整体居中
      const layerHeights = new Map()
      let maxLayerH = 0
      ranks.forEach(r => {
        const ids = layers.get(r)
        const hsum = ids.reduce((sum, id) => sum + sizeOf(id).h, 0) + NODE_SEP * (ids.length - 1)
        layerHeights.set(r, hsum)
        if (hsum > maxLayerH) maxLayerH = hsum
      })
      const pos = {}
      let x = MARGIN_X
      ranks.forEach(r => {
        const ids = layers.get(r)
        let layerW = 0
        ids.forEach(id => { layerW = Math.max(layerW, sizeOf(id).w) })
        let y = MARGIN_Y + (maxLayerH - layerHeights.get(r)) / 2
        ids.forEach(id => {
          const s = sizeOf(id)
          pos[id] = { x: x, y: y, w: s.w, h: s.h }
          y += s.h + NODE_SEP
        })
        x += layerW + RANK_SEP
      })
      let maxX = 0
      let maxY = 0
      allIds.forEach(id => { const p = pos[id]; if (p) { maxX = Math.max(maxX, p.x + p.w); maxY = Math.max(maxY, p.y + p.h) } })
      const lanes = computeBackwardLanes(dsl.edges || [], order)
      const routes = computeEdgeRoutes(dsl.edges || [], pos, lanes)
      // 上绕车道计入上边界（不足时整体下移）；下绕车道计入下边界。
      let minRouteY = Infinity
      let maxRouteY = -Infinity
      routes.forEach(route => {
        if (!route.routed) return
        minRouteY = Math.min(minRouteY, route.laneY)
        maxRouteY = Math.max(maxRouteY, route.laneY + EDGE_LABEL_H)
      })
      const routeShift = minRouteY < CANVAS_PAD ? CANVAS_PAD - minRouteY : 0
      if (routeShift > 0) {
        allIds.forEach(id => { if (pos[id]) pos[id].y += routeShift })
        routes.forEach(route => {
          route.yStart += routeShift
          route.yEnd += routeShift
          if (route.routed) { route.laneY += routeShift; route.labelY += routeShift }
        })
        maxY += routeShift
        maxRouteY += routeShift
      }
      const contentBottom = Math.max(maxY, maxRouteY > -Infinity ? maxRouteY : maxY)
      // ── 转置为屏幕坐标（V-12）──
      // 抽象点 (a, b) → 屏幕 (x = b, y = a)：节点矩形交换宽高，边路径逐点转置后即为
      // 「源节点下边框出手、目标节点上边框入手」的纵向连线；回环与跨节点避让车道
      // 分别走在节点左右两侧（抽象空间的上绕/下绕）。
      const screenPos = {}
      allIds.forEach(id => {
        const p = pos[id]
        if (p) screenPos[id] = { x: p.y, y: p.x, w: p.h, h: p.w }
      })
      const screenRoutes = new Map()
      routes.forEach((route, index) => {
        const e = (dsl.edges || [])[index]
        const a = e && pos[e.from]
        const b = e && pos[e.to]
        if (!a || !b) return
        const out = a.x + a.w
        const back = b.x
        const start = { startX: route.yStart, startY: out }
        if (route.routed) {
          screenRoutes.set(index, {
            kind: route.kind, ...start,
            d: 'M ' + route.yStart + ' ' + out
              + ' L ' + route.yStart + ' ' + route.channelStart
              + ' L ' + route.laneY + ' ' + route.channelStart
              + ' L ' + route.laneY + ' ' + route.channelEnd
              + ' L ' + route.yEnd + ' ' + route.channelEnd
              + ' L ' + route.yEnd + ' ' + back,
            labelX: route.laneY, labelY: route.labelX,
          })
          return
        }
        // 平行直连边：共享起点槽位与终点锚点，靠腰部偏移分离曲线与命中路径
        const off = (route.parallelCount > 1 && route.parallelIndex != null)
          ? (route.parallelIndex - (route.parallelCount - 1) / 2) * 3
          : 0
        const waist = (out + back) / 2 + off
        screenRoutes.set(index, {
          kind: route.kind, ...start,
          d: 'M ' + route.yStart + ' ' + out + ' C ' + route.yStart + ' ' + waist + ', ' + route.yEnd + ' ' + waist + ', ' + route.yEnd + ' ' + back,
          labelX: (route.yStart + route.yEnd) / 2, labelY: waist,
        })
      })
      return { pos: screenPos, W: contentBottom + MARGIN_Y, H: maxX + MARGIN_X, lanes, routes: screenRoutes, order, seqLabels, rank }
    }

    function uniqueNodeId(dsl, base) {
      let candidate = base
      let index = 1
      while ((dsl.nodes || []).some(n => n.id === candidate)) { index += 1; candidate = base + '-' + index }
      return candidate
    }

    function sanitizeNodeId(value, dsl, currentId) {
      const sanitized = String(value || '').trim().replace(/[\\/:*?"<>|\x00-\x1F\x7F]/g, '-')
      if (!sanitized) return currentId || uniqueNodeId(dsl, 'node')
      if (sanitized === currentId) return sanitized
      return (dsl.nodes || []).some(n => n.id === sanitized) ? uniqueNodeId(dsl, sanitized) : sanitized
    }

    // ── 基础表单件 ──────────────────────────────────────────────────────────
    function HelpDot(props) {
      return h('span', { className: 'vwf-help', title: props.text }, '?')
    }

    function Field(props) {
      const errs = props.errors || []
      return h('div', { className: 'vwf-field' },
        h('div', { className: 'vwf-field-label' + (errs.length ? ' err' : '') },
          h('span', null, props.label),
          props.help ? h(HelpDot, { text: props.help }) : null,
          props.required ? h('span', { className: 'req' }, '*') : null
        ),
        props.children,
        errs.map((m, i) => h('div', { key: i, className: 'vwf-err-line' }, m))
      )
    }

    function VwfSelect(props) {
      // 支持分组选项：option 带 group 时按连续 group 渲染 <optgroup>（角色选择区分
      // 内置/自定义；无 group 的选项（占位、兜底值）平铺在 optgroup 之外）。
      const renderOpt = (o) => h('option', { key: o.value, value: o.value, title: o.title || '' }, o.label)
      const groups = []
      const flat = []
      let cur = null
      for (const o of props.options || []) {
        if (o && o.group) {
          if (!cur || cur.group !== o.group) { cur = { group: o.group, items: [] }; groups.push(cur) }
          cur.items.push(o)
        } else {
          flat.push(o)
          cur = null
        }
      }
      return h('select', {
        className: 'vwf-select' + (props.invalid ? ' err' : ''),
        value: props.value,
        disabled: !!props.disabled,
        title: props.title || '',
        onChange: (ev) => props.onChange(ev.target.value),
      }, flat.map(renderOpt).concat(groups.map(g => h('optgroup', { key: g.group, label: g.group }, g.items.map(renderOpt)))))
    }

    // ── SVG 画布（编辑态与运行看板共用）────────────────────────────────────
    // readOnly = 整块只读视图（无把手/菜单/连线，也不选中）；
    // structureLocked = 仅锁结构（内置模板：仍可点选节点与连接做定位与查看，不能改结构）。
    // 两者都不渲染连线把手与右键菜单。
    function Canvas(props) {
      const dsl = props.dsl
      const wrapRef = React.useRef(null)
      const svgRef = React.useRef(null)
      const [scale, setScale] = React.useState(1)
      const [panOffset, setPanOffset] = React.useState({ x: 0, y: 0 })
      const [connect, setConnect] = React.useState(null) // {from, x, y}
      const [hoverTarget, setHoverTarget] = React.useState(null) // 拖线时鼠标指向的目标节点（高亮）
      const [menu, setMenu] = React.useState(null) // {x, y}
      const panRef = React.useRef(null)
      const lay = React.useMemo(
        () => layoutGraph(dsl, props.visibleTerminals || []),
        [JSON.stringify({ entry: dsl.entry || '', n: (dsl.nodes || []).map(n => n.id), e: (dsl.edges || []).map(e => [e.from, e.to, e.on, e.outcome, e.countRound]), v: props.visibleTerminals || [] })]
      )
      const pos = lay.pos
      const W = lay.W
      const H = lay.H
      const seqLabels = lay.seqLabels || {}

      const fitView = React.useCallback(() => {
        const wrap = wrapRef.current
        if (!wrap) return
        const s = Math.min(1.2, Math.max(0.3, Math.min((wrap.clientWidth - CANVAS_PAD * 2) / W, (wrap.clientHeight - CANVAS_PAD * 2) / H)))
        setScale(s)
        setPanOffset({ x: 0, y: 0 })
        ctx.timeout(() => {
          if (!wrapRef.current) return
          const stageW = Math.max(W * s + CANVAS_PAD * 2, wrapRef.current.clientWidth)
          const stageH = Math.max(H * s + CANVAS_PAD * 2, wrapRef.current.clientHeight)
          wrapRef.current.scrollLeft = Math.max(0, (stageW - wrapRef.current.clientWidth) / 2)
          wrapRef.current.scrollTop = Math.max(0, (stageH - wrapRef.current.clientHeight) / 2)
        }, 0)
      }, [W, H])
      const fittedRef = React.useRef(false)
      React.useEffect(() => {
        if (fittedRef.current) return undefined
        fittedRef.current = true
        // 编辑器宿主是先渲染 <dialog>、再在父级 effect 中 showModal；初始 fit 延后到
        // 下一轮，确保读到的是弹层打开后的真实可视尺寸，而不是 display:none 的 0 尺寸。
        return ctx.timeout(fitView, 0)
      }, [fitView])
      React.useEffect(() => { props.registerFit && props.registerFit(fitView) }, [fitView])
      // 定位到指定节点（校验弹窗关闭后聚焦首个问题节点，对应 Gold-Band 的 setCenter）
      const posRef = React.useRef(pos)
      React.useEffect(() => { posRef.current = pos }, [pos])
      React.useEffect(() => {
        props.registerScrollTo && props.registerScrollTo((id) => {
          const p = posRef.current[id]
          const wrap = wrapRef.current
          const svg = svgRef.current
          if (!p || !wrap || !svg) return
          const wrapRect = wrap.getBoundingClientRect()
          const svgRect = svg.getBoundingClientRect()
          const dx = (svgRect.left - wrapRect.left) + p.x * scaleRef.current - wrap.clientWidth / 2
          const dy = (svgRect.top - wrapRect.top) + p.y * scaleRef.current - wrap.clientHeight / 2
          wrap.scrollLeft += dx
          wrap.scrollTop += dy
        })
      }, [])

      // 滚轮缩放（指针锚定；stage 居中后按 SVG 实际屏幕位置换算）
      const scaleRef = React.useRef(scale)
      React.useEffect(() => { scaleRef.current = scale }, [scale])
      React.useEffect(() => {
        const wrap = wrapRef.current
        if (!wrap) return undefined
        const onWheel = (ev) => {
          ev.preventDefault()
          const svg = svgRef.current
          if (!svg) return
          const svgRect = svg.getBoundingClientRect()
          const px = (ev.clientX - svgRect.left) / scaleRef.current
          const py = (ev.clientY - svgRect.top) / scaleRef.current
          const next = Math.min(1.6, Math.max(0.3, +(scaleRef.current * (ev.deltaY < 0 ? 1.12 : 0.89)).toFixed(3)))
          setScale(next)
          ctx.timeout(() => {
            if (!wrapRef.current || !svgRef.current) return
            const nextRect = svgRef.current.getBoundingClientRect()
            wrapRef.current.scrollLeft += (nextRect.left + px * next) - ev.clientX
            wrapRef.current.scrollTop += (nextRect.top + py * next) - ev.clientY
          }, 0)
        }
        wrap.addEventListener('wheel', onWheel, { passive: false })
        return () => wrap.removeEventListener('wheel', onWheel)
      }, [])
      const toGraph = (ev) => {
        const svg = svgRef.current
        if (!svg) return null
        const rect = svg.getBoundingClientRect()
        return { x: (ev.clientX - rect.left) / scale, y: (ev.clientY - rect.top) / scale }
      }

      // 画布拖拽平移：任意非连线把手区域都可拖动；有滚动空间的轴写 scroll，
      // 没有滚动空间的轴写 stage transform，保证小工作流也能四向移动。
      const onPanePointerDown = (ev) => {
        if (connect) return
        if (ev.button !== undefined && ev.button !== 0) return
        const wrap = wrapRef.current
        const target = ev.target
        const inCanvas = target === wrap || !!(target && typeof target.closest === 'function' && target.closest('.vwf-canvas-stage'))
        const isConnectHandle = !!(target && typeof target.closest === 'function' && target.closest('.vwf-handle-src'))
        if (!wrap || !inCanvas || isConnectHandle) return
        ev.preventDefault()
        panRef.current = {
          sx: ev.clientX,
          sy: ev.clientY,
          left: wrap.scrollLeft,
          top: wrap.scrollTop,
          offsetX: panOffset.x,
          offsetY: panOffset.y,
          canScrollX: wrap.scrollWidth > wrap.clientWidth + 1,
          canScrollY: wrap.scrollHeight > wrap.clientHeight + 1,
          moved: false,
        }
        const move = (me) => {
          const p = panRef.current
          if (!p) return
          const dx = me.clientX - p.sx
          const dy = me.clientY - p.sy
          if (Math.abs(dx) + Math.abs(dy) > 3) p.moved = true
          if (p.canScrollX) wrap.scrollLeft = p.left - dx
          if (p.canScrollY) wrap.scrollTop = p.top - dy
          if (!p.canScrollX || !p.canScrollY) {
            setPanOffset({
              x: p.canScrollX ? p.offsetX : p.offsetX + dx,
              y: p.canScrollY ? p.offsetY : p.offsetY + dy,
            })
          }
        }
        const up = () => {
          panRef.current = null
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
      }

      const hitNode = (pt) => {
        if (!pt) return null
        for (const id of Object.keys(pos)) {
          const p = pos[id]
          if (pt.x >= p.x && pt.x <= p.x + p.w && pt.y >= p.y && pt.y <= p.y + p.h) return id
        }
        return null
      }

      const onSourceDown = (id, ev) => {
        ev.stopPropagation()
        ev.preventDefault()
        const pt = toGraph(ev)
        if (!pt) return
        setConnect({ from: id, x: pt.x, y: pt.y })
        const move = (me) => {
          const p2 = toGraph(me)
          if (!p2) return
          setConnect(c => (c ? { ...c, x: p2.x, y: p2.y } : c))
          const hit = hitNode(p2)
          setHoverTarget(prev => (prev === hit ? prev : hit))
        }
        const up = (ue) => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
          const p2 = toGraph(ue)
          const target = hitNode(p2)
          setConnect(null)
          setHoverTarget(null)
          if (target && target !== id && props.onConnect) props.onConnect(id, target)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
      }

      const onPaneContextMenu = (ev) => {
        if (props.readOnly || props.structureLocked) return
        ev.preventDefault()
        const wrap = wrapRef.current
        if (!wrap) return
        const rect = wrap.getBoundingClientRect()
        // 菜单为外层相对容器的固定浮层：使用视口坐标
        setMenu({ x: ev.clientX - rect.left, y: ev.clientY - rect.top })
      }

      // ── 边 ──
      const edgeEls = []
      const labelEls = []
      const labelRects = []
      ;(dsl.edges || []).forEach((e, idx) => {
        const a = pos[e.from]
        const b = pos[e.to]
        if (!a || !b) return
        // 路径几何由 layoutGraph 在屏幕坐标里算好（自上而下，V-12）；此处只做渲染与标签避让
        const route = lay.routes.get(idx) || { kind: 'direct', d: '', startX: a.x + a.w / 2, startY: a.y + a.h, labelX: a.x + a.w / 2, labelY: a.y + a.h + 40 }
        const isFail = e.on === 'failure'
        const isTech = e.on === 'technical'
        const color = isFail ? EDGE_FAIL : isTech ? EDGE_TECH : EDGE_OK
        const selected = props.selectedEdge === idx
        const d = route.d
        const labelX = route.labelX
        let labelY = route.labelY
        // 标签按实际短文案估算宽度（11px 字号：CJK 约 11px/字，拉丁约 7px/字，取 9 折中）；
        // 若与节点或已有标签相碰，沿垂直方向持续让位。节点/既有标签都是有限集合，不设固定次数上限。
        const lbl = edgeLabelText(e, { success: t('edgeSuccess'), failure: t('edgeFailure'), technical: t('edgeTechnical') })
        const lblW = Math.max(12, lbl.length * 9)
        let labelBox = { x: labelX - lblW / 2, y: labelY - EDGE_LABEL_H, w: lblW, h: EDGE_LABEL_H }
        const boxesOverlap = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
        while (true) {
          const hitsNode = Object.keys(pos).some(id => boxesOverlap(labelBox, pos[id]))
          const hitsLabel = labelRects.some(rect => boxesOverlap(labelBox, rect))
          if (!hitsNode && !hitsLabel) break
          labelY += EDGE_LABEL_H
          labelBox = { x: labelX - lblW / 2, y: labelY - EDGE_LABEL_H, w: lblW, h: EDGE_LABEL_H }
        }
        labelRects.push(labelBox)
        edgeEls.push(h('path', {
          key: 'e' + idx, d, fill: 'none',
          className: 'vwf-edge-flow',
          stroke: selected ? EDGE_SELECTED : color,
          strokeWidth: selected ? 4.2 : (isFail || isTech ? 2 : 2.2),
          opacity: isFail || isTech || route.routed ? 0.92 : 1,
          markerEnd: 'url(#vwf-arrow' + (selected ? '-sel' : isFail ? '-fail' : isTech ? '-tech' : '') + ')',
        }))
        edgeEls.push(h('path', {
          key: 'eh' + idx, d, className: 'vwf-edge-hit',
          style: { cursor: props.readOnly ? 'default' : 'pointer' },
          onClick: (ev) => { ev.stopPropagation(); if (!props.readOnly && props.onEdgeClick) props.onEdgeClick(idx) },
        }))
        // 起始点统一小圆点（颜色跟随边的状态），终点由箭头标识。
        edgeEls.push(h('circle', {
          key: 'sd' + idx, className: 'vwf-edge-start', cx: route.startX, cy: route.startY, r: 4,
          fill: selected ? EDGE_SELECTED : color,
          stroke: selected ? EDGE_SELECTED : color, strokeWidth: 1,
        }))
        // 边标签按类型与 outcome 名如实显示；when 条件悬停可见（title），表单/JSON 面板可编辑
        labelEls.push(h('text', {
          key: 'lb' + idx, x: labelX, y: labelY - 6, textAnchor: 'middle', fontSize: 11, fontWeight: selected ? 700 : 600,
          fill: selected ? EDGE_SELECTED : color,
          style: { paintOrder: 'stroke', stroke: selected ? 'var(--vwf-surface)' : 'var(--vwf-canvas)', strokeWidth: 3 },
        }, e.when ? h('title', null, e.when) : null, lbl))
      })

      // ── 节点 ──
      const nodeEls = []
      const candidates = props.entryCandidates || []
      Object.keys(pos).forEach((id) => {
        const p = pos[id]
        const isTerm = id === END_NODE
        const node = isTerm ? null : (dsl.nodes || []).find(n => n.id === id)
        const selected = props.selectedNode === id
        const invalid = !!(props.invalidNodes && props.invalidNodes.has(id))
        const status = props.statusMap ? props.statusMap[id] : null
        const isConnectTarget = !!(connect && hoverTarget === id)
        if (isTerm) {
          nodeEls.push(h('g', {
            key: 'n' + id, 'data-node-id': id, transform: 'translate(' + p.x + ',' + p.y + ')',
            style: { cursor: props.readOnly ? 'default' : 'pointer' },
            onClick: (ev) => { ev.stopPropagation(); if (!props.readOnly && props.onTerminalClick) props.onTerminalClick(id) },
          },
            h('rect', { width: p.w, height: p.h, rx: p.h / 2, fill: 'var(--dsw-alias-bg-layer-1, #1e1e1e)', stroke: isConnectTarget ? ACCENT : 'var(--dsw-alias-border-l3, #555)', strokeWidth: isConnectTarget ? 3 : 1, strokeDasharray: '5 4', opacity: 0.9, ...(isConnectTarget ? { 'data-vwf-connect-target': 'true' } : {}) }),
            h('text', { x: p.w / 2, y: p.h / 2 + 4, textAnchor: 'middle', fontSize: 12, fill: 'var(--dsw-alias-label-secondary, #9a9a9a)' }, t('endNode')),
            h('circle', { className: 'vwf-handle', cx: p.w / 2, cy: 0, r: 4 })
          ))
          return
        }
        const stroke = isConnectTarget ? ACCENT : selected ? ACCENT : invalid ? 'var(--vwf-err)' : status ? STATUS_COLOR[status] : 'var(--vwf-border-strong)'
        const seq = seqLabels[id]
        const seqW = seq ? Math.max(22, 8 + String(seq).length * 7) : 0
        nodeEls.push(h('g', {
          key: 'n' + id, 'data-node-id': id, transform: 'translate(' + p.x + ',' + p.y + ')',
          style: { cursor: props.readOnly ? 'default' : 'pointer' },
          onClick: (ev) => { ev.stopPropagation(); if (!props.readOnly && props.onNodeClick) props.onNodeClick(id) },
        },
          h('rect', {
            className: 'vwf-node-card', width: p.w, height: p.h, rx: 14,
            stroke: stroke, strokeWidth: isConnectTarget ? 3 : (selected || invalid ? 2 : 1),
            ...(isConnectTarget ? { 'data-vwf-connect-target': 'true' } : {}),
            style: isConnectTarget ? { filter: 'drop-shadow(0 0 10px ' + ACCENT + ')' } : selected ? { filter: 'drop-shadow(0 0 8px ' + ACCENT + ')' } : invalid ? { filter: 'drop-shadow(0 0 6px var(--vwf-err))' } : undefined,
          }),
          candidates.indexOf(id) >= 0 ? h('g', { key: 'eb' },
            h('rect', { className: 'vwf-entry-badge', x: -6, y: -9, width: 34, height: 16, rx: 8 }),
            h('text', { className: 'vwf-entry-badge-text', x: 11, y: 3, textAnchor: 'middle' }, t('entryBadge'))
          ) : null,
          seq ? h('g', { key: 'seq', 'data-node-seq': seq },
            h('rect', { className: 'vwf-node-seq-badge', x: 8, y: 8, width: seqW, height: 18, rx: 6 }),
            h('text', { className: 'vwf-node-seq', x: 8 + seqW / 2, y: 21, textAnchor: 'middle' }, seq)
          ) : null,
          h('text', { className: 'vwf-node-label', x: p.w / 2, y: p.h / 2 - 4, textAnchor: 'middle' }, (node && (node.label || node.id)) || id),
          h('text', { className: 'vwf-node-kind', x: p.w / 2, y: p.h / 2 + 15, textAnchor: 'middle' }, (node && node.kind) || 'worker'),
          status ? h('circle', { cx: p.w - 14, cy: 14, r: 6, fill: STATUS_COLOR[status] }) : null,
          // 纵向布局（V-12）：入口把手在上边框中点、出线把手在下边框中点
          !props.readOnly && !props.structureLocked ? h('circle', { className: 'vwf-handle', cx: p.w / 2, cy: 0, r: 4 }) : null,
          !props.readOnly && !props.structureLocked ? h('circle', {
            className: 'vwf-handle vwf-handle-src', cx: p.w / 2, cy: p.h, r: 5,
            onPointerDown: (ev) => onSourceDown(id, ev),
          }) : null
        ))
      })

      // 连线中的临时线
      let connectEl = null
      if (connect && pos[connect.from]) {
        const a = pos[connect.from]
        // 出线预览从源节点下边框中点起，同样自上而下出线（V-12）
        const sx = a.x + a.w / 2
        const sy = a.y + a.h
        const my = sy + (connect.y - sy) / 2
        connectEl = h('path', {
          d: 'M ' + sx + ' ' + sy + ' C ' + sx + ' ' + my + ', ' + connect.x + ' ' + my + ', ' + connect.x + ' ' + connect.y,
          fill: 'none', stroke: ACCENT, strokeWidth: 2, strokeDasharray: '6 5', markerEnd: 'url(#vwf-arrow-sel)',
        })
      }

      return h('div', { className: 'vwf-canvas-host', style: { position: 'relative' } },
        h('div', {
          className: 'vwf-canvas-wrap',
          ref: wrapRef,
          style: props.height ? { height: props.height } : undefined,
          onPointerDown: onPanePointerDown,
        },
          h('div', {
            className: 'vwf-canvas-stage',
            'data-vwf-pane': 'true',
            style: { transform: 'translate(' + panOffset.x + 'px,' + panOffset.y + 'px)' },
          },
            h('svg', {
              className: 'vwf-svg', width: W * scale, height: H * scale, viewBox: '0 0 ' + W + ' ' + H,
              ref: svgRef,
              'data-vwf-pane': 'true',
              onClick: (ev) => { if (panRef.current && panRef.current.moved) return; if (props.onPaneClick) props.onPaneClick() },
              onContextMenu: onPaneContextMenu,
            },
              h('defs', null,
                h('pattern', { id: 'vwf-dots', width: 28, height: 28, patternUnits: 'userSpaceOnUse' },
                  h('circle', { cx: 1, cy: 1, r: 1, fill: 'var(--vwf-border)' })),
                h('marker', { id: 'vwf-arrow', markerWidth: 8, markerHeight: 8, refX: 7, refY: 4, orient: 'auto' }, h('path', { d: 'M0,0 L8,4 L0,8 z', fill: EDGE_OK })),
                h('marker', { id: 'vwf-arrow-fail', markerWidth: 8, markerHeight: 8, refX: 7, refY: 4, orient: 'auto' }, h('path', { d: 'M0,0 L8,4 L0,8 z', fill: EDGE_FAIL })),
                h('marker', { id: 'vwf-arrow-tech', markerWidth: 8, markerHeight: 8, refX: 7, refY: 4, orient: 'auto' }, h('path', { d: 'M0,0 L8,4 L0,8 z', fill: EDGE_TECH })),
                h('marker', { id: 'vwf-arrow-sel', markerWidth: 8, markerHeight: 8, refX: 7, refY: 4, orient: 'auto' }, h('path', { d: 'M0,0 L8,4 L0,8 z', fill: EDGE_SELECTED }))
              ),
              h('rect', { width: W, height: H, fill: 'url(#vwf-dots)', 'data-vwf-pane': 'true' }),
              edgeEls,
              nodeEls,
              connectEl,
              labelEls
            )
          )
        ),
        menu ? h('div', { className: 'vwf-menu', style: { left: menu.x, top: menu.y } },
          h('button', { className: 'vwf-menu-item', onClick: () => { setMenu(null); if (props.onAddTerminal) props.onAddTerminal(END_NODE) } }, t('addEndTarget'))
        ) : null,
        h('div', { className: 'vwf-zoom' },
          h('button', { title: t('zoomIn'), onClick: () => setScale(s => Math.min(1.6, +(s + 0.15).toFixed(2))) }, '+'),
          h('button', { title: t('zoomOut'), onClick: () => setScale(s => Math.max(0.3, +(s - 0.15).toFixed(2))) }, '−'),
          h('button', { title: t('fitView'), onClick: fitView }, '⤢')
        )
      )
    }

    const ARTIFACT_KINDS = ['json', 'markdown', 'text', 'html', 'canvas', 'flowchart', 'diagram']

    function artifactPathFromRecordId(recordId) {
      const parts = String(recordId || '').split(':')
      return parts.length >= 4 ? parts.slice(3).join(':') : recordId
    }

    function latestArtifactRecords(records) {
      const byId = new Map()
      for (const r of records || []) {
        if (!r || !r.record_id) continue
        const cur = byId.get(r.record_id)
        if (!cur || (r.record_revision || 0) > (cur.record_revision || 0)) byId.set(r.record_id, r)
      }
      return Array.from(byId.values()).sort((a, b) => String(a.record_id).localeCompare(String(b.record_id)))
    }

    function renderArtifactBody(record) {
      const mt = record && record.body && record.body.media_type
      const val = record && record.body && record.body.value
      if (mt === 'text/html') {
        // iframe 底色是产物自身的内容画布（HTML 未声明背景时浏览器默认白底），
        // 不参与主题 token：换成深色表面会让未声明背景的浅色产物变成不可读的深底浅字。
        return h('iframe', { sandbox: '', title: record.record_id, srcDoc: String(val || ''), style: { width: '100%', height: 220, border: '1px solid var(--vwf-border)', borderRadius: 6, background: '#fff' } })
      }
      if (mt === 'text/markdown' || mt === 'text/plain') {
        return h('pre', { className: 'vwf-code', style: { maxHeight: 220, overflow: 'auto' } }, String(val ?? ''))
      }
      return h('pre', { className: 'vwf-code', style: { maxHeight: 220, overflow: 'auto' } }, JSON.stringify(val, null, 2))
    }

    function ArtifactFilesEditor(props) {
      const files = (props.node.output && props.node.output.files) || {}
      // 基础段用业务词「交付内容」；技术口径（Formal Artifact）在高级层不重复出现
      const label = props.label || t('artifactFiles')
      const entries = Object.entries(files)
      const errorsFor = props.errorsFor || (() => [])
      const setFiles = (next) => {
        const output = { ...(props.node.output || {}) }
        if (next && Object.keys(next).length) output.files = next
        else delete output.files
        if (!output.schema && !output.successCondition && !output.files) {
          props.onUpdate(props.node.id, { output: null })
          return
        }
        props.onUpdate(props.node.id, { output })
      }
      const updateEntry = (oldPath, path, kind) => {
        const next = { ...files }
        if (oldPath !== path && oldPath in next) delete next[oldPath]
        if (path && path.trim()) next[path.trim()] = kind || 'markdown'
        setFiles(next)
      }
      const addEntry = () => {
        let i = entries.length + 1
        let path = 'artifact-' + i + '.md'
        while (files[path]) { i += 1; path = 'artifact-' + i + '.md' }
        setFiles({ ...files, [path]: 'markdown' })
      }
      const removeEntry = (path) => {
        const next = { ...files }
        delete next[path]
        setFiles(next)
      }
      return h('div', { className: 'vwf-subsection' },
        h(Field, { label, help: t('artifactFilesHelp'), errors: errorsFor('output.files') },
          entries.length ? entries.map(([path, kind]) => h('div', { key: path, className: 'vwf-row', style: { gap: 6, marginBottom: 6, flexWrap: 'wrap' } },
            h('input', {
              className: 'vwf-input vwf-mono', style: { flex: 2, minWidth: 140 }, value: path, placeholder: 'contract.md',
              disabled: !!props.readOnly,
              onChange: (ev) => updateEntry(path, ev.target.value, kind),
            }),
            h(VwfSelect, {
              value: kind || 'markdown',
              disabled: !!props.readOnly,
              options: ARTIFACT_KINDS.map((k) => ({ value: k, label: k })),
              onChange: (v) => updateEntry(path, path, v),
            }),
            props.readOnly ? null : h('button', { className: 'vwf-btn sm danger', type: 'button', onClick: () => removeEntry(path) }, t('removeArtifact'))
          )) : h('div', { className: 'vwf-muted-sm' }, '—'),
          props.readOnly ? null : h('button', { className: 'vwf-btn sm', type: 'button', style: { marginTop: 6 }, onClick: addEntry }, t('addArtifact'))
        )
      )
    }

    // ── 配置栏渐进披露区（FEAT-84 §7.3）────────────────────────────────────
    // 段内出现校验错误时自动展开一次，避免必填错误被折叠藏起来（错误不得静默隐藏）。
    // ── 配置栏三段 tab（V-11，对齐原型 inspector 的 tab 形态）────────────────
    // 渐进披露原则不变：默认停在第一档（业务词），高级设置 / JSON 不切过去就不渲染内容。
    // 带错误的档位标出 ⚠，并在错误签名变化时自动切到该档——避免「保存被拦却看不到是哪个字段」。
    function InspectorTabs(props) {
      const tabs = props.tabs
      const [active, setActive] = React.useState(tabs[0].key)
      const errKey = tabs.filter(tb => tb.hasError).map(tb => tb.key).join(',')
      const lastErrKey = React.useRef(errKey)
      React.useEffect(() => {
        if (errKey && lastErrKey.current !== errKey) setActive(errKey.split(',')[0])
        lastErrKey.current = errKey
      }, [errKey])
      const current = tabs.find(tb => tb.key === active) || tabs[0]
      return h('div', { className: 'vwf-wb-tabs' },
        h('div', { className: 'vwf-wb-tabbar', role: 'tablist' },
          tabs.map(tb => h('button', {
            key: tb.key, type: 'button', role: 'tab',
            className: 'vwf-wb-tab' + (tb.key === current.key ? ' on' : ''),
            'data-vwf-tab': tb.key,
            'aria-selected': tb.key === current.key ? 'true' : 'false',
            title: tb.note || '',
            onClick: () => setActive(tb.key),
          }, tb.label, tb.hasError ? h('span', { className: 'vwf-wb-tab-err' }, '⚠') : null))
        ),
        h('div', { className: 'vwf-wb-tabpanel', role: 'tabpanel' }, current.panel)
      )
    }

    // ── 左侧步骤定位区（FEAT-84 §7.2）──────────────────────────────────────
    // 按画布同一套分层序号列出步骤（与节点角标一一对应）；点击定位画布并选中该节点。
    // 扇出节点额外标注「并行组」，其下游节点标注「汇总」，让扇出与汇总的结构可读。
    function StepNavigator(props) {
      const dsl = props.dsl || {}
      const visibleTerminals = props.visibleTerminals || []
      const lay = React.useMemo(() => {
        try { return layoutGraph(dsl, visibleTerminals) } catch (e) { return null }
      }, [JSON.stringify({ entry: dsl.entry || '', n: (dsl.nodes || []).map(n => n.id), e: (dsl.edges || []).map(e => [e.from, e.to, e.on, e.outcome, e.countRound]), v: visibleTerminals })])
      if (!lay) return h('div', { className: 'vwf-wb-steps-body' }, h('div', { className: 'vwf-muted-sm' }, '—'))
      const seqLabels = lay.seqLabels || {}
      const rankOf = (id) => (lay.rank && lay.rank[id] != null ? lay.rank[id] : null)
      // 汇总 = 直接接收扇出节点出边的节点（扇出完成后汇聚到它）
      const fanoutIds = (dsl.nodes || []).filter(n => n.kind === 'fanout').map(n => n.id)
      const summaryIds = {}
      ;(dsl.edges || []).forEach(e => { if (e && fanoutIds.indexOf(e.from) >= 0) summaryIds[e.to] = true })
      const seqOrder = (id) => {
        const r = rankOf(id)
        const s = seqLabels[id]
        const sub = s && s.indexOf('.') >= 0 ? Number(s.split('.')[1]) : 0
        return (r == null ? 9999 : r) * 1000 + sub
      }
      const ids = (dsl.nodes || []).map(n => n.id).filter(id => seqLabels[id] != null || rankOf(id) != null)
        .sort((a, b) => seqOrder(a) - seqOrder(b))
      return h('div', { className: 'vwf-wb-steps-body' },
        ids.map(id => {
          const node = (dsl.nodes || []).find(n => n.id === id) || {}
          const on = props.selectedNodeId === id
          return h('button', {
            key: id, type: 'button',
            className: 'vwf-wb-step' + (on ? ' on' : ''),
            'data-node-id': id,
            'aria-current': on ? 'true' : 'false',
            title: (node.label || id) + ' · ' + id,
            onClick: () => props.onPick(id),
          },
            h('span', { className: 'vwf-wb-step-seq' }, seqLabels[id] != null ? String(seqLabels[id]) : '·'),
            h('span', { className: 'vwf-wb-step-label' }, node.label || id),
            summaryIds[id] ? h('span', { className: 'vwf-badge accent' }, t('wbSummaryBadge')) : null,
            node.kind === 'fanout' ? h('span', { className: 'vwf-badge' }, t('wbParallelBadge')) : null,
            node.profile ? h('span', { className: 'vwf-wb-step-role' }, node.profile) : null
          )
        }),
        !ids.length ? h('div', { className: 'vwf-muted-sm' }, t('wbNoSteps')) : null
      )
    }

    // ── 连接清单（FEAT-84 §7.7/V-4/V-5）────────────────────────────────────
    // 直接遍历模板定义的 edges 渲染 —— 不依赖节点侧的结果声明，保证「不漏边」。
    // 三类分组：普通业务路由 / 业务回环 / 调用重试；返工轮次作为独立概念在页脚说明。
    function ConnectionList(props) {
      const dsl = props.dsl || {}
      const edges = dsl.edges || []
      const rankOf = props.rankOf || (() => null)
      const orderOf = (id) => {
        const r = rankOf(id)
        if (r == null) return null
        if (id === END_NODE) return Number.MAX_SAFE_INTEGER
        return r
      }
      const nodeLabel = (id) => {
        if (id === END_NODE) return t('endNode')
        const n = (dsl.nodes || []).find(x => x.id === id)
        return (n && (n.label || n.id)) || id
      }
      const rows = edges.map((e, i) => ({ e, i, cls: connectionClassOf(e, orderOf) }))
      const groups = [
        { cls: 'normal', label: t('wbConnNormal'), help: t('wbConnNormalHelp') },
        { cls: 'loop', label: t('wbConnLoop'), help: t('wbConnLoopHelp') },
        { cls: 'retry', label: t('wbConnRetry'), help: t('wbConnRetryHelp') },
      ]
      // 缺项提示（规格 §11）：源节点声明了业务结果取值，但模板定义里没有对应去向
      const missing = []
      ;(dsl.nodes || []).forEach(n => {
        const name = routingNameOf(n.output && n.output.outcomePath)
        if (!name) return
        routingValuesOf(n).forEach(v => {
          const val = String(v == null ? '' : v).trim()
          if (!val) return
          const hit = edges.some(e => e && e.from === n.id && String(e.outcome == null ? '' : e.outcome) === val)
          if (!hit) missing.push({ node: n.id, label: nodeLabel(n.id), value: val })
        })
      })
      return h('div', { className: 'vwf-wb-conn-body' },
        !edges.length ? h('div', { className: 'vwf-muted-sm' }, t('wbConnEmpty')) : null,
        groups.map(g => {
          const list = rows.filter(r => r.cls === g.cls)
          if (!list.length) return null
          return h('div', { key: g.cls },
            h('div', { className: 'vwf-wb-conn-group' }, g.label + '（' + list.length + '）'),
            list.map(({ e, i, cls }) => {
              const kindKey = cls === 'retry' ? 'wbConnRetry' : cls === 'loop' ? 'wbConnLoop' : 'wbConnNormal'
              const sub = edgeKind(e) === 'outcome'
                ? t('wbConnBusinessResult') + (e.countRound ? ' · ' + t('edgeCountRound') : '')
                : edgeKind(e) === 'technical' ? t('edgeType_technical')
                  : edgeKind(e) === 'failure' ? t('edgeType_failure') : t('edgeType_success')
              return h('button', {
                key: i, type: 'button',
                className: 'vwf-wb-conn-row' + (props.selectedEdgeIndex === i ? ' on' : ''),
                onClick: () => props.onPickEdge(i),
              },
                h('span', { className: 'vwf-row', style: { gap: 6, flexWrap: 'nowrap' } },
                  h('span', { className: 'vwf-wb-conn-kind ' + cls }, g.label),
                  h('span', { className: 'vwf-wb-conn-route' }, nodeLabel(e.from) + ' → ' + nodeLabel(e.to))
                ),
                h('span', { className: 'vwf-wb-conn-meta' }, sub),
                h('span', { className: 'vwf-wb-conn-meta' }, g.help)
              )
            })
          )
        }),
        missing.length
          ? h('div', { className: 'vwf-err-line', style: { marginTop: 8 } },
              t('wbConnMissingEdges') + missing.map(m => m.label + ' · ' + m.value).join('、'))
          : null,
        h('div', { className: 'vwf-wb-legend' },
          h('div', { className: 'vwf-wb-legend-line' },
            t('wbConnCount', { n: edges.length }) + ' · ' + t('wbConnCountBreakdown', {
              normal: rows.filter(r => r.cls === 'normal').length,
              loop: rows.filter(r => r.cls === 'loop').length,
              retry: rows.filter(r => r.cls === 'retry').length,
            })),
          h('div', { className: 'vwf-wb-legend-line' }, h('b', null, t('wbConnLegendLoop')), t('wbConnLegendLoopHelp')),
          h('div', { className: 'vwf-wb-legend-line' }, h('b', null, t('wbConnLegendRetry')), t('wbConnLegendRetryHelp')),
          h('div', { className: 'vwf-wb-legend-line' }, h('b', null, t('wbConnLegendRounds')), t('wbConnLegendRoundsHelp'))
        )
      )
    }

    // ── 节点配置表单（对应 WorkerNodeInspector）──────────────────────────────
    function NodeInspector(props) {
      const node = props.node
      const dsl = props.dsl
      const errorsFor = (field) => (props.fieldErrors || {})['node:' + node.id + ':' + field] || []
      const [idDraft, setIdDraft] = React.useState(node.id)
      const [idComposing, setIdComposing] = React.useState(false)
      const [schemaDraft, setSchemaDraft] = React.useState(node.output && node.output.schema ? JSON.stringify(node.output.schema, null, 2) : '')
      const [schemaError, setSchemaError] = React.useState(null)
      const [schemaNotice, setSchemaNotice] = React.useState(null)
      const [schemaDirty, setSchemaDirty] = React.useState(false)
      // V2：业务结果字段名与取值列表的本地草稿（提交时用 applyRoutingWrite 合并写回 schema）
      const [routingNameDraft, setRoutingNameDraft] = React.useState(() => routingNameOf(node.output && node.output.outcomePath))
      const [routingValuesDraft, setRoutingValuesDraft] = React.useState(() => routingValuesOf(node))
      const [routingValuesDirty, setRoutingValuesDirty] = React.useState(false)
      const [routingNotice, setRoutingNotice] = React.useState(null)
      const debounceRef = React.useRef(null)

      React.useEffect(() => { setIdDraft(node.id) }, [node.id])
      React.useEffect(() => {
        setSchemaDraft(node.output && node.output.schema ? JSON.stringify(node.output.schema, null, 2) : '')
        setSchemaError(null)
        setSchemaNotice(null)
        setSchemaDirty(false)
        setRoutingNameDraft(routingNameOf(node.output && node.output.outcomePath))
        setRoutingValuesDraft(routingValuesOf(node))
        setRoutingValuesDirty(false)
        setRoutingNotice(null)
      }, [node.id])
      React.useEffect(() => () => { if (debounceRef.current) debounceRef.current() }, [])

      const validationEnabled = !!node.output
      const manualEnabled = !!node.manualCheck
      // 业务结果路由（outcomePath）节点：output.outcomePath 存在即视为该模式，
      // 空串（编辑中）不跳回其他模式
      const routingEnabled = !!node.output && node.output.outcomePath != null
      const resultMode = routingEnabled ? 'routing' : validationEnabled ? 'ai' : manualEnabled ? 'manual' : 'none'
      const isFanout = node.kind === 'fanout'
      const failOnValue = node.failOn === undefined ? 'all' : node.failOn
      const failOnMode = Number.isInteger(failOnValue) ? 'number' : failOnValue

      // V2 业务结果路由：取值列表的权威是 schema，边存在性每次渲染实时算（R7）
      const routingName = routingNameOf(node.output && node.output.outcomePath)
      const routingSchema = (node.output && node.output.schema) || null
      const routingProp = (routingSchema && routingSchema.properties && routingSchema.properties[routingName]) || null
      const routingEnumerable = enumerableValues(routingProp)
      const routingIsBoolean = !!(routingProp && routingProp.type === 'boolean')
      const routingCandidateList = routingCandidates(routingSchema)
      const routingStatus = routingEdgeStatus(props.dsl || { nodes: [], edges: [] }, node.id)
      const commitRouting = (name, values) => {
        const out = applyRoutingWrite(node, name, values)
        props.onUpdate(node.id, { output: out })
        // 与 JSON 编辑器保持同源：写回后同步草稿，避免旧草稿回写覆盖（D2）
        if (out.schema) setSchemaDraft(JSON.stringify(out.schema, null, 2))
      }
      const commitRoutingValues = (values) => {
        setRoutingValuesDraft(values)
        commitRouting(routingName, values)
      }

      const commitSchema = (value) => {
        if (!value.trim()) {
          props.onUpdate(node.id, { output: { ...(node.output || {}), schema: null } })
          setSchemaError(null)
          return true
        }
        try {
          const parsed = JSON.parse(value)
          props.onUpdate(node.id, { output: { ...(node.output || {}), schema: parsed } })
          setSchemaError(null)
          return true
        } catch (e) {
          setSchemaError(t('outputSchemaInvalid'))
          return false
        }
      }
      const onSchemaChange = (value) => {
        setSchemaDraft(value)
        setSchemaError(null)
        setSchemaNotice(null)
        setSchemaDirty(true)
        if (debounceRef.current) debounceRef.current()
        debounceRef.current = ctx.timeout(() => {
          commitSchema(value)
          setSchemaDirty(false)
        }, SCHEMA_DEBOUNCE_MS)
      }
      const beautifySchema = () => {
        if (!schemaDraft.trim()) {
          // 取消残留的 2s 防抖，避免「输入后清空再点 ✨」时旧防抖在稍后把刚填入的模板覆盖为 null
          if (debounceRef.current) debounceRef.current()
          const template = buildSchemaTemplate({
            kind: isFanout ? 'fanout' : 'worker',
            successCondition: (node.output && node.output.successCondition) || '',
            verifyBranch: !!node.verifyBranch,
          })
          const formatted = JSON.stringify(template, null, 2)
          setSchemaDraft(formatted)
          setSchemaDirty(false)
          setSchemaError(null)
          setSchemaNotice(t('outputSchemaAutofilled'))
          props.onUpdate(node.id, { output: { ...(node.output || {}), schema: template } })
          return
        }
        try {
          const formatted = JSON.stringify(JSON.parse(schemaDraft), null, 2)
          setSchemaDraft(formatted)
          setSchemaDirty(false)
          setSchemaError(null)
          setSchemaNotice(null)
          props.onUpdate(node.id, { output: { ...(node.output || {}), schema: JSON.parse(schemaDraft) } })
        } catch (e) {
          setSchemaError(t('outputSchemaInvalid'))
          setSchemaNotice(null)
        }
      }

      // schema 编辑块（textarea + ✨ 美化 + 错误/提示行）：fanout / ai / routing 三处共用
      const schemaField = (opts) => h(Field, { label: opts.label, required: opts.required, help: opts.help, errors: errorsFor('output.schema') },
        h('div', { style: { position: 'relative' } },
          h('textarea', {
            className: 'vwf-textarea vwf-mono' + (errorsFor('output.schema').length ? ' err' : ''),
            rows: 6, value: schemaDraft, placeholder: t('outputSchemaPlaceholder'),
            disabled: !!props.readOnlyStructure, title: props.readOnlyStructure ? t('wbBuiltinStructureReadonly') : '',
            onChange: (ev) => { if (!props.readOnlyStructure) onSchemaChange(ev.target.value) },
            onBlur: () => { if (!props.readOnlyStructure && schemaDirty) { commitSchema(schemaDraft); setSchemaDirty(false) } },
          }),
          props.readOnlyStructure ? null : h('button', {
            className: 'vwf-btn sm', title: t('outputSchemaBeautify'),
            style: { position: 'absolute', right: 6, top: 6 },
            onMouseDown: (ev) => ev.preventDefault(),
            onClick: beautifySchema,
          }, '✨')
        ),
        schemaError
          ? h('div', { className: 'vwf-err-line' }, schemaError)
          : (schemaNotice ? h('div', { className: 'vwf-ok-line' }, schemaNotice) : null)
      )

      const commitNodeId = (value) => {
        if (value === node.id) { setIdDraft(node.id); return }
        props.onUpdate(node.id, { id: value })
      }

      const changeKind = (kind) => {
        if (kind === 'fanout') {
          const output = { ...(node.output || {}), schema: (node.output && node.output.schema) || null }
          delete output.successCondition
          // fanout 节点禁止 outcomePath（不参与 Business Outcome Routing）
          delete output.outcomePath
          setSchemaDraft(output.schema ? JSON.stringify(output.schema, null, 2) : '')
          props.onUpdate(node.id, {
            kind: 'fanout',
            items: node.items || '$.args.items',
            failOn: node.failOn === undefined ? 'all' : node.failOn,
            manualCheck: null,
            output,
          })
        } else {
          props.onUpdate(node.id, {
            kind: undefined,
            items: undefined,
            failOn: undefined,
            output: node.output && node.output.schema ? node.output : null,
          })
        }
      }

      // provider/model 选项（vwf.models 数据源；当前值不在列表时保留显示）
      const providers = props.providers || []
      const curProv = node.model && node.model.provider ? node.model.provider : ''
      const curModel = node.model && node.model.model ? node.model.model : ''
      const provOpts = providers.map(p => p.id)
      if (curProv && provOpts.indexOf(curProv) < 0) provOpts.push(curProv)
      const modelOpts = ((providers.find(p => p.id === curProv) || {}).models || []).slice()
      if (curModel && modelOpts.indexOf(curModel) < 0) modelOpts.push(curModel)

      const roles = props.roles || []
      // 角色选择区分内置/自定义（issue-58）：分组下拉 + 空自定义提示 + 管理入口。
      // 来源与摘要复用角色库的同一套判定与生成规则（roleOriginOf / roleSummaryOf），
      // 避免节点角色选择与角色库对同一角色给出不同含义（FEAT-86 收口）。
      const builtinRoles = roles.filter(r => roleOriginOf(r).builtin)
      const customRoles = roles.filter(r => !roleOriginOf(r).builtin)
      const roleLabel = (role) => (role ? (roleSummaryOf(role, 24) ? role.id + ' — ' + roleSummaryOf(role, 24) : role.id) : '')
      const roleTitle = (role) => roleSummaryOf(role, 120)
      const roleOptions = [{ value: '', label: t('selectProfile') }]
        .concat(builtinRoles.map(role => ({ value: role.id, label: roleLabel(role), title: roleTitle(role), group: t('builtinRoles') })))
        .concat(customRoles.map(role => ({ value: role.id, label: roleLabel(role), title: roleTitle(role), group: t('customRoles') })))
      // 当前值不在清单（旧工作流/宿主脏数据）时兜底保留展示
      if (node.profile && !roles.some(r => r.id === node.profile)) roleOptions.push({ value: node.profile, label: node.profile, title: '' })

      // ── 渐进披露分组（FEAT-84 §7.3/V-11）：业务词在前，技术词与 JSON 收进第三档 ──
      // 字段 → 归属档；未选中的档不渲染内容，出错时档位标 ⚠ 并自动切过去。
      const errCount = (fields) => fields.reduce((n, f) => n + errorsFor(f).length, 0)
      // 内置模板结构只读（§9/§11）：控件不可用并给出只读说明，不静默忽略点击
      const ro = !!props.readOnlyStructure
      const roDis = ro ? { disabled: true, title: t('wbBuiltinStructureReadonly') } : {}
      const basicFields = ['label', 'goal', 'profile', 'output.files']
      const outcomeFields = isFanout ? ['failOn'] : ['output.outcomePath', 'output.successCondition']
      const advancedFields = ['id', 'kind', 'items', 'failOn', 'model.provider', 'model.model', 'output.schema', 'output.outcomePath']
      const nodeLabelOf = (id) => {
        if (id === END_NODE) return t('endNode')
        const n = (dsl.nodes || []).find(x => x.id === id)
        return (n && (n.label || n.id)) || id
      }
      // 「从这个步骤往哪走」：出边按连接清单同一套分类，业务结果名与去向都直接可读
      const outEdges = (dsl.edges || []).map((e, i) => ({ e, i })).filter(x => x.e && x.e.from === node.id)
      const outgoingKindLabel = (cls) => cls === 'retry' ? t('wbConnRetry') : cls === 'loop' ? t('wbConnLoop') : t('wbConnNormal')
      const outgoingBlock = h('div', { className: 'vwf-field', style: { marginTop: 10 } },
        h('div', { className: 'vwf-field-label' }, t('wbOutgoing'),
          h('span', { className: 'vwf-help', title: t('wbOutgoingHelp') }, '?')),
        outEdges.length
          ? outEdges.map(({ e, i }) => {
            const cls = connectionClassOf(e, props.orderOf)
            const cond = edgeKind(e) === 'outcome'
              ? t('wbConnBusinessResult') + '：' + String(e.outcome == null ? '' : e.outcome)
              : edgeKind(e) === 'technical' ? t('edgeType_technical')
                : edgeKind(e) === 'failure' ? t('edgeType_failure') : t('edgeType_success')
            return h('button', {
              key: i, type: 'button', className: 'vwf-wb-outcome-row',
              onClick: () => { if (props.onPickEdge) props.onPickEdge(i) },
            },
              h('span', { className: 'vwf-row', style: { gap: 6, flexWrap: 'nowrap' } },
                h('span', { className: 'vwf-wb-conn-kind ' + cls }, outgoingKindLabel(cls)),
                h('span', { className: 'vwf-wb-outcome-name' }, nodeLabelOf(e.to))
              ),
              h('span', { className: 'vwf-wb-outcome-to' }, cond)
            )
          })
          : h('div', { className: 'vwf-muted-sm' }, t('wbOutgoingNone'))
      )

      const basicSection = h(React.Fragment, null,
        h(Field, { label: t('wbFieldStepName'), errors: errorsFor('label') },
          h('input', { className: 'vwf-input', value: node.label || '', ...roDis, onChange: (ev) => { if (!ro) props.onUpdate(node.id, { label: ev.target.value }) } })
        ),
        h(Field, { label: t('wbFieldTask'), required: true, help: isFanout ? t('fanoutItemsHelp') : undefined, errors: errorsFor('goal') },
          h('textarea', { className: 'vwf-textarea' + (errorsFor('goal').length ? ' err' : ''), rows: 3, value: node.goal || '', placeholder: isFanout ? t('fanoutGoalPlaceholder') : t('defaultNodeGoal'), ...roDis, onChange: (ev) => { if (!ro) props.onUpdate(node.id, { goal: ev.target.value }) } })
        ),
        h(Field, { label: t('wbFieldRole'), required: true, help: t('profileHelp'), errors: errorsFor('profile') },
          h(VwfSelect, {
            value: node.profile || '', invalid: errorsFor('profile').length > 0,
            options: roleOptions, disabled: ro, title: ro ? t('wbBuiltinStructureReadonly') : '',
            onChange: (v) => { if (!ro) props.onUpdate(node.id, { profile: v || null }) },
          })
        ),
        !isFanout ? h(ArtifactFilesEditor, { node, readOnly: ro, label: t('wbFieldDeliverable'), onUpdate: (id, patch) => { if (!ro) props.onUpdate(id, patch) }, errorsFor }) : null
      )

      const outcomeSection = h(React.Fragment, null,
        isFanout ? h('div', null,
          h('div', { style: { fontSize: 13, fontWeight: 500, marginTop: 10 } }, t('wbFanoutGroup')),
          h('div', { className: 'vwf-muted-sm', style: { marginTop: 2 } }, t('wbFanoutGroupHelp')),
          h(Field, { label: t('fanoutFailOn'), required: true, help: t('fanoutFailOnHelp'), errors: errorsFor('failOn') },
            h(VwfSelect, {
              value: failOnMode,
              invalid: errorsFor('failOn').length > 0,
              options: [
                { value: 'all', label: 'all' },
                { value: 'any', label: 'any' },
                { value: 'number', label: t('fanoutFailOnNumber') },
              ],
              disabled: ro, title: ro ? t('wbBuiltinStructureReadonly') : '',
              onChange: (value) => { if (!ro) props.onUpdate(node.id, { failOn: value === 'number' ? 0 : value }) },
            }),
            failOnMode === 'number' ? h('input', {
              className: 'vwf-input' + (errorsFor('failOn').length ? ' err' : ''),
              type: 'number', min: 0, step: 1, value: failOnValue, ...roDis,
              onChange: (ev) => { if (!ro) props.onUpdate(node.id, { failOn: Math.max(0, Math.trunc(Number(ev.target.value) || 0)) }) },
            }) : null
          ),
          // 扇出未完成不得冒充汇总完成（§9）：把汇总语义写在业务侧，不只在运行页体现
          h('div', { className: 'vwf-muted-sm', style: { marginTop: 4 } }, t('wbFanoutSummaryWait'))
        ) : h('div', null,
          h('div', { style: { fontSize: 13, fontWeight: 500, marginTop: 10 } }, t('resultMode')),
          h('div', { className: 'vwf-muted-sm', style: { marginTop: 2 } }, t('resultModeDescription')),
          h('div', { className: 'vwf-field' },
            h(VwfSelect, {
              value: resultMode,
              options: [
                { value: 'none', label: t('resultModeNone') },
                { value: 'ai', label: t('outputValidation') },
                { value: 'manual', label: t('manualCheck') },
                { value: 'routing', label: t('resultModeRouting') },
              ],
              disabled: ro, title: ro ? t('wbBuiltinStructureReadonly') : '',
              onChange: (mode) => {
                setSchemaError(null)
                setSchemaDirty(false)
                setSchemaNotice(null)
                const out = node.output || {}
                // 切档只允许清掉档位专属字段（successCondition / outcomePath / manualCheck），
                // 不得丢 output.schema：内核契约是「output 非空 ⇒ output.schema 必填」，
                // 丢 schema 会让节点变成自己校验不过、且本档没有 schema 输入框可改的死状态。
                setSchemaDraft(out.schema ? JSON.stringify(out.schema, null, 2) : '')
                const kept = (extra) => {
                  const next = { ...(extra || {}) }
                  if (out.schema) next.schema = out.schema
                  if (out.files) next.files = out.files
                  return Object.keys(next).length ? next : null
                }
                if (mode === 'routing') props.onUpdate(node.id, { output: kept({ schema: out.schema || null, outcomePath: out.outcomePath || '' }), manualCheck: null })
                else if (mode === 'ai') props.onUpdate(node.id, { output: kept({ schema: out.schema || null, successCondition: out.successCondition || '' }), manualCheck: null })
                else if (mode === 'manual') props.onUpdate(node.id, { output: kept(), manualCheck: true })
                else props.onUpdate(node.id, { output: kept(), manualCheck: null })
              },
            })
          ),
          resultMode === 'ai' ? h('div', { className: 'vwf-muted-sm', style: { marginTop: 6 } }, t('outputValidationDescription')) : null,
          resultMode === 'manual' ? h('div', { className: 'vwf-muted-sm', style: { marginTop: 6 } }, t('manualCheckDescription')) : null,
          resultMode === 'routing' ? h('div', { className: 'vwf-muted-sm', style: { marginTop: 6 } }, t('resultModeRoutingDescription')) : null,
          resultMode === 'routing' ? h('div', null,
            // F1：只填参数名（`$.` 前缀属于实现细节，对用户不可见）；粘贴 `$.route` 会自动归一
            h(Field, { label: t('routingFieldName'), required: true, help: t('routingFieldNameHelp'), errors: errorsFor('output.outcomePath') },
              h('input', {
                className: 'vwf-input vwf-mono' + (errorsFor('output.outcomePath').length ? ' err' : ''),
                value: routingNameDraft, placeholder: 'route', list: 'vwf-routing-candidates', ...roDis,
                onChange: (ev) => {
                  setRoutingNotice(null)
                  setRoutingNameDraft(ev.target.value)
                  const name = normalizeRoutingName(ev.target.value)
                  if (name) commitRouting(name, routingValuesDraft)
                },
                onBlur: () => {
                  const name = normalizeRoutingName(routingNameDraft)
                  if (routingNameDraft !== name) setRoutingNameDraft(name)
                  if (!name && routingNameDraft.trim()) setRoutingNotice(t('routingNameInvalid'))
                },
              })
            ),
            // 该字段的作用用可见文字说明（不只放在 ? tooltip 里）
            h('div', { className: 'vwf-muted-sm', style: { marginTop: 2 } }, t('routingFieldNameHint')),
            // 候选：schema 中已有的可穷举字段（R6/E2）
            h('datalist', { id: 'vwf-routing-candidates' },
              routingCandidateList.map((c) => h('option', { key: c, value: c }))
            ),
            !routingName
              ? h('div', { className: 'vwf-muted-sm', style: { marginTop: 6 } }, t('routingNeedFieldName'))
              : h('div', { className: 'vwf-field', style: { marginTop: 6 } },
                h('div', { className: 'vwf-field-label' }, t('routingValues'), h('span', { className: 'req' }, '*'),
                  h('span', { className: 'vwf-help', title: t('routingValuesHelp') }, '?')),
                // F2：取值参数项（+/-），写入 schema enum；F3：每行边存在性图标 + 一键补边
                routingValuesDraft.map((v, i) => {
                  const st = routingStatus.values.find((x) => x.value === v)
                  const state = st ? st.state : 'missing'
                  const declared = String(v == null ? '' : v).trim()
                  const dest = declared
                    ? (dsl.edges || []).map((e, ei) => ({ e, ei })).filter(x => x.e && x.e.from === node.id && String(x.e.outcome == null ? '' : x.e.outcome) === declared)
                    : []
                  return h('div', { key: i, className: 'vwf-row vwf-routing-row', style: { marginTop: 4 } },
                    h('input', {
                      className: 'vwf-input vwf-mono', value: v, placeholder: 'pass', ...roDis,
                      onChange: (ev) => {
                        const next = routingValuesDraft.slice()
                        next[i] = ev.target.value
                        setRoutingValuesDraft(next)
                        setRoutingValuesDirty(true)
                      },
                      onBlur: () => { if (routingValuesDirty) { commitRoutingValues(routingValuesDraft); setRoutingValuesDirty(false) } },
                    }),
                    h('span', {
                      className: 'vwf-routing-badge',
                      title: state === 'ok' ? t('routingEdgeExists') : state === 'duplicated' ? t('routingEdgeDuplicated') : t('routingEdgeMissing'),
                    }, state === 'ok' ? '✅' : state === 'duplicated' ? '❗' : '⚠️'),
                    // 业务结果的去向：直接写出这个结果会走到哪一步，不必去连接清单里找
                    h('span', { className: 'vwf-wb-outcome-to', style: { flex: '0 1 auto', minWidth: 0 } },
                      dest.length ? '→ ' + dest.map(d => nodeLabelOf(d.e.to)).join('、') : t('wbOutcomeNoTarget')),
                    state !== 'ok' && props.onAddOutcomeEdge && !ro
                      ? h('button', {
                        className: 'vwf-btn sm',
                        onClick: () => props.onAddOutcomeEdge(node.id, normalizeRoutingName(v)),
                      }, t('routingAddEdge'))
                      : null,
                    ro ? null : h('button', {
                      className: 'vwf-btn sm ghost', title: t('routingRemoveValue'),
                      onClick: () => {
                        if (st && st.state !== 'missing') { setRoutingNotice(t('routingRemoveBlocked')); return }
                        const next = routingValuesDraft.filter((_, j) => j !== i)
                        setRoutingValuesDraft(next)
                        setRoutingValuesDirty(false)
                        commitRoutingValues(next)
                      },
                    }, '−')
                  )
                }),
                ro ? null : h('button', {
                  className: 'vwf-btn sm', style: { marginTop: 6 },
                  onClick: () => { setRoutingValuesDraft(routingValuesDraft.concat([''])); setRoutingNotice(null) },
                }, '＋ ' + t('routingAddValue')),
                // E3/E4：不可穷举或 boolean 型路由字段
                !routingEnumerable && routingValuesDraft.filter((v) => String(v).trim()).length === 0
                  ? h('div', { className: 'vwf-muted-sm', style: { marginTop: 4 } }, t('routingValuesEmpty'))
                  : null,
                routingIsBoolean
                  ? h('div', { className: 'vwf-muted-sm', style: { marginTop: 4 } }, t('routingBooleanUnsupported'))
                  : (!routingEnumerable && routingValuesDraft.filter((v) => String(v).trim()).length > 0
                    ? h('div', { className: 'vwf-err-line' }, t('routingNotEnumerable'))
                    : null),
                // F4：反向告警——图中存在未声明的 outcome 取值
                routingStatus.undeclared.length
                  ? h('div', { className: 'vwf-err-line' }, t('routingUndeclaredEdges') + routingStatus.undeclared.map((x) => x.value + ' → ' + x.to).join('、'))
                  : null,
                routingNotice ? h('div', { className: 'vwf-err-line' }, routingNotice) : null
              )
          ) : null
        ),
        // 这一步的全部去向（两类模板共用一份，避免重复渲染分支）
        outgoingBlock
      )

      const advancedSection = h(React.Fragment, null,
        h('div', { className: 'vwf-muted-sm', style: { marginTop: 10, marginBottom: 2 } }, t('wbAdvancedHelp')),
        h(Field, { label: t('nodeKind'), required: true, errors: errorsFor('kind') },
          h(VwfSelect, {
            value: isFanout ? 'fanout' : 'worker',
            invalid: errorsFor('kind').length > 0,
            options: [
              { value: 'worker', label: t('nodeKindWorker') },
              { value: 'fanout', label: t('nodeKindFanout') },
            ],
            disabled: ro, title: ro ? t('wbBuiltinStructureReadonly') : '',
            onChange: (v) => { if (!ro) changeKind(v) },
          })
        ),
        h(Field, { label: t('nodeId'), required: true, help: t('nodeIdHelp'), errors: errorsFor('id') },
          h('input', {
            className: 'vwf-input vwf-mono' + (errorsFor('id').length ? ' err' : ''),
            value: idDraft, ...roDis,
            onChange: (ev) => { if (!ro) setIdDraft(ev.target.value) },
            onBlur: (ev) => { if (!ro) commitNodeId(ev.target.value) },
            onCompositionStart: () => setIdComposing(true),
            onCompositionEnd: (ev) => { setIdComposing(false); setIdDraft(ev.currentTarget.value); commitNodeId(ev.currentTarget.value) },
            onKeyDown: (ev) => { if (ev.key === 'Enter' && !idComposing) ev.currentTarget.blur() },
          })
        ),
        isFanout ? h(Field, { label: t('fanoutItems'), required: true, help: t('fanoutItemsHelp'), errors: errorsFor('items') },
          h('input', {
            className: 'vwf-input vwf-mono' + (errorsFor('items').length ? ' err' : ''),
            value: node.items || '', placeholder: '$.args.items', ...roDis,
            onChange: (ev) => { if (!ro) props.onUpdate(node.id, { items: ev.target.value }) },
          })
        ) : null,
        // AI 服务与模型：技术信息按契约收进高级层；内置模板的默认 / 覆盖入口在流程库侧
        h(Field, { label: t('agent'), required: true, help: t('wbAgentHelp'), errors: errorsFor('model.provider') },
          provOpts.length
            ? h(VwfSelect, {
                value: curProv,
                options: [{ value: '', label: t('selectAgent') }].concat(provOpts.map(id => ({ value: id, label: id }))),
                disabled: ro, title: ro ? t('wbBuiltinStructureReadonly') : '',
                onChange: (v) => { if (!ro) props.onUpdate(node.id, { model: { provider: v || undefined, model: undefined } }) },
              })
            : h('input', { className: 'vwf-input', value: curProv, placeholder: 'deepseek-official', ...roDis, onChange: (ev) => { if (!ro) props.onUpdate(node.id, { model: { provider: ev.target.value, model: curModel || undefined } }) } })
        ),
        h(Field, { label: t('model'), required: true, errors: errorsFor('model.model') },
          providers.length
            ? h(VwfSelect, {
                value: curModel,
                options: [{ value: '', label: t('selectModel') }].concat(modelOpts.map(id => ({ value: id, label: id }))),
                disabled: ro, title: ro ? t('wbBuiltinStructureReadonly') : '',
                onChange: (v) => { if (!ro) props.onUpdate(node.id, { model: { provider: curProv || undefined, model: v || undefined } }) },
              })
            : h('input', { className: 'vwf-input', value: curModel, placeholder: 'deepseek-v4-flash', ...roDis, onChange: (ev) => { if (!ro) props.onUpdate(node.id, { model: { provider: curProv || undefined, model: ev.target.value || undefined } }) } })
        ),
        h('div', { className: 'vwf-muted-sm', style: { marginTop: 2 } }, t('wbModelScopeNote')),
        isFanout
          ? schemaField({ label: t('outputSchema'), help: t('perItemSchemaHelp') })
          : h('div', null,
              resultMode === 'ai' || resultMode === 'routing' || node.output
                ? schemaField({ label: t('outputSchema'), required: resultMode === 'ai' || resultMode === 'routing', help: t('outputSchemaHelp') })
                : null,
              resultMode === 'ai' ? h(Field, { label: t('successCondition'), required: true, help: t('successConditionHelp'), errors: errorsFor('output.successCondition') },
                h('input', {
                  className: 'vwf-input vwf-mono' + (errorsFor('output.successCondition').length ? ' err' : ''),
                  value: (node.output && node.output.successCondition) || '', placeholder: '$.result == true', ...roDis,
                  onChange: (ev) => { if (!ro) { setSchemaNotice(null); props.onUpdate(node.id, { output: { ...(node.output || {}), successCondition: ev.target.value } }) } },
                })
              ) : null
            )
      )

      return h('div', { className: 'vwf-section' },
        h('div', { className: 'vwf-row' },
          h('strong', null, t('nodeConfig')),
          h('span', { className: 'vwf-spacer' }),
          h('span', { className: 'vwf-badge' }, isFanout ? 'fanout' : 'worker'),
          props.readOnlyStructure ? h('span', { className: 'vwf-badge accent' }, t('builtinBadge')) : null
        ),
        props.readOnlyStructure
          ? h('div', { className: 'vwf-wb-readonly' }, t('wbBuiltinStructureReadonly'))
          : null,
        h(InspectorTabs, {
          tabs: [
            { key: 'basic', label: t('wbSecBasic'), note: t('wbSecBasicNote'), panel: basicSection, hasError: errCount(basicFields) > 0 },
            { key: 'outcome', label: t('wbSecOutcome'), note: t('wbSecOutcomeNote'), panel: outcomeSection, hasError: errCount(outcomeFields) > 0 },
            { key: 'advanced', label: t('wbSecAdvanced'), note: t('wbSecAdvancedNote'), panel: advancedSection, hasError: errCount(advancedFields) > 0 },
          ],
        })
      )
    }

    // ── 边配置表单（对应 EdgeInspector）──────────────────────────────────────
    // 边类型四态与 validate-core 同构：成功（可带 when）/ 失败 / 技术重试（自环）/
    // 业务 outcome（名称 + countRound 回退记账）。类型切换经 updateEdge({kind})
    // 走 applyEdgeKind 互斥清理，保证 on 与 outcome 不并存。
    function EdgeInspector(props) {
      const edge = props.edge
      const dsl = props.dsl
      const index = props.index
      const errorsFor = (field) => (props.fieldErrors || {})['edge:' + index + ':' + field] || []
      const kind = edgeKind(edge)
      const targetOpts = (dsl.nodes || []).map(n => ({ value: n.id, label: (n.label ? n.label + ' · ' : '') + n.id })).concat([{ value: END_NODE, label: END_NODE + ' · ' + t('endNode') }])
      // HD 的 result 边沿原字段编辑；业务 outcome 边编辑 outcome 字段
      const outField = hasOutcomeField(edge) ? 'outcome' : (edge && edge.result !== undefined ? 'result' : 'outcome')
      const outValue = edge[outField] == null ? '' : String(edge[outField])
      // V2（F5）：源节点处于业务结果路由档时，outcome 名称改为「从节点声明取值中选」；
      // 非路由档保持文本输入（兼容手写图）；未被声明的历史/手写取值仍可见并标注。
      const srcValues = routingValuesOf((dsl.nodes || []).find(n => n && n.id === edge.from))
      const usedByOthers = {}
      if (srcValues.length) {
        ;(dsl.edges || []).forEach((e2, i2) => {
          if (i2 === index || !e2 || e2.from !== edge.from) return
          if (e2.outcome === undefined || e2.outcome === null || e2.outcome === '') return
          usedByOthers[String(e2.outcome)] = true
        })
      }
      const ro = !!props.readOnlyStructure
      const roDis = ro ? { disabled: true, title: t('wbBuiltinStructureReadonly') } : {}
      const roSel = ro ? { disabled: true, title: t('wbBuiltinStructureReadonly') } : {}
      return h('div', { className: 'vwf-section' },
        h('div', { className: 'vwf-row' },
          h('strong', null, t('edgeConfig')),
          h('span', { className: 'vwf-spacer' }),
          ro ? null : h('button', { className: 'vwf-btn sm danger', onClick: props.onDelete }, t('deleteEdge'))
        ),
        ro ? h('div', { className: 'vwf-wb-readonly' }, t('wbBuiltinStructureReadonly')) : null,
        h(Field, { label: t('edgeOutcome'), required: true, errors: errorsFor('on') },
          h(VwfSelect, {
            value: kind,
            options: ['success', 'failure', 'technical', 'outcome'].map(v => ({ value: v, label: t('edgeType_' + v) })),
            ...roSel,
            onChange: (v) => { if (!ro) props.onUpdate(index, { kind: v }) },
          })
        ),
        kind === 'outcome' ? h(Field, { label: t('edgeOutcomeName'), required: true, help: srcValues.length ? t('edgeOutcomeNameSelectHelp') : t('edgeOutcomeNameHelp'), errors: errorsFor('outcome') },
          srcValues.length
            ? h(VwfSelect, {
              value: outValue,
              invalid: errorsFor('outcome').length > 0,
              options: [{ value: '', label: t('edgeOutcomePlaceholder') }].concat(srcValues.map((v) => ({
                value: v,
                label: v + (usedByOthers[v] ? '（' + t('edgeOutcomeUsed') + '）' : ''),
              }))).concat(
                outValue && !srcValues.includes(outValue)
                  ? [{ value: outValue, label: outValue + '（' + t('edgeOutcomeUndeclared') + '）' }]
                  : []
              ),
              ...roSel,
              onChange: (v) => { if (!ro) props.onUpdate(index, { [outField]: v }) },
            })
            : h('input', {
              className: 'vwf-input vwf-mono' + (errorsFor('outcome').length ? ' err' : ''),
              value: outValue, placeholder: 'PASS', ...roDis,
              onChange: (ev) => { if (!ro) props.onUpdate(index, { [outField]: ev.target.value }) },
            })
        ) : null,
        kind === 'outcome' ? h('label', { className: 'vwf-field-label', style: { cursor: 'pointer' } },
          h('input', { type: 'checkbox', checked: !!edge.countRound, style: { margin: 0 }, ...roDis, onChange: (ev) => { if (!ro) props.onUpdate(index, { countRound: ev.target.checked }) } }),
          t('edgeCountRound'),
          h('span', { className: 'vwf-help', title: t('edgeCountRoundHelp') }, '?')
        ) : null,
        kind === 'technical' ? h('div', { className: 'vwf-muted-sm', style: { marginTop: 6 } }, t('edgeTechnicalHelp')) : null,
        h(Field, { label: t('edgeTarget'), required: true, errors: errorsFor('to') },
          h(VwfSelect, {
            value: edge.to,
            options: targetOpts, ...roSel,
            onChange: (v) => { if (!ro) props.onUpdate(index, { to: v }) },
          })
        ),
        kind === 'success' ? h(Field, { label: t('edgeWhen'), help: t('edgeWhenHelp'), errors: errorsFor('when') },
          h('input', {
            className: 'vwf-input vwf-mono' + (errorsFor('when').length ? ' err' : ''),
            value: edge.when || '', placeholder: '$.need_integration_test == true', ...roDis,
            onChange: (ev) => { if (!ro) props.onUpdate(index, { when: ev.target.value }) },
          })
        ) : null
      )
    }

    // ── 角色库管理（issue-58；FEAT-86 收口）────────────────────────────────
    // 从画布「角色库」进入：列表（来源筛选 + 内置/自定义分区）→ 查看详情（只读 +
    // 独立滚动完整职责）→ 编辑/创建表单（名称唯一校验、被引用角色保存前影响范围
    // 确认、重命名仅零引用放行）→ 删除（零引用二次确认 / 有引用阻止并展示引用
    // 位置）。覆盖在编辑器之上（fixed 遮罩），节点未提交的草稿状态不受影响。
    //
    // FEAT-86 收口点：①来源按 builtin 字段判定，分区标题与行内 badge 双重可识别；
    // ②列表摘要最多两行（显式 summary 优先，缺失时由职责生成、不写回原文）；
    // ③完整职责在独立滚动区，列表高度不随全文增长；④Escape 逐层关闭并把焦点
    // 回收到触发元素；⑤来源筛选、查看、编辑、复制、删除、关闭、保存全部键盘可达。
    function RoleManager(props) {
      const [roles, setRoles] = React.useState(null)
      const [loadError, setLoadError] = React.useState(null)
      const [filter, setFilter] = React.useState('all') // 来源筛选：all | builtin | custom
      const [view, setView] = React.useState(props.initialCreate ? 'form' : 'list')
      const [formMode, setFormMode] = React.useState(props.initialCreate ? 'create' : 'edit')
      const [current, setCurrent] = React.useState(null) // 查看/编辑中的角色详情（创建来源）
      const [draftName, setDraftName] = React.useState('')
      const [draftContent, setDraftContent] = React.useState('')
      const [error, setError] = React.useState(null)
      const [confirm, setConfirm] = React.useState(null) // {kind:'delete'|'blocked'|'impact', role?, usage?, name?, content?}
      const [saving, setSaving] = React.useState(false)
      const dialogRef = React.useRef(null)
      const viewBtnRefs = React.useRef({}) // 角色 id → 「查看详情」按钮（返回列表后回收焦点）
      const returnFocusRef = React.useRef(null) // 待回收焦点的角色 id
      const confirmReturnRef = React.useRef(null) // 关闭二次确认后要回收焦点的元素
      const newBtnRef = React.useRef(null) // 列表层「新增角色」：关闭浮层后没有指定行的兜底焦点
      const mountedRef = React.useRef(false)
      const refetch = React.useCallback(() => {
        host.call('vwf.roles').then((r) => {
          if (r && r.ok === false) {
            // 读取失败必须与「没有角色」区分（规格 §11）：保持未知态并给出重试入口
            setRoles(null)
            setLoadError((r.errors && r.errors[0] && r.errors[0].message) || t('roleLoadFailed'))
            return
          }
          setLoadError(null)
          setRoles((r && r.roles) || [])
        }).catch((e) => { setRoles(null); setLoadError(t('roleLoadFailed') + String(e)) })
      }, [])
      React.useEffect(() => { refetch() }, [])
      // 焦点回收（V-6）：打开详情/表单时焦点进入浮层容器；Escape/返回回到列表时，
      // 焦点归位到该角色的「查看详情」按钮（行按钮是重新渲染的新节点，故按 id 取当次元素）；
      // 没有指定行时（取消新建等）归位到列表层的「新增角色」，不让焦点掉到 body。
      // 首次挂载即列表层（角色=设置页签），不抢焦点。
      React.useEffect(() => {
        if (!mountedRef.current) { mountedRef.current = true; return }
        const id = view === 'list' ? returnFocusRef.current : null
        if (view === 'list') returnFocusRef.current = null
        const el = id ? viewBtnRefs.current[id] : (view === 'list' ? newBtnRef.current : dialogRef.current)
        if (el && el.focus) el.focus()
      }, [view])
      const fmt = (tpl, vars) => {
        let s = String(tpl || '')
        for (const k of Object.keys(vars || {})) s = s.split('{' + k + '}').join(String(vars[k]))
        return s
      }
      const backToList = () => { setError(null); setView('list'); setCurrent(null) }
      const closeConfirm = () => {
        setConfirm(null)
        const el = confirmReturnRef.current
        confirmReturnRef.current = null
        if (el && typeof el.focus === 'function') { try { el.focus() } catch (e) { /* 同上 */ } }
      }
      // Escape 逐层关闭（V-6）：二次确认 → 详情/表单 → 角色管理。捕获阶段拦截，
      // 避免同层编辑器 dialog 的原生 Escape 关闭把整层一起收掉。
      React.useEffect(() => {
        const onKeyDown = (ev) => {
          if (!ev || ev.key !== 'Escape') return
          // 逐层关闭（FEAT-86 V-6）：二次确认 → 详情/表单。列表层已不再是浮层（角色=设置页签），
          // 该层没有可收的内容，必须放行给宿主——否则 Escape 被吞掉，设置面板关不上。
          if (confirm) { ev.preventDefault(); ev.stopPropagation(); closeConfirm() }
          else if (view !== 'list') { ev.preventDefault(); ev.stopPropagation(); backToList() }
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => document.removeEventListener('keydown', onKeyDown, true)
      })

      const openView = (id) => {
        returnFocusRef.current = id
        setCurrent(null); setError(null); setView('view')
        host.call('vwf.roles.get', { id }).then((r) => {
          if (r && r.ok) setCurrent(r.role)
          else setError((r && r.errors && r.errors[0] && r.errors[0].message) || t('roleSaveFailed'))
        }).catch((e) => setError(String(e)))
      }
      const openEdit = (id) => {
        returnFocusRef.current = null
        setCurrent(null); setError(null)
        host.call('vwf.roles.get', { id }).then((r) => {
          if (r && r.ok) {
            setCurrent(r.role)
            setDraftName(r.role.id)
            setDraftContent(r.role.content || '')
            setFormMode('edit')
            setView('form')
          } else setError((r && r.errors && r.errors[0] && r.errors[0].message) || t('roleSaveFailed'))
        }).catch((e) => setError(String(e)))
      }
      const openCreate = (source) => {
        returnFocusRef.current = null
        setCurrent(source || null)
        setDraftName(source ? t('customRoleSuffix', { src: source.id }) : '')
        setDraftContent(source ? (source.content || '') : '')
        setFormMode('create')
        setError(null)
        setView('form')
      }
      // 自定义角色复制：与内置「基于此角色创建」同路径（详情预填 + 走 create），
      // 但 current 保持 null —— create 分支用 current.builtin===false 判定编辑，
      // 复制自定义角色必须走新建，否则会被当作 update 修改原角色。
      const openCloneCustom = (role) => {
        returnFocusRef.current = null
        setCurrent(null); setError(null); setView('form'); setFormMode('create')
        host.call('vwf.roles.get', { id: role.id }).then((r) => {
          if (r && r.ok) {
            setDraftName(t('customRoleSuffix', { src: r.role.id }))
            setDraftContent(r.role.content || '')
          } else setError((r && r.errors && r.errors[0] && r.errors[0].message) || t('roleSaveFailed'))
        }).catch((e) => setError(String(e)))
      }
      // 名称权威校验（Host：完整规则——非法字符/首尾点/Windows 保留名 + 唯一性含内置/
      // 自定义/打包回退）。客户端不再维护规则副本；本地只保留空值即时提示（非权威快速通道）。
      const validateNameWithHost = async (name) => {
        const v = await host.call('vwf.roles.validate', { name: name, excludeId: (current && current.builtin === false) ? current.id : undefined }).catch((e) => ({ ok: false, errors: [{ message: String(e) }] }))
        if (v && v.ok === true) return null
        return (v && v.errors && v.errors[0] && v.errors[0].message) || t('roleNameInvalid')
      }
      const validForm = async () => {
        const name = draftName.trim()
        if (!name) { setError(t('roleNameRequired')); return null }
        if (!draftContent.trim()) { setError(t('roleContentRequired')); return null }
        const bad = await validateNameWithHost(name)
        if (bad) { setError(bad); return null }
        return name
      }
      const submitForm = (name, content) => {
        const editingCustom = !!(current && current.builtin === false)
        setError(null)
        setSaving(true)
        const call = editingCustom
          ? host.call('vwf.roles.update', { id: current.id, name: name, content: content, draftDsl: props.draftDsl })
          : host.call('vwf.roles.create', { name: name, content: content })
        call.then((r) => {
          if (r && r.ok) {
            if (props.onChanged) props.onChanged()
            refetch()
            setView('list')
            setCurrent(null)
          } else setError((r && r.errors && r.errors[0] && r.errors[0].message) || t('roleSaveFailed'))
        }).catch((e) => setError(t('roleSaveFailed') + String(e))).then(() => setSaving(false))
      }
      const save = async () => {
        const name = await validForm()
        if (!name) return
        const editingCustom = !!(current && current.builtin === false)
        if (!editingCustom) { submitForm(name, draftContent); return }
        host.call('vwf.roles.usage', { id: current.id, draftDsl: props.draftDsl }).then((u) => {
          if (!u || u.ok !== true) {
            // 宿主失败以 ok:false 解析（而非 reject）：同样必须保持表单打开。
            setError(t('roleUsageFailed') + ((u && u.errors && u.errors[0] && u.errors[0].message) || ''))
            return
          }
          const used = u.count > 0
          if (name !== current.id && used) {
            setError(fmt(t('roleRenameBlocked'), { n: u.count }))
            return
          }
          if (used) { confirmReturnRef.current = dialogRef.current; setConfirm({ kind: 'impact', usage: u, name: name, content: draftContent }) }
          else submitForm(name, draftContent)
        }).catch((e) => {
          // fail-closed：引用统计失败时保持表单打开并展示错误，禁止绕过影响确认保存。
          setError(t('roleUsageFailed') + String(e))
        })
      }
      const confirmSave = () => {
        if (!confirm || !confirm.name) return
        const c = confirm
        setConfirm(null)
        submitForm(c.name, c.content)
      }
      const askDelete = (role, trigger) => {
        confirmReturnRef.current = trigger || null
        host.call('vwf.roles.usage', { id: role.id, draftDsl: props.draftDsl }).then((u) => {
          if (!u || u.ok !== true) {
            // fail-closed：引用统计失败时绝不进入删除确认（修复 fail-open：ok:false 曾被
            // 折叠为「零引用」直接放行删除）
            setError(t('roleUsageFailed') + ((u && u.errors && u.errors[0] && u.errors[0].message) || ''))
            return
          }
          setConfirm({ kind: u.count > 0 ? 'blocked' : 'delete', role: role, usage: u })
        }).catch((e) => setError(t('roleUsageFailed') + String(e)))
      }
      const doDelete = () => {
        if (!confirm || !confirm.role) return
        setSaving(true)
        host.call('vwf.roles.remove', { id: confirm.role.id, draftDsl: props.draftDsl }).then((r) => {
          setConfirm(null)
          if (r && r.ok) {
            if (props.onChanged) props.onChanged()
            refetch()
          } else setError((r && r.errors && r.errors[0] && r.errors[0].message) || t('roleDeleteFailed'))
        }).catch((e) => setError(t('roleDeleteFailed') + String(e))).then(() => setSaving(false))
      }

      const originBadge = (role) => {
        const origin = roleOriginOf(role)
        return h('span', { className: 'vwf-badge' + (origin.builtin ? ' accent' : '') },
          origin.builtin ? t('builtinRoleBadge') : t('customRoleBadge'))
      }
      // 列表行：名称 + 来源 badge + 最多两行摘要 + 折行的操作组。摘要为显示层生成，
      // 不写回角色原文（规格 §9）；行高不随职责全文增长（V-2）。
      const roleRow = (role) => {
        const origin = roleOriginOf(role)
        const summary = roleSummaryOf(role)
        return h('div', { key: role.id, className: 'vwf-role-row', 'data-vwf-role-origin': origin.key },
          h('div', { className: 'vwf-role-row-main' },
            h('span', { className: 'vwf-role-name' }, role.id),
            originBadge(role)
          ),
          summary ? h('div', { className: 'vwf-role-summary', title: summary }, summary) : null,
          h('div', { className: 'vwf-role-actions' },
            h('button', { className: 'vwf-btn sm', ref: (el) => { viewBtnRefs.current[role.id] = el }, onClick: () => openView(role.id) }, t('viewRoleDetail')),
            origin.builtin ? null : h('button', { className: 'vwf-btn sm', onClick: () => openEdit(role.id) }, t('editRole')),
            origin.builtin ? null : h('button', { className: 'vwf-btn sm', onClick: () => openCloneCustom(role) }, t('cloneFromRole')),
            origin.builtin ? null : h('button', { className: 'vwf-btn sm danger', onClick: () => askDelete(role) }, t('deleteRole'))
          )
        )
      }
      const allRows = roles || []
      const builtinRows = allRows.filter(r => !!r.builtin)
      const customRows = allRows.filter(r => !r.builtin)
      const showBuiltin = filter !== 'custom'
      const showCustom = filter !== 'builtin'
      const sectionTitle = (label) => h('div', { className: 'vwf-role-section-title' }, h('span', null, label))
      // 来源筛选：与原型一致带上分段计数，页签内一眼看出内置/自定义各有多少
      const filterBtn = (key, label, n) => h('button', {
        type: 'button',
        'aria-pressed': filter === key ? 'true' : 'false',
        className: 'vwf-btn sm' + (filter === key ? ' primary' : ''),
        onClick: () => setFilter(key),
      }, label + ' ' + n)

      let body = null
      if (roles === null) {
        body = h('div', { className: 'vwf-role-empty', role: 'alert' }, loadError || t('roleLoading'))
      } else if (view === 'list') {
        body = h('div', null,
          h('div', { className: 'vwf-muted-sm' }, t('roleMgmtHint')),
          h('div', { className: 'vwf-row', role: 'group', 'aria-label': t('roleLibrary') },
            filterBtn('all', t('roleFilterAll'), allRows.length),
            filterBtn('builtin', t('roleBuiltinShort'), builtinRows.length),
            filterBtn('custom', t('roleCustomShort'), customRows.length)
          ),
          showBuiltin ? h('div', null,
            sectionTitle(t('builtinRoles')),
            h('div', { className: 'vwf-list', style: { marginTop: 6 } },
              builtinRows.map(roleRow),
              !builtinRows.length ? h('div', { className: 'vwf-role-empty' }, t('noBuiltinRoles')) : null
            )
          ) : null,
          showCustom ? h('div', null,
            sectionTitle(t('customRoles')),
            h('div', { className: 'vwf-list', style: { marginTop: 6 } },
              customRows.map(roleRow),
              !customRows.length ? h('div', { className: 'vwf-role-empty' }, t('noCustomRoles')) : null
            )
          ) : null
        )
      } else if (view === 'view') {
        body = current
          ? h('div', null,
              h('div', { className: 'vwf-row' },
                h('span', { className: 'vwf-dialog-title' }, current.name || current.id),
                originBadge(current)
              ),
              h('div', { className: 'vwf-muted-sm' },
                roleOriginOf(current).builtin ? t('roleViewBuiltin') : t('roleViewCustom')),
              h('div', { className: 'vwf-role-section-title' }, h('span', null, t('roleContent'))),
              // 独立滚动区 + 键盘可进入：完整职责再长也不撑高列表或弹层
              h('div', { className: 'vwf-role-content', tabIndex: 0 }, current.content || ''),
              h('div', { className: 'vwf-row', style: { marginTop: 8, gap: 8 } },
                h('button', { className: 'vwf-btn primary', onClick: () => openCreate(current) }, t('createFromRole')),
                !roleOriginOf(current).builtin ? h('button', { className: 'vwf-btn', onClick: () => openEdit(current.id) }, t('editRole')) : null,
                h('button', { className: 'vwf-btn sm', onClick: backToList }, t('back'))
              )
            )
          : h('div', { className: 'vwf-role-empty' }, error || t('roleLoading'))
      } else {
        const editingCustom = !!(current && current.builtin === false)
        body = h('div', null,
          h('div', { className: 'vwf-row' },
            h('span', { className: 'vwf-dialog-title' }, formMode === 'edit' ? t('editRole') + ' · ' + (current ? current.id : '') : t('newRole')),
            current ? originBadge(current) : h('span', { className: 'vwf-badge' }, t('customRoleBadge'))
          ),
          editingCustom ? h('div', { className: 'vwf-muted-sm' }, fmt(t('roleFromSource'), { src: current.id })) : null,
          h('div', { className: 'vwf-field' },
            h('label', { className: 'vwf-field-label', htmlFor: 'vwf-role-name' }, t('roleName'), h('span', { className: 'req' }, '*')),
            h('input', {
              id: 'vwf-role-name',
              className: 'vwf-input', value: draftName, placeholder: t('roleNamePlaceholder'),
              onChange: (ev) => setDraftName(ev.target.value),
              onBlur: () => {
                const name = draftName.trim()
                if (!name) return
                // 失焦即时提示（Host 权威裁决）：.foo/foo./CON/COM1 等过去仅在保存时报错的
                // 名称现在输入即提示；输入过程不打断，错误在失焦/保存时呈现
                validateNameWithHost(name).then((bad) => { if (bad) setError(bad) })
              },
            })
          ),
          h('div', { className: 'vwf-field' },
            h('label', { className: 'vwf-field-label', htmlFor: 'vwf-role-content' }, t('roleContent'), h(HelpDot, { text: t('roleContentHelp') }), h('span', { className: 'req' }, '*')),
            h('textarea', {
              id: 'vwf-role-content',
              className: 'vwf-textarea vwf-mono', rows: 12, value: draftContent, placeholder: t('roleContentPlaceholder'),
              onChange: (ev) => setDraftContent(ev.target.value),
            })
          ),
          h('div', { className: 'vwf-row', style: { justifyContent: 'flex-end', gap: 8 } },
            h('button', { className: 'vwf-btn', onClick: backToList }, t('cancelRole')),
            h('button', { className: 'vwf-btn primary', disabled: saving, onClick: save }, t('saveRole'))
          )
        )
      }

      let overlay = null
      if (confirm) {
        if (confirm.kind === 'delete') {
          overlay = h('div', { className: 'vwf-dialog-mask', style: { zIndex: 980 } },
            h('div', { className: 'vwf-dialog' },
              h('div', { className: 'vwf-dialog-title' }, t('roleDeleteTitle') + confirm.role.id + t('roleDeleteTitleSuffix')),
              h('div', { className: 'vwf-dialog-desc' }, t('roleDeleteDesc')),
              h('div', { className: 'vwf-row', style: { justifyContent: 'flex-end', gap: 8 } },
                h('button', { className: 'vwf-btn', onClick: closeConfirm }, t('cancelRole')),
                h('button', { className: 'vwf-btn danger', disabled: saving, onClick: doDelete }, t('deleteRole'))
              )
            )
          )
        } else if (confirm.kind === 'blocked') {
          const usage = confirm.usage || { count: 0, refs: [] }
          overlay = h('div', { className: 'vwf-dialog-mask', style: { zIndex: 980 } },
            h('div', { className: 'vwf-dialog' },
              h('div', { className: 'vwf-dialog-title' }, t('roleBlockedTitle')),
              h('div', { className: 'vwf-dialog-desc' }, fmt(t('roleDeleteBlocked'), { name: confirm.role.id, n: usage.count })),
              (usage.refs || []).length ? h('div', null,
                h('div', { className: 'vwf-muted-sm', style: { marginBottom: 4 } }, t('roleRefs')),
                h('div', { className: 'vwf-role-refs', tabIndex: 0 },
                  usage.refs.map((w, wi) => h('div', { key: 'wf' + wi, className: 'vwf-role-ref-line' },
                    (w.workflowName || w.workflowId) + (w.builtin ? '（' + t('builtinRoleBadge') + '）' : '') + '：' +
                    w.nodes.map(n => n.label + '（' + n.id + '）').join('、')
                  ))
                )
              ) : null,
              h('div', { className: 'vwf-row', style: { justifyContent: 'flex-end' } },
                h('button', { className: 'vwf-btn primary', onClick: closeConfirm }, t('close'))
              )
            )
          )
        } else if (confirm.kind === 'impact') {
          overlay = h('div', { className: 'vwf-dialog-mask', style: { zIndex: 980 } },
            h('div', { className: 'vwf-dialog' },
              h('div', { className: 'vwf-dialog-title' }, t('roleUsageTitle')),
              h('div', { className: 'vwf-dialog-desc' }, fmt(t('roleUsageConfirm'), { n: confirm.usage.count })),
              h('div', { className: 'vwf-row', style: { justifyContent: 'flex-end', gap: 8 } },
                h('button', { className: 'vwf-btn', onClick: closeConfirm }, t('cancelRole')),
                h('button', { className: 'vwf-btn primary', onClick: confirmSave }, t('confirmSaveRole'))
              )
            )
          )
        }
      }

      // V-1：角色库是设置页的独立页签——列表直接内联在页签里（不再嵌在模板编辑画布区域，
      // 也不再套一层自己的浮层）；详情 / 表单 / 二次确认仍走同页的浮层，因此「完整职责独立
      // 滚动、逐层 Escape、焦点回收」三条能力原样保留（FEAT-86 V-2/V-6）。浮层留在页签容器内，
      // 页签本身不随浮层开合而消失。
      return h('div', { className: 'vwf-role-tab', 'data-vwf-roles-tab': '' },
        view === 'list'
          ? h('div', { className: 'vwf-row' },
              h('button', {
                className: 'vwf-btn sm primary', ref: newBtnRef,
                onClick: () => openCreate(null),
              }, '＋ ' + t('newRole')),
              h('button', { className: 'vwf-btn sm', onClick: refetch }, t('refresh'))
            )
          : null,
        error ? h('div', { className: 'vwf-err-line', role: 'alert' }, error) : null,
        view === 'list'
          ? body
          : h('div', { className: 'vwf-dialog-mask', onClick: backToList },
              h('div', {
                className: 'vwf-role-mgr',
                ref: dialogRef,
                tabIndex: -1,
                role: 'dialog',
                'aria-modal': 'true',
                'aria-label': t('roleManager'),
                onClick: (ev) => ev.stopPropagation(),
              },
                h('div', { className: 'vwf-row' },
                  h('div', { className: 'vwf-dialog-title' }, t('roleManager')),
                  h('span', { className: 'vwf-spacer' }),
                  h('button', { className: 'vwf-btn sm', onClick: backToList }, t('close'))
                ),
                h('div', { className: 'vwf-role-mgr-body' }, body)
              )
            ),
        overlay
      )
    }

    // ── 编辑器（对应 WorkflowEditor：画布 + JSON 双 tab + 配置面板）──────────
    function Editor(props) {
      const wf = props.wf
      const setWf = props.setWf
      const canvasHeight = props.canvasHeight
      const [tab, setTab] = React.useState('canvas')
      const [selectedNodeId, setSelectedNodeId] = React.useState((wf.nodes[0] || {}).id || null)
      const [selectedEdgeIndex, setSelectedEdgeIndex] = React.useState(null)
      const [visibleTerminals, setVisibleTerminals] = React.useState([])
      const [fieldErrors, setFieldErrors] = React.useState({})
      const [invalidNodeIds, setInvalidNodeIds] = React.useState(new Set())
      const [jsonDraft, setJsonDraft] = React.useState(() => JSON.stringify(wf, null, 2))
      const [jsonError, setJsonError] = React.useState(null)
      const [pendingValidation, setPendingValidation] = React.useState(null)
      const [dialogOpen, setDialogOpen] = React.useState(false)
      const [liveErrors, setLiveErrors] = React.useState([])
      // 校验警示（LOC-021）：内核 warnings 此前无编辑器出口——强档缺配对、弱异源等提示
      // 用户在配置时完全看不到。与 errors 同源同生命周期，在状态行下方以警示色展示。
      const [liveWarnings, setLiveWarnings] = React.useState([])
      const [connOpen, setConnOpen] = React.useState(false) // 连接信息弹窗（V-13）
      const validateTimerRef = React.useRef(null)
      const validateSeqRef = React.useRef(0)
      const fitRef = React.useRef(null)
      const scrollToRef = React.useRef(null)
      const scheduleValidate = (snapshot) => {
        const seq = ++validateSeqRef.current
        if (validateTimerRef.current) validateTimerRef.current()
        validateTimerRef.current = ctx.timeout(() => {
          host.call('vwf.validate', { dsl: snapshot }).then(r => {
            if (seq !== validateSeqRef.current) return
            setLiveErrors(r.ok ? [] : (r.errors || []))
            setLiveWarnings(r.warnings || [])
          }).catch((e) => {
            // 实时校验失败也必须可见：否则状态行会一直停在旧结论上
            if (seq !== validateSeqRef.current) return
            setLiveErrors([{ message: t('validateUnavailable') + String((e && e.message) || e) }])
            setLiveWarnings([])
          })
        }, VALIDATE_DEBOUNCE_MS)
      }
      const [historyVersion, setHistoryVersion] = React.useState(0)
      const historyRef = React.useRef({ past: [], future: [] })
      const historyTimerRef = React.useRef(null)
      const pendingHistoryRef = React.useRef(null)
      // 历史上限：长编辑会话防止无限增长。快照只存 JSON 字符串，避免每键双份深拷贝。
      const HISTORY_MAX = 50
      const HISTORY_DEBOUNCE_MS = 400
      const edgeSigOf = (edge) => edge ? JSON.stringify({ from: edge.from || '', to: edge.to || '', on: edge.on || '', when: edge.when || '' }) : null
      const captureBefore = (beforeDsl, beforeJson, beforeJsonError) => ({
        json: beforeJson != null ? beforeJson : JSON.stringify(beforeDsl),
        jsonError: beforeJsonError || null,
        selNode: selectedNodeId,
        selEdgeSig: edgeSigOf(selectedEdgeIndex !== null && wf.edges && wf.edges[selectedEdgeIndex] ? wf.edges[selectedEdgeIndex] : null),
      })
      const pushHistoryEntry = (entry) => {
        const h = historyRef.current
        const prev = h.past[h.past.length - 1]
        if (prev && prev.json === entry.json && prev.jsonError === entry.jsonError) return
        if (h.past.length >= HISTORY_MAX) h.past.shift()
        h.past.push(entry)
        h.future = []
        setHistoryVersion(v => v + 1)
      }
      const flushHistory = () => {
        if (historyTimerRef.current) { historyTimerRef.current(); historyTimerRef.current = null }
        if (pendingHistoryRef.current) {
          pushHistoryEntry(pendingHistoryRef.current)
          pendingHistoryRef.current = null
        }
      }
      const queueHistory = (entry, mode) => {
        if (mode === false) return
        if (mode === 'now') {
          flushHistory()
          pushHistoryEntry(entry)
          return
        }
        // debounce：窗口内保留最早的 before，连续打字只产生一条撤销记录
        if (!pendingHistoryRef.current) {
          pendingHistoryRef.current = entry
          setHistoryVersion(v => v + 1)
        }
        if (historyTimerRef.current) historyTimerRef.current()
        historyTimerRef.current = ctx.timeout(() => {
          historyTimerRef.current = null
          if (pendingHistoryRef.current) {
            pushHistoryEntry(pendingHistoryRef.current)
            pendingHistoryRef.current = null
          }
        }, HISTORY_DEBOUNCE_MS)
      }
      const applySnapshot = (entry) => {
        setJsonDraft(entry.json)
        setJsonError(entry.jsonError || null)
        setFieldErrors({})
        setInvalidNodeIds(new Set())
        setLiveErrors([])
        setLiveWarnings([])
        let parsed
        try { parsed = JSON.parse(entry.json) } catch (e) {
          // 非法 JSON 中间态：只恢复草稿文案，图模型保持当前合法态（与编辑时一致）
          return
        }
        const snapshot = normalizeEntry(parsed)
        setWf(snapshot)
        const nodeStillExists = !!entry.selNode && (snapshot.nodes || []).some(n => n.id === entry.selNode)
        if (nodeStillExists) {
          setSelectedNodeId(entry.selNode)
          setSelectedEdgeIndex(null)
        } else {
          setSelectedNodeId(null)
          let edgeMatchIndex = null
          if (entry.selEdgeSig) {
            edgeMatchIndex = (snapshot.edges || []).findIndex(e => edgeSigOf(e) === entry.selEdgeSig)
          }
          if (edgeMatchIndex !== null && edgeMatchIndex >= 0) setSelectedEdgeIndex(edgeMatchIndex)
          else setSelectedEdgeIndex(null)
        }
        scheduleValidate(snapshot)
      }
      const undo = () => {
        flushHistory()
        const h = historyRef.current
        if (!h.past.length) return
        const previous = h.past.pop()
        h.future.unshift(captureBefore(wf, jsonDraft, jsonError))
        applySnapshot(previous)
        setHistoryVersion(v => v + 1)
      }
      const redo = () => {
        flushHistory()
        const h = historyRef.current
        if (!h.future.length) return
        const next = h.future.shift()
        h.past.push(captureBefore(wf, jsonDraft, jsonError))
        applySnapshot(next)
        setHistoryVersion(v => v + 1)
      }
      const canUndo = historyRef.current.past.length > 0 || !!pendingHistoryRef.current
      const canRedo = historyRef.current.future.length > 0

      const selectedNode = selectedNodeId ? (wf.nodes || []).find(n => n.id === selectedNodeId) || null : null
      const selectedEdge = selectedEdgeIndex !== null ? (wf.edges || [])[selectedEdgeIndex] || null : null
      const entryCandidates = React.useMemo(() => deriveEntryCandidates(wf), [wf])
      // 编辑已有模板且 ID 已修改 → 保存置灰，只能另存为（currentId=原模板 id）
      const idChanged = props.currentId != null && wf.id !== props.currentId
      // 内置模板结构只读（§9/V-7）：节点与连接不可编辑，控件不可用并给出说明；
      // 供应商 / 模型仍走既有「模型覆盖」入口（流程库行内），本任务不重新设计该入口。
      const readOnlyStructure = !!props.builtin

      // ── A 编排台（FEAT-84）：窄屏流程 / 配置窗格 + 步骤/连接共用同一套执行序 ─────
      // 窄屏本身由 CSS 媒体查询驱动（900px）；这里只管当前窗格，
      // 桌面宽度下 pane-* 类不参与任何布局。
      const [narrowPane, setNarrowPane] = React.useState('flow')
      const wbLayout = React.useMemo(() => {
        try { return layoutGraph(wf, visibleTerminals) } catch (e) { return null }
      }, [JSON.stringify({ entry: wf.entry || '', n: (wf.nodes || []).map(n => n.id), e: (wf.edges || []).map(e => [e.from, e.to, e.on, e.outcome, e.countRound]), v: visibleTerminals })])
      // 执行序 = 画布分层序号（与节点角标同源）；连接分类与「步骤在前在后」判定共用它
      const rankOf = (id) => (wbLayout && wbLayout.rank && wbLayout.rank[id] != null ? wbLayout.rank[id] : null)
      const pickStep = (id) => {
        setSelectedNodeId(id)
        setSelectedEdgeIndex(null)
        if (props.onPickNode) props.onPickNode()
        ctx.timeout(() => { if (scrollToRef.current) scrollToRef.current(id) }, 0)
      }
      const pickEdge = (index) => {
        setSelectedEdgeIndex(index)
        setSelectedNodeId(null)
        if (props.onPickNode) props.onPickNode()
      }
      // 未保存三选一的「保存并返回」需要能触发编辑器内的保存流程（校验失败时留在原处）
      React.useEffect(() => {
        if (props.registerSave) props.registerSave(() => { void handleSave() })
      })
      // Escape 分层关闭：先关最上层（连接弹窗 / 校验弹窗），都不在时才让宿主关闭整个工作区。
      // 角色库已迁到设置页签（V-1），不再经过工作区，分层关闭由 RoleManager 自己承担。
      React.useEffect(() => {
        const onKey = (ev) => {
          if (ev.key !== 'Escape') return
          if (connOpen) { ev.preventDefault(); ev.stopPropagation(); setConnOpen(false); return }
          if (dialogOpen) { ev.preventDefault(); ev.stopPropagation(); closeValidationDialog() }
        }
        document.addEventListener('keydown', onKey, true)
        return () => document.removeEventListener('keydown', onKey, true)
      })

      // history: 'now' = 结构变更立即入栈；默认 debounce = 打字合并为一条
      const syncWorkflow = (next, opts) => {
        const mode = (opts && opts.history) || 'debounce'
        queueHistory(captureBefore(wf, jsonDraft, jsonError), mode)
        const normalized = normalizeEntry(next)
        setFieldErrors({})
        setInvalidNodeIds(new Set())
        setJsonError(null)
        setLiveErrors([])
        setLiveWarnings([])
        setWf(normalized)
        setJsonDraft(JSON.stringify(normalized, null, 2))
        scheduleValidate(normalized)
      }
      React.useEffect(() => () => {
        if (validateTimerRef.current) validateTimerRef.current()
        if (historyTimerRef.current) historyTimerRef.current()
      }, [])
      React.useEffect(() => {
        scheduleValidate(wf)
      }, [])

      const handleConnect = (from, to) => {
        if (from === END_NODE) return
        const edge = { from, to, on: 'success' }
        const next = { ...wf, edges: [...(wf.edges || []), edge] }
        syncWorkflow(next, { history: 'now' })
        setSelectedEdgeIndex(next.edges.length - 1)
        setSelectedNodeId(null)
      }

      // V2 F3：取值行缺失对应边时的一键补边（默认落 $end，建后选中可改目标）
      const addOutcomeEdge = (from, outcome) => {
        if (!from || !outcome) return
        const edge = { from, to: END_NODE, outcome }
        const next = { ...wf, edges: [...(wf.edges || []), edge] }
        syncWorkflow(next, { history: 'now' })
        setSelectedEdgeIndex(next.edges.length - 1)
        setSelectedNodeId(null)
      }

      const addNode = () => {
        const id = uniqueNodeId(wf, 'node-' + (wf.nodes.length + 1))
        const node = { id, label: t('defaultNodeLabel', { n: id.replace(/\D+/g, '') || String(wf.nodes.length + 1) }), profile: '' }
        const next = { ...wf, entry: wf.entry || id, nodes: [...wf.nodes, node] }
        syncWorkflow(next, { history: 'now' })
        setSelectedNodeId(id)
        setSelectedEdgeIndex(null)
      }

      const deleteSelectedNode = () => {
        if (!selectedNodeId) return
        const nodes = wf.nodes.filter(n => n.id !== selectedNodeId)
        const next = {
          ...wf,
          entry: wf.entry === selectedNodeId ? ((nodes[0] || {}).id || '') : wf.entry,
          nodes,
          edges: wf.edges.filter(e => e.from !== selectedNodeId && e.to !== selectedNodeId),
        }
        syncWorkflow(next, { history: 'now' })
        setSelectedNodeId((nodes[0] || {}).id || null)
      }

      const updateNode = (nodeId, patch) => {
        const nextId = patch.id && patch.id !== nodeId ? sanitizeNodeId(patch.id, wf, nodeId) : null
        const next = {
          ...wf,
          entry: nextId && wf.entry === nodeId ? nextId : wf.entry,
          nodes: wf.nodes.map(n => n.id === nodeId ? { ...n, ...patch, id: nextId || n.id } : n),
          edges: nextId ? wf.edges.map(e => ({ ...e, from: e.from === nodeId ? nextId : e.from, to: e.to === nodeId ? nextId : e.to })) : wf.edges,
        }
        syncWorkflow(next, nextId ? { history: 'now' } : undefined)
        if (nextId) setSelectedNodeId(nextId)
      }

      // patch.kind 触发边类型切换（applyEdgeKind 互斥清理）；其余 patch 后做与
      // validate-core 一致的兜底清理：when 仅 success、countRound 仅业务边。
      const updateEdge = (index, patch) => {
        const current = wf.edges[index]
        if (!current) return
        let updated
        if (patch && patch.kind !== undefined) {
          const rest = { ...patch }
          delete rest.kind
          updated = applyEdgeKind({ ...current, ...rest }, patch.kind)
        } else {
          updated = { ...current, ...patch }
        }
        if (updated.on !== 'success') delete updated.when
        else if (patch.when !== undefined && !String(patch.when).trim()) delete updated.when
        if (edgeKind(updated) !== 'outcome' || !updated.countRound) delete updated.countRound
        const next = { ...wf, edges: wf.edges.map((e, i) => i === index ? updated : e) }
        syncWorkflow(next)
        setSelectedEdgeIndex(index)
      }

      const deleteSelectedEdge = () => {
        if (selectedEdgeIndex === null) return
        syncWorkflow({ ...wf, edges: wf.edges.filter((_, i) => i !== selectedEdgeIndex) }, { history: 'now' })
        setSelectedEdgeIndex(null)
      }

      const updateControl = (patch) => {
        const control = { ...(wf.control || {}), ...patch }
        if (control.maxRounds == null) delete control.maxRounds
        syncWorkflow({ ...wf, control })
      }

      // 业务规则字段（候选二 Q7）：工作流级顶层字段（异源开关 / 超限行为）
      const updateMeta = (patch) => syncWorkflow({ ...wf, ...patch })

      // 保存：校验 → 失败弹窗；关闭弹窗 → 字段标红 + 画布红圈 + 定位首个问题
      const handleSave = async () => {
        let toSave = wf
        if (tab === 'json') {
          let parsed = null
          try { parsed = JSON.parse(jsonDraft) } catch (e) { parsed = null }
          if (!parsed || !Array.isArray(parsed.nodes)) {
            setJsonError(t('outputSchemaInvalid'))
            return
          }
          toSave = normalizeEntry(ingestEditorJson(parsed))
          setWf(toSave)
        }
        // RPC 异常（宿主 handler 抛错 / 校验服务不可用）必须走进校验弹窗：
        // 静默 return 会表现为「点保存没反应」且 dirty 不清、退出时才提示未保存
        const v = await host.call('vwf.validate', { dsl: toSave }).catch((e) => ({
          ok: false,
          errors: [{ at: '$', message: t('validateUnavailable') + String((e && e.message) || e) }],
        }))
        if (!v) return
        if (!v.ok) {
          setPendingValidation(v)
          setDialogOpen(true)
          return
        }
        const r = await host.call('vwf.workflows.save', { dsl: v.sanitized || toSave, currentId: props.currentId }).catch((e) => ({ ok: false, errors: [{ message: String(e) }] }))
        if (!r.ok) {
          setPendingValidation({ errors: r.errors || [{ message: t('saveFailed') }] })
          setDialogOpen(true)
          return
        }
        setFieldErrors({})
        setInvalidNodeIds(new Set())
        if (r.dsl) { setWf(r.dsl); setJsonDraft(JSON.stringify(r.dsl, null, 2)) }
        props.onSaved(r.id)
      }

      const closeValidationDialog = () => {
        setDialogOpen(false)
        if (!pendingValidation) return
        const fe = pendingValidation.fieldErrors || {}
        setFieldErrors(fe)
        const invalid = new Set()
        ;(pendingValidation.errors || []).forEach(e2 => {
          if (e2.nodeIds) e2.nodeIds.forEach(id => invalid.add(id))
          else if (e2.nodeId) invalid.add(e2.nodeId)
        })
        setInvalidNodeIds(invalid)
        if (pendingValidation.sanitized) {
          setWf(pendingValidation.sanitized)
          setJsonDraft(JSON.stringify(pendingValidation.sanitized, null, 2))
        }
        const first = (pendingValidation.errors || []).find(e2 => e2.nodeId || (e2.nodeIds && e2.nodeIds.length) || e2.edgeIndex !== undefined)
        if (first) {
          const nid = first.nodeId || (first.nodeIds || [])[0]
          if (nid) {
            setSelectedNodeId(nid)
            setSelectedEdgeIndex(null)
            ctx.timeout(() => { if (scrollToRef.current) scrollToRef.current(nid) }, 0)
          }
          else if (first.edgeIndex !== undefined) { setSelectedEdgeIndex(first.edgeIndex); setSelectedNodeId(null) }
        }
        setPendingValidation(null)
      }

      const onJsonChange = (value) => {
        queueHistory(captureBefore(wf, jsonDraft, jsonError), 'debounce')
        setJsonDraft(value)
        setJsonError(null)
        try {
          const parsed = JSON.parse(value)
          if (parsed && Array.isArray(parsed.nodes)) {
            const next = normalizeEntry(ingestEditorJson(parsed))
            setWf(next)
          }
        } catch (e) { /* 保留草稿，保存时报错 */ }
      }

      return h('div', null,
        // 连接信息（V-13）：常驻清单改为「查看连接」按钮 + 弹窗，逐条覆盖模板定义的全部连接
        connOpen ? h('div', { className: 'vwf-dialog-mask', onClick: () => setConnOpen(false) },
          h('div', { className: 'vwf-dialog vwf-conn-dialog', onClick: (ev) => ev.stopPropagation() },
            h('div', { className: 'vwf-dialog-title' }, t('wbConnections') + ' · ' + (wf.name || wf.id || '')),
            h('div', { className: 'vwf-dialog-desc' }, t('wbConnDialogDesc')),
            h(ConnectionList, {
              dsl: wf, rankOf, selectedEdgeIndex,
              onPickEdge: (index) => { setConnOpen(false); pickEdge(index) },
            }),
            h('div', { className: 'vwf-row', style: { justifyContent: 'flex-end' } },
              h('button', { className: 'vwf-btn primary', onClick: () => setConnOpen(false) }, t('close'))
            )
          )
        ) : null,
        dialogOpen ? h('div', { className: 'vwf-dialog-mask', onClick: closeValidationDialog },
          h('div', { className: 'vwf-dialog', onClick: (ev) => ev.stopPropagation() },
            h('div', { className: 'vwf-dialog-title' }, t('validationDialogTitle')),
            h('div', { className: 'vwf-dialog-desc' }, t('validationDialogDescription')),
            h('div', { className: 'vwf-dialog-issues' },
              ((pendingValidation && pendingValidation.errors) || []).map((e2, i) => h('div', { key: i, className: 'vwf-dialog-issue' }, e2.message))
            ),
            h('div', { className: 'vwf-row', style: { justifyContent: 'flex-end' } },
              h('button', { className: 'vwf-btn primary', onClick: closeValidationDialog }, t('validationDialogClose'))
            )
          )
        ) : null,
        // 窗格切换条与网格平级：放在网格内会随所在窗格一起被隐藏（配置窗格里无法切回流程）
        h('div', { className: 'vwf-pane-switch', role: 'tablist', 'aria-label': t('wbPaneSwitch') },
          h('button', {
            className: 'vwf-wb-pane-tab' + (narrowPane === 'flow' ? ' on' : ''), type: 'button', role: 'tab',
            'aria-selected': narrowPane === 'flow' ? 'true' : 'false',
            onClick: () => setNarrowPane('flow'),
          }, t('wbPaneFlow')),
          h('button', {
            className: 'vwf-wb-pane-tab' + (narrowPane === 'config' ? ' on' : ''), type: 'button', role: 'tab',
            'aria-selected': narrowPane === 'config' ? 'true' : 'false',
            onClick: () => setNarrowPane('config'),
          }, t('wbPaneConfig'))
        ),
        h('div', { className: 'vwf-editor pane-' + narrowPane },
          h('div', { className: 'vwf-nav-col' },
            h('div', { className: 'vwf-card vwf-wb-steps-card' },
              h('div', { className: 'vwf-card-head' },
                h('div', { className: 'vwf-card-title' }, t('wbSteps')),
                h('span', { className: 'vwf-badge' }, (wf.nodes || []).length + '')
              ),
              h(StepNavigator, {
                dsl: wf, visibleTerminals, selectedNodeId,
                onPick: pickStep,
              })
            )
          ),
          h('div', { className: 'vwf-canvas-col' },
            h('div', { className: 'vwf-card' },
              h('div', { className: 'vwf-card-head' },
                h('div', null,
                  h('div', { className: 'vwf-card-title' }, t('title')),
                  // 模板信息：名称/ID 必填可编辑（编辑态 ID 变化 → 保存置灰，只能另存为）
                  h('div', { className: 'vwf-row', style: { gap: 8, marginTop: 8 } },
                    h('span', { className: 'vwf-field-label' }, t('templateName'), h('span', { className: 'req' }, '*')),
                    h('input', {
                      className: 'vwf-input', style: { width: 220 },
                      value: wf.name || '', placeholder: t('templateName'),
                      disabled: readOnlyStructure, title: readOnlyStructure ? t('wbBuiltinStructureReadonly') : '',
                      onChange: (ev) => { if (!readOnlyStructure) syncWorkflow({ ...wf, name: ev.target.value }) },
                    }),
                    h('span', { className: 'vwf-field-label' }, t('templateId'), h('span', { className: 'req' }, '*')),
                    h('input', {
                      className: 'vwf-input vwf-mono', style: { width: 180 },
                      value: wf.id || '', placeholder: 'my-workflow',
                      disabled: readOnlyStructure, title: readOnlyStructure ? t('wbBuiltinStructureReadonly') : '',
                      onChange: (ev) => { if (!readOnlyStructure) syncWorkflow({ ...wf, id: ev.target.value }) },
                    })
                  ),
                  h('div', { className: 'vwf-muted-sm', style: { marginTop: 2 } }, t('subtitle'))
                ),
                h('div', { className: 'vwf-row', style: { gap: 6, alignItems: 'center' } },
                  h('div', { className: 'vwf-history-group' },
                    h('button', { className: 'vwf-btn sm ghost vwf-history-btn', disabled: !canUndo, title: t('undo'), onClick: undo }, '↶'),
                    h('button', { className: 'vwf-btn sm ghost vwf-history-btn', disabled: !canRedo, title: t('redo'), onClick: redo }, '↷')
                  ),
                  h('div', { className: 'vwf-row', style: { gap: 2 } },
                    h('button', { className: 'vwf-btn sm' + (tab === 'canvas' ? ' primary' : ''), onClick: () => setTab('canvas') }, t('canvas')),
                    h('button', {
                      className: 'vwf-btn sm' + (tab === 'json' ? ' primary' : ''),
                      disabled: readOnlyStructure, title: readOnlyStructure ? t('wbBuiltinStructureReadonly') : '',
                      onClick: () => { if (!readOnlyStructure) setTab('json') },
                    }, 'JSON')
                  ),
                  h('button', {
                    className: 'vwf-btn sm',
                    disabled: !!props.probing || !(wf.nodes || []).length,
                    title: t('oneClickCheckHelp'),
                    onClick: () => { void props.onOneClickCheck() },
                  }, props.probing ? t('oneClickCheckRunning') : t('oneClickCheck')),
                  h('button', {
                    className: 'vwf-btn sm ghost',
                    disabled: !!props.probing || !(wf.nodes || []).length,
                    title: t('probeForceRerunHint'),
                    onClick: () => { void props.onOneClickCheck(true) },
                  }, props.probing ? t('oneClickCheckRunning') : t('probeForceRerun')),
                  idChanged ? h('button', { className: 'vwf-btn sm', onClick: () => { void handleSave() } }, t('saveAs')) : null,
                  h('button', {
                    className: 'vwf-btn sm primary',
                    disabled: props.saving || !(wf.nodes || []).length || idChanged || readOnlyStructure,
                    title: readOnlyStructure ? t('wbBuiltinSaveDisabled') : '',
                    onClick: () => { if (!readOnlyStructure) { void handleSave() } },
                  }, t('saveWorkflow'))
                )
              ),
              tab === 'canvas' ? h('div', { className: 'vwf-canvas-toolbar' },
                h('div', { className: 'vwf-toolbar-actions' },
                  h('button', {
                    className: 'vwf-toolbar-action', disabled: readOnlyStructure,
                    title: readOnlyStructure ? t('wbBuiltinStructureReadonly') : '',
                    onClick: () => { if (!readOnlyStructure) addNode() },
                  },
                    h('span', { className: 'vwf-toolbar-action-icon' }, '＋'),
                    h('span', { className: 'vwf-toolbar-action-label' }, t('addNode'))
                  ),
                  h('button', {
                    className: 'vwf-toolbar-action danger', disabled: !selectedNodeId || readOnlyStructure,
                    title: readOnlyStructure ? t('wbBuiltinStructureReadonly') : '',
                    onClick: () => { if (!readOnlyStructure) deleteSelectedNode() },
                  },
                    h('span', { className: 'vwf-toolbar-action-icon' }, '−'),
                    h('span', { className: 'vwf-toolbar-action-label' }, t('deleteNode'))
                  ),
                  // 查看连接（V-13）：连接信息收进弹窗，画布不再被常驻清单占位
                  h('button', {
                    className: 'vwf-toolbar-action vwf-conn-open', onClick: () => setConnOpen(true),
                    title: t('wbConnDialogDesc'),
                  },
                    h('span', { className: 'vwf-toolbar-action-icon' }, '⇄'),
                    h('span', { className: 'vwf-toolbar-action-label' }, t('wbViewConnections') + '（' + (wf.edges || []).length + '）')
                  )
                ),
                h('span', { className: 'vwf-muted-sm vwf-toolbar-hint' }, t('connectHint'))
              ) : null,
              tab === 'canvas'
                ? h(Canvas, {
                    dsl: wf,
                    height: canvasHeight,
                    structureLocked: readOnlyStructure,
                    visibleTerminals,
                    selectedNode: selectedNodeId,
                    selectedEdge: selectedEdgeIndex,
                    invalidNodes: invalidNodeIds,
                    entryCandidates,
                    registerFit: (fn) => { fitRef.current = fn },
                    registerScrollTo: (fn) => { scrollToRef.current = fn },
                    onNodeClick: (id) => { setSelectedNodeId(id); setSelectedEdgeIndex(null) },
                    onTerminalClick: () => { setSelectedNodeId(null) },
                    onEdgeClick: (idx) => { setSelectedEdgeIndex(idx); setSelectedNodeId(null) },
                    onPaneClick: () => { /* 与 Gold-Band 一致：空白点击只关闭菜单，不清空选择 */ },
                    onConnect: handleConnect,
                    onAddTerminal: (id) => setVisibleTerminals(cur => cur.indexOf(id) >= 0 ? cur : cur.concat([id])),
                  })
                : h('div', { style: { padding: 12, borderTop: '1px solid var(--vwf-border)' } },
                    h('textarea', { className: 'vwf-textarea vwf-json-edit', value: jsonDraft, spellCheck: false, onChange: (ev) => onJsonChange(ev.target.value) }),
                    jsonError ? h('div', { className: 'vwf-err-line' }, jsonError) : null
                  )
            ),
            h('div', { className: 'vwf-status ' + (liveErrors.length ? 'err' : 'ok'), style: { marginTop: 6 } },
              liveErrors.length ? liveErrors.length + ' ' + t('validIssues') + '：' + liveErrors[0].message + (liveErrors.length > 1 ? ' …' : '') : t('validOk')
            ),
            // 校验警示（LOC-021）：非阻断提示（如强档缺配对、弱异源）与错误同区展示，
            // 不与错误争夺同一行——错误存在时让位给错误，避免用户误判为阻断。
            liveWarnings.length && !liveErrors.length
              ? h('div', { className: 'vwf-status warn', style: { marginTop: 2 } },
                  '⚠️ ' + liveWarnings.length + ' ' + t('validWarnings') + '：' + liveWarnings[0] + (liveWarnings.length > 1 ? ' …' : ''))
              : null
          ),
          h('div', { className: 'vwf-card vwf-inspector' },
            h('div', { className: 'vwf-card-title', style: { marginBottom: 4 } }, t('inspector')),
            h('div', { className: 'vwf-section' },
              h('div', { style: { fontSize: 13, fontWeight: 500 } }, t('workflowControls')),
              h('div', { className: 'vwf-muted-sm', style: { marginTop: 2 } }, t('workflowControlsHelp')),
              h(Field, { label: t('maxRounds'), help: t('maxRoundsHelp'), errors: fieldErrors['control:maxRounds'] || [] },
                h('input', {
                  className: 'vwf-input' + ((fieldErrors['control:maxRounds'] || []).length ? ' err' : ''),
                  type: 'number', min: 1, max: 9, step: 1,
                  value: wf.control && wf.control.maxRounds != null ? wf.control.maxRounds : '',
                  placeholder: '9',
                  onChange: (ev) => {
                    const raw = ev.target.value
                    if (!raw.trim()) return updateControl({ maxRounds: null })
                    const parsed = Number(raw)
                    // 系统约定上限 9（候选二 Q7）：超 9 钳制到 9，校验器同样强制 1-9
                    updateControl({ maxRounds: Number.isFinite(parsed) ? Math.min(9, Math.trunc(parsed)) : 0 })
                  },
                })
              ),
              h(Field, { label: t('heteroCheck'), help: t('heteroCheckHelp'), errors: fieldErrors['heteroCheck'] || [] },
                h('select', {
                  className: 'vwf-input' + ((fieldErrors['heteroCheck'] || []).length ? ' err' : ''),
                  // 异源档位三态（LOC-021）：默认档 = 弱；关档下开发与审核同模型属用户显式选择，系统不提示
                  value: (wf.heteroCheck === true || wf.heteroCheck === undefined || wf.heteroCheck === null || wf.heteroCheck === 'weak')
                    ? 'weak'
                    : (wf.heteroCheck === false ? 'off' : wf.heteroCheck),
                  onChange: (ev) => updateMeta({ heteroCheck: ev.target.value }),
                },
                  h('option', { value: 'weak' }, t('heteroModeWeak')),
                  h('option', { value: 'strong' }, t('heteroModeStrong')),
                  h('option', { value: 'off' }, t('heteroModeOff'))
                )
              ),
              h(Field, { label: t('onMaxRounds'), help: t('onMaxRoundsHelp'), errors: fieldErrors['onMaxRounds'] || [] },
                h('select', {
                  className: 'vwf-input',
                  value: wf.onMaxRounds || 'return',
                  onChange: (ev) => {
                    const v = ev.target.value
                    if (v === 'return') updateMeta({ onMaxRounds: undefined })
                    else updateMeta({ onMaxRounds: v })
                  },
                },
                  h('option', { value: 'return' }, 'return'),
                  h('option', { value: 'auto-reschedule' }, 'auto-reschedule')
                )
              )
            ),
            selectedNode ? h(NodeInspector, {
              node: selectedNode, dsl: wf, fieldErrors, providers: props.providers, roles: props.roles,
              readOnlyStructure, orderOf: rankOf, onPickEdge: pickEdge,
              onUpdate: updateNode, onAddOutcomeEdge: addOutcomeEdge,
            }) : null,
            selectedEdge ? h(EdgeInspector, { edge: selectedEdge, index: selectedEdgeIndex, dsl: wf, fieldErrors, readOnlyStructure, onUpdate: updateEdge, onDelete: deleteSelectedEdge }) : null,
            !selectedNode && !selectedEdge ? h('div', { className: 'vwf-empty', style: { marginTop: 10 } }, t('selectHint')) : null
          )
        ),
      )
    }

    // ── 运行看板（保留 pkg-19 能力，画布复用 Canvas 只读态）──────────────────
    function nodeIdForLabel(label, dsl) {
      for (const n of (dsl.nodes || [])) { if (n.label === label || n.id === label) return n.id }
      return null
    }
    function mapStatus(state, dsl) {
      const m = {}
      for (const a of (state && state.agents) || []) {
        const baseLabel = String(a.label).replace(/ R\d+$/, '').replace(/ #\d+$/, '')
        const id = nodeIdForLabel(baseLabel, dsl)
        if (!id) continue
        const next = a.outcome === 'completed' ? 'pass' : a.outcome === 'failed' ? 'fail' : 'running'
        if (next === 'fail' || m[id] === undefined || (next === 'running' && m[id] === 'pass')) m[id] = next
      }
      const cur = state && state.phase ? nodeIdForLabel(state.phase, dsl) : null
      if (cur && m[cur] !== 'pass' && m[cur] !== 'fail') m[cur] = 'running'
      return m
    }

    function dashboardAgentRows(agents) {
      const regular = []
      const groups = []
      const byGroup = {}
      for (const a of agents || []) {
        const clean = String(a.label || '').replace(/ R\d+$/, '')
        const match = /^(.*) #(\d+)$/.exec(clean)
        if (!match) { regular.push(a); continue }
        if (!byGroup[match[1]]) {
          byGroup[match[1]] = []
          groups.push(match[1])
        }
        byGroup[match[1]].push({ ...a, itemIndex: Number(match[2]) })
      }
      // 节点执行结果同样是双通道（V-4）：形状 + outcome 文字，不只靠颜色。
      const statusBadge = (a) => {
        const tone = a.outcome === 'completed' ? 'ok' : a.outcome === 'failed' ? 'err' : 'run'
        return h('span', { className: 'vwf-badge', style: { color: STATUS_COLOR[tone === 'ok' ? 'pass' : tone === 'err' ? 'fail' : 'running'] } }, STATUS_SHAPE[tone] + ' ' + a.outcome)
      }
      const rows = regular.map(a => h('tr', { key: 'agent-' + a.seq },
        h('td', null, String(a.seq)),
        h('td', null, a.label),
        h('td', null, a.phase || '—'),
        h('td', null, statusBadge(a))
      ))
      for (const name of groups) {
        rows.push(h('tr', { key: 'group-' + name, className: 'vwf-fanout-group' },
          h('td', { colSpan: 4 }, name + ' · fanout · ' + byGroup[name].length + ' items')
        ))
        byGroup[name].sort((a, b) => a.itemIndex - b.itemIndex).forEach((a) => {
          rows.push(h('tr', { key: 'fanout-' + a.seq },
            h('td', null, '#' + a.itemIndex),
            h('td', null, a.label),
            h('td', null, a.phase || '—'),
            h('td', null, statusBadge(a))
          ))
        })
      }
      return rows
    }

    function statusBadge(status) {
      const s = String(status || '')
      // #80：PAUSED 用人工关注色（可恢复等待态），不落 fail 色
      // LOC-030：BLOCKED 同为可恢复等待态（统一受阻生命周期，非终态），不落 fail 色
      const tone = s === 'DONE' ? 'ok' : s === 'running' ? 'run' : (s === 'WAITING_HUMAN' || s.indexOf('AWAITING_HUMAN_') === 0 || s === 'PAUSED' || s === 'BLOCKED') ? 'wait' : 'err'
      const label = s === 'WAITING_HUMAN' ? t('dashWaitHuman') : s === 'BLOCKED' ? t('dashBlocked') : s.indexOf('AWAITING_HUMAN_') === 0 ? t('dashHumanGate') : (s || '—')
      return h('span', { className: 'vwf-badge', style: { color: STATUS_COLOR[tone === 'ok' ? 'pass' : tone === 'err' ? 'fail' : tone === 'run' ? 'running' : 'human'] } }, STATUS_SHAPE[tone] + ' ' + label)
    }
    // FEAT-100 V-3：待处理（人工门禁）任务数 = 列表「待处理」筛选同一口径（bucket=attention，
    // 含 PAUSED），同一 Logical Run 的多段折叠为一条，已被续跑接管的段不计。
    // 页签计数与列表筛选共用它，避免两处口径漂移。
    function attentionTaskCount(runs) {
      const seen = new Set()
      for (const run of runs || []) {
        if (!run || run.supersededBy || runBucketOf(run.status) !== 'attention') continue
        seen.add(run.logical_run_id || run.id)
      }
      return seen.size
    }
    function isActiveRunStatus(status) {
      const s = String(status || '')
      return s === 'running' || s === 'WAITING_HUMAN' || s.indexOf('AWAITING_HUMAN_') === 0 || s === 'PAUSED'
    }

    // ── 运行看板（FEAT-85：多工作空间运行列表 + Logical Run 详情工作区）──────────
    // 「一个列表管多个任务，一个详情看一次运行」：列表按 logical_run_id 折叠 segment
    // （一个 Logical Run = 一个用户任务），按工作空间分组；详情只保留一个选中节点的
    // 结果出口，结果 / 检查 / 活动用页签在同一区域切换。
    // 数据来源全部为既有协议（不新增 RPC、不改运行存储格式）：
    //   vwf.runs.list       运行摘要行 + 逻辑运行 join（logical_run_id / segment /
    //                       segment_count / logical_state / pause_pending）
    //   vwf.logicalRuns.get 详情：lifecycle / segments / snapshots / node_attempts /
    //                       business_outcomes / completion / guidance / control_events /
    //                       baseline_revisions / workspace / human_decisions
    //   vwf.records.list    逐次 attempt（kind / round / item_index / result / outcome）与
    //                       节点成果 + resolved_inputs（扇出汇总输入来源）
    //   vwf.state           现况：agents / logs / formalRecords / decision_package / blocked_edge
    //   vwf.run.control     pause / interrupt / guidance
    const HD_UNKNOWN = 'UNKNOWN'
    // 待处理 = 需人工介入或可恢复（人工门禁 / WAITING_HUMAN / PAUSED / BLOCKED）
    function isAttentionStatus(status) {
      const s = String(status || '')
      return s === 'WAITING_HUMAN' || s.indexOf('AWAITING_HUMAN_') === 0 || s === 'PAUSED' || s === 'BLOCKED'
    }
    // 列表状态分桶：待处理 / 进行中 / 已完成 / 已结束（非完成终态，如 STOPPED、FAILED_*）
    // FEAT-100 V-3 组内顺序：需处理（人工门禁）→ 进行中 → 已完成；ended（已结束）排在
    // 末档，既不抢前三档的位置，也不因为改排序而从列表里消失。
    function runOrderOf(bucket) {
      return bucket === 'attention' ? 0 : bucket === 'running' ? 1 : bucket === 'done' ? 2 : 3
    }
    function runBucketOf(status) {
      const s = String(status || '')
      if (isAttentionStatus(s)) return 'attention'
      if (s === 'DONE') return 'done'
      if (s === 'running') return 'running'
      return 'ended'
    }
    function fmtAt(ts) {
      const n = Number(ts) || 0
      if (!n) return '—'
      try { return new Date(n).toLocaleString() } catch (e) { return '—' }
    }
    function shortSha(v) {
      const s = String(v || '')
      return s ? s.slice(0, 10) : '—'
    }
    // 同一 Logical Run 的多段折叠为一个用户任务（规格 §9：多 segment 不得呈现为多个新任务）。
    // 无逻辑归属的旧记录各自成行，保持既有呈现不被吞掉。
    function foldRunsIntoTasks(runs) {
      const tasks = []
      const byLogical = new Map()
      for (const r of runs || []) {
        const lr = String(r.logical_run_id || '')
        if (!lr) { tasks.push({ key: 'run:' + r.id, logicalRunId: '', segments: [r] }); continue }
        let task = byLogical.get(lr)
        if (!task) { task = { key: 'lr:' + lr, logicalRunId: lr, segments: [] }; byLogical.set(lr, task); tasks.push(task) }
        task.segments.push(r)
      }
      for (const task of tasks) {
        task.segments.sort((a, b) => (Number(a.segment) || 0) - (Number(b.segment) || 0) || ((a.startedAt || 0) - (b.startedAt || 0)))
        // 当前段：未被续跑接管的优先（正在跑的那一段）；都被接管时取段号最大的一段
        const live = task.segments.filter((s) => !s.supersededBy)
        const pool = live.length ? live : task.segments
        task.head = pool.reduce((best, s) => ((Number(s.segment) || 0) >= (Number(best.segment) || 0) ? s : best), pool[0])
        task.segmentCount = Math.max(task.segments.length, ...task.segments.map((s) => Number(s.segment_count) || 0))
      }
      return tasks
    }
    // 节点尝试索引：node → 按段号与完成时间升序（node_attempts 为宿主段末扫描的权威入档）
    function attemptsByNode(list) {
      const m = {}
      for (const a of list || []) {
        if (!a || !a.node) continue
        const k = String(a.node)
        if (!m[k]) m[k] = []
        m[k].push(a)
      }
      for (const k of Object.keys(m)) {
        m[k].sort((a, b) => (Number(a.segment) || 0) - (Number(b.segment) || 0) || ((a.completed_at || 0) - (b.completed_at || 0)))
      }
      return m
    }
    // 返工深度：同一节点被重复执行的最多次数减一
    function reworkCountOf(record) {
      const byNode = attemptsByNode(record && record.node_attempts)
      let max = 0
      for (const k of Object.keys(byNode)) max = Math.max(max, byNode[k].length)
      return max > 0 ? max - 1 : 0
    }
    function outcomeValuesOf(record) {
      const bo = (record && record.business_outcomes) || {}
      const set = new Set()
      for (const k of Object.keys(bo)) if (bo[k] && bo[k].outcome !== undefined && bo[k].outcome !== null) set.add(String(bo[k].outcome))
      return Array.from(set).sort()
    }
    // 退回类结果：蓝图里 countRound=true 的边（返工 / 补充回边）声明的 outcome
    function returnOutcomesOf(dsl) {
      const set = new Set()
      for (const e of ((dsl && dsl.edges) || [])) if (e && e.countRound === true && e.outcome) set.add(String(e.outcome))
      return set
    }
    function workspaceLabelOf(ws) {
      if (!ws) return ''
      const id = ws.workspace_id ? String(ws.workspace_id) : ''
      const p = ws.workspace_path ? String(ws.workspace_path) : (ws.source_path ? String(ws.source_path) : '')
      const base = p ? p.split('/').filter(Boolean).pop() : ''
      return id || base || (ws.mode ? String(ws.mode) : '')
    }
    // 决策包可选四项用 UNKNOWN 哨兵表达「显式未知」；界面必须本地化，不得显示英文哨兵
    function unknownText(v) {
      const s = v === undefined || v === null ? '' : String(v).trim()
      return (!s || s === HD_UNKNOWN) ? t('rdDecisionUnknown') : s
    }
    // attempt 记录按 attempt_id 取最新 Revision（running → completed / interrupted 同 id 递进）
    function latestAttemptBodies(records) {
      const byAttempt = new Map()
      for (const r of records || []) {
        const rid = String((r && r.record_id) || '')
        if (rid.indexOf('attempt:') !== 0) continue
        const v = r.body && r.body.value
        if (!v || !v.attempt_id) continue
        const cur = byAttempt.get(String(v.attempt_id))
        if (!cur || Number(r.record_revision || 0) >= Number(cur.record_revision || 0)) byAttempt.set(String(v.attempt_id), { record_id: rid, record_revision: Number(r.record_revision || 0), value: v, provenance: r.provenance || null })
      }
      return byAttempt
    }
    // node_result 记录按 record_id 取最新 Revision（旧 Revision 仍可查，列表只取用于展示的最新）
    function latestNodeResultBodies(records) {
      const byNode = new Map()
      for (const r of records || []) {
        const rid = String((r && r.record_id) || '')
        if (rid.indexOf('node:') !== 0) continue
        const cur = byNode.get(rid)
        if (!cur || Number(r.record_revision || 0) >= Number(cur.record_revision || 0)) byNode.set(rid, r)
      }
      return byNode
    }
    function tierBadgeOf(lifecycleState) {
      const s = String(lifecycleState || '')
      const color = s === 'COMPLETED' ? STATUS_COLOR.pass : s === 'RUNNING' ? STATUS_COLOR.running : (s === 'WAITING_HUMAN' || s === 'PAUSED' || s === 'BLOCKED') ? STATUS_COLOR.human : STATUS_COLOR.fail
      return h('span', { className: 'vwf-badge', style: { color: color } }, s || '—')
    }

    // 运行看板：列表视图（分组 / 四类筛选 / 分页 / 返回位置保留）+ 详情视图（唯一详情出口）
    function Dashboard(props) {
      const [runs, setRuns] = React.useState([])
      const [tplMap, setTplMap] = React.useState({})
      const [auto, setAuto] = React.useState(true)
      const [page, setPage] = React.useState(0)
      const [pageSize, setPageSize] = React.useState(10)
      const [view, setView] = React.useState('list')
      const [taskKey, setTaskKey] = React.useState('')
      const [runId, setRunId] = React.useState('')
      const [wsFilter, setWsFilter] = React.useState('all')
      const [bucketFilter, setBucketFilter] = React.useState('all')
      const [resultFilter, setResultFilter] = React.useState('all')
      const [completionFilter, setCompletionFilter] = React.useState('all')
      const [lrMap, setLrMap] = React.useState({})
      const [lrErr, setLrErr] = React.useState({})
      const [listErr, setListErr] = React.useState('')
      const [tick, setTick] = React.useState(0)
      const lrMapRef = React.useRef({})
      const inFlightRef = React.useRef(new Set())
      const listScrollRef = React.useRef(null)
      const savedScrollRef = React.useRef(0)
      React.useEffect(() => {
        host.call('vwf.workflows.list').then((l) => {
          const m = {}
          for (const w of l || []) m[w.id] = w.dsl || null
          setTplMap(m)
        }).catch(() => {})
      }, [])
      const refresh = React.useCallback(() => {
        host.call('vwf.runs.list').then((r) => { setRuns((r && r.runs) || []); setListErr('') }).catch((e) => setListErr(String((e && e.message) || e)))
        setTick((n) => n + 1)
      }, [])
      React.useEffect(() => {
        if (!auto) return undefined
        return ctx.interval(refresh, 3000)
      }, [auto, refresh])
      React.useEffect(() => { refresh() }, [])
      const allRuns = React.useMemo(() => {
        return [...runs].sort((a, b) => ((b.startedAt || b.ts || 0) - (a.startedAt || a.ts || 0)) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
      }, [runs])
      const tasks = React.useMemo(() => foldRunsIntoTasks(allRuns), [allRuns])
      const activeCount = allRuns.filter((r) => !r.supersededBy && isActiveRunStatus(r.status)).length
      // 人工门禁待处理项（一次裁决一张）：不再单独成卡，而是并入下面的分组列表——
      // 组内按「需处理 → 进行中 → 已完成」排序，行上保留裁决位次（V-3）。
      const gates = allRuns.filter((r) => !r.supersededBy && isAttentionStatus(r.status) && r.status !== 'PAUSED')
      // 页签计数与列表筛选同源（见 attentionTaskCount）
      const attentionCount = React.useMemo(() => attentionTaskCount(allRuns), [allRuns])
      React.useEffect(() => { if (props.onAttention) props.onAttention(attentionCount) }, [attentionCount])
      // 工作空间分组数据源：vwf.runs.list 摘要不含 workspace，按 logical_run_id 惰性补齐并缓存
      // （规格 §11 首选：客户端缓存 + 惰性补齐，不新增 RPC）。读取失败只标注该行未知，不冒充事实。
      const PREFETCH_LIMIT = 6
      React.useEffect(() => {
        let fired = 0
        for (const task of tasks) {
          if (fired >= PREFETCH_LIMIT) break
          const id = task.logicalRunId
          if (!id || lrMapRef.current[id] || lrErr[id] || inFlightRef.current.has(id)) continue
          inFlightRef.current.add(id)
          fired++
          host.call('vwf.logicalRuns.get', { logical_run_id: id }).then((r) => {
            inFlightRef.current.delete(id)
            if (r && r.found && r.record) {
              lrMapRef.current = Object.assign({}, lrMapRef.current, { [id]: r.record })
              setLrMap(lrMapRef.current)
            } else {
              setLrErr((m) => (m[id] ? m : Object.assign({}, m, { [id]: t('rdWsNoRecord') })))
            }
          }).catch((e) => {
            inFlightRef.current.delete(id)
            setLrErr((m) => (m[id] ? m : Object.assign({}, m, { [id]: String((e && e.message) || e) })))
          })
        }
      }, [tasks, lrMap, lrErr])
      const modelOf = React.useCallback((task) => {
        const head = task.head || {}
        const lr = task.logicalRunId ? lrMap[task.logicalRunId] : null
        const ws = lr && lr.workspace ? lr.workspace : null
        return {
          task,
          head,
          lr,
          ws,
          wsId: ws ? String(ws.workspace_id || '') : '',
          wsLabel: workspaceLabelOf(ws),
          wsPending: !!task.logicalRunId && !lr && !lrErr[task.logicalRunId],
          wsError: task.logicalRunId && !lr ? (lrErr[task.logicalRunId] || '') : '',
          rework: lr ? reworkCountOf(lr) : null,
          updatedAt: (lr && lr.updated_at) || head.startedAt || head.ts || 0,
          completionType: lr && lr.completion && lr.completion.type ? String(lr.completion.type) : '',
          outcomes: lr ? outcomeValuesOf(lr) : [],
          lifecycle: lr && lr.lifecycle ? String(lr.lifecycle.state || '') : '',
          bucket: runBucketOf(head.status),
        }
      }, [lrMap, lrErr])
      const models = React.useMemo(() => tasks.map(modelOf), [tasks, modelOf])
      // 空间筛选项：来自已补齐的工作空间（含未归属与未知两类显式项）
      const wsOptions = React.useMemo(() => {
        const seen = new Map()
        for (const m of models) if (m.wsId && !seen.has(m.wsId)) seen.set(m.wsId, m.wsLabel || m.wsId)
        return Array.from(seen.entries()).map(([id, label]) => ({ id, label })).sort((a, b) => (a.label < b.label ? -1 : 1))
      }, [models])
      const resultOptions = React.useMemo(() => {
        const set = new Set()
        for (const m of models) for (const o of m.outcomes) set.add(o)
        return Array.from(set).sort()
      }, [models])
      const completionOptions = React.useMemo(() => {
        const set = new Set()
        for (const m of models) if (m.completionType) set.add(m.completionType)
        return Array.from(set).sort()
      }, [models])
      const visible = models.filter((m) => {
        if (bucketFilter !== 'all' && m.bucket !== bucketFilter) return false
        if (resultFilter !== 'all' && !m.outcomes.includes(resultFilter)) return false
        if (completionFilter === '__none__') { if (m.completionType) return false } else if (completionFilter !== 'all' && m.completionType !== completionFilter) return false
        if (wsFilter === 'all') return true
        // 空间未补齐的行在补齐前不因空间筛选被静默隐藏（补齐后立即按真实空间归位）
        if (m.wsPending) return true
        if (m.task.logicalRunId && m.wsError) return wsFilter === '__unknown__'
        if (!m.task.logicalRunId) return wsFilter === '__none__'
        return wsFilter === '__unknown__' ? !m.wsId : m.wsId === wsFilter
      })
      // 分页：仅在筛选条件或每页条数变化时回到第 0 页；轮询导致列表长度变化时保留用户当前位置
      // （越界由 safePage 收敛，不会显示空页）
      React.useEffect(() => { setPage(0) }, [wsFilter, bucketFilter, resultFilter, completionFilter, pageSize])
      const totalPages = Math.max(1, Math.ceil(visible.length / pageSize))
      const safePage = Math.min(page, totalPages - 1)
      const pageModels = visible.slice(safePage * pageSize, safePage * pageSize + pageSize)
      // 待处理任务的队列位次（一次裁决一张）：按列表同一数据源折叠 Logical Run 后定位次，
      // 并入列表的行上仍然能看出「谁在裁决、谁在排队」。
      const gateIdx = React.useMemo(() => {
        const m = new Map()
        for (const r of allRuns) {
          if (r.supersededBy || !isAttentionStatus(r.status) || r.status === 'PAUSED') continue
          const key = r.logical_run_id || r.id
          if (!m.has(key)) m.set(key, m.size)
        }
        return m
      }, [allRuns])
      // 返回位置保留：详情在浮层里打开，列表没有卸载，筛选/分页/滚动本来就留在原处；
      // 这里只额外记住打开详情的那一行，关闭后把焦点还回去。
      const openDetail = (key, rowEl) => {
        const el = listScrollRef.current
        savedScrollRef.current = el ? el.scrollTop : 0
        detailReturnRef.current = rowEl || null
        setTaskKey(key)
        setView('detail')
      }
      React.useEffect(() => {
        if (view !== 'list') return
        const el = listScrollRef.current
        if (el) el.scrollTop = savedScrollRef.current
      }, [view, safePage])
      const openByRunId = () => {
        const id = String(runId || '').trim()
        if (!id) return
        const hit = tasks.find((task) => task.segments.some((s) => String(s.id) === id))
        if (hit) { openDetail(hit.key); return }
        const lrHit = tasks.find((task) => task.logicalRunId === id)
        if (lrHit) openDetail(lrHit.key)
      }
      // V-4：详情在与模板编辑同级的大工作区层里打开（原生 top-layer dialog）。
      // 列表留在下层继续挂载——关闭详情就回到原来的筛选、分页与滚动位置，
      // 不需要另存状态再还原；焦点回收到打开它的那一行。
      const detailTask = view === 'detail' ? (tasks.find((x) => x.key === taskKey) || null) : null
      const detailOpen = !!detailTask
      const detailDialogRef = React.useRef(null)
      const detailReturnRef = React.useRef(null)
      React.useEffect(() => {
        const dialog = detailDialogRef.current
        if (!dialog) return undefined
        try {
          if (detailOpen && !dialog.open && typeof dialog.showModal === 'function') dialog.showModal()
        } catch (e) { /* 无 showModal 的对照环境由样式层兜底 */ }
        // 卸载 / 关闭时由 cleanup 收掉：节点被 React 摘掉后再读 ref 已经拿不到对话框，
        // 不在这里关就会留下一个仍带 open 的游离 dialog。
        return () => { try { if (dialog.open && typeof dialog.close === 'function') dialog.close() } catch (e) { /* 同上 */ } }
      }, [detailOpen])
      React.useEffect(() => {
        if (detailOpen) return
        const el = detailReturnRef.current
        detailReturnRef.current = null
        if (el && el.isConnected && el.focus) el.focus()
      }, [detailOpen])
      return h('div', { className: 'vwf-root' },
        activeCount >= 2 ? h('div', { className: 'vwf-code', style: { borderColor: STATUS_COLOR.human, marginBottom: 8 } },
          t('dashParallel', { n: activeCount })) : null,
        listErr ? h('div', { className: 'vwf-err-line' }, t('dashIntegrityFailed', { err: listErr })) : null,
        h('div', { className: 'vwf-card', style: { marginBottom: 8 } },
          h('div', { className: 'vwf-card-head' },
            h('div', { className: 'vwf-card-title' }, t('dashRunList')),
            h('div', { className: 'vwf-row', style: { gap: 8 } },
              h('span', { className: 'vwf-muted-sm' }, t('dashTaskCount', { n: visible.length })),
              h('label', { className: 'vwf-row', style: { fontSize: 11 } },
                h('input', { type: 'checkbox', checked: auto, onChange: (ev) => setAuto(ev.target.checked) }),
                ' ' + t('dashAutoPoll')
              )
            )
          ),
          h('div', { className: 'vwf-filters' },
            h('label', { className: 'vwf-filter' },
              h('span', { className: 'vwf-muted-sm' }, t('dashWsFilterLabel')),
              h('select', { className: 'vwf-input', value: wsFilter, onChange: (ev) => setWsFilter(ev.target.value) },
                [h('option', { key: 'all', value: 'all' }, t('dashWsAll', { n: wsOptions.length }))]
                  .concat(wsOptions.map((o) => h('option', { key: o.id, value: o.id }, o.label)))
                  .concat([h('option', { key: '__none__', value: '__none__' }, t('dashWsUngrouped')), h('option', { key: '__unknown__', value: '__unknown__' }, t('dashWsUnknown'))])
              )
            ),
            h('label', { className: 'vwf-filter' },
              h('span', { className: 'vwf-muted-sm' }, t('dashStatus')),
              h('select', { className: 'vwf-input', value: bucketFilter, onChange: (ev) => setBucketFilter(ev.target.value) },
                [['all', t('dashFilterAll')], ['attention', t('dashFilterAttention')], ['running', t('dashFilterRunning')], ['done', t('dashFilterDone')], ['ended', t('dashFilterEnded')]]
                  .map(([v, l]) => h('option', { key: v, value: v }, l))
              )
            ),
            h('label', { className: 'vwf-filter' },
              h('span', { className: 'vwf-muted-sm' }, t('dashResultFilterLabel')),
              h('select', { className: 'vwf-input', value: resultFilter, onChange: (ev) => setResultFilter(ev.target.value) },
                [h('option', { key: 'all', value: 'all' }, t('dashResultAll'))].concat(resultOptions.map((o) => h('option', { key: o, value: o }, o)))
              )
            ),
            h('label', { className: 'vwf-filter' },
              h('span', { className: 'vwf-muted-sm' }, t('dashCompletionFilterLabel')),
              h('select', { className: 'vwf-input', value: completionFilter, onChange: (ev) => setCompletionFilter(ev.target.value) },
                [h('option', { key: 'all', value: 'all' }, t('dashCompletionAll'))]
                  .concat(completionOptions.map((o) => h('option', { key: o, value: o }, o)))
                  .concat([h('option', { key: '__none__', value: '__none__' }, t('dashCompletionNone'))])
              )
            )
          ),
          h('div', { className: 'vwf-run-list', ref: listScrollRef },
            pageModels.length ? groupTaskRows(pageModels, openDetail, gateIdx) : h('div', { className: 'vwf-empty' }, t('dashNoMatch'))
          ),
          h('div', { className: 'vwf-muted-sm', style: { padding: '6px 14px 0' } }, t('dashSupersededFolded')),
          h('div', { className: 'vwf-row', style: { marginTop: 8, padding: '0 14px 12px', flexWrap: 'wrap', gap: 8, alignItems: 'center' } },
            h('span', { className: 'vwf-muted-sm' }, t('dashPage', { page: safePage + 1, total: totalPages, n: visible.length })),
            h('button', { className: 'vwf-btn sm', disabled: safePage === 0, onClick: () => setPage((p) => Math.max(0, p - 1)) }, t('dashPrev')),
            h('button', { className: 'vwf-btn sm', disabled: safePage >= totalPages - 1, onClick: () => setPage((p) => Math.min(totalPages - 1, p + 1)) }, t('dashNext')),
            h('span', { className: 'vwf-muted-sm' }, t('dashPerPage')),
            h('select', { className: 'vwf-input', style: { width: 70 }, value: pageSize, onChange: (ev) => setPageSize(Number(ev.target.value)) },
              [10, 20, 50, 100].map((n) => h('option', { key: n, value: n }, String(n)))
            )
          )
        ),
        h('div', { className: 'vwf-card', style: { marginBottom: 8, padding: '10px 14px' } },
          h('div', { className: 'vwf-card-title' }, t('runMode')),
          h('div', { className: 'vwf-muted', style: { marginTop: 4 } }, t('runModePrimary')),
          h('div', { className: 'vwf-muted', style: { marginTop: 2 } }, t('runModeEnhanced'))
        ),
        h('div', { className: 'vwf-row' },
          h('input', { className: 'vwf-input', style: { flex: 1 }, placeholder: t('dashRunIdPlaceholder'), value: runId, onChange: (ev) => setRunId(ev.target.value) }),
          h('button', { className: 'vwf-btn', onClick: openByRunId }, t('dashDetails')),
          h('button', { className: 'vwf-btn', onClick: refresh }, t('refresh'))
        ),
        // 任务在刷新后消失（记录被清理）时不渲染假详情，回列表
        detailTask ? h('dialog', {
          className: 'vwf-editor-dialog',
          ref: detailDialogRef,
          'aria-label': t('dashRunDetailTitle', { id: detailTask.head.taskId || detailTask.head.id }),
          onClick: (ev) => { if (ev.target === ev.currentTarget) setView('list') },
          onCancel: (ev) => { ev.preventDefault(); setView('list') },
          onClose: () => { if (view === 'detail') setView('list') },
        },
          h('div', { className: 'vwf-editor-head' },
            h('strong', null, detailTask.head.taskId || detailTask.head.id),
            statusBadge(detailTask.head.status),
            h('span', { className: 'vwf-muted-sm' }, t('dashListRestored')),
            h('span', { className: 'vwf-spacer' }),
            h('button', { className: 'vwf-btn sm', onClick: () => setView('list') }, t('dashBackToList'))
          ),
          h('div', { className: 'vwf-editor-body' },
            h('div', { className: 'vwf-rd-scroll' },
              h(RunDetail, {
                key: detailTask.key,
                task: detailTask,
                tplMap,
                lrInitial: detailTask.logicalRunId ? lrMap[detailTask.logicalRunId] : null,
                lrError: detailTask.logicalRunId ? (lrErr[detailTask.logicalRunId] || '') : '',
                tick,
                onRefresh: refresh,
              })
            )
          )
        ) : null
      )
    }

    // 列表分组渲染：按工作空间分组，组标题带条目数；组内按「需处理 → 进行中 → 已完成」排序
    // （V-3，同档保持原来的时间倒序——sort 稳定）；行只显示任务级摘要，详情一律经唯一出口。
    // gateIdx：待处理任务在人工门禁队列中的位次（一次裁决一张），并入列表后仍在行上可见。
    function groupTaskRows(models, openDetail, gateIdx) {
      const order = []
      const byWs = new Map()
      for (const m of models) {
        const key = m.wsPending ? '__pending__' : (!m.task.logicalRunId ? '__none__' : (m.wsError ? '__unknown__' : (m.wsId || '__unknown__')))
        if (!byWs.has(key)) { byWs.set(key, []); order.push(key) }
        byWs.get(key).push(m)
      }
      const labelOf = (key) => {
        if (key === '__pending__') return t('dashWsLoading')
        if (key === '__none__') return t('dashWsUngrouped')
        if (key === '__unknown__') return t('dashWsUnknown')
        const hit = models.find((m) => m.wsId === key)
        return (hit && hit.wsLabel) || key
      }
      return order.map((key) => h('section', { key: key, className: 'vwf-run-group', 'aria-label': labelOf(key) },
        h('h3', { className: 'vwf-run-group-head' },
          h('span', null, labelOf(key)),
          h('span', { className: 'vwf-badge' }, String(byWs.get(key).length))
        ),
        byWs.get(key).slice().sort((a, b) => runOrderOf(a.bucket) - runOrderOf(b.bucket)).map((m) => {
          const gi = m.task.logicalRunId ? (gateIdx || new Map()).get(m.task.logicalRunId) : undefined
          return h('button', {
            key: m.task.key,
            className: 'vwf-run-row',
            onClick: (ev) => openDetail(m.task.key, ev.currentTarget),
            'aria-label': (m.head.taskId || m.head.id) + ' ' + t('dashDetails'),
          },
            h('div', { className: 'vwf-row', style: { justifyContent: 'space-between' } },
              h('strong', null, m.head.taskId || m.head.id),
              h('div', { className: 'vwf-row', style: { gap: 6 } },
                // 人工门禁位次（一次裁决一张）：并入列表后不丢这条信息
                gi === undefined ? null : h('span', { className: 'vwf-badge accent' }, gi === 0 ? t('dashDeciding') : t('dashQueued', { n: gi + 1 })),
                statusBadge(m.head.status)
              )
            ),
          h('p', { className: 'vwf-run-row-note' }, m.lr && m.lr.title ? String(m.lr.title) : (m.head.name || m.head.workflowId || '—')),
          h('div', { className: 'vwf-row', style: { justifyContent: 'space-between' } },
            h('small', null, (m.head.name || m.head.workflowId || '—') + ' · ' + (m.rework === null ? t('dashRuntimeLabel') : (m.rework > 0 ? t('dashReworkCount', { n: m.rework }) : t('dashFirstRun')))),
            h('small', null, m.task.segmentCount > 1 ? t('dashSegment', { n: (m.head.segment || m.task.segmentCount), total: m.task.segmentCount }) + ' · ' : '')
          ),
          h('div', { className: 'vwf-row', style: { justifyContent: 'space-between' } },
            h('small', { className: 'vwf-muted-sm' }, t('dashUpdatedAt', { at: fmtAt(m.updatedAt) })),
            h('small', { className: 'vwf-muted-sm' }, m.completionType ? m.completionType : '')
          ),
          m.wsError ? h('small', { className: 'vwf-muted-sm' }, t('dashIntegrityLabel') + '：' + m.wsError) : null
          )
        })
      ))
    }

    // ── Logical Run 详情工作区（唯一选中节点结果出口）────────────────────────
    // 左侧运行定位 + 节点目录用于定位；正文只展示一个选中节点，结果 / 检查 / 活动页签切换。
    function RunDetail(props) {
      const task = props.task
      const tplMap = props.tplMap || {}
      const head = task.head || {}
      const lrId = task.logicalRunId
      const [lr, setLr] = React.useState(props.lrInitial || null)
      const [lrError, setLrError] = React.useState(props.lrError || '')
      const [recs, setRecs] = React.useState(null)
      const [recErr, setRecErr] = React.useState('')
      const [snap, setSnap] = React.useState(null)
      const [selNode, setSelNode] = React.useState('')
      const [tab, setTab] = React.useState('result')
      const [attemptSel, setAttemptSel] = React.useState({})
      const [wsTick, setWsTick] = React.useState(0)
      const [providers, setProviders] = React.useState(null)
      const [modelDraft, setModelDraft] = React.useState({})
      const [decisionChoice, setDecisionChoice] = React.useState('')
      const [decisionReason, setDecisionReason] = React.useState('')
      const [guidanceText, setGuidanceText] = React.useState('')
      const [guidanceMsg, setGuidanceMsg] = React.useState('')
      const [controlErr, setControlErr] = React.useState('')
      const fetchLr = React.useCallback(() => {
        if (!lrId) return
        host.call('vwf.logicalRuns.get', { logical_run_id: lrId }).then((r) => {
          if (r && r.found && r.record) { setLr(r.record); setLrError('') } else setLrError(t('rdWsNoRecord'))
        }).catch((e) => setLrError(String((e && e.message) || e)))
      }, [lrId, wsTick])
      const fetchRecords = React.useCallback(() => {
        if (!lrId) return
        host.call('vwf.records.list', { logical_run_id: lrId }).then((r) => {
          if (r && r.ok) { setRecs(r); setRecErr('') } else setRecErr(String((r && r.error) || 'unavailable'))
        }).catch((e) => setRecErr(String((e && e.message) || e)))
      }, [lrId, wsTick])
      React.useEffect(() => { fetchLr() }, [fetchLr, props.tick])
      React.useEffect(() => { fetchRecords() }, [fetchRecords, props.tick])
      React.useEffect(() => {
        if (!head.id) return
        host.call('vwf.state', { runId: head.id }).then((r) => setSnap(r && r.found ? r : null)).catch(() => {})
      }, [head.id, props.tick])
      React.useEffect(() => {
        host.call('vwf.models', {}).then((r) => setProviders((r && r.providers) || [])).catch(() => setProviders([]))
      }, [])
      const snapState = snap && snap.found ? snap.state : null
      const dsl = (lr && lr.snapshots && lr.snapshots.length ? (lr.snapshots[lr.snapshots.length - 1].workflow || {}).dsl : null) || tplMap[head.workflowId] || null
      const st = snapState && dsl ? mapStatus(snapState, dsl) : {}
      const activeSeg = lr ? Math.max(1, ...((lr.segments || []).map((s) => Number(s.index) || 0).concat([1]))) : 1
      const attempts = React.useMemo(() => latestAttemptBodies(recs && recs.records), [recs])
      const nodeResults = React.useMemo(() => latestNodeResultBodies(recs && recs.records), [recs])
      const byNode = React.useMemo(() => attemptsByNode(lr && lr.node_attempts), [lr])
      // 目录：DSL 节点 + 该节点的逻辑尝试（kind=logical，排除 fanout 子项）
      const logicalAttemptsOf = React.useCallback((nodeId) => {
        const out = []
        for (const a of attempts.values()) {
          const v = a.value
          if (!v || String(v.node) !== String(nodeId) || v.kind === 'item') continue
          out.push(a)
        }
        out.sort((x, y) => (Number(x.value.segment) || 0) - (Number(y.value.segment) || 0) || (new Date(x.value.ended_at || x.value.started_at || 0) - new Date(y.value.ended_at || y.value.started_at || 0)))
        return out
      }, [attempts])
      const itemsOf = React.useCallback((nodeId) => {
        const out = []
        for (const a of attempts.values()) {
          const v = a.value
          if (!v || String(v.node) !== String(nodeId) || v.kind !== 'item') continue
          out.push(a)
        }
        out.sort((x, y) => (Number(x.value.item_index) || 0) - (Number(y.value.item_index) || 0) || (Number(x.value.segment) || 0) - (Number(y.value.segment) || 0))
        return out
      }, [attempts])
      const nodes = (dsl && dsl.nodes) || []
      const phaseNodeId = snapState && snapState.phase && dsl ? nodeIdForLabel(snapState.phase, dsl) : null
      const effectiveSel = selNode || phaseNodeId || (nodes[0] ? nodes[0].id : '')
      const selected = nodes.find((n) => n.id === effectiveSel) || null
      const selectedAttempts = selected ? logicalAttemptsOf(selected.id) : []
      const latestIdx = selectedAttempts.length
      const pickedIdx = selected && attemptSel[selected.id] ? Math.min(attemptSel[selected.id], latestIdx) : latestIdx
      const picked = pickedIdx > 0 ? selectedAttempts[pickedIdx - 1] : null
      const pickedValue = picked ? picked.value : null
      // 「上一轮成果」：该节点最新尝试所在段早于当前生效段 → 显示的是返工前的成果
      const nodeLatestSegment = (nodeId) => {
        const list = logicalAttemptsOf(nodeId)
        let max = 0
        for (const a of list) max = Math.max(max, Number(a.value.segment) || 0)
        return max
      }
      const isPrevRound = selected ? (nodeLatestSegment(selected.id) > 0 && nodeLatestSegment(selected.id) < activeSeg) : false
      const historical = selected ? (pickedIdx > 0 && pickedIdx < latestIdx) : false
      const returnOutcomes = returnOutcomesOf(dsl)
      // 退回意见跟随触发它的审查轮次：从该段记录里找产出退回类 outcome 的节点
      const returnsFor = (segment) => {
        const out = []
        for (const a of attempts.values()) {
          const v = a.value
          if (!v || v.kind === 'item') continue
          if ((Number(v.segment) || 0) !== Number(segment)) continue
          if (v.outcome === undefined || v.outcome === null) continue
          if (!returnOutcomes.has(String(v.outcome))) continue
          out.push({ node: String(v.node), outcome: String(v.outcome), segment: Number(v.segment) || 0, round: Number(v.round) || 0, result: v.result, at: v.ended_at || v.started_at || null })
        }
        return out.sort((a, b) => (a.round - b.round) || ((Number(a.segment) || 0) - (Number(b.segment) || 0)))
      }
      const nodeResultBody = (nodeId) => {
        const rec = nodeResults.get('node:' + lrId + ':' + nodeId)
        return rec && rec.body ? rec.body.value : null
      }
      const nodeResolvedInputs = (nodeId) => {
        const rec = nodeResults.get('node:' + lrId + ':' + nodeId)
        if (!rec) return []
        // 输入清单的权威位置是 provenance.resolved_inputs_snapshot（scripts/revision-dependencies.mjs
        // 经 buildRecordDependencies 写入）；兼容少数直接带顶层 resolved_inputs 的记录形状。
        const snap = (rec.provenance && rec.provenance.resolved_inputs_snapshot) || rec.resolved_inputs || null
        const items = snap && snap.items
        return Array.isArray(items) ? items : []
      }
      const sendControl = (action, extra) => {
        if (!lrId) return
        if (action === 'interrupt' && !window.confirm(t('ctlConfirmInterrupt'))) return
        setControlErr('')
        host.call('vwf.run.control', Object.assign({ action, logical_run_id: lrId }, extra || {})).then((r) => {
          if (r && r.ok) { if (extra && extra.text) { setGuidanceText(''); setGuidanceMsg(t('rdControlGuidance') + ' ✓') } fetchLr(); props.onRefresh && props.onRefresh() }
          else setControlErr(String((r && r.error) || 'control failed'))
        }).catch((e) => setControlErr(String((e && e.message) || e)))
      }
      const terminal = !!(lr && (lr.terminal === true || ['COMPLETED', 'STOPPED', 'FAILED'].indexOf(String(lr.lifecycle && lr.lifecycle.state)) >= 0))
      // 决策包与受阻现场：来自 vwf.state（宿主权威运行记录）
      const pkg = snapState && snapState.decision_package && typeof snapState.decision_package === 'object' ? snapState.decision_package : null
      const decisionId = snapState ? String(snapState.decision_id || '') : ''
      const consumed = lr && lr.consumed_decisions && decisionId ? lr.consumed_decisions[decisionId] : null
      const blockedEdge = snapState ? snapState.blocked_edge : null
      const lrWorkflow = lr && lr.snapshots && lr.snapshots.length ? lr.snapshots[lr.snapshots.length - 1] : null
      const lrProviderModel = (lrWorkflow && lrWorkflow.provider_model) || {}
      const mappingRows = (rows) => h('table', { className: 'vwf-table' },
        h('thead', null, h('tr', null, h('th', null, t('dashColNode')), h('th', null, t('rdBlockedPrevValue')))),
        h('tbody', null, rows.map((r) => h('tr', { key: r.k }, h('td', null, r.k), h('td', null, r.v))))
      )
      return h('div', { className: 'vwf-root' },
        // 返回列表与位置提示在承载本详情的工作区标题栏上（V-4），正文只保留刷新
        h('div', { className: 'vwf-row', style: { justifyContent: 'flex-end' } },
          h('button', { className: 'vwf-btn sm', onClick: () => { setWsTick((n) => n + 1) } }, t('refresh'))
        ),
        lrError ? h('div', { className: 'vwf-err-line' }, t('dashIntegrityFailed', { err: lrError })) : null,
        recErr ? h('div', { className: 'vwf-note warn' }, t('rdRecordsUnavailable')) : null,
        controlErr ? h('div', { className: 'vwf-err-line' }, controlErr) : null,
        h('div', { className: 'vwf-rd-main' },
          // 左栏：运行定位（工作空间 / 模板 / 当前阶段 / 状态）+ 节点目录（只用于定位）
          h('div', { className: 'vwf-rd-side' },
            h('div', { className: 'vwf-card', style: { padding: '10px 12px' } },
              h('div', { className: 'vwf-card-title' }, t('rdLocator')),
              h('div', { className: 'vwf-rd-kv' }, h('span', { className: 'vwf-muted-sm' }, t('rdWorkspaceLabel', { ws: (lr && lr.workspace && workspaceLabelOf(lr.workspace)) || '—' }))),
              h('div', { className: 'vwf-rd-kv' }, h('span', { className: 'vwf-muted-sm' }, t('rdTemplateLabel') + '：' + (head.name || head.workflowId || '—'))),
              h('div', { className: 'vwf-rd-kv' }, h('span', { className: 'vwf-muted-sm' }, t('dashPhaseLabel', { phase: snapState ? (snapState.phase || '—') : '—' }))),
              h('div', { className: 'vwf-rd-kv' }, h('span', { className: 'vwf-muted-sm' }, t('dashTaskIdLabel', { taskId: head.taskId || '—' }))),
              h('div', { className: 'vwf-rd-kv vwf-row', style: { gap: 6 } }, h('span', { className: 'vwf-muted-sm' }, t('rdLifecycleLabel')), tierBadgeOf(lr && lr.lifecycle ? lr.lifecycle.state : '')),
              h('div', { className: 'vwf-rd-kv' }, h('span', { className: 'vwf-muted-sm' }, t('rdCompletionLabel') + '：' + (lr && lr.completion && lr.completion.type ? String(lr.completion.type) : t('dashCompletionNone')))),
              h('div', { className: 'vwf-rd-kv' }, h('span', { className: 'vwf-muted-sm' }, t('rdReworkLabel') + '：' + (lr ? (reworkCountOf(lr) > 0 ? t('dashReworkCount', { n: reworkCountOf(lr) }) : t('dashFirstRun')) : '—')))
            ),
            h('div', { className: 'vwf-card', style: { padding: '10px 12px' } },
              h('div', { className: 'vwf-card-title' }, t('rdNodeDirectory')),
              nodes.length ? nodes.map((n) => {
                const list = logicalAttemptsOf(n.id)
                const seg = nodeLatestSegment(n.id)
                const prev = seg > 0 && seg < activeSeg
                return h('button', {
                  key: n.id,
                  className: 'vwf-node-dir-row' + (n.id === effectiveSel ? ' selected' : ''),
                  onClick: () => { setSelNode(n.id); setTab('result') },
                },
                  h('span', { className: 'vwf-node-dir-label' }, n.label || n.id),
                  h('span', { className: 'vwf-row', style: { gap: 4 } },
                    list.length ? h('span', { className: 'vwf-badge' }, t('rdAttemptPicker') + ' ' + list.length) : null,
                    prev ? h('span', { className: 'vwf-badge', style: { color: STATUS_COLOR.human } }, t('rdPrevRoundArtifact')) : null,
                    st[n.id] ? h('span', { className: 'vwf-badge', style: { color: st[n.id] === 'pass' ? STATUS_COLOR.pass : st[n.id] === 'fail' ? STATUS_COLOR.fail : STATUS_COLOR.running } }, st[n.id]) : null,
                    n.id === phaseNodeId ? h('span', { className: 'vwf-badge accent' }, t('rdCurrentNode')) : null
                  )
                )
              }) : h('div', { className: 'vwf-muted-sm' }, t('rdNoRecords'))
            )
          ),
          // 右栏：唯一选中节点详情出口
          h('div', { className: 'vwf-rd-body' },
            selected ? h('div', { className: 'vwf-card', style: { padding: '10px 12px' } },
              h('div', { className: 'vwf-row', style: { justifyContent: 'space-between', flexWrap: 'wrap' } },
                h('div', { className: 'vwf-row', style: { gap: 6 } },
                  h('span', { className: 'vwf-badge ' + (historical || isPrevRound ? 'accent' : '') }, historical || isPrevRound ? t('rdHistorical') : t('rdCurrentResult')),
                  isPrevRound ? h('span', { className: 'vwf-badge', style: { color: STATUS_COLOR.human } }, t('rdPrevRoundArtifact')) : null
                ),
                h('span', { className: 'vwf-muted-sm' }, (lr && lr.title ? String(lr.title) : (head.taskId || head.id)))
              ),
              h('div', { className: 'vwf-card-title', style: { marginTop: 6 } }, selected.label || selected.id),
              selectedAttempts.length ? h('label', { className: 'vwf-row', style: { gap: 8, marginTop: 6 } },
                h('span', { className: 'vwf-muted-sm' }, t('rdAttemptPicker')),
                h('select', {
                  className: 'vwf-input', style: { maxWidth: 320 },
                  value: String(pickedIdx),
                  onChange: (ev) => setAttemptSel(Object.assign({}, attemptSel, { [selected.id]: Number(ev.target.value) })),
                }, selectedAttempts.map((a, i) => {
                  const v = a.value
                  const label = t('rdAttemptOption', { n: i + 1, state: v.status === 'failed' ? t('rdAttemptReturned') : (v.status === 'completed' ? (i + 1 < selectedAttempts.length ? t('rdAttemptReturned') : t('rdAttemptPassed')) : t('rdAttemptRunning')) }) + (i + 1 === selectedAttempts.length ? t('rdAttemptLatest') : '')
                  return h('option', { key: v.attempt_id, value: String(i + 1) }, label)
                }))
              ) : h('div', { className: 'vwf-muted-sm', style: { marginTop: 6 } }, t('rdNotStarted') + '：' + t('rdNotStartedNote')),
              pickedValue ? h('div', { className: 'vwf-muted-sm', style: { marginTop: 4 } },
                t('rdAttemptMeta', { segment: pickedValue.segment, revision: pickedValue.snapshot_revision, provider: pickedValue.provider, model: pickedValue.model })
                + (pickedValue.ended_at ? ' · ' + t('rdAttemptAt', { at: fmtAt(Date.parse(pickedValue.ended_at)) }) : '')
              ) : null,
              isPrevRound ? h('div', { className: 'vwf-note warn' }, t('rdPrevRoundNote')) : null,
              // 三页签：同一区域内切换，页面不同时重复展示同一节点详情
              h('div', { className: 'vwf-tabs', style: { marginTop: 8 }, role: 'tablist' },
                [['result', t('rdTabResult')], ['checks', t('rdTabChecks')], ['activity', t('rdTabActivity')]].map(([k, l]) =>
                  h('button', {
                    key: k, role: 'tab', 'aria-selected': tab === k ? 'true' : 'false',
                    className: 'vwf-tab' + (tab === k ? ' on' : ''),
                    onClick: () => setTab(k),
                  }, l))
              ),
              tab === 'result' ? renderResultTab() : tab === 'checks' ? renderChecksTab() : renderActivityTab()
            ) : h('div', { className: 'vwf-empty' }, t('rdSelectNodeHint'))
          )
        ),
        renderControlCard(),
        renderPausedCard(),
        renderDecisionCard(),
        renderRecoveryCard(),
        renderSegmentsCard(),
        renderSnapshotsCard(),
        renderCanvasCard(),
        renderAgentsCard(),
        renderArtifactsCard(),
        renderWorkspaceCard()
      )

      // 结果页签：本次执行的成果（含扇出子任务独立结果与汇总输入来源）
      function renderResultTab() {
        const rt = []
        if (!picked && isPrevRound) {
          rt.push(h('div', { className: 'vwf-note warn', key: 'prev' }, t('rdPrevRoundNote')))
        }
        if (recErr) rt.push(h('div', { className: 'vwf-note warn', key: 'rec' }, t('rdNoRecords')))
        // 成果必须跟随所选 attempt：attempt 记录自带该次结果（与 node_result 同源）。
        // node_result 是「最新 Revision」语义，因此只在所选就是最新一次时才回退到它——
        // 历史执行没有正文时如实显示「暂无成果」，不冒充最新一轮成果。
        const isLatestPick = pickedIdx === latestIdx
        const bodyValue = isLatestPick ? nodeResultBody(selected.id) : null
        const showValue = pickedValue && pickedValue.result !== undefined
          ? pickedValue.result
          : (bodyValue !== null && bodyValue !== undefined ? bodyValue : null)
        if (showValue !== null && showValue !== undefined) {
          rt.push(h('div', { key: 'body' },
            h('div', { className: 'vwf-sec' }, t('rdTabResult')),
            h('div', { className: 'vwf-code' }, typeof showValue === 'string' ? showValue : safeJson(showValue))
          ))
        } else if (pickedValue) {
          rt.push(h('div', { className: 'vwf-note', key: 'nobody' }, t('rdNoRecords')))
        }
        if (pickedValue && pickedValue.outcome !== undefined && pickedValue.outcome !== null) {
          rt.push(h('div', { className: 'vwf-row', key: 'oc', style: { gap: 6, marginTop: 6 } },
            h('span', { className: 'vwf-badge accent' }, String(pickedValue.outcome)),
            h('span', { className: 'vwf-muted-sm' }, pickedValue.outcome_path ? t('rdOutcomePath', { path: pickedValue.outcome_path }) : '')
          ))
        } else if (selected && pickedValue) {
          rt.push(h('div', { className: 'vwf-muted-sm', key: 'oc0', style: { marginTop: 6 } }, t('rdBusinessOutcomeNone')))
        }
        // 扇出：并行组子任务各自独立结果 + 汇总输入来源；部分未完成时不冒充完成
        if (selected && selected.kind === 'fanout') {
          const items = itemsOf(selected.id)
          rt.push(h('div', { key: 'fanout' },
            h('div', { className: 'vwf-sec' }, t('rdFanoutGroup', { n: items.length || (Array.isArray(selected.items) ? selected.items.length : 0) })),
            h('div', { className: 'vwf-muted-sm' }, t('rdFanoutIndependent')),
            items.length ? items.map((a) => {
              const v = a.value
              const done = v.status === 'completed'
              return h('div', { key: v.attempt_id, className: 'vwf-fanout-item' },
                h('div', { className: 'vwf-row', style: { justifyContent: 'space-between' } },
                  h('strong', null, t('rdFanoutChild', { n: (Number(v.item_index) || 0) + 1 }) + (v.item ? ' · ' + String(v.item).slice(0, 80) : '')),
                  h('span', { className: 'vwf-badge', style: { color: done ? STATUS_COLOR.pass : v.status === 'failed' ? STATUS_COLOR.fail : STATUS_COLOR.running } }, done ? t('rdAttemptPassed') : (v.status === 'failed' ? t('rdAttemptReturned') : t('rdFanoutIncomplete')))
                ),
                h('div', { className: 'vwf-muted-sm' }, t('rdAttemptMeta', { segment: v.segment, revision: v.snapshot_revision, provider: v.provider, model: v.model })),
                v.result !== undefined && v.result !== null ? h('div', { className: 'vwf-code', style: { marginTop: 4 } }, typeof v.result === 'string' ? v.result : safeJson(v.result)) : null,
                v.error ? h('div', { className: 'vwf-note warn' }, String(v.error)) : null
              )
            }) : h('div', { className: 'vwf-muted-sm' }, t('rdFanoutNoSub')),
            (() => {
              const pending = items.filter((a) => a.value.status !== 'completed')
              const expected = Array.isArray(selected.items) ? selected.items.length : items.length
              const unfinished = Math.max(pending.length, Math.max(0, expected - items.length))
              return unfinished > 0
                ? h('div', { className: 'vwf-note warn' }, t('rdFanoutWaiting', { n: unfinished }) + ' ' + t('rdFanoutWaitingNote'))
                : (expected > 0 ? h('div', { className: 'vwf-note' }, t('rdFanoutWaitingNote')) : null)
            })()
          ))
        }
        // 汇总输入来源：node_result 的 resolved_inputs（LOC-034 依赖链）
        const inputs = nodeResolvedInputs(selected.id)
        if (inputs.length) {
          rt.push(h('div', { key: 'inputs' },
            h('div', { className: 'vwf-sec' }, t('rdFanoutSynth')),
            h('div', { className: 'vwf-row', style: { gap: 6 } },
              inputs.map((it, i) => h('span', { key: i, className: 'vwf-badge' }, t('rdFanoutInputFrom', { producer: String(it.producer || it.binding || '—') })))
            )
          ))
        }
        return h('div', { className: 'vwf-tab-panel' }, rt)
      }

      // 检查页签：本次执行的检查结论与退回意见（意见跟随触发它的审查轮次）
      function renderChecksTab() {
        const rt = []
        if (!picked) return h('div', { className: 'vwf-tab-panel' }, h('div', { className: 'vwf-muted-sm' }, t('rdNodeNotRun')))
        const seg = Number(pickedValue.segment) || 0
        const returns = returnsFor(seg)
        rt.push(h('div', { key: 'head', className: 'vwf-sec' }, t('rdAttemptPicker') + ' ' + pickedIdx + ' · ' + t('rdSegmentLabel', { n: seg })))
        rt.push(h('div', { key: 'meta', className: 'vwf-muted-sm' },
          t('rdAttemptMeta', { segment: pickedValue.segment, revision: pickedValue.snapshot_revision, provider: pickedValue.provider, model: pickedValue.model })))
        rt.push(h('div', { key: 'own', className: 'vwf-row', style: { gap: 6, marginTop: 6 } },
          h('span', { className: 'vwf-muted-sm' }, t('dashColResult') + '：'),
          pickedValue.outcome !== undefined && pickedValue.outcome !== null
            ? h('span', { className: 'vwf-badge accent' }, String(pickedValue.outcome))
            : h('span', { className: 'vwf-muted-sm' }, t('rdBusinessOutcomeNone'))
        ))
        if (returns.length) {
          for (const r of returns) {
            rt.push(h('div', { key: 'ret-' + r.node + '-' + r.round + '-' + r.segment },
              h('div', { className: 'vwf-sec' }, t('rdReturnComments') + ' · ' + t('rdReturnFromRound', { n: r.round || r.segment })),
              h('div', { className: 'vwf-note warn' }, t('rdReturnFromRound', { n: r.round || r.segment }) + '：' + String(r.node) + ' → ' + String(r.outcome)),
              r.result !== undefined && r.result !== null ? h('div', { className: 'vwf-code' }, typeof r.result === 'string' ? r.result : safeJson(r.result)) : null,
              h('div', { className: 'vwf-muted-sm' }, t('rdAfterReturn') + '：' + t('rdAfterReturnNote'))
            ))
          }
        } else {
          rt.push(h('div', { key: 'noret', className: 'vwf-muted-sm', style: { marginTop: 6 } }, t('rdReturnNone')))
        }
        return h('div', { className: 'vwf-tab-panel' }, rt)
      }

      // 活动页签：指导 / 控制事件 / 人工决策 / 基线修订 / 运行日志（日志标注来源分段）
      function renderActivityTab() {
        const rt = []
        const g = (lr && lr.guidance) || []
        const ce = (lr && lr.control_events) || []
        const hd = (lr && lr.human_decisions) || []
        const br = (lr && lr.baseline_revisions) || []
        rt.push(h('div', { key: 'g', className: 'vwf-sec' }, t('rdActivityTitle')))
        if (g.length) {
          rt.push(h('div', { key: 'gl' }, g.map((x) => h('div', { key: 'g' + x.seq, className: 'vwf-muted-sm' },
            '#' + x.seq + ' · ' + t(x.mode === 'baseline' ? 'rdPausedGuidanceBaseline' : 'rdPausedGuidanceCoach') + ' · ' + fmtAt(x.at) + ' · ' + (x.mode === 'baseline' ? String(x.new_baseline || '') : String(x.text || ''))))))
        }
        if (ce.length) {
          rt.push(h('div', { key: 'ce', style: { marginTop: 6 } },
            h('div', { className: 'vwf-muted-sm' }, t('rdActivityControl')),
            h('div', null, ce.map((x, i) => h('div', { key: 'ce' + i, className: 'vwf-muted-sm' },
              String(x.type || '—') + ' · ' + fmtAt(x.at) + (x.run_id ? ' · ' + t('rdSegmentLabel', { n: (x.run_id === head.id ? (head.segment || activeSeg) : '?') }) : ''))))))
        }
        if (hd.length) {
          rt.push(h('div', { key: 'hd', style: { marginTop: 6 } },
            h('div', { className: 'vwf-muted-sm' }, t('rdActivityHuman')),
            h('div', null, hd.map((x, i) => h('div', { key: 'hd' + i, className: 'vwf-muted-sm' },
              String(x.decision_id || '—') + ' · ' + String(x.user_choice || '—') + ' · ' + fmtAt(x.at || x.created_at))))))
        }
        if (br.length) {
          rt.push(h('div', { key: 'br', style: { marginTop: 6 } },
            h('div', { className: 'vwf-muted-sm' }, t('rdActivityBaseline')),
            h('div', null, br.map((x, i) => h('div', { key: 'br' + i, className: 'vwf-muted-sm' }, 'R' + (x.revision || i + 1) + ' · ' + fmtAt(x.at))))))
        }
        const logs = (snapState && snapState.logs) || []
        rt.push(h('div', { key: 'lg', style: { marginTop: 6 } },
          h('div', { className: 'vwf-muted-sm' }, t('rdActivityLogs') + ' · ' + t('rdSegmentLabel', { n: head.segment || activeSeg })),
          logs.length ? h('div', { className: 'vwf-code' }, logs.slice(-20).map((line) => t('rdLogSource', { segment: head.segment || activeSeg, text: String(line) })).join('\n')) : h('div', { className: 'vwf-muted-sm' }, t('rdActivityNone'))
        ))
        return h('div', { className: 'vwf-tab-panel' }, rt)
      }

      // 运行控制：按钮名对应实际 action（pause=检查点生效，interrupt=立即中止，guidance 仅 PAUSED）
      function renderControlCard() {
        const lstate = lr && lr.lifecycle ? String(lr.lifecycle.state) : ''
        const badge = statusBadge(head.status)
        return h('div', { className: 'vwf-card', style: { marginTop: 8, padding: '10px 12px' } },
          h('div', { className: 'vwf-row', style: { justifyContent: 'space-between' } },
            h('div', { className: 'vwf-card-title' }, t('rdControlTitle')),
            badge
          ),
          h('div', { className: 'vwf-muted-sm', style: { marginTop: 4 } }, t('dashStatusLabel', { status: head.status }) + ' · ' + t('rdLifecycleLabel') + '：' + (lstate || '—')),
          terminal ? h('div', { className: 'vwf-note warn' }, t('rdControlTerminal', { state: lstate || head.status })) : null,
          !terminal && lstate === 'RUNNING' ? h('div', null,
            h('div', { className: 'vwf-row', style: { gap: 8, marginTop: 6 } },
              h('button', { className: 'vwf-btn sm', onClick: () => sendControl('pause') }, t('rdControlPause')),
              h('button', { className: 'vwf-btn sm', onClick: () => sendControl('interrupt') }, t('rdControlInterrupt')),
              head.pause_pending ? h('span', { className: 'vwf-badge', style: { color: STATUS_COLOR.human } }, t('ctlPending')) : null
            ),
            h('div', { className: 'vwf-muted-sm', style: { marginTop: 4 } }, t('rdControlPauseNote') + ' ' + t('rdControlInterruptNote'))
          ) : null,
          !terminal && lstate === 'PAUSED' ? h('div', { className: 'vwf-note warn', style: { marginTop: 6 } },
            t('rdPausedTitle') + ' · ' + t('rdPausedWhy') + '：' + String((lr && lr.lifecycle && lr.lifecycle.reason && (lr.lifecycle.reason.code || lr.lifecycle.reason.message)) || '—')) : null
        )
      }

      // PAUSED 卡：暂停原因 / 已有 guidance / 指导提交 / 恢复入口。
      // 指导经 vwf.run.control 提交（宿主 RPC，不属 DT-01 阻塞面），不产生业务结果；
      // 恢复沿用既有 wf_run 续跑语义，其提交路径受 DT-01 阻塞，只交参数映射。
      function renderPausedCard() {
        const lstate = lr && lr.lifecycle ? String(lr.lifecycle.state) : ''
        if (lstate !== 'PAUSED') return null
        const reason = lr && lr.lifecycle && lr.lifecycle.reason ? (lr.lifecycle.reason.code || lr.lifecycle.reason.message) : ''
        const g = (lr && lr.guidance) || []
        return h('div', { className: 'vwf-card', style: { marginTop: 8 } },
          h('div', { className: 'vwf-card-head' },
            h('div', { className: 'vwf-card-title' }, t('rdPausedTitle')),
            h('span', { className: 'vwf-badge', style: { color: STATUS_COLOR.human } }, String(head.status || 'PAUSED'))
          ),
          h('div', { style: { padding: '8px 14px 12px' } },
            h('div', { className: 'vwf-muted' }, t('rdPausedWhy') + '：' + String(reason || '—')),
            h('div', { className: 'vwf-note' }, t('rdPausedNote')),
            h('div', { className: 'vwf-sec', style: { marginTop: 6 } }, t('rdPausedGuidance')),
            g.length
              ? h('table', { className: 'vwf-table' },
                  h('tbody', null, g.map((x) => h('tr', { key: 'g' + x.seq },
                    h('td', { className: 'vwf-muted-sm', style: { width: 90 } }, '#' + x.seq + ' · ' + t(x.mode === 'baseline' ? 'rdPausedGuidanceBaseline' : 'rdPausedGuidanceCoach')),
                    h('td', null, x.mode === 'baseline' ? String(x.new_baseline || '') : String(x.text || '')),
                    h('td', { className: 'vwf-muted-sm', style: { width: 140 } }, fmtAt(x.at))
                  )))
                )
              : h('div', { className: 'vwf-muted-sm' }, t('rdPausedGuidanceNone')),
            h('label', { style: { display: 'block', marginTop: 6 } },
              h('span', { className: 'vwf-field-label' }, t('rdControlGuidance')),
              h('textarea', { className: 'vwf-textarea', rows: 2, style: { width: '100%' }, placeholder: t('rdPausedGuidancePlaceholder'), value: guidanceText, onChange: (ev) => setGuidanceText(ev.target.value) })
            ),
            h('div', { className: 'vwf-row', style: { gap: 8, marginTop: 6 } },
              h('button', { className: 'vwf-btn sm primary', disabled: !guidanceText.trim(), onClick: () => sendControl('guidance', { text: guidanceText.trim() }) }, t('rdPausedGuidanceSubmit')),
              guidanceMsg ? h('span', { className: 'vwf-badge', style: { color: STATUS_COLOR.pass } }, guidanceMsg) : null,
              h('span', { className: 'vwf-muted-sm' }, t('rdControlGuidanceNote'))
            ),
            h('div', { className: 'vwf-sec', style: { marginTop: 10 } }, t('rdPausedResume')),
            h('div', { className: 'vwf-note warn' }, t('rdPausedResumeDt01')),
            mappingRows([
              { k: 'taskId', v: String(head.taskId || '—') },
              { k: 'templateId', v: String(head.workflowId || '—') },
              { k: 'resume_paused', v: 'true' },
              { k: 'logical_run_id', v: String(lrId || '—') },
            ])
          )
        )
      }

      // WAITING_HUMAN 结构化决策卡：选项 / 理由 / 影响说明 / 提交后锁定与续跑中；
      // 提交路径受 DT-01 阻塞时只交界面与字段映射，不伪造成功状态。
      function renderDecisionCard() {
        const status = String(head.status || '')
        if (status !== 'WAITING_HUMAN' && status.indexOf('AWAITING_HUMAN_') !== 0) return null
        const rows = []
        if (!pkg) {
          rows.push(h('div', { key: 'nopkg', className: 'vwf-note warn' }, t('rdDecisionNoPackage')))
        } else {
          rows.push(h('div', { key: 'why' },
            h('div', { className: 'vwf-sec' }, t('rdDecisionWhy')),
            h('div', { className: 'vwf-muted' }, unknownText(pkg.why))
          ))
          rows.push(h('div', { key: 'cur', style: { marginTop: 6 } },
            h('div', { className: 'vwf-sec' }, t('rdDecisionCurrent')),
            h('div', { className: 'vwf-muted' }, unknownText(pkg.current_state))
          ))
          const opts = Array.isArray(pkg.options) ? pkg.options.map((o) => String((o && o.id) || '')).filter(Boolean) : []
          const effects = pkg.subsequent_effects && typeof pkg.subsequent_effects === 'object' ? pkg.subsequent_effects : {}
          rows.push(h('div', { key: 'opt', style: { marginTop: 6 } },
            h('div', { className: 'vwf-sec' }, t('rdDecisionOptions')),
            opts.length ? h('div', { className: 'vwf-row', style: { gap: 8, flexWrap: 'wrap' } }, opts.map((id) => {
              const control = ['USER_ACCEPTED', 'ADD_BUDGET', 'STOP'].indexOf(id) >= 0
              return h('button', {
                key: id, className: 'vwf-btn sm' + (decisionChoice === id ? ' primary' : ''),
                'aria-pressed': decisionChoice === id ? 'true' : 'false',
                onClick: () => setDecisionChoice(id),
                title: effects[id] || '',
              }, id + (control ? '' : ''))
            })) : h('div', { className: 'vwf-muted-sm' }, t('rdDecisionUnknown'))
          ))
          if (opts.length) {
            rows.push(h('div', { key: 'eff', style: { marginTop: 6 } },
              h('div', { className: 'vwf-sec' }, t('rdDecisionEffects')),
              h('table', { className: 'vwf-table' },
                h('thead', null, h('tr', null, h('th', null, t('rdDecisionOptions')), h('th', null, t('rdDecisionEffects')))),
                h('tbody', null, opts.map((id) => h('tr', { key: id }, h('td', null, id), h('td', null, effects[id] ? unknownText(effects[id]) : t('rdDecisionUnknown')))))
              )
            ))
          }
          const extra = [['cost', t('rdDecisionCost')], ['benefit', t('rdDecisionBenefit')], ['risk', t('rdDecisionRisk')], ['recommendation', t('rdDecisionRecommendation')]]
            .filter(([k]) => pkg[k] !== undefined && pkg[k] !== null && String(pkg[k]).trim() !== '')
          if (extra.length) {
            rows.push(h('div', { key: 'extra', style: { marginTop: 6 } },
              h('div', { className: 'vwf-sec' }, t('rdDecisionCost') + ' / ' + t('rdDecisionBenefit') + ' / ' + t('rdDecisionRisk')),
              h('table', { className: 'vwf-table' },
                h('tbody', null, extra.map(([k, l]) => h('tr', { key: k }, h('td', null, l), h('td', null, unknownText(pkg[k])))))
              )
            ))
          }
          if (blockedEdge) {
            rows.push(h('div', { key: 'be', style: { marginTop: 6 } },
              h('div', { className: 'vwf-sec' }, t('rdDecisionBlockedEdge')),
              h('div', { className: 'vwf-code' }, safeJson(blockedEdge))
            ))
          }
        }
        rows.push(h('label', { key: 'reason', style: { display: 'block', marginTop: 6 } },
          h('span', { className: 'vwf-field-label' }, t('rdDecisionReason')),
          h('textarea', { className: 'vwf-textarea', rows: 2, placeholder: t('rdDecisionReasonPlaceholder'), value: decisionReason, onChange: (ev) => setDecisionReason(ev.target.value), style: { width: '100%' } })
        ))
        rows.push(h('div', { key: 'impact', className: 'vwf-note' }, t('rdDecisionImpact') + '：' + t('rdDecisionImpactNote')))
        if (consumed) rows.push(h('div', { key: 'cons', className: 'vwf-note warn' }, t('rdDecisionConsumed', { id: decisionId })))
        rows.push(h('div', { key: 'dt01', className: 'vwf-note warn' }, t('rdDecisionDt01')))
        const mapRows = [['decision_id', decisionId || '—'], ['user_choice', decisionChoice || '—']]
        if (decisionReason.trim()) mapRows.push(['reason', decisionReason.trim()])
        mapRows.push(['taskId', head.taskId || '—'])
        mapRows.push(['templateId', head.workflowId || '—'])
        rows.push(h('div', { key: 'map' },
          h('div', { className: 'vwf-sec' }, t('rdDecisionMapping')),
          mappingRows(mapRows.map(([k, v]) => ({ k, v: String(v) })))
        ))
        rows.push(h('div', { key: 'act', className: 'vwf-row', style: { marginTop: 6, gap: 8 } },
          // 提交按钮在 DT-01 未裁定前锁定：不发起续跑，也不显示成功
          h('button', { className: 'vwf-btn primary', disabled: true, 'aria-disabled': 'true' }, t('rdDecisionSubmit')),
          h('span', { className: 'vwf-muted-sm' }, t('rdDecisionLocked') + ' · ' + t('rdDecisionNotYetLocked'))
        ))
        return h('div', { className: 'vwf-card', style: { marginTop: 8 } },
          h('div', { className: 'vwf-card-head' }, h('div', { className: 'vwf-card-title' }, t('rdDecisionTitle'))),
          h('div', { style: { padding: '8px 14px 12px' } }, rows)
        )
      }

      // BLOCKED 恢复卡：阻塞原因 / 当前 Provider·Model / 修改后值 / 新修订与旧修订保留说明
      function renderRecoveryCard() {
        if (String(head.status) !== 'BLOCKED') return null
        const rows = []
        rows.push(h('div', { key: 'r', className: 'vwf-note warn' }, t('rdBlockedReason') + '：' + String(head.reason || '—')))
        rows.push(h('div', { key: 'n', className: 'vwf-muted-sm' }, t('rdBlockedResumeNode', { node: String(head.node || '—') })))
        const nodeIds = Object.keys(lrProviderModel)
        rows.push(h('div', { key: 'pm', style: { marginTop: 6 } },
          h('div', { className: 'vwf-sec' }, t('rdBlockedModel')),
          nodeIds.length
            ? h('table', { className: 'vwf-table' },
                h('thead', null, h('tr', null, h('th', null, t('dashColNode')), h('th', null, t('rdBlockedPrevValue')), h('th', null, t('rdBlockedNewValue')))),
                h('tbody', null, nodeIds.map((nid) => {
                  const pm = lrProviderModel[nid] || {}
                  const draft = modelDraft[nid] || {}
                  const provs = (providers || []).map((p) => String((p && (p.id || p.name)) || '')).filter(Boolean)
                  const models = (providers || []).filter((p) => String((p && (p.id || p.name)) || '') === String(draft.provider || pm.provider)).flatMap((p) => (p.models || []).map((m) => String(m)))
                  return h('tr', { key: nid },
                    h('td', null, nid),
                    h('td', null, String(pm.provider || 'default') + ' / ' + String(pm.model || 'default')),
                    h('td', null, h('div', { className: 'vwf-row', style: { gap: 4 } },
                      h('select', { className: 'vwf-input', style: { width: 110 }, value: String(draft.provider || pm.provider || ''), onChange: (ev) => setModelDraft(Object.assign({}, modelDraft, { [nid]: Object.assign({}, draft, { provider: ev.target.value, model: '' }) })) },
                        [h('option', { key: '', value: '' }, t('rdBlockedKeepDefault'))].concat(provs.map((p) => h('option', { key: p, value: p }, p)))),
                      h('select', { className: 'vwf-input', style: { width: 130 }, value: String(draft.model || pm.model || ''), onChange: (ev) => setModelDraft(Object.assign({}, modelDraft, { [nid]: Object.assign({}, draft, { model: ev.target.value }) })) },
                        [h('option', { key: '', value: '' }, t('rdBlockedKeepDefault'))].concat(models.map((m) => h('option', { key: m, value: m }, m))))
                    ))
                  )
                }))
              )
            : h('div', { className: 'vwf-muted-sm' }, t('rdBlockedNoProvider'))
        ))
        rows.push(h('div', { key: 'note', className: 'vwf-note' }, t('rdBlockedRestoreNote')))
        rows.push(h('div', { key: 'dt01', className: 'vwf-note warn' }, t('rdBlockedDt01')))
        const overrides = {}
        for (const nid of Object.keys(modelDraft)) {
          const d = modelDraft[nid] || {}
          if (!d.provider && !d.model) continue
          overrides[nid] = { provider: d.provider || undefined, model: d.model || undefined }
        }
        rows.push(h('div', { key: 'map' },
          h('div', { className: 'vwf-sec' }, t('rdBlockedMapping')),
          mappingRows([
            { k: 'taskId', v: String(head.taskId || '—') },
            { k: 'templateId', v: String(head.workflowId || '—') },
            { k: 'entry', v: String(head.node || '—') },
            { k: 'model_overrides', v: Object.keys(overrides).length ? safeJson(overrides) : '—' },
          ])
        ))
        rows.push(h('div', { key: 'act', className: 'vwf-row', style: { marginTop: 6, gap: 8 } },
          h('button', { className: 'vwf-btn primary', disabled: true, 'aria-disabled': 'true' }, t('rdBlockedSubmit')),
          h('span', { className: 'vwf-muted-sm' }, t('rdDecisionLocked'))
        ))
        return h('div', { className: 'vwf-card', style: { marginTop: 8 } },
          h('div', { className: 'vwf-card-head' }, h('div', { className: 'vwf-card-title' }, t('rdBlockedTitle'))),
          h('div', { style: { padding: '8px 14px 12px' } }, rows)
        )
      }

      // 执行分段：一个 Logical Run 的每一段（多段折叠为一条任务的连续分段）
      function renderSegmentsCard() {
        const segs = (lr && lr.segments) || task.segments || []
        if (!segs.length) return null
        return h('div', { className: 'vwf-card', style: { marginTop: 8 } },
          h('div', { className: 'vwf-card-head' }, h('div', { className: 'vwf-card-title' }, t('rdSegments'))),
          h('div', { style: { padding: '8px 14px 12px' } },
            h('table', { className: 'vwf-table' },
              h('thead', null, h('tr', null,
                h('th', null, t('rdColSegment')), h('th', null, t('rdColTrigger')), h('th', null, t('rdColState')),
                h('th', null, t('rdColStarted')), h('th', null, t('rdColEnded')), h('th', null, t('rdColDecision'))
              )),
              h('tbody', null, segs.map((s) => h('tr', { key: 'seg' + (s.index || s.id) },
                h('td', null, String(s.index !== undefined ? s.index : (s.segment || '—')) + (s.active ? ' · ' + t('rdSegmentActive') : '')),
                h('td', null, String(s.trigger || '—')),
                h('td', null, String(s.status || head.status || '—')),
                h('td', null, fmtAt(s.started_at || s.startedAt)),
                h('td', null, fmtAt(s.ended_at || s.endedAt)),
                h('td', null, String(s.decision_id || '—'))
              )))
            )
          )
        )
      }

      // 快照修订：生效修订与历史修订都保留可查（Provider / Model 变更留下新修订）
      function renderSnapshotsCard() {
        const snaps = (lr && lr.snapshots) || []
        return h('div', { className: 'vwf-card', style: { marginTop: 8 } },
          h('div', { className: 'vwf-card-head' }, h('div', { className: 'vwf-card-title' }, t('rdSnapshots'))),
          h('div', { style: { padding: '8px 14px 12px' } },
            snaps.length ? h('table', { className: 'vwf-table' },
              h('thead', null, h('tr', null,
                h('th', null, t('rdColRevision')), h('th', null, t('rdColActive')), h('th', null, t('rdColTime')), h('th', null, t('rdColProviderModel'))
              )),
              h('tbody', null, snaps.map((s) => h('tr', { key: 'snap' + s.revision },
                h('td', null, 'R' + String(s.revision)),
                h('td', null, s.active ? t('rdSegmentActive') : '—'),
                h('td', null, fmtAt(s.created_at)),
                h('td', null, h('div', { className: 'vwf-muted-sm' }, Object.keys(s.provider_model || {}).map((nid) => nid + '=' + String((s.provider_model[nid] || {}).provider || 'default') + '/' + String((s.provider_model[nid] || {}).model || 'default')).join(' · ') || '—'))
              )))
            ) : h('div', { className: 'vwf-muted-sm' }, t('rdNoSnapshots'))
          )
        )
      }

      // 只读画布（沿用既有 Canvas 只读态与 workflowId 匹配的模板 DSL）
      function renderCanvasCard() {
        if (!dsl) return null
        return h('div', { className: 'vwf-card', style: { marginTop: 8 } }, h(Canvas, { dsl, readOnly: true, statusMap: st }))
      }

      // 节点表：既有 agents 行渲染（含 fanout 子项归组），本段来源标注
      function renderAgentsCard() {
        const agents = (snapState && snapState.agents) || []
        if (!agents.length) return null
        return h('div', { className: 'vwf-card', style: { marginTop: 8 } },
          h('div', { className: 'vwf-card-head' },
            h('div', { className: 'vwf-card-title' }, t('dashColNode') + ' / ' + t('dashColResult')),
            h('span', { className: 'vwf-muted-sm' }, t('rdSegmentLabel', { n: head.segment || activeSeg }))
          ),
          h('div', { style: { padding: '8px 14px 12px' } },
            h('table', { className: 'vwf-table' },
              h('thead', null, h('tr', null, h('th', null, t('dashColIndex')), h('th', null, t('dashColNode')), h('th', null, t('dashColPhase')), h('th', null, t('dashColResult')))),
              h('tbody', null, dashboardAgentRows(agents))
            )
          )
        )
      }

      // 正式产物：标注来源分段与 attempt（避免当前轮与上一轮混淆）
      function renderArtifactsCard() {
        const arts = latestArtifactRecords(snapState && snapState.formalRecords)
        return h('div', { className: 'vwf-card', style: { marginTop: 8 } },
          h('div', { className: 'vwf-card-head' }, h('div', { className: 'vwf-card-title' }, t('formalArtifacts'))),
          h('div', { style: { padding: '8px 14px 12px' } },
            arts.length ? arts.map((rec) => h('div', { key: rec.record_id + '@' + rec.record_revision, style: { marginBottom: 12, paddingBottom: 12, borderBottom: '1px solid var(--dsw-alias-border-l2, #333)' } },
              h('div', { className: 'vwf-row', style: { gap: 8, flexWrap: 'wrap', marginBottom: 6 } },
                h('strong', null, artifactPathFromRecordId(rec.record_id)),
                h('span', { className: 'vwf-badge accent' }, t('artifactRevision') + ' R' + rec.record_revision),
                h('span', { className: 'vwf-muted-sm' }, rec.body && rec.body.media_type ? rec.body.media_type : ''),
                rec.provenance && rec.provenance.node ? h('span', { className: 'vwf-muted-sm' }, t('dashArtifactNode', { node: rec.provenance.node })) : null
              ),
              h('div', { className: 'vwf-muted-sm' }, rec.provenance
                ? t('rdArtifactSource', { segment: rec.provenance.attempt === undefined || rec.provenance.attempt === null ? '—' : rec.provenance.attempt, attempt: rec.record_revision, provider: String(rec.provenance.provider || 'default'), model: String(rec.provenance.model || 'default') })
                : t('rdArtifactSourceUnknown')),
              h('div', { className: 'vwf-row', style: { gap: 6 } }, rec.provenance && rec.provenance.node_business_outcome ? h('span', { className: 'vwf-badge accent' }, String(rec.provenance.node_business_outcome)) : null),
              renderArtifactBody(rec)
            )) : h('div', { className: 'vwf-muted-sm' }, t('noFormalArtifacts'))
          )
        )
      }

      // 工作空间面板：mode / repository / branch / 当前·base HEAD / 集成 / 活动锁 / 清理；
      // 读取失败显示未知状态与重试，不把过时缓存当作当前事实。
      function renderWorkspaceCard() {
        const ws = lr && lr.workspace ? lr.workspace : null
        const body = []
        if (lrError) {
          body.push(h('div', { key: 'e', className: 'vwf-note warn' }, t('rdWsReadFailed', { err: lrError })))
          body.push(h('div', { key: 'r', className: 'vwf-row' },
            h('button', { className: 'vwf-btn sm', onClick: () => { setWsTick((n) => n + 1) } }, t('rdWsRetry')),
            h('span', { className: 'vwf-muted-sm' }, t('rdWsStaleNote'))
          ))
        } else if (!ws) {
          body.push(h('div', { key: 'n', className: 'vwf-muted-sm' }, t('rdWsNoRecord')))
        } else {
          const kv = [
            [t('rdWsMode'), ws.mode ? String(ws.mode) : null],
            [t('rdWsRepo'), ws.source_path ? String(ws.source_path) : (ws.workspace_path ? String(ws.workspace_path) : null)],
            [t('rdWsBranch'), ws.work_branch ? String(ws.work_branch) : null],
            [t('rdWsCurrentHead'), ws.current_head ? shortSha(ws.current_head) : null],
            [t('rdWsBaseHead'), ws.base_commit ? shortSha(ws.base_commit) : null],
            [t('rdWsIntegration'), ws.lifecycle ? String(ws.lifecycle) : ((ws.integration_checkpoints || []).length ? String((ws.integration_checkpoints[ws.integration_checkpoints.length - 1] || {}).type || '') : null)],
            [t('rdWsLocks'), (ws.resource_locks || []).length ? (ws.resource_locks || []).map((l) => t('rdWsLockItem', { type: String(l.type || '') })).join('、') : t('rdWsNoLock')],
            [t('rdWsCleanup'), ws.cleanup ? (typeof ws.cleanup === 'string' ? String(ws.cleanup) : safeJson(ws.cleanup)) : null],
          ]
          body.push(h('table', { key: 'kv', className: 'vwf-table' },
            h('tbody', null, kv.map(([k, v]) => h('tr', { key: k },
              h('td', { className: 'vwf-muted-sm', style: { width: 90 } }, k),
              h('td', null, v === null || v === undefined || v === '' ? h('span', { className: 'vwf-badge' }, t('rdWsUnknown')) : String(v))
            )))
          ))
          if (ws.refreshed_at) body.push(h('div', { key: 'at', className: 'vwf-muted-sm' }, t('rdWsRefreshedAt', { at: fmtAt(ws.refreshed_at) })))
        }
        return h('div', { className: 'vwf-card', style: { marginTop: 8 } },
          h('div', { className: 'vwf-card-head' }, h('div', { className: 'vwf-card-title' }, t('rdWsPanel'))),
          h('div', { style: { padding: '8px 14px 12px' } }, body)
        )
      }
    }

    function safeJson(v) {
      try { return JSON.stringify(v, null, 2) } catch (e) { return String(v) }
    }


    // ── 页面：模板库 + 全局编辑层 + 运行看板 ───────────────────────────────
    function Skeleton() {
      return { id: 'my-flow', name: t('myWorkflow'), description: '', entry: 'node-1', control: { maxRounds: 9 }, nodes: [{ id: 'node-1', profile: '', label: t('defaultNodeLabel', { n: 1 }) }], edges: [{ from: 'node-1', to: '$end', on: 'success' }] }
    }

    function Page() {
      const [i18nReady, setI18nReady] = React.useState(false)
      const [tab, setTab] = React.useState('templates')
      const [list, setList] = React.useState(null)
      const [editId, setEditId] = React.useState(null) // 编辑层中的模板 id
      const [wf, setWf] = React.useState(null) // 编辑层中的工作流草稿
      const [dirty, setDirty] = React.useState(false)
      const [saving, setSaving] = React.useState(false)
      const [msg, setMsg] = React.useState(null)
      const [providers, setProviders] = React.useState([])
      const [roles, setRoles] = React.useState([])
      const [confirmDiscardOpen, setConfirmDiscardOpen] = React.useState(false)
      // 未保存三选一（§7.11）：由 Page 触发的「保存并返回」需要回调到编辑器内的保存流程
      const editorSaveRef = React.useRef(null)
      // 流程库筛选（V-1：关闭工作区后回到原列表、筛选与滚动位置）
      const [tplFilter, setTplFilter] = React.useState('')
      // V-2：流程库子页签 全部 / 内置 / 我的（默认全部）
      const [libFilter, setLibFilter] = React.useState('all')
      // V-3：运行页签上的待处理计数。待处理项并入运行列表后，这个计数是「不丢失」的兜底
      // 可见性——列表页未挂载时自己取一次摘要，进入运行页后由 Dashboard 的轮询结果接管。
      const [attention, setAttention] = React.useState(0)
      React.useEffect(() => {
        host.call('vwf.runs.list')
          .then((r) => setAttention(attentionTaskCount((r && r.runs) || [])))
          .catch(() => {})
      }, [])
      const editorDialogRef = React.useRef(null)
      const editorOpen = !!wf

      // issue-54：用原生 top-layer dialog 承载编辑器，避免皮肤布局中的
      // transform / overflow 等祖先样式把 position:fixed 元素限制在设置页内部。
      React.useEffect(() => {
        if (!editorOpen) return undefined
        const dialog = editorDialogRef.current
        if (!dialog) return undefined
        try {
          if (typeof dialog.showModal === 'function') {
            if (!dialog.open) dialog.showModal()
          } else {
            dialog.setAttribute('open', '')
          }
        } catch (e) {
          dialog.setAttribute('open', '')
        }
        return undefined
      }, [editorOpen])

      const refresh = React.useCallback(() => host.call('vwf.workflows.list').then((l) => setList(l || [])).catch(() => setList([])), [])
      // ── LOC-014 模型覆盖（最小入口）：内置模板按节点 / $default 覆盖 Provider/Model ──
      // 完整交互归 LOC-016；本对话框按"允许重做"实现，仅求可用与语义正确。
      const [ovId, setOvId] = React.useState(null)
      const [ovW, setOvW] = React.useState(null)
      const [ovDraft, setOvDraft] = React.useState({})
      const [ovBusy, setOvBusy] = React.useState(false)
      const [ovSaved, setOvSaved] = React.useState('{}')
      const [ovConfirm, setOvConfirm] = React.useState(null)
      const ovDialogRef = React.useRef(null)
      // 未保存判定的归一化：仅保留 provider/model 均非空的行（与保存口径一致）
      const ovNorm = (d) => JSON.stringify(Object.keys(d || {}).sort().reduce((a, k) => {
        const v = d[k]
        const provider = String((v && v.provider) || '').trim()
        const model = String((v && v.model) || '').trim()
        if (provider && model) a[k] = { provider, model }
        return a
      }, {}))
      React.useEffect(() => {
        if (!ovId) return undefined
        const dialog = ovDialogRef.current
        try {
          if (dialog && typeof dialog.showModal === 'function') { if (!dialog.open) dialog.showModal() }
          else if (dialog) dialog.setAttribute('open', '')
        } catch (e) { if (dialog) dialog.setAttribute('open', '') }
        return undefined
      }, [ovId])
      const openOv = (w) => {
        if (!w || !w.builtin) return
        host.call('vwf.workflows.modelOverride.get', { id: w.id }).then((r) => {
          const saved = (r && r.ok && r.overrides) || {}
          const draft = {}
          if (saved['$default']) draft['$default'] = { provider: saved['$default'].provider, model: saved['$default'].model }
          for (const n of ((w.dsl && w.dsl.nodes) || [])) if (saved[n.id]) draft[n.id] = { provider: saved[n.id].provider, model: saved[n.id].model }
          setOvW(w); setOvDraft(draft); setOvSaved(ovNorm(ovResolvedOf(w, draft))); setOvConfirm(null); setOvId(w.id)
        }).catch((e) => setMsg(t('modelOverrideLoadFailed') + String(e)))
      }
      const closeOv = () => { setOvConfirm(null); setOvId(null); setOvW(null); setOvDraft({}); setOvSaved('{}') }
      const requestCloseOv = () => {
        // 未保存退出 → 与编辑器同款确认弹窗（UAT 反馈 #4）
        if (ovNorm(ovDraft) !== ovSaved) { setOvConfirm('close'); return }
        closeOv()
      }
      const ovSet = (k, field, v) => setOvDraft((d) => ({ ...d, [k]: { ...(d[k] || {}), [field]: v } }))
      const reloadOvView = () => {
        // 清除后留在覆盖窗口（UAT 反馈 #5）：刷新清单并就地更新当前查看的模板数据
        return host.call('vwf.workflows.list').then((l) => {
          setList(l || [])
          const w = (l || []).find(x => x.id === ovId)
          if (w) setOvW(w)
        }).catch(() => {})
      }
      // 解析草稿为最终覆盖（留空列 = 沿用该行当前默认，UAT 反馈：只切 model 不动 provider）
      const ovResolvedOf = (w, draft) => {
        const models = (w && w.dsl && w.dsl.bindings && w.dsl.bindings.models && typeof w.dsl.bindings.models === 'object') ? w.dsl.bindings.models : {}
        const out = {}
        for (const n of ((w && w.dsl && w.dsl.nodes) || [])) {
          const d = (draft || {})[n.id]
          if (!d) continue
          const eff = (n.model && (n.model.provider || n.model.model)) ? n.model : (models[n.id] || null)
          const provider = String(d.provider || '').trim() || (eff ? String(eff.provider || '') : '')
          const model = String(d.model || '').trim() || (eff ? String(eff.model || '') : '')
          if (provider && model) out[n.id] = { provider, model }
        }
        return out
      }
      const saveOv = () => {
        if (!ovId || ovBusy) return
        const overrides = ovResolvedOf(ovW, ovDraft)
        if (!Object.keys(overrides).length) { setMsg(t('modelOverrideEmpty')); return }
        setOvBusy(true)
        host.call('vwf.workflows.modelOverride.save', { id: ovId, overrides }).then((r) => {
          setOvBusy(false)
          if (r && r.ok) { setOvSaved(ovNorm(overrides)); setMsg(t('modelOverrideSaved') + ovId); closeOv(); refresh() }
          else setMsg(t('modelOverrideFailed') + ((r && r.errors && r.errors[0] && r.errors[0].message) || ''))
        }).catch((e) => { setOvBusy(false); setMsg(t('modelOverrideFailed') + String(e)) })
      }
      const doClearOv = () => {
        if (!ovId || ovBusy) return
        setOvBusy(true)
        host.call('vwf.workflows.modelOverride.clear', { id: ovId }).then((r) => {
          setOvBusy(false)
          if (r && r.ok) {
            setOvDraft({}); setOvSaved('{}'); setOvConfirm(null)
            setMsg(t('modelOverrideCleared') + ovId)
            reloadOvView()
            refresh()
          }
          else { setOvConfirm(null); setMsg(t('modelOverrideFailed') + ((r && r.errors && r.errors[0] && r.errors[0].message) || '')) }
        }).catch((e) => { setOvBusy(false); setOvConfirm(null); setMsg(t('modelOverrideFailed') + String(e)) })
      }
      // 角色数据源独立抓手：角色库变更后立即刷新，让新建/编辑的角色马上进入节点选择器
      const refetchRoles = React.useCallback(() => {
        host.call('vwf.roles').then(r => { if (r && r.roles) setRoles(r.roles) }).catch(() => {})
      }, [])
      React.useEffect(() => {
        host.call('vwf.i18n', { locale: isEn() ? 'en' : 'zh' }).then((r) => {
          messages = (r && r.messages) || {}
          setI18nReady(true)
        }).catch(() => { messages = {}; setI18nReady(true) })
      }, [])
      React.useEffect(() => { refresh() }, [])
      React.useEffect(() => {
        host.call('vwf.models').then(r => { if (r && r.providers) setProviders(r.providers) }).catch(() => {})
        refetchRoles()
      }, [refetchRoles])

      // Escape 分层关闭：未保存三选一在最上层时先关它，不把整个工作区一起带走
      React.useEffect(() => {
        if (!confirmDiscardOpen) return undefined
        const onKey = (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); setConfirmDiscardOpen(false) } }
        document.addEventListener('keydown', onKey, true)
        return () => document.removeEventListener('keydown', onKey, true)
      }, [confirmDiscardOpen])
      const openEditor = (id) => {
        const w = (list || []).find(x => x.id === id)
        if (!w) return
        setEditId(id)
        setWf(clone(w.dsl))
        setDirty(false)
      }
      const closeEditor = () => { setConfirmDiscardOpen(false); setEditId(null); setWf(null); setDirty(false) }
      const requestCloseEditor = () => {
        if (dirty) { setConfirmDiscardOpen(true); return }
        closeEditor()
      }
      const onNew = () => {
        const d = Skeleton()
        setEditId(null)
        setWf(d)
        setDirty(true)
      }
      const onRemove = (id) => {
        const w = (list || []).find(x => x.id === id)
        if (w && w.builtin) { setMsg(t('builtinReadonly')); return }
        if (!window.confirm(t('confirmDelete') + id + '？')) return
        host.call('vwf.workflows.remove', { id }).then((r) => {
          if (r && r.ok) { setMsg(t('deleted') + id); refresh() }
          else setMsg(t('deleteFailed') + ((r && r.errors && r.errors[0] && r.errors[0].message) || ''))
        }).catch((e) => setMsg(t('deleteFailed') + String(e)))
      }
      const onSaved = (id) => {
        setSaving(false)
        setDirty(false)
        setMsg(t('saved') + id)
        closeEditor()
        refresh()
      }
      const [probing, setProbing] = React.useState(false)
      // #74 探针结论 → 用户文案（host 侧已做错误清洗，此处只做呈现映射）
      const probeStatusText = (r) => {
        const map = {
          available: t('probeStatusAvailable'), auth_failed: t('probeStatusAuthFailed'), quota: t('probeStatusQuota'),
          rate_limit: t('probeStatusRateLimit'), model_unavailable: t('probeStatusModelUnavailable'), permission_denied: t('probeStatusPermissionDenied'),
          provider_unreachable: t('probeStatusUnreachable'), timeout: t('probeStatusTimeout'), provider_error: t('probeStatusOther'),
          provider_not_configured: t('probeStatusProviderNotConfigured'), model_not_configured: t('probeStatusModelNotConfigured'),
          probe_internal_error: t('probeStatusInternalError'),
          probe_degraded: t('probeStatusDegraded'), unknown: t('probeStatusUnknown'),
        }
        return map[r.status] || r.status || t('probeStatusUnknown')
      }
      const onOneClickCheck = (force) => {
        if (!wf || probing) return
        setProbing(true)
        host.call('vwf.probe', { dsl: wf, force: force === true }).then((r) => {
          if (!r) { setMsg(t('oneClickCheckFailed')); return }
          if (r.stage === 'static' && !r.ok) {
            const first = (r.errors && r.errors[0] && r.errors[0].message) || t('oneClickCheckFailed')
            setMsg(t('oneClickCheckStaticFail', { detail: first }))
            return
          }
          if (r.pending || r.code === 'PROBE_NOT_IMPLEMENTED') {
            setMsg(t('oneClickCheckProbePending'))
            return
          }
          if (r.code === 'LLM_SERVICE_UNAVAILABLE') { setMsg(t('probeLlmUnavailable')); return }
          if (Array.isArray(r.results)) {
            if (!r.results.length) { setMsg(t('probeNoBindings')); return }
            setMsg(probeReport(r))
            return
          }
          if (r.ok) setMsg(t('oneClickCheckOk'))
          else setMsg(t('oneClickCheckFailed') + ((r.errors && r.errors[0] && r.errors[0].message) || ''))
        }).catch((e) => setMsg(t('oneClickCheckFailed') + String(e))).finally(() => setProbing(false))
      }
      // #74 UAT-02 反馈：探针结论按「节点序号」逐节点呈现，三级层级用视觉区分（不写 markdown 标记）：
      //   一级 = 整体结论；二级 = 一级节点（单列序号 0/1/2…）；三级 = 二级节点（同列并行 1.1/1.2…，如有）。
      // 序号直接复用画布的两级序号（layoutGraph().seqLabels），与节点卡片角标一一对应。
      // 图标：✅ 可用 / ❌ 不可用（带 host 侧清洗过的原因）/ ⚠️ 未定论（探针降级、探针内部错误、
      // 未返回结论）/ ➖ 未指定模型（继承会话模型）。同一绑定被多个节点引用时逐节点展开。
      const probeReport = (r) => {
        const all = Array.isArray(r.results) ? r.results : []
        const byNode = new Map()
        for (const x of all) for (const id of (x.nodes || [])) byNode.set(String(id), x)
        const nodes = (wf && Array.isArray(wf.nodes)) ? wf.nodes : []
        const blueprintModels = (wf && wf.bindings && wf.bindings.models) || null
        const modelOf = (n) => {
          if (n && n.model && (n.model.provider || n.model.model)) return n.model
          return (blueprintModels && blueprintModels[String(n && n.id)]) || null
        }
        // 画布两级序号：单列 "m"，同列并行 "m.1"/"m.2"；布局拿不到时退化为数组顺序
        let labels = {}
        try { labels = layoutGraph(wf || {}, []).seqLabels || {} } catch (e) { labels = {} }
        const seqOf = (n) => (labels[n.id] === undefined ? '' : String(labels[n.id]))
        const keyOf = (n) => {
          const parts = seqOf(n).split('.')
          const main = parts[0] === '' ? 1e6 : Number(parts[0])
          return [isFinite(main) ? main : 1e6, parts.length > 1 ? Number(parts[1]) || 0 : 0]
        }
        const ordered = nodes.slice().sort((a, b) => { const ka = keyOf(a); const kb = keyOf(b); return (ka[0] - kb[0]) || (ka[1] - kb[1]) })
        const rows = []
        const covered = new Set()
        let ok = 0
        let bad = 0
        let soft = 0
        let unbound = 0
        ordered.forEach((n) => {
          const seq = seqOf(n)
          // 二级节点（同列并行）进第三级缩进；一级节点（单列）进第二级
          const level = seq.indexOf('.') >= 0 ? 3 : 2
          const label = (seq ? seq + ' ' : '') + (n.label || n.id) + '（' + n.id + '）'
          const m = modelOf(n)
          const x = byNode.get(String(n.id)) || null
          if (!x) {
            if (!m) {
              unbound += 1
              rows.push({ level: level, tone: 'muted', text: '➖ ' + label + ' · ' + t('probeNodeInherit') })
              return
            }
            soft += 1
            rows.push({ level: level, tone: 'warn', text: '⚠️ ' + label + ' · ' + String(m.provider || 'default') + '/' + String(m.model || 'default') + ' · ' + t('probeNodeNotProbed') })
            return
          }
          covered.add(String(n.id))
          if (x.status === 'available') {
            ok += 1
            rows.push({ level: level, tone: 'ok', text: '✅ ' + label + ' · ' + x.provider + '/' + x.model + ' · ' + probeStatusText(x) + (x.cached ? t('probeCachedSuffix') : '') })
            return
          }
          const undecided = x.status === 'probe_degraded' || x.status === 'probe_internal_error'
          if (undecided) soft += 1
          else bad += 1
          rows.push({
            level: level, tone: undecided ? 'warn' : 'bad',
            text: (undecided ? '⚠️ ' : '❌ ') + label + ' · ' + x.provider + '/' + x.model + ' · ' + probeStatusText(x) +
              (x.message ? '：' + x.message : '') + (x.cached ? t('probeCachedSuffix') : ''),
          })
        })
        // 防御：结果里出现当前节点表未覆盖的绑定（DSL 与结果不同步）时也要如实呈现
        for (const x of all) {
          const rest = (x.nodes || []).filter((id) => !covered.has(String(id)) && !nodes.some((n) => String(n.id) === String(id)))
          if (!rest.length) continue
          if (x.status === 'available') ok += rest.length
          else if (x.status === 'probe_degraded' || x.status === 'probe_internal_error') soft += rest.length
          else bad += rest.length
          rows.push({
            level: 2, tone: x.status === 'available' ? 'ok' : 'bad',
            text: (x.status === 'available' ? '✅ ' : '❌ ') + x.provider + '/' + x.model + ' · ' + probeStatusText(x) +
              (x.message ? '：' + x.message : '') + t('probeBindingNodes', { nodes: rest.join('、') }),
          })
        }
        const total = ok + bad + soft + unbound
        const notes = []
        if (soft) notes.push(t('probeNoteSoft', { n: soft }))
        if (unbound) notes.push(t('probeNoteUnbound', { n: unbound }))
        const head = (bad === 0 ? '✅ ' + t('probeReportOk', { ok: ok, total: total }) : '❌ ' + t('probeReportFail', { total: total, bad: bad })) +
          (notes.length ? t('probeReportNotes', { notes: notes.join('，') }) : '')
        return { lines: [{ level: 1, tone: bad === 0 ? 'ok' : 'bad', text: head }].concat(rows) }
      }

      const editingBuiltin = !!(list || []).find(x => x.id === editId && x.builtin)
      // 流程库筛选：先按子页签（全部 / 内置 / 我的）收范围，再按名称 / ID / 摘要匹配，两者叠加
      const mineCount = (list || []).filter(w => !w.builtin).length
      const builtinCount = (list || []).length - mineCount
      const scopedList = libFilter === 'all' ? (list || []) : (list || []).filter(w => (libFilter === 'builtin') === !!w.builtin)
      const tplFilterNorm = tplFilter.trim().toLowerCase()
      const filteredList = !tplFilterNorm ? scopedList : scopedList.filter(w => {
        const hay = [w.name, w.id, w.description].map(x => String(x == null ? '' : x).toLowerCase()).join(' ')
        return hay.indexOf(tplFilterNorm) >= 0
      })
      // LOC-014 覆盖对话框行：每节点一行；两列下拉的"沿用默认"各自带出本列实际值
      // （provider 列显示默认 provider，model 列显示默认 model）；无 providers 回退文本输入
      const ovRows = () => {
        const models = (ovW && ovW.dsl && ovW.dsl.bindings && ovW.dsl.bindings.models && typeof ovW.dsl.bindings.models === 'object') ? ovW.dsl.bindings.models : {}
        const provList = (providers || []).map(p => p.id)
        const modelsOfProv = (pid) => (((providers || []).find(p => p.id === pid) || {}).models || [])
        const resolved = ovResolvedOf(ovW, ovDraft)
        return ((ovW && ovW.dsl && ovW.dsl.nodes) || []).map((n) => {
          const eff = (n.model && (n.model.provider || n.model.model)) ? n.model : (models[n.id] || null)
          const d = (ovDraft || {})[n.id] || {}
          const provKeep = t('modelOverrideKeepDefault') + '（' + (eff ? eff.provider : t('modelOverrideInherit')) + '）'
          const modelKeep = t('modelOverrideKeepDefault') + '（' + (eff ? eff.model : t('modelOverrideInherit')) + '）'
          const isOver = !!resolved[n.id]
          const curProv = String(d.provider || '').trim() || (eff ? String(eff.provider || '') : '')
          const provCtl = provList.length
            ? h(VwfSelect, { value: d.provider || '', options: [{ value: '', label: provKeep }].concat(provList.map(id => ({ value: id, label: id }))), onChange: (v) => ovSet(n.id, 'provider', v) })
            : h('input', { className: 'vwf-input vwf-mono', style: { width: 150 }, value: d.provider || '', placeholder: provKeep, onChange: (ev) => ovSet(n.id, 'provider', ev.target.value) })
          const modelCtl = provList.length
            ? h(VwfSelect, { value: d.model || '', options: [{ value: '', label: modelKeep }].concat(modelsOfProv(curProv).map(id => ({ value: id, label: id }))), onChange: (v) => ovSet(n.id, 'model', v) })
            : h('input', { className: 'vwf-input vwf-mono', style: { width: 170 }, value: d.model || '', placeholder: modelKeep, onChange: (ev) => ovSet(n.id, 'model', ev.target.value) })
          return h('div', { key: 'ov-row-' + n.id, className: 'vwf-list-item' },
            h('div', { style: { minWidth: 0, flex: 1 } },
              h('div', { className: 'vwf-row', style: { gap: 6 } },
                h('span', null, isOver ? '🔵' : '⚪'),
                h('span', { className: 'vwf-list-name' }, (n.label || n.id) + '（' + n.id + '）'),
                isOver
                  ? h('span', { className: 'vwf-badge', style: { color: 'var(--vwf-info)' } }, t('modelOverrideBadge'))
                  : h('span', { className: 'vwf-badge' }, t('modelOverrideDefaultBadge')),
                h('span', { className: 'vwf-muted-sm vwf-mono' }, t('modelOverrideCurrent') + (eff ? eff.provider + ' / ' + eff.model : t('modelOverrideInherit')))
              )
            ),
            h('div', { style: { width: 150 } }, provCtl),
            h('div', { style: { width: 170 } }, modelCtl),
            h('button', { className: 'vwf-btn sm', disabled: ovBusy || !isOver, onClick: () => ovSet(n.id, 'provider', '') || ovSet(n.id, 'model', '') }, t('modelOverrideResetRow'))
          )
        })
      }
      // 结果条按行分级渲染：一级加粗放大、二级缩进、三级再缩进一层；✅/❌/⚠️/➖ 决定色调。
      // 纯文本消息（保存/删除回执等）按单级普通行渲染。
      const renderMsg = (m) => {
        const rows = (m && Array.isArray(m.lines)) ? m.lines : String(m == null ? '' : m).split('\n').map((line) => ({ text: line }))
        return h('div', { className: 'vwf-code' },
          rows.map((row, i) => {
            const text = String(row.text == null ? '' : row.text)
            const tone = row.tone || (text.indexOf('❌') >= 0 ? 'bad'
              : text.indexOf('⚠️') >= 0 ? 'warn'
                : text.indexOf('✅') >= 0 ? 'ok'
                  : text.indexOf('➖') >= 0 ? 'muted' : '')
            return h('div', { key: 'msg-line-' + i, className: 'vwf-msg-line l' + (row.level || 0) + (tone ? ' ' + tone : '') }, text)
          })
        )
      }
      if (!i18nReady) return h('div', { className: 'vwf-muted' }, t('i18nLoading'))

      return h('div', { className: 'vwf-root' },
        // V-1：顶部导航为 流程库 / 运行 / 角色 三个页签；角色库有独立入口，
        // 不再嵌在模板编辑画布区域。运行页签常驻待处理计数（V-3，不随筛选与分页消失）。
        h('div', { className: 'vwf-tabs', role: 'tablist' },
          h('button', { className: 'vwf-tab' + (tab === 'templates' ? ' on' : ''), 'data-vwf-nav': 'templates', role: 'tab', 'aria-selected': tab === 'templates' ? 'true' : 'false', onClick: () => setTab('templates') }, t('templates')),
          h('button', { className: 'vwf-tab' + (tab === 'dashboard' ? ' on' : ''), 'data-vwf-nav': 'dashboard', role: 'tab', 'aria-selected': tab === 'dashboard' ? 'true' : 'false', onClick: () => setTab('dashboard') },
            t('dashboard'),
            attention ? h('span', { className: 'vwf-badge accent', 'aria-label': t('dashFilterAttention') + ' ' + attention }, String(attention)) : null
          ),
          h('button', { className: 'vwf-tab' + (tab === 'roles' ? ' on' : ''), 'data-vwf-nav': 'roles', role: 'tab', 'aria-selected': tab === 'roles' ? 'true' : 'false', onClick: () => setTab('roles') }, t('rolesTab'))
        ),
        tab === 'templates' ? h('div', { className: 'vwf-root' },
          h('div', { className: 'vwf-row' },
            h('button', { className: 'vwf-btn', onClick: onNew }, '＋ ' + t('newTemplate')),
            h('button', { className: 'vwf-btn', onClick: refresh }, t('refresh')),
            h('input', {
              className: 'vwf-input', style: { width: 220, marginLeft: 'auto' },
              value: tplFilter, placeholder: t('wbLibraryFilter'), 'aria-label': t('wbLibraryFilter'),
              onChange: (ev) => setTplFilter(ev.target.value),
            }),
            !providers.length ? h('span', { className: 'vwf-muted-sm' }, t('noModels')) : null
          ),
          // V-2：流程库子页签 全部 / 内置 / 我的（默认全部）；真按钮，键盘可达
          h('div', { className: 'vwf-row', role: 'tablist', 'aria-label': t('templates') },
            [['all', t('libFilterAll'), (list || []).length],
              ['builtin', t('libFilterBuiltin'), builtinCount],
              ['mine', t('libFilterMine'), mineCount]].map(([key, label, n]) => h('button', {
                key: key,
                role: 'tab',
                'data-vwf-lib-filter': key,
                'aria-selected': libFilter === key ? 'true' : 'false',
                className: 'vwf-btn sm' + (libFilter === key ? ' primary' : ''),
                onClick: () => setLibFilter(key),
              }, label + ' ' + n))
          ),
          h('div', { className: 'vwf-list' },
            filteredList.map(w => h('div', { key: w.id, className: 'vwf-list-item' },
              h('div', { style: { minWidth: 0, flex: 1 } },
                h('div', { className: 'vwf-row', style: { gap: 6 } },
                  h('span', { className: 'vwf-list-name' }, w.name || w.id),
                  h('span', { className: 'vwf-badge' }, w.id),
                  w.builtin ? h('span', { className: 'vwf-badge accent' }, t('builtinBadge')) : null,
                  w.modelOverridden ? h('span', { className: 'vwf-badge', style: { color: 'var(--vwf-info)' } }, t('modelOverrideBadge')) : null
                ),
                w.description ? h('div', { className: 'vwf-list-desc' }, w.description) : null
              ),
              // V-6：内置记录只有「查看流程 / 模型设置」，不提供删除（含置灰态）；
              // 自定义记录仍是「编辑 / 删除」，不回退。
              h('button', { className: 'vwf-btn sm', onClick: () => openEditor(w.id) }, t(w.builtin ? 'viewFlow' : 'editTemplate')),
              w.builtin
                ? h('button', { className: 'vwf-btn sm', onClick: () => openOv(w) }, t('modelOverride'))
                : h('button', { className: 'vwf-btn sm danger', onClick: () => onRemove(w.id) }, t('deleteTemplate'))
            )),
            list && !list.length ? h('div', { className: 'vwf-empty' }, '—') : null,
            list && list.length && !filteredList.length ? h('div', { className: 'vwf-empty' }, t('wbLibraryFilterEmpty')) : null
          )
        ) : null,
        tab === 'dashboard' ? h(Dashboard, { wf, onAttention: setAttention }) : null,
        tab === 'roles' ? h(RoleManager, { onChanged: refetchRoles }) : null,
        msg ? renderMsg(msg) : null,
        wf ? h('dialog', {
          className: 'vwf-editor-dialog',
          ref: editorDialogRef,
          'aria-label': t('title'),
          onClick: (ev) => { if (ev.target === ev.currentTarget) requestCloseEditor() },
          onCancel: (ev) => { ev.preventDefault(); requestCloseEditor() },
          onClose: closeEditor,
        },
          h('div', { className: 'vwf-editor-head' },
            h('strong', null, (wf.name || wf.id) + ''),
            editId ? h('span', { className: 'vwf-badge' }, editId) : h('span', { className: 'vwf-badge accent' }, t('newTemplate')),
            editingBuiltin ? h('span', { className: 'vwf-badge accent' }, t('builtinBadge')) : null,
            dirty ? h('span', { className: 'vwf-badge', style: { color: 'var(--vwf-warn)' } }, t('unsavedDraft')) : null,
            h('span', { className: 'vwf-spacer' }),
            h('button', { className: 'vwf-btn sm', onClick: requestCloseEditor }, t('close'))
          ),
          // 检测/探针结果同时显示在编辑器内：结果条若只渲染在外层主面板，
          // 会被全屏编辑器 dialog 完全遮挡（#74 UAT 反馈）
          msg ? h('div', { className: 'vwf-editor-msg' }, renderMsg(msg)) : null,
          h('div', { className: 'vwf-editor-body' },
            h(Editor, {
              key: editId || 'new',
              wf, providers, roles, saving, probing,
              currentId: editId,
              builtin: editingBuiltin,
              setWf: (next) => { setWf(next); setDirty(true) },
              onSaved: (id) => { onSaved(id); if (!editId) setEditId(id) },
              onOneClickCheck,
              onRolesChanged: refetchRoles,
              registerSave: (fn) => { editorSaveRef.current = fn },
            })
          ),
          confirmDiscardOpen ? h('div', { className: 'vwf-confirm-mask', onClick: () => setConfirmDiscardOpen(false) },
            h('div', { className: 'vwf-confirm', onClick: (ev) => ev.stopPropagation() },
              h('div', { className: 'vwf-confirm-title' }, t('wbUnsavedTitle')),
              h('div', { className: 'vwf-dialog-desc' }, t('wbUnsavedDesc')),
              h('div', { className: 'vwf-confirm-actions' },
                h('button', { className: 'vwf-btn', onClick: () => setConfirmDiscardOpen(false) }, t('wbUnsavedKeepEditing')),
                h('button', { className: 'vwf-btn danger', onClick: () => { setConfirmDiscardOpen(false); closeEditor() } }, t('wbUnsavedDiscard')),
                h('button', {
                  className: 'vwf-btn primary', disabled: saving,
                  onClick: () => {
                    setConfirmDiscardOpen(false)
                    // 校验失败时编辑器内会给出问题清单并留在原处，不静默丢弃输入
                    if (editorSaveRef.current) editorSaveRef.current()
                  },
                }, t('wbUnsavedSaveAndBack'))
              )
            )
          ) : null
        ) : null,
        ovId && ovW ? h('dialog', {
          className: 'vwf-editor-dialog',
          ref: ovDialogRef,
          'aria-label': t('modelOverride'),
          onClick: (ev) => { if (ev.target === ev.currentTarget) requestCloseOv() },
          onCancel: (ev) => { ev.preventDefault(); requestCloseOv() },
          onClose: closeOv,
        },
          h('div', { className: 'vwf-editor-head' },
            h('strong', null, t('modelOverride') + ' · ' + (ovW.name || ovW.id)),
            h('span', { className: 'vwf-badge' }, ovW.id),
            h('span', { className: 'vwf-spacer' }),
            h('button', { className: 'vwf-btn sm', onClick: requestCloseOv }, t('close'))
          ),
          h('div', { className: 'vwf-editor-body' },
            h('div', { className: 'vwf-muted-sm', style: { marginBottom: 8 } }, t('modelOverrideHelp')),
            h('div', { className: 'vwf-list' }, ovRows())
          ),
          h('div', { className: 'vwf-row', style: { justifyContent: 'flex-end', gap: 8, padding: '8px 0' } },
            h('button', { className: 'vwf-btn sm danger', disabled: ovBusy, onClick: () => setOvConfirm('clear') }, t('modelOverrideClear')),
            h('button', { className: 'vwf-btn sm', disabled: ovBusy, onClick: saveOv }, t('modelOverrideSave'))
          ),
          ovConfirm ? h('div', { className: 'vwf-confirm-mask', onClick: () => setOvConfirm(null) },
            h('div', { className: 'vwf-confirm', onClick: (ev) => ev.stopPropagation() },
              h('div', { className: 'vwf-confirm-title' }, ovConfirm === 'close' ? t('modelOverrideConfirmDiscard') : t('modelOverrideConfirmClear')),
              h('div', { className: 'vwf-confirm-actions' },
                h('button', { className: 'vwf-btn', onClick: () => setOvConfirm(null) }, t('discardCancel')),
                ovConfirm === 'close'
                  ? h('button', { className: 'vwf-btn danger', onClick: () => { setOvConfirm(null); closeOv() } }, t('discardConfirm'))
                  : h('button', { className: 'vwf-btn danger', disabled: ovBusy, onClick: doClearOv }, t('modelOverrideClear'))
              )
            )
          ) : null
        ) : null
      )
    }

    slots.inject('settings.section', () => slots.register(
      { name: 'settings.section', id: 'workflow-visual', order: 25, label: '工作流' },
      () => h(Page, null)
    ))
  },
}

// 注：本函数刻意定义在 return 之后 —— #175 起 build-bundle.mjs 要求压缩后的动态闭包体
// 必须以 return{ 开头（顶层不得出现任何前置语句）。函数声明会被提升，因此 return 中的
// buildSchemaTemplate 属性导出与 apply 内的调用均不受影响。

// ── 成功表达式解析正则（单一来源，防止与内核字面漂移）────────────────────────
// client.js 是浏览器动态闭包，无法 import scripts/validate-core.cjs，故此处保留一份
// 字面量；由 tests/schema-template.test.mjs 断言其 source 与内核 COND_RE 完全一致
// （防漂移门禁）。buildSchemaTemplate 一律经本函数取用，避免同一正则散落多处。
function conditionRegex() {
  return /^\$\.([A-Za-z0-9_.]+)\s*(==|!=)\s*(true|false|null|"([^"]*)"|-?\d+(\.\d+)?)$/
}

// ── 图语义副本（LOC-005 parity 门禁导出）：从 apply() 提升至闭包顶层 ─────────
// 与校验内核 scripts/validate-core.cjs 同名函数同构；字面漂移由
// tests/graph-semantics-parity.test.mjs 以内核权威侧同输入对拍锁定。
// 提升到顶层的唯一原因是可测试性（顶层导出），函数体逐字未动，行为不变。
function hasOutcomeField(e) {
  return !!(e && e.outcome !== undefined && e.outcome !== null && e.outcome !== '')
}
function isStructuralEdge(e) {
  return !!(e && (e.on === 'success' || hasOutcomeField(e)))
}
// 与校验内核同构：countRound 声明 / 自环 = 回退边，不参与入口入边与主链分层。
function isRollbackEdge(e) {
  if (!isStructuralEdge(e)) return false
  if (e.from === e.to) return true
  return e.countRound !== undefined
}
function deriveEntryCandidates(dsl) {
  // END_NODE / HUMAN_DECISION_ID 字面量内联：与 apply() 内同名常量一致，
  // 提升顶层后保持闭包「以 return{ 开头」形态，不引入 TDZ 引用。
  const ids = new Set((dsl.nodes || []).map(n => n && n.id).filter(Boolean))
  const incoming = new Set()
  ;(dsl.edges || []).forEach(e => {
    if (!isStructuralEdge(e) || isRollbackEdge(e)) return
    if (!e.to || e.to === '$end' || e.to === '$human-decision' || !ids.has(e.to)) return
    if (!(ids.has(e.from) || e.from === '$human-decision')) return
    incoming.add(e.to)
  })
  return (dsl.nodes || []).map(n => n && n.id).filter(id => Boolean(id) && !incoming.has(id))
}
// 编辑器 JSON tab 同时接受蓝图落盘格式（displayName / bindings.models）与 DSL。
// 投影规则必须与 scripts/validate-core.cjs 的 projectToVwf 对齐——勿在此分叉。
function ingestEditorJson(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) return raw
  const models = (raw.bindings && raw.bindings.models && typeof raw.bindings.models === 'object')
    ? raw.bindings.models : {}
  const hasBindings = Object.keys(models).length > 0
  if (typeof raw.displayName !== 'string' && !hasBindings) return raw
  const displayName = typeof raw.displayName === 'string' ? raw.displayName : (raw.name || raw.id || '')
  const nodes = raw.nodes.map((n) => {
    if (!n || typeof n !== 'object') return n
    if (n.model || !models[n.id]) return n
    return { ...n, model: models[n.id] }
  })
  const next = {
    id: raw.id,
    name: displayName,
    description: raw.description || '',
    entry: raw.entry,
    control: raw.control || { maxRounds: 9 },
    nodes,
    edges: raw.edges.map((e) => e),
  }
  if (raw.onMaxRounds !== undefined) next.onMaxRounds = raw.onMaxRounds
  // 异源档位三态（LOC-021）：旧布尔 true → weak、false → off；字符串原样透传；
  // 与 scripts/projection-core.cjs heteroModeForEdit 保持同一口径——勿在此分叉。
  if (raw.heteroCheck !== undefined && raw.heteroCheck !== null) {
    next.heteroCheck = raw.heteroCheck === true ? 'weak' : (raw.heteroCheck === false ? 'off' : raw.heteroCheck)
  }
  if (raw.bundleRoles) next.bundleRoles = true
  if (raw.humanDecision !== undefined) next.humanDecision = raw.humanDecision
  return next
}

// ── 角色来源与显示摘要（FEAT-86 收口）────────────────────────────────────────
// 来源按 `builtin` 布尔字段判定（规格 §9：不得通过角色名猜来源）；缺字段时按
// 布尔语义映射为自定义，与角色列表分区、节点角色选择器分组共用同一判定。
function roleOriginOf(role) {
  const builtin = !!(role && role.builtin)
  return { key: builtin ? 'builtin' : 'custom', builtin: builtin }
}

// 列表摘要（显示层）：显式 summary 优先；缺失时从职责 content 生成一段可读文本，
// 仅用于展示，不写回、不覆盖角色原文（规格 §9「摘要不写回原文」）。截断按字符
// 计数（Array.from 切分，不切断代理对）；两行显示上限由 CSS line-clamp 收敛，
// 连续长串靠 overflow-wrap:anywhere 换行，不产生横向溢出。
function roleSummaryOf(role, maxChars) {
  const limit = typeof maxChars === 'number' && maxChars > 0 ? maxChars : 120
  const explicit = role && typeof role.summary === 'string' ? role.summary.trim() : ''
  if (explicit) return explicit
  const raw = role && typeof role.content === 'string' ? role.content : ''
  const text = raw
    .replace(/```[\s\S]*?```/g, ' ')        // 代码块不参与摘要
    .replace(/^[ \t]{0,3}#{1,6}[ \t]*/gm, '') // 标题符号
    .replace(/^[ \t]{0,3}[-*+][ \t]+/gm, '')  // 列表符号
    .replace(/^[ \t]{0,3}>[ \t]?/gm, '')      // 引用符号
    .replace(/[ \t\r\n]+/g, ' ')
    .trim()
  if (!text) return ''
  const chars = Array.from(text)
  return chars.length > limit ? chars.slice(0, limit).join('') + '…' : text
}

// ── 基础 Schema 模板生成（独立纯函数，供 beautifySchema 空字段分支与单测复用）──
// 输入：{ kind: 'worker'|'fanout', successCondition?: string, verifyBranch?: boolean }
// 输出：标准 JSON Schema 对象（type/properties/required）。类型推导与多级路径展开
// 规则见 docs/design/output-schema-beautify-autofill-requirements.md；成功表达式
// 解析正则与 scripts/validate-core.cjs 的 COND_RE 保持一致（==/!= 字面量比较）。
function buildSchemaTemplate(input) {
  const opts = input || {}
  const kind = opts.kind === 'fanout' ? 'fanout' : 'worker'
  const schema = { type: 'object', properties: {}, required: [] }

  if (kind === 'worker') {
    const cond = typeof opts.successCondition === 'string' ? opts.successCondition.trim() : ''
    const m = conditionRegex().exec(cond)
    if (m) {
      // 按比较值推导叶子字段类型：==true/false→boolean、=="字符串"→string、
      // ==数字→number、推导不出（null 等）→string 兜底
      const token = m[3]
      const valueType = token === 'true' || token === 'false' ? 'boolean'
        : (token.length >= 2 && token.charCodeAt(0) === 34) ? 'string'
          : /^-?\d+(\.\d+)?$/.test(token) ? 'number'
            : 'string'
      // 多级路径 $.a.b == x 按嵌套对象展开；每一级路径都在父对象中标记 required
      const segments = m[1].split('.')
      let cursor = schema
      for (let i = 0; i < segments.length; i += 1) {
        const seg = segments[i]
        cursor.required.push(seg)
        if (i === segments.length - 1) {
          cursor.properties[seg] = { type: valueType }
        } else {
          let next = cursor.properties[seg]
          if (!next || typeof next !== 'object' || next.type !== 'object') {
            next = { type: 'object', properties: {}, required: [] }
            cursor.properties[seg] = next
          }
          cursor = next
        }
      }
    }
    // 可信度闸门：required 必须含 verified_branch 与 verified_head
    if (opts.verifyBranch === true) {
      if (!schema.properties.verified_branch) schema.properties.verified_branch = { type: 'string' }
      if (!schema.properties.verified_head) schema.properties.verified_head = { type: 'string' }
      if (schema.required.indexOf('verified_branch') < 0) schema.required.push('verified_branch')
      if (schema.required.indexOf('verified_head') < 0) schema.required.push('verified_head')
    }
  }

  return schema
}

// ── 边类型模型（与 validate-core 边规则同构）────────────────────────────────
// 引擎边定义 = on ∈ { success, failure, technical } ∪ 业务 outcome 边（与节点
// output.outcomePath 配套，可带 countRound）。UI 类型语义：
//   'success'/'failure' → on 同名边（when 仅 success）；'technical' → 技术重试自环；
//   'outcome' → 业务 outcome 边（HD 的 result 边沿 result 字段展示/编辑）。
// 编辑中 outcome 置空串仍按 outcome 类型呈现（表单不跳变）；空值由保存校验拦截。
function edgeKind(e) {
  if (!e || typeof e !== 'object') return 'success'
  if (e.outcome != null || (e.result != null && e.result !== '')) return 'outcome'
  if (e.on === 'technical' || e.on === 'failure') return e.on
  return 'success'
}

// 类型切换的字段互斥清理，与内核校验一一对应：
//   outcome 与 on 互斥；when 仅 success；countRound 仅业务边；technical 禁 when/countRound。
// 返回新对象，不改入参。
function applyEdgeKind(e, k) {
  const n = { ...(e || {}) }
  if (k === 'outcome') {
    delete n.on
    delete n.when
    if (!n.countRound) delete n.countRound
    if (n.outcome === undefined && n.result === undefined) n.outcome = ''
  } else {
    delete n.outcome
    delete n.result
    delete n.countRound
    n.on = k === 'technical' || k === 'failure' ? k : 'success'
    if (n.on !== 'success') delete n.when
  }
  return n
}

// 画布短标签：业务边显示 outcome 名（HD result 边同），其余按类型取文案。
// labels = { success, failure, technical }，由调用方传入 i18n 文案。
function edgeLabelText(e, l) {
  l = l || {}
  const v = e.outcome != null && e.outcome !== '' ? e.outcome : e.result != null && e.result !== '' ? e.result : null
  if (v != null) return String(v)
  if (e.on === 'technical') return l.technical || 'technical'
  if (e.on === 'failure') return l.failure || 'failure'
  return l.success || 'success'
}

// ── 连接分类（FEAT-84 §9/V-5）────────────────────────────────────────────────
// 三类互斥，且与「返工轮次」分开表述 —— 不得合并成同一个「重试」：
//   retry（调用重试）：on=technical 的技术自环，系统自动重发同一步骤，不消耗返工轮次
//   loop （业务回环）：显式计入打回轮次（countRound），或指向执行序上更早的步骤
//   normal（普通业务路由）：单向前进的业务结果去向
// orderOf(nodeId) 返回该节点的执行序位（画布分层序号），未知返回 null。
function connectionClassOf(edge, orderOf) {
  if (!edge || typeof edge !== 'object') return 'normal'
  if (edge.on === 'technical') return 'retry'
  if (edge.countRound === true) return 'loop'
  const from = orderOf ? orderOf(edge.from) : null
  const to = orderOf ? orderOf(edge.to) : null
  if (from != null && to != null && to < from) return 'loop'
  return 'normal'
}

// ── 业务结果路由模型（LOC-001 V2：录入体验改造）──────────────────────────────
// 契约不变原则：界面只让用户填「参数名 + 取值列表」，写入仍是内核既有形态
//   output.outcomePath = '$.<name>'
//   output.schema.properties.<name> = { type: 'string', enum: [...values] }
// schema 是取值列表的唯一真源（D2）：列表只是它的编辑器，改动即合并写回。

/** `$.route` → `route`；非单段路径返回 '' */
function routingNameOf(outcomePath) {
  if (typeof outcomePath !== 'string') return ''
  const m = /^\$\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(outcomePath.trim())
  return m ? m[1] : ''
}

/** 友好录入归一：接受 `route` / `$.route` / 含空白；非法返回 '' */
function normalizeRoutingName(input) {
  const raw = String(input == null ? '' : input).trim().replace(/^\$\./, '')
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(raw) ? raw : ''
}

function routingPathOf(name) {
  return name ? '$.' + name : ''
}

/** 与内核一致的「可穷举」判定：enum / oneOf 全常量 / const / boolean */
function enumerableValues(prop) {
  if (!prop || typeof prop !== 'object') return null
  if (Array.isArray(prop.enum) && prop.enum.length) return prop.enum.map(String)
  if (Array.isArray(prop.oneOf) && prop.oneOf.length) {
    const vals = prop.oneOf.filter((x) => x && x.const !== undefined).map((x) => String(x.const))
    if (vals.length === prop.oneOf.length) return vals
  }
  if (prop.const !== undefined) return [String(prop.const)]
  if (prop.type === 'boolean') return ['true', 'false']
  return null
}

/** schema 中可作路由字段的属性名候选（进档恢复 R6 用） */
function routingCandidates(schema) {
  const props = (schema && schema.properties) || {}
  return Object.keys(props).filter((k) => enumerableValues(props[k]))
}

/** 节点当前声明的取值列表（schema 权威） */
function routingValuesOf(node) {
  const out = (node && node.output) || null
  if (!out) return []
  const name = routingNameOf(out.outcomePath)
  if (!name) return []
  return enumerableValues(out.schema && out.schema.properties && out.schema.properties[name]) || []
}

/**
 * 写入：参数名 + 取值 → 新的 output（保留 schema 其它属性、required 与 files）。
 * 改名时清掉旧属性键，避免 schema 里留下孤儿枚举。
 */
function applyRoutingWrite(node, name, values) {
  const out = (node && node.output) || {}
  const baseSchema = (out.schema && typeof out.schema === 'object') ? out.schema : { type: 'object' }
  const properties = { ...(baseSchema.properties || {}) }
  const clean = (values || []).map((v) => String(v == null ? '' : v).trim()).filter((v) => v !== '')
  const prev = routingNameOf(out.outcomePath)
  if (name) {
    const prop = clean.length
      ? { type: 'string', enum: clean }
      : { type: 'string' }
    properties[name] = prop
    if (prev && prev !== name && properties[prev] !== undefined) delete properties[prev]
    const required = Array.isArray(baseSchema.required) ? baseSchema.required.slice() : []
    if (!required.includes(name)) required.push(name)
    return { ...out, schema: { ...baseSchema, properties, required }, outcomePath: routingPathOf(name) }
  }
  if (prev && properties[prev] !== undefined) delete properties[prev]
  return { ...out, schema: { ...baseSchema, properties }, outcomePath: routingPathOf('') }
}

/**
 * 边存在性（F3/F4）：对每个声明取值给出 { value, state, edgeIndexes }，
 * 并回出「用了未声明取值」的边。state ∈ ok | missing | duplicated。
 */
function routingEdgeStatus(dsl, nodeId) {
  const nodes = (dsl && dsl.nodes) || []
  const edges = (dsl && dsl.edges) || []
  const values = routingValuesOf(nodes.find((n) => n && n.id === nodeId))
  const rows = values.map((v) => {
    const hits = []
    edges.forEach((e, i) => {
      if (e && e.from === nodeId && e.outcome !== undefined && e.outcome !== null && String(e.outcome) === v) hits.push(i)
    })
    return { value: v, edgeIndexes: hits, state: hits.length === 0 ? 'missing' : (hits.length > 1 ? 'duplicated' : 'ok') }
  })
  const declared = {}
  values.forEach((v) => { declared[v] = true })
  const undeclared = []
  edges.forEach((e, i) => {
    if (!e || e.from !== nodeId) return
    if (e.outcome === undefined || e.outcome === null || e.outcome === '') return
    const v = String(e.outcome)
    if (!declared[v]) undeclared.push({ edgeIndex: i, value: v, to: e.to })
  })
  return { values: rows, undeclared }
}
