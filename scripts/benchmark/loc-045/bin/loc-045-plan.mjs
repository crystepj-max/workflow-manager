#!/usr/bin/env node
import { loadTaskRegistry, listPlannedTrials, maxLogicalRuns } from '../lib/task-registry.mjs'

const registry = loadTaskRegistry()
const trials = listPlannedTrials(registry)
console.log(JSON.stringify({
  planned_runs: maxLogicalRuns(registry),
  arms: registry.arms,
  trials,
}, null, 2))
