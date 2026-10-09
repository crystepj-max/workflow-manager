// LOC-041 节点隔离验收：AC-01~04 与 UAT-01~04 的可执行替身证据
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, symlinkSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import {
  ISOLATION_GUARANTEE, NODE_ROLE_CAPABILITIES,
  probeIsolationCapability, buildProbeProfile, resolveNodeCapabilities, prepareNodeContext,
  writeInZone, publishProbe, runPrivilegeProbes,
  verifyCandidateUnchanged, canIssueIndependentProof,
} from '../node-isolation.mjs'
import { WORKSPACE_MODE, createRegistry, allocateWorkspace } from '../workspace-isolation.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const host = join(here, '..', 'node-isolation-host.mjs')
const fixtureRoot = join(here, '..', '..', '.scratch', 'node-isolation-tests')
mkdirSync(fixtureRoot, { recursive: true })

const cleanups = []
after(() => {
  for (const fn of [...cleanups].reverse()) {
    try { fn() } catch { /* ignore */ }
  }
})

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim()
}

function initRepo() {
  const root = mkdtempSync(join(fixtureRoot, 'repo-'))
  git(['init', '-q', '-b', 'main', '--template='], root)
  git(['config', 'user.email', 't@t'], root)
  git(['config', 'user.name', 't'], root)
  writeFileSync(join(root, 'src.txt'), 'base\n')
  git(['add', '-A'], root)
  git(['commit', '-q', '-m', 'init'], root)
  cleanups.push(() => { try { rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ } })
  return root
}

function workRoot() {
  const dir = mkdtempSync(join(fixtureRoot, 'root-'))
  cleanups.push(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } })
  return dir
}

function gitWorkspace(repo, runId) {
  const reg = createRegistry()
  return allocateWorkspace(reg, {
    logical_run_id: runId,
    mode: WORKSPACE_MODE.ISOLATED_WRITE,
    repository_path: repo,
    repository: 'org/demo',
    work_root: workRoot(),
    task_identity: runId,
  })
}

function hostCall(cmd, input) {
  const out = execFileSync('node', [host, cmd, JSON.stringify(input)], { encoding: 'utf-8' })
  const parsed = JSON.parse(out.trim())
  assert.equal(parsed.ok, true, cmd + ' 应成功: ' + JSON.stringify(parsed))
  return parsed
}

// ── 能力矩阵 ────────────────────────────────────────────────────────────────

test('resolveNodeCapabilities：review 只读候选、可写证据', () => {
  const caps = resolveNodeCapabilities('review')
  assert.equal(caps.candidate.write, false)
  assert.equal(caps.evidence.write, true)
  assert.equal(caps.independent_proof, true)
})

test('resolveNodeCapabilities：不得放宽基线能力', () => {
  assert.throws(() => resolveNodeCapabilities('review', { candidate: { write: true } }))
})

test('canIssueIndependentProof：unavailable 阻断正式独立 Proof', () => {
  const d = canIssueIndependentProof(ISOLATION_GUARANTEE.UNAVAILABLE, NODE_ROLE_CAPABILITIES.review)
  assert.equal(d.ok, false)
})

test('canIssueIndependentProof：enforced + review 允许', () => {
  const d = canIssueIndependentProof(ISOLATION_GUARANTEE.ENFORCED, NODE_ROLE_CAPABILITIES.review)
  assert.equal(d.ok, true)
})

// ── AC-01 / UAT-01：越权写入拒绝 ───────────────────────────────────────────

test('AC-01 review 写候选被文件层拒绝，候选字节不变', () => {
  const repo = initRepo()
  const ws = gitWorkspace(repo, 'run-review')
  writeFileSync(join(ws.source_path, 'canary.txt'), 'original\n')
  const before = readFileSync(join(ws.source_path, 'canary.txt'))
  const ctx = prepareNodeContext(ws, { node_id: 'review', profile: 'review', isolation_guarantee: ISOLATION_GUARANTEE.ENFORCED })
  assert.throws(() => writeInZone(ctx, 'candidate', 'canary.txt', 'tampered\n', ws.workspace_path))
  const after = readFileSync(join(ws.source_path, 'canary.txt'))
  assert.deepEqual(before, after)
})

test('AC-01 test 写业务源被拒绝', () => {
  const repo = initRepo()
  const ws = gitWorkspace(repo, 'run-test')
  const ctx = prepareNodeContext(ws, { node_id: 'test', profile: 'test', isolation_guarantee: ISOLATION_GUARANTEE.ENFORCED })
  assert.throws(() => writeInZone(ctx, 'source', 'src.txt', 'hack\n', ws.workspace_path))
})

test('AC-01 researcher 写源树被拒绝', () => {
  const repo = initRepo()
  const ws = gitWorkspace(repo, 'run-res')
  const ctx = prepareNodeContext(ws, { node_id: 'expert-a', profile: 'researcher', isolation_guarantee: ISOLATION_GUARANTEE.ENFORCED })
  assert.throws(() => writeInZone(ctx, 'source', 'src.txt', 'hack\n', ws.workspace_path))
})

// ── AC-02 / UAT-02：合法操作成功 ───────────────────────────────────────────

test('AC-02 review 可写证据区；test 可写覆盖层与缓存根', () => {
  const repo = initRepo()
  const ws = gitWorkspace(repo, 'run-legal')
  const rctx = prepareNodeContext(ws, { node_id: 'review', profile: 'review', isolation_guarantee: ISOLATION_GUARANTEE.ENFORCED })
  const report = writeInZone(rctx, 'evidence', 'review-report.md', '# ok\n', ws.workspace_path)
  assert.ok(existsSync(report))
  const tctx = prepareNodeContext(ws, { node_id: 'test', profile: 'test', isolation_guarantee: ISOLATION_GUARANTEE.ENFORCED })
  const overlay = writeInZone(tctx, 'test_overlay', 'case.mjs', 'export const x = 1\n', ws.workspace_path)
  assert.ok(existsSync(overlay))
  const digestBefore = tctx.candidate_digest
  const verify = verifyCandidateUnchanged(tctx, digestBefore)
  assert.equal(verify.ok, true)
})

// ── AC-03 / UAT-03：发布授权边界 ───────────────────────────────────────────

test('AC-03 无授权发布拒绝且无副作用', () => {
  const denied = publishProbe({ authorized: false, target: 'probe://local/publish', action: 'publish' })
  assert.equal(denied.ok, false)
  assert.equal(denied.side_effect, false)
  const allowed = publishProbe({ authorized: true, target: 'probe://local/publish', action: 'publish' })
  assert.equal(allowed.ok, true)
  assert.match(allowed.remote_ref, /^probe-local-/)
  const badTarget = publishProbe({ authorized: true, target: 'https://evil.example/publish', action: 'publish' })
  assert.equal(badTarget.ok, false)
})

// ── AC-04 / UAT-04：绕过与不支持 ───────────────────────────────────────────

test('AC-04 越权探针全部拒绝且候选不变', () => {
  const repo = initRepo()
  const ws = gitWorkspace(repo, 'run-bypass')
  writeFileSync(join(ws.source_path, '.ni-canary.txt'), 'base\n')
  const ctx = prepareNodeContext(ws, { node_id: 'review', profile: 'review', isolation_guarantee: ISOLATION_GUARANTEE.ENFORCED })
  const results = runPrivilegeProbes(ctx, { seed_canary: false })
  for (const r of results) {
    assert.equal(r.allowed, false, r.probe + ' 应被拒绝')
    assert.equal(r.candidate_unchanged, true, r.probe + ' 候选应不变')
  }
})

test('AC-04 unavailable 配置不能签发独立 Proof', () => {
  const d = canIssueIndependentProof(ISOLATION_GUARANTEE.UNAVAILABLE, NODE_ROLE_CAPABILITIES.review)
  assert.equal(d.ok, false)
  assert.match(d.reason, /unavailable/)
})

test('probeIsolationCapability：forced 模式可测试', () => {
  const enforced = probeIsolationCapability({ force_guarantee: ISOLATION_GUARANTEE.ENFORCED })
  assert.equal(enforced.guarantee, ISOLATION_GUARANTEE.ENFORCED)
  const unavailable = probeIsolationCapability({ force_guarantee: ISOLATION_GUARANTEE.UNAVAILABLE })
  assert.equal(unavailable.guarantee, ISOLATION_GUARANTEE.UNAVAILABLE)
})

// ── 包装脚本 ────────────────────────────────────────────────────────────────

test('node-isolation-host：prepareNode + publishProbe + canIssueProof', () => {
  const repo = initRepo()
  const reg = createRegistry()
  const wr = workRoot()
  const ws = allocateWorkspace(reg, {
    logical_run_id: 'run-host', mode: WORKSPACE_MODE.ISOLATED_WRITE,
    repository_path: repo, repository: 'org/demo', work_root: wr, task_identity: 'run-host',
  })
  mkdirSync(join(wr, '.vwf-registry'), { recursive: true })
  writeFileSync(join(wr, '.vwf-registry/state.json'), JSON.stringify({
    workspaces: { 'run-host': ws }, locks: {}, locksByKey: {}, timeline: [], archived: {},
    lockSeq: 0, nextPort: 39100, ports: [],
  }))
  const prep = hostCall('prepareNode', {
    work_root: wr, logical_run_id: 'run-host', node_id: 'review', profile: 'review',
    isolation_guarantee: ISOLATION_GUARANTEE.ENFORCED,
  })
  assert.equal(prep.context.profile, 'review')
  const pub = hostCall('publishProbe', { authorized: false })
  assert.equal(pub.result.ok, false)
  const proof = hostCall('canIssueProof', { isolation_guarantee: ISOLATION_GUARANTEE.ENFORCED, profile: 'review' })
  assert.equal(proof.decision.ok, true)
})

// ═══════════════════════════════════════════════════════════════════════════
// FIX-235 回归：探针 profile 与三判定（区内进程可跑 / 区内可写 / 区外写入被拒）
// 根因：旧参考配置没有导入 dyld 启动规则，当前 macOS 进程启动读取 dyld 闭包时被拒，
// canary SIGABRT(134)，insideAllowed 恒 false → 恒 unavailable（故障机 2026-09-20 实证）。
// 严格 deny-default profile 导入系统 dyld-support 后，才允许在有限目录内运行进程。
// ═══════════════════════════════════════════════════════════════════════════

test('FIX-235 profile：节点执行使用默认拒绝与受限读取/写入根', { skip: process.platform !== 'darwin' }, () => {
  const profileRoot = mkdtempSync(join('/private/tmp', 'ni-profile-'))
  cleanups.push(() => { try { rmSync(profileRoot, { recursive: true, force: true }) } catch { /* ignore */ } })
  const profile = buildProbeProfile(profileRoot)
  assert.ok(profile.includes('(version 1)'), '含版本声明')
  assert.ok(profile.includes('(deny default)'), '默认拒绝全部未明确授权的操作')
  assert.ok(profile.includes('dyld-support.sb'), '导入系统启动所需规则')
  assert.ok(profile.includes(`(subpath "${profileRoot}")`), '只开放显式工作区根')
  assert.ok(!profile.includes('(allow default)'), '不得默认放行')
})

test('FIX-235 语义回归：非 darwin 平台判 unavailable 且不执行探针', () => {
  const r = probeIsolationCapability({ platform: 'linux', probe_root: join(fixtureRoot, 'ni-should-not-exist') })
  assert.equal(r.guarantee, ISOLATION_GUARANTEE.UNAVAILABLE)
  assert.equal(r.backend, null)
  assert.equal(existsSync(join(fixtureRoot, 'ni-should-not-exist')), false, '非 darwin 不落探测目录')
})

test('FIX-235 探针目录不可用时返回 unavailable', { skip: process.platform !== 'darwin' }, () => {
  const r = probeIsolationCapability({ probe_root: '/dev/null/node-isolation-probe' })
  assert.equal(r.guarantee, ISOLATION_GUARANTEE.UNAVAILABLE)
  assert.equal(r.backend, 'sandbox-exec')
  assert.match(r.evidence.reason, /探针目录|ENOTDIR|目录/)
})

test('FIX-235 真机探针：darwin 上实际拒绝区外读写、shell 与符号链接绕过', { skip: process.platform !== 'darwin' }, () => {
  const probeRoot = join(fixtureRoot, 'ni-live-' + Date.now())
  const r = probeIsolationCapability({ probe_root: probeRoot })
  assert.equal(r.guarantee, ISOLATION_GUARANTEE.ENFORCED, JSON.stringify(r.evidence))
  assert.equal(r.evidence.insideAllowed, true, '区内进程可跑')
  assert.equal(r.evidence.insideWrite, true, '授权目录写入成功')
  assert.equal(r.evidence.outsideReadBlocked, true, '区外文件读取被拒')
  assert.equal(r.evidence.outsideBlocked, true, '区外文件写入被拒')
  assert.equal(r.evidence.shellWriteEnforced, true, '直接 shell 写入受同一边界约束')
  assert.equal(r.evidence.symlinkWriteBlocked, true, '符号链接不能越权写入源文件')
  assert.equal(existsSync(probeRoot), false, '探针现场默认清理')
})

test('LOC-041 Seatbelt 执行策略：工具与 shell 只能写授权目录', { skip: process.platform !== 'darwin' }, async () => {
  const { buildNodeExecutionProfile } = await import('../node-isolation.mjs')
  assert.equal(typeof buildNodeExecutionProfile, 'function', '必须有真实节点执行用的 Seatbelt 策略生成器')

  const root = mkdtempSync(join('/private/tmp', 'ni-seatbelt-execution-'))
  cleanups.push(() => { try { rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ } })
  const source = join(root, 'source')
  mkdirSync(source)
  const sourceFile = join(source, 'source.txt')
  writeFileSync(sourceFile, 'source-base\n')
  const ws = { workspace_path: root, source_path: source, resources: {} }
  const ctx = prepareNodeContext(ws, { node_id: 'review', profile: 'review', isolation_guarantee: ISOLATION_GUARANTEE.ENFORCED })
  assert.throws(
    () => buildNodeExecutionProfile({ ...ctx, capabilities: undefined }),
    /capabilities/,
    '缺少能力表时必须拒绝生成策略',
  )
  assert.throws(
    () => buildNodeExecutionProfile({ ...ctx, writable_roots: undefined }),
    /writable_roots/,
    '缺少写入目录清单时必须拒绝生成策略',
  )
  assert.throws(
    () => buildNodeExecutionProfile({ ...ctx, capabilities: { ...ctx.capabilities, evidence: undefined } }),
    /capabilities\.evidence/,
    '缺少证据区能力时不得默认允许读取',
  )
  assert.throws(
    () => buildNodeExecutionProfile({
      ...ctx,
      capabilities: {
        ...ctx.capabilities,
        candidate: { ...ctx.capabilities.candidate, write: true },
      },
      writable_roots: [...ctx.writable_roots, source],
    }),
    /不得放宽 candidate\.write/,
    'review context 不能放宽角色基线并开放候选写入',
  )
  assert.throws(
    () => buildNodeExecutionProfile({
      ...ctx,
      writable_roots: [...ctx.writable_roots, source],
    }),
    /writable root.*候选\/源只读能力/,
    'review context 的写入目录清单不能把只读候选加入白名单',
  )
  const sourceBefore = readFileSync(sourceFile)
  const outsideFile = join('/private/tmp', 'ni-seatbelt-outside-' + Date.now() + '.txt')
  const runtimeManifest = join(root, 'runtime-package.json')
  const runtimeSibling = join(root, 'runtime-private.txt')
  writeFileSync(outsideFile, 'outside-secret\n')
  writeFileSync(runtimeManifest, '{"name":"runtime-metadata"}\n')
  writeFileSync(runtimeSibling, 'runtime-private\n')
  const evidenceFile = join(ctx.evidence_path, 'review-report.txt')
  const evidenceLink = join(ctx.evidence_path, 'source-link.txt')
  symlinkSync(sourceFile, evidenceLink)
  const nodePath = process.execPath
  const listen = () => new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.end('ok'))
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
  const allowedServer = await listen()
  const deniedServer = await listen()
  const allowedPort = allowedServer.address().port
  const deniedPort = deniedServer.address().port
  const profile = buildNodeExecutionProfile(ctx, {
    executable_paths: [nodePath],
    extra_read_files: [runtimeManifest],
    loopback_port: allowedPort,
  })

  try {
    assert.match(profile, /\(deny default\)/, '节点策略必须默认拒绝')
    assert.match(profile, /dyld-support\.sb/, '必须导入 macOS 进程启动所需规则')
    assert.doesNotMatch(profile, /\(allow default\)/, '节点策略不得默认放行')

    const shellScript = [
      `printf 'candidate-tamper\\n' > '${sourceFile}'`,
      `printf 'evidence-ok\\n' > '${evidenceFile}'`,
      `printf 'symlink-tamper\\n' > '${evidenceLink}'`,
    ].join('; ')
    const shell = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, '/bin/sh', '-c', shellScript], {
      encoding: 'utf-8', timeout: 5000,
    })
    assert.equal(shell.error, undefined, shell.stderr)
    assert.equal(shell.signal, null, 'shell 必须在拒绝越权写入后继续运行')

    const nodeScript = `const fs=require('node:fs'),net=require('node:net'); const read=p=>{try{return fs.readFileSync(p,'utf8').trim()}catch(e){return e.code}}; const write=p=>{try{fs.writeFileSync(p,'tool-tamper\\n');return 'written'}catch(e){return e.code}}; const connect=port=>new Promise(resolve=>{const s=net.connect(port,'127.0.0.1');const timer=setTimeout(()=>{s.destroy();resolve('TIMEOUT')},1500);timer.unref();s.once('connect',()=>{clearTimeout(timer);s.destroy();resolve('connected')});s.once('error',e=>{clearTimeout(timer);resolve(e.code||e.message)})}); (async()=>console.log(JSON.stringify({source:read(${JSON.stringify(sourceFile)}),outside:read(${JSON.stringify(outsideFile)}),runtimeManifest:read(${JSON.stringify(runtimeManifest)}),runtimeSibling:read(${JSON.stringify(runtimeSibling)}),evidence:write(${JSON.stringify(evidenceFile)}),sourceWrite:write(${JSON.stringify(sourceFile)}),symlinkWrite:write(${JSON.stringify(evidenceLink)}),allowedPort:await connect(${allowedPort}),deniedPort:await connect(${JSON.stringify(deniedPort)})})))()`
    const toolOutput = execFileSync('/usr/bin/sandbox-exec', ['-p', profile, nodePath, '-e', nodeScript], {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
    })
    const tool = JSON.parse(toolOutput.trim())
    assert.equal(tool.source, 'source-base')
    assert.equal(tool.outside, 'EPERM', '工具不得读取授权根外文件')
    assert.equal(tool.runtimeManifest, '{"name":"runtime-metadata"}', '精确声明的运行时元数据文件可读')
    assert.equal(tool.runtimeSibling, 'EPERM', '运行时元数据的同目录文件仍不可读')
    assert.equal(tool.evidence, 'written', '合法证据写入应成功')
    assert.equal(tool.sourceWrite, 'EPERM', '工具不得写业务源')
    assert.equal(tool.symlinkWrite, 'EPERM', '符号链接不得绕过授权根')
    assert.equal(tool.allowedPort, 'connected', '模型代理 loopback 端口应可用')
    assert.equal(tool.deniedPort, 'EPERM', '其他 loopback 端口必须被拒绝')
    assert.equal(readFileSync(sourceFile).equals(sourceBefore), true, '候选字节必须保持不变')
    assert.equal(readFileSync(evidenceFile, 'utf-8'), 'tool-tamper\n', '证据目录应保留合法写入')
  } finally {
    await Promise.all([allowedServer, deniedServer].map((server) => new Promise((resolve) => server.close(resolve))))
    rmSync(outsideFile, { force: true })
  }
})

test('SDK DSH 启动接缝：提供受约束的 sandboxed launch spec', async () => {
  const { buildSandboxedDshLaunchSpec } = await import('../node-isolation.mjs')
  assert.equal(typeof buildSandboxedDshLaunchSpec, 'function', 'SDK 自定义 dshBin 需要可复用的隔离启动规格')
})

test('SDK DSH 启动接缝：Seatbelt 内运行真实入口且不继承父进程秘密', { skip: process.platform !== 'darwin' }, async () => {
  const { buildSandboxedDshLaunchSpec } = await import('../node-isolation.mjs')
  assert.equal(typeof buildSandboxedDshLaunchSpec, 'function')

  const root = mkdtempSync(join('/private/tmp', 'ni-dsh-launch-'))
  cleanups.push(() => { try { rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ } })
  const source = join(root, 'source')
  const runtime = join(root, 'runtime')
  mkdirSync(source)
  mkdirSync(runtime)
  const sourceFile = join(source, 'source.txt')
  const outsideFile = join(root, 'outside.txt')
  const runtimeManifest = join(root, 'runtime-package.json')
  const runtimeSibling = join(root, 'runtime-private.txt')
  const dshEntry = join(runtime, 'fake-dsh.mjs')
  const listen = () => new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.end('ok'))
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
  const allowedServer = await listen()
  const deniedServer = await listen()
  const allowedPort = allowedServer.address().port
  const deniedPort = deniedServer.address().port
  writeFileSync(sourceFile, 'source-base\n')
  writeFileSync(outsideFile, 'outside-secret\n')
  writeFileSync(runtimeManifest, '{"name":"runtime-metadata"}\n')
  writeFileSync(runtimeSibling, 'runtime-private\n')
  writeFileSync(dshEntry, `
    import { spawnSync } from 'node:child_process'
    import { readFileSync, writeFileSync } from 'node:fs'
    import net from 'node:net'
    const stdin = await new Promise((resolve) => { const chunks = []; process.stdin.on('data', (chunk) => chunks.push(chunk)); process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))) })
    const read = (path) => { try { return readFileSync(path, 'utf8').trim() } catch (error) { return error.code } }
    const write = (path) => { try { writeFileSync(path, 'changed\\n'); return 'written' } catch (error) { return error.code } }
    const connect = (port) => new Promise((resolve) => { const socket = net.connect(port, '127.0.0.1'); const timer = setTimeout(() => { socket.destroy(); resolve('TIMEOUT') }, 1500); socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve('connected') }); socket.once('error', (error) => { clearTimeout(timer); resolve(error.code || error.message) }) })
    const shell = spawnSync('/bin/sh', ['-c', [
      'if printf tampered > ' + ${JSON.stringify(sourceFile)} + ' 2>/dev/null; then printf source-write-allowed; else printf source-write-denied; fi',
      'if cat ' + ${JSON.stringify(outsideFile)} + ' >/dev/null 2>&1; then printf outside-read-allowed; else printf outside-read-denied; fi',
      'printf shell-proof > ' + ${JSON.stringify(join(root, 'evidence', 'review', 'shell-proof.txt'))},
    ].join(';')], { encoding: 'utf8' })
    console.log(JSON.stringify({
      source: read(${JSON.stringify(sourceFile)}),
      outside: read(${JSON.stringify(outsideFile)}),
      sourceWrite: write(${JSON.stringify(sourceFile)}),
      evidenceWrite: write(${JSON.stringify(join(root, 'evidence', 'review', 'launch-proof.txt'))}),
      shell: shell.stdout,
      shellExitCode: shell.status,
      allowedPort: await connect(${allowedPort}),
      deniedPort: await connect(${deniedPort}),
      modelProxy: process.env.HTTPS_PROXY || null,
      secret: process.env.WFM_LAUNCH_SECRET || process.env.OPENAI_API_KEY || null,
      hasModelKey: Boolean(process.env.DEEPSEEK_API_KEY),
      runtimeManifest: read(${JSON.stringify(runtimeManifest)}),
      runtimeSibling: read(${JSON.stringify(runtimeSibling)}),
      path: process.env.PATH,
      home: process.env.DSH_HOME,
      stdin,
      args: process.argv.slice(2),
    }))
  `)
  const context = prepareNodeContext(
    { workspace_path: root, source_path: source, resources: {} },
    { node_id: 'review', profile: 'review', isolation_guarantee: ISOLATION_GUARANTEE.ENFORCED },
  )
  const dshHome = join(context.scratch_path, 'dsh-home')
  mkdirSync(dshHome)
  const contaminatedHome = join(context.scratch_path, 'existing-home')
  mkdirSync(contaminatedHome)
  writeFileSync(join(contaminatedHome, 'credentials.json'), '{"token":"must-not-reuse"}')
  assert.throws(
    () => buildSandboxedDshLaunchSpec(context, {
      dsh_entry: dshEntry, runtime_roots: [runtime], dsh_home: contaminatedHome,
    }),
    /dsh_home 必须为空/,
    '已有配置/凭据的 DSH Home 必须拒绝复用',
  )
  const writableRuntimeEntry = join(context.evidence_path, 'runtime.js')
  writeFileSync(writableRuntimeEntry, '// runtime placeholder\n')
  assert.throws(
    () => buildSandboxedDshLaunchSpec(context, {
      dsh_entry: writableRuntimeEntry,
      runtime_roots: [context.evidence_path],
      dsh_home: dshHome,
    }),
    /runtime root 不得与节点 writable_roots 重叠/,
    '运行时根目录不得同时落在节点可写目录中',
  )
  try {
    const spec = buildSandboxedDshLaunchSpec(context, {
      dsh_entry: dshEntry,
      runtime_roots: [runtime],
      runtime_files: [runtimeManifest],
      dsh_home: dshHome,
      loopback_port: allowedPort,
      api_key: 'fixture-deepseek-key',
      argv: ['--profile', 'sdk-profile', '--patch', 'one.js'],
    })
    assert.equal(spec.command, '/usr/bin/sandbox-exec')
    assert.deepEqual(spec.args.slice(0, 2), ['-p', spec.profile])
    assert.deepEqual(spec.args.slice(3), [dshEntry, '--profile', 'sdk-profile', '--patch', 'one.js'])
    assert.equal(spec.cwd, context.agent_cwd)
    assert.equal(spec.env.DSH_HOME, dshHome)
    assert.equal(spec.env.HOME, dshHome)
    assert.equal(spec.env.TMPDIR, context.scratch_path)
    assert.equal(spec.env.HTTPS_PROXY, 'http://127.0.0.1:' + allowedPort)
    assert.equal(spec.env.HTTP_PROXY, 'http://127.0.0.1:' + allowedPort)
    assert.equal(spec.env.DEEPSEEK_API_KEY, 'fixture-deepseek-key', '沙箱内真实 DSH 需要模型凭据')
    assert.equal(Object.hasOwn(spec.env, 'OPENAI_API_KEY'), false)
    assert.equal(Object.hasOwn(spec.env, 'NODE_OPTIONS'), false)
    assert.ok(spec.profile.includes('(literal ' + JSON.stringify(realpathSync(runtimeManifest)) + ')'), '只放行明确列出的运行时元数据文件')

    const launcher = join(here, '..', 'node-isolation-launcher.mjs')
    const config = JSON.stringify({
      context,
      dsh_entry: dshEntry,
      runtime_roots: [runtime],
      runtime_files: [runtimeManifest],
      dsh_home: dshHome,
      loopback_port: allowedPort,
    })
    const run = spawnSync(process.execPath, [launcher, '--profile', 'sdk-profile', '--patch', 'one.js'], {
      cwd: context.agent_cwd,
      input: 'sdk-stdio-probe\n',
      env: {
        PATH: '/untrusted/bin',
        OPENAI_API_KEY: 'parent-secret',
        WFM_LAUNCH_SECRET: 'parent-secret',
        DEEPSEEK_API_KEY: 'fixture-deepseek-key',
        WFM_NODE_ISOLATION_LAUNCH_SPEC: config,
      },
      encoding: 'utf-8',
      timeout: 10000,
    })
    assert.equal(run.error, undefined, run.stderr)
    assert.equal(run.status, 0, run.stderr)
    const result = JSON.parse(run.stdout.trim())
    assert.equal(result.source, 'source-base')
    assert.equal(result.outside, 'EPERM')
    assert.equal(result.sourceWrite, 'EPERM')
    assert.equal(result.evidenceWrite, 'written')
    assert.equal(result.shell, 'source-write-deniedoutside-read-denied', 'DSH 子进程启动的 shell 必须继承同一策略')
    assert.equal(result.shellExitCode, 0)
    assert.equal(readFileSync(join(root, 'evidence', 'review', 'shell-proof.txt'), 'utf-8'), 'shell-proof')
    assert.equal(result.allowedPort, 'connected', '沙箱内 DSH 子进程应能访问唯一代理端口')
    assert.equal(result.deniedPort, 'EPERM', '沙箱内 DSH 子进程必须拒绝其他 loopback 端口')
    assert.equal(result.modelProxy, 'http://127.0.0.1:' + allowedPort, '实际 DSH 进程只使用本地模型代理')
    assert.equal(result.secret, null, '父进程秘密不得传给实际 DSH')
    assert.equal(result.hasModelKey, true, '只有 DeepSeek API 凭据应传入实际 DSH')
    assert.equal(result.runtimeManifest, '{"name":"runtime-metadata"}', 'launcher 将精确文件读取许可传给沙箱')
    assert.equal(result.runtimeSibling, 'EPERM', '精确文件许可不开放同目录其他文件')
    assert.equal(result.path, '/usr/bin:/bin:/usr/sbin:/sbin', '父进程 PATH 不得带入真实 DSH')
    assert.equal(result.home, dshHome)
    assert.equal(result.stdin, 'sdk-stdio-probe\n', 'SDK stdin 数据必须转发给真实 DSH')
    assert.deepEqual(result.args, ['--profile', 'sdk-profile', '--patch', 'one.js'])
    assert.equal(readFileSync(sourceFile, 'utf-8'), 'source-base\n')
  } finally {
    await Promise.all([allowedServer, deniedServer].map((server) => new Promise((resolve) => server.close(resolve))))
  }
})

test('SDK DSH 启动接缝：SDK SIGTERM 会结束 Seatbelt 内整个 DSH 进程组', { skip: process.platform !== 'darwin' }, async () => {
  const { buildSandboxedDshLaunchSpec } = await import('../node-isolation.mjs')
  assert.equal(typeof buildSandboxedDshLaunchSpec, 'function')

  const root = mkdtempSync(join('/private/tmp', 'ni-dsh-signal-'))
  cleanups.push(() => { try { rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ } })
  const runtime = join(root, 'runtime')
  mkdirSync(runtime)
  const dshEntry = join(runtime, 'fake-dsh.mjs')
  const shutdownFile = join(root, 'evidence', 'review', 'shutdown.txt')
  writeFileSync(dshEntry, `
    import { writeFileSync } from 'node:fs'
    console.log(JSON.stringify({ ready: true, pid: process.pid }))
    process.on('SIGTERM', () => { writeFileSync(${JSON.stringify(shutdownFile)}, 'stopped\\n'); process.exit(0) })
    setInterval(() => {}, 1000)
  `)
  const context = prepareNodeContext(
    { workspace_path: root, source_path: null, resources: {} },
    { node_id: 'review', profile: 'review', isolation_guarantee: ISOLATION_GUARANTEE.ENFORCED },
  )
  const dshHome = join(context.scratch_path, 'dsh-home')
  mkdirSync(dshHome)
  const launcher = join(here, '..', 'node-isolation-launcher.mjs')
  const child = spawn(process.execPath, [launcher, '--sdk-probe'], {
    cwd: context.agent_cwd,
    env: {
      WFM_NODE_ISOLATION_LAUNCH_SPEC: JSON.stringify({
        context, dsh_entry: dshEntry, runtime_roots: [runtime], dsh_home: dshHome,
      }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf-8').on('data', (chunk) => { stdout += chunk })
  child.stderr.setEncoding('utf-8').on('data', (chunk) => { stderr += chunk })
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`DSH child did not become ready: ${stderr}`)), 5000)
    const inspect = () => {
      const line = stdout.split('\n').find((value) => value.includes('"ready":true'))
      if (!line) return
      clearTimeout(timer)
      try { resolve(JSON.parse(line)) } catch (error) { reject(error) }
    }
    child.stdout.on('data', inspect)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      reject(new Error(`launcher exited before DSH was ready (code=${code}, signal=${signal}): ${stderr}`))
    })
  })
  const closed = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })))
  const readyInfo = await ready
  assert.equal(typeof readyInfo.pid, 'number')
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
  const result = await closed
  clearTimeout(timer)
  assert.ok(result.code === 0 || result.code === 143, `launcher exited with ${JSON.stringify(result)}: ${stderr}`)
  assert.equal(readFileSync(shutdownFile, 'utf-8'), 'stopped\n', '真实 DSH child 收到 SDK 的 SIGTERM')
  assert.equal(child.exitCode !== null || child.signalCode !== null, true, 'wrapper 必须等待嵌套进程组退出')
})


test('node-isolation-host：为已准备节点 context 生成默认拒绝策略', { skip: process.platform !== 'darwin' }, () => {
  const root = mkdtempSync(join('/private/tmp', 'ni-host-profile-'))
  cleanups.push(() => { try { rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ } })
  const source = join(root, 'source')
  mkdirSync(source)
  const context = prepareNodeContext(
    { workspace_path: root, source_path: source, resources: {} },
    { node_id: 'review', profile: 'review', isolation_guarantee: ISOLATION_GUARANTEE.ENFORCED },
  )
  const result = hostCall('buildProfile', {
    context,
    options: { executable_paths: [process.execPath], loopback_port: 61383 },
  })
  assert.match(result.profile, /\(deny default\)/)
  assert.match(result.profile, /dyld-support\.sb/)
  assert.match(result.profile, new RegExp(context.evidence_path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(result.profile, /localhost:61383/)
})
