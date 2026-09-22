import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const source = readFileSync(new URL('../src/lib/speech-phrases.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText
const { speakablePhrase, takeSpeechPhrases } = await import(`data:text/javascript,${encodeURIComponent(compiled)}`)

test('releases a stable clause while the next clause is still streaming', () => {
  const first = takeSpeechPhrases('I checked the forecast for your area, and the rain should')
  assert.deepEqual(first.phrases, ['I checked the forecast for your area, '])
  assert.equal(first.rest, 'and the rain should')
})

test('keeps short comma fragments and partial words together', () => {
  const first = takeSpeechPhrases('Yes, the system is work')
  assert.deepEqual(first.phrases, [])
  const second = takeSpeechPhrases(first.rest + 'ing as expected. Next')
  assert.deepEqual(second.phrases, ['Yes, the system is working as expected. '])
})

test('does not read URLs, paths, code, JSON, or unfinished markdown', () => {
  for (const text of [
    'See https://example.com/path, ',
    'Open C:\\Users\\name\\file.txt. ',
    'Edit src/lib/tts.ts next. ',
    'Run `npm start` now. ',
    '{"status":"ok"}',
    'Read [this link](https://example.com). ',
  ]) assert.equal(speakablePhrase(text), false, text)
})

test('does not split an abbreviation as a sentence', () => {
  const result = takeSpeechPhrases('Ask Mr. Stark to call me. Then')
  assert.deepEqual(result.phrases, ['Ask Mr. Stark to call me. '])
})

test('waits for and removes a streamed code fence', () => {
  const partial = takeSpeechPhrases('Here is the result. ```js\nconst x = 1;')
  assert.deepEqual(partial.phrases, [])
  const complete = takeSpeechPhrases(partial.rest + '\n``` The result is ready. Next')
  assert.deepEqual(complete.phrases, ['Here is the result. ', 'The result is ready. '])
})
