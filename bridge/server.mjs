/** Local JARVIS bridge backed by the authenticated OpenAI Codex CLI. */
import http from 'node:http'
import process from 'node:process'
import { WebSocketServer, WebSocket } from 'ws'
import { CodexConversation, codexModelLabel } from './codex.mjs'

const HOST = '127.0.0.1'
const PORT = Number(process.env.JARVIS_BRIDGE_PORT ?? 8787)
const EXTRA_ORIGINS = new Set((process.env.JARVIS_ALLOWED_ORIGINS ?? '').split(',').map((v) => v.trim().replace(/\/+$/, '')).filter(Boolean))
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
const isDevPort = (p) => (p >= 5173 && p <= 5199) || (p >= 4173 && p <= 4199)
function originAllowed(origin) {
  if (!origin) return false
  if (EXTRA_ORIGINS.has(origin.replace(/\/+$/, ''))) return true
  try {
    const url = new URL(origin)
    return url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname) && isDevPort(Number(url.port))
  } catch { return false }
}

const server = http.createServer((req, res) => {
  const origin = req.headers.origin
  if (!originAllowed(origin)) { res.writeHead(403, { vary: 'origin' }); return res.end('forbidden') }
  const cors = { vary: 'origin', 'access-control-allow-origin': origin, 'access-control-allow-headers': 'content-type' }
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end() }
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { ...cors, 'content-type': 'application/json' })
    return res.end(JSON.stringify({ ok: true, backend: 'codex', tts: false, stt: false }))
  }
  res.writeHead(404, cors); res.end()
})

const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 })
server.on('upgrade', (req, socket, head) => {
  const path = (req.url ?? '/').split('?')[0]
  if ((path !== '/' && path !== '/ws') || !originAllowed(req.headers.origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return
  }
  wss.handleUpgrade(req, socket, head, (client) => wss.emit('connection', client, req))
})

wss.on('connection', (socket) => {
  socket.send(JSON.stringify({ type: 'ready', servers: ['codex'] }))
  let askId = null
  const send = (message) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)) }
  const conversation = new CodexConversation({
    cwd: process.cwd(),
    onText: (delta) => send({ type: 'text', delta, ask: askId }),
    onTool: (name) => send({ type: 'tool', name, ask: askId }),
  })
  socket.on('message', (raw) => {
    let message
    try { message = JSON.parse(raw.toString()) } catch { return }
    if (message.type === 'interrupt') { conversation.cancel(); return }
    if (message.type !== 'ask' || typeof message.text !== 'string') return
    if (Buffer.byteLength(message.text, 'utf8') > 32 * 1024) return send({ type: 'error', ask: message.id ?? null, message: 'The request is too large.' })
    if (conversation.child) conversation.cancel()
    askId = typeof message.id === 'string' ? message.id : null
    void conversation.ask(message.text)
      .then((text) => send({ type: 'done', text, ask: askId }))
      .catch((err) => send({ type: 'error', message: String(err.message ?? err), ask: askId }))
  })
  socket.on('close', () => conversation.close())
})

server.listen(PORT, HOST, () => {
  console.log(`[jarvis] bridge listening on ws://${HOST}:${PORT}`)
  console.log(`[jarvis] backend ${codexModelLabel()} via authenticated Codex CLI`)
  console.log('[jarvis] read-only sandbox; approvals, MCP, browser, and file actions disabled')
})
