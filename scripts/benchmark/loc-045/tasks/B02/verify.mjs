import assert from 'node:assert/strict'
import { validateConfig } from './validate-config.mjs'

assert.deepEqual(validateConfig({ port: 8080 }), { ok: true })
assert.equal(validateConfig({ port: 8080 }).ok, true)
assert.equal(validateConfig({ port: 0 }).ok, false)
assert.equal(validateConfig({ port: 'x' }).ok, false)
// name 必填为实施后行为；基线夹具不强制
console.log('B02 verify: pass (baseline port rules)')
