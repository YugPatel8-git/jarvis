import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { performance } from 'node:perf_hooks'
import { WebSocket } from 'ws'

const PORT = Number(process.env.JARVIS_CHROME_PORT ?? 9223)
const profile = resolve('.jarvis','chrome-profile')
const candidates = [process.env.JARVIS_CHROME_PATH, process.env.ProgramFiles && resolve(process.env.ProgramFiles,'Google/Chrome/Application/chrome.exe'), process.env['ProgramFiles(x86)'] && resolve(process.env['ProgramFiles(x86)'],'Google/Chrome/Application/chrome.exe'), process.env.LOCALAPPDATA && resolve(process.env.LOCALAPPDATA,'Google/Chrome/Application/chrome.exe')].filter(Boolean)
let cdpSeq = 0
const wait = (ms) => new Promise((r) => setTimeout(r,ms))
async function api(path='/json') {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { signal:AbortSignal.timeout(2500) })
  if (!r.ok) throw new Error(`Chrome DevTools returned ${r.status}`)
  return r.json()
}
async function ensure(url='about:blank') {
  try { await api('/json/version'); return } catch {}
  const exe=candidates.find(existsSync)
  if (!exe) throw new Error('Google Chrome was not found. Set JARVIS_CHROME_PATH.')
  spawn(exe,[`--remote-debugging-port=${PORT}`,`--user-data-dir=${profile}`,'--no-first-run','--no-default-browser-check',url],{detached:true,stdio:'ignore',windowsHide:false}).unref()
  for(let i=0;i<20;i++){ await wait(150); try { await api('/json/version'); return } catch {} }
  throw new Error('Chrome local automation endpoint did not start.')
}
async function tabs(){ await ensure(); return (await api('/json')).filter((t)=>t.type==='page') }
async function cdp(target,method,params={}) {
  return new Promise((ok,no)=>{
    // CDP request ids are protocol integers. Epoch milliseconds exceed the
    // 32-bit range accepted by current Chrome builds and receive no response.
    const ws=new WebSocket(target.webSocketDebuggerUrl), id=++cdpSeq
    const timer=setTimeout(()=>{ws.close();no(new Error('Chrome operation timed out'))},10000)
    ws.on('open',()=>ws.send(JSON.stringify({id,method,params})))
    ws.on('message',(raw)=>{const m=JSON.parse(raw);if(m.id!==id)return;clearTimeout(timer);ws.close();if(m.error)no(new Error(m.error.message));else ok(m.result)})
    ws.on('error',no)
  })
}
function url(raw){const u=new URL(String(raw));if(!['http:','https:'].includes(u.protocol))throw new Error('Only http(s) navigation is allowed.');return u.href}
export async function browserAction(a) {
  const operationStarted=performance.now()
  let op=a.operation
  if(['open','navigate','search','youtube_search'].includes(op)){
    let dest=a.url
    if(op==='search')dest=`https://www.google.com/search?q=${encodeURIComponent(a.query??'')}`
    if(op==='youtube_search')dest=`https://www.youtube.com/results?search_query=${encodeURIComponent(a.query??'')}`
    dest=url(dest); await ensure()
    if(op==='open'){const r=await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(dest)}`,{method:'PUT'});if(!r.ok)throw new Error('Chrome refused the tab.');return {opened:dest}}
    const t=(await tabs())[0]; if(!t) return browserAction({operation:'open',url:dest})
    await cdp(t,'Page.navigate',{url:dest}); return {navigated:dest}
  }
  const list=await tabs()
  if(op==='tabs')return list.map(({id,title,url})=>({id,title,url}))
  if(op==='close_all'){for(const item of list)await fetch(`http://127.0.0.1:${PORT}/json/close/${encodeURIComponent(item.id)}`);return {closed:list.length}}
  if(op==='next_tab'||op==='previous_tab'){
    if(!list.length)throw new Error('No Chrome tab is available.')
    const index=op==='next_tab'?(list.length>1?1:0):list.length-1
    const chosen=list[index]
    const r=await fetch(`http://127.0.0.1:${PORT}/json/activate/${encodeURIComponent(chosen.id)}`)
    return {activated:r.ok,id:chosen.id,title:chosen.title}
  }
  const t=list.find((x)=>x.id===a.tabId)??list[0]; if(!t)throw new Error('No Chrome tab is available.')
  if(op==='close'||op==='activate'){const r=await fetch(`http://127.0.0.1:${PORT}/json/${op}/${encodeURIComponent(t.id)}`);return {[op+'d']:r.ok,id:t.id}}
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
      let cleanupMs=0
      while(walker.nextNode()){
        const parent=walker.currentNode.parentElement
        if(!parent||parent.closest(skip))continue
        const style=getComputedStyle(parent)
        if(style.display==='none'||style.visibility==='hidden'||Number(style.opacity)===0||!parent.getClientRects().length)continue
        const cleanAt=performance.now()
        const line=(walker.currentNode.nodeValue||'').replace(/\\s+/g,' ').trim()
        cleanupMs+=performance.now()-cleanAt
        if(line.length<2||seen.has(line))continue
        seen.add(line);lines.push(line)
        if(lines.join('\\n').length>=18000)break
      }
      const cleanAt=performance.now(),text=lines.join('\\n').slice(0,18000)
      cleanupMs+=performance.now()-cleanAt
      return {text,extractionMs:performance.now()-began-cleanupMs,cleanupMs}
    })()`
    const cdpStarted=performance.now()
    const r=await cdp(t,'Runtime.evaluate',{expression,returnByValue:true})
    const value=r.result?.value??{text:'',extractionMs:0,cleanupMs:0}
    return {title:t.title,url:t.url,text:value.text,timings:{browserToolMs:performance.now()-operationStarted,roundTripMs:performance.now()-cdpStarted,extractionMs:value.extractionMs,cleanupMs:value.cleanupMs}}
  }
  if(op==='click'){const sel=JSON.stringify(String(a.selector??''));const r=await cdp(t,'Runtime.evaluate',{expression:`(()=>{const e=document.querySelector(${sel});if(!e)return "not found";e.click();return "clicked"})()`,returnByValue:true});return {result:r.result?.value}}
  if(op==='type'){const sel=JSON.stringify(String(a.selector??'')),val=JSON.stringify(String(a.value??''));const r=await cdp(t,'Runtime.evaluate',{expression:`(()=>{const e=document.querySelector(${sel});if(!e)return "not found";e.focus();e.value=${val};e.dispatchEvent(new Event("input",{bubbles:true}));e.dispatchEvent(new Event("change",{bubbles:true}));return "entered"})()`,returnByValue:true});return {result:r.result?.value}}
  if(op==='screenshot'){await cdp(t,'Page.enable');const r=await cdp(t,'Page.captureScreenshot',{format:'jpeg',quality:75});return {image:r.data,mimeType:'image/jpeg'}}
  throw new Error(`Unsupported browser operation: ${op}`)
}
