import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve, isAbsolute, basename } from 'node:path'
import process from 'node:process'
import { performance } from 'node:perf_hooks'
import { createCdpPool } from './cdp.mjs'
import { youtubeMusic } from './youtube-music.mjs'

export function createBrowserController({ env=process.env, fetchImpl=fetch, spawnProcess=spawn, exists=existsSync, pool=createCdpPool(), sleep=ms=>new Promise(r=>setTimeout(r,ms)) }={}) {
const sessions=new Map()
let selected='chrome'
function session(name=selected) {
  if(!['chrome','brave'].includes(name))throw new Error('Supported browsers are Chrome and Brave.')
  if(sessions.has(name))return sessions.get(name)
  const brave=name==='brave', label=brave?'Brave':'Chrome', key=brave?'BRAVE':'CHROME'
  const port=Number(env[`JARVIS_${key}_PORT`]??(brave?9224:9223))
  if(!Number.isInteger(port)||port<1024||port>65535)throw new Error(`${label} automation port must be between 1024 and 65535.`)
  const relative=brave?'BraveSoftware/Brave-Browser/Application/brave.exe':'Google/Chrome/Application/chrome.exe'
  const override=env[`JARVIS_${key}_PATH`]
  // Accept an executable path, never shell text or user-supplied launch flags.
  if(override&&(!isAbsolute(override)||basename(override).toLowerCase()!==(brave?'brave.exe':'chrome.exe')))throw new Error(`JARVIS_${key}_PATH must be an absolute path to ${brave?'brave.exe':'chrome.exe'}.`)
  const candidates=override?[override]:[env.ProgramFiles,env['ProgramFiles(x86)'],env.LOCALAPPDATA].filter(Boolean).map(root=>resolve(root,relative))
  let launching=null, retryAt=0
  async function request(path,method='GET',json=true){
    let r
    try{r=await fetchImpl(`http://127.0.0.1:${port}${path}`,{method,signal:AbortSignal.timeout(2500)})}
    catch(e){throw new Error(`${label} automation endpoint 127.0.0.1:${port} is unreachable: ${e.cause?.code??e.message}`)}
    if(!r.ok)throw new Error(`${label} DevTools ${path.split('?')[0]} returned HTTP ${r.status}`)
    return json?r.json():true
  }
  async function probe(){
    const v=await request('/json/version')
    const endpoint=new URL(v.webSocketDebuggerUrl)
    if(!['ws:','wss:'].includes(endpoint.protocol)||!['127.0.0.1','localhost'].includes(endpoint.hostname)||Number(endpoint.port)!==port)throw new Error(`${label} endpoint did not identify a local DevTools browser.`)
    return v
  }
  async function ensure(){
    try{await probe();return}catch{}
    if(launching)return launching
    if(Date.now()<retryAt)throw new Error(`${label} automation is cooling down after a failed connection.`)
    const exe=candidates.find(exists)
    if(!exe)throw new Error(`${label} executable was not found. Set JARVIS_${key}_PATH to its installed executable.`)
    launching=(async()=>{
      let launchError
      let child
      try{child=spawnProcess(exe,['--remote-debugging-address=127.0.0.1',`--remote-debugging-port=${port}`,`--user-data-dir=${resolve('.jarvis',name+'-profile')}`,'--no-first-run','--no-default-browser-check','about:blank'],{shell:false,detached:true,stdio:'ignore',windowsHide:true})}
      catch(e){throw new Error(`${label} launch failed: ${e.message}`)}
      child.on('error',e=>{launchError=e});child.unref()
      for(let i=0;i<20;i++){await sleep(150);if(launchError)throw new Error(`${label} launch failed: ${launchError.message}`);try{await probe();return}catch{}}
      throw new Error(`${label} launched but its local automation endpoint did not become accessible. Ordinary browser windows cannot be controlled without that endpoint.`)
    })()
    try{return await launching}catch(e){retryAt=Date.now()+30000;throw e}finally{launching=null}
  }
  async function tabs(ready=false){
    if(!ready)await ensure()
    return (await request('/json')).filter(t=>t.type==='page')
  }
  async function status(){
    const installed=candidates.some(exists)
    try{await probe();await tabs(true);return {browser:name,installed,connected:true}}
    catch(e){return {browser:name,installed,connected:false,reason:e.message}}
  }
  const value={name,label,request,ensure,tabs,status}
  sessions.set(name,value);return value
}
async function cdp(target,method,params={}) {
  const r=await pool.request(target,method,params)
  if(r.exceptionDetails)throw new Error(`Browser page evaluation failed: ${r.exceptionDetails.text||'JavaScript exception'}`)
  if(r.errorText)throw new Error(`Browser navigation failed: ${r.errorText}`)
  return r
}
function url(raw){const u=new URL(String(raw));if(!['http:','https:'].includes(u.protocol))throw new Error('Only http(s) navigation is allowed.');return u.href}
async function open(s,dest){
  await s.ensure()
  const target=await s.request(`/json/new?${encodeURIComponent(dest)}`,'PUT')
  if(!target?.id)throw new Error(`${s.label} did not return an opened tab.`)
  await s.request(`/json/activate/${encodeURIComponent(target.id)}`,'GET',false)
  return target
}
return async function browserAction(a) {
  const operationStarted=performance.now()
  let op=a.operation
  if(op==='capabilities'){
    const browsers=await Promise.all(['chrome','brave'].map(name=>session(name).status()))
    const connected=browsers.filter(b=>b.connected).map(b=>b.browser), installed=browsers.filter(b=>b.installed).map(b=>b.browser)
    const message=connected.length?`Browser control is connected to ${connected.join(' and ')}, sir. Site sign-in and playback still need to be checked.`:installed.length?`Browser commands are configured for ${installed.join(' and ')}, sir, but no automation session is connected yet. An open command can start one; ordinary browser windows are not currently accessible.`:'The browser router is running, but no supported browser executable or automation connection was found.'
    return {browsers,message}
  }
  if(a.browser)selected=session(a.browser).name
  let s=session()
  if(op==='youtube_music'){
    if(!a.browser){
      for(const name of [selected,selected==='chrome'?'brave':'chrome']){
        const candidate=session(name)
        try{const list=await candidate.tabs(true);if(list.some(t=>{try{return new URL(t.url).hostname==='music.youtube.com'}catch{return false}})){s=candidate;selected=name;break}}catch{}
      }
    }
    return youtubeMusic(a,{session:s,cdp,open,sleep})
  }
  if(['open','navigate','search','youtube_search'].includes(op)){
    let dest=a.url
    if(op==='search')dest=`https://www.google.com/search?q=${encodeURIComponent(a.query??'')}`
    if(op==='youtube_search')dest=`https://www.youtube.com/results?search_query=${encodeURIComponent(a.query??'')}`
    dest=url(dest); await s.ensure()
    if(op==='open'){const t=await open(s,dest);return {opened:dest,tabId:t.id,browser:s.name}}
    const list=await s.tabs(true), t=a.tabId?list.find(t=>t.id===a.tabId):list[0]
    if(!t){if(a.tabId)throw new Error('Requested browser tab is no longer available.');const t=await open(s,dest);return {opened:dest,tabId:t.id,browser:s.name}}
    await cdp(t,'Page.navigate',{url:dest}); return {navigated:dest,browser:s.name}
  }
  const list=await s.tabs()
  if(op==='tabs')return list.map(({id,title,url})=>({id,title,url,browser:s.name}))
  if(op==='close_all'){await Promise.all(list.map(item=>s.request(`/json/close/${encodeURIComponent(item.id)}`,'GET',false)));return {closed:list.length}}
  if(op==='next_tab'||op==='previous_tab'){
    if(!list.length)throw new Error(`No ${s.label} tab is available.`)
    const index=op==='next_tab'?(list.length>1?1:0):list.length-1
    const chosen=list[index]
    await s.request(`/json/activate/${encodeURIComponent(chosen.id)}`,'GET',false)
    return {activated:true,id:chosen.id,title:chosen.title}
  }
  const t=a.tabId?list.find(x=>x.id===a.tabId):list[0]; if(!t)throw new Error(`Requested ${s.label} tab is not available.`)
  if(op==='close'||op==='activate'){await s.request(`/json/${op}/${encodeURIComponent(t.id)}`,'GET',false);return {[op==='close'?'closed':'activated']:true,id:t.id}}
  if(op==='scroll'){const y=Math.max(-5000,Math.min(5000,Number(a.y)||650));await cdp(t,'Runtime.evaluate',{expression:`scrollBy({top:${y},behavior:"smooth"})`});return {scrolled:y}}
  if(op==='search_results'){
    const expression=`(()=>{
      const out=[],seen=new Set()
      for(const a of document.querySelectorAll('a[href]')){
        const title=(a.innerText||a.textContent||'').replace(/\\s+/g,' ').trim()
        let href;try{href=new URL(a.href,location.href).href}catch{continue}
        if(title.length<3||!/^https?:/.test(href)||seen.has(href))continue
        const parsed=new URL(href), path=parsed.pathname
        if(parsed.hostname===location.hostname&&(path==='/search'||path.startsWith('/search/')||path==='/results'||path.startsWith('/results/')))continue
        const snippet=(a.closest('article,li,[data-testid],div')?.innerText||'').replace(/\\s+/g,' ').trim().slice(0,240)
        seen.add(href);out.push({title:title.slice(0,160),url:href,snippet})
        if(out.length===5)break
      }
      return out
    })()`
    const r=await cdp(t,'Runtime.evaluate',{expression,returnByValue:true})
    return {results:r.result?.value??[]}
  }
  if(op==='read'){
    const expression=`(()=>{
      const began=performance.now()
      const root=document.querySelector('article,main,[role="main"]')||document.body
      if(!root)return {text:'',extractionMs:0,cleanupMs:0}
      const skip='script,style,noscript,template,svg,canvas,nav,header,footer,aside,form,[hidden],[aria-hidden="true"],[class*="advert"],[class*="cookie"],[class*="popup"],[class*="modal"]'
      const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT),seen=new Set(),lines=[]
      const visibility=new WeakMap()
      let length=0
      let cleanupMs=0
      while(walker.nextNode()){
        const parent=walker.currentNode.parentElement
        if(!parent)continue
        let visible=visibility.get(parent)
        if(visible===undefined){
          const style=getComputedStyle(parent)
          visible=!parent.closest(skip)&&style.display!=='none'&&style.visibility!=='hidden'&&Number(style.opacity)!==0&&Boolean(parent.getClientRects().length)
          visibility.set(parent,visible)
        }
        if(!visible)continue
        const cleanAt=performance.now()
        const line=(walker.currentNode.nodeValue||'').replace(/\\s+/g,' ').trim()
        cleanupMs+=performance.now()-cleanAt
        if(line.length<2||seen.has(line))continue
        seen.add(line);lines.push(line);length+=line.length+1
        if(length>=18000)break
      }
      const cleanAt=performance.now(),text=lines.join('\\n').slice(0,18000)
      cleanupMs+=performance.now()-cleanAt
      const login=document.querySelector('input[type="password"]')
      const authenticationRequired=Boolean(login&&login.getClientRects().length)
      return {text,authenticationRequired,extractionMs:performance.now()-began-cleanupMs,cleanupMs}
    })()`
    const cdpStarted=performance.now()
    const r=await cdp(t,'Runtime.evaluate',{expression,returnByValue:true})
    const value=r.result?.value??{text:'',extractionMs:0,cleanupMs:0}
    return {title:t.title,url:t.url,text:value.text,authenticationRequired:Boolean(value.authenticationRequired),timings:{browserToolMs:performance.now()-operationStarted,roundTripMs:performance.now()-cdpStarted,extractionMs:value.extractionMs,cleanupMs:value.cleanupMs}}
  }
  if(op==='click'){const sel=JSON.stringify(String(a.selector??''));const r=await cdp(t,'Runtime.evaluate',{expression:`(()=>{const e=document.querySelector(${sel});if(!e)return "not found";e.click();return "clicked"})()`,returnByValue:true});return {result:r.result?.value}}
  if(op==='type'){const sel=JSON.stringify(String(a.selector??'')),val=JSON.stringify(String(a.value??''));const r=await cdp(t,'Runtime.evaluate',{expression:`(()=>{const e=document.querySelector(${sel});if(!e)return "not found";e.focus();e.value=${val};e.dispatchEvent(new Event("input",{bubbles:true}));e.dispatchEvent(new Event("change",{bubbles:true}));return "entered"})()`,returnByValue:true});return {result:r.result?.value}}
  if(op==='screenshot'){await cdp(t,'Page.enable');const r=await cdp(t,'Page.captureScreenshot',{format:'jpeg',quality:75});return {image:r.data,mimeType:'image/jpeg'}}
  throw new Error(`Unsupported browser operation: ${op}`)
}
}
export const browserAction=createBrowserController()
