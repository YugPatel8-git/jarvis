import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('../src/lib/tts.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

function speakerHarness({ fish = false, kokoroFails = false, fishDecodeFails = false, audioHangs = false, fetchImpl, coldKokoro = false, silentCancel = false, holdAudio = false, streaming = false, appendFails = false, nativeFirstHangs = false } = {}) {
  const utterances = []
  const played = []
  const audioPlayed = []
  const localSyntheses = []
  const revoked = []
  const audios = []
  let loads = 0
  const mediaSources = []
  class Events {
    listeners = new Map()
    addEventListener(name, fn) { this.listeners.set(name, fn) }
    removeEventListener(name) { this.listeners.delete(name) }
    emit(name) { this.listeners.get(name)?.() }
  }
  class Media extends Events {
    static isTypeSupported() { return true }
    readyState = 'closed'
    constructor() { super(); mediaSources.push(this) }
    addSourceBuffer() {
      const source = new Events()
      source.updating = false
      source.appendBuffer = () => {
        if (appendFails) throw new Error('decode failed')
        source.updating = true
        queueMicrotask(() => { source.updating = false; source.emit('updateend') })
      }
      this.source = source
      return source
    }
    endOfStream() { this.readyState = 'ended' }
  }
  let fishRequests = 0
  let active = null
  const speechSynthesis = {
    addEventListener() {},
    getVoices: () => [{ name: 'British test voice', lang: 'en-GB' }],
    resume() {}, pause() {},
    cancel() {
      if (active) {
        const previous = active
        active = null
        if (!silentCancel) previous.onerror?.({ error: 'canceled' })
      }
    },
    speak(utterance) {
      utterances.push(utterance.text)
      active = utterance
      if (nativeFirstHangs && utterances.length === 1) return
      setTimeout(() => {
        if (active !== utterance) return
        utterance.onstart?.()
        played.push(utterance.text)
        setTimeout(() => {
          if (active !== utterance) return
          active = null
          utterance.onend?.()
        }, 5)
      }, 1)
    },
  }
  const exports = {}
  const context = {
    exports,
    require(id) {
      if (id === '../config') return { TTS_ENGINE: fish ? 'kokoro' : 'system', BRIDGE_HTTP_URL: 'http://127.0.0.1:8787' }
      if (id === './capabilities') return { caps: () => ({ ttsEngine: fish ? 'fish' : null }) }
      if (id === './kokoro') return {
        isReady: () => fish && !coldKokoro, isUnavailable: () => !fish,
        load: () => { loads++; return new Promise(() => {}) },
        speak: async (text) => { localSyntheses.push(text); return kokoroFails ? null : 'blob:kokoro-test' },
        activeVoice: () => 'bm_george',
      }
      if (id === './speech-phrases') return { takeSpeechPhrases: (s) => {
        const cut = s.indexOf('. ')
        return cut < 0 ? { phrases: [], rest: s } : { phrases: [s.slice(0, cut + 2)], rest: s.slice(cut + 2) }
      } }
      if (id === './speech-text') return { toSpeechText: (s) => s }
      throw new Error(`Unexpected import: ${id}`)
    },
    speechSynthesis,
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text } },
    localStorage: { getItem: () => null },
    performance,
    AbortController,
    fetch: async (...args) => {
      fishRequests++
      if (fetchImpl) return fetchImpl(...args)
      if (!fishDecodeFails) return { ok: false, status: 429 }
      return { ok: true, body: { getReader: () => {
        let sent = false
        return { read: async () => sent ? { done: true } : (sent = true, { done: false, value: new Uint8Array([1, 2, 3]) }) }
      } } }
    },
    Blob,
    MediaSource: streaming ? Media : undefined,
    Audio: class {
      constructor(url) { this.url = url; audios.push(this) }
      removeAttribute() {}
      load() {}
      play() {
        audioPlayed.push(this.url)
        if (streaming && this.url === 'blob:fish-test') {
          const media = mediaSources.at(-1)
          queueMicrotask(() => { media.readyState = 'open'; media.emit('sourceopen') })
        }
        if (audioHangs) return Promise.resolve()
        if (fishDecodeFails && this.url === 'blob:fish-test') {
          setTimeout(() => this.onerror?.(), 1)
          return Promise.resolve()
        }
        setTimeout(() => { this.onplaying?.(); if (!holdAudio) this.onended?.() }, 1)
        return Promise.resolve()
      }
      pause() { this.onpause?.() }
    },
    URL: { revokeObjectURL(url) { revoked.push(url) }, createObjectURL: () => 'blob:fish-test' },
    setTimeout: (fn, ms, ...args) => setTimeout(fn, (audioHangs && ms === 45_000) || (fetchImpl && ms === 20_000) || (nativeFirstHangs && ms === 700) ? 15 : ms, ...args), clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: () => { throw new Error('TTS must not schedule a visual frame loop') },
    cancelAnimationFrame() {},
    console,
  }
  vm.runInNewContext(compiled, context, { filename: 'tts.js' })
  return { createSpeaker: exports.createSpeaker, isPlaybackActive: exports.isPlaybackActive, subscribePlayback: exports.subscribePlayback, diag: exports.diag, utterances, played, audioPlayed, localSyntheses, revoked, audios, mediaSources, get loads() { return loads }, get fishRequests() { return fishRequests } }
}

test('playback indicator waits for actual audio, handles buffering, and clears on cancel', async () => {
  const h = speakerHarness({ fish: true, holdAudio: true })
  const changes = []
  const unsubscribe = h.subscribePlayback(() => changes.push(h.isPlaybackActive()))
  const speaker = h.createSpeaker()
  try {
    speaker.say('At your service.')
    assert.equal(h.isPlaybackActive(), false, 'queued speech is not audible speech')
    await new Promise((r) => setTimeout(r, 15))
    assert.equal(h.isPlaybackActive(), true)
    assert.deepEqual(changes, [true])
    const audio = h.audios.at(-1)
    audio.onwaiting()
    assert.equal(h.isPlaybackActive(), false)
    await Promise.resolve()
    audio.onplaying()
    await Promise.resolve()
    assert.equal(h.diag.started, 1, 'resuming does not recount the phrase')
    const staleStart = audio.onplaying
    speaker.cancel()
    assert.equal(h.isPlaybackActive(), false, 'cancel clears the snapshot synchronously')
    assert.equal(speaker.level(), 0)
    staleStart()
    await speaker.end()
    assert.equal(h.isPlaybackActive(), false, 'a stale callback cannot relight the ring')
    assert.deepEqual(changes, [true, false, true, false])
  } finally { speaker.cancel(); unsubscribe() }
})

test('native playback notifies asynchronously and visual failures cannot break speech', async () => {
  const h = speakerHarness()
  const changes = []
  const broken = h.subscribePlayback(() => { throw new Error('visual failure') })
  const unsubscribe = h.subscribePlayback(() => changes.push(h.isPlaybackActive()))
  const speaker = h.createSpeaker()
  try {
    speaker.say('Ready.')
    assert.deepEqual(changes, [], 'no rendering before speech starts')
    await speaker.end()
    await Promise.resolve()
    assert.deepEqual(h.played, ['Ready.'])
    assert.deepEqual(changes, [true, false])
    assert.equal(h.isPlaybackActive(), false)
  } finally { speaker.cancel(); unsubscribe(); broken() }
})

test('audio end clears the indicator before the remaining turn finishes', async () => {
  const h = speakerHarness({ fish: true, holdAudio: true })
  const speaker = h.createSpeaker()
  try {
    speaker.say('Ready.')
    await new Promise((r) => setTimeout(r, 15))
    assert.equal(h.isPlaybackActive(), true)
    h.audios.at(-1).onended()
    assert.equal(h.isPlaybackActive(), false)
    assert.equal(speaker.level(), 0)
    await speaker.end()
  } finally { speaker.cancel() }
})

test('local speech queue plays each phrase once in order', async () => {
  const { createSpeaker, utterances, played } = speakerHarness()
  const speaker = createSpeaker()
  speaker.push('Good afternoon. ')
  speaker.push('All systems are ready.')
  await speaker.end()
  assert.deepEqual(utterances, ['Good afternoon.', 'All systems are ready.'])
  assert.deepEqual(played, utterances)
})

test('barge-in clears queued local speech and settles the turn', async () => {
  const { createSpeaker, played } = speakerHarness()
  const speaker = createSpeaker()
  speaker.say('First phrase.')
  speaker.say('Queued phrase.')
  const done = speaker.end()
  speaker.cancel()
  await done
  await new Promise((resolve) => setTimeout(resolve, 15))
  assert.deepEqual(played, [])
})

test('browser TTS contacts only the local bridge for Fish speech', () => {
  assert.match(source, /BRIDGE_HTTP_URL\}\/tts/)
  assert.doesNotMatch(source, /api\.fish\.audio|FISH_AUDIO_API_KEY|elevenlabs\.io/)
})

test('Fish rate limit falls back to Kokoro without another Fish request', async () => {
  const harness = speakerHarness({ fish: true })
  const speaker = harness.createSpeaker()
  speaker.say('Good afternoon.')
  await speaker.end()
  assert.equal(harness.fishRequests, 1)
  assert.deepEqual(harness.localSyntheses, ['Good afternoon.'])
  assert.deepEqual(harness.audioPlayed, ['blob:kokoro-test'])
})

test('Fish and Kokoro failures fall back to system speech', async () => {
  const harness = speakerHarness({ fish: true, kokoroFails: true })
  const speaker = harness.createSpeaker()
  speaker.say('All systems are ready.')
  await speaker.end()
  assert.equal(harness.fishRequests, 1)
  assert.deepEqual(harness.localSyntheses, ['All systems are ready.'])
  assert.deepEqual(harness.played, ['All systems are ready.'])
})

test('Fish decode failure falls back to Kokoro before system speech', async () => {
  const harness = speakerHarness({ fish: true, fishDecodeFails: true })
  const speaker = harness.createSpeaker()
  speaker.say('The answer is ready.')
  await speaker.end()
  assert.equal(harness.fishRequests, 1)
  assert.deepEqual(harness.localSyntheses, ['The answer is ready.'])
  assert.deepEqual(harness.audioPlayed, ['blob:fish-test', 'blob:kokoro-test'])
})

test('stuck audio playback times out and falls back to system speech', async () => {
  const harness = speakerHarness({ fish: true, audioHangs: true })
  const speaker = harness.createSpeaker()
  speaker.say('Still here, sir.')
  await speaker.end()
  assert.deepEqual(harness.audioPlayed, ['blob:kokoro-test'])
  assert.deepEqual(harness.played, ['Still here, sir.'])
})

test('cold Kokoro loads in the background while system speech delivers the failed Fish phrase', async () => {
  const h = speakerHarness({ fish: true, coldKokoro: true })
  const speaker = h.createSpeaker()
  speaker.say('Useful answer.')
  await speaker.end()
  assert.equal(h.loads, 1)
  assert.deepEqual(h.played, ['Useful answer.'])
})

test('Fish timeout falls back and remaining phrases skip the failed provider', async () => {
  const h = speakerHarness({ fish: true, fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })) })
  const speaker = h.createSpeaker()
  speaker.say('First useful phrase.')
  await speaker.end()
  speaker.say('Next useful phrase.')
  await speaker.end()
  assert.equal(h.fishRequests, 1)
  assert.equal(h.localSyntheses.length, 2)
  assert.equal(h.diag.pendingFish, 0)
})

test('new speaker cancels native playback even when the engine emits no cancel event', async () => {
  const h = speakerHarness({ silentCancel: true })
  const old = h.createSpeaker()
  old.say('Old answer.')
  const oldDone = old.end()
  const next = h.createSpeaker()
  next.say('New answer.')
  await Promise.all([oldDone, next.end()])
  assert.deepEqual(h.played, ['New answer.'])
})

test('a swallowed native utterance retries once without its cancellation completing the replacement', async () => {
  const h = speakerHarness({ nativeFirstHangs: true })
  const speaker = h.createSpeaker()
  speaker.say('Still responding.')
  await speaker.end()
  assert.equal(h.utterances.length, 2)
  assert.deepEqual(h.played, ['Still responding.'])
})

test('cancelled Fish response cannot start playback after a new speaker', async () => {
  let complete
  const h = speakerHarness({ fish: true, fetchImpl: () => new Promise((resolve) => { complete = resolve }) })
  const old = h.createSpeaker()
  old.say('Stale answer.')
  const done = old.end()
  old.cancel()
  complete({ ok: true, body: { cancel: async () => {} } })
  await done
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(h.audioPlayed, [])
  assert.equal(h.diag.pendingFish, 0)
})

test('Fish playback cancellation releases current and prefetched URLs and ignores stale events', async () => {
  const h = speakerHarness({ fish: true, holdAudio: true })
  const speaker = h.createSpeaker()
  speaker.say('First phrase.')
  speaker.push('Second phrase. ')
  const done = speaker.end()
  await new Promise((resolve) => setTimeout(resolve, 10))
  const started = h.diag.started
  speaker.cancel()
  await done
  assert.ok(h.revoked.length >= 2)
  assert.equal(h.audios[0].onplaying, null)
  assert.equal(h.diag.started, started)
  assert.equal(h.diag.queueDepth, 0)
})

const fishAudio = async () => ({ ok: true, body: { getReader: () => {
  let sent = false
  return { cancel: async () => {}, read: async () => sent ? { done: true } : (sent = true, { value: new Uint8Array([1, 2, 3]) }) }
} } })

test('MediaSource append failure falls back promptly and releases stream listeners', async () => {
  const h = speakerHarness({ fish: true, streaming: true, appendFails: true, fetchImpl: fishAudio })
  const speaker = h.createSpeaker()
  speaker.say('Streamed answer.')
  await speaker.end()
  assert.equal(h.localSyntheses.length, 1)
  assert.equal(h.mediaSources[0].source.listeners.size, 0)
  assert.equal(h.diag.pendingFish, 0)
})

test('rapid phrase queue keeps synthesis bounded and cancellation releases prefetched streams', async () => {
  const h = speakerHarness({ fish: true, streaming: true, holdAudio: true, fetchImpl: fishAudio })
  const speaker = h.createSpeaker()
  for (let i = 0; i < 30; i++) speaker.push(`Phrase number ${i}. `)
  await new Promise((r) => setTimeout(r, 10))
  assert.ok(h.fishRequests <= 2, 'only current phrase plus one natural-gap prefetch')
  speaker.cancel()
  await speaker.end()
  assert.equal(h.diag.queueDepth, 0)
  assert.equal(h.diag.pendingFish, 0)
  assert.ok(h.revoked.length >= 2)
})
