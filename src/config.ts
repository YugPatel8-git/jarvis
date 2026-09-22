/** Browser-safe configuration. No model credentials are accepted here. */
function str(raw: unknown): string | undefined {
  const value = typeof raw === 'string' ? raw.trim() : ''
  return value || undefined
}
function choice<T extends string>(raw: unknown, allowed: readonly T[], fallback: T): T {
  const value = str(raw)
  return value && (allowed as readonly string[]).includes(value) ? value as T : fallback
}

export const BACKEND: 'bridge' | 'direct' = 'bridge'
export const BRIDGE_WS_URL = str(import.meta.env.VITE_BRIDGE_URL) ?? 'ws://127.0.0.1:8787'
export const BRIDGE_HTTP_URL = BRIDGE_WS_URL.replace(/^ws/, 'http')
export const TTS_ENGINE: 'kokoro' | 'system' = choice(
  import.meta.env.VITE_TTS_ENGINE, ['kokoro', 'system'] as const, 'kokoro',
)
export const KOKORO_VOICE = choice(
  import.meta.env.VITE_KOKORO_VOICE,
  ['bm_george', 'bm_fable', 'bm_lewis', 'bm_daniel'] as const,
  'bm_george',
)
export const env = {
  // These optional browser services are unrelated to model authentication.
  elevenKey: '',
  elevenVoiceId: 'JBFqnCBsd6RMkjVDRZzb',
}
