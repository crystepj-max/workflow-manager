// workspace-isolation-host.mjs 的只读注册表加载助手（供 node-isolation-host 复用，避免重复实现）。

import { readFileSync, existsSync } from 'node:fs'
import { createRegistry } from './workspace-isolation.mjs'

export function loadRegistryFromWorkRoot(workRoot) {
  const p = workRoot + '/.vwf-registry/state.json'
  const reg = createRegistry()
  if (!existsSync(p)) return reg
  const data = JSON.parse(readFileSync(p, 'utf-8'))
  if (data.workspaces) {
    for (const [k, v] of Object.entries(data.workspaces)) reg.workspaces.set(k, v)
  }
  if (data.locks) {
    for (const [k, v] of Object.entries(data.locks)) reg.locks.set(k, v)
  }
  if (data.locksByKey) {
    for (const [k, v] of Object.entries(data.locksByKey)) reg.locksByKey.set(k, v)
  }
  if (data.timeline) reg.timeline = data.timeline
  if (data.archived) {
    for (const [k, v] of Object.entries(data.archived)) reg.archived.set(k, v)
  }
  if (data.lockSeq) reg.lockSeq = data.lockSeq
  if (data.nextPort) reg.nextPort = data.nextPort
  if (data.ports) {
    for (const port of data.ports) reg.ports.add(port)
  }
  return reg
}
