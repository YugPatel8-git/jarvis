import process from 'node:process'
import { resolve } from 'node:path'

const clean = (text) => String(text ?? '').trim().replace(/[.!?]+$/,'')
const result = (tool,args,spoken) => ({tool,args,spoken})
const responses = {
  chromeOpen: ['Chrome is open, sir.', 'Chrome is open, sir. The internet awaits.', 'Chrome is open. Try to keep the tab count civilized, sir.'],
  chromeClose: ['Chrome is closed, sir.', 'Chrome is closed. A brief moment of peace, sir.'],
  youtubeOpen: ['YouTube is open, sir.', 'YouTube is open. An ambitious use of free time, sir.'],
  codeOpen: ['VS Code is open, sir.', "VS Code is open. Let's see what the code has planned for us, sir."],
  build: ['The build completed, sir.', 'The build completed. The compiler was cooperative for once, sir.'],
  lint: ['Lint completed, sir.', 'Lint completed. The code has had its inspection, sir.'],
}
const previous = new Map()
function say(kind) {
  const pool = responses[kind]
  const next = ((previous.get(kind) ?? -1) + 1) % pool.length
  previous.set(kind, next)
  return pool[next]
}

export function matchFastPath(input) {
  const raw=clean(input), lower=raw.toLowerCase()
  let m
  if(lower==='open chrome')return result('browser',{operation:'open',url:'https://www.google.com/'},say('chromeOpen'))
  if(lower==='close chrome')return result('browser',{operation:'close_all'},say('chromeClose'))
  if(lower==='open youtube')return result('browser',{operation:'open',url:'https://www.youtube.com/'},say('youtubeOpen'))
  if((m=/^(?:search google for|google)\s+(.+)$/i.exec(raw)))return result('browser',{operation:'search',query:m[1].trim()},`Searching Google for ${m[1].trim()}, sir.`)
  if((m=/^(?:search youtube for|youtube search(?: for)?)\s+(.+)$/i.exec(raw)))return result('browser',{operation:'youtube_search',query:m[1].trim()},`Searching YouTube for ${m[1].trim()}, sir.`)
  if((m=/^(?:open (?:this )?(?:url|website)|go to)\s+(https?:\/\/\S+)$/i.exec(raw)))return result('browser',{operation:'open',url:m[1]},'The page is open.')
  if(lower==='close tab'||lower==='close this tab'||lower==='tab close')return result('browser',{operation:'close'},'That tab is closed, sir.')
  if(lower==='next tab'||lower==='switch to next tab'||lower==='tab next')return result('browser',{operation:'next_tab'},'Next tab.')
  if(lower==='previous tab'||lower==='switch to previous tab'||lower==='tab previous')return result('browser',{operation:'previous_tab'},'Previous tab.')
  if(lower==='scroll down')return result('browser',{operation:'scroll',y:700},'')
  if(lower==='scroll up')return result('browser',{operation:'scroll',y:-700},'')

  if(lower==='open downloads'||lower==='open my downloads')return result('shell',{command:'explorer.exe',args:[resolve(process.env.USERPROFILE??'.','Downloads')]},'Downloads is open, sir.')
  if(lower==='open vs code'||lower==='open visual studio code')return result('shell',{command:process.env.ComSpec??'C:\\Windows\\System32\\cmd.exe',args:['/d','/s','/c','code']},say('codeOpen'))
  if(lower==='open notepad')return result('shell',{command:'notepad.exe',args:[]},'Notepad is open, sir.')
  if(lower==='open calculator')return result('shell',{command:'calc.exe',args:[]},'Calculator is open.')
  if(lower==='close vs code'||lower==='close visual studio code')return result('shell',{command:'taskkill.exe',args:['/im','Code.exe']},'VS Code is closed, sir.')

  if((m=/^open (?:the )?(?:file|folder)\s+(.+)$/i.exec(raw)))return result('filesystem',{operation:'open',path:m[1].trim()},'Opened.')
  if((m=/^create (?:a )?folder\s+(.+)$/i.exec(raw)))return result('filesystem',{operation:'mkdir',path:m[1].trim()},'The folder is ready, sir.')
  if((m=/^mkdir\s+(.+)$/i.exec(raw)))return result('filesystem',{operation:'mkdir',path:m[1].trim()},'Folder created.')
  if(lower==='run node --version'||lower==='node version')return result('shell',{command:process.execPath,args:['--version']},'Node version checked.')
  if(lower==='run npm --version'||lower==='npm version')return result('shell',{command:process.env.ComSpec??'C:\\Windows\\System32\\cmd.exe',args:['/d','/s','/c','npm --version']},'npm version checked.')
  if(lower==='run git status'||lower==='git status')return result('shell',{command:'git',args:['status','--short']},'Git status checked.')
  if(lower==='run the build'||lower==='run npm build'||lower==='npm run build')return result('shell',{command:process.env.ComSpec??'C:\\Windows\\System32\\cmd.exe',args:['/d','/s','/c','npm run build']},say('build'))
  if(lower==='run lint'||lower==='run npm lint'||lower==='npm run lint')return result('shell',{command:process.env.ComSpec??'C:\\Windows\\System32\\cmd.exe',args:['/d','/s','/c','npm run lint']},say('lint'))
  return null
}
