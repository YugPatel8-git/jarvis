import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const compile = file => ts.transpileModule(readFileSync(new URL(`../src/lib/${file}.ts`, import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const voiceSource = compile('voice'), vadSource = compile('vad')
const settle = () => new Promise(resolve => setImmediate(resolve))

function clock() {
  let now = 10000, serial = 0
  const timers = new Map()
  const add = (fn, delay, interval = 0) => {
    const id = ++serial
    timers.set(id, { fn, at: now + delay, interval })
    return id
  }
  return {
    get now() { return now },
    globals: {
      Date: class extends Date { static now() { return now } },
      performance: { now: () => now },
      setTimeout: (fn, delay) => add(fn, delay), clearTimeout: id => timers.delete(id),
      setInterval: (fn, delay) => add(fn, delay, delay), clearInterval: id => timers.delete(id),
      requestAnimationFrame: fn => add(fn, 10), cancelAnimationFrame: id => timers.delete(id),
    },
    async advance(ms) {
      const end = now + ms
      while (true) {
        const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        const [id, t] = next
        now = t.at
        if (t.interval) t.at += t.interval
        else timers.delete(id)
        t.fn()
        await settle()
      }
      now = end
      await settle()
    },
  }
}

async function harness({ premium = false, guard = false } = {}) {
  const time = clock(), turns = [], partials = [], requests = [], recognizers = []
  let mode = guard ? 'guard' : 'command', oldSpeech = guard, interruptions = 0, vadHandlers, speaking = false
  class Recognition {
    results = []
    constructor() { recognizers.push(this) }
    start() { this.onstart?.() }
    abort() { this.onend?.() }
    result(text, { index = this.results.length, final = true } = {}) {
      const entry = [{ transcript: text }]; entry.isFinal = final
      this.results[index] = entry
      this.onresult?.({ resultIndex: index, results: this.results })
    }
  }
  const exports = {}
  vm.runInNewContext(voiceSource, {
    exports, ...time.globals, console, Blob,
    window: { SpeechRecognition: Recognition },
    require(id) {
      if (id === '../config') return { BRIDGE_HTTP_URL: 'http://test' }
      if (id === './audio') return { getMic: async () => ({}) }
      if (id === './capabilities') return { caps: () => ({ stt: premium }) }
      if (id === './tts') return { speakingNow: () => oldSpeech ? 'A previous unrelated answer.' : '', speakingSince: () => 0 }
      if (id === './vad') return { startVad: async handlers => {
        vadHandlers = handlers
        return { live: () => true, stop() {}, setGuard() {}, meter: () => ({ speaking }) }
      } }
      throw new Error(id)
    },
    fetch: () => new Promise(resolve => requests.push(text => resolve({ ok: true, json: async () => ({ text }) }))),
  })
  const voice = await exports.startVoice({
    mode: () => mode,
    onSpeechStart: () => { interruptions++; oldSpeech = false; mode = 'command' },
    onPartial: text => partials.push(text),
    onUtterance: text => turns.push({ text, at: time.now }),
    onError: message => assert.fail(message),
  })
  return {
    time, turns, voice, requests, partials, recognizers,
    get rec() { return recognizers.at(-1) },
    get interruptions() { return interruptions }, get oldSpeech() { return oldSpeech },
    begin() { speaking = true; vadHandlers.onActivity(true); vadHandlers.onStart() },
    quiet() { vadHandlers.onActivity(false) },
    end() { speaking = false; vadHandlers.onEnd(new Blob(['speech'])) },
    async transcribed(text) { requests.shift()(text); await settle() },
  }
}

test('browser normal sentence submits once at 900ms, without an assembler delay', async () => {
  const h = await harness()
  h.rec.result('Explain the current project')
  await h.time.advance(899); assert.equal(h.turns.length, 0)
  await h.time.advance(1); assert.deepEqual(h.turns, [{ text: 'Explain the current project', at: 10900 }])
  await h.time.advance(2000); assert.equal(h.turns.length, 1)
  h.voice.stop()
})

test('a 400ms hesitation and later continuation keep one browser turn', async () => {
  const h = await harness()
  h.rec.result('Please open', { final: false })
  await h.time.advance(400)
  h.rec.result('Please open Chrome', { index: 0, final: false })
  await h.time.advance(899); assert.equal(h.turns.length, 0)
  await h.time.advance(1); assert.equal(h.turns[0].text, 'Please open Chrome')
  h.voice.stop()
})

test('speech-start cancels a pending deadline before delayed transcript callbacks', async () => {
  const h = await harness()
  h.rec.result('Tell me more')
  await h.time.advance(850)
  h.rec.onspeechstart()
  await h.time.advance(1200); assert.equal(h.turns.length, 0)
  h.rec.result('about this project', { final: false })
  await h.time.advance(300)
  h.rec.onspeechend()
  await h.time.advance(899); assert.equal(h.turns.length, 0)
  await h.time.advance(1); assert.equal(h.turns[0].text, 'Tell me more about this project')
  h.voice.stop()
})

test('late final transcript uses the speech-end deadline, not another 900ms', async () => {
  const h = await harness()
  h.rec.onspeechstart()
  await h.time.advance(500)
  h.rec.onspeechend()
  await h.time.advance(600)
  h.rec.result('Show the project status.')
  await h.time.advance(299); assert.equal(h.turns.length, 0)
  await h.time.advance(1); assert.equal(h.turns[0].at, 11400)
  h.voice.stop()
})

test('short commands each use 900ms and late finals cannot duplicate an interim submission', async () => {
  const h = await harness()
  for (const text of ['Stop.', 'Open Chrome', 'Yes', 'Yes']) {
    const index = h.rec.results.length
    h.rec.result(text, { index, final: false })
    await h.time.advance(900)
    const count = h.turns.length
    h.rec.result(text, { index, final: true })
    await h.time.advance(1000)
    assert.equal(h.turns.length, count)
  }
  assert.deepEqual(h.turns.map(t => t.text), ['Stop.', 'Open Chrome', 'Yes', 'Yes'])
  h.voice.stop()
})

test('marking an unchanged interim final does not restart its silence deadline', async () => {
  const h = await harness()
  h.rec.result('Open Chrome', { final: false })
  await h.time.advance(850)
  h.rec.result('Open Chrome.', { index: 0, final: true })
  await h.time.advance(49); assert.equal(h.turns.length, 0)
  await h.time.advance(1); assert.deepEqual(h.turns, [{ text: 'Open Chrome.', at: 10900 }])
  h.voice.stop()
})

test('speech-end arriving after a final result does not stack another quiet window', async () => {
  const h = await harness()
  h.rec.onspeechstart()
  h.rec.result('Open Chrome.')
  await h.time.advance(850)
  h.rec.onspeechend()
  await h.time.advance(50)
  assert.deepEqual(h.turns, [{ text: 'Open Chrome.', at: 10900 }])
  h.voice.stop()
})

test('unfinished wording gets only 1000ms total silence', async () => {
  const h = await harness()
  h.rec.result('Tell me about the')
  await h.time.advance(999); assert.equal(h.turns.length, 0)
  await h.time.advance(1); assert.equal(h.turns.length, 1)
  h.voice.stop()
})

test('browser barge-in stops old speech immediately and submits the new command at 900ms', async () => {
  const h = await harness({ guard: true })
  h.rec.result('Stop.')
  assert.equal(h.oldSpeech, false); assert.equal(h.interruptions, 1)
  await h.time.advance(900); assert.equal(h.turns[0].text, 'Stop.')
  await h.time.advance(2000); assert.equal(h.oldSpeech, false); assert.equal(h.turns.length, 1)
  h.voice.stop()
})

test('stopping a voice session clears pending input and ignores late callbacks', async () => {
  const h = await harness()
  h.rec.result('Open Chrome')
  h.voice.stop()
  h.rec.result('Open Chrome', { index: 0 })
  await h.time.advance(3000); assert.equal(h.turns.length, 0)
})

test('speech-end cannot bypass the existing one-word barge-in guard', async () => {
  const h = await harness({ guard: true })
  h.rec.result('project')
  h.rec.onspeechend()
  await h.time.advance(2000)
  assert.equal(h.turns.length, 0); assert.equal(h.oldSpeech, true)
  h.voice.stop()
})

test('recognizer restart rejects stale callbacks but accepts new session result indices', async () => {
  const h = await harness(), old = h.rec
  old.result('Yes')
  await h.time.advance(900)
  old.onend()
  await h.time.advance(80)
  old.result('stale words')
  h.rec.result('Yes')
  await h.time.advance(900)
  assert.deepEqual(h.turns.map(t => t.text), ['Yes', 'Yes'])
  h.voice.stop()
})

test('VAD transcription time counts toward 900ms instead of stacking another wait', async () => {
  const h = await harness({ premium: true })
  h.begin(); await h.time.advance(300); h.quiet()
  await h.time.advance(650); h.end()
  await h.time.advance(100); await h.transcribed('Open Chrome')
  await h.time.advance(149); assert.equal(h.turns.length, 0)
  await h.time.advance(1); assert.deepEqual(h.turns, [{ text: 'Open Chrome', at: 11200 }])
  h.voice.stop()
})

test('slow transcription submits immediately on arrival after the silence deadline', async () => {
  const h = await harness({ premium: true })
  h.begin(); await h.time.advance(300); h.quiet()
  await h.time.advance(650); h.end()
  await h.time.advance(1500); await h.transcribed('Yes')
  assert.deepEqual(h.turns, [{ text: 'Yes', at: h.time.now }])
  h.voice.stop()
})

test('stopping during transcription prevents a late request', async () => {
  const h = await harness({ premium: true })
  h.begin(); await h.time.advance(300); h.quiet()
  await h.time.advance(650); h.end()
  h.voice.stop()
  await h.transcribed('Open Chrome')
  await h.time.advance(2000)
  assert.equal(h.turns.length, 0)
})

test('resumed VAD activity cancels the old deadline and combines queued speech in order', async () => {
  const h = await harness({ premium: true, guard: true })
  h.begin(); assert.equal(h.oldSpeech, false)
  await h.time.advance(300); h.quiet()
  await h.time.advance(650); h.end()
  await h.time.advance(100); await h.transcribed('Explain this')
  await h.time.advance(100); h.begin()
  await h.time.advance(7000); assert.equal(h.turns.length, 0, 'never fire the old six-second active-speech timeout')
  h.quiet(); const quietAt = h.time.now
  await h.time.advance(650); h.end()
  await h.transcribed('project')
  await h.time.advance(250)
  assert.deepEqual(h.turns, [{ text: 'Explain this project', at: quietAt + 900 }])
  assert.equal(h.oldSpeech, false)
  h.voice.stop()
})

test('queued transcription cannot submit the first fragment before the later one arrives', async () => {
  const h = await harness({ premium: true })
  h.begin(); await h.time.advance(300); h.quiet()
  await h.time.advance(650); h.end()
  h.begin(); await h.time.advance(300); h.quiet()
  await h.time.advance(650); h.end()
  await h.time.advance(500)
  await h.transcribed('Open')
  assert.equal(h.turns.length, 0)
  await h.transcribed('Chrome')
  assert.deepEqual(h.turns.map(t => t.text), ['Open Chrome'])
  h.voice.stop()
})

test('existing VAD rejects clicks, preserves short speech and ignores a 400ms pause', async () => {
  const time = clock(), exports = {}, edges = [], segments = []
  let energy = 0, starts = 0, contexts = 0
  class Recorder {
    static isTypeSupported() { return true }
    mimeType = 'audio/webm'; state = 'inactive'
    start() { this.state = 'recording' }
    stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['audio']) }); this.onstop?.() }
  }
  vm.runInNewContext(vadSource, {
    exports, ...time.globals, Blob, MediaRecorder: Recorder,
    require: () => ({ getMic: async () => ({}) }),
    AudioContext: class {
      constructor() { contexts++ }
      resume() {} close() {}
      createMediaStreamSource() { return { connect() {}, disconnect() {} } }
      createAnalyser() { return { fftSize: 1024, getFloatTimeDomainData: buf => buf.fill(energy) } }
    },
  })
  const vad = await exports.startVad({
    onActivity: active => edges.push(active), onStart: () => starts++,
    onEnd: blob => segments.push(blob), onLevel() {}, onError: assert.fail,
  })
  const run = async (value, ms) => { energy = value; await time.advance(ms) }
  await run(.1, 30); await run(0, 1000)
  assert.equal(starts, 0); assert.equal(segments.length, 0)
  await run(.1, 300); await run(0, 400)
  assert.equal(segments.length, 0)
  await run(.1, 250); await run(0, 700)
  assert.equal(starts, 1); assert.equal(segments.length, 1)
  assert.ok(edges.includes(true) && edges.includes(false))
  assert.equal(contexts, 1, 'reuse the existing VAD audio graph')
  vad.stop()
})
