// host.js 单元测试：双根加载（T-IMP-06）/ DSL 校验（Gold-Band 同构规则）/ 编译 / RPC /
// 异源硬规则（T-IMP-07）/ 角色回退
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const realGenerated = join(here, '..', '..', '..', '.generated', 'dev-workflow-2-0', 'vwf-dsl.json')

// ── 共享假服务（helpers/fake-services.mjs）与共享加载器（helpers/load-host.mjs）──
import { loadHost, ROLE_CORE_SEED } from './helpers/load-host.mjs'
import { REPO, SESSION_REPO, HOME, DSH_HOME, USER_DIR, SKILL_ROOT, makeFs, makeSubprocess, sandboxPolicy } from './helpers/fake-services.mjs'

const call = async (handlers, method, args) => handlers.get(method)(args)
const MINIMAL_BUILTIN = JSON.stringify({
  id: 'dev-workflow-2-0', name: '开发工作流 2.0', description: '内置最小样例', entry: 'dispatch',
  control: { maxRounds: 9 },
  nodes: [
    { id: 'dispatch', profile: 'dispatcher', label: '调度', goal: 'g', model: { provider: 'p1', model: 'm1' } },
    { id: 'closeout', profile: 'closeout', label: '收口', goal: 'g', manualCheck: true, model: { provider: 'p1', model: 'm1' } },
  ],
  edges: [
    { from: 'dispatch', to: 'closeout', on: 'success' },
    { from: 'closeout', to: '$end', on: 'success' },
  ],
}, null, 2) + '\n'
const OFFICIAL_BUILTIN = JSON.stringify({
  id: 'official-builtin', name: '正式内置样例', description: '仍占内置身份', entry: 'dispatch',
  control: { maxRounds: 9 },
  nodes: [
    { id: 'dispatch', profile: 'dispatcher', label: '调度', goal: 'g', model: { provider: 'p1', model: 'm1' } },
  ],
  edges: [
    { from: 'dispatch', to: '$end', on: 'success' },
  ],
}, null, 2) + '\n'
const REMOVED_DIR = DSH_HOME + '/visual-workflow/removed'

function plantOfficialBuiltin(fs) {
  fs._files.set(REPO + '/.generated/official-builtin/vwf-dsl.json', OFFICIAL_BUILTIN)
}

// 统一校验内核（候选二 T-IMP-13）：宿主经 fs 读源码求值——测试假 fs 需种入真实内核
const validatorCoreSrc = readFileSync(join(here, '..', '..', '..', 'scripts', 'validate-core.cjs'), 'utf8')

function seedFs(extra = {}) {
  const seed = {
    [REPO + '/.generated/dev-workflow-2-0/vwf-dsl.json']: existsSync(realGenerated) ? readFileSync(realGenerated, 'utf8') : MINIMAL_BUILTIN,
    [REPO + '/scripts/validate-core.cjs']: validatorCoreSrc,
  }
  Object.assign(seed, extra)
  return makeFs(seed)
}

function env({ failPattern, extra = {} } = {}) {
  const fs = seedFs()
  // 统一编译器管道（T-IMP-12）：vwf.script 走 CLI compile——模拟输出用真实生成物（存在时）
  const compileScript = existsSync(realGenerated)
    ? readFileSync(join(here, '..', '..', '..', '.generated', 'dev-workflow-2-0', 'script.mjs'), 'utf8')
    : '//MOCK-SCRIPT'
  const sub = makeSubprocess({ failPattern, fs, compileScript })
  const { handlers, definedTools, events, ctx } = loadHost({ fs, subprocess: sub, sandboxPolicy, ...extra })
  return { handlers, definedTools, events, ctx, fs, sub }
}

function baseDsl(overrides = {}) {
  const dsl = {
    id: 't1',
    name: '测试工作流',
    entry: 'a',
    control: { maxRounds: 3 },
    nodes: [
      { id: 'a', profile: 'dispatcher', label: 'A', goal: '目标A', model: { provider: 'p1', model: 'm1' }, output: { schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }, successCondition: '$.ok == true' } },
      { id: 'b', profile: 'dev', label: 'B', goal: '目标B', model: { provider: 'p1', model: 'm1' } },
    ],
    edges: [
      { from: 'a', to: 'b', on: 'success' },
      { from: 'a', to: '$end', on: 'failure' },
      { from: 'b', to: '$end', on: 'success' },
      { from: 'b', to: 'a', on: 'failure' },
    ],
  }
  return { ...dsl, ...overrides }
}

// 含 dev+review 节点的合法结构（异源检查对象；走通性：dev 有成功条件须带 failure 出口）
function heteroDsl(devModel, reviewModel, overrides = {}) {
  const dsl = {
    id: 'h1',
    name: '异源测试',
    entry: 'dev',
    control: { maxRounds: 3 },
    nodes: [
      { id: 'dev', profile: 'dev', label: '开发', goal: '开发目标', model: devModel, output: { schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }, successCondition: '$.ok == true' } },
      { id: 'review', profile: 'review', label: '审核', goal: '审核目标', model: reviewModel },
    ],
    edges: [
      { from: 'dev', to: 'review', on: 'success' },
      { from: 'dev', to: '$end', on: 'failure' },
      { from: 'review', to: '$end', on: 'success' },
      { from: 'review', to: 'dev', on: 'failure' },
    ],
  }
  return { ...dsl, ...overrides }
}

// ═══════════════════════════════════════════════════════════════════════════
// T-IMP-06 · 双根加载
// ═══════════════════════════════════════════════════════════════════════════

test('AC-2：历史模板从 .generated/ 目录加载为自定义（host.js 无硬编码模板）', async () => {
  const { handlers, sub } = env()
  const list = await call(handlers, 'vwf.workflows.list')
  const shipped = list.find(w => w.id === 'dev-workflow-2-0')
  assert.ok(shipped, '列表包含历史模板')
  assert.equal(shipped.builtin, false, 'dev-workflow-2-0 已迁为自定义，无内置标签')
  const v = await call(handlers, 'vwf.validate', { dsl: shipped.dsl })
  assert.equal(v.ok, true, JSON.stringify(v.errors))
  // T-IMP-12：vwf.compile 已删除；vwf.script 走统一编译器管道（CLI compile）
  const s = await call(handlers, 'vwf.script', { dsl: shipped.dsl })
  assert.equal(s.ok, true, JSON.stringify(s.errors))
  const compileCall = sub._calls.find(c => c.join(' ').includes('generate.mjs') && c.join(' ').includes(' compile '))
  assert.ok(compileCall, 'vwf.script 经 CLI compile 取统一译文')
  if (existsSync(realGenerated)) {
    assert.ok(s.script.includes('AWAITING_HUMAN_'), '统一译文含人工验收门禁语义')
    assert.ok(s.script.includes('const MAX_ROUNDS = 9'))
  }
})

test('内置根优先取发起 agent 会话 cwd（agentless 兜底 sandboxPolicy.workspaceRoot）', async () => {
  // agents 注入 currentInitiator → session.header.cwd = 会话工作区
  const sessionFs = makeFs({ [SESSION_REPO + '/.generated/dev-workflow-2-0/vwf-dsl.json']: MINIMAL_BUILTIN })
  const sub = makeSubprocess({ fs: sessionFs })
  const { handlers } = loadHost({
    fs: sessionFs, subprocess: sub, sandboxPolicy,
    agents: { currentInitiator: () => ({ session: { header: { cwd: SESSION_REPO } } }) },
  })
  const list = await call(handlers, 'vwf.workflows.list')
  const shipped = list.find(w => w.id === 'dev-workflow-2-0')
  assert.ok(shipped && shipped.builtin === false, '历史模板从会话 cwd 的 .generated/ 加载为自定义')
  assert.equal(shipped.name, '开发工作流 2.0')
  // 无 agents 时兜底 sandboxPolicy.workspaceRoot（env() 默认路径覆盖）
})

test('AC-3：save 落盘后新实例（重启宿主等价）仍可 list', async () => {
  // 实例 A：save 落盘
  const a = env()
  const good = await call(a.handlers, 'vwf.workflows.save', { dsl: baseDsl() })
  assert.equal(good.ok, true, JSON.stringify(good.errors))
  // 实例 B：同一 fs（磁盘）重新加载插件 → 用户模板仍在（builtin=false）
  const bFs = a.fs
  const bSub = makeSubprocess({ fs: bFs })
  const { handlers: bHandlers } = loadHost({ fs: bFs, subprocess: bSub, sandboxPolicy })
  const list = await call(bHandlers, 'vwf.workflows.list')
  const u = list.find(w => w.id === 't1')
  assert.ok(u && u.builtin === false, '重启后用户模板仍在（目录加载）')
  assert.equal(u.name, '测试工作流')
})

test('apply 无 initiator（浏览器审批激活）→ 后续模型调用实时解析会话 cwd', async () => {
  let initiator = null // apply 时无 currentInitiator（knownCwd=null）
  const liveFs = makeFs({ [SESSION_REPO + '/.generated/dev-workflow-2-0/vwf-dsl.json']: MINIMAL_BUILTIN })
  const sub = makeSubprocess({ fs: liveFs })
  const { handlers } = loadHost({
    fs: liveFs, subprocess: sub, sandboxPolicy,
    agents: { currentInitiator: () => initiator },
  })
  // 无 initiator 的调用：兜底 sp.workspaceRoot（/repo 无 .generated）→ 内置根空
  let list = await call(handlers, 'vwf.workflows.list')
  assert.ok(!list.some(w => w.id === 'dev-workflow-2-0'))
  // 模型发起调用（有 initiator）：实时解析会话 cwd → 内置根出现
  initiator = { session: { header: { cwd: SESSION_REPO } } }
  list = await call(handlers, 'vwf.workflows.list')
  assert.ok(list.some(w => w.id === 'dev-workflow-2-0' && w.builtin === false), '实时 initiator 生效')
  // initiator 再次消失（客户端 RPC）：knownCwd 兜底仍能解析
  initiator = null
  list = await call(handlers, 'vwf.workflows.list')
  assert.ok(list.some(w => w.id === 'dev-workflow-2-0' && w.builtin === false), 'knownCwd 历史兜底生效')
})

test('真实生成物 .generated/dev-workflow-2-0/vwf-dsl.json 校验通过（编译已并入统一管道）', async (t) => {
  if (!existsSync(realGenerated)) { t.skip('缺少 .generated/（先 npm run generate）'); return }
  const { handlers } = env()
  const list = await call(handlers, 'vwf.workflows.list')
  const builtin = list.find(w => w.id === 'dev-workflow-2-0')
  const v = await call(handlers, 'vwf.validate', { dsl: builtin.dsl })
  assert.equal(v.ok, true, JSON.stringify(v.errors))
})

test('AC-3：save 新模板 → 蓝图落盘 + skill 同步（save 即闭环）+ list 投影', async () => {
  const { handlers, fs, sub } = env()
  const good = await call(handlers, 'vwf.workflows.save', { dsl: baseDsl() })
  assert.equal(good.ok, true, JSON.stringify(good.errors))
  assert.equal(good.id, 't1')
  const file = USER_DIR + '/t1.json'
  assert.ok(fs._files.has(file), '蓝图已落盘用户目录')
  const bp = JSON.parse(fs._files.get(file))
  assert.equal(bp.id, 't1')
  assert.equal(bp.displayName, '测试工作流', 'name → displayName 逆投影')
  assert.equal(bp.name, undefined, '蓝图无 name 字段（D1 单标识）')
  assert.equal(bp.entry, 'a', '入口归一后落盘')
  assert.deepEqual(bp.bindings.models.a, { provider: 'p1', model: 'm1' }, '节点 model 逆投影为 bindings.models')
  assert.equal(bp.nodes[0].goal, '目标A', '节点 goal 保留')
  // skill 同步：spawn 生成器 user 子命令
  const genCall = sub._calls.find(c => c.join(' ').includes('generate.mjs') && c.join(' ').includes(' user '))
  assert.ok(genCall, '已 spawn 生成器 user 子命令')
  assert.ok(genCall.join(' ').includes(file), '生成器入参为蓝图路径')
  assert.ok(genCall.join(' ').includes(SKILL_ROOT), '生成器 skill 输出根为 ~/.dsh/skills')
  // list 合并双根：用户条目 builtin=false，dsl 为蓝图 → vwf 投影
  const list = await call(handlers, 'vwf.workflows.list')
  const u = list.find(w => w.id === 't1')
  assert.ok(u && u.builtin === false)
  assert.equal(u.name, '测试工作流')
  assert.equal(u.dsl.entry, 'a')
  assert.ok(u.dsl.nodes.every(n => n.label && n.goal))
  const firstCustom = list.findIndex(w => !w.builtin)
  assert.ok(firstCustom === -1 || list.slice(0, firstCustom).every(w => w.builtin), '内置模板置顶，用户模板排在其后')
})

test('save 蓝图级校验失败（生成器 exit 1）→ 回滚落盘并回传错误（原子性）', async () => {
  const { handlers, fs, sub } = env({ failPattern: /generate\.mjs/ })
  const bad = await call(handlers, 'vwf.workflows.save', { dsl: baseDsl() })
  assert.equal(bad.ok, false)
  assert.ok(bad.errors[0].message.includes('已回滚'), JSON.stringify(bad.errors))
  assert.ok(!fs._files.has(USER_DIR + '/t1.json'), '蓝图已回滚，不留盘')
  assert.ok(sub._calls.some(c => c.join(' ').includes('rmSync')), '回滚走子进程 rm')
  const list = await call(handlers, 'vwf.workflows.list')
  assert.ok(!list.some(w => w.id === 't1'))
})

test('撞名：正式内置只读 / 同名用户拒绝提示改名 / currentId 更新自身允许', async () => {
  const { handlers, fs } = env()
  plantOfficialBuiltin(fs)
  await call(handlers, 'vwf.workflows.save', { dsl: baseDsl() })
  const toBuiltin = await call(handlers, 'vwf.workflows.save', { dsl: baseDsl({ id: 'official-builtin', name: '正式内置样例' }) })
  assert.equal(toBuiltin.ok, false)
  assert.ok(toBuiltin.errors.some(e => e.message.includes('内置模板只读')), JSON.stringify(toBuiltin.errors))
  // 同名用户：无 currentId → 拒绝
  const clash = await call(handlers, 'vwf.workflows.save', { dsl: baseDsl() })
  assert.equal(clash.ok, false)
  assert.ok(clash.errors.some(e => e.message.includes('已存在同名模板')), JSON.stringify(clash.errors))
  // 同名用户：currentId 指向其他 → 拒绝
  const clash2 = await call(handlers, 'vwf.workflows.save', { dsl: baseDsl(), currentId: 'other' })
  assert.equal(clash2.ok, false)
  // 更新自身（currentId === id）→ 允许（覆盖落盘）
  const upd = await call(handlers, 'vwf.workflows.save', { dsl: baseDsl({ description: 'v2' }), currentId: 't1' })
  assert.equal(upd.ok, true, JSON.stringify(upd.errors))
  const list = await call(handlers, 'vwf.workflows.list')
  assert.equal(list.find(w => w.id === 't1').description, 'v2', '更新覆盖生效')
})

test('remove：用户模板可删（蓝图+skill 同步删）；正式内置/不存在拒绝；历史模板可删且不再列出', async () => {
  const { handlers, fs, sub } = env()
  plantOfficialBuiltin(fs)
  await call(handlers, 'vwf.workflows.save', { dsl: baseDsl() })
  const rmBuiltin = await call(handlers, 'vwf.workflows.remove', { id: 'official-builtin' })
  assert.equal(rmBuiltin.ok, false)
  assert.ok(rmBuiltin.errors.some(e => e.message.includes('内置模板只读')))
  const rmMissing = await call(handlers, 'vwf.workflows.remove', { id: 'nope' })
  assert.equal(rmMissing.ok, false)
  assert.ok(rmMissing.errors.some(e => e.message.includes('不存在')))
  const rmShipped = await call(handlers, 'vwf.workflows.remove', { id: 'dev-workflow-2-0' })
  assert.equal(rmShipped.ok, true)
  assert.ok(fs._files.has(REMOVED_DIR + '/dev-workflow-2-0'), '删除标记已写入')
  assert.ok(!(await call(handlers, 'vwf.workflows.list')).some(w => w.id === 'dev-workflow-2-0'), '历史模板删除后不再列出')
  const ok = await call(handlers, 'vwf.workflows.remove', { id: 't1' })
  assert.equal(ok.ok, true)
  assert.ok(!fs._files.has(USER_DIR + '/t1.json'), '蓝图已删')
  const rmCalls = sub._calls.filter(c => c.join(' ').includes('rmSync')).map(c => c.join(' '))
  assert.ok(rmCalls.some(s => s.includes(USER_DIR + '/t1.json')), '蓝图 rm 调用')
  assert.ok(rmCalls.some(s => s.includes(SKILL_ROOT + '/t1')), 'skill 目录 rm 调用')
  assert.ok(rmCalls.some(s => s.includes(SKILL_ROOT + '/dev-workflow-2-0')), '历史模板同步删 skill')
  // 所有子进程 spawn 必须移除宿主注入的 NODE_OPTIONS（WorkBuddy safe-delete 钩子拦截 rmSync）
  const rmSpecs = sub._specs.filter(s => s.argv.join(' ').includes('rmSync'))
  assert.ok(rmSpecs.length >= 1, 'rmSync spawn 调用存在')
  assert.ok(rmSpecs.every(s => s.env && s.env.NODE_OPTIONS === undefined), 'NODE_OPTIONS 已移除（tombstone）')
  const list = await call(handlers, 'vwf.workflows.list')
  assert.ok(!list.some(w => w.id === 't1'))
})

test('历史模板迁为自定义：可保存覆盖用户目录；删除后 save 可重建', async () => {
  const { handlers, fs } = env()
  const list = await call(handlers, 'vwf.workflows.list')
  const shipped = list.find(w => w.id === 'dev-workflow-2-0')
  assert.ok(shipped && shipped.builtin === false)
  const saved = await call(handlers, 'vwf.workflows.save', { dsl: baseDsl({ id: 'dev-workflow-2-0', name: '开发工作流 2.0', description: '用户覆盖' }), currentId: 'dev-workflow-2-0' })
  assert.equal(saved.ok, true, JSON.stringify(saved.errors))
  assert.ok(fs._files.has(USER_DIR + '/dev-workflow-2-0.json'), '覆盖落盘用户目录')
  const overlay = (await call(handlers, 'vwf.workflows.list')).filter(w => w.id === 'dev-workflow-2-0')
  assert.equal(overlay.length, 1, '用户覆盖与生成物不重复列出')
  assert.equal(overlay[0].builtin, false)
  assert.equal(overlay[0].description, '用户覆盖')
  const rm = await call(handlers, 'vwf.workflows.remove', { id: 'dev-workflow-2-0' })
  assert.equal(rm.ok, true)
  assert.ok(!(await call(handlers, 'vwf.workflows.list')).some(w => w.id === 'dev-workflow-2-0'))
  const restored = await call(handlers, 'vwf.workflows.save', { dsl: baseDsl({ id: 'dev-workflow-2-0', name: '开发工作流 2.0' }) })
  assert.equal(restored.ok, true, JSON.stringify(restored.errors))
  const again = (await call(handlers, 'vwf.workflows.list')).find(w => w.id === 'dev-workflow-2-0')
  assert.ok(again && again.builtin === false, '重建后仍为自定义')
})

test('findWorkflow：内置优先、用户兜底（经 wf_run 未知模板错误消息验证合并列表）', async () => {
  const { handlers, definedTools } = env({ extra: { workflowEngine: { start: () => { throw new Error('不应执行') } }, agents: { requireInitiator: () => ({}) } } })
  await call(handlers, 'vwf.workflows.save', { dsl: baseDsl() })
  const wfRun = definedTools.find(t => t.name === 'wf_run')
  assert.ok(wfRun, 'wf_run 已注册')
  const out = await wfRun.execute({ templateId: 'nope', taskId: 't' })
  assert.ok(out.includes('未知工作流'))
  assert.ok(out.includes('dev-workflow-2-0'), '内置根在合并列表中')
  assert.ok(out.includes('t1'), '用户根在合并列表中')
})

test('wf_run 在 agents 存在但 engine 缺失时仍注册，execute 优雅报错', async () => {
  const { definedTools } = env({ extra: { agents: { requireInitiator: () => ({}) } } })
  const wfRun = definedTools.find(t => t.name === 'wf_run')
  assert.ok(wfRun, 'wf_run 已注册')
  const out = await wfRun.execute({ templateId: 'dev-workflow-2-0', taskId: 't' })
  assert.ok(out.includes('无法访问 workflowEngine'), out)
})

test('wf_run 在 agents 缺失时不注册（优雅降级）', async () => {
  const { definedTools } = env()
  assert.ok(!definedTools.some(t => t.name === 'wf_run'))
})

// ═══════════════════════════════════════════════════════════════════════════
// T-IMP-07 · 异源硬规则（与校验内核 validate-core.cjs 规则 7 一致，候选二统一）
// ═══════════════════════════════════════════════════════════════════════════

test('异源 T1：dev/review 完全同模型 → save 与 validate 均拒', async () => {
  const { handlers } = env()
  const dsl = heteroDsl({ provider: 'p1', model: 'm1' }, { provider: 'p1', model: 'm1' })
  const v = await call(handlers, 'vwf.validate', { dsl })
  assert.equal(v.ok, false)
  assert.ok(v.errors.some(e => e.at === '$.bindings.models' && e.message.includes('模型相同')), JSON.stringify(v.errors))
  const s = await call(handlers, 'vwf.workflows.save', { dsl })
  assert.equal(s.ok, false)
  assert.ok(s.errors.some(e => e.message.includes('模型相同')))
  const list = await call(handlers, 'vwf.workflows.list')
  assert.ok(!list.some(w => w.id === 'h1'), '违规模板未落盘')
})

test('异源 T2：同 provider 不同 model → 通过 + 弱异源警告', async () => {
  const { handlers } = env()
  const s = await call(handlers, 'vwf.workflows.save', { dsl: heteroDsl({ provider: 'p1', model: 'm1' }, { provider: 'p1', model: 'm2' }) })
  assert.equal(s.ok, true, JSON.stringify(s.errors))
  assert.equal(s.warnings.length, 1)
  assert.ok(s.warnings[0].includes('弱异源'))
  const v = await call(handlers, 'vwf.validate', { dsl: heteroDsl({ provider: 'p1', model: 'm1' }, { provider: 'p1', model: 'm2' }) })
  assert.equal(v.ok, true)
  assert.equal(v.warnings.length, 1)
})

test('异源 T3：不同 provider → 通过无警告', async () => {
  const { handlers } = env()
  const s = await call(handlers, 'vwf.workflows.save', { dsl: heteroDsl({ provider: 'deepseek-official', model: 'v4-pro' }, { provider: 'kimi-coding', model: 'k3' }) })
  assert.equal(s.ok, true, JSON.stringify(s.errors))
  assert.deepEqual(s.warnings, [])
})

test('异源 T4：dev/review 缺模型绑定 → 拒（模型必填或无法证明异源）', async () => {
  const { handlers } = env()
  const dsl = heteroDsl(null, { provider: 'p1', model: 'm1' })
  const v = await call(handlers, 'vwf.validate', { dsl })
  assert.equal(v.ok, false)
  assert.ok(v.errors.some(e => e.message.includes('无法证明异源') || e.message.includes('未绑定')), JSON.stringify(v.errors))
})

test('异源 T5：无 dev/review 节点的模板跳过检查', async () => {
  const { handlers } = env()
  const s = await call(handlers, 'vwf.workflows.save', { dsl: baseDsl() })
  assert.equal(s.ok, true, JSON.stringify(s.errors))
  assert.deepEqual(s.warnings, [])
})

test('异源 T6：违规蓝图 save 两次（第二次=更新自身）均被拒', async () => {
  const { handlers } = env()
  const dsl = heteroDsl({ provider: 'p1', model: 'm1' }, { provider: 'p1', model: 'm1' })
  const first = await call(handlers, 'vwf.workflows.save', { dsl })
  assert.equal(first.ok, false)
  const second = await call(handlers, 'vwf.workflows.save', { dsl, currentId: 'h1' })
  assert.equal(second.ok, false, '更新路径同样拒绝')
})

test('异源 T7：profile（角色）为 dev/review 的节点同样纳入检查（节点 id 为 node-N）', async () => {
  const { handlers } = env()
  const dsl = {
    id: 'h7', name: 'profile 异源', entry: 'node-1', control: { maxRounds: 3 },
    nodes: [
      { id: 'node-1', profile: 'dev', label: '开发', model: { provider: 'p1', model: 'm1' }, output: { schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }, successCondition: '$.ok == true' } },
      { id: 'node-2', profile: 'review', label: '审核', model: { provider: 'p1', model: 'm1' } },
    ],
    edges: [
      { from: 'node-1', to: 'node-2', on: 'success' },
      { from: 'node-2', to: '$end', on: 'success' },
      { from: 'node-2', to: 'node-1', on: 'failure' },
    ],
  }
  const s = await call(handlers, 'vwf.workflows.save', { dsl })
  assert.equal(s.ok, false, 'profile 定位的同模型应被拒')
  assert.ok(s.errors.some(e => e.message.includes('模型相同')), JSON.stringify(s.errors))
  const v = await call(handlers, 'vwf.validate', { dsl })
  assert.equal(v.ok, false)
})

test('模型绑定必填：节点缺 model.provider/model.model 报字段级错误', async () => {
  const { handlers } = env()
  const v = await call(handlers, 'vwf.validate', {
    dsl: baseDsl({
      nodes: [
        { id: 'a', profile: 'dispatcher', label: 'A', goal: '目标A' },
        { id: 'b', profile: 'dev', label: 'B', goal: '目标B', model: { provider: 'p1' } },
      ],
    }),
  })
  assert.equal(v.ok, false)
  assert.ok(v.errors.some(e => e.message.includes('model.provider') || e.message.includes('未绑定 Agent')), JSON.stringify(v.errors))
  assert.ok(v.errors.some(e => e.message.includes('未绑定模型')), JSON.stringify(v.errors))
  assert.ok(v.fieldErrors['node:a:model.provider'] && v.fieldErrors['node:a:model.model'], '字段级定位 model.provider/model.model')
  assert.ok(v.fieldErrors['node:b:model.model'], '部分缺失同样定位')
  const s = await call(handlers, 'vwf.workflows.save', { dsl: baseDsl({ nodes: [{ id: 'a', profile: 'dispatcher', label: 'A', goal: '目标A' }] }) })
  assert.equal(s.ok, false, 'save 同样拒绝缺模型模板')
})

// ═══════════════════════════════════════════════════════════════════════════
// 既有回归（未受双根改造影响的部分）
// ═══════════════════════════════════════════════════════════════════════════

test('基础校验：合法 DSL 通过并返回入口归一', async () => {
  const { handlers } = env()
  const dsl = baseDsl({ entry: 'WRONG' })
  const v = await call(handlers, 'vwf.validate', { dsl })
  assert.equal(v.ok, true, JSON.stringify(v.errors))
  assert.equal(v.sanitized.entry, 'a', '唯一无入边节点自动归一为入口')
})

test('多入口节点报错并携带 nodeIds', async () => {
  const { handlers } = env()
  const dsl = baseDsl({
    nodes: [
      { id: 'a', profile: 'dispatcher', label: 'A' },
      { id: 'b', profile: 'dev', label: 'B' },
      { id: 'c', profile: 'dev', label: 'C' },
    ],
    edges: [{ from: 'a', to: '$end', on: 'success' }],
  })
  const v = await call(handlers, 'vwf.validate', { dsl })
  assert.equal(v.ok, false)
  const issue = v.errors.find(e2 => e2.message.indexOf('入口不唯一') >= 0)
  assert.ok(issue, '存在多入口错误')
  assert.equal(issue.at, '$.entry')
})

test('无入口（环形互指）报错', async () => {
  const { handlers } = env()
  const dsl = baseDsl({
    nodes: [
      { id: 'a', profile: 'dispatcher', label: 'A' },
      { id: 'b', profile: 'dev', label: 'B' },
    ],
    edges: [
      { from: 'a', to: 'b', on: 'success' },
      { from: 'b', to: 'a', on: 'success' },
      { from: 'b', to: '$end', on: 'success' },
    ],
  })
  const v = await call(handlers, 'vwf.validate', { dsl })
  assert.equal(v.ok, false)
  assert.ok(v.errors.some(e2 => e2.message.indexOf('没有入边的入口') >= 0 || e2.message.indexOf('存在环') >= 0))
})

test('缺 $end / 悬空节点 / 重复 id / 保留 id / 缺 profile 报错', async () => {
  const { handlers } = env()
  const v = await call(handlers, 'vwf.validate', {
    dsl: {
      id: 't1', name: '测试', entry: 'a',
      nodes: [
        { id: 'a', profile: 'dispatcher' },
        { id: 'a', profile: 'dev' },
        { id: '$end', profile: 'x' },
        { id: 'c', profile: '' },
      ],
      edges: [
        { from: 'a', to: 'c', on: 'success' },
        { from: 'c', to: 'a', on: 'failure' },
      ],
    },
  })
  assert.equal(v.ok, false)
  const msg = (part) => v.errors.filter(e2 => e2.message.indexOf(part) >= 0)
  assert.ok(msg('结束节点').length, '缺 $end 报错')
  assert.ok(msg('没有出边').length, '悬空节点报错（$end 与 a 无出边）')
  assert.ok(msg('id 重复').length, '重复 id 报错')
  assert.ok(msg('保留 id').length, '保留 id 报错')
  assert.ok(msg('未关联角色').length, '缺 profile 报错')
  assert.ok(v.fieldErrors['node:a:id'] && v.fieldErrors['node:a:id'].length >= 1, 'fieldErrors 定位节点')
})

test('successCondition 路径不在 schema 内报错', async () => {
  const { handlers } = env()
  const dsl = baseDsl({
    nodes: [
      { id: 'a', profile: 'dispatcher', output: { schema: { type: 'object', properties: { ok: { type: 'boolean' } } }, successCondition: '$.missing == true' } },
    ],
    edges: [{ from: 'a', to: '$end', on: 'success' }],
  })
  const v = await call(handlers, 'vwf.validate', { dsl })
  assert.equal(v.ok, false)
  assert.ok(v.errors.some(e2 => e2.message.indexOf('成功表达式路径未在') >= 0))
  assert.ok(v.fieldErrors['node:a:output.successCondition'], '字段级定位')
})

test('successCondition 格式无效报错', async () => {
  const { handlers } = env()
  const dsl = baseDsl({
    nodes: [{ id: 'a', profile: 'dispatcher', output: { schema: { type: 'object' }, successCondition: 'ok == 1' } }],
    edges: [{ from: 'a', to: '$end', on: 'success' }],
  })
  const v = await call(handlers, 'vwf.validate', { dsl })
  assert.ok(v.errors.some(e2 => e2.message.indexOf('需为 $.path') >= 0))
})

test('failure 出边最多一条；多 success 出边必须全部带 when', async () => {
  const { handlers } = env()
  const v1 = await call(handlers, 'vwf.validate', {
    dsl: baseDsl({
      edges: [
        { from: 'a', to: 'b', on: 'failure' },
        { from: 'a', to: '$end', on: 'failure' },
        { from: 'b', to: '$end', on: 'success' },
      ],
    }),
  })
  assert.ok(v1.errors.some(e2 => e2.message.indexOf('failure 边') >= 0), '双 failure 报错')

  const v2 = await call(handlers, 'vwf.validate', {
    dsl: baseDsl({
      nodes: [
        { id: 'a', profile: 'dispatcher', output: { schema: { type: 'object', properties: { x: { type: 'boolean' } } } } },
        { id: 'b', profile: 'dev' },
        { id: 'c', profile: 'dev' },
      ],
      edges: [
        { from: 'a', to: 'b', on: 'success' },
        { from: 'a', to: 'c', on: 'success' },
        { from: 'b', to: '$end', on: 'success' },
        { from: 'c', to: '$end', on: 'success' },
      ],
    }),
  })
  assert.ok(v2.errors.some(e2 => e2.message.indexOf('全部带 when') >= 0), '双 success 不带 when 报错')

  const v3 = await call(handlers, 'vwf.validate', {
    dsl: baseDsl({
      nodes: [
        { id: 'a', profile: 'dispatcher', goal: '目标A', model: { provider: 'p1', model: 'm1' }, output: { schema: { type: 'object', properties: { x: { type: 'boolean' } } } } },
        { id: 'b', profile: 'dev', goal: '目标B', model: { provider: 'p1', model: 'm1' } },
        { id: 'c', profile: 'dev', goal: '目标C', model: { provider: 'p1', model: 'm1' } },
      ],
      edges: [
        { from: 'a', to: 'b', on: 'success', when: '$.x == true' },
        { from: 'a', to: 'c', on: 'success', when: '$.x == false' },
        { from: 'b', to: '$end', on: 'success' },
        { from: 'c', to: '$end', on: 'success' },
      ],
    }),
  })
  assert.equal(v3.ok, true, JSON.stringify(v3.errors))
})

test('when 只允许 success 边', async () => {
  const { handlers } = env()
  const v = await call(handlers, 'vwf.validate', {
    dsl: baseDsl({
      edges: [
        { from: 'a', to: 'b', on: 'success' },
        { from: 'b', to: '$end', on: 'success' },
        { from: 'b', to: 'a', on: 'failure', when: '$.x == true' },
      ],
    }),
  })
  assert.ok(v.errors.some(e2 => e2.message.indexOf('只允许用于 success 边') >= 0))
  // sanitize 会剔除 failure 边的 when
  const clean = await call(handlers, 'vwf.validate', {
    dsl: baseDsl({ edges: [{ from: 'a', to: 'b', on: 'success' }, { from: 'b', to: '$end', on: 'success' }, { from: 'b', to: 'a', on: 'failure' }] }),
  })
  assert.equal(clean.sanitized.edges[2].when, undefined)
})

test('maxRounds 非正报错', async () => {
  const { handlers } = env()
  const v = await call(handlers, 'vwf.validate', { dsl: baseDsl({ control: { maxRounds: 0 } }) })
  assert.equal(v.ok, false)
  assert.ok(v.fieldErrors['control:maxRounds'])
})

test('工作流 id 为空 / nodes 为空报错', async () => {
  const { handlers } = env()
  const v1 = await call(handlers, 'vwf.validate', { dsl: baseDsl({ id: '  ' }) })
  assert.ok(v1.errors.some(e2 => e2.message.indexOf('kebab-case') >= 0))
  const v2 = await call(handlers, 'vwf.validate', { dsl: { id: 'x', nodes: [], edges: [] } })
  assert.ok(v2.errors.some(e2 => e2.message.indexOf('至少') >= 0))
})

test('vwf.validate 异常输入也返回 lossless JSON 的 warnings 数组', async () => {
  const { handlers } = env()
  const v = await call(handlers, 'vwf.validate', { dsl: null })
  assert.equal(v.ok, false)
  assert.deepEqual(v.warnings, [])
  assert.doesNotThrow(() => JSON.stringify(v))
})

test('模板名称必填（name 为空拒绝，save 同拒）', async () => {
  const { handlers } = env()
  const v = await call(handlers, 'vwf.validate', { dsl: baseDsl({ name: '  ' }) })
  assert.equal(v.ok, false)
  assert.ok(v.errors.some(e => e.message.includes('displayName')), JSON.stringify(v.errors))
  const s = await call(handlers, 'vwf.workflows.save', { dsl: baseDsl({ name: '' }) })
  assert.equal(s.ok, false, 'save 拒绝空名称')
})

test('vwf.roles 无 fs 服务时内置角色常驻（builtin 标识）', async () => {
  const { handlers } = loadHost()
  const r = await call(handlers, 'vwf.roles')
  assert.ok(Array.isArray(r.roles))
  assert.ok(!r.roles.some(x => x.id === 'dispatcher'), 'dispatcher 已退出内置身份（issue-81 迁为自定义）')
  assert.ok(r.roles.some(x => x.id === 'closeout'))
  assert.ok(r.roles.length > 0, '无 fs 时内置仍常驻')
  assert.ok(r.roles.every(x => x.builtin === true), '无 fs 时仅内置常驻（数量不写死，随注册表演进）')
})

test('vwf.roles 经 fs 服务读工作区 dsh/roles 增强内置摘要（resolve→stat→listDir→readText 契约）', async () => {
  // 回归：旧实现把 'dsh/roles' 字符串直接传给 listDir（宿主 fs 服务期望 resolve 后的
  // target），任何真实服务都会抛错回退内置清单——改为按 fs 服务契约取目录。
  const fs = makeFs({
    [REPO + '/dsh/roles/dispatcher.md']: '你是 2.0 开发工作流的调度 Agent。\n职责：三要素门禁。\n',
    [REPO + '/dsh/roles/dev.md']: '你是开发 Agent。\n职责：测试驱动施工。\n',
    [REPO + '/dsh/roles/review.md']: '你是审核 Agent。\n职责：独立审查。\n',
    [REPO + '/dsh/roles/NOT_ROLE.txt']: '不应被识别为角色',
  })
  const sub = makeSubprocess({ fs })
  const { handlers } = loadHost({ fs, subprocess: sub, sandboxPolicy })
  const r = await call(handlers, 'vwf.roles')
  const ids = r.roles.map(x => x.id)
  assert.ok(!ids.some(id => String(id).includes('NOT_ROLE')), '非 .md 文件不识别为角色')
  assert.ok(ids.includes('dev') && ids.includes('closeout'), '内置常驻（不校验完整清单，避免随注册表演进而改测试）')
  const dp = r.roles.find(x => x.id === 'dispatcher')
  assert.equal(dp.builtin, false, 'dispatcher 保留文件但归为自定义（issue-81）')
  assert.ok(dp.summary.startsWith('你是 2.0'), '摘要取正文首行（跳过 frontmatter/标题）')
})

test('vwf.roles：仓库根无 dsh/roles 目录时内置角色常驻（静态/web 模式兜底）', async () => {
  const { handlers } = env()
  const r = await call(handlers, 'vwf.roles')
  assert.ok(r.roles.length > 0, '兜底时内置仍常驻')
  assert.ok(r.roles.every(x => x.builtin === true))
  assert.ok(r.roles.some(x => x.id === 'closeout'))
})

test('内置角色注册表结构不变量：id 唯一、为稳定英文，中文名非空', async () => {
  // 回归护栏：内置角色清单本身即单一来源，测试不复制该清单；但机器 ID 必须保持
  // 稳定英文、中文名必须存在（issue-81 验收第 1、10 条），结构被破坏时此处报警。
  const { handlers } = loadHost()
  const r = await call(handlers, 'vwf.roles')
  const ids = r.roles.map(x => x.id)
  assert.equal(new Set(ids).size, ids.length, 'id 不允许重复')
  // 数量按下限护栏而非精确值：issue-81 正式体系为 12 个，后续扩充无需改测试，
  // 但误删角色会被此处拦下。清单本身是单一来源，测试不复制它。
  assert.ok(ids.length >= 12, `内置角色不得少于 12 个（当前 ${ids.length}）`)
  for (const role of r.roles) {
    assert.match(role.id, /^[a-z][a-z0-9-]*$/, `机器 ID 必须为稳定英文：${role.id}`)
    assert.ok(role.name && String(role.name).trim().length > 0, `中文名不得为空：${role.id}`)
  }
})

test('dispatcher 迁为自定义后历史引用不丢失：仍可解析、引用仍被统计', async () => {
  // issue-81 验收第 6 条：dispatcher 退出内置身份，但引用它的历史工作流不能失效。
  // 迁移做法是不动 dsh/roles/dispatcher.md、只把它移出内置集合，因此 profile
  // 'dispatcher' 的解析路径完全不变。
  const fs = makeFs({
    [REPO + '/dsh/roles/dispatcher.md']: '调度角色正文\n',
    [USER_DIR + '/wf-old.json']: JSON.stringify({
      id: 'wf-old', displayName: '历史流程', entry: 'n1',
      nodes: [{ id: 'n1', profile: 'dispatcher', label: '调度', goal: 'g' }],
      edges: [],
    }),
  })
  const sub = makeSubprocess({ fs })
  const { handlers } = loadHost({ fs, subprocess: sub, sandboxPolicy })
  const r = await call(handlers, 'vwf.roles')
  const dp = r.roles.find(x => x.id === 'dispatcher')
  assert.ok(dp, '历史角色仍出现在角色库')
  assert.equal(dp.builtin, false, '身份已变为自定义')
  const u = await call(handlers, 'vwf.roles.usage', { id: 'dispatcher' })
  assert.equal(u.ok, true)
  assert.ok(u.count >= 1, `历史引用仍被统计（实际 ${u.count}）`)
})

test('迁移角色在产品工作区经打包快照可见且可编辑（不回写 .generated）', async () => {
  // Codex PR#124 第二轮 P1：dispatcher 迁出内置后，产品工作区没有 dsh/roles/dispatcher.md，
  // 必须仍以「自定义」身份从 bundleRoles 模板的角色包只读回退可见。编辑时种子到工作区
  // dsh/roles/，绝不回写 .generated（生成产物不得承载用户状态）。
  const fs = makeFs({
    [REPO + '/.generated/default-workflow/roles/dispatcher.md']: '打包快照正文\n',
  })
  const sub = makeSubprocess({ fs })
  const { handlers } = loadHost({ fs, subprocess: sub, sandboxPolicy })
  // 1) 产品工作区（无 dsh/roles/dispatcher.md）→ 仍出现在自定义分组
  const r = await call(handlers, 'vwf.roles')
  const dp = r.roles.find(x => x.id === 'dispatcher')
  assert.ok(dp, '打包回退：迁移角色仍可见')
  assert.equal(dp.builtin, false, '身份为自定义')
  // 2) 详情可取
  const d = await call(handlers, 'vwf.roles.get', { id: 'dispatcher' })
  assert.equal(d.ok, true)
  assert.equal(d.role.builtin, false)
  assert.equal(d.role.content, '打包快照正文\n', '详情回退到打包快照内容')
  // 3) 编辑 → 种子到工作区 dsh/roles/，.generated 不被改写
  const upd = await call(handlers, 'vwf.roles.update', { id: 'dispatcher', name: 'dispatcher', content: '编辑后的新内容\n' })
  assert.equal(upd.ok, true, JSON.stringify(upd.errors || ''))
  assert.ok(fs._files.has(REPO + '/dsh/roles/dispatcher.md'), '种子到工作区 dsh/roles/')
  assert.equal(fs._files.get(REPO + '/dsh/roles/dispatcher.md'), '编辑后的新内容\n', '工作区文件为编辑后内容')
  assert.equal(fs._files.get(REPO + '/.generated/default-workflow/roles/dispatcher.md'), '打包快照正文\n', '.generated 打包快照未被改写')
})

test('打包回退角色同名 create 被拒绝（Codex PR#124 第三轮 P2，评论 3889725486）', async () => {
  // 迁移角色经打包快照只读回退可见时，roleNameTaken 必须把它计入唯一性校验，
  // 避免 vwf.roles.create({name:'dispatcher'}) 静默成功创建同名工作区文件。
  const fs = makeFs({
    [REPO + '/.generated/default-workflow/roles/dispatcher.md']: '打包快照正文\n',
  })
  const sub = makeSubprocess({ fs })
  const { handlers } = loadHost({ fs, subprocess: sub, sandboxPolicy })
  // 角色库列出 dispatcher（打包回退可见）
  const r = await call(handlers, 'vwf.roles')
  assert.ok(r.roles.find(x => x.id === 'dispatcher'), '打包回退角色可见')
  // create 同名 → 必须拒绝
  const dup = await call(handlers, 'vwf.roles.create', { name: 'dispatcher', content: '尝试覆盖\n' })
  assert.equal(dup.ok, false)
  assert.match(dup.errors[0].message, /同名角色/)
  // 工作区未被静默写入
  assert.ok(!fs._files.has(REPO + '/dsh/roles/dispatcher.md'), '工作区未被静默写入')
})

test('打包回退角色删除语义：给出明确提示且不被误删（Codex 第四轮 P2）', async () => {
  // 回归：此前 vwf.roles.remove 在统计引用前就返回「自定义角色不存在」，界面上
  // 可点删除却必然失败。打包回退角色的定义来自内置模板角色包（生成产物），
  // 只能读取不能删除，应给出可行动的明确提示。
  const fs = makeFs({
    [REPO + '/.generated/default-workflow/roles/dispatcher.md']: '打包快照正文\n',
  })
  const sub = makeSubprocess({ fs })
  const { handlers } = loadHost({ fs, subprocess: sub, sandboxPolicy })
  const rm = await call(handlers, 'vwf.roles.remove', { id: 'dispatcher' })
  assert.equal(rm.ok, false, '打包回退角色不可删除')
  assert.match(rm.errors[0].message, /角色包|生成产物/, '提示说明定义来源')
  assert.ok(!/不存在/.test(rm.errors[0].message), '不再误报「自定义角色不存在」')
  assert.equal(fs._files.get(REPO + '/.generated/default-workflow/roles/dispatcher.md'), '打包快照正文\n', '打包快照未被改动')
})

// ═══════════════════════════════════════════════════════════════════════════
// issue-58 · 角色库：内置/自定义分类、创建、编辑、引用保护与安全删除
// ═══════════════════════════════════════════════════════════════════════════

test('角色库：内置角色常驻置前并带 builtin 标识，工作区额外 .md 归为自定义', async () => {
  const fs = makeFs({
    [REPO + '/dsh/roles/dispatcher.md']: '内置身份正文\n',
    [REPO + '/dsh/roles/需求分析师.md']: '负责需求拆解。\n',
  })
  const sub = makeSubprocess({ fs })
  const { handlers } = loadHost({ fs, subprocess: sub, sandboxPolicy })
  const r = await call(handlers, 'vwf.roles')
  const firstCustom = r.roles.findIndex(x => x.builtin === false)
  const lastBuiltin = r.roles.reduce((acc, x, i) => (x.builtin === true ? i : acc), -1)
  assert.ok(lastBuiltin >= 0, '内置角色常驻')
  assert.ok(firstCustom === -1 || lastBuiltin < firstCustom, '内置角色全部排在自定义角色之前')
  assert.equal(r.roles.find(x => x.id === 'dispatcher').builtin, false, 'dispatcher 已迁为自定义角色')
  assert.equal(r.roles.find(x => x.id === '需求分析师').builtin, false, '内置集合之外的 .md 归为自定义')
  assert.equal(r.roles.find(x => x.id === '需求分析师').id, '需求分析师')
})

test('角色库 get：内置详情（工作区正文）+ 自定义详情 + 未知 id 报错', async () => {
  const fs = makeFs({
    [REPO + '/dsh/roles/dev.md']: '内置正文\n',
    [REPO + '/dsh/roles/dispatcher.md']: '迁移后的自定义正文\n',
    [REPO + '/dsh/roles/需求分析师.md']: '自定义正文\n',
  })
  const sub = makeSubprocess({ fs })
  const { handlers } = loadHost({ fs, subprocess: sub, sandboxPolicy })
  const b = await call(handlers, 'vwf.roles.get', { id: 'dev' })
  assert.equal(b.ok, true)
  assert.equal(b.role.builtin, true)
  assert.equal(b.role.content, '内置正文\n')
  // issue-81：dispatcher 退出内置后仍可通过 get 取到，只是身份变为自定义
  const d = await call(handlers, 'vwf.roles.get', { id: 'dispatcher' })
  assert.equal(d.ok, true)
  assert.equal(d.role.builtin, false, 'dispatcher 迁为自定义后依然可取，历史引用不失效')
  const c = await call(handlers, 'vwf.roles.get', { id: '需求分析师' })
  assert.equal(c.ok, true)
  assert.equal(c.role.builtin, false)
  assert.equal(c.role.content, '自定义正文\n')
  const miss = await call(handlers, 'vwf.roles.get', { id: 'nope' })
  assert.equal(miss.ok, false)
  assert.match(miss.errors[0].message, /角色不存在/)
})

test('内置角色详情：打包快照优先于工作区旧版同名文件（#129 遗留项 1）', async () => {
  // 运行时 roleRef（#81 身份切分）对内置角色先读打包快照再回退工作区；编辑器详情
  // 必须同序——否则工作区一份旧版/本地改过的 dsh/roles/dev.md 会让界面展示与执行口径不一致。
  globalThis.__VWF_REPO_ROOT__ = REPO
  try {
    const fs = seedFs({
      [REPO + '/dsh/roles/dev.md']: '打包快照 dev 正文\n',
      [SESSION_REPO + '/dsh/roles/dev.md']: '工作区旧版 dev 正文\n',
    })
    const { handlers } = env({ extra: { fs, agents: { currentInitiator: () => ({ session: { header: { cwd: SESSION_REPO } } }) } } })
    const d = await call(handlers, 'vwf.roles.get', { id: 'dev' })
    assert.equal(d.ok, true)
    assert.equal(d.role.content, '打包快照 dev 正文\n', '内置角色详情应优先取打包快照（与运行时 roleRef 同源）')
    assert.equal(d.role.summary, '打包快照 dev 正文', '摘要与展示内容同源')
    // 角色列表（vwf.roles）内置摘要同样本快照优先——旧版工作区文件不再以旧版摘要出现
    const r = await call(handlers, 'vwf.roles')
    const devInList = r.roles.find(x => x.id === 'dev')
    assert.equal(devInList.summary, '打包快照 dev 正文', '角色列表内置摘要同取打包快照（#129 遗留项 1）')
  } finally {
    delete globalThis.__VWF_REPO_ROOT__
  }
})

test('角色库 create：落盘 dsh/roles/<name>.md；与内置/自定义重名、非法名、空内容全部拒绝', async () => {
  const fs = makeFs({
    [REPO + '/dsh/roles/dev.md']: '内置正文\n',
    [REPO + '/dsh/roles/已有.md']: '已有自定义\n',
  })
  const sub = makeSubprocess({ fs })
  const { handlers } = loadHost({ fs, subprocess: sub, sandboxPolicy })
  const ok = await call(handlers, 'vwf.roles.create', { name: '需求分析师', content: '负责需求拆解。\n' })
  assert.equal(ok.ok, true)
  assert.equal(ok.role.builtin, false)
  assert.ok(fs._files.has(REPO + '/dsh/roles/需求分析师.md'), '角色文件落盘')
  // 与内置重名（大小写不敏感）
  const dup1 = await call(handlers, 'vwf.roles.create', { name: 'Dev', content: 'x' })
  assert.equal(dup1.ok, false)
  assert.match(dup1.errors[0].message, /同名角色/)
  // 与其他自定义重名
  const dup2 = await call(handlers, 'vwf.roles.create', { name: '需求分析师', content: 'x' })
  assert.equal(dup2.ok, false)
  assert.match(dup2.errors[0].message, /同名角色/)
  // 非法字符
  const bad = await call(handlers, 'vwf.roles.create', { name: 'a/b', content: 'x' })
  assert.equal(bad.ok, false)
  assert.match(bad.errors[0].message, /非法字符/)
  // 空内容
  const noContent = await call(handlers, 'vwf.roles.create', { name: '空内容', content: '  ' })
  assert.equal(noContent.ok, false)
  assert.equal(noContent.errors[0].at, 'content')
})

test('角色库 usage：跨历史模板 + 用户模板统计节点引用', async () => {
  const fs = makeFs({
    [REPO + '/.generated/dev-workflow-2-0/vwf-dsl.json']: JSON.stringify({
      id: 'dev-workflow-2-0', name: '内置流', entry: 'a',
      nodes: [
        { id: 'a', profile: '需求分析师', label: 'A' },
        { id: 'b', profile: '需求分析师', label: 'B' },
        { id: 'c', profile: 'dev', label: 'C' },
      ],
      edges: [],
    }, null, 2) + '\n',
    [REPO + '/scripts/validate-core.cjs']: validatorCoreSrc,
    [USER_DIR + '/wf-a.json']: JSON.stringify({
      id: 'wf-a', displayName: 'A', entry: 'n1',
      nodes: [{ id: 'n1', profile: '需求分析师', label: 'N1', goal: 'g' }, { id: 'n2', profile: 'dev', label: 'N2', goal: 'g' }],
      edges: [],
    }),
  })
  const sub = makeSubprocess({ fs })
  const { handlers } = loadHost({ fs, subprocess: sub, sandboxPolicy })
  const u = await call(handlers, 'vwf.roles.usage', { id: '需求分析师' })
  assert.equal(u.ok, true)
  assert.equal(u.count, 3, '历史模板 2 + 用户模板 1')
  assert.equal(u.refs.length, 2, '按工作流分组')
  const shippedRef = u.refs.find(x => x.workflowId === 'dev-workflow-2-0')
  assert.equal(shippedRef.builtin, false, '历史模板引用不再标内置')
  assert.equal(shippedRef.nodes.length, 2)
})

test('角色库 update：内容修改全局生效；被引用角色重命名阻止；零引用重命名放行；内置拒绝', async () => {
  const fs = makeFs({
    [REPO + '/dsh/roles/需求分析师.md']: '旧内容\n',
    [USER_DIR + '/wf-a.json']: JSON.stringify({
      id: 'wf-a', displayName: 'A', entry: 'n1',
      nodes: [{ id: 'n1', profile: '需求分析师', label: 'N1', goal: 'g' }, { id: 'n2', profile: 'dev', label: 'N2', goal: 'g' }],
      edges: [],
    }),
    [USER_DIR + '/wf-b.json']: JSON.stringify({
      id: 'wf-b', displayName: 'B', entry: 'n1',
      nodes: [{ id: 'n1', profile: '需求分析师', label: 'N1', goal: 'g' }],
      edges: [],
    }),
  })
  const sub = makeSubprocess({ fs })
  const { handlers } = loadHost({ fs, subprocess: sub, sandboxPolicy })
  // 内容修改：引用存在也放行（引用按 id 共享配置，不是副本）
  const upd = await call(handlers, 'vwf.roles.update', { id: '需求分析师', name: '需求分析师', content: '新内容\n' })
  assert.equal(upd.ok, true)
  assert.ok(fs._files.get(REPO + '/dsh/roles/需求分析师.md').startsWith('新内容'), '内容更新落盘')
  // 重命名（有引用）→ 阻止并提示影响
  const ren = await call(handlers, 'vwf.roles.update', { id: '需求分析师', name: '需求分析师V2', content: '新内容\n' })
  assert.equal(ren.ok, false)
  assert.match(ren.errors[0].message, /仍被 2 个节点使用/)
  // 零引用角色重命名 → 写新文件 + 删旧文件
  await call(handlers, 'vwf.roles.create', { name: '闲置角色', content: '闲置内容\n' })
  const ren2 = await call(handlers, 'vwf.roles.update', { id: '闲置角色', name: '闲置角色V2', content: '闲置内容2\n' })
  assert.equal(ren2.ok, true)
  assert.equal(ren2.role.id, '闲置角色V2')
  assert.ok(fs._files.has(REPO + '/dsh/roles/闲置角色V2.md'))
  assert.ok(!fs._files.has(REPO + '/dsh/roles/闲置角色.md'), '重命名后旧文件删除')
  // 内置角色阻止修改（issue-81 后 dispatcher 已非内置，改用仍在内置的 dev）
  const builtinUpd = await call(handlers, 'vwf.roles.update', { id: 'dev', name: 'dev', content: 'x' })
  assert.equal(builtinUpd.ok, false)
  assert.match(builtinUpd.errors[0].message, /内置角色只读/)
})

test('角色库 remove：内置拒绝；被引用角色阻止并携带引用位置；零引用删除', async () => {
  const fs = makeFs({
    [REPO + '/dsh/roles/需求分析师.md']: '正文\n',
    [REPO + '/dsh/roles/闲置角色.md']: '正文2\n',
    [USER_DIR + '/wf-a.json']: JSON.stringify({
      id: 'wf-a', displayName: 'A', entry: 'n1',
      nodes: [{ id: 'n1', profile: '需求分析师', label: 'N1', goal: 'g' }],
      edges: [],
    }),
  })
  const sub = makeSubprocess({ fs })
  const { handlers } = loadHost({ fs, subprocess: sub, sandboxPolicy })
  // 内置拒绝（issue-81 后 dispatcher 已非内置，改用仍在内置的 dev）
  const b = await call(handlers, 'vwf.roles.remove', { id: 'dev' })
  assert.equal(b.ok, false)
  assert.match(b.errors[0].message, /内置角色只读/)
  // 被引用 → 阻止 + usage 详情（无强制删除）
  const refd = await call(handlers, 'vwf.roles.remove', { id: '需求分析师' })
  assert.equal(refd.ok, false)
  assert.match(refd.errors[0].message, /仍被 1 个节点使用/)
  assert.equal(refd.usage.count, 1)
  assert.equal(refd.usage.refs[0].workflowId, 'wf-a')
  assert.equal(refd.usage.refs[0].nodes[0].id, 'n1')
  assert.ok(fs._files.has(REPO + '/dsh/roles/需求分析师.md'), '被引用角色未被删除')
  // 零引用 → 删除
  const ok = await call(handlers, 'vwf.roles.remove', { id: '闲置角色' })
  assert.equal(ok.ok, true)
  assert.ok(!fs._files.has(REPO + '/dsh/roles/闲置角色.md'))
})

test('角色库 审查修复：NFC/大小写唯一性、仅写法差异重命名拒绝、Windows 保留名', async () => {
  const fs = makeFs({
    [REPO + '/dsh/roles/CaseRole.md']: '旧内容\n',
    [REPO + '/dsh/roles/需求分析师.md']: '正文\n',
  })
  const sub = makeSubprocess({ fs })
  const { handlers } = loadHost({ fs, subprocess: sub, sandboxPolicy })
  // NFC 等价名（é 规范化不同写法）→ 视为同名拒绝
  const nfc = await call(handlers, 'vwf.roles.create', { name: 'Cr\u00e9dit', content: 'x\n' })
  const nfd = await call(handlers, 'vwf.roles.create', { name: 'Cre\u0301dit', content: 'x\n' })
  assert.equal(nfc.ok, true)
  assert.equal(nfd.ok, false, 'NFD 写法与 NFC 同名应拒绝')
  assert.match(nfd.errors[0].message, /同名角色/)
  // 大小写等价名 → 拒绝
  const caseDup = await call(handlers, 'vwf.roles.create', { name: 'caserole', content: 'x\n' })
  assert.equal(caseDup.ok, false)
  assert.match(caseDup.errors[0].message, /同名角色/)
  // 仅大小写不同的重命名 → 拒绝（同一文件，写后删会删掉自己）
  const caseRen = await call(handlers, 'vwf.roles.update', { id: 'CaseRole', name: 'caserole', content: 'x\n' })
  assert.equal(caseRen.ok, false)
  assert.match(caseRen.errors[0].message, /仅大小写/)
  assert.ok(fs._files.has(REPO + '/dsh/roles/CaseRole.md'), '仅写法差异重命名不产生任何文件变更')
  // Windows 保留设备名 → 拒绝
  const con = await call(handlers, 'vwf.roles.create', { name: 'CON', content: 'x\n' })
  assert.equal(con.ok, false)
  assert.match(con.errors[0].message, /保留/)
  const com1 = await call(handlers, 'vwf.roles.create', { name: 'com1', content: 'x\n' })
  assert.equal(com1.ok, false)
  assert.match(com1.errors[0].message, /保留/)
})

test('角色库 审查修复：纯内容编辑无需 subprocess；重命名仍要求 subprocess', async () => {
  const fs = makeFs({ [REPO + '/dsh/roles/闲置角色.md']: '旧内容\n' })
  // 无 subprocess 服务（静态/web profile 形态）
  const { handlers } = loadHost({ fs, subprocess: undefined, sandboxPolicy })
  const upd = await call(handlers, 'vwf.roles.update', { id: '闲置角色', name: '闲置角色', content: '新内容\n' })
  assert.equal(upd.ok, true, JSON.stringify(upd))
  assert.ok(fs._files.get(REPO + '/dsh/roles/闲置角色.md').startsWith('新内容'), '内容编辑仅依赖 fs')
  const ren = await call(handlers, 'vwf.roles.update', { id: '闲置角色', name: '闲置角色V2', content: 'x\n' })
  assert.equal(ren.ok, false)
  assert.match(ren.errors[0].message, /子进程/)
  assert.ok(fs._files.has(REPO + '/dsh/roles/闲置角色.md'), '重命名被拒绝时旧文件保留')
})

test('角色库 审查修复：目录读取失败 fail-closed（不当作空库放行）', async () => {
  const fs = makeFs({ [REPO + '/dsh/roles/需求分析师.md']: '正文\n' })
  // 模拟清单失败（瞬时宿主/文件系统错误）
  const origList = fs.listDir
  fs.listDir = async () => { throw new Error('EIO 模拟清单失败') }
  const sub = makeSubprocess({ fs })
  const { handlers } = loadHost({ fs, subprocess: sub, sandboxPolicy })
  const c = await call(handlers, 'vwf.roles.create', { name: '新角色', content: 'x\n' })
  assert.equal(c.ok, false, '清单失败时创建必须中止（不得当作空库放行）')
  assert.match(c.errors[0].message, /读取失败/)
  const u = await call(handlers, 'vwf.roles.update', { id: '需求分析师', name: '需求分析师', content: 'x\n' })
  assert.equal(u.ok, false)
  assert.match(u.errors[0].message, /读取失败/)
  fs.listDir = origList
})

test('角色库 审查修复：开放草稿引用纳入 usage（删除/重命名保护）', async () => {
  const fs = makeFs({
    [REPO + '/dsh/roles/需求分析师.md']: '正文\n',
  })
  const sub = makeSubprocess({ fs })
  const { handlers } = loadHost({ fs, subprocess: sub, sandboxPolicy })
  const draft = {
    id: 'draft-x', name: '草稿', entry: 'n1', control: { maxRounds: 3 },
    nodes: [{ id: 'n1', profile: '需求分析师', label: 'N1', goal: 'g' }],
    edges: [],
  }
  const u = await call(handlers, 'vwf.roles.usage', { id: '需求分析师', draftDsl: draft })
  assert.equal(u.ok, true)
  assert.equal(u.count, 1, '草稿引用也计入')
  assert.equal(u.refs[0].draft, true)
  // 仅草稿引用（无持久化引用）→ 删除仍被阻止
  const rm = await call(handlers, 'vwf.roles.remove', { id: '需求分析师', draftDsl: draft })
  assert.equal(rm.ok, false)
  assert.match(rm.errors[0].message, /仍被 1 个节点使用/)
  assert.match(rm.errors[0].message, /草稿|draft|未保存/)
  assert.ok(fs._files.has(REPO + '/dsh/roles/需求分析师.md'), '草稿引用阻止删除时文件保留')
})

test('角色库 审查修复：重命名旧文件删除失败时回滚新文件', async () => {
  const fs = makeFs({ [REPO + '/dsh/roles/闲置角色.md']: '旧内容\n' })
  const sub = makeSubprocess({ fs })
  const realSpawn = sub.spawn
  const reader = (text) => ({ readFrom: () => ({ text, nextOffset: text.length, lossy: false }) })
  // 模拟：删除旧文件（闲置角色.md）的子进程失败
  sub.spawn = (spec) => {
    const argvStr = spec.argv.join(' ')
    if (argvStr.includes('rmSync') && argvStr.includes('闲置角色.md')) {
      return { pid: 1, done: Promise.resolve({ exitCode: 1, signal: null }), collected: { stdout: reader(''), stderr: reader('EACCES 模拟删除失败') }, terminate() {}, waitForExit: async () => true }
    }
    return realSpawn(spec)
  }
  const { handlers } = loadHost({ fs, subprocess: sub, sandboxPolicy })
  const ren = await call(handlers, 'vwf.roles.update', { id: '闲置角色', name: '闲置角色V2', content: '新内容\n' })
  assert.equal(ren.ok, false)
  assert.match(ren.errors[0].message, /已回滚/)
  assert.ok(fs._files.has(REPO + '/dsh/roles/闲置角色.md'), '旧文件未被误删')
  assert.ok(!fs._files.has(REPO + '/dsh/roles/闲置角色V2.md'), '新文件已回滚删除')
})

test('角色库 复审修复：工作流清单失败时 usage/remove fail-closed（失败 ≠ 零引用）', async () => {
  const fs = makeFs({
    [REPO + '/dsh/roles/需求分析师.md']: '正文\n',
    [USER_DIR + '/wf-a.json']: JSON.stringify({
      id: 'wf-a', displayName: 'A', entry: 'n1',
      nodes: [{ id: 'n1', profile: '需求分析师', label: 'N1', goal: 'g' }],
      edges: [],
    }),
  })
  const sub = makeSubprocess({ fs })
  // 用户模板清单读取失败（临时性错误，目录本身存在）
  const origList = fs.listDir
  fs.listDir = async (t) => {
    const p = t && (t.displayPath || t.targetKey)
    if (String(p).includes(USER_DIR)) throw new Error('EIO 模拟用户模板清单失败')
    return origList(t)
  }
  const { handlers } = loadHost({ fs, subprocess: sub, sandboxPolicy })
  const u = await call(handlers, 'vwf.roles.usage', { id: '需求分析师' })
  assert.equal(u.ok, false, '清单失败不得返回成功零引用')
  assert.match(u.errors[0].message, /清单读取失败|读取失败/)
  const rm = await call(handlers, 'vwf.roles.remove', { id: '需求分析师' })
  assert.equal(rm.ok, false)
  assert.match(rm.errors[0].message, /引用统计失败/)
  assert.ok(fs._files.has(REPO + '/dsh/roles/需求分析师.md'), '清单失败时角色未被删除')
  fs.listDir = origList
})

test('角色库 复审修复：角色目录 stat 异常按 error fail-closed（不归为 missing 放行）', async () => {
  const fs = makeFs({
    [REPO + '/dsh/roles/需求分析师.md']: '正文\n',
  })
  const origStat = fs.stat
  // 角色目录存在但 stat 瞬时失败
  fs.stat = async (t) => {
    const p = t && (t.displayPath || t.targetKey)
    if (String(p) === REPO + '/dsh/roles') throw new Error('EIO 模拟 stat 失败')
    return origStat(t)
  }
  const sub = makeSubprocess({ fs })
  const { handlers } = loadHost({ fs, subprocess: sub, sandboxPolicy })
  const c = await call(handlers, 'vwf.roles.create', { name: '新角色', content: 'x\n' })
  assert.equal(c.ok, false, 'stat 异常不得当空库放行（否则会覆盖既有角色）')
  assert.match(c.errors[0].message, /状态读取失败|读取失败/)
  fs.stat = origStat
})

test('角色库 复审修复：profile 引用按 roleKey 规范化匹配（大小写/规范化不敏感）', async () => {
  const fs = makeFs({
    [REPO + '/dsh/roles/analyst.md']: '正文\n',
    [USER_DIR + '/wf-a.json']: JSON.stringify({
      id: 'wf-a', displayName: 'A', entry: 'n1',
      // profile 大小写与文件名不同：文件系统不敏感时实际解析到 analyst.md
      nodes: [{ id: 'n1', profile: 'Analyst', label: 'N1', goal: 'g' }],
      edges: [],
    }),
  })
  const sub = makeSubprocess({ fs })
  const { handlers } = loadHost({ fs, subprocess: sub, sandboxPolicy })
  const u = await call(handlers, 'vwf.roles.usage', { id: 'analyst' })
  assert.equal(u.ok, true)
  assert.equal(u.count, 1, 'Analyst profile 计入 analyst 角色引用')
  const rm = await call(handlers, 'vwf.roles.remove', { id: 'analyst' })
  assert.equal(rm.ok, false)
  assert.match(rm.errors[0].message, /仍被 1 个节点使用/)
  assert.ok(fs._files.has(REPO + '/dsh/roles/analyst.md'), '被引用角色未被删除')
})

test('角色库 三审修复：可选根确认不存在（ENOENT）→ 跳过继续；草稿移除全部引用 → 解除保护', async () => {
  const fs = makeFs({
    [REPO + '/dsh/roles/需求分析师.md']: '正文\n',
    [USER_DIR + '/wf-a.json']: JSON.stringify({
      id: 'wf-a', displayName: 'A', entry: 'n1',
      nodes: [{ id: 'n1', profile: '需求分析师', label: 'N1', goal: 'g' }],
      edges: [],
    }),
  })
  const sub = makeSubprocess({ fs })
  const origList = fs.listDir
  // 宿主根内置目录（~/.dsh/.generated）确认不存在 → strict 扫描应跳过而不是失败
  fs.listDir = async (t) => {
    const p = t && (t.displayPath || t.targetKey)
    if (String(p).includes('/.dsh/.generated')) { throw new Error('ENOENT: no such file or directory') }
    return origList(t)
  }
  const { handlers } = loadHost({ fs, subprocess: sub, sandboxPolicy })
  const u = await call(handlers, 'vwf.roles.usage', { id: '需求分析师' })
  assert.equal(u.ok, true, '可选根 ENOENT 不阻断 usage')
  assert.equal(u.count, 1, '跳过缺失根后仍统计到引用')
  fs.listDir = origList
  // 草稿移除全部引用 → 持久化引用被草稿状态取代（不再误阻止删除/重命名）
  const draftNoRef = {
    id: 'wf-a', name: 'A', entry: 'n1', control: { maxRounds: 3 },
    nodes: [{ id: 'n1', profile: 'dev', label: 'N1', goal: 'g' }],
    edges: [],
  }
  const u2 = await call(handlers, 'vwf.roles.usage', { id: '需求分析师', draftDsl: draftNoRef })
  assert.equal(u2.ok, true)
  assert.equal(u2.count, 0, '草稿移除引用后不再计入（待保存状态以草稿为准）')
})

test('角色库 三审修复：roleDir resolve 瞬时失败按 error fail-closed（ENOENT 才归 missing）', async () => {
  const fs = makeFs({ [REPO + '/dsh/roles/需求分析师.md']: '正文\n' })
  const origResolve = fs.resolve
  fs.resolve = async (path) => {
    if (path === REPO + '/dsh/roles') throw new Error('EIO 模拟 resolve 瞬时失败')
    return origResolve(path)
  }
  const sub = makeSubprocess({ fs })
  const { handlers } = loadHost({ fs, subprocess: sub, sandboxPolicy })
  const c = await call(handlers, 'vwf.roles.create', { name: '新角色', content: 'x\n' })
  assert.equal(c.ok, false, 'resolve 瞬时失败不得当空库放行')
  assert.match(c.errors[0].message, /解析失败|读取失败/)
  fs.resolve = origResolve
})

test('内置双根：仓库 .generated 为空时从 ~/.dsh/.generated 加载（homeBuiltinDir 回归）', async () => {
  // 回归：rootPaths 曾不返回 homeBuiltinDir，而 loadBuiltins 引用 p.homeBuiltinDir——
  // 任意非本仓库会话下内置模板列表为空。修复后宿主根内置模板可见。
  const homeDsl = JSON.stringify({
    id: 'default-workflow', name: '默认工作流', description: '用户级内置', entry: 'n1',
    control: { maxRounds: 9 },
    nodes: [{ id: 'n1', profile: 'dispatcher', label: '节点1', goal: 'g' }],
    edges: [{ from: 'n1', to: '$end', on: 'success' }],
  }, null, 2) + '\n'
  const fs = makeFs({
    [DSH_HOME + '/.generated/default-workflow/vwf-dsl.json']: homeDsl,
    [REPO + '/scripts/validate-core.cjs']: validatorCoreSrc,
  })
  const sub = makeSubprocess({ fs })
  const { handlers } = loadHost({ fs, subprocess: sub, sandboxPolicy })
  const list = await call(handlers, 'vwf.workflows.list')
  const w = list.find(x => x.id === 'default-workflow')
  assert.ok(w && w.builtin === false, '宿主根历史模板可见且为自定义')
  assert.equal(w.name, '默认工作流')
})

test('静态组合包：首次同步完成前也能直接读取包内内置模板', async () => {
  // 回归：页面首个 list RPC 可能早于异步宿主根同步；组合包本身携带的生成物
  // 应直接可读，不能把首屏是否为空交给同步任务的时序。
  const previous = globalThis.__VWF_REPO_ROOT__
  globalThis.__VWF_REPO_ROOT__ = REPO
  try {
    const fs = makeFs({
      [REPO + '/.generated/default-workflow/vwf-dsl.json']: JSON.stringify({
        id: 'default-workflow', name: '默认工作流', entry: 'n1', control: { maxRounds: 9 },
        nodes: [{ id: 'n1', profile: 'dispatcher', label: '节点1', goal: 'g' }],
        edges: [{ from: 'n1', to: '$end', on: 'success' }],
      }),
    })
    const sub = makeSubprocess({ fs })
    const { handlers } = loadHost({
      fs, subprocess: sub, sandboxPolicy,
      agents: { currentInitiator: () => ({ session: { header: { cwd: SESSION_REPO } } }) },
    })
    const list = await call(handlers, 'vwf.workflows.list')
    assert.ok(list.some(x => x.id === 'default-workflow'), '包内生成物可直接进入模板列表')
  } finally {
    if (previous === undefined) delete globalThis.__VWF_REPO_ROOT__
    else globalThis.__VWF_REPO_ROOT__ = previous
  }
})

test('静态组合包：项目路径不可用时仍从包内加载校验内核', async () => {
  // 回归：网页模式没有当前 agent 项目路径；校验内核随组合包仓库一起提供，
  // 保存模板不能因为 repoRoot 为空而被误报为“缺少 scripts/validate-core.cjs”。
  const previous = globalThis.__VWF_REPO_ROOT__
  globalThis.__VWF_REPO_ROOT__ = REPO
  try {
    const fs = makeFs({ [REPO + '/scripts/validate-core.cjs']: validatorCoreSrc })
    const { handlers } = loadHost({
      fs,
      subprocess: makeSubprocess({ fs }),
      sandboxPolicy: { workspaceRoot: '' },
    })
    const v = await call(handlers, 'vwf.validate', { dsl: baseDsl() })
    assert.equal(v.ok, true, JSON.stringify(v.errors))
    assert.notEqual(v.errors && v.errors[0] && v.errors[0].message, '校验内核不可用：缺少 scripts/validate-core.cjs（请确认仓库完整）')
  } finally {
    if (previous === undefined) delete globalThis.__VWF_REPO_ROOT__
    else globalThis.__VWF_REPO_ROOT__ = previous
  }
})

test('动态插件：浏览器保存（无会话 cwd）从宿主 visual-workflow 副本加载校验内核', async () => {
  // 客户端 RPC 没有 currentInitiator；sandboxPolicy.workspaceRoot 是 DSH 部署 cwd，
  // 不是工作流仓库。动态模式也没有 bundle 注入的 __VWF_REPO_ROOT__。
  const previousRoot = globalThis.__VWF_REPO_ROOT__
  const previousAlias = globalThis.__VWF_REPO__
  delete globalThis.__VWF_REPO_ROOT__
  delete globalThis.__VWF_REPO__
  try {
    const fs = makeFs({
      [DSH_HOME + '/visual-workflow/validate-core.cjs']: validatorCoreSrc,
    })
    const { handlers } = loadHost({
      fs,
      subprocess: makeSubprocess({ fs }),
      sandboxPolicy: { workspaceRoot: SESSION_REPO, resolve: () => ({ mode: 'danger-full-access', workspaceRoot: SESSION_REPO }) },
    })
    const v = await call(handlers, 'vwf.validate', { dsl: baseDsl() })
    assert.equal(v.ok, true, JSON.stringify(v.errors))
    assert.notEqual(
      v.errors && v.errors[0] && v.errors[0].message,
      '校验内核不可用：缺少 scripts/validate-core.cjs（请确认仓库完整）',
    )
  } finally {
    if (previousRoot === undefined) delete globalThis.__VWF_REPO_ROOT__
    else globalThis.__VWF_REPO_ROOT__ = previousRoot
    if (previousAlias === undefined) delete globalThis.__VWF_REPO__
    else globalThis.__VWF_REPO__ = previousAlias
  }
})

test('动态插件：fs 读不到仓库时经子进程从 Home 副本加载校验内核', async () => {
  const previousRoot = globalThis.__VWF_REPO_ROOT__
  const previousAlias = globalThis.__VWF_REPO__
  delete globalThis.__VWF_REPO_ROOT__
  delete globalThis.__VWF_REPO__
  try {
    const hostFs = makeFs({})
    const kernelFs = makeFs({
      [DSH_HOME + '/visual-workflow/validate-core.cjs']: validatorCoreSrc,
    })
    const { handlers } = loadHost({
      fs: hostFs,
      subprocess: makeSubprocess({ fs: kernelFs }),
      sandboxPolicy: { workspaceRoot: '', resolve: () => ({ mode: 'danger-full-access', workspaceRoot: '' }) },
    })
    const v = await call(handlers, 'vwf.validate', { dsl: baseDsl() })
    assert.equal(v.ok, true, JSON.stringify(v.errors))
  } finally {
    if (previousRoot === undefined) delete globalThis.__VWF_REPO_ROOT__
    else globalThis.__VWF_REPO_ROOT__ = previousRoot
    if (previousAlias === undefined) delete globalThis.__VWF_REPO__
    else globalThis.__VWF_REPO__ = previousAlias
  }
})

test('动态插件：workspaceRoot 在仓库子目录时向上查找校验内核', async () => {
  const previousRoot = globalThis.__VWF_REPO_ROOT__
  const previousAlias = globalThis.__VWF_REPO__
  delete globalThis.__VWF_REPO_ROOT__
  delete globalThis.__VWF_REPO__
  try {
    const nested = REPO + '/packages/dsh-visual-workflow'
    const fs = makeFs({ [REPO + '/scripts/validate-core.cjs']: validatorCoreSrc })
    const { handlers } = loadHost({
      fs,
      subprocess: makeSubprocess({ fs }),
      sandboxPolicy: { workspaceRoot: nested, resolve: () => ({ mode: 'danger-full-access', workspaceRoot: nested }) },
    })
    const v = await call(handlers, 'vwf.validate', { dsl: baseDsl() })
    assert.equal(v.ok, true, JSON.stringify(v.errors))
  } finally {
    if (previousRoot === undefined) delete globalThis.__VWF_REPO_ROOT__
    else globalThis.__VWF_REPO_ROOT__ = previousRoot
    if (previousAlias === undefined) delete globalThis.__VWF_REPO__
    else globalThis.__VWF_REPO__ = previousAlias
  }
})

test('动态插件：历史 loader 的 __VWF_REPO__ 别名可加载校验内核', async () => {
  const previousRoot = globalThis.__VWF_REPO_ROOT__
  const previousAlias = globalThis.__VWF_REPO__
  delete globalThis.__VWF_REPO_ROOT__
  globalThis.__VWF_REPO__ = REPO
  try {
    const fs = makeFs({ [REPO + '/scripts/validate-core.cjs']: validatorCoreSrc })
    const { handlers } = loadHost({
      fs,
      subprocess: makeSubprocess({ fs }),
      sandboxPolicy: { workspaceRoot: '', resolve: () => ({ mode: 'danger-full-access', workspaceRoot: '' }) },
    })
    const v = await call(handlers, 'vwf.validate', { dsl: baseDsl() })
    assert.equal(v.ok, true, JSON.stringify(v.errors))
  } finally {
    if (previousRoot === undefined) delete globalThis.__VWF_REPO_ROOT__
    else globalThis.__VWF_REPO_ROOT__ = previousRoot
    if (previousAlias === undefined) delete globalThis.__VWF_REPO__
    else globalThis.__VWF_REPO__ = previousAlias
  }
})

test('动态插件：从插件 dist/validate-core.cjs 加载校验内核', async () => {
  const previousRoot = globalThis.__VWF_REPO_ROOT__
  const previousAlias = globalThis.__VWF_REPO__
  delete globalThis.__VWF_REPO_ROOT__
  delete globalThis.__VWF_REPO__
  try {
    const PLUGIN = '/plugin/pkg'
    const fs = makeFs({
      [PLUGIN + '/dist/validate-core.cjs']: validatorCoreSrc,
    })
    const { handlers } = loadHost({
      fs,
      subprocess: makeSubprocess({ fs }),
      pluginRoot: PLUGIN,
      sandboxPolicy: { workspaceRoot: '', resolve: () => ({ mode: 'danger-full-access', workspaceRoot: '' }) },
    })
    const v = await call(handlers, 'vwf.validate', { dsl: baseDsl() })
    assert.equal(v.ok, true, JSON.stringify(v.errors))
  } finally {
    if (previousRoot === undefined) delete globalThis.__VWF_REPO_ROOT__
    else globalThis.__VWF_REPO_ROOT__ = previousRoot
    if (previousAlias === undefined) delete globalThis.__VWF_REPO__
    else globalThis.__VWF_REPO__ = previousAlias
  }
})

test('动态插件：repo-root 指针让浏览器保存使用仓库生成器', async () => {
  const previousRoot = globalThis.__VWF_REPO_ROOT__
  const previousAlias = globalThis.__VWF_REPO__
  delete globalThis.__VWF_REPO_ROOT__
  delete globalThis.__VWF_REPO__
  try {
    const fs = makeFs({
      [DSH_HOME + '/visual-workflow/repo-root']: REPO + '\n',
      [DSH_HOME + '/visual-workflow/validate-core.cjs']: validatorCoreSrc,
      [REPO + '/scripts/validate-core.cjs']: validatorCoreSrc,
    })
    const sub = makeSubprocess({ fs })
    const { handlers } = loadHost({
      fs,
      subprocess: sub,
      sandboxPolicy: { workspaceRoot: SESSION_REPO, resolve: () => ({ mode: 'danger-full-access', workspaceRoot: SESSION_REPO }) },
    })
    const saved = await call(handlers, 'vwf.workflows.save', { dsl: baseDsl({ id: 'browser-save' }) })
    assert.equal(saved.ok, true, JSON.stringify(saved.errors))
    assert.ok(
      sub._calls.some((argv) => argv[1] === REPO + '/scripts/generate.mjs'),
      JSON.stringify(sub._calls),
    )
  } finally {
    if (previousRoot === undefined) delete globalThis.__VWF_REPO_ROOT__
    else globalThis.__VWF_REPO_ROOT__ = previousRoot
    if (previousAlias === undefined) delete globalThis.__VWF_REPO__
    else globalThis.__VWF_REPO__ = previousAlias
  }
})

test('静态组合包：另存为使用包内生成器，不使用宿主工作目录下的同名路径', async () => {
  // 回归：web profile 的 sandbox workspace 可能是 DSH 宿主仓库，
  // 生成器实际随 workflow-manager 组合包提供，不能拼接到宿主 workspace。
  const previous = globalThis.__VWF_REPO_ROOT__
  globalThis.__VWF_REPO_ROOT__ = REPO
  try {
    const fs = makeFs({ [REPO + '/scripts/validate-core.cjs']: validatorCoreSrc })
    const sub = makeSubprocess({ fs })
    const { handlers } = loadHost({
      fs,
      subprocess: sub,
      sandboxPolicy: { workspaceRoot: '/deepseek-harness' },
    })
    const saved = await call(handlers, 'vwf.workflows.save', { dsl: baseDsl({ id: 'my-flow001', name: '另存为测试' }) })
    assert.equal(saved.ok, true, JSON.stringify(saved.errors))
    assert.ok(
      sub._calls.some((argv) => argv[1] === REPO + '/scripts/generate.mjs'),
      JSON.stringify(sub._calls),
    )
    assert.equal(
      sub._calls.some((argv) => argv[1] === '/deepseek-harness/scripts/generate.mjs'),
      false,
      JSON.stringify(sub._calls),
    )
  } finally {
    if (previous === undefined) delete globalThis.__VWF_REPO_ROOT__
    else globalThis.__VWF_REPO_ROOT__ = previous
  }
})

test('syncBuiltins：apply 后把仓库 .generated 标准配置同步到宿主根（仅补缺失）', async () => {
  const fs = makeFs({
    [REPO + '/.generated/default-workflow/vwf-dsl.json']: JSON.stringify({ id: 'default-workflow', bundleRoles: true }),
    [REPO + '/.generated/default-workflow/roles/dispatcher.md']: '调度角色正文\n',
    [REPO + '/.generated/dev-workflow-2-0/vwf-dsl.json']: JSON.stringify({ id: 'dev-workflow-2-0' }),
    [REPO + '/.generated/dev-workflow-2-0/script.mjs']: '// project-only\n',
  })
  const sub = makeSubprocess({ fs })
  loadHost({ fs, subprocess: sub, sandboxPolicy })
  // syncBuiltins 异步触发（fire-and-forget）：轮询假 fs 等待落盘
  const dst = DSH_HOME + '/.generated/default-workflow/vwf-dsl.json'
  let synced = false
  for (let i = 0; i < 100; i++) {
    if (fs._files.has(dst)) { synced = true; break }
    await new Promise(r => setTimeout(r, 10))
  }
  assert.ok(synced, '声明用户级的内置模板已同步到宿主根 ~/.dsh/.generated')
  assert.ok(fs._files.has(DSH_HOME + '/.generated/default-workflow/roles/dispatcher.md'), '角色包随模板同步')
  assert.ok(!fs._files.has(DSH_HOME + '/.generated/dev-workflow-2-0/vwf-dsl.json'), '项目专属模板不进入用户级目录')
  assert.ok(!fs._files.has(DSH_HOME + '/.generated/.sync-probe'), '同步不留下探针文件')
})

test('vwf.models 无 llm 服务时返回空 providers', async () => {
  const { handlers } = loadHost()
  const r = await call(handlers, 'vwf.models')
  assert.deepEqual(r, { providers: [] })
})

test('vwf.state 未找到返回 found:false', async () => {
  const { handlers } = env()
  const r = await call(handlers, 'vwf.state', { runId: 'nope' })
  assert.deepEqual(r, { found: false, state: null })
})

// ═══════════════════════════════════════════════════════════════════════════
// 候选二 Q7 · 业务规则前端可配置闭环（编辑器字段 → DSL → 蓝图 → 校验生效）
// ═══════════════════════════════════════════════════════════════════════════

test('Q7 闭环：heteroCheck/onMaxRounds 随 DSL 往返并在校验中生效', async () => {
  const { handlers, fs } = env()
  const dsl = {
    ...heteroDsl({ provider: 'deepseek-official', model: 'v4-pro' }, { provider: 'kimi-coding', model: 'k3' }),
    heteroCheck: true,
    onMaxRounds: 'auto-reschedule',
  }
  const v = await call(handlers, 'vwf.validate', { dsl })
  assert.equal(v.ok, true, JSON.stringify(v.errors))
  assert.equal(v.sanitized.heteroCheck, true, '异源开关过 sanitize 保留')
  assert.equal(v.sanitized.onMaxRounds, 'auto-reschedule', '超限行为过 sanitize 保留')
  const s = await call(handlers, 'vwf.workflows.save', { dsl })
  assert.equal(s.ok, true, JSON.stringify(s.errors))
  const bp = JSON.parse(fs._files.get(USER_DIR + '/h1.json'))
  assert.equal(bp.heteroCheck, true, '异源开关落盘蓝图')
  assert.equal(bp.onMaxRounds, 'auto-reschedule', '超限行为落盘蓝图')
})

test('Q7 闭环：开启异源开关 + 同模型 → 保存被拒；关掉开关同模型依旧被拒（硬规则全局）', async () => {
  const { handlers } = env()
  const on = await call(handlers, 'vwf.workflows.save', { dsl: { ...heteroDsl({ provider: 'p1', model: 'm1' }, { provider: 'p1', model: 'm1' }), heteroCheck: true } })
  assert.equal(on.ok, false)
  assert.ok(on.errors.some(e => e.message.includes('模型相同')), JSON.stringify(on.errors))
  const off = await call(handlers, 'vwf.workflows.save', { dsl: heteroDsl({ provider: 'p1', model: 'm1' }, { provider: 'p1', model: 'm1' }) })
  assert.equal(off.ok, false, '异源硬规则全局强制（T-06），与开关无关')
})

test('Q7 闭环：回合上限系统约束（10 拒并带 control:maxRounds 坐标；5 通过）', async () => {
  const { handlers, fs } = env()
  const bad = await call(handlers, 'vwf.workflows.save', { dsl: baseDsl({ control: { maxRounds: 10 } }) })
  assert.equal(bad.ok, false)
  assert.ok(bad.errors.some(e => e.fieldKey === 'control:maxRounds'), JSON.stringify(bad.errors))
  const good = await call(handlers, 'vwf.workflows.save', { dsl: baseDsl({ control: { maxRounds: 5 } }) })
  assert.equal(good.ok, true, JSON.stringify(good.errors))
  const bp = JSON.parse(fs._files.get(USER_DIR + '/t1.json'))
  assert.equal(bp.control.maxRounds, 5, '上限 5 落盘蓝图')
})

test('fanout 投影往返：kind/items/failOn 经 validate/save/list 无损', async () => {
  const { handlers, fs } = env()
  const dsl = {
    id: 'fanout-ui', name: '扇出编辑器', entry: 'fan', control: { maxRounds: 3 },
    nodes: [
      {
        id: 'fan', kind: 'fanout', profile: 'dispatcher', label: '逐项处理',
        goal: '处理 {{item}}', items: '$.args.items', failOn: 1,
        model: { provider: 'p1', model: 'm1' },
        output: { schema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } },
      },
      { id: 'finish', profile: 'test', label: '汇总', goal: '汇总', model: { provider: 'p1', model: 'm1' } },
    ],
    edges: [
      { from: 'fan', to: 'finish', on: 'success' },
      { from: 'fan', to: '$end', on: 'failure' },
      { from: 'finish', to: '$end', on: 'success' },
    ],
  }
  const v = await call(handlers, 'vwf.validate', { dsl })
  assert.equal(v.ok, true, JSON.stringify(v.errors))
  assert.equal(v.sanitized.nodes[0].kind, 'fanout')
  assert.equal(v.sanitized.nodes[0].items, '$.args.items')
  assert.equal(v.sanitized.nodes[0].failOn, 1)
  const saved = await call(handlers, 'vwf.workflows.save', { dsl })
  assert.equal(saved.ok, true, JSON.stringify(saved.errors))
  const bp = JSON.parse(fs._files.get(USER_DIR + '/fanout-ui.json'))
  assert.equal(bp.nodes[0].kind, 'fanout')
  assert.equal(bp.nodes[0].items, '$.args.items')
  assert.equal(bp.nodes[0].failOn, 1)
  const listed = (await call(handlers, 'vwf.workflows.list')).find((item) => item.id === 'fanout-ui')
  assert.equal(listed.dsl.nodes[0].kind, 'fanout')
  assert.equal(listed.dsl.nodes[0].items, '$.args.items')
  assert.equal(listed.dsl.nodes[0].failOn, 1)
})

test('fanout 校验错误按 kind/items/failOn fieldKey 接入宿主', async () => {
  const { handlers } = env()
  const dsl = baseDsl({
    nodes: [
      {
        id: 'a', kind: 'fanout', profile: 'dispatcher', label: 'A', goal: '缺占位',
        items: '$.bad.items', failOn: -1, model: { provider: 'p1', model: 'm1' },
      },
      { id: 'b', profile: 'dev', label: 'B', goal: '目标B', model: { provider: 'p1', model: 'm1' } },
    ],
  })
  const v = await call(handlers, 'vwf.validate', { dsl })
  assert.equal(v.ok, false)
  assert.ok(v.fieldErrors['node:a:items'])
  assert.ok(v.fieldErrors['node:a:failOn'])
  assert.ok(v.fieldErrors['node:a:goal'])
})

// ═══════════════════════════════════════════════════════════════════════════
// #19 · 多 run 并行三约束（P2-T4）：runTag 登记 / 同 taskId 互斥 / entry 续跑
//      接管 / vwf.runs.list 清单 / 双 run 事件流隔离
// ═══════════════════════════════════════════════════════════════════════════

// 可控假引擎：start() 返回挂起 result（测试末尾统一放行终态），事件经 loadHost
// 的 events 表手工驱动——与真实 worker 线程的异步投递时序解耦。
function makeEngine() {
  const pending = []
  return {
    starts: [],
    start(req) {
      this.starts.push(req)
      const id = 'run-' + this.starts.length
      let release = () => {}
      const result = new Promise((r) => { release = r })
      pending.push({ id, release })
      return { id, result }
    },
    end(id, stopReason, value) {
      const p = pending.find((x) => x.id === id)
      if (p) p.release({ stopReason, value: value === undefined ? null : value, agentsStarted: 0 })
    },
  }
}

// 结束一次运行：resolve 引擎 result（wf_run 回执需要）+ 投递 workflow/end 事件
// （runs 状态机与 runTag.active 清除依赖事件——假引擎不会自动广播）
// 真实引擎语义：workflow/end 事件只带 stopReason（completed/cancelled/error，
// 无 value）；脚本终态在 result.value 里，只有 wf_run 的 await 能看到
function settleRun(eng, events, id, scriptStatus, extra = {}) {
  eng.end(id, 'completed', { status: scriptStatus, ...extra })
  const ev = events.get('workflow/end')
  if (ev) ev({ id }, { stopReason: 'completed' })
}

function engineEnv(eng) {
  return env({ extra: { workflowEngine: eng, agents: { requireInitiator: () => ({}), currentInitiator: () => null } } })
}

// wf_run.execute 内部有校验/编译等多个 await，引擎 start 非同步可达：轮询等待
async function until(fn, label, ms = 4000) {
  const t0 = Date.now()
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('until 超时：' + (label || '条件未满足'))
    await new Promise((r) => setTimeout(r, 5))
  }
}

async function assertMutexBlocked(executePromise, eng, startsBefore, label) {
  let settled = false
  let value
  executePromise.then((v) => { settled = true; value = v }, (e) => { settled = true; value = e })
  const t0 = Date.now()
  while (Date.now() - t0 < 800) {
    if (eng.starts.length > startsBefore) throw new Error(label + '：错误地启动了引擎')
    if (settled) break
    await new Promise((r) => setTimeout(r, 5))
  }
  if (!settled) throw new Error(label + '：未立即返回互斥错误')
  assert.ok(String(value).includes('串行互斥'), label + '：' + value)
}

test('#19 T1：wf_run 启动登记 taskId/workflowId；runs.list 最新在前；双 run 状态互不串扰', async () => {
  const eng = makeEngine()
  const { handlers, events, definedTools } = engineEnv(eng)
  const wfRun = definedTools.find(t => t.name === 'wf_run')
  assert.ok(wfRun, 'wf_run 已注册')
  assert.equal(eng.starts.length, 0)
  const p1 = wfRun.execute({ templateId: 'dev-workflow-2-0', taskId: 'issue-12' })
  await until(() => eng.starts.length >= 1, '第一次启动放行')
  events.get('workflow/start')({ id: 'run-1', meta: { name: '开发工作流 2.0' } })
  const p2 = wfRun.execute({ templateId: 'dev-workflow-2-0', taskId: 'issue-13' })
  await until(() => eng.starts.length >= 2, '不同 taskId 并行放行')
  events.get('workflow/start')({ id: 'run-2', meta: { name: '开发工作流 2.0' } })
  // 交错事件：两个 run 各自 phase/log/agent 互不相干
  events.get('workflow/phase')({ id: 'run-1' }, '调度')
  events.get('workflow/phase')({ id: 'run-2' }, '开发')
  events.get('workflow/agent-start')({ id: 'run-1' }, { seq: 1, label: 'dev', phase: '调度' })
  events.get('workflow/agent-start')({ id: 'run-2' }, { seq: 1, label: 'review', phase: '开发' })
  events.get('workflow/log')({ id: 'run-2' }, 'B 的私有日志')

  const list = await call(handlers, 'vwf.runs.list', {})
  assert.equal(list.runs.length, 2)
  assert.equal(list.runs[0].id, 'run-2', '最新在前')
  assert.equal(list.runs[1].id, 'run-1')
  assert.equal(list.runs[1].taskId, 'issue-12')
  assert.equal(list.runs[1].workflowId, 'dev-workflow-2-0', 'templateId 登记为来源')
  assert.equal(typeof list.runs[1].startedAt, 'number')
  assert.equal(list.runs[1].supersededBy, '')

  const s1 = await call(handlers, 'vwf.state', { runId: 'run-1' })
  const s2 = await call(handlers, 'vwf.state', { runId: 'run-2' })
  assert.equal(s1.found, true)
  assert.equal(s1.state.phase, '调度', 'A 的阶段不被 B 覆盖')
  assert.equal(s2.state.phase, '开发')
  assert.deepEqual(s1.state.agents.map(a => a.label), ['dev'])
  assert.equal(s1.state.logs.some(l => l.includes('B 的私有日志')), false, 'A 看不到 B 的日志')
  assert.ok(s2.state.logs.some(l => l.includes('B 的私有日志')))
  assert.equal(s1.state.taskId, 'issue-12')
  assert.equal(s2.state.taskId, 'issue-13')

  settleRun(eng, events, 'run-1', 'DONE')
  settleRun(eng, events, 'run-2', 'DONE')
  const [r1, r2] = await Promise.all([p1, p2])
  // 终态回写回归：事件层是 completed，权威状态应为脚本返回 DONE
  const d1 = await call(handlers, 'vwf.state', { runId: 'run-1' })
  assert.equal(d1.state.status, 'DONE', 'value.status 回写覆盖事件层 completed')
  assert.ok(r1.includes('"stopReason":"completed"') && r1.includes('"status":"DONE"'), r1)
  assert.ok(r2.includes('"stopReason":"completed"') && r2.includes('"status":"DONE"'), r2)
})

test('#19 T2（AC2）：同 taskId 进行中二次启动被拒并提示占用 runId；不同 taskId 放行；完成后解除', async () => {
  const eng = makeEngine()
  const { handlers, events, definedTools } = engineEnv(eng)
  const wfRun = definedTools.find(t => t.name === 'wf_run')
  const p1 = wfRun.execute({ templateId: 'dev-workflow-2-0', taskId: 'issue-12' })
  await until(() => eng.starts.length >= 1, '首次启动')
  // 互斥不依赖 workflow/start 事件到达（tag.active 空窗回归点）
  const blocked = await wfRun.execute({ templateId: 'dev-workflow-2-0', taskId: 'issue-12' })
  assert.ok(blocked.includes('串行互斥'), blocked)
  assert.ok(blocked.includes('run-1'), '提示占用中的 runId')
  assert.equal(eng.starts.length, 1, '被拒调用未触达引擎')
  const p2 = wfRun.execute({ templateId: 'dev-workflow-2-0', taskId: 'issue-13' })
  await until(() => eng.starts.length >= 2, '不同 taskId 并行放行')
  settleRun(eng, events, 'run-1', 'DONE')
  settleRun(eng, events, 'run-2', 'DONE')
  await Promise.all([p1, p2])
  // 终态后同 taskId 解除互斥，可再次启动
  const p3 = wfRun.execute({ templateId: 'dev-workflow-2-0', taskId: 'issue-12' })
  await until(() => eng.starts.length >= 3, '终态后同 taskId 可再次启动')
  settleRun(eng, events, 'run-3', 'DONE')
  await p3
})

test('#19 T3（AC3）：AWAITING_HUMAN 占用同 taskId 拒绝新启动；entry 续跑放行并把旧门禁标记接管', async () => {
  const eng = makeEngine()
  const { handlers, events, definedTools } = engineEnv(eng)
  const wfRun = definedTools.find(t => t.name === 'wf_run')
  const p1 = wfRun.execute({ templateId: 'dev-workflow-2-0', taskId: 'issue-12' })
  await until(() => eng.starts.length >= 1, '首次启动')
  events.get('workflow/start')({ id: 'run-1', meta: { name: 'x' } })
  settleRun(eng, events, 'run-1', 'AWAITING_HUMAN_accept')
  const receipt1 = await p1
  // 回执契约：引擎原样 completed + value 携带脚本终态（runtime-host H1/H2 钉住）
  assert.ok(receipt1.includes('"stopReason":"completed"') && receipt1.includes('AWAITING_HUMAN_accept'), receipt1)
  // 门禁占用仍互斥（isActiveStatus 兜住 AWAITING_HUMAN_* 终态）
  const blocked = await wfRun.execute({ templateId: 'dev-workflow-2-0', taskId: 'issue-12' })
  assert.ok(blocked.includes('串行互斥'), blocked)
  assert.ok(blocked.includes('entry='), '提示续跑路径')
  // entry 续跑绕过互斥；接管发生在续跑启动边界（start 后同步 supersedeParked）
  const p2 = wfRun.execute({ templateId: 'dev-workflow-2-0', taskId: 'issue-12', entry: 'accept', approved: true })
  await until(() => eng.starts.length >= 2, 'entry 续跑绕过互斥')
  events.get('workflow/start')({ id: 'run-2', meta: { name: 'x' } })
  const s1 = await call(handlers, 'vwf.state', { runId: 'run-1' })
  assert.equal(s1.state.status, 'AWAITING_HUMAN_accept', '旧记录状态保留供追溯')
  assert.equal(s1.state.supersededBy, 'run-2', '旧门禁标记接管')
  const list = await call(handlers, 'vwf.runs.list', {})
  assert.equal(list.runs.find(r => r.id === 'run-1').supersededBy, 'run-2', '旧卡片退出门禁队列')
  assert.equal(list.runs.find(r => r.id === 'run-2').supersededBy, '')
  assert.equal(list.runs[0].id, 'run-2', '续跑记录最新在前')
  settleRun(eng, events, 'run-2', 'DONE')
  await p2
  const d2 = await call(handlers, 'vwf.state', { runId: 'run-2' })
  assert.equal(d2.state.status, 'DONE', '续跑终态同样回写为 DONE')
})

test('#19 T4（AC1）：无 wf_run 参与的双 run 交错事件按 runId 隔离（平台工具直起路径）', async () => {
  const { handlers, events } = env()
  events.get('workflow/start')({ id: 'wfa', meta: { name: 'A' } })
  events.get('workflow/start')({ id: 'wfb', meta: { name: 'B' } })
  for (let i = 1; i <= 3; i++) {
    events.get('workflow/agent-start')({ id: 'wfa' }, { seq: i, label: 'a-' + i, phase: 'pa' })
    events.get('workflow/agent-start')({ id: 'wfb' }, { seq: i, label: 'b-' + i, phase: 'pb' })
    events.get('workflow/agent-end')({ id: 'wfa' }, { seq: i, outcome: i === 3 ? 'failed' : 'completed' })
    events.get('workflow/agent-end')({ id: 'wfb' }, { seq: i, outcome: 'completed' })
  }
  events.get('workflow/end')({ id: 'wfa' }, { stopReason: 'FAILED_AT_dev' })
  events.get('workflow/end')({ id: 'wfb' }, { stopReason: 'DONE' })
  const a = await call(handlers, 'vwf.state', { runId: 'wfa' })
  const b = await call(handlers, 'vwf.state', { runId: 'wfb' })
  const none = await call(handlers, 'vwf.state', { runId: 'nope' })
  assert.equal(a.state.status, 'FAILED_AT_dev')
  assert.equal(b.state.status, 'DONE')
  assert.equal(a.state.agents.filter(x => x.outcome === 'failed').length, 1, '失败只落在 A')
  assert.equal(b.state.agents.some(x => x.outcome === 'failed'), false)
  assert.equal(none.found, false)
  const list = await call(handlers, 'vwf.runs.list', {})
  assert.deepEqual(list.runs.map(r => r.id), ['wfb', 'wfa'], '最新在前')
  assert.deepEqual(list.runs.map(r => r.taskId), ['', ''], '平台工具直起无 tag：taskId 留空且不影响列表')
})

test('#18 终态归一：workflow/end 时未收到 agent-end 的子代理按 failed 收口，不误判为 running', async () => {
  const { handlers, events } = env()
  events.get('workflow/start')({ id: 'wfr', meta: { name: 'F' } })
  events.get('workflow/phase')({ id: 'wfr' }, '逐项处理')
  for (let i = 1; i <= 3; i++) {
    events.get('workflow/agent-start')({ id: 'wfr' }, { seq: i, label: '逐项处理 #' + i, phase: '逐项处理' })
  }
  // 只有 #2 投递了 agent-end；#1/#3 启动即失败、引擎未投递 agent-end
  events.get('workflow/agent-end')({ id: 'wfr' }, { seq: 2, outcome: 'failed' })
  events.get('workflow/end')({ id: 'wfr' }, { stopReason: 'FAILED_AT_fan' })
  const s = await call(handlers, 'vwf.state', { runId: 'wfr' })
  assert.equal(s.state.status, 'FAILED_AT_fan')
  assert.deepEqual(s.state.agents.map(a => a.outcome), ['failed', 'failed', 'failed'],
    '终局时仍 running 的行按 failed 收口（看板红色，不再永久进行中）')
  // 迟到的乱序 agent-end 仍按 seq 覆盖回真实结果
  events.get('workflow/agent-end')({ id: 'wfr' }, { seq: 1, outcome: 'completed' })
  const s2 = await call(handlers, 'vwf.state', { runId: 'wfr' })
  assert.deepEqual(s2.state.agents.map(a => a.outcome), ['completed', 'failed', 'failed'])
})

test('#19 评审修复：终态正则接受非 ASCII 节点 id 与 fanout cap 失败态', async () => {
  const eng = makeEngine()
  const { handlers, events, definedTools } = engineEnv(eng)
  const wfRun = definedTools.find(t => t.name === 'wf_run')
  // 非 ASCII 门禁节点 id：AWAITING_HUMAN_验收 必须被权威回写
  const p1 = wfRun.execute({ templateId: 'dev-workflow-2-0', taskId: 'issue-19a' })
  await until(() => eng.starts.length >= 1, '启动1')
  events.get('workflow/start')({ id: 'run-1', meta: { name: 'x' } })
  settleRun(eng, events, 'run-1', 'AWAITING_HUMAN_验收')
  await p1
  const s1 = await call(handlers, 'vwf.state', { runId: 'run-1' })
  assert.equal(s1.state.status, 'AWAITING_HUMAN_验收', '非 ASCII 节点 id 的门禁态被回写')
  // fanout cap 失败态：FAILED_ITEM_CAP 同为脚本终态
  const p2 = wfRun.execute({ templateId: 'dev-workflow-2-0', taskId: 'issue-19b' })
  await until(() => eng.starts.length >= 2, '启动2')
  events.get('workflow/start')({ id: 'run-2', meta: { name: 'x' } })
  settleRun(eng, events, 'run-2', 'FAILED_ITEM_CAP')
  await p2
  const s2 = await call(handlers, 'vwf.state', { runId: 'run-2' })
  assert.equal(s2.state.status, 'FAILED_ITEM_CAP', 'cap 失败态被回写')
  // 门禁占用互斥对非 ASCII 态同样生效
  const blocked = await wfRun.execute({ templateId: 'dev-workflow-2-0', taskId: 'issue-19a' })
  assert.ok(blocked.includes('串行互斥'), 'AWAITING_HUMAN_验收 占用同 taskId 互斥')
})

function hdDsl() {
  return {
    id: 'hd-ui',
    name: 'HD 测试',
    entry: 'work',
    control: { maxRounds: 3 },
    nodes: [
      {
        id: 'work', profile: 'dev', label: '执行', goal: '目标',
        model: { provider: 'p1', model: 'm1' },
        output: { schema: { type: 'object', properties: { status: { type: 'string' } }, required: ['status'], additionalProperties: false } },
      },
      { id: 'finish', profile: 'closeout', label: '收口', goal: '收口', model: { provider: 'p2', model: 'm2' } },
    ],
    edges: [
      { from: 'work', to: '$human-decision', on: 'success' },
      { from: '$human-decision', to: 'finish', on: 'success', result: 'SHIP' },
      { from: 'finish', to: '$end', on: 'success' },
    ],
    humanDecision: { maxRoundsReachedOptions: ['STOP', 'USER_ACCEPTED'] },
  }
}

function outcomeDsl() {
  const bp = JSON.parse(readFileSync(join(here, '..', '..', '..', 'scripts', 'test', 'fixtures', 'outcome-evaluate-mini.json'), 'utf8'))
  const models = (bp.bindings && bp.bindings.models) || {}
  return {
    id: bp.id,
    name: bp.displayName,
    entry: bp.entry,
    control: bp.control,
    nodes: bp.nodes.map((n) => ({ ...n, label: n.label || n.id, model: models[n.id] })),
    edges: bp.edges,
  }
}

test('#120 Human Decision 投影往返：result / humanDecision 经 validate/save 无损', async () => {
  const { handlers, fs } = env()
  const dsl = hdDsl()
  const v = await call(handlers, 'vwf.validate', { dsl })
  assert.equal(v.ok, true, JSON.stringify(v.errors))
  const saved = await call(handlers, 'vwf.workflows.save', { dsl })
  assert.equal(saved.ok, true, JSON.stringify(saved.errors))
  const bp = JSON.parse(fs._files.get(USER_DIR + '/hd-ui.json'))
  assert.equal(bp.edges.find((e) => e.from === '$human-decision').result, 'SHIP')
  assert.deepEqual(bp.humanDecision.maxRoundsReachedOptions, ['STOP', 'USER_ACCEPTED'])
  const listed = (await call(handlers, 'vwf.workflows.list')).find((item) => item.id === 'hd-ui')
  assert.equal(listed.dsl.edges.find((e) => e.from === '$human-decision').result, 'SHIP')
})

test('#120 WAITING_HUMAN 占用同 taskId；decision_id 续跑接管并可读取 Package', async () => {
  const eng = makeEngine()
  const { handlers, events, definedTools } = engineEnv(eng)
  const wfRun = definedTools.find((t) => t.name === 'wf_run')
  const pkg = { why: '等人', current_state: '待拍板', options: [{ id: 'STOP' }], subsequent_effects: { STOP: '停' } }
  const p1 = wfRun.execute({ templateId: 'dev-workflow-2-0', taskId: 'issue-hd' })
  await until(() => eng.starts.length >= 1, '首次启动')
  events.get('workflow/start')({ id: 'run-1', meta: { name: 'x' } })
  settleRun(eng, events, 'run-1', 'WAITING_HUMAN', {
    decision_id: 'issue-hd:work:0',
    reason: 'ESCALATED_DECISION',
    decision_package: pkg,
    control_event: { record_kind: 'DECISION', decision_id: 'issue-hd:work:0', user_choice: null },
  })
  await p1
  const s1 = await call(handlers, 'vwf.state', { runId: 'run-1' })
  assert.equal(s1.state.status, 'WAITING_HUMAN')
  assert.equal(s1.state.decision_id, 'issue-hd:work:0')
  assert.equal(s1.state.decision_package.why, '等人')
  const blocked = await wfRun.execute({ templateId: 'dev-workflow-2-0', taskId: 'issue-hd' })
  assert.ok(blocked.includes('串行互斥'), blocked)
  const startsBefore = eng.starts.length
  await assertMutexBlocked(wfRun.execute({ templateId: 'dev-workflow-2-0', taskId: 'issue-hd', entry: 'work' }), eng, startsBefore, 'WAITING_HUMAN 占用不得被仅 entry 解除')
  await assertMutexBlocked(wfRun.execute({ templateId: 'dev-workflow-2-0', taskId: 'issue-hd', decision_id: 'other:work:0', user_choice: 'STOP' }), eng, startsBefore, 'WAITING_HUMAN 占用不得被错误 decision_id 解除')
  await assertMutexBlocked(wfRun.execute({ templateId: 'dev-workflow-2-0', taskId: 'issue-hd', entry: 'accept', approved: true }), eng, startsBefore, '残留 entry 协议不得接管 WAITING_HUMAN')
  const p2 = wfRun.execute({ templateId: 'dev-workflow-2-0', taskId: 'issue-hd', decision_id: 'issue-hd:work:0', user_choice: 'STOP' })
  await until(() => eng.starts.length >= 2, 'decision_id 续跑绕过互斥')
  events.get('workflow/start')({ id: 'run-2', meta: { name: 'x' } })
  const parked = await call(handlers, 'vwf.state', { runId: 'run-1' })
  assert.equal(parked.state.supersededBy, 'run-2')
  assert.equal(parked.state.control_event.user_choice, null, '挂起请求事件保持追加-only，选择不得回写覆盖')
  settleRun(eng, events, 'run-2', 'STOPPED')
  await p2
})

test('#120 新蓝图续跑拒绝 approved；残留门禁占用行为不变', async () => {
  const eng = makeEngine()
  const { handlers, events, definedTools } = engineEnv(eng)
  const wfRun = definedTools.find((t) => t.name === 'wf_run')
  const rejected = await wfRun.execute({ dsl: hdDsl(), taskId: 'issue-new', approved: true })
  assert.ok(String(rejected).includes('禁止 approved'), rejected)
  assert.equal(eng.starts.length, 0, '拒绝 approved 不得启动引擎')

  const p1 = wfRun.execute({ templateId: 'dev-workflow-2-0', taskId: 'issue-left' })
  await until(() => eng.starts.length >= 1, '残留启动')
  events.get('workflow/start')({ id: 'run-1', meta: { name: 'x' } })
  settleRun(eng, events, 'run-1', 'AWAITING_HUMAN_accept')
  await p1
  const blocked = await wfRun.execute({ templateId: 'dev-workflow-2-0', taskId: 'issue-left' })
  assert.ok(blocked.includes('串行互斥'), blocked)
  const p2 = wfRun.execute({ templateId: 'dev-workflow-2-0', taskId: 'issue-left', entry: 'accept', approved: true })
  await until(() => eng.starts.length >= 2, '残留 entry 续跑仍放行')
  events.get('workflow/start')({ id: 'run-2', meta: { name: 'x' } })
  const s1 = await call(handlers, 'vwf.state', { runId: 'run-1' })
  assert.equal(s1.state.supersededBy, 'run-2')
  settleRun(eng, events, 'run-2', 'DONE')
  await p2
})

test('#128 业务结果投影往返：outcome / countRound / completionPath 经 validate/save/list 无损', async () => {
  const { handlers, fs } = env()
  const dsl = outcomeDsl()
  const v = await call(handlers, 'vwf.validate', { dsl })
  assert.equal(v.ok, true, JSON.stringify(v.errors))
  const saved = await call(handlers, 'vwf.workflows.save', { dsl })
  assert.equal(saved.ok, true, JSON.stringify(saved.errors))
  const bp = JSON.parse(fs._files.get(USER_DIR + '/outcome-evaluate-mini.json'))
  const opt = bp.edges.find((e) => e.outcome === 'OPTIMIZE')
  assert.equal(opt.countRound, true)
  assert.equal(Object.prototype.hasOwnProperty.call(opt, 'on'), false)
  const ev = bp.nodes.find((n) => n.id === 'evaluate')
  assert.equal(ev.output.outcomePath, '$.verdict')
  assert.equal(ev.output.completionPath, '$.completion_type')
  const listed = (await call(handlers, 'vwf.workflows.list')).find((item) => item.id === 'outcome-evaluate-mini')
  const listedOpt = listed.dsl.edges.find((e) => e.outcome === 'OPTIMIZE')
  assert.equal(listedOpt.countRound, true)
  assert.equal(Object.prototype.hasOwnProperty.call(listedOpt, 'on'), false)
  assert.equal(listed.dsl.nodes.find((n) => n.id === 'evaluate').output.completionPath, '$.completion_type')
})

test('#128 ROUTE_HALTED / ENDED_NO_OUTCOME_EDGE 回写为权威终态且释放占用', async () => {
  const eng = makeEngine()
  const { handlers, events, definedTools } = engineEnv(eng)
  const wfRun = definedTools.find((t) => t.name === 'wf_run')
  const p1 = wfRun.execute({ templateId: 'dev-workflow-2-0', taskId: 'issue-rh' })
  await until(() => eng.starts.length >= 1, 'ROUTE_HALTED 启动')
  events.get('workflow/start')({ id: 'run-1', meta: { name: 'x' } })
  settleRun(eng, events, 'run-1', 'ROUTE_HALTED', { reason: 'HUMAN_DECISION', node: 'evaluate' })
  await p1
  const s1 = await call(handlers, 'vwf.state', { runId: 'run-1' })
  assert.equal(s1.state.status, 'ROUTE_HALTED', 'value.status 回写覆盖事件层 completed')
  const p2 = wfRun.execute({ templateId: 'dev-workflow-2-0', taskId: 'issue-rh' })
  await until(() => eng.starts.length >= 2, 'ROUTE_HALTED 后同 taskId 可再启动')
  events.get('workflow/start')({ id: 'run-2', meta: { name: 'x' } })
  settleRun(eng, events, 'run-2', 'ENDED_NO_OUTCOME_EDGE')
  await p2
  const s2 = await call(handlers, 'vwf.state', { runId: 'run-2' })
  assert.equal(s2.state.status, 'ENDED_NO_OUTCOME_EDGE')
})

// A3-2（Codex Round 2）：workspace RPC 必须携带宿主登记的不可伪造 capability——
// 未登记 Run、capability 缺失/不匹配一律拒绝，防止猜测 taskId 跨 Run 越权。
// 测试环境无 workspace-isolation-host.mjs（未部署集成），workspaceCaps 初始为空
// （wf_run 走 notFound 降级不登记），因此任何 workspace RPC 都必须被拒。
test('#93 A3-2：未登记 capability 的 workspace RPC 一律拒绝（越权防护）', async () => {
  const eng = makeEngine()
  const { handlers } = engineEnv(eng)

  const writeSource = handlers.get('vwf.workspace.writeSource')
  assert.ok(writeSource, 'vwf.workspace.writeSource RPC 已注册')
  // 未登记 Run：任何 capability 都不匹配
  const r1 = await writeSource({ logical_run_id: 'cap-run', rel: 'x.txt', content: 'x', capability: 'cap-fake' })
  assert.equal(r1.ok, false)
  assert.ok(String(r1.error).includes('capability'), '未登记 Run 应拒绝：' + JSON.stringify(r1))
  const r2 = await writeSource({ logical_run_id: 'cap-run', rel: 'x.txt', content: 'x' })
  assert.equal(r2.ok, false)
  assert.ok(String(r2.error).includes('capability'), '缺 capability 应拒绝')
  // 完全未登记的 taskId 同样拒绝
  const r3 = await writeSource({ logical_run_id: 'other-run', rel: 'x.txt', content: 'x', capability: 'cap-anything' })
  assert.equal(r3.ok, false)
  assert.ok(String(r3.error).includes('capability'), '未登记 taskId 应拒绝')
  // 读、锁、provenance 等其他 RPC 同样拒绝
  const readSource = handlers.get('vwf.workspace.readSource')
  const r4 = await readSource({ logical_run_id: 'cap-run', rel: 'x.txt', capability: 'cap-fake' })
  assert.equal(r4.ok, false)
  const acquireLock = handlers.get('vwf.workspace.acquireLock')
  const r5 = await acquireLock({ logical_run_id: 'cap-run', resource_key: 'k', owner: 'o', capability: 'cap-fake' })
  assert.equal(r5.ok, false)
  const buildProv = handlers.get('vwf.workspace.buildProvenance')
  const r6 = await buildProv({ logical_run_id: 'cap-run', node: 'dev', attempt: 1, capability: 'cap-fake' })
  assert.equal(r6.ok, false)
})

test('#69 Codex P1：正式安装仅从插件 dist/formal-artifacts.cjs 加载内核', async () => {
  const formalArtifactsSrc = readFileSync(join(here, '..', '..', '..', 'scripts', 'formal-artifacts.cjs'), 'utf8')
  const PLUGIN = '/plugin/pkg'
  const fs = seedFs({
    [PLUGIN + '/dist/formal-artifacts.cjs']: formalArtifactsSrc,
  })
  const { handlers, events } = loadHost({ fs, pluginRoot: PLUGIN })
  events.get('workflow/start')({ id: 'run-art', meta: { name: 'artifact-test' } })
  const res = await call(handlers, 'vwf.artifacts.ingest', {
    runId: 'run-art',
    nodeId: 'writer',
    artifacts: [{ path: 'out/data.json', kind: 'json', content: '{"n":1}' }],
  })
  assert.equal(res.ok, true, res.errors && res.errors[0] && res.errors[0].message)
  assert.equal(res.produced, 1)
  assert.equal(res.formalRecords.length, 1)
  assert.equal(res.formalRecords[0].body.value.n, 1)
})

test('#69 Codex P2：vwf.artifacts.ingest 拒绝 JSON 类缺 content', async () => {
  const formalArtifactsSrc = readFileSync(join(here, '..', '..', '..', 'scripts', 'formal-artifacts.cjs'), 'utf8')
  const fs = seedFs({ [REPO + '/scripts/formal-artifacts.cjs']: formalArtifactsSrc })
  const { handlers, events } = loadHost({ fs })
  events.get('workflow/start')({ id: 'run-bad', meta: {} })
  const res = await call(handlers, 'vwf.artifacts.ingest', {
    runId: 'run-bad',
    nodeId: 'writer',
    artifacts: [{ path: 'bad.json', kind: 'json' }],
  })
  assert.equal(res.ok, false)
  assert.match(res.errors[0].message, /必填/)
})

test('#93 A3-2：vwf_workspace dtool 已注册，未登记 capability 仍拒绝', async () => {
  const eng = makeEngine()
  const { definedTools } = engineEnv(eng)
  const wsTool = definedTools.find((t) => t.name === 'vwf_workspace')
  assert.ok(wsTool, 'vwf_workspace 已注册为节点可调用 dtool')
  const raw = await wsTool.execute({ op: 'writeSource', logical_run_id: 'cap-run', rel: 'x.txt', content: 'x', capability: 'cap-fake' })
  const parsed = JSON.parse(raw)
  assert.equal(parsed.ok, false)
  assert.ok(String(parsed.error).includes('capability'), parsed.error)
})

test('#93 正式路径：vwf.script 未部署包装脚本时 allocate 不阻断编译', async () => {
  const { handlers } = env()
  const s = await call(handlers, 'vwf.script', { dsl: baseDsl(), allocate: true, taskId: 'issue-script' })
  assert.equal(s.ok, true, JSON.stringify(s.errors))
  assert.equal(s.workspaceArgs, null)
})

test('粘贴蓝图 JSON：displayName / bindings.models 摄入 DSL，回退 outcome 不吞入口', async () => {
  const { handlers, fs } = env()
  const bp = JSON.parse(readFileSync(join(here, '..', '..', '..', 'scripts', 'test', 'fixtures', 'construction-rollback-mini.json'), 'utf8'))
  const v = await call(handlers, 'vwf.validate', { dsl: bp })
  assert.equal(v.ok, true, JSON.stringify(v.errors))
  assert.equal(v.sanitized.name, '完整功能开发', 'displayName 投影为模板名称')
  assert.equal(v.sanitized.entry, 'requirements', '唯一入口仍是 requirements')
  assert.equal(v.sanitized.nodes.find((n) => n.id === 'requirements').model.provider, 'kimi-coding')
  assert.equal(v.sanitized.nodes.find((n) => n.id === 'dev').model.model, 'deepseek-v4-pro')
  const saved = await call(handlers, 'vwf.workflows.save', { dsl: bp })
  assert.equal(saved.ok, true, JSON.stringify(saved.errors))
  const disk = JSON.parse(fs._files.get(USER_DIR + '/construction-rollback-mini.json'))
  assert.equal(disk.displayName, '完整功能开发')
  assert.equal(disk.nodes.find((n) => n.id === 'review').verifyBranch, true, 'verifyBranch 保存往返')
  assert.equal(disk.bindings.models.requirements.provider, 'kimi-coding')
})

test('角色库 core 加载：动态模式优先 repo 最新成对资产，不被 home 旧清单覆盖', async () => {
  const seed = { ...ROLE_CORE_SEED }
  const homeManifestPath = DSH_HOME + '/visual-workflow/builtin-roles.json'
  const stale = JSON.parse(seed[homeManifestPath])
  stale.builtins.find((r) => r.id === 'dev').name = 'HOME 旧开发名'
  seed[homeManifestPath] = JSON.stringify(stale)
  // repo 候选保持当前 manifest（dev.name = 开发）
  const fs = makeFs(seed)
  const sub = makeSubprocess({ fs })
  const { handlers } = loadHost({ fs, subprocess: sub, sandboxPolicy })
  const r = await call(handlers, 'vwf.roles')
  assert.equal(r.roles.find((x) => x.id === 'dev').name, '开发', '动态模式必须优先 repo 当前清单')
})

test('#93 DSH_HOME：明确 process.env.DSH_HOME 直接优先，不能被成功 probe fallback 覆盖', async () => {
  const injected = '/tmp/vwf-explicit-dev-home'
  const processValue = { env: { DSH_HOME: injected, HOME: '/tmp' }, cwd: () => REPO }
  const { definedTools, sub } = env({ extra: { processValue, agents: { currentInitiator: () => null, requireInitiator: () => ({}) } } })
  const debug = definedTools.find((t) => t.name === 'vwf_debug')
  assert.ok(debug, 'agents 存在时应注册 vwf_debug')
  const paths = JSON.parse(await debug.execute({ op: 'paths' }))
  assert.equal(paths.dshHome, injected, '明确注入的 DSH_HOME 必须直接胜出')
  const probe = sub._calls.find((c) => c.join(' ').includes('process.env.DSH_HOME') && c.join(' ').includes('.homedir'))
  assert.equal(probe, undefined, '明确 DSH_HOME 存在时不应再执行可能回落产品 ~/.dsh 的 probe')
})

