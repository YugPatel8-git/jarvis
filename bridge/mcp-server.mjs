import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { callRouter } from './tool-client.mjs'

const server=new McpServer({name:'jarvis-local-tools',version:'1.0.0'},{instructions:'All actions are classified by the JARVIS permission router. Normal actions run automatically. High-risk actions pause for a single explicit user approval. Never bypass or simulate approval.'})
const response=(v)=>({content:[{type:'text',text:JSON.stringify(v)}]})
let lastVision={hash:null,at:0}
const tool=(name,description,schema)=>server.tool(name,description,schema,async(a)=>{
  const v=await callRouter(name,a)
  if(name==='vision'&&v?.data){
    const hash=createHash('sha256').update(v.data).digest('hex'), now=Date.now()
    if(lastVision.hash===hash&&now-lastVision.at<60000)return {content:[{type:'text',text:'The requested image is unchanged from the previous frame.'}]}
    lastVision={hash,at:now}
    return {content:[{type:'text',text:a.source==='screen'?'Current user-shared screen frame.':'Camera capture requested by the user.'},{type:'image',data:v.data,mimeType:v.mimeType??'image/jpeg'}]}
  }
  if(name==='vision'&&v?.unchanged)return {content:[{type:'text',text:'The shared screen is unchanged from the previous frame; use the previous image context.'}]}
  if(name==='browser'&&v?.image)return {content:[{type:'text',text:'Screenshot of the current isolated Chrome tab.'},{type:'image',data:v.image,mimeType:v.mimeType??'image/jpeg'}]}
  return response(v)
})
tool('browser','Control isolated Chrome. After a model-driven search, prefer search_results for at most five title/URL/snippet records; use read for cleaned visible article text.',{
  operation:z.enum(['open','navigate','search','youtube_search','search_results','tabs','close','close_all','next_tab','previous_tab','activate','click','type','scroll','read','screenshot']),
  url:z.string().optional(),query:z.string().optional(),tabId:z.string().optional(),selector:z.string().optional(),label:z.string().optional(),value:z.string().optional(),y:z.number().optional(),
})
tool('shell','Run a normal local executable with structured arguments, or a PowerShell script. The router blocks high-risk execution for approval.',{
  command:z.string().optional(),args:z.array(z.string()).optional(),script:z.string().optional(),cwd:z.string().optional(),
})
tool('filesystem','Read/list/stat or create/write/move/delete ordinary files. Credential locations and destructive operations are approval-gated.',{
  operation:z.enum(['read','list','stat','open','mkdir','write','move','delete']),path:z.string(),destination:z.string().optional(),content:z.string().optional(),overwrite:z.boolean().optional(),recursive:z.boolean().optional(),
})
tool('hud','Show a sanitized JARVIS panel or blade, or change the HUD through constrained operations. For panel/blade value, supply title and html; optional kind, size, slot, accent, animation, and hold are normalized by the router.',{
  kind:z.enum(['panel','blade','ui']),operation:z.string().optional(),value:z.record(z.string(),z.unknown()),
})
tool('vision','Capture one camera frame or one currently shared screen frame. Use source=screen only for a user question about visible screen content; if sharing is off, report that it is unavailable. Prefer browser read for accessible webpage text. Never capture speculatively.',{
  source:z.enum(['camera','screen']).default('camera'),mode:z.enum(['look','watch']).default('look'),reason:z.string().optional(),seconds:z.number().min(2).max(15).optional(),when:z.enum(['now','past']).optional(),
})
await server.connect(new StdioServerTransport())
