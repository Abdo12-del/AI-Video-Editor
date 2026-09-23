import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateGeminiTurn, GeminiProviderError } from './geminiProvider'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Gemini generateContent client', () => {
  it('uses the API-key header and parses function calls without placing the key in the URL or body', async () => {
    const key = 'test-only-not-a-google-key-do-not-use-123456789'
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ functionCall: { id: 'call-1', name: 'get_timeline', args: { track_id: 'track-video' } } }]
          }
        }
      ]
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await generateGeminiTurn(key, {
      systemInstruction: 'Use only the declared tools.',
      contents: [{ role: 'user', parts: [{ text: 'Inspect the timeline.' }] }],
      functionDeclarations: [{ name: 'get_timeline', description: 'Read timeline.', parameters: { type: 'OBJECT', properties: {} } }]
    })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('models/gemini-3.8-flash:generateContent')
    expect(url).not.toContain(key)
    expect(init.headers).toMatchObject({ 'x-goog-api-key': key })
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(JSON.stringify(body)).not.toContain(key)
    expect(result.functionCalls).toEqual([{ id: 'call-1', name: 'get_timeline', args: { track_id: 'track-video' } }])
  })

  it('sets JSON response mode when the visual caption caller requests structured output', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ content: { role: 'model', parts: [{ text: '{"frames":[]}' }] } }]
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const key = 'test-only-not-a-google-key-do-not-use-123456789'

    await generateGeminiTurn(key, { systemInstruction: 'Return JSON.', contents: [], responseMimeType: 'application/json' })

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as { generationConfig?: Record<string, unknown> }
    expect(body.generationConfig?.responseMimeType).toBe('application/json')
  })

  it('returns sanitized provider error codes instead of API response text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: 'secret-key-echo' } }), { status: 403 })))
    const key = 'test-only-not-a-google-key-do-not-use-123456789'
    const error = await generateGeminiTurn(key, { systemInstruction: 'test', contents: [] }).catch((value: unknown) => value)
    expect(error).toMatchObject({ code: 'invalid-key' })
    expect(String(error)).not.toContain(key)
    expect(String(error)).not.toContain('secret-key-echo')
  })

  it('preserves an explicit visual-analysis cancellation instead of showing a network failure', async () => {
    const controller = new AbortController()
    controller.abort()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('AbortError')))
    const key = 'test-only-not-a-google-key-do-not-use-123456789'

    await expect(generateGeminiTurn(key, { systemInstruction: 'test', contents: [], signal: controller.signal })).rejects.toThrow('Operation cancelled by the user.')
  })

  it('rejects malformed key input without making a network request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(generateGeminiTurn('too-short', { systemInstruction: 'test', contents: [] })).rejects.toBeInstanceOf(GeminiProviderError)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
