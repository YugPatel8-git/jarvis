import { useStore } from '../store'

/** A single unobtrusive example while the interface is idle. */
export function Suggestions() {
  const phase = useStore((s) => s.phase)
  const turns = useStore((s) => s.turns)
  if (phase !== 'dormant' || turns.length > 0) return null
  return (
    <div className="suggest">
      <span className="suggest-lead">try</span>
      <span className="suggest-text">Press Talk and say “open Chrome”</span>
    </div>
  )
}
