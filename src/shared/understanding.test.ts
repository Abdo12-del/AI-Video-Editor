import { describe, expect, it } from 'vitest'
import { addMediaToTimeline, createProject } from './project'
import type { AnalysisResult, MediaAsset, ProjectData, Scene, TranscriptSegment, VisualMoment } from './types'
import {
  buildSceneProfiles,
  buildVideoDigest,
  expandToSentenceBounds,
  findBestSegments,
  getEvidenceCoverage,
  normalizeSearchText,
  planSceneKeyframes,
  queryTokens,
  searchTranscript
} from './understanding'

const asset: MediaAsset = {
  id: 'media-1', name: 'talk.mp4', filePath: '/tmp/talk.mp4', duration: 90, width: 1920, height: 1080,
  fps: 30, sizeBytes: 1000, hasAudio: true, videoCodec: 'h264', importedAt: new Date(0).toISOString()
}

function transcript(text: string, start: number, end: number, id = `t-${start}`): TranscriptSegment {
  return { id, start, end, text }
}

function scene(start: number, end: number): Scene {
  return { start, end }
}

function moment(timestampSeconds: number, description: string, shotIndex = 1, visibleText?: string): VisualMoment {
  return { timestampSeconds, second: Math.floor(timestampSeconds), shotIndex, description, ...(visibleText ? { visibleText } : {}) }
}

function analysis(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    mediaId: asset.id,
    analyzedAt: new Date(0).toISOString(),
    scenes: [scene(0, 30), scene(30, 60), scene(60, 90)],
    silences: [{ start: 40, end: 46, duration: 6 }],
    transcript: [
      transcript('Welcome to the tutorial about video editing basics.', 1, 6),
      transcript('First we open the project and inspect the timeline carefully.', 7, 12),
      transcript('Artificial intelligence helps editors find the best moments automatically.', 31, 37),
      transcript('The second half covers color grading and audio mixing.', 61, 68),
      transcript('Thanks for watching this complete guide.', 80, 85)
    ],
    audio: { clippingDetected: false, silenceCount: 1, analyzed: true, meanVolumeDb: -18, maxVolumeDb: -3 },
    quality: { width: 1920, height: 1080, fps: 30, videoCodec: 'h264', notes: [] },
    warnings: [],
    ...overrides
  }
}

function projectWith(analysisByMedia: Record<string, AnalysisResult> = { 'media-1': analysis() }): ProjectData {
  const base = addMediaToTimeline(createProject('Understanding fixtures', '/tmp'), [asset])
  return { ...base, analysisByMedia }
}

describe('getEvidenceCoverage', () => {
  it('reports every evidence dimension', () => {
    expect(getEvidenceCoverage(projectWith())).toEqual({ transcript: true, scenes: true, silence: true, audio: true, visual: false, sceneVisuals: false })
  })

  it('reports visual coverage only when stored moments exist', () => {
    const withVisual = projectWith({ 'media-1': analysis({ visualIndex: {
      provider: 'gemini', analyzedAt: '2026-01-01T00:00:00.000Z', sampleIntervalSeconds: 1, durationSeconds: 90,
      frameCount: 1, summary: 'A speaker.', shots: [], moments: [moment(32, 'A speaker at a desk.')]
    } }) })
    expect(getEvidenceCoverage(withVisual).visual).toBe(true)
    expect(getEvidenceCoverage(projectWith()).visual).toBe(false)
  })
})

describe('buildSceneProfiles', () => {
  it('fuses scenes with transcript, silence, and keyframe timestamps', () => {
    const profiles = buildSceneProfiles(projectWith())
    expect(profiles).toHaveLength(3)
    expect(profiles[0]).toMatchObject({ sceneIndex: 1, start: 0, end: 30, keyframeTimestamp: 15, hasVisualEvidence: false, visualSummary: '' })
    expect(profiles[1].speechCoveragePercent).toBeGreaterThan(0)
    expect(profiles[1].silenceSeconds).toBe(6)
    expect(profiles[1].transcriptExcerpt).toContain('Artificial intelligence')
  })

  it('attaches stored visual moments without inventing summaries', () => {
    const withVisual = projectWith({ 'media-1': analysis({ visualIndex: {
      provider: 'gemini', analyzedAt: '2026-01-01T00:00:00.000Z', sampleIntervalSeconds: 1, durationSeconds: 90,
      frameCount: 1, summary: 'A speaker.', shots: [], moments: [moment(32, 'A speaker at a desk.', 2, 'LIVE')]
    } }) })
    const profiles = buildSceneProfiles(withVisual)
    expect(profiles[1]).toMatchObject({ hasVisualEvidence: true, momentCount: 1, visibleTexts: ['LIVE'] })
    expect(profiles[1].visualSummary).toContain('speaker at a desk')
    expect(profiles[0]).toMatchObject({ hasVisualEvidence: false, visualSummary: '' })
  })
})

describe('planSceneKeyframes', () => {
  it('plans the midpoint still per scene', () => {
    expect(planSceneKeyframes([scene(0, 30), scene(30, 60)])).toEqual([
      { sceneIndex: 1, timestampSeconds: 15 },
      { sceneIndex: 2, timestampSeconds: 45 }
    ])
  })

  it('adds quarter points for long scenes when asked', () => {
    expect(planSceneKeyframes([scene(0, 60)], 3)).toEqual([
      { sceneIndex: 1, timestampSeconds: 15 },
      { sceneIndex: 1, timestampSeconds: 30 },
      { sceneIndex: 1, timestampSeconds: 45 }
    ])
  })
})

describe('transcript search', () => {
  it('normalizes Arabic spelling variants', () => {
    expect(normalizeSearchText('الذّكاءُ الاصطناعيّ')).toBe(normalizeSearchText('الذكاء الاصطناعي'))
    expect(normalizeSearchText('أحمد إلي البداية')).toBe('احمد الي البدايه')
    expect(queryTokens('عن ماذا؟')).toEqual(['عن', 'ماذا'])
    expect(queryTokens('a')).toEqual([])
  })

  it('finds timestamped matches with context and scene linkage', () => {
    const result = searchTranscript(projectWith(), 'artificial intelligence')
    expect(result.available).toBe(true)
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0]).toMatchObject({ start: 31, end: 37, sceneIndex: 2, mediaName: 'talk.mp4' })
    expect(result.matches[0].contextBefore).toContain('timeline')
    expect(result.matches[0].contextAfter).toContain('color grading')
  })

  it('matches Arabic queries despite diacritics', () => {
    const arabic = projectWith({ 'media-1': analysis({ transcript: [transcript('نتحدث اليوم عن الذّكاء الاصطناعي وتطبيقاته.', 10, 16)] }) })
    const result = searchTranscript(arabic, 'الذكاء الاصطناعي')
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0]).toMatchObject({ start: 10, end: 16 })
  })

  it('reports honestly when nothing matches or no transcript exists', () => {
    expect(searchTranscript(projectWith(), 'quantum cooking').matches).toHaveLength(0)
    const empty = projectWith({ 'media-1': analysis({ transcript: [] }) })
    const result = searchTranscript(empty, 'anything')
    expect(result.available).toBe(false)
    expect(result.reason).toMatch(/transcript/i)
  })
})

describe('expandToSentenceBounds', () => {
  it('snaps windows to complete-sentence boundaries', () => {
    const segments = [
      transcript('Hello world. This is', 0, 4),
      transcript('a split sentence fragment', 4, 8),
      transcript('that finally ends here. Next idea starts.', 8, 12)
    ]
    expect(expandToSentenceBounds(segments, 3, 9)).toEqual({ start: 0, end: 12 })
  })
})

describe('findBestSegments', () => {
  it('ranks candidates with multi-signal evidence', () => {
    const result = findBestSegments(projectWith(), { count: 3, targetDuration: 20 })
    expect(result.available).toBe(true)
    expect(result.candidates).toHaveLength(3)
    const [first, second, third] = result.candidates
    expect(first.score).toBeGreaterThanOrEqual(second.score)
    expect(second.score).toBeGreaterThanOrEqual(third.score)
    expect(first.transcriptExcerpt).toBeTruthy()
    expect(first.evidence.wordCount).toBeGreaterThan(0)
    expect(first.signals.speechCoverage).not.toBeNull()
    expect(first.signals.sceneCoherence).not.toBeNull()
    expect(first.confidence).toBeGreaterThan(0)
    expect(result.reason).toMatch(/transcript/)
  })

  it('keeps candidates non-overlapping and time-ordered on ties', () => {
    const result = findBestSegments(projectWith(), { count: 3, targetDuration: 20 })
    for (let index = 1; index < result.candidates.length; index += 1) {
      const previous = result.candidates[index - 1]
      const current = result.candidates[index]
      const overlap = Math.max(0, Math.min(previous.sourceEnd, current.sourceEnd) - Math.max(previous.sourceStart, current.sourceStart))
      expect(overlap / (current.sourceEnd - current.sourceStart)).toBeLessThanOrEqual(0.65)
    }
  })

  it('finds topic windows for a query with sentence snapping', () => {
    const result = findBestSegments(projectWith(), { query: 'artificial intelligence', count: 2 })
    expect(result.available).toBe(true)
    expect(result.candidates.length).toBeGreaterThan(0)
    expect(result.candidates[0].transcriptExcerpt.toLowerCase()).toContain('artificial intelligence')
    expect(result.candidates[0].signals.queryRelevance).not.toBeNull()
  })

  it('stays honest when no visual evidence exists', () => {
    const result = findBestSegments(projectWith(), { count: 2 })
    expect(result.visualAvailable).toBe(false)
    expect(result.reason).toMatch(/visual/i)
    for (const candidate of result.candidates) {
      expect(candidate.visualDescription).toBeUndefined()
      expect(candidate.signals.visualInterest).toBeNull()
      expect(candidate.evidence.hasVisualEvidence).toBe(false)
    }
  })

  it('uses stored visual evidence when it overlaps a window', () => {
    const withVisual = projectWith({ 'media-1': analysis({ visualIndex: {
      provider: 'gemini', analyzedAt: '2026-01-01T00:00:00.000Z', sampleIntervalSeconds: 1, durationSeconds: 90,
      frameCount: 2, summary: 'A speaker.', shots: [], moments: [moment(32, 'A speaker at a desk.', 2), moment(34, 'The speaker gestures.', 2)]
    } }) })
    const result = findBestSegments(withVisual, { count: 3 })
    expect(result.visualAvailable).toBe(true)
    const described = result.candidates.filter((candidate) => candidate.visualDescription)
    expect(described.length).toBeGreaterThan(0)
    expect(described[0].signals.visualInterest).not.toBeNull()
  })

  it('falls back to scene-anchored windows without a transcript', () => {
    const noTranscript = projectWith({ 'media-1': analysis({ transcript: [] }) })
    const result = findBestSegments(noTranscript, { count: 2 })
    expect(result.available).toBe(true)
    expect(result.candidates.length).toBeGreaterThan(0)
    expect(result.candidates[0].signals.speechCoverage).toBeNull()
    expect(result.candidates[0].signals.sceneCoherence).toBe(1)
    expect(result.reason).toMatch(/transcript/i)
  })

  it('reports unavailable topic search without a transcript', () => {
    const noTranscript = projectWith({ 'media-1': analysis({ transcript: [] }) })
    const result = findBestSegments(noTranscript, { query: 'anything' })
    expect(result.available).toBe(false)
    expect(result.reason).toMatch(/transcript/i)
  })
})

describe('buildVideoDigest', () => {
  it('organizes every evidence section with bounded sizes', () => {
    const digest = buildVideoDigest(projectWith(), { candidateCount: 2 })
    expect(digest.coverage).toMatchObject({ transcript: true, scenes: true, silence: true, audio: true, visual: false })
    expect(digest.scenes).toMatchObject({ available: true, count: 3 })
    expect(digest.scenes.samples).toHaveLength(3)
    expect(digest.transcript).toMatchObject({ available: true, segmentCount: 5 })
    expect(digest.silence).toMatchObject({ available: true, regionCount: 1, longestSeconds: 6 })
    expect(digest.audio).toMatchObject({ analyzed: true, clippingDetected: false })
    expect(digest.visual.available).toBe(false)
    expect(digest.visual.reason).toMatch(/visual index/i)
    expect(digest.candidates.items).toHaveLength(2)
    expect(digest.timeline).toMatchObject({ durationSeconds: 90, subtitleCount: 0, musicClipCount: 0 })
    expect(JSON.stringify(digest).length).toBeLessThan(18_000)
  })
})
