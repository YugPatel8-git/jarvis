import { useSyncExternalStore } from 'react'
import { useStore, type Phase } from '../store'
import { isPlaybackActive, subscribePlayback } from '../lib/tts'

const labels: Record<Phase, string> = {
  dormant: 'Ready when you are',
  listening: 'Listening',
  thinking: 'Thinking',
  tooling: 'Working',
  speaking: 'Preparing speech',
}

/** Playback notifications only: no frame loop, audio graph, or per-frame render. */
export function JarvisIndicator() {
  const phase = useStore((s) => s.phase)
  const error = useStore((s) => s.error)
  const playing = useSyncExternalStore(subscribePlayback, isPlaybackActive, () => false)
  const state = playing ? 'speaking' : error ? 'error' : phase === 'speaking' ? 'dormant' : phase
  const label = playing ? 'Speaking' : error ? 'Needs attention' : labels[phase]

  return (
    <div className="indicator" data-state={state} data-preparing={!playing && !error && phase === 'speaking' || undefined}>
      <div className="core-scene" aria-hidden="true">
        <svg className="core-schematic" viewBox="0 0 720 300" fill="none" focusable="false">
          <g className="schematic-traces">
            <path d="M240 150H166L139 123H65M248 105H208L178 75H103M265 66L233 34H185M243 187H193L155 225H82M291 249L271 269H218" />
            <path d="M480 150H547L577 120H654M470 98H513L547 64H604M481 187H534L561 214H665M439 245L467 273H524" />
            <path d="M173 157H108M551 158H620M203 83H163M558 223H599M306 31V17M413 30V20" />
          </g>
          <g className="schematic-nodes">
            <path d="M57 119h8v8h-8zM95 71h8v8h-8zM74 221h8v8h-8zM654 116h8v8h-8zM665 210h8v8h-8zM524 269h8v8h-8z" />
            <circle cx="181" cy="34" r="3" /><circle cx="215" cy="269" r="3" /><circle cx="608" cy="64" r="3" />
            <path d="M117 153v8m6-8v8m6-8v8M597 154v8m6-8v8m6-8v8M211 29v10m5-10v10M488 268v10m5-10v10" />
          </g>
        </svg>
        <div className="jarvis-core">
          <div className="core-energy" />
          <svg className="core-rings" viewBox="0 0 240 240" fill="none" focusable="false">
            <circle className="core-outer" cx="120" cy="120" r="118" />
            <circle className="core-segments" cx="120" cy="120" r="111" pathLength="100" strokeDasharray="22 3 8 5 31 3 18 10" transform="rotate(-38 120 120)" />
            <circle className="core-track" cx="120" cy="120" r="103" />
            <path className="core-ticks" d="M73 38.6a94 94 0 0 1 141 81.4M167 201.4a94 94 0 0 1-141-81.4" strokeDasharray="1 5" />
            <circle className="core-inner" cx="120" cy="120" r="84" />
            <circle className="core-lens" cx="120" cy="120" r="77" />
            <path className="core-index" d="M120 0v8m120 112h-8M120 240v-8M0 120h8M116 48h8M116 192h8" />
          </svg>
          <div className="core-center"><span>JARVIS</span><i /></div>
        </div>
      </div>
      <span className="indicator-label" role="status">{label}</span>
    </div>
  )
}
