import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { CodexAppServerConversation } from '../bridge/codex-app-server.mjs'

test('a crashed persistent app-server restarts once and starts a fresh thread if resume fails', async () => {
  const children = []
  const methods = []
  const failures = []
  const spawnProcess = () => {
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
  } finally { conversation.close() }
})
