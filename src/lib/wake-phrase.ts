/** Narrow wake matching for local standby recognition. */
const WAKE = /\bhey[,]?\s+jarvis\b(?!'s)/i

export function hasWakePhrase(text: string): boolean {
  return WAKE.test(text)
}

export function afterWakePhrase(text: string): string {
  const match = WAKE.exec(text)
  return match ? text.slice(match.index + match[0].length).replace(/^[\s,.:;!?-]+/, '').trim() : ''
}

/** Remove a wake vocative from the beginning, including one accidental repeat. */
export function commandAfterWake(text: string): string {
  let command = text.trim()
  for (let i = 0; i < 2; i++) {
    command = command.replace(/^\s*(?:(?:hey[,]?\s+)?jarvis)\b[\s,.:;!?-]*/i, '').trim()
  }
  return command
}
