import * as bridge from './bridge'
import type { Blade, Panel } from '../store'

export type Msg = { role: 'user' | 'assistant'; content: string }
export type AskHandlers = { onText: (delta: string) => void; onTool: (name: string) => void; onAck?: (text: string) => void }
export type { ConnectionState } from './bridge'
export const usingBridge = true
export function ask(prompt: string, _history: Msg[], handlers: AskHandlers) { return bridge.ask(prompt, handlers) }
export const warm = () => bridge.warmBridge()
export const watchServers = (fn: (servers: string[]) => void) => bridge.watchServers(fn)
export const watchPanels = (fn: (panel: Panel) => void) => bridge.watchPanels(fn)
export const watchBlades = (fn: (blade: Blade) => void) => bridge.watchBlades(fn)
export const watchUi = (fn: (op: string, args: any) => void) => bridge.watchUi(fn)
export const watchCapture = (fn: (req: bridge.CaptureRequest) => Promise<bridge.CaptureResult>) => bridge.watchCapture(fn)
export const cancel = () => bridge.cancel()
export const interrupt = () => bridge.cancel()
export const isConnected = () => bridge.isConnected()
export const watchConnection = (fn: (state: bridge.ConnectionState) => void) => bridge.watchConnection(fn)
export const connectedLabels = () => bridge.bridgeServers()
