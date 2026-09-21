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
