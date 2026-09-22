import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FISH_MODEL, fishConfigured, fishSpeech } from '../bridge/fish-tts.mjs'

test('Fish request keeps bearer authentication on the bridge', async () => {
  const env = { FISH_AUDIO_API_KEY: 'test-secret', FISH_AUDIO_MODEL: 's2.1-pro', FISH_AUDIO_REFERENCE_ID: 'test-voice' }
  let request
  const result = await fishSpeech('Good afternoon.', {
    env,
    fetchImpl: async (url, options) => {
      request = { url, options }
      return { ok: true, body: 'audio-stream' }
    },
  })
  assert.equal(fishConfigured(env), true)
  assert.equal(request.url, 'https://api.fish.audio/v1/tts')
  assert.equal(request.options.headers.authorization, 'Bearer test-secret')
  assert.equal(FISH_MODEL, 's2.1-pro-free')
  assert.equal(request.options.headers.model, FISH_MODEL)
  assert.deepEqual(JSON.parse(request.options.body), { text: 'Good afternoon.', format: 'mp3', reference_id: 'test-voice' })
  assert.equal(result.audio, 'audio-stream')
})

test('upstream errors never return account details', async () => {
  const result = await fishSpeech('Hello.', {
    env: { FISH_AUDIO_API_KEY: 'test-secret', FISH_AUDIO_REFERENCE_ID: 'test-voice' },
    fetchImpl: async () => ({ ok: false, status: 401, body: { cancel: async () => {} } }),
  })
  assert.deepEqual(result, { status: 401, audio: null })
  assert.equal(fishConfigured({}), false)
  assert.equal(fishConfigured({ FISH_AUDIO_API_KEY: 'test-secret' }), false)
})

test('rate limits never trigger a paid Fish model', async () => {
  const models = []
  const result = await fishSpeech('Hello.', {
    env: { FISH_AUDIO_API_KEY: 'test-secret', FISH_AUDIO_REFERENCE_ID: 'test-voice', FISH_AUDIO_MODEL: 's2.1-pro' },
    fetchImpl: async (_url, options) => {
      models.push(options.headers.model)
      return { ok: false, status: 429, body: { cancel: async () => {} } }
    },
  })
  assert.deepEqual(models, ['s2.1-pro-free'])
  assert.deepEqual(result, { status: 429, audio: null })
})
