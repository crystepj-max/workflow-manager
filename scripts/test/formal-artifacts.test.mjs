// #69 Formal Artifact 内核：JSON 类 content 校验与 ingest
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const {
  parseArtifactBody,
  ingestArtifacts,
  blueprintKindToMediaType,
} = require(join(repo, 'scripts', 'formal-artifacts.cjs'))

test('#69 parseArtifactBody：JSON 类缺 content 或非法 JSON 应拒绝', () => {
  for (const kind of ['json', 'canvas', 'flowchart', 'diagram']) {
    assert.throws(() => parseArtifactBody(kind, undefined), /必填/)
    assert.throws(() => parseArtifactBody(kind, null), /必填/)
    assert.throws(() => parseArtifactBody(kind, ''), /不能为空/)
    assert.throws(() => parseArtifactBody(kind, '   '), /不能为空/)
    assert.throws(() => parseArtifactBody(kind, '{bad'), /合法 JSON/)
  }
  const body = parseArtifactBody('canvas', '{"nodes":[],"edges":[]}')
  assert.equal(body.media_type, blueprintKindToMediaType('canvas'))
  assert.deepEqual(body.value, { nodes: [], edges: [] })
})

test('#69 ingestArtifacts：JSON 类缺 content 不产生非法 Record', () => {
  assert.throws(
    () => ingestArtifacts([], {
      runId: 'r1',
      nodeId: 'n1',
      artifacts: [{ path: 'x.json', kind: 'json' }],
    }),
    /必填/,
  )
  const ok = ingestArtifacts([], {
    runId: 'r1',
    nodeId: 'n1',
    artifacts: [{ path: 'x.json', kind: 'json', content: '{"ok":true}' }],
  })
  assert.equal(ok.length, 1)
  assert.equal(ok[0].body.value.ok, true)
  assert.equal('value' in ok[0].body, true)
})
