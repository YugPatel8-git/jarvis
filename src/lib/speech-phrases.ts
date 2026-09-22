/** Extract only complete, speakable phrases from a streaming model answer. */
const ABBREVIATION = /(?:^|\s)(?:mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|e\.g|i\.e|inc|ltd|no|fig|a\.m|p\.m|u\.s|u\.k)\.$/i
const BOUNDARY = /[.!?;:,]["'’)\]]?\s+|\n\n/g
const UNSPEAKABLE = /https?:\/\/|www\.|`|\[[^\]]*(?:\]|$)|\b[A-Za-z]:[\\/]|(?:^|\s)(?:\.\.?[\\/]|\/[\w.-]+\/)|\b[\w.-]+(?:\/[\w.-]+)+|[{}<>]|^\s*"[^"]+"\s*:|\b(?:const|let|function|import|export)\s+|(?:^|\s)#{1,6}\s|(?:^|\s)[\w.-]+\.(?:js|ts|tsx|json|py|mjs|md)\b/i

export function speakablePhrase(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed || UNSPEAKABLE.test(trimmed)) return false
  if (/^[-*+]\s|^\d+\.\s/.test(trimmed)) return false
  return /[\p{L}\p{N}]/u.test(trimmed)
}

export function takeSpeechPhrases(buffer: string): { phrases: string[]; rest: string } {
  const phrases: string[] = []
  let rest = buffer
  // A streamed code span can contain ordinary punctuation. Wait for its
  // closing marker before removing it, so code cannot leak as a later phrase.
  const ticks = rest.match(/`/g)?.length ?? 0
  const fences = rest.match(/```/g)?.length ?? 0
  if (ticks % 2 || fences % 2 || (ticks && !/```[\s\S]*?```|`[^`]+`/.test(rest))) {
    return { phrases, rest }
  }
  if (ticks) rest = rest.replace(/```[\s\S]*?```|`[^`]+`/g, ' ').replace(/\s+/g, ' ')
  for (;;) {
    BOUNDARY.lastIndex = 0
    let match: RegExpExecArray | null
    let cut = 0
    while ((match = BOUNDARY.exec(rest))) {
      const candidate = rest.slice(0, match.index + match[0].length)
      const words = candidate.match(/[\p{L}\p{N}]+/gu)?.length ?? 0
      const punctuation = match[0][0]
      if (punctuation === '.' && ABBREVIATION.test(candidate.trimEnd())) continue
      if (/[,:]/.test(punctuation) && words < 6) continue
      if (punctuation === ';' && words < 4) continue
      // A code fence, link, URL, or path may still be arriving. Hold it until
      // the next clean boundary, then discard it as a unit.
      cut = match.index + match[0].length
      break
    }
    if (!cut) break
    const phrase = rest.slice(0, cut)
    if (speakablePhrase(phrase)) phrases.push(phrase)
    rest = rest.slice(cut)
  }
  return { phrases, rest }
}
