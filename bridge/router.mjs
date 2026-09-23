import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { open, writeFile, mkdir, rename, rm, readdir, stat } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import process from 'node:process'
import { classify, audit, HIGH_RISK, redact } from './security.mjs'
import { browserAction } from './browser.mjs'

const runFile=promisify(execFile)
const MAX_OUTPUT=64*1024
const timeout=Number(process.env.JARVIS_TOOL_TIMEOUT_MS??120000)
function clip(v){
  const ansi=new RegExp(String.fromCharCode(27)+'\\[[0-?]*[ -/]*[@-~]','g')
  let text=String(v??'').replace(ansi,'').replace(/\r(?!\n)/g,'\n')
  const lines=[], seen=new Map()
  for(const line of text.split(/\r?\n/)){
    const key=line.trim()
    const count=(seen.get(key)??0)+1;seen.set(key,count)
    if(!key||count<=3)lines.push(line)
  }
  text=lines.join('\n')
  if(text.length<=MAX_OUTPUT)return text
  return text.slice(0,16*1024)+'\n… output trimmed …\n'+text.slice(-(MAX_OUTPUT-16*1024-24))
}

async function shell(a){
  let command=String(a.command??'').trim(), args=Array.isArray(a.args)?a.args.map(String):[]
  if(a.script!==undefined){command=process.env.SystemRoot+'\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';args=['-NoProfile','-NonInteractive','-Command',String(a.script)]}
  if(!command)throw new Error('A command or PowerShell script is required.')
  try{
    const env={...process.env};delete env.FISH_AUDIO_API_KEY
    const r=await runFile(command,args,{cwd:a.cwd?resolve(String(a.cwd)):process.cwd(),timeout,maxBuffer:MAX_OUTPUT*4,windowsHide:true,shell:false,env})
    return {stdout:clip(r.stdout),stderr:clip(r.stderr)}
  }catch(err){
    const detail=[clip(err?.stdout),clip(err?.stderr),String(err?.killed?'Command timed out or was terminated.':'')].filter(Boolean).join('\n')
    throw new Error(detail||clip(err?.message??err))
  }
}
async function filesystem(a){
  const p=resolve(String(a.path??'.')), op=a.operation
  if(op==='read'){
    const file=await open(p,'r')
    try {
      const bytes=Buffer.allocUnsafe(MAX_OUTPUT+4)
      const {bytesRead}=await file.read(bytes,0,bytes.length,0)
      return {path:p,text:bytes.toString('utf8',0,bytesRead).slice(0,MAX_OUTPUT)}
    } finally { await file.close() }
  }
  if(op==='list')return {path:p,entries:await readdir(p,{withFileTypes:true}).then(xs=>xs.slice(0,1000).map(x=>({name:x.name,type:x.isDirectory()?'directory':'file'})))}
  if(op==='stat'){const s=await stat(p);return {path:p,size:s.size,directory:s.isDirectory(),modified:s.mtime.toISOString()}}
  if(op==='open'){await stat(p);await runFile('explorer.exe',[p],{timeout:10000,windowsHide:false,shell:false});return {opened:p}}
  if(op==='mkdir'){await mkdir(p,{recursive:true});return {created:p}}
  if(op==='write'){await mkdir(dirname(p),{recursive:true});await writeFile(p,String(a.content??''),{encoding:'utf8',flag:a.overwrite?'w':'wx'});return {written:p}}
  if(op==='move'){const d=resolve(String(a.destination));await mkdir(dirname(d),{recursive:true});if(!a.overwrite)await stat(d).then(()=>{throw new Error('Destination exists.')},()=>{});await rename(p,d);return {moved:p,destination:d}}
  if(op==='delete'){await rm(p,{recursive:Boolean(a.recursive),force:false});return {deleted:p}}
  throw new Error(`Unsupported filesystem operation: ${op}`)
}

export function createRouter({requestApproval,emit,request,onOutcome=()=>{}}){
  let hudSeq = 0
  return async function route(tool,args={},traceAsk=undefined){
    const started=performance.now()
    // The bridge owns environment secrets. MCP tools must not return them to
    // the model, even after a generic high-risk approval.
    const envFile = /(?:^|[\\/])\.env(?:\.[^\\/]*)?$/i
    const targetPaths = [args.path,args.destination].filter(Boolean).map(String)
    const shellText = [args.command,...(Array.isArray(args.args)?args.args:[]),args.script].filter(Boolean).join(' ')
    if ((tool==='filesystem'&&targetPaths.some(p=>envFile.test(p))) ||
        (tool==='shell'&&/\.env(?:\.[\w-]+)?\b/i.test(shellText))) {
      return {denied:true,message:'Environment files are reserved for the local bridge.'}
    }
    const policy=classify(tool,args)
    let approved=policy.classification!=='high-risk'
    await audit({tool,classification:policy.classification,approvalRequested:!approved,status:approved?'started':'awaiting-approval',args:redact(args)})
    const auditStartMs=performance.now()-started
    if(policy.classification===HIGH_RISK){
      approved=await requestApproval(policy)
      await audit({tool,classification:policy.classification,approvalRequested:true,approved,status:approved?'approved':'denied'})
      if(!approved)return {denied:true,message:'The user denied this specific high-risk action.'}
    }
    try{
      const actionStarted=performance.now()
      let result
      if(tool==='shell')result=await shell(args)
      else if(tool==='filesystem')result=await filesystem(args)
      else if(tool==='browser'){
        result=await browserAction(args)
        if(result.timings){emit('tool-timing',{tool:'browser',operation:args.operation,...result.timings});delete result.timings}
      }
      else if(tool==='hud'){
        const value=args.value??{}, id=String(value.id??`hud-${Date.now().toString(36)}-${++hudSeq}`)
        if(args.kind==='panel')emit('blade',{blade:{id,title:String(value.title??'JARVIS'),kind:'markup',html:String(value.html??value.markup??''),size:value.slot==='wide'?'wide':'compact',hold:value.hold??'turn'}})
        else if(args.kind==='blade')emit('blade',{blade:{id,title:String(value.title??'JARVIS'),kind:value.kind??'markup',url:value.url,images:value.images,html:String(value.html??value.markup??''),mode:value.mode,size:value.size??'compact',hold:value.hold??'turn'}})
        else emit('ui',{op:args.operation,args:value})
        result={displayed:true,id}
      }
      else if(tool==='vision')result=await request('capture',{source:args.source==='screen'?'screen':'camera',mode:args.mode??'look',reason:String(args.reason??'').slice(0,80),seconds:Math.max(2,Math.min(15,Number(args.seconds)||6)),when:args.when==='past'?'past':'now'},45000)
      else if(tool==='mcp')throw new Error('External MCP adapters are disabled until an explicitly allowlisted adapter can route every action through this permission layer.')
      else throw new Error(`Unknown tool: ${tool}`)
      const operationMs=performance.now()-actionStarted
      await audit({tool,classification:policy.classification,approvalRequested:policy.classification===HIGH_RISK,approved,success:true})
      emit('tool-timing',{tool,ask:traceAsk,operation:args.operation??null,auditStartMs:Number(auditStartMs.toFixed(2)),operationMs:Number(operationMs.toFixed(2)),auditFinishMs:Number((performance.now()-actionStarted-operationMs).toFixed(2)),routerTotalMs:Number((performance.now()-started).toFixed(2))})
      onOutcome(tool,true,performance.now()-started)
      return result
    }catch(err){
      await audit({tool,classification:policy.classification,approvalRequested:policy.classification===HIGH_RISK,approved,success:false,error:String(err?.message??err)})
      onOutcome(tool,false,performance.now()-started)
      throw err
    }
  }
}
