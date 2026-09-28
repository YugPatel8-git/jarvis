import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const compile = (path) => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText

test('rapid Talk presses start one microphone session; Escape stops a delayed voice start', async () => {
  const effects = [], listeners = new Map(), timers = new Set()
  let starts = 0, stops = 0, resolveVoice
  const state = new Proxy({ phase: 'dormant', setPhase(value) { this.phase = value } }, { get: (obj, key) => obj[key] ?? (() => {}) })
  const exports = {}
  vm.runInNewContext(compile('../src/App.tsx'), {
    exports, performance, console,
    require(id) {
      if (id === 'react') return { useRef: (value) => ({ current: value }), useEffect: (fn) => effects.push(fn) }
      if (id === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) }
      if (id === './store') return { useStore: { getState: () => state } }
      if (id === './lib/voice') return { startVoice: () => { starts++; return new Promise((r) => { resolveVoice = r }) } }
      if (id === './lib/capabilities') return { probeCapabilities: async () => ({}) }
      if (id === './lib/audio') return { startAnalyser: async () => {}, releaseMic() {}, micLevel: () => 0 }
      if (id === './ui/Hud') return { Hud: 'Hud' }
      return new Proxy({}, { get: () => () => {} })
    },
    window: { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: (name) => listeners.delete(name) },
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); timers.add(t); return t }, clearTimeout,
    setInterval, clearInterval, requestAnimationFrame: () => 1, cancelAnimationFrame() {},
  })
  const tree = exports.default()
  const talk = tree.props.children.find((node) => node.type === 'Hud').props.onTalk
  const cleanup = effects[1]()
  try {
    for (let i = 0; i < 10; i++) talk()
    await new Promise((r) => setImmediate(r))
    assert.equal(starts, 1)
    listeners.get('keydown')({ key: 'Escape', preventDefault() {} })
    resolveVoice({ stop: () => { stops++ }, live: () => true })
    await new Promise((r) => setImmediate(r))
    assert.equal(stops, 1)
    assert.equal(state.phase, 'dormant')
  } finally { cleanup(); for (const timer of timers) clearTimeout(timer) }
})

test('rapid questions during bridge connection keep only the latest turn and cancel it deterministically', async () => {
  const instances = [], timers = new Set()
  class Socket {
    static OPEN = 1
    readyState = 0
    listeners = new Map()
    sent = []
    constructor() { instances.push(this) }
    addEventListener(name, fn) { const list = this.listeners.get(name) ?? new Set(); list.add(fn); this.listeners.set(name, list) }
    removeEventListener(name, fn) { this.listeners.get(name)?.delete(fn) }
    send(value) { this.sent.push(JSON.parse(value)) }
    close() { this.readyState = 3 }
  }
  const exports = {}
  const timer = (fn, ms) => { const value = setTimeout(fn, ms); timers.add(value); return value }
  vm.runInNewContext(compile('../src/lib/bridge.ts'), {
    exports, WebSocket: Socket, console, setTimeout: timer, clearTimeout,
    window: { setTimeout: timer }, location: { port: '5173' },
    require: (id) => id === '../config' ? { BRIDGE_WS_URL: 'ws://test' } : {},
  })
  try {
    const handlers = { onText() {}, onTool() {} }
    const asks = Array.from({ length: 10 }, (_, i) => exports.ask(`Question ${i}`, handlers))
    assert.equal(instances.length, 1)
    const ws = instances[0]
    ws.readyState = 1; ws.onopen()
    await new Promise((r) => setImmediate(r))
    assert.equal(ws.sent.filter((m) => m.type === 'ask').length, 1)
    assert.equal(ws.sent.find((m) => m.type === 'ask').text, 'Question 9')
    exports.cancel()
    await Promise.all(asks)
    assert.equal(ws.listeners.get('message').size, 1, 'only the connection dispatcher remains')
  } finally { for (const t of timers) clearTimeout(t) }
})
