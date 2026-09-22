import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const source = readFileSync(new URL('../src/lib/speech-text.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText
const { toSpeechText, wantsLiteralTechnicalSpeech } = await import(`data:text/javascript,${encodeURIComponent(compiled)}`)
const phraseSource = readFileSync(new URL('../src/lib/speech-phrases.ts', import.meta.url), 'utf8')
const phraseCompiled = ts.transpileModule(phraseSource, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText
const { takeSpeechPhrases } = await import(`data:text/javascript,${encodeURIComponent(phraseCompiled)}`)

const cases = [
  ['Compiling...', ''],
  ['Tokyo.', 'Tokyo.'],
  ['Recursion is when a function calls itself until it reaches a base case.', 'Recursion is when a function calls itself until it reaches a base case.'],
  ['npm run build exited with code 0', 'The build finished successfully.'],
  ['C:\\Users\\yugkp\\Downloads\\jarvis\\src\\App.tsx', 'App.tsx in the source folder.'],
  ['https://github.com/openai/codex', 'The OpenAI Codex GitHub page.'],
  ['Done', 'Done.'],
  ['Error at src/App.tsx:184:22', "There's an error in App.tsx."],
  ['5.4s', 'About five point four seconds.'],
  ['JARVIS_ALLOW_WRITES=1', 'Write access is enabled.'],
  ['Process exited with code 1', 'The command failed.'],
  ['TypeError at src/App.tsx:184:22', "There's an error in App.tsx."],
  ['TypeError: Cannot read properties of undefined\nat App.tsx:184:22', "There's an error in App.tsx."],
  ['npm run build', "I'll run the build."],
  ['git status', "I'll check the Git status."],
  ['npm install', "I'll install the project dependencies."],
  ['npx tsc --noEmit', "I'll run the command."],
  ['Task completed successfully', 'Done.'],
  ['Checking that now.', 'Checking that now.'],
  ['**Done**', 'Done.'],
  ['80%', 'Eighty percent.'],
  ['$25', 'Twenty-five dollars.'],
  ['It took 5.4s in 2026.', 'It took about five point four seconds in twenty twenty-six.'],
]

test('normalizes technical display text for speech', () => {
  for (const [display, expected] of cases) assert.equal(toSpeechText(display), expected, display)
})

test('suppresses internal status and raw diagnostics', () => {
  for (const display of ['Executing', 'Running tool', 'Calling MCP', 'stdout: hello', 'stderr: error', 'Exit code 0', 'Agent message delta', 'route: codex', 'mcp__server__tool', '{"ok":true}', '| --- | --- |', 'OPENAI_API_KEY=hidden', 'Bearer abcdefghijklmnop', 'C:\\Users\\x\\.codex\\auth.json']) {
    assert.equal(toSpeechText(display), '', display)
  }
})

test('literal technical requests preserve exact technical text', () => {
  for (const request of ['Read that command.', 'Read the exact URL.', 'Tell me the exact path.', 'Read the code.', 'Spell that.', 'Read the error exactly.']) {
    assert.equal(wantsLiteralTechnicalSpeech(request), true, request)
  }
  assert.equal(wantsLiteralTechnicalSpeech('What does this command do?'), false)
  assert.equal(toSpeechText('https://github.com/openai/codex', { literalTechnical: true }), 'https://github.com/openai/codex')
})

test('keeps HUD input separate from speech normalization', () => {
  const display = '**Build successful**'
  assert.equal(toSpeechText(display), 'The build finished successfully.')
  assert.equal(display, '**Build successful**')
})

test('streamed technical text reaches the normalizer without changing display text', () => {
  const display = 'The file is at C:\\Users\\yugkp\\Downloads\\jarvis\\src\\App.tsx. More details'
  const { phrases, rest } = takeSpeechPhrases(display)
  assert.equal(display.includes('C:\\Users'), true)
  assert.equal(phrases.length, 1)
  assert.equal(toSpeechText(phrases[0]), 'The file is at App.tsx in the source folder.')
  assert.equal(rest, 'More details')
})
