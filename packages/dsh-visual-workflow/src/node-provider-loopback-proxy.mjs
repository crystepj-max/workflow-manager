import http from 'node:http'
import net from 'node:net'
import tls from 'node:tls'

const MODEL_HOST = 'api.deepseek.com'
const MODEL_PORT = 443
const MAX_OPEN_SOCKETS = 16
const CONNECT_TIMEOUT_MS = 15000
const MAX_PROXY_RESPONSE_BYTES = 16 * 1024

function proxyValue(env, lower, upper) {
  const lowercase = typeof env[lower] === 'string' ? env[lower].trim() : ''
  if (lowercase) return lowercase
  const uppercase = typeof env[upper] === 'string' ? env[upper].trim() : ''
  return uppercase || ''
}

function noProxyMatches(host, port, value) {
  const entries = String(value || '').split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean)
  return entries.some((entry) => {
    if (entry === '*') return true
    const normalized = entry.startsWith('.') ? entry.slice(1) : entry
    const colon = normalized.lastIndexOf(':')
    const entryPort = colon > 0 ? normalized.slice(colon + 1) : ''
    const entryHost = colon > 0 ? normalized.slice(0, colon) : normalized
    if (entryPort && entryPort !== String(port)) return false
    return host === entryHost || host.endsWith('.' + entryHost)
  })
}

export function resolveModelUpstreamProxy(env = process.env) {
  const noProxy = proxyValue(env, 'no_proxy', 'NO_PROXY')
  if (noProxyMatches(MODEL_HOST, MODEL_PORT, noProxy)) return null
  const raw = proxyValue(env, 'https_proxy', 'HTTPS_PROXY')
    || proxyValue(env, 'http_proxy', 'HTTP_PROXY')
    || proxyValue(env, 'all_proxy', 'ALL_PROXY')
  if (!raw) return null
  let url
  try { url = new URL(raw) } catch { throw new Error('configured outbound proxy URL is invalid') }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
    throw new Error('configured outbound proxy must use HTTP or HTTPS')
  }
  return url
}

function connectSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = url.protocol === 'https:'
      ? tls.connect({ host: url.hostname, port: Number(url.port || 443), servername: url.hostname })
      : net.connect({ host: url.hostname, port: Number(url.port || 80) })
    let settled = false
    const readyEvent = url.protocol === 'https:' ? 'secureConnect' : 'connect'
    const timer = setTimeout(() => finish(new Error('outbound proxy connection timed out')), CONNECT_TIMEOUT_MS)
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.off(readyEvent, onReady)
      socket.off('error', onError)
      if (error) {
        socket.destroy()
        reject(error)
      } else {
        resolve(socket)
      }
    }
    const onReady = () => finish(null)
    const onError = () => finish(new Error('outbound proxy connection failed'))
    socket.once(readyEvent, onReady)
    socket.once('error', onError)
  })
}

function proxyAuthorization(url) {
  if (!url.username && !url.password) return ''
  const user = decodeURIComponent(url.username)
  const password = decodeURIComponent(url.password)
  return 'Proxy-Authorization: Basic ' + Buffer.from(user + ':' + password).toString('base64') + '\r\n'
}

async function openUpstreamTunnel(proxyUrl) {
  const socket = await connectSocket(proxyUrl)
  const authority = MODEL_HOST + ':' + MODEL_PORT
  const request = 'CONNECT ' + authority + ' HTTP/1.1\r\n'
    + 'Host: ' + authority + '\r\n'
    + proxyAuthorization(proxyUrl)
    + 'Proxy-Connection: keep-alive\r\n\r\n'

  return new Promise((resolve, reject) => {
    let response = Buffer.alloc(0)
    let settled = false
    const timer = setTimeout(() => finish(new Error('outbound proxy CONNECT timed out')), CONNECT_TIMEOUT_MS)
    const finish = (error, remainder) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.off('data', onData)
      socket.off('error', onError)
      if (error) {
        socket.destroy()
        reject(error)
      } else {
        socket.setTimeout(0)
        socket.pause()
        resolve({ socket, remainder })
      }
    }
    const onError = () => finish(new Error('outbound proxy CONNECT failed'))
    const onData = (chunk) => {
      response = Buffer.concat([response, chunk])
      if (response.length > MAX_PROXY_RESPONSE_BYTES) return finish(new Error('outbound proxy response headers exceeded limit'))
      const boundary = response.indexOf('\r\n\r\n')
      if (boundary < 0) return
      const header = response.subarray(0, boundary).toString('latin1')
      const status = /^HTTP\/\d(?:\.\d)?\s+(\d{3})\b/i.exec(header)
      if (!status || status[1] !== '200') return finish(new Error('outbound proxy refused the model connection'))
      finish(null, response.subarray(boundary + 4))
    }
    socket.once('error', onError)
    socket.on('data', onData)
    socket.write(request)
  })
}

function parseConnectAuthority(value) {
  const match = /^([a-z0-9.-]+):(\d{1,5})$/i.exec(String(value || ''))
  if (!match) return null
  return { host: match[1].toLowerCase().replace(/\.$/, ''), port: Number(match[2]) }
}

function rejectConnect(socket, status, message) {
  if (socket.destroyed) return
  socket.end('HTTP/1.1 ' + status + ' ' + message + '\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
}

export async function createDeepSeekApiLoopbackProxy(options = {}) {
  const env = options.env || process.env
  const upstreamProxy = resolveModelUpstreamProxy(env)
  const sockets = new Set()
  let closed = false
  const server = http.createServer((_request, response) => {
    response.writeHead(405, { connection: 'close', 'content-length': '0' })
    response.end()
  })
  server.maxConnections = MAX_OPEN_SOCKETS
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  server.on('connect', async (request, client, head) => {
    const target = parseConnectAuthority(request.url)
    if (!target || target.host !== MODEL_HOST || target.port !== MODEL_PORT) {
      rejectConnect(client, 403, 'Forbidden')
      return
    }
    let upstream
    try {
      if (upstreamProxy) {
        const opened = await openUpstreamTunnel(upstreamProxy)
        upstream = opened.socket
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (opened.remainder.length) client.write(opened.remainder)
      } else {
        upstream = net.connect({ host: MODEL_HOST, port: MODEL_PORT })
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => finish(new Error('DeepSeek API connection timed out')), CONNECT_TIMEOUT_MS)
          const finish = (error) => {
            clearTimeout(timer)
            upstream.off('connect', onConnect)
            upstream.off('error', onError)
            if (error) reject(error)
            else resolve()
          }
          const onConnect = () => finish(null)
          const onError = () => finish(new Error('DeepSeek API connection failed'))
          upstream.once('connect', onConnect)
          upstream.once('error', onError)
        })
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      }
      if (head.length) upstream.write(head)
      sockets.add(upstream)
      upstream.once('close', () => sockets.delete(upstream))
      upstream.on('error', () => client.destroy())
      client.on('error', () => upstream.destroy())
      client.pipe(upstream)
      upstream.pipe(client)
    } catch {
      upstream?.destroy()
      rejectConnect(client, 502, 'Bad Gateway')
    }
  })

  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error)
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string' || !Number.isInteger(address.port)) {
    server.close()
    throw new Error('loopback proxy did not receive a local port')
  }

  return {
    host: '127.0.0.1',
    port: address.port,
    proxyUrl: 'http://127.0.0.1:' + address.port,
    async close() {
      if (closed) return
      closed = true
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}
