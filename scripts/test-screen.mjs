import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('../src/lib/screen.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText

function harness() {
  let pickerCalls = 0, stopped = 0, ended = null, pixel = 80
  const statuses = []
  const track = {
    readyState: 'live',
    getSettings: () => ({ displaySurface: 'monitor' }),
    addEventListener: (_name, fn) => { ended = fn },
    stop: () => { track.readyState = 'ended'; stopped++ },
  }
  const stream = { getVideoTracks: () => [track], getTracks: () => [track] }
  const makeCanvas = () => ({
    width: 0, height: 0,
    getContext: () => ({ drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(64 * 36 * 4).fill(pixel) }) }),
    toDataURL: () => 'data:image/jpeg;base64,ZmFrZQ==',
  })
  const exports = {}
  vm.runInNewContext(compiled, {
    exports,
    require: (id) => { assert.equal(id, './bridge'); return { setScreenSharing: (value) => statuses.push(value) } },
    window: {}, performance,
    navigator: { mediaDevices: { getDisplayMedia: async () => { pickerCalls++; return stream } } },
    document: { createElement: (tag) => tag === 'video'
      ? { videoWidth: 1920, videoHeight: 1080, play: async () => {}, pause() {}, srcObject: null }
      : makeCanvas() },
    Uint8ClampedArray, Math,
  }, { filename: 'screen.js' })
  return { screen: exports, statuses, get pickerCalls() { return pickerCalls }, get stopped() { return stopped }, end: () => ended?.(), change: () => { pixel = 120 } }
}

test('screen is off until explicit activation and picker runs once', async () => {
  const h = harness()
  assert.equal(h.screen.sharing(), false)
  assert.match(h.screen.captureFrame().error, /off/)
  assert.equal(h.pickerCalls, 0)
  await h.screen.startSharing()
  assert.equal(h.pickerCalls, 1)
  assert.equal(h.screen.sharing(), true)
  assert.deepEqual(h.statuses, [true])
})

test('unchanged frame is not re-encoded and native stop clears state', async () => {
  const h = harness()
  await h.screen.startSharing()
  assert.ok(h.screen.captureFrame().data)
  assert.equal(h.screen.captureFrame().unchanged, true)
  h.change()
  assert.ok(h.screen.captureFrame().data)
  h.end()
  assert.equal(h.screen.sharing(), false)
  assert.equal(h.screen.diag.payloadBytes, 0)
  assert.equal(h.screen.captureFrame().data, undefined)
  assert.equal(h.stopped, 1)
  assert.deepEqual(h.statuses, [true, false])
})
