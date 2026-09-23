import { BRIDGE_HTTP_URL, TTS_ENGINE } from '../config'
import * as kokoro from './kokoro'
import { caps, capabilitiesProbed } from './capabilities'
import { takeSpeechPhrases } from './speech-phrases'
import { toSpeechText, type SpeechContext } from './speech-text'

/**
 * Speech output.
 *
 * Fish Audio is reached only through the local bridge when configured.
 * Kokoro and browser speechSynthesis remain the local fallbacks.
 *
 * Text is cut at stable clauses and sentences as it streams in, so JARVIS can
 * start talking while Codex is still writing.
 *
 * The queue is an explicit array with a single pump rather than a promise
 * chain. A chain cannot be cut: cancelling mid-sentence left the chain's tail
 * unresolved forever, which wedged the whole assistant. An array can simply be
 * emptied.
 */

type Speaker = {
  /** Feed streamed text in. Stable phrases are spoken as they appear. */
  push: (delta: string) => void
  /** Speak a phrase ahead of anything still queued. Used for filler like
   *  "Working on it, sir" while a tool runs. */
  say: (text: string) => void
  /** No more text coming — flush the remainder and resolve when audio ends. */
  end: () => Promise<void>
  /** Cut it off mid-sentence (barge-in). Always settles `end()`. */
  cancel: () => void
  /** 0..1 output loudness for the visualiser. */
  level: () => number
  markModelDelta: () => void
}

// ---------------------------------------------------------------------------
// What he is saying right now
// ---------------------------------------------------------------------------

let speaking = ''
let recent = ''
let recentUntil = 0

/** Recognition lags the speakers by a few hundred milliseconds, so a sentence
 *  keeps arriving at the microphone well after it has finished playing. */
const ECHO_TAIL_MS = 1800

/**
 * Why you cannot hear him.
 *
 * Published on `window.__tts`. Speech has exactly four ways to fail silently —
 * the engine never started, the OS voice errored, every line was cancelled by
 * a barge-in, or nothing was ever queued — and from outside the page they are
 * indistinguishable. This tells them apart at a glance.
 */
export const diag = {
  engine: 'system' as 'system' | 'kokoro' | 'fish',
  /** Utterances handed to an engine — the OS voice or an audio element. */
  spoken: 0,
  /**
   * Of those, how many actually began producing sound.
   *
   * Counted for EVERY engine, which it did not used to be: this was incremented
   * only in speakNative's onstart, so on the ElevenLabs path — the good path,
   * the one a configured machine actually uses — it stayed at zero forever.
   * The diagnostics panel reads this to decide whether he is audible at all, so
   * a working cloud voice reported "no sound produced", and the T self-test
   * raised that as an error on screen. The verdict has to be about sound, not
   * about which code path produced it.
   */
  started: 0,
  /** Genuine engine failures, excluding deliberate cancels. */
  failures: 0,
  /** Last SpeechSynthesis error code, e.g. 'synthesis-failed'. */
  lastError: '',
  voice: '',
  lastText: '',
  /** Queue-to-audible-start latency for the most recent spoken chunk. */
  lastStartLatencyMs: 0,
  /** Lowest queue-to-start latency observed in this page session. */
  bestStartLatencyMs: 0,
  firstModelDeltaMs: 0,
  firstPhraseMs: 0,
  firstTtsStartMs: 0,
  firstAudioReadyMs: 0,
  firstAudibleMs: 0,
  /** Latest phrase stage timings, relative to phrase readiness. */
  stages: {} as Record<string, number>,
  phraseGapMs: 0,
  phraseGapsMs: [] as number[],
  queueDepth: 0,
  pendingFish: 0,
  playbackTimeouts: 0,
}

export type VoiceSettings = { volume: number; clarity: 'off' | 'low' | 'medium'; gap: 'tight' | 'natural' }
const SETTINGS_KEY = 'jarvis.voice.output.v1'
const DEFAULT_SETTINGS: VoiceSettings = { volume: 115, clarity: 'low', gap: 'natural' }
function readSettings(): VoiceSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Partial<VoiceSettings>
    return {
      volume: Number.isFinite(saved.volume) ? Math.max(80, Math.min(150, Number(saved.volume))) : 115,
      clarity: saved.clarity === 'off' || saved.clarity === 'medium' ? saved.clarity : 'low',
      gap: saved.gap === 'tight' ? 'tight' : 'natural',
    }
  } catch { return { ...DEFAULT_SETTINGS } }
}
let settings = typeof localStorage === 'undefined' ? { ...DEFAULT_SETTINGS } : readSettings()
export function voiceSettings(): VoiceSettings { return { ...settings } }
export function setVoiceSettings(next: Partial<VoiceSettings>): void {
  settings = { ...settings, ...next }
  settings.volume = Math.max(80, Math.min(150, settings.volume))
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
}

if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__tts = diag
}

let speakingAt = 0

/** When the current sentence started, or 0 if nothing is being spoken. The
 *  voice loop uses this to refuse to interrupt him in his own first syllable. */
export function speakingSince(): number {
  return speaking ? speakingAt : 0
}

function setSpeaking(text: string) {
  if (text) {
    speaking = text
    speakingAt = Date.now()
    return
  }
  if (speaking) {
    recent = speaking
    recentUntil = Date.now() + ECHO_TAIL_MS
  }
  speaking = ''
}

/**
 * What the microphone is likely to be hearing from the speakers right now.
 *
 * The voice loop reads this to recognise itself: the mic stays open while he
 * talks, so it hears every word he says and would otherwise treat his own
 * answer as a barge-in. Includes a short tail of the previous sentence,
 * because the gap between two sentences is exactly when the echo of the first
 * one lands. See `isEcho` in voice.ts.
 */
export function speakingNow(): string {
  const tail = Date.now() < recentUntil ? recent : ''
  return `${speaking} ${tail}`.trim()
}

// ---------------------------------------------------------------------------
// Voice selection
// ---------------------------------------------------------------------------

const VOICE_PREF_KEY = 'jarvis.voice'

/**
 * Rank installed voices by how close they are to the character: a British
 * male, low and level, not a novelty voice.
 *
 * The big win on macOS is the Enhanced/Premium variant of Daniel. The stock
 * "Daniel" is a compact voice from a decade ago and sounds it; the Enhanced
 * download is free (System Settings → Accessibility → Spoken Content → System
 * Voice → Manage Voices) and once installed it appears here automatically.
 */
function score(v: SpeechSynthesisVoice): number {
  const n = v.name.toLowerCase()
  let s = 0

  // The macOS British male, and the closest thing to the character available
  // without leaving the machine.
  if (n.startsWith('daniel')) s += 100
  else if (n.includes('google uk english male')) s += 85
  else if (/\b(oliver|arthur|jamie|malcolm)\b/.test(n)) s += 80
  // Newer macOS en-GB male voices — casual, but serviceable.
  else if (/\b(reed|rocko|eddy)\b/.test(n)) s += 40

  // Higher-quality variants of whatever matched above.
  if (n.includes('premium')) s += 30
  else if (n.includes('enhanced')) s += 20

  if (/en[-_]gb/i.test(v.lang)) s += 25
  else if (/^en/i.test(v.lang)) s += 5

  // Voices that clearly aren't a butler.
  if (/grandma|grandpa|bubbles|jester|bells|boing|whisper|zarvox|superstar|trinoids|wobble|bahh|organ|cellos|bad news|good news/.test(n)) {
    s -= 200
  }
  // Female-presenting names across the English sets.
  if (/\b(flo|sandy|shelley|kate|serena|fiona|moira|karen|tessa|samantha|zoe|allison|ava|susan)\b/.test(n)) {
    s -= 60
  }

  return s
}

/** Only voices that scored on a name match, not merely on being English —
 *  otherwise the picker cycles through a dozen US novelty voices. */
const USABLE = 40

/** Best-first list of usable voices — also what the voice picker cycles. */
export function candidateVoices(): SpeechSynthesisVoice[] {
  return speechSynthesis
    .getVoices()
    .filter((v) => /^en/i.test(v.lang))
    .map((v) => ({ v, s: score(v) }))
    .filter((x) => x.s >= USABLE)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.v)
}

let cachedVoice: SpeechSynthesisVoice | null | undefined

function pickVoice(): SpeechSynthesisVoice | null {
  if (cachedVoice !== undefined) return cachedVoice
  const all = speechSynthesis.getVoices()
  if (!all.length) return null // not loaded yet — try again next utterance

  // Honour an explicit choice made with the voice picker. A saved name that no
  // longer resolves is dropped rather than left to resurrect itself silently
  // if that voice is ever reinstalled.
  const saved = localStorage.getItem(VOICE_PREF_KEY)
  if (saved) {
    const hit = all.find((v) => v.name === saved)
    if (hit) return (cachedVoice = hit)
    localStorage.removeItem(VOICE_PREF_KEY)
  }

  cachedVoice = candidateVoices()[0] ?? all.find((v) => /^en/i.test(v.lang)) ?? null
  return cachedVoice
}

/** What the HUD should show. Reports the engine actually in use rather than
 *  always naming a speechSynthesis voice that a cloud or neural engine has
 *  quietly replaced. */
export function currentVoiceName(): string {
  if (caps().ttsEngine === 'fish') return 'Fish Audio'
  if (TTS_ENGINE === 'kokoro' && kokoro.isReady()) {
    return kokoro.activeVoice().replace(/^bm_/, '')
  }
  return pickVoice()?.name ?? 'default'
}

/** Start voice/model loading on page load; unlock output on the Talk gesture. */
export function prewarmSpeech(unlockOutput = false): void {
  pickVoice()
  if (unlockOutput) outputContext()
  // Fish is primary. Loading an 86 MB fallback before the health probe wastes
  // startup bandwidth and GPU memory on the normal path.
  if (TTS_ENGINE === 'kokoro' && capabilitiesProbed() && caps().ttsEngine !== 'fish') void kokoro.load()
}

/** Step to the next candidate — lets you audition voices on your own machine
 *  rather than trusting a ranking to be right about how they sound. */
export function cycleVoice(): string {
  if (TTS_ENGINE === 'kokoro' && kokoro.isReady()) {
    return kokoro.cycleVoice().replace(/^bm_/, '')
  }
  const list = candidateVoices()
  if (!list.length) return 'default'
  const now = pickVoice()
  const i = list.findIndex((v) => v.name === now?.name)
  const next = list[(i + 1) % list.length]
  localStorage.setItem(VOICE_PREF_KEY, next.name)
  cachedVoice = next
  return next.name
}

// Voices load asynchronously in Chrome; the first call usually returns nothing.
if (typeof speechSynthesis !== 'undefined') {
  speechSynthesis.addEventListener('voiceschanged', () => {
    cachedVoice = undefined
    pickVoice()
  })
  pickVoice()
}

// ---------------------------------------------------------------------------
// Shared output analyser
// ---------------------------------------------------------------------------

/**
 * One AudioContext for every sentence ever spoken.
 *
 * Blink caps a document at roughly six concurrent hardware contexts. Building
 * one per sentence and never closing it meant the visualiser died partway
 * through the first long answer, silently, because the constructor throw was
 * caught and ignored.
 */
let outCtx: AudioContext | null = null

function outputContext(): AudioContext | null {
  try {
    if (!outCtx) outCtx = new AudioContext()
    if (outCtx.state === 'suspended') void outCtx.resume()
    return outCtx
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------

/**
 * Nudge the delivery toward JARVIS's cadence.
 *
 * speechSynthesis ignores SSML, so punctuation is the only prosody control
 * available — the engine pauses on commas and full stops. Making sure the
 * vocative "sir" is always set off by a comma buys the small beat before it
 * that does most of the characterisation.
 */
function shape(text: string): string {
  return (
    text
      // Models leak markdown even when told not to, and a synthesiser will
      // happily read "https colon slash slash" out loud. Strip the syntax and
      // keep the words.
      .replace(/^\s*Sources?:.*$/gim, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // [label](url) -> label
      // Stop before trailing punctuation, so "See https://x.com." keeps the
      // full stop that ends the sentence rather than having it eaten.
      .replace(/https?:\/\/[^\s]*[^\s.,;:!?)\]]/g, '')
      .replace(/[*_`#>]+/g, '')
      .replace(/^\s*[-•]\s+/gm, '')
      // The vocative wants its comma — that small beat before "sir" does most
      // of the characterisation. Anchored to a following pause or end of line
      // so the honorific is left alone: "Sir Isaac Newton" is not a vocative.
      .replace(/([^,\s])\s+(sir)(\s*[.,!?;:]|\s*$)/gi, '$1, $2$3')
      .replace(/\s+/g, ' ')
      .trim()
  )
}

type Item = {
  text: string
  queuedAt: number
  model: boolean
  engine?: 'fish' | 'kokoro' | 'system'
  /** Generation starts at most one phrase ahead, while playback is active. */
  audio?: Promise<string | null> | null
  stages: Record<string, number>
}

export function createSpeaker(context: SpeechContext = {}): Speaker {
  const turnStart = performance.now()
  const useFish = caps().ttsEngine === 'fish'
  // Keep one timbre per answer; a model finishing its first download midway
  // through a sentence should only take over on the following turn.
  const useKokoro = TTS_ENGINE === 'kokoro' && kokoro.isReady()
  diag.firstModelDeltaMs = 0
  diag.firstPhraseMs = 0
  diag.firstTtsStartMs = 0
  diag.firstAudioReadyMs = 0
  diag.firstAudibleMs = 0
  const mark = (field: 'firstModelDeltaMs' | 'firstPhraseMs' | 'firstTtsStartMs' | 'firstAudioReadyMs' | 'firstAudibleMs') => {
    if (!diag[field]) diag[field] = Math.round(performance.now() - turnStart)
  }
  const queue: Item[] = []
  let buffer = ''
  let cancelled = false
  let outLevel = 0
  let pumping = false
  let playingAudio = false

  let currentAudio: HTMLAudioElement | null = null
  const requests = new Set<AbortController>()
  let nativeInFlight = false
  let previousEnd = 0
  let drained: Array<() => void> = []

  const settleDrained = () => {
    const waiting = drained
    drained = []
    for (const r of waiting) r()
  }

  const enqueue = (sentence: string, priority = false) => {
    if (cancelled) return
    const spoken = toSpeechText(sentence, context)
    if (!spoken) return
    // Shape once here so both engines get the same text — stripped markdown,
    // and the comma before "sir" that buys the beat.
    const text = context.literalTechnical ? spoken : shape(spoken)
    if (!text) return

    const item: Item = { text, queuedAt: performance.now(), model: !priority, stages: {} }
    item.stages.phraseReady = 0
    if (priority) {
      // Genuinely ahead of the queue this time. The old `say()` appended to the
      // same chain and only appeared to preempt because it was called when the
      // queue happened to be empty.
      queue.unshift(item)
    } else {
      mark('firstPhraseMs')
      queue.push(item)
    }
    diag.queueDepth = queue.length
    // If phrase one is already playing, prepare phrase two immediately.
    // The pump still owns playback order, so there can be no overlap.
    if (playingAudio && queue.length <= (settings.gap === 'tight' ? 2 : 1)) prime(item)
    void pump()
  }

  /** null means "no audio pipeline, use the system voice directly". */
  function synthesise(item: Item): Promise<string | null> | null {
    const { text } = item
    if (item.model) mark('firstTtsStartMs')
    if (useFish) {
      const controller = new AbortController()
      let streaming = false
      requests.add(controller)
      diag.pendingFish = requests.size
      item.engine = 'fish'
      item.stages.requestStart = Math.round(performance.now() - item.queuedAt)
      return fetch(`${BRIDGE_HTTP_URL}/tts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: controller.signal,
      }).then(async (res) => {
        if (!res.ok) return null
        item.stages.headers = Math.round(performance.now() - item.queuedAt)
        const reader = res.body?.getReader()
        if (!reader) return null
        if (typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported('audio/mpeg')) {
          const media = new MediaSource()
          const url = URL.createObjectURL(media)
          let source: SourceBuffer
          const pending: Uint8Array[] = []
          let ended = false
          const append = () => {
            if (!source || source.updating || media.readyState !== 'open' || !pending.length) {
              if (source && ended && !source.updating && !pending.length && media.readyState === 'open') media.endOfStream()
              return
            }
            source.appendBuffer(pending.shift()! as Uint8Array<ArrayBuffer>)
          }
          streaming = true
          media.addEventListener('sourceopen', () => {
            try {
              source = media.addSourceBuffer('audio/mpeg')
              source.addEventListener('updateend', append)
              append()
            } catch { if (media.readyState === 'open') media.endOfStream('decode') }
          }, { once: true })
          void (async () => {
            try {
              for (;;) {
                const { done, value } = await reader.read()
                if (done || cancelled) break
                if (value?.length) {
                  if (item.stages.firstByte === undefined) {
                    item.stages.firstByte = Math.round(performance.now() - item.queuedAt)
                    item.stages.decodeStart = item.stages.firstByte
                  }
                  pending.push(value); append()
                  diag.stages = { ...item.stages }
                }
              }
              item.stages.complete = Math.round(performance.now() - item.queuedAt)
              diag.stages = { ...item.stages }
              ended = true; append()
            } catch { if (media.readyState === 'open') media.endOfStream('network') }
            finally { requests.delete(controller); diag.pendingFish = requests.size }
          })()
          diag.stages = { ...item.stages }
          if (item.model) mark('firstAudioReadyMs')
          return url
        }
        const chunks: Uint8Array[] = []
        let size = 0
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (cancelled) { await reader.cancel(); return null }
          if (value?.length) {
            if (item.stages.firstByte === undefined) item.stages.firstByte = Math.round(performance.now() - item.queuedAt)
            chunks.push(value)
            size += value.length
          }
        }
        item.stages.complete = Math.round(performance.now() - item.queuedAt)
        if (!size) return null
        item.stages.decodeStart = item.stages.complete
        const blob = new Blob(chunks as BlobPart[], { type: 'audio/mpeg' })
        if (cancelled) return null
        if (item.model) mark('firstAudioReadyMs')
        diag.stages = { ...item.stages }
        return URL.createObjectURL(blob)
      }).catch(() => null).finally(() => { if (!streaming) { requests.delete(controller); diag.pendingFish = requests.size } })
        .then(async (url) => {
          if (url) return url
          if (cancelled || kokoro.isUnavailable()) return null
          item.engine = 'kokoro'
          item.stages.fallbackStart = Math.round(performance.now() - item.queuedAt)
          const local = await kokoro.speak(text).catch(() => null)
          if (local && item.model) mark('firstAudioReadyMs')
          return local
        })
    }
    if (useKokoro && !kokoro.isUnavailable()) {
      item.engine = 'kokoro'
      return kokoro.speak(text).then((url) => { if (url && item.model) mark('firstAudioReadyMs'); return url }).catch(() => null)
    }
    item.engine = 'system'
    return null
  }

  /** Start generating an item's audio if it hasn't begun. */
  const prime = (item: Item | undefined) => {
    if (item && item.audio === undefined) {
      const audio = synthesise(item)
      item.audio = audio?.then((url) => {
        if (cancelled && url) URL.revokeObjectURL(url)
        return cancelled ? null : url
      }) ?? null
    }
  }

  async function pump(): Promise<void> {
    if (pumping) return
    pumping = true
    try {
      for (;;) {
        if (cancelled) break
        const item = queue.shift()
        diag.queueDepth = queue.length
        if (!item) break

        prime(item)
        await speakOne(item)
      }
    } finally {
      pumping = false
      if (cancelled || !queue.length) settleDrained()
    }
  }

  async function speakOne(item: Item): Promise<void> {
    if (cancelled) return
    setSpeaking(item.text)
    try {
      const url = item.audio ? await item.audio : null
      if (cancelled) return
      // A failed generation is not a failed turn — drop to the system voice.
      if (url) {
        playingAudio = true
        prime(queue[0])
        if (settings.gap === 'tight') prime(queue[1])
        diag.engine = item.engine === 'fish' ? 'fish' : 'kokoro'
        const played = await playUrl(url, item)
        if (!played && !cancelled) {
          if (item.engine === 'fish') {
            item.stages.fallbackStart = Math.round(performance.now() - item.queuedAt)
            const local = await kokoro.speak(item.text).catch(() => null)
            if (cancelled) { if (local) URL.revokeObjectURL(local); return }
            if (local) {
              item.engine = 'kokoro'
              diag.engine = 'kokoro'
              if (await playUrl(local, item)) return
            }
          }
          diag.engine = 'system'
          await speakNative(item.text, item.queuedAt, item.model)
        }
        return
      }

      playingAudio = true
      prime(queue[0])
      diag.engine = 'system'
      await speakNative(item.text, item.queuedAt, item.model)
    } finally {
      playingAudio = false
      if (speaking === item.text) setSpeaking('')
    }
  }

  const speakNative = (text: string, queuedAt: number, model: boolean) =>
    new Promise<boolean>((resolve) => {
      // Chrome's speechSynthesis wedges after cancel().
      //
      // This is the single most likely reason a whole session goes silent. The
      // engine is a global singleton, `cancel()` can leave its queue in a state
      // where every subsequent speak() is accepted and then never spoken — no
      // error, no events, just silence for the rest of the page's life. Barge-in
      // calls cancel() constantly now that the microphone stays open, so what
      // used to be a rare quirk became the common case.
      //
      // resume() is the documented un-wedge. It is a no-op when nothing is
      // paused, so it is safe to fire before every utterance.
      speechSynthesis.resume()

      const u = new SpeechSynthesisUtterance(text)
      const voice = pickVoice()
      if (voice) u.voice = voice
      u.lang = voice?.lang ?? 'en-GB'
      // Deliberate, and deliberately invariant — the character's pace does not
      // change with stakes, and that steadiness is most of the effect. This
      // lands around 130 wpm, below the median for film dialogue.
      u.rate = 0.92
      // Mid-baritone, and *not* pushed lower for gravitas. The voice is
      // clarity-weighted rather than chest-weighted; dropping it further reads
      // as a film-trailer voiceover, which is the wrong character entirely.
      u.pitch = 0.95

      // speechSynthesis exposes no amplitude, so drive the reactor from a
      // synthetic envelope. It only has to look like speech, not match it.
      let raf = 0
      let t = 0
      const tick = () => {
        t += 0.08
        outLevel =
          0.35 +
          Math.abs(Math.sin(t * 2.1)) * 0.3 +
          Math.abs(Math.sin(t * 5.7)) * 0.2
        raf = requestAnimationFrame(tick)
      }
      tick()

      let done = false
      let started = false
      let watchdog: ReturnType<typeof setTimeout> | null = null
      let keepalive: ReturnType<typeof setInterval> | null = null

      const finish = () => {
        if (done) return
        done = true
        nativeInFlight = false
        if (watchdog) clearTimeout(watchdog)
        if (keepalive) clearInterval(keepalive)
        cancelAnimationFrame(raf)
        // Held rather than zeroed, so the orb doesn't collapse in the gap
        // between two sentences of the same answer.
        outLevel = 0.12
        // The whole point of the boolean: `true` only if sound actually began.
        resolve(started)
      }

      u.onstart = () => {
        if (model) {
          mark('firstAudioReadyMs')
          mark('firstAudibleMs')
        }
        started = true
        diag.started++
        diag.lastStartLatencyMs = Math.round(performance.now() - queuedAt)
        if (!diag.bestStartLatencyMs || diag.lastStartLatencyMs < diag.bestStartLatencyMs) diag.bestStartLatencyMs = diag.lastStartLatencyMs
        diag.lastError = ''
        if (watchdog) clearTimeout(watchdog)
        // Chrome stops speaking after roughly fifteen seconds unless the engine
        // is nudged. A pause/resume pair is the standard keepalive and is
        // inaudible; without it long answers cut off mid-sentence.
        keepalive = setInterval(() => {
          if (done) return
          speechSynthesis.pause()
          speechSynthesis.resume()
        }, 5000)
      }
      u.onend = finish
      // Swallowing this was a mistake. When the OS voice fails there is no
      // other signal at all — no exception, no silence you can detect from
      // code — so an unlogged onerror turns a broken voice into an unexplained
      // quiet app, which is exactly the bug that took three attempts to find.
      u.onerror = (e) => {
        const code = String((e as SpeechSynthesisErrorEvent).error ?? 'unknown')
        diag.lastError = code
        // 'interrupted' and 'canceled' are us, cancelling deliberately on a
        // barge-in. Everything else means the engine could not speak.
        if (code !== 'interrupted' && code !== 'canceled') {
          diag.failures++
          console.error(`[jarvis] speech failed (${code}) on voice "${u.voice?.name ?? 'default'}"`)
        }
        finish()
      }

      // If `start` never arrives the engine has swallowed the utterance, and
      // nothing else will ever tell us — no error fires. Un-wedge and try once
      // more; if that also goes nowhere, resolve rather than hang, because a
      // silent sentence is recoverable and a stuck queue is not.
      watchdog = setTimeout(() => {
        if (done || started) return
        console.warn('[jarvis] speech did not start — un-wedging the engine')
        speechSynthesis.cancel()
        speechSynthesis.resume()
        try {
          speechSynthesis.speak(u)
        } catch {
          finish()
          return
        }
        watchdog = setTimeout(() => {
          if (done || started) return
          console.error('[jarvis] system speech engine is not responding')
          diag.failures++
          diag.lastError = diag.lastError || 'no-start'
          finish()
        }, 1500)
      }, 700)
      diag.spoken++
      diag.lastText = text.slice(0, 60)
      diag.voice = u.voice?.name ?? 'default'
      nativeInFlight = true
      speechSynthesis.speak(u)
    })

  const playUrl = (url: string, item: Item) =>
    new Promise<boolean>((resolve) => {
      const audio = new Audio(url)
      const { text, queuedAt, model } = item
      currentAudio = audio
      // Count playback only when the element actually starts.
      diag.spoken++
      diag.lastText = text.slice(0, 60)
      diag.voice = diag.engine === 'fish' ? 'Fish Audio' : kokoro.activeVoice()

      let read: (() => number) | null = null
      const ctx = outputContext()
      if (ctx) {
        try {
          const analyser = ctx.createAnalyser()
          analyser.fftSize = 256
          const source = ctx.createMediaElementSource(audio)
          const presence = ctx.createBiquadFilter()
          presence.type = 'peaking'; presence.frequency.value = 3000; presence.Q.value = 0.8
          presence.gain.value = settings.clarity === 'medium' ? 1.5 : settings.clarity === 'low' ? 0.7 : 0
          const compressor = ctx.createDynamicsCompressor()
          compressor.threshold.value = -16; compressor.knee.value = 12
          compressor.ratio.value = 1.5; compressor.attack.value = 0.01; compressor.release.value = 0.18
          const gain = ctx.createGain()
          gain.gain.value = settings.volume / 100
          const ceiling = ctx.createWaveShaper()
          const curve = new Float32Array(1024)
          for (let i = 0; i < curve.length; i++) {
            const x = (i / (curve.length - 1)) * 2 - 1
            curve[i] = Math.tanh(x * 1.5) / Math.tanh(1.5)
          }
          ceiling.curve = curve
          source.connect(presence).connect(compressor).connect(gain).connect(ceiling).connect(analyser).connect(ctx.destination)
          const bins = new Uint8Array(analyser.frequencyBinCount)
          read = () => {
            analyser.getByteFrequencyData(bins as Uint8Array<ArrayBuffer>)
            let sum = 0
            for (let i = 2; i < bins.length; i++) sum += bins[i]
            return Math.min(1, (sum / (bins.length - 2) / 255) * 3.5)
          }
        } catch {
          /* the analyser is a nice-to-have */
        }
      }

      let raf = 0
      const tick = () => {
        outLevel = read ? read() : 0.4
        raf = requestAnimationFrame(tick)
      }
      tick()

      let done = false
      let started = false
      let failed = false
      const watchdog = setTimeout(() => {
        diag.failures++
        diag.playbackTimeouts++
        diag.lastError = 'playback-timeout'
        failed = true
        audio.pause()
        finish()
      }, 45_000)
      const finish = () => {
        if (done) return
        done = true
        clearTimeout(watchdog)
        cancelAnimationFrame(raf)
        outLevel = 0.12
        URL.revokeObjectURL(url)
        if (currentAudio === audio) currentAudio = null
        resolve(started && !failed)
      }
      // Sound is genuinely coming out. This is the neural counterpart of
      // SpeechSynthesisUtterance.onstart, and it is what makes the diagnostics
      // verdict — and the T self-test — tell the truth on the premium path.
      audio.onplaying = () => {
        started = true
        item.stages.playbackStart = Math.round(performance.now() - queuedAt)
        if (previousEnd) {
          diag.phraseGapMs = Math.round(performance.now() - previousEnd)
          diag.phraseGapsMs.push(diag.phraseGapMs)
          diag.phraseGapsMs = diag.phraseGapsMs.slice(-30)
        }
        diag.stages = { ...item.stages }
        if (model) mark('firstAudibleMs')
        diag.started++
        diag.lastStartLatencyMs = Math.round(performance.now() - queuedAt)
        if (!diag.bestStartLatencyMs || diag.lastStartLatencyMs < diag.bestStartLatencyMs) diag.bestStartLatencyMs = diag.lastStartLatencyMs
        diag.lastError = ''
      }
      audio.onended = () => { previousEnd = performance.now(); finish() }
      // canplay means enough data has decoded to start, not that the entire
      // streamed MP3 has been decoded.
      audio.oncanplay = () => { item.stages.decodeReady = Math.round(performance.now() - queuedAt); diag.stages = { ...item.stages } }
      audio.onerror = () => {
        // A decode or network failure on a blob we already hold is rare, but
        // silent when it happens: the sentence simply never plays and the queue
        // moves on. Count it rather than letting it look like nothing was said.
        diag.failures++
        diag.lastError = 'audio-element'
        failed = true
        finish()
      }
      // The one that matters for barge-in: cancel() pauses the element, and a
      // paused element never fires `ended`. Without this the promise never
      // settles and every await behind it hangs for the life of the page.
      audio.onpause = finish
      item.stages.playbackScheduled = Math.round(performance.now() - queuedAt)
      void audio.play().catch((err) => {
        diag.failures++
        diag.lastError = String((err as Error)?.name ?? 'play-rejected')
        failed = true
        finish()
      })
    })

  return {
    say(text) {
      enqueue(text, true)
    },
    push(delta) {
      if (cancelled) return
      buffer += delta
      if (context.literalTechnical) return
      const extracted = takeSpeechPhrases(buffer)
      buffer = extracted.rest
      for (const phrase of extracted.phrases) enqueue(phrase)
    },
    async end() {
      if (buffer.trim()) {
        enqueue(buffer)
        buffer = ''
      }
      if (cancelled) return
      if (!pumping && !queue.length) return
      await new Promise<void>((resolve) => drained.push(resolve))
    },
    cancel() {
      if (cancelled) return
      cancelled = true
      buffer = ''
      queue.length = 0
      diag.queueDepth = 0
      for (const request of requests) request.abort()
      requests.clear()
      diag.pendingFish = 0
      // Keep the echo tail: the words already in the air still have to be
      // recognised and discarded, even though he has stopped adding to them.
      setSpeaking('')

      // Only reach for the global cancel if this speaker actually has a native
      // utterance out — speechSynthesis.cancel() is document-wide and would
      // otherwise silence an unrelated speaker mid-word.
      if (nativeInFlight) {
        nativeInFlight = false
        speechSynthesis.cancel()
        // Always pair the cancel with a resume — see the note in speakNative.
        // Leaving the engine cancelled is what silences every later sentence.
        speechSynthesis.resume()
      }
      if (currentAudio) {
        currentAudio.pause()
        currentAudio = null
      }
      outLevel = 0
      settleDrained()
    },
    level: () => outLevel,
    markModelDelta: () => mark('firstModelDeltaMs'),
  }
}
