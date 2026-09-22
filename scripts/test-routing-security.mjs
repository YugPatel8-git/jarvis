import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchFastPath } from '../bridge/fast-path.mjs'
import { isComplex } from '../bridge/codex-app-server.mjs'
import { classify, HIGH_RISK, NORMAL, redact, sensitivePath } from '../bridge/security.mjs'
import { createRouter } from '../bridge/router.mjs'

test('requested deterministic commands route without a model turn', () => {
  const commands = [
    'open Chrome', 'close Chrome', 'open YouTube', 'open VS Code', 'open Downloads',
    'search Google for weather', 'search YouTube for jazz', 'open URL https://example.com',
    'tab next', 'tab previous', 'tab close', 'scroll down', 'scroll up',
    'mkdir bench-folder', 'node version', 'npm version', 'git status',
    'npm run build', 'npm run lint',
  ]
  for (const command of commands) assert.ok(matchFastPath(command), command)
  assert.equal(matchFastPath('What is the capital of Japan?'), null)
})

test('simple questions stay low effort and coding work qualifies for high effort', () => {
  for (const prompt of ['What is the capital of Japan?', 'What is recursion?', 'Explain polymorphism in one sentence.']) assert.equal(isComplex(prompt), false, prompt)
  for (const prompt of ['Debug this race condition', 'Write a Python function that retries a request', 'Review the security architecture']) assert.equal(isComplex(prompt), true, prompt)
})

test('sensitive and destructive operations still require approval', () => {
  assert.equal(classify('filesystem', { operation: 'read', path: 'C:\\Users\\x\\.codex\\auth.json' }).classification, HIGH_RISK)
  assert.equal(classify('filesystem', { operation: 'delete', path: 'C:\\work\\file.txt' }).classification, HIGH_RISK)
  assert.equal(classify('shell', { command: 'powershell', script: 'Remove-Item C:\\work\\file.txt' }).classification, HIGH_RISK)
  assert.equal(classify('browser', { operation: 'click', selector: '#purchase' }).classification, HIGH_RISK)
  assert.equal(classify('filesystem', { operation: 'stat', path: 'C:\\work\\file.txt' }).classification, NORMAL)
  assert.equal(sensitivePath('C:\\Users\\x\\.ssh\\id_ed25519'), true)
  assert.equal(sensitivePath('C:\\work\\jarvis\\.env'), true)
  assert.equal(classify('shell', { command: 'powershell', script: 'Get-Content .env' }).classification, HIGH_RISK)
})

test('audit redaction removes common secrets', () => {
  assert.deepEqual(redact({ apiKey: 'secret-value', detail: 'Bearer abcdefghijklmnopqrstuvwxyz' }), {
    apiKey: '[REDACTED]', detail: '[REDACTED]',
  })
})

test('MCP tools cannot read the bridge environment file', async () => {
  const route = createRouter({ requestApproval: async () => true, emit: () => {}, request: async () => ({}) })
  assert.equal((await route('filesystem', { operation: 'read', path: '.env' })).denied, true)
  assert.equal((await route('shell', { command: 'powershell', script: 'Get-Content .env' })).denied, true)
})
