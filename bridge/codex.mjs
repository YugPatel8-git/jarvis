import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import process from 'node:process'

const TURN_TIMEOUT_MS = Number(process.env.JARVIS_TURN_TIMEOUT_MS ?? 120_000)
const MODEL = process.env.JARVIS_CODEX_MODEL?.trim() || null

const PERSONA = `You are JARVIS. You are speaking out loud to one person.

Keep conversational replies to at most two short sentences and usually under
thirty words. Use plain spoken prose only: no markdown, headings, bullets,
code fences, URLs, raw JSON, or emoji. Be dry, precise, calmly competent, and
occasionally address the user as sir. Do not claim to have used tools.

You are running as a conversation engine in a read-only sandbox. Do not run
commands, inspect files, browse, use MCP servers, or attempt to change the
machine. If a request needs a capability you do not have, state that constraint
briefly. Never ask for an API key. Your authentication is managed by the local
Codex CLI and must never be discussed or exposed.`

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
  constructor({ cwd, onText, onTool }) {
    this.cwd = cwd
    this.onText = onText
    this.onTool = onTool
    this.sessionId = null
    this.child = null
    this.cancelled = false
  }

  async ask(prompt) {
    if (this.child) throw new Error('Codex is already answering')
    this.cancelled = false

    const common = [
      '--sandbox', 'read-only',
      '--ask-for-approval', 'never',
      'exec',
    ]
    const mode = this.sessionId
      ? ['resume', '--ignore-user-config', '--ignore-rules', '--json', this.sessionId, '-']
      : ['--ignore-user-config', '--ignore-rules', '--json', '--cd', this.cwd, '-']
    if (MODEL) mode.splice(mode.length - 1, 0, '--model', MODEL)

    const invocation = commandFor([...common, ...mode])
    // Never let an API key override the saved ChatGPT login. Authentication
    // files are left to Codex itself and are never read by this bridge.
    const childEnv = { ...process.env }
    delete childEnv.OPENAI_API_KEY
    delete childEnv.CODEX_API_KEY
    const child = spawn(invocation.command, invocation.args, {
      cwd: this.cwd,
      env: childEnv,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child

    const input = this.sessionId ? prompt : `${PERSONA}\n\nUser: ${prompt}`
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
        resolve(answer.trim())
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
    child.kill('SIGTERM')
  }

  close() {
    this.cancel()
    this.sessionId = null
  }
}

export const codexModelLabel = () => MODEL || 'Codex default'
