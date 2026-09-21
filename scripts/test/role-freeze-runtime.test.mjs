// FIX-226（决策 3=A）：自定义角色正文的运行期冻结 —— 端到端行为测试。
// 规格 §15 验收条件对应的机器可验证部分：
//   AC-01 等待期间改写角色文件，恢复后节点角色正文仍是运行时那一版
//   AC-02 同一运行重复恢复三次，三次读到的角色正文完全一致
//   AC-03 新建运行读到修改后的角色正文（冻结只作用于已存在的运行）
// 方法：真实编译 dev-workflow-2-0（其 dispatch/route 节点用自定义角色 dispatcher），
// 在独立角色源目录里改写角色文件，再用同一份已编译译文真实执行——断言注入 prompt 的
// 角色正文逐字不变（不是字符串嗅探，而是运行时实际注入文本）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { compileBlueprint } from '../generate.mjs'
import { runGeneratedScript, makeAgentScript } from './helpers/runtime-harness.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..', '..')
const ROLES_SRC = path.join(root, 'dsh', 'roles')
const tpl = JSON.parse(readFileSync(path.join(root, 'templates', 'custom-seeds', 'dev-workflow-2-0.json'), 'utf8'))

const ORIGINAL = readFileSync(path.join(ROLES_SRC, 'dispatcher.md'), 'utf8')
const EDITED = ORIGINAL + '\n\n【已改版】本轮只做只读研究\n'

const ROLE_MARK = '【角色定义】（自定义角色，编译期内联，运行起始冻结）：\n'

// 独立角色源目录：内置与自定义角色一并拷贝，可安全改写（不动仓库 dsh/roles）
function makeRolesDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'vwf-freeze-'))
  for (const f of readdirSync(ROLES_SRC)) {
    if (f.endsWith('.md')) writeFileSync(path.join(dir, f), readFileSync(path.join(ROLES_SRC, f), 'utf8'), 'utf8')
  }
  return dir
}

const TABLE = {
  调度: { complete: true, missing: [], need_integration_test: true, reason: 'ok' },
  开发: { status: 'completed', summary: 's', self_verify: 'v' },
  测试: { result: 'PASSED', reason: 'r', evidence: 'e', verified_branch: 'dev2/task', verified_head: 'abc123' },
  审核: { verdict: 'APPROVE', summary: 's', verified_branch: 'dev2/task', verified_head: 'abc123' },
  人工验收: { verdict: 'PASS', summary_for_human: 's', details: 'd', verified_branch: 'dev2/task', verified_head: 'abc123' },
}

// 取运行时实际注入该节点的角色正文段（标记之后、运行上下文之前）
function injectedRoleDef(prompt) {
  const start = prompt.indexOf(ROLE_MARK)
  assert.ok(start >= 0, 'prompt 未含自定义角色内联标记：' + prompt.slice(0, 120))
  const from = start + ROLE_MARK.length
  const end = prompt.indexOf('\n\n---\n\n## 运行上下文', from)
  assert.ok(end > from, 'prompt 未含运行上下文分隔，无法定位注入段')
  return prompt.slice(from, end)
}

const dispatchPrompt = (agent) => {
  const c = agent.calls.find((x) => x.label === '调度')
  assert.ok(c, '调度节点应出场（实际 ' + JSON.stringify(agent.calls.map((x) => x.label)) + '）')
  return c.prompt
}

test('AC-01 等待期间改写角色文件，已编译运行仍按运行时那一版角色行事', async () => {
  const dir = makeRolesDir()
  try {
    const { script } = compileBlueprint(tpl, { rolesDir: dir })
    // 编译之后（= 运行已开始）改写工作区角色文件
    writeFileSync(path.join(dir, 'dispatcher.md'), EDITED, 'utf8')

    const agent = makeAgentScript(TABLE)
    await runGeneratedScript(script, { args: {}, agent })

    const prompt = dispatchPrompt(agent)
    assert.equal(injectedRoleDef(prompt), ORIGINAL, '注入的角色正文仍是运行时那一版（逐字一致）')
    assert.ok(!prompt.includes('【已改版】'), '改写后的内容不得进入本 Run')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('AC-02 同一运行重复恢复三次，三次读到的角色正文完全一致', async () => {
  const dir = makeRolesDir()
  try {
    const { script } = compileBlueprint(tpl, { rolesDir: dir })
    writeFileSync(path.join(dir, 'dispatcher.md'), EDITED, 'utf8')

    const seen = []
    for (let i = 0; i < 3; i++) {
      // 同一份 Rev1 冻结译文续跑（宿主续跑恒用首版脚本，FIX-226 断言其角色正文亦冻结）
      const agent = makeAgentScript(TABLE)
      await runGeneratedScript(script, { args: { entry: 'dispatch' }, agent })
      seen.push(injectedRoleDef(dispatchPrompt(agent)))
    }
    assert.equal(seen[0], ORIGINAL, '第 1 次恢复 = 运行时那一版')
    assert.equal(seen[1], seen[0], '第 2 次恢复与第 1 次逐字一致')
    assert.equal(seen[2], seen[1], '第 3 次恢复与第 2 次逐字一致')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('AC-03 新建运行读到修改后的角色正文（冻结只作用于已存在的运行）', async () => {
  const dir = makeRolesDir()
  try {
    const first = compileBlueprint(tpl, { rolesDir: dir })
    writeFileSync(path.join(dir, 'dispatcher.md'), EDITED, 'utf8')
    // 已有运行不受影响
    const a1 = makeAgentScript(TABLE)
    await runGeneratedScript(first.script, { args: {}, agent: a1 })
    assert.equal(injectedRoleDef(dispatchPrompt(a1)), ORIGINAL, '已存在的运行仍用旧版')

    // 重新编译 = 新运行：读到修改后的正文
    const second = compileBlueprint(tpl, { rolesDir: dir })
    assert.notEqual(second.script, first.script, '内容变化必然产生不同译文')
    const a2 = makeAgentScript(TABLE)
    await runGeneratedScript(second.script, { args: {}, agent: a2 })
    assert.equal(injectedRoleDef(dispatchPrompt(a2)), EDITED, '新建运行读到修改后的角色正文')
    assert.notEqual(
      second.roles.find((r) => r.id === 'dispatcher').digest,
      first.roles.find((r) => r.id === 'dispatcher').digest,
      '新编译的角色摘要随内容变化（快照可回答「本 Run 用的是哪一版」）',
    )
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('AC-05 角色文件读不到：运行仍继续，角色降级为读文件路径（不崩溃）', async () => {
  const dir = makeRolesDir()
  try {
    rmSync(path.join(dir, 'dispatcher.md'), { force: true })
    const { script, roles } = compileBlueprint(tpl, { rolesDir: dir })
    const disp = roles.find((r) => r.id === 'dispatcher')
    assert.equal(disp.inlined, false, '读不到即未内联')
    assert.equal(disp.reason, 'unreadable', '降级原因如实标注')

    const agent = makeAgentScript(TABLE)
    const { result } = await runGeneratedScript(script, { args: {}, agent })
    assert.equal(result.status, 'AWAITING_HUMAN_accept', '运行仍能走到人工门禁（不因角色读不到而失败）')
    const prompt = dispatchPrompt(agent)
    assert.ok(!prompt.includes(ROLE_MARK), '未内联时不出现内联标记')
    assert.ok(prompt.includes('dsh/roles/dispatcher.md'), '降级为读文件路径提示（如实告知未冻结）')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
