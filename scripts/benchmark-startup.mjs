import { spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'

const port = Number(process.env.JARVIS_STARTUP_PORT ?? 5187)
const bridgePort = Number(process.env.JARVIS_STARTUP_BRIDGE_PORT ?? 8788)
const origin = `http://localhost:${port}`
const began = performance.now()
const times = { launcherSpawnMs: null, bridgeListeningMs: null, viteReadyMs: null, pageResponseMs: null, codexReadyMs: null, codexState: null, fishConfigured: null }
const child = spawn(process.execPath, ['scripts/start.mjs'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(port), JARVIS_BRIDGE_PORT: String(bridgePort) },
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
})
times.launcherSpawnMs = Math.round(performance.now() - began)
let output = ''
const collect = (chunk) => {
  output = (output + chunk.toString()).slice(-8000)
  if (times.bridgeListeningMs === null && output.includes('bridge listening on')) times.bridgeListeningMs = Math.round(performance.now() - began)
  if (times.viteReadyMs === null && /Local:\s+http:\/\//.test(output)) times.viteReadyMs = Math.round(performance.now() - began)
}
child.stdout.on('data', collect)
child.stderr.on('data', collect)
const deadline = began + 45_000
try {
  while (performance.now() < deadline) {
    if (times.pageResponseMs === null) {
      try { const response = await fetch(origin, { signal: AbortSignal.timeout(600) }); if (response.ok) times.pageResponseMs = Math.round(performance.now() - began) } catch {}
    }
    if (times.codexReadyMs === null) {
      try {
        const response = await fetch(`http://127.0.0.1:${bridgePort}/health`, { headers: { origin }, signal: AbortSignal.timeout(600) })
        if (response.ok) {
          const health = await response.json()
          times.fishConfigured = health.ttsEngine === 'fish'
          times.codexState = health.core
          if (health.core === 'ready') times.codexReadyMs = Math.round(performance.now() - began)
        }
      } catch {}
    }
    if (times.pageResponseMs !== null && (times.codexReadyMs !== null || times.codexState === 'fallback')) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const prewarmErrorClass = /not recognized|not found/i.test(output) ? 'command unavailable' : /timed out/i.test(output) ? 'timeout' : /app-server prewarm failed/i.test(output) ? 'other prewarm failure' : null
  console.log(JSON.stringify({ ...times, prewarmErrorClass, note: 'Page response is HTTP only; browser first render, WebSocket connect, and Kokoro readiness require a live browser.' }))
} finally {
  child.kill('SIGTERM')
}
