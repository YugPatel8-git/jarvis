# Final latency and reliability pass

## Outcome

The existing architecture is retained. The main changes remove waits in speech fallback and prefetch, prevent stale work from affecting newer turns, reuse CDP connections, and release audio/process resources deterministically. No dependencies, models, paid services, wake-word behavior, or background vision/polling were added.

Branch: `gpt-codex-version`. Starting HEAD: `3310e6c` (Phase 7 is committed). The four uncommitted Windows hiding changes present at the start were preserved. This pass is uncommitted.

## Bottlenecks and fixes

### Speech start and phrase gaps

- A Fish failure could block the current phrase on Kokoro's initial model download. A cold Kokoro now warms in the background while system speech delivers that phrase; a ready Kokoro remains the first fallback.
- Fish prefetch previously waited for current audio to become available. It now starts while current synthesis is pending, bounded to one following phrase with Natural gap or two with Tight gap. Local synthesis still begins prefetch at playback.
- The 550 ms filler timer could enqueue speech ahead of useful content. It was removed. Tool state still appears immediately.
- A complete useful sentence before an unfinished code fence can now be spoken immediately. The unfinished code remains protected from speech.
- Fish requests retain the 20-second bound. One failed provider switches the rest of that speaker to fallback and aborts outstanding Fish work. Local generation has an 8-second bound; late audio is discarded and its URL released.
- Audio readiness is now recorded on `canplay`, rather than treating a newly created MediaSource URL as playable audio.

### Cancellation, playback and resource cleanup

- Creating a speaker cancels the prior speaker. App response replacement and error paths also cancel their speech explicitly.
- Current and prefetched audio URLs, reader operations, MediaSource listeners, audio element callbacks, animation frames, and Web Audio nodes are released. Pending encoded stream data is bounded to 8 MiB per prefetched stream.
- Native cancellation settles its playback promise even if the engine emits no cancellation event. Both native and audio-element playback remain bounded at 45 seconds.
- A swallowed native utterance retries once using a new utterance object, so the old cancellation event cannot complete the replacement.
- Old speaker cleanup cannot clear the current speaker's echo-tracking text.
- MediaSource append/error failures trigger fallback promptly instead of waiting for the playback watchdog.

### First visible text and frontend work

- The first text delta updates the transcript immediately. Later deltas are collected for at most 16 ms; speech processing still receives every delta immediately.
- The first 80 characters bypass the existing decode animation. The remainder keeps the visual effect.
- Failed reconnect attempts continue through the existing bounded backoff. Late socket opens/messages/closes cannot alter a newer connection, and warmup timeout timers are cleared when readiness arrives.
- Cancelled connection attempts only clear their own pending turn.

### Codex and context

- Optional model metadata loads concurrently with thread creation. It cannot hold first-turn readiness for a metadata timeout.
- Resuming a thread omits the extra bounded recent-history copy. Fresh threads still receive that continuity text (up to 6,000 characters). Persona, security instructions, model and reasoning selection remain intact.
- Cancellation during `turn/start` waits for that request's actual turn ID before sending the interrupt. Retired turn IDs are retained in a bounded set of 64.
- Notifications and process-exit callbacks from old processes/turns are ignored.
- A crash after turn submission rejects the active request without automatically replaying it through exec fallback. Replay could duplicate a tool action. Existing bounded process recovery remains available for subsequent requests; exec fallback remains available when warmup fails before submission.
- Windows process shutdown terminates the owned process tree and releases inherited pipes. The shutdown helper itself is bounded.

### Local paths, tools and browser

- Local commands still use zero Codex calls. Authorization and durable audit writes remain on the execution path; they were not bypassed for speed.
- A healthy tab operation uses `/json` directly, eliminating its redundant `/json/version` request.
- CDP uses up to eight shared target connections with a 30-second idle expiry and a 10-second command deadline. Concurrent replies are correlated by ID. Disconnects/timeouts reject pending calls immediately; uncertain actions are never replayed automatically.
- The existing authenticated MCP tool socket reuse and 30-second Chrome launch cooldown remain intact.
- Replacing the frontend closes the prior connection. A delayed close from that prior socket cannot cancel the new frontend's turn or pending requests.

### Screen and startup

- Screen capture reuses two canvases, created only on demand and cleared on stop. The 1600-pixel maximum, JPEG quality, unchanged-frame suppression and explicit user activation remain intact.
- Concurrent screen starts share one picker request. Stop invalidates a pending selection, and an old track's `ended` event cannot stop a newer sharing session.
- Existing lazy Kokoro and MediaPipe imports were retained. No new startup media or loading sequence was added. Repeated launcher measurements show no meaningful startup change.
- All project-owned background subprocess launch sites use `windowsHide: true`. Shell semantics are preserved. Windows-only tree cleanup leaves non-Windows signal behavior intact.
- HTTP streaming now flushes Fish headers and respects response backpressure. Response cleanup checks whether the response already ended or disconnected, and response errors cannot crash the bridge.

## Critical paths audited

| Request | Necessary blocking work | Changes / retained behavior |
|---|---|---|
| Manual mic | Permission/input setup, recognition/endpointing, then ordinary request path | Talk remains manual; concurrent activation shares startup; existing endpointing retained to avoid truncating speech |
| Text question | Warm bridge connection, Codex warmup if needed, turn submission | Persistent socket/process; useful deltas stream independently of speech; first text paints without decode delay |
| Local command | Classification, audit, command, completion audit | Zero model calls; no health probes or new sockets on a healthy connection |
| Reasoning request | Thread readiness, prior interrupt if any, `turn/start`, useful model events | Optional catalog removed from readiness path; low/high routing retained |
| Fish phrase | Phrase boundary, normalization, HTTP response, MP3 decode/playback | Bounded early prefetch; immediate cold-model fallback; no paid retry |
| Browser command | Target lookup, CDP command/reply | One healthy lookup; pooled CDP; bounded failure cleanup |
| Screen question | Model-requested vision tool, one fresh capture/encode, model response | On demand only; canvas reuse; unchanged frame suppression retained |

## Measurements

All values are milliseconds, shown as **median / p90**. No browser audio or visual paint measurement is implied by a bridge-text measurement.

### Live local transport and Fish

One warmup plus 10 measured trials per prompt/provider, using the existing benchmark and the same fixed Fish phrase.

| Metric | Before | After |
|---|---:|---:|
| Local `git status`: first bridge event | 0.39 / 0.49 | 0.28 / 0.44 |
| Local `git status`: first useful bridge text | 47.47 / 48.58 | 38.66 / 40.45 |
| Local `git status`: first stable speech text | 47.50 / 48.68 | 38.68 / 40.48 |
| Diagnostics: first useful bridge text | 0.24 / 0.36 | 0.22 / 0.25 |
| Fish response headers | Not recorded | 514.80 / 615.15 |
| Fish first byte | 446.89 / 624.62 | 514.93 / 615.30 |
| Fish complete audio download | 1634.75 / 2149.32 | 1474.68 / 1746.47 |

Git process timing and network timing vary. The local execution path itself was not substantially changed, so its lower sample must not be attributed to this pass. Fish's median first byte worsened while its p90 and completion improved; there is no demonstrated Fish network speedup.

An attempted alternating original/updated Fish comparison stopped at an HTTP 502 from the original handler. The original bridge also produced an unhandled `write after end` error, which led to the HTTP cleanup fix. No aggressive retries were used. A later updated-bridge smoke check returned HTTP 200 with 44,720 audio bytes and the bridge remained healthy; this single trial is not a performance comparison. The cause of the Fish median variation remains unproven.

### Repeated warm development startup

Five alternating trials of the saved pre-pass launcher/core and current code. Both use hidden Windows launches. Codex CLI was unavailable, so these measure development-server and HTTP readiness, with the core in fallback. HTTP readiness is sampled on the benchmark's 100 ms loop; it is not first browser paint.

| Metric | Before | After |
|---|---:|---:|
| Launcher spawn returns | 5 / 5 | 5 / 7 |
| Bridge listening | 132 / 152 | 133 / 140 |
| Vite ready | 234 / 242 | 235 / 242 |
| First page HTTP response | 269 / 277 | 271 / 273 |

The 1–2 ms median differences are small relative to timer/process variation and the readiness sampling interval. Startup is effectively unchanged in these trials; no startup speedup is claimed.

### Controlled comparisons (fixtures, not real audio or Chrome)

`scripts/benchmark-pipeline.mjs` compares saved pre-pass source with current source under identical simulated delays: 120 ms headers, 40 ms body, 60 ms playback, and 200 ms cold local synthesis. CDP uses a loopback fixture with 3 ms HTTP/handshake and 2 ms command delays. Windows timer granularity affects these values.

| Metric | Before | After |
|---|---:|---:|
| Buffered Fish: first playback event, 10 trials | 187.99 / 190.73 | 189.11 / 190.96 |
| Buffered Fish: phrase gap, 10 trials | 110.39 / 111.16 | 15.71 / 16.32 |
| Cold fallback: first playback event, 10 trials | 223.36 / 226.64 | 13.22 / 15.14 |
| Browser scroll command, 20 warm trials | 64.03 / 93.35 | 32.25 / 33.16 |

First buffered Fish playback is effectively unchanged; the useful improvements in this fixture are earlier fallback and synthesis overlap. Over 20 warm browser commands, HTTP requests fell from 40 to 20 and new WebSocket handshakes from 20 to zero. These demonstrate eliminated work under controlled conditions, not guaranteed real-world audible or browser speedups.

### Metrics unavailable

- Actual first spoken audio, first playable MP3, real phrase gaps, AudioContext/autoplay behavior, HUD paint/render profiles and microphone endpoint-to-audio latency: no browser was connected to the available UI automation surface.
- Live Codex first event/text, authenticated turn and live app-server readiness: `codex` was unavailable on this execution environment's PATH. Protocol/recovery paths were tested with a simulated app-server.
- Real Chrome tool latency and physical screen-analysis latency: no live Chrome/screen capture surface. CDP and screen lifecycle tests use fixtures.
- Tool socket reconnect median/p90: functional disconnect/reconnect tests pass, but no clean latency benchmark was collected.
- Baseline Fish headers were not instrumented. Full download completion is not first playable audio.

## Validation and security

- Existing baseline: 42 tests passed.
- Final automated suite: 60 passed, zero failed, including live bridge origin and bearer-auth checks. No skipped tests.
- Coverage includes Fish cancellation/timeout/decode/MediaSource failure, stale completion, replacement speakers, native cancel without events, native retry, bounded rapid phrase prefetch, 45-second playback watchdog, rapid Talk/ask calls, pending tool disconnect, active Codex crash, cancellation during submission, stale process/turn events, CDP disconnect/timeout/reconnect, screen start/stop/restart and stale track events, duplicate ask suppression, health/cache bounds, hidden Codex launch options and owned process cleanup.
- Production build passed. Existing large-chunk advisory remains; production main JS is about 1,417.81 kB before gzip and Kokoro is still a separate lazy chunk.
- Lint: zero errors, 13 existing warnings (React purity/refs/state rules and one unnecessary escape). No warnings were suppressed.
- Diff whitespace check passed. Git's existing LF/CRLF notices are unrelated to runtime behavior.
- Loopback binding, origin checks, bearer auth, router approval classification, sensitive-path handling, redaction and sandbox settings are retained. Fish is still hard-pinned to `s2.1-pro-free`; credentials remain bridge-only. `.env` is ignored and untracked.
- Some intermediate new test runs failed because mocks lacked browser cleanup methods or correct CommonJS default-import behavior; those fixtures were corrected. An early phrase test also caught leading whitespace after a removed code block, which was fixed. These failures were not suppressed.

## Files

### Modified

| File | Change |
|---|---|
| `bridge/browser.mjs` | Shared CDP requests, removes redundant healthy probe; retains prior Windows hiding fix |
| `bridge/codex-app-server.mjs` | Concurrent metadata, smaller resume context, turn/process ownership, safe interruption and recovery |
| `bridge/codex.mjs` | Ignores stale fallback output/timers; shared process-tree cleanup |
| `bridge/router.mjs` | Prior Explorer hiding fix retained; no new authorization changes |
| `bridge/server.mjs` | Fish backpressure/headers, HTTP error cleanup, frontend replacement ownership |
| `src/lib/tts.ts` | Prefetch, fast bounded fallback, cancellation, stream/playback and resource cleanup |
| `src/lib/speech-phrases.ts` | Releases useful text preceding incomplete code |
| `src/lib/bridge.ts` | Connection/turn ownership, bounded reconnect continuation, timer cleanup |
| `src/lib/screen.ts` | Canvas reuse, shared picker and generation checks |
| `src/App.tsx` | Speaker replacement/error cancellation, removes filler, batches later display chunks |
| `src/ui/Hud.tsx` | First useful text bypasses decode animation |
| `scripts/start.mjs` | Owned process cleanup; prior hidden-launch fix retained |
| `scripts/setup.mjs` | Prior hidden preflight fix retained |
| `scripts/benchmark-startup.mjs` | Optional baseline launcher, complete process/pipe cleanup |
| `scripts/benchmark-latency.mjs` | Fish headers measurement |
| `scripts/test-codex-recovery.mjs` | Active crash, submission cancellation, old process events and optional catalog |
| `scripts/test-screen.mjs` | Picker/stop/restart ownership and cache reset |
| `scripts/test-speech-phrases.mjs` | Safe early phrase before streamed code |
| `scripts/test-tool-client.mjs` | Disconnect during an active request |
| `scripts/test-tts.mjs` | Playback, fallback, cancellation and resource regression cases |

### Added

- `bridge/cdp.mjs`: bounded CDP connection pool.
- `bridge/process.mjs`: hidden, bounded Windows process-tree cleanup.
- `scripts/benchmark-pipeline.mjs`: controlled before/after fixtures.
- `scripts/test-cdp.mjs`: pooled CDP failure/reuse coverage.
- `scripts/test-frontend-races.mjs`: rapid Talk and connection/ask ownership tests.
- `scripts/test-http-cleanup.mjs`: ended-response and response-error regression test.
- `scripts/test-process.mjs`: actual owned subprocess/pipe cleanup test.
- `docs/optimization-pass.md`: this report.

Deleted files: none. Dependencies added/removed/changed: none. No speculative dead-code or asset removal was performed.

Local measurement snapshots and source baselines are under ignored `.jarvis/optimization-*.json`, `.jarvis/tts-before.ts` and `.jarvis/browser-before.mjs`. The controlled benchmark needs those source baselines; capture them before a future pass with `Copy-Item src/lib/tts.ts .jarvis/tts-before.ts` and `Copy-Item bridge/browser.mjs .jarvis/browser-before.mjs`. They are not production imports or committed assets.

## Reproduce checks and commit

With `npm start` running in another terminal:

```powershell
node --test scripts/test-*.mjs
npm run build
npm run lint
git diff --check
```

Expected final Git state: branch `gpt-codex-version`, 20 modified tracked files and 8 added files, all uncommitted. This includes the previous four Windows hiding edits. No unrelated changes were present when this pass began.

Manual commit commands for this reviewed tree:

```powershell
cd C:\Users\yugkp\Downloads\jarvis
git status --short
git add -A
git commit -m "Optimize Jarvis speech latency and harden async recovery"
```

No push was performed. This completes the requested optimization pass.
