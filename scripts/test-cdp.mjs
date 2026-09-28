import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocketServer } from 'ws'
import { createCdpPool } from '../bridge/cdp.mjs'

test('CDP reuses connections, correlates concurrent replies, rejects disconnects and reconnects without replay', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => server.once('listening', resolve))
  const target = { webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}` }
  const pool = createCdpPool({ idleMs: 25, timeoutMs: 200 })
  let connections = 0, calls = 0
  server.on('connection', (ws) => {
    connections++
    ws.on('message', (raw) => {
      const m = JSON.parse(raw); calls++
      if (m.method === 'disconnect') return ws.terminate()
      if (m.method === 'hang') return
      ws.send(JSON.stringify({ id: m.id, result: m.params }))
    })
  })
  try {
    assert.deepEqual(await Promise.all([pool.request(target, 'read', { n: 1 }), pool.request(target, 'read', { n: 2 })]), [{ n: 1 }, { n: 2 }])
    assert.equal(connections, 1)
    await assert.rejects(pool.request(target, 'disconnect'), /closed/)
    assert.equal(calls, 3)
    await pool.request(target, 'read')
    assert.equal(connections, 2)
    await assert.rejects(pool.request(target, 'hang'), /timed out/)
    await pool.request(target, 'read')
    await new Promise((resolve) => setTimeout(resolve, 50))
    await pool.request(target, 'read')
    assert.equal(connections, 4)
  } finally { pool.close(); for (const ws of server.clients) ws.terminate(); await new Promise((r) => server.close(r)) }
})
