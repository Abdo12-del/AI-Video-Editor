import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  activeProject: null as { media: Array<{ id: string; filePath: string; thumbnailPath?: string; waveformPath?: string }> } | null
}))

vi.mock('electron', () => ({ protocol: { handle: mocks.handle } }))
vi.mock('./projectStore', () => ({ getActiveProject: () => mocks.activeProject }))

import { registerMediaProtocol } from './mediaProtocol'

let root = ''
let sourcePath = ''
let audioPath = ''
let waveformPath = ''
let handler: ((request: { url: string; method: string; headers: Headers }) => Promise<Response>) | undefined

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ai-video-protocol-'))
  sourcePath = join(root, 'source.mp4')
  audioPath = join(root, 'music.mp3')
  waveformPath = join(root, 'waveform.png')
  await writeFile(sourcePath, '0123456789', 'utf8')
  await writeFile(audioPath, 'audio-data', 'utf8')
  await writeFile(waveformPath, 'waveform-image', 'utf8')
  mocks.activeProject = { media: [{ id: 'media-1', filePath: sourcePath, waveformPath }, { id: 'audio-1', filePath: audioPath }] }
  registerMediaProtocol()
  handler = mocks.handle.mock.calls[0]?.[1] as typeof handler
})

afterAll(async () => {
  mocks.activeProject = null
  if (root) await rm(root, { recursive: true, force: true })
})

describe('aivideo media protocol', () => {
  it('serves byte ranges for seeking without loading the whole source', async () => {
    expect(handler).toBeTypeOf('function')
    const response = await handler!({ url: 'aivideo://media/media-1', method: 'GET', headers: new Headers({ range: 'bytes=2-5' }) })
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(await response.text()).toBe('2345')
  })

  it('returns the complete media file for a request without a range', async () => {
    const response = await handler!({ url: 'aivideo://media/media-1', method: 'GET', headers: new Headers() })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('video/mp4')
    expect(await response.text()).toBe('0123456789')
  })

  it('serves audio with a browser-decodable MIME type for independent music-track preview', async () => {
    const response = await handler!({ url: 'aivideo://media/audio-1', method: 'GET', headers: new Headers() })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('audio/mpeg')
    expect(await response.text()).toBe('audio-data')
  })

  it('serves generated waveform images through the local media protocol', async () => {
    const response = await handler!({ url: 'aivideo://waveform/media-1', method: 'GET', headers: new Headers() })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(await response.text()).toBe('waveform-image')
  })

  it('rejects malformed ranges and unknown media identifiers', async () => {
    const badRange = await handler!({ url: 'aivideo://media/media-1', method: 'GET', headers: new Headers({ range: 'bytes=20-30' }) })
    expect(badRange.status).toBe(416)
    const unknown = await handler!({ url: 'aivideo://media/missing', method: 'GET', headers: new Headers() })
    expect(unknown.status).toBe(404)
  })
})
