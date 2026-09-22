/** Fish credentials and upstream requests stay in the bridge process. */
export const FISH_MODEL = 's2.1-pro-free'

export function fishConfigured(env = process.env) {
  return Boolean(env.FISH_AUDIO_API_KEY?.trim() && env.FISH_AUDIO_REFERENCE_ID?.trim())
}

export async function fishSpeech(text, { env = process.env, fetchImpl = fetch, signal } = {}) {
  const key = env.FISH_AUDIO_API_KEY?.trim()
  const referenceId = env.FISH_AUDIO_REFERENCE_ID?.trim()
  if (!key || !referenceId) return null
  const response = await fetchImpl('https://api.fish.audio/v1/tts', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      model: FISH_MODEL,
    },
    body: JSON.stringify({ text, format: 'mp3', reference_id: referenceId }),
    signal,
  })
  // Never forward upstream error bodies: they may include account information.
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    return { status: response.status, audio: null }
  }
  return { status: 200, audio: response.body }
}
