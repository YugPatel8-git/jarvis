import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import vm from 'node:vm'
import { createBrowserController } from '../bridge/browser.mjs'
import { matchFastPath } from '../bridge/fast-path.mjs'
import { BROWSER_INSTRUCTIONS, mcpBrowserEvidence } from '../bridge/browser-capabilities.mjs'
import { musicPageState } from '../bridge/youtube-music.mjs'
import { classify, HIGH_RISK } from '../bridge/security.mjs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'

function harness({connected=true,installed=true,pages=[],evaluate=()=>({ready:true}),rejectPath,cdpError,launchFails=false}={}) {
  const requests=[],calls=[],launches=[]
  const controller=createBrowserController({
    env:{ProgramFiles:'C:/Program Files'},exists:()=>installed,sleep:async()=>{},
    spawnProcess(exe,args,options){
      launches.push({exe,args,options});const child=new EventEmitter();child.unref=()=>{}
      if(launchFails)queueMicrotask(()=>child.emit('error',new Error('spawn denied')))
      else connected=true
      return child
    },
    fetchImpl:async(raw,options)=>{
      const u=new URL(raw);requests.push({url:u,options})
      if(!connected)throw new Error('connect ECONNREFUSED')
      if(rejectPath&&u.pathname.startsWith(rejectPath))return {ok:false,status:403}
      const value=u.pathname==='/json/version'?{webSocketDebuggerUrl:`ws://127.0.0.1:${u.port}/devtools/browser/test`}
        :u.pathname==='/json'?pages
        :u.pathname==='/json/new'?{id:'created',type:'page',url:decodeURIComponent(u.search.slice(1)),webSocketDebuggerUrl:`ws://127.0.0.1:${u.port}/devtools/page/created`}:{}
      return {ok:true,json:async()=>value}
    },
    pool:{request:async(t,method,args)=>{calls.push({t,method,args});if(cdpError)return cdpError;return {result:{value:evaluate(args.expression,t)}}}},
  })
  return {controller,requests,calls,launches}
}
const page={id:'music',type:'page',url:'https://music.youtube.com/library',webSocketDebuggerUrl:'ws://127.0.0.1:9223/devtools/page/music'}

test('requested browser commands have deterministic local routes',()=>{
  for(const [text,args] of [
    ['Open Brave',{operation:'open',browser:'brave',url:'https://www.google.com/'}],
    ['Open Brave and search YouTube Music',{operation:'search',browser:'brave',query:'YouTube Music'}],
    ['Open YouTube Music',{operation:'youtube_music',action:'open'}],
    ['Open YouTube Music and play my library.',{operation:'youtube_music',action:'play_library'}],
    ['Open YouTube Music Library',{operation:'youtube_music',action:'library'}],
    ["Don't you have browser controls?",{operation:'capabilities'}],
  ])assert.deepEqual(matchFastPath(text)?.args,args,text)
  assert.equal(matchFastPath('open Brave and delete my files'),null)
  assert.equal(matchFastPath('play my library'),null)
})

test('Brave search encodes query as URL data, never executable text',async()=>{
  const h=harness({connected:false})
  await h.controller({operation:'search',browser:'brave',query:'YouTube Music & calc.exe'})
  assert.equal(h.launches.length,1)
  assert.match(h.launches[0].exe,/BraveSoftware.*brave\.exe$/)
  assert.equal(h.launches[0].options.shell,false)
  assert.equal(h.launches[0].options.windowsHide,true)
  assert.ok(h.launches[0].args.includes('--remote-debugging-port=9224'))
  assert.ok(h.launches[0].args.some(a=>a.includes('brave-profile')))
  assert.ok(h.launches[0].args.every(a=>!a.includes('calc')))
  const dest=decodeURIComponent(h.requests.find(r=>r.url.pathname==='/json/new').url.search.slice(1))
  assert.equal(new URL(dest).searchParams.get('q'),'YouTube Music & calc.exe')
})

test('browser selection persists for tab operations; explicit Chrome switches back',async()=>{
  const h=harness({pages:[page]})
  await h.controller({operation:'open',browser:'brave',url:'https://music.youtube.com/'})
  await h.controller({operation:'tabs'})
  assert.equal(h.requests.at(-1).url.port,'9224')
  await h.controller({operation:'tabs',browser:'chrome'})
  assert.equal(h.requests.at(-1).url.port,'9223')
})

for(const [name,options,pattern] of [
  ['missing Brave',{connected:false,installed:false},/Brave executable was not found/],
  ['launch failure',{connected:false,launchFails:true},/Brave launch failed: spawn denied/],
  ['tab refusal',{rejectPath:'/json/new'},/HTTP 403/],
])test(name+' reports actual failure',async()=>{
  const h=harness(options)
  await assert.rejects(h.controller({operation:'open',browser:'brave',url:'https://music.youtube.com/'}),pattern)
})

test('unsafe navigation, invalid browser and executable overrides fail closed',async()=>{
  const h=harness()
  await assert.rejects(h.controller({operation:'open',url:'file:///C:/secret'}),/http/)
  await assert.rejects(h.controller({operation:'tabs',browser:'powershell'}),/Supported browsers/)
  const bad=createBrowserController({env:{JARVIS_BRAVE_PATH:'cmd.exe /c calc'},exists:()=>true})
  await assert.rejects(bad({operation:'tabs',browser:'brave'}),/absolute path/)
  assert.equal(h.launches.length,0)
})

test('capability answers distinguish installation and connection without launches',async()=>{
  for(const connected of [false,true]){
    const h=harness({connected}),status=await h.controller({operation:'capabilities'})
    assert.equal(h.launches.length,0)
    assert.ok(status.browsers.every(b=>b.connected===connected&&b.installed))
    assert.match(status.message,connected?/control is connected/:/no automation session is connected/)
    assert.doesNotMatch(status.message,/can't control|don't have browser/)
  }
})

test('failed activation and navigation never return success',async()=>{
  const h=harness({pages:[page],rejectPath:'/json/activate'})
  await assert.rejects(h.controller({operation:'next_tab'}),/HTTP 403/)
  const bad=harness({pages:[page],cdpError:{errorText:'net::ERR_BLOCKED_BY_CLIENT'}})
  await assert.rejects(bad.controller({operation:'navigate',url:'https://example.com/'}),/ERR_BLOCKED_BY_CLIENT/)
  await assert.rejects(h.controller({operation:'read',tabId:'stale'}),/not available/)
})

test('YouTube Music reuses its accessible tab and avoids another browser launch',async()=>{
  const h=harness({pages:[page]})
  const result=await h.controller({operation:'youtube_music'})
  assert.equal(result.tabId,'music')
  assert.equal(h.launches.length,0)
  assert.equal(h.requests.some(r=>r.url.pathname==='/json/new'),false)
  assert.equal(result.playing,false)
})

test('YouTube Music opens the exact canonical destination',async()=>{
  const h=harness()
  const result=await h.controller({operation:'youtube_music'})
  assert.equal(result.opened,'https://music.youtube.com/')
  assert.equal(result.playing,false)
})

for(const [name,state,pattern] of [
  ['sign-in required',{ready:true,authenticationRequired:true},/needs sign-in/],
  ['inaccessible Library',{ready:false},/controls are not accessible/],
  ['missing Play',{ready:true,controlMissing:true},/no accessible library Play/],
  ['unconfirmed playback',{ready:true,clicked:true,playing:false},/not confirmed playback/],
])test('YouTube Music '+name+' cannot claim playback',async()=>{
  const h=harness({pages:[page],evaluate:()=>state})
  const result=await h.controller({operation:'youtube_music',action:'play_library'})
  assert.equal(result.playing,false)
  assert.match(result.message,pattern)
})

test('YouTube Music reports success only after clicking Library Play and observing playback',async()=>{
  let clicked=false
  const h=harness({pages:[page],evaluate:expression=>{
    if(expression.endsWith('(true)')){clicked=true;return {ready:true,clicked:true,playing:false}}
    return {ready:true,playing:clicked}
  }})
  assert.equal((await h.controller({operation:'youtube_music',action:'play_library'})).playing,true)
  assert.equal(clicked,true)
})

test('an old queue still playing cannot verify Library playback',async()=>{
  const h=harness({pages:[page],evaluate:expression=>({ready:true,clicked:expression.endsWith('(true)'),playing:true,source:'old',time:100})})
  const result=await h.controller({operation:'youtube_music',action:'play_library'})
  assert.equal(result.playing,false)
  assert.equal(result.playClicked,true)
})

test('fixed page helper only clicks a visible library Play control on the music origin',()=>{
  let clicks=0
  const button={getClientRects:()=>[1],getAttribute:name=>name==='aria-label'?'Play my songs':null,click:()=>clicks++}
  const root={getClientRects:()=>[1],querySelectorAll:()=>[button]}
  const context={location:{origin:'https://music.youtube.com',pathname:'/library'},getComputedStyle:()=>({visibility:'visible'}),document:{readyState:'complete',querySelectorAll:()=>[],querySelector:s=>s.includes('library')?root:null}}
  const run=()=>vm.runInNewContext(`(${musicPageState.toString()})(true)`,context)
  assert.equal(run().clicked,true)
  assert.equal(clicks,1)
  context.location.origin='https://example.com'
  assert.equal(run().ready,false)
  assert.equal(clicks,1)
})

test('capability guidance and evidence never equate registration with connection',()=>{
  assert.match(BROWSER_INSTRUCTIONS,/independently of disabled built-in/)
  assert.match(BROWSER_INSTRUCTIONS,/Security approvals remain mandatory/)
  assert.match(mcpBrowserEvidence({data:[{name:'jarvis',tools:{browser:{name:'browser'}}}]}),/registered tools: browser/)
  assert.match(mcpBrowserEvidence({data:[]}),/unverified/)
  assert.match(mcpBrowserEvidence({data:[{name:'jarvis',runtimeStatus:'failed',tools:{browser:{name:'browser'}}}]}),/failed.*unverified/)
  assert.match(mcpBrowserEvidence({data:[{name:'jarvis',toolsError:'failure'}]}),/discovery failed/)
  assert.equal(classify('browser',{operation:'click',selector:'#purchase',browser:'brave'}).classification,HIGH_RISK)
})

test('real MCP registration exposes browser selection and music operations to clients',async()=>{
  const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../bridge/mcp-server.mjs',import.meta.url))],stderr:'pipe'})
  const client=new Client({name:'browser-regression',version:'1'})
  try{
    await client.connect(transport)
    const {tools}=await client.listTools()
    assert.deepEqual(tools.map(t=>t.name).sort(),['browser','filesystem','hud','shell','vision'])
    const schema=tools.find(t=>t.name==='browser').inputSchema.properties
    assert.deepEqual(schema.browser.enum,['chrome','brave'])
    assert.ok(schema.operation.enum.includes('youtube_music'))
    assert.ok(schema.operation.enum.includes('capabilities'))
  }finally{await client.close()}
})
