import { WebSocket } from 'ws'

/** Reuse a bounded set of target connections; never replay an uncertain action. */
export function createCdpPool({ idleMs = 30_000, timeoutMs = 10_000, maxConnections = 8 } = {}) {
  const connections = new Map()
  let seq = 0
  function dispose(entry, error = new Error('Chrome connection closed.')) {
    if (entry.closed) return
    entry.closed = true
    clearTimeout(entry.idle)
    if (connections.get(entry.url) === entry) connections.delete(entry.url)
    for (const request of entry.pending.values()) { clearTimeout(request.timer); request.reject(error) }
    entry.pending.clear()
    entry.ws.terminate()
  }
  function idle(entry) {
    clearTimeout(entry.idle)
    if (!entry.closed && !entry.pending.size) {
      entry.idle = setTimeout(() => dispose(entry), idleMs)
      entry.idle.unref?.()
    }
  }
  function connection(url) {
    let entry = connections.get(url)
    if (entry && entry.ws.readyState < WebSocket.CLOSING) return entry
    if (entry) dispose(entry)
    if (connections.size >= maxConnections) {
      const unused = [...connections.values()].find((item) => !item.pending.size)
      if (!unused) throw new Error('Chrome has too many active tool requests.')
      dispose(unused)
    }
    const ws = new WebSocket(url)
    entry = { url, ws, pending: new Map(), idle: null, closed: false }
    connections.set(url, entry)
    ws.on('open', () => { for (const request of entry.pending.values()) request.send() })
    ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw) } catch { return }
      const request = entry.pending.get(msg.id)
      if (!request) return
      entry.pending.delete(msg.id); clearTimeout(request.timer)
      if (msg.error) request.reject(new Error(msg.error.message)); else request.resolve(msg.result)
      idle(entry)
    })
    ws.on('error', (error) => dispose(entry, error))
    ws.on('close', () => dispose(entry))
    return entry
  }
  return {
    request(target, method, params = {}) {
      return new Promise((resolve, reject) => {
        const entry = connection(target.webSocketDebuggerUrl), id = ++seq
        clearTimeout(entry.idle)
        const timer = setTimeout(() => dispose(entry, new Error('Chrome operation timed out')), timeoutMs)
        let sent = false
        const send = () => {
          if (sent || entry.closed) return
          sent = true
          entry.ws.send(JSON.stringify({ id, method, params }), (error) => { if (error) dispose(entry, error) })
        }
        entry.pending.set(id, { resolve, reject, timer, send })
        if (entry.ws.readyState === WebSocket.OPEN) send()
      })
    },
    close() { for (const entry of connections.values()) dispose(entry) },
  }
}
