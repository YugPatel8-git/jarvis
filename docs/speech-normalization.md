# Conservative speech interpretation

Browser SpeechRecognition still assembles indexed interim/final chunks at
900/1000 ms. VAD + Scribe v1 still transcribes ordered audio segments. Neither
engine is replaced. Before this feature, input only received whitespace cleanup;
the local router matched exact command strings and had no correction layer.

Both engines now supply exact accepted STT chunks alongside the assembled text.
These travel through App, brain and the bridge client as optional `speech`
metadata. User turns retain the chunks in memory as `rawSpeech`; visible text is
still the original assembled transcript. This is not a persistent transcript log.
Interim revisions still replace their own result index, as before.

The bridge validates that the raw chunks assemble to the request text, then runs
`normalizeSpeech` before routing. Its result retains `rawTranscript`, `rawChunks`,
`normalizedTranscript`, confidence, reason and any suggestion/clarification.
Typed requests are not corrected. No network operation or model call is involved
in normalization, and there are no dependencies, scans, or background timers.

## Rules

- High: exact whole-entity aliases in a narrow command/question grammar, such as
  `visual studio cold`, `git statues`, and `open down loads`. `open crow` also
  requires recent Chrome context without competing YouTube context. Screen
  sheriff requires recent screen-sharing context or the existing sharing flag.
- Medium: contextual candidates without supporting context, or a unique app
  candidate within one edit. Actions receive a local clarification. Explanatory
  questions retain raw text and pass an explicitly uncertain suggestion in the
  existing main request, with instructions not to act on the guess.
- Low: no reliable candidate, conflicting wording, protected content, or input
  outside the bounded grammar. No correction. Explicit uncertainty in protected
  instructions receives a local clarification before routing.

Public terms live in `shared/speech-vocabulary.mjs`. App names are shared with
the existing fast-path matcher; route implementations and approval checks are
unchanged. Context is at most four user/assistant entries containing only known
vocabulary tags. Sensitive or negated context contributes no tags. Existing
screen-sharing state is read without a new capture or tool call.

Credentials, amounts/numbers, URLs, paths/filenames, destructive operations,
security instructions and financial instructions are excluded. Arbitrary names,
search queries and dictation are not fuzzily rewritten. Credential-like speech
is redacted from existing voice diagnostic text fields. The normalizer does not
log transcripts or expose its records through diagnostics. Raw chunks remain
available in the existing in-memory conversation, including sensitive input;
they are not added to correction logs or phrase hints.

High-confidence interpretations feed the normal local matcher/router. A changed
non-local request includes JSON-quoted Raw speech and Interpreted speech in the
same Codex request. Unchanged text gets no correction annotation. No extra
correction model call is made.

## STT hints and verification

Browser language stays `en-GB`. Public phrase hints use a modest boost only when
the experimental API exists; setter failures are ignored, and an engine's
`phrases-not-supported` error disables hints for the session. No language pack
is installed and no recognition engine is switched. See [MDN phrase hints](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition/phrases).

Scribe v1 receives `language_code=en`, matching the English voice interface.
No paid keyterm prompting, transcript editing, punctuation rewriting, or model
upgrade is enabled. See [ElevenLabs transcription options](https://elevenlabs.io/docs/api-reference/speech-to-text/convert).

`scripts/test-speech-normalization.mjs` tests aliases, exclusions, context expiry,
raw preservation, shared routes, phrase hints, same-request model handling,
clarification, and measured local matching overhead. Voice tests retain the
endpoint/restart/late-result regressions and check raw chunks and redaction.
Measurements use deterministic text and mocks; no live microphone accuracy
improvement has been measured.
