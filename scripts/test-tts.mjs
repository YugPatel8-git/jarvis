import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('../src/lib/tts.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

function speakerHarness({ fish = false, kokoroFails = false } = {}) {
  const utterances = []
  const played = []
  const audioPlayed = []
  const localSyntheses = []
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
        previous.onerror?.({ error: 'canceled' })
      }
    },
    speak(utterance) {
      utterances.push(utterance.text)
      active = utterance
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
        isReady: () => fish, isUnavailable: () => !fish,
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
    fetch: async () => { fishRequests++; return { ok: false, status: 429 } },
    Audio: class {
      constructor(url) { this.url = url }
      play() {
        audioPlayed.push(this.url)
        setTimeout(() => { this.onplaying?.(); this.onended?.() }, 1)
        return Promise.resolve()
      }
      pause() { this.onpause?.() }
    },
    URL: { revokeObjectURL() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    console,
  }
  vm.runInNewContext(compiled, context, { filename: 'tts.js' })
  return { createSpeaker: exports.createSpeaker, utterances, played, audioPlayed, localSyntheses, get fishRequests() { return fishRequests } }
}

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
