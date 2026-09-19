// 一次性原型：三个结构不同的工作流 UI，在同一地址用 ?variant=A|B|C 切换。
// 仅读取本地模板；所有编辑、运行与人工决定都在浏览器内存中模拟。
const catalog = await fetch('/prototype-data').then(response => response.json())
const params = new URLSearchParams(location.search)
const names = { A: '编排台', B: '步骤手册', C: '任务现场' }
const subtitles = { A: '看全局 · 随手编排', B: '跟着步骤 · 从容设置', C: '看结果 · 处理当下' }
const icons = {
  flow:'M5 4h5v5H5z M15 15h5v5h-5z M10 6.5h6a2 2 0 0 1 2 2V15 M7.5 9v8a2 2 0 0 0 2 2H15',
  grid:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  play:'m8 5 11 7-11 7Z', pause:'M8 5v14 M16 5v14',
  check:'m5 12 4 4L19 6', chevron:'m9 5 7 7-7 7', left:'m15 5-7 7 7 7',
  down:'m6 9 6 6 6-6', plus:'M12 5v14 M5 12h14', minus:'M5 12h14',
  undo:'M8 4 3 9l5 5 M3 9h10a7 7 0 0 1 7 7v3',
  sun:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v2 M12 20v2 M2 12h2 M20 12h2 M5 5l1.5 1.5 M17.5 17.5 1.5 1.5 M5 19l1.5-1.5 M17.5 6.5 1.5-1.5',
  moon:'M20 14.2A8.5 8.5 0 0 1 9.8 4a8.5 8.5 0 1 0 10.2 10.2Z',
  info:'M12 11v6 M12 7v.1 M21 12a9 9 0 1 0-18 0 9 9 0 0 0 18 0',
  close:'m6 6 12 12 M6 18 18 6', users:'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M17 4a4 4 0 0 1 0 7 M22 21v-2a4 4 0 0 0-3-3.9',
  user:'M20 21v-2a7 7 0 0 0-14 0v2 M13 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8',
  shield:'m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z m-4 9 3 3 5-6',
  code:'m8 6-6 6 6 6 M16 6l6 6-6 6 M14 4l-4 16',
  flask:'M9 3h6 M10 3v7l-6 9a1 1 0 0 0 1 2h14a1 1 0 0 0 1-2l-6-9V3 M7 15h10',
  file:'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z M14 2v6h6 M8 13h8 M8 17h5',
  flag:'M5 21V3 M5 3c4-3 9 3 14 0v10c-5 3-10-3-14 0',
  clock:'M12 8v5l3 2 M21 12a9 9 0 1 0-18 0 9 9 0 0 0 18 0',
  alert:'m12 3 10 18H2Z M12 9v5 M12 17v.2',
  search:'M10.5 3a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15 M16 16l5 5',
  settings:'M4 7h16 M4 17h16 M9 4v6 M15 14v6',
  folder:'M3 5h6l2 2h10v13H3Z',
  chat:'M21 15a3 3 0 0 1-3 3H7l-4 3V5a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3Z M7 7h10 M7 12h7',
  fit:'M3 9V3h6 M15 3h6v6 M21 15v6h-6 M9 21H3v-6',
  book:'M12 5c-3-2-7-2-10-1v15c3-1 7-1 10 1 3-2 7-2 10-1V4c-3-1-7-1-10 1Z M12 5v15',
  arrow:'M4 12h16 m-6-6 6 6-6 6',
  refresh:'M20 7v5h-5 M4 17v-5h5 M6 5a8 8 0 0 1 13 4 M18 19A8 8 0 0 1 5 15',
  bolt:'m13 2-9 12h7l-1 8 10-12h-7Z',
}
const icon = name => `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${icons[name] || icons.flow}"/></svg>`
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]))
const button = (label, action, style = '', symbol = '', attrs = '') => `<button class="btn ${style}" data-action="${action}" ${attrs}>${symbol ? icon(symbol) : ''}${label}</button>`
const badge = (label, type = '', symbol = '') => `<span class="badge ${type}">${symbol ? icon(symbol) : ''}${label}</span>`
const roleNames = { evaluator:'评估员',dev:'开发者',review:'审查员',test:'测试员',accept:'验收助手',closeout:'交付助手',diagnose:'诊断员',orchestrator:'研究统筹',researcher:'研究员',synthesizer:'分析师',requirements:'需求分析师' }
const friendly = {
  preflight:['开工检查','shield','确认资料、要求与环境已准备好','核对已确认的任务要求和所需资料，确认现在可以开始实施。'],
  dev:['实现任务','code','按已确认要求完成开发','按照已确认的任务要求实现功能，保留完成记录与需要说明的变化。'],
  review:['检查成果','shield','独立检查成果是否符合要求','对照已确认的任务要求，检查实现是否完整、正确。指出必须修改的问题；把额外建议单独记录。'],
  test:['验证效果','flask','实际运行，确认效果和已有功能','实际运行已通过审查的成果，验证主要操作、边界情况和受影响的原有功能。记录可复查的证据。'],
  uat:['准备验收','user','整理成果，等待你的验收决定','汇总成果、检查记录与已知限制，整理为可直接体验的验收清单，交给你做最终决定。'],
  closeout:['完成交付','flag','整理交付记录和后续事项','在满足当前流程交付条件后整理记录、交付成果，并保留后续事项。'],
  diagnose:['找出原因','search','先复现问题，再寻找原因','根据用户描述重现问题，记录观察到的现象，找出有证据支持的原因。资料不足时说明还缺少什么。'],
  fix:['修复问题','code','围绕已确认的原因完成修复','针对已确认的问题原因做必要修改，说明改了什么、为什么这样改，以及如何确认有效。'],
  regression:['确认修复效果','flask','问题已解决，原有功能仍正常','重新体验原来出问题的操作，确认问题得到解决，并检查可能受影响的原有功能。'],
  orchestrate:['安排研究','flow','拆清问题，安排不同研究视角','围绕研究问题列出需要了解的内容，安排各位研究员从不同视角寻找资料和依据。'],
  research:['独立研究','search','各自取证，保留不同意见','从分配给你的视角研究问题。分别列出已确认事实、推断和未知，并保留支持与反对的证据。'],
  synthesize:['汇总发现','book','整理共识、分歧和证据','汇总研究结果，指出大家达成一致的内容、仍有分歧的地方，以及各自的依据。'],
  evaluate:['评估结果','shield','判断是否回答了问题、达成了目标','对照本次任务目标评估现有结果，说明已经满足的部分、需要继续补充的内容，以及仍不确定的地方。'],
  confirm:['明确目标','file','确定本次改进的范围与要求','和用户对齐希望改善的地方、需要保留的已有体验，以及用什么方式判断改进有效。'],
  execute:['实施改进','code','完成必要改进，保护已有体验','围绕已确认的改进目标完成必要调整，保护已经满足要求的部分，记录变化和效果。'],
}
const descriptions = ['把已确认的任务，变成可验收的成果。','找到问题根因，再验证修复是否有效。','从不同视角研究一个还没有定论的问题。','围绕明确目标，做一轮有证据的改进。']
const flowTitles = ['完整功能开发','诊断与修复','多视角探索','快速优化']
function makeSteps(template) {
  return template.nodes.map((node, index) => {
    const spec = friendly[node.id] || [node.label,'file','明确目标，产出本步骤的成果',node.goal.split('\n')[0].slice(0,150)]
    return { id:node.id, label:spec[0], icon:spec[1], summary:spec[2], goal:spec[3], role:roleNames[node.role] || 'AI 助手', model:'跟随工作流设置', deliverable:node.id === 'review' ? '审查报告与待修改事项' : node.id === 'uat' ? '成果摘要与验收清单' : '工作记录与成果说明', maxRounds:'3', independent:node.id==='review', next:template.nodes[index + 1]?.id || 'end', returnTo:template.nodes[Math.max(index-1,0)]?.id || 'end', aiService:'跟随工作流设置' }
  })
}
const state = {
  variant:['A','B','C'].includes(params.get('variant')) ? params.get('variant') : 'A',
  theme:params.get('theme') === 'dark' ? 'dark' : 'light',
  view:['editor','library','runs','roles'].includes(params.get('view')) ? params.get('view') : 'library',
  surface:['host','settings','workspace'].includes(params.get('surface')) ? params.get('surface') : params.get('view')==='editor'?'workspace':'settings',
  settingsView:['library','runs','roles'].includes(params.get('view')) ? params.get('view') : 'library', settingsScroll:0,
  workflow:0, title:flowTitles[0], nodes:makeSteps(catalog[0]), selected:'review', tab:'task',
  scenario:'approval', activeRun:'uat', runSelected:'uat', runTab:'result', paused:false,
  dirty:false, mobile:'details', zoom:1, search:'', decisions:[], editedRole:null,
}
const runNodes = makeSteps(catalog[0]) // 固定演示运行，独立于正在编辑的模板草稿。
const runIndex = id => Math.max(0, runNodes.findIndex(node => node.id === id))
let saved = JSON.stringify(state.nodes)
let undo = []
let toastTimer
let dialogFocus
const app = document.querySelector('#app')
const modal = document.querySelector('#modal')
const selected = () => state.nodes.find(node => node.id === state.selected) || state.nodes[0]
const runNode = () => runNodes.find(node => node.id === state.runSelected) || runNodes[0]
const indexOf = id => Math.max(0, state.nodes.findIndex(node => node.id === id))
const ordinal = index => String(index + 1).padStart(2, '0')
const viewNames = { editor:'编排',library:'流程库',runs:'运行',roles:'角色' }
const scenarioNames = { running:state.paused ? '已暂停' : '进行中', approval:'等待你验收', blocked:'需要处理', completed:'已完成' }
function toast(message) {
  clearTimeout(toastTimer)
  const target = document.querySelector('#toast')
  target.textContent = message
  target.classList.add('show')
  toastTimer = setTimeout(() => target.classList.remove('show'), 3400)
}
function urlState() {
  const url = new URL(location.href)
  url.searchParams.set('variant',state.variant)
  url.searchParams.set('theme',state.theme)
  url.searchParams.set('view',state.view)
  url.searchParams.set('surface',state.surface)
  history.replaceState({},'',url)
}
function currentState() {
  return { 原型:'一次性 · 所有操作仅本页模拟', 方向:state.variant+' · '+names[state.variant], 主题:state.theme, 界面层级:state.surface, 设置页位置:{页面:state.settingsView,滚动位置:state.settingsScroll}, 页面:viewNames[state.view], 工作流:state.title, 选中步骤:selected(), 步骤草稿:state.nodes, 未保存:state.dirty, 运行:{ 场景:state.scenario, 当前步骤:state.activeRun, 选中步骤:state.runSelected, 详情页签:state.runTab, 暂停:state.paused, 模拟决定:state.decisions }, 配置页签:state.tab, 小屏视图:state.mobile, 自定义角色:state.editedRole }
}
function updateStateDisplay() {
  window.__prototypeState = currentState()
  document.querySelectorAll('[data-saved-label]').forEach(element => {
    element.classList.toggle('dirty',state.dirty)
    element.innerHTML = icon(state.dirty ? 'clock' : 'check')+(state.dirty ? '未保存' : '草稿已保存')
  })
  const strip = document.querySelector('.state-strip')
  if (strip) strip.innerHTML = `${state.variant} · ${state.theme==='light'?'浅色':'深色'} · ${viewNames[state.view]}<br>${escape(state.view==='runs'?runNode().label:selected().label)} · ${state.dirty?'有未保存修改':'草稿已保存'}`
  const full = document.querySelector('#full-state')
  if (full) full.textContent = JSON.stringify(currentState(),null,2)
}
function hostScenery() {
  return `<div class="dsh-host" ${state.surface!=='host'?'inert aria-hidden="true"':''}><aside class="dsh-projects"><div class="row"><span class="brand">${icon('flow')}</span><strong>DeepSeek Harness</strong></div><div class="dsh-new">${icon('plus')} 新会话</div><small class="eyebrow">工作空间</small>${['当前项目','工作流设计','团队研究','我的笔记'].map((label,i)=>`<div class="dsh-project ${i===1?'current':''}">${icon('folder')}${label}</div>`).join('')}<div class="dsh-settings-launch">${button('设置','open-settings','quiet','settings')}</div></aside><section class="dsh-conversation"><div class="dsh-conversation-head">工作流设计 <span class="muted">/ 新会话</span></div><div class="dsh-welcome"><span class="eyebrow">DSH 宿主环境示意</span><h2>接下来，想一起做点什么？</h2><p>从一段对话开始，也可以让工作流安排每一步。</p>${button('打开工作流设置','open-settings','','settings')}</div><div class="dsh-composer">描述你想完成的事…<span>↵</span></div></section><aside class="dsh-tools"><span class="eyebrow">工作空间</span>${[['folder','项目文件'],['users','协作角色'],['file','工作记录'],['settings','偏好设置']].map(([symbol,label])=>`<div>${icon(symbol)}<span>${label}</span></div>`).join('')}</aside></div>`
}
function settingsLibrary() {
  const filtered=catalog.map((item,i)=>({item,i})).filter(({i})=>flowTitles[i].includes(state.search)||descriptions[i].includes(state.search))
  return `<div class="settings-section-head"><div><h2>为下一件事，选好流程。</h2><p>选择一套流程，在独立工作区里编排。</p></div>${button('新建','new-workflow','primary','plus')}</div><label class="search-box compact-search">${icon('search')}<input aria-label="搜索流程" data-search placeholder="搜索流程…" value="${escape(state.search)}"></label><div class="compact-workflows">${filtered.map(({item,i})=>`<article class="compact-workflow"><div class="compact-workflow-icon">${icon(['flow','flask','search','bolt'][i])}</div><div class="grow"><div class="row"><h3>${flowTitles[i]}</h3>${badge('内置')}</div><p>${descriptions[i]}</p><small>${item.nodes.length} 个步骤${i===0?' · 包含人工验收':''}</small></div>${button('编辑','open-editor','','arrow',`data-index="${i}" aria-label="编辑${flowTitles[i]}"`)}</article>`).join('')||`<div class="empty"><h3>没有找到这个流程</h3><p>换一个关键词试试。</p>${button('清除搜索','clear-search')}</div>`}</div><div class="settings-tip">${icon('fit')} 编辑时会打开更大的工作区，关闭后回到这里。</div>`
}
function settingsRuns() {
  const message={approval:'成果已准备好，等待你的验收决定。',running:state.paused?'任务已暂停，已有成果保持不变。':'协作者正在处理当前步骤。',blocked:'测试环境尚未就绪，需要处理后继续。',completed:'本次任务已完成，交付记录已整理。'}[state.scenario]
  return `<div class="settings-section-head"><div><h2>了解进展，处理待办。</h2><p>在这里看摘要，打开工作区查看完整成果。</p></div>${badge('示例运行')}</div><article class="compact-run featured"><div class="row between">${statusBadge()}<small class="muted">今天 14:20</small></div><h3>工作流界面改版</h3><p>${message}</p><div class="compact-progress" aria-label="六个步骤的进度">${runNodes.map(n=>`<span class="${nodeStatus(n).kind}"></span>`).join('')}</div><div class="row between"><small class="muted">${runNodes.filter(n=>nodeStatus(n).kind==='success').length} / ${runNodes.length} 个步骤已完成</small>${button(state.scenario==='approval'?'查看并验收':'查看详情','open-run','primary','arrow')}</div></article><h3 class="settings-minor-title">最近完成</h3><div class="compact-history"><span class="status-icon success">${icon('check')}</span><div class="grow"><strong>工作流界面改版 · 上次演示</strong><p>昨天 16:05 · 已完成</p></div>${button('查看记录','history-completed','quiet','arrow')}</div><div class="settings-tip">${icon('info')} 运行与人工决定均为示例，可在底部切换其他场景。</div>`
}
function settingsRoles() {
  const descriptions=['按已确认要求完成任务。','独立检查成果，指出必要修改。','实际运行并验证效果。','整理验收资料，保留你的决定权。','整理交付与后续事项。']
  return `<div class="settings-section-head"><div><h2>让分工清楚一点。</h2><p>角色决定职责，具体任务在步骤中安排。</p></div>${button('新建角色','new-role','primary','plus')}</div><div class="compact-roles">${['开发者','审查员','测试员','验收助手','交付助手',...(state.editedRole?[state.editedRole.name]:[])].map((name,i)=>`<div class="compact-role"><span class="node-icon">${icon(['code','shield','flask','user','flag'][i]||'user')}</span><div class="grow"><strong>${escape(name)}</strong><p>${escape(descriptions[i]||state.editedRole.description)}</p></div>${button('职责','role-detail','quiet','arrow',`data-name="${escape(name)}"`)}</div>`).join('')}</div>`
}
function settingsSurface() {
  return `<div class="settings-layer" ${state.surface==='workspace'?'inert aria-hidden="true"':''}><section class="settings-shell" role="dialog" aria-modal="${state.surface==='settings'}" aria-labelledby="settings-title"><header class="settings-top"><h1 id="settings-title">设置</h1><span class="grow"></span><span class="settings-host-note">DSH · 原型</span><button class="icon-btn" data-action="close-settings" aria-label="关闭设置" title="关闭设置">${icon('close')}</button></header><div class="settings-body"><nav class="settings-sidebar" aria-label="设置分类">${[['settings','通用设置'],['bolt','模型'],['grid','插件'],['users','Agent 预设'],['flow','工作流'],['settings','反向代理'],['book','侧边卡片'],['sun','皮肤管理']].map(([symbol,label])=>`<button class="settings-category ${label==='工作流'?'active':''}" data-action="${label==='工作流'?'settings-home':'host-info'}" ${label==='工作流'?'aria-current="page"':''}>${icon(symbol)}${label}</button>`).join('')}</nav><div class="settings-panel"><nav class="settings-tabs" aria-label="插件设置页签">${[['library','流程库'],['runs','运行'],['roles','角色']].map(([key,label])=>`<button class="nav-tab ${state.settingsView===key?'active':''}" data-action="settings-tab" data-view="${key}" aria-pressed="${state.settingsView===key}">${label}${key==='runs'&&state.scenario==='approval'?'<span class="count">1</span>':''}</button>`).join('')}</nav><main class="settings-content" id="settings-content" tabindex="-1">${state.settingsView==='library'?settingsLibrary():state.settingsView==='runs'?settingsRuns():settingsRoles()}</main></div></div></section></div>`
}
function returnToSettings() {
  state.surface='settings';state.view=state.settingsView
  render()
  const focus=state.settingsView==='library'?document.querySelector(`[data-action="open-editor"][data-index="${state.workflow}"]`):document.querySelector('[data-action="open-run"]')
  focus?.focus({preventScroll:true})
}
function requestWorkspaceClose() {
  if(state.dirty) openDialog('离开前，保留这次修改？','<p>你对流程做了调整。保存后返回设置，或放弃本次未保存的修改。</p>',button('继续编辑','close-modal')+button('放弃修改','discard-and-close')+button('保存并返回','save-and-close','primary','check'))
  else returnToSettings()
}
function header() {
  const editing = state.view === 'editor'
  const title = editing ? state.title : state.view === 'runs' ? '工作流界面改版' : state.view === 'library' ? '工作流' : '角色'
  const subtitle = editing ? '从开工到交付，让每一步都有清晰的安排。' : state.view === 'runs' ? `完整功能开发 · 今天 14:20 开始 · 示例运行` : state.view === 'library' ? '选择合适的流程，开始下一件事。' : '为每一步选择合适的协作者。'
  return `<div class="page-header"><div class="grow"><div class="title-line"><button class="icon-btn back-to-settings" data-action="close-workspace" aria-label="关闭工作区，返回设置" title="返回设置">${icon('left')}</button><h1 id="workspace-title">${escape(title)}</h1>${editing ? badge('副本 · 草稿') : state.view==='runs' ? statusBadge() : ''}</div><p class="subline">${subtitle}</p></div>
    <div class="page-actions">${editing ? `<span class="saved-label" data-saved-label></span><button class="icon-btn undo-btn" aria-label="撤销最近修改" title="撤销最近修改" data-action="undo">${icon('undo')}</button>${button('保存草稿','save','','check')}${button('体验运行','try-run','primary','play')}` : state.view==='runs' ? button(state.paused?'继续运行':'暂停运行','pause',state.scenario==='running'?'':'quiet',state.paused?'play':'pause',state.scenario!=='running'?'disabled':'') : state.view==='library' ? button('新建工作流','new-workflow','primary','plus') : button('新建角色','new-role','primary','plus')}</div></div>
    <nav class="page-nav" aria-label="工作区导航">${[['editor','flow','编排'],['runs','play','运行'],['roles','users','角色']].map(([key,symbol,label])=>`<button class="nav-tab ${state.view===key?'active':''}" data-action="view" data-view="${key}" ${state.view===key?'aria-current="page"':''}>${icon(symbol)}${label}${key==='runs' && state.scenario==='approval'?'<span class="count">1</span>':''}</button>`).join('')}<span class="nav-spacer"></span><button class="workspace-close-link" data-action="close-workspace">返回设置 ${icon('close')}</button></nav>`
}
function hostRail() {
  return `<aside class="host-rail" aria-label="宿主导航示意"><div class="brand" title="Workflow Manager">${icon('flow')}</div><button class="rail-button" data-action="host-info" aria-label="宿主会话入口（示意）">${icon('chat')}会话</button><button class="rail-button active" data-action="view" data-view="library">${icon('flow')}工作流</button><button class="rail-button" data-action="view" data-view="roles">${icon('users')}角色</button><div class="rail-spacer"></div><button class="rail-button" data-action="design">${icon('settings')}说明</button><span class="avatar">C</span></aside>`
}
function outline() {
  return `<aside class="outline" aria-label="步骤目录"><div class="outline-title"><span>流程步骤</span><span>${state.nodes.length}</span></div>${state.nodes.map((node,i)=>`<button class="step-link ${state.selected===node.id?'active':''}" data-action="select" data-id="${node.id}" ${state.selected===node.id?'aria-current="step"':''}><span class="step-no">${ordinal(i)}</span>${escape(node.label)}</button>`).join('')}<button class="add-link" data-action="add-step">${icon('plus')}添加步骤</button><div class="outline-note">${icon('user')}<p>在准备验收后，由你决定通过或退回修改。</p></div></aside>`
}
function coordinates() {
  const compact = window.innerHeight <= 800
  const positions = compact ? [[25,62],[279,62],[533,62],[533,240],[279,240],[25,240]] : [[25,105],[279,105],[533,105],[533,326],[279,326],[25,326]]
  return state.nodes.map((node,i)=>({node,x:positions[i]?.[0] ?? 25+(i%3)*254,y:positions[i]?.[1] ?? 560+Math.floor((i-6)/3)*200}))
}
function flowCanvas() {
  const points = coordinates()
  const compact = window.innerHeight <= 800
  const cardH = compact ? 106 : 120
  let lines = ''
  for (let i=0;i<points.length-1;i++) {
    const a = points[i], b=points[i+1]
    const sx=a.x+101,sy=a.y+cardH/2,ex=b.x+101,ey=b.y+cardH/2
    let d
    if (a.y===b.y) d = a.x < b.x ? `M${a.x+202} ${sy}H${b.x-8}` : `M${a.x} ${sy}H${b.x+210}`
    else if (a.x===b.x) d=`M${sx} ${a.y+cardH}V${b.y-8}`
    else d=`M${sx} ${a.y+cardH}V${a.y+151}H${ex}V${b.y-8}`
    lines+=`<path class="flow-line ${i===1?'selected':''}" d="${d}" marker-end="url(#arrowhead)"/>`
  }
  if(state.workflow===0) lines+=`<path class="flow-line return" d="M634 105V72Q634 58 620 58H394Q380 58 380 72V96" marker-end="url(#returnhead)"/><rect class="flow-caption-bg" x="421" y="46" width="173" height="22" rx="4"/><text class="flow-caption return" x="507" y="61" text-anchor="middle">需要修改 · 回到实现任务</text><text class="flow-caption" x="648" y="278">通过</text><path class="flow-line" d="M126 446V465"/><path class="flow-line" d="M126 75V96" marker-end="url(#arrowhead)"/>`
  if(compact) lines = lines.replaceAll('634 105','634 62').replaceAll('V72','V35').replaceAll('634 58','634 23').replaceAll('620 58','620 23').replaceAll('394','394').replaceAll('380 58','380 23').replaceAll('380 72','380 35').replaceAll('V96','V53').replaceAll('y="46"','y="11"').replaceAll('y="61"','y="26"').replaceAll('y="278"','y="211"').replaceAll('126 446','126 346').replaceAll('V465','V363').replaceAll('126 75','126 39')
  const height = points.length > 6 ? 790+Math.max(0,Math.ceil((points.length-9)/3))*200 : compact ? 394 : 520
  return `<section class="canvas-panel" aria-label="工作流画布"><div class="canvas-toolbar"><div><h3>流程全景</h3><span class="muted small">选择一步，查看任务与后续安排</span></div><button class="icon-btn" data-action="fit" aria-label="适应画布" title="适应画布">${icon('fit')}</button></div><div class="canvas-body" tabindex="0" aria-label="可独立滚动的流程画布"><div class="flow-surface" style="height:${height}px"><svg class="flow-art" viewBox="0 0 760 ${height}" style="height:${height}px" aria-hidden="true"><defs><marker id="arrowhead" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M1 1L9 5L1 9" fill="none" stroke="var(--control)" stroke-width="1.6"/></marker><marker id="returnhead" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M1 1L9 5L1 9" fill="none" stroke="var(--warn)" stroke-width="1.6"/></marker></defs>${lines}</svg><span class="start-marker" style="top:${compact?14:48}px">开始 · 任务已确认</span>${points.map(({node,x,y},i)=>`<button class="node ${node.id===state.selected?'selected':''}" data-action="select" data-id="${node.id}" style="left:${x}px;top:${y}px" aria-label="步骤 ${i+1}：${escape(node.label)}" aria-pressed="${node.id===state.selected}"><span class="node-seq">${ordinal(i)}</span><span class="row"><span class="node-icon">${icon(node.icon)}</span><span><h4>${escape(node.label)}</h4><span class="node-role">AI · ${escape(node.role)}</span></span></span><span class="node-description">${escape(node.summary)}</span></button>`).join('')}${state.workflow===0?`<button class="human-gate" data-action="human-info" style="top:${compact?209:295}px;left:207px">${icon('user')}你来验收</button><span class="finish-marker" style="left:83px;top:${compact?371:474}px">${icon('check')}交付完成</span>`:''}</div></div><div class="canvas-footer"><div class="legend"><span><i></i>正常推进</span><span><i class="return"></i>退回修改</span><span>${icon('user')}人工决定</span></div><div class="row"><button class="icon-btn" data-action="zoom-out" aria-label="缩小画布">${icon('minus')}</button><span id="zoom-label">100%</span><button class="icon-btn" data-action="zoom-in" aria-label="放大画布">${icon('plus')}</button></div></div></section>`
}
function field(label, key, content, wide=false, help='') {
  return `<label class="field ${wide?'wide':''}"><span class="field-label">${label}</span>${content}${help?`<span class="help">${help}</span>`:''}</label>`
}
const input = (key,value) => `<input data-field="${key}" value="${escape(value)}">`
function choices(key,value,options) {
  return `<select data-field="${key}">${options.map(option=>`<option ${option===value?'selected':''}>${escape(option)}</option>`).join('')}</select>`
}
function formContent() {
  const n=selected(), i=indexOf(n.id)
  if(state.tab==='routes') return `<div class="note accent">用结果描述后续安排。每一种结果，都应有明确去向。</div><hr class="section-rule"><div class="route-card"><h4>${badge('符合要求','success','check')}</h4>${field('接下来执行','next',`<select data-field="next">${state.nodes.filter(item=>item.id!==n.id).map(item=>`<option value="${item.id}" ${n.next===item.id?'selected':''}>${escape(item.label)}</option>`).join('')}<option value="end" ${n.next==='end'?'selected':''}>结束流程</option></select>`)}<p>完成当前步骤后，自动进入指定步骤。</p></div><div class="route-card"><h4>${badge('需要修改','warn','undo')}</h4>${field('退回哪一步','returnTo',`<select data-field="returnTo">${state.nodes.map(item=>`<option value="${item.id}" ${n.returnTo===item.id?'selected':''}>${escape(item.label)}</option>`).join('')}</select>`)}<p>说明问题后返回修改，保留本次检查记录。</p></div><div class="route-card"><h4>${badge('暂时无法继续','','pause')}</h4><p>停止自动推进，并告诉你原因和恢复方式。</p></div>${field('最多自动返工','maxRounds',choices('maxRounds',n.maxRounds,['1','2','3','4','5']),false,'达到次数后交给你决定是否继续。')}`
  if(state.tab==='advanced') return `${field('使用哪个 AI 服务','aiService',choices('aiService',n.aiService,['跟随工作流设置','示例服务 A','示例服务 B']),false,'通常沿用工作流设置即可。这里的服务只用于演示。')}${field('选择模型','model',choices('model',n.model,['跟随工作流设置','示例模型 · 均衡','示例模型 · 深入分析']))}<hr class="section-rule"><label class="field-checkbox"><input type="checkbox" data-field="independent" ${n.independent?'checked':''}><span>由独立协作者检查<span class="help">让检查与执行相互独立，减少遗漏。</span></span></label><details class="detail-disclosure"><summary>技术详情</summary><p class="help">需要排查或导出配置时使用。</p><pre>${escape(JSON.stringify({id:n.id,role:n.role,output:{description:n.deliverable},routing:{next:n.next,returnTo:n.returnTo}},null,2))}</pre></details>`
  return `<div class="form-grid">${field('步骤名称','label',input('label',n.label))}${field('由谁完成','role',choices('role',n.role,[...new Set([n.role,...Object.values(roleNames),...(state.editedRole?[state.editedRole.name]:[])])]))}${field('这一步要做什么','goal',`<textarea data-field="goal" rows="5">${escape(n.goal)}</textarea>`,true,'用日常语言描述任务、要求和需要留意的事。')}<div class="wide"><hr class="section-rule"><span class="field-label">开始时会拿到什么</span><div class="input-source">${icon('file')}已确认的任务要求${badge('必要资料')}</div><div class="input-source">${icon('folder')}${i>0?escape(state.nodes[i-1].label)+'的成果':'本次任务的背景资料'}</div><span class="help">前一步的相关成果会随任务一起交给协作者。</span><hr class="section-rule"></div>${field('需要交付什么','deliverable',input('deliverable',n.deliverable),true,'写清楚你希望得到的结果，不必定义数据格式。')}<div class="note wide">${icon('info')} 说明越具体，协作者越容易按要求完成。保存前可以随时撤销调整。</div></div>`
}
function inspector() {
  const n=selected(),i=indexOf(n.id)
  return `<section class="inspector" aria-label="步骤配置"><div class="inspector-head"><div class="row between"><span class="eyebrow">步骤 ${ordinal(i)} / ${ordinal(state.nodes.length-1)}</span>${badge('AI 任务','accent')}</div><h2 style="margin-top:9px">${escape(n.label)}</h2><p>${escape(n.summary)}</p></div><div class="detail-tabs" aria-label="配置分类">${[['task','任务内容'],['routes','流转规则'],['advanced','更多设置']].map(([key,label])=>`<button class="detail-tab ${state.tab===key?'active':''}" data-action="tab" data-tab="${key}" aria-pressed="${state.tab===key}">${label}</button>`).join('')}</div><div class="inspector-scroll">${formContent()}</div><footer class="inspector-foot"><button class="btn quiet" data-action="previous-step" ${i===0?'disabled':''}>${icon('left')}上一步</button><span>${i+1} / ${state.nodes.length}</span><button class="btn quiet" data-action="next-step">${i===state.nodes.length-1?'回到开始':'下一步'}${icon('chevron')}</button></footer></section>`
}
function mobileBar() {
  return `<div class="mobile-toggle"><span>${indexOf(state.selected)+1}/${state.nodes.length} · ${escape(selected().label)}</span><div class="row">${button('选择步骤','select-step','quiet','flow')}${state.variant==='A'?button(state.mobile==='details'?'看流程':'看配置','mobile-toggle') : ''}</div></div>`
}
function phaseStrip(run=false) {
  const current=run ? state.runSelected : state.selected
  const steps=run ? runNodes : state.nodes
  return `<div class="phase-strip" aria-label="流程阶段">${steps.map((n,i)=>`<button class="phase ${current===n.id?'active':''}" data-action="${run?'run-select':'select'}" data-id="${n.id}" aria-pressed="${current===n.id}"><span class="phase-index">${run&&nodeStatus(n).kind==='success'?icon('check'):ordinal(i)}</span>${escape(n.label)}</button>${i<steps.length-1?`<span class="phase-divider">›</span>`:''}`).join('')}</div>`
}
function VariantA() { return `${mobileBar()}<div class="editor-a" data-mobile="${state.mobile}">${outline()}${flowCanvas()}${inspector()}</div>` }
function VariantB() {
  const i=indexOf(state.selected), n=selected()
  return `${mobileBar()}<div class="editor-b"><aside class="chapter-rail"><span class="eyebrow">一件事，一步步做好</span><h2>工作手册</h2><p>安排好每一步，剩下的交给协作。</p>${state.nodes.map((node,i)=>`<button class="chapter-link ${node.id===state.selected?'active':''}" data-action="select" data-id="${node.id}"><span class="chapter-number">${ordinal(i)}</span><span><strong>${escape(node.label)}</strong><small>${escape(node.role)}负责</small></span></button>`).join('')}<button class="add-link" data-action="add-step">${icon('plus')}添加一步</button></aside>${inspector()}<aside class="journey-aside"><span class="eyebrow">当前位置</span><div class="chapter-stamp">${ordinal(i)}</div><h3>先说清楚，<br>再交给协作者。</h3><p>这一页只安排「${escape(n.label)}」。接下来发生什么，也在这里说清楚。</p><div class="next-stop"><small>顺利完成后</small><strong>${escape(state.nodes.find(item=>item.id===n.next)?.label || '流程结束')}</strong><small>${escape(state.nodes.find(item=>item.id===n.next)?.summary || '整理好成果，完成本次任务。')}</small></div><div class="next-stop"><small>需要修改时</small><strong>带着具体问题退回</strong><small>保留每次结果，方便追溯。</small></div>${button('调整后续安排','show-routes','quiet','arrow')}</aside></div>`
}
function VariantC() {
  return `${mobileBar()}<div class="editor-c">${phaseStrip()}<div class="cockpit-body"><aside class="context-rail"><span class="eyebrow">安排当前步骤</span><h3>围绕成果协作</h3><button class="context-item ${state.tab==='task'?'active':''}" data-action="tab" data-tab="task">${state.tab==='task'?badge('正在设置','accent'):''}<strong>任务与交付</strong><p>描述你需要协作者完成的事。</p></button><button class="context-item ${state.tab==='routes'?'active':''}" data-action="tab" data-tab="routes"><strong>结果与下一步</strong><p>完成了去哪里，需要修改找谁。</p></button><button class="context-item ${state.tab==='advanced'?'active':''}" data-action="tab" data-tab="advanced"><strong>协作方式</strong><p>模型选择与独立检查。</p></button><hr class="section-rule"><div class="note warn">${icon('user')} 成果准备就绪后，最终验收由你决定。</div><button class="add-link" data-action="add-step">${icon('plus')}添加步骤</button><button class="btn quiet" style="margin-top:16px" data-action="mini-map">${icon('flow')}查看流程关系</button></aside>${inspector()}</div></div>`
}
function library() {
  const filtered = catalog.map((item,i)=>({item,i})).filter(({i})=>flowTitles[i].includes(state.search) || descriptions[i].includes(state.search))
  return `<section class="library"><div class="library-intro"><div><span class="eyebrow">从合适的起点开始</span><h2>把想做的事，交给流程。</h2><p>从熟悉的工作方式开始，复制后按需要调整。</p></div><label class="search-box">${icon('search')}<input aria-label="搜索流程" placeholder="搜索流程…" value="${escape(state.search)}" data-search></label></div><div class="template-grid">${filtered.map(({item,i})=>`<article class="template-card"><div class="row between"><span class="node-icon">${icon(['flow','flask','search','bolt'][i])}</span>${badge(i===0?'当前使用':'内置流程',i===0?'accent':'')}</div><h3>${flowTitles[i]}</h3><p>${descriptions[i]}</p><div class="mini-flow">${item.nodes.map((node,index)=>`<span>${escape(friendly[node.id]?.[0] || node.label)}</span>${index<item.nodes.length-1?icon('chevron'):''}`).join('')}</div><div class="row between"><span class="muted small">${item.nodes.length} 个步骤${i===0?' · 包含人工验收':''}</span>${button('使用此流程','use-template',i===0?'primary':'','arrow',`data-index="${i}"`)}</div></article>`).join('') || `<div class="empty"><h3>没有找到这个流程</h3><p>换一个关键词，或从现有流程开始创建。</p>${button('清除搜索','clear-search')}</div>`}</div></section>`
}
function roles() {
  return `<section class="library"><div class="library-intro"><div><span class="eyebrow">清晰分工，各司其职</span><h2>把事交给合适的人。</h2><p>角色说明负责什么；步骤说明这一次具体做什么。</p></div></div><div class="role-grid">${['开发者','审查员','测试员','验收助手','交付助手',...(state.editedRole?[state.editedRole.name]:[])].map((name,i)=>`<article class="role-card"><div class="row between"><span class="node-icon">${icon(['code','shield','flask','user','flag'][i] || 'user')}</span>${badge(i<5?'内置':'自定义')}</div><h3>${escape(name)}</h3><p>${['按已确认的要求完成任务，记录实现与变化。','独立检查成果，指出当前必须解决的问题。','实际运行成果，检查效果与原有功能。','整理你需要的验收材料，保留你的决定权。','整理交付记录，保留后续事项。'][i] || escape(state.editedRole?.description || '按你定义的职责参与工作。')}</p>${button('查看职责','role-detail','quiet','arrow',`data-name="${escape(name)}"`)}</article>`).join('')}</div></section>`
}
function statusBadge() {
  const kind={running:'accent',approval:'warn',blocked:'danger',completed:'success'}[state.scenario]
  const label=state.scenario==='running' ? state.paused?'已暂停':'进行中' : scenarioNames[state.scenario]
  return badge(label,kind,{running:state.paused?'pause':'play',approval:'user',blocked:'alert',completed:'check'}[state.scenario])
}
function nodeStatus(node) {
  const active=runIndex(state.activeRun), index=runIndex(node.id)
  if(state.scenario==='completed' || index<active) return {label:'已完成',kind:'success',icon:'check'}
  if(index>active) return {label:'尚未开始',kind:'',icon:'clock'}
  if(state.scenario==='approval') return {label:'等待你验收',kind:'warn',icon:'user'}
  if(state.scenario==='blocked') return {label:'需要处理',kind:'danger',icon:'alert'}
  return {label:state.paused?'已暂停':'正在进行',kind:'accent',icon:state.paused?'pause':'play'}
}
function runStepList() {
  return `<aside class="run-steps" aria-label="选择运行步骤"><span class="eyebrow">本次运行的进度</span>${runNodes.map(node=>{const status=nodeStatus(node);return `<button class="run-step ${state.runSelected===node.id?'active':''}" data-action="run-select" data-id="${node.id}" aria-pressed="${state.runSelected===node.id}"><span class="status-icon ${status.kind}">${icon(status.icon)}</span><span><strong>${escape(node.label)}</strong><small>${status.label}</small></span></button>`}).join('')}<div class="note" style="margin:22px 6px 0">${icon('info')} 选择步骤，在同一处查看结果与记录。</div></aside>`
}
function runContent() {
  const node=runNode(),status=nodeStatus(node),isCurrent=node.id===state.activeRun
  if(state.runTab==='activity') return `<div class="doc-eyebrow">操作与流转记录 · 示例</div><h3>发生了什么</h3>${[['14:20','开始本次任务','按已确认的任务要求准备实施。'],...runNodes.filter(item=>nodeStatus(item).kind==='success').map((item,i)=>['14:'+String(22+i*3).padStart(2,'0'),item.label+'完成',item.summary]),...(state.scenario==='completed'?[]:[['现在',nodeStatus(runNodes[runIndex(state.activeRun)]).label,runNodes[runIndex(state.activeRun)].label]]),...state.decisions.map(item=>['现在',item.label,item.note || '本页模拟决定。'])].map(([time,title,desc])=>`<div class="timeline-entry"><time>${time}</time><div><strong>${escape(title)}</strong><p>${escape(desc)}</p></div></div>`).join('')}`
  if(status.label==='尚未开始') return `<div class="empty"><span class="node-icon" style="margin:0 auto 15px">${icon('clock')}</span><h3>这一步还没有开始</h3><p>前面的步骤完成后，${escape(node.role)}会开始处理。<br>这里将集中展示本步骤的结果、检查与记录。</p>${button('回到当前步骤','current-run','primary','arrow')}</div>`
  if(isCurrent && state.scenario==='blocked') return `<div class="note" style="background:var(--danger-bg);color:var(--danger)">${icon('alert')} 测试环境尚未就绪，效果验证暂时无法继续。</div><h3 style="margin-top:24px">先恢复环境，再继续验证</h3><p>已完成的实现和审查记录仍然保留。请确认测试服务可以打开，再继续当前步骤。</p><ul class="check-list"><li>${icon('check')}任务要求与当前成果已保留</li><li>${icon('check')}审查已完成，无须重新开始</li><li>${icon('clock')}等待测试环境可用</li></ul><div class="note">演示操作：点击下方「环境已就绪，继续」，查看恢复后的页面。</div>`
  if(state.runTab==='checks') return `<div class="doc-eyebrow">检查记录 · 示例数据</div><h3>用证据确认结果</h3><p>每一项都关联当前成果。自动检查通过后，仍需由你决定是否验收。</p><ul class="check-list">${['配置面板独立滚动，画布保持可见','选中步骤后，在一个详情区查看成果','浅色与深色主题文字清晰','主路径和必要边界情况已检查'].map(label=>`<li>${icon('check')}<span>${label}<br><small class="muted">示例检查结论 · 非本产品真实验收</small></span></li>`).join('')}</ul><div class="note warn">验收提示：请实际体验长表单、切换主题与处理异常，确认符合你的使用习惯。</div>`
  if(isCurrent && state.scenario==='running') return `<div class="doc-eyebrow">当前进度 · 示例运行</div><h3>${state.paused?'已暂停，可以稍后继续':escape(node.role)+'正在'+escape(node.label)}</h3><p>${escape(node.goal)}</p><div class="deliverable"><span class="file-icon">${icon(node.icon)}</span><div class="grow"><strong>${state.paused?'任务停在这里，已有成果保留':'正在整理当前步骤的结果'}</strong><small>结果就绪后会在这里显示</small></div>${badge(state.paused?'已暂停':'进行中','accent',state.paused?'pause':'clock')}</div><div class="note">${state.paused?'点击顶部「继续运行」恢复本页演示。':'你可以先查看前面步骤的成果，当前任务会保持运行。'}</div>`
  const isAcceptance=node.id==='uat' || (isCurrent && state.scenario==='approval')
  return `<div class="doc-eyebrow">${isAcceptance?'等待你的决定':'本步骤的成果'} · 示例内容</div><h3>${isAcceptance?'界面改版，已经可以体验。':escape(node.label)+'已完成'}</h3><p>${isAcceptance?'新的编排界面把任务内容、后续安排与复杂设置分开呈现。请对照下面的验收材料，确认它是否更符合你的工作习惯。':escape(node.summary)+'。本步骤的成果与检查记录集中保留在这里，便于你快速了解结果。'}</p><div class="deliverable"><span class="file-icon">${icon('file')}</span><div class="grow"><strong>${isAcceptance?'成果摘要与体验清单':escape(node.deliverable)}</strong><small>${isAcceptance?'4 个体验要点 · 版本 02':'本步骤工作记录 · 版本 01'}</small></div>${button('查看','preview-file','quiet','arrow')}</div><h4 style="font-family:var(--body);font-size:12px;margin:22px 0 8px">${isAcceptance?'这次需要你确认':'结果摘要'}</h4><ul class="check-list"><li>${icon('check')}配置长表单时，是否仍然清楚自己在改哪一步</li><li>${icon('check')}成果与检查记录，是否容易找到和对照</li><li>${icon('check')}浅色与深色主题，是否都清晰舒适</li></ul><div class="note ${isAcceptance?'warn':'success'}">${icon(isAcceptance?'user':'check')}${isAcceptance?'自动检查与人工验收分开记录。你的决定将影响流程的下一步。':'本页为设计演示。以上内容不代表正式产品检查或验收已经通过。'}</div>`
}
function decisionBar() {
  const isCurrent=state.runSelected===state.activeRun
  if(!isCurrent) return `<footer class="decision-bar"><small>正在查看：${escape(runNode().label)}</small>${button('回到当前步骤','current-run','quiet','arrow')}</footer>`
  if(state.scenario==='approval') return `<footer class="decision-bar"><small>${icon('user')} 由你决定下一步</small><div class="row">${button('退回修改','decision-return','','undo')}${button('验收通过','decision-accept','primary','check')}</div></footer>`
  if(state.scenario==='blocked') return `<footer class="decision-bar"><small>环境恢复后，继续当前步骤</small>${button('环境已就绪，继续','recover','primary','play')}</footer>`
  if(state.scenario==='completed') return `<footer class="decision-bar"><small>${icon('check')} 本次任务已完成 · 示例</small>${button('查看交付摘要','preview-file','','file')}</footer>`
  return `<footer class="decision-bar"><small>${state.paused?'暂停期间保留所有已完成结果':'当前步骤：'+escape(runNode().label)}</small>${badge(state.paused?'已暂停':'进行中','accent',state.paused?'pause':'clock')}</footer>`
}
function runWork() {
  const n=runNode(),status=nodeStatus(n)
  return `<section class="run-work" aria-label="选中步骤的唯一详情区"><div class="run-work-head"><div>${badge('步骤 '+ordinal(runIndex(n.id)), 'accent')}<h2>${escape(n.label)}</h2><p>${state.scenario==='approval'&&state.activeRun===n.id?'当前成果已完成自动检查。接下来，由你决定是否通过验收。':escape(n.summary)}</p></div></div><article class="run-document"><div class="row between" style="padding:14px 22px 0"><span class="small muted">${escape(n.role)} · 本次结果</span>${badge(status.label,status.kind,status.icon)}</div><div class="detail-tabs" aria-label="结果分类">${[['result','成果'],['checks','检查'],['activity','活动记录']].map(([key,label])=>`<button class="detail-tab ${state.runTab===key?'active':''}" data-action="run-tab" data-tab="${key}" aria-pressed="${state.runTab===key}">${label}</button>`).join('')}</div><div class="run-doc-scroll">${runContent()}</div>${decisionBar()}</article></section>`
}
function runMeta() {
  return `<aside class="run-meta"><h3>本次任务</h3><div class="meta-line"><small>任务目标</small><strong>让工作流更容易理解与使用</strong></div><div class="meta-line"><small>采用流程</small><strong>完整功能开发</strong></div><div class="meta-line"><small>当前成果</small><strong>版本 02</strong></div><div class="meta-line"><small>已返工</small><strong>1 次 / 最多 3 次</strong></div><div class="meta-line"><small>开始时间</small><strong>今天 14:20</strong></div><div class="note" style="margin-top:24px">${icon('file')} 输入、成果和决定都随本次任务保留。</div><button class="btn quiet" style="margin-top:16px" data-action="run-history">${icon('clock')}查看其他运行</button></aside>`
}
function runView() {
  if(state.variant==='B') return `<div class="run-b">${runStepList()}${runWork()}</div>`
  if(state.variant==='C') return `<div class="run-c">${phaseStrip(true)}<div class="cockpit-body"><aside class="context-rail"><span class="eyebrow">需要你的关注</span><h3>今天的工作现场</h3><button class="context-item active" data-action="current-run">${statusBadge()}<strong>工作流界面改版</strong><p>完整功能开发</p></button><button class="context-item" data-action="run-history">${badge('已完成','success','check')}<strong>表单提交异常</strong><p>今天 11:32 · 诊断与修复</p></button><hr class="section-rule"><span class="eyebrow">当前任务</span><div class="meta-line"><small>当前成果</small><strong>版本 02</strong></div><div class="meta-line"><small>已返工</small><strong>1 次 / 最多 3 次</strong></div><p class="help" style="margin-top:18px">点击上方阶段，在同一区域查看任何一步的结果。</p></aside>${runWork()}</div></div>`
  return `<div class="run-layout">${runStepList()}${runWork()}${runMeta()}</div>`
}
function PrototypeSwitcher() {
  document.querySelector('#prototype-switcher').innerHTML=`<div class="prototype-caption"><strong>一次性 UI 原型</strong><br>示例数据 · 操作仅本页有效</div><div class="switcher-pill"><button class="icon-btn" data-action="variant-prev" aria-label="上一个设计方向" title="上一个方向（←）">${icon('left')}</button><button class="variant-label" data-action="pick-variant" aria-label="选择设计方向">${state.variant} · ${names[state.variant]}<small>原型 · ${subtitles[state.variant]}</small></button><button class="icon-btn" data-action="variant-next" aria-label="下一个设计方向" title="下一个方向（→）">${icon('chevron')}</button><span class="switcher-divider"></span><div class="theme-choice" aria-label="主题"><button class="${state.theme==='light'?'active':''}" data-action="theme" data-theme="light" aria-pressed="${state.theme==='light'}">${icon('sun')}浅色</button><button class="${state.theme==='dark'?'active':''}" data-action="theme" data-theme="dark" aria-pressed="${state.theme==='dark'}">${icon('moon')}深色</button></div><span class="switcher-divider"></span><select aria-label="演示运行场景" data-scenario><option value="" ${state.view!=='runs'?'selected':''}>体验运行状态</option>${[['approval','等待验收'],['running','进行中'],['blocked','需要处理'],['completed','已完成']].map(([key,label])=>`<option value="${key}" ${state.view==='runs'&&state.scenario===key?'selected':''}>${label}</option>`).join('')}</select><button class="info-btn" data-action="design">${icon('info')}设计说明</button></div><div class="state-strip" aria-live="polite"></div>`
}
function fitCanvas() {
  const container=document.querySelector('.canvas-body'),surface=document.querySelector('.flow-surface')
  if(!container||!surface) return
  const available=Math.max(0,container.clientWidth-20)
  const fitted=Math.min(1,available/760,(container.clientHeight-6)/parseInt(surface.style.height))
  const effective=Math.max(.8,fitted)*state.zoom
  surface.style.zoom=effective
  const label=document.querySelector('#zoom-label')
  if(label) label.textContent=Math.round(effective*100)+'%'
}
function render() {
  const oldSettings=document.querySelector('.settings-content')
  if(oldSettings) state.settingsScroll=oldSettings.scrollTop
  const previousSurface=document.documentElement.dataset.surface
  const focus=document.activeElement
  const focusAction=focus?.dataset?.action
  const focusId=focus?.dataset?.id
  const focusTab=focus?.dataset?.tab
  const focusTheme=focus?.dataset?.theme
  const focusView=focus?.dataset?.view
  document.documentElement.dataset.theme=state.theme
  document.documentElement.dataset.variant=state.variant
  document.documentElement.dataset.surface=state.surface
  app.innerHTML=`${hostScenery()}${state.surface!=='host'?settingsSurface():''}${state.surface==='workspace'?`<div class="workspace-layer"><section class="workspace-shell" role="dialog" aria-modal="true" aria-labelledby="workspace-title"><div class="work-area">${header()}<main id="main" tabindex="-1">${state.view==='editor'?({A:VariantA,B:VariantB,C:VariantC}[state.variant])():state.view==='runs'?runView():roles()}</main></div></section></div>`:''}`
  PrototypeSwitcher()
  updateStateDisplay()
  urlState()
  requestAnimationFrame(()=>{fitCanvas();document.querySelector('.phase.active')?.scrollIntoView({block:'nearest',inline:'center'})})
  const settingsContent=document.querySelector('.settings-content')
  if(settingsContent) settingsContent.scrollTop=state.settingsScroll
  document.querySelector('.skip-link').href=state.surface==='workspace'?'#main':'#settings-content'
  if(previousSurface!==state.surface) document.querySelector(state.surface==='workspace'?'.back-to-settings':state.surface==='settings'?'.settings-tabs button.active':'.dsh-settings-launch button')?.focus({preventScroll:true})
  if(focusAction) {
    const matches=[...document.querySelectorAll('[data-action]')].filter(el=>el.dataset.action===focusAction && (!focusId||el.dataset.id===focusId) && (!focusTab||el.dataset.tab===focusTab) && (!focusTheme||el.dataset.theme===focusTheme) && (!focusView||el.dataset.view===focusView))
    matches.find(el=>el.getClientRects().length&&!el.closest('[inert]'))?.focus({preventScroll:true})
  }
}
function openDialog(title,content,footer='') {
  dialogFocus=document.activeElement
  modal.innerHTML=`<header class="modal-head"><h2 id="modal-title">${title}</h2><button class="icon-btn" data-action="close-modal" aria-label="关闭对话框">${icon('close')}</button></header><div class="modal-content">${content}</div>${footer?`<footer class="modal-foot">${footer}</footer>`:''}`
  if(!modal.open) modal.showModal()
}
function closeDialog() {
  modal.close()
  if(dialogFocus?.isConnected) dialogFocus.focus({preventScroll:true})
}
function designDialog() {
  const styles=getComputedStyle(document.documentElement)
  const tokenNames=['画布','表面','正文','次要正文','强调色','强调底色']
  const tokens=['--bg','--surface','--ink','--muted','--accent','--tint']
  openDialog(`${state.variant} · ${names[state.variant]}`,`<p>一次性 UI 原型，所有运行、成果和决定均为演示。三个方向共用相同内容，可用底部箭头或键盘 ← → 对照；输入文字时不会拦截方向键。</p><div class="note accent">${{A:'重点：看懂整条流程。画布、步骤目录、配置栏分别滚动，主要操作始终可见。',B:'重点：轻松完成配置。步骤即章节，宽表单集中处理当前任务，右侧说明接下来怎么走。',C:'重点：处理眼前的任务。阶段带保持方位，成果和需要你做的决定集中在工作区。'}[state.variant]}</div><h3>视觉方向 · ${state.theme==='light'?'浅色':'深色'}</h3><div class="swatches">${tokens.map((token,i)=>{const color=styles.getPropertyValue(token).trim();return `<div class="swatch"><div class="swatch-color" style="background:${color}"></div><span>${tokenNames[i]}</span><span>${color}</span></div>`}).join('')}</div><p>标题：${state.variant==='B'?'Songti SC，带有手册的阅读感':'Avenir Next / PingFang SC，紧凑清晰'}。正文：PingFang SC，14px。数据：SFMono。所有字体优先使用本地字体。</p><h3>小入口，大工作区</h3><p>设置弹窗约 800px 宽，只呈现流程列表、运行摘要与角色。编辑流程或查看成果时，打开更大的独立工作区；返回时保留列表位置。未保存的修改会先提醒你。两层弹窗均使用不透明背景，避免宿主壁纸影响阅读。</p><h3>一起体验这四件事</h3><ul><li>把「任务内容」滚到底，观察步骤位置是否仍清楚。</li><li>修改任务说明、撤销、保存，再切换方向。</li><li>进入运行，在同一详情区查看成果、检查和记录。</li><li>选择「需要处理」和「等待验收」，试试恢复与验收决定。</li></ul><h3>依据与边界</h3><p>采用 <a href="https://www.nngroup.com/articles/progressive-disclosure/" target="_blank" rel="noreferrer">NN/G 渐进呈现</a>、<a href="https://www.nngroup.com/articles/ten-usability-heuristics/" target="_blank" rel="noreferrer">可用性原则</a>及 <a href="https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html" target="_blank" rel="noreferrer">WCAG 文字对比度</a>作为设计基准。颜色成对定义，状态带文字和图标。原型检查不等于完整无障碍认证或正式产品验收。</p><details class="detail-disclosure"><summary>查看完整相关状态</summary><pre id="full-state">${escape(JSON.stringify(currentState(),null,2))}</pre></details>`)
}
function changeVariant(offset) {
  state.variant=['A','B','C'][(['A','B','C'].indexOf(state.variant)+offset+3)%3]
  render()
  toast(`${state.variant} · ${names[state.variant]}，当前内容与修改已保留`)
}
function chooseScenario(scenario) {
  if(!scenario)return
  state.view='runs';state.scenario=scenario;state.paused=false
  if(state.surface!=='workspace'){state.surface='settings';state.settingsView='runs'}
  const conventional={approval:'uat',running:'review',blocked:'test',completed:'closeout'}[scenario]
  state.activeRun=conventional
  state.runSelected=state.activeRun;state.runTab='result'
  render()
}
function ensureSave() {
  const invalid=state.nodes.find(node=>!node.label.trim() || !node.goal.trim())
  if(invalid) {
    state.selected=invalid.id;state.tab='task';state.view='editor';render()
    openDialog('还有一项需要补充',`<div class="note warn">${escape(invalid.label || '未命名步骤')}缺少${!invalid.label.trim()?'步骤名称':'任务说明'}。填写后再保存。</div>`,button('回去填写','close-modal','primary'))
    return false
  }
  saved=JSON.stringify(state.nodes);state.dirty=false;render();toast('草稿已保存在本页；刷新后恢复示例')
  return true
}
function switchTemplate(index,title) {
  state.workflow=index;state.title=title || flowTitles[index]+' · 副本';state.nodes=makeSteps(catalog[index]);state.selected=state.nodes[Math.min(2,state.nodes.length-1)].id
  state.view='editor';state.tab='task';state.dirty=false;state.search='';undo=[];saved=JSON.stringify(state.nodes)
  state.surface='workspace'
  render();toast('已打开独立工作区，可以在这里编辑')
}
document.addEventListener('click',event=>{
  const target=event.target.closest('[data-action]')
  if(!target || target.disabled)return
  const action=target.dataset.action
  if(action==='variant-prev')changeVariant(-1)
  else if(action==='variant-next')changeVariant(1)
  else if(action==='theme'){state.theme=target.dataset.theme;render()}
  else if(action==='open-settings'){state.surface='settings';state.view=state.settingsView;render()}
  else if(action==='close-settings'){state.surface='host';render()}
  else if(action==='settings-home'){state.settingsView='library';state.view='library';render()}
  else if(action==='settings-tab'){state.settingsView=target.dataset.view;state.view=state.settingsView;state.settingsScroll=0;const content=document.querySelector('.settings-content');if(content)content.scrollTop=0;render()}
  else if(action==='open-editor'){
    const index=Number(target.dataset.index)
    if(index===state.workflow){state.surface='workspace';state.view='editor';render()}
    else switchTemplate(index)
  }
  else if(action==='open-run'){state.surface='workspace';state.view='runs';state.runSelected=state.activeRun;render()}
  else if(action==='close-workspace')requestWorkspaceClose()
  else if(action==='save-and-close'){closeDialog();if(ensureSave())returnToSettings()}
  else if(action==='discard-and-close'){state.nodes=JSON.parse(saved);state.dirty=false;undo=[];closeDialog();returnToSettings()}
  else if(action==='view'){state.view=target.dataset.view;render()}
  else if(action==='select'){state.selected=target.dataset.id;state.mobile='details';render()}
  else if(action==='tab'){state.tab=target.dataset.tab;render()}
  else if(action==='show-routes'){state.tab='routes';render()}
  else if(action==='next-step' || action==='previous-step'){state.selected=state.nodes[(indexOf(state.selected)+(action==='next-step'?1:-1)+state.nodes.length)%state.nodes.length].id;render()}
  else if(action==='save')ensureSave()
  else if(action==='undo'){
    if(!undo.length){toast('还没有可撤销的修改');return}
    state.nodes=JSON.parse(undo.pop());if(!state.nodes.some(n=>n.id===state.selected))state.selected=state.nodes[0].id;state.dirty=JSON.stringify(state.nodes)!==saved;render();toast('已撤销最近修改')
  }
  else if(action==='try-run'){chooseScenario('running');toast('正在体验完整功能开发的示例运行，编辑草稿已保留')}
  else if(action==='pause'){if(state.scenario!=='running')return;state.paused=!state.paused;render();toast(state.paused?'模拟运行已暂停，已有结果保留':'模拟运行已继续')}
  else if(action==='run-select'){state.runSelected=target.dataset.id;state.runTab='result';render()}
  else if(action==='run-tab'){state.runTab=target.dataset.tab;render()}
  else if(action==='current-run'){state.runSelected=state.activeRun;state.runTab='result';render()}
  else if(action==='recover'){state.scenario='running';state.paused=false;render();toast('环境恢复后的继续状态已模拟，正在验证效果')}
  else if(action==='mobile-toggle'){state.mobile=state.mobile==='details'?'canvas':'details';render()}
  else if(action==='fit'){state.zoom=1;fitCanvas();document.querySelector('.canvas-body')?.scrollTo(0,0)}
  else if(action==='zoom-in' || action==='zoom-out'){state.zoom=Math.min(1.6,Math.max(.8,state.zoom+(action==='zoom-in'?.1:-.1)));fitCanvas()}
  else if(action==='design')designDialog()
  else if(action==='close-modal')closeDialog()
  else if(action==='host-info')openDialog('宿主导航示意','<p>这里保留了 DSH 宿主的导航占位，帮助判断插件在应用中的空间。工作流的编排、运行和角色界面可直接体验。</p>')
  else if(action==='human-info')openDialog('由你决定是否验收','<p>验收助手先整理成果和检查记录。你可以选择通过、附带后续建议通过，或说明问题并退回修改。</p><div class="note warn">AI 的自动检查不会替你做最终验收决定。</div>',button('体验验收界面','open-approval','primary','arrow'))
  else if(action==='open-approval'){closeDialog();state.surface='workspace';chooseScenario('approval')}
  else if(action==='pick-variant')openDialog('选择设计方向',['A','B','C'].map(key=>`<button class="variant-option ${state.variant===key?'active':''}" data-action="set-variant" data-variant="${key}"><b>${key}</b><span><strong>${names[key]}</strong><p>${subtitles[key]}</p></span></button>`).join(''))
  else if(action==='set-variant'){state.variant=target.dataset.variant;closeDialog();render()}
  else if(action==='select-step')openDialog('选择步骤',state.nodes.map((n,i)=>`<button class="variant-option" data-action="modal-step" data-id="${n.id}"><b>${ordinal(i)}</b><span><strong>${escape(n.label)}</strong><p>${escape(n.summary)}</p></span></button>`).join(''))
  else if(action==='modal-step'){state.selected=target.dataset.id;closeDialog();render()}
  else if(action==='mini-map')openDialog('流程关系',`<div class="stack">${state.nodes.map((n,i)=>`<div class="row">${badge(ordinal(i),'accent')}<strong class="small">${escape(n.label)}</strong><span class="muted small">${i<state.nodes.length-1?'→ '+escape(state.nodes[i+1].label):'→ 结束'}</span></div>`).join('')}</div><hr class="section-rule"><div class="note warn">需要修改时，带着检查记录返回对应步骤；准备验收后由你决定。</div>`)
  else if(action==='preview-file')openDialog('成果摘要与体验清单',`<div class="row between"><h3>工作流界面改版</h3>${badge('示例成果')}</div><p>当前版本 02 · 由验收助手整理</p><h3>体验步骤</h3><ul><li>进入编排，选择「检查成果」，将任务内容滚动到底。</li><li>在底部切换浅色和深色，检查说明文字、表单与按钮。</li><li>进入运行，切换成果、检查、活动记录。</li><li>体验暂停、异常恢复与人工验收。</li></ul><div class="note warn">这是一份演示材料。正式运行时，这里会展示与当前成果版本绑定的真实文件。</div>`)
  else if(action==='decision-accept')openDialog('确认本次验收决定',`<p>通过后，流程进入「完成交付」。若还有不阻断本次交付的建议，可以一并保留。</p><label class="field-checkbox"><input id="conditional" type="checkbox"><span>附带后续建议通过</span></label><label class="field" style="margin-top:16px"><span class="field-label">后续建议<span class="optional">选填</span></span><textarea id="decision-note" rows="3" placeholder="例如：下次优化小屏幕的流程总览"></textarea></label><div class="note">这是原型中的模拟验收，不会写入任何真实运行。</div>`,button('取消','close-modal')+button('确认通过（模拟）','confirm-accept','primary','check'))
  else if(action==='decision-return')openDialog('说明需要修改的地方',`<p>具体说明哪里不符合要求。流程会带着这些意见回到「实现任务」。</p><label class="field"><span class="field-label">需要修改的问题</span><textarea id="decision-note" rows="4" placeholder="例如：配置内容滚动后，我仍然找不到下一步操作"></textarea></label><p id="decision-error" class="inline-error" role="alert"></p><div class="note">这是原型中的模拟退回。</div>`,button('取消','close-modal')+button('退回修改（模拟）','confirm-return','primary','undo'))
  else if(action==='confirm-accept' || action==='confirm-return'){
    const note=modal.querySelector('#decision-note')?.value.trim() || ''
    const conditional=modal.querySelector('#conditional')?.checked
    if(action==='confirm-return' && !note){modal.querySelector('#decision-error').textContent='请先写明需要修改的问题，协作者才能继续。';modal.querySelector('#decision-note').focus();return}
    if(conditional && !note){toast('请填写需要保留的后续建议');modal.querySelector('#decision-note').focus();return}
    state.decisions.push({label:action==='confirm-return'?'退回修改':conditional?'有条件通过':'验收通过',note})
    state.scenario='running';state.paused=false;state.activeRun=action==='confirm-return'?'dev':'closeout';state.runSelected=state.activeRun;state.runTab='result'
    closeDialog();render();toast(action==='confirm-return'?'已模拟退回，修改意见已随任务保留':'已记录模拟验收决定，进入交付步骤')
  }
  else if(action==='run-history')openDialog('运行记录',`<p>示例记录帮助判断查找与恢复体验。</p><button class="variant-option" data-action="open-approval"><span class="status-icon warn">${icon('user')}</span><span><strong>工作流界面改版</strong><p>今天 14:20 · 等待你验收</p></span></button><button class="variant-option" data-action="history-completed"><span class="status-icon success">${icon('check')}</span><span><strong>工作流界面改版 · 上次演示</strong><p>昨天 16:05 · 已完成</p></span></button>`)
  else if(action==='history-completed'){closeDialog();state.surface='workspace';chooseScenario('completed')}
  else if(action==='clear-search'){state.search='';render()}
  else if(action==='new-workflow')openDialog('创建工作流副本',`<p>从已有流程开始，调整成适合自己的工作方式。</p><label class="field"><span class="field-label">工作流名称</span><input id="workflow-name" value="我的工作流"></label><label class="field"><span class="field-label">从哪套流程开始</span><select id="template-choice">${flowTitles.map((name,i)=>`<option value="${i}">${name}</option>`).join('')}</select></label><p id="create-error" class="inline-error" role="alert"></p>`,button('取消','close-modal')+button('创建副本','create-workflow','primary','plus'))
  else if(action==='create-workflow'){
    const title=modal.querySelector('#workflow-name').value.trim(),index=Number(modal.querySelector('#template-choice').value)
    if(!title){modal.querySelector('#create-error').textContent='给工作流起一个名字，方便之后找到。';return}
    closeDialog();switchTemplate(index,title)
  }
  else if(action==='use-template'){
    const index=Number(target.dataset.index)
    if(state.dirty){openDialog('当前草稿还没有保存','<p>先保存当前草稿，或舍弃本页修改后创建新的流程副本。</p>',button('继续编辑','close-modal')+button('舍弃修改并创建','discard-use','', '',`data-index="${index}"`))}
    else switchTemplate(index)
  }
  else if(action==='discard-use'){const i=Number(target.dataset.index);closeDialog();switchTemplate(i)}
  else if(action==='add-step')openDialog('添加一步',`<p>先写清楚希望完成的事，之后可以继续设置角色和结果。</p><label class="field"><span class="field-label">步骤名称</span><input id="new-step-name" placeholder="例如：整理交付说明"></label><label class="field"><span class="field-label">放在哪里</span><select id="new-step-after">${state.nodes.map(n=>`<option value="${n.id}" ${n.id===state.selected?'selected':''}>${escape(n.label)}之后</option>`).join('')}</select></label><p id="create-error" class="inline-error" role="alert"></p>`,button('取消','close-modal')+button('添加步骤','confirm-add','primary','plus'))
  else if(action==='confirm-add'){
    const label=modal.querySelector('#new-step-name').value.trim(),after=modal.querySelector('#new-step-after').value
    if(!label){modal.querySelector('#create-error').textContent='请填写步骤名称。';return}
    undo.push(JSON.stringify(state.nodes));const index=indexOf(after);const id='step-'+Date.now()
    state.nodes.splice(index+1,0,{...selected(),id,label,icon:'file',summary:'完成这一项工作，并交给下一步。',goal:'请描述这一步需要完成的任务。',role:'AI 助手',next:state.nodes[index+1]?.id || 'end',returnTo:after})
    state.nodes[index].next=id;state.selected=id;state.tab='task';state.dirty=true;closeDialog();render();toast('已添加步骤，可继续完善任务内容')
  }
  else if(action==='role-detail')openDialog(escape(target.dataset.name)+'的职责',`<p>${target.dataset.name===state.editedRole?.name?escape(state.editedRole.description):'在每个步骤中遵循已确认的要求，保留成果和必要说明。遇到影响目标或验收的未决事项时，交给用户决定。'}</p><div class="note">内置角色在正式产品中保持只读；在本原型中可用「新建角色」体验自定义入口。</div>`)
  else if(action==='new-role')openDialog('新建角色',`<label class="field"><span class="field-label">角色名称</span><input id="role-name" placeholder="例如：体验检查员"></label><label class="field"><span class="field-label">主要职责</span><textarea id="role-description" placeholder="这个角色负责什么，应该交付什么？"></textarea></label><p id="create-error" class="inline-error" role="alert"></p>`,button('取消','close-modal')+button('创建角色','confirm-role','primary','plus'))
  else if(action==='confirm-role'){
    const name=modal.querySelector('#role-name').value.trim(),desc=modal.querySelector('#role-description').value.trim()
    if(!name||!desc){modal.querySelector('#create-error').textContent='请填写角色名称与职责。';return}
    state.editedRole={name,description:desc};closeDialog();render();toast('已在本页创建角色示例')
  }
})
document.addEventListener('focusin',event=>{
  if(event.target.dataset.field) undo.push(JSON.stringify(state.nodes))
})
document.addEventListener('input',event=>{
  const target=event.target
  if(target.dataset.field) {
    selected()[target.dataset.field]=target.type==='checkbox'?target.checked:target.value
    state.dirty=JSON.stringify(state.nodes)!==saved;updateStateDisplay()
  }
  if(target.hasAttribute('data-search')) {
    const start=target.selectionStart
    state.search=target.value;render()
    const next=document.querySelector('[data-search]');next?.focus();next?.setSelectionRange(start,start)
  }
})
document.addEventListener('change',event=>{
  const target=event.target
  if(target.hasAttribute('data-scenario')) chooseScenario(target.value)
  if(target.dataset.field && target.tagName==='SELECT') {selected()[target.dataset.field]=target.value;state.dirty=JSON.stringify(state.nodes)!==saved;updateStateDisplay()}
})
document.addEventListener('keydown',event=>{
  if(modal.open)return
  if(event.key==='Escape'){event.preventDefault();if(state.surface==='workspace')requestWorkspaceClose();else if(state.surface==='settings'){state.surface='host';render()}return}
  if(event.target.closest('input,textarea,select,[contenteditable=true]') || event.altKey || event.ctrlKey || event.metaKey)return
  if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();changeVariant(event.key==='ArrowLeft'?-1:1)}
})
modal.addEventListener('click',event=>{if(event.target===modal){const r=modal.getBoundingClientRect();if(event.clientX<r.left || event.clientX>r.right || event.clientY<r.top || event.clientY>r.bottom)closeDialog()}})
modal.addEventListener('close',()=>{if(dialogFocus?.isConnected)dialogFocus.focus({preventScroll:true})})
let lastCompact = window.innerHeight <= 800
window.addEventListener('resize',()=>{if(lastCompact !== (window.innerHeight <= 800)){lastCompact = window.innerHeight <= 800;render()}else fitCanvas()})
window.addEventListener('popstate',()=>{const p=new URLSearchParams(location.search);state.variant=['A','B','C'].includes(p.get('variant'))?p.get('variant'):'A';state.theme=p.get('theme')==='dark'?'dark':'light';render()})
render()
