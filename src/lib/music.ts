/** Optional local work cue. Startup never plays music. */
let work: HTMLAudioElement | null = null
let enabled = false
let active = false
let ducked = false
let frame = 0

export function enable(): void {
  if (enabled) return
  enabled = true
  work = new Audio('/audio/work.mp3')
  work.preload = 'auto'
  work.loop = true
  work.volume = 0
}

function fade(target: number, ms: number): void {
  if (!work) return
  cancelAnimationFrame(frame)
  const el = work
  const from = el.volume
  const start = performance.now()
  if (target > 0 && el.paused) void el.play().catch(() => {})
  const step = () => {
    const k = Math.min(1, (performance.now() - start) / ms)
    el.volume = from + (target - from) * k
    if (k < 1) frame = requestAnimationFrame(step)
    else if (target === 0) el.pause()
  }
  frame = requestAnimationFrame(step)
}

function level(): number { return active ? (ducked ? 0.11 * 0.35 : 0.11) : 0 }

export function working(on: boolean): void {
  active = on
  fade(level(), on ? 900 : 1400)
}

export function duck(on: boolean): void {
  ducked = on
  if (active) fade(level(), on ? 250 : 900)
}
