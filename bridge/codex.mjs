import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import process from 'node:process'

const TURN_TIMEOUT_MS = Number(process.env.JARVIS_TURN_TIMEOUT_MS ?? 120_000)
const MODEL = process.env.JARVIS_CODEX_MODEL?.trim() || 'gpt-5.6-sol'
const MAX_SESSION_TURNS = Number(process.env.JARVIS_SESSION_TURNS ?? 24)
const MAX_SESSION_CHARS = Number(process.env.JARVIS_SESSION_CHARS ?? 40_000)
const RECENT_TURNS = 6
const RECENT_CHARS = 6_000

const PERSONA = `You are JARVIS. You are speaking out loud to one person.

Keep conversational replies to at most two short sentences and usually under
thirty words. For a simple factual question, answer with the fact alone when
sufficient; for example, a capital-city answer can be just "Tokyo." Add context
only when useful. If a question is repeated, answer it directly again instead
of referring to an earlier answer. Give complex tasks the detail they need. Use plain spoken prose only: no markdown, headings, bullets,
code fences, URLs, raw JSON, or emoji. Be professional, composed, concise, and
occasionally dryly humorous when appropriate; never let wit reduce clarity,
accuracy, or efficiency. Stay direct for errors, security, urgent or serious
matters. Do not censor ordinary language. Do not claim to have used tools.

Your only machine capabilities are the tools from the jarvis MCP server. Use
the browser read tool when asked about the current webpage. Use tools when the
user asks you to act, without narrating progress. Answer when results are ready.
Never try to bypass that server with your
built-in shell: the Codex sandbox is deliberately read-only. The router executes
normal actions immediately and independently pauses high-risk actions for the
user's explicit approval. Do not claim success until the tool returns success.
Use camera vision only when the user asks you to look. Never ask for an API key.
Authentication is managed by the local Codex CLI and must never be exposed.`

function commandFor(args) {
  if (process.platform !== 'win32') return { command: 'codex', args }
  // npm installs Codex as codex.cmd on Windows. cmd.exe is used only to invoke
  // that fixed wrapper; every argument is generated here and the user prompt
  // travels over stdin, never through the command line.
  return {
    command: process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe',
    args: ['/d', '/s', '/c', 'codex', ...args],
  }
}

function textFromEvent(event) {
  if (typeof event.delta === 'string') return event.delta
  if (typeof event.text === 'string') return event.text
  if (typeof event.item?.delta === 'string') return event.item.delta
  if (event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
    return event.item.text
  }
  return ''
}

export class CodexConversation {
  constructor({ cwd, onText, onTool, routerToken }) {
    this.cwd = cwd
    this.onText = onText
    this.onTool = onTool
    this.routerToken = routerToken
    this.sessionId = null
    this.child = null
    this.cancelled = false
    this.turns = 0
    this.contextChars = 0
    this.recent = []
  }

  async ask(prompt) {
    if (this.child) throw new Error('Codex is already answering')
    this.cancelled = false
    if(this.sessionId&&(this.turns>=MAX_SESSION_TURNS||this.contextChars+prompt.length>MAX_SESSION_CHARS)){
      this.sessionId=null
      this.turns=0
      this.contextChars=0
    }
    const resuming=Boolean(this.sessionId)

    const mcpFile = new URL('./mcp-server.mjs', import.meta.url)
    const common = [
      '--sandbox', 'read-only',
      '--ask-for-approval', 'never',
      '-c', `mcp_servers.jarvis.command=${JSON.stringify(process.execPath)}`,
      '-c', `mcp_servers.jarvis.args=${JSON.stringify([decodeURIComponent(mcpFile.pathname.replace(/^\/(?:[A-Za-z]:)/, (m) => m.slice(1))).replaceAll('/', '\\\\')])}`,
      '-c', 'mcp_servers.jarvis.env_vars=["JARVIS_ROUTER_TOKEN","JARVIS_BRIDGE_PORT"]',
      '-c', 'mcp_servers.jarvis.required=true',
      '-c', 'mcp_servers.jarvis.default_tools_approval_mode="approve"',
      '-c', 'features.plugins=false',
      'exec',
    ]
    const mode = resuming
      ? ['resume', '--ignore-user-config', '--ignore-rules', '--json', this.sessionId, '-']
      : ['--ignore-user-config', '--ignore-rules', '--json', '--cd', this.cwd, '-']
    if (MODEL) mode.splice(mode.length - 1, 0, '--model', MODEL)

    const invocation = commandFor([...common, ...mode])
    // Never let an API key override the saved ChatGPT login. Authentication
    // files are left to Codex itself and are never read by this bridge.
    const childEnv = { ...process.env }
    delete childEnv.OPENAI_API_KEY
    delete childEnv.CODEX_API_KEY
    childEnv.JARVIS_ROUTER_TOKEN = this.routerToken
    const child = spawn(invocation.command, invocation.args, {
      cwd: this.cwd,
      env: childEnv,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child

    const continuity=this.recent.length
      ? '\n\nBounded recent context from the prior session; treat it as potentially stale:\n'+this.recent.map(x=>`User: ${x.prompt}\nJARVIS: ${x.answer}`).join('\n').slice(-RECENT_CHARS)
      : ''
    const input = resuming ? prompt : `${PERSONA}${continuity}\n\nUser: ${prompt}`
    child.stdin.end(input, 'utf8')

    let answer = ''
    let stderr = ''
    let parseError = null
    const timer = setTimeout(() => this.cancel(), TURN_TIMEOUT_MS)
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })

    lines.on('line', (line) => {
      if (!line.trim()) return
      let event
      try {
        event = JSON.parse(line)
      } catch (err) {
        parseError = err
        return
      }

      if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
        this.sessionId = event.thread_id
      }

      // Codex versions may expose message text as deltas, item updates, or only
      // the completed agent_message. Emit only the unseen suffix in every case.
      const candidate = textFromEvent(event)
      if (candidate) {
        const delta = candidate.startsWith(answer) ? candidate.slice(answer.length) : candidate
        if (delta) {
          answer += delta
          this.onText(delta)
        }
      }

      if (event.type === 'item.started' && event.item?.type && event.item.type !== 'agent_message') {
        this.onTool(event.item.type.replaceAll('_', ' '))
      }
    })

    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-8_000)
    })

    return await new Promise((resolve, reject) => {
      child.once('error', (err) => reject(new Error(`Could not start Codex CLI: ${err.message}`)))
      child.once('close', (code) => {
        clearTimeout(timer)
        lines.close()
        if (this.child === child) this.child = null
        if (this.cancelled) return resolve(answer.trim())
        if (code !== 0) {
          const detail = stderr.trim() || parseError?.message || `exit code ${code}`
          return reject(new Error(`Codex CLI failed: ${detail}`))
        }
        const final=answer.trim()
        this.turns+=1
        this.contextChars+=prompt.length+final.length
        this.recent.push({prompt:prompt.slice(0,1000),answer:final.slice(0,1200)})
        this.recent=this.recent.slice(-RECENT_TURNS)
        resolve(final)
      })
    })
  }

  cancel() {
    this.cancelled = true
    if (!this.child) return
    const child = this.child
    this.child = null
    // An interrupted rollout may not be safe to resume while its process is
    // unwinding, so the next utterance starts a fresh session.
    this.sessionId = null
    child.stdin.destroy()
    if (process.platform === 'win32' && child.pid) {
      // codex.cmd runs beneath cmd.exe on Windows. Killing only the wrapper
      // leaves codex.exe generating in the background, so terminate this one
      // process tree by its concrete PID. No shell or model-supplied input is
      // involved.
      spawn(process.env.SystemRoot + '\\System32\\taskkill.exe', [
        '/pid', String(child.pid), '/t', '/f',
      ], { windowsHide: true, stdio: 'ignore', shell: false })
    } else {
      child.kill('SIGTERM')
    }
  }

  close() {
    this.cancel()
    this.sessionId = null
  }
}

export const codexModelLabel = () => MODEL || 'Codex default'
