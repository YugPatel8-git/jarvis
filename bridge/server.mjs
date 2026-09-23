import http from 'node:http'
import { randomBytes } from 'node:crypto'
import process from 'node:process'
import { existsSync, readFileSync } from 'node:fs'
import { WebSocketServer, WebSocket } from 'ws'
import { CodexAppServerConversation, appServerModelLabel } from './codex-app-server.mjs'
import { createRouter } from './router.mjs'
import { matchFastPath } from './fast-path.mjs'
import { FISH_MODEL, fishConfigured, fishSpeech } from './fish-tts.mjs'
import { createHealth, diagnosticText } from './health.mjs'

// Read only Fish settings into a private object. Never add the key to
// process.env: Codex, MCP, and shell child processes inherit that environment.
const fishEnv = {
  FISH_AUDIO_API_KEY: process.env.FISH_AUDIO_API_KEY ?? '',
  FISH_AUDIO_REFERENCE_ID: process.env.FISH_AUDIO_REFERENCE_ID ?? '',
}
if (existsSync('.env')) {
  const lines = readFileSync('.env', 'utf8').split(/\r?\n/)
  for (const line of lines) {
    const match = line.match(/^\s*(FISH_AUDIO_API_KEY|FISH_AUDIO_REFERENCE_ID)=(.*)\s*$/)
    if (match && !fishEnv[match[1]]) fishEnv[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, '$2')
  }
}

const HOST='127.0.0.1', PORT=Number(process.env.JARVIS_BRIDGE_PORT??8787)
const TOKEN=randomBytes(32).toString('hex')
const health=createHealth()
health.mark('bridge','ready')
health.mark('frontend','idle')
health.mark('tools','idle')
if(!fishConfigured(fishEnv))health.mark('fish','unavailable')
const EXTRA=new Set((process.env.JARVIS_ALLOWED_ORIGINS??'').split(',').map(x=>x.trim().replace(/\/+$/,'')).filter(Boolean))
const local=new Set(['localhost','127.0.0.1','[::1]'])
function originAllowed(origin){if(!origin)return false;if(EXTRA.has(origin.replace(/\/+$/,'')))return true;try{const u=new URL(origin),p=Number(u.port);return u.protocol==='http:'&&local.has(u.hostname)&&((p>=5173&&p<=5199)||(p>=4173&&p<=4199))}catch{return false}}
const cors=(origin)=>({vary:'origin','access-control-allow-origin':origin,'access-control-allow-headers':'content-type'})
const eleven=()=>process.env.ELEVENLABS_API_KEY||null
async function body(req,max){const chunks=[];let n=0;for await(const c of req){n+=c.length;if(n>max)throw new Error('body too large');chunks.push(c)}return Buffer.concat(chunks)}
async function handle(req,res){
  const origin=req.headers.origin
  if(!originAllowed(origin)){res.writeHead(403,{vary:'origin'});return res.end('forbidden')}
  const h=cors(origin)
  if(req.method==='OPTIONS'){res.writeHead(204,h);return res.end()}
  if(req.method==='GET'&&req.url==='/health'){res.writeHead(200,{...h,'content-type':'application/json'});return res.end(JSON.stringify({ok:true,backend:'codex-app-server',core:conversation.state,model:conversation.model||'Codex default',efforts:conversation.supportedEfforts,tools:true,tts:fishConfigured(fishEnv),ttsEngine:fishConfigured(fishEnv)?'fish':null,stt:Boolean(eleven()),prewarm:coreTimings}))}
  if(req.method==='POST'&&req.url==='/tts'){
    if(!fishConfigured(fishEnv)){res.writeHead(503,{...h,'cache-control':'no-store'});return res.end('Speech service unavailable.')}
    if(!health.fishAvailable()){res.writeHead(503,{...h,'cache-control':'no-store'});return res.end('Speech service is cooling down.')}
    const data=JSON.parse((await body(req,64*1024)).toString());const text=String(data.text??'').trim().slice(0,5000)
    if(!text){res.writeHead(400,h);return res.end('Speech text required.')}
    const began=performance.now(), controller=new AbortController()
    const abort=()=>controller.abort()
    res.once('close',abort)
    try{
      const up=await fishSpeech(text,{env:fishEnv,signal:AbortSignal.any([controller.signal,AbortSignal.timeout(20000)])})
      if(!up?.audio){const notice=health.failure('fish','upstream');if(notice)send({type:'health-notice',text:notice});res.writeHead(502,{...h,'cache-control':'no-store'});return res.end('Speech generation unavailable.')}
      res.writeHead(200,{...h,'content-type':'audio/mpeg','cache-control':'no-store'})
      let first=true
      for await(const c of up.audio){if(first){health.timing('fishFirstByte',performance.now()-began);first=false}res.write(c)}
      health.timing('fishComplete',performance.now()-began)
      const notice=health.mark('fish','ready');if(notice)send({type:'health-notice',text:notice})
      return res.end()
    }catch(error){
      if(controller.signal.aborted)return
      const notice=health.failure('fish',error?.name==='TimeoutError'?'timeout':'upstream');if(notice)send({type:'health-notice',text:notice})
      if(!res.headersSent){res.writeHead(502,{...h,'cache-control':'no-store'});res.end('Speech generation unavailable.')}else res.destroy()
    }finally{res.off('close',abort)}
  }
  if(req.method==='POST'&&req.url==='/stt'){
    const key=eleven();if(!key){res.writeHead(503,h);return res.end('ElevenLabs is not configured.')}
    const audio=await body(req,25*1024*1024), form=new FormData();form.append('model_id','scribe_v1');form.append('file',new Blob([audio],{type:req.headers['content-type']||'audio/webm'}),'speech.webm')
    const up=await fetch('https://api.elevenlabs.io/v1/speech-to-text',{method:'POST',headers:{'xi-api-key':key},body:form});res.writeHead(up.status,{...h,'content-type':'application/json','cache-control':'no-store'});return res.end(await up.text())
  }
  res.writeHead(404,h);res.end()
}
const server=http.createServer((q,s)=>handle(q,s).catch(e=>{if(!s.headersSent)s.writeHead(500,{'cache-control':'no-store'});s.end(q.url==='/tts'?'Speech generation unavailable.':String(e?.message??e))}))
const wss=new WebSocketServer({noServer:true,maxPayload:2*1024*1024})
let frontend=null, seq=0, screenSharing=false
const screenQuestion=(text)=>/\b(?:my screen|this screen|on screen|this window|this button|what am i looking at|what should i click|where should i click|read this error|what(?:'s| is) this error|currently open|guide me through this)\b/i.test(text)
const waiting=new Map()
function send(msg){if(frontend?.readyState===WebSocket.OPEN)frontend.send(JSON.stringify(msg))}
let askId=null
const coreTimings={}
const conversation=new CodexAppServerConversation({cwd:process.cwd(),routerToken:TOKEN,onText:(delta)=>send({type:'text',delta,ask:askId}),onTool:(name)=>send({type:'tool',name,ask:askId}),onTiming:(metric,ms)=>{const value=Number(ms.toFixed(2));coreTimings[metric]=value;if(metric==='firstCodexEventMs')health.timing('codexFirstEvent',ms);if(metric==='firstTextMs')health.timing('codexFirstText',ms);send({type:'timing',metric,ms:value,ask:askId})},onRouting:({model,effort})=>send({type:'routing',model,effort,ask:askId}),onFailure:(kind)=>{const notice=health.failure('codex',kind);if(notice)send({type:'health-notice',text:notice})},onState:(state)=>{const notice=health.mark('codex',state==='ready'?'ready':state==='fallback'?'degraded':'recovering');if(notice)send({type:'health-notice',text:notice});send({type:'core',state,servers:[state==='ready'?'ai-core-ready':state==='fallback'?'ai-core-fallback':'ai-core-warming','jarvis-tools','hud','vision']})}})
void conversation.warm().catch(()=>console.warn('[jarvis] app-server prewarm failed; exec fallback remains available.'))
function request(type,args,ms=120000){return new Promise((ok,no)=>{if(!frontend)return no(new Error('JARVIS interface is not connected.'));const id=`r${++seq}`,timer=setTimeout(()=>{waiting.delete(id);no(new Error(`${type} request timed out`))},ms);waiting.set(id,{ok,no,timer});send({type,id,...args})})}
const route=createRouter({
  requestApproval:(p)=>request('approval',p).then(x=>Boolean(x.approved)),
  request,
  emit:(type,payload)=>send({type,...payload,...(type==='tool-timing'&&payload.ask===undefined?{ask:askId}:{})}),
  onOutcome:(tool,ok,ms)=>{if(tool==='browser'){if(ok){health.timing('browserTool',ms);health.mark('browser','ready')}else{const notice=health.failure('browser','tool');if(notice)send({type:'health-notice',text:notice})}}else if(!ok&&tool!=='hud'){const notice=health.failure('tools','tool');if(notice)send({type:'health-notice',text:notice})}else if(ok&&tool!=='hud')health.mark('tools','ready')},
})
server.on('upgrade',(req,socket,head)=>{
  const path=(req.url??'/').split('?')[0], tool=path==='/tools'
  const auth=req.headers.authorization===`Bearer ${TOKEN}`
  if((tool&&!auth)||(!tool&&((path!=='/'&&path!=='/ws')||!originAllowed(req.headers.origin)))){socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');socket.destroy();return}
  wss.handleUpgrade(req,socket,head,(ws)=>wss.emit('connection',ws,req))
})
wss.on('connection',(socket,req)=>{
  if((req.url??'').startsWith('/tools')){
    health.mark('tools','ready')
    socket.on('close',()=>health.mark('tools','idle'))
    socket.on('message',async(raw)=>{let m;try{m=JSON.parse(raw)}catch{return}try{socket.send(JSON.stringify({id:m.id,result:await route(m.tool,m.args)}))}catch(e){socket.send(JSON.stringify({id:m.id,error:String(e?.message??e)}))}})
    return
  }
  frontend=socket;health.mark('frontend','ready');socket.send(JSON.stringify({type:'ready',servers:[conversation.state==='ready'?'ai-core-ready':conversation.state==='fallback'?'ai-core-fallback':'ai-core-warming','jarvis-tools','hud','vision']}))
  const seenAsks=new Set()
  socket.on('message',(raw)=>{
    let m;try{m=JSON.parse(raw)}catch{return}
    if(m.type==='screen-status'){screenSharing=m.sharing===true;return}
    if((m.type==='reply'||m.type==='approval-reply')&&m.id){const p=waiting.get(m.id);if(p){clearTimeout(p.timer);waiting.delete(m.id);p.ok(m)}return}
    if(m.type==='interrupt'){conversation.cancel();return}
    if(m.type!=='ask'||typeof m.text!=='string')return
    if(Buffer.byteLength(m.text)>32*1024)return send({type:'error',ask:m.id??null,message:'The request is too large.'})
    if(typeof m.id==='string'){
      if(seenAsks.has(m.id))return
      seenAsks.add(m.id)
      if(seenAsks.size>64)seenAsks.delete(seenAsks.values().next().value)
    }
    if(conversation.busy)conversation.cancel();askId=typeof m.id==='string'?m.id:null
    const currentAsk=askId
    if(/^(?:run diagnostics|what(?:'s| is) wrong with you|why are you slow|check your systems|are all systems healthy|recover yourself)[.!?]*$/i.test(m.text.trim())){
      if(/^recover yourself/i.test(m.text.trim())&&conversation.state!=='ready')void conversation.warm().catch(()=>{})
      const spoken=diagnosticText(health.snapshot({pendingRequests:waiting.size,model:conversation.model}))
      send({type:'route',engine:'local',ask:currentAsk});send({type:'text',delta:spoken,ask:currentAsk,diagnostics:true});send({type:'done',text:spoken,ask:currentAsk,local:true});return
    }
    if(/\bcan you see my screen\b/i.test(m.text)){
      const spoken=screenSharing?'Your screen is being shared, sir. I can inspect it when you ask.':"Not yet, sir. Share your screen and I'll have a look."
      send({type:'route',engine:'local',ask:askId});send({type:'text',delta:spoken,ask:askId});send({type:'done',text:spoken,ask:askId,local:true});return
    }
    if(!screenSharing&&screenQuestion(m.text)){
      const spoken="Screen sharing is off, sir. Use the SCREEN OFF control to share a screen, window, or tab, then I'll have a look."
      send({type:'route',engine:'local',ask:askId});send({type:'text',delta:spoken,ask:askId});send({type:'done',text:spoken,ask:askId,local:true});return
    }
    const fast=matchFastPath(m.text)
    if(fast){
      send({type:'route',engine:'local',ask:askId})
      send({type:'tool',name:`local ${fast.tool}`,ask:askId})
      const localStarted=performance.now()
      void route(fast.tool,fast.args,currentAsk).then(value=>{
        health.timing('localCommand',performance.now()-localStarted)
        const spoken=value?.denied?value.message:fast.spoken
        if(spoken)send({type:'text',delta:spoken,ask:currentAsk})
        send({type:'done',text:spoken||'',ask:currentAsk,local:true})
      }).catch(e=>send({type:'error',message:`${fast.tool==='shell'&&/npm run build/.test(fast.args.args?.join(' ')??'')?'The build failed, sir. ':''}${String(e?.message??e)}`,ask:currentAsk,local:true}))
      return
    }
    send({type:'route',engine:'codex',ask:askId})
    const prompt=screenSharing&&screenQuestion(m.text)?`${m.text}\n[The user is sharing a screen. For visible screen content, use the vision tool with source=screen before answering. Use browser read instead if accessible page text already answers the question. Screen observation does not authorize actions.]`:m.text
    void conversation.ask(prompt).then(text=>send({type:'done',text,ask:currentAsk})).catch(e=>send({type:'error',message:String(e?.message??e),ask:currentAsk}))
  })
  socket.on('close',()=>{if(frontend===socket){frontend=null;screenSharing=false;health.mark('frontend','recovering');health.failure('frontend','disconnect')}if(conversation.busy)conversation.cancel();for(const [id,p]of waiting){clearTimeout(p.timer);p.no(new Error('Interface disconnected.'));waiting.delete(id)}})
})
server.listen(PORT,HOST,()=>{console.log(`[jarvis] bridge listening on ws://${HOST}:${PORT}`);console.log(`[jarvis] backend ${appServerModelLabel(conversation)} via persistent app-server with exec fallback`);console.log(`[jarvis] speech ${fishConfigured(fishEnv)?`Fish Audio ${FISH_MODEL} with local fallback`:'local Kokoro/system'}`)})
function shutdown(){conversation.close();server.close()}
process.on('SIGINT',shutdown)
process.on('SIGTERM',shutdown)
