import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { CodexConversation as ExecFallback, codexModelLabel } from './codex.mjs'

const TURN_TIMEOUT_MS = Number(process.env.JARVIS_TURN_TIMEOUT_MS ?? 120_000)
const MODEL = process.env.JARVIS_CODEX_MODEL?.trim() || null
const FAST_EFFORT = process.env.JARVIS_FAST_EFFORT?.trim() || 'low'
const STRONG_EFFORT = process.env.JARVIS_STRONG_EFFORT?.trim() || 'high'
const MAX_SESSION_TURNS = Number(process.env.JARVIS_SESSION_TURNS ?? 24)
const MAX_SESSION_CHARS = Number(process.env.JARVIS_SESSION_CHARS ?? 40_000)
const RECENT_TURNS = 6
const RECENT_CHARS = 6_000
const DISABLED_FEATURES = ['plugins', 'apps', 'browser_use', 'computer_use', 'image_generation', 'multi_agent', 'shell_tool', 'skill_search', 'tool_suggest', 'web_search_request']
const PERSONA = `You are JARVIS. You are speaking out loud to one person.
Keep conversational replies to at most two short sentences and usually under thirty words. Use plain spoken prose only: no markdown, headings, bullets, code fences, URLs, raw JSON, or emoji. Be dry, precise, calmly competent, and occasionally address the user as sir. Do not claim to have used tools.
Your only machine capabilities are the tools from the jarvis MCP server. Never bypass that server with built-in shell or filesystem tools. The Codex sandbox is read-only. The router executes normal actions and pauses high-risk actions for explicit user approval. Do not claim success until a tool returns success. Use camera vision only when asked. Never request an API key or expose authentication data.`

function commandFor(args) {
  if (process.platform !== 'win32') return { command: 'codex', args }
  return { command: process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe', args: ['/d', '/s', '/c', 'codex', ...args] }
}
function mcpPath() {
  const url = new URL('./mcp-server.mjs', import.meta.url)
  return decodeURIComponent(url.pathname.replace(/^\/(?:[A-Za-z]:)/, (m) => m.slice(1))).replaceAll('/', '\\')
}
function isComplex(prompt) {
  return /\b(debug|diagnos|architect|design|plan|refactor|race condition|security review|analy[sz]e|compare|investigate|implement|codebase|project)\b/i.test(prompt) || prompt.length > 900
}
function safeEnv(routerToken) {
  const env = { ...process.env, JARVIS_ROUTER_TOKEN: routerToken }
  delete env.OPENAI_API_KEY
  delete env.CODEX_API_KEY
  return env
}

export class CodexAppServerConversation {
  constructor({ cwd, onText, onTool, onTiming, onState, routerToken }) {
    Object.assign(this, { cwd, onText, onTool, routerToken })
    this.onTiming = onTiming ?? (() => {})
    this.onState = onState ?? (() => {})
    this.child = null; this.pending = new Map(); this.requestId = 0
    this.threadId = null; this.turnId = null; this.active = null; this.starting = null
    this.interrupting = null
    this.state = 'warming'; this.model = MODEL; this.supportedEfforts = []
    this.turns = 0; this.contextChars = 0; this.recent = []
    this.fallback = new ExecFallback({ cwd, onText, onTool, routerToken })
  }
  get busy() { return Boolean(this.starting) || Boolean(this.active) || Boolean(this.fallback.child) }
  warm() {
    if (this.child && this.state === 'ready') return Promise.resolve()
    if (!this.starting) this.starting = this.#start().catch((err) => { this.#stopProcess(); throw err }).finally(() => { this.starting = null })
    return this.starting
  }
  async #start() {
    this.state = 'warming'; this.onState('warming')
    const began = performance.now()
    const invocation = commandFor(['-c', 'mcp_servers={}', ...DISABLED_FEATURES.flatMap((name) => ['--disable', name]), 'app-server', '--stdio'])
    const child = spawn(invocation.command, invocation.args, { cwd: this.cwd, env: safeEnv(this.routerToken), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    this.onTiming('processSpawnReturnMs', performance.now() - began)
    this.child = child; this.stderr = ''
    child.stderr.on('data', (chunk) => { this.stderr = (this.stderr + chunk).slice(-8000) })
    child.once('exit', (code) => this.#died(new Error(`Codex app-server exited (${code}): ${this.stderr.trim()}`)))
    child.once('error', (err) => this.#died(err))
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => this.#line(line))
    await this.#request('initialize', { clientInfo: { name: 'jarvis_local', title: 'JARVIS Local Bridge', version: '1.0.0' } })
    this.#notify('initialized', {})
    this.onTiming('appServerInitializeMs', performance.now() - began)
    try {
      const catalogAt = performance.now()
      const models = await this.#request('model/list', { limit: 100 })
      this.modelCatalog = models.data ?? []
      const chosen = MODEL ? this.modelCatalog.find((x) => x.model === MODEL || x.id === MODEL) : null
      if (chosen) this.model = chosen.model
      this.onTiming('modelCatalogMs', performance.now() - catalogAt)
    } catch { /* optional metadata */ }
    const resuming = Boolean(this.threadId), threadAt = performance.now()
    await this.#openThread(resuming)
    this.onTiming(resuming ? 'threadResumeMs' : 'threadStartMs', performance.now() - threadAt)
    this.state = 'ready'; this.onState('ready'); this.onTiming('prewarmTotalMs', performance.now() - began)
  }
  async #openThread(resume = false) {
    const config = { mcp_servers: { jarvis: { command: process.execPath, args: [mcpPath()], env_vars: ['JARVIS_ROUTER_TOKEN', 'JARVIS_BRIDGE_PORT'], required: true, default_tools_approval_mode: 'approve' } }, features: Object.fromEntries(DISABLED_FEATURES.map((name) => [name, false])) }
    const continuity = this.recent.length ? `\nBounded recent context from the prior thread; treat it as potentially stale:\n${this.recent.map((x) => `User: ${x.prompt}\nJARVIS: ${x.answer}`).join('\n').slice(-RECENT_CHARS)}` : ''
    const common = { cwd: this.cwd, approvalPolicy: 'never', sandbox: 'read-only', model: this.model, developerInstructions: PERSONA + continuity, config }
    const result = resume
      ? await this.#request('thread/resume', { threadId: this.threadId, ...common })
      : await this.#request('thread/start', { ...common, serviceName: 'jarvis_local' })
    this.threadId = result.thread.id; this.model = result.thread.model ?? this.model
    const activeModel = this.modelCatalog?.find((x) => x.model === this.model || x.id === this.model)
    this.supportedEfforts = activeModel?.supportedReasoningEfforts?.map((x) => x.reasoningEffort) ?? this.supportedEfforts
  }
  #effort(prompt) {
    const wanted = isComplex(prompt) ? STRONG_EFFORT : FAST_EFFORT
    if (!this.supportedEfforts.length || this.supportedEfforts.includes(wanted)) return wanted
    return this.supportedEfforts.includes('low') ? 'low' : this.supportedEfforts[0]
  }
  async ask(prompt) {
    if (this.busy) throw new Error('Codex is already answering')
    const start = performance.now()
    try { await this.warm() } catch { this.state = 'fallback'; this.onState('fallback'); return this.fallback.ask(prompt) }
    if (this.interrupting) { await this.interrupting; this.interrupting = null }
    if (this.turns >= MAX_SESSION_TURNS || this.contextChars + prompt.length > MAX_SESSION_CHARS) {
      this.threadId = null; this.turns = 0; this.contextChars = 0; await this.#openThread(false)
    }
    const active = { prompt, answer: '', resolve: null, reject: null, start, firstEvent: false, firstText: false, timer: null }
    const completion = new Promise((resolve, reject) => { active.resolve = resolve; active.reject = reject })
    this.active = active; active.timer = setTimeout(() => this.cancel(), TURN_TIMEOUT_MS)
    this.onTiming('bridgePromptProcessingMs', performance.now() - start)
    try {
      const submitted = performance.now()
      const result = await this.#request('turn/start', { threadId: this.threadId, input: [{ type: 'text', text: prompt, text_elements: [] }], effort: this.#effort(prompt), summary: 'none', approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly' } })
      this.turnId = result.turn.id; this.onTiming('requestSubmissionMs', performance.now() - submitted)
      return await completion
    } catch (err) {
      if (this.active === active) this.#finish(err)
      if (!active.answer && !this.child) { this.state = 'fallback'; this.onState('fallback'); return this.fallback.ask(prompt) }
      throw err
    }
  }
  #line(line) {
    if (!line.trim()) return
    let msg; try { msg = JSON.parse(line) } catch { return }
    if (Object.hasOwn(msg, 'id') && !msg.method) {
      const pending = this.pending.get(msg.id); if (!pending) return
      this.pending.delete(msg.id)
      if (msg.error) pending.reject(new Error(msg.error.message ?? 'Codex app-server request failed')); else pending.resolve(msg.result)
      return
    }
    if (Object.hasOwn(msg, 'id') && msg.method) { this.#write({ id: msg.id, error: { code: -32601, message: 'Client request not supported' } }); return }
    const active = this.active; if (!active || !msg.method) return
    const elapsed = performance.now() - active.start
    if (!active.firstEvent) { active.firstEvent = true; this.onTiming('firstCodexEventMs', elapsed) }
    if (msg.method === 'item/agentMessage/delta' && typeof msg.params?.delta === 'string') {
      if (!active.firstText) { active.firstText = true; this.onTiming('firstTextMs', elapsed) }
      active.answer += msg.params.delta; this.onText(msg.params.delta)
    } else if (msg.method === 'item/started' && msg.params?.item?.type && msg.params.item.type !== 'agentMessage') this.onTool(String(msg.params.item.type).replaceAll('_', ' '))
    else if (msg.method === 'turn/started') this.turnId = msg.params?.turn?.id ?? this.turnId
    else if (msg.method === 'turn/completed') this.#finish(msg.params?.turn?.status === 'failed' ? new Error(msg.params?.turn?.error?.message ?? 'Codex turn failed') : null)
  }
  #finish(err) {
    const active = this.active; if (!active) return
    this.active = null; clearTimeout(active.timer); this.onTiming('completionMs', performance.now() - active.start)
    if (err) active.reject(err)
    else {
      const answer = active.answer.trim()
      this.turns += 1; this.contextChars += active.prompt.length + answer.length
      this.recent.push({ prompt: active.prompt.slice(0, 1000), answer: answer.slice(0, 1200) })
      this.recent = this.recent.slice(-RECENT_TURNS)
      active.resolve(answer)
    }
  }
  #request(method, params) {
    const id = ++this.requestId
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.#write({ method, id, params }) })
  }
  #notify(method, params) { this.#write({ method, params }) }
  #write(message) {
    if (!this.child?.stdin.writable) throw new Error('Codex app-server is not connected')
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }
  #died(err) {
    if (!this.child) return
    this.child = null; this.state = 'warming'; this.onState('warming')
    for (const pending of this.pending.values()) pending.reject(err)
    this.pending.clear(); if (this.active) this.#finish(err)
  }
  #stopProcess() {
    if (!this.child) return
    const child = this.child; this.child = null
    try { child.stdin.end() } catch {}
    child.kill('SIGTERM')
  }
  cancel() {
    if (this.fallback.child) return this.fallback.cancel()
    if (!this.active) return
    const active = this.active, turnId = this.turnId
    this.active = null; clearTimeout(active.timer); active.resolve(active.answer.trim())
    if (this.child && this.threadId && turnId) this.interrupting = this.#request('turn/interrupt', { threadId: this.threadId, turnId }).catch(() => {})
  }
  close() {
    this.cancel(); this.fallback.close()
    this.#stopProcess()
  }
}
export const appServerModelLabel = (conversation) => conversation?.model || codexModelLabel()
