# Voice endpoint timing

## Before this pass

- VAD: 110ms sustained onset, 650ms quiet before recording a segment ends,
  20-second maximum segment. Transcription then runs through the existing bridge.
- Browser fallback: 900ms since the most recent recognition result.
- Both paths then used another assembler hold: 0ms for explicit sentence
  punctuation, 250ms for ordinary text, or 1600ms for unfinished/short text.
  Active speech could also schedule a six-second forced flush.
- The 350ms playback echo guard, 14-second initial listening window, and
  11-second follow-up window are separate from endpointing.

## After this pass

The normal silence deadline is **900ms total**. Explicitly unfinished wording
gets **1000ms total**. Short commands such as Stop, Yes, and Open Chrome use
900ms, even without punctuation. There is no second post-endpoint hold.

VAD still captures after 650ms so transcription starts early. Energy edges from
the existing detector cancel/reset the deadline. Transcription time counts
toward it: a transcript arriving after the deadline submits immediately, unless
the user is speaking or another captured segment is still being transcribed.
Queued fragments remain ordered and form one utterance. The six-second forced
flush during active speech was removed.

Browser recognition uses speech-start/end callbacks when supplied, with
transcript activity as its fallback clock. Resumed speech clears the pending
timer before waiting for new words. Converting unchanged interim words to a final
result does not restart the deadline. Consumed recognition-result indices prevent
late final revisions from submitting a second turn, while new indices can still
submit repeated commands with identical wording. Stale recognizer instances and
callbacks after stop cannot submit.

The existing 110ms onset confirmation and echo/barge-in guards remain. No longer
minimum-duration filter was added, preserving brief commands. No new model call,
audio graph, signal analysis, polling interval, dependency, or rendering work was
added. Existing recovery and follow-up timers were retained. TTS, UI, backend,
personality, routing, screen sharing, and security sources were not edited.

## Validation and limits

Eighteen deterministic tests in `scripts/test-voice-endpoint.mjs` cover normal
900ms submission, 400ms hesitation, resumed speech, delayed finals, one-word
commands, repeated commands, barge-in, stop, stale recognizer callbacks,
transcription latency/queueing, and real VAD logic with simulated energy.
The existing TTS tests separately cover cancellation and stale audio prevention.
The browser smoke-test recognizer mock now follows cumulative session result
indices, matching the browser API.

The deadline is local policy, not a guarantee of measured microphone-to-request
latency. Browser recognition events can arrive late, and the VAD path still needs
the existing transcription response. No live microphone measurement was made.
Event semantics: [MDN speechend](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition/speechend_event).

```powershell
node --test scripts/test-*.mjs
npm.cmd run build
npm.cmd run lint
git diff --check
```

The full suite needs the local bridge running on port 8787 for three security
integration tests. Tests use mocked speech services; no paid speech/model call
is required.
