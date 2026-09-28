// Controlled transport/playback fixtures, not real Fish or browser audio timings.
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import http from 'node:http'
import { WebSocketServer } from 'ws'
import { pathToFileURL, fileURLToPath } from 'node:url'

const runs = 10
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const stats = (values) => {
  const xs = values.sort((a, b) => a - b)
  return { median: +xs[Math.ceil(xs.length * .5) - 1].toFixed(2), p90: +xs[Math.ceil(xs.length * .9) - 1].toFixed(2) }
}

async function speech(source, cold) {
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const starts = [], gaps = []
  for (let n = 0; n <= runs; n++) {
    let first = 0, previousEnd = 0, gap = 0, began
    const exports = {}, urls = new Set()
    let seq = 0
    const started = () => { const now = performance.now(); if (!first) first = now - began; if (previousEnd) gap = now - previousEnd }
    const voice = { getVoices: () => [{ name: 'Test', lang: 'en-GB' }], addEventListener() {}, pause() {}, resume() {}, cancel() {}, speak(u) { setTimeout(() => { started(); u.onstart?.(); setTimeout(() => { previousEnd = performance.now(); u.onend?.() }, 60) }, 1) } }
    vm.runInNewContext(code, {
      exports, performance, console, AbortController, Blob,
      require(id) {
        if (id === '../config') return { TTS_ENGINE: 'kokoro', BRIDGE_HTTP_URL: 'http://fixture' }
        if (id === './capabilities') return { caps: () => ({ ttsEngine: 'fish' }) }
        if (id === './speech-text') return { toSpeechText: (s) => s }
        if (id === './speech-phrases') return { takeSpeechPhrases: (s) => { const i = s.indexOf('. '); return i < 0 ? { phrases: [], rest: s } : { phrases: [s.slice(0, i + 2)], rest: s.slice(i + 2) } } }
        if (id === './kokoro') return { isReady: () => !cold, isUnavailable: () => false, activeVoice: () => 'test', load: async () => {}, speak: async () => { await sleep(200); return 'blob:local' } }
        throw new Error(id)
      },
      localStorage: { getItem: () => null }, speechSynthesis: voice,
      SpeechSynthesisUtterance: class { constructor(text) { this.text = text } },
      URL: { createObjectURL() { const url = `blob:${++seq}`; urls.add(url); return url }, revokeObjectURL(url) { urls.delete(url) } },
      fetch: async () => {
        if (cold) return { ok: false }
        await sleep(120)
        return { ok: true, body: { getReader() { let read = false; return { async read() { if (read) return { done: true }; read = true; await sleep(40); return { value: new Uint8Array([1]) } } } } } }
      },
      Audio: class {
        pause() { this.onpause?.() }
        removeAttribute() {}
        load() {}
        async play() { setTimeout(() => { started(); this.onplaying?.(); setTimeout(() => { previousEnd = performance.now(); this.onended?.() }, 60) }, 1) }
      },
      setTimeout, clearTimeout, setInterval, clearInterval, requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    })
    began = performance.now()
    const speaker = exports.createSpeaker()
    speaker.push('Useful first phrase. ')
    if (!cold) { await sleep(30); speaker.push('Useful next phrase. ') }
    await speaker.end()
    speaker.cancel()
    if (n) { starts.push(first); if (!cold) gaps.push(gap) }
  }
  return { runs, firstPlaybackEventMs: stats(starts), phraseGapMs: gaps.length ? stats(gaps) : null }
}

async function browser() {
  let requests = 0, connections = 0
  const server = http.createServer((req, res) => {
    requests++
    setTimeout(() => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(req.url === '/json/version' ? {} : [{ id: 'fixture', type: 'page', webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/cdp` }])) }, 3)
  })
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => setTimeout(() => wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws)), 3))
  wss.on('connection', (ws) => { connections++; ws.on('message', (raw) => { const m = JSON.parse(raw); setTimeout(() => ws.send(JSON.stringify({ id: m.id, result: {} })), 2) }) })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  process.env.JARVIS_CHROME_PORT = String(server.address().port)
  const result = {}
  try {
    for (const [label, relative] of [['before', '../.jarvis/browser-before.mjs'], ['after', '../bridge/browser.mjs']]) {
      const { browserAction } = await import(pathToFileURL(fileURLToPath(new URL(relative, import.meta.url))).href)
      await browserAction({ operation: 'scroll' })
      const samples = [], oldRequests = requests, oldConnections = connections
      for (let i = 0; i < 20; i++) { const at = performance.now(); await browserAction({ operation: 'scroll' }); samples.push(performance.now() - at) }
      result[label] = { runs: 20, ms: stats(samples), httpRequests: requests - oldRequests, newConnections: connections - oldConnections }
    }
  } finally { for (const ws of wss.clients) ws.terminate(); wss.close(); server.closeAllConnections(); await new Promise((r) => server.close(r)) }
  return result
}

const result = { note: 'Synthetic 120 ms headers + 40 ms body, 60 ms playback, 200 ms cold local synthesis; CDP fixture has 3 ms HTTP/handshake and 2 ms command delay. These are controlled code-path comparisons, not real audible/network latency.', speech: {}, browser: null }
for (const [label, relative] of [['before', '../.jarvis/tts-before.ts'], ['after', '../src/lib/tts.ts']]) {
  const source = readFileSync(new URL(relative, import.meta.url), 'utf8')
  result.speech[label] = { bufferedFish: await speech(source, false), coldFallback: await speech(source, true) }
}
result.browser = await browser()
console.log(JSON.stringify(result, null, 2))
