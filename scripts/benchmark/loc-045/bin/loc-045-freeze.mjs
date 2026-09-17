#!/usr/bin/env node
import { computeFreeze, writeFreezeManifest } from '../lib/freeze.mjs'

const freeze = computeFreeze()
const path = writeFreezeManifest(undefined, freeze)
console.log(JSON.stringify({ ok: true, freeze_manifest: path, frozen_at: freeze.frozen_at }, null, 2))
