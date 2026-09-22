import assert from 'node:assert/strict'
import { hasWakePhrase, afterWakePhrase, commandAfterWake } from '../src/lib/wake-phrase.ts'

const cases = [
  ['Hey Jarvis', true, ''],
  ['Hey, Jarvis', true, ''],
  ['Hey Jarvis, open Chrome', true, 'open Chrome'],
  ['Hey Jarvis, search YouTube for Max Verstappen highlights', true, 'search YouTube for Max Verstappen highlights'],
  ['Hey Jarvis, what is recursion?', true, 'what is recursion?'],
  ['Jarvis', false, ''],
  ['Travis', false, ''],
  ["Hey Jarvis's", false, ''],
  ['Hey Jarvis Hey Jarvis', true, 'Hey Jarvis'],
]
for (const [input, wake, trailing] of cases) {
  assert.equal(hasWakePhrase(input), wake, input)
  assert.equal(afterWakePhrase(input), trailing, input)
}
console.log(`${cases.length} wake phrase cases passed`)
assert.equal(commandAfterWake('Hey Jarvis, open Chrome'), 'open Chrome')
assert.equal(commandAfterWake('Hey Jarvis Hey Jarvis'), '')
assert.equal(commandAfterWake('Hey Jarvis Hey Jarvis, open Chrome'), 'open Chrome')
assert.equal(commandAfterWake('Hey Jarvis, what is recursion?'), 'what is recursion?')
