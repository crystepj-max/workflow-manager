export function validateConfig(obj) {
  if (!obj || typeof obj !== 'object') {
    return { ok: false, error: 'invalid' }
  }
  const port = obj.port
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: 'invalid port' }
  }
  return { ok: true }
}
