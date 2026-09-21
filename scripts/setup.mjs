#!/usr/bin/env node
import { spawnSync } from 'node:child_process'

const line = (tag, message) => console.log(`[${tag}] ${message}`)
console.log('\nJARVIS preflight — read-only checks; nothing is installed or changed')

const major = Number(process.versions.node.split('.')[0])
line(major >= 20 ? ' ok ' : 'note', `Node.js ${process.versions.node} (20+ required).`)

const codex = spawnSync('codex', ['--version'], { encoding: 'utf8', timeout: 10_000, shell: process.platform === 'win32' })
if (codex.status === 0) {
  line(' ok ', `Codex CLI found: ${codex.stdout.trim()}`)
  line('  · ', 'JARVIS will reuse the CLI ChatGPT login. It never uses an API key.')
} else {
  line('note', 'Codex CLI was not found on PATH.')
  line('  · ', 'Install Codex separately, then run `codex login` and choose ChatGPT sign-in.')
}

line(process.env.ELEVENLABS_API_KEY ? ' ok ' : '  · ', process.env.ELEVENLABS_API_KEY
  ? 'Optional ElevenLabs speech is configured in this shell.'
  : 'Browser speech will be used; ElevenLabs is optional.')
console.log('\nRun `npm run bridge` and `npm run dev`, or use `npm start`.\n')
