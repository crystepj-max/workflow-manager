#!/usr/bin/env node
import { createProviderRoutes } from './node-provider-routes.mjs'

try {
  const command = process.argv[2]
  if (command !== 'createRoutes') throw new Error('unknown node provider host command')
  const input = process.argv[3] ? JSON.parse(process.argv[3]) : {}
  process.stdout.write(JSON.stringify(createProviderRoutes(input)))
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(error && error.message || error) }))
}
