// ─────────────────────────────────────────────────────────────────────────────
// visual-workflow · CLIENT 半（pkg-20，编辑模块 Gold-Band 对齐版）
//
// 参考 Gold-Band《工作流编辑器》（web/src/components/WorkflowEditor.tsx +
// workflowGraph.ts）对 pkg-19 的编辑模块做整体改造：
//
//  画布（对应 ReactFlow 画布 + workflowGraph 布局）
//   - 自动分层布局（success 主链最长路分层，LR），节点不可手拖——与 Gold-Band
//     nodesDraggable=false 一致；回退边（failure/指向更早节点）走上方法车道
//     布线（lane routing，同 computeBackwardLanes + WorkflowRoutedEdge 公式）
//   - 节点卡片 220x66（圆角 14、label + 类型小字、入口徽标）、$end 虚线圆形
//     终止节点、左右连接把手；边带流动虚线动画 + 箭头 + 成功/失败标签
//   - 交互：点选节点/边；从源把手拖出连线落到目标节点建边；右键画布弹出
//     「添加结束节点」菜单；滚轮缩放（指针锚定）+ 拖拽平移 + 缩放控件
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
//  宿主形态：设置→工作流 section 内为「模板库 + 运行看板」，点「编辑」弹出
//  右侧大抽屉（≈1120px，对应 Gold-Band 的 Sheet 抽屉）承载编辑器。
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
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return

    // ── i18n（zh 默认；locale 服务 active==='en' 时切英文）──────────────────
    const ZH = {
      title: '工作流编辑器',
      subtitle: '通过画布创建节点和边，并为每个节点绑定角色与模型；右键画布可添加结束节点。',
      templateName: '模板名称',
      templateId: '模板 ID',
      saveAs: '另存为',
      canvas: '画布',
      saveWorkflow: '保存工作流',
      getScript: '获取脚本',
      inspector: '配置面板',
      addNode: '新增节点',
      deleteNode: '删除节点',
      addEndTarget: '添加结束节点',
      nodeConfig: '节点配置',
      edgeConfig: '边配置',
      selectHint: '选择画布中的节点或边进行配置。',
      workflowControls: '工作流控制',
      workflowControlsHelp: '回合上限限制 failure 打回的最大轮次（1-9，留空默认 9）；异源检查声明 dev/review 必须异源；超限行为选打回超限后的处置。',
      maxRounds: '打回上限',
      maxRoundsHelp: '每个 failure 打回消耗一轮；系统约定上限 9，超过上限工作流失败。',
      heteroCheck: '异源检查',
      heteroCheckHelp: '声明 dev 与 review 节点必须异源（注入运行日志；异源硬规则全局强制，与开关无关）。',
      onMaxRounds: '超限行为',
      onMaxRoundsHelp: '打回超限后：return=直接终止；auto-reschedule=先做失败归因分析（归因/拆分/人工介入建议）再终止。',
      nodeId: '节点 ID',
      nodeLabel: '显示名',
      profile: '角色',
      selectProfile: '选择角色',
      profileHelp: '角色对应工作区 dsh/roles/<角色>.md 文件，运行时会把角色正文提供给 AI。',
      agent: 'Agent',
      selectAgent: '选择 Agent',
      model: '模型',
      selectModel: '默认模型',
      goal: '节点目标',
      defaultNodeGoal: '描述该节点需要完成的任务。',
      resultMode: '节点结果判定方式',
      resultModeDescription: 'AI 输出验证和人工 check 互斥；开启其中一个会自动关闭另一个。',
      resultModeNone: '不启用',
      outputValidation: 'AI 输出验证',
      outputValidationDescription: '要求 AI 按约束输出 JSON，并用成功表达式自动判断该节点是成功还是失败。',
      manualCheck: '人工 check',
      manualCheckDescription: '节点运行到此后暂停，由人工裁决成功或失败（AWAITING_HUMAN）。',
      outputSchema: 'JSON 输出约束',
      outputSchemaPlaceholder: '标准 JSON Schema，例如 {"type":"object","properties":{"result":{"type":"boolean"}},"required":["result"]}',
      outputSchemaHelp: '填写给 AI 的最终 JSON 输出结构（标准 JSON Schema）。保存时会校验成功表达式路径是否存在于其中。',
      outputSchemaBeautify: '美化 JSON',
      outputSchemaInvalid: 'JSON 格式无效，修正后才会写入工作流。',
      successCondition: '成功表达式',
      successConditionHelp: '填写用于判断节点成功的表达式，例如 $.result == true。支持多级路径。保存时会校验路径是否存在于 JSON 输出约束中。',
      edgeOutcome: '边类型',
      edgeTarget: '目标',
      edgeWhen: 'when 条件',
      edgeWhenHelp: '仅 success 边可带 when（$.path == value）。同一节点多条 success 出边时必须全部带 when。',
      deleteEdge: '删除边',
      validationDialogTitle: '工作流无法保存',
      validationDialogDescription: '请先处理以下问题。关闭弹窗后，对应字段会以红色标出。',
      validationDialogClose: '查看并修正',
      validOk: '✓ 校验通过',
      validIssues: '条校验问题',
      unnamedNode: '未命名节点',
      entryBadge: '入口',
      endNode: '结束',
      edgeSuccess: '成功',
      edgeFailure: '失败',
      templates: '模板库',
      dashboard: '运行看板',
      newTemplate: '新建模板',
      editTemplate: '编辑',
      deleteTemplate: '删除',
      builtinBadge: '内置',
      refresh: '刷新列表',
      close: '关闭',
      unsavedDraft: '有未保存改动',
      saved: '已保存 ',
      saveFailed: '保存失败：',
      deleted: '已删除 ',
      deleteFailed: '删除失败：',
      confirmDelete: '确认删除模板 ',
      builtinReadonly: '内置模板不可删除',
      noModels: '宿主未配置可用模型（vwf.models 返回空），provider/model 将保留文本输入。',
      zoomIn: '放大',
      zoomOut: '缩小',
      fitView: '适配视图',
      connectHint: '从节点右侧把手拖出连线到目标节点',
    }
    const EN = {
      title: 'Workflow Editor',
      subtitle: 'Create nodes and edges on the canvas and bind each node to a role and a model; right-click the canvas to add an end node.',
      templateName: 'Template name',
      templateId: 'Template ID',
      saveAs: 'Save As',
      canvas: 'Canvas',
      saveWorkflow: 'Save Workflow',
      getScript: 'Get Script',
      inspector: 'Inspector',
      addNode: 'Add Node',
      deleteNode: 'Delete Node',
      addEndTarget: 'Add End node',
      nodeConfig: 'Node Config',
      edgeConfig: 'Edge Config',
      selectHint: 'Select a node or edge on the canvas to configure it.',
      workflowControls: 'Workflow Controls',
      workflowControlsHelp: 'Max reject rounds limits failure loops (1-9, blank uses 9); heterogeneity declares dev/review must differ; onMaxRounds picks the over-limit behavior.',
      maxRounds: 'Max reject rounds',
      maxRoundsHelp: 'Each failure transition consumes one round; the workflow fails beyond the limit (system cap 9).',
      heteroCheck: 'Heterogeneity check',
      heteroCheckHelp: 'Declares dev and review must use different models (runtime log injection; the hard rule is global regardless of the switch).',
      onMaxRounds: 'Over-limit behavior',
      onMaxRoundsHelp: 'After max rounds: return=terminate; auto-reschedule=run failure attribution (attribution/split/human advice) then terminate.',
      nodeId: 'Node ID',
      nodeLabel: 'Label',
      profile: 'Profile',
      selectProfile: 'Select profile',
      profileHelp: 'A profile maps to dsh/roles/<profile>.md in the workspace; its content is provided to the AI at runtime.',
      agent: 'Agent',
      selectAgent: 'Select agent',
      model: 'Model',
      selectModel: 'Default model',
      goal: 'Goal',
      defaultNodeGoal: 'Describe what this node should accomplish.',
      resultMode: 'Node result mode',
      resultModeDescription: 'AI output validation and manual check are mutually exclusive; enabling either one disables the other.',
      resultModeNone: 'Disabled',
      outputValidation: 'AI Output Validation',
      outputValidationDescription: 'Require the AI to return constrained JSON, then use the success expression to decide success or failure.',
      manualCheck: 'Manual check',
      manualCheckDescription: 'The run pauses at this node (AWAITING_HUMAN) until a human decides success or failure.',
      outputSchema: 'JSON output constraint',
      outputSchemaPlaceholder: 'Standard JSON Schema, e.g. {"type":"object","properties":{"result":{"type":"boolean"}},"required":["result"]}',
      outputSchemaHelp: 'Define the final JSON shape for the AI (standard JSON Schema). Save validates that the success expression path exists in it.',
      outputSchemaBeautify: 'Beautify JSON',
      outputSchemaInvalid: 'Invalid JSON; fix it before it is written to the workflow.',
      successCondition: 'Success expression',
      successConditionHelp: 'Define how the node is considered successful, e.g. $.result == true. Nested paths supported. Save validates the path exists in the JSON output constraint.',
      edgeOutcome: 'Edge Type',
      edgeTarget: 'Target',
      edgeWhen: 'when condition',
      edgeWhenHelp: 'Only success edges may carry when ($.path == value). Multiple success out-edges must all carry when.',
      deleteEdge: 'Delete Edge',
      validationDialogTitle: 'Workflow cannot be saved',
      validationDialogDescription: 'Fix these issues first. After closing, invalid fields are highlighted in red.',
      validationDialogClose: 'Review and fix',
      validOk: '✓ Valid',
      validIssues: 'validation issue(s)',
      unnamedNode: 'Unnamed node',
      entryBadge: 'Entry',
      endNode: 'End',
      edgeSuccess: 'Success',
      edgeFailure: 'Failure',
      templates: 'Templates',
      dashboard: 'Runs',
      newTemplate: 'New Template',
      editTemplate: 'Edit',
      deleteTemplate: 'Delete',
      builtinBadge: 'built-in',
      refresh: 'Refresh',
      close: 'Close',
      unsavedDraft: 'Unsaved changes',
      saved: 'Saved ',
      saveFailed: 'Save failed: ',
      deleted: 'Deleted ',
      deleteFailed: 'Delete failed: ',
      confirmDelete: 'Delete template ',
      builtinReadonly: 'The built-in template cannot be deleted',
      noModels: 'No models configured on the host (vwf.models empty); provider/model fall back to text inputs.',
      zoomIn: 'Zoom in',
      zoomOut: 'Zoom out',
      fitView: 'Fit view',
      connectHint: 'Drag from the right handle of a node onto a target node to connect',
    }
    let localeService
    try { localeService = ctx.get('locale') } catch (e) { localeService = undefined }
    const isEn = () => {
      try {
        const snap = localeService && localeService.getSnapshot ? localeService.getSnapshot() : null
        return !!(snap && String(snap.active || '').toLowerCase().indexOf('en') === 0)
      } catch (e) { return false }
    }
    const t = (key) => (isEn() ? (EN[key] || ZH[key]) : ZH[key]) || key

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
.vwf-section { border:1px solid var(--dsw-alias-border-l2, #333); border-radius:10px; background:var(--dsw-alias-bg-layer-1, #1e1e1e); padding:10px 12px; margin-top:10px; }
.vwf-subsection { border:1px solid var(--dsw-alias-border-l2, #333); border-radius:8px; background:var(--dsw-alias-bg-layer-2, #242424); padding:10px 12px; margin-top:10px; }
.vwf-drawer-mask { position:fixed; inset:0; z-index:900; background:var(--dsw-alias-bg-mask-1, rgba(0,0,0,.4)); }
.vwf-drawer { position:fixed; top:0; right:0; bottom:0; z-index:901; width:min(1120px, 94vw); display:flex; flex-direction:column; background:var(--dsw-alias-bg-layer-1, #1b1b1b); border-left:1px solid var(--dsw-alias-border-l2, #333); box-shadow:-18px 0 48px rgba(0,0,0,.35); }
.vwf-drawer-head { display:flex; align-items:center; gap:10px; padding:12px 16px; border-bottom:1px solid var(--dsw-alias-border-l2, #333); }
.vwf-drawer-body { flex:1; min-height:0; overflow:auto; padding:14px 16px; }
.vwf-editor { display:grid; grid-template-columns:minmax(0,1fr) 340px; gap:12px; align-items:start; }
@media (max-width: 900px) { .vwf-editor { grid-template-columns:minmax(0,1fr); } }
.vwf-canvas-col { min-width:0; }
.vwf-canvas-wrap { position:relative; height:560px; overflow:auto; border-top:1px solid var(--dsw-alias-border-l2, #333); background:var(--dsw-alias-bg-base, #181818); }
/* 画布工具栏：文档流内一行（不再悬浮遮挡入口节点） */
.vwf-canvas-toolbar { display:flex; gap:6px; align-items:center; flex-wrap:wrap; padding:8px 12px; border-top:1px solid var(--dsw-alias-border-l2, #333); background:var(--dsw-alias-bg-layer-2, #242424); }
.vwf-svg { display:block; user-select:none; touch-action:none; }
.vwf-menu { position:absolute; z-index:20; min-width:160px; padding:4px; border:1px solid var(--dsw-alias-border-l2, #333); border-radius:10px; background:var(--dsw-alias-bg-overlay, #2d2d2d); box-shadow:0 8px 28px rgba(0,0,0,.4); }
.vwf-menu-item { display:block; width:100%; text-align:left; padding:7px 10px; border:0; border-radius:7px; background:transparent; color:var(--dsw-alias-label-primary, #e8e8e8); font-size:12px; cursor:pointer; }
.vwf-menu-item:hover { background:var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.08)); }
.vwf-zoom { position:absolute; right:10px; bottom:10px; z-index:5; display:flex; flex-direction:column; border:1px solid var(--dsw-alias-border-l2, #333); border-radius:10px; overflow:hidden; background:var(--dsw-alias-bg-layer-2, #242424); }
.vwf-zoom button { width:30px; height:30px; border:0; border-bottom:1px solid var(--dsw-alias-border-l2, #333); background:transparent; color:var(--dsw-alias-label-secondary, #9a9a9a); cursor:pointer; font-size:14px; }
.vwf-zoom button:last-child { border-bottom:0; }
.vwf-zoom button:hover { background:var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.08)); }
.vwf-inspector { position:sticky; top:0; max-height:calc(100vh - 140px); overflow:auto; padding:12px; }
.vwf-empty { display:grid; place-items:center; min-height:120px; border:1px dashed var(--dsw-alias-border-l2, #333); border-radius:10px; color:var(--dsw-alias-label-secondary, #9a9a9a); font-size:12px; padding:16px; text-align:center; }
.vwf-dialog-mask { position:fixed; inset:0; z-index:950; background:var(--dsw-alias-bg-mask-1, rgba(0,0,0,.45)); display:flex; align-items:center; justify-content:center; }
.vwf-dialog { width:min(520px, 92vw); max-height:80vh; display:flex; flex-direction:column; border:1px solid var(--dsw-alias-border-l2, #333); border-radius:14px; background:var(--dsw-alias-bg-layer-1, #1e1e1e); box-shadow:0 24px 64px rgba(0,0,0,.5); padding:16px; gap:10px; }
.vwf-dialog-title { font-size:15px; font-weight:600; }
.vwf-dialog-desc { font-size:12px; color:var(--dsw-alias-label-secondary, #9a9a9a); }
.vwf-dialog-issues { max-height:300px; overflow:auto; display:flex; flex-direction:column; gap:6px; border:1px solid var(--dsw-alias-border-l2, #333); border-radius:10px; padding:10px; background:var(--dsw-alias-bg-base, #181818); }
.vwf-dialog-issue { padding:6px 10px; border-radius:8px; background:var(--dsw-alias-bg-layer-2, #242424); color:var(--dsw-alias-state-error-primary, #e5484d); font-size:12px; }
.vwf-status { font-size:11px; }
.vwf-status.ok { color:var(--dsw-alias-state-success-primary, #34d399); }
.vwf-status.err { color:var(--dsw-alias-state-error-primary, #e5484d); }
.vwf-code { white-space:pre-wrap; font-family:var(--dsw-font-family-mono, ui-monospace, monospace); font-size:11px; opacity:.9; max-height:320px; overflow:auto; border:1px solid var(--dsw-alias-border-l2, #333); border-radius:8px; padding:10px; background:var(--dsw-alias-bg-base, #181818); }
.vwf-table { width:100%; border-collapse:collapse; font-size:11px; }
.vwf-table th, .vwf-table td { text-align:left; padding:4px 8px; border-bottom:1px solid var(--dsw-alias-border-l2, #333); }
.vwf-json-edit { width:100%; height:520px; box-sizing:border-box; resize:none; font-family:var(--dsw-font-family-mono, ui-monospace, monospace); font-size:11px; line-height:1.6; }
/* ── SVG 画布 ── */
.vwf-edge-flow { stroke-dasharray:3 17; animation:vwf-dash 3.6s linear infinite; }
@keyframes vwf-dash { to { stroke-dashoffset:-20; } }
.vwf-edge-hit { stroke:transparent; stroke-width:16; fill:none; }
.vwf-node-card { fill:var(--dsw-alias-bg-layer-2, #242424); stroke:var(--dsw-alias-border-l2, #333); stroke-width:1; }
.vwf-node-kind { fill:var(--dsw-alias-label-tertiary, #8a8a8a); font-size:10px; letter-spacing:.14em; text-transform:uppercase; }
.vwf-node-label { fill:var(--dsw-alias-label-primary, #e8e8e8); font-size:13px; font-weight:500; }
.vwf-handle { fill:var(--dsw-alias-label-tertiary, #8a8a8a); stroke:var(--dsw-alias-bg-layer-2, #242424); stroke-width:2; }
.vwf-handle-src { cursor:crosshair; }
.vwf-handle-src:hover { fill:var(--dsw-alias-brand-primary, #4d9fff); }
.vwf-entry-badge { fill:var(--dsw-alias-bg-layer-1, #1e1e1e); stroke:var(--dsw-alias-border-l3, #444); }
.vwf-entry-badge-text { fill:var(--dsw-alias-label-secondary, #9a9a9a); font-size:10px; }
/* ── 滚动条常显样式（画布内纵向滚动 + 抽屉/面板/弹窗） ── */
.vwf-canvas-wrap::-webkit-scrollbar, .vwf-drawer-body::-webkit-scrollbar, .vwf-inspector::-webkit-scrollbar, .vwf-dialog-issues::-webkit-scrollbar { width:10px; height:10px; }
.vwf-canvas-wrap::-webkit-scrollbar-thumb, .vwf-drawer-body::-webkit-scrollbar-thumb, .vwf-inspector::-webkit-scrollbar-thumb, .vwf-dialog-issues::-webkit-scrollbar-thumb { background:var(--dsw-alias-border-l3, #444); border-radius:99px; border:2px solid transparent; background-clip:padding-box; }
.vwf-canvas-wrap::-webkit-scrollbar-track, .vwf-drawer-body::-webkit-scrollbar-track, .vwf-inspector::-webkit-scrollbar-track, .vwf-dialog-issues::-webkit-scrollbar-track { background:transparent; }
`)

    const h = React.createElement

    // ── 图常量（对应 workflowGraph.ts）──────────────────────────────────────
    const NODE_W = 220
    const NODE_H = 66
    const TERM_W = 140
    const TERM_H = 44
    const NODE_SEP = 72
    const RANK_SEP = 116
    const MARGIN_X = 56
    const MARGIN_Y = 64
    const END_NODE = '$end'
    const STATUS_COLOR = { running: 'var(--dsw-alias-brand-primary, #60a5fa)', pass: 'var(--dsw-alias-state-success-primary, #22c55e)', fail: 'var(--dsw-alias-state-error-primary, #ef4444)', human: 'var(--dsw-alias-state-warn-primary, #f59e0b)' }
    const EDGE_OK = 'var(--dsw-alias-label-tertiary, #9a9a9a)'
    const EDGE_FAIL = 'var(--dsw-alias-state-error-primary, #f87171)'
    const ACCENT = 'var(--dsw-alias-brand-primary, #60a5fa)'
    const SCHEMA_DEBOUNCE_MS = 2000
    const VALIDATE_DEBOUNCE_MS = 350

    function clone(x) { return JSON.parse(JSON.stringify(x)) }

    // ── 拓扑与布局（对应 workflowGraph.ts 的 successTopologyOrder /
    //    deriveEntryCandidateIds / computeBackwardLanes / layoutSuccessPath）──
    function successTopologyOrder(dsl) {
      const ids = (dsl.nodes || []).map(n => n && n.id).filter(Boolean)
      const idSet = new Set(ids)
      const adjacency = new Map()
      const indegree = new Map()
      ids.forEach(id => { adjacency.set(id, []); indegree.set(id, 0) })
      ;(dsl.edges || []).forEach(e => {
        if (e.on !== 'success') return
        if (!idSet.has(e.from) || !idSet.has(e.to)) return
        adjacency.get(e.from).push(e.to)
        indegree.set(e.to, (indegree.get(e.to) || 0) + 1)
      })
      const queued = new Set()
      const queue = []
      const pushRoot = (id) => { if (!idSet.has(id) || queued.has(id)) return; queued.add(id); queue.push(id) }
      pushRoot(dsl.entry)
      ids.forEach(id => { if ((indegree.get(id) || 0) === 0) pushRoot(id) })
      const ordered = []
      while (queue.length) {
        const id = queue.shift()
        ordered.push(id)
        ;(adjacency.get(id) || []).forEach(next => {
          indegree.set(next, (indegree.get(next) || 0) - 1)
          if ((indegree.get(next) || 0) === 0) pushRoot(next)
        })
      }
      ids.forEach(id => { if (!queued.has(id)) ordered.push(id) })
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
      const order = successTopologyOrder({ ...dsl, entry: '' })
      const incoming = new Set()
      ;(dsl.edges || []).forEach(e => {
        if (!ids.has(e.from) || !ids.has(e.to)) return
        if (e.on !== 'success' && isBackwardEdge(e.from, e.to, order)) return
        incoming.add(e.to)
      })
      return (dsl.nodes || []).map(n => n.id).filter(id => Boolean(id) && !incoming.has(id))
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

    // 分层布局：success/前向边最长路定 rank，rank 内按拓扑序纵向堆叠并整体居中
    function layoutGraph(dsl, extraTerminals) {
      const nodeIds = (dsl.nodes || []).map(n => n.id).filter(Boolean)
      const idSet = new Set(nodeIds)
      const order = successTopologyOrder(dsl)
      const terminalIds = []
      ;(dsl.edges || []).forEach(e => { if (e.to === END_NODE && terminalIds.indexOf(END_NODE) < 0) terminalIds.push(END_NODE) })
      ;(extraTerminals || []).forEach(id => { if (terminalIds.indexOf(id) < 0) terminalIds.push(id) })
      const allIds = nodeIds.concat(terminalIds)
      const sizeOf = (id) => id === END_NODE ? { w: TERM_W, h: TERM_H } : { w: NODE_W, h: NODE_H }

      // rank：success + 前向非 success 边参与最长路（对应 layoutSuccessPath 的过滤）
      const rank = {}
      allIds.forEach(id => { rank[id] = 0 })
      let changed = true
      let guard = 0
      while (changed && guard++ < 100) {
        changed = false
        for (const e of (dsl.edges || [])) {
          if (!idSet.has(e.from)) continue
          if (!(idSet.has(e.to) || e.to === END_NODE)) continue
          if (e.on !== 'success' && isBackwardEdge(e.from, e.to, order)) continue
          if (rank[e.from] + 1 > (rank[e.to] || 0)) { rank[e.to] = rank[e.from] + 1; changed = true }
        }
      }
      const layers = new Map()
      allIds.forEach(id => {
        const r = rank[id] || 0
        if (!layers.has(r)) layers.set(r, [])
        layers.get(r).push(id)
      })
      const ranks = Array.from(layers.keys()).sort((a, b) => a - b)
      ranks.forEach(r => layers.get(r).sort((a, b) => (order.get(a) || 0) - (order.get(b) || 0)))

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
      return { pos, W: maxX + MARGIN_X, H: maxY + MARGIN_Y, lanes: computeBackwardLanes(dsl.edges || [], order), order }
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
      return h('select', {
        className: 'vwf-select' + (props.invalid ? ' err' : ''),
        value: props.value,
        onChange: (ev) => props.onChange(ev.target.value),
      }, (props.options || []).map(o => h('option', { key: o.value, value: o.value, title: o.title || '' }, o.label)))
    }

    // ── SVG 画布（编辑态与运行看板共用；readOnly 时无把手/菜单/连线）─────────
    function Canvas(props) {
      const dsl = props.dsl
      const wrapRef = React.useRef(null)
      const [scale, setScale] = React.useState(1)
      const [connect, setConnect] = React.useState(null) // {from, x, y}
      const [menu, setMenu] = React.useState(null) // {x, y}
      const panRef = React.useRef(null)
      const lay = React.useMemo(
        () => layoutGraph(dsl, props.visibleTerminals || []),
        [JSON.stringify({ n: (dsl.nodes || []).map(n => n.id), e: (dsl.edges || []).map(e => [e.from, e.to, e.on]), v: props.visibleTerminals || [] })]
      )
      const pos = lay.pos
      const W = lay.W
      const H = lay.H

      const fitView = React.useCallback(() => {
        const wrap = wrapRef.current
        if (!wrap) return
        const s = Math.min(1.2, Math.max(0.3, Math.min((wrap.clientWidth - 24) / W, (wrap.clientHeight - 24) / H)))
        setScale(s)
        ctx.timeout(() => {
          if (!wrapRef.current) return
          wrapRef.current.scrollLeft = Math.max(0, (W * s - wrapRef.current.clientWidth) / 2)
          wrapRef.current.scrollTop = 0
        }, 0)
      }, [W, H])
      const fittedRef = React.useRef(false)
      React.useEffect(() => {
        if (fittedRef.current) return
        fittedRef.current = true
        fitView()
      }, [fitView])
      React.useEffect(() => { props.registerFit && props.registerFit(fitView) }, [fitView])
      // 定位到指定节点（校验弹窗关闭后聚焦首个问题节点，对应 Gold-Band 的 setCenter）
      const posRef = React.useRef(pos)
      React.useEffect(() => { posRef.current = pos }, [pos])
      React.useEffect(() => {
        props.registerScrollTo && props.registerScrollTo((id) => {
          const p = posRef.current[id]
          const wrap = wrapRef.current
          if (!p || !wrap) return
          wrap.scrollLeft = Math.max(0, p.x * scaleRef.current - wrap.clientWidth / 2)
          wrap.scrollTop = Math.max(0, p.y * scaleRef.current - 60)
        })
      }, [])

      // 滚轮缩放（指针锚定）
      const scaleRef = React.useRef(scale)
      React.useEffect(() => { scaleRef.current = scale }, [scale])
      React.useEffect(() => {
        const wrap = wrapRef.current
        if (!wrap) return undefined
        const onWheel = (ev) => {
          ev.preventDefault()
          const rect = wrap.getBoundingClientRect()
          const px = ev.clientX - rect.left + wrap.scrollLeft
          const py = ev.clientY - rect.top + wrap.scrollTop
          const next = Math.min(1.6, Math.max(0.3, +(scaleRef.current * (ev.deltaY < 0 ? 1.12 : 0.89)).toFixed(3)))
          const ratio = next / scaleRef.current
          setScale(next)
          ctx.timeout(() => {
            if (!wrapRef.current) return
            wrapRef.current.scrollLeft = px * ratio - (ev.clientX - rect.left)
            wrapRef.current.scrollTop = py * ratio - (ev.clientY - rect.top)
          }, 0)
        }
        wrap.addEventListener('wheel', onWheel, { passive: false })
        return () => wrap.removeEventListener('wheel', onWheel)
      }, [])
      const toGraph = (ev) => {
        const wrap = wrapRef.current
        if (!wrap) return null
        const rect = wrap.getBoundingClientRect()
        return { x: (ev.clientX - rect.left + wrap.scrollLeft) / scale, y: (ev.clientY - rect.top + wrap.scrollTop) / scale }
      }

      // 空白拖拽平移
      const onPanePointerDown = (ev) => {
        if (connect) return
        const wrap = wrapRef.current
        if (!wrap) return
        panRef.current = { sx: ev.clientX, sy: ev.clientY, left: wrap.scrollLeft, top: wrap.scrollTop, moved: false }
        const move = (me) => {
          const p = panRef.current
          if (!p) return
          const dx = me.clientX - p.sx
          const dy = me.clientY - p.sy
          if (Math.abs(dx) + Math.abs(dy) > 3) p.moved = true
          wrap.scrollLeft = p.left - dx
          wrap.scrollTop = p.top - dy
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
        }
        const up = (ue) => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
          const p2 = toGraph(ue)
          const target = hitNode(p2)
          setConnect(null)
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
      ;(dsl.edges || []).forEach((e, idx) => {
        const a = pos[e.from]
        const b = pos[e.to]
        if (!a || !b) return
        const lane = lay.lanes.get(idx)
        const x1 = a.x + a.w
        const y1 = a.y + a.h / 2
        const x2 = b.x
        const y2 = b.y + b.h / 2
        const isFail = e.on === 'failure'
        const color = isFail ? EDGE_FAIL : EDGE_OK
        const selected = props.selectedEdge === idx
        let d
        let labelX
        let labelY
        if (lane !== undefined) {
          const so = x1 + 34
          const to = x2 - 34
          const laneY = Math.min(y1, y2) - 82 - lane * 38
          d = 'M ' + x1 + ' ' + y1 + ' L ' + so + ' ' + y1 + ' L ' + so + ' ' + laneY + ' L ' + to + ' ' + laneY + ' L ' + to + ' ' + y2 + ' L ' + x2 + ' ' + y2
          labelX = (so + to) / 2
          labelY = laneY
        } else {
          const mx = x1 + (x2 - x1) / 2
          d = 'M ' + x1 + ' ' + y1 + ' C ' + mx + ' ' + y1 + ', ' + mx + ' ' + y2 + ', ' + x2 + ' ' + y2
          labelX = mx
          labelY = (y1 + y2) / 2
        }
        edgeEls.push(h('path', {
          key: 'e' + idx, d, fill: 'none',
          className: 'vwf-edge-flow',
          stroke: selected ? ACCENT : color,
          strokeWidth: selected ? 3.4 : (isFail ? 2 : 2.2),
          opacity: isFail || lane !== undefined ? 0.92 : 1,
          markerEnd: 'url(#vwf-arrow' + (selected ? '-sel' : isFail ? '-fail' : '') + ')',
          style: selected ? { filter: 'drop-shadow(0 0 6px ' + ACCENT + ')' } : undefined,
        }))
        edgeEls.push(h('path', {
          key: 'eh' + idx, d, className: 'vwf-edge-hit',
          style: { cursor: props.readOnly ? 'default' : 'pointer' },
          onClick: (ev) => { ev.stopPropagation(); if (!props.readOnly && props.onEdgeClick) props.onEdgeClick(idx) },
        }))
        // 边标签统一显示 成功/失败；when 条件悬停可见（title），表单/JSON 面板可编辑
        const lbl = isFail ? t('edgeFailure') : t('edgeSuccess')
        labelEls.push(h('text', {
          key: 'lb' + idx, x: labelX, y: labelY - 6, textAnchor: 'middle', fontSize: 11, fontWeight: 600,
          fill: selected ? ACCENT : color,
          style: { paintOrder: 'stroke', stroke: 'var(--dsw-alias-bg-base, #181818)', strokeWidth: 3 },
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
        if (isTerm) {
          nodeEls.push(h('g', {
            key: 'n' + id, transform: 'translate(' + p.x + ',' + p.y + ')',
            style: { cursor: props.readOnly ? 'default' : 'pointer' },
            onClick: (ev) => { ev.stopPropagation(); if (!props.readOnly && props.onTerminalClick) props.onTerminalClick(id) },
          },
            h('rect', { width: p.w, height: p.h, rx: p.h / 2, fill: 'var(--dsw-alias-bg-layer-1, #1e1e1e)', stroke: 'var(--dsw-alias-border-l3, #555)', strokeWidth: 1, strokeDasharray: '5 4', opacity: 0.9 }),
            h('text', { x: p.w / 2, y: p.h / 2 + 4, textAnchor: 'middle', fontSize: 12, fill: 'var(--dsw-alias-label-secondary, #9a9a9a)' }, t('endNode')),
            h('circle', { className: 'vwf-handle', cx: 0, cy: p.h / 2, r: 4 })
          ))
          return
        }
        const stroke = selected ? ACCENT : invalid ? 'var(--dsw-alias-state-error-primary, #e5484d)' : status ? STATUS_COLOR[status] : 'var(--dsw-alias-border-l2, #333)'
        nodeEls.push(h('g', {
          key: 'n' + id, transform: 'translate(' + p.x + ',' + p.y + ')',
          style: { cursor: props.readOnly ? 'default' : 'pointer' },
          onClick: (ev) => { ev.stopPropagation(); if (!props.readOnly && props.onNodeClick) props.onNodeClick(id) },
        },
          h('rect', {
            className: 'vwf-node-card', width: p.w, height: p.h, rx: 14,
            stroke: stroke, strokeWidth: selected || invalid ? 2 : 1,
            style: selected ? { filter: 'drop-shadow(0 0 8px ' + ACCENT + ')' } : invalid ? { filter: 'drop-shadow(0 0 6px var(--dsw-alias-state-error-primary, #e5484d))' } : undefined,
          }),
          candidates.indexOf(id) >= 0 ? h('g', { key: 'eb' },
            h('rect', { className: 'vwf-entry-badge', x: -6, y: -9, width: 34, height: 16, rx: 8 }),
            h('text', { className: 'vwf-entry-badge-text', x: 11, y: 3, textAnchor: 'middle' }, t('entryBadge'))
          ) : null,
          h('text', { className: 'vwf-node-label', x: p.w / 2, y: p.h / 2 - 4, textAnchor: 'middle' }, (node && (node.label || node.id)) || id),
          h('text', { className: 'vwf-node-kind', x: p.w / 2, y: p.h / 2 + 15, textAnchor: 'middle' }, 'worker'),
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
        h('div', { className: 'vwf-canvas-wrap', ref: wrapRef, style: props.height ? { height: props.height } : undefined },
          h('svg', {
            className: 'vwf-svg', width: W * scale, height: H * scale, viewBox: '0 0 ' + W + ' ' + H,
            onPointerDown: onPanePointerDown,
            onClick: (ev) => { if (panRef.current && panRef.current.moved) return; if (props.onPaneClick) props.onPaneClick() },
            onContextMenu: onPaneContextMenu,
          },
            h('defs', null,
              h('pattern', { id: 'vwf-dots', width: 28, height: 28, patternUnits: 'userSpaceOnUse' },
                h('circle', { cx: 1, cy: 1, r: 1, fill: 'var(--dsw-alias-border-l2, #333)' })),
              h('marker', { id: 'vwf-arrow', markerWidth: 8, markerHeight: 8, refX: 7, refY: 4, orient: 'auto' }, h('path', { d: 'M0,0 L8,4 L0,8 z', fill: EDGE_OK })),
              h('marker', { id: 'vwf-arrow-fail', markerWidth: 8, markerHeight: 8, refX: 7, refY: 4, orient: 'auto' }, h('path', { d: 'M0,0 L8,4 L0,8 z', fill: EDGE_FAIL })),
              h('marker', { id: 'vwf-arrow-sel', markerWidth: 8, markerHeight: 8, refX: 7, refY: 4, orient: 'auto' }, h('path', { d: 'M0,0 L8,4 L0,8 z', fill: ACCENT }))
            ),
            h('rect', { width: W, height: H, fill: 'url(#vwf-dots)' }),
            edgeEls,
            nodeEls,
            connectEl,
            labelEls
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

    // ── 节点配置表单（对应 WorkerNodeInspector）──────────────────────────────
    function NodeInspector(props) {
      const node = props.node
      const dsl = props.dsl
      const errorsFor = (field) => (props.fieldErrors || {})['node:' + node.id + ':' + field] || []
      const [idDraft, setIdDraft] = React.useState(node.id)
      const [idComposing, setIdComposing] = React.useState(false)
      const [schemaDraft, setSchemaDraft] = React.useState(node.output && node.output.schema ? JSON.stringify(node.output.schema, null, 2) : '')
      const [schemaError, setSchemaError] = React.useState(null)
      const [schemaDirty, setSchemaDirty] = React.useState(false)
      const debounceRef = React.useRef(null)

      React.useEffect(() => { setIdDraft(node.id) }, [node.id])
      React.useEffect(() => {
        setSchemaDraft(node.output && node.output.schema ? JSON.stringify(node.output.schema, null, 2) : '')
        setSchemaError(null)
        setSchemaDirty(false)
      }, [node.id])
      React.useEffect(() => () => { if (debounceRef.current) debounceRef.current() }, [])

      const validationEnabled = !!node.output
      const manualEnabled = !!node.manualCheck
      const resultMode = validationEnabled ? 'ai' : manualEnabled ? 'manual' : 'none'

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
        setSchemaDirty(true)
        if (debounceRef.current) debounceRef.current()
        debounceRef.current = ctx.timeout(() => {
          commitSchema(value)
          setSchemaDirty(false)
        }, SCHEMA_DEBOUNCE_MS)
      }
      const beautifySchema = () => {
        if (!schemaDraft.trim()) { setSchemaDirty(false); commitSchema(schemaDraft); return }
        try {
          const formatted = JSON.stringify(JSON.parse(schemaDraft), null, 2)
          setSchemaDraft(formatted)
          setSchemaDirty(false)
          props.onUpdate(node.id, { output: { ...(node.output || {}), schema: JSON.parse(schemaDraft) } })
          setSchemaError(null)
        } catch (e) {
          setSchemaError(t('outputSchemaInvalid'))
        }
      }

      const commitNodeId = (value) => {
        if (value === node.id) { setIdDraft(node.id); return }
        props.onUpdate(node.id, { id: value })
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
      const roleOpts = roles.map(r => r.id)
      if (node.profile && roleOpts.indexOf(node.profile) < 0) roleOpts.push(node.profile)

      return h('div', { className: 'vwf-section' },
        h('div', { className: 'vwf-row' },
          h('strong', null, t('nodeConfig')),
          h('span', { className: 'vwf-spacer' }),
          h('span', { className: 'vwf-badge' }, 'worker')
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
            options: [{ value: '', label: t('selectProfile') }].concat(roleOpts.map(id => {
              const role = roles.find(r => r.id === id)
              return { value: id, label: role && role.summary ? id + ' — ' + role.summary.slice(0, 24) : id, title: role ? role.summary : '' }
            })),
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
          modelOpts.length
            ? h(VwfSelect, {
                value: curModel,
                options: [{ value: '', label: t('selectModel') }].concat(modelOpts.map(id => ({ value: id, label: id }))),
                onChange: (v) => props.onUpdate(node.id, { model: { provider: curProv || undefined, model: v || undefined } }),
              })
            : h('input', { className: 'vwf-input', value: curModel, placeholder: 'deepseek-v4-flash', onChange: (ev) => props.onUpdate(node.id, { model: { provider: curProv || undefined, model: ev.target.value || undefined } }) })
        ),
        h(Field, { label: t('goal'), required: true, errors: errorsFor('goal') },
          h('textarea', { className: 'vwf-textarea', rows: 3, value: node.goal || '', placeholder: t('defaultNodeGoal'), onChange: (ev) => props.onUpdate(node.id, { goal: ev.target.value }) })
        ),
        h('div', { className: 'vwf-subsection' },
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
                if (mode === 'ai') props.onUpdate(node.id, { output: { schema: (node.output && node.output.schema) || null, successCondition: (node.output && node.output.successCondition) || '' }, manualCheck: null })
                else if (mode === 'manual') props.onUpdate(node.id, { output: null, manualCheck: true })
                else props.onUpdate(node.id, { output: null, manualCheck: null })
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
              schemaError ? h('div', { className: 'vwf-err-line' }, schemaError) : null
            ),
            h(Field, { label: t('successCondition'), required: true, help: t('successConditionHelp'), errors: errorsFor('output.successCondition') },
              h('input', {
                className: 'vwf-input vwf-mono' + (errorsFor('output.successCondition').length ? ' err' : ''),
                value: (node.output && node.output.successCondition) || '', placeholder: '$.result == true',
                onChange: (ev) => props.onUpdate(node.id, { output: { ...(node.output || {}), successCondition: ev.target.value } }),
              })
            )
          ) : null
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

    // ── 编辑器（对应 WorkflowEditor：画布 + JSON 双 tab + 配置面板）──────────
    function Editor(props) {
      const wf = props.wf
      const setWf = props.setWf
      const canvasHeight = props.canvasHeight || 560
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
      const validateTimerRef = React.useRef(null)
      const fitRef = React.useRef(null)
      const scrollToRef = React.useRef(null)

      const selectedNode = selectedNodeId ? (wf.nodes || []).find(n => n.id === selectedNodeId) || null : null
      const selectedEdge = selectedEdgeIndex !== null ? (wf.edges || [])[selectedEdgeIndex] || null : null
      const entryCandidates = React.useMemo(() => deriveEntryCandidates(wf), [wf])
      // 编辑已有模板且 ID 已修改 → 保存置灰，只能另存为（currentId=原模板 id）
      const idChanged = props.currentId != null && wf.id !== props.currentId

      // 变更同步：归一入口、清空校验标记、同步 JSON 草稿、通知上层、防抖实时校验
      const syncWorkflow = (next) => {
        const normalized = normalizeEntry(next)
        setFieldErrors({})
        setInvalidNodeIds(new Set())
        setJsonError(null)
        setWf(normalized)
        setJsonDraft(JSON.stringify(normalized, null, 2))
        if (validateTimerRef.current) validateTimerRef.current()
        validateTimerRef.current = ctx.timeout(() => {
          host.call('vwf.validate', { dsl: normalized }).then(r => setLiveErrors(r.ok ? [] : (r.errors || []))).catch(() => {})
        }, VALIDATE_DEBOUNCE_MS)
      }
      React.useEffect(() => () => { if (validateTimerRef.current) validateTimerRef.current() }, [])
      React.useEffect(() => {
        host.call('vwf.validate', { dsl: wf }).then(r => setLiveErrors(r.ok ? [] : (r.errors || []))).catch(() => {})
      }, [])

      const handleConnect = (from, to) => {
        if (from === END_NODE) return
        const edge = { from, to, on: 'success' }
        const next = { ...wf, edges: [...(wf.edges || []), edge] }
        syncWorkflow(next)
        setSelectedEdgeIndex(next.edges.length - 1)
        setSelectedNodeId(null)
      }

      const addNode = () => {
        const id = uniqueNodeId(wf, 'node-' + (wf.nodes.length + 1))
        const node = { id, label: '节点' + id.replace(/\D+/g, ''), profile: 'dispatcher' }
        const next = { ...wf, entry: wf.entry || id, nodes: [...wf.nodes, node] }
        syncWorkflow(next)
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
        syncWorkflow(next)
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
        syncWorkflow(next)
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
        syncWorkflow({ ...wf, edges: wf.edges.filter((_, i) => i !== selectedEdgeIndex) })
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
          toSave = normalizeEntry(parsed)
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
        setJsonDraft(value)
        setJsonError(null)
        try {
          const parsed = JSON.parse(value)
          if (parsed && Array.isArray(parsed.nodes)) {
            const next = normalizeEntry(parsed)
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
                h('div', { className: 'vwf-row' },
                  h('div', { className: 'vwf-row', style: { gap: 2 } },
                    h('button', { className: 'vwf-btn sm' + (tab === 'canvas' ? ' primary' : ''), onClick: () => setTab('canvas') }, t('canvas')),
                    h('button', { className: 'vwf-btn sm' + (tab === 'json' ? ' primary' : ''), onClick: () => setTab('json') }, 'JSON')
                  ),
                  h('button', { className: 'vwf-btn sm', onClick: props.onScript }, t('getScript')),
                  idChanged ? h('button', { className: 'vwf-btn sm', onClick: () => { void handleSave() } }, t('saveAs')) : null,
                  h('button', { className: 'vwf-btn sm primary', disabled: props.saving || !(wf.nodes || []).length || idChanged, onClick: () => { void handleSave() } }, t('saveWorkflow'))
                )
              ),
              tab === 'canvas' ? h('div', { className: 'vwf-canvas-toolbar' },
                h('button', { className: 'vwf-btn sm ghost', onClick: addNode }, '＋ ' + t('addNode')),
                h('button', { className: 'vwf-btn sm ghost danger', disabled: !selectedNodeId, onClick: deleteSelectedNode }, t('deleteNode')),
                h('span', { className: 'vwf-muted-sm', style: { padding: '0 6px' } }, t('connectHint'))
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
        )
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
        const id = nodeIdForLabel(String(a.label).replace(/ R\d+$/, ''), dsl)
        if (!id) continue
        m[id] = a.outcome === 'completed' ? 'pass' : a.outcome === 'failed' ? 'fail' : 'running'
      }
      const cur = state && state.phase ? nodeIdForLabel(state.phase, dsl) : null
      if (cur && m[cur] !== 'pass' && m[cur] !== 'fail') m[cur] = 'running'
      return m
    }

    function Dashboard(props) {
      const [runId, setRunId] = React.useState('')
      const [snap, setSnap] = React.useState(null)
      const [auto, setAuto] = React.useState(true)
      const dsl = props.wf || null
      const refresh = React.useCallback(() => {
        if (!runId) return
        host.call('vwf.state', { runId }).then(r => setSnap(r)).catch(() => {})
      }, [runId])
      React.useEffect(() => {
        if (!auto || !runId) return undefined
        return ctx.interval(refresh, 3000)
      }, [auto, runId])
      const st = snap && snap.found && dsl ? mapStatus(snap.state, dsl) : {}
      return h('div', { className: 'vwf-root' },
        h('div', { className: 'vwf-row' },
          h('input', { className: 'vwf-input', style: { flex: 1 }, placeholder: 'runId（运行回执中的 runId）', value: runId, onChange: (ev) => setRunId(ev.target.value) }),
          h('button', { className: 'vwf-btn', onClick: refresh }, t('refresh')),
          h('label', { className: 'vwf-row', style: { fontSize: 11 } },
            h('input', { type: 'checkbox', checked: auto, onChange: (ev) => setAuto(ev.target.checked) }),
            ' 自动轮询 3s'
          )
        ),
        snap === null
          ? h('div', { className: 'vwf-muted' }, '输入 runId 后自动轮询运行状态')
          : !snap.found
            ? h('div', { className: 'vwf-err-line' }, '未找到该 runId 的状态（仅插件进程内的运行记录）')
            : h('div', null,
                h('div', { className: 'vwf-row' },
                  h('span', null, '状态：' + snap.state.status),
                  h('span', { className: 'vwf-muted' }, '当前阶段：' + (snap.state.phase || '—')),
                  h('span', { className: 'vwf-badge', style: { color: STATUS_COLOR.running } }, 'running'),
                  h('span', { className: 'vwf-badge', style: { color: STATUS_COLOR.pass } }, 'pass'),
                  h('span', { className: 'vwf-badge', style: { color: STATUS_COLOR.fail } }, 'fail'),
                  h('span', { className: 'vwf-badge', style: { color: STATUS_COLOR.human } }, '人工门禁')
                ),
                dsl ? h('div', { className: 'vwf-card', style: { marginTop: 8 } }, h(Canvas, { dsl, readOnly: true, statusMap: st })) : null,
                h('table', { className: 'vwf-table', style: { marginTop: 8 } },
                  h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, '节点'), h('th', null, '阶段'), h('th', null, '结果'))),
                  h('tbody', null, snap.state.agents.map(a => h('tr', { key: a.seq },
                    h('td', null, String(a.seq)),
                    h('td', null, a.label),
                    h('td', null, a.phase || '—'),
                    h('td', null, h('span', { className: 'vwf-badge', style: { color: a.outcome === 'completed' ? STATUS_COLOR.pass : a.outcome === 'failed' ? STATUS_COLOR.fail : STATUS_COLOR.running } }, a.outcome))
                  )))
                ),
                h('div', { className: 'vwf-code', style: { marginTop: 8 } }, (snap.state.logs || []).slice(-20).join('\n'))
              )
      )
    }

    // ── 页面：模板库 + 大抽屉编辑器 + 运行看板 ───────────────────────────────
    function Skeleton() {
      return { id: 'my-flow', name: '我的工作流', description: '', entry: 'node-1', control: { maxRounds: 9 }, nodes: [{ id: 'node-1', profile: 'dispatcher', label: '节点1' }], edges: [{ from: 'node-1', to: '$end', on: 'success' }] }
    }

    function Page() {
      const [tab, setTab] = React.useState('templates')
      const [list, setList] = React.useState(null)
      const [editId, setEditId] = React.useState(null) // 抽屉中的模板 id
      const [wf, setWf] = React.useState(null) // 抽屉中的工作流草稿
      const [dirty, setDirty] = React.useState(false)
      const [saving, setSaving] = React.useState(false)
      const [msg, setMsg] = React.useState(null)
      const [providers, setProviders] = React.useState([])
      const [roles, setRoles] = React.useState([])

      const refresh = React.useCallback(() => host.call('vwf.workflows.list').then((l) => setList(l || [])).catch(() => setList([])), [])
      React.useEffect(() => { refresh() }, [])
      React.useEffect(() => {
        host.call('vwf.models').then(r => { if (r && r.providers) setProviders(r.providers) }).catch(() => {})
        host.call('vwf.roles').then(r => { if (r && r.roles) setRoles(r.roles) }).catch(() => {})
      }, [])

      const openEditor = (id) => {
        const w = (list || []).find(x => x.id === id)
        if (!w) return
        setEditId(id)
        setWf(clone(w.dsl))
        setDirty(false)
      }
      const closeEditor = () => { setEditId(null); setWf(null); setDirty(false) }
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
      const onScript = () => {
        if (!wf) return
        host.call('vwf.script', { dsl: wf }).then(r => setMsg(r.ok ? ('✓ 编译通过 · 引擎可用：' + r.engineAvailable + '\n\n' + r.script) : JSON.stringify(r.errors))).catch(() => {})
      }

      const editingBuiltin = !!(list || []).find(x => x.id === editId && x.builtin)

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
        wf ? h('div', null,
          h('div', { className: 'vwf-drawer-mask', onClick: closeEditor }),
          h('div', { className: 'vwf-drawer' },
            h('div', { className: 'vwf-drawer-head' },
              h('strong', null, (wf.name || wf.id) + ''),
              editId ? h('span', { className: 'vwf-badge' }, editId) : h('span', { className: 'vwf-badge accent' }, t('newTemplate')),
              editingBuiltin ? h('span', { className: 'vwf-badge accent' }, t('builtinBadge')) : null,
              dirty ? h('span', { className: 'vwf-badge', style: { color: 'var(--dsw-alias-state-warn-primary, #f59e0b)' } }, t('unsavedDraft')) : null,
              h('span', { className: 'vwf-spacer' }),
              h('button', { className: 'vwf-btn sm', onClick: closeEditor }, t('close'))
            ),
            h('div', { className: 'vwf-drawer-body' },
              h(Editor, {
                wf, providers, roles, saving,
                currentId: editId,
                setWf: (next) => { setWf(next); setDirty(true) },
                onSaved: (id) => { onSaved(id); if (!editId) setEditId(id) },
                onScript,
              })
            )
          )
        ) : null
      )
    }

    slots.inject('settings.section', () => slots.register(
      { name: 'settings.section', id: 'workflow-visual', order: 25, label: '工作流' },
      () => h(Page, null)
    ))
  },
}
