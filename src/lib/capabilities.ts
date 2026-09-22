import { BACKEND, BRIDGE_HTTP_URL, env } from '../config'

/**
 * What speech engines are available, probed during page startup.
 *
 * The whole point is that the app runs for anyone. A student who has done
 * nothing but install Codex CLI and log in gets the browser's own speech
 * recognition and voice — no keys, no accounts, it just works. A student who
 * also supplies an ElevenLabs key gets Scribe transcription. Fish Audio TTS
 * is detected separately through the local bridge, with local voice fallback.
 *
 * Remote speech paths live behind the bridge, which holds their keys. Direct
 * mode is browser-only so no credentials enter the frontend bundle.
 */

export type Capabilities = {
  /** ElevenLabs speech-to-text (Scribe) is reachable via the bridge. */
  stt: boolean
  /** Fish Audio text-to-speech is reachable via the bridge. */
  tts: boolean
  ttsEngine: 'fish' | null
}

/** Browser-only until the probe says otherwise. Safe default: the app works. */
let current: Capabilities = { stt: false, tts: false, ttsEngine: null }
let probed = false

/** The last known capabilities. Read synchronously by the voice and speech
 *  layers; accurate once `probeCapabilities` has resolved. */
export function caps(): Capabilities {
  return current
}

export function capabilitiesProbed(): boolean {
  return probed
}

/**
 * Ask the bridge what it can do during page startup. Manual voice activation
 * awaits this probe, so the first request uses the right engine. Never throws:
 * a failed probe simply leaves the browser fallback in
 * place, which is the correct behaviour when the bridge is unreachable.
 */
export async function probeCapabilities(): Promise<Capabilities> {
  if (BACKEND !== 'bridge') {
    // No bridge to ask. Direct mode has no server-side speech, so browser only.
    current = { stt: false, tts: false, ttsEngine: null }
    probed = true
    return current
  }
  try {
    const res = await fetch(`${BRIDGE_HTTP_URL}/health`, {
      signal: AbortSignal.timeout(3000),
    })
    if (res.ok) {
      const h = (await res.json()) as { stt?: boolean; tts?: boolean; ttsEngine?: string }
      current = { stt: Boolean(h.stt), tts: Boolean(h.tts), ttsEngine: h.ttsEngine === 'fish' ? 'fish' : null }
    }
  } catch {
    // Bridge down or slow — stay on the browser engines rather than blocking
    // manual activation on a health check that is only an optimisation.
  }
  probed = true
  return current
}

/** A short human label for the HUD: what voice stack is actually in play. */
export function engineLabel(): string {
  const c = current
  if (c.stt && c.ttsEngine === 'fish') return 'ElevenLabs recognition + Fish Audio voice'
  if (c.ttsEngine === 'fish') return 'Fish Audio voice'
  // env.elevenKey is only meaningful in direct mode; harmless to mention.
  if (env.elevenKey && BACKEND !== 'bridge') return 'ElevenLabs (direct)'
  return 'browser speech'
}
