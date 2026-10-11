// Keep configuration separate from evidence: a registered tool is not a connected browser.
export const BROWSER_INSTRUCTIONS = `Browser control is provided by the jarvis MCP browser tool, independently of disabled built-in browser_use/computer_use features and the read-only Codex sandbox. Use the exposed jarvis browser tool for requested actions instead of declining because built-in controls are disabled. Its capabilities operation probes local Chrome/Brave automation without launching a browser. Installed, connected, authenticated, and playing are distinct states: never infer one from another. Use browser=brave when requested; youtube_music supports open, library, and play_library. Existing automation sessions retain their own sign-ins; an ordinary browser window is not accessible unless its local debugging endpoint is exposed. Never copy cookies or credentials. Inspect tool results; report denied, unavailable, sign-in-required, missing controls, navigation errors, and unconfirmed playback accurately. Do not claim success without verified results. If the MCP tool is absent, say that this Codex turn did not expose the jarvis browser tool, not that JARVIS has no browser controls. Local browser commands can still work. Security approvals remain mandatory.`

export function mcpBrowserEvidence(response) {
  const server = response?.data?.find(item => item.name === 'jarvis')
  if (!server) return 'JARVIS MCP discovery did not return the jarvis server; browser tool availability is unverified.'
  if (server.toolsError) return 'JARVIS MCP tool discovery failed; browser tool availability is unverified.'
  if (server.runtimeStatus && server.runtimeStatus !== 'connected') return `JARVIS MCP connection state: ${server.runtimeStatus}; browser tool availability is unverified.`
  const tools = Object.values(server.tools ?? {}).map(tool => tool?.name).filter(Boolean)
  return tools.includes('browser')
    ? `JARVIS MCP discovery verified these registered tools: ${tools.filter(name => ['browser','shell','filesystem','hud','vision'].includes(name)).join(', ')}. Browser connection and site access must still be checked by the browser tool.`
    : 'JARVIS MCP discovery returned no browser tool. Report this registration limitation if browser automation is needed.'
}
