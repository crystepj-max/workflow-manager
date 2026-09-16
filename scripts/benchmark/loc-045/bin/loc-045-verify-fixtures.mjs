#!/usr/bin/env node
import { loadTaskRegistry } from '../lib/task-registry.mjs'
import { verifyAllFixtures, allFixturesPass } from '../lib/quality.mjs'

const registry = loadTaskRegistry()
const results = verifyAllFixtures(registry)
const ok = allFixturesPass(results)
console.log(JSON.stringify({ ok, results }, null, 2))
process.exit(ok ? 0 : 1)
