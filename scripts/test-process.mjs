import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { stopProcessTree } from '../bridge/process.mjs'

test('owned background process shutdown settles and releases its pipes', async () => {
  const env = { ...process.env }; delete env.FISH_AUDIO_API_KEY
  const child = spawn(process.execPath, ['-e', 'console.log("ready"); setInterval(()=>{},1000)'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env })
  try {
    await once(child.stdout, 'data')
    const closed = once(child, 'close')
    await stopProcessTree(child)
    await closed
    assert.equal(child.stdout.destroyed, true)
    assert.equal(child.stderr.destroyed, true)
  } finally { if (child.exitCode === null && !child.killed) child.kill() }
})
