import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { callRouter } from './tool-client.mjs'

const server=new McpServer({name:'jarvis-local-tools',version:'1.0.0'},{instructions:'All actions are classified by the JARVIS permission router. Normal actions run automatically. High-risk actions pause for a single explicit user approval. Never bypass or simulate approval.'})
const response=(v)=>({content:[{type:'text',text:JSON.stringify(v)}]})
const tool=(name,description,schema)=>server.tool(name,description,schema,async(a)=>{
  const v=await callRouter(name,a)
  if(name==='vision'&&v?.data)return {content:[{type:'text',text:'Camera capture requested by the user.'},{type:'image',data:v.data,mimeType:v.mimeType??'image/jpeg'}]}
  if(name==='browser'&&v?.image)return {content:[{type:'text',text:'Screenshot of the current isolated Chrome tab.'},{type:'image',data:v.image,mimeType:v.mimeType??'image/jpeg'}]}
  return response(v)
})
tool('browser','Control an isolated local Chrome profile: open/navigate/search tabs, click ordinary selectors, scroll, read, or screenshot.',{
  operation:z.enum(['open','navigate','search','youtube_search','tabs','close','activate','click','type','scroll','read','screenshot']),
  url:z.string().optional(),query:z.string().optional(),tabId:z.string().optional(),selector:z.string().optional(),label:z.string().optional(),value:z.string().optional(),y:z.number().optional(),
})
tool('shell','Run a normal local executable with structured arguments, or a PowerShell script. The router blocks high-risk execution for approval.',{
  command:z.string().optional(),args:z.array(z.string()).optional(),script:z.string().optional(),cwd:z.string().optional(),
})
tool('filesystem','Read/list/stat or create/write/move/delete ordinary files. Credential locations and destructive operations are approval-gated.',{
  operation:z.enum(['read','list','stat','mkdir','write','move','delete']),path:z.string(),destination:z.string().optional(),content:z.string().optional(),overwrite:z.boolean().optional(),recursive:z.boolean().optional(),
})
tool('hud','Show a sanitized JARVIS panel/blade, or change the HUD through its existing constrained operations.',{
  kind:z.enum(['panel','blade','ui']),operation:z.string().optional(),value:z.record(z.string(),z.unknown()),
})
tool('vision','Capture one requested camera frame or a short frame grid. Never use speculatively; browser camera permission still applies.',{
  mode:z.enum(['look','watch']).default('look'),reason:z.string().optional(),seconds:z.number().min(2).max(15).optional(),when:z.enum(['now','past']).optional(),
})
await server.connect(new StdioServerTransport())
