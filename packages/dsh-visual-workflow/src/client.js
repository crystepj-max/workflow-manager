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
//     终止节点、左右连接把手；边带流动虚线动画 + 箭头；成功边/标签为蓝色、
//     失败为红色、选中为主文字色加粗
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
//   - 边表单：边类型 / 目标 / when 条件（仅 success 边）/ 删除边
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
//  - 保留：画布工具栏文档流一行（不遮挡入口节点）、边标签统一成功/失败
//    （when 悬停 title 可见）
//
//  运行约束：动态客户端闭包（plain JS、无 JSX/import；React/host/styles 为
//  注入符号；计时器走 ctx.timeout/ctx.interval——inject: ['slots','timer']）。
// ─────────────────────────────────────────────────────────────────────────────

return {
  name: 'visual-workflow-client',
  inject: ['slots', 'timer'],
  buildSchemaTemplate: buildSchemaTemplate,
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
.vwf-root { display:flex; flex-direction:column; gap:12px; font-size:13px; color:var(--dsw-alias-label-primary, inherit); }
.vwf-row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.vwf-spacer { flex:1; }
.vwf-muted { color:var(--dsw-alias-label-secondary, #9a9a9a); font-size:12px; }
.vwf-muted-sm { color:var(--dsw-alias-label-tertiary, #8a8a8a); font-size:11px; }
.vwf-tabs { display:flex; gap:4px; border-bottom:1px solid var(--dsw-alias-border-l2, #333); }
.vwf-tab { padding:7px 14px; border:1px solid transparent; border-radius:8px 8px 0 0; cursor:pointer; color:var(--dsw-alias-label-secondary, #9a9a9a); font-size:13px; background:transparent; }
.vwf-tab.on { color:var(--dsw-alias-brand-text, var(--dsw-alias-brand-primary, #4d9fff)); border-color:var(--dsw-alias-border-l2, #333); border-bottom-color:transparent; background:var(--dsw-alias-bg-layer-2, #242424); }
.vwf-card { border:1px solid var(--dsw-alias-border-l2, #333); border-radius:12px; background:var(--dsw-alias-bg-layer-2, #242424); overflow:hidden; }
.vwf-card-head { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:10px 14px; border-bottom:1px solid var(--dsw-alias-border-l2, #333); flex-wrap:wrap; }
.vwf-card-title { font-size:14px; font-weight:600; color:var(--dsw-alias-label-primary, #e8e8e8); }
.vwf-btn { padding:6px 12px; border-radius:8px; border:1px solid var(--dsw-alias-border-l2, #333); background:var(--dsw-alias-button-tool-bar-fill, transparent); color:var(--dsw-alias-label-primary, #e8e8e8); cursor:pointer; font-size:12px; line-height:1.4; }
.vwf-btn:hover:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.06)); }
.vwf-btn:disabled { opacity:.45; cursor:not-allowed; }
.vwf-btn.primary { border-color:var(--dsw-alias-brand-primary, #4d9fff); background:var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #4d9fff)); color:var(--dsw-alias-label-primary-foreground, #fff); }
.vwf-btn.danger { color:var(--dsw-alias-state-error-primary, #e5484d); }
.vwf-btn.danger:hover:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover-danger, rgba(229,72,77,.12)); }
/* 画布顶部删除操作保持完整红色；禁用态不用透明度混色，避免在深色画布上发黑。 */
.vwf-canvas-toolbar .vwf-btn.danger,
.vwf-canvas-toolbar .vwf-btn.danger:disabled { color:var(--dsw-alias-state-error-primary, #e5484d); opacity:1; -webkit-text-fill-color:currentColor; }
.vwf-btn.ghost { border-color:transparent; background:transparent; }
.vwf-btn.sm { padding:3px 10px; font-size:12px; border-radius:99px; }
.vwf-badge { display:inline-block; padding:1px 8px; border-radius:99px; font-size:10px; border:1px solid var(--dsw-alias-border-l3, #444); color:var(--dsw-alias-label-secondary, #9a9a9a); }
.vwf-badge.accent { color:var(--dsw-alias-brand-text, var(--dsw-alias-brand-primary, #4d9fff)); border-color:currentColor; }
.vwf-list { display:flex; flex-direction:column; gap:8px; }
.vwf-list-item { display:flex; align-items:center; gap:10px; padding:10px 12px; border:1px solid var(--dsw-alias-border-l2, #333); border-radius:10px; background:var(--dsw-alias-bg-layer-1, #1e1e1e); }
.vwf-list-item:hover { border-color:var(--dsw-alias-border-l3, #444); }
.vwf-list-name { font-weight:600; font-size:13px; }
.vwf-list-desc { color:var(--dsw-alias-label-secondary, #9a9a9a); font-size:11px; margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:520px; }
.vwf-field { display:flex; flex-direction:column; gap:4px; margin-top:10px; }
.vwf-field-label { display:flex; align-items:center; gap:5px; font-size:12px; font-weight:500; color:var(--dsw-alias-label-secondary, #9a9a9a); }
.vwf-field-label .req { color:var(--dsw-alias-state-error-primary, #e5484d); }
.vwf-field-label.err { color:var(--dsw-alias-state-error-primary, #e5484d); }
.vwf-help { display:inline-flex; align-items:center; justify-content:center; width:14px; height:14px; border-radius:99px; border:1px solid var(--dsw-alias-border-l3, #555); color:var(--dsw-alias-label-tertiary, #8a8a8a); font-size:9px; cursor:help; }
.vwf-input, .vwf-select, .vwf-textarea { padding:6px 9px; border:1px solid var(--dsw-alias-border-l2, #333); border-radius:8px; background:var(--dsw-alias-bg-layer-1, #1e1e1e); color:var(--dsw-alias-label-primary, #e8e8e8); font:inherit; font-size:12px; width:100%; box-sizing:border-box; }
.vwf-select { appearance:auto; }
.vwf-textarea { resize:vertical; line-height:1.5; }
.vwf-mono { font-family:var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Consolas, monospace); }
.vwf-input.err, .vwf-select.err, .vwf-textarea.err { border-color:var(--dsw-alias-state-error-primary, #e5484d); }
.vwf-err-line { color:var(--dsw-alias-state-error-primary, #e5484d); font-size:11px; margin-top:2px; }
.vwf-ok-line { color:var(--dsw-alias-state-success-primary, #34d399); font-size:11px; margin-top:2px; }
.vwf-section { border:1px solid var(--dsw-alias-border-l2, #333); border-radius:10px; background:var(--dsw-alias-bg-layer-1, #1e1e1e); padding:10px 12px; margin-top:10px; }
.vwf-subsection { border:1px solid var(--dsw-alias-border-l2, #333); border-radius:8px; background:var(--dsw-alias-bg-layer-2, #242424); padding:10px 12px; margin-top:10px; }
.vwf-editor-dialog { --vwf-editor-safe-gap:clamp(12px, 3vw, 32px); position:fixed; inset:var(--vwf-editor-safe-gap); z-index:900; width:min(1440px, calc(100vw - var(--vwf-editor-safe-gap) - var(--vwf-editor-safe-gap))); height:min(920px, calc(100vh - var(--vwf-editor-safe-gap) - var(--vwf-editor-safe-gap))); max-width:none; max-height:none; margin:auto; padding:0; border:1px solid var(--dsw-alias-border-l2, #333); border-radius:18px; background:var(--dsw-alias-bg-layer-1, #1b1b1b); color:var(--dsw-alias-label-primary, #e8e8e8); box-shadow:0 24px 80px rgba(0,0,0,.48); overflow:hidden; }
.vwf-editor-dialog[open] { display:flex; flex-direction:column; }
.vwf-editor-dialog::backdrop { background:var(--dsw-alias-bg-mask-1, rgba(0,0,0,.56)); backdrop-filter:blur(2px); }
.vwf-editor-head { display:flex; align-items:center; gap:10px; padding:12px 16px; border-bottom:1px solid var(--dsw-alias-border-l2, #333); flex:0 0 auto; }
.vwf-editor-body { flex:1; min-height:0; overflow:auto; padding:14px 16px; overscroll-behavior:contain; }
.vwf-editor { display:grid; grid-template-columns:minmax(0,1fr) 340px; gap:12px; align-items:stretch; height:100%; min-height:0; }
@media (max-width: 900px) { .vwf-editor { grid-template-columns:minmax(0,1fr); height:auto; } .vwf-inspector { position:static; height:auto; } }
.vwf-canvas-col { min-width:0; min-height:0; display:flex; flex-direction:column; }
.vwf-canvas-col > .vwf-card { flex:1; min-height:0; display:flex; flex-direction:column; }
.vwf-canvas-wrap { position:relative; height:560px; overflow:auto; display:flex; border-top:1px solid var(--dsw-alias-border-l2, #333); background:var(--dsw-alias-bg-base, #181818); overscroll-behavior:contain; }
.vwf-editor .vwf-canvas-wrap { flex:1; min-height:360px; height:auto; }
.vwf-canvas-stage { flex:0 0 auto; width:max-content; height:max-content; box-sizing:border-box; margin:auto; padding:24px; cursor:grab; }
.vwf-canvas-stage:active { cursor:grabbing; }
/* 画布工具栏：文档流内一行（不再悬浮遮挡入口节点）；窄屏允许提示换行增高 */
.vwf-canvas-toolbar { display:flex; gap:8px; row-gap:6px; align-items:center; flex-wrap:wrap; padding:8px 12px; border-top:1px solid var(--dsw-alias-border-l2, #333); background:var(--dsw-alias-bg-layer-2, #242424); }
.vwf-canvas-toolbar .vwf-btn { flex:0 0 auto; min-height:28px; white-space:nowrap; }
.vwf-toolbar-hint { flex:1 1 240px; min-width:180px; margin-left:2px; line-height:1.45; overflow-wrap:anywhere; }
/* 画布顶部操作按钮组：图标圆形 + 文案，与 Gold-Band 交互形态一致 */
.vwf-toolbar-actions { display:inline-flex; align-items:stretch; border:1px solid var(--dsw-alias-border-l2, #333); border-radius:999px; background:var(--dsw-alias-bg-layer-2, #242424); overflow:hidden; }
.vwf-toolbar-action { display:inline-flex; align-items:center; gap:6px; padding:3px 10px; border:0; background:transparent; color:var(--dsw-alias-label-primary, #e8e8e8); cursor:pointer; font-size:12px; white-space:nowrap; }
.vwf-toolbar-action + .vwf-toolbar-action { border-left:1px solid var(--dsw-alias-border-l2, #333); }
.vwf-toolbar-action:hover:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.06)); }
.vwf-toolbar-action .vwf-toolbar-action-icon { display:inline-flex; align-items:center; justify-content:center; width:22px; height:22px; border-radius:999px; background:var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.08)); color:inherit; font-size:13px; }
.vwf-toolbar-action.danger,
.vwf-toolbar-action.danger:disabled { color:var(--dsw-alias-state-error-primary, #e5484d); opacity:1; -webkit-text-fill-color:currentColor; }
.vwf-toolbar-action.danger:hover:not(:disabled) { background:rgba(229,72,77,.1); }
.vwf-toolbar-action:disabled { cursor:not-allowed; }
/* 显示名历史撤销/重做按钮组 */
.vwf-history-group { display:inline-flex; border:1px solid var(--dsw-alias-border-l2, #333); border-radius:999px; background:var(--dsw-alias-bg-layer-2, #242424); overflow:hidden; }
.vwf-history-group .vwf-history-btn { border:0; border-radius:0; background:transparent; font-size:14px; min-width:28px; padding:3px 8px; }
.vwf-history-group .vwf-history-btn:disabled { opacity:.45; cursor:not-allowed; }
/* 角色库常驻区（issue-58 反馈）：画布右上角胶囊区；管理/新增入口不再依赖自定义角色数量 */
.vwf-role-zone { margin-left:auto; display:inline-flex; align-items:center; gap:2px; padding:3px 6px 3px 12px; border:1px solid var(--dsw-alias-brand-primary, #4d9fff); border-radius:999px; background:var(--dsw-alias-bg-layer-2, #242424); flex:0 0 auto; }
.vwf-role-zone-label { font-size:11px; font-weight:700; letter-spacing:.08em; color:var(--dsw-alias-brand-text, var(--dsw-alias-brand-primary, #4d9fff)); margin-right:8px; white-space:nowrap; }
.vwf-svg { display:block; user-select:none; touch-action:none; }
.vwf-menu { position:absolute; z-index:20; min-width:160px; padding:4px; border:1px solid var(--dsw-alias-border-l2, #333); border-radius:10px; background:var(--dsw-alias-bg-overlay, #2d2d2d); box-shadow:0 8px 28px rgba(0,0,0,.4); }
.vwf-menu-item { display:block; width:100%; text-align:left; padding:7px 10px; border:0; border-radius:7px; background:transparent; color:var(--dsw-alias-label-primary, #e8e8e8); font-size:12px; cursor:pointer; }
.vwf-menu-item:hover { background:var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.08)); }
.vwf-zoom { position:absolute; right:10px; bottom:10px; z-index:5; display:flex; flex-direction:column; border:1px solid var(--dsw-alias-border-l2, #333); border-radius:10px; overflow:hidden; background:var(--dsw-alias-bg-layer-2, #242424); }
.vwf-zoom button { width:30px; height:30px; border:0; border-bottom:1px solid var(--dsw-alias-border-l2, #333); background:transparent; color:var(--dsw-alias-label-secondary, #9a9a9a); cursor:pointer; font-size:14px; }
.vwf-zoom button:last-child { border-bottom:0; }
.vwf-zoom button:hover { background:var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.08)); }
.vwf-inspector { position:sticky; top:0; height:100%; min-height:0; overflow:auto; padding:12px; }
.vwf-empty { display:grid; place-items:center; min-height:120px; border:1px dashed var(--dsw-alias-border-l2, #333); border-radius:10px; color:var(--dsw-alias-label-secondary, #9a9a9a); font-size:12px; padding:16px; text-align:center; }
.vwf-dialog-mask { position:fixed; inset:0; z-index:950; background:var(--dsw-alias-bg-mask-1, rgba(0,0,0,.45)); display:flex; align-items:center; justify-content:center; }
.vwf-dialog { width:min(520px, 92vw); max-height:80vh; display:flex; flex-direction:column; border:1px solid var(--dsw-alias-border-l2, #333); border-radius:14px; background:var(--dsw-alias-bg-layer-1, #1e1e1e); box-shadow:0 24px 64px rgba(0,0,0,.5); padding:16px; gap:10px; }
.vwf-confirm-mask { position:fixed; inset:0; z-index:960; background:var(--dsw-alias-bg-mask-1, rgba(0,0,0,.45)); display:flex; align-items:center; justify-content:center; }
.vwf-confirm { width:min(360px, 90vw); display:flex; flex-direction:column; gap:14px; border:1px solid var(--dsw-alias-border-l2, #333); border-radius:14px; background:var(--dsw-alias-bg-layer-1, #1e1e1e); box-shadow:0 24px 64px rgba(0,0,0,.5); padding:18px; }
.vwf-confirm-title { font-size:14px; font-weight:600; color:var(--dsw-alias-label-primary, #e8e8e8); }
.vwf-confirm-actions { display:flex; justify-content:flex-end; gap:8px; }
.vwf-dialog-title { font-size:15px; font-weight:600; }
.vwf-dialog-desc { font-size:12px; color:var(--dsw-alias-label-secondary, #9a9a9a); }
.vwf-dialog-issues { max-height:300px; overflow:auto; display:flex; flex-direction:column; gap:6px; border:1px solid var(--dsw-alias-border-l2, #333); border-radius:10px; padding:10px; background:var(--dsw-alias-bg-base, #181818); }
.vwf-dialog-issue { padding:6px 10px; border-radius:8px; background:var(--dsw-alias-bg-layer-2, #242424); color:var(--dsw-alias-state-error-primary, #e5484d); font-size:12px; }
/* ── 角色库管理（issue-58）── */
.vwf-role-mgr { width:min(780px, 94vw); max-height:88vh; display:flex; flex-direction:column; border:1px solid var(--dsw-alias-border-l2, #333); border-radius:14px; background:var(--dsw-alias-bg-layer-1, #1e1e1e); box-shadow:0 24px 64px rgba(0,0,0,.5); padding:16px; gap:12px; overflow:hidden; }
.vwf-role-mgr-body { flex:1; min-height:0; overflow:auto; display:flex; flex-direction:column; gap:10px; }
.vwf-role-section-title { font-size:13px; font-weight:600; color:var(--dsw-alias-brand-text, var(--dsw-alias-brand-primary, #4d9fff)); margin-top:6px; }
.vwf-role-row { display:flex; align-items:center; gap:10px; padding:8px 10px; border:1px solid var(--dsw-alias-border-l2, #333); border-radius:10px; background:var(--dsw-alias-bg-layer-2, #242424); flex-wrap:wrap; }
.vwf-role-row .vwf-role-name { font-weight:600; font-size:13px; }
.vwf-role-row .vwf-role-summary { color:var(--dsw-alias-label-secondary, #9a9a9a); font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:400px; min-width:0; }
.vwf-role-content { white-space:pre-wrap; font-size:11px; line-height:1.55; max-height:340px; overflow:auto; border:1px solid var(--dsw-alias-border-l2, #333); border-radius:8px; padding:10px; background:var(--dsw-alias-bg-base, #181818); }
.vwf-role-refs { display:flex; flex-direction:column; gap:6px; max-height:200px; overflow:auto; border:1px solid var(--dsw-alias-border-l2, #333); border-radius:8px; padding:8px 10px; background:var(--dsw-alias-bg-base, #181818); font-size:11px; }
.vwf-role-ref-line { color:var(--dsw-alias-label-secondary, #9a9a9a); }
.vwf-role-empty { padding:14px; border:1px dashed var(--dsw-alias-border-l2, #333); border-radius:10px; color:var(--dsw-alias-label-secondary, #9a9a9a); font-size:12px; text-align:center; }
.vwf-status { font-size:11px; }
.vwf-status.ok { color:var(--dsw-alias-state-success-primary, #34d399); }
.vwf-status.err { color:var(--dsw-alias-state-error-primary, #e5484d); }
.vwf-code { white-space:pre-wrap; font-family:var(--dsw-font-family-mono, ui-monospace, monospace); font-size:11px; opacity:.9; max-height:320px; overflow:auto; border:1px solid var(--dsw-alias-border-l2, #333); border-radius:8px; padding:10px; background:var(--dsw-alias-bg-base, #181818); }
.vwf-table { width:100%; border-collapse:collapse; font-size:11px; }
.vwf-table th, .vwf-table td { text-align:left; padding:4px 8px; border-bottom:1px solid var(--dsw-alias-border-l2, #333); }
.vwf-table .vwf-fanout-group td { padding-top:9px; font-weight:600; color:var(--dsw-alias-brand-text, var(--dsw-alias-brand-primary, #4d9fff)); background:var(--dsw-alias-bg-layer-2, #242424); }
.vwf-json-edit { width:100%; height:520px; box-sizing:border-box; resize:none; font-family:var(--dsw-font-family-mono, ui-monospace, monospace); font-size:11px; line-height:1.6; }
/* ── SVG 画布 ── */
.vwf-edge-flow { stroke-dasharray:3 17; animation:vwf-dash 3.6s linear infinite; }
@keyframes vwf-dash { to { stroke-dashoffset:-20; } }
.vwf-edge-hit { stroke:transparent; stroke-width:16; fill:none; }
.vwf-node-card { fill:var(--dsw-alias-bg-layer-2, #242424); stroke:var(--dsw-alias-border-l2, #333); stroke-width:1; }
.vwf-node-kind { fill:var(--dsw-alias-label-tertiary, #8a8a8a); font-size:10px; letter-spacing:.14em; text-transform:uppercase; }
.vwf-node-label { fill:var(--dsw-alias-label-primary, #e8e8e8); font-size:13px; font-weight:500; }
.vwf-node-seq { fill:var(--dsw-alias-brand-text, var(--dsw-alias-brand-primary, #4d9fff)); font-size:11px; font-weight:700; font-variant-numeric:tabular-nums; }
.vwf-node-seq-badge { fill:var(--dsw-alias-bg-layer-1, #1e1e1e); stroke:var(--dsw-alias-brand-primary, #4d9fff); stroke-width:1; }
.vwf-handle { fill:var(--dsw-alias-label-tertiary, #8a8a8a); stroke:var(--dsw-alias-bg-layer-2, #242424); stroke-width:2; }
/* 节点左右连接把手（拖出/落入连线的源与目标指示）：默认隐藏，节点悬停时显示，
   避免没有对应边的节点右侧出现无意义灰点（验收反馈）。 */
.vwf-handle { opacity:0; pointer-events:none; transition:opacity .12s ease; }
/* 悬停高亮：把手以品牌色圆环醒目显示，避免与边起点圆点（同类槽位）混淆而不可见 */
g:hover > .vwf-handle { opacity:1; pointer-events:auto; fill:var(--dsw-alias-brand-primary, #4d9fff); stroke:var(--dsw-alias-bg-layer-2, #242424); stroke-width:3; filter:drop-shadow(0 0 4px var(--dsw-alias-brand-primary, #4d9fff)); }
.vwf-handle-src { cursor:crosshair; }
.vwf-handle-src:hover { fill:var(--dsw-alias-brand-primary, #4d9fff); }
.vwf-entry-badge { fill:var(--dsw-alias-bg-layer-1, #1e1e1e); stroke:var(--dsw-alias-border-l3, #444); }
.vwf-entry-badge-text { fill:var(--dsw-alias-label-secondary, #9a9a9a); font-size:10px; }
/* ── 滚动条常显样式（画布内纵向滚动 + 编辑层/面板/弹窗） ── */
.vwf-canvas-wrap::-webkit-scrollbar, .vwf-editor-body::-webkit-scrollbar, .vwf-inspector::-webkit-scrollbar, .vwf-dialog-issues::-webkit-scrollbar { width:10px; height:10px; }
.vwf-canvas-wrap::-webkit-scrollbar-thumb, .vwf-editor-body::-webkit-scrollbar-thumb, .vwf-inspector::-webkit-scrollbar-thumb, .vwf-dialog-issues::-webkit-scrollbar-thumb { background:var(--dsw-alias-border-l3, #444); border-radius:99px; border:2px solid transparent; background-clip:padding-box; }
.vwf-canvas-wrap::-webkit-scrollbar-track, .vwf-editor-body::-webkit-scrollbar-track, .vwf-inspector::-webkit-scrollbar-track, .vwf-dialog-issues::-webkit-scrollbar-track { background:transparent; }
`)

    const h = React.createElement

    // ── 图常量（对应 workflowGraph.ts）──────────────────────────────────────
    const NODE_W = 220
    const NODE_H = 66
    const TERM_W = 140
    const TERM_H = 44
    const NODE_SEP = 88
    const RANK_SEP = 116
    const EDGE_LANE_GAP = 82
    const EDGE_LANE_SEP = 38
    const EDGE_ROUTE_STUB = 34
    const EDGE_LABEL_W = 36
    const EDGE_LABEL_H = 18
    const MARGIN_X = 56
    const MARGIN_Y = 64
    const CANVAS_PAD = 24
    const END_NODE = '$end'
    const HUMAN_DECISION_ID = '$human-decision'
    const STATUS_COLOR = { running: 'var(--dsw-alias-brand-primary, #60a5fa)', pass: 'var(--dsw-alias-state-success-primary, #22c55e)', fail: 'var(--dsw-alias-state-error-primary, #ef4444)', human: 'var(--dsw-alias-state-warn-primary, #f59e0b)' }
    const EDGE_OK = '#2563eb'
    const EDGE_FAIL = 'var(--dsw-alias-state-error-primary, #f87171)'
    const EDGE_SELECTED = '#111827'
    const ACCENT = 'var(--dsw-alias-brand-primary, #60a5fa)'
    const SCHEMA_DEBOUNCE_MS = 2000
    const VALIDATE_DEBOUNCE_MS = 350

    function clone(x) { return JSON.parse(JSON.stringify(x)) }

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
      if (raw.heteroCheck) next.heteroCheck = true
      if (raw.bundleRoles) next.bundleRoles = true
      if (raw.humanDecision !== undefined) next.humanDecision = raw.humanDecision
      return next
    }

    // ── 拓扑与布局（对应 workflowGraph.ts 的 successTopologyOrder /
    //    deriveEntryCandidateIds / computeBackwardLanes / layoutSuccessPath）──
    // 两级序号：主序号 = 前向最长路列（横轴 0…n）；同列多节点 = m.1…m.k（纵轴）。
    // `$human-decision` 为透明跳板：A→HD→B 在排版上等价于前向边 A→B（回退旁路除外）。
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

    function deriveEntryCandidates(dsl) {
      const ids = new Set((dsl.nodes || []).map(n => n && n.id).filter(Boolean))
      const incoming = new Set()
      ;(dsl.edges || []).forEach(e => {
        if (!isStructuralEdge(e) || isRollbackEdge(e)) return
        if (!e.to || e.to === END_NODE || e.to === HUMAN_DECISION_ID || !ids.has(e.to)) return
        if (!(ids.has(e.from) || e.from === HUMAN_DECISION_ID)) return
        incoming.add(e.to)
      })
      return (dsl.nodes || []).map(n => n && n.id).filter(id => Boolean(id) && !incoming.has(id))
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

    // 分层布局：前向结构边（含 HD 透传）最长路定主序号；同列按拓扑序定子序号并纵向堆叠
    function layoutGraph(dsl, extraTerminals) {
      const nodeIds = (dsl.nodes || []).map(n => n.id).filter(Boolean)
      const idSet = new Set(nodeIds)
      const order = successTopologyOrder(dsl)
      const terminalIds = []
      ;(dsl.edges || []).forEach(e => { if (e.to === END_NODE && terminalIds.indexOf(END_NODE) < 0) terminalIds.push(END_NODE) })
      ;(extraTerminals || []).forEach(id => { if (terminalIds.indexOf(id) < 0) terminalIds.push(id) })
      const allIds = nodeIds.concat(terminalIds)
      const sizeOf = (id) => id === END_NODE ? { w: TERM_W, h: TERM_H } : { w: NODE_W, h: NODE_H }

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
      return { pos, W: maxX + MARGIN_X, H: contentBottom + MARGIN_Y, lanes, routes, order, seqLabels, rank }
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
        onChange: (ev) => props.onChange(ev.target.value),
      }, flat.map(renderOpt).concat(groups.map(g => h('optgroup', { key: g.group, label: g.group }, g.items.map(renderOpt)))))
    }

    // ── SVG 画布（编辑态与运行看板共用；readOnly 时无把手/菜单/连线）─────────
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
        if (props.readOnly) return
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
        const x1 = a.x + a.w
        const y1 = a.y + a.h / 2
        const x2 = b.x
        const y2 = b.y + b.h / 2
        const route = lay.routes.get(idx) || { kind: 'direct', yStart: y1, yEnd: y2, routed: false }
        const isFail = e.on === 'failure'
        const color = isFail ? EDGE_FAIL : EDGE_OK
        const selected = props.selectedEdge === idx
        let d
        let labelX
        let labelY
        if (route.routed) {
          const so = route.channelStart
          const to = route.channelEnd
          const laneY = route.laneY
          d = 'M ' + x1 + ' ' + route.yStart + ' L ' + so + ' ' + route.yStart + ' L ' + so + ' ' + laneY + ' L ' + to + ' ' + laneY + ' L ' + to + ' ' + route.yEnd + ' L ' + x2 + ' ' + route.yEnd
          labelX = route.labelX
          labelY = route.labelY
        } else {
          const mx = x1 + (x2 - x1) / 2
          const sy = route.yStart
          const ey = route.yEnd
          // 平行直连边：共享起点槽位/终点锚点，控制点横向微偏移分离曲线与命中路径
          const off = (route.parallelCount > 1 && route.parallelIndex != null)
            ? (route.parallelIndex - (route.parallelCount - 1) / 2) * 3
            : 0
          d = 'M ' + x1 + ' ' + sy + ' C ' + (mx + off) + ' ' + sy + ', ' + (mx + off) + ' ' + ey + ', ' + x2 + ' ' + ey
          labelX = mx
          labelY = (sy + ey) / 2
        }
        // 标签按实际短文案（成功/失败）估算为固定小矩形；若与节点或已有标签相碰，
        // 沿垂直方向持续让位。节点/既有标签都是有限集合，不设固定次数上限。
        let labelBox = { x: labelX - EDGE_LABEL_W / 2, y: labelY - EDGE_LABEL_H, w: EDGE_LABEL_W, h: EDGE_LABEL_H }
        const boxesOverlap = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
        while (true) {
          const hitsNode = Object.keys(pos).some(id => boxesOverlap(labelBox, pos[id]))
          const hitsLabel = labelRects.some(rect => boxesOverlap(labelBox, rect))
          if (!hitsNode && !hitsLabel) break
          labelY += EDGE_LABEL_H
          labelBox = { x: labelX - EDGE_LABEL_W / 2, y: labelY - EDGE_LABEL_H, w: EDGE_LABEL_W, h: EDGE_LABEL_H }
        }
        labelRects.push(labelBox)
        edgeEls.push(h('path', {
          key: 'e' + idx, d, fill: 'none',
          className: 'vwf-edge-flow',
          stroke: selected ? EDGE_SELECTED : color,
          strokeWidth: selected ? 4.2 : (isFail ? 2 : 2.2),
          opacity: isFail || route.routed ? 0.92 : 1,
          markerEnd: 'url(#vwf-arrow' + (selected ? '-sel' : isFail ? '-fail' : '') + ')',
        }))
        edgeEls.push(h('path', {
          key: 'eh' + idx, d, className: 'vwf-edge-hit',
          style: { cursor: props.readOnly ? 'default' : 'pointer' },
          onClick: (ev) => { ev.stopPropagation(); if (!props.readOnly && props.onEdgeClick) props.onEdgeClick(idx) },
        }))
        // 起始点统一小圆点（颜色跟随边的状态），终点由箭头标识。
        edgeEls.push(h('circle', {
          key: 'sd' + idx, className: 'vwf-edge-start', cx: x1, cy: route.yStart, r: 4,
          fill: selected ? EDGE_SELECTED : color,
          stroke: selected ? EDGE_SELECTED : color, strokeWidth: 1,
        }))
        // 边标签统一显示 成功/失败；when 条件悬停可见（title），表单/JSON 面板可编辑
        const lbl = isFail ? t('edgeFailure') : t('edgeSuccess')
        labelEls.push(h('text', {
          key: 'lb' + idx, x: labelX, y: labelY - 6, textAnchor: 'middle', fontSize: 11, fontWeight: selected ? 700 : 600,
          fill: selected ? EDGE_SELECTED : color,
          style: { paintOrder: 'stroke', stroke: selected ? 'rgba(255,255,255,.82)' : 'var(--dsw-alias-bg-base, #181818)', strokeWidth: 3 },
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
            h('circle', { className: 'vwf-handle', cx: 0, cy: p.h / 2, r: 4 })
          ))
          return
        }
        const stroke = isConnectTarget ? ACCENT : selected ? ACCENT : invalid ? 'var(--dsw-alias-state-error-primary, #e5484d)' : status ? STATUS_COLOR[status] : 'var(--dsw-alias-border-l2, #333)'
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
            style: isConnectTarget ? { filter: 'drop-shadow(0 0 10px ' + ACCENT + ')' } : selected ? { filter: 'drop-shadow(0 0 8px ' + ACCENT + ')' } : invalid ? { filter: 'drop-shadow(0 0 6px var(--dsw-alias-state-error-primary, #e5484d))' } : undefined,
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
          !props.readOnly ? h('circle', { className: 'vwf-handle', cx: 0, cy: p.h / 2, r: 4 }) : null,
          !props.readOnly ? h('circle', {
            className: 'vwf-handle vwf-handle-src', cx: p.w, cy: p.h / 2, r: 5,
            onPointerDown: (ev) => onSourceDown(id, ev),
          }) : null
        ))
      })

      // 连线中的临时线
      let connectEl = null
      if (connect && pos[connect.from]) {
        const a = pos[connect.from]
        const x1 = a.x + a.w
        const y1 = a.y + a.h / 2
        const mx = x1 + (connect.x - x1) / 2
        connectEl = h('path', {
          d: 'M ' + x1 + ' ' + y1 + ' C ' + mx + ' ' + y1 + ', ' + mx + ' ' + connect.y + ', ' + connect.x + ' ' + connect.y,
          fill: 'none', stroke: ACCENT, strokeWidth: 2, strokeDasharray: '6 5', markerEnd: 'url(#vwf-arrow-sel)',
        })
      }

      return h('div', { style: { position: 'relative' } },
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
                  h('circle', { cx: 1, cy: 1, r: 1, fill: 'var(--dsw-alias-border-l2, #333)' })),
                h('marker', { id: 'vwf-arrow', markerWidth: 8, markerHeight: 8, refX: 7, refY: 4, orient: 'auto' }, h('path', { d: 'M0,0 L8,4 L0,8 z', fill: EDGE_OK })),
                h('marker', { id: 'vwf-arrow-fail', markerWidth: 8, markerHeight: 8, refX: 7, refY: 4, orient: 'auto' }, h('path', { d: 'M0,0 L8,4 L0,8 z', fill: EDGE_FAIL })),
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
        return h('iframe', { sandbox: '', title: record.record_id, srcDoc: String(val || ''), style: { width: '100%', height: 220, border: '1px solid var(--dsw-alias-border-l2, #333)', borderRadius: 6, background: '#fff' } })
      }
      if (mt === 'text/markdown' || mt === 'text/plain') {
        return h('pre', { className: 'vwf-code', style: { maxHeight: 220, overflow: 'auto' } }, String(val ?? ''))
      }
      return h('pre', { className: 'vwf-code', style: { maxHeight: 220, overflow: 'auto' } }, JSON.stringify(val, null, 2))
    }

    function ArtifactFilesEditor(props) {
      const files = (props.node.output && props.node.output.files) || {}
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
        h(Field, { label: t('artifactFiles'), help: t('artifactFilesHelp'), errors: errorsFor('output.files') },
          entries.length ? entries.map(([path, kind]) => h('div', { key: path, className: 'vwf-row', style: { gap: 6, marginBottom: 6, flexWrap: 'wrap' } },
            h('input', {
              className: 'vwf-input vwf-mono', style: { flex: 2, minWidth: 140 }, value: path, placeholder: 'contract.md',
              onChange: (ev) => updateEntry(path, ev.target.value, kind),
            }),
            h(VwfSelect, {
              value: kind || 'markdown',
              options: ARTIFACT_KINDS.map((k) => ({ value: k, label: k })),
              onChange: (v) => updateEntry(path, path, v),
            }),
            h('button', { className: 'vwf-btn sm danger', type: 'button', onClick: () => removeEntry(path) }, t('removeArtifact'))
          )) : h('div', { className: 'vwf-muted-sm' }, '—'),
          h('button', { className: 'vwf-btn sm', type: 'button', style: { marginTop: 6 }, onClick: addEntry }, t('addArtifact'))
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
      const debounceRef = React.useRef(null)

      React.useEffect(() => { setIdDraft(node.id) }, [node.id])
      React.useEffect(() => {
        setSchemaDraft(node.output && node.output.schema ? JSON.stringify(node.output.schema, null, 2) : '')
        setSchemaError(null)
        setSchemaNotice(null)
        setSchemaDirty(false)
      }, [node.id])
      React.useEffect(() => () => { if (debounceRef.current) debounceRef.current() }, [])

      const validationEnabled = !!node.output
      const manualEnabled = !!node.manualCheck
      const resultMode = validationEnabled ? 'ai' : manualEnabled ? 'manual' : 'none'
      const isFanout = node.kind === 'fanout'
      const failOnValue = node.failOn === undefined ? 'all' : node.failOn
      const failOnMode = Number.isInteger(failOnValue) ? 'number' : failOnValue

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

      const commitNodeId = (value) => {
        if (value === node.id) { setIdDraft(node.id); return }
        props.onUpdate(node.id, { id: value })
      }

      const changeKind = (kind) => {
        if (kind === 'fanout') {
          const output = { ...(node.output || {}), schema: (node.output && node.output.schema) || null }
          delete output.successCondition
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
      // 角色选择区分内置/自定义（issue-58）：分组下拉 + 空自定义提示 + 管理入口
      const builtinRoles = roles.filter(r => r.builtin)
      const customRoles = roles.filter(r => !r.builtin)
      const roleLabel = (role) => (role && role.summary ? role.id + ' — ' + role.summary.slice(0, 24) : (role ? role.id : ''))
      const roleOptions = [{ value: '', label: t('selectProfile') }]
        .concat(builtinRoles.map(role => ({ value: role.id, label: roleLabel(role), title: role.summary || '', group: t('builtinRoles') })))
        .concat(customRoles.map(role => ({ value: role.id, label: roleLabel(role), title: role.summary || '', group: t('customRoles') })))
      // 当前值不在清单（旧工作流/宿主脏数据）时兜底保留展示
      if (node.profile && !roles.some(r => r.id === node.profile)) roleOptions.push({ value: node.profile, label: node.profile, title: '' })

      return h('div', { className: 'vwf-section' },
        h('div', { className: 'vwf-row' },
          h('strong', null, t('nodeConfig')),
          h('span', { className: 'vwf-spacer' }),
          h('span', { className: 'vwf-badge' }, isFanout ? 'fanout' : 'worker')
        ),
        h(Field, { label: t('nodeKind'), required: true, errors: errorsFor('kind') },
          h(VwfSelect, {
            value: isFanout ? 'fanout' : 'worker',
            invalid: errorsFor('kind').length > 0,
            options: [
              { value: 'worker', label: t('nodeKindWorker') },
              { value: 'fanout', label: t('nodeKindFanout') },
            ],
            onChange: changeKind,
          })
        ),
        h(Field, { label: t('nodeId'), required: true, errors: errorsFor('id') },
          h('input', {
            className: 'vwf-input' + (errorsFor('id').length ? ' err' : ''),
            value: idDraft,
            onChange: (ev) => setIdDraft(ev.target.value),
            onBlur: (ev) => commitNodeId(ev.target.value),
            onCompositionStart: () => setIdComposing(true),
            onCompositionEnd: (ev) => { setIdComposing(false); setIdDraft(ev.currentTarget.value); commitNodeId(ev.currentTarget.value) },
            onKeyDown: (ev) => { if (ev.key === 'Enter' && !idComposing) ev.currentTarget.blur() },
          })
        ),
        h(Field, { label: t('nodeLabel'), errors: errorsFor('label') },
          h('input', { className: 'vwf-input', value: node.label || '', onChange: (ev) => props.onUpdate(node.id, { label: ev.target.value }) })
        ),
        h(Field, { label: t('profile'), required: true, help: t('profileHelp'), errors: errorsFor('profile') },
          h(VwfSelect, {
            value: node.profile || '', invalid: errorsFor('profile').length > 0,
            options: roleOptions,
            onChange: (v) => props.onUpdate(node.id, { profile: v || null }),
          })
        ),
        h(Field, { label: t('agent'), required: true, errors: errorsFor('model.provider') },
          provOpts.length
            ? h(VwfSelect, {
                value: curProv,
                options: [{ value: '', label: t('selectAgent') }].concat(provOpts.map(id => ({ value: id, label: id }))),
                onChange: (v) => props.onUpdate(node.id, { model: { provider: v || undefined, model: undefined } }),
              })
            : h('input', { className: 'vwf-input', value: curProv, placeholder: 'deepseek-official', onChange: (ev) => props.onUpdate(node.id, { model: { provider: ev.target.value, model: curModel || undefined } }) })
        ),
        h(Field, { label: t('model'), required: true, errors: errorsFor('model.model') },
          providers.length
            ? h(VwfSelect, {
                value: curModel,
                options: [{ value: '', label: t('selectModel') }].concat(modelOpts.map(id => ({ value: id, label: id }))),
                onChange: (v) => props.onUpdate(node.id, { model: { provider: curProv || undefined, model: v || undefined } }),
              })
            : h('input', { className: 'vwf-input', value: curModel, placeholder: 'deepseek-v4-flash', onChange: (ev) => props.onUpdate(node.id, { model: { provider: curProv || undefined, model: ev.target.value || undefined } }) })
        ),
        h(Field, { label: t('goal'), required: true, help: isFanout ? t('fanoutItemsHelp') : undefined, errors: errorsFor('goal') },
          h('textarea', { className: 'vwf-textarea' + (errorsFor('goal').length ? ' err' : ''), rows: 3, value: node.goal || '', placeholder: isFanout ? t('fanoutGoalPlaceholder') : t('defaultNodeGoal'), onChange: (ev) => props.onUpdate(node.id, { goal: ev.target.value }) })
        ),
        isFanout ? h('div', { className: 'vwf-subsection' },
          h(Field, { label: t('fanoutItems'), required: true, help: t('fanoutItemsHelp'), errors: errorsFor('items') },
            h('input', {
              className: 'vwf-input vwf-mono' + (errorsFor('items').length ? ' err' : ''),
              value: node.items || '', placeholder: '$.args.items',
              onChange: (ev) => props.onUpdate(node.id, { items: ev.target.value }),
            })
          ),
          h(Field, { label: t('fanoutFailOn'), required: true, help: t('fanoutFailOnHelp'), errors: errorsFor('failOn') },
            h(VwfSelect, {
              value: failOnMode,
              invalid: errorsFor('failOn').length > 0,
              options: [
                { value: 'all', label: 'all' },
                { value: 'any', label: 'any' },
                { value: 'number', label: t('fanoutFailOnNumber') },
              ],
              onChange: (value) => props.onUpdate(node.id, { failOn: value === 'number' ? 0 : value }),
            }),
            failOnMode === 'number' ? h('input', {
              className: 'vwf-input' + (errorsFor('failOn').length ? ' err' : ''),
              type: 'number', min: 0, step: 1, value: failOnValue,
              onChange: (ev) => props.onUpdate(node.id, { failOn: Math.max(0, Math.trunc(Number(ev.target.value) || 0)) }),
            }) : null
          ),
          h(Field, { label: t('outputSchema'), help: t('perItemSchemaHelp'), errors: errorsFor('output.schema') },
            h('div', { style: { position: 'relative' } },
              h('textarea', {
                className: 'vwf-textarea vwf-mono' + (errorsFor('output.schema').length ? ' err' : ''),
                rows: 6, value: schemaDraft, placeholder: t('outputSchemaPlaceholder'),
                onChange: (ev) => onSchemaChange(ev.target.value),
                onBlur: () => { if (schemaDirty) { commitSchema(schemaDraft); setSchemaDirty(false) } },
              }),
              h('button', {
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
        ) : h('div', { className: 'vwf-subsection' },
          h('div', { style: { fontSize: 13, fontWeight: 500 } }, t('resultMode')),
          h('div', { className: 'vwf-muted-sm', style: { marginTop: 2 } }, t('resultModeDescription')),
          h('div', { className: 'vwf-field' },
            h(VwfSelect, {
              value: resultMode,
              options: [
                { value: 'none', label: t('resultModeNone') },
                { value: 'ai', label: t('outputValidation') },
                { value: 'manual', label: t('manualCheck') },
              ],
              onChange: (mode) => {
                setSchemaDraft('')
                setSchemaError(null)
                setSchemaDirty(false)
                if (mode === 'ai') props.onUpdate(node.id, { output: { schema: (node.output && node.output.schema) || null, successCondition: (node.output && node.output.successCondition) || '', files: (node.output && node.output.files) || undefined }, manualCheck: null })
                else if (mode === 'manual') props.onUpdate(node.id, { output: (node.output && node.output.files) ? { files: node.output.files } : null, manualCheck: true })
                else props.onUpdate(node.id, { output: (node.output && node.output.files) ? { files: node.output.files } : null, manualCheck: null })
              },
            })
          ),
          resultMode === 'ai' ? h('div', { className: 'vwf-muted-sm', style: { marginTop: 6 } }, t('outputValidationDescription')) : null,
          resultMode === 'manual' ? h('div', { className: 'vwf-muted-sm', style: { marginTop: 6 } }, t('manualCheckDescription')) : null,
          resultMode === 'ai' ? h('div', null,
            h(Field, { label: t('outputSchema'), required: true, help: t('outputSchemaHelp'), errors: errorsFor('output.schema') },
              h('div', { style: { position: 'relative' } },
                h('textarea', {
                  className: 'vwf-textarea vwf-mono' + (errorsFor('output.schema').length ? ' err' : ''),
                  rows: 6, value: schemaDraft, placeholder: t('outputSchemaPlaceholder'),
                  onChange: (ev) => onSchemaChange(ev.target.value),
                  onBlur: () => { if (schemaDirty) { commitSchema(schemaDraft); setSchemaDirty(false) } },
                }),
                h('button', {
                  className: 'vwf-btn sm', title: t('outputSchemaBeautify'),
                  style: { position: 'absolute', right: 6, top: 6 },
                  onMouseDown: (ev) => ev.preventDefault(),
                  onClick: beautifySchema,
                }, '✨')
              ),
              schemaError
                ? h('div', { className: 'vwf-err-line' }, schemaError)
                : (schemaNotice ? h('div', { className: 'vwf-ok-line' }, schemaNotice) : null)
            ),
            h(Field, { label: t('successCondition'), required: true, help: t('successConditionHelp'), errors: errorsFor('output.successCondition') },
              h('input', {
                className: 'vwf-input vwf-mono' + (errorsFor('output.successCondition').length ? ' err' : ''),
                value: (node.output && node.output.successCondition) || '', placeholder: '$.result == true',
                onChange: (ev) => props.onUpdate(node.id, { output: { ...(node.output || {}), successCondition: ev.target.value } }),
              })
            )
          ) : null,
          !isFanout ? h(ArtifactFilesEditor, { node, onUpdate: props.onUpdate, errorsFor }) : null
        )
      )
    }

    // ── 边配置表单（对应 EdgeInspector）──────────────────────────────────────
    function EdgeInspector(props) {
      const edge = props.edge
      const dsl = props.dsl
      const index = props.index
      const errorsFor = (field) => (props.fieldErrors || {})['edge:' + index + ':' + field] || []
      const targetOpts = (dsl.nodes || []).map(n => ({ value: n.id, label: (n.label ? n.label + ' · ' : '') + n.id })).concat([{ value: END_NODE, label: END_NODE + ' · ' + t('endNode') }])
      return h('div', { className: 'vwf-section' },
        h('div', { className: 'vwf-row' },
          h('strong', null, t('edgeConfig')),
          h('span', { className: 'vwf-spacer' }),
          h('button', { className: 'vwf-btn sm danger', onClick: props.onDelete }, t('deleteEdge'))
        ),
        h(Field, { label: t('edgeOutcome'), required: true, errors: errorsFor('on') },
          h(VwfSelect, {
            value: edge.on,
            options: [{ value: 'success', label: 'success' }, { value: 'failure', label: 'failure' }],
            onChange: (v) => props.onUpdate(index, { on: v }),
          })
        ),
        h(Field, { label: t('edgeTarget'), required: true, errors: errorsFor('to') },
          h(VwfSelect, {
            value: edge.to,
            options: targetOpts,
            onChange: (v) => props.onUpdate(index, { to: v }),
          })
        ),
        edge.on === 'success' ? h(Field, { label: t('edgeWhen'), help: t('edgeWhenHelp'), errors: errorsFor('when') },
          h('input', {
            className: 'vwf-input vwf-mono' + (errorsFor('when').length ? ' err' : ''),
            value: edge.when || '', placeholder: '$.need_integration_test == true',
            onChange: (ev) => props.onUpdate(index, { when: ev.target.value }),
          })
        ) : null
      )
    }

    // ── 角色库管理（issue-58）─────────────────────────────────────────────
    // 从节点配置的「管理角色」进入：列表（内置/自定义分区）→ 查看内置（只读 +
    // 基于此角色创建）→ 编辑/创建表单（名称唯一校验、被引用角色保存前影响范围
    // 确认、重命名仅零引用放行）→ 删除（零引用二次确认 / 有引用阻止并展示引用
    // 位置）。覆盖在编辑器之上（fixed 遮罩），节点未提交的草稿状态不受影响。
    function RoleManager(props) {
      const [roles, setRoles] = React.useState(null)
      const [view, setView] = React.useState(props.initialCreate ? 'form' : 'list')
      const [formMode, setFormMode] = React.useState(props.initialCreate ? 'create' : 'edit')
      const [current, setCurrent] = React.useState(null) // 查看/编辑中的角色详情（创建来源）
      const [draftName, setDraftName] = React.useState('')
      const [draftContent, setDraftContent] = React.useState('')
      const [error, setError] = React.useState(null)
      const [confirm, setConfirm] = React.useState(null) // {kind:'delete'|'blocked'|'impact', role?, usage?, name?, content?}
      const [saving, setSaving] = React.useState(false)
      const refetch = React.useCallback(() => {
        host.call('vwf.roles').then(r => setRoles((r && r.roles) || [])).catch(() => setRoles([]))
      }, [])
      React.useEffect(() => { refetch() }, [])
      const fmt = (tpl, vars) => {
        let s = String(tpl || '')
        for (const k of Object.keys(vars || {})) s = s.split('{' + k + '}').join(String(vars[k]))
        return s
      }

      const openView = (id) => {
        setCurrent(null); setError(null); setView('view')
        host.call('vwf.roles.get', { id }).then((r) => {
          if (r && r.ok) setCurrent(r.role)
          else setError((r && r.errors && r.errors[0] && r.errors[0].message) || t('roleSaveFailed'))
        }).catch((e) => setError(String(e)))
      }
      const openEdit = (id) => {
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
        setCurrent(source || null)
        setDraftName(source ? t('customRoleSuffix', { src: source.id }) : '')
        setDraftContent(source ? (source.content || '') : '')
        setFormMode('create')
        setError(null)
        setView('form')
      }
      // 自定义角色克隆：与内置「基于此角色创建」同路径（详情预填 + 走 create），
      // 但 current 保持 null —— create 分支用 current.builtin===false 判定编辑，
      // 克隆自定义角色必须走新建，否则会被当作 update 修改原角色。
      const openCloneCustom = (role) => {
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
          if (used) setConfirm({ kind: 'impact', usage: u, name: name, content: draftContent })
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
      const askDelete = (role) => {
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

      const roleRow = (role) => h('div', { key: role.id, className: 'vwf-role-row' },
        h('span', { className: 'vwf-role-name' }, role.id),
        h('span', { className: 'vwf-badge' + (role.builtin ? ' accent' : '') }, role.builtin ? t('builtinRoleBadge') : t('customRoleBadge')),
        role.summary ? h('span', { className: 'vwf-role-summary' }, role.summary) : null,
        h('span', { className: 'vwf-spacer' }),
        role.builtin
          ? h('button', { className: 'vwf-btn sm', onClick: () => openView(role.id) }, t('viewRole'))
          : h('button', { className: 'vwf-btn sm', onClick: () => openEdit(role.id) }, t('editRole')),
        !role.builtin ? h('button', { className: 'vwf-btn sm', onClick: () => openCloneCustom(role) }, t('cloneFromRole')) : null,
        !role.builtin ? h('button', { className: 'vwf-btn sm danger', onClick: () => askDelete(role) }, t('deleteRole')) : null
      )
      const builtinRows = (roles || []).filter(r => r.builtin)
      const customRows = (roles || []).filter(r => !r.builtin)

      let body = null
      if (view === 'list') {
        body = h('div', null,
          h('div', { className: 'vwf-muted-sm' }, t('roleMgmtHint')),
          h('div', { className: 'vwf-role-section-title' }, t('builtinRoles')),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 } },
            builtinRows.map(roleRow),
            !builtinRows.length ? h('div', { className: 'vwf-role-empty' }, t('roleLoading')) : null
          ),
          h('div', { className: 'vwf-role-section-title' }, t('customRoles')),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 } },
            customRows.map(roleRow),
            !customRows.length ? h('div', { className: 'vwf-role-empty' }, t('noCustomRoles')) : null
          ),
          h('div', { className: 'vwf-row', style: { justifyContent: 'flex-end', marginTop: 8 } },
            h('button', { className: 'vwf-btn primary', onClick: () => openCreate(null) }, '＋ ' + t('newRole'))
          )
        )
      } else if (view === 'view') {
        body = current
          ? h('div', null,
              h('div', { className: 'vwf-row' },
                h('span', { className: 'vwf-dialog-title' }, current.name || current.id),
                h('span', { className: 'vwf-badge accent' }, t('builtinRoleBadge'))
              ),
              h('div', { className: 'vwf-muted-sm' }, t('roleViewBuiltin')),
              h('div', { className: 'vwf-role-section-title' }, t('roleContent')),
              h('div', { className: 'vwf-role-content' }, current.content || ''),
              h('div', { className: 'vwf-row', style: { marginTop: 8, gap: 8 } },
                h('button', { className: 'vwf-btn primary', onClick: () => openCreate(current) }, t('createFromRole')),
                h('button', { className: 'vwf-btn sm', onClick: () => { setError(null); setView('list'); setCurrent(null) } }, t('back'))
              )
            )
          : h('div', { className: 'vwf-role-empty' }, t('roleLoading'))
      } else {
        body = h('div', null,
          h('div', { className: 'vwf-row' },
            h('span', { className: 'vwf-dialog-title' }, formMode === 'edit' ? t('editRole') + ' · ' + (current ? current.id : '') : t('newRole')),
            current && current.builtin === false ? h('span', { className: 'vwf-badge' }, t('customRoleBadge')) : null
          ),
          current && current.builtin === false ? h('div', { className: 'vwf-muted-sm' }, fmt(t('roleFromSource'), { src: current.id })) : null,
          h('div', { className: 'vwf-field' },
            h('div', { className: 'vwf-field-label' }, t('roleName'), h('span', { className: 'req' }, '*')),
            h('input', {
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
            h('div', { className: 'vwf-field-label' }, t('roleContent'), h(HelpDot, { text: t('roleContentHelp') }), h('span', { className: 'req' }, '*')),
            h('textarea', {
              className: 'vwf-textarea vwf-mono', rows: 12, value: draftContent, placeholder: t('roleContentPlaceholder'),
              onChange: (ev) => setDraftContent(ev.target.value),
            })
          ),
          h('div', { className: 'vwf-row', style: { justifyContent: 'flex-end', gap: 8 } },
            h('button', { className: 'vwf-btn', onClick: () => { setError(null); setView('list'); setCurrent(null) } }, t('cancelRole')),
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
                h('button', { className: 'vwf-btn', onClick: () => setConfirm(null) }, t('cancelRole')),
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
                h('div', { className: 'vwf-role-refs' },
                  usage.refs.map((w, wi) => h('div', { key: 'wf' + wi, className: 'vwf-role-ref-line' },
                    (w.workflowName || w.workflowId) + (w.builtin ? '（' + t('builtinRoleBadge') + '）' : '') + '：' +
                    w.nodes.map(n => n.label + '（' + n.id + '）').join('、')
                  ))
                )
              ) : null,
              h('div', { className: 'vwf-row', style: { justifyContent: 'flex-end' } },
                h('button', { className: 'vwf-btn primary', onClick: () => setConfirm(null) }, t('close'))
              )
            )
          )
        } else if (confirm.kind === 'impact') {
          overlay = h('div', { className: 'vwf-dialog-mask', style: { zIndex: 980 } },
            h('div', { className: 'vwf-dialog' },
              h('div', { className: 'vwf-dialog-title' }, t('roleUsageTitle')),
              h('div', { className: 'vwf-dialog-desc' }, fmt(t('roleUsageConfirm'), { n: confirm.usage.count })),
              h('div', { className: 'vwf-row', style: { justifyContent: 'flex-end', gap: 8 } },
                h('button', { className: 'vwf-btn', onClick: () => setConfirm(null) }, t('cancelRole')),
                h('button', { className: 'vwf-btn primary', onClick: confirmSave }, t('confirmSaveRole'))
              )
            )
          )
        }
      }

      return h('div', { className: 'vwf-dialog-mask', onClick: props.onClose },
        h('div', { className: 'vwf-role-mgr', onClick: (ev) => ev.stopPropagation() },
          h('div', { className: 'vwf-row' },
            h('div', { className: 'vwf-dialog-title' }, t('roleManager')),
            h('span', { className: 'vwf-spacer' }),
            h('button', { className: 'vwf-btn sm', onClick: props.onClose }, t('close'))
          ),
          error ? h('div', { className: 'vwf-err-line' }, error) : null,
          h('div', { className: 'vwf-role-mgr-body' }, body),
          overlay
        )
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
      const [roleUI, setRoleUI] = React.useState(null) // 角色管理浮层：null | 'list' | 'create'
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
          }).catch(() => {})
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

      // history: 'now' = 结构变更立即入栈；默认 debounce = 打字合并为一条
      const syncWorkflow = (next, opts) => {
        const mode = (opts && opts.history) || 'debounce'
        queueHistory(captureBefore(wf, jsonDraft, jsonError), mode)
        const normalized = normalizeEntry(next)
        setFieldErrors({})
        setInvalidNodeIds(new Set())
        setJsonError(null)
        setLiveErrors([])
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

      const updateEdge = (index, patch) => {
        const current = wf.edges[index]
        if (!current) return
        const updated = { ...current, ...patch }
        if (updated.on !== 'success') delete updated.when
        else if (patch.when !== undefined && !String(patch.when).trim()) delete updated.when
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
        const v = await host.call('vwf.validate', { dsl: toSave }).catch(() => null)
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
        h('div', { className: 'vwf-editor' },
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
                      onChange: (ev) => syncWorkflow({ ...wf, name: ev.target.value }),
                    }),
                    h('span', { className: 'vwf-field-label' }, t('templateId'), h('span', { className: 'req' }, '*')),
                    h('input', {
                      className: 'vwf-input vwf-mono', style: { width: 180 },
                      value: wf.id || '', placeholder: 'my-workflow',
                      onChange: (ev) => syncWorkflow({ ...wf, id: ev.target.value }),
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
                    h('button', { className: 'vwf-btn sm' + (tab === 'json' ? ' primary' : ''), onClick: () => setTab('json') }, 'JSON')
                  ),
                  h('button', {
                    className: 'vwf-btn sm',
                    disabled: !!props.probing || !(wf.nodes || []).length,
                    title: t('oneClickCheckHelp'),
                    onClick: () => { void props.onOneClickCheck() },
                  }, props.probing ? t('oneClickCheckRunning') : t('oneClickCheck')),
                  idChanged ? h('button', { className: 'vwf-btn sm', onClick: () => { void handleSave() } }, t('saveAs')) : null,
                  h('button', { className: 'vwf-btn sm primary', disabled: props.saving || !(wf.nodes || []).length || idChanged, onClick: () => { void handleSave() } }, t('saveWorkflow'))
                )
              ),
              tab === 'canvas' ? h('div', { className: 'vwf-canvas-toolbar' },
                h('div', { className: 'vwf-toolbar-actions' },
                  h('button', { className: 'vwf-toolbar-action', onClick: addNode },
                    h('span', { className: 'vwf-toolbar-action-icon' }, '＋'),
                    h('span', { className: 'vwf-toolbar-action-label' }, t('addNode'))
                  ),
                  h('button', { className: 'vwf-toolbar-action danger', disabled: !selectedNodeId, onClick: deleteSelectedNode },
                    h('span', { className: 'vwf-toolbar-action-icon' }, '−'),
                    h('span', { className: 'vwf-toolbar-action-label' }, t('deleteNode'))
                  )
                ),
                h('span', { className: 'vwf-muted-sm vwf-toolbar-hint' }, t('connectHint')),
                h('div', { className: 'vwf-role-zone', title: t('roleMgmtHint') },
                  h('span', { className: 'vwf-role-zone-label' }, '🎭 ' + t('roleLibrary')),
                  h('button', { className: 'vwf-btn sm', onClick: () => setRoleUI('list') }, t('manageRoles')),
                  h('button', { className: 'vwf-btn sm primary', onClick: () => setRoleUI('create') }, '＋ ' + t('newRole'))
                )
              ) : null,
              tab === 'canvas'
                ? h(Canvas, {
                    dsl: wf,
                    height: canvasHeight,
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
                : h('div', { style: { padding: 12, borderTop: '1px solid var(--dsw-alias-border-l2, #333)' } },
                    h('textarea', { className: 'vwf-textarea vwf-json-edit', value: jsonDraft, spellCheck: false, onChange: (ev) => onJsonChange(ev.target.value) }),
                    jsonError ? h('div', { className: 'vwf-err-line' }, jsonError) : null
                  )
            ),
            h('div', { className: 'vwf-status ' + (liveErrors.length ? 'err' : 'ok'), style: { marginTop: 6 } },
              liveErrors.length ? liveErrors.length + ' ' + t('validIssues') + '：' + liveErrors[0].message + (liveErrors.length > 1 ? ' …' : '') : t('validOk')
            )
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
                h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 } },
                  h('input', {
                    type: 'checkbox',
                    checked: !!wf.heteroCheck,
                    onChange: (ev) => updateMeta({ heteroCheck: ev.target.checked }),
                  }),
                  h('span', null, wf.heteroCheck ? 'ON' : 'OFF')
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
            selectedNode ? h(NodeInspector, { node: selectedNode, dsl: wf, fieldErrors, providers: props.providers, roles: props.roles, onUpdate: updateNode }) : null,
            selectedEdge ? h(EdgeInspector, { edge: selectedEdge, index: selectedEdgeIndex, dsl: wf, fieldErrors, onUpdate: updateEdge, onDelete: deleteSelectedEdge }) : null,
            !selectedNode && !selectedEdge ? h('div', { className: 'vwf-empty', style: { marginTop: 10 } }, t('selectHint')) : null
          )
        ),
        roleUI ? h(RoleManager, {
          initialCreate: roleUI === 'create',
          onClose: () => setRoleUI(null),
          onChanged: () => { if (props.onRolesChanged) props.onRolesChanged() },
          // 开放草稿（本编辑器未保存的 wf）：删除/重命名前把草稿引用一并计入保护
          draftDsl: wf,
        }) : null
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
      const statusBadge = (a) => h('span', {
        className: 'vwf-badge',
        style: { color: a.outcome === 'completed' ? STATUS_COLOR.pass : a.outcome === 'failed' ? STATUS_COLOR.fail : STATUS_COLOR.running },
      }, a.outcome)
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
      const color = s === 'DONE' ? STATUS_COLOR.pass : s === 'running' ? STATUS_COLOR.running : (s === 'WAITING_HUMAN' || s.indexOf('AWAITING_HUMAN_') === 0) ? STATUS_COLOR.human : STATUS_COLOR.fail
      const label = s === 'WAITING_HUMAN' ? t('dashWaitHuman') : s.indexOf('AWAITING_HUMAN_') === 0 ? t('dashHumanGate') : (s || '—')
      return h('span', { className: 'vwf-badge', style: { color: color } }, label)
    }
    function isActiveRunStatus(status) {
      const s = String(status || '')
      return s === 'running' || s === 'WAITING_HUMAN' || s.indexOf('AWAITING_HUMAN_') === 0
    }

    // 运行看板（#19 多 run 并行）：运行清单 + 切换、门禁卡片队列（一次裁决一张）、
    // closeout 串行警示条；同 taskId 互斥拒绝在 host 端 wf_run 边界执行。
    // 数据源 vwf.runs.list + vwf.state；画布按 workflowId 匹配模板 DSL。
    function Dashboard(props) {
      const [runId, setRunId] = React.useState('')
      const [snap, setSnap] = React.useState(null)
      const [runs, setRuns] = React.useState([])
      const [tplMap, setTplMap] = React.useState({})
      const [auto, setAuto] = React.useState(true)
      const [page, setPage] = React.useState(0)
      const [pageSize, setPageSize] = React.useState(20)
      React.useEffect(() => {
        host.call('vwf.workflows.list').then((l) => {
          const m = {}
          for (const w of l || []) m[w.id] = w.dsl || null
          setTplMap(m)
        }).catch(() => {})
      }, [])
      // 立即拉取所选 run 详情：点击行即时切换，不等下一个轮询周期；
      // seq 守卫防止慢响应回写覆盖新选择（连续切行竞态）
      const seqRef = React.useRef(0)
      const fetchState = (id) => {
        if (!id) return
        const seq = ++seqRef.current
        host.call('vwf.state', { runId: id }).then((r) => { if (seq === seqRef.current) setSnap(r) }).catch(() => {})
      }
      const selectRun = (id) => { setRunId(id); fetchState(id) }
      const refresh = React.useCallback(() => {
        host.call('vwf.runs.list').then((r) => setRuns((r && r.runs) || [])).catch(() => {})
        if (!runId) return
        fetchState(runId)
      }, [runId])
      React.useEffect(() => {
        if (!auto) return undefined
        return ctx.interval(refresh, 3000)
      }, [auto, refresh])
      React.useEffect(() => { refresh() }, [])
      const allRuns = React.useMemo(() => {
        return [...runs].sort((a, b) => ((b.startedAt || b.ts || 0) - (a.startedAt || a.ts || 0)) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
      }, [runs])
      const activeCount = allRuns.filter((r) => !r.supersededBy && isActiveRunStatus(r.status)).length
      const gates = allRuns.filter((r) => !r.supersededBy && (String(r.status) === 'WAITING_HUMAN' || String(r.status).indexOf('AWAITING_HUMAN_') === 0))
      // 分页：数据刷新（新 run 落盘 / 历史拉取）时回到第 0 页
      React.useEffect(() => { setPage(0) }, [allRuns.length])
      const totalPages = Math.max(1, Math.ceil(allRuns.length / pageSize))
      const safePage = Math.min(page, totalPages - 1)
      const start = safePage * pageSize
      const pageRuns = allRuns.slice(start, start + pageSize)
      const prevPage = () => setPage((p) => Math.max(0, p - 1))
      const nextPage = () => setPage((p) => Math.min(totalPages - 1, p + 1))
      const snapState = snap && snap.found ? snap.state : null
      const dsl = snapState ? (tplMap[snapState.workflowId] || null) : null
      const st = snapState && dsl ? mapStatus(snapState, dsl) : {}
      return h('div', { className: 'vwf-root' },
        activeCount >= 2 ? h('div', { className: 'vwf-code', style: { borderColor: STATUS_COLOR.human, marginBottom: 8 } },
          t('dashParallel', { n: activeCount })) : null,
        gates.length ? h('div', { className: 'vwf-card', style: { marginBottom: 8 } },
          h('div', { className: 'vwf-card-head' }, h('div', { className: 'vwf-card-title' }, t('dashGateQueue'))),
          h('div', { style: { padding: '4px 14px 10px' } },
            gates.map((g, i) => h('div', { key: g.id, style: { padding: '8px 0', borderTop: i ? '1px solid var(--dsw-alias-border-l2, #333)' : 'none' } },
              h('div', { className: 'vwf-row', style: { gap: 8, flexWrap: 'wrap' } },
                h('span', { className: 'vwf-badge accent' }, i === 0 ? t('dashDeciding') : t('dashQueued', { n: i + 1 })),
                h('strong', null, g.taskId || g.id),
                h('span', { className: 'vwf-muted-sm' }, (g.name || g.workflowId || '') + ' · ' + (String(g.status) === 'WAITING_HUMAN' ? t('dashHumanDecision', { reason: g.reason || '' }) : t('dashGateNode', { node: String(g.status).replace('AWAITING_HUMAN_', '') }))),
                statusBadge(g.status)
              ),
              h('div', { className: 'vwf-code', style: { marginTop: 4 } },
                String(g.status) === 'WAITING_HUMAN'
                  ? ('续跑：wf_run { taskId: "' + (g.taskId || '<taskId>') + '"' + (g.workflowId ? ', templateId: "' + g.workflowId + '"' : '') + ', decision_id: "' + (g.decision_id || '<decision_id>') + '", user_choice: "USER_ACCEPTED|ADD_BUDGET|STOP" }')
                  : ('续跑：wf_run { taskId: "' + (g.taskId || '<taskId>') + '"' + (g.workflowId ? ', templateId: "' + g.workflowId + '"' : '') + ', entry: "' + String(g.status).replace('AWAITING_HUMAN_', '') + '", approved: true|false }'))
            )))
        ) : null,
        h('div', { className: 'vwf-card', style: { marginBottom: 8 } },
          h('div', { className: 'vwf-card-head' },
            h('div', { className: 'vwf-card-title' }, t('dashRunList')),
            h('label', { className: 'vwf-row', style: { fontSize: 11 } },
              h('input', { type: 'checkbox', checked: auto, onChange: (ev) => setAuto(ev.target.checked) }),
              ' ' + t('dashAutoPoll')
            )
          ),
          h('div', { className: 'vwf-table-scroll', style: { maxHeight: 420, overflowY: 'auto' } },
            h('table', { className: 'vwf-table' },
              h('thead', null, h('tr', null, h('th', null, 'taskId'), h('th', null, t('dashWorkflow')), h('th', null, t('dashStatus')), h('th', null, t('dashPhase')), h('th', null, 'runId'))),
              h('tbody', null, pageRuns.map((r) => h('tr', { key: r.id, onClick: () => selectRun(r.id), style: { cursor: 'pointer', opacity: r.supersededBy ? 0.5 : 1 } },
                h('td', null, r.taskId || '—'),
                h('td', null, r.name || r.workflowId || '—'),
                h('td', null, r.supersededBy ? h('span', { className: 'vwf-badge' }, t('dashTakenOver')) : statusBadge(r.status)),
                h('td', null, r.phase || '—'),
                h('td', { className: 'vwf-muted-sm' }, r.id)
              )))
            )
          ),
          pageRuns && !pageRuns.length ? h('div', { className: 'vwf-empty' }, t('dashNoRuns')) : null,
          h('div', { className: 'vwf-row', style: { marginTop: 8, flexWrap: 'wrap', gap: 8, alignItems: 'center' } },
            h('span', { className: 'vwf-muted-sm' }, t('dashPage', { page: safePage + 1, total: totalPages, n: allRuns.length })),
            h('button', { className: 'vwf-btn sm', disabled: safePage === 0, onClick: prevPage }, t('dashPrev')),
            h('button', { className: 'vwf-btn sm', disabled: safePage >= totalPages - 1, onClick: nextPage }, t('dashNext')),
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
          h('button', { className: 'vwf-btn', onClick: refresh }, t('refresh'))
        ),
        snap === null
          ? h('div', { className: 'vwf-muted' }, t('dashPickRun'))
          : !snap.found
            ? h('div', { className: 'vwf-err-line' }, t('dashRunNotFound'))
            : h('div', null,
                h('div', null,
                  h('div', { className: 'vwf-row' },
                    h('span', null, t('dashStatusLabel', { status: snap.state.status })),
                    h('span', { className: 'vwf-muted' }, t('dashPhaseLabel', { phase: snap.state.phase || '—' })),
                    snap.state.taskId ? h('span', { className: 'vwf-muted' }, t('dashTaskIdLabel', { taskId: snap.state.taskId })) : null
                  ),
                  h('div', { className: 'vwf-row', style: { borderTop: '1px solid var(--dsw-alias-border-l2, #333)', marginTop: 6, paddingTop: 6 } },
                    h('span', { className: 'vwf-muted', style: { fontSize: 10 } }, t('dashLegend')),
                    h('span', { className: 'vwf-badge', style: { color: STATUS_COLOR.running } }, 'running'),
                    h('span', { className: 'vwf-badge', style: { color: STATUS_COLOR.pass } }, 'pass'),
                    h('span', { className: 'vwf-badge', style: { color: STATUS_COLOR.fail } }, 'fail'),
                    h('span', { className: 'vwf-badge', style: { color: STATUS_COLOR.human } }, t('dashHumanGate'))
                  )
                ),
                dsl ? h('div', { className: 'vwf-card', style: { marginTop: 8 } }, h(Canvas, { dsl, readOnly: true, statusMap: st })) : null,
                h('table', { className: 'vwf-table', style: { marginTop: 8 } },
                  h('thead', null, h('tr', null, h('th', null, t('dashColIndex')), h('th', null, t('dashColNode')), h('th', null, t('dashColPhase')), h('th', null, t('dashColResult')))),
                  h('tbody', null, dashboardAgentRows(snap.state.agents))
                ),
                (() => {
                  const arts = latestArtifactRecords(snap.state.formalRecords)
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
                        renderArtifactBody(rec)
                      )) : h('div', { className: 'vwf-muted-sm' }, t('noFormalArtifacts'))
                    )
                  )
                })(),
                h('div', { className: 'vwf-code', style: { marginTop: 8 } }, (snap.state.logs || []).slice(-20).join('\n'))
              )
      )
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
      const onOneClickCheck = () => {
        if (!wf || probing) return
        setProbing(true)
        host.call('vwf.probe', { dsl: wf }).then((r) => {
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
          if (r.ok) setMsg(t('oneClickCheckOk'))
          else setMsg(t('oneClickCheckFailed') + ((r.errors && r.errors[0] && r.errors[0].message) || ''))
        }).catch((e) => setMsg(t('oneClickCheckFailed') + String(e))).finally(() => setProbing(false))
      }

      const editingBuiltin = !!(list || []).find(x => x.id === editId && x.builtin)
      if (!i18nReady) return h('div', { className: 'vwf-muted' }, t('i18nLoading'))

      return h('div', { className: 'vwf-root' },
        h('div', { className: 'vwf-tabs' },
          h('button', { className: 'vwf-tab' + (tab === 'templates' ? ' on' : ''), onClick: () => setTab('templates') }, t('templates')),
          h('button', { className: 'vwf-tab' + (tab === 'dashboard' ? ' on' : ''), onClick: () => setTab('dashboard') }, t('dashboard'))
        ),
        tab === 'templates' ? h('div', { className: 'vwf-root' },
          h('div', { className: 'vwf-row' },
            h('button', { className: 'vwf-btn', onClick: onNew }, '＋ ' + t('newTemplate')),
            h('button', { className: 'vwf-btn', onClick: refresh }, t('refresh')),
            !providers.length ? h('span', { className: 'vwf-muted-sm' }, t('noModels')) : null
          ),
          h('div', { className: 'vwf-list' },
            (list || []).map(w => h('div', { key: w.id, className: 'vwf-list-item' },
              h('div', { style: { minWidth: 0, flex: 1 } },
                h('div', { className: 'vwf-row', style: { gap: 6 } },
                  h('span', { className: 'vwf-list-name' }, w.name || w.id),
                  h('span', { className: 'vwf-badge' }, w.id),
                  w.builtin ? h('span', { className: 'vwf-badge accent' }, t('builtinBadge')) : null
                ),
                w.description ? h('div', { className: 'vwf-list-desc' }, w.description) : null
              ),
              h('button', { className: 'vwf-btn sm', onClick: () => openEditor(w.id) }, t('editTemplate')),
              h('button', { className: 'vwf-btn sm danger', disabled: !!w.builtin, title: w.builtin ? t('builtinReadonly') : '', onClick: () => onRemove(w.id) }, t('deleteTemplate'))
            )),
            list && !list.length ? h('div', { className: 'vwf-empty' }, '—') : null
          )
        ) : null,
        tab === 'dashboard' ? h(Dashboard, { wf }) : null,
        msg ? h('div', { className: 'vwf-code' }, msg) : null,
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
            dirty ? h('span', { className: 'vwf-badge', style: { color: 'var(--dsw-alias-state-warn-primary, #f59e0b)' } }, t('unsavedDraft')) : null,
            h('span', { className: 'vwf-spacer' }),
            h('button', { className: 'vwf-btn sm', onClick: requestCloseEditor }, t('close'))
          ),
          h('div', { className: 'vwf-editor-body' },
            h(Editor, {
              key: editId || 'new',
              wf, providers, roles, saving, probing,
              currentId: editId,
              setWf: (next) => { setWf(next); setDirty(true) },
              onSaved: (id) => { onSaved(id); if (!editId) setEditId(id) },
              onOneClickCheck,
              onRolesChanged: refetchRoles,
            })
          ),
          confirmDiscardOpen ? h('div', { className: 'vwf-confirm-mask', onClick: () => setConfirmDiscardOpen(false) },
            h('div', { className: 'vwf-confirm', onClick: (ev) => ev.stopPropagation() },
              h('div', { className: 'vwf-confirm-title' }, t('confirmDiscard')),
              h('div', { className: 'vwf-confirm-actions' },
                h('button', { className: 'vwf-btn', onClick: () => setConfirmDiscardOpen(false) }, t('discardCancel')),
                h('button', { className: 'vwf-btn danger', onClick: () => { setConfirmDiscardOpen(false); closeEditor() } }, t('discardConfirm'))
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
    const m = /^\$\.([A-Za-z0-9_.]+)\s*(==|!=)\s*(true|false|null|"([^"]*)"|-?\d+(\.\d+)?)$/.exec(cond)
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
