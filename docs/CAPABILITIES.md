# JARVIS local capabilities

Codex runs in its read-only sandbox and receives only the project-local
`jarvis` MCP server. That server forwards tool calls over an authenticated
loopback channel to `bridge/router.mjs`; the random bearer token exists only
in the bridge process and its Codex/MCP children.

The router has exactly two classifications:

- **normal** — executed immediately, then audited.
- **high-risk** — paused immediately before execution until the browser shows
  the action, target, reason, consequence, and “Do you want me to proceed?”

High-risk rules cover protected credential paths; deletion and destructive
overwrites; destructive Git; elevation; registry, services, scheduled tasks,
firewall, antivirus, and startup changes; global/system software changes;
sensitive form entry; consequential web controls such as purchase, publish,
send, transfer, subscription, and account deletion; and outbound write-style
requests detected in shell commands. Approval is single-use.

Audit records go to `logs/tool-audit.jsonl`. Values matching password, secret,
token, key, cookie, card, seed, and recovery fields are redacted. The log is
git-ignored.

Chrome automation uses a dedicated profile under `.jarvis/chrome-profile`
and a loopback-only DevTools port. It does not attach to the user's normal
Chrome profile or reuse its cookies. Camera frames are requested from the
already-connected frontend only for explicit vision tool calls and are not
written to disk.

`config/integrations.json` is the explicit integration allowlist. It is empty
by default. External MCP passthrough remains disabled because a direct
third-party MCP connection would bypass this router; integrations need a
mediated adapter before they can be enabled.

## Daily-use efficiency

Deterministic requests such as opening Chrome, YouTube, Downloads or VS Code;
Google and YouTube searches; basic tab/scroll controls; known development
commands; and folder creation are matched locally. They still use the permission
router and audit log, but make zero Codex calls. Reasoning, summarization,
generation, ambiguous requests, and page understanding continue through Codex.

At startup the bridge prewarms one persistent `codex app-server` stdio process,
validates the saved ChatGPT login through the normal Codex runtime, and prepares
the active thread without making a model call. Turns reuse that process and
thread, stream `item/agentMessage/delta` notifications directly to the HUD and
sentence-buffered TTS, and cancel with `turn/interrupt`. If app-server exits,
the bridge restarts and resumes its thread; the prior `codex exec` path remains
as a last-resort fallback.

Threads rotate after 24 model turns or roughly 40,000 characters. A rotation
carries only six bounded recent exchanges; static JARVIS instructions are set
once per thread and the full browser transcript is never resent. Ordinary
conversation uses the active model's `low` reasoning effort; complex coding,
debugging, architecture, security, and planning prompts use `high`. Browser
reads strip executable and layout
content, deduplicate visible lines, and cap model-bound text at 18,000
characters. Shell output removes ANSI/progress noise and remains capped at 64
KiB.

The remaining npm audit finding is a high-severity advisory in the transitive
`sharp/libvips` path used by optional Kokoro speech. npm reports no available
fix. The project intentionally does not approve blocked lifecycle scripts or
force a risky upgrade merely to suppress this advisory.
