import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import validatorCore from '../validate-core.cjs'
import projectionCore from '../projection-core.cjs'
import schemaProtocol from '../schema-protocol-core.cjs'
import { validateRecord } from '../cwf-validate.mjs'
import { compileBlueprint } from '../generate.mjs'
import { runGeneratedScript, makeAgentScript } from './helpers/runtime-harness.mjs'

const { validateBlueprint, projectToVwf, projectToBlueprint } = validatorCore
const {
  auditSchemaDefinition,
  validateInstanceSimple,
  instanceValid,
  legacyInstanceValid,
  resolveProtocol,
  checkProtocolGate,
  buildRuntimeEnvelope,
  freezeProtocolSnapshot,
  EXECUTION_KEYWORDS,
} = schemaProtocol

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '../..')
const templatesDir = join(repo, 'templates')

function tpl(name) {
  return JSON.parse(readFileSync(join(templatesDir, name), 'utf8'))
}

test('AC-01：声明执行关键字合法/非法对照静态与运行时一致', () => {
  const cases = [
    ['minItems', { type: 'array', minItems: 1 }, [], ['a']],
    ['maxItems', { type: 'array', maxItems: 1 }, ['a', 'b'], ['a']],
    ['minLength', { type: 'string', minLength: 2 }, 'a', 'ab'],
    ['maxLength', { type: 'string', maxLength: 2 }, 'abc', 'ab'],
    ['minimum', { type: 'number', minimum: 3 }, 2, 3],
    ['maximum', { type: 'number', maximum: 3 }, 4, 3],
    ['pattern', { type: 'string', pattern: '^a+$' }, 'b', 'aa'],
    ['oneOf', { oneOf: [{ type: 'string' }, { type: 'number' }] }, true, 'x'],
    ['anyOf', { anyOf: [{ type: 'string' }, { type: 'number' }] }, {}, 1],
    ['allOf', { allOf: [{ type: 'string' }, { minLength: 2 }] }, 'a', 'ab'],
    ['not', { not: { type: 'number' } }, 1, 'x'],
    ['if/then/else', { if: { type: 'string' }, then: { minLength: 2 }, else: { type: 'number' } }, 'a', 'ab'],
  ]
  for (const [label, schema, bad, good] of cases) {
    assert.equal(instanceValid(schema, bad), false, label + ' 非法应拒绝')
    assert.equal(instanceValid(schema, good), true, label + ' 合法应通过')
    const badErrs = validateInstanceSimple(schema, bad)
    const goodErrs = validateInstanceSimple(schema, good)
    assert.ok(badErrs.length > 0, label + ' 非法应有路径')
    assert.equal(goodErrs.length, 0, label + ' 合法应无错误：' + goodErrs.join('; '))
  }
})

test('AC-02：未知关键字/未来主版本/缺 capability 拒绝；注释字段不误阻断', () => {
  const badKeyword = {
    id: 'proto-bad-kw',
    displayName: 'x',
    entry: 'n',
    protocol: { version: '1.0', required_capabilities: ['type', 'properties', 'required', 'additionalProperties'] },
    nodes: [{ id: 'n', profile: 'dev', goal: 'g', output: { schema: { type: 'object', properties: { x: { type: 'string', format: 'email' } }, required: ['x'], additionalProperties: false } } }],
    edges: [{ from: 'n', to: '$end', outcome: 'DONE' }],
  }
  assert.equal(validateBlueprint(badKeyword).ok, false)

  const v2 = JSON.parse(JSON.stringify(tpl('wf-optimize.json')))
  v2.protocol.version = '2.0'
  assert.equal(validateBlueprint(v2).ok, false)

  const missingCap = JSON.parse(JSON.stringify(tpl('wf-explore.json')))
  missingCap.protocol.required_capabilities = ['type']
  assert.equal(validateBlueprint(missingCap).ok, false)

  const annotated = {
    id: 'proto-annot',
    displayName: 'x',
    entry: 'n',
    protocol: { version: '1.0', required_capabilities: ['type', 'enum', 'properties', 'required', 'additionalProperties'] },
    nodes: [{
      id: 'n', profile: 'dev', goal: 'g',
      output: {
        outcomePath: '$.route',
        schema: {
          type: 'object',
          description: '注释不应阻断',
          properties: { route: { type: 'string', enum: ['OK'] } },
          required: ['route'],
          additionalProperties: false,
        },
      },
    }],
    edges: [{ from: 'n', to: '$end', outcome: 'OK' }],
  }
  assert.equal(validateBlueprint(annotated).ok, true)
  const gate = checkProtocolGate(resolveProtocol(annotated))
  assert.equal(gate.length, 0)
})

test('AC-03：四模板校验通过、投影往返保留 protocol；Portable 样例仍有效', () => {
  for (const file of readdirSync(templatesDir).filter((f) => f.endsWith('.json'))) {
    const bp = tpl(file)
    const r = validateBlueprint(bp)
    assert.equal(r.ok, true, file + ': ' + JSON.stringify(r.errors))
    if (bp.protocol) {
      const back = projectToBlueprint(projectToVwf(bp))
      assert.deepEqual(back.protocol, bp.protocol, file + ' protocol 往返')
    }
  }
  const portableSchema = JSON.parse(readFileSync(join(repo, 'docs/design/construction-workflow/handoff.schema.json'), 'utf8'))
  const examplesDir = join(repo, 'docs/design/construction-workflow/examples')
  for (const f of readdirSync(examplesDir).filter((x) => x.endsWith('.json'))) {
    const errors = validateRecord(portableSchema, JSON.parse(readFileSync(join(examplesDir, f), 'utf8')))
    assert.equal(errors.length, 0, 'Portable 样例 ' + f + ': ' + errors.join('; '))
  }
})

test('AC-04：旧 Run 恢复沿用冻结 protocol 快照；信封字段可追溯', () => {
  const bp = tpl('wf-optimize.json')
  const frozen = freezeProtocolSnapshot(bp, 'digest-old')
  const { script } = compileBlueprint(bp)
  const agent = makeAgentScript({
    '目标确认': { route: 'READY', contract_digest: 'abc', summary: 'ok' },
  })
  const run1 = runGeneratedScript(script, {
    args: { taskId: 't1', entry: 'confirm' },
    agent,
  })
  const snap = {
    ...frozen,
    protocol_version: '1.0',
    script_digest: 'digest-old',
  }
  const upgraded = JSON.parse(JSON.stringify(bp))
  upgraded.protocol.version = '1.0'
  upgraded.protocol.required_capabilities.push('pattern')
  const { script: script2 } = compileBlueprint(upgraded)
  return run1.then((first) => {
    assert.ok(first.logs.some((l) => l.includes('[schema-protocol]')))
    return runGeneratedScript(script2, {
      args: { taskId: 't1', entry: 'confirm', protocol_snapshot: snap },
      agent,
    }).then((resumed) => {
      const resumedLog = resumed.logs.find((l) => l.includes('[schema-protocol]'))
      assert.ok(resumedLog)
      assert.ok(resumedLog.includes('digest-old'), '恢复应沿用旧 script_digest')
      const env = buildRuntimeEnvelope({
        protocol_version: snap.protocol_version,
        mode: snap.mode,
        run_id: 't1',
        node_id: 'confirm',
        host_call_id: null,
        script_digest: snap.script_digest,
        model: { provider: 'p', model: 'm' },
        inputs: { binding: 'x' },
        outputs: null,
        decision_ref: null,
        payload: { route: 'READY' },
      })
      assert.equal(env.attempt_ref, 'unavailable')
      assert.equal(env.payload.route, 'READY')
      assert.equal(env.producer, 'workflow-runtime')
    })
  })
})

test('legacy-unversioned 仍可读且 runtime 使用八关键字子集', () => {
  const legacy = {
    id: 'legacy-mini',
    displayName: 'legacy',
    entry: 'n',
    nodes: [{
      id: 'n', profile: 'dev', goal: 'g',
      output: {
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
          additionalProperties: false,
        },
        successCondition: '$.ok == true',
      },
    }],
    edges: [
      { from: 'n', to: '$end', on: 'success' },
      { from: 'n', to: 'n', on: 'failure' },
    ],
  }
  const r = validateBlueprint(legacy)
  assert.equal(r.ok, true)
  assert.ok(r.warnings.some((w) => w.includes('legacy-unversioned')))
  assert.equal(legacyInstanceValid(legacy.nodes[0].output.schema, { ok: true }), true)
  assert.equal(legacyInstanceValid(legacy.nodes[0].output.schema, { ok: false, extra: 1 }), false)
})

test('auditSchemaDefinition 拒绝 $ref 与拼写错误关键字', () => {
  const audit = auditSchemaDefinition({ type: 'object', properties: { x: { $ref: '#/defs/X' } } }, { mode: 'versioned', requiredCapabilities: ['type', 'properties'], path: '$.schema' })
  assert.ok(audit.errors.some((e) => e.message.includes('$ref')))
  const typo = auditSchemaDefinition({ type: 'object', mininum: 1 }, { mode: 'versioned', requiredCapabilities: ['type'], path: '$.schema' })
  assert.ok(typo.errors.some((e) => e.message.includes('未知 Schema 关键字')))
})

test('EXECUTION_KEYWORDS 覆盖规格 1.0 全集', () => {
  const expected = [
    'type', 'enum', 'const', 'properties', 'required', 'additionalProperties', 'items',
    'minItems', 'maxItems', 'minLength', 'maxLength', 'minimum', 'maximum', 'pattern',
    'oneOf', 'anyOf', 'allOf', 'not', 'if', 'then', 'else',
  ]
  for (const k of expected) assert.ok(EXECUTION_KEYWORDS.has(k), k)
  assert.equal(EXECUTION_KEYWORDS.size, expected.length)
})
