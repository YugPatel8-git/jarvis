const HOME='https://music.youtube.com/'
const LIBRARY=HOME+'library'
const isMusic=raw=>{try{return new URL(raw).origin===new URL(HOME).origin}catch{return false}}

// Fixed site and controls only. No user-provided JavaScript, selectors, URLs, or credentials.
export function musicPageState(click=false) {
  if(location.origin!=='https://music.youtube.com')return {ready:false,reason:'YouTube Music redirected outside its music site; sign-in may be required.'}
  if(document.readyState==='loading')return {ready:false}
  const visible=e=>Boolean(e?.getClientRects().length)&&getComputedStyle(e).visibility!=='hidden'
  const signIn=[...document.querySelectorAll('a[href*="accounts.google.com"],ytmusic-nav-bar a,ytmusic-nav-bar button')].some(e=>visible(e)&&/^(sign in|log in)$/i.test((e.textContent||e.getAttribute('aria-label')||'').trim()))
  if(signIn)return {ready:true,authenticationRequired:true}
  if(!location.pathname.startsWith('/library'))return {ready:false}
  const root=document.querySelector('ytmusic-library-landing-page,ytmusic-library-landing-page-renderer,ytmusic-library-page')
  if(!visible(root))return {ready:false}
  const media=document.querySelector('video,audio')
  const playback={playing:Boolean(media&&!media.paused&&!media.ended&&media.readyState>=3),source:media?.currentSrc,time:media?.currentTime}
  if(!click)return {ready:true,...playback}
  // Never click the global player: it could resume an unrelated old queue.
  const controls=[...root.querySelectorAll('ytmusic-play-button-renderer,button,[role="button"]')]
  const play=controls.find(e=>visible(e)&&!e.disabled&&e.getAttribute('aria-disabled')!=='true'&&/^play(?:\b|$)/i.test(e.getAttribute('aria-label')||e.getAttribute('title')||''))
  if(!play)return {ready:true,controlMissing:true}
  play.click()
  return {ready:true,clicked:true,...playback}
}

export async function youtubeMusic(a,{session:s,cdp,open,sleep}) {
  const action=a.action??'open'
  if(!['open','library','play_library'].includes(action))throw new Error('Unsupported YouTube Music action.')
  const dest=action==='open'?HOME:LIBRARY
  await s.ensure()
  let target=(await s.tabs(true)).find(t=>isMusic(t.url))
  if(!target)target=await open(s,dest)
  else {
    await s.request(`/json/activate/${encodeURIComponent(target.id)}`,'GET',false)
    if(action!=='open'&&new URL(target.url).pathname!=='/library')await cdp(target,'Page.navigate',{url:dest})
  }
  const base={browser:s.name,tabId:target.id,opened:dest,playing:false}
  if(action==='open')return {...base,message:'YouTube Music is open, sir.'}
  const state=async click=>(await cdp(target,'Runtime.evaluate',{expression:`(${musicPageState.toString()})(${Boolean(click)})`,returnByValue:true})).result?.value
  let page
  for(let i=0;i<20;i++){
    try{page=await state(false)}catch(e){if(i===19)throw e}
    if(page?.ready||page?.reason)break
    await sleep(250)
  }
  if(page?.authenticationRequired)return {...base,authenticationRequired:true,message:'YouTube Music needs sign-in in the connected browser. Sign in there yourself, then ask me to play your library again.'}
  if(!page?.ready)return {...base,message:page?.reason??'YouTube Music opened, but its Library controls are not accessible yet. I have not started playback.'}
  if(action==='library')return {...base,libraryOpened:true,message:'Your YouTube Music Library is open, sir.'}
  const clicked=await state(true)
  if(clicked?.authenticationRequired)return {...base,authenticationRequired:true,message:'YouTube Music now requires sign-in in the connected browser. I have not started playback.'}
  if(!clicked?.clicked)return {...base,libraryOpened:true,message:'Your YouTube Music Library is open, but no accessible library Play control was found. I have not started playback.'}
  for(let i=0;i<12;i++){
    await sleep(250)
    const observed=await state(false)
    if(observed?.playing&&(!clicked.playing||observed.source!==clicked.source||observed.time<clicked.time-1))return {...base,libraryOpened:true,playing:true,message:'YouTube Music is playing from your library, sir.'}
  }
  return {...base,libraryOpened:true,playClicked:true,message:'I clicked Play in your YouTube Music Library, but the page has not confirmed playback. Autoplay restrictions or unavailable content may be blocking it.'}
}
