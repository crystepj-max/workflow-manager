import { readFileSync } from 'node:fs'

const store = JSON.parse(readFileSync(new URL('./configs.json', import.meta.url), 'utf8'))

export function loadEnv(name) {
  if (!Object.hasOwn(store, name)) throw new Error(`unknown env: ${name}`)
  return JSON.parse(JSON.stringify(store[name]))
}
