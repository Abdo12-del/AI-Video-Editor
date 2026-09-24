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

import { planVisualSamples, analyzeVideoVisuals, analyzeSceneKeyframes, GeminiSceneVisualAnalyzer, NullVisualAnalyzer } from './videoUnderstanding'

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

describe('scene-keyframe visual analyzer', () => {
  it('reports unavailable through the null analyzer without touching the provider', async () => {
    const analyzer = new NullVisualAnalyzer()
    expect(analyzer.provider).toBe('none')
    expect(analyzer.available).toBe(false)
    await expect(analyzer.analyzeKeyframes([], 'en', new AbortController().signal)).rejects.toThrow(/not available/)
    expect(mocks.generateGeminiTurn).not.toHaveBeenCalled()
  })

  it('requires a plausible API key before analyzing', async () => {
    const analyzer = new GeminiSceneVisualAnalyzer('short')
    expect(analyzer.available).toBe(false)
    await expect(analyzer.analyzeKeyframes(
      [{ sceneIndex: 1, start: 0, end: 4, timestampSeconds: 2, imageBase64: 'aGk=' }], 'en', new AbortController().signal
    )).rejects.toThrow(/API key/)
  })

  it('parses structured scene analyses, drops unknown scenes, and clamps importance', async () => {
    mocks.generateGeminiTurn.mockResolvedValueOnce({
      functionCalls: [], modelContent: { role: 'model', parts: [] },
      text: JSON.stringify({
        scenes: [
          { sceneIndex: 1, visualSummary: 'A presenter at a desk.', subjects: ['presenter', 'desk'], activity: 'speaking', hasPerson: true, hasOnScreenText: true, textOnScreen: 'LIVE', visualImportance: 2.5 },
          { sceneIndex: 2, visualSummary: 'A wide empty studio.', subjects: [], activity: 'static', hasPerson: false, hasOnScreenText: false, visualImportance: 0.2 },
          { sceneIndex: 99, visualSummary: 'Invented scene.', subjects: [], activity: 'static', hasPerson: false, hasOnScreenText: false, visualImportance: 1 }
        ]
      })
    })
    const analyzer = new GeminiSceneVisualAnalyzer('mock-gemini-key-123456789012345')
    const result = await analyzer.analyzeKeyframes([
      { sceneIndex: 1, start: 0, end: 10, timestampSeconds: 5, imageBase64: 'aGk=' },
      { sceneIndex: 2, start: 10, end: 20, timestampSeconds: 15, imageBase64: 'aGk=' }
    ], 'en', new AbortController().signal)

    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ sceneIndex: 1, visualImportance: 1, hasPerson: true, textOnScreen: 'LIVE' })
    expect(result[1]).toMatchObject({ sceneIndex: 2, activity: 'static', visualImportance: 0.2 })
    const request = mocks.generateGeminiTurn.mock.calls[0][1] as {
      responseMimeType: string
      contents: Array<{ parts: Array<Record<string, unknown>> }>
    }
    expect(request.responseMimeType).toBe('application/json')
    expect(request.contents[0].parts.filter((part) => 'inlineData' in part)).toHaveLength(2)
  })

  it('refuses to save partial scene descriptions', async () => {
    mocks.generateGeminiTurn.mockResolvedValueOnce({
      functionCalls: [], modelContent: { role: 'model', parts: [] },
      text: JSON.stringify({ scenes: [{ sceneIndex: 1, visualSummary: '', subjects: [], activity: 'static', hasPerson: false, hasOnScreenText: false, visualImportance: 0.5 }] })
    })
    const analyzer = new GeminiSceneVisualAnalyzer('mock-gemini-key-123456789012345')
    await expect(analyzer.analyzeKeyframes(
      [{ sceneIndex: 1, start: 0, end: 4, timestampSeconds: 2, imageBase64: 'aGk=' }], 'en', new AbortController().signal
    )).rejects.toThrow(/every scene keyframe/)
  })

  it('extracts one keyframe per scene, stores structured profiles, and cleans temporary frames', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scene keyframes '))
    const asset: MediaAsset = {
      id: 'media-1', name: 'test.mp4', filePath: 'C:\\Videos\\original.mp4',
      duration: 20, width: 1920, height: 1080, fps: 30, sizeBytes: 12_000,
      hasAudio: true, videoCodec: 'h264', importedAt: new Date(0).toISOString()
    }
    mocks.extractVisualFrameAt.mockImplementation(async (_asset: MediaAsset, _time: number, outputPath: string) => {
      await writeFile(outputPath, Buffer.from('keyframe-bytes'))
    })
    mocks.generateGeminiTurn.mockResolvedValueOnce({
      functionCalls: [], modelContent: { role: 'model', parts: [] },
      text: JSON.stringify({
        scenes: [
          { sceneIndex: 1, visualSummary: 'A presenter at a desk.', subjects: ['presenter'], activity: 'speaking', hasPerson: true, hasOnScreenText: false, visualImportance: 0.8 },
          { sceneIndex: 2, visualSummary: 'A product close-up.', subjects: ['product'], activity: 'static', hasPerson: false, hasOnScreenText: false, visualImportance: 0.6 }
        ]
      })
    })

    try {
      const profiles = await analyzeSceneKeyframes(
        asset, [{ start: 0, end: 10 }, { start: 10, end: 20 }], root, 'mock-gemini-key-123456789012345', 'en', 'scene-job', vi.fn()
      )
      expect(profiles).toHaveLength(2)
      expect(profiles[0]).toMatchObject({ sceneIndex: 1, start: 0, end: 10, keyframeTimestamp: 5, provider: 'gemini', visualImportance: 0.8 })
      expect(profiles[1]).toMatchObject({ sceneIndex: 2, keyframeTimestamp: 15, hasPerson: false })
      expect(mocks.extractVisualFrameAt).toHaveBeenCalledTimes(2)
      expect(JSON.stringify(mocks.generateGeminiTurn.mock.calls[0][1])).not.toContain(asset.filePath)
      expect(await readdir(join(root, 'cache'))).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
