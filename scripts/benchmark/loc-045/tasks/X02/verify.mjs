import assert from 'node:assert/strict'
import { fetchMaterial, setRound } from './material-tool.mjs'

setRound('first')
assert.equal(fetchMaterial('cost').status, 'TEMP_UNAVAILABLE')
assert.equal(fetchMaterial('feature').status, 'OK')
setRound('supplement')
assert.equal(fetchMaterial('cost').status, 'OK')
console.log('X02 verify: pass')
