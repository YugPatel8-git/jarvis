import { performance } from 'node:perf_hooks'
import WebSocket from 'ws'

const url = process.env.JARVIS_BRIDGE_WS ?? 'ws://127.0.0.1:8787/ws'
const runs = Number(process.env.JARVIS_BENCH_RUNS ?? 5)
const ttsStartMs = Number(process.env.JARVIS_TTS_START_MS ?? 0)
const prompts = (process.env.JARVIS_BENCH_PROMPTS
  ? JSON.parse(process.env.JARVIS_BENCH_PROMPTS)
  : ['What is recursion?', 'What is the capital of Japan?', 'Explain polymorphism in one sentence.', 'Summarize the current webpage.'])

const ws = new WebSocket(url, { origin: 'http://localhost:5173' })
await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
const rows = []
let seq = 0

async function ask(prompt) {
  const id = `bench-${++seq}`
  const start = performance.now()
  const row = { prompt, run: seq, clientToBridgeMs: null, firstAckMs: null, firstTextMs: null, firstSpeakableMs: null, totalMs: null, server: {} }
  let streamed = ''
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('benchmark timeout')), 120_000)
    const finish = (err) => {
      clearTimeout(timer); ws.off('message', onMessage)
      if (err) reject(err); else resolve(row)
    }
    const onMessage = (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()) } catch { return }
      if (msg.ask !== id) return
      const elapsed = performance.now() - start
      if (row.clientToBridgeMs === null) row.clientToBridgeMs = elapsed
      if (msg.type === 'ack' && row.firstAckMs === null) row.firstAckMs = elapsed
      if (msg.type === 'timing') row.server[msg.metric] = msg.ms
      if (msg.type === 'text') {
        if (row.firstTextMs === null) row.firstTextMs = elapsed
        streamed += msg.delta ?? ''
        if (row.firstSpeakableMs === null && (/[.!?](?:\s|$)/.test(streamed) || streamed.length > 140)) row.firstSpeakableMs = elapsed
      }
      if (msg.type === 'done') { row.totalMs = elapsed; finish() }
      if (msg.type === 'error') finish(new Error(msg.message))
    }
    ws.on('message', onMessage)
    ws.send(JSON.stringify({ type: 'ask', id, text: prompt }))
  })
}

for (const prompt of prompts) {
  for (let i = 0; i < runs; i += 1) rows.push(await ask(prompt))
}
ws.close()

const median = (values) => {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b)
  return v.length ? v[Math.floor(v.length / 2)] : null
}
const summary = prompts.map((prompt) => {
  const group = rows.filter((r) => r.prompt === prompt)
  return {
    prompt,
    runs: group.length,
    firstEventMedianMs: median(group.map((r) => r.server.firstCodexEventMs)),
    firstVisibleMedianMs: median(group.map((r) => r.firstTextMs)),
    firstSpeakableMedianMs: median(group.map((r) => r.firstSpeakableMs)),
    firstAudioMedianMs: ttsStartMs ? median(group.map((r) => r.firstSpeakableMs + ttsStartMs)) : null,
    totalMedianMs: median(group.map((r) => r.totalMs)),
    clientToBridgeMedianMs: median(group.map((r) => r.clientToBridgeMs)),
    acknowledgementMedianMs: median(group.map((r) => r.firstAckMs)),
  }
})
console.log(JSON.stringify({ summary, rows }, null, 2))
