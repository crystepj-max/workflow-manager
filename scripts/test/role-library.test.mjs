// 角色库内核（scripts/role-library.cjs）直测
// seam = 模块接口（createRoleLibrary().execute / buildSnapshot），不穿 Host/RPC/fs。
// 期望值来源 = 线上 host.js 角色 RPC 的既有行为（characterization）+ 产品规格 §8。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import roleLibrary from '../role-library.cjs'

const { createRoleLibrary, validateManifest, buildSnapshot, readRoleFileSafe, collectReferencedRoleFiles } = roleLibrary

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')
const manifest = JSON.parse(readFileSync(join(repoRoot, 'dsh', 'roles', 'builtin-roles.json'), 'utf8'))

function lib() {
  return createRoleLibrary(manifest)
}

// 目录事实构造器
function catalog({ workspace = [], bundled = [], state = 'ok', message = '' } = {}) {
  return { state, message, workspace, bundled }
}

// ── manifest 校验（loud-fail）────────────────────────────────────────────
test('validateManifest：合法清单通过', () => {
  assert.equal(validateManifest(manifest).schemaVersion, 1)
})

test('validateManifest：非法清单一律抛错（fail-closed）', () => {
  assert.throws(() => validateManifest(null), /不是对象/)
  assert.throws(() => validateManifest({}), /builtins/)
  assert.throws(() => validateManifest({ schemaVersion: 2, builtins: manifest.builtins }), /schemaVersion/)
  assert.throws(() => validateManifest({ schemaVersion: 1, builtins: [] }), /为空/)
  const bad = JSON.parse(JSON.stringify(manifest))
  bad.builtins[0].id = 'BAD ID'
  assert.throws(() => validateManifest(bad), /非法 id/)
  const dup = JSON.parse(JSON.stringify(manifest))
  dup.builtins.push({ ...dup.builtins[0] })
  assert.throws(() => validateManifest(dup), /冲突/)
  const noName = JSON.parse(JSON.stringify(manifest))
  noName.builtins[1].name = '  '
  assert.throws(() => validateManifest(noName), /中文名为空/)
  const badDef = JSON.parse(JSON.stringify(manifest))
  badDef.builtins[2].definition = '../escape.md'
  assert.throws(() => validateManifest(badDef), /definition/)
  const dpIn = JSON.parse(JSON.stringify(manifest))
  dpIn.builtins.push({ id: 'dispatcher', name: 'x', summary: 'y', definition: 'dsh/roles/dispatcher.md', builtin: true, readonly: true })
  assert.throws(() => validateManifest(dpIn), /dispatcher 不得为内置/)
})

// ── list ─────────────────────────────────────────────────────────────────
test('list：无目录事实时 12 内置常驻、按清单顺序、带 manifest 摘要', async () => {
  const r = await lib().execute({ operation: 'list', facts: { catalog: catalog({ state: 'missing' }) } })
  assert.equal(r.ok, true)
  assert.equal(r.roles.length, 12)
  assert.deepEqual(r.roles.map((x) => x.id), manifest.builtins.map((b) => b.id))
  assert.ok(r.roles.every((x) => x.builtin === true))
  assert.equal(r.roles.find((x) => x.id === 'dev').summary, manifest.builtins.find((b) => b.id === 'dev').summary)
})

test('list：内置在前、工作区自定义按 id 序居中、打包回退排最后且不重复', async () => {
  const facts = {
    catalog: catalog({
      workspace: [
        { id: 'zzz-custom', content: 'z 摘要\nz 正文' },
        { id: 'dev', content: '工作区旧 dev 摘要\n工作区旧正文' }, // 与内置同 id → 不进入自定义分组
        { id: 'aaa-custom', content: 'a 摘要\na 正文' },
      ],
      bundled: [{ id: 'dispatcher', content: '调度首行\n其余' }],
    }),
  }
  const r = await lib().execute({ operation: 'list', facts })
  const ids = r.roles.map((x) => x.id)
  assert.equal(ids.indexOf('aaa-custom') < ids.indexOf('zzz-custom'), true, '自定义按 id 升序')
  assert.equal(ids.filter((x) => x === 'dev').length, 1, '内置 id 不重复出现在自定义分组')
  assert.equal(ids.indexOf('dispatcher'), ids.length - 1, '打包回退排最后')
  const dp = r.roles[r.roles.length - 1]
  assert.equal(dp.builtin, false)
  assert.equal(dp.summary, '调度首行', '打包回退摘要取首个非空行')
  // 内置摘要：无快照时从工作区文件正文计算（dev 有工作区文件）
  assert.equal(r.roles.find((x) => x.id === 'dev').summary, '工作区旧 dev 摘要')
})

test('list：内置摘要优先取打包快照（与工作区旧文件脱钩）', async () => {
  const facts = {
    catalog: catalog({ workspace: [{ id: 'dev', content: '工作区旧摘要\n旧正文' }] }),
    builtinBodies: { dev: '打包快照首行\n\n正文' },
  }
  const r = await lib().execute({ operation: 'list', facts })
  assert.equal(r.roles.find((x) => x.id === 'dev').summary, '打包快照首行')
})

// ── get ──────────────────────────────────────────────────────────────────
test('get：内置详情来源优先级 快照 > 工作区 > 占位', async () => {
  const l = lib()
  // 占位兜底
  let r = await l.execute({ operation: 'get', id: 'dev', facts: { catalog: catalog({ state: 'missing' }) } })
  assert.equal(r.ok, true)
  assert.match(r.role.content, /当前工作区未包含该内置角色的完整定义/)
  assert.equal(r.role.name, '开发')
  // 工作区回退
  r = await l.execute({ operation: 'get', id: 'dev', facts: { catalog: catalog({ workspace: [{ id: 'dev', summary: '', content: '工作区正文\n' }] }) } })
  assert.equal(r.role.content, '工作区正文\n')
  // 快照优先
  r = await l.execute({
    operation: 'get', id: 'dev',
    facts: { catalog: catalog({ workspace: [{ id: 'dev', summary: '', content: '工作区正文\n' }] }), builtinBodies: { dev: '打包快照正文\n' } },
  })
  assert.equal(r.role.content, '打包快照正文\n')
})

test('get：自定义读工作区；打包回退只读可见；未知 id 报「角色不存在」', async () => {
  const l = lib()
  let r = await l.execute({ operation: 'get', id: 'my-role', facts: { catalog: catalog({ workspace: [{ id: 'my-role', content: 'c\n' }] }) } })
  assert.deepEqual({ id: r.role.id, builtin: r.role.builtin, content: r.role.content }, { id: 'my-role', builtin: false, content: 'c\n' })
  r = await l.execute({ operation: 'get', id: 'dispatcher', facts: { catalog: catalog({ bundled: [{ id: 'dispatcher', content: '调度正文\n' }] }) } })
  assert.equal(r.role.builtin, false)
  assert.equal(r.role.content, '调度正文\n')
  r = await l.execute({ operation: 'get', id: 'ghost', facts: { catalog: catalog() } })
  assert.equal(r.ok, false)
  assert.match(r.errors[0].message, /角色不存在：ghost/)
})

// ── usage ────────────────────────────────────────────────────────────────
function wf(id, name, builtin, profiles) {
  return { workflowId: id, workflowName: name, builtin, nodes: profiles.map((p, i) => ({ id: 'n' + i, label: 'N' + i, profile: p })) }
}

test('usage：跨内置+用户模板统计；profile 大小写/规范化不敏感', async () => {
  const facts = {
    workflows: {
      state: 'ok',
      records: [
        wf('builtin-wf', '内置流', true, ['dev', 'review']),
        wf('user-wf', '用户流', false, ['Dev', 'dev']),
      ],
    },
  }
  const r = await lib().execute({ operation: 'usage', id: 'dev', facts })
  assert.equal(r.ok, true)
  assert.equal(r.count, 3, '大小写不敏感匹配：dev + Dev + dev')
  assert.equal(r.refs.length, 2)
  assert.equal(r.refs[0].builtin, true)
})

test('usage：草稿取代同 id 持久化版本；无 id 草稿独立计入；失败 fail-closed', async () => {
  const l = lib()
  // 草稿移除全部引用 → 持久化版本被取代（零引用）
  let r = await l.execute({
    operation: 'usage', id: 'dev',
    facts: {
      workflows: {
        state: 'ok',
        records: [wf('wf-a', 'A', false, ['dev'])],
        draft: { id: 'wf-a', name: 'A', nodes: [{ id: 'n0', label: 'N0', profile: 'review' }] },
      },
    },
  })
  assert.equal(r.count, 0, '草稿无引用时持久化引用被取代')
  // 无 id 草稿独立计入
  r = await l.execute({
    operation: 'usage', id: 'dev',
    facts: {
      workflows: {
        state: 'ok',
        records: [],
        draft: { name: '未命名', nodes: [{ id: 'n0', label: 'N0', profile: 'dev' }] },
      },
    },
  })
  assert.equal(r.count, 1)
  assert.equal(r.refs[0].draft, true)
  // 事实读取失败 fail-closed
  r = await l.execute({ operation: 'usage', id: 'dev', facts: { workflows: { state: 'error', message: '模板读取失败' } } })
  assert.equal(r.ok, false)
  assert.match(r.errors[0].message, /引用统计失败：模板读取失败/)
})

// ── validateName ─────────────────────────────────────────────────────────
test('validateName：完整规则集（含首尾点与 Windows 保留名）+ 唯一性', async () => {
  const l = lib()
  const facts = { catalog: catalog({ workspace: [{ id: 'taken', content: 'x' }], bundled: [{ id: 'dispatcher', content: 'x' }] }) }
  const bad = async (name, re) => {
    const r = await l.execute({ operation: 'validateName', name, facts })
    assert.equal(r.ok, false, `应拒绝：${JSON.stringify(name)}`)
    assert.match(r.errors[0].message, re)
    assert.equal(r.errors[0].at, 'name')
  }
  await bad('', /不能为空/)
  await bad('a'.repeat(65), /最多 64/)
  await bad('a/b', /非法字符/)
  await bad('.foo', /以点开头或结尾/)
  await bad('foo.', /以点开头或结尾/)
  await bad('CON', /系统保留名/)
  await bad('com1', /系统保留名/)
  await bad('dev', /已存在同名角色/)
  await bad('Taken', /已存在同名角色/)       // 大小写不敏感
  await bad('dispatcher', /已存在同名角色/)  // 打包回退角色计入唯一性
  const ok = await l.execute({ operation: 'validateName', name: '新角色', facts })
  assert.equal(ok.ok, true)
  // excludeId 排除自身（重命名场景）
  const self = await l.execute({ operation: 'validateName', name: 'taken', excludeId: 'taken', facts })
  assert.equal(self.ok, true)
})

// ── change / create ──────────────────────────────────────────────────────
test('change create：能力/名称/内容/唯一性检查顺序与线上一致，成功产出 write 意图', async () => {
  const l = lib()
  const facts = (c) => ({ capabilities: { fs: true, subprocess: true }, catalog: c || catalog() })
  // 无 fs 能力
  let r = await l.execute({ operation: 'change', action: 'create', name: 'x', content: 'y', facts: { capabilities: { fs: false } } })
  assert.match(r.errors[0].message, /宿主文件能力不可用：无法创建角色/)
  // 名称先于内容
  r = await l.execute({ operation: 'change', action: 'create', name: 'a/b', content: '', facts: facts() })
  assert.equal(r.errors[0].at, 'name')
  assert.match(r.errors[0].message, /非法字符/)
  // 内容为空
  r = await l.execute({ operation: 'change', action: 'create', name: 'x', content: '  ', facts: facts() })
  assert.match(r.errors[0].message, /角色配置不能为空/)
  // 目录读取失败 fail-closed
  r = await l.execute({ operation: 'change', action: 'create', name: 'x', content: 'y', facts: facts(catalog({ state: 'error', message: 'IO 故障' })) })
  assert.match(r.errors[0].message, /角色库读取失败，无法验证名称唯一性：IO 故障/)
  // 重名
  r = await l.execute({ operation: 'change', action: 'create', name: 'dev', content: 'y', facts: facts() })
  assert.match(r.errors[0].message, /已存在同名角色/)
  // 成功：尾部补换行
  r = await l.execute({ operation: 'change', action: 'create', name: '新角色', content: '正文', facts: facts() })
  assert.equal(r.ok, true)
  assert.deepEqual(r.effect, { kind: 'write', id: '新角色', content: '正文\n' })
})

// ── change / update ──────────────────────────────────────────────────────
test('change update：只读/存在性/重命名保护顺序与线上一致', async () => {
  const l = lib()
  const ws = catalog({ workspace: [{ id: 'my-role', summary: '', content: '旧\n' }] })
  const caps = { fs: true, subprocess: true }
  const noUsage = { state: 'ok', records: [] }
  // 内置只读
  let r = await l.execute({ operation: 'change', action: 'update', id: 'dev', name: 'dev', content: 'x', facts: { capabilities: caps, catalog: ws, workflows: noUsage } })
  assert.match(r.errors[0].message, /内置角色只读/)
  // 目录错误 fail-closed
  r = await l.execute({ operation: 'change', action: 'update', id: 'my-role', name: 'my-role', content: 'x', facts: { capabilities: caps, catalog: catalog({ state: 'error', message: 'IO' }), workflows: noUsage } })
  assert.match(r.errors[0].message, /角色库读取失败：IO/)
  // 不存在（既不在工作区也不在打包回退）
  r = await l.execute({ operation: 'change', action: 'update', id: 'ghost', name: 'ghost', content: 'x', facts: { capabilities: caps, catalog: ws, workflows: noUsage } })
  assert.match(r.errors[0].message, /自定义角色不存在：ghost/)
  // 打包回退角色可编辑（种子到工作区）
  r = await l.execute({ operation: 'change', action: 'update', id: 'dispatcher', name: 'dispatcher', content: '新内容', facts: { capabilities: caps, catalog: catalog({ bundled: [{ id: 'dispatcher', content: '旧\n' }] }), workflows: noUsage } })
  assert.equal(r.ok, true)
  assert.deepEqual(r.effect, { kind: 'write', id: 'dispatcher', content: '新内容\n' })
  // 仅写法差异重命名拒绝
  r = await l.execute({ operation: 'change', action: 'update', id: 'my-role', name: 'My-Role', content: 'x', facts: { capabilities: caps, catalog: ws, workflows: noUsage } })
  assert.match(r.errors[0].message, /仅大小写或写法不同/)
  // 重命名有引用阻止
  const usedWf = { state: 'ok', records: [wf('wf-a', 'A', false, ['my-role'])] }
  r = await l.execute({ operation: 'change', action: 'update', id: 'my-role', name: 'new-role', content: 'x', facts: { capabilities: caps, catalog: ws, workflows: usedWf } })
  assert.equal(r.errors[0].at, 'name')
  assert.match(r.errors[0].message, /重命名会导致这些引用全部失效/)
  // 重命名需 subprocess
  r = await l.execute({ operation: 'change', action: 'update', id: 'my-role', name: 'new-role', content: 'x', facts: { capabilities: { fs: true, subprocess: false }, catalog: ws, workflows: noUsage } })
  assert.match(r.errors[0].message, /重命名需要子进程服务/)
  // 纯内容编辑无需 subprocess、无需 usage 事实
  r = await l.execute({ operation: 'change', action: 'update', id: 'my-role', name: 'my-role', content: '新正文', facts: { capabilities: { fs: true, subprocess: false }, catalog: ws } })
  assert.equal(r.ok, true)
  assert.deepEqual(r.effect, { kind: 'write', id: 'my-role', content: '新正文\n' })
  // 零引用重命名产出 rename 意图
  r = await l.execute({ operation: 'change', action: 'update', id: 'my-role', name: 'new-role', content: '新正文', facts: { capabilities: caps, catalog: ws, workflows: noUsage } })
  assert.deepEqual(r.effect, { kind: 'rename', from: 'my-role', to: 'new-role', content: '新正文\n' })
})

// ── change / remove ──────────────────────────────────────────────────────
test('change remove：只读/引用阻止（含草稿提示）/打包回退不可删/成功意图', async () => {
  const l = lib()
  const caps = { fs: true, subprocess: true }
  const ws = catalog({ workspace: [{ id: 'my-role', summary: '', content: 'x' }] })
  // 能力缺失
  let r = await l.execute({ operation: 'change', action: 'remove', id: 'my-role', facts: { capabilities: { fs: true, subprocess: false }, catalog: ws, workflows: { state: 'ok', records: [] } } })
  assert.match(r.errors[0].message, /宿主文件能力不可用：无法删除角色/)
  // 内置只读
  r = await l.execute({ operation: 'change', action: 'remove', id: 'dev', facts: { capabilities: caps, catalog: ws, workflows: { state: 'ok', records: [] } } })
  assert.match(r.errors[0].message, /内置角色只读/)
  // 引用统计失败 fail-closed（文案带「已阻止删除」）
  r = await l.execute({ operation: 'change', action: 'remove', id: 'my-role', facts: { capabilities: caps, catalog: ws, workflows: { state: 'error', message: 'IO' } } })
  assert.match(r.errors[0].message, /引用统计失败，已阻止删除：IO/)
  // 有引用阻止并携带 usage（草稿加提示）
  r = await l.execute({
    operation: 'change', action: 'remove', id: 'my-role',
    facts: {
      capabilities: caps, catalog: ws,
      workflows: { state: 'ok', records: [wf('wf-a', 'A', false, ['my-role'])], draft: { name: '草稿', nodes: [{ id: 'n0', label: 'N0', profile: 'my-role' }] } },
    },
  })
  assert.equal(r.ok, false)
  assert.match(r.errors[0].message, /仍被 2 个节点使用（含未保存草稿的引用）/)
  assert.equal(r.usage.count, 2)
  // 打包回退角色不可删除
  r = await l.execute({ operation: 'change', action: 'remove', id: 'dispatcher', facts: { capabilities: caps, catalog: catalog({ bundled: [{ id: 'dispatcher', content: 'x' }] }), workflows: { state: 'ok', records: [] } } })
  assert.match(r.errors[0].message, /定义来自内置模板自带的角色包/)
  // 不存在
  r = await l.execute({ operation: 'change', action: 'remove', id: 'ghost', facts: { capabilities: caps, catalog: ws, workflows: { state: 'ok', records: [] } } })
  assert.match(r.errors[0].message, /自定义角色不存在：ghost/)
  // 成功
  r = await l.execute({ operation: 'change', action: 'remove', id: 'my-role', facts: { capabilities: caps, catalog: ws, workflows: { state: 'ok', records: [] } } })
  assert.deepEqual(r.effect, { kind: 'remove', id: 'my-role' })
})

test('execute：未知操作 fail-closed', async () => {
  const r = await lib().execute({ operation: 'nope', facts: {} })
  assert.equal(r.ok, false)
  assert.match(r.errors[0].message, /未知角色库操作/)
})

// ── 构建期投影（生成器同步入口）────────────────────────────────────────────
test('buildSnapshot：清单 + 内置角色正文同步读取；非法路径注入被拒绝', () => {
  const files = new Map()
  files.set(join(repoRoot, 'dsh', 'roles', 'builtin-roles.json'), JSON.stringify(manifest))
  for (const b of manifest.builtins) files.set(join(repoRoot, 'dsh', 'roles', b.id + '.md'), '# ' + b.name + '\n正文')
  const io = { readFileSync: (p) => { if (!files.has(p)) { const e = new Error('ENOENT'); throw e } return files.get(p) } }
  const snap = buildSnapshot({ manifestPath: join(repoRoot, 'dsh', 'roles', 'builtin-roles.json'), rolesDir: join(repoRoot, 'dsh', 'roles'), io })
  assert.deepEqual(snap.builtinIds, manifest.builtins.map((b) => b.id))
  assert.equal(snap.roleDefs.dev, '# 开发\n正文')
  assert.equal(Object.keys(snap.roleDefs).length, 12)
})

test('readRoleFileSafe：路径穿越返回 null，不读目录外文件', () => {
  const io = { readFileSync: () => { throw new Error('不应被读取') } }
  assert.equal(readRoleFileSafe('/roles', '../../etc/passwd', io), null)
  assert.equal(readRoleFileSafe('/roles', 'bad id!', io), null)
})

test('collectReferencedRoleFiles：打包被引用且文件存在的角色（含自定义 dispatcher）', () => {
  const io = { readFileSync: (p) => (p.endsWith('dispatcher.md') ? '调度正文' : (p.endsWith('dev.md') ? '开发正文' : (() => { throw new Error('ENOENT') })())) }
  const bp = { nodes: [{ profile: 'dev' }, { profile: 'dispatcher' }, { profile: 'ghost' }] }
  const out = collectReferencedRoleFiles(bp, '/roles', io)
  assert.deepEqual(Array.from(out.keys()).sort(), ['roles/dev.md', 'roles/dispatcher.md'])
  assert.equal(out.get('roles/dispatcher.md'), '调度正文', '自定义角色随 skill 自包含（不得过滤为仅内置）')
})
