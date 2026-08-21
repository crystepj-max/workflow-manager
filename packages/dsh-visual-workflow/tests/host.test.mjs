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
import { loadHost } from './helpers/load-host.mjs'
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

test('AC-2：内置模板从 .generated/ 目录加载（host.js 无硬编码模板）', async () => {
  const { handlers, sub } = env()
  const list = await call(handlers, 'vwf.workflows.list')
  const builtin = list.find(w => w.id === 'dev-workflow-2-0')
  assert.ok(builtin, '列表包含内置模板')
  assert.equal(builtin.builtin, true)
  const v = await call(handlers, 'vwf.validate', { dsl: builtin.dsl })
  assert.equal(v.ok, true, JSON.stringify(v.errors))
  // T-IMP-12：vwf.compile 已删除；vwf.script 走统一编译器管道（CLI compile）
  const s = await call(handlers, 'vwf.script', { dsl: builtin.dsl })
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
  const builtin = list.find(w => w.id === 'dev-workflow-2-0')
  assert.ok(builtin && builtin.builtin === true, '内置模板从会话 cwd 的 .generated/ 加载')
  assert.equal(builtin.name, '开发工作流 2.0')
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
  assert.ok(list.some(w => w.id === 'dev-workflow-2-0' && w.builtin === true), '实时 initiator 生效')
  // initiator 再次消失（客户端 RPC）：knownCwd 兜底仍能解析
  initiator = null
  list = await call(handlers, 'vwf.workflows.list')
  assert.ok(list.some(w => w.id === 'dev-workflow-2-0' && w.builtin === true), 'knownCwd 历史兜底生效')
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

test('撞名：内置只读 / 同名用户拒绝提示改名 / currentId 更新自身允许', async () => {
  const { handlers } = env()
  await call(handlers, 'vwf.workflows.save', { dsl: baseDsl() })
  // 内置只读
  const toBuiltin = await call(handlers, 'vwf.workflows.save', { dsl: baseDsl({ id: 'dev-workflow-2-0', name: '开发工作流 2.0' }) })
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

test('remove：仅用户模板可删（蓝图+skill 同步删）；内置/不存在拒绝', async () => {
  const { handlers, fs, sub } = env()
  await call(handlers, 'vwf.workflows.save', { dsl: baseDsl() })
  const rmBuiltin = await call(handlers, 'vwf.workflows.remove', { id: 'dev-workflow-2-0' })
  assert.equal(rmBuiltin.ok, false)
  assert.ok(rmBuiltin.errors.some(e => e.message.includes('内置模板只读')))
  const rmMissing = await call(handlers, 'vwf.workflows.remove', { id: 'nope' })
  assert.equal(rmMissing.ok, false)
  assert.ok(rmMissing.errors.some(e => e.message.includes('不存在')))
  const ok = await call(handlers, 'vwf.workflows.remove', { id: 't1' })
  assert.equal(ok.ok, true)
  assert.ok(!fs._files.has(USER_DIR + '/t1.json'), '蓝图已删')
  const rmCalls = sub._calls.filter(c => c.join(' ').includes('rmSync')).map(c => c.join(' '))
  assert.ok(rmCalls.some(s => s.includes(USER_DIR + '/t1.json')), '蓝图 rm 调用')
  assert.ok(rmCalls.some(s => s.includes(SKILL_ROOT + '/t1')), 'skill 目录 rm 调用')
  // 所有子进程 spawn 必须移除宿主注入的 NODE_OPTIONS（WorkBuddy safe-delete 钩子拦截 rmSync）
  const rmSpecs = sub._specs.filter(s => s.argv.join(' ').includes('rmSync'))
  assert.ok(rmSpecs.length >= 1, 'rmSync spawn 调用存在')
  assert.ok(rmSpecs.every(s => s.env && s.env.NODE_OPTIONS === undefined), 'NODE_OPTIONS 已移除（tombstone）')
  const list = await call(handlers, 'vwf.workflows.list')
  assert.ok(!list.some(w => w.id === 't1'))
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

test('模板名称必填（name 为空拒绝，save 同拒）', async () => {
  const { handlers } = env()
  const v = await call(handlers, 'vwf.validate', { dsl: baseDsl({ name: '  ' }) })
  assert.equal(v.ok, false)
  assert.ok(v.errors.some(e => e.message.includes('displayName')), JSON.stringify(v.errors))
  const s = await call(handlers, 'vwf.workflows.save', { dsl: baseDsl({ name: '' }) })
  assert.equal(s.ok, false, 'save 拒绝空名称')
})

test('vwf.roles 无 fs 服务时回退内置六角色', async () => {
  const { handlers } = loadHost()
  const r = await call(handlers, 'vwf.roles')
  assert.ok(Array.isArray(r.roles))
  assert.ok(r.roles.some(x => x.id === 'dispatcher'))
  assert.ok(r.roles.some(x => x.id === 'closeout'))
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
