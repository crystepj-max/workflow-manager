#!/usr/bin/env node
import { writeResearchReport } from '../lib/report.mjs'

const { jsonPath, mdPath, report } = writeResearchReport()
console.log(JSON.stringify({
  ok: true,
  status: report.status,
  jsonPath,
  mdPath,
  planned_runs: report.planned_runs,
}, null, 2))
