// 场景创建测试替身：代替 cwf-run-init.mjs，在临时项目里造 run 目录与工作树
// 用法：node fake-run-init.mjs <runDir> <taskId> <worktree>
import fs from 'node:fs'
import path from 'node:path'

const [runDir, taskId, worktree] = process.argv.slice(2)
const runId = path.basename(runDir)
fs.mkdirSync(runDir, { recursive: true })
fs.mkdirSync(worktree, { recursive: true })
fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({
  run_id: runId,
  issue_or_task_identity: `#${taskId}`,
  work_branch: `dev-${runId}`,
  stage: 'dev',
  worktree,
}, null, 2) + '\n')
console.log(JSON.stringify({ ok: true, runId, worktree }))
