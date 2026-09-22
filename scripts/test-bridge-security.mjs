import { test } from 'node:test'
import assert from 'node:assert/strict'
import WebSocket from 'ws'

const base = 'http://127.0.0.1:8787'

test('bridge rejects an untrusted HTTP origin', async () => {
  const response = await fetch(`${base}/health`, { headers: { origin: 'http://evil.example' } })
  assert.equal(response.status, 403)
})

test('tool WebSocket rejects a missing bearer token', async () => {
  const status = await new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:8787/tools')
    ws.on('unexpected-response', (_request, response) => resolve(response.statusCode))
    ws.on('open', () => reject(new Error('unauthenticated tool socket opened')))
    ws.on('error', reject)
  })
  assert.equal(status, 403)
})

test('conversation WebSocket rejects an untrusted origin', async () => {
  const status = await new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:8787/ws', { origin: 'http://evil.example' })
    ws.on('unexpected-response', (_request, response) => resolve(response.statusCode))
    ws.on('open', () => reject(new Error('untrusted conversation socket opened')))
    ws.on('error', reject)
  })
  assert.equal(status, 403)
})
