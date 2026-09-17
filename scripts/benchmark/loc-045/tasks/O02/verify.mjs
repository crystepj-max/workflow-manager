import assert from 'node:assert/strict'
import { loadEnv } from './load-env.mjs'

assert.deepEqual(loadEnv('dev'), { timeout: 30, retry: 2, endpoint: '/dev' })
assert.deepEqual(loadEnv('prod'), { timeout: 30, retry: 3, endpoint: '/prod' })
try {
  loadEnv('staging')
  assert.fail('unknown env')
} catch (e) {
  assert.match(String(e.message), /unknown env/)
}
const a = loadEnv('dev')
a.retry = 99
assert.equal(loadEnv('dev').retry, 2)
console.log('O02 verify: pass')
