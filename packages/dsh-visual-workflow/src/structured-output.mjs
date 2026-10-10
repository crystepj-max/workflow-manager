import { ToolArgsError, assertObjectJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'

export const name = 'vwf-structured-output'
export const inject = ['agents']
export const STRUCTURED_OUTPUT_TOOL = 'structured_output'

export const STRUCTURED_OUTPUT_INSTRUCTION = 'When you have your final answer, you MUST report it by calling the `structured_output` tool with arguments matching its parameter schema exactly. Do not finish with a plain text answer: only the tool call counts as your result.'

function attachStructuredOutput(agent, schema) {
  agent.ctx.inject(['tools', 'systemPrompt'], (childCtx) => {
    const staged = new WeakMap()
    let pending
    let captured

    childCtx.tools.register({
      name: STRUCTURED_OUTPUT_TOOL,
      description: 'Report your final structured result. Call this exactly once, when your answer is complete; the arguments must match this tool\'s parameter schema exactly.',
      parameters: schema,
      output: {
        schema: {
          type: 'object',
          properties: { recorded: { type: 'boolean', const: true } },
          required: ['recorded'],
          additionalProperties: false,
        },
        render: () => [{ type: 'text', text: 'Structured output recorded.' }],
      },
      execute(args, exec) {
        const violations = validateJsonSchemaValue(schema, args)
        if (violations.length) throw new ToolArgsError(violations)
        staged.set(exec, args)
        exec.concludeTurn()
        return Promise.resolve({ recorded: true })
      },
    })

    childCtx.systemPrompt.section({
      name: 'tool:' + STRUCTURED_OUTPUT_TOOL,
      order: childCtx.systemPrompt.getSectionOrder('STRUCTURED_OUTPUT'),
      text: STRUCTURED_OUTPUT_INSTRUCTION,
    })

    childCtx.tools.guard((exec) => captured === undefined && pending === undefined
      ? undefined
      : `structured output already recorded: the run is complete, so \`${exec.name}\` is not executed`)

    childCtx.on('tools/result', (exec, result) => {
      if (exec.name === STRUCTURED_OUTPUT_TOOL) {
        const value = staged.get(exec)
        if (value === undefined) return
        staged.delete(exec)
        if (result.isError) return
        if (exec.parent === undefined) {
          if (captured === undefined) captured = { value }
        } else if (captured === undefined && pending === undefined) {
          pending = { parent: exec.parent, value }
        }
        return
      }
      if (pending?.parent !== exec.token) return
      const entry = pending
      pending = undefined
      if (!result.isError && captured === undefined) captured = { value: entry.value }
    })
  })
}

export function apply(ctx, config) {
  const schema = config && config.schema
  assertObjectJsonSchema(schema)
  const installed = new WeakSet()
  const install = (agent) => {
    if (!agent || !agent.ctx || installed.has(agent)) return
    installed.add(agent)
    attachStructuredOutput(agent, schema)
  }
  ctx.on('agent/created', ({ agent }) => install(agent))
  for (const agent of ctx.agents.list()) install(agent)
}

export function buildStructuredOutputPatch(modulePath, schema) {
  if (typeof modulePath !== 'string' || !modulePath.startsWith('/') || modulePath.includes('\0')) {
    throw new TypeError('structured output module path must be an absolute path')
  }
  assertObjectJsonSchema(schema)
  return [
    '- insert:',
    '    - id: vwf-structured-output',
    '      name: ' + JSON.stringify(modulePath),
    '      config:',
    '        schema: ' + JSON.stringify(schema),
    '',
  ].join('\n')
}

function parseArguments(value) {
  if (typeof value === 'string') {
    try { return JSON.parse(value) } catch { return undefined }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

function successfulNativeResult(event) {
  const data = event && event.data
  const message = data && data.message
  if (!message || message.role !== 'tool' || !message.source || message.source.kind !== 'tool'
    || typeof message.source.callId !== 'string' || !Array.isArray(message.content)) return null
  if (data.error !== undefined) return null
  if (message.isError === true) return null
  return message.source.callId
}

/** Extract only a validated capture whose authoritative native/PTC result succeeded. */
export function extractStructuredOutput(events, schema) {
  assertObjectJsonSchema(schema)
  const calls = new Map()
  const runCodeCalls = new Set()
  const nativeResults = new Set()
  const ptcStarts = new Map()
  const ptcResults = new Map()
  const successfulResults = new Set()

  for (const event of Array.isArray(events) ? events : []) {
    const data = event && event.data
    if (!data || typeof data !== 'object') continue
    if (event.type === 'tool/call') {
      if (data.name === STRUCTURED_OUTPUT_TOOL && typeof data.callId === 'string') {
        calls.set(data.callId, parseArguments(data.arguments))
      }
      if (data.name === 'run_code' && typeof data.callId === 'string') runCodeCalls.add(data.callId)
      continue
    }
    if (event.type === 'tool/result') {
      const callId = successfulNativeResult(event)
      if (callId) {
        nativeResults.add(callId)
        successfulResults.add(callId)
      }
      continue
    }
    if (event.type === 'tool/ptc-dispatch-start' && data.name === STRUCTURED_OUTPUT_TOOL
      && typeof data.subCallId === 'string') {
      ptcStarts.set(data.subCallId, {
        value: parseArguments(data.arguments),
        rootCallId: data.rootCallId,
      })
      continue
    }
    if (event.type === 'tool/ptc-dispatch' && data.name === STRUCTURED_OUTPUT_TOOL
      && typeof data.subCallId === 'string') {
      ptcResults.set(data.subCallId, data.isError !== true)
    }
  }

  let captured
  for (const [callId, value] of calls) {
    if (!callId.startsWith('outer:') && value !== undefined && nativeResults.has(callId)) captured = value
  }
  for (const [subCallId, start] of ptcStarts) {
    if (start.value === undefined || ptcResults.get(subCallId) !== true) continue
    if (typeof start.rootCallId !== 'string' || !runCodeCalls.has(start.rootCallId)
      || !successfulResults.has(start.rootCallId)) continue
    captured = start.value
  }
  if (captured === undefined || validateJsonSchemaValue(schema, captured).length) return undefined
  return captured
}
