import process from 'node:process'
import { resolve } from 'node:path'

const clean = (text) => String(text ?? '').trim().replace(/[.!?]+$/,'')
const result = (tool,args,spoken) => ({tool,args,spoken})

export function matchFastPath(input) {
  const raw=clean(input), lower=raw.toLowerCase()
  let m
  if(lower==='open chrome')return result('browser',{operation:'open',url:'https://www.google.com/'},'Chrome is open.')
  if(lower==='close chrome')return result('browser',{operation:'close_all'},'Chrome is closed.')
  if(lower==='open youtube')return result('browser',{operation:'open',url:'https://www.youtube.com/'},'YouTube is open.')
  if((m=/^(?:search google for|google)\s+(.+)$/i.exec(raw)))return result('browser',{operation:'search',query:m[1].trim()},`Searching Google for ${m[1].trim()}.`)
  if((m=/^(?:search youtube for|youtube search(?: for)?)\s+(.+)$/i.exec(raw)))return result('browser',{operation:'youtube_search',query:m[1].trim()},`Searching YouTube for ${m[1].trim()}.`)
  if((m=/^(?:open (?:this )?(?:url|website)|go to)\s+(https?:\/\/\S+)$/i.exec(raw)))return result('browser',{operation:'open',url:m[1]},'The page is open.')
  if(lower==='close tab'||lower==='close this tab')return result('browser',{operation:'close'},'Tab closed.')
  if(lower==='next tab'||lower==='switch to next tab')return result('browser',{operation:'next_tab'},'Next tab.')
  if(lower==='previous tab'||lower==='switch to previous tab')return result('browser',{operation:'previous_tab'},'Previous tab.')
  if(lower==='scroll down')return result('browser',{operation:'scroll',y:700},'')
  if(lower==='scroll up')return result('browser',{operation:'scroll',y:-700},'')

  if(lower==='open downloads'||lower==='open my downloads')return result('shell',{command:'explorer.exe',args:[resolve(process.env.USERPROFILE??'.','Downloads')]},'Downloads is open.')
  if(lower==='open vs code'||lower==='open visual studio code')return result('shell',{command:process.env.ComSpec??'C:\\Windows\\System32\\cmd.exe',args:['/d','/s','/c','code']},'Visual Studio Code is open.')
  if(lower==='open notepad')return result('shell',{command:'notepad.exe',args:[]},'Notepad is open.')
  if(lower==='open calculator')return result('shell',{command:'calc.exe',args:[]},'Calculator is open.')
  if(lower==='close vs code'||lower==='close visual studio code')return result('shell',{command:'taskkill.exe',args:['/im','Code.exe']},'Visual Studio Code is closed.')

  if((m=/^open (?:the )?(?:file|folder)\s+(.+)$/i.exec(raw)))return result('filesystem',{operation:'open',path:m[1].trim()},'Opened.')
  if((m=/^create (?:a )?folder\s+(.+)$/i.exec(raw)))return result('filesystem',{operation:'mkdir',path:m[1].trim()},'Folder created.')
  if(lower==='run node --version')return result('shell',{command:process.execPath,args:['--version']},'Node version checked.')
  if(lower==='run npm --version')return result('shell',{command:process.env.ComSpec??'C:\\Windows\\System32\\cmd.exe',args:['/d','/s','/c','npm --version']},'npm version checked.')
  if(lower==='run git status'||lower==='git status')return result('shell',{command:'git',args:['status','--short']},'Git status checked.')
  if(lower==='run the build'||lower==='run npm build'||lower==='npm run build')return result('shell',{command:process.env.ComSpec??'C:\\Windows\\System32\\cmd.exe',args:['/d','/s','/c','npm run build']},'The build is complete.')
  if(lower==='run lint'||lower==='run npm lint'||lower==='npm run lint')return result('shell',{command:process.env.ComSpec??'C:\\Windows\\System32\\cmd.exe',args:['/d','/s','/c','npm run lint']},'Lint is complete.')
  return null
}
