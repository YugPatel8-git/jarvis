import { performance } from 'node:perf_hooks'
import { readFileSync } from 'node:fs'
import WebSocket from 'ws'
import ts from 'typescript'

// Reuse the browser's phrase and speech rules without a benchmark-only guess.
async function localModule(name) {
  const source = readFileSync(new URL(`../src/lib/${name}.ts`, import.meta.url), 'utf8')
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText
  return import(`data:text/javascript,${encodeURIComponent(code)}`)
}
const { takeSpeechPhrases } = await localModule('speech-phrases')
const { toSpeechText } = await localModule('speech-text')

const url = process.env.JARVIS_BRIDGE_WS ?? 'ws://127.0.0.1:8787/ws'
const runs = Number(process.env.JARVIS_BENCH_RUNS ?? 10)
const prompts = process.env.JARVIS_BENCH_PROMPTS
  ? JSON.parse(process.env.JARVIS_BENCH_PROMPTS)
  : ['What is the capital of Japan?', 'What is recursion?', 'Explain polymorphism in one sentence.']

const ws = new WebSocket(url, { origin: 'http://localhost:5173' })
await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
let seq = 0

async function ask(prompt) {
  const id = `bench-${++seq}`
  const start = performance.now()
  const row = { prompt, firstEventMs: null, firstModelDeltaMs: null, firstVisibleTextMs: null, firstPhraseMs: null, normalizationMs: null, firstSpeechText: '', firstAudioReadyMs: null, firstAudibleMs: null, totalMs: null, model: null, effort: null, route: null, answer: '', tools: [], toolTimings: [], server: {} }
  let buffer = ''
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('benchmark timeout')), 120_000)
    const finish = (error) => {
      clearTimeout(timer); ws.off('message', onMessage)
      if (error) reject(error); else resolve(row)
    }
    const onMessage = (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()) } catch { return }
      if (msg.ask !== id) return
      const elapsed = performance.now() - start
      if (row.firstEventMs === null) row.firstEventMs = elapsed
      if (msg.type === 'timing') row.server[msg.metric] = msg.ms
      if (msg.type === 'routing') { row.model = msg.model; row.effort = msg.effort }
      if (msg.type === 'route') row.route = msg.engine
      if (msg.type === 'tool') row.tools.push({ name: msg.name, atMs: elapsed })
      if (msg.type === 'tool-timing') row.toolTimings.push({ ...msg, atMs: elapsed })
      if (msg.type === 'text') {
        if (row.route === 'codex' && row.firstModelDeltaMs === null) row.firstModelDeltaMs = elapsed
        if (row.firstVisibleTextMs === null) row.firstVisibleTextMs = elapsed
        row.answer += msg.delta ?? ''
        buffer += msg.delta ?? ''
        const extracted = takeSpeechPhrases(buffer)
        buffer = extracted.rest
        for (const phrase of extracted.phrases) {
          const began = performance.now()
          const speech = toSpeechText(phrase)
          const cost = performance.now() - began
          if (speech && row.firstPhraseMs === null) {
            row.firstPhraseMs = elapsed
            row.normalizationMs = cost
            row.firstSpeechText = speech
          }
        }
      }
      if (msg.type === 'done') {
        row.totalMs = elapsed
        if (row.firstPhraseMs === null && buffer.trim()) {
          const began = performance.now()
          const speech = toSpeechText(buffer)
          if (speech) { row.firstPhraseMs = elapsed; row.normalizationMs = performance.now() - began; row.firstSpeechText = speech }
        }
        finish()
      }
      if (msg.type === 'error') finish(new Error(msg.message))
    }
    ws.on('message', onMessage)
    ws.send(JSON.stringify({ type: 'ask', id, text: prompt }))
  })
}

const rows = []
for (const prompt of prompts) {
  await ask(prompt) // warm the turn and model path before measured trials
  for (let run = 1; run <= runs; run += 1) {
    rows.push({ run, ...await ask(prompt) })
    process.stderr.write(`bench ${prompts.indexOf(prompt) + 1}/${prompts.length} ${run}/${runs}\n`)
  }
}
ws.close()

function stats(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!sorted.length) return { median: null, p90: null }
  const quantile = (p) => Number(sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)].toFixed(2))
  return { median: quantile(0.5), p90: quantile(0.9) }
}

const summary = prompts.map((prompt) => {
  const group = rows.filter((row) => row.prompt === prompt)
  return {
    prompt, runs: group.length,
    model: [...new Set(group.map((row) => row.model))],
    effort: [...new Set(group.map((row) => row.effort))],
    firstAppEventMs: stats(group.map((row) => row.server.firstCodexEventMs)),
    firstModelDeltaMs: stats(group.map((row) => row.firstModelDeltaMs)),
    firstVisibleBridgeTextMs: stats(group.map((row) => row.firstVisibleTextMs)),
    firstStableSpeechPhraseMs: stats(group.map((row) => row.firstPhraseMs)),
    normalizationMs: stats(group.map((row) => row.normalizationMs)),
    requestSubmissionMs: stats(group.map((row) => row.server.requestSubmissionMs)),
    firstAudioReadyMs: stats(group.map((row) => row.firstAudioReadyMs)),
    firstAudibleRealSpeechMs: stats(group.map((row) => row.firstAudibleMs)),
    totalCompletionMs: stats(group.map((row) => row.totalMs)),
  }
})
console.log(JSON.stringify({ note: 'Audio and HUD paint timings require a live browser; null means unmeasured, not zero.', summary, rows }, null, 2))
