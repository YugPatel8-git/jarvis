/** Extract stable phrase boundaries; speech-text.ts decides what to say. */
const ABBREVIATION = /(?:^|\s)(?:mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|e\.g|i\.e|inc|ltd|no|fig|a\.m|p\.m|u\.s|u\.k)\.$/i
const BOUNDARY = /[.!?;:,]["'’)\]]?\s+|\n\n/g

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
  if (ticks) rest = rest.replace(/```[\s\S]*?```/g, ' ').replace(/\s+/g, ' ')
  for (;;) {
    BOUNDARY.lastIndex = 0
    let match: RegExpExecArray | null
    let cut = 0
    while ((match = BOUNDARY.exec(rest))) {
      const candidate = rest.slice(0, match.index + match[0].length)
      const words = candidate.match(/[\p{L}\p{N}]+/gu)?.length ?? 0
      const punctuation = match[0][0]
      if (punctuation === '.' && ABBREVIATION.test(candidate.trimEnd())) continue
      // A short complete acknowledgement can start while the next sentence
      // is still arriving. Keep comma clauses substantial enough to sound human.
      if (/[,:]/.test(punctuation) && words < 5) continue
      if (punctuation === ';' && words < 4) continue
      // The whitespace after punctuation makes this a stable boundary. The
      // normalizer handles any technical content inside the phrase.
      cut = match.index + match[0].length
      break
    }
    if (!cut) break
    const phrase = rest.slice(0, cut)
    phrases.push(phrase)
    rest = rest.slice(cut)
  }
  return { phrases, rest }
}
