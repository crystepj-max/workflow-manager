import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

export function loadTaskRegistry(root = ROOT) {
  const raw = JSON.parse(readFileSync(join(root, 'tasks.json'), 'utf8'))
  const byId = new Map(raw.tasks.map((t) => [t.id, t]))
  return { ...raw, byId, root }
}

export function listPlannedTrials(registry) {
  const trials = []
  for (const [armId, arm] of Object.entries(registry.arms)) {
    for (const taskId of arm.tasks) {
      for (let repeat = 1; repeat <= arm.repeats; repeat++) {
        trials.push({
          trial_id: `${armId}-${taskId}-r${repeat}`,
          task_id: taskId,
          arm: armId,
          repeat,
          order: registry.repeat_order[(repeat - 1) % registry.repeat_order.length],
          template: registry.byId.get(taskId)?.template ?? null,
        })
      }
    }
  }
  return trials
}

export function maxLogicalRuns(registry) {
  return listPlannedTrials(registry).length
}
