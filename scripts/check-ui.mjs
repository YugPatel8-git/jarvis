/** Browser smoke check against a running Vite server. Uses an isolated headless
 * Chrome profile and mocked speech/bridge APIs; never calls a model or Fish.
 * Run: node scripts/check-ui.mjs http://127.0.0.1:5195
 * Optional: CHROME_PATH to select a Chromium executable.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { WebSocket } from 'ws'

const base = process.argv[2] || 'http://127.0.0.1:5195'
const output = resolve('.jarvis/ui-check')
const profile = join(output, `chrome-${Date.now()}`)
await mkdir(profile, { recursive: true })
const chrome = spawn(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--autoplay-policy=no-user-gesture-required', 'about:blank',
], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
let chromeLog = ''
chrome.stderr.on('data', chunk => { chromeLog = (chromeLog + chunk).slice(-5000) })
const pause = ms => new Promise(r => setTimeout(r, ms))
let ws
try {
  let port
  for (let i = 0; i < 100; i++) {
    try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break } catch { await pause(100) }
  }
  assert.ok(port, 'Chrome debugging endpoint started')
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
  ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl)
  await new Promise((r, reject) => { ws.once('open', r); ws.once('error', reject) })
  let seq = 0
  const pending = new Map(), errors = [], network = []
  ws.on('close', () => { for (const call of pending.values()) call.reject(new Error('Chrome connection closed: ' + chromeLog)); pending.clear() })
  ws.on('message', raw => {
    const message = JSON.parse(raw)
    if (message.id) {
      const call = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) call?.reject(new Error(JSON.stringify(message.error)))
      else call?.resolve(message.result)
    }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text + ': ' + message.params.exceptionDetails.exception?.description)
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') errors.push(message.params.args.map(a => a.value || a.description).join(' '))
    if (message.method === 'Network.loadingFailed') network.push(message.params.errorText)
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Chrome timed out: ${method}. ${chromeLog}`)) }, 10000)
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value) }, reject: error => { clearTimeout(timer); reject(error) } })
    ws.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result.value
  }
  const until = async expression => {
    for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await pause(30) }
    throw new Error(`Timed out: ${expression}`)
  }
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable')
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__rafCalls = 0;
    const originalRAF = requestAnimationFrame;
    window.requestAnimationFrame = fn => { window.__rafCalls++; return originalRAF(fn); };
    window.__healthFish = true;
    const originalFetch = window.fetch;
    window.fetch = (url, options) => {
      if (String(url).endsWith('/health')) return Promise.resolve(new Response(JSON.stringify({ stt: false, tts: window.__healthFish, ttsEngine: window.__healthFish ? 'fish' : null }), { status: 200 }));
      if (String(url).startsWith('http') && !String(url).startsWith(location.origin)) throw new Error('Unexpected external request in UI test');
      return originalFetch(url, options);
    };
    const RealSocket = window.WebSocket;
    class BridgeSocket extends EventTarget {
      static OPEN = 1; readyState = 0;
      constructor(url, protocols) {
        super();
        if (protocols === 'vite-hmr') return new RealSocket(url, protocols);
        window.__bridge = this;
        setTimeout(() => { this.readyState = 1; this.onopen?.(); this.emit({ type: 'ready', servers: ['Browser', 'Filesystem'] }); }, 0);
      }
      emit(value) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
      send(raw) { const value = JSON.parse(raw); if (value.type === 'ask') window.__lastAsk = value; }
      close() { this.readyState = 3; this.onclose?.(); }
    }
    window.WebSocket = BridgeSocket;
    Object.defineProperty(window, 'speechSynthesis', { value: {
      getVoices: () => [{ name: 'British test voice', lang: 'en-GB' }], addEventListener() {}, resume() {}, pause() {},
      speak(u) { window.__utterance = u; queueMicrotask(() => u.onstart?.()); },
      cancel() { const u = window.__utterance; window.__utterance = null; u?.onerror?.({ error: 'canceled' }); }
    } });
    window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
    window.SpeechRecognition = class {
      constructor() { window.__recognizer = this; }
      results = [];
      start() { queueMicrotask(() => this.onstart?.()); }
      abort() { this.onend?.(); }
      result(text) { const result = [{ transcript: text }]; result.isFinal = true; const resultIndex = this.results.length; this.results.push(result); this.onresult({ resultIndex, results: this.results }); }
    };
    navigator.mediaDevices.getUserMedia = async () => {
      window.__inputContext = new AudioContext();
      return window.__inputContext.createMediaStreamDestination().stream;
    };
    window.__pickerCalls = 0;
    navigator.mediaDevices.getDisplayMedia = async () => {
      window.__pickerCalls++;
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
      canvas.getContext('2d').fillRect(0, 0, 320, 180);
      return canvas.captureStream(0);
    };
  ` })
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: base })
  await until(`!!document.querySelector('.jarvis-core') && window.__jarvis?.bridgeReady`)
  await pause(300)
  const initialFrames = await evaluate('window.__rafCalls')
  await pause(500)
  assert.equal(await evaluate('window.__rafCalls'), initialFrames, 'idle has no rendering loop')
  assert.equal(await evaluate(`document.querySelectorAll('canvas').length`), 0)
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.core-energy')).animationName`), 'none')
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.core-schematic')).pointerEvents`), 'none')
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.core-rings')).pointerEvents`), 'none')
  const idle = await send('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(output, 'idle.png'), Buffer.from(idle.data, 'base64'))

  for (const phase of ['listening', 'thinking', 'tooling']) {
    await evaluate(`window.__jarvis.setPhase('${phase}')`)
    await until(`document.querySelector('.indicator').dataset.state === '${phase}'`)
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('.core-energy')).animationName`), 'core-breathe')
    assert.equal(await evaluate(`document.getAnimations().length`), 1, 'only one glow layer animates')
  }
  await evaluate(`window.__jarvis.setPhase('speaking')`)
  await until(`document.querySelector('.indicator').dataset.state === 'dormant'`)
  assert.equal(await evaluate(`document.querySelector('.indicator').dataset.preparing`), 'true')
  assert.equal(await evaluate(`document.getAnimations().length`), 0, 'preparing speech is static')
  await evaluate(`window.__healthFish = false; (await import('/src/lib/capabilities.ts')).probeCapabilities()`)
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 't' }))`)
  await until(`document.querySelector('.indicator').dataset.state === 'speaking'`)
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.core-energy')).animationName`), 'core-breathe')
  assert.equal(await evaluate(`document.getAnimations().length`), 1)
  await evaluate(`window.__utterance.onend()`)
  await until(`document.querySelector('.indicator').dataset.state === 'dormant'`)
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 't' }))`)
  await until(`document.querySelector('.indicator').dataset.state === 'speaking'`)
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`)
  await until(`document.querySelector('.indicator').dataset.state === 'dormant' && window.__jarvis.phase === 'dormant'`)
  assert.equal(await evaluate(`document.getAnimations().length`), 0, 'cancel removes glow animation')

  // Exercise the actual Talk, voice-event and App cancellation path.
  await evaluate(`document.querySelector('.talk-button').click()`)
  await until(`!!window.__recognizer && window.__jarvis.phase === 'listening'`)
  await evaluate(`window.__recognizer.result('Please explain the current project.')`)
  await until(`!!window.__lastAsk && window.__jarvis.phase === 'thinking'`)
  await evaluate(`window.__bridge.emit({ type: 'text', ask: window.__lastAsk.id, delta: 'The project is ready, sir. ' })`)
  await until(`document.querySelector('.indicator').dataset.state === 'speaking'`)
  await evaluate(`window.__recognizer.result('stop')`)
  await until(`window.__jarvis.phase === 'listening' && document.querySelector('.indicator').dataset.state === 'listening'`)
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); window.__inputContext?.close()`)
  await until(`window.__jarvis.phase === 'dormant'`)
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space' }))`)
  await until(`!!window.__recognizer && window.__jarvis.phase === 'listening'`)
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); window.__inputContext?.close()`)
  await until(`window.__jarvis.phase === 'dormant'`)

  // A coordinate click confirms the screen control is not covered by an overlay.
  const screenButton = await evaluate(`(() => { const r = document.querySelector('.screen-button').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...screenButton })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...screenButton })
  await until(`document.querySelector('.screen-button').getAttribute('aria-pressed') === 'true'`)
  assert.equal(await evaluate('window.__pickerCalls'), 1)
  await evaluate(`document.querySelector('.screen-button').click()`)
  await until(`document.querySelector('.screen-button').getAttribute('aria-pressed') === 'false'`)
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd' }))`)
  await until(`!!document.querySelector('.diag')`)
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd' }))`)

  await evaluate(`window.__jarvis.setError('The connection needs attention.')`)
  await until(`document.querySelector('.indicator').dataset.state === 'error'`)
  await evaluate(`window.__jarvis.setError(null)`)
  await evaluate(`window.__jarvis.pushTurn({ id: 'readability', role: 'jarvis', text: 'The speech pipeline remains unchanged.\n\n' + 'Technical detail: phrase prefetch, cancellation, and recovery remain available.\n'.repeat(55) + '\nEND OF TECHNICAL RESPONSE' })`)
  await pause(100)
  assert.equal(await evaluate(`document.querySelector('.log').scrollHeight > document.querySelector('.log').clientHeight`), true)
  assert.equal(await evaluate(`document.querySelector('.log').textContent.includes('END OF TECHNICAL RESPONSE')`), true)
  await evaluate(`document.querySelector('.log').scrollTop = 0; document.querySelector('.log').dispatchEvent(new Event('scroll')); window.__jarvis.appendToLastTurn(' Extra detail.')`)
  await pause(100)
  assert.equal(await evaluate(`document.querySelector('.log').scrollTop`), 0, 'streaming does not pull the reader away from earlier text')

  const sizes = [[1366, 768], [1920, 1080], [2560, 1440], [390, 844]]
  for (const [width, height] of sizes) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
    await pause(80)
    const layout = await evaluate(`(() => { const log = document.querySelector('.log'); const footer = document.querySelector('.hud-bottom').getBoundingClientRect(); const ring = document.querySelector('.jarvis-core').getBoundingClientRect(); return { width: document.documentElement.scrollWidth, viewport: innerWidth, logWidth: log.clientWidth, logHeight: log.clientHeight, footerBottom: footer.bottom, viewportHeight: innerHeight, ringTop: ring.top, ringWidth: ring.width, controlsUncovered: [...document.querySelectorAll('.controls button')].every(button => { const r = button.getBoundingClientRect(); return button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }) }; })()`)
    assert.ok(layout.width <= layout.viewport, `${width}: no horizontal overflow`)
    assert.ok(layout.logHeight > 100 && layout.logWidth <= 910, `${width}: readable transcript`)
    assert.ok(layout.footerBottom <= layout.viewportHeight + 1 && layout.ringTop > 0, `${width}: ring and controls visible`)
    assert.ok(layout.ringWidth >= 140 && layout.ringWidth <= 260, `${width}: responsive core size`)
    assert.ok(layout.controlsUncovered, `${width}: controls accept pointer input`)
    const screenshot = await send('Page.captureScreenshot', { format: 'png' })
    await writeFile(join(output, `${width}x${height}.png`), Buffer.from(screenshot.data, 'base64'))
  }
  await evaluate(`window.__jarvis.setPhase('listening')`)
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await pause(60)
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.core-energy')).animationName`), 'none')
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 't' }))`)
  await until(`document.querySelector('.indicator').dataset.state === 'speaking'`)
  assert.equal(await evaluate(`document.getAnimations().length`), 0, 'reduced motion disables speaking pulse')
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.core-energy')).opacity`), '1', 'reduced motion retains speaking brightness')
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`)
  await pause(100)
  const finalFrames = await evaluate('window.__rafCalls')
  await pause(400)
  assert.equal(await evaluate('window.__rafCalls'), finalFrames, 'stopping leaves no visual frame loop')
  assert.deepEqual(errors, [], 'no browser console errors')
  assert.deepEqual(network, [], 'no failed browser requests')
  console.log('PASS: idle, listening, thinking, tooling, actual playback events, end/cancel, Talk, barge-in, Escape, screen click/start/stop, diagnostics, errors, long transcript, 4 viewports, reduced motion, no idle frame loop, no console/network errors.')
  console.log(`Screenshots: ${output}`)
} finally {
  ws?.close()
  chrome.kill()
}
