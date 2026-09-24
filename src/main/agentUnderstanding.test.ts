import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AnalysisResult, AppSettings, MediaAsset, ProjectData } from '../shared/types'
import { addMediaToTimeline, createProject } from '../shared/project'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  generateGeminiTurn: vi.fn(),
  writeLog: vi.fn(),
  analyzeMedia: vi.fn(),
  transcribeMedia: vi.fn()
}))

vi.mock('electron', () => ({ app: { isPackaged: false } }))
vi.mock('./logger', () => ({ writeLog: mocks.writeLog }))
vi.mock('./mediaEngine', () => ({ analyzeMedia: mocks.analyzeMedia, transcribeMedia: mocks.transcribeMedia }))
vi.mock('./geminiProvider', () => ({
  generateGeminiTurn: mocks.generateGeminiTurn,
  GeminiProviderError: class GeminiProviderError extends Error {
    code: string
    constructor(code: string) { super(code); this.code = code }
  }
}))

import { sendAgentMessage } from './agentService'
import { executeAgentTool, getAgentToolDefinitions } from './agentToolRegistry'

afterEach(() => vi.clearAllMocks())

const arSettings: AppSettings = {
  language: 'ar', ollamaEnabled: false, ollamaModel: 'qwen2.5:7b', whisperBinaryPath: '', whisperModelPath: ''
}
const enSettings: AppSettings = { ...arSettings, language: 'en' }
const secretKey = 'agent-test-secret-not-an-api-key-123456789'
const report = vi.fn()

function videoAsset(id: string, name: string, duration: number): MediaAsset {
  return {
    id, name, filePath: `/private/source/${name}`, duration,
    width: 1920, height: 1080, fps: 30, sizeBytes: 1024, hasAudio: true, videoCodec: 'h264',
    audioCodec: 'aac', importedAt: new Date().toISOString()
  }
}

function seedTalkAnalysis(): AnalysisResult {
  return {
    mediaId: 'media-1', analyzedAt: new Date().toISOString(),
    scenes: [{ start: 0, end: 30 }, { start: 30, end: 60 }, { start: 60, end: 90 }],
    silences: [{ start: 40, end: 46, duration: 6 }],
    transcript: [
      { id: 't1', start: 1, end: 6, text: 'Welcome to the tutorial about video editing basics.' },
      { id: 't2', start: 7, end: 12, text: 'First we open the project and inspect the timeline carefully.' },
      { id: 't3', start: 31, end: 37, text: 'نتحدث اليوم عن الذكاء الاصطناعي وتطبيقاته في المونتاج.' },
      { id: 't4', start: 61, end: 68, text: 'The second half covers color grading and audio mixing.' },
      { id: 't5', start: 80, end: 85, text: 'Thanks for watching this complete guide.' }
    ],
    audio: { clippingDetected: false, silenceCount: 1, analyzed: true, meanVolumeDb: -18 },
    quality: { width: 1920, height: 1080, fps: 30, videoCodec: 'h264', notes: [] }, warnings: []
  }
}

function projectWithTalk(seedAnalysis = true): ProjectData {
  let project = createProject('Understanding chat', join(tmpdir(), 'aivideo-understanding'))
  project = addMediaToTimeline(project, [videoAsset('media-1', 'talk.mp4', 90)])
  if (seedAnalysis) project = { ...project, analysisByMedia: { 'media-1': seedTalkAnalysis() } }
  return project
}

function localAnalysisResult(asset: MediaAsset, withTranscript: boolean): AnalysisResult {
  return {
    mediaId: asset.id, analyzedAt: new Date().toISOString(),
    scenes: [{ start: 0, end: 45 }, { start: 45, end: 90 }],
    silences: [{ start: 60, end: 63, duration: 3 }],
    transcript: withTranscript
      ? [
        { id: 't1', start: 2, end: 9, text: 'We tested the real workflow with careful steps and a useful result.' },
        { id: 't2', start: 10, end: 18, text: 'The team compared three options and selected the strongest design.' },
        { id: 't3', start: 46, end: 55, text: 'Then we measured the change and confirmed the improvement.' }
      ]
      : [],
    audio: { clippingDetected: false, silenceCount: 1, analyzed: true },
    quality: { width: 1920, height: 1080, fps: 30, videoCodec: 'h264', notes: [] }, warnings: []
  }
}

function functionTurn(calls: Array<{ name: string; args: Record<string, unknown>; id?: string }>) {
  return {
    modelContent: { role: 'model', parts: calls.map((call) => ({ functionCall: call })) },
    text: '',
    functionCalls: calls
  }
}

function textTurn(text: string) {
  return { modelContent: { role: 'model', parts: [{ text }] }, text, functionCalls: [] }
}

describe('video understanding tools', () => {
  it('registers the best-segments, transcript-search, and digest tools', async () => {
    await sendAgentMessage(projectWithTalk(), 'تراجع', arSettings, 'register-job', report, null)
    const names = getAgentToolDefinitions().map((tool) => tool.name)
    expect(names).toContain('find_best_segments')
    expect(names).toContain('search_transcript')
    expect(names).toContain('get_video_understanding')
  })
})

describe('mandatory test 1: a generic best-clips request auto-runs analysis and never asks which clips', () => {
  it('local Arabic flow analyzes first, then ranks with timestamps', async () => {
    mocks.analyzeMedia.mockImplementation(async (asset: MediaAsset) => localAnalysisResult(asset, false))
    const first = await sendAgentMessage(projectWithTalk(false), 'قص أفضل المقاطع من الفيديو.', arSettings, 'best-job-1', report, null)

    expect(mocks.analyzeMedia).toHaveBeenCalled()
    expect(first.reply).toContain('حللت الفيديو')
    expect(first.reply).toMatch(/\d\d:\d\d\.\d/)
    expect(first.reply).not.toMatch(/أي مقاطع|أخبرني|حدد المقاطع/)
    expect(first.proposal?.action).toMatchObject({ type: 'create-short' })
    expect(first.conversation?.hasPendingAction).toBe(true)
  })

  it('Gemini flow executes the analysis tool instead of guessing', async () => {
    mocks.generateGeminiTurn
      .mockResolvedValueOnce(functionTurn([{ id: 'best-1', name: 'find_best_segments', args: { count: 3 } }]))
      .mockResolvedValueOnce(textTurn('Here is my ranked plan: 00:01.0–00:31.0 looks strongest.'))
    const asked = await sendAgentMessage(projectWithTalk(), 'Cut the best moments from the video.', enSettings, 'best-job-2', report, secretKey)

    expect(mocks.analyzeMedia).not.toHaveBeenCalled()
    expect(asked.steps?.map((step) => step.label)).toContain('Best segments ranked')
    expect(asked.reply).toContain('ranked plan')
  })
})

describe('mandatory test 2: a Short request runs analysis, candidates, approval, then execution', () => {
  it('analyzes first, proposes the best range, and creates the Short after نعم', async () => {
    mocks.analyzeMedia.mockImplementation(async (asset: MediaAsset) => localAnalysisResult(asset, true))
    const project = projectWithTalk(false)
    const asked = await sendAgentMessage(project, 'اصنع Short من الفيديو', arSettings, 'short-job', report, null)

    expect(mocks.analyzeMedia).toHaveBeenCalled()
    expect(asked.reply).toContain('Short')
    expect(asked.proposal?.action).toMatchObject({ type: 'create-short', aspectRatio: '9:16' })
    expect(asked.conversation?.hasPendingAction).toBe(true)

    const created = await sendAgentMessage(asked.project, 'نعم', arSettings, 'short-job', report, null)
    expect(created.reply).toContain('تم إنشاء الـShort')
    expect(created.project.exportSettings.aspectRatio).toBe('9:16')
  })
})

describe('mandatory test 3: a topic request returns the matching timestamps', () => {
  it('local Arabic flow proposes the part where the topic is discussed', async () => {
    const asked = await sendAgentMessage(projectWithTalk(), 'خذ الجزء الذي يتحدث فيه عن الذكاء الاصطناعي.', arSettings, 'topic-job', report, null)

    expect(mocks.analyzeMedia).not.toHaveBeenCalled()
    expect(asked.reply).toContain('الذكاء الاصطناعي')
    expect(asked.reply).toMatch(/\d\d:\d\d\.\d/)
    expect(asked.proposal?.action).toMatchObject({ type: 'create-short' })
    expect(asked.conversation?.hasPendingAction).toBe(true)
  })

  it('search_transcript returns timestamped matches with scene linkage', async () => {
    const project = projectWithTalk()
    const found = await executeAgentTool('search_transcript', { query: 'الذكاء الاصطناعي' }, { project, settings: enSettings, jobId: 'topic-tool', report })
    const result = found.result as { available: boolean; matches: Array<{ start: number; end: number; sceneIndex?: number; text: string }> }

    expect(result.available).toBe(true)
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0]).toMatchObject({ start: 31, end: 37, sceneIndex: 2 })
    expect(result.matches[0].text).toContain('الذكاء الاصطناعي')
  })
})

describe('mandatory test 4: best-3 returns three ranked candidates from real analysis', () => {
  it('local Arabic flow lists three ranked timestamped ranges', async () => {
    const asked = await sendAgentMessage(projectWithTalk(), 'اختر أفضل 3 مقاطع.', arSettings, 'best3-job', report, null)

    expect(asked.reply).toContain('1.')
    expect(asked.reply).toContain('2.')
    expect(asked.reply).toContain('3.')
    expect(asked.reply).toMatch(/مرتبة من الأفضل/)
    expect(asked.reply).toMatch(/\d\d:\d\d\.\d/)
  })

  it('find_best_segments ranks three evidence-backed candidates, best first', async () => {
    const project = projectWithTalk()
    const ranked = await executeAgentTool('find_best_segments', { count: 3 }, { project, settings: enSettings, jobId: 'best3-tool', report })
    const result = ranked.result as {
      available: boolean
      candidates: Array<{ score: number; transcriptExcerpt: string; evidence: { wordCount: number } }>
    }

    expect(result.available).toBe(true)
    expect(result.candidates).toHaveLength(3)
    expect(result.candidates[0].score).toBeGreaterThanOrEqual(result.candidates[1].score)
    expect(result.candidates[1].score).toBeGreaterThanOrEqual(result.candidates[2].score)
    for (const candidate of result.candidates) {
      expect(candidate.transcriptExcerpt).toBeTruthy()
      expect(candidate.evidence.wordCount).toBeGreaterThan(0)
    }
  })
})

describe('mandatory test 5: honesty when no visual analysis exists', () => {
  it('find_best_segments says visual interest was not scored and never invents descriptions', async () => {
    const project = projectWithTalk()
    const ranked = await executeAgentTool('find_best_segments', { count: 2 }, { project, settings: enSettings, jobId: 'honest-tool', report })
    const result = ranked.result as {
      available: boolean
      visualAvailable: boolean
      reason: string
      candidates: Array<{ visualDescription?: string; signals: { visualInterest: number | null } }>
    }

    expect(result.available).toBe(true)
    expect(result.visualAvailable).toBe(false)
    expect(result.reason).toMatch(/Visual analysis is not available/)
    for (const candidate of result.candidates) {
      expect(candidate.visualDescription).toBeUndefined()
      expect(candidate.signals.visualInterest).toBeNull()
    }
  })

  it('the Arabic reply names transcript/audio/scene evidence and claims no watched frames', async () => {
    const asked = await sendAgentMessage(projectWithTalk(), 'قص أفضل المقاطع من الفيديو.', arSettings, 'honest-job', report, null)

    expect(asked.reply).toContain('لا توجد فهرسة بصرية')
    expect(asked.reply).toContain('التفريغ الصوتي')
    expect(asked.reply).not.toMatch(/رأيت|شاهدت|يظهر في الفيديو/)
  })

  it('get_video_understanding reports coverage per evidence dimension', async () => {
    const project = projectWithTalk()
    const digest = await executeAgentTool('get_video_understanding', {}, { project, settings: enSettings, jobId: 'digest-tool', report })
    const result = digest.result as {
      coverage: { transcript: boolean; scenes: boolean; silence: boolean; audio: boolean; visual: boolean }
      scenes: { count: number }
      visual: { available: boolean; reason?: string }
      candidates: { items: unknown[] }
    }

    expect(result.coverage).toMatchObject({ transcript: true, scenes: true, silence: true, audio: true, visual: false })
    expect(result.scenes.count).toBe(3)
    expect(result.visual.available).toBe(false)
    expect(result.visual.reason).toMatch(/visual index/i)
    expect(result.candidates.items).toHaveLength(3)
    expect(JSON.stringify(result).length).toBeLessThan(18_000)
  })
})
