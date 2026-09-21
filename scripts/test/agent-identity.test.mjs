import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { agentName, machineCode, newRecord, AGENT_IDENTITY_FILE } from '../local-task-registry.mjs'

const CLI = path.resolve(import.meta.dirname, '..', 'local-task-registry.mjs')

function tmpRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-identity-'))
}

/** 固定环境：只保留运行 node 所需的变量，避免把测试机自身的 agent 痕迹带进来。 */
function cleanEnv(extra = {}) {
  return { PATH: process.env.PATH, HOME: process.env.HOME, ...extra }
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
// 而不是安静写一条无归属的记录。走真实子进程，覆盖参数解析与 stderr 告警层。
test('CLI allocate：取不到 agent 身份时在 stderr 告警，且不伪造身份', () => {
  const repo = tmpRepo()
  const r = spawnSync(process.execPath, [CLI, 'allocate', '--name', '无身份样例', '--type', 'FIX', '--offline', '--repo', repo], {
    encoding: 'utf8',
    env: cleanEnv(),
  })
  assert.equal(r.status, 0, `allocate 不应失败：${r.stderr}`)
  assert.match(r.stderr, /未识别到 agent 身份/)
  assert.equal(readRegistry(repo).tasks.at(-1).origin_agent, null, '取不到身份时不得编造归属')
})

test('CLI allocate：会话自报身份时静默记录，且登记册带 agent 名', () => {
  const repo = tmpRepo()
  const r = spawnSync(process.execPath, [CLI, 'allocate', '--name', '有身份样例', '--type', 'FIX', '--offline', '--repo', repo], {
    encoding: 'utf8',
    env: cleanEnv({ AI_AGENT_NAME: 'ZCODE' }),
  })
  assert.equal(r.status, 0, `allocate 不应失败：${r.stderr}`)
  assert.doesNotMatch(r.stderr, /未识别到 agent 身份/)
  assert.equal(JSON.parse(r.stdout).origin_agent, 'ZCODE')
  assert.equal(readRegistry(repo).tasks.at(-1).origin_agent, 'ZCODE')
})
