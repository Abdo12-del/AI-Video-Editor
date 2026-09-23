import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MediaAsset } from '../shared/types'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  extractVisualFrameAt: vi.fn(),
  extractVisualFramesPerSecond: vi.fn(),
  ensureMediaJobActive: vi.fn(),
  registerMediaJobCancellation: vi.fn(() => vi.fn()),
  generateGeminiTurn: vi.fn()
}))

vi.mock('electron', () => ({ app: { isPackaged: false } }))
vi.mock('./mediaEngine', () => ({
  extractVisualFrameAt: mocks.extractVisualFrameAt,
  extractVisualFramesPerSecond: mocks.extractVisualFramesPerSecond,
  ensureMediaJobActive: mocks.ensureMediaJobActive,
  registerMediaJobCancellation: mocks.registerMediaJobCancellation
}))
vi.mock('./geminiProvider', () => ({ generateGeminiTurn: mocks.generateGeminiTurn }))

import { planVisualSamples, analyzeVideoVisuals } from './videoUnderstanding'

afterEach(() => vi.clearAllMocks())

describe('visual sample planning', () => {
  it('samples every source second and adds an extra still for a detected sub-second shot', () => {
    const samples = planVisualSamples(4.2, [
      { start: 0, end: 0.3 },
      { start: 0.3, end: 0.7 },
      { start: 0.7, end: 2.1 },
      { start: 2.1, end: 4.2 }
    ])

    expect(samples.map(({ timestampSeconds, shotIndex }) => [timestampSeconds, shotIndex])).toEqual([
      [0, 1], [0.5, 2], [1, 3], [2, 3], [3, 4], [4, 4]
    ])
  })

  it('uses a single full-duration shot when no local shot boundaries are available', () => {
    expect(planVisualSamples(2.2, []).map(({ timestampSeconds, shotIndex }) => [timestampSeconds, shotIndex])).toEqual([
      [0, 1], [1, 1], [2, 1]
    ])
  })

  it('returns no frame samples for a zero or invalid duration', () => {
    expect(planVisualSamples(0, [])).toEqual([])
    expect(planVisualSamples(Number.NaN, [])).toEqual([])
  })
})

describe('visual indexing orchestration (mocked provider and FFmpeg)', () => {
  it('sends only extracted low-resolution stills, requires a complete caption set, and deletes temporary frames', async () => {
    const root = await mkdtemp(join(tmpdir(), 'مشروع فيديو visual index '))
    const asset: MediaAsset = {
      id: 'media-1', name: 'مصدر فيديو test.mp4', filePath: 'C:\\Users\\Test User\\فيديو أصلي.mp4',
      duration: 2, width: 1920, height: 1080, fps: 30, sizeBytes: 12_000,
      hasAudio: true, videoCodec: 'h264', audioCodec: 'aac', importedAt: new Date(0).toISOString()
    }
    mocks.extractVisualFramesPerSecond.mockImplementation(async (_asset: MediaAsset, outputDirectory: string) => {
      const paths = [join(outputDirectory, 'frame-000000.jpg'), join(outputDirectory, 'frame-000001.jpg')]
      await Promise.all(paths.map((path, index) => writeFile(path, Buffer.from(`jpeg-still-${index}`))))
      return paths
    })
    mocks.generateGeminiTurn.mockResolvedValueOnce({
      functionCalls: [], modelContent: { role: 'model', parts: [] },
      text: JSON.stringify({
        segmentSummary: 'A presenter speaks in a studio.',
        frames: [
          { id: 'frame-000000', description: 'A presenter stands in a bright studio.', visibleText: '' },
          { id: 'frame-000001', description: 'The presenter points toward a title card.', visibleText: 'Studio update' }
        ],
        shots: [{ index: 1, description: 'A presenter speaks in a bright studio.' }]
      })
    })

    try {
      const result = await analyzeVideoVisuals(
        asset, [{ start: 0, end: 2 }], root, 'mock-gemini-key-123456789012345', 'en', 'visual-job', vi.fn()
      )

      expect(result.frameCount).toBe(2)
      expect(result.shots[0].description).toContain('A presenter speaks')
      expect(result.moments[1]).toMatchObject({ timestampSeconds: 1, visibleText: 'Studio update' })
      expect(mocks.extractVisualFrameAt).not.toHaveBeenCalled()
      expect(mocks.generateGeminiTurn).toHaveBeenCalledOnce()
      const request = mocks.generateGeminiTurn.mock.calls[0][1] as {
        responseMimeType: string
        contents: Array<{ parts: Array<Record<string, unknown>> }>
      }
      expect(request.responseMimeType).toBe('application/json')
      expect(request.contents[0].parts.filter((part) => 'inlineData' in part)).toHaveLength(2)
      expect(JSON.stringify(request)).not.toContain(asset.filePath)
      expect(JSON.stringify(request)).toContain('Frame ID frame-000000')
      expect(await readdir(join(root, 'cache'))).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
