/** Event-driven, bounded runtime health. Never stores exception text or secrets. */
const COMPONENTS = ['bridge', 'frontend', 'tools', 'codex', 'fish', 'kokoro', 'systemVoice', 'browser', 'ttsQueue']
const METRICS = ['localCommand', 'codexFirstEvent', 'codexFirstText', 'fishFirstByte', 'fishComplete', 'browserTool']
const FAILURE_KINDS = new Set(['timeout', 'disconnect', 'upstream', 'decode', 'tool', 'process-exit', 'start-failed', 'turn-timeout'])
const LIMIT = 32
const median = (values) => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor((sorted.length - 1) / 2)]
}

export function createHealth({ now = () => Date.now() } = {}) {
  const components = Object.fromEntries(COMPONENTS.map((name) => [name, { state: 'unknown', failures: 0, changedAt: 0, degradedSinceReady: false, lastFailureKind: null, repeatedFailure: 0 }]))
  const metrics = Object.fromEntries(METRICS.map((name) => [name, []]))
  const slowStreak = Object.fromEntries(METRICS.map((name) => [name, 0]))
  const notices = []
  let fishRetryAt = 0

  function mark(name, state) {
    const item = components[name]
    if (!item || !['ready', 'unknown', 'idle', 'recovering', 'degraded', 'unavailable'].includes(state)) return null
    if (state === 'idle' && item.state === 'degraded') return null
    const recovering = item.degradedSinceReady
    item.state = state
    if (state === 'degraded') item.degradedSinceReady = true
    if (state === 'ready') { item.failures = 0; item.degradedSinceReady = false; item.repeatedFailure = 0; item.lastFailureKind = null }
    item.changedAt = now()
    if (recovering && state === 'ready') return `${name === 'codex' ? 'Codex' : name === 'browser' ? 'The browser connection' : name === 'fish' ? 'Fish Audio' : 'The connection'} recovered, sir.`
    return null
  }

  function failure(name, kind = null) {
    const item = components[name]
    if (!item) return null
    item.failures++
    const safeKind = FAILURE_KINDS.has(kind) ? kind : null
    item.repeatedFailure = safeKind && item.lastFailureKind === safeKind ? item.repeatedFailure + 1 : 1
    item.lastFailureKind = safeKind
    item.changedAt = now()
    if (name === 'fish' && item.failures >= 3) fishRetryAt = now() + 30_000
    if (item.failures < 3 || item.state === 'degraded') return null
    item.state = 'degraded'
    item.degradedSinceReady = true
    const notice = `${name === 'fish' ? 'Fish Audio' : name === 'codex' ? 'Codex' : name === 'browser' ? 'Browser automation' : 'A JARVIS component'} is having repeated trouble, sir. ${name === 'fish' ? 'I am using the local voice for now.' : 'I will keep safe recovery bounded.'}`
    notices.push({ at: now(), component: name, text: notice })
    if (notices.length > 8) notices.shift()
    return notice
  }

  function timing(name, ms) {
    const list = metrics[name]
    if (!list || !Number.isFinite(ms) || ms < 0) return false
    const base = list.length >= 8 ? median(list) : null
    const slow = base !== null && ms > Math.max(base * 2.5, base + 500)
    slowStreak[name] = slow ? slowStreak[name] + 1 : 0
    list.push(Math.round(ms * 100) / 100)
    if (list.length > LIMIT) list.shift()
    return slowStreak[name] >= 3
  }

  function snapshot(extra = {}) {
    // Expire only transient notices, and only when diagnostics are requested.
    while (notices.length && now() - notices[0].at > 10 * 60_000) notices.shift()
    return {
      components: Object.fromEntries(COMPONENTS.map((name) => [name, { ...components[name] }])),
      metrics: Object.fromEntries(METRICS.map((name) => [name, { samples: metrics[name].length, medianMs: median(metrics[name]), slow: slowStreak[name] >= 3 }])),
      fishCooldownMs: Math.max(0, fishRetryAt - now()),
      notices: [...notices],
      ...extra,
    }
  }

  return { mark, failure, timing, snapshot, fishAvailable: () => now() >= fishRetryAt }
}

export function diagnosticText(snapshot) {
  const c = snapshot.components
  const issues = Object.entries(c).filter(([, value]) => value.state === 'degraded' || value.state === 'unavailable')
  const parts = issues.length
    ? issues.map(([name]) => `${name === 'fish' ? 'Fish Audio' : name} is degraded`)
    : ['The bridge and active connections are operating normally']
  if (c.codex?.state === 'ready') parts.push('Codex is connected')
  else if (c.codex?.state === 'recovering') parts.push('Codex is reconnecting')
  else if (c.codex?.state === 'degraded') parts.push('Codex is using its fallback')
  if (c.fish?.state === 'ready') parts.push('Fish Audio is responding')
  else if (c.fish?.state === 'unknown') parts.push('Fish Audio has not been checked by a speech request')
  if (c.browser?.state === 'unknown') parts.push('browser automation has not been used yet')
  if (snapshot.pendingRequests) parts.push(`${snapshot.pendingRequests} request${snapshot.pendingRequests === 1 ? ' is' : 's are'} pending`)
  const slow = Object.entries(snapshot.metrics).filter(([, value]) => value.slow).map(([name]) => name)
  if (slow.length) parts.push(`${slow.join(' and ')} has been slower than its recent baseline`)
  return `${parts.join('. ')}. Sir, no screen capture or account check was needed for this report.`
}
