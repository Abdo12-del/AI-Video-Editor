import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AnalysisResult, AppSettings, MediaAsset, ProjectData } from '../shared/types'
import { addAudioToTimeline, addMediaToTimeline, createProject, getMusicClips, getVideoClips, projectDuration } from '../shared/project'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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
import { __clearAllConversationSessions, getConversationSession, projectRevisionHash, setPendingAction } from './conversationStore'

beforeEach(() => {
  __clearAllConversationSessions()
  vi.clearAllMocks()
})

const arSettings: AppSettings = {
  language: 'ar', ollamaEnabled: false, ollamaModel: 'qwen2.5:7b', whisperBinaryPath: '', whisperModelPath: ''
}
const enSettings: AppSettings = { ...arSettings, language: 'en' }
const frSettings: AppSettings = { ...arSettings, language: 'fr' }
const secretKey = 'agent-test-secret-not-an-api-key-123456789'
const report = vi.fn()

function videoAsset(id: string, name: string, duration: number): MediaAsset {
  return {
    id, name, filePath: `/private/source/${name}`, duration,
    width: 1920, height: 1080, fps: 30, sizeBytes: 1024, hasAudio: true,
    videoCodec: 'h264', audioCodec: 'aac', importedAt: new Date().toISOString()
  }
}

function audioAsset(id: string, name: string, duration: number): MediaAsset {
  return {
    id, name, filePath: `/private/source/${name}`, duration,
    width: 0, height: 0, fps: 30, sizeBytes: 512, hasAudio: true,
    videoCodec: 'none', audioCodec: 'pcm_s16le', importedAt: new Date().toISOString()
  }
}

function silenceAnalysis(mediaId: string, silences: Array<{ start: number; end: number; duration: number }>): AnalysisResult {
  return {
    mediaId, analyzedAt: new Date().toISOString(), scenes: [{ start: 0, end: 60 }], silences, transcript: [],
    audio: { clippingDetected: false, silenceCount: silences.length, analyzed: true },
    quality: { width: 1920, height: 1080, fps: 30, videoCodec: 'h264', notes: [] }, warnings: []
  }
}

function silenceProject(): ProjectData {
  let project = createProject('Silence chat', join(tmpdir(), 'aivideo-chat-silence'))
  project = addMediaToTimeline(project, [videoAsset('media-1', 'Interview.mp4', 60)])
  const analysis = silenceAnalysis('media-1', [
    { start: 10, end: 16, duration: 6 },
    { start: 30, end: 39, duration: 9 }
  ])
  return { ...project, analysisByMedia: { 'media-1': analysis } }
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

describe('conversation memory: confirm / cancel in context', () => {
  it('group 1: silence question then نعم executes against the stored pending action', async () => {
    const project = silenceProject()
    const asked = await sendAgentMessage(project, 'احذف فترات الصمت', arSettings, 'chat-job', report, null)

    expect(asked.reply).toContain('هل تريد حذفها')
    expect(asked.reply).toContain('2 مقاطع صامتة')
    expect(asked.conversation?.status).toBe('WAITING_FOR_CONFIRMATION')
    expect(asked.conversation?.hasPendingAction).toBe(true)
    expect(asked.steps?.map((step) => step.state)).toEqual(['done', 'done', 'active'])
    expect(mocks.generateGeminiTurn).not.toHaveBeenCalled()

    const confirmed = await sendAgentMessage(asked.project, 'نعم', arSettings, 'chat-job', report, null)
    expect(confirmed.reply).toContain('حُذفت 2 فترة صمت')
    expect(getVideoClips(confirmed.project)).toHaveLength(3)
    expect(confirmed.project.history.undo.length).toBeGreaterThan(0)
    expect(confirmed.conversation?.status).toBe('COMPLETED')
    expect(confirmed.conversation?.hasPendingAction).toBe(false)
    expect(mocks.generateGeminiTurn).not.toHaveBeenCalled()
  })

  it('group 2: silence question then لا cancels and keeps the timeline', async () => {
    const project = silenceProject()
    const asked = await sendAgentMessage(project, 'احذف فترات الصمت', arSettings, 'chat-job', report, null)
    const cancelled = await sendAgentMessage(asked.project, 'لا', arSettings, 'chat-job', report, null)

    expect(cancelled.reply).toContain('تم الإلغاء')
    expect(cancelled.reply).toContain('لن أنفذ')
    expect(getVideoClips(cancelled.project)).toHaveLength(1)
    expect(cancelled.project.history.undo).toHaveLength(0)
    expect(cancelled.conversation?.status).toBe('CANCELLED')
  })

  it('group 3: long confirm phrases (نعم، نفذه / تمام نفذها) execute the pending action', async () => {
    for (const confirm of ['نعم، نفذه', 'تمام نفذها']) {
      __clearAllConversationSessions()
      const project = silenceProject()
      const asked = await sendAgentMessage(project, 'احذف فترات الصمت', arSettings, 'chat-job', report, null)
      const confirmed = await sendAgentMessage(asked.project, confirm, arSettings, 'chat-job', report, null)
      expect(confirmed.reply).toContain('حُذفت 2 فترة صمت')
      expect(getVideoClips(confirmed.project)).toHaveLength(3)
    }
  })

  it('group 4: seeded music pending action resolves yes/oui in English and French', async () => {
    for (const [settings, yes] of [[enSettings, 'yes'], [frSettings, 'oui']] as const) {
      __clearAllConversationSessions()
      let project = createProject('Music chat', join(tmpdir(), 'aivideo-chat-music'))
      project = addMediaToTimeline(project, [videoAsset('media-1', 'Interview.mp4', 60)])
      project = { ...project, media: [...project.media, audioAsset('music-1', 'Theme.wav', 30)] }
      const session = getConversationSession(project.id)
      const question = settings.language === 'fr' ? 'Ajouter cette musique ?' : 'Add this music?'
      setPendingAction(session, {
        id: 'pending-music', type: 'add_music', tool: 'add_music',
        parameters: { media_id: 'music-1', position: 0 },
        reason: 'seeded for confirmation', question,
        projectRevision: projectRevisionHash(project), projectId: project.id,
        createdAt: new Date().toISOString()
      })
      const confirmed = await sendAgentMessage(project, yes, settings, 'chat-job', report, null)
      expect(getMusicClips(confirmed.project)).toHaveLength(1)
      expect(getMusicClips(confirmed.project)[0].mediaId).toBe('music-1')
      expect(confirmed.reply).toContain('Theme.wav')
      expect(confirmed.conversation?.status).toBe('COMPLETED')
      expect(mocks.generateGeminiTurn).not.toHaveBeenCalled()
    }
  })
})

describe('conversation memory: values, follow-ups, and pronouns', () => {
  it('group 5: music volume question then 50% applies −6.02 dB to the focused music', async () => {
    let project = createProject('Volume chat', join(tmpdir(), 'aivideo-chat-volume'))
    project = addMediaToTimeline(project, [videoAsset('media-1', 'Interview.mp4', 60)])
    project = addAudioToTimeline(project, [audioAsset('music-1', 'Theme.wav', 30)], 0)

    const asked = await sendAgentMessage(project, 'اخفض صوتها', arSettings, 'chat-job', report, null)
    expect(asked.reply).toContain('مستوى')
    expect(asked.conversation?.waitingForInput).toBe(true)

    const applied = await sendAgentMessage(asked.project, '50', arSettings, 'chat-job', report, null)
    expect(applied.reply).toContain('50%')
    expect(getMusicClips(applied.project)[0].gainDb).toBeCloseTo(20 * Math.log10(0.5), 2)
    expect(applied.conversation?.status).toBe('COMPLETED')
  })

  it('group 6: multi-turn silence then music keeps decisions and tool history', async () => {
    let project = createProject('Multi chat', join(tmpdir(), 'aivideo-chat-multi'))
    project = addMediaToTimeline(project, [videoAsset('media-1', 'Interview.mp4', 60)])
    project = {
      ...project,
      media: [...project.media, audioAsset('audio-a', 'SongA.wav', 30), audioAsset('audio-b', 'SongB.wav', 30)],
      analysisByMedia: { 'media-1': silenceAnalysis('media-1', [{ start: 10, end: 16, duration: 6 }]) }
    }

    const asked = await sendAgentMessage(project, 'احذف فترات الصمت', arSettings, 'chat-job', report, null)
    const silenceless = await sendAgentMessage(asked.project, 'نعم', arSettings, 'chat-job', report, null)
    expect(getVideoClips(silenceless.project)).toHaveLength(2)

    const choice = await sendAgentMessage(silenceless.project, 'أضف موسيقى من اختيارك', arSettings, 'chat-job', report, null)
    expect(choice.reply).toContain('SongA.wav')
    expect(choice.conversation?.waitingForInput).toBe(true)

    const withMusic = await sendAgentMessage(choice.project, '2', arSettings, 'chat-job', report, null)
    expect(getMusicClips(withMusic.project)).toHaveLength(1)
    expect(getMusicClips(withMusic.project)[0].mediaId).toBe('audio-a')

    const session = getConversationSession(project.id)
    expect(session.decisions.length).toBeGreaterThanOrEqual(2)
    expect(session.lastToolResults.map((item) => item.tool)).toEqual(expect.arrayContaining(['remove_silence', 'add_music']))
    expect(session.messages.length).toBeGreaterThan(4)
  })

  it('group 7: Gemini partial failure then أكمل continues with the dialogue history', async () => {
    let project = createProject('Continue chat', join(tmpdir(), 'aivideo-chat-continue'))
    project = addMediaToTimeline(project, [videoAsset('media-1', 'Interview.mp4', 20)])
    mocks.generateGeminiTurn
      .mockResolvedValueOnce(functionTurn([{ id: 'ratio-1', name: 'change_aspect_ratio', args: { aspect_ratio: '9:16' } }]))
      .mockRejectedValueOnce(new Error('temporary network failure'))
      .mockResolvedValueOnce(textTurn('Continuing: portrait framing is already applied.'))

    const partial = await sendAgentMessage(project, 'Make this video vertical.', enSettings, 'chat-job', report, secretKey)
    expect(mocks.generateGeminiTurn).toHaveBeenCalledTimes(2)
    expect(partial.project.exportSettings.aspectRatio).toBe('9:16')
    expect(partial.reply).toContain('follow-up turn')

    const continued = await sendAgentMessage(partial.project, 'أكمل', enSettings, 'chat-job', report, secretKey)
    expect(mocks.generateGeminiTurn).toHaveBeenCalledTimes(3)
    const resumed = mocks.generateGeminiTurn.mock.calls[2][1] as { contents: Array<{ role?: string; parts?: Array<{ text?: string }> }>; systemInstruction: string }
    expect(resumed.contents[0]).toEqual({ role: 'user', parts: [{ text: 'Make this video vertical.' }] })
    expect(resumed.contents.at(-1)).toEqual({ role: 'user', parts: [{ text: 'أكمل' }] })
    expect(resumed.systemInstruction).toContain('Conversation state')
    expect(resumed.systemInstruction).toContain('change_aspect_ratio')
    expect(continued.reply).toBe('Continuing: portrait framing is already applied.')
  })

  it('group 8: المقطع الثاني then قصه trims the referenced clip after asking for duration', async () => {
    let project = createProject('Pronoun chat', join(tmpdir(), 'aivideo-chat-pronoun'))
    project = addMediaToTimeline(project, [videoAsset('media-1', 'One.mp4', 60), videoAsset('media-2', 'Two.mp4', 60)])
    const secondClipId = getVideoClips(project)[1].id

    const focused = await sendAgentMessage(project, 'المقطع الثاني', arSettings, 'chat-job', report, null)
    expect(focused.reply).toContain('ماذا تريد أن تفعل به')
    expect(getConversationSession(project.id).focus?.index).toBe(2)

    const trimAsked = await sendAgentMessage(focused.project, 'قصه', arSettings, 'chat-job', report, null)
    expect(trimAsked.reply).toContain('رقم 2')
    expect(getConversationSession(project.id).pendingAction?.type).toBe('trim_clip')

    const trimmed = await sendAgentMessage(trimAsked.project, '30 ثانية', arSettings, 'chat-job', report, null)
    expect(trimmed.reply).toContain('30')
    const clip = getVideoClips(trimmed.project).find((item) => item.id === secondClipId)
    expect(clip).toBeDefined()
    expect(clip!.sourceOut - clip!.sourceIn).toBeCloseTo(30, 1)
  })

  it('group 9: orphan نعم references the dialogue instead of restarting it', async () => {
    let project = createProject('Orphan chat', join(tmpdir(), 'aivideo-chat-orphan'))
    project = addMediaToTimeline(project, [videoAsset('media-1', 'Interview.mp4', 60)])

    const orphan = await sendAgentMessage(project, 'نعم', arSettings, 'chat-job', report, null)
    expect(orphan.reply).toContain('لا توجد عملية بانتظار الموافقة')
    expect(orphan.reply).toContain('Short')
    expect(orphan.conversation?.status).toBe('COMPLETED')
    expect(mocks.generateGeminiTurn).not.toHaveBeenCalled()

    const unknown = await sendAgentMessage(orphan.project, 'حدثني عن المونتاج', arSettings, 'chat-job', report, null)
    expect(unknown.reply).toContain('Gemini')
    const reminded = await sendAgentMessage(unknown.project, 'نعم', arSettings, 'chat-job', report, null)
    expect(reminded.reply).toContain('آخر ما طلبته')
    expect(reminded.reply).toContain('حدثني عن المونتاج')
  })
})

describe('conversation memory: shorts, supersede, and French confirmations', () => {
  it('short request then نعم creates the vertical Short from the best segment', async () => {
    let project = createProject('Short chat', join(tmpdir(), 'aivideo-chat-short'))
    project = addMediaToTimeline(project, [videoAsset('media-1', 'Interview.mp4', 120)])
    const analysis: AnalysisResult = {
      mediaId: 'media-1', analyzedAt: new Date().toISOString(),
      scenes: [{ start: 0, end: 8 }, { start: 8, end: 16 }],
      silences: [{ start: 80, end: 86, duration: 6 }],
      transcript: [
        { id: 't1', start: 0.5, end: 4, text: 'We tested the workflow and found a reliable improvement.' },
        { id: 't2', start: 4.2, end: 8, text: 'The team compared real results before choosing the final design.' },
        { id: 't3', start: 8.2, end: 12, text: 'Then we measured the change and confirmed the result.' }
      ],
      audio: { clippingDetected: false, silenceCount: 1, analyzed: true },
      quality: { width: 1920, height: 1080, fps: 30, videoCodec: 'h264', notes: [] }, warnings: []
    }
    project = { ...project, analysisByMedia: { 'media-1': analysis } }

    const asked = await sendAgentMessage(project, 'أنشئ Short عموديًا', arSettings, 'chat-job', report, null)
    expect(asked.proposal?.action).toMatchObject({ type: 'create-short', aspectRatio: '9:16' })
    expect(asked.reply).toContain('Short')
    expect(asked.conversation?.hasPendingAction).toBe(true)

    const created = await sendAgentMessage(asked.project, 'نعم', arSettings, 'chat-job', report, null)
    expect(created.reply).toContain('تم إنشاء الـShort')
    expect(created.project.exportSettings.aspectRatio).toBe('9:16')
    expect(projectDuration(created.project)).toBeLessThan(120)
  })

  it('a new actionable command supersedes the pending confirmation', async () => {
    const project = silenceProject()
    const asked = await sendAgentMessage(project, 'احذف فترات الصمت', arSettings, 'chat-job', report, null)
    expect(getConversationSession(project.id).pendingAction?.type).toBe('delete_silence')

    const replaced = await sendAgentMessage(asked.project, 'احذف أول 5 ثوان', arSettings, 'chat-job', report, null)
    expect(replaced.reply).toContain('حُذف الجزء')
    expect(projectDuration(replaced.project)).toBeCloseTo(55, 1)
    const session = getConversationSession(project.id)
    expect(session.pendingAction).toBeNull()
    expect(session.decisions.join(' ')).toContain('dropped pending')
  })

  it('French silence flow confirms with oui', async () => {
    const project = silenceProject()
    const asked = await sendAgentMessage(project, 'supprime les silences', frSettings, 'chat-job', report, null)
    expect(asked.reply).toContain('Les supprimer ?')

    const confirmed = await sendAgentMessage(asked.project, 'oui', frSettings, 'chat-job', report, null)
    expect(confirmed.reply).toContain('supprimé(s)')
    expect(getVideoClips(confirmed.project)).toHaveLength(3)
  })
})
