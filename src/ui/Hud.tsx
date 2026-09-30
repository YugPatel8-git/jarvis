import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { Blades } from './Blades'
import { Pointer } from './Pointer'
import { GestureGuide } from './GestureGuide'
import { JarvisIndicator } from './JarvisIndicator'
import { ImageShelf } from './ImageShelf'
import * as screen from '../lib/screen'

export function Hud({ onTalk, onStop }: { onTalk: () => void; onStop: () => void }) {
  const [screenOn, setScreenOn] = useState(screen.sharing)
  const [screenRequesting, setScreenRequesting] = useState(false)
  const [screenError, setScreenError] = useState('')
  useEffect(() => screen.subscribe(() => setScreenOn(screen.sharing())), [])
  const toggleScreen = () => {
    console.info('[jarvis] SCREEN BUTTON CLICKED')
    if (screenOn) { screen.stopSharing(); return }
    if (screenRequesting) return
    setScreenError('')
    setScreenRequesting(true)
    // startSharing invokes getDisplayMedia before its first await, inside this click.
    void screen.startSharing().catch((error: unknown) => {
      const name = error instanceof Error ? error.name : 'UnknownError'
      console.warn(`[jarvis] SCREEN SHARE ERROR: ${name}`)
      const reason: Record<string, string> = {
        NotSupportedError: 'SCREEN SHARE UNSUPPORTED',
        SecurityError: 'Screen sharing needs localhost or a secure connection.',
        NotAllowedError: 'Screen sharing was cancelled or blocked by Chrome.',
        AbortError: 'Screen sharing was cancelled.',
        NotFoundError: 'No screen or window was available to share.',
        InvalidStateError: 'Select this tab and try sharing again.',
        NotReadableError: 'Chrome could not read that screen or window.',
        TypeError: 'Chrome could not start screen sharing.',
      }
      if (name !== 'AbortError') setScreenError(reason[name] ?? 'Screen sharing could not start.')
    }).finally(() => setScreenRequesting(false))
  }
  const phase = useStore((s) => s.phase)
  const bridgeReady = useStore((s) => s.bridgeReady)
  const caption = useStore((s) => s.caption)
  const turns = useStore((s) => s.turns)
  const activeTool = useStore((s) => s.activeTool)
  const connected = useStore((s) => s.connected)
  const error = useStore((s) => s.error)
  const voice = useStore((s) => s.voice)
  const readinessNote = useStore((s) => s.readinessNote)
  const gestures = useStore((s) => s.gestures)
  const looking = useStore((s) => s.looking)
  const chrome = useStore((s) => s.ui.chrome)
  const log = useRef<HTMLDivElement>(null)
  const follow = useRef(true)

  // Follow streamed text only while the reader is already at the bottom.
  // Older technical responses remain selectable and scrollable.
  useEffect(() => {
    if (follow.current && log.current) log.current.scrollTop = log.current.scrollHeight
  }, [turns, chrome.transcript])

  return (
    <div className="hud">
      <header className="hud-top">
        {chrome.brand && <div className="brand">JARVIS<span>PERSONAL ASSISTANT</span></div>}
        <div className="connection"><span className={bridgeReady ? 'connection-dot ready' : 'connection-dot'} />{bridgeReady ? 'LOCAL · CONNECTED' : 'CONNECTING TO LOCAL BRIDGE'}</div>
      </header>

      <main className="workspace">
        <JarvisIndicator />
        <div className="activity" aria-live="polite">
          {activeTool && chrome.toolBadge ? `Using ${activeTool.replace(/[_-]/g, ' ')}` : phase === 'dormant' ? readinessNote : ''}
        </div>
        <div className="log" ref={log} role="region" aria-label="Conversation transcript" tabIndex={0}
          onScroll={() => { const el = log.current; if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64 }}>
          {turns.length === 0 && <div className="empty-state"><h1>At your service.</h1><p>Space to talk. A moment to think.</p>{chrome.suggestions && <span>Try “open Chrome”</span>}</div>}
          {chrome.transcript && turns.map((t) => (
            <article key={t.id} className={`log-line log-${t.role}`}>
              <h2 className="log-who">{t.role === 'user' ? 'YOU' : 'JARVIS'}</h2>
              <div className="log-text">{t.text}</div>
            </article>
          ))}
        </div>
        <div className="caption" aria-live="polite">{caption}</div>
        <ImageShelf />
        {(screenError || error) && <div className="error" role="alert">{screenError || error}</div>}
      </main>

      <footer className="hud-bottom">
        <div className="controls">
          <button type="button" className="talk-button" onClick={onTalk} aria-label="Start microphone listening" aria-pressed={phase !== 'dormant'}>{phase === 'dormant' ? 'MIC · TALK' : 'MIC ON'}<kbd>Space</kbd></button>
          <button type="button" className="screen-button" onClick={toggleScreen} disabled={screenRequesting} aria-pressed={screenOn} aria-label={screenOn ? 'Stop screen sharing' : 'Share screen'}>{screenRequesting ? 'SCREEN REQUESTING…' : screenOn ? `SCREEN SHARING${screen.sourceType() ? ` · ${screen.sourceType()}` : ''}` : 'SCREEN OFF'}</button>
          <button type="button" onClick={onStop}>STOP<kbd>Esc</kbd></button>
        </div>
        <div className="footer-meta">
          <span>{voice ? `VOICE · ${voice.replace(/\(.*?\)/g, '').trim()}` : 'VOICE READY'} <kbd>V</kbd></span>
          <span><kbd>D</kbd> diagnostics <span className="meta-separator">/</span> <kbd>G</kbd> hands</span>
          {chrome.systems && <span className="systems" title={connected.join(', ')}>{connected.length ? connected.join(' · ') : 'LOCAL SYSTEMS'} · Web</span>}
        </div>
      </footer>

      <Blades />
      {gestures && <Pointer />}
      {(gestures || looking) && <div className="hands-live">{looking ? `CAMERA · ${looking}` : 'CAMERA ON · G TO STOP'}</div>}
      {gestures && <GestureGuide />}
    </div>
  )
}
