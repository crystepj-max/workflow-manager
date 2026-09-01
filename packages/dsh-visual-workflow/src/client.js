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
      undo: '撤销',
      redo: '重做',
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
      nodeKind: '节点类型',
      nodeKindWorker: '普通节点',
      nodeKindFanout: '扇出节点',
      fanoutItems: 'items 来源',
      fanoutItemsHelp: '仅支持 $.results.<节点id>.<字段> 或 $.args.<字段>；目标中用 {{item}} 引用当前项。',
      fanoutFailOn: '失败阈值',
      fanoutFailOnHelp: 'any=任一项失败；all=全部失败（默认）；数字 N=失败数大于 N。',
      fanoutFailOnNumber: '允许失败数',
      perItemSchemaHelp: '该 Schema 校验每个子代理的结果；聚合包装对象不受此 Schema 校验。',
      nodeId: '节点 ID',
      nodeLabel: '显示名',
      profile: '角色',
      selectProfile: '选择角色',
      profileHelp: '角色对应工作区 dsh/roles/<角色>.md 文件，运行时会把角色正文提供给 AI。',
      manageRoles: '管理角色',
      roleLibrary: '角色库',
      roleManager: '角色管理',
      roleMgmtHint: '节点配置负责选择角色，这里负责管理角色资产。',
      builtinRoles: '内置角色',
      customRoles: '自定义角色',
      noCustomRoles: '暂无自定义角色',
      newRole: '新增角色',
      viewRole: '查看',
      editRole: '编辑',
      deleteRole: '删除',
      back: '返回',
      roleName: '角色名称',
      roleNamePlaceholder: '例如：需求分析师',
      roleFromSource: '来自「{src}」，保存后将创建独立副本。',
      roleContent: '角色配置',
      roleContentPlaceholder: '描述该角色的定位、职责、工作流程与产出要求（Markdown）。',
      roleContentHelp: '保存到工作区 dsh/roles/<角色名称>.md；运行时该文件内容将提供给本节点 AI。',
      createFromRole: '基于此角色创建自定义角色',
      cloneFromRole: '基于此创建',
      builtinRoleBadge: '内置角色',
      customRoleBadge: '自定义角色',
      saveRole: '保存角色',
      cancelRole: '取消',
      roleDupName: '已存在同名角色，请使用其他名称。',
      roleNameRequired: '角色名称不能为空',
      roleContentRequired: '角色配置不能为空',
      roleNameInvalid: '角色名称不能为空，且最长 64 字符、不含非法字符（/\\:*?"<>|）',
      roleViewBuiltin: '内置角色为系统标准模板：不可修改、不可删除，仅可查看、选择使用或基于其创建自定义角色。',
      roleDeleteTitle: '确定删除「',
      roleDeleteTitleSuffix: '」吗？',
      roleDeleteDesc: '删除后该角色将无法恢复和继续使用。',
      roleDeleteBlocked: '「{name}」仍被 {n} 个节点使用，无法删除。请先将这些节点更换为其他角色，解除全部引用后再删除。',
      roleRenameBlocked: '该角色仍被 {n} 个节点使用，重命名会导致这些引用全部失效；请先解除引用，或使用「基于此角色创建自定义角色」新建变体。',
      roleUsageConfirm: '此角色当前被 {n} 个工作流节点使用，保存修改后这些位置将共同使用新的角色配置。',
      confirmSaveRole: '确认并保存',
      roleRefs: '引用位置',
      roleBlockedTitle: '无法删除自定义角色',
      roleUsageTitle: '修改影响范围确认',
      roleLoading: '加载中…',
      roleSaved: '角色已保存 ',
      roleDeleted: '角色已删除 ',
      roleSaveFailed: '保存失败：',
      roleUsageFailed: '引用统计失败，未保存修改：',
      roleDeleteFailed: '删除失败：',
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
      runMode: '运行方式',
      runModePrimary: '正式路径：在编辑器中点「获取脚本」，再把脚本交给平台 workflow 工具执行。',
      runModeEnhanced: '增强路径：宿主 agents 可用时才注册 wf_run；若 workflowEngine 在执行阶段解析失败，请改用正式路径。',
      newTemplate: '新建模板',
      editTemplate: '编辑',
      deleteTemplate: '删除',
      builtinBadge: '内置',
      refresh: '刷新列表',
      close: '关闭',
      unsavedDraft: '有未保存改动',
      confirmDiscard: '放弃未保存的改动并关闭？',
      discardCancel: '我再想想',
      discardConfirm: '不改了',
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
      undo: 'Undo',
      redo: 'Redo',
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
      nodeKind: 'Node type',
      nodeKindWorker: 'Worker',
      nodeKindFanout: 'Fan-out',
      fanoutItems: 'Items source',
      fanoutItemsHelp: 'Use $.results.<node-id>.<field> or $.args.<field>; reference the current item as {{item}} in the goal.',
      fanoutFailOn: 'Failure threshold',
      fanoutFailOnHelp: 'any=one failure; all=all fail (default); number N=failedCount > N.',
      fanoutFailOnNumber: 'Allowed failures',
      perItemSchemaHelp: 'This schema validates each sub-agent result, not the aggregate wrapper.',
      nodeId: 'Node ID',
      nodeLabel: 'Label',
      profile: 'Profile',
      selectProfile: 'Select profile',
      profileHelp: 'A profile maps to dsh/roles/<profile>.md in the workspace; its content is provided to the AI at runtime.',
      manageRoles: 'Manage roles',
      roleLibrary: 'Role Library',
      roleManager: 'Role Manager',
      roleMgmtHint: 'Node config picks a role; this panel manages role assets.',
      builtinRoles: 'Built-in Roles',
      customRoles: 'Custom Roles',
      noCustomRoles: 'No custom roles yet',
      newRole: 'New Role',
      viewRole: 'View',
      editRole: 'Edit',
      deleteRole: 'Delete',
      back: 'Back',
      roleName: 'Role name',
      roleNamePlaceholder: 'e.g. Requirements Analyst',
      roleFromSource: 'From "{src}"; saving creates an independent copy.',
      roleContent: 'Role configuration',
      roleContentPlaceholder: 'Describe the role positioning, duties, workflow and output requirements (Markdown).',
      roleContentHelp: 'Saved to dsh/roles/<role-name>.md in the workspace; the file content is given to the node AI at runtime.',
      createFromRole: 'Create custom role from this role',
      cloneFromRole: 'Clone from this',
      builtinRoleBadge: 'Built-in',
      customRoleBadge: 'Custom',
      saveRole: 'Save Role',
      cancelRole: 'Cancel',
      roleDupName: 'A role with the same name already exists; please use another name.',
      roleNameRequired: 'Role name is required',
      roleContentRequired: 'Role configuration is required',
      roleNameInvalid: 'Role name is required, at most 64 chars, no illegal chars (/\\:*?"<>|)',
      roleViewBuiltin: 'Built-in roles are system standard templates: read-only; you may view, select, or create a custom variant from one.',
      roleDeleteTitle: 'Delete role "',
      roleDeleteTitleSuffix: '"?',
      roleDeleteDesc: 'After deletion the role cannot be recovered or reused.',
      roleDeleteBlocked: '"{name}" is still used by {n} node(s) and cannot be deleted. Switch those nodes to another role first, then delete after all references are gone.',
      roleRenameBlocked: 'This role is still used by {n} node(s); renaming would break those references. Remove the references first, or use "Create custom role from this role" to make a variant.',
      roleUsageConfirm: 'This role is used by {n} node(s); after saving, those positions will share the new configuration.',
      confirmSaveRole: 'Confirm & Save',
      roleRefs: 'References',
      roleBlockedTitle: 'Cannot delete custom role',
      roleUsageTitle: 'Impact confirmation',
      roleLoading: 'Loading…',
      roleSaved: 'Role saved ',
      roleDeleted: 'Role deleted ',
      roleSaveFailed: 'Save failed: ',
      roleUsageFailed: 'Failed to read role usage; change not saved: ',
      roleDeleteFailed: 'Delete failed: ',
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
      runMode: 'How to run',
      runModePrimary: 'Standard path: select Get Script in the editor, then run the script with the platform workflow tool.',
      runModeEnhanced: 'Enhanced path: wf_run is registered only when host agents are available. If workflowEngine cannot be resolved at execution time, use the standard path.',
      newTemplate: 'New Template',
      editTemplate: 'Edit',
      deleteTemplate: 'Delete',
      builtinBadge: 'built-in',
      refresh: 'Refresh',
      close: 'Close',
      unsavedDraft: 'Unsaved changes',
      confirmDiscard: 'Discard unsaved changes and close?',
      discardCancel: 'Not yet',
      discardConfirm: 'Discard',
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
    const STATUS_COLOR = { running: 'var(--dsw-alias-brand-primary, #60a5fa)', pass: 'var(--dsw-alias-state-success-primary, #22c55e)', fail: 'var(--dsw-alias-state-error-primary, #ef4444)', human: 'var(--dsw-alias-state-warn-primary, #f59e0b)' }
    const EDGE_OK = '#2563eb'
    const EDGE_FAIL = 'var(--dsw-alias-state-error-primary, #f87171)'
    const EDGE_SELECTED = '#111827'
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
      const sourceKindCount = new Map()
      const sourceOrdinal = new Map()
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
        const top = Math.min(y1, y2) - 10
        const bottom = Math.max(y1, y2) + 10
        const between = Object.keys(pos).map(id => ({ id, p: pos[id] })).filter(item => {
          const p = item.p
          if (item.id === e.from || item.id === e.to) return false
          return p.x < right && p.x + p.w > left
        })
        const hits = between.filter(item => {
          const p = item.p
          return p.y < bottom && p.y + p.h > top
        })
        const backward = lanes.has(index)
        // 跨节点定义：前向边的水平区段内存在任一无关节点（即使不与端点纵向相交）→ 下绕。
        const kind = backward ? 'up' : (between.length > 0 ? 'down' : 'direct')
        const sKey = e.from + '|' + kind
        const sOrdinal = sourceOrdinal.get(sKey) || 0
        sourceOrdinal.set(sKey, sOrdinal + 1)
        const sCounts = sourceKindCount.get(e.from) || { up: 0, direct: 0, down: 0, total: 0 }
        sCounts[kind] += 1
        sCounts.total += 1
        sourceKindCount.set(e.from, sCounts)
        infos.push({ index, e, a, b, x1, y1, x2, y2, between, hits, kind, sOrdinal })
      })

      // 起点锚点固定 3 个槽位（验收反馈优化 3）：上绕=上槽、直连=中槽（与连线源把手
      // 位置一致，即节点右边框垂直居中）、下绕=下槽；同类边共享同一槽位。
      const borderAnchor = (id, kind, ordinal) => {
        const node = pos[id]
        if (!node) return 0
        const pad = 8
        const safeTop = node.y + pad
        const safeBottom = node.y + node.h - pad
        const slot = kind === 'up' ? 0 : kind === 'direct' ? 1 : 2
        return safeTop + (slot + 0.5) * ((safeBottom - safeTop) / 3)
      }

      // 平行直连边（同 from→to 的多条条件边）共享起点槽位与终点垂直居中，但曲线必须
      // 相互分离：命中路径完全重叠时后画的 SVG path 会拦截所有画布点击，前一条边无法
      // 在画布上选中（仅能经 JSON 编辑）——按平行序号给控制点做微小横向偏移。
      const parallelDirect = new Map()
      infos.forEach((info) => {
        if (info.kind !== 'direct') return
        const pk = info.e.from + '->' + info.e.to
        const list = parallelDirect.get(pk) || []
        list.push(info)
        parallelDirect.set(pk, list)
      })
      const PARALLEL_SPREAD = 3

      infos.forEach((info) => {
        const { index, e, x1, y1, x2, y2, between, kind, sOrdinal } = info
        const yStart = borderAnchor(e.from, kind, sOrdinal)
        // #6：终点统一在节点左侧垂直居中，不做间隔。
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
          // 自环边（防御脏数据）：不参与最长路 rank，避免自身 rank 无限自增
          if (e.from === e.to) continue
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
      return { pos, W: maxX + MARGIN_X, H: contentBottom + MARGIN_Y, lanes, routes, order }
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
        [JSON.stringify({ entry: dsl.entry || '', n: (dsl.nodes || []).map(n => n.id), e: (dsl.edges || []).map(e => [e.from, e.to, e.on]), v: props.visibleTerminals || [] })]
      )
      const pos = lay.pos
      const W = lay.W
      const H = lay.H

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
          h('textarea', { className: 'vwf-textarea' + (errorsFor('goal').length ? ' err' : ''), rows: 3, value: node.goal || '', placeholder: isFanout ? '处理任务：{{item}}' : t('defaultNodeGoal'), onChange: (ev) => props.onUpdate(node.id, { goal: ev.target.value }) })
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
            schemaError ? h('div', { className: 'vwf-err-line' }, schemaError) : null
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
        setDraftName(source ? source.id + ' - 自定义' : '')
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
            setDraftName(r.role.id + ' - 自定义')
            setDraftContent(r.role.content || '')
          } else setError((r && r.errors && r.errors[0] && r.errors[0].message) || t('roleSaveFailed'))
        }).catch((e) => setError(String(e)))
      }
      const validForm = () => {
        const name = draftName.trim()
        if (!name || name.length > 64 || /[\\/:*?"<>|\x00-\x1F\x7F]/.test(name)) { setError(t('roleNameInvalid')); return null }
        if (!draftContent.trim()) { setError(t('roleContentRequired')); return null }
        const key = (s) => String(s || '').normalize('NFC').toLowerCase()
        const dup = (roles || []).some(r => key(r.id) === key(name) && (!current || r.id !== current.id))
        if (dup) { setError(t('roleDupName')); return null }
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
      const save = () => {
        const name = validForm()
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
          setConfirm({ kind: (u && u.ok && u.count > 0) ? 'blocked' : 'delete', role: role, usage: (u && u.ok) ? u : null })
        }).catch((e) => setError(String(e)))
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
      // 历史上限：防止长编辑会话（每键一次快照 = 深拷贝 DSL + 完整 JSON）内存无限增长
      const HISTORY_MAX = 50
      const pushHistory = (beforeDsl, beforeJson, beforeJsonError) => {
        const h = historyRef.current
        const prev = h.past[h.past.length - 1]
        // 相邻快照相同（同一变更被两个入口记录，如 JSON 编辑与同步）只保留一次。
        if (prev && prev.json === beforeJson && prev.jsonError === (beforeJsonError || null) && JSON.stringify(prev.dsl) === JSON.stringify(beforeDsl)) return
        const selEdge = selectedEdgeIndex !== null && wf.edges && wf.edges[selectedEdgeIndex] ? wf.edges[selectedEdgeIndex] : null
        if (h.past.length >= HISTORY_MAX) h.past.shift()
        h.past.push({
          dsl: clone(beforeDsl),
          json: beforeJson,
          jsonError: beforeJsonError || null,
          selNode: selectedNodeId,
          selEdgeSig: selEdge ? JSON.stringify({ from: selEdge.from || '', to: selEdge.to || '', on: selEdge.on || '', when: selEdge.when || '' }) : null,
        })
        h.future = []
        setHistoryVersion(v => v + 1)
      }
      const applySnapshot = (entry) => {
        const snapshot = normalizeEntry(entry.dsl)
        // props.setWf 会同时置脏并同步父级草稿状态；与普通编辑走同一上层通道。
        setWf(snapshot)
        setJsonDraft(entry.json)
        setJsonError(entry.jsonError || null)
        setFieldErrors({})
        setInvalidNodeIds(new Set())
        setLiveErrors([])
        const nodeStillExists = !!entry.selNode && (snapshot.nodes || []).some(n => n.id === entry.selNode)
        if (nodeStillExists) {
          setSelectedNodeId(entry.selNode)
          setSelectedEdgeIndex(null)
        } else {
          setSelectedNodeId(null)
          let edgeMatchIndex = null
          if (entry.selEdgeSig) {
            edgeMatchIndex = (snapshot.edges || []).findIndex(e => JSON.stringify({ from: e.from || '', to: e.to || '', on: e.on || '', when: e.when || '' }) === entry.selEdgeSig)
          }
          if (edgeMatchIndex !== null && edgeMatchIndex >= 0) setSelectedEdgeIndex(edgeMatchIndex)
          else setSelectedEdgeIndex(null)
        }
        // 撤销/重做同样触发防抖校验，保持与普通编辑一致的实时校验状态。
        scheduleValidate(snapshot)
      }
      const undo = () => {
        const h = historyRef.current
        if (!h.past.length) return
        const previous = h.past.pop()
        const currentEdge = selectedEdgeIndex !== null && wf.edges && wf.edges[selectedEdgeIndex] ? wf.edges[selectedEdgeIndex] : null
        h.future.unshift({
          dsl: clone(wf),
          json: jsonDraft,
          jsonError: jsonError,
          selNode: selectedNodeId,
          selEdgeSig: currentEdge ? JSON.stringify({ from: currentEdge.from || '', to: currentEdge.to || '', on: currentEdge.on || '', when: currentEdge.when || '' }) : null,
        })
        applySnapshot(previous)
        setHistoryVersion(v => v + 1)
      }
      const redo = () => {
        const h = historyRef.current
        if (!h.future.length) return
        const next = h.future.shift()
        const currentEdge = selectedEdgeIndex !== null && wf.edges && wf.edges[selectedEdgeIndex] ? wf.edges[selectedEdgeIndex] : null
        h.past.push({
          dsl: clone(wf),
          json: jsonDraft,
          jsonError: jsonError,
          selNode: selectedNodeId,
          selEdgeSig: currentEdge ? JSON.stringify({ from: currentEdge.from || '', to: currentEdge.to || '', on: currentEdge.on || '', when: currentEdge.when || '' }) : null,
        })
        applySnapshot(next)
        setHistoryVersion(v => v + 1)
      }
      const canUndo = historyRef.current.past.length > 0
      const canRedo = historyRef.current.future.length > 0

      const selectedNode = selectedNodeId ? (wf.nodes || []).find(n => n.id === selectedNodeId) || null : null
      const selectedEdge = selectedEdgeIndex !== null ? (wf.edges || [])[selectedEdgeIndex] || null : null
      const entryCandidates = React.useMemo(() => deriveEntryCandidates(wf), [wf])
      // 编辑已有模板且 ID 已修改 → 保存置灰，只能另存为（currentId=原模板 id）
      const idChanged = props.currentId != null && wf.id !== props.currentId

      // 变更同步：归一入口、清空校验标记、同步 JSON 草稿、通知上层、防抖实时校验
      const syncWorkflow = (next) => {
        pushHistory(wf, jsonDraft, jsonError)
        const normalized = normalizeEntry(next)
        setFieldErrors({})
        setInvalidNodeIds(new Set())
        setJsonError(null)
        setLiveErrors([])
        setWf(normalized)
        setJsonDraft(JSON.stringify(normalized, null, 2))
        scheduleValidate(normalized)
      }
      React.useEffect(() => () => { if (validateTimerRef.current) validateTimerRef.current() }, [])
      React.useEffect(() => {
        scheduleValidate(wf)
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
        pushHistory(wf, jsonDraft, jsonError)
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
                h('div', { className: 'vwf-row', style: { gap: 6, alignItems: 'center' } },
                  h('div', { className: 'vwf-history-group' },
                    h('button', { className: 'vwf-btn sm ghost vwf-history-btn', disabled: !canUndo, title: t('undo'), onClick: undo }, '↶'),
                    h('button', { className: 'vwf-btn sm ghost vwf-history-btn', disabled: !canRedo, title: t('redo'), onClick: redo }, '↷')
                  ),
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
      return h('span', { className: 'vwf-badge', style: { color: color } }, s === 'WAITING_HUMAN' ? '等待人工' : s.indexOf('AWAITING_HUMAN_') === 0 ? '人工门禁' : (s || '—'))
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
      const [older, setOlder] = React.useState([])
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
        // 磁盘历史随刷新重拉（评审 PRRT_kwDOT57Tec6b7TeY）：看板常驻期间发生
        // 容量淘汰时，已淘汰冷记录要从 older 移除，否则出现 51 条/点陈旧行 not-found
        host.call('vwf.runs.history').then((r) => setOlder((r && r.runs) || [])).catch(() => {})
        if (!runId) return
        fetchState(runId)
      }, [runId])
      React.useEffect(() => {
        if (!auto) return undefined
        return ctx.interval(refresh, 3000)
      }, [auto, refresh])
      // 进入看板即时查询一次：不等首个 3s 轮询周期（避免首屏误显示「暂无运行记录」）；
      // 磁盘全量历史已由 refresh 一并拉取（见 allRuns 合并）
      React.useEffect(() => { refresh() }, [])
      // 展示列表 = 内存实时记录（最近回载，状态更新鲜） ∪ 磁盘历史（按 id 去重，历史追加在后）
      const allRuns = React.useMemo(() => {
        const seen = new Set()
        const merged = []
        for (const r of runs) if (!seen.has(r.id)) { seen.add(r.id); merged.push(r) }
        for (const r of older) if (!seen.has(r.id)) { seen.add(r.id); merged.push(r) }
        // 统一按持久化时间倒序（评审 PRRT_kwDOT57Tec6b7TeU）：内存合并在前会把
        // 按需水合的旧 run 提到磁盘冷记录之前，令表格/分页失序；排序恢复真实时序
        return merged.sort((a, b) => ((b.startedAt || b.ts || 0) - (a.startedAt || a.ts || 0)) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
      }, [runs, older])
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
          '⚠ 并行运行 ' + activeCount + ' 个：closeout 收口须串行执行，避免并发互踩；人工门禁请逐张裁决。') : null,
        gates.length ? h('div', { className: 'vwf-card', style: { marginBottom: 8 } },
          h('div', { className: 'vwf-card-head' }, h('div', { className: 'vwf-card-title' }, '人工门禁队列（一次裁决一张）')),
          h('div', { style: { padding: '4px 14px 10px' } },
            gates.map((g, i) => h('div', { key: g.id, style: { padding: '8px 0', borderTop: i ? '1px solid var(--dsw-alias-border-l2, #333)' : 'none' } },
              h('div', { className: 'vwf-row', style: { gap: 8, flexWrap: 'wrap' } },
                h('span', { className: 'vwf-badge accent' }, i === 0 ? '裁决中' : '排队 #' + (i + 1)),
                h('strong', null, g.taskId || g.id),
                h('span', { className: 'vwf-muted-sm' }, (g.name || g.workflowId || '') + ' · ' + (String(g.status) === 'WAITING_HUMAN' ? ('Human Decision ' + (g.reason || '')) : ('门禁节点 ' + String(g.status).replace('AWAITING_HUMAN_', '')))),
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
            h('div', { className: 'vwf-card-title' }, '运行列表'),
            h('label', { className: 'vwf-row', style: { fontSize: 11 } },
              h('input', { type: 'checkbox', checked: auto, onChange: (ev) => setAuto(ev.target.checked) }),
              ' 自动轮询 3s'
            )
          ),
          h('div', { className: 'vwf-table-scroll', style: { maxHeight: 420, overflowY: 'auto' } },
            h('table', { className: 'vwf-table' },
              h('thead', null, h('tr', null, h('th', null, 'taskId'), h('th', null, '工作流'), h('th', null, '状态'), h('th', null, '阶段'), h('th', null, 'runId'))),
              h('tbody', null, pageRuns.map((r) => h('tr', { key: r.id, onClick: () => selectRun(r.id), style: { cursor: 'pointer', opacity: r.supersededBy ? 0.5 : 1 } },
                h('td', null, r.taskId || '—'),
                h('td', null, r.name || r.workflowId || '—'),
                h('td', null, r.supersededBy ? h('span', { className: 'vwf-badge' }, '已由续跑接管') : statusBadge(r.status)),
                h('td', null, r.phase || '—'),
                h('td', { className: 'vwf-muted-sm' }, r.id)
              )))
            )
          ),
          pageRuns && !pageRuns.length ? h('div', { className: 'vwf-empty' }, '暂无运行记录') : null,
          h('div', { className: 'vwf-row', style: { marginTop: 8, flexWrap: 'wrap', gap: 8, alignItems: 'center' } },
            h('span', { className: 'vwf-muted-sm' }, '第 ' + (safePage + 1) + '/' + totalPages + ' 页 · 共 ' + allRuns.length + ' 条'),
            h('button', { className: 'vwf-btn sm', disabled: safePage === 0, onClick: prevPage }, '上一页'),
            h('button', { className: 'vwf-btn sm', disabled: safePage >= totalPages - 1, onClick: nextPage }, '下一页'),
            h('span', { className: 'vwf-muted-sm' }, '每页'),
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
          h('input', { className: 'vwf-input', style: { flex: 1 }, placeholder: 'runId（点上方行自动填入，或手动粘贴）', value: runId, onChange: (ev) => setRunId(ev.target.value) }),
          h('button', { className: 'vwf-btn', onClick: refresh }, t('refresh'))
        ),
        snap === null
          ? h('div', { className: 'vwf-muted' }, '选择或输入 runId 查看运行详情')
          : !snap.found
            ? h('div', { className: 'vwf-err-line' }, '未找到该 runId 的状态（内存与磁盘历史均无记录）')
            : h('div', null,
                h('div', null,
                  h('div', { className: 'vwf-row' },
                    h('span', null, '状态：' + snap.state.status),
                    h('span', { className: 'vwf-muted' }, '当前阶段：' + (snap.state.phase || '—')),
                    snap.state.taskId ? h('span', { className: 'vwf-muted' }, 'taskId：' + snap.state.taskId) : null
                  ),
                  h('div', { className: 'vwf-row', style: { borderTop: '1px solid var(--dsw-alias-border-l2, #333)', marginTop: 6, paddingTop: 6 } },
                    h('span', { className: 'vwf-muted', style: { fontSize: 10 } }, '画布图例：'),
                    h('span', { className: 'vwf-badge', style: { color: STATUS_COLOR.running } }, 'running'),
                    h('span', { className: 'vwf-badge', style: { color: STATUS_COLOR.pass } }, 'pass'),
                    h('span', { className: 'vwf-badge', style: { color: STATUS_COLOR.fail } }, 'fail'),
                    h('span', { className: 'vwf-badge', style: { color: STATUS_COLOR.human } }, '人工门禁')
                  )
                ),
                dsl ? h('div', { className: 'vwf-card', style: { marginTop: 8 } }, h(Canvas, { dsl, readOnly: true, statusMap: st })) : null,
                h('table', { className: 'vwf-table', style: { marginTop: 8 } },
                  h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, '节点'), h('th', null, '阶段'), h('th', null, '结果'))),
                  h('tbody', null, dashboardAgentRows(snap.state.agents))
                ),
                h('div', { className: 'vwf-code', style: { marginTop: 8 } }, (snap.state.logs || []).slice(-20).join('\n'))
              )
      )
    }

    // ── 页面：模板库 + 全局编辑层 + 运行看板 ───────────────────────────────
    function Skeleton() {
      return { id: 'my-flow', name: '我的工作流', description: '', entry: 'node-1', control: { maxRounds: 9 }, nodes: [{ id: 'node-1', profile: 'dispatcher', label: '节点1' }], edges: [{ from: 'node-1', to: '$end', on: 'success' }] }
    }

    function Page() {
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
              wf, providers, roles, saving,
              currentId: editId,
              setWf: (next) => { setWf(next); setDirty(true) },
              onSaved: (id) => { onSaved(id); if (!editId) setEditId(id) },
              onScript,
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
