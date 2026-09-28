/** Explicit, on-demand screen sharing. No frames exist before a HUD click. */
import { setScreenSharing } from './bridge'

type Frame = { data?: string; mimeType?: string; unchanged?: boolean; error?: string }
export const diag = { sharing: false, source: '', captureMs: 0, encodeMs: 0, payloadBytes: 0, visionRequestAt: 0, firstResponseMs: 0, totalMs: 0 }
if (typeof window !== 'undefined') (window as unknown as Record<string, unknown>).__screen = diag

let stream: MediaStream | null = null
let video: HTMLVideoElement | null = null
let lastPixels: Uint8ClampedArray | null = null
let lastSentAt = 0
let generation = 0
let starting: Promise<void> | null = null
let canvas: HTMLCanvasElement | null = null
let thumb: HTMLCanvasElement | null = null
let listeners = new Set<() => void>()
const notify = () => { setScreenSharing(sharing()); for (const fn of listeners) fn() }
export const sharing = () => Boolean(stream?.getVideoTracks().some((track) => track.readyState === 'live'))
export const sourceType = () => diag.source
export function subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn) } }

export function stopSharing(): void {
  generation++
  starting = null
  const old = stream
  stream = null
  video?.pause()
  if (video) video.srcObject = null
  video = null
  old?.getTracks().forEach((track) => track.stop())
  lastPixels = null; lastSentAt = 0
  canvas = null; thumb = null
  diag.sharing = false; diag.source = ''; diag.payloadBytes = 0
  notify()
}

/** Must be called directly from the screen button's user gesture. */
export async function startSharing(): Promise<void> {
  if (sharing()) return
  if (starting) return starting
  if (typeof window !== 'undefined' && window.isSecureContext === false) {
    throw Object.assign(new Error('Screen sharing requires localhost or a secure connection.'), { name: 'SecurityError' })
  }
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw Object.assign(new Error('Screen sharing is unsupported in this browser.'), { name: 'NotSupportedError' })
  }
  console.info('[jarvis] GETDISPLAYMEDIA REQUESTED')
  const mine = ++generation
  const request = (async () => {
  const selected = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
  if (mine !== generation) { selected.getTracks().forEach((t) => t.stop()); return }
  const track = selected.getVideoTracks()[0]
  if (!track) { selected.getTracks().forEach((t) => t.stop()); throw new Error('No screen video was selected.') }
  try {
    const el = document.createElement('video')
    el.muted = true; el.playsInline = true; el.srcObject = selected
    track.addEventListener('ended', () => { if (mine === generation) stopSharing() }, { once: true })
    await el.play()
    if (mine !== generation) { el.pause(); el.srcObject = null; selected.getTracks().forEach((t) => t.stop()); return }
    if (track.readyState !== 'live') throw new Error('Screen sharing ended before capture began.')
    stream = selected; video = el
    const surface = track.getSettings().displaySurface
    diag.source = surface === 'monitor' ? 'Screen' : surface === 'window' ? 'Window' : surface === 'browser' ? 'Tab' : ''
    diag.sharing = true
    notify()
    console.info('[jarvis] SCREEN SHARE STARTED')
  } catch (error) { selected.getTracks().forEach((t) => t.stop()); throw error }
  })()
  starting = request
  try { await request } finally { if (starting === request) starting = null }
}

/** One compressed frame per request, with a tiny local comparison thumbnail. */
export function captureFrame(): Frame {
  if (!sharing() || !video?.videoWidth) return { error: 'Screen sharing is off or the selected source is not ready.' }
  const started = performance.now()
  const scale = Math.min(1, 1600 / Math.max(video.videoWidth, video.videoHeight))
  canvas ??= document.createElement('canvas')
  const width = Math.max(1, Math.round(video.videoWidth * scale))
  const height = Math.max(1, Math.round(video.videoHeight * scale))
  if (canvas.width !== width) canvas.width = width
  if (canvas.height !== height) canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return { error: 'Could not capture the shared screen.' }
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
  diag.captureMs = Math.round(performance.now() - started)
  if (!thumb) { thumb = document.createElement('canvas'); thumb.width = 64; thumb.height = 36 }
  const tiny = thumb.getContext('2d', { willReadFrequently: true })
  if (!tiny) return { error: 'Could not compare screen frames.' }
  tiny.drawImage(canvas, 0, 0, 64, 36)
  const pixels = tiny.getImageData(0, 0, 64, 36).data
  let difference = 0
  if (lastPixels) for (let i = 0; i < pixels.length; i += 4) {
    difference += Math.abs(pixels[i] - lastPixels[i]) + Math.abs(pixels[i + 1] - lastPixels[i + 1]) + Math.abs(pixels[i + 2] - lastPixels[i + 2])
  }
  if (lastPixels && difference / (64 * 36 * 3) < 2 && performance.now() - lastSentAt < 60_000) {
    diag.encodeMs = 0; diag.payloadBytes = 0
    return { unchanged: true }
  }
  const encoded = canvas.toDataURL('image/jpeg', 0.83)
  diag.encodeMs = Math.round(performance.now() - started - diag.captureMs)
  const data = encoded.slice(encoded.indexOf(',') + 1)
  diag.payloadBytes = Math.round(data.length * 0.75)
  lastPixels = new Uint8ClampedArray(pixels); lastSentAt = performance.now()
  return { data, mimeType: 'image/jpeg' }
}
