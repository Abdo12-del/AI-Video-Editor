import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AnalysisResult, AppSettings, MediaAsset, ProjectData, VisualIndex } from '../shared/types'
import { addMediaToTimeline, createProject, getMusicClips } from '../shared/project'
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
import { executeAgentTool, getAgentToolDefinitions, registerAgentTool } from './agentToolRegistry'

afterEach(() => vi.clearAllMocks())

const settings: AppSettings = {
  language: 'en', ollamaEnabled: false, ollamaModel: 'qwen2.5:7b', whisperBinaryPath: '', whisperModelPath: ''
}
const secretKey = 'agent-test-secret-not-an-api-key-123456789'
const report = vi.fn()

function createTestProject(duration = 0): ProjectData {
  let project = createProject('Test project', join(tmpdir(), 'aivideo-test-project'))
  if (duration > 0) {
    const asset: MediaAsset = {
      id: 'media-1', name: 'Interview.mp4', filePath: '/private/source/Interview.mp4', duration,
      width: 1920, height: 1080, fps: 30, sizeBytes: 1024, hasAudio: true, videoCodec: 'h264',
      audioCodec: 'aac', importedAt: new Date().toISOString()
    }
    project = addMediaToTimeline(project, [asset])
  }
  return project
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

describe('Gemini editing agent loop', () => {
  it('registers timestamped visual context and maps Timeline time back to source time without describing unindexed video', async () => {
    let project = createTestProject(20)
    const clip = project.timeline.clips[0]
    project = {
      ...project,
      timeline: { ...project.timeline, clips: [{ ...clip, position: 5, sourceIn: 3, sourceOut: 20 }] }
    }
    const analyzedAt = new Date().toISOString()
    const visualIndex: VisualIndex = {
      provider: 'gemini', analyzedAt, sampleIntervalSeconds: 1, durationSeconds: 20, frameCount: 20,
      summary: 'A presenter speaks to camera in a bright studio.',
      shots: [{ index: 1, start: 0, end: 20, description: 'A presenter speaks to camera in a bright studio.' }],
      moments: Array.from({ length: 20 }, (_, second) => ({
        timestampSeconds: second, second, shotIndex: 1,
        description: `A presenter speaks to camera at source second ${second}.`,
        visibleText: second === 6 ? 'Studio update' : undefined
      }))
    }
    const analysis: AnalysisResult = {
      mediaId: 'media-1', analyzedAt, scenes: [{ start: 0, end: 20 }], silences: [], transcript: [],
      audio: { clippingDetected: false, silenceCount: 0, analyzed: false },
      quality: { width: 1920, height: 1080, fps: 30, videoCodec: 'h264', notes: [] }, warnings: [], visualIndex
    }
    project = { ...project, analysisByMedia: { ...project.analysisByMedia, 'media-1': analysis } }
    mocks.generateGeminiTurn.mockResolvedValueOnce(textTurn('I can answer from the saved still-frame captions.'))

    await sendAgentMessage(project, 'What is visible near eight seconds?', settings, 'visual-register-job', report, secretKey)

    expect(getAgentToolDefinitions().map((tool) => tool.name)).toContain('get_visual_context')
    const context = { project, settings, jobId: 'visual-query-job', report }
    const point = await executeAgentTool('get_visual_context', { time_seconds: 8 }, context)
    expect(point.result).toMatchObject({
      available: true, mode: 'point', mediaName: 'Interview.mp4', timelineTimeSeconds: 8,
      requestedSourceTimeSeconds: 6, nearestSampleTimeSeconds: 6
    })
    expect(JSON.stringify(point.result)).toContain('A presenter speaks to camera at source second 6.')
    expect(JSON.stringify(point.result)).toContain('Studio update')

    const range = await executeAgentTool('get_visual_context', { start_seconds: 7, end_seconds: 10 }, context)
    expect(range.result).toMatchObject({ mode: 'timeline-range', timelineRangeSeconds: [7, 10] })
    expect(JSON.stringify(range.result)).toContain('"sourceRangeSeconds":[5,8]')
    expect(JSON.stringify(range.result)).toContain('"timelineTimeSeconds":7')
    expect(JSON.stringify(range.result)).toContain('"timelineTimeSeconds":9')

    const withoutIndex = createTestProject(20)
    const missing = await executeAgentTool('get_visual_context', { media_id: 'media-1' }, { ...context, project: withoutIndex })
    expect(missing.result).toMatchObject({ available: false })
    expect(JSON.stringify(missing.result)).toContain('No visual index')
  })

  it('lets Gemini choose sequential edits, returns each updated revision, and previews the final project', async () => {
    const project = createTestProject(20)
    mocks.generateGeminiTurn
      .mockResolvedValueOnce(functionTurn([{ id: 'ratio-1', name: 'change_aspect_ratio', args: { aspect_ratio: '9:16' } }]))
      .mockResolvedValueOnce(functionTurn([{ id: 'audio-1', name: 'change_volume', args: { percent: 15 } }]))
      .mockResolvedValueOnce(functionTurn([{ id: 'preview-1', name: 'preview_changes', args: {} }]))
      .mockResolvedValueOnce(textTurn('I changed the frame to portrait, raised the clip audio, and refreshed the project preview.'))

    const response = await sendAgentMessage(project, 'Make this video vertical and raise the speaking volume a little.', settings, 'agent-job', report, secretKey)

    expect(mocks.generateGeminiTurn).toHaveBeenCalledTimes(4)
    expect(response.project.exportSettings.aspectRatio).toBe('9:16')
    expect(response.project.history.undo).toHaveLength(2)
    expect(response.project.timeline.clips[0].gainDb).toBeGreaterThan(0)
    expect(response.reply).toContain('refreshed the project preview')

    const firstRequest = mocks.generateGeminiTurn.mock.calls[0][1] as { functionDeclarations: Array<{ name: string }>; contents: Array<Record<string, unknown>> }
    expect(firstRequest.functionDeclarations.map((tool) => tool.name)).toContain('get_project_state')
    expect(firstRequest.functionDeclarations.map((tool) => tool.name)).toContain('get_transcript')
    expect(firstRequest.contents[0]).toEqual({ role: 'user', parts: [{ text: 'Make this video vertical and raise the speaking volume a little.' }] })

    const followUp = mocks.generateGeminiTurn.mock.calls[1][1] as { contents: Array<{ role?: string; parts?: Array<Record<string, unknown>> }> }
    const responseParts = followUp.contents[2]?.parts ?? []
    expect(responseParts).toHaveLength(1)
    expect(JSON.stringify(responseParts)).toContain('9:16')
    expect(JSON.stringify(responseParts)).toContain('projectRevision')
    expect(JSON.stringify(responseParts)).toContain('"ok":true')
    expect(JSON.stringify(mocks.writeLog.mock.calls)).not.toContain(secretKey)
  })

  it('rejects stale later edits from the same model revision and preserves the first successful edit', async () => {
    const project = createTestProject(20)
    mocks.generateGeminiTurn.mockResolvedValueOnce(functionTurn([
      { id: 'ratio-1', name: 'change_aspect_ratio', args: { aspect_ratio: '9:16' } },
      { id: 'volume-stale', name: 'change_volume', args: { percent: 15 } },
      { id: 'subtitle-stale', name: 'add_subtitle', args: { start: 1, end: 2, text: 'Must not run' } }
    ]))

    const response = await sendAgentMessage(project, 'Make the video vertical, raise volume, and add a caption.', settings, 'agent-job', report, secretKey)

    expect(mocks.generateGeminiTurn).toHaveBeenCalledTimes(1)
    expect(response.project.exportSettings.aspectRatio).toBe('9:16')
    expect(response.project.timeline.clips[0].gainDb).toBe(0)
    expect(response.project.subtitles).toHaveLength(0)
    expect(response.project.history.undo).toHaveLength(1)
    expect(response.reply).toContain('project-revision conflict')
    expect(response.reply).toContain('Earlier successful edits were preserved')
  })

  it('stops after a tool failure, keeps prior successful edits, and does not run later steps', async () => {
    const project = createTestProject(20)
    mocks.generateGeminiTurn
      .mockResolvedValueOnce(functionTurn([{ id: 'ratio-1', name: 'change_aspect_ratio', args: { aspect_ratio: '9:16' } }]))
      .mockResolvedValueOnce(functionTurn([
        { id: 'bad-subtitle', name: 'add_subtitle', args: { start: 3, end: 2, text: 'Invalid timing' } },
        { id: 'volume-after-failure', name: 'change_volume', args: { percent: 15 } }
      ]))

    const response = await sendAgentMessage(project, 'Make the video vertical, add a caption, and raise volume.', settings, 'agent-job', report, secretKey)

    expect(mocks.generateGeminiTurn).toHaveBeenCalledTimes(2)
    expect(response.project.exportSettings.aspectRatio).toBe('9:16')
    expect(response.project.timeline.clips[0].gainDb).toBe(0)
    expect(response.project.subtitles).toHaveLength(0)
    expect(response.project.history.undo).toHaveLength(1)
    expect(response.reply).toContain('Tool(s) did not complete: add_subtitle')
    expect(JSON.stringify(mocks.writeLog.mock.calls)).not.toContain(secretKey)
  })

  it('lets Gemini add imported audio to the independent music track, return the result, and mute the track next', async () => {
    let project = createTestProject(20)
    const audio: MediaAsset = {
      ...project.media[0], id: 'music-1', name: 'theme.wav', filePath: '/private/source/theme.wav',
      width: 0, height: 0, videoCodec: 'none', audioCodec: 'pcm_s16le', hasAudio: true
    }
    project = { ...project, media: [...project.media, audio] }
    mocks.generateGeminiTurn
      .mockResolvedValueOnce(functionTurn([{ id: 'audio-1', name: 'add_audio', args: { media_id: audio.id, position: 0, gain_db: -4 } }]))
      .mockResolvedValueOnce(functionTurn([{ id: 'mute-1', name: 'mute_track', args: { track_id: 'track-music', muted: true } }]))
      .mockResolvedValueOnce(textTurn('I added the imported music and muted its track as requested.'))

    const response = await sendAgentMessage(project, 'Add the imported theme and mute that track.', settings, 'agent-job', report, secretKey)

    expect(mocks.generateGeminiTurn).toHaveBeenCalledTimes(3)
    expect(getMusicClips(response.project)).toHaveLength(1)
    expect(getMusicClips(response.project)[0].gainDb).toBe(-4)
    expect(response.project.timeline.tracks.find((track) => track.id === 'track-music')?.muted).toBe(true)
    expect(response.project.history.undo).toHaveLength(2)
    const tools = mocks.generateGeminiTurn.mock.calls[0][1] as { functionDeclarations: Array<{ name: string }> }
    expect(tools.functionDeclarations.map((tool) => tool.name)).toContain('trim_audio_clip')
    const followUp = mocks.generateGeminiTurn.mock.calls[1][1] as { contents: Array<{ parts?: Array<Record<string, unknown>> }> }
    expect(JSON.stringify(followUp.contents.at(-1)?.parts)).toContain('trackId')
    expect(JSON.stringify(followUp.contents.at(-1)?.parts)).toContain('track-music')
  })

  it('lets Gemini create a real undoable subtitle and returns the created timing to the model', async () => {
    const project = createTestProject(20)
    mocks.generateGeminiTurn
      .mockResolvedValueOnce(functionTurn([{ id: 'subtitle-1', name: 'add_subtitle', args: { start: 1.25, end: 3.5, text: 'A confirmed caption' } }]))
      .mockResolvedValueOnce(textTurn('I added the caption from 1.25 to 3.5 seconds.'))

    const response = await sendAgentMessage(project, 'Add a caption from 1.25 to 3.5 seconds.', settings, 'agent-job', report, secretKey)

    expect(response.project.subtitles).toHaveLength(1)
    expect(response.project.subtitles[0]).toMatchObject({ start: 1.25, end: 3.5, text: 'A confirmed caption' })
    expect(response.project.history.undo).toHaveLength(1)
    const declaration = mocks.generateGeminiTurn.mock.calls[0][1] as { functionDeclarations: Array<{ name: string }> }
    expect(declaration.functionDeclarations.map((tool) => tool.name)).toContain('add_audio')
    expect(declaration.functionDeclarations.map((tool) => tool.name)).toContain('update_subtitle')
    const followUp = mocks.generateGeminiTurn.mock.calls[1][1] as { contents: Array<{ parts?: Array<Record<string, unknown>> }> }
    expect(JSON.stringify(followUp.contents.at(-1)?.parts)).toContain('subtitleId')
    expect(JSON.stringify(followUp.contents.at(-1)?.parts)).toContain('A confirmed caption')
  })

  it('uses transcript-backed Shorts candidates and holds a large vertical extraction for approval', async () => {
    const project = createTestProject(120)
    const asset = project.media[0]
    const analysis: AnalysisResult = {
      mediaId: asset.id, analyzedAt: new Date().toISOString(), scenes: [{ start: 0, end: 8 }, { start: 8, end: 16 }],
      silences: [{ start: 80, end: 86, duration: 6 }],
      transcript: [
        { id: 't1', start: 0.5, end: 4, text: 'We tested the workflow and found a reliable improvement.' },
        { id: 't2', start: 4.2, end: 8, text: 'The team compared real results before choosing the final design.' },
        { id: 't3', start: 8.2, end: 12, text: 'Then we measured the change and confirmed the result.' }
      ],
      audio: { clippingDetected: false, silenceCount: 1, analyzed: true },
      quality: { width: 1920, height: 1080, fps: 30, videoCodec: 'h264', notes: [] }, warnings: []
    }
    const analyzed = { ...project, analysisByMedia: { [asset.id]: analysis } }
    mocks.generateGeminiTurn
      .mockResolvedValueOnce(functionTurn([{ id: 'candidates-1', name: 'find_short_candidates', args: { max_duration_seconds: 20, limit: 3 } }]))
      .mockResolvedValueOnce(functionTurn([{ id: 'short-1', name: 'create_short_from_range', args: { start: 0, end: 20, aspect_ratio: '9:16' } }]))

    const response = await sendAgentMessage(analyzed, 'Find and prepare a vertical Short from the strongest real segment.', settings, 'agent-job', report, secretKey)

    expect(mocks.generateGeminiTurn).toHaveBeenCalledTimes(2)
    expect(response.project.history.undo).toHaveLength(0)
    expect(response.project.exportSettings.aspectRatio).toBe('16:9')
    expect(response.proposal?.action).toMatchObject({ type: 'create-short', start: 0, end: 20, aspectRatio: '9:16', baseUpdatedAt: analyzed.updatedAt })
    const declarations = mocks.generateGeminiTurn.mock.calls[0][1] as { functionDeclarations: Array<{ name: string }>; systemInstruction: string }
    expect(declarations.functionDeclarations.map((tool) => tool.name)).toContain('find_short_candidates')
    expect(declarations.functionDeclarations.map((tool) => tool.name)).toContain('create_short_from_range')
    expect(declarations.systemInstruction).toContain('actual transcript')
    const candidateResults = mocks.generateGeminiTurn.mock.calls[1][1] as { contents: Array<{ parts?: Array<Record<string, unknown>> }> }
    expect(JSON.stringify(candidateResults.contents)).toContain('transcriptExcerpt')
    expect(response.reply).toContain('waiting for your review')
  })

  it('returns successful project changes when Gemini fails during its follow-up turn', async () => {
    const project = createTestProject(20)
    mocks.generateGeminiTurn
      .mockResolvedValueOnce(functionTurn([{ id: 'ratio-1', name: 'change_aspect_ratio', args: { aspect_ratio: '9:16' } }]))
      .mockRejectedValueOnce(new Error('temporary network failure'))

    const response = await sendAgentMessage(project, 'Make this video vertical.', settings, 'agent-job', report, secretKey)

    expect(mocks.generateGeminiTurn).toHaveBeenCalledTimes(2)
    expect(response.project.exportSettings.aspectRatio).toBe('9:16')
    expect(response.project.history.undo).toHaveLength(1)
    expect(response.reply).toContain('follow-up turn')
    expect(response.reply).toContain('succeeded so far')
    expect(response.reply).not.toContain('temporary network failure')
    expect(mocks.writeLog).toHaveBeenCalledWith('warn', 'gemini_followup_failed', {
      projectId: project.id,
      code: 'unknown',
      toolCalls: 1
    })
    expect(JSON.stringify(mocks.writeLog.mock.calls)).not.toContain(secretKey)
  })

  it('reports unavailable transcript data honestly and supports dynamically registered future tools', async () => {
    const dynamicToolName = 'future_feature_test'
    const unregister = registerAgentTool({
      name: dynamicToolName,
      description: 'Test that future feature tools can be registered at runtime.',
      parameters: { type: 'OBJECT', properties: {} },
      mutatesProject: false,
      execute: (_args, context) => ({ project: context.project, result: { ok: true, feature: 'registered' } })
    })
    try {
      const project = createTestProject()
      mocks.generateGeminiTurn
        .mockResolvedValueOnce(functionTurn([
          { id: 'transcript-1', name: 'get_transcript', args: {} },
          { id: 'future-1', name: dynamicToolName, args: {} }
        ]))
        .mockResolvedValueOnce(textTurn('There is no transcript in this project; the registered feature tool ran successfully.'))

      const response = await sendAgentMessage(project, 'Do I have captions?', settings, 'agent-job', report, secretKey)
      const request = mocks.generateGeminiTurn.mock.calls[0][1] as { functionDeclarations: Array<{ name: string }> }
      expect(request.functionDeclarations.map((tool) => tool.name)).toContain(dynamicToolName)
      const results = mocks.generateGeminiTurn.mock.calls[1][1] as { contents: Array<{ parts?: Array<Record<string, unknown>> }> }
      const serializedResults = JSON.stringify(results.contents.at(-1)?.parts)
      expect(serializedResults).toContain('No transcript exists')
      expect(serializedResults).toContain('registered')
      expect(response.project.subtitles).toHaveLength(0)
    } finally {
      unregister()
    }
  })

  it('holds a large Gemini-proposed deletion for review and stops the rest of the edit plan', async () => {
    const project = createTestProject(100)
    mocks.generateGeminiTurn.mockResolvedValueOnce(functionTurn([
      { id: 'delete-1', name: 'delete_timeline_range', args: { start: 0, end: 50 } },
      { id: 'ratio-1', name: 'change_aspect_ratio', args: { aspect_ratio: '9:16' } }
    ]))

    const response = await sendAgentMessage(project, 'Remove the first half and make the video vertical.', settings, 'agent-job', report, secretKey)

    expect(mocks.generateGeminiTurn).toHaveBeenCalledTimes(1)
    expect(response.project.exportSettings.aspectRatio).toBe('16:9')
    expect(response.project.history.undo).toHaveLength(0)
    expect(response.proposal?.action).toMatchObject({ type: 'delete-range', start: 0, end: 50 })
    expect(response.reply).toContain('needs your review')
  })
})
