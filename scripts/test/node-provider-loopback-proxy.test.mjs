import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { createDeepSeekApiLoopbackProxy, resolveModelUpstreamProxy } from '../../packages/dsh-visual-workflow/src/node-provider-loopback-proxy.mjs'

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve(server.address().port)
    })
  })
}

function connect(proxyPort, target) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: proxyPort })
    let response = Buffer.alloc(0)
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('CONNECT response timed out'))
    }, 3000)
    const onError = (error) => {
      clearTimeout(timer)
      reject(error)
    }
    socket.once('error', onError)
    socket.once('connect', () => {
      socket.write('CONNECT ' + target + ' HTTP/1.1\r\nHost: ' + target + '\r\n\r\n')
    })
    const onData = (chunk) => {
      response = Buffer.concat([response, chunk])
      const boundary = response.indexOf('\r\n\r\n')
      if (boundary < 0) return
      clearTimeout(timer)
      socket.off('data', onData)
      socket.off('error', onError)
      socket.pause()
      const header = response.subarray(0, boundary).toString('latin1')
      const status = Number(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/i.exec(header)?.[1])
      resolve({ socket, status, remainder: response.subarray(boundary + 4) })
    }
    socket.on('data', onData)
  })
}

test('loopback model proxy only listens on localhost and rejects hosts outside the official API allowlist', async () => {
  const proxy = await createDeepSeekApiLoopbackProxy({ env: {} })
  try {
    assert.equal(proxy.host, '127.0.0.1')
    const result = await connect(proxy.port, 'example.com:443')
    assert.equal(result.status, 403)
    result.socket.destroy()
  } finally {
    await proxy.close()
  }
})

test('loopback model proxy tunnels only DeepSeek API HTTPS through the configured upstream proxy', async () => {
  let upstreamAuthority
  const upstreamSockets = new Set()
  const upstream = http.createServer()
  upstream.on('connection', (socket) => {
    upstreamSockets.add(socket)
    socket.once('close', () => upstreamSockets.delete(socket))
  })
  upstream.on('connect', (request, socket) => {
    upstreamAuthority = request.url
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    socket.on('data', (chunk) => socket.write(chunk))
  })
  const upstreamPort = await listen(upstream)
  const proxy = await createDeepSeekApiLoopbackProxy({ env: { HTTPS_PROXY: 'http://127.0.0.1:' + upstreamPort } })
  try {
    const result = await connect(proxy.port, 'api.deepseek.com:443')
    assert.equal(result.status, 200)
    assert.equal(upstreamAuthority, 'api.deepseek.com:443')
    const echoed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('proxy echo timed out')), 3000)
      result.socket.once('data', (chunk) => {
        clearTimeout(timer)
        resolve(chunk.toString())
      })
    })
    result.socket.resume()
    result.socket.write('proxy-check')
    assert.equal(await echoed, 'proxy-check')
    result.socket.destroy()
  } finally {
    await proxy.close()
    for (const socket of upstreamSockets) socket.destroy()
    await new Promise((resolve) => upstream.close(resolve))
  }
})

test('loopback model proxy respects no_proxy and refuses unsupported upstream proxy schemes', () => {
  assert.equal(resolveModelUpstreamProxy({ HTTPS_PROXY: 'socks5://127.0.0.1:1080', NO_PROXY: 'api.deepseek.com' }), null)
  assert.throws(() => resolveModelUpstreamProxy({ HTTPS_PROXY: 'socks5://127.0.0.1:1080' }), /must use HTTP or HTTPS/)
})
