import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { agentName, machineCode, newRecord, allocate, AGENT_IDENTITY_FILE } from '../local-task-registry.mjs'

function tmpRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-identity-'))
}

/**
 * 函数级固定身份环境：暂时摘除运行环境的自报身份变量（AI_AGENT_NAME /
 * CLIENT_INFO_IDE_TYPE / 任何 *_AGENT_NAME），避免测试机自身痕迹混进断言。
 * （旧版两个用例经 CLI allocate 子进程覆盖；CLI 写命令自 W8 P0-C fail-closed
 * 后改走函数级，告警与「不伪造归属」语义不变。）
 */
function withoutAgentEnv(run) {
  const removed = []
  for (const k of Object.keys(process.env)) {
    if (k === 'AI_AGENT_NAME' || k === 'CLIENT_INFO_IDE_TYPE' || /_AGENT_NAME$/.test(k)) {
      removed.push([k, process.env[k]])
      delete process.env[k]
    }
  }
  try {
    return run()
  } finally {
    for (const [k, v] of removed) process.env[k] = v
  }
}

function readRegistry(repo) {
  return JSON.parse(fs.readFileSync(path.join(repo, 'docs', 'tasks', 'registry.json'), 'utf-8'))
}

test('agentName：AI_AGENT_NAME 显式覆盖优先级最高', () => {
  const env = { AI_AGENT_NAME: 'ZCODE', CLIENT_INFO_IDE_TYPE: 'WorkBuddy', FOO_AGENT_NAME: 'x' }
  assert.equal(agentName(env, tmpRepo()), 'ZCODE')
})

test('agentName：无显式覆盖时取宿主自报（CLIENT_INFO_IDE_TYPE）', () => {
  const env = { CLIENT_INFO_IDE_TYPE: 'WorkBuddy', FOO_AGENT_NAME: 'x' }
  assert.equal(agentName(env, tmpRepo()), 'WorkBuddy')
})

test('agentName：宿主无标识时按通用约定识别任意 *_AGENT_NAME', () => {
  assert.equal(agentName({ CURSOR_AGENT_NAME: 'Cursor' }, tmpRepo()), 'Cursor')
  assert.equal(agentName({ CODEX_AGENT_NAME: 'Codex' }, tmpRepo()), 'Codex')
})

test('agentName：指纹变量为空串不视为命中，继续向后取值', () => {
  const env = { AI_AGENT_NAME: '   ', CLIENT_INFO_IDE_TYPE: '', CODEX_AGENT_NAME: 'Codex' }
  assert.equal(agentName(env, tmpRepo()), 'Codex')
})

test('agentName：环境无痕迹时回落到工作树 .agent-identity 文件', () => {
  const repo = tmpRepo()
  fs.writeFileSync(path.join(repo, AGENT_IDENTITY_FILE), 'DSH\n')
  assert.equal(agentName({}, repo), 'DSH')
})

test('agentName：三级全空返回 null（不猜、不给默认值）', () => {
  assert.equal(agentName({}, tmpRepo()), null)
})

test('newRecord：origin_agent 由 agentName 填充，与机器码并列留痕', () => {
  const repo = tmpRepo()
  fs.writeFileSync(path.join(repo, AGENT_IDENTITY_FILE), 'WorkBuddy')
  const record = newRecord({ taskId: 'FIX-999', name: '样例任务', type: 'FIX', repo })
  assert.equal(record.origin_agent, 'WorkBuddy')
  assert.equal(record.origin_machine, machineCode())
})

// 归属静默留空是历史缺陷（88 条记录里 87 条为空）。取不到身份必须出声，
// 而不是安静写一条无归属的记录。
test('allocate：取不到 agent 身份时在 stderr 告警，且不伪造身份', () => {
  const repo = tmpRepo()
  const errors = []
  const prevErr = console.error
  console.error = (msg) => errors.push(String(msg))
  try {
    const rec = withoutAgentEnv(() => allocate(repo, { name: '无身份样例', type: 'FIX', offline: true }))
    assert.equal(rec.origin_agent, null, '取不到身份时不得编造归属')
    assert.match(errors.join('\n'), /未识别到 agent 身份/)
    assert.equal(readRegistry(repo).tasks.at(-1).origin_agent, null)
  } finally {
    console.error = prevErr
  }
})

test('allocate：会话自报身份时静默记录，且登记册带 agent 名', () => {
  const repo = tmpRepo()
  const had = 'AI_AGENT_NAME' in process.env
  const prev = process.env.AI_AGENT_NAME
  const errors = []
  const prevErr = console.error
  console.error = (msg) => errors.push(String(msg))
  process.env.AI_AGENT_NAME = 'ZCODE'
  try {
    const rec = allocate(repo, { name: '有身份样例', type: 'FIX', offline: true })
    assert.equal(rec.origin_agent, 'ZCODE')
    assert.doesNotMatch(errors.join('\n'), /未识别到 agent 身份/)
    assert.equal(readRegistry(repo).tasks.at(-1).origin_agent, 'ZCODE')
  } finally {
    console.error = prevErr
    if (had) process.env.AI_AGENT_NAME = prev
    else delete process.env.AI_AGENT_NAME
  }
})
