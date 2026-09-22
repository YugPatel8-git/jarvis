# JARVIS — Codex edition

An Iron Man-inspired browser voice assistant with a React/Three.js interface and
a local WebSocket bridge powered by OpenAI Codex CLI.

## Authentication

JARVIS reuses the existing `codex login` ChatGPT session. It does not accept,
read, store, or expose `OPENAI_API_KEY`, and it does not use direct API billing.
No Codex authentication data is sent to browser JavaScript.

## Requirements

- Windows 11
- Node.js 20 or newer
- Codex CLI installed and signed in with ChatGPT (`codex login`)
- Chrome or Edge for microphone and speech-recognition support

Dependencies are intentionally not installed during Phase 3.

## Architecture

```text
Browser UI → ws://127.0.0.1:8787 → local bridge → Codex CLI → ChatGPT account
```

The bridge invokes `codex exec --json`, uses the CLI's saved authentication,
captures JSONL events, and resumes the returned session ID for later turns.
Each invocation forces a read-only sandbox, never requests approval, and ignores
user Codex configuration and execution-policy rules so unrelated MCP servers,
plugins, and automation are not silently inherited.

## Security defaults

- Bridge binds only to `127.0.0.1`.
- WebSocket and HTTP requests require an allowlisted localhost browser origin.
- Missing-origin clients are rejected.
- Input and WebSocket payload sizes are capped.
- Codex runs read-only with approval policy `never`.
- User Codex config, project rules, MCP integrations, browser automation, shell
  writes, and filesystem writes are disabled for JARVIS conversations.
- The previous remote-page, media-proxy, and local-file HTTP endpoints were
  removed, eliminating their SSRF and path-disclosure attack surfaces.

## Preserved experience

The boot sequence, HUD, wake word, microphone flow, browser speech recognition,
system/Kokoro text-to-speech, gesture controls, camera blade, effects, diagnostics,
WebSocket conversation transport, and barge-in UI remain in the frontend.

### Local wake word

After initialization, wake listening uses the browser's on-device English speech
recognition (`processLocally: true`). It only activates when that API reports an
installed local language pack. The HUD offers an explicit **Install local speech**
button when the browser can download the pack. If on-device recognition is not
available, wake listening stays off; press **Space** for a command. The app does
not use cloud browser transcription or the bridge STT service to watch for the
wake phrase.

The wake phrase is **Hey Jarvis** (including “Hey, Jarvis”). The wake and a
following command stay in the same recognition session, so “Hey Jarvis, open
Chrome” can be one utterance. The Wake word and Microphone controls are visible
in the HUD. Microphone mute stops the capture stream; wake preference persists
in this browser.

The JARVIS tab must remain open, with microphone permission granted. Background
tabs or minimized Chrome may throttle browser recognition, and a closed browser
cannot wake this web app. Speaker echo cancellation and text echo filtering
reduce self-wakes, but a video or another person audibly saying “Hey Jarvis”
cannot be reliably distinguished from the user by a browser microphone.

Phase 3 temporarily disables model-driven panels/blades, camera-to-model vision,
legacy browser control, global MCP tools, and ElevenLabs bridge speech.
These can be reintroduced later as explicit, least-privilege Codex capabilities.

## Configuration

See `.env.example`. `JARVIS_CODEX_MODEL` is optional; when unset, Codex uses its
normal authenticated default. `JARVIS_TURN_TIMEOUT_MS` defaults to two minutes.

## License

MIT. See `LICENSE`.
