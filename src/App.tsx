import { useEffect, useRef } from 'react'
import { Scene } from './scene/Scene'
import { Hud } from './ui/Hud'
import { Diagnostics } from './ui/Diagnostics'
import { useStore } from './store'
import { startVoice, type Voice, type VoiceMode } from './lib/voice'
import { createSpeaker, cycleVoice, currentVoiceName, prewarmSpeech } from './lib/tts'
import { wantsLiteralTechnicalSpeech } from './lib/speech-text'
import * as sfx from './lib/sfx'
import * as hands from './lib/hands'
import * as camera from './lib/camera'
import * as screen from './lib/screen'
import * as kokoro from './lib/kokoro'
import { TTS_ENGINE } from './config'
import {
  ask,
  warm,
  interrupt,
  watchServers,
  watchPanels,
  watchBlades,
  watchCapture,
  watchUi,
  watchConnection,
  watchHealthNotice,
  connectedLabels,
  isConnected,
  type Msg,
} from './lib/brain'
import { startAnalyser, micLevel, releaseMic } from './lib/audio'
import { probeCapabilities } from './lib/capabilities'

/**
 * The conversation.
 *
 * This used to be a sequential loop — greet, await a capture, await an answer,
 * repeat — with the microphone opened and closed around each step. That shape
 * cannot be interrupted: while it is awaiting the answer, nothing is listening,
 * so there is no way for the user to get a word in.
 *
 * It is an event machine now. The voice loop runs continuously and pushes
 * events at us; every one of them is legal in every phase. Saying anything at
 * all stops him talking, and whatever you say next becomes the new turn.
 */

/** Manual capture window; permission prompts may take part of this time. */
const AWAIT_SPEECH_MS = 14000

/** After an answer, how long the mic stays open for a follow-up before he
 *  drops back to standby. Long enough that you don't have to say the name
 *  again to continue a thought. */
const FOLLOW_UP_MS = 11000

/** crypto.randomUUID needs a secure context, which a LAN address over plain
 *  http is not. Not worth failing a whole turn over an id. */
const newId = () =>
  globalThis.crypto?.randomUUID?.() ??
  `id${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`


export default function App() {
  const store = useStore
  const history = useRef<Msg[]>([])
  const speaker = useRef<ReturnType<typeof createSpeaker> | null>(null)
  const voice = useRef<Voice | null>(null)

  /**
   * Monotonic turn counter. Every await in a turn checks it on the way out:
   * if it has moved, that turn was superseded by a barge-in and must not touch
   * the phase, the speaker, or the busy state on its way to the floor.
   */
  const turn = useRef(0)
  const startingVoice = useRef(false)
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const voicePoll = useRef<ReturnType<typeof setInterval> | null>(null)

  // -- helpers --------------------------------------------------------------

  const clearIdle = () => {
    if (idleTimer.current) clearTimeout(idleTimer.current)
    idleTimer.current = null
  }

  const silence = () => {
    speaker.current?.cancel()
    speaker.current = null
  }

  const goDormant = () => {
    const phase = store.getState().phase
    if (phase === 'thinking' || phase === 'tooling' || phase === 'speaking') interrupt()
    clearIdle()
    silence()
    turn.current++
    const s = store.getState()
    s.setCaption('')
    s.setActiveTool(null)
    sfx.duck(false)
    s.setPhase('dormant')
    voice.current?.stop()
    voice.current = null
    releaseMic()
    s.setLevel(0)
  }

  /** Open the mic and wait. `window` is how long before he gives up. */
  const listen = (window: number) => {
    clearIdle()
    const s = store.getState()
    s.setCaption('')
    s.setPhase('listening')
    sfx.play('listen')
    idleTimer.current = setTimeout(goDormant, window)
  }

  // -- one turn -------------------------------------------------------------

  const respond = async (said: string): Promise<void> => {
    const mine = ++turn.current
    const turnStartedAt = performance.now()
    const stale = () => mine !== turn.current

    clearIdle()
    const s = store.getState()
    // Last turn's panels and blades go now, before the new answer starts
    // putting its own up. Anything the model marked sticky survives.
    s.clearPanels()
    s.clearBlades()
    s.setCaption('')
    s.pushTurn({ id: newId(), role: 'user', text: said })
    s.setPhase('thinking')

    const spk = createSpeaker({ literalTechnical: wantsLiteralTechnicalSpeech(said) })
    speaker.current = spk
    sfx.duck(true)

    const turnId = newId()
    let started = false
    let acknowledged = false
    let toolSeen = false
    const slowRequest = /\b(search|browse|research|check|inspect|find|open|read|analy[sz]e|compare|summari[sz]e|run|build|test|edit|change|create|write|fix|webpage|website|weather|latest|online)\b/i.test(said)
    const ackTimer = setTimeout(() => {
      if (!stale() && !started && !acknowledged && (toolSeen || slowRequest)) {
        acknowledged = true
        spk.say(toolSeen ? 'Checking that now.' : 'Give me a second.')
      }
    }, 550)

    try {
      await ask(said, history.current, {
        onText: (delta) => {
          if (stale()) return
          if (screen.diag.visionRequestAt >= turnStartedAt && !screen.diag.firstResponseMs) screen.diag.firstResponseMs = Math.round(performance.now() - screen.diag.visionRequestAt)
          spk.markModelDelta()
          clearTimeout(ackTimer)
          if (!started) {
            started = true
            store.getState().setPhase('speaking')
            // The answer arriving is what ends the tool phase — a timer would
            // clear the readout while a slow tool was still running.
            store.getState().setActiveTool(null)
            store.getState().pushTurn({ id: turnId, role: 'jarvis', text: '' })
          }
          store.getState().appendToLastTurn(delta)
          spk.push(delta)
        },
        onTool: (name) => {
          if (stale()) return
          // Only claim the tooling phase while he has nothing to say yet.
          // Setting it unconditionally pinned the machine in 'tooling' for the
          // rest of any answer that called a tool after it started talking,
          // which also broke the reactor's lip-sync for the remainder.
          if (!started) store.getState().setPhase('tooling')
          store.getState().setActiveTool(name)
          sfx.play('tool')
          // Tool activity makes a delayed local acknowledgement eligible.
          // The timer still skips it if real text starts first.
          toolSeen = true
        },
      })

      if (stale()) return

      if (screen.diag.visionRequestAt >= turnStartedAt) screen.diag.totalMs = Math.round(performance.now() - screen.diag.visionRequestAt)

      await spk.end()
      if (stale()) return
      sfx.play('done')
    } catch (err) {
      if (stale()) return
      console.error(err)
      sfx.play('error')
      store
        .getState()
        .setError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      clearTimeout(ackTimer)
      if (!stale()) {
        speaker.current = null
        sfx.duck(false)
        store.getState().setActiveTool(null)
        // Keep the manually opened microphone available briefly for follow-ups.
        listen(FOLLOW_UP_MS)
      }
    }
  }

  // -- voice events ---------------------------------------------------------

  /** What the voice loop should do with what it hears, derived from phase. */
  const mode = (): VoiceMode => {
    switch (store.getState().phase) {
      case 'dormant':
        return 'deaf'
      case 'listening':
        return 'command'
      default:
        return 'guard' // thinking, tooling, speaking
    }
  }

  /**
   * Someone started talking. This is the whole point of the rewrite: he stops,
   * immediately, whatever he was doing.
   */
  const onSpeechStart = () => {
    clearIdle()
    const phase = store.getState().phase
    if (phase === 'dormant') return

    const wasBusy =
      phase === 'thinking' || phase === 'tooling' || phase === 'speaking'

    silence()
    if (wasBusy) {
      // Abandon the answer in flight. The turn counter moves in respond()'s
      // replacement; bumping it here covers the case where nothing replaces it.
      turn.current++
      interrupt()
      store.getState().setActiveTool(null)
      sfx.duck(false)
    }
    store.getState().setPhase('listening')
  }

  const onUtterance = (text: string) => {
    const phase = store.getState().phase
    if (phase === 'dormant') return
    const said = text.trim()
    if (!said) {
      listen(AWAIT_SPEECH_MS)
      return
    }

    void respond(said)
  }

  const onPartial = (text: string) => {
    store.getState().setCaption(text)
  }

  const onVoiceError = (message: string) => {
    store.getState().setError(message)
  }

  const activateVoice = () => {
    const phase = store.getState().phase
    if (phase === 'thinking' || phase === 'tooling' || phase === 'speaking') onSpeechStart()
    listen(AWAIT_SPEECH_MS)
    if (voice.current || startingVoice.current) return
    startingVoice.current = true
    // Output unlock must begin in the click/key gesture. Input permission and
    // capability discovery can run together after that gesture.
    prewarmSpeech(true)
    void sfx.unlockAudio()
    void Promise.all([startAnalyser(), probeCapabilities()])
      .then(async () => {
        if (store.getState().phase === 'dormant') { releaseMic(); return }
        const next = await startVoice({ mode, onSpeechStart, onPartial, onUtterance, onError: onVoiceError })
        if (store.getState().phase === 'dormant') { next.stop(); releaseMic() }
        else voice.current = next
      })
      .catch((err) => {
        goDormant()
        store.getState().setError(err instanceof Error ? err.message : 'Microphone unavailable.')
      })
      .finally(() => { startingVoice.current = false })
  }

  // -- startup --------------------------------------------------------------

  const initialize = () => {
    const s = store.getState()

    watchServers((servers) => store.getState().setConnected(servers))
    watchPanels((panel) => store.getState().pushPanel(panel))
    watchBlades((blade) => store.getState().pushBlade(blade))

    /**
     * JARVIS asking to see something.
     *
     * Announced on screen for as long as it takes, with whatever he said he was
     * looking for. The camera's own light is on too, but a hardware light that
     * appears with no explanation is exactly the thing that makes people
     * distrust an assistant — so the interface says it before they have to ask.
     */
    watchCapture(async (req) => {
      if (req.source === 'screen') {
        screen.diag.visionRequestAt = performance.now()
        screen.diag.firstResponseMs = 0; screen.diag.totalMs = 0
        return screen.captureFrame()
      }
      const note =
        req.mode === 'watch'
          ? req.when === 'past'
            ? req.reason || 'reviewing the last few seconds'
            : `${req.reason || 'watching'} · ${req.seconds}s`
          : req.reason || 'taking a look'
      store.getState().setLooking(note)

      // The past is only available if something has been remembering it, and
      // that only happens while the camera is on screen. Answering plainly
      // beats opening the camera and recording the next few seconds instead,
      // which is a different question from the one that was asked.
      if (req.mode === 'watch' && req.when === 'past' && camera.bufferedSeconds() < 1) {
        store.getState().setLooking(null)
        return {
          error:
            'There is no recent footage — the camera has to be open on screen ' +
            'for me to remember what just happened. Ask me to open the camera, ' +
            'and I can watch from then on.',
        }
      }

      // Held for the whole capture. Without this the stream can be torn down by
      // whoever else was using it half way through a six-second watch.
      let held = false
      try {
        await camera.holdCamera()
        held = true
        if (req.mode === 'look') return camera.grabFrame()
        if (req.when === 'past') {
          const grid = camera.recentGrid(req.seconds, 9)
          return grid ?? { error: 'There is not enough recent footage to review.' }
        }
        return await camera.watchAhead(req.seconds, 9)
      } catch (err) {
        return {
          error:
            (err as DOMException)?.name === 'NotAllowedError'
              ? 'The camera is not permitted, so I cannot see anything.'
              : `The camera could not be read: ${(err as Error)?.message ?? err}`,
        }
      } finally {
        if (held) camera.releaseCamera()
        store.getState().setLooking(null)
      }
    })

    // The interface is JARVIS's to drive. These arrive out of band, pushed
    // mid-turn the way panels are, so a command can retint the reactor or put
    // something into orbit while he is still speaking the sentence about it.
    watchUi((op, args) => {
      const s = store.getState()
      const a = (args ?? {}) as Record<string, never>
      switch (op) {
        case 'patch':
          s.applyUi(args)
          break
        case 'orbit':
          if (a.action === 'add') s.addOrbit(args)
          else if (a.action === 'remove') s.removeOrbit(String(a.id))
          else s.clearOrbits()
          break
        case 'effect':
          s.fireEffect(a.kind)
          break
        case 'reset':
          s.resetUi()
          break
        case 'screen':
          s.clearScreen(a.what ?? 'all')
          break
        default:
          console.warn('[jarvis] unknown ui op:', op, args)
      }
    })
    const showTransient = (text: string) => {
      store.getState().setError(text)
      setTimeout(() => { if (store.getState().error === text) store.getState().setError(null) }, 7000)
    }
    let connectionLostAt = 0
    let connectionAffectedTurn = false
    watchConnection((state) => {
      if (state === 'lost') {
        store.getState().setBridgeReady(false)
        connectionLostAt = Date.now()
        connectionAffectedTurn = ['thinking', 'tooling', 'speaking'].includes(store.getState().phase)
        if (connectionAffectedTurn) showTransient('Bridge connection lost — reconnecting.')
      } else if (state === 'reconnected') {
        store.getState().setBridgeReady(true)
        if (connectionAffectedTurn || (connectionLostAt && Date.now() - connectionLostAt > 3000)) showTransient('Bridge reconnected, sir.')
        connectionLostAt = 0
        connectionAffectedTurn = false
      }
    })
    watchHealthNotice(showTransient)
    void warm().then(() => {
      s.setConnected(connectedLabels())
      s.setBridgeReady(isConnected())
    }).catch((err: Error) => s.setError(err.message))
    void probeCapabilities().then((available) => {
      store.getState().setVoice(currentVoiceName())
      if (TTS_ENGINE !== 'kokoro' || available.ttsEngine === 'fish') return
      void kokoro.load()
      voicePoll.current = setInterval(() => {
        const p = kokoro.loadProgress()
        if (kokoro.isReady() || kokoro.isUnavailable()) {
          store.getState().setReadinessNote('')
          store.getState().setVoice(currentVoiceName())
          if (voicePoll.current) clearInterval(voicePoll.current)
          voicePoll.current = null
        } else if (p > 0 && p < 1) {
          store.getState().setReadinessNote('VOICE WARMING ' + Math.round(p * 100) + '%')
        }
      }, 200)
    })
    s.setVoice(currentVoiceName())
  }

  useEffect(() => {
    prewarmSpeech()
    initialize()
    // Startup subscriptions are established once for this page lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // -- level pump + keys ----------------------------------------------------

  useEffect(() => {
    let raf = 0
    let lastLevel = -1
    let lastLevelAt = 0

    const pump = () => {
      const st = store.getState()
      // While speaking, follow JARVIS's own output rather than the mic, so the
      // orb lip-syncs instead of reacting to room noise.
      const lvl =
        st.phase === 'speaking' && speaker.current
          ? speaker.current.level()
          : micLevel()
      const now = performance.now()
      if (now - lastLevelAt >= 32 && (Math.abs(lvl - lastLevel) >= 0.015 || now - lastLevelAt >= 250)) {
        st.setLevel(lvl)
        lastLevel = lvl
        lastLevelAt = now
      }
      raf = requestAnimationFrame(pump)
    }
    pump()

    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return

      // V previews the next local voice. Hearing it on the actual speakers
      // is more useful than trusting a voice name or ranking.
      // Bare V only — ⌘V and ⌃V are paste, and swallowing those was rude.
      if (
        e.key === 'v' &&
        !e.repeat &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        e.preventDefault()
        const name = cycleVoice()
        store.getState().setVoice(name)
        silence()
        const demo = createSpeaker()
        speaker.current = demo
        demo.say(`Voice set to ${name.replace(/\(.*?\)/g, '').trim()}. At your service, sir.`)
        void demo.end()
        return
      }

      // G puts the camera on and starts tracking hands. Off by default and
      // never implicit: a webcam that turns itself on because an interface
      // thought it might be useful is not a trade anyone agreed to.
      if (e.key === 'g' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        const on = store.getState().gestures
        if (on) {
          hands.disableHands()
          store.getState().setGestures(false)
        } else {
          store.getState().setError(null)
          void hands
            .enableHands()
            .then(() => store.getState().setGestures(true))
            .catch((err: Error) => {
              store.getState().setGestures(false)
              store
                .getState()
                .setError(
                  err?.name === 'NotAllowedError'
                    ? 'Camera access denied — gesture control is unavailable.'
                    : `Gesture control failed to start: ${err?.message ?? err}`,
                )
            })
        }
        return
      }

      // T speaks a fixed line, bypassing the recogniser and the
      // model entirely. When "I can't hear him" is the report, this is the one
      // keypress that separates a broken voice engine from a broken voice loop
      // — and it prints the verdict rather than making you infer it.
      if (e.key === 't' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        silence()
        const t = createSpeaker()
        speaker.current = t
        t.say('Audio test. If you can hear this, speech output is working, sir.')
        void t.end().then(() => {
          const d = (window as unknown as Record<string, Record<string, unknown>>).__tts
          console.info('[jarvis] audio test →', d)
          if (d && d.started === 0) {
            store.getState().setError(
              `No sound produced. engine=${d.engine} voice=${d.voice} error=${d.lastError || 'none'}`,
            )
          }
        })
        return
      }

      // Escape stands the whole thing down — the one thing the old build had
      // no key for at all.
      if (e.key === 'Escape') {
        e.preventDefault()
        goDormant()
        return
      }

      // Space starts a manual voice turn.
      if (e.code !== 'Space' || e.repeat) return
      e.preventDefault()
      activateVoice()
    }
    window.addEventListener('keydown', onKey)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('keydown', onKey)
      clearIdle()
      if (voicePoll.current) clearInterval(voicePoll.current)
      voice.current?.stop()
      releaseMic()
      speaker.current?.cancel()
      // The camera must not outlive the page that turned it on.
      hands.disableHands()
      screen.stopSharing()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <>
      <Scene />
      <Hud onTalk={activateVoice} />
      <Diagnostics />
    </>
  )
}
