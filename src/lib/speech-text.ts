/** Local, deterministic display-to-speech conversion. Display text is untouched. */
export type SpeechContext = { literalTechnical?: boolean }

export function wantsLiteralTechnicalSpeech(request: string): boolean {
  return /\b(?:read|say|speak|tell me|give me|spell)\b.{0,32}\b(?:exact|literally|verbatim|command|url|link|path|code|error|spell(?:ing)?)\b|\bspell (?:that|it|this|out)\b/i.test(request)
}

const SMALL = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen']
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']

function words(n: number): string {
  if (n < 20) return SMALL[n]
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? `-${SMALL[n % 10]}` : '')
  if (n < 1000) return `${SMALL[Math.floor(n / 100)]} hundred${n % 100 ? ` ${words(n % 100)}` : ''}`
  return String(n)
}

function basename(path: string): string {
  return path.replace(/[:;,.)]+$/, '').split(/[\\/]/).filter(Boolean).at(-1) ?? 'file'
}

function naturalPath(path: string): string {
  const file = basename(path.replace(/:\d+(?::\d+)?$/, ''))
  return /(?:^|[\\/])src[\\/]/i.test(path)
    ? `${file} in the source folder`
    : `the ${file} file in your JARVIS project`
}

function naturalUrl(raw: string): string {
  try {
    const u = new URL(raw.replace(/[.,;!?)]*$/, ''))
    if (/^(?:www\.)?github\.com$/i.test(u.hostname)) {
      const names = u.pathname.split('/').filter(Boolean)
      if (names.length >= 2) return `the ${names[0] === 'openai' ? 'OpenAI ' : ''}${names[1] === 'codex' ? 'Codex ' : ''}GitHub page`.replace(/\s+/g, ' ')
      return 'the GitHub page'
    }
    return 'the link on screen'
  } catch {
    return 'the link on screen'
  }
}

const WINDOWS_PATH = /\b[A-Za-z]:\\(?:[^\s\\]+\\)*[^\s\\]+/g
const RELATIVE_PATH = /(?:^|\s)((?:\.\.?[\\/])?(?:src|scripts|bridge|public|docs)[\\/][\w.\\/-]+)/g
const URL_PATTERN = /https?:\/\/[^\s<>)]*/gi

function finish(text: string): string {
  const clean = text.replace(/\s+/g, ' ').replace(/\s+([,.!?;:])/g, '$1').trim()
  if (!clean) return ''
  const first = clean[0].toUpperCase() + clean.slice(1)
  return /[.!?;:,]$/.test(first) ? first : `${first}.`
}

export function toSpeechText(displayText: string, context: SpeechContext = {}): string {
  const raw = displayText.trim()
  if (!raw) return ''
  if (context.literalTechnical) return raw.replace(/\s+/g, ' ')
  const original = raw.replace(/^\s*(?:#{1,6}\s*|\*\*|__)/, '').replace(/(?:\*\*|__)$/, '').trim()

  if (/^(?:compiling|retrieving|searching|executing|processing)\s*(?:\.{0,3}|…)?$/i.test(original)) return ''
  if (/^(?:executing command|processing your request|running tool|calling mcp|reading filesystem)\b/i.test(original)) return ''
  if (/^(?:stdout|stderr|agent message delta|internal route|debug metadata|exit code\s*\d+)\b/i.test(original)) return ''
  if (/^(?:route|backend|tool|function)\s*[:=]/i.test(original) || /^mcp__[\w_]+$/i.test(original)) return ''
  if (/^(?:\{[\s\S]*\}|\[[\s\S]*\])$/.test(original)) return ''
  if (/^\s*\|.+\|\s*$/m.test(original) && /\|\s*:?-{3}/.test(original)) return ''
  if (/^(?:const|let|var|function|import|export)\s+|=>|===|&&|\|\|/.test(original)) return ''
  if (/\b[A-Z][A-Z0-9_]{3,}=(?![01]\b)\S+/.test(original)) return ''
  if (/^(?:at\s+\S+|\s*\w*Error:)[\s\S]*\n\s*at\s+/i.test(original)) {
    const path = original.match(/(?:[A-Za-z]:\\|(?:src|scripts|bridge)\/)[^\s:]+|\b[\w.-]+\.(?:tsx?|jsx?|py|mjs)\b/i)?.[0]
    return path ? `There's an error in ${basename(path)}.` : "There's an error."
  }

  if (/^(?:npm run build|the build)\s+(?:exited with code|finished with exit code)\s+0\.?$/i.test(original) || /^build successful\.?$/i.test(original)) return 'The build finished successfully.'
  if (/^process exited with code [1-9]\d*\.?$/i.test(original)) return 'The command failed.'
  if (/^(?:npm run build|the build)\s+(?:exited with code|finished with exit code)\s+[1-9]\d*\.?$/i.test(original)) return 'The build failed.'
  if (/^(?:task completed successfully|operation successful)\.?$/i.test(original)) return 'Done.'
  if (/^certainly\.?$/i.test(original)) return 'Sure.'
  if (/^error at\s+(.+?)(?::\d+(?::\d+)?)?\.?$/i.test(original)) {
    const path = original.replace(/^error at\s+/i, '').replace(/:\d+(?::\d+)?\.?$/, '')
    return `There's an error in ${basename(path)}.`
  }
  if (/^JARVIS_ALLOW_WRITES=1\.?$/i.test(original)) return 'Write access is enabled.'
  if (/^JARVIS_ALLOW_WRITES=0\.?$/i.test(original)) return 'Write access is disabled.'
  if (/^npm run build\.?$/i.test(original)) return "I'll run the build."
  if (/^git status\.?$/i.test(original)) return "I'll check the Git status."
  if (/^npm install\.?$/i.test(original)) return "I'll install the project dependencies."
  if (/^(?:npm|npx|node|git|python|pip|pwsh|powershell|cd|ls|dir|Get-ChildItem|curl)\s+\S+/i.test(original)) return "I'll run the command."
  if (/^https?:\/\/\S+$/i.test(original)) return finish(naturalUrl(original))
  if (/^(?:[A-Za-z]:\\|(?:src|scripts|bridge|public|docs)[\\/])\S+$/i.test(original)) return finish(naturalPath(original))
  if (/^\d+(?:\.\d+)?s$/i.test(original)) {
    const [whole, fraction] = original.slice(0, -1).split('.')
    return finish(`about ${words(Number(whole))}${fraction ? ` point ${fraction.split('').map((d) => SMALL[Number(d)]).join(' ')}` : ''} seconds`)
  }

  let text = displayText
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*\|?\s*:?-{3,}:?(?:\s*\|\s*:?-{3,}:?)*\s*\|?\s*$/gm, '')
    .replace(/^\s*Sources?:.*$/gim, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(URL_PATTERN, (url) => naturalUrl(url))
    .replace(WINDOWS_PATH, (path) => naturalPath(path))
    .replace(RELATIVE_PATH, (_match, path: string) => ` ${naturalPath(path)}`)
    .replace(/\b(?:npm run build)\b/gi, 'the build')
    .replace(/\b(?:git status)\b/gi, 'the Git status')
    .replace(/\b(?:npm install)\b/gi, 'the project dependencies')
    .replace(/\bmcp__[\w_]+\b/gi, 'the connected tool')
    .replace(/\bJARVIS_ALLOW_WRITES=1\b/gi, 'write access is enabled')
    .replace(/\bJARVIS_ALLOW_WRITES=0\b/gi, 'write access is disabled')
    .replace(/\b(\d{1,2})\.(\d+)s\b/gi, (_m, a: string, b: string) => `about ${words(Number(a))} point ${b.split('').map((d) => SMALL[Number(d)]).join(' ')} seconds`)
    .replace(/\b(\d{1,3})%/g, (_m, n: string) => `${words(Number(n))} percent`)
    .replace(/\$(\d{1,3})\b/g, (_m, n: string) => `${words(Number(n))} dollars`)
    .replace(/\b(in|by|since|until|through|from|year)\s+20(\d{2})\b/gi, (_m, lead: string, year: string) => `${lead} twenty ${words(Number(year))}`)
    .replace(/\bGPT\b/g, 'G P T')
    .replace(/\bnpm\b/gi, 'N P M')
    .replace(/\bVS Code\b/gi, 'V S Code')
    .replace(/\*\*|__|`|^\s{0,3}#{1,6}\s*|^\s*[-*+]\s+/gm, '')
    .replace(/[|<>]/g, ' ')
    .replace(/\s*[\\/_*#]\s*/g, ' ')
    .replace(/\b(?:compiling|executing|processing|calling mcp|running tool)\b[.:]?/gi, '')
  if (/^\s*(?:typeerror|referenceerror|syntaxerror)\b/i.test(text)) text = "There's an error."
  return finish(text)
}
