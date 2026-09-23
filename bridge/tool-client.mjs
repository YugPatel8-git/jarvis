import { WebSocket } from 'ws'
import process from 'node:process'

const IDLE_MS = 30_000
const TOOL_TIMEOUT_MS = 130_000
let seq = 0
let socket = null
let connecting = null
let idleTimer = null
const pending = new Map()

function clearIdle() { if (idleTimer) clearTimeout(idleTimer); idleTimer = null }
function idleClose() {
  clearIdle()
  if (pending.size || !socket) return
  idleTimer = setTimeout(() => { if (!pending.size && socket) socket.close() }, IDLE_MS)
  idleTimer.unref?.()
}
function failAll(error) {
  for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(error) }
  pending.clear()
}
async function connect() {
  if (socket?.readyState === WebSocket.OPEN) return socket
  if (connecting) return connecting
  const port = Number(process.env.JARVIS_BRIDGE_PORT ?? 8787)
  const token = process.env.JARVIS_ROUTER_TOKEN
  if (!token) throw new Error('The JARVIS tool router token is unavailable.')
  connecting = new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/tools`, { headers: { authorization: `Bearer ${token}` } })
    let settled = false
    const timer = setTimeout(() => { ws.terminate(); fail(new Error('Tool router connection timed out.')) }, 5000)
    const fail = (error) => {
      if (settled) return
      settled = true; clearTimeout(timer); connecting = null; reject(error)
    }
    ws.once('open', () => {
      if (settled) return
      settled = true; clearTimeout(timer); connecting = null; socket = ws; resolve(ws)
    })
    ws.on('message', (raw) => {
      let message
      try { message = JSON.parse(raw) } catch { return }
      const request = pending.get(String(message.id))
      if (!request) return
      pending.delete(String(message.id)); clearTimeout(request.timer)
      if (message.error) request.reject(new Error(message.error)); else request.resolve(message.result)
      idleClose()
    })
    ws.on('error', (error) => { fail(error); failAll(error) })
    ws.on('close', () => {
      if (socket === ws) socket = null
      fail(new Error('Tool router disconnected.'))
      failAll(new Error('Tool router disconnected.'))
    })
  })
  return connecting
}

export async function callRouter(tool, args) {
  const ws = await connect()
  clearIdle()
  const id = String(++seq)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('Tool router timed out.'))
      idleClose()
    }, TOOL_TIMEOUT_MS)
    pending.set(id, { resolve, reject, timer })
    ws.send(JSON.stringify({ id, tool, args }), (error) => {
      if (!error || !pending.has(id)) return
      clearTimeout(timer); pending.delete(id); reject(error); idleClose()
    })
  })
}
