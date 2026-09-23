import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { setVoiceSettings, voiceSettings, type VoiceSettings } from '../lib/tts'

/**
 * The "why can't he hear me / why can't I hear him" panel.
 *
 * Both halves of the voice loop fail silently by nature. Speech recognition
 * that ignores you and speech synthesis that produces no sound look identical
 * from the outside — nothing throws, nothing logs, the interface carries on as
 * though it were working. Every bug in this loop has therefore cost a round
 * trip of guesswork, and that is the actual problem this fixes: it is not a
 * developer toy, it is the instrument that turns "it doesn't work" into a
 * specific, answerable fact.
 *
 * Press D to show it. It polls rather than subscribing, because the two
 * diagnostic records are plain mutable objects written from outside React —
 * that is deliberate, since the whole point is to observe the loop without
 * changing its timing.
 */

type VoiceDiag = {
  running: boolean
  sessions: number
  heard: string
  heardAt: number
  lastError: string
  mode: string
  dropped: string
  accepted: number
  restarts: number
  idleMs: number
}

type TtsDiag = {
  engine: string
  spoken: number
  started: number
  failures: number
  lastError: string
  voice: string
  lastText: string
  stages: Record<string, number>
  phraseGapMs: number
}

type ScreenDiag = { sharing: boolean; source: string; captureMs: number; encodeMs: number; payloadBytes: number; firstResponseMs: number; totalMs: number }

const ago = (t: number) => (t ? `${((Date.now() - t) / 1000).toFixed(1)}s ago` : '—')

function Row({ k, v, bad }: { k: string; v: string; bad?: boolean }) {
  return (
    <div className="diag-row">
      <span className="diag-k">{k}</span>
      <span className={bad ? 'diag-v diag-bad' : 'diag-v'}>{v}</span>
    </div>
  )
}

export function Diagnostics() {
  const [open, setOpen] = useState(false)
  const [output, setOutput] = useState<VoiceSettings>(voiceSettings)
  const [, tick] = useState(0)
  const phase = useStore((s) => s.phase)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key === 'd' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (!open) return
    const id = setInterval(() => tick((n) => n + 1), 250)
    return () => clearInterval(id)
  }, [open])

  if (!open) return null

  const w = window as unknown as Record<string, unknown>
  const v = (w.__voice ?? {}) as Partial<VoiceDiag>
  const t = (w.__tts ?? {}) as Partial<TtsDiag>
  const screen = (w.__screen ?? {}) as Partial<ScreenDiag>
  const update = (next: Partial<VoiceSettings>) => { setVoiceSettings(next); setOutput(voiceSettings()) }

  // The two verdicts worth stating outright, rather than making you infer them
  // from the numbers underneath.
  const earsOk = Boolean(v.running) && (v.accepted ?? 0) > 0
  const mouthOk = (t.started ?? 0) > 0

  return (
    <div className="diag" aria-live="polite">
      <div className="diag-head">DIAGNOSTICS · D to close</div>

      <div className="diag-verdict">
        <span className={earsOk ? 'diag-ok' : 'diag-bad'}>
          {earsOk ? '● hearing you' : '● not hearing you'}
        </span>
        <span className={mouthOk ? 'diag-ok' : 'diag-bad'}>
          {mouthOk ? '● speaking' : '● no sound produced'}
        </span>
      </div>

      <div className="diag-sec">LISTENING</div>
      <Row k="recogniser" v={v.running ? 'running' : 'STOPPED'} bad={!v.running} />
      <Row k="sessions" v={String(v.sessions ?? 0)} />
      <Row
        k="silent for"
        v={`${((v.idleMs ?? 0) / 1000).toFixed(1)}s`}
        bad={(v.idleMs ?? 0) > 15000}
      />
      <Row k="forced restarts" v={String(v.restarts ?? 0)} bad={(v.restarts ?? 0) > 0} />
      <Row k="mode" v={`${v.mode ?? '—'} (phase ${phase})`} />
      <Row k="accepted" v={String(v.accepted ?? 0)} bad={(v.accepted ?? 0) === 0} />
      <Row k="last heard" v={v.heard ? `"${v.heard}" ${ago(v.heardAt ?? 0)}` : '— nothing yet'} bad={!v.heard} />
      <Row k="last drop" v={v.dropped || '—'} bad={Boolean(v.dropped)} />
      <Row k="error" v={v.lastError || '—'} bad={Boolean(v.lastError)} />

      <div className="diag-sec">SPEAKING · press T to test</div>
      <Row k="engine" v={String(t.engine ?? 'system')} />
      <Row k="voice" v={String(t.voice || '—')} />
      <Row k="handed to voice" v={String(t.spoken ?? 0)} />
      <Row k="actually spoke" v={String(t.started ?? 0)} bad={(t.started ?? 0) === 0} />
      <Row k="failures" v={String(t.failures ?? 0)} bad={(t.failures ?? 0) > 0} />
      <div className="diag-sec">VOICE OUTPUT</div>
      <label className="diag-row">Voice volume <input aria-label="Voice volume" type="range" min="80" max="150" step="5" value={output.volume} onChange={(e) => update({ volume: Number(e.target.value) })} /> {output.volume}%</label>
      <label className="diag-row">Voice clarity <select aria-label="Voice clarity" value={output.clarity} onChange={(e) => update({ clarity: e.target.value as VoiceSettings['clarity'] })}><option value="off">Off</option><option value="low">Low</option><option value="medium">Medium</option></select></label>
      <label className="diag-row">Phrase gap <select aria-label="Phrase gap" value={output.gap} onChange={(e) => update({ gap: e.target.value as VoiceSettings['gap'] })}><option value="natural">Natural</option><option value="tight">Tight</option></select></label>
      <div className="diag-sec">LAST PHRASE · MS FROM READY</div>
      {Object.entries(t.stages ?? {}).map(([stage, ms]) => <Row key={stage} k={stage} v={`${ms} ms`} />)}
      <Row k="last phrase gap" v={t.phraseGapMs === undefined ? '—' : `${t.phraseGapMs} ms`} />
      <div className="diag-sec">SCREEN</div>
      <Row k="sharing" v={screen.sharing ? `on · ${screen.source || 'selected source'}` : 'off'} />
      <Row k="capture / encode" v={`${screen.captureMs ?? 0} / ${screen.encodeMs ?? 0} ms`} />
      <Row k="frame payload" v={`${screen.payloadBytes ?? 0} bytes`} />
      <Row k="vision to first reply" v={`${screen.firstResponseMs ?? 0} ms`} />
      <Row k="vision to turn end" v={`${screen.totalMs ?? 0} ms`} />
      <Row k="error" v={t.lastError || '—'} bad={Boolean(t.lastError)} />
    </div>
  )
}
