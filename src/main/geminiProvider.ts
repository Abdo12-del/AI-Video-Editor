import type { GeminiConnectionErrorCode } from '../shared/types'

export const GEMINI_MODEL = 'gemini-3.8-flash'

export interface GeminiSchema {
  type: string
  description?: string
  properties?: Record<string, GeminiSchema>
  required?: string[]
  enum?: string[]
  items?: GeminiSchema
  minimum?: number
  maximum?: number
}

export interface GeminiFunctionDeclaration {
  name: string
  description: string
  parameters: GeminiSchema
}

export interface GeminiFunctionCall {
  name: string
  args: Record<string, unknown>
  id?: string
}

export interface GeminiTurn {
  modelContent: Record<string, unknown>
  text: string
  functionCalls: GeminiFunctionCall[]
}

export class GeminiProviderError extends Error {
  readonly code: GeminiConnectionErrorCode

  constructor(code: GeminiConnectionErrorCode) {
    super(`Gemini request failed (${code}).`)
    this.name = 'GeminiProviderError'
    this.code = code
  }
}

function codeForHttpStatus(status: number): GeminiConnectionErrorCode {
  if (status === 400 || status === 404) return 'request-rejected'
  if (status === 401 || status === 403) return 'invalid-key'
  if (status === 429) return 'rate-limited'
  if (status >= 500) return 'service-unavailable'
  return 'unknown'
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

export async function generateGeminiTurn(
  apiKey: string,
  input: {
    systemInstruction: string
    contents: Array<Record<string, unknown>>
    functionDeclarations?: GeminiFunctionDeclaration[]
    responseMimeType?: 'application/json'
    signal?: AbortSignal
  }
): Promise<GeminiTurn> {
  const key = apiKey.trim()
  if (key.length < 20 || key.length > 512 || /[\r\n\0]/.test(key)) throw new GeminiProviderError('invalid-key')

  const body: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: input.systemInstruction }] },
    contents: input.contents,
    generationConfig: {
      maxOutputTokens: 4096,
      ...(input.responseMimeType ? { responseMimeType: input.responseMimeType } : {})
    }
  }
  if (input.functionDeclarations?.length) {
    body.tools = [{ functionDeclarations: input.functionDeclarations }]
    body.toolConfig = { functionCallingConfig: { mode: 'AUTO' } }
  }

  let response: Response
  try {
    response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': key
      },
      body: JSON.stringify(body),
      signal: input.signal ?? AbortSignal.timeout(45_000)
    })
  } catch {
    if (input.signal?.aborted && (input.signal.reason as { name?: unknown } | undefined)?.name === 'AbortError') {
      throw new Error('Operation cancelled by the user.')
    }
    throw new GeminiProviderError('network')
  }
  if (!response.ok) throw new GeminiProviderError(codeForHttpStatus(response.status))

  let payload: unknown
  try { payload = await response.json() } catch { throw new GeminiProviderError('unknown') }
  const root = asRecord(payload)
  const candidates = Array.isArray(root?.candidates) ? root.candidates : []
  const candidate = asRecord(candidates[0])
  const modelContent = asRecord(candidate?.content)
  const parts = Array.isArray(modelContent?.parts) ? modelContent.parts : []
  if (!modelContent || !parts.length) {
    const promptFeedback = asRecord(root?.promptFeedback)
    if (promptFeedback?.blockReason) throw new GeminiProviderError('blocked')
    throw new GeminiProviderError('unknown')
  }

  const text = parts.map((value) => asRecord(value)?.text).filter((value): value is string => typeof value === 'string').join('').trim()
  const functionCalls = parts.flatMap((value) => {
    const part = asRecord(value)
    const call = asRecord(part?.functionCall)
    if (typeof call?.name !== 'string' || !call.name) return []
    return [{
      name: call.name,
      args: asRecord(call.args) ?? {},
      id: typeof call.id === 'string' ? call.id : undefined
    }]
  })
  return { modelContent, text, functionCalls }
}

export async function testGeminiApiKey(apiKey: string): Promise<void> {
  const result = await generateGeminiTurn(apiKey, {
    systemInstruction: 'You are testing API connectivity. Reply with one short word.',
    contents: [{ role: 'user', parts: [{ text: 'Reply: OK' }] }],
    signal: AbortSignal.timeout(20_000)
  })
  if (!result.text && !result.functionCalls.length) throw new GeminiProviderError('unknown')
}
