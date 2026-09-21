import http from 'node:http'
import { randomBytes } from 'node:crypto'
import process from 'node:process'
import { WebSocketServer, WebSocket } from 'ws'
import { CodexConversation, codexModelLabel } from './codex.mjs'
import { createRouter } from './router.mjs'

const HOST='127.0.0.1', PORT=Number(process.env.JARVIS_BRIDGE_PORT??8787)
const TOKEN=randomBytes(32).toString('hex')
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
  if(req.method==='GET'&&req.url==='/health'){res.writeHead(200,{...h,'content-type':'application/json'});return res.end(JSON.stringify({ok:true,backend:'codex',tools:true,tts:Boolean(eleven()),stt:Boolean(eleven())}))}
  if(req.method==='POST'&&req.url==='/tts'){
    const key=eleven();if(!key){res.writeHead(503,h);return res.end('ElevenLabs is not configured.')}
    const data=JSON.parse((await body(req,64*1024)).toString());const text=String(data.text??'').slice(0,5000)
    const up=await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${process.env.JARVIS_VOICE_ID??'JBFqnCBsd6RMkjVDRZzb'}/stream?output_format=mp3_22050_32&optimize_streaming_latency=3`,{method:'POST',headers:{'xi-api-key':key,'content-type':'application/json'},body:JSON.stringify({text,model_id:'eleven_flash_v2_5'})})
    res.writeHead(up.status,{...h,'content-type':up.headers.get('content-type')??'audio/mpeg','cache-control':'no-store'});for await(const c of up.body)res.write(c);return res.end()
  }
  if(req.method==='POST'&&req.url==='/stt'){
    const key=eleven();if(!key){res.writeHead(503,h);return res.end('ElevenLabs is not configured.')}
    const audio=await body(req,25*1024*1024), form=new FormData();form.append('model_id','scribe_v1');form.append('file',new Blob([audio],{type:req.headers['content-type']||'audio/webm'}),'speech.webm')
    const up=await fetch('https://api.elevenlabs.io/v1/speech-to-text',{method:'POST',headers:{'xi-api-key':key},body:form});res.writeHead(up.status,{...h,'content-type':'application/json','cache-control':'no-store'});return res.end(await up.text())
  }
  res.writeHead(404,h);res.end()
}
const server=http.createServer((q,s)=>handle(q,s).catch(e=>{if(!s.headersSent)s.writeHead(500);s.end(String(e?.message??e))}))
const wss=new WebSocketServer({noServer:true,maxPayload:2*1024*1024})
let frontend=null, seq=0
const waiting=new Map()
function send(msg){if(frontend?.readyState===WebSocket.OPEN)frontend.send(JSON.stringify(msg))}
function request(type,args,ms=120000){return new Promise((ok,no)=>{if(!frontend)return no(new Error('JARVIS interface is not connected.'));const id=`r${++seq}`,timer=setTimeout(()=>{waiting.delete(id);no(new Error(`${type} request timed out`))},ms);waiting.set(id,{ok,no,timer});send({type,id,...args})})}
const route=createRouter({
  requestApproval:(p)=>request('approval',p).then(x=>Boolean(x.approved)),
  request,
  emit:(type,payload)=>send({type,...payload}),
})
server.on('upgrade',(req,socket,head)=>{
  const path=(req.url??'/').split('?')[0], tool=path==='/tools'
  const auth=req.headers.authorization===`Bearer ${TOKEN}`
  if((tool&&!auth)||(!tool&&((path!=='/'&&path!=='/ws')||!originAllowed(req.headers.origin)))){socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');socket.destroy();return}
  wss.handleUpgrade(req,socket,head,(ws)=>wss.emit('connection',ws,req))
})
wss.on('connection',(socket,req)=>{
  if((req.url??'').startsWith('/tools')){
    socket.on('message',async(raw)=>{let m;try{m=JSON.parse(raw)}catch{return}try{socket.send(JSON.stringify({id:m.id,result:await route(m.tool,m.args)}))}catch(e){socket.send(JSON.stringify({id:m.id,error:String(e?.message??e)}))}})
    return
  }
  frontend=socket;socket.send(JSON.stringify({type:'ready',servers:['codex','jarvis-tools','hud','vision']}))
  let askId=null
  const conversation=new CodexConversation({cwd:process.cwd(),routerToken:TOKEN,onText:(delta)=>send({type:'text',delta,ask:askId}),onTool:(name)=>send({type:'tool',name,ask:askId})})
  socket.on('message',(raw)=>{
    let m;try{m=JSON.parse(raw)}catch{return}
    if((m.type==='reply'||m.type==='approval-reply')&&m.id){const p=waiting.get(m.id);if(p){clearTimeout(p.timer);waiting.delete(m.id);p.ok(m)}return}
    if(m.type==='interrupt'){conversation.cancel();return}
    if(m.type!=='ask'||typeof m.text!=='string')return
    if(Buffer.byteLength(m.text)>32*1024)return send({type:'error',ask:m.id??null,message:'The request is too large.'})
    if(conversation.child)conversation.cancel();askId=typeof m.id==='string'?m.id:null
    void conversation.ask(m.text).then(text=>send({type:'done',text,ask:askId})).catch(e=>send({type:'error',message:String(e?.message??e),ask:askId}))
  })
  socket.on('close',()=>{if(frontend===socket)frontend=null;conversation.close();for(const [id,p]of waiting){clearTimeout(p.timer);p.no(new Error('Interface disconnected.'));waiting.delete(id)}})
})
server.listen(PORT,HOST,()=>{console.log(`[jarvis] bridge listening on ws://${HOST}:${PORT}`);console.log(`[jarvis] backend ${codexModelLabel()} with routed local MCP tools`);console.log(`[jarvis] speech ${eleven()?'ElevenLabs enabled server-side':'system/Kokoro fallback'}`)})
