// 收口交付动作运行时集成（LOC-037 / WR-014）：宿主侧接线验收
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path, { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadHost } from './helpers/load-host.mjs'
import { REPO, makeFs, makeSubprocess, sandboxPolicy } from './helpers/fake-services.mjs'
import { executeCloseout, gatherFacts, planActions } from '../../../scripts/delivery-closeout-host.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const DELIVERY_HOST_SRC = readFileSync(join(here, '..', '..', '..', 'scripts', 'delivery-closeout-host.mjs'), 'utf8')

const realDeliveryHost = (dir) => (cmd, input) => {
  const MAP = { 'gather-facts': gatherFacts, 'plan-actions': planActions, closeout: executeCloseout }
  return MAP[cmd]({ ...input, operations_dir: input.operations_dir || dir })
}

function env({ deployed = true, deliveryCloseoutHost = null, seed = {} } = {}) {
  const base = deployed
    ? { [REPO + '/scripts/delivery-closeout-host.mjs']: DELIVERY_HOST_SRC, ...seed }
    : { ...seed }
  const fs = makeFs(base)
  const sub = makeSubprocess({ fs, deliveryCloseoutHost })
  const { handlers } = loadHost({
    fs, subprocess: sub, sandboxPolicy,
    agents: { requireInitiator: () => ({}) },
  })
  return { handlers, fs, sub }
}

const INPUT = {
  run_id: 'loc-037-host',
  delivery_scope: 'non-git',
  candidate_ref: { head: 'abc', digest: 'sha256-abc' },
  acceptance: { decision: 'accept' },
  reports: [{ name: 'uat-card', path: 'uat-card.md' }],
}

test('W1 vwf.delivery.closeout：非 Git 可 DELIVERED', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vwf-delivery-host-'))
  const { handlers } = env({ deliveryCloseoutHost: realDeliveryHost(dir) })
  const r = await handlers.get('vwf.delivery.closeout')({ ...INPUT, include_cleanup: false, operations_dir: dir })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.status, 'DELIVERED')
  assert.ok(r.delivery_report)
})

test('W2 vwf.delivery.* 参数校验 fail-closed', async () => {
  const { handlers } = env({})
  assert.equal((await handlers.get('vwf.delivery.gatherFacts')({})).ok, false)
  assert.equal((await handlers.get('vwf.delivery.planActions')({})).ok, false)
  assert.equal((await handlers.get('vwf.delivery.closeout')({})).ok, false)
})

test('W3 delivery-closeout-host.mjs 未部署 → notFound', async () => {
  const { handlers } = env({ deployed: false })
  const r = await handlers.get('vwf.delivery.closeout')(INPUT)
  assert.equal(r.ok, false)
  assert.equal(r.notFound, true)
})

test('W4 gatherFacts / planActions RPC 接线', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vwf-delivery-host-'))
  const { handlers } = env({ deliveryCloseoutHost: realDeliveryHost(dir) })
  const facts = await handlers.get('vwf.delivery.gatherFacts')(INPUT)
  assert.equal(facts.ok, true)
  assert.equal(facts.delivery_report.read_only, true)
  const plan = await handlers.get('vwf.delivery.planActions')({ ...INPUT, delivery_scope: 'non-git' })
  assert.equal(plan.ok, true)
  assert.equal(plan.action_plan.required_actions.length, 0)
})
