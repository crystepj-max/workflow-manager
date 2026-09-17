import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export function emptyTrialRecord({ trial_id, task_id, arm, repeat, order, freeze }) {
  return {
    trial_id,
    task_id,
    arm,
    repeat,
    pairing_order: order,
    status: 'NOT_EXECUTED',
    fixture_digest: freeze?.fixture_digests?.[task_id] ?? null,
    template_digest: freeze?.template_digests ?? null,
    script_digest: freeze?.script_digest ?? null,
    baseline_digest: freeze?.baseline_digest ?? null,
    model_settings: freeze?.model_settings ?? null,
    model_calls: [],
    auto_wall_clock_ms: null,
    human_wait_ms: null,
    quality_checks: [],
    evidence_refs: [],
    human_events: [],
    usage: { tokens: null, cost: 'unavailable', source: null },
    failure_reason: null,
    started_at: null,
    ended_at: null,
    created_at: new Date().toISOString(),
    record_id: randomUUID(),
  }
}

export function writeTrialRecord(resultsDir, record) {
  mkdirSync(resultsDir, { recursive: true })
  const path = join(resultsDir, `${record.trial_id}.json`)
  writeFileSync(path, JSON.stringify(record, null, 2) + '\n', 'utf8')
  return path
}

export function readTrialRecord(resultsDir, trialId) {
  const path = join(resultsDir, `${trialId}.json`)
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function loadAllTrialRecords(resultsDir) {
  if (!existsSync(resultsDir)) return []
  return readdirSync(resultsDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(resultsDir, f), 'utf8')))
}
