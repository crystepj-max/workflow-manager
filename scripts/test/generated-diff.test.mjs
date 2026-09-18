// LOC-006：生成产物比对单一权威与孤儿清理直测
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { compareGeneratedFiles, pruneGenerated } from '../generate.mjs'

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gen-diff-'))
}
const write = (p, content) => {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}

test('compareGeneratedFiles：一致时三态皆空', () => {
  const dir = tmpdir()
  write(path.join(dir, 'a/script.mjs'), 'x')
  const files = new Map([['a/script.mjs', 'x']])
  assert.deepEqual(compareGeneratedFiles(files, dir), { missing: [], extra: [], changed: [] })
})

test('compareGeneratedFiles：missing / extra / changed 三态分别命中', () => {
  const dir = tmpdir()
  write(path.join(dir, 'a/script.mjs'), 'old')
  write(path.join(dir, 'z/orphan.mjs'), 'orphan')
  const files = new Map([['a/script.mjs', 'new'], ['b/script.mjs', 'b']])
  const d = compareGeneratedFiles(files, dir)
  assert.deepEqual(d.missing, ['b/script.mjs'])
  assert.deepEqual(d.extra, ['z/orphan.mjs'])
  assert.deepEqual(d.changed, ['a/script.mjs'])
})

test('compareGeneratedFiles：目录不存在 = 全部 missing', () => {
  const files = new Map([['a/script.mjs', 'x']])
  assert.deepEqual(compareGeneratedFiles(files, path.join(tmpdir(), 'nope')), { missing: ['a/script.mjs'], extra: [], changed: [] })
})

test('pruneGenerated：只移除顶层 id 不在 map 内的目录，保留活目录与散文件', () => {
  const dir = tmpdir()
  write(path.join(dir, 'live/script.mjs'), 'x')
  write(path.join(dir, 'dead-blueprint/meta.json'), 'y')
  write(path.join(dir, 'stray-file.txt'), 'z')
  const files = new Map([['live/script.mjs', 'x']])
  const removed = pruneGenerated(files, dir)
  assert.deepEqual(removed, ['dead-blueprint'])
  assert.ok(fs.existsSync(path.join(dir, 'live/script.mjs')))
  assert.ok(!fs.existsSync(path.join(dir, 'dead-blueprint')))
  assert.ok(fs.existsSync(path.join(dir, 'stray-file.txt')), '根下散文件不动')
})

test('pruneGenerated：幂等——第二次运行无移除', () => {
  const dir = tmpdir()
  write(path.join(dir, 'dead/meta.json'), 'y')
  const files = new Map([['live/script.mjs', 'x']])
  assert.equal(pruneGenerated(files, dir).length, 1)
  assert.deepEqual(pruneGenerated(files, dir), [])
})

test('pruneGenerated：目录不存在返回空数组', () => {
  assert.deepEqual(pruneGenerated(new Map(), path.join(tmpdir(), 'nope')), [])
})
