export const APPS: Readonly<Record<string, readonly string[]>>
export const TERMS: readonly string[]
export function appCommand(text: string): string | undefined
export function sensitiveSpeech(text: string): boolean
export function diagnosticSpeech(text: string): string
export function applySpeechHints(rec: object, Phrase: unknown): boolean
