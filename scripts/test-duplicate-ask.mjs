import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { WebSocket } from 'ws'

test('duplicate ask IDs on one connection execute one local command', async () => {
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  const child = spawn(process.execPath, ['bridge/server.mjs'], {
    cwd: process.cwd(), env: { ...process.env, JARVIS_BRIDGE_PORT: String(port) },
    windowsHide: true, stdio: 'ignore',
  })
  let ws
  try {
    let ready = false
    for (let i = 0; i < 80; i++) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, { headers: { origin: 'http://localhost:5173' }, signal: AbortSignal.timeout(300) })
        if (response.ok) { ready = true; break }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.equal(ready, true)
    ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: 'http://localhost:5173' })
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
    const frames = []
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('local command did not finish')), 5000)
      ws.on('message', (raw) => {
        const message = JSON.parse(raw)
        if (message.ask !== 'same-id') return
        frames.push(message)
        if (message.type === 'done') { clearTimeout(timer); resolve() }
      })
    })
    const ask = JSON.stringify({ type: 'ask', id: 'same-id', text: 'node version' })
    ws.send(ask); ws.send(ask)
    await done
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(frames.filter((frame) => frame.type === 'route').length, 1)
    assert.equal(frames.filter((frame) => frame.type === 'done').length, 1)
  } finally {
    ws?.close()
    child.kill('SIGTERM')
  }
})
