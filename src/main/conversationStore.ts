import { createHash } from 'node:crypto'
import type { ChatMessage, ProjectData } from '../shared/types'
import type {
  ConversationFocus,
  ConversationStatus,
  PendingAction,
  WaitingInputKind
} from '../shared/conversation'

/**
 * Application-owned conversation state (short-term dialogue memory).
 *
 * One session per project id, kept for the whole project session. Gemini may
 * interpret language, but THIS store is the source of truth for:
 * what the user asked, what the agent said, the last question, whether a
 * confirmation is pending, which tool/params were prepared, previous tool
 * results, the current project revision, and the focused clip/element.
 */

export interface ConversationMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: string
  relatedAction?: string
  toolCall?: { name: string; args: Record<string, unknown> }
  toolResult?: unknown
}

export interface WaitingForInput {
  kind: WaitingInputKind
  question: string
  /** Partial action context (e.g. volume target, trim clip). */
  partial: Record<string, unknown>
  createdAt: string
}

export interface CurrentTask {
  goal: string
  steps: string[]
  currentStep: number
  createdAt: string
}

export interface ToolRecord {
  tool: string
  ok: boolean
  summary: string
  at: string
}

export interface ConversationSession {
  projectId: string
  status: ConversationStatus
  messages: ConversationMessage[]
  pendingAction: PendingAction | null
  waitingForInput: WaitingForInput | null
  focus: ConversationFocus | null
  currentTask: CurrentTask | null
  decisions: string[]
  lastToolResults: ToolRecord[]
  /** Rule-based rolling summary of folded (old) messages. */
  summary: string
  projectRevision: string
  updatedAt: string
}

const MAX_SESSIONS = 20
const MAX_MESSAGES = 60
const SUMMARIZE_THRESHOLD = 40
const KEEP_AFTER_SUMMARY = 20
const MAX_SUMMARY_CHARS = 2000

const sessions = new Map<string, ConversationSession>()

function messageId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** Same revision fingerprint the agent loop uses for stale-edit detection. */
export function projectRevisionHash(project: ProjectData): string {
  const state = JSON.stringify({
    updatedAt: project.updatedAt,
    media: project.media.map((asset) => [asset.id, asset.duration, asset.width, asset.height, asset.hasAudio, Boolean(asset.missing)]),
    analysis: Object.entries(project.analysisByMedia).map(([mediaId, analysis]) => [
      mediaId, analysis.analyzedAt, analysis.scenes.length, analysis.silences.length, analysis.transcript.length,
      analysis.visualIndex?.analyzedAt ?? null, analysis.visualIndex?.frameCount ?? 0, analysis.visualIndex?.shots.length ?? 0
    ]),
    timeline: project.timeline,
    subtitles: project.subtitles,
    exportSettings: project.exportSettings,
    history: [project.history.undo.length, project.history.redo.length]
  })
  return createHash('sha256').update(state).digest('hex').slice(0, 16)
}

export function createEmptySession(projectId: string): ConversationSession {
  return {
    projectId,
    status: 'IDLE',
    messages: [],
    pendingAction: null,
    waitingForInput: null,
    focus: null,
    currentTask: null,
    decisions: [],
    lastToolResults: [],
    summary: '',
    projectRevision: '',
    updatedAt: new Date().toISOString()
  }
}

export function getConversationSession(projectId: string): ConversationSession {
  const existing = sessions.get(projectId)
  if (existing) {
    existing.updatedAt = new Date().toISOString()
    return existing
  }
  const session = createEmptySession(projectId)
  sessions.set(projectId, session)
  if (sessions.size > MAX_SESSIONS) {
    const oldest = [...sessions.values()].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))[0]
    if (oldest && oldest.projectId !== projectId) sessions.delete(oldest.projectId)
  }
  return session
}

export function resetConversationSession(projectId: string): ConversationSession {
  const session = createEmptySession(projectId)
  sessions.set(projectId, session)
  return session
}

/** Test-only helper to isolate conversation tests from each other. */
export function __clearAllConversationSessions(): void {
  sessions.clear()
}

export function setSessionStatus(session: ConversationSession, status: ConversationStatus): void {
  session.status = status
  session.updatedAt = new Date().toISOString()
}

export function appendConversationMessage(
  session: ConversationSession,
  message: Omit<ConversationMessage, 'id' | 'timestamp'> & { id?: string; timestamp?: string }
): ConversationMessage {
  const record: ConversationMessage = {
    id: message.id ?? messageId(),
    timestamp: message.timestamp ?? new Date().toISOString(),
    role: message.role,
    content: message.content.slice(0, 4000),
    ...(message.relatedAction ? { relatedAction: message.relatedAction } : {}),
    ...(message.toolCall ? { toolCall: message.toolCall } : {}),
    ...(message.toolResult !== undefined ? { toolResult: message.toolResult } : {})
  }
  session.messages.push(record)
  if (session.messages.length > MAX_MESSAGES) {
    session.messages = session.messages.slice(-MAX_MESSAGES)
  }
  session.updatedAt = record.timestamp
  return record
}

export function setPendingAction(session: ConversationSession, pending: PendingAction): void {
  session.pendingAction = pending
  session.waitingForInput = null
  setSessionStatus(session, 'WAITING_FOR_CONFIRMATION')
}

export function clearPendingAction(
  session: ConversationSession,
  outcome: 'executed' | 'cancelled' | 'superseded' | 'failed'
): PendingAction | null {
  const pending = session.pendingAction
  session.pendingAction = null
  if (outcome === 'cancelled') setSessionStatus(session, 'CANCELLED')
  else if (outcome === 'failed') setSessionStatus(session, 'FAILED')
  return pending
}

export function setWaitingForInput(session: ConversationSession, waiting: WaitingForInput): void {
  session.waitingForInput = waiting
  setSessionStatus(session, 'WAITING_FOR_INPUT')
}

export function clearWaitingForInput(session: ConversationSession): void {
  session.waitingForInput = null
}

export function updateSessionFocus(session: ConversationSession, focus: ConversationFocus | null): void {
  if (focus && focus.kind !== 'none') session.focus = focus
  session.updatedAt = new Date().toISOString()
}

export function recordToolResult(
  session: ConversationSession,
  tool: string,
  ok: boolean,
  summary: string
): void {
  session.lastToolResults.push({ tool, ok, summary: summary.slice(0, 500), at: new Date().toISOString() })
  if (session.lastToolResults.length > 8) session.lastToolResults = session.lastToolResults.slice(-8)
  session.updatedAt = new Date().toISOString()
}

export function addDecision(session: ConversationSession, decision: string): void {
  const text = decision.trim().slice(0, 220)
  if (!text) return
  if (session.decisions.at(-1) === text) return
  session.decisions.push(text)
  if (session.decisions.length > 20) session.decisions = session.decisions.slice(-20)
  session.updatedAt = new Date().toISOString()
}

export function setCurrentTask(session: ConversationSession, task: CurrentTask | null): void {
  session.currentTask = task
  session.updatedAt = new Date().toISOString()
}

/**
 * Folds old messages into a rule-based summary (no LLM call, so it never
 * changes Gemini turn counts). History is bounded; the summary keeps the
 * gist of what was folded away.
 */
export function summarizeIfNeeded(session: ConversationSession): void {
  if (session.messages.length <= SUMMARIZE_THRESHOLD) return
  const foldCount = session.messages.length - KEEP_AFTER_SUMMARY
  const folded = session.messages.slice(0, foldCount)
  const lines = folded.map((message) => {
    const who = message.role === 'user' ? 'User' : message.role === 'assistant' ? 'Agent' : 'System'
    const action = message.relatedAction ? ` [${message.relatedAction}]` : ''
    const tool = message.toolCall ? ` [tool ${message.toolCall.name}]` : ''
    return `${who}${action}${tool}: ${message.content.slice(0, 140)}`
  })
  const addition = lines.join('\n')
  session.summary = `${session.summary}\n${addition}`.trim().slice(-MAX_SUMMARY_CHARS)
  session.messages = session.messages.slice(-KEEP_AFTER_SUMMARY)
}

/**
 * Seeds a fresh session from the persisted project chat log so a restart (or
 * a new main-process session) does not amnesia-reset an ongoing dialogue.
 * Pending actions cannot be restored from text alone and stay empty.
 */
export function hydrateSessionFromProject(session: ConversationSession, project: ProjectData): void {
  if (session.messages.length > 0 || session.summary) return
  const previous: ChatMessage[] = Array.isArray(project.chatMessages) ? project.chatMessages : []
  if (!previous.length) return
  for (const message of previous.slice(-12)) {
    if (message.role !== 'user' && message.role !== 'assistant') continue
    session.messages.push({
      id: message.id,
      role: message.role,
      content: String(message.content ?? '').slice(0, 2000),
      timestamp: message.createdAt,
      ...(message.operationId ? { relatedAction: message.operationId } : {})
    })
  }
  session.updatedAt = new Date().toISOString()
}

export interface ConversationContext {
  status: ConversationStatus
  pendingAction: PendingAction | null
  waitingForInput: WaitingForInput | null
  focus: ConversationFocus | null
  currentTask: CurrentTask | null
  decisions: string[]
  lastToolResults: ToolRecord[]
  summary: string
  recentMessages: ConversationMessage[]
  totalMessages: number
  projectRevision: string
}

export function buildConversationContext(session: ConversationSession, recentLimit = 8): ConversationContext {
  return {
    status: session.status,
    pendingAction: session.pendingAction,
    waitingForInput: session.waitingForInput,
    focus: session.focus,
    currentTask: session.currentTask,
    decisions: [...session.decisions],
    lastToolResults: [...session.lastToolResults],
    summary: session.summary,
    recentMessages: session.messages.slice(-recentLimit),
    totalMessages: session.messages.length,
    projectRevision: session.projectRevision
  }
}

function truncateText(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/**
 * Builds the bounded Gemini history prefix (oldest→newest, without the
 * current user message which the caller appends verbatim afterwards).
 * Returns [] for a fresh session so single-turn behavior is unchanged.
 */
export function buildGeminiHistoryContents(
  session: ConversationSession,
  maxMessages = 8
): Array<Record<string, unknown>> {
  const previous = session.messages.slice(0, -1).slice(-maxMessages)
  const contents: Array<Record<string, unknown>> = []
  for (const message of previous) {
    if (message.role === 'user') {
      contents.push({ role: 'user', parts: [{ text: truncateText(message.content, 800) }] })
    } else if (message.role === 'assistant') {
      let text = truncateText(message.content, 800)
      if (message.toolCall) text += `\n[Executed tool: ${message.toolCall.name}]`
      contents.push({ role: 'model', parts: [{ text }] })
    }
  }
  return contents
}

/**
 * Renders the app-owned conversation state as a clearly-labelled block for
 * the system instruction. Project facts must still come from tools; this
 * block only carries dialogue metadata (all untrusted input is quoted).
 */
export function formatConversationContextBlock(session: ConversationSession, referenceHint = ''): string {
  const context = buildConversationContext(session, 6)
  const hasHistory = context.totalMessages > 1 || session.summary.length > 0
  const hasState = Boolean(
    context.pendingAction || context.waitingForInput || context.focus ||
    context.decisions.length || context.lastToolResults.length || context.currentTask || referenceHint
  )
  if (!hasHistory && !hasState) return ''
  const lines: string[] = ['Conversation state (dialogue metadata; project facts still require tools):']
  lines.push(`- Session status: ${context.status}. There IS an ongoing dialogue; never greet as if this were a new conversation while this context exists.`)
  if (context.pendingAction) {
    const pending = context.pendingAction
    lines.push(`- AWAITING USER CONFIRMATION: "${truncateText(pending.question, 220)}"`)
    lines.push(`  Pending action: ${pending.type} via tool ${pending.tool} ${truncateText(JSON.stringify(pending.parameters), 300)} (reason: ${truncateText(pending.reason, 220)}).`)
    lines.push('  Interpret a short user reply ("yes"/"no"/equivalents) as the answer to that question. Do not start a new task.')
  }
  if (context.waitingForInput) {
    lines.push(`- WAITING FOR USER INPUT (${context.waitingForInput.kind}): "${truncateText(context.waitingForInput.question, 220)}"`)
    lines.push('  Interpret the user reply as the requested value when it matches; otherwise ask again briefly.')
  }
  if (context.focus && context.focus.kind !== 'none') {
    const focus = context.focus
    const what = focus.kind === 'clip' && focus.index ? `video clip #${focus.index}` : focus.kind
    lines.push(`- Dialogue focus: ${what}${focus.label ? ` ("${truncateText(focus.label, 80)}")` : ''}. Resolve "it/this/that" to this element.`)
  }
  if (referenceHint) lines.push(`- Reference: ${truncateText(referenceHint, 220)}`)
  if (context.decisions.length) {
    lines.push(`- User decisions so far: ${context.decisions.slice(-5).map((item) => truncateText(item, 120)).join(' | ')}`)
  }
  if (context.lastToolResults.length) {
    lines.push(`- Last tool results: ${context.lastToolResults.slice(-4).map((item) => `${item.tool}: ${item.ok ? 'ok' : 'FAILED'} — ${truncateText(item.summary, 120)}`).join(' | ')}`)
  }
  if (context.currentTask) {
    lines.push(`- Current task: ${truncateText(context.currentTask.goal, 120)} (step ${context.currentTask.currentStep + 1}/${context.currentTask.steps.length}: ${truncateText(context.currentTask.steps[context.currentTask.currentStep] ?? '', 120)})`)
  }
  if (context.recentMessages.length) {
    const turns = context.recentMessages.map((message) => `${message.role === 'user' ? 'User' : 'Agent'}: ${truncateText(message.content.replace(/\s+/g, ' '), 160)}`)
    lines.push(`- Recent turns: ${turns.join(' / ')}`)
  }
  if (context.summary) lines.push(`- Older dialogue summary: ${truncateText(context.summary.replace(/\s+/g, ' '), 600)}`)
  return `\n${lines.join('\n')}`
}

/** Updates the dialogue focus from a successful tool call (tool-agnostic). */
export function updateFocusFromTool(
  session: ConversationSession,
  toolName: string,
  args: Record<string, unknown>,
  result: unknown,
  project: ProjectData
): void {
  const now = new Date().toISOString()
  const record = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  const output = record(result)
  const clipId = typeof output?.clipId === 'string'
    ? output.clipId
    : typeof args.clip_id === 'string' ? args.clip_id : undefined
  const mediaId = typeof output?.mediaId === 'string'
    ? output.mediaId
    : typeof args.media_id === 'string' ? args.media_id : undefined
  const subtitleId = typeof output?.subtitleId === 'string'
    ? output.subtitleId
    : typeof args.subtitle_id === 'string' ? args.subtitle_id : undefined

  if (toolName === 'add_subtitle' || toolName === 'update_subtitle') {
    if (subtitleId) {
      const subtitle = project.subtitles.find((item) => item.id === subtitleId)
      session.focus = { kind: 'subtitle', subtitleId, label: subtitle?.text.slice(0, 60), updatedAt: now }
    }
    return
  }
  if (toolName === 'add_audio' || toolName === 'add_music' || toolName === 'trim_audio_clip' ||
    toolName === 'move_audio_clip' || toolName === 'adjust_audio_clip_volume' || toolName === 'set_gain') {
    if (clipId) {
      const clip = project.timeline.clips.find((item) => item.id === clipId)
      const asset = project.media.find((item) => item.id === (clip?.mediaId ?? mediaId))
      if (clip && clip.trackId === 'track-music') {
        session.focus = { kind: 'music', clipId, mediaId: clip.mediaId, label: asset?.name ?? 'Music', updatedAt: now }
        return
      }
    }
    if (toolName === 'set_gain' && clipId) {
      const clip = project.timeline.clips.find((item) => item.id === clipId)
      if (clip) {
        const asset = project.media.find((item) => item.id === clip.mediaId)
        session.focus = clip.trackId === 'track-music'
          ? { kind: 'music', clipId, mediaId: clip.mediaId, label: asset?.name ?? 'Music', updatedAt: now }
          : { kind: 'clip', clipId, mediaId: clip.mediaId, label: asset?.name, updatedAt: now }
      }
      return
    }
    if (mediaId && !clipId) {
      const asset = project.media.find((item) => item.id === mediaId)
      if (asset) session.focus = { kind: 'media', mediaId, label: asset.name, updatedAt: now }
    }
    return
  }
  if (clipId && (toolName === 'trim_clip' || toolName === 'split_clip' || toolName === 'delete_clip' ||
    toolName === 'move_clip' || toolName === 'add_clip')) {
    const clip = project.timeline.clips.find((item) => item.id === clipId)
    const asset = project.media.find((item) => item.id === (clip?.mediaId ?? mediaId))
    session.focus = { kind: 'clip', clipId, mediaId: clip?.mediaId ?? mediaId, label: asset?.name, updatedAt: now }
  }
}
