import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { CodexAppServerConversation } from '../bridge/codex-app-server.mjs'

test('a crashed persistent app-server restarts once and starts a fresh thread if resume fails', async () => {
  const children = []
  const methods = []
  const failures = []
  const spawnProcess = (_command, _args, options) => {
    assert.equal(options.windowsHide, true)
    assert.equal(options.shell, false)
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.stdin = {
      writable: true,
      write(line) {
        const message = JSON.parse(line)
        if (!message.id) return
        methods.push(message.method)
        const resumeFailed = children.length === 2 && message.method === 'thread/resume'
        const result = message.method === 'model/list' ? { data: [] }
          : message.method.startsWith('thread/') ? { thread: { id: `thread-${children.length}`, model: 'gpt-5.6-sol' } }
          : {}
        queueMicrotask(() => child.stdout.write(JSON.stringify({ id: message.id, ...(resumeFailed ? { error: { message: 'stale thread' } } : { result }) }) + '\n'))
      },
      end() { this.writable = false },
    }
    child.kill = () => { child.stdout.end(); child.stderr.end() }
    children.push(child)
    return child
  }
  const conversation = new CodexAppServerConversation({
    cwd: process.cwd(), routerToken: 'test-token', onText() {}, onTool() {},
    onFailure: (kind) => failures.push(kind), spawnProcess,
  })
  try {
    await conversation.warm()
    assert.equal(children.length, 1)
    children[0].stdout.end()
    children[0].emit('exit', 1)
    await new Promise((resolve) => setTimeout(resolve, 700))
    assert.equal(children.length, 2)
    assert.equal(conversation.state, 'ready')
    assert.deepEqual(failures, ['process-exit'])
    assert.ok(methods.includes('thread/resume'))
    assert.equal(methods.filter((method) => method === 'thread/start').length, 2)
    children[0].emit('error', new Error('late old process error'))
    assert.equal(conversation.state, 'ready')
    assert.equal(conversation.child, children[1])
  } finally { conversation.close() }
})

function activeHarness() {
  const children = [], requests = [], deltas = []
  let turn = 0
  const conversation = new CodexAppServerConversation({
    cwd: process.cwd(), routerToken: 'test-token', onText: (text) => deltas.push(text), onTool() {},
    spawnProcess() {
      const child = new EventEmitter()
      child.stdout = new PassThrough(); child.stderr = new PassThrough()
      child.reply = (m, result) => child.stdout.write(JSON.stringify({ id: m.id, result }) + '\n')
      child.event = (method, params) => child.stdout.write(JSON.stringify({ method, params }) + '\n')
      child.stdin = { writable: true, end() {}, write(line) {
        const m = JSON.parse(line)
        if (!m.id) return
        requests.push(m)
        if (m.method === 'model/list' || m.method === 'turn/start') return
        queueMicrotask(() => child.reply(m, m.method.startsWith('thread/') ? { thread: { id: 'thread', model: 'gpt-5.6-sol' } } : {}))
      } }
      child.kill = () => { child.stdout.end(); child.stderr.end() }
      children.push(child)
      return child
    },
  })
  const submitted = async () => {
    await new Promise((r) => setImmediate(r))
    const m = requests.filter((r) => r.method === 'turn/start').at(-1)
    assert.ok(m)
    return m
  }
  const accept = (m) => { const id = `turn-${++turn}`; children.at(-1).reply(m, { turn: { id } }); return id }
  return { conversation, children, requests, deltas, submitted, accept }
}

test('optional model catalog never blocks thread warmup', async () => {
  const h = activeHarness()
  try { await h.conversation.warm(); assert.equal(h.conversation.state, 'ready') }
  finally { h.conversation.close() }
})

test('cancel during submission interrupts the actual turn and stale deltas cannot enter the next answer', async () => {
  const h = activeHarness()
  try {
    await h.conversation.warm()
    const old = h.conversation.ask('Old question')
    const first = await h.submitted()
    h.conversation.cancel()
    const next = h.conversation.ask('New question')
    const oldId = h.accept(first)
    await old
    const second = await h.submitted()
    assert.notEqual(second.id, first.id)
    assert.equal(h.requests.find((m) => m.method === 'turn/interrupt').params.turnId, oldId)
    const newId = h.accept(second)
    await new Promise((r) => setImmediate(r))
    const child = h.children[0]
    child.event('item/agentMessage/delta', { threadId: 'thread', turnId: oldId, delta: 'OLD' })
    child.event('turn/completed', { threadId: 'thread', turn: { id: oldId, status: 'completed' } })
    child.event('item/agentMessage/delta', { threadId: 'thread', turnId: newId, delta: 'NEW' })
    child.event('turn/completed', { threadId: 'thread', turn: { id: newId, status: 'completed' } })
    assert.equal(await next, 'NEW')
    assert.deepEqual(h.deltas, ['NEW'])
  } finally { h.conversation.close() }
})

test('crash during a submitted turn fails promptly without replaying tool work through fallback', async () => {
  const h = activeHarness()
  let fallbackCalls = 0
  h.conversation.fallback.ask = async () => { fallbackCalls++; return 'duplicate' }
  try {
    await h.conversation.warm()
    const answer = h.conversation.ask('Run the requested tool')
    const rejected = assert.rejects(answer, /exited/)
    await h.submitted()
    h.children[0].emit('exit', 1)
    await rejected
    assert.equal(fallbackCalls, 0)
  } finally { h.conversation.close() }
})
