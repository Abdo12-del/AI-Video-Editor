import { describe, expect, it } from 'vitest'
import { addMediaToTimeline, createProject, trimClip } from './project'
import { findShortCandidates } from './shorts'
import type { AnalysisResult, MediaAsset } from './types'

const asset: MediaAsset = {
  id: 'interview-1', name: 'Interview.mp4', filePath: 'C:/Interview.mp4', duration: 40, width: 1920, height: 1080,
  fps: 30, sizeBytes: 1000, hasAudio: true, videoCodec: 'h264', importedAt: new Date(0).toISOString()
}

function projectWithTranscript() {
  const base = createProject('Shorts test', 'C:/Project')
  const added = addMediaToTimeline(base, [asset])
  const project = trimClip(added, added.timeline.clips[0].id, 5, 25)
  const analysis: AnalysisResult = {
    mediaId: asset.id, analyzedAt: new Date(0).toISOString(),
    scenes: [{ start: 5, end: 12 }, { start: 12, end: 18 }, { start: 18, end: 25 }],
    silences: [{ start: 19, end: 23, duration: 4 }],
    transcript: [
      { id: 't1', start: 5.5, end: 9, text: 'We tested the real workflow with careful steps and a useful result.', words: [{ text: 'tested', start: 5.5, end: 6, confidence: 0.92 }] },
      { id: 't2', start: 9.2, end: 13, text: 'The team compared three options and selected the strongest design.', words: [{ text: 'compared', start: 9.2, end: 9.7, confidence: 0.88 }] },
      { id: 't3', start: 13.2, end: 17, text: 'Then we measured the change and confirmed the improvement.', words: [{ text: 'confirmed', start: 13.2, end: 13.7, confidence: 0.94 }] },
      { id: 't4', start: 18, end: 19, text: 'A brief ending before silence.' }
    ],
    audio: { clippingDetected: false, silenceCount: 1, analyzed: true, meanVolumeDb: -18 },
    quality: { width: 1920, height: 1080, fps: 30, videoCodec: 'h264', notes: [] }, warnings: []
  }
  return { ...project, analysisByMedia: { [asset.id]: analysis } }
}

describe('evidence-based Shorts candidates', () => {
  it('returns source and timeline ranges backed by real transcript, scene, and silence data', () => {
    const result = findShortCandidates(projectWithTranscript(), 12, 3)

    expect(result.available).toBe(true)
    expect(result.candidates.length).toBeGreaterThan(0)
    const top = result.candidates[0]
    expect(top).toMatchObject({
      mediaId: asset.id, sourceStart: 8.2, sourceEnd: 20.2, timelineStart: 3.2, timelineEnd: 15.2,
      durationSeconds: 12, score: expect.any(Number)
    })
    expect(top.score).toBeGreaterThan(0)
    expect(top.transcriptExcerpt).toContain('The team compared three options')
    expect(top.transcriptExcerpt).toContain('confirmed the improvement')
    expect(top.evidence).toMatchObject({ transcriptSegments: 4, sceneBoundaryCount: 2, silenceSeconds: 1.2, averageTranscriptConfidence: 0.913 })
    expect(JSON.stringify(top)).not.toContain(asset.filePath)
  })

  it('uses approved visual-index evidence when local transcript is unavailable', () => {
    const project = addMediaToTimeline(createProject('No transcript', 'C:/Project'), [asset])
    project.analysisByMedia[asset.id] = {
      mediaId: asset.id, analyzedAt: new Date(0).toISOString(), scenes: [{ start: 0, end: 20 }, { start: 20, end: 40 }], silences: [], transcript: [],
      audio: { clippingDetected: false, silenceCount: 0, analyzed: true },
      quality: { width: 1920, height: 1080, fps: 30, videoCodec: 'h264', notes: [] }, warnings: [],
      visualIndex: {
        provider: 'gemini', analyzedAt: new Date(0).toISOString(), sampleIntervalSeconds: 1, durationSeconds: 40, frameCount: 40,
        shots: [{ index: 1, start: 0, end: 20, description: 'A person demonstrates a product.' }, { index: 2, start: 20, end: 40, description: 'The product is shown in close-up.' }],
        moments: [
          { timestampSeconds: 2, second: 2, shotIndex: 1, description: 'A person demonstrates a product.', visibleText: '' },
          { timestampSeconds: 12, second: 12, shotIndex: 1, description: 'The person points to a feature.', visibleText: '' },
          { timestampSeconds: 24, second: 24, shotIndex: 2, description: 'The product is shown in close-up.', visibleText: '' }
        ], summary: 'A product demonstration.'
      }
    }
    const result = findShortCandidates(project)
    expect(result.available).toBe(true)
    expect(result.candidates[0].transcriptExcerpt).toContain('A person demonstrates a product.')
    expect(result.candidates[0].evidence.transcriptSegments).toBe(0)
  })
})
