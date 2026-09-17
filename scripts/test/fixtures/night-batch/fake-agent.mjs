// 夜间批次测试替身：模拟「独立 AI 施工会话」
// 用法：node fake-agent.mjs <runDir> <taskId>
// 行为由环境变量 FAKE_AGENT_PLAN（JSON）驱动：{ "<taskId>": { "delayMs": 100, "to": "…", "hang": false, "exit": false } }
// 并发探针：环境变量 FAKE_AGENT_PROBE（JSON 文件路径）——记录并发峰值，供测试断言不超过 maxConcurrency
import fs from 'node:fs'
import path from 'node:path'

const [runDir, taskId] = process.argv.slice(2)
const plan = JSON.parse(process.env.FAKE_AGENT_PLAN || '{}')
const behavior = plan[taskId] || { delayMs: 50, to: 'WAITING_HUMAN' }
const probePath = process.env.FAKE_AGENT_PROBE || null

function readProbe() {
  try { return JSON.parse(fs.readFileSync(probePath, 'utf8')) } catch { return { now: 0, max: 0 } }
}

if (probePath) {
  const cur = readProbe()
  cur.now += 1
  cur.max = Math.max(cur.max, cur.now)
  fs.writeFileSync(probePath, JSON.stringify(cur))
}

if (behavior.hang) {
  // 挂起不退出、不写释放事件——触发看门狗
  setInterval(() => {}, 1000)
} else {
  setTimeout(() => {
    if (probePath) {
      const cur = readProbe()
      cur.now -= 1
      fs.writeFileSync(probePath, JSON.stringify(cur))
    }
    if (behavior.exit) process.exit(0) // 退出但不写释放事件
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(path.join(runDir, 'release-event.json'), JSON.stringify({
      to: behavior.to || 'WAITING_HUMAN',
      blockedNode: behavior.to === 'BLOCKED' ? 'test' : null,
      reason: behavior.to === 'BLOCKED' ? '测试注入受阻' : null,
      reworkCount: behavior.to === 'BLOCKED' ? 2 : 0,
      nextStep: behavior.to === 'BLOCKED' ? '人工确认' : null,
    }, null, 2) + '\n')
    process.exit(0)
  }, behavior.delayMs ?? 50)
}
