#!/usr/bin/env node
import { prepareExperiment } from '../lib/runner.mjs'

const result = prepareExperiment()
console.log(JSON.stringify(result, null, 2))
