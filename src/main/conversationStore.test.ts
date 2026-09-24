import { beforeEach, describe, expect, it } from 'vitest'
import type { PendingAction } from '../shared/conversation'
import { addAudioToTimeline, addMediaToTimeline, createProject } from '../shared/project'
import type { MediaAsset, ProjectData } from '../shared/types'
import {
  __clearAllConversationSessions,
  addDecision,
  appendConversationMessage,
  buildGeminiHistoryContents,
  clearPendingAction,
  clearWaitingForInput,
  createEmptySession,
  formatConversationContextBlock,
  getConversationSession,
  hydrateSessionFromProject,
  projectRevisionHash,
  recordToolResult,
  resetConversationSession,
  setPendingAction,
  setWaitingForInput,
  summarizeIfNeeded,
  updateFocusFromTool
} from './conversationStore'

function asset(id: string, name: string, duration: number): MediaAsset {
  return {
    id, name, filePath: `/private/source/${name}`, duration,
    width: 1920, height: 1080, fps: 30, sizeBytes: 1024, hasAudio: true,
    videoCodec: 'h264', audioCodec: 'aac', importedAt: new Date().toISOString()
  }
}

function testProject(): ProjectData {
  let project = createProject('Store', '/tmp/aivideo-store')
  project = addMediaToTimeline(project, [asset('media-1', 'One.mp4', 60)])
  return project
}

function pendingAction(overrides: Partial<PendingAction> = {}): PendingAction {
  return {
    id: 'pending-1', type: 'delete_silence', tool: 'remove_silence',
    parameters: { minimum_duration: 1 }, reason: 'seeded', question: 'Delete them?',
    projectRevision: 'rev-1', projectId: 'project-1', createdAt: new Date().toISOString(),
    ...overrides
  }
}

beforeEach(() => __clearAllConversationSessions())

describe('projectRevisionHash', () => {
  it('is a stable 16-char fingerprint that changes with the project', () => {
    const project = testProject()
    const hash = projectRevisionHash(project)
    expect(hash).toMatch(/^[0-9a-f]{16}$/)
    expect(projectRevisionHash(project)).toBe(hash)
    expect(projectRevisionHash({ ...project, updatedAt: '2030-01-01T00:00:00.000Z' })).not.toBe(hash)
  })
})

describe('session lifecycle', () => {
  it('returns one stable session per project id', () => {
    const first = getConversationSession('project-1')
    expect(first.status).toBe('IDLE')
    expect(getConversationSession('project-1')).toBe(first)
    expect(getConversationSession('project-2')).not.toBe(first)
  })
  it('evicts the oldest session past the cap', () => {
    const first = getConversationSession('project-evict')
    appendConversationMessage(first, { role: 'user', content: 'remember me' })
    for (let index = 0; index < 20; index += 1) getConversationSession(`project-overflow-${index}`)
    expect(getConversationSession('project-evict').messages).toHaveLength(0)
  })
  it('resets a session to empty', () => {
    const session = getConversationSession('project-reset')
    appendConversationMessage(session, { role: 'user', content: 'hi' })
    setPendingAction(session, pendingAction())
    const fresh = resetConversationSession('project-reset')
    expect(fresh.messages).toHaveLength(0)
    expect(fresh.pendingAction).toBeNull()
    expect(fresh.status).toBe('IDLE')
  })
})

describe('pending + waiting state machine', () => {
  it('pending sets WAITING_FOR_CONFIRMATION and clears waiting input', () => {
    const session = createEmptySession('project-1')
    setWaitingForInput(session, { kind: 'volume_level', question: 'Level?', partial: {}, createdAt: new Date().toISOString() })
    setPendingAction(session, pendingAction())
    expect(session.status).toBe('WAITING_FOR_CONFIRMATION')
    expect(session.waitingForInput).toBeNull()
    expect(session.pendingAction?.type).toBe('delete_silence')
  })
  it('clearing pending maps outcomes to terminal states', () => {
    const session = createEmptySession('project-1')
    setPendingAction(session, pendingAction())
    clearPendingAction(session, 'cancelled')
    expect(session.pendingAction).toBeNull()
    expect(session.status).toBe('CANCELLED')
    setPendingAction(session, pendingAction())
    clearPendingAction(session, 'failed')
    expect(session.status).toBe('FAILED')
  })
  it('waiting sets WAITING_FOR_INPUT and clears independently', () => {
    const session = createEmptySession('project-1')
    setWaitingForInput(session, { kind: 'trim_duration', question: 'How long?', partial: { clipId: 'clip-1' }, createdAt: new Date().toISOString() })
    expect(session.status).toBe('WAITING_FOR_INPUT')
    clearWaitingForInput(session)
    expect(session.waitingForInput).toBeNull()
  })
})

describe('history bounds', () => {
  it('caps stored messages and truncates long content', () => {
    const session = createEmptySession('project-1')
    for (let index = 0; index < 70; index += 1) {
      appendConversationMessage(session, { role: index % 2 ? 'assistant' : 'user', content: `message ${index} ${'x'.repeat(5000)}` })
    }
    expect(session.messages).toHaveLength(60)
    expect(session.messages[0].content).toBe('message 10 ' + 'x'.repeat(5000).slice(0, 4000 - 'message 10 '.length))
  })
  it('folds old messages into a rule-based summary without an LLM call', () => {
    const session = createEmptySession('project-1')
    for (let index = 0; index < 41; index += 1) {
      appendConversationMessage(session, { role: index % 2 ? 'assistant' : 'user', content: `turn ${index}` })
    }
    summarizeIfNeeded(session)
    expect(session.messages).toHaveLength(20)
    expect(session.summary).toContain('turn 0')
    expect(session.summary).not.toContain('turn 40')
    expect(session.messages.at(-1)?.content).toBe('turn 40')
  })
  it('leaves short histories untouched', () => {
    const session = createEmptySession('project-1')
    appendConversationMessage(session, { role: 'user', content: 'hi' })
    summarizeIfNeeded(session)
    expect(session.messages).toHaveLength(1)
    expect(session.summary).toBe('')
  })
  it('bounds tool records and decisions', () => {
    const session = createEmptySession('project-1')
    for (let index = 0; index < 12; index += 1) recordToolResult(session, `tool-${index}`, true, 'ok')
    expect(session.lastToolResults).toHaveLength(8)
    expect(session.lastToolResults[0].tool).toBe('tool-4')
    addDecision(session, 'same')
    addDecision(session, 'same')
    expect(session.decisions).toEqual(['same'])
  })
})

describe('hydrateSessionFromProject', () => {
  it('restores recent chat log entries so restarts keep the dialogue', () => {
    const session = createEmptySession('project-1')
    const project = testProject()
    project.chatMessages = [
      { id: 'm1', role: 'user', content: 'remove silence', createdAt: new Date().toISOString() },
      { id: 'm2', role: 'assistant', content: 'Delete them?', createdAt: new Date().toISOString() }
    ]
    hydrateSessionFromProject(session, project)
    expect(session.messages.map((message) => message.content)).toEqual(['remove silence', 'Delete them?'])
    // Never overwrites a live session.
    hydrateSessionFromProject(session, project)
    expect(session.messages).toHaveLength(2)
  })
})

describe('buildGeminiHistoryContents', () => {
  it('returns [] for a fresh session so single-turn calls are unchanged', () => {
    const session = createEmptySession('project-1')
    appendConversationMessage(session, { role: 'user', content: 'current request' })
    expect(buildGeminiHistoryContents(session)).toEqual([])
  })
  it('maps prior turns to user/model contents, excluding the current message', () => {
    const session = createEmptySession('project-1')
    appendConversationMessage(session, { role: 'user', content: 'first request' })
    appendConversationMessage(session, { role: 'assistant', content: 'first answer', toolCall: { name: 'change_aspect_ratio', args: {} } })
    appendConversationMessage(session, { role: 'user', content: 'current request' })
    expect(buildGeminiHistoryContents(session)).toEqual([
      { role: 'user', parts: [{ text: 'first request' }] },
      { role: 'model', parts: [{ text: 'first answer\n[Executed tool: change_aspect_ratio]' }] }
    ])
  })
})

describe('formatConversationContextBlock', () => {
  it('is empty for fresh sessions and forbids greeting resets otherwise', () => {
    const fresh = createEmptySession('project-1')
    expect(formatConversationContextBlock(fresh)).toBe('')
    const session = createEmptySession('project-1')
    appendConversationMessage(session, { role: 'user', content: 'first' })
    appendConversationMessage(session, { role: 'assistant', content: 'second' })
    const block = formatConversationContextBlock(session)
    expect(block).toContain('Conversation state')
    expect(block).toContain('never greet as if this were a new conversation')
  })
  it('carries pending actions, focus, and tool results as dialogue metadata', () => {
    const session = createEmptySession('project-1')
    appendConversationMessage(session, { role: 'user', content: 'remove silence' })
    setPendingAction(session, pendingAction({ question: 'Found 2 silent segments. Delete them?' }))
    recordToolResult(session, 'find_silences', true, 'found 2')
    const block = formatConversationContextBlock(session, 'The user refers to clip #1.')
    expect(block).toContain('AWAITING USER CONFIRMATION')
    expect(block).toContain('Found 2 silent segments. Delete them?')
    expect(block).toContain('find_silences: ok')
    expect(block).toContain('clip #1')
  })
})

describe('updateFocusFromTool', () => {
  it('focuses the created subtitle', () => {
    const session = createEmptySession('project-1')
    const project = { ...testProject(), subtitles: [{ id: 'sub-1', start: 1, end: 2, text: 'Hello world' }] }
    updateFocusFromTool(session, 'add_subtitle', { start: 1, end: 2, text: 'Hello world' }, { ok: true, subtitleId: 'sub-1' }, project)
    expect(session.focus).toMatchObject({ kind: 'subtitle', subtitleId: 'sub-1' })
  })
  it('focuses the added music clip', () => {
    const session = createEmptySession('project-1')
    let project = addAudioToTimeline(testProject(), [asset('music-1', 'Theme.wav', 30)], 0)
    const clip = project.timeline.clips.find((item) => item.trackId === 'track-music')
    expect(clip).toBeDefined()
    project = { ...project }
    updateFocusFromTool(session, 'add_music', { media_id: 'music-1' }, { ok: true, clipId: clip?.id, mediaId: 'music-1' }, project)
    expect(session.focus).toMatchObject({ kind: 'music', clipId: clip?.id, mediaId: 'music-1' })
  })
  it('focuses the trimmed video clip', () => {
    const session = createEmptySession('project-1')
    const project = testProject()
    const clip = project.timeline.clips[0]
    updateFocusFromTool(session, 'trim_clip', { clip_id: clip.id }, { ok: true }, project)
    expect(session.focus).toMatchObject({ kind: 'clip', clipId: clip.id })
  })
})
