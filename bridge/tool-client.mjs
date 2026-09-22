import { WebSocket } from 'ws'
import process from 'node:process'

let seq=0
export function callRouter(tool,args){
  const port=Number(process.env.JARVIS_BRIDGE_PORT??8787), token=process.env.JARVIS_ROUTER_TOKEN
  if(!token)return Promise.reject(new Error('The JARVIS tool router token is unavailable.'))
  return new Promise((resolve,reject)=>{
    const ws=new WebSocket(`ws://127.0.0.1:${port}/tools`,{headers:{authorization:`Bearer ${token}`}})
    const id=String(++seq), timer=setTimeout(()=>{ws.close();reject(new Error('Tool router timed out.'))},130000)
    ws.on('open',()=>ws.send(JSON.stringify({id,tool,args})))
    ws.on('message',(raw)=>{const m=JSON.parse(raw);if(m.id!==id)return;clearTimeout(timer);ws.close();if(m.error)reject(new Error(m.error));else resolve(m.result)})
    ws.on('error',reject)
  })
}
