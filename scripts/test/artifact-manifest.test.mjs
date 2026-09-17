// LOC-035 产物清单：AC-01~04 与 UAT 场景机器验证
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const am = require(join(repo, 'scripts', 'artifact-manifest.cjs'))

function sha(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'am-'))
  const runDir = join(root, '.agent-runs', 't1')
  mkdirSync(runDir, { recursive: true })
  return { root, runDir, rel: '.agent-runs/t1', cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function submit(fx, req, prev) {
  return am.processSubmit({ cwd: fx.root, runDir: fx.rel, taskId: 't1', req, prevManifest: prev })
}

test('declarationsFromOutputFiles：旧字符串声明默认必需', () => {
  const d = am.declarationsFromOutputFiles({ 'uat-card.md': 'markdown' })
  assert.equal(d.length, 1)
  assert.equal(d[0].required, true)
  assert.equal(d[0].allow_empty, false)
})

test('AC-01 / UAT-01：缺失必需 UAT 卡片阻断材料就绪', () => {
  const fx = fixture()
  const r1 = submit(fx, {
    revision: 1,
    node: 'uat',
    producer_attempt_id: 'a1k1',
    round_id: 1,
    item_id: null,
    entries: am.declarationsFromOutputFiles({ 'uat-card.md': 'markdown', 'acceptance-summary.md': 'markdown' }),
  })
  assert.equal(r1.manifest.materials_status, 'incomplete')
  assert.equal(r1.manifest.required_complete, false)
  const miss = r1.manifest.entries.find((e) => e.logical_name === 'uat-card.md')
  assert.equal(miss.verification_status, 'rejected')
  writeFileSync(join(fx.runDir, 'uat-card.md'), '# UAT\n')
  writeFileSync(join(fx.runDir, 'acceptance-summary.md'), '# sum\n')
  const r2 = submit(fx, {
    revision: 2,
    node: 'uat',
    producer_attempt_id: 'a1k2',
    round_id: 1,
    item_id: null,
    entries: am.declarationsFromOutputFiles({ 'uat-card.md': 'markdown', 'acceptance-summary.md': 'markdown' }),
  }, r1.manifest)
  assert.equal(r2.manifest.materials_status, 'ready')
  assert.equal(r2.manifest.revision, 2)
  fx.cleanup()
})

test('AC-02 / UAT-02：两轮同名报告保持 R1/R2 两个版本', () => {
  const fx = fixture()
  writeFileSync(join(fx.runDir, 'research-e1.md'), 'R1')
  const r1 = submit(fx, {
    revision: 1,
    node: 'research',
    producer_attempt_id: 'a1k1',
    round_id: 1,
    item_id: 'e1',
    entries: [{ logical_name: 'research-e1.md', relative_path: 'research-e1.md', media_type: 'text/markdown', required: true }],
  })
  writeFileSync(join(fx.runDir, 'research-e1.md'), 'R2')
  const r2 = submit(fx, {
    revision: 2,
    node: 'research',
    producer_attempt_id: 'a1k2',
    round_id: 2,
    item_id: 'e1',
    entries: [{ logical_name: 'research-e1.md', relative_path: 'research-e1.md', media_type: 'text/markdown', required: true }],
  }, r1.manifest)
  const snap1 = readFileSync(join(fx.runDir, r1.manifest.entries[0].ref.snapshot_path))
  const snap2 = readFileSync(join(fx.runDir, r2.manifest.entries[0].ref.snapshot_path))
  assert.equal(snap1.toString(), 'R1')
  assert.equal(snap2.toString(), 'R2')
  const picked = am.entriesForManifestRead(r2.manifest, { round_id: 2, item_id: 'e1', logical_name: 'research-e1.md' })
  assert.equal(picked.length, 1)
  assert.equal(picked[0].sha256, sha(Buffer.from('R2')))
  fx.cleanup()
})

test('AC-03 / UAT-03：越界路径、symlink 越界、重复身份、错误摘要均被拦截', () => {
  const fx = fixture()
  writeFileSync(join(fx.runDir, 'ok.md'), 'ok')
  mkdirSync(join(fx.root, 'outside'))
  writeFileSync(join(fx.root, 'outside', 'x.md'), 'x')
  symlinkSync(join(fx.root, 'outside'), join(fx.runDir, 'escape-link'))
  const badDigest = sha(Buffer.from('ok'))
  const r = submit(fx, {
    revision: 1,
    node: 'dev',
    producer_attempt_id: 'a1k1',
    round_id: 0,
    item_id: null,
    entries: [
      { logical_name: 'outside.md', relative_path: '../outside/x.md', media_type: 'text/markdown', required: true },
      { logical_name: 'escape.md', relative_path: 'escape-link/x.md', media_type: 'text/markdown', required: true },
      { logical_name: 'dup.md', relative_path: 'ok.md', media_type: 'text/markdown', required: true },
      { logical_name: 'dup.md', relative_path: 'ok.md', media_type: 'text/markdown', required: true },
      { logical_name: 'bad-sha.md', relative_path: 'ok.md', media_type: 'text/markdown', required: true, sha256: '0'.repeat(64) },
      { logical_name: 'good.md', relative_path: 'ok.md', media_type: 'text/markdown', required: true },
    ],
  })
  const byName = Object.fromEntries(r.manifest.entries.map((e) => [e.logical_name, e]))
  assert.equal(byName['outside.md'].verification_status, 'rejected')
  assert.equal(byName['escape.md'].verification_status, 'rejected')
  assert.equal(byName['dup.md'].verification_status, 'rejected')
  assert.equal(byName['bad-sha.md'].verification_status, 'rejected')
  assert.equal(byName['good.md'].verification_status, 'verified')
  assert.ok(!byName['good.md'].ref || byName['good.md'].ref.digest)
  fx.cleanup()
})

test('AC-04 / UAT-04：可选缺失不阻断；默认必需空文件阻断；allow_empty 可通过', () => {
  const fx = fixture()
  writeFileSync(join(fx.runDir, 'required.md'), 'data')
  writeFileSync(join(fx.runDir, 'empty.md'), '')
  const r1 = submit(fx, {
    revision: 1,
    node: 'uat',
    producer_attempt_id: 'a1k1',
    round_id: 0,
    item_id: null,
    entries: [
      { logical_name: 'required.md', relative_path: 'required.md', media_type: 'text/markdown', required: true },
      { logical_name: 'optional.md', relative_path: 'optional.md', media_type: 'text/markdown', required: false },
      { logical_name: 'empty.md', relative_path: 'empty.md', media_type: 'text/markdown', required: true },
    ],
  })
  const by = Object.fromEntries(r1.manifest.entries.map((e) => [e.logical_name, e]))
  assert.equal(by['optional.md'].verification_status, 'missing_optional')
  assert.equal(by['empty.md'].verification_status, 'rejected')
  assert.equal(r1.manifest.materials_status, 'incomplete')
  const r2 = submit(fx, {
    revision: 2,
    node: 'uat',
    producer_attempt_id: 'a1k2',
    round_id: 0,
    item_id: null,
    entries: [
      { logical_name: 'required.md', relative_path: 'required.md', media_type: 'text/markdown', required: true },
      { logical_name: 'optional.md', relative_path: 'optional.md', media_type: 'text/markdown', required: false },
      { logical_name: 'empty.md', relative_path: 'empty.md', media_type: 'text/markdown', required: true, allow_empty: true },
    ],
  }, r1.manifest)
  const by2 = Object.fromEntries(r2.manifest.entries.map((e) => [e.logical_name, e]))
  assert.equal(by2['optional.md'].verification_status, 'missing_optional')
  assert.equal(by2['empty.md'].verification_status, 'verified')
  assert.equal(r2.manifest.materials_status, 'ready')
  const block = am.gateBlockOf(r1.manifest, 'uat')
  assert.ok(block && block.code === 'ARTIFACT_MANIFEST_INCOMPLETE')
  assert.equal(am.gateBlockOf(r2.manifest, 'uat'), null)
  fx.cleanup()
})

test('parseSubmitRequest：损坏行返回 null', () => {
  assert.equal(am.parseSubmitRequest('log [am-submit]{bad'), null)
  assert.ok(am.parseSubmitRequest('[am-submit]' + JSON.stringify({ node: 'n', entries: [] })))
})
