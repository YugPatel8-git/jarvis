// Public, bounded vocabulary only. Never put user text or secrets in STT hints.
export const APPS = Object.freeze({
  chrome: ['Chrome'], code: ['Visual Studio Code', 'VS Code'], notepad: ['Notepad'],
  calculator: ['Calculator'], downloads: ['Downloads'], youtube: ['YouTube'],
})
export const TERMS = Object.freeze([
  ...Object.values(APPS).flat(), 'git status', 'npm', 'node', 'Codex', 'build',
  'lint', 'branch', 'commit', 'push', 'diagnostics', 'screen share', 'screen sharing',
  'microphone', 'Fish', 'Kokoro',
])
const appCommands = new Map()
for (const [id, names] of Object.entries(APPS)) {
  for (const name of names) {
    appCommands.set(`open ${name.toLowerCase()}`, `open:${id}`)
    if (id === 'chrome' || id === 'code') appCommands.set(`close ${name.toLowerCase()}`, `close:${id}`)
  }
}
appCommands.set('open my downloads', 'open:downloads')
export const appCommand = text => appCommands.get(text.toLowerCase())

// Conservative exclusion, not a replacement for the router's approval policy.
export const sensitiveSpeech = text => /\b(?:pass\s*word|passphrase|credential\w*|secret\w*|api\s*key|token|bearer|mfa|otp|pin|verification\s*code|auth\w*|seed\s*phrase|recovery\s*code|private\s*key|login|log\s*in|sign\s*in)\b|(?:sk|ghp|gho|xoxb)[-_][\w-]+|\b[A-Za-z0-9+/=_-]{24,}\b/i.test(text)
export const diagnosticSpeech = text => sensitiveSpeech(text) ? '[REDACTED]' : text

/** No installs, downloads, engine switch, or dynamic/private phrase hints. */
export function applySpeechHints(rec, Phrase) {
  if (!('phrases' in rec) || typeof Phrase !== 'function') return false
  try {
    rec.phrases = TERMS.map(term => new Phrase(term, 2))
    return true
  } catch {
    try { rec.phrases = [] } catch { /* unsupported engine */ }
    return false
  }
}
