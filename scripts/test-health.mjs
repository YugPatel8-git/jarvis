import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHealth, diagnosticText } from '../bridge/health.mjs'

test('normal monitoring stays silent and diagnostics do not expose errors', () => {
  const health = createHealth()
  health.mark('bridge', 'ready')
  health.mark('codex', 'ready')
  health.timing('localCommand', 40)
  assert.equal(health.snapshot().notices.length, 0)
  health.failure('browser', new Error('Authorization: Bearer test-secret'))
  const report = JSON.stringify(health.snapshot()) + diagnosticText(health.snapshot())
  assert.doesNotMatch(report, /Bearer|test-secret|Authorization/)
  assert.match(report, /Codex is connected/)
  assert.equal(health.snapshot().components.browser.lastFailureKind, null)
})

test('Fish failures trigger one degradation notice and a bounded cooldown', () => {
  let time = 1_000
  const health = createHealth({ now: () => time })
  assert.equal(health.failure('fish'), null)
  assert.equal(health.failure('fish'), null)
  assert.match(health.failure('fish'), /local voice/)
  assert.equal(health.failure('fish'), null)
  assert.equal(health.fishAvailable(), false)
  assert.equal(health.snapshot().notices.length, 1)
  health.mark('fish', 'idle')
  assert.equal(health.snapshot().components.fish.state, 'degraded')
  time += 30_001
  assert.equal(health.fishAvailable(), true)
  assert.match(health.mark('fish', 'ready'), /recovered/)
  assert.equal(health.snapshot().components.fish.failures, 0)
})

test('timings and notices stay bounded; only persistent large regressions flag slow', () => {
  let time = 1_000
  const health = createHealth({ now: () => time })
  for (let i = 0; i < 10; i++) assert.equal(health.timing('localCommand', 40), false)
  assert.equal(health.timing('localCommand', 900), false)
  assert.equal(health.timing('localCommand', 900), false)
  assert.equal(health.timing('localCommand', 900), true)
  for (let i = 0; i < 50; i++) health.timing('localCommand', 40)
  assert.equal(health.snapshot().metrics.localCommand.samples, 32)
  assert.equal(health.snapshot().metrics.localCommand.slow, false)
  for (let i = 0; i < 12; i++) { health.failure('browser'); health.mark('browser', 'ready') }
  assert.ok(health.snapshot().notices.length <= 8)
  time += 11 * 60_000
  assert.equal(health.snapshot().notices.length, 0)
})

test('diagnostics report unknown browser status without probing it', () => {
  const health = createHealth()
  health.mark('bridge', 'ready')
  const report = diagnosticText(health.snapshot({ pendingRequests: 1 }))
  assert.match(report, /browser automation has not been used yet/)
  assert.match(report, /1 request is pending/)
})

test('repeated failure kinds are counted without retaining exception text', () => {
  const health = createHealth()
  health.failure('codex', 'process-exit')
  health.failure('codex', 'process-exit')
  assert.equal(health.snapshot().components.codex.repeatedFailure, 2)
  health.failure('codex', 'turn-timeout')
  assert.equal(health.snapshot().components.codex.repeatedFailure, 1)
  health.mark('codex', 'ready')
  assert.equal(health.snapshot().components.codex.lastFailureKind, null)
})
