# JARVIS monochrome core refinement

## Current implementation

The small ring is now a responsive SVG/DOM core with thin concentric circles,
a segmented outer track, two arcs of radial ticks, a brighter inner ring,
a dark radial-gradient center, a JARVIS wordmark, and a faint static halo.
A separate static SVG carries low-opacity angled traces, rectangular terminals,
small nodes, and technical ticks. No reference image is used as a background.
The supplied blob URL was inaccessible; the implementation follows the written
reference description.

Only these files were changed during this refinement:

- `src/ui/JarvisIndicator.tsx`
- `src/index.css`
- `scripts/test-ui.mjs`
- `scripts/check-ui.mjs`
- `docs/ui-redesign.md`

The core is 180–260px on desktop, 140–184px on short laptop screens, and
140–180px on narrow screens. Traces clip inside the decorative scene on narrow
windows. Below 600px viewport height the workspace can scroll while the controls
remain in their separate footer. The empty-state heading is smaller to keep the
core dominant. Existing transcript scrolling, selection, and control handlers
are preserved.

## State and animation budget

- Idle: static rings, dark center, faint halo.
- Preparing speech: static, slightly brighter; no speaking pulse.
- Listening: one 4.8-second glow pulse.
- Thinking/tooling: one 6-second glow breath.
- Actual playback: one 2.4-second glow pulse and brighter inner ring/wordmark.
- End/cancel: speaking styles clear without an exit transition.
- Error: dashed inner ring in gray.

There is **one CSS keyframe definition and at most one animated element**.
Only opacity and transform animate; shadows are static. Rings and traces do not
rotate or animate. Reduced motion disables movement while retaining state
brightness and accessible labels. The entire decorative scene and its descendants
have `pointer-events: none` and are hidden from assistive technology. Existing
footer z-index 70 and diagnostics z-index 100 are preserved.

The existing `useSyncExternalStore` playback subscription is unchanged.
`data-preparing` distinguishes queued speech visually without changing the phase
mapping. Native `onstart` / audio `onplaying` still supply the playback boolean;
end, buffering, errors, and cancellation clear it. Speech never waits for a
visual update. No changes were made to `tts.ts`, `App.tsx`, `store.ts`, backend
routing, startup, security, recovery, or personality during this refinement.

## Verification for this refinement

- All **65 tests pass**, including existing UI, TTS, Fish, cancellation, screen,
  routing, recovery, and security tests. The three bridge integration tests needed
  a temporary local bridge on port 8787; the initial run without it failed with
  connection refused, then the full suite passed with the bridge running.
- Production TypeScript/Vite build passes. Entry JS: 304.54 kB / 101.99 kB gzip;
  CSS: 12.88 kB / 3.93 kB gzip. Compared with the pre-pass build artifacts,
  uncompressed entry JS increased approximately 2 kB and CSS 1.8 kB.
- No dependency, model request, audio processing, timer, or JavaScript frame loop
  was added to the application. Real end-to-end latency was not measured.
- Lint passes with the existing `bridge/security.mjs:14` unnecessary-escape
  warning. The build retains its existing optional Kokoro chunk-size warning.
- `git diff --check` passes.
- The browser smoke check now covers the new geometry, preparation state,
  animation count, pointer hit-testing, Space, and reduced-motion speaking glow.
  It **could not execute its UI checks**: headless Chrome exited with a GPU
  process access failure. No connected browser surface was available.
- Consequently live layout, MIC/audio hardware, Space/Escape interaction,
  diagnostics, screen-picker interaction, reduced motion, and click hit-testing
  are not claimed as browser-verified. Existing mocked tests and source review
  cover their preserved wiring, including transcript, Talk/Stop, screen sharing,
  asynchronous playback, buffering, and cancellation.
- SHA-256 checks confirmed `src/lib/tts.ts`, `src/App.tsx`, `src/store.ts`, and the
  three pre-existing modified bridge files are byte-for-byte unchanged.
- Nothing was staged or committed. `.env` remains ignored and untracked.

The targeted staging command at the end of this document covers the **complete
pending UI redesign**, including its earlier uncommitted prerequisites. It excludes
the three unrelated bridge personality/wording changes. Staging only the new core
would omit the earlier HUD mount and playback subscription on which it depends.

---

## Previous minimal-interface pass (historical record)

## Result

The interface uses a near-black background, system typography, off-white text,
muted labels, one thin circular indicator, a scrollable transcript, and fixed
controls. The transcript renders every turn retained by the existing store
(up to 41), preserving line breaks and long technical responses. It follows new
text only when the reader is already near the bottom.

The layout uses an 820px transcript column, with adjustments for short laptop
screens, narrow windows, and wide displays. Talk, Space, Escape, screen sharing,
voice selection, diagnostics, and optional gesture controls remain available.

## Removed rendering

The old `src/scene/Scene.tsx` mounted a Three.js canvas, shader-based core,
4,000 particles, orbiting images, camera drift, bloom, noise, chromatic aberration,
and vignette. All four scene source files were removed.

Also removed: decorative effects, blade sweeps, transcript decoding, the canvas
hand overlay, the always-running App level pump, and TTS visual frame loops.
Requested images now appear in a static shelf. Hand aiming uses two small DOM
cursors only while gesture control is explicitly enabled. Functional gesture
tracking/scrolling/resizing and diagnostics polling remain opt-in.

Removed direct dependencies: `three`, `@types/three`, `@react-three/fiber`,
`@react-three/postprocessing`, and `framer-motion`. npm removed 26 packages.
Removed unused assets: `src/assets/vite.svg` and `public/favicon.svg`.
The document now has a small embedded monochrome favicon.

## Ring states

| State | Appearance |
| --- | --- |
| Idle | Static thin gray-white ring with a faint fixed glow |
| Listening | Brighter ring with a slow 3.6-second CSS breath |
| Thinking / tools | Restrained 4.8-second CSS breath |
| Audible speech | Bright white ring with a gentle CSS glow pulse |
| End / buffering / cancellation | Speaking glow clears without an exit transition |
| Error | Static dashed gray ring and the existing error message |

Reduced-motion preferences disable all pulsing while retaining state labels and
brightness changes. Barge-in follows the existing transition into listening.

## Playback connection and preservation

`JarvisIndicator` observes a boolean exposed by `tts.ts`. Native `onstart` and
audio-element `onplaying` activate it. Completion, errors, buffering, and
cancellation clear it. Queued text does not activate the speaking glow.

Notification is deferred to a microtask and never awaited. Subscriber exceptions
are contained. The queue, phrase prefetch, Fish routing/reference/voice, fallback,
output processing graph, recovery, and cancellation logic are unchanged.
The existing amplitude reader remains available on demand; its frame loop is
gone. No model call, dependency, audio graph, or per-frame React update was added.

Startup, personality, Codex routing, local commands, capture, approval/security,
and diagnostics implementation were preserved. The three pre-existing bridge
file edits were not modified by this task.

## Validation

- Production TypeScript/Vite build passes. Entry JS is approximately 302.6 kB
  (101.1 kB gzip); CSS approximately 11.1 kB (3.5 kB gzip).
- The existing large optional Kokoro chunk still produces Vite's size warning.
- Lint passes with one existing `no-useless-escape` warning in
  `bridge/security.mjs:14`.
- All 65 tests pass, including speech, screen, routing, recovery, process,
  security, playback, and two UI render tests. A bridge was running for the three
  tests requiring port 8787. The UI tests cover ring state mapping, full technical
  text, controls, and direct screen-picker activation.
- `git diff --check` passes.
- Source review confirms no decorative canvas/WebGL rendering or always-running
  UI frame loop remains. Live microphone/gesture processing is still functional
  processing, outside the idle UI.

### Browser verification limit

The headless Chrome process failed in the restricted runtime (GPU process access
failure; renderer/CDP connection failed). No browser connector was available, and
the native computer-use pipe was unavailable. Live layout, click hit-testing,
browser console cleanliness, real audio output, and measured end-to-end latency
are therefore **not verified**. No screenshots or browser success are claimed.

`scripts/check-ui.mjs` contains a browser smoke check for a normal local runtime.
It uses a separate headless profile, mocked bridge/voice APIs, and no model/Fish
calls. It covers four viewports, playback/cancel/barge-in, screen clicks,
diagnostics, long transcripts, reduced motion, and idle frame activity. The
browser test itself could not complete in this environment.

## Commands

```powershell
npm.cmd run build
npm.cmd run lint
# Start the bridge in another terminal for test-bridge-security.mjs:
npm.cmd run bridge
# Then run the full regression suite:
node --test scripts/test-*.mjs
# Start Vite in another terminal, then run the browser smoke check:
npm.cmd run dev -- --host 127.0.0.1 --port 5195 --strictPort
node scripts/check-ui.mjs http://127.0.0.1:5195
```

Stage only the redesign (excluding the pre-existing bridge edits):

```powershell
git add -- index.html package.json package-lock.json src public/favicon.svg scripts/test-tts.mjs scripts/test-ui.mjs scripts/check-ui.mjs docs/ui-redesign.md
git diff --cached --stat
git commit -m "Replace animated Jarvis UI with minimal monochrome interface"
```

No commit or push was performed. `.env` remains ignored and untracked.
