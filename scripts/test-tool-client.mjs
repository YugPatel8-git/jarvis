import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocketServer } from 'ws'

test('MCP tool client reuses one authenticated socket and reconnects after a drop', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => server.once('listening', resolve))
  process.env.JARVIS_BRIDGE_PORT = String(server.address().port)
  process.env.JARVIS_ROUTER_TOKEN = 'test-router-token'
  let connections = 0
  server.on('connection', (ws, request) => {
    assert.equal(request.headers.authorization, 'Bearer test-router-token')
    connections++
    ws.on('message', (raw) => {
      const message = JSON.parse(raw)
      ws.send(JSON.stringify({ id: message.id, result: { tool: message.tool } }))
    })
  })
  try {
    const { callRouter } = await import('../bridge/tool-client.mjs')
    const first = await Promise.all([callRouter('browser', {}), callRouter('filesystem', {})])
    assert.deepEqual(first, [{ tool: 'browser' }, { tool: 'filesystem' }])
    assert.equal(connections, 1)
    for (const client of server.clients) client.terminate()
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.deepEqual(await callRouter('shell', {}), { tool: 'shell' })
    assert.equal(connections, 2)
  } finally {
    for (const client of server.clients) client.terminate()
    await new Promise((resolve) => server.close(resolve))
    delete process.env.JARVIS_ROUTER_TOKEN
    delete process.env.JARVIS_BRIDGE_PORT
  }
})
