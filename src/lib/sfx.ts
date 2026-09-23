/**
 * Sound design.
 *
 * Every cue is synthesised in Web Audio rather than shipped as a file, so the
 * app makes the right noises the moment you clone it — nothing to download, no
 * licence to worry about, a few hundred bytes instead of a few megabytes.
 *
 * These are interface cues; startup plays no soundtrack.
 */

type Cue = 'listen' | 'tool' | 'done' | 'error'

let ctx: AudioContext | null = null
let master: GainNode | null = null

/** Where the master sits when JARVIS isn't speaking. */
let volume = 0.5
let ducked = false
/** How far everything this module makes drops under the voice. */
const DUCK = 0.45

function audio(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext()
    master = ctx.createGain()
    master.gain.value = volume
    master.connect(ctx.destination)
  }
  return ctx
}

/**
 * Ramp a gain to a new value from wherever it actually is.
 *
 * The cancel-then-anchor dance is not optional: a Web Audio ramp interpolates
 * from the *previous scheduled event*, so a later automation point that hasn't
 * fired yet — the three-second fade-in of the bed, say — survives, and the
 * value climbs back to it the moment the new ramp lands. That is how ducking
 * during the first seconds of the bed used to undo itself.
 */
function rampTo(param: AudioParam, to: number, seconds: number) {
  if (!ctx) return
  const now = ctx.currentTime
  param.cancelScheduledValues(now)
  param.setValueAtTime(param.value, now)
  param.linearRampToValueAtTime(Math.max(0.0001, to), now + seconds)
}

/**
 * Browsers won't start audio until the user has interacted with the page, so
 * this has to be called from a click or keypress.
 */
export async function unlockAudio(): Promise<void> {
  const c = audio()
  if (c.state === 'suspended') {
    try {
      await c.resume()
    } catch {
      // A refused audio unlock should not prevent manual microphone capture.
    }
  }
}

export function setVolume(v: number) {
  volume = Math.max(0, Math.min(1, v))
  if (master) rampTo(master.gain, ducked ? volume * DUCK : volume, 0.05)
}

// ---------------------------------------------------------------------------
// Synthesis helpers
// ---------------------------------------------------------------------------

/** A pitched blip with an exponential decay — the basic HUD tick. */
function blip(
  freq: number,
  {
    at = 0,
    dur = 0.12,
    type = 'sine' as OscillatorType,
    gain = 0.25,
    sweepTo = 0,
  } = {},
) {
  const c = audio()
  const t = c.currentTime + at
  const osc = c.createOscillator()
  const env = c.createGain()

  osc.type = type
  osc.frequency.setValueAtTime(freq, t)
  if (sweepTo) osc.frequency.exponentialRampToValueAtTime(sweepTo, t + dur)

  // Fast attack, exponential tail — reads as electronic rather than musical.
  env.gain.setValueAtTime(0.0001, t)
  env.gain.exponentialRampToValueAtTime(gain, t + 0.008)
  env.gain.exponentialRampToValueAtTime(0.0001, t + dur)

  osc.connect(env).connect(master!)
  osc.start(t)
  osc.stop(t + dur + 0.02)
}

/** Filtered noise burst — air, whooshes, transients. */
function noise({ at = 0, dur = 0.4, gain = 0.12, from = 400, to = 6000 } = {}) {
  const c = audio()
  const t = c.currentTime + at
  const frames = Math.floor(c.sampleRate * dur)
  const buf = c.createBuffer(1, frames, c.sampleRate)
  const data = buf.getChannelData(0)
  for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1

  const src = c.createBufferSource()
  src.buffer = buf

  const filter = c.createBiquadFilter()
  filter.type = 'bandpass'
  filter.Q.value = 1.2
  filter.frequency.setValueAtTime(from, t)
  filter.frequency.exponentialRampToValueAtTime(to, t + dur)

  const env = c.createGain()
  env.gain.setValueAtTime(0.0001, t)
  env.gain.exponentialRampToValueAtTime(gain, t + dur * 0.25)
  env.gain.exponentialRampToValueAtTime(0.0001, t + dur)

  src.connect(filter).connect(env).connect(master!)
  src.start(t)
}

// ---------------------------------------------------------------------------

const synth: Record<Cue, () => void> = {
  /** Listening: a single soft low pip so it doesn't fight the user's voice. */
  listen: () => blip(660, { dur: 0.1, gain: 0.14 }),

  /** A tool fired — a tiny mechanical tick. */
  tool: () => {
    blip(2200, { dur: 0.05, type: 'square', gain: 0.07 })
    noise({ dur: 0.1, gain: 0.05, from: 3000, to: 900 })
  },

  /** Turn complete: a short descending pair. */
  done: () => {
    blip(1320, { dur: 0.1, gain: 0.14 })
    blip(880, { at: 0.08, dur: 0.2, gain: 0.13 })
  },

  /** Something failed — flat, slightly dissonant, not alarming. */
  error: () => {
    blip(320, { dur: 0.18, type: 'square', gain: 0.14 })
    blip(226, { at: 0.13, dur: 0.3, type: 'square', gain: 0.12 })
  },
}

export function play(cue: Cue) {
  if (!ctx || ctx.state !== 'running') return

  synth[cue]()
}

// ---------------------------------------------------------------------------
/**
 * Duck everything this module makes while JARVIS speaks.
 *
 * All interface cues hang off the master, so ducking prevents a tool tick or
 * completion chime from landing over a spoken word.
 */
export function duck(on: boolean) {
  if (ducked === on || !master) return
  ducked = on
  // Out of the way quickly, back slowly — a fast recovery is audible as a
  // swell, and there is usually another sentence right behind the first.
  rampTo(master.gain, on ? volume * DUCK : volume, on ? 0.12 : 0.5)
}
