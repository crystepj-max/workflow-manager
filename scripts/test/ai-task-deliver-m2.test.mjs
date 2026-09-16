import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const checkScript = path.join(root, 'scripts/ai-task-deliver-m2-check.mjs')

test('M2 机械验收脚本通过', () => {
  const r = spawnSync(process.execPath, [checkScript], {
    encoding: 'utf8',
    cwd: root,
  })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /"auto_rework_limit": 3/)
  assert.match(r.stdout, /conditional_pass/)
})

// CHORE-36：验收项执行时机规则要有机器咬合——模板缺字段时必须失败并指名该字段。
// 用 --root 搭临时根，保证「唯一变量 = 模板缺了字段」，不靠改仓库真源来测。
test('UAT 卡模板缺「执行时机」字段时，机械检查必须失败并指名该字段', () => {
  // 注意：必须用 realpath 后的临时目录。macOS 上 /tmp 与 os.tmpdir() 返回的 /var/... 都是
  // 符号链接，被 spawn 的脚本（如 ai-task-preflight-check.mjs）以 `path.resolve(argv[1])`
  // 对比 `import.meta.url` 判定是否 CLI——路径不一致时它会静默什么都不做（退出码 0）。
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'chore36-m2-check-'))
  try {
    for (const dir of ['docs', 'dsh', 'scripts']) {
      fs.cpSync(path.join(root, dir), path.join(tmp, dir), { recursive: true })
    }
    // 先证明临时根本身能通过（排除「临时根缺别的文件」造成的假失败）
    const before = spawnSync(process.execPath, [checkScript, '--root', tmp], { encoding: 'utf8', cwd: root })
    assert.equal(before.status, 0, before.stdout + before.stderr)

    // 再证明确实是「缺字段」导致失败
    const cardPath = path.join(tmp, 'docs/design/ai-task-define-delivery/uat-card-template.md')
    const original = fs.readFileSync(cardPath, 'utf8')
    const stripped = original
      .split('\n')
      .filter((line) => !line.includes('执行时机'))
      .join('\n')
    assert.notEqual(stripped, original, '模板里应存在可被移除的「执行时机」字样')
    fs.writeFileSync(cardPath, stripped)

    const after = spawnSync(process.execPath, [checkScript, '--root', tmp], { encoding: 'utf8', cwd: root })
    assert.notEqual(after.status, 0, '模板缺「执行时机」字段时检查必须失败')
    assert.match(after.stderr + after.stdout, /执行时机/, '失败信息须指名「执行时机」')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
