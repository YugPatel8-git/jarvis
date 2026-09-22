import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

export const NORMAL = 'normal'
export const HIGH_RISK = 'high-risk'
const SECRET = /pass(word)?|secret|token|api[_-]?key|authorization|cookie|card|seed|recovery|private[_-]?key/i
const SENSITIVE = /(?:^|[\\/])(?:\.env(?:\.[^\\/]*)?|\.ssh|\.gnupg|\.aws|\.azure|\.codex|AppData[\\/]Local[\\/](?:Google[\\/]Chrome|Microsoft[\\/]Edge)[\\/]User Data|AppData[\\/]Roaming[\\/](?:Microsoft[\\/]Credentials|KeePass|1Password|Bitwarden)|wallets?)(?:[\\/]|$)|(?:Login Data|Cookies|Web Data|key4\.db|logins\.json|wallet\.dat|id_(?:rsa|ed25519))(?:$|[\\/])/i
const SYSTEM = /\b(?:format|diskpart|bcdedit|reg(?:\.exe)?\s+(?:add|delete|import)|set-mppreference|netsh\s+(?:advfirewall|firewall)|sc(?:\.exe)?\s+(?:create|delete|config|start|stop)|(?:new|set|stop|start)-service|register-scheduledtask|schtasks|runas|start-process\b[^\r\n]*-verb\s+runas|winget\s+(?:install|uninstall)|choco\s+(?:install|uninstall)|npm\s+(?:install|i)\s+-g)\b/i
const DESTROY = /\b(?:remove-item|del|erase|rmdir|rd|rm|git\s+(?:reset\s+--hard|clean\s+-[a-z]*f|push\s+[^\r\n]*--force)|cipher\s+\/w)\b/i
const SEND = /\b(?:send-mailmessage|invoke-restmethod|curl|wget)\b[^\r\n]*(?:-method\s+(?:post|put|patch|delete)|-X\s*(?:POST|PUT|PATCH|DELETE))/i

export function redact(v, d = 0) {
  if (d > 5) return '[truncated]'
  if (typeof v === 'string') return v.replace(/\b(?:sk|pk)-[\w-]{12,}\b/g, '[REDACTED]').replace(/\b(?:Bearer|Basic)\s+[\w.~+\/-]+=*/gi, '[REDACTED]').replace(/\b(?:\d[ -]*?){13,19}\b/g, '[REDACTED]')
  if (Array.isArray(v)) return v.map((x) => redact(x, d + 1))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k,x]) => [k, SECRET.test(k) ? '[REDACTED]' : redact(x,d+1)]))
  return v
}
export const sensitivePath = (p) => SENSITIVE.test(String(p ?? '').replaceAll('/', '\\'))
const risk = (action, affects, reason, irreversible) => ({ classification: HIGH_RISK, action, affects, reason, irreversible })
export function classify(tool, a = {}) {
  const text = JSON.stringify(a)
  if (tool === 'browser') {
    const target = [a.selector,a.label,a.url].filter(Boolean).join(' ')
    if (a.operation === 'type' && /pass(word)?|card|cvv|cvc|seed|recovery|private.?key|credential/i.test(target)) return risk('Enter sensitive information into a website', 'The selected field on the current external page', 'This would disclose authentication or financial information', false)
    if (a.operation === 'click' && /submit|send|publish|post|purchase|checkout|buy|pay|subscribe|transfer|trade|delete.?account|confirm.?order/i.test(target)) return risk('Activate a consequential website control', 'The current external website or account', 'This may submit, publish, purchase, transfer, or delete external data', false)
  }
  if (tool === 'filesystem') {
    if (sensitivePath(a.path) || sensitivePath(a.destination)) return risk('Access a protected credential location', 'The named protected path', 'It may contain credentials, tokens, private keys, or wallet data', false)
    if (a.operation === 'delete') return risk('Delete files or folders', String(a.path ?? 'the requested path'), 'Deletion can remove user data', true)
    if (a.operation === 'move' && a.overwrite) return risk('Overwrite a move destination', String(a.destination ?? 'the destination'), 'Existing data could be irreversibly replaced', true)
  }
  if (tool === 'shell') {
    const cmd = [a.command, ...(a.args ?? []), a.script].filter(Boolean).join(' ')
    if (/\.env(?:\.[\w-]+)?\b/i.test(cmd)) return risk('Access an environment file', 'Project credentials', 'Environment files may contain secret keys', false)
    if (SYSTEM.test(cmd)) return risk('Run a system-level command', 'Windows, installed software, services, registry, firewall, or startup settings', 'It changes machine-wide state or security configuration', true)
    if (DESTROY.test(cmd)) return risk('Run a destructive command', 'Files or Git work in the command target', 'It may permanently discard significant work or data', true)
    if (SEND.test(cmd)) return risk('Send data to an external service', 'Data in the outbound request', 'This creates an external consequence and may disclose information', false)
  }
  if (tool === 'mcp') return risk('Run a third-party integration action', String(a.server ?? 'the configured service'), 'External integrations can create external consequences', false)
  if (/password|credential|seed phrase|recovery code|private key/i.test(text)) return risk('Handle authentication material', 'Credentials or private authentication data', 'Sensitive values must not be exposed or entered without permission', false)
  return { classification: NORMAL }
}
export async function audit(entry) {
  const file = resolve('logs','tool-audit.jsonl')
  await mkdir(dirname(file), { recursive: true })
  await appendFile(file, JSON.stringify(redact({ timestamp: new Date().toISOString(), ...entry }))+'\n', { encoding:'utf8', mode:0o600 })
}
