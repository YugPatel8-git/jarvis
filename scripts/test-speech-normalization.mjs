import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import vm from 'node:vm'
import ts from 'typescript'
import * as speech from '../bridge/speech-normalization.mjs'
import * as vocabulary from '../shared/speech-vocabulary.mjs'
import { matchFastPath } from '../bridge/fast-path.mjs'
import { classify, HIGH_RISK } from '../bridge/security.mjs'
import * as health from '../bridge/health.mjs'

for (const [raw, normalized, context = {}] of [
  ['visual studio cold', 'Visual Studio Code'],
  ['open visual studio cold', 'open Visual Studio Code'],
  ['git statues', 'git status'],
  ['open down loads', 'open Downloads'],
  ['screen sheriff', 'screen share', { screenSharing: true }],
  ['turn off screen sheriff', 'turn off screen sharing', { terms: ['screen sharing'] }],
  ['open crow', 'open Chrome', { terms: ['Chrome'] }],
]) test(`high-confidence correction: ${raw}`, () => {
  const result = speech.normalizeSpeech(raw, context)
  assert.equal(result.rawTranscript, raw)
  assert.equal(result.normalizedTranscript, normalized)
  assert.equal(result.confidence, 'high')
})

for (const raw of ['open crow', 'open chrom', 'open studio', 'open code', 'open crow or chrome']) test(`ambiguous app does not silently correct: ${raw}`, () => {
  const result = speech.normalizeSpeech(raw)
  assert.equal(result.normalizedTranscript, raw)
  assert.notEqual(result.confidence, 'high')
})

for (const raw of [
  'transfer maybe fifty dollars to Chrome', 'pay 15 or 50 dollars',
  'delete down loads folder', 'format sea drive', 'git push force maybe',
  'open https://crow.example', 'open file visual studio cold.txt',
  'change firewall rules in visual studio cold', 'send visual studio cold to Jane',
  'my password is visual studio cold', 'API key sk-test-not-a-real-key',
  'MFA code 123456', 'buy Chrome for twenty dollars', 'rename down loads',
]) test(`protected input stays raw: ${raw.split(' ').slice(0, 3).join(' ')}`, () => {
  const result = speech.normalizeSpeech(raw, { terms: vocabulary.TERMS, screenSharing: true })
  assert.equal(result.rawTranscript, raw)
  assert.equal(result.normalizedTranscript, raw)
  assert.equal(result.suggestion, null)
  assert.notEqual(result.confidence, 'high')
})

test('context is bounded, expires, and never retains credential text', () => {
  const context = speech.createSpeechContext()
  context.remember('We are working in Chrome')
  assert.equal(speech.normalizeSpeech('open crow', { terms: context.terms() }).confidence, 'high')
  context.remember('my password is Chrome')
  for (let i = 0; i < 3; i++) context.remember('unrelated weather conversation')
  assert.deepEqual(context.terms(), [])
  assert.equal(speech.normalizeSpeech('open crow', { terms: context.terms() }).confidence, 'medium')
  assert.deepEqual(speech.contextTerms('credential token Chrome'), [])
  assert.equal(speech.normalizeSpeech('open crow', { terms: ['Chrome', 'YouTube'] }).confidence, 'medium')
})

test('medium confidence gives evidence only for reasoning; actions require clarification', () => {
  const reasoning = speech.normalizeSpeech('explain screen sheriff')
  assert.equal(reasoning.confidence, 'medium')
  assert.equal(reasoning.normalizedTranscript, reasoning.rawTranscript)
  assert.match(speech.speechPrompt(reasoning), /uncertain/)
  assert.match(speech.speechPrompt(reasoning), /do not take actions/)
  assert.match(speech.normalizeSpeech('open crow').clarification, /Did you mean Chrome/)
})

test('no broad substitutions in search queries, dictation, filenames or names', () => {
  for (const raw of ['search google for visual studio cold', 'write visual studio cold', 'call Crow', 'open folder down loads', 'explain "git statues"', 'git statues.md']) {
    assert.equal(speech.normalizeSpeech(raw).normalizedTranscript, raw)
  }
})

test('exact raw chunks are retained; malformed or mismatched speech metadata is rejected', () => {
  const rawChunks = ['  open ', ' visual studio cold  ']
  const input = speech.readSpeechInput('open visual studio cold', { rawChunks })
  const result = speech.normalizeSpeech(input.rawTranscript, {}, input.rawChunks)
  assert.deepEqual(result.rawChunks, rawChunks)
  assert.equal(result.rawTranscript, rawChunks.join(' '))
  assert.equal(result.normalizedTranscript, 'open Visual Studio Code')
  assert.match(speech.speechPrompt(result), /Raw speech:/)
  for (const metadata of [{rawChunks:['delete everything']}, {rawChunks:[42]}, {rawChunks:Array(257).fill('x')}, {}]) {
    assert.equal(speech.readSpeechInput('open Chrome', metadata), null)
  }
})

test('shared app vocabulary maps to existing routes without expanding approved actions', () => {
  for (const names of Object.values(vocabulary.APPS)) for (const name of names) assert.ok(matchFastPath(`open ${name}`))
  for (const raw of ['open visual studio cold', 'git statues', 'open down loads']) {
    assert.ok(matchFastPath(speech.normalizeSpeech(raw).normalizedTranscript))
  }
  assert.equal(matchFastPath(speech.normalizeSpeech('delete down loads folder').normalizedTranscript), null)
  assert.equal(classify('filesystem', { operation:'delete', path:'Downloads' }).classification, HIGH_RISK)
  assert.equal(classify('shell', { command:'git', args:['reset','--hard'] }).classification, HIGH_RISK)
})

test('phrase hints are bounded public terms and unsupported engines are harmless', () => {
  const rec = { phrases: [] }
  class Phrase { constructor(phrase, boost) { Object.assign(this, {phrase, boost}) } }
  assert.equal(vocabulary.applySpeechHints(rec, Phrase), true)
  assert.deepEqual(rec.phrases.map(p => p.phrase), vocabulary.TERMS)
  assert.ok(rec.phrases.length < 32)
  assert.equal(vocabulary.applySpeechHints({}, Phrase), false)
  assert.equal(vocabulary.applySpeechHints({ get phrases(){return []}, set phrases(_value){throw new Error('unsupported')} }, Phrase), false)
  assert.equal(vocabulary.diagnosticSpeech('my password is visual studio cold'), '[REDACTED]')
})

const serverSource = ts.transpileModule(readFileSync(new URL('../bridge/server.mjs', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
function bridgeHarness(toolResult=()=>({})) {
  let connection, handle
  const prompts = [], tools = [], logs = [], sttForms = [], frames = []
  const server = { on() {}, listen(_port, _host, fn) { fn() } }
  vm.runInNewContext(serverSource, {
    exports: {}, performance, Buffer, Blob, FormData, URL, setTimeout, clearTimeout,
    console: { log: text => logs.push(text), warn: text => logs.push(text) },
    fetch: async (_url, args) => { sttForms.push(args.body); return {status:200,text:async()=>'{"text":"hello"}'} },
    require(id) {
      if (id === 'node:http') return { createServer(fn) { handle=fn; return server } }
      if (id === 'node:process') return { env: {ELEVENLABS_API_KEY:'fixture'}, cwd:()=>'.', on(){} }
      if (id === 'node:fs') return { existsSync:()=>false }
      if (id === 'node:crypto') return { randomBytes:()=>Buffer.alloc(32) }
      if (id === 'node:events') return { once:async()=>{} }
      if (id === 'ws') return { WebSocketServer:class { on(name,fn){if(name==='connection')connection=fn} }, WebSocket:{OPEN:1} }
      if (id === './codex-app-server.mjs') return {CodexAppServerConversation:class {
        state='ready'; warm(){return Promise.resolve()} cancel(){} ask(prompt){prompts.push(prompt);return Promise.resolve('Fixture answer')}
      },appServerModelLabel:()=> 'fixture'}
      if (id === './router.mjs') return {createRouter:()=>async(tool,args)=>{tools.push({tool,args});return toolResult(tool,args)}}
      if (id === './fast-path.mjs') return {matchFastPath}
      if (id === './speech-normalization.mjs') return speech
      if (id === './fish-tts.mjs') return {fishConfigured:()=>false}
      if (id === './health.mjs') return health
      throw new Error(id)
    },
  })
  const socket = new EventEmitter()
  Object.assign(socket,{readyState:1,send:raw=>frames.push(JSON.parse(raw)),close(){}})
  connection(socket,{url:'/ws'})
  let serial=0
  return {prompts,tools,logs,sttForms,frames,handle,
    screen(){socket.emit('message',JSON.stringify({type:'screen-status',sharing:true}))},
    async ask(text, voice=true) {
      socket.emit('message',JSON.stringify({type:'ask',id:String(++serial),text,...(voice?{speech:{rawChunks:[text]}}:{})}))
      await new Promise(resolve=>setImmediate(resolve))
    },
  }
}

test('bridge routes normalized speech locally with zero model calls', async () => {
  const h=bridgeHarness()
  await h.ask('open visual studio cold')
  await h.ask('git statues')
  await h.ask('open down loads')
  assert.equal(h.tools.length,3)
  assert.equal(h.tools[0].args.args.at(-1),'code')
  assert.deepEqual(h.tools[1].args.args,['status','--short'])
  assert.match(h.tools[2].args.args[0],/Downloads$/)
  assert.equal(h.prompts.length,0)
})

test('browser fast paths use tool-reported outcomes with zero model calls',async()=>{
  const h=bridgeHarness((_tool,args)=>args.operation==='capabilities'?{message:'Brave installed; automation not connected.'}:args.operation==='youtube_music'?{message:'YouTube Music needs sign-in.',playing:false}:{})
  for(const text of ['Open Brave','Open Brave and search YouTube Music','Open YouTube Music and play my library',"Don't you have browser controls?"])await h.ask(text,false)
  assert.equal(h.tools.length,4)
  assert.equal(h.prompts.length,0)
  assert.deepEqual(h.frames.filter(f=>f.type==='done').slice(-2).map(f=>f.text),['YouTube Music needs sign-in.','Brave installed; automation not connected.'])
})

test('browser failure and approval denial never produce a success response',async()=>{
  const denied=bridgeHarness(()=>({denied:true,message:'Action declined.'}))
  await denied.ask('Open Brave',false)
  assert.equal(denied.frames.find(f=>f.type==='done').text,'Action declined.')
  const failed=bridgeHarness(()=>{throw new Error('Brave executable was not found.')})
  await failed.ask('Open Brave',false)
  assert.match(failed.frames.find(f=>f.type==='error').message,/Brave executable was not found/)
  assert.equal(failed.frames.some(f=>f.type==='done'),false)
  assert.equal(failed.prompts.length,0)
})

test('main request carries both representations exactly once; typed text is unchanged', async () => {
  const h=bridgeHarness()
  await h.ask('explain visual studio cold')
  assert.equal(h.prompts.length,1)
  assert.match(h.prompts[0],/Raw speech: "explain visual studio cold"/)
  assert.match(h.prompts[0],/Interpreted speech: "explain Visual Studio Code"/)
  await h.ask('open visual studio cold',false)
  assert.equal(h.prompts[1],'open visual studio cold')
  assert.equal(h.tools.length,0)
})

test('bridge uses recent task and existing screen state without another context request', async () => {
  const h=bridgeHarness()
  await h.ask('We are working in Chrome',false)
  await h.ask('open crow')
  assert.equal(h.tools.length,1)
  assert.equal(h.tools[0].args.url,'https://www.google.com/')
  h.screen()
  await h.ask('turn off screen sheriff')
  assert.equal(h.prompts.length,2)
  assert.match(h.prompts[1],/turn off screen sharing/)
})

test('uncertain actions and credentials trigger local clarification without tools, models or logging', async () => {
  const h=bridgeHarness()
  for (const raw of ['open crow','format sea drive','delete down loads folder','pay 15 or 50 dollars','my password is visual studio cold']) await h.ask(raw)
  assert.equal(h.tools.length,0)
  assert.equal(h.prompts.length,0)
  assert.equal(h.frames.filter(frame=>frame.type==='done').length,5)
  assert.doesNotMatch(JSON.stringify(h.logs)+JSON.stringify(h.frames),/my password|visual studio cold|15 or 50/)
})

test('Scribe keeps v1 and sends only an English language hint, with no paid keyterms', async () => {
  const h=bridgeHarness(), response=new EventEmitter()
  let responseBody
  Object.assign(response,{writeHead(){},end(value){responseBody=value},destroy(){}})
  const request={method:'POST',url:'/stt',headers:{origin:'http://localhost:5173'},async *[Symbol.asyncIterator](){yield Buffer.from('audio')}}
  h.handle(request,response)
  await new Promise(resolve=>setImmediate(resolve))
  assert.equal(h.sttForms.length,1,responseBody)
  assert.equal(h.sttForms[0].get('language_code'),'en')
  assert.equal(h.sttForms[0].get('model_id'),'scribe_v1')
  assert.equal(h.sttForms[0].has('keyterms'),false)
})

test('normalization adds negligible local fast-path overhead', t => {
  const count=5000, raw='open visual studio cold'
  for(let i=0;i<100;i++) speech.normalizeSpeech(raw)
  const base=performance.now()
  for(let i=0;i<count;i++) matchFastPath('open Visual Studio Code')
  const baseMs=(performance.now()-base)/count
  const start=performance.now()
  for(let i=0;i<count;i++) matchFastPath(speech.normalizeSpeech(raw).normalizedTranscript)
  const totalMs=(performance.now()-start)/count
  t.diagnostic(`mean local match ${baseMs.toFixed(4)} ms; normalization + match ${totalMs.toFixed(4)} ms (${count} iterations)`)
  assert.ok(totalMs<1,`mean ${totalMs} ms exceeds the 1ms regression budget`)
})
