import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ToolArgsError } from '@deepseek-ai/dsh-tools'
import {
  STRUCTURED_OUTPUT_TOOL,
  apply,
  buildStructuredOutputPatch,
  extractStructuredOutput,
} from '../src/structured-output.mjs'

const schema = {
  type: 'object',
  properties: { answer: { type: 'number' }, note: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false,
}

function mount(schemaValue = schema) {
  let onCreated
  let tool
  let guard
  const resultListeners = []
  const sections = []
  const childCtx = {
    tools: {
      register(value) { tool = value },
      guard(value) { guard = value },
    },
    systemPrompt: {
      section(value) { sections.push(value) },
      getSectionOrder() { return 50 },
    },
    on(name, listener) {
      if (name === 'tools/result') resultListeners.push(listener)
    },
  }
  const agent = { ctx: { inject(names, install) { assert.deepEqual(names, ['tools', 'systemPrompt']); install(childCtx) } } }
  const ctx = {
    agents: { list: () => [] },
    on(name, listener) { if (name === 'agent/created') onCreated = listener },
  }
  apply(ctx, { schema: schemaValue })
  onCreated({ agent })
  return {
    tool,
    guard,
    sections,
    result(exec, value) { for (const listener of resultListeners) listener(exec, value) },
  }
}

test('structured-output plugin registers the node schema and rejects invalid arguments', async () => {
  const mounted = mount()
  assert.equal(mounted.tool.name, STRUCTURED_OUTPUT_TOOL)
  assert.deepEqual(mounted.tool.parameters, schema)
  assert.equal(mounted.sections[0].name, 'tool:structured_output')
  let concluded = false
  assert.throws(() => mounted.tool.execute({ answer: 'wrong type' }, {
    concludeTurn() { concluded = true },
  }), ToolArgsError)
  assert.equal(concluded, false)
})

test('structured-output plugin treats only a successful native result as terminal', async () => {
  const mounted = mount()
  const failed = { name: STRUCTURED_OUTPUT_TOOL, token: 'failed', parent: undefined, concludeTurn() {} }
  await mounted.tool.execute({ answer: 1 }, failed)
  mounted.result(failed, { isError: true })
  assert.equal(mounted.guard({ name: 'read' }), undefined)

  const accepted = { name: STRUCTURED_OUTPUT_TOOL, token: 'accepted', parent: undefined, concludeTurn() {} }
  await mounted.tool.execute({ answer: 2 }, accepted)
  mounted.result(accepted, { isError: false })
  assert.match(mounted.guard({ name: 'read' }), /already recorded/)
})

test('structured-output plugin waits for successful outer PTC settlement', async () => {
  const mounted = mount()
  const capture = { name: STRUCTURED_OUTPUT_TOOL, token: 'inner', parent: 'outer', concludeTurn() {} }
  await mounted.tool.execute({ answer: 42 }, capture)
  mounted.result(capture, { isError: false })
  assert.match(mounted.guard({ name: 'read' }), /already recorded/)
  mounted.result({ name: 'run_code', token: 'outer' }, { isError: true })
  assert.equal(mounted.guard({ name: 'read' }), undefined)

  const committed = { name: STRUCTURED_OUTPUT_TOOL, token: 'inner-2', parent: 'outer-2', concludeTurn() {} }
  await mounted.tool.execute({ answer: 43 }, committed)
  mounted.result(committed, { isError: false })
  mounted.result({ name: 'run_code', token: 'outer-2' }, { isError: false })
  assert.match(mounted.guard({ name: 'read' }), /already recorded/)
})

test('structured result extraction requires successful schema-checked native tool result', () => {
  const toolResult = (callId, { isError = false, error } = {}) => ({
    type: 'tool/result',
    data: {
      message: {
        id: 'message-' + callId,
        role: 'tool',
        source: { kind: 'tool', callId },
        toolCallId: callId,
        content: [{ type: 'text', text: isError ? 'Invalid arguments.' : 'Structured output recorded.' }],
        ...(isError ? { isError: true } : {}),
      },
      ...(error ? { error } : {}),
    },
  })
  const events = [
    { type: 'tool/call', data: { callId: 'bad', name: STRUCTURED_OUTPUT_TOOL, arguments: '{"answer":"bad"}' } },
    toolResult('bad', { isError: true, error: { code: 'INVALID_ARGS' } }),
    { type: 'tool/call', data: { callId: 'good', name: STRUCTURED_OUTPUT_TOOL, arguments: '{"answer":42,"note":"ok"}' } },
    toolResult('good'),
  ]
  assert.deepEqual(extractStructuredOutput(events, schema), { answer: 42, note: 'ok' })
  assert.equal(extractStructuredOutput(events.slice(0, 2), schema), undefined)
})

test('structured result extraction waits for a successful outer PTC result', () => {
  const outerResult = (callId, failed = false) => ({
    type: 'tool/result',
    data: {
      message: {
        id: 'message-' + callId,
        role: 'tool',
        source: { kind: 'tool', callId },
        toolCallId: callId,
        content: [{ type: 'text', text: failed ? 'run_code failed.' : 'run_code completed.' }],
        ...(failed ? { isError: true } : {}),
      },
      ...(failed ? { error: { code: 'FAILED' } } : {}),
    },
  })
  const nested = [
    { type: 'tool/call', data: { callId: 'outer', name: 'run_code', arguments: '{}' } },
    { type: 'tool/ptc-dispatch-start', data: { rootCallId: 'outer', parentCallId: 'outer', subCallId: 'inner', name: STRUCTURED_OUTPUT_TOOL, arguments: { answer: 7 } } },
    { type: 'tool/ptc-dispatch', data: { rootCallId: 'outer', parentCallId: 'outer', subCallId: 'inner', name: STRUCTURED_OUTPUT_TOOL, arguments: { answer: 7 }, isError: false, content: [] } },
  ]
  assert.equal(extractStructuredOutput(nested, schema), undefined)
  assert.deepEqual(extractStructuredOutput([
    ...nested,
    outerResult('outer'),
  ], schema), { answer: 7 })
  assert.equal(extractStructuredOutput([
    ...nested,
    outerResult('outer', true),
  ], schema), undefined)
})

test('structured profile patch uses a literal absolute module path and JSON schema', () => {
  const patch = buildStructuredOutputPatch('/opt/vwf/dist/structured-output.mjs', schema)
  assert.match(patch, /name: "\/opt\/vwf\/dist\/structured-output\.mjs"/)
  assert.ok(patch.includes('schema: ' + JSON.stringify(schema)))
  assert.throws(() => buildStructuredOutputPatch('./relative.mjs', schema), /absolute path/)
})
