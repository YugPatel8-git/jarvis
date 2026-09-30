import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as React from 'react'
import * as jsx from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'

function uiHarness({ phase = 'dormant', playing = false, error = null, turns = [], gestures = false } = {}) {
  const state = { phase, error, turns, gestures, bridgeReady: true, connected: ['Browser'], voice: 'Fish Audio', caption: '',
    ui: { chrome: { brand: true, transcript: true, toolBadge: true, systems: true, suggestions: true }, orbits: [] } }
  const callbacks = []
  let screenRequests = 0
  const cache = new Map()
  function load(file) {
    if (cache.has(file)) return cache.get(file)
    const exports = {}
    cache.set(file, exports)
    const source = ts.transpileModule(readFileSync(new URL(`../src/ui/${file}.tsx`, import.meta.url), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    }).outputText
    vm.runInNewContext(source, {
      exports, console, require(id) {
        if (id === 'react') return { ...React, useSyncExternalStore: (_subscribe, snapshot) => snapshot() }
        if (id === 'react/jsx-runtime') return { ...jsx, jsx(type, props, key) {
          if (type === 'button') callbacks.push(props)
          return jsx.jsx(type, props, key)
        }, jsxs(type, props, key) {
          if (type === 'button') callbacks.push(props)
          return jsx.jsxs(type, props, key)
        } }
        if (id === '../store') return { useStore: selector => selector(state) }
        if (id === '../lib/tts') return { isPlaybackActive: () => playing, subscribePlayback: () => () => {} }
        if (id === '../lib/screen') return { sharing: () => false, subscribe: () => () => {}, startSharing: () => { screenRequests++; return Promise.resolve() } }
        if (id === './JarvisIndicator') return load('JarvisIndicator')
        return new Proxy({}, { get: (_target, name) => () => React.createElement('span', { 'data-component': name }) })
      },
    })
    return exports
  }
  return { state, callbacks, load, get screenRequests() { return screenRequests } }
}

test('core distinguishes preparation from audible playback and keeps accessible state feedback', () => {
  for (const [phase, playing, error, expected] of [
    ['dormant', false, null, 'dormant'], ['listening', false, null, 'listening'],
    ['thinking', false, null, 'thinking'], ['tooling', false, null, 'tooling'],
    ['speaking', false, null, 'dormant'], ['speaking', true, null, 'speaking'],
    ['dormant', true, null, 'speaking'], ['dormant', false, 'Connection lost', 'error'],
    ['speaking', false, 'Connection lost', 'error'], ['listening', true, null, 'speaking'],
  ]) {
    const h = uiHarness({ phase, playing, error })
    const html = renderToStaticMarkup(React.createElement(h.load('JarvisIndicator').JarvisIndicator))
    assert.ok(html.includes(`data-state="${expected}"`))
    assert.ok(html.includes('class="jarvis-core"'), 'core is always present')
    assert.equal(html.includes('data-preparing="true"'), phase === 'speaking' && !playing && !error)
    assert.equal(html.includes('>Speaking</span>'), playing)
    assert.ok(html.includes('class="core-scene" aria-hidden="true"'), 'decoration is hidden from assistive technology')
    assert.ok(html.includes('role="status"'), 'state feedback is accessible without animation')
  }
})

test('HUD renders all retained technical responses and preserves direct Talk/Stop/screen actions', async () => {
  const turns = Array.from({ length: 10 }, (_, i) => ({ id: String(i), role: i % 2 ? 'jarvis' : 'user', text: `Response ${i}\n${'technical detail '.repeat(100)}` }))
  const h = uiHarness({ turns })
  let talks = 0, stops = 0
  const html = renderToStaticMarkup(React.createElement(h.load('Hud').Hud, { onTalk: () => talks++, onStop: () => stops++ }))
  assert.equal((html.match(/<article/g) || []).length, 10)
  for (const t of turns) assert.ok(html.includes(t.text))
  assert.ok(html.includes('Conversation transcript'))
  assert.ok(html.includes('Fish Audio'))
  assert.ok(!html.includes('data-component="Pointer"'), 'no pointer work when gestures are off')
  assert.ok(!html.includes('data-component="GestureGuide"'), 'no gesture-guide timer when gestures are off')
  h.callbacks.find(p => p.className === 'talk-button').onClick()
  h.callbacks.find(p => p.children?.[0] === 'STOP').onClick()
  h.callbacks.find(p => p.className === 'screen-button').onClick()
  assert.equal(talks, 1)
  assert.equal(stops, 1)
  assert.equal(h.screenRequests, 1, 'screen picker starts inside the click, without a timer or await')
  await Promise.resolve()
})
