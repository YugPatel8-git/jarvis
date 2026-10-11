import { APPS, TERMS, sensitiveSpeech } from '../shared/speech-vocabulary.mjs'

const clean = text => text.replace(/\s+/g, ' ').trim()
const protectedInput = /\d|[$€£¥]|https?:|www\.|[\\/@`"“”]|\b\w+\.\w+\b|\b(?:delete|remove|erase|wipe|format|destroy|reset|rebase|checkout|clean|force|push|commit|merge|revert|discard|overwrite|rename|move|password|pay|payment|money|amount|dollars?|cents?|bank\w*|crypto|bitcoin|wallet|transfer|buy|sell|purchase|trade|send|publish|sudo|admin\w*|permission\w*|security|firewall|encrypt\w*|decrypt\w*|file|filename|path|drive)\b/i
const uncertain = /\b(?:maybe|perhaps|not sure|i think|or|uncertain|something like)\b/i
const uncertaintyAlias = /\b(?:visual studio cold|git statues|down loads|screen sheriff|crow|sea drive)\b/i
const aliases = new Map([
  ['visual studio cold', 'Visual Studio Code'], ['git statues', 'git status'],
  ['down loads', 'Downloads'], ['screen sheriff', 'screen share'], ['crow', 'Chrome'],
])
const candidates = Object.values(APPS).flat().map(text => ({ text, lower: text.toLowerCase() }))
const termPatterns = TERMS.map(term => [term, new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')])

// Store only known vocabulary tags, never full conversation/screen content.
export function contextTerms(text) {
  if (typeof text !== 'string' || sensitiveSpeech(text)) return []
  const bounded = text.slice(0, 2048)
  if (/\b(?:not|never|avoid|instead|don't|do not)\b/i.test(bounded)) return []
  return termPatterns.filter(([, pattern]) => pattern.test(bounded)).map(([term]) => term)
}

export function createSpeechContext() {
  const turns = []
  return {
    remember(text) { turns.push(contextTerms(text)); if (turns.length > 4) turns.shift() },
    terms: () => [...new Set(turns.flat())],
  }
}

// At most 32x32 cells and a single edit; never match arbitrary arguments/paths.
function oneEdit(a, b) {
  if (a.length > 32 || b.length > 32 || Math.abs(a.length - b.length) > 1) return false
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(row[j - 1] + 1, previous[j] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    if (Math.min(...row) > 1) return false
    previous = row
  }
  return previous[b.length] === 1
}

export function normalizeSpeech(rawTranscript, context = {}, rawChunks = [rawTranscript]) {
  const result = { rawTranscript, rawChunks: [...rawChunks], normalizedTranscript: rawTranscript,
    confidence: 'low', reason: 'unchanged', suggestion: null, clarification: null }
  if (sensitiveSpeech(rawTranscript)) return { ...result, reason: 'sensitive', clarification: 'Please rephrase without sharing credentials or authentication codes.' }
  if (rawTranscript.length > 512) return { ...result, reason: 'length-limit' }
  if (protectedInput.test(rawTranscript)) {
    return { ...result, reason: 'protected', clarification: uncertain.test(rawTranscript) || uncertaintyAlias.test(rawTranscript)
      ? 'Please clarify the exact instruction and target before I act.' : null }
  }
  if (uncertain.test(rawTranscript)) return { ...result, reason: 'uncertain', clarification:
    /^\s*(?:open|run|turn on|turn off)\b/i.test(rawTranscript) ? 'Please clarify what you want me to do.' : null }
  const text = clean(rawTranscript), punctuation = /[.!?]$/.test(text) ? text.slice(-1) : ''
  const body = punctuation ? text.slice(0, -1) : text
  // Corrections are restricted to a whole entity or one explicit entity slot.
  // Search queries, dictation, quoted text and free-form instructions are left alone.
  const match = /^(?:(open |run |turn off |turn on |what is |explain |tell me about ))?([a-z ]+)$/i.exec(body)
  if (!match) return result
  const prefix = match[1] ?? '', entity = match[2].toLowerCase()
  const reasoning = /^(?:what is|explain|tell me about) /i.test(prefix)
  const knownContext = new Set((context.terms ?? []).filter(term => TERMS.includes(term)))
  let target = aliases.get(entity), confidence = 'high', reason = 'exact-alias'
  if (target && prefix && !reasoning) {
    const allowed = target === 'git status' ? /^run $/i
      : target === 'screen share' ? /^turn (?:on|off) $/i : /^open $/i
    if (!allowed.test(prefix)) return result
  }
  if (target === 'Downloads' && prefix.toLowerCase() !== 'open ') return result
  if (entity === 'crow') {
    if (prefix.toLowerCase() !== 'open ') return result
    confidence = knownContext.has('Chrome') && !knownContext.has('YouTube') ? 'high' : 'medium'
    reason = 'context-app'
  }
  if (entity === 'screen sheriff') {
    confidence = context.screenSharing || knownContext.has('screen share') || knownContext.has('screen sharing') ? 'high' : 'medium'
    if (/^turn (?:on|off) /i.test(prefix)) target = 'screen sharing'
    reason = 'context-screen'
  }
  if (!target && /^open $/i.test(prefix) && entity.length >= 5 && entity.length <= 32 && !TERMS.some(term => term.toLowerCase() === entity)) {
    const matches = candidates.filter(candidate => oneEdit(entity, candidate.lower))
    if (matches.length === 1) {
      target = matches[0].text
      // Fuzzy matches never execute silently, even with context.
      confidence = 'medium'; reason = 'bounded-app-similarity'
    }
  }
  if (!target) return result
  const suggestion = `${prefix}${target}${punctuation}`
  if (confidence === 'medium') return { ...result, confidence, reason, suggestion,
    clarification: reasoning ? null : `Did you mean ${target}? Please repeat the full request.` }
  return { ...result, confidence, reason, normalizedTranscript: suggestion }
}

/** Compact evidence in the existing main request, never a correction call. */
export function speechPrompt(result) {
  if (result.confidence === 'high' && clean(result.rawTranscript) !== result.normalizedTranscript) {
    return `Raw speech: ${JSON.stringify(result.rawTranscript)}\nInterpreted speech: ${JSON.stringify(result.normalizedTranscript)}`
  }
  if (result.confidence === 'medium' && !result.clarification) {
    return `Raw speech: ${JSON.stringify(result.rawTranscript)}\nPossible interpretation (uncertain): ${JSON.stringify(result.suggestion)}\nExplain only; do not take actions based on this guess. State the interpretation or ask a brief clarification.`
  }
  return result.rawTranscript
}

// Metadata must describe the text already supplied, not introduce a new command.
export function readSpeechInput(text, speech) {
  if (!speech || !Array.isArray(speech.rawChunks) || !speech.rawChunks.length || speech.rawChunks.length > 256) return null
  if (speech.rawChunks.some(chunk => typeof chunk !== 'string')) return null
  const rawTranscript = speech.rawChunks.join(' ')
  if (rawTranscript.length > 32768 || clean(rawTranscript) !== clean(text)) return null
  return { rawTranscript, rawChunks: speech.rawChunks.slice() }
}
