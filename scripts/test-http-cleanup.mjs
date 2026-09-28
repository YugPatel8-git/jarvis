import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import vm from 'node:vm'
import ts from 'typescript'

test('HTTP response errors and an already-ended response cannot crash the bridge or trigger a second end', async () => {
  let handler
  const source = ts.transpileModule(readFileSync(new URL('../bridge/server.mjs', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const server = { on() {}, listen(_port, _host, fn) { fn() } }
  vm.runInNewContext(source, {
    exports: {}, console: { log() {}, warn() {} }, performance, Buffer, setTimeout, clearTimeout,
    require(id) {
      if (id === 'node:http') return { createServer(fn) { handler = fn; return server } }
      if (id === 'node:process') return { env: {}, cwd: () => '.', on() {} }
      if (id === 'node:fs') return { existsSync: () => false }
      if (id === 'node:crypto') return { randomBytes: () => Buffer.alloc(32) }
      if (id === 'node:events') return { once: async () => {} }
      if (id === 'ws') return { WebSocketServer: class { on() {} }, WebSocket: { OPEN: 1 } }
      if (id === './codex-app-server.mjs') return { CodexAppServerConversation: class { state = 'ready'; warm() { return Promise.resolve() } }, appServerModelLabel: () => 'fixture' }
      if (id === './router.mjs') return { createRouter: () => () => {} }
      if (id === './fish-tts.mjs') return { fishConfigured: () => false }
      if (id === './health.mjs') return { createHealth: () => ({ mark() {} }) }
      return {}
    },
  })
  const response = new EventEmitter()
  let ends = 0
  Object.assign(response, {
    headersSent: false, writableEnded: false, destroyed: false,
    writeHead() { this.headersSent = true },
    end() { ends++; this.writableEnded = true; throw new Error('response finished during cleanup') },
    destroy() { this.destroyed = true },
  })
  handler({ method: 'GET', url: '/health', headers: { origin: 'http://localhost:5173' } }, response)
  await new Promise((r) => setImmediate(r))
  assert.equal(ends, 1)
  response.emit('error', new Error('socket write failed'))
  assert.equal(response.destroyed, true)
})
