import type { AnalysisResult, ProjectData, Scene, TranscriptSegment } from './types'
import { clipDuration, getVideoClips } from './project'

/* ------------------------------------------------------------------ *
 * Video Understanding evidence layer (pure, deterministic).
 *
 * This module fuses the locally stored evidence (transcript, scenes,
 * silence, audio metrics, approved visual index) into ranked "best
 * segment" candidates plus an organized digest for the editing agent.
 *
 * Honesty rules (enforced by construction, not by prompts):
 * - Every result names the evidence it used via EvidenceCoverage.
 * - visualDescription is only set when stored visual evidence overlaps
 *   the window; otherwise it stays undefined and the reason says so.
 * - Missing signals are excluded from scoring (weights renormalized);
 *   confidence separately reports how much evidence existed.
 * ------------------------------------------------------------------ */

export interface EvidenceCoverage {
  transcript: boolean
  scenes: boolean
  silence: boolean
  audio: boolean
  visual: boolean
  sceneVisuals: boolean
}

export function getEvidenceCoverage(project: ProjectData, mediaId?: string): EvidenceCoverage {
  const assets = mediaId
    ? project.media.filter((asset) => asset.id === mediaId)
    : project.media.filter((asset) => getVideoClips(project).some((clip) => clip.mediaId === asset.id))
  const analyses = assets.map((asset) => project.analysisByMedia[asset.id]).filter((item): item is AnalysisResult => Boolean(item))
  return {
    transcript: analyses.some((item) => item.transcript.length > 0),
    scenes: analyses.some((item) => item.scenes.length > 0),
    silence: analyses.some((item) => item.silences.length > 0),
    audio: analyses.some((item) => item.audio.analyzed),
    visual: analyses.some((item) => (item.visualIndex?.moments.length ?? 0) > 0),
    sceneVisuals: analyses.some((item) => (item.sceneVisuals?.length ?? 0) > 0)
  }
}

/* ---------------- scene profiles (stored evidence only) ---------------- */

export interface SceneProfile {
  sceneIndex: number
  mediaId: string
  mediaName: string
  start: number
  end: number
  duration: number
  /** Representative still time for this scene (midpoint). */
  keyframeTimestamp: number
  hasVisualEvidence: boolean
  /** Joined stored captions; empty string when no visual evidence exists. */
  visualSummary: string
  visibleTexts: string[]
  momentCount: number
  speechCoveragePercent: number
  silenceSeconds: number
  transcriptExcerpt: string
  subjects?: string[]
  activity?: string
  visualImportance?: number
  hasPerson?: boolean
}

export function buildSceneProfiles(project: ProjectData, mediaId?: string, limit = 40): SceneProfile[] {
  const take = clampInt(limit, 1, 120)
  const assets = mediaId
    ? project.media.filter((asset) => asset.id === mediaId)
    : project.media.filter((asset) => getVideoClips(project).some((clip) => clip.mediaId === asset.id)).slice(0, 8)
  const profiles: SceneProfile[] = []
  for (const asset of assets) {
    const analysis = project.analysisByMedia[asset.id]
    const scenes = analysis?.scenes ?? []
    for (const [index, scene] of scenes.entries()) {
      if (profiles.length >= take) return profiles
      if (!Number.isFinite(scene.start) || !Number.isFinite(scene.end) || scene.end <= scene.start) continue
      const duration = scene.end - scene.start
      const moments = (analysis?.visualIndex?.moments ?? []).filter((moment) => moment.timestampSeconds >= scene.start && moment.timestampSeconds < scene.end)
      const included = (analysis?.transcript ?? []).filter((segment) => segment.text.trim() && segment.end > scene.start && segment.start < scene.end)
      const speechSeconds = overlapDuration(included.map(({ start, end }) => ({ start, end })), scene.start, scene.end)
      const silenceSeconds = overlapDuration((analysis?.silences ?? []).map(({ start, end }) => ({ start, end })), scene.start, scene.end)
      const structured = analysis?.sceneVisuals?.find((profile) => profile.sceneIndex === index + 1)
      const visibleTexts = [...new Set(moments.map((moment) => (moment.visibleText ?? '').trim()).filter(Boolean))].slice(0, 6)
      if (structured?.textOnScreen?.trim()) visibleTexts.unshift(structured.textOnScreen.trim().slice(0, 160))
      profiles.push({
        sceneIndex: index + 1,
        mediaId: asset.id,
        mediaName: asset.name.slice(0, 120),
        start: round2(scene.start),
        end: round2(scene.end),
        duration: round2(duration),
        keyframeTimestamp: round2(scene.start + duration / 2),
        hasVisualEvidence: moments.length > 0 || Boolean(structured),
        visualSummary: structured?.visualSummary ?? moments.map((moment) => moment.description).join(' ').slice(0, 500),
        visibleTexts: [...new Set(visibleTexts)].slice(0, 6),
        momentCount: moments.length,
        speechCoveragePercent: Math.round(Math.min(1, speechSeconds / duration) * 100),
        silenceSeconds: round2(silenceSeconds),
        transcriptExcerpt: included.map((item) => item.text.trim()).join(' … ').slice(0, 500),
        ...(structured ? { subjects: structured.subjects.slice(0, 8), activity: structured.activity, visualImportance: structured.visualImportance, hasPerson: structured.hasPerson } : {})
      })
    }
  }
  return profiles
}

export interface PlannedSceneKeyframe {
  sceneIndex: number
  timestampSeconds: number
}

/** Representative still timestamps per scene (midpoint; quarter points for long scenes). */
export function planSceneKeyframes(scenes: Scene[], maxPerScene = 1): PlannedSceneKeyframe[] {
  const perScene = clampInt(maxPerScene, 1, 3)
  const planned: PlannedSceneKeyframe[] = []
  scenes.forEach((scene, index) => {
    if (!Number.isFinite(scene.start) || !Number.isFinite(scene.end) || scene.end <= scene.start) return
    const duration = scene.end - scene.start
    const points = perScene <= 1 || duration <= 20
      ? [scene.start + duration / 2]
      : [scene.start + duration * 0.25, scene.start + duration / 2, scene.start + duration * 0.75].slice(0, perScene)
    for (const point of points) {
      planned.push({ sceneIndex: index + 1, timestampSeconds: Number(point.toFixed(3)) })
    }
  })
  return planned
}

/* ---------------- transcript understanding ---------------- */

/** Lowercases, strips Arabic diacritics/tatweel, unifies alef/hamza/ة/ى, removes accents and punctuation. */
export function normalizeSearchText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[ٱأإآ]/g, 'ا')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[ً-ٰٟـ]/g, '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function queryTokens(query: string): string[] {
  return normalizeSearchText(query).split(' ').filter((token) => token.length >= 2)
}

export interface TranscriptMatch {
  mediaId: string
  mediaName: string
  segmentId: string
  start: number
  end: number
  text: string
  contextBefore?: string
  contextAfter?: string
  sceneIndex?: number
}

export function searchTranscript(
  project: ProjectData,
  query: string,
  options: { mediaId?: string; limit?: number } = {}
): { available: boolean; matches: TranscriptMatch[]; reason?: string } {
  const tokens = queryTokens(query)
  if (!tokens.length) return { available: false, matches: [], reason: 'The search query is empty after normalization.' }
  const limit = clampInt(options.limit ?? 10, 1, 40)
  const assets = options.mediaId
    ? project.media.filter((asset) => asset.id === options.mediaId)
    : project.media.filter((asset) => getVideoClips(project).some((clip) => clip.mediaId === asset.id))
  const transcripts = assets.map((asset) => ({ asset, segments: project.analysisByMedia[asset.id]?.transcript ?? [] }))
  if (!transcripts.some(({ segments }) => segments.length > 0)) {
    return { available: false, matches: [], reason: 'No transcript exists for the timeline sources. Transcribe the video first.' }
  }
  const matches: TranscriptMatch[] = []
  for (const { asset, segments } of transcripts) {
    const ordered = [...segments].sort((a, b) => a.start - b.start)
    const scenes = project.analysisByMedia[asset.id]?.scenes ?? []
    for (const [index, segment] of ordered.entries()) {
      if (matches.length >= limit) break
      const normalized = normalizeSearchText(segment.text)
      if (!normalized || !tokens.every((token) => normalized.includes(token))) continue
      const scenePosition = scenes.findIndex((scene) => segment.start >= scene.start && segment.start < scene.end)
      matches.push({
        mediaId: asset.id,
        mediaName: asset.name.slice(0, 120),
        segmentId: segment.id,
        start: round2(segment.start),
        end: round2(segment.end),
        text: segment.text.slice(0, 300),
        ...(ordered[index - 1]?.text.trim() ? { contextBefore: ordered[index - 1].text.trim().slice(0, 200) } : {}),
        ...(ordered[index + 1]?.text.trim() ? { contextAfter: ordered[index + 1].text.trim().slice(0, 200) } : {}),
        ...(scenePosition >= 0 ? { sceneIndex: scenePosition + 1 } : {})
      })
    }
  }
  return matches.length
    ? { available: true, matches }
    : { available: true, matches: [], reason: `No transcript segment mentions "${query.trim().slice(0, 80)}".` }
}

const SENTENCE_END = /[.!?…؟!]['"”»)\]]*\s*$/

function endsSentence(text: string): boolean {
  return SENTENCE_END.test(text.trim())
}

function startsSentence(previous: TranscriptSegment | undefined, current: TranscriptSegment): boolean {
  if (!previous) return true
  if (current.start - previous.end > 0.8) return true
  return endsSentence(previous.text)
}

/** Snaps a [start, end] window to sentence boundaries (bounded expansion, never inverts). */
export function expandToSentenceBounds(
  transcript: TranscriptSegment[],
  start: number,
  end: number,
  maxExpandSeconds = 4
): { start: number; end: number } {
  const ordered = [...transcript].sort((a, b) => a.start - b.start)
  let snappedStart = start
  let snappedEnd = end
  const firstIndex = ordered.findIndex((segment) => segment.end > start)
  if (firstIndex >= 0) {
    for (let index = firstIndex; index >= 0; index -= 1) {
      const segment = ordered[index]
      const previous = index > 0 ? ordered[index - 1] : undefined
      if (segment.start >= start || start - segment.start > maxExpandSeconds) break
      snappedStart = segment.start
      if (startsSentence(previous, segment)) break
    }
  }
  const lastIndex = [...ordered].reverse().findIndex((segment) => segment.start < end)
  if (lastIndex >= 0) {
    const from = ordered.length - 1 - lastIndex
    for (let index = from; index < ordered.length; index += 1) {
      const segment = ordered[index]
      if (segment.end <= end || segment.end - end > maxExpandSeconds) {
        if (segment.end > end) break
        snappedEnd = Math.max(snappedEnd, segment.end)
        continue
      }
      snappedEnd = segment.end
      if (endsSentence(segment.text)) break
    }
  }
  if (!(snappedEnd > snappedStart)) return { start, end }
  return { start: snappedStart, end: snappedEnd }
}

/* ---------------- best-segment ranking ---------------- */

export interface BestSegmentSignals {
  transcriptQuality: number | null
  speechCoverage: number | null
  silenceFit: number | null
  sceneCoherence: number | null
  visualInterest: number | null
  audioQuality: number | null
  durationFit: number
  completeness: number | null
  queryRelevance: number | null
}

export interface BestSegmentCandidate {
  id: string
  clipId: string
  mediaId: string
  mediaName: string
  timelineStart: number
  timelineEnd: number
  sourceStart: number
  sourceEnd: number
  durationSeconds: number
  score: number
  confidence: number
  transcriptExcerpt: string
  /** Present only when stored visual evidence overlaps this window. */
  visualDescription?: string
  signals: BestSegmentSignals
  evidence: {
    transcriptSegments: number
    wordCount: number
    speechCoveragePercent: number
    sceneBoundaryCount: number
    silenceSeconds: number
    visualMomentCount: number
    hasVisualEvidence: boolean
    audioAnalyzed: boolean
    averageTranscriptConfidence?: number
  }
}

export interface FindBestSegmentsOptions {
  targetDuration?: number
  count?: number
  query?: string
  minDuration?: number
  maxDuration?: number
  mediaId?: string
}

export interface BestSegmentsResult {
  available: boolean
  candidates: BestSegmentCandidate[]
  coverage: EvidenceCoverage
  visualAvailable: boolean
  reason: string
}

const SIGNAL_WEIGHTS: Record<keyof Omit<BestSegmentSignals, 'queryRelevance'>, number> = {
  transcriptQuality: 0.16,
  speechCoverage: 0.20,
  silenceFit: 0.14,
  sceneCoherence: 0.08,
  visualInterest: 0.12,
  audioQuality: 0.06,
  durationFit: 0.10,
  completeness: 0.06
}
const QUERY_WEIGHT = 0.08

function clampInt(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum
  return Math.max(minimum, Math.min(maximum, Math.floor(value)))
}

function round2(value: number): number {
  return Number(value.toFixed(2))
}

function overlapDuration(rows: Array<{ start: number; end: number }>, start: number, end: number): number {
  const ranges = rows
    .map((row) => ({ start: Math.max(start, row.start), end: Math.min(end, row.end) }))
    .filter((range) => range.end > range.start)
    .sort((left, right) => left.start - right.start)
  let total = 0
  let cursor = start
  for (const range of ranges) {
    if (range.start > cursor) total += range.end - range.start
    else if (range.end > cursor) total += range.end - cursor
    cursor = Math.max(cursor, range.end)
  }
  return total
}

function countWords(text: string): number {
  return text.trim().split(/\s+/u).filter(Boolean).length
}

function uniqueWordRatio(segments: TranscriptSegment[]): number {
  const words = segments.flatMap((segment) => segment.text.toLocaleLowerCase().normalize('NFKC').match(/[\p{L}\p{N}]{2,}/gu) ?? [])
  if (!words.length) return 0
  return new Set(words).size / words.length
}

function averageConfidence(segments: TranscriptSegment[]): number | undefined {
  const values = segments.flatMap((item) => item.words ?? []).map((word) => word.confidence).filter((value): value is number => Number.isFinite(value))
  if (!values.length) return undefined
  return values.reduce((sum, value) => sum + Math.max(0, Math.min(1, value)), 0) / values.length
}

interface ScoredWindow {
  clipId: string
  mediaId: string
  mediaName: string
  timelineStart: number
  sourceStart: number
  sourceEnd: number
  score: number
  signals: BestSegmentSignals
  repetitionPenalty: number
  transcriptExcerpt: string
  visualDescription?: string
  evidence: BestSegmentCandidate['evidence']
}

function scoreWindow(
  project: ProjectData,
  clipId: string,
  mediaId: string,
  mediaName: string,
  timelineStart: number,
  sourceStart: number,
  sourceEnd: number,
  targetDuration: number,
  query: string[],
  matchHits: number
): ScoredWindow | null {
  const duration = sourceEnd - sourceStart
  if (!(duration > 0)) return null
  const analysis = project.analysisByMedia[mediaId]
  const included = (analysis?.transcript ?? []).filter((item) => item.text.trim() && item.end > sourceStart && item.start < sourceEnd).sort((a, b) => a.start - b.start)
  const wordCount = included.reduce((sum, item) => sum + countWords(item.text), 0)
  const speechSeconds = overlapDuration(included.map(({ start, end }) => ({ start, end })), sourceStart, sourceEnd)
  const silenceSeconds = overlapDuration((analysis?.silences ?? []).map(({ start, end }) => ({ start, end })), sourceStart, sourceEnd)
  const scenes = analysis?.scenes ?? []
  const internalBoundaries = scenes.filter((scene) => scene.start > sourceStart + 0.5 && scene.start < sourceEnd - 0.5).length
  const moments = (analysis?.visualIndex?.moments ?? []).filter((moment) => moment.timestampSeconds >= sourceStart && moment.timestampSeconds < sourceEnd)
  const structured = (analysis?.sceneVisuals ?? []).filter((profile) => profile.end > sourceStart && profile.start < sourceEnd)
  const hasVisualEvidence = moments.length > 0 || structured.length > 0

  const averageTranscriptConfidence = averageConfidence(included)
  const transcriptQuality = included.length
    ? (averageTranscriptConfidence ?? 0.6) * 0.5 + Math.min(1, uniqueWordRatio(included) / 0.55) * 0.5
    : null
  const speechCoverage = included.length ? Math.min(1, speechSeconds / duration) : null
  const silenceFit = analysis ? 1 - Math.min(1, silenceSeconds / duration) : null
  const sceneCoherence = scenes.length ? 1 - Math.min(1, internalBoundaries / 3) : null
  let visualInterest: number | null = null
  if (hasVisualEvidence) {
    const density = Math.min(1, moments.length / Math.max(1, duration))
    const distinctShots = new Set(moments.map((moment) => moment.shotIndex)).size
    const hasText = moments.some((moment) => (moment.visibleText ?? '').trim()) || structured.some((profile) => profile.hasOnScreenText)
    visualInterest = structured.length
      ? Math.min(1, structured.reduce((sum, profile) => sum + profile.visualImportance, 0) / structured.length * 0.65 + density * 0.35)
      : Math.min(1, density * 0.55 + Math.min(1, distinctShots / 3) * 0.25 + (hasText ? 0.2 : 0))
  }
  const audio = analysis?.audio
  const audioQuality = audio?.analyzed
    ? audio.clippingDetected ? 0.35 : audio.meanVolumeDb !== undefined && audio.meanVolumeDb < -40 ? 0.55 : 0.85
    : null
  const distance = Math.abs(duration - targetDuration)
  const durationFit = distance <= targetDuration * 0.25 ? 1 : Math.max(0.3, 1 - Math.min(0.7, distance / targetDuration))
  let completeness: number | null = null
  if (included.length) {
    const full = [...(analysis?.transcript ?? [])].sort((a, b) => a.start - b.start)
    const first = included[0]
    const last = included[included.length - 1]
    const firstIndex = full.indexOf(first)
    const startAligned = startsSentence(firstIndex > 0 ? full[firstIndex - 1] : undefined, first)
    const endAligned = endsSentence(last.text)
    completeness = startAligned && endAligned ? 1 : startAligned || endAligned ? 0.55 : 0.25
  } else if (scenes.length) {
    const onStart = scenes.some((scene) => Math.abs(scene.start - sourceStart) < 0.6 || Math.abs(scene.end - sourceStart) < 0.6)
    const onEnd = scenes.some((scene) => Math.abs(scene.start - sourceEnd) < 0.6 || Math.abs(scene.end - sourceEnd) < 0.6)
    completeness = onStart && onEnd ? 1 : onStart || onEnd ? 0.55 : 0.25
  }
  const queryRelevance = query.length ? Math.min(1, matchHits / Math.max(1, query.length * 2)) : null

  const signals: BestSegmentSignals = {
    transcriptQuality, speechCoverage, silenceFit, sceneCoherence, visualInterest, audioQuality, durationFit, completeness, queryRelevance
  }
  let weighted = 0
  let totalWeight = 0
  for (const [key, weight] of Object.entries(SIGNAL_WEIGHTS) as Array<[keyof typeof SIGNAL_WEIGHTS, number]>) {
    const value = signals[key]
    if (value === null) continue
    weighted += weight * value
    totalWeight += weight
  }
  if (queryRelevance !== null) {
    weighted += QUERY_WEIGHT * queryRelevance
    totalWeight += QUERY_WEIGHT
  }
  const repetitionPenalty = wordCount > 10 ? Math.max(0, Math.min(1, (1 - uniqueWordRatio(included) - 0.35) / 0.65)) : 0
  const score = totalWeight > 0
    ? Math.round(Math.max(0, Math.min(100, (weighted / totalWeight - repetitionPenalty * 0.12) * 100)))
    : 0
  const visualDescription = hasVisualEvidence
    ? (structured.length
      ? structured.map((profile) => profile.visualSummary).join(' ').slice(0, 300)
      : moments.map((moment) => `[${moment.timestampSeconds.toFixed(1)}s] ${moment.description}`).join(' … ').slice(0, 300))
    : undefined
  return {
    clipId, mediaId, mediaName,
    timelineStart: round2(timelineStart),
    sourceStart: round2(sourceStart),
    sourceEnd: round2(sourceEnd),
    score,
    signals,
    repetitionPenalty: Number(repetitionPenalty.toFixed(3)),
    transcriptExcerpt: included.map((item) => item.text.trim()).join(' … ').slice(0, 700),
    ...(visualDescription ? { visualDescription } : {}),
    evidence: {
      transcriptSegments: included.length,
      wordCount,
      speechCoveragePercent: speechCoverage === null ? 0 : Math.round(speechCoverage * 100),
      sceneBoundaryCount: internalBoundaries,
      silenceSeconds: round2(silenceSeconds),
      visualMomentCount: moments.length,
      hasVisualEvidence,
      audioAnalyzed: Boolean(audio?.analyzed),
      ...(averageTranscriptConfidence === undefined ? {} : { averageTranscriptConfidence: Number(averageTranscriptConfidence.toFixed(3)) })
    }
  }
}

function windowAround(
  clip: { sourceIn: number; sourceOut: number },
  center: number,
  targetDuration: number,
  minDuration: number,
  maxDuration: number
): { start: number; end: number } | null {
  const length = Math.max(minDuration, Math.min(maxDuration, targetDuration))
  let start = Math.max(clip.sourceIn, Math.min(center - length / 2, clip.sourceOut - minDuration))
  let end = Math.min(clip.sourceOut, start + length)
  if (end - start < minDuration) {
    start = Math.max(clip.sourceIn, end - length)
  }
  if (end - start < minDuration) return null
  return { start, end }
}

function rankWindows(windows: ScoredWindow[], count: number): ScoredWindow[] {
  const ordered = [...windows].sort((left, right) => right.score - left.score || left.timelineStart - right.timelineStart)
  const selected: ScoredWindow[] = []
  for (const candidate of ordered) {
    const duplicate = selected.some((existing) => {
      if (existing.clipId !== candidate.clipId) return false
      const overlap = Math.max(0, Math.min(existing.sourceEnd, candidate.sourceEnd) - Math.max(existing.sourceStart, candidate.sourceStart))
      const shorter = Math.min(existing.sourceEnd - existing.sourceStart, candidate.sourceEnd - candidate.sourceStart)
      return shorter > 0 && overlap / shorter > 0.65
    })
    if (!duplicate) selected.push(candidate)
    if (selected.length >= count) break
  }
  return selected
}

export function findBestSegments(project: ProjectData, options: FindBestSegmentsOptions = {}): BestSegmentsResult {
  const count = clampInt(options.count ?? 3, 1, 8)
  const target = Number.isFinite(options.targetDuration ?? NaN) ? Math.max(4, Math.min(180, options.targetDuration!)) : 30
  const minDuration = Number.isFinite(options.minDuration ?? NaN) ? Math.max(2, Math.min(120, options.minDuration!)) : 8
  const maxDuration = Number.isFinite(options.maxDuration ?? NaN) ? Math.max(minDuration, Math.min(300, options.maxDuration!)) : 60
  const query = options.query?.trim() ? queryTokens(options.query) : []
  const clips = getVideoClips(project).filter((clip) => clipDuration(clip) >= 2 && (!options.mediaId || clip.mediaId === options.mediaId))
  const coverage = getEvidenceCoverage(project, options.mediaId)
  const unavailable = (reason: string): BestSegmentsResult => ({ available: false, candidates: [], coverage, visualAvailable: coverage.visual, reason })
  if (!clips.length) return unavailable('There are no video clips on the Timeline.')
  if (query.length && !clips.some((clip) => (project.analysisByMedia[clip.mediaId]?.transcript.length ?? 0) > 0)) {
    return unavailable('No transcript exists for the timeline sources, so topic search is unavailable. Transcribe the video first.')
  }

  const windows: ScoredWindow[] = []
  for (const clip of clips) {
    const asset = project.media.find((item) => item.id === clip.mediaId)
    if (!asset) continue
    const analysis = project.analysisByMedia[clip.mediaId]
    const transcript = (analysis?.transcript ?? [])
      .filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start)
      .slice(0, 2000)
    const mediaName = asset.name.slice(0, 120)

    if (query.length && transcript.length) {
      const normalized = transcript.map((segment) => ({ segment, text: normalizeSearchText(segment.text) }))
      const hits = normalized.filter(({ text }) => text && query.every((token) => text.includes(token))).slice(0, 24)
      for (const { segment } of hits) {
        const raw = windowAround(clip, (segment.start + segment.end) / 2, target, minDuration, maxDuration)
        if (!raw) continue
        const snapped = expandToSentenceBounds(transcript, Math.max(clip.sourceIn, raw.start), Math.min(clip.sourceOut, raw.end))
        const start = Math.max(clip.sourceIn, Math.min(snapped.start, clip.sourceOut - minDuration))
        const end = Math.min(clip.sourceOut, Math.max(snapped.end, start + minDuration))
        if (end - start < minDuration || end - start > maxDuration + 8) continue
        const hitsInWindow = normalized.filter(({ segment: item, text }) => item.end > start && item.start < end && query.every((token) => text.includes(token))).length
        const scored = scoreWindow(project, clip.id, clip.mediaId, mediaName, clip.position + start - clip.sourceIn, start, end, target, query, hitsInWindow * query.length)
        if (scored) windows.push(scored)
      }
      continue
    }

    if (transcript.length) {
      for (const anchor of transcript) {
        if (!anchor.text.trim() || anchor.start < clip.sourceIn || anchor.start >= clip.sourceOut) continue
        const rawStart = Math.max(clip.sourceIn, anchor.start - 1)
        const rawEnd = Math.min(clip.sourceOut, rawStart + target)
        if (rawEnd - rawStart < minDuration) continue
        const snapped = expandToSentenceBounds(transcript, rawStart, rawEnd)
        const start = Math.max(clip.sourceIn, snapped.start)
        const end = Math.min(clip.sourceOut, Math.min(snapped.end, start + maxDuration + 8))
        if (end - start < minDuration) continue
        const scored = scoreWindow(project, clip.id, clip.mediaId, mediaName, clip.position + start - clip.sourceIn, start, end, target, [], 0)
        if (scored) windows.push(scored)
      }
      continue
    }

    const scenes = (analysis?.scenes ?? []).filter((scene) => scene.end > clip.sourceIn && scene.start < clip.sourceOut).slice(0, 60)
    for (const scene of scenes) {
      const start = Math.max(clip.sourceIn, scene.start)
      const end = Math.min(clip.sourceOut, scene.end, start + maxDuration)
      if (end - start < minDuration) continue
      const scored = scoreWindow(project, clip.id, clip.mediaId, mediaName, clip.position + start - clip.sourceIn, start, end, target, [], 0)
      if (scored) windows.push(scored)
    }
    if (!scenes.length) {
      const end = Math.min(clip.sourceOut, clip.sourceIn + maxDuration)
      if (end - clip.sourceIn >= minDuration) {
        const scored = scoreWindow(project, clip.id, clip.mediaId, mediaName, clip.position, clip.sourceIn, end, target, [], 0)
        if (scored) windows.push(scored)
      }
    }
  }

  if (query.length && !windows.length) {
    const hasTranscript = clips.some((clip) => (project.analysisByMedia[clip.mediaId]?.transcript.length ?? 0) > 0)
    return unavailable(hasTranscript
      ? `No transcript segment mentions "${(options.query ?? '').trim().slice(0, 80)}".`
      : 'No transcript exists for the timeline sources, so topic search is unavailable. Transcribe the video first.')
  }
  const selected = rankWindows(windows, count)
  if (!selected.length) {
    return { available: true, candidates: [], coverage, visualAvailable: coverage.visual, reason: 'The analyzed clips do not contain a window long enough for the requested segment length.' }
  }
  const confidence = Number(Math.min(1, Math.max(0.05,
    (coverage.transcript ? 0.30 : 0) + (coverage.scenes ? 0.15 : 0) + (coverage.silence ? 0.15 : 0) + (coverage.audio ? 0.10 : 0) + (coverage.visual ? 0.30 : 0)
  )).toFixed(2))
  const used: string[] = []
  if (coverage.transcript) used.push(query.length ? 'transcript topic matches with sentence-boundary snapping' : 'transcript speech coverage and sentence completeness')
  if (coverage.scenes) used.push('scene boundaries')
  if (coverage.silence) used.push('silence analysis')
  if (coverage.audio) used.push('audio quality')
  if (coverage.visual) used.push('visual-index evidence')
  const reason = `Ranked ${selected.length} candidate(s) from ${used.length ? used.join(', ') : 'timeline geometry only'}.`
    + (coverage.transcript ? '' : ' No transcript exists; speech-based signals were not used.')
    + (coverage.visual ? '' : ' Visual analysis is not available; visual interest was not scored.')
  return {
    available: true,
    candidates: selected.map((window, index) => ({
      id: `best-${window.clipId}-${Math.round(window.sourceStart * 10)}-${index}`,
      clipId: window.clipId,
      mediaId: window.mediaId,
      mediaName: window.mediaName,
      timelineStart: window.timelineStart,
      timelineEnd: round2(window.timelineStart + (window.sourceEnd - window.sourceStart)),
      sourceStart: window.sourceStart,
      sourceEnd: window.sourceEnd,
      durationSeconds: round2(window.sourceEnd - window.sourceStart),
      score: window.score,
      confidence,
      transcriptExcerpt: window.transcriptExcerpt,
      ...(window.visualDescription ? { visualDescription: window.visualDescription } : {}),
      signals: window.signals,
      evidence: window.evidence
    })),
    coverage,
    visualAvailable: coverage.visual,
    reason
  }
}

/* ---------------- organized video digest ---------------- */

export interface VideoDigest {
  generatedAt: string
  video: { totalDurationSeconds: number; clipCount: number; media: Array<{ mediaId: string; name: string; durationSeconds: number }> }
  coverage: EvidenceCoverage
  scenes: { available: boolean; count: number; samples: SceneProfile[] }
  transcript: { available: boolean; segmentCount: number; wordCount: number; excerpt: string }
  silence: { available: boolean; regionCount: number; totalSeconds: number; longestSeconds: number }
  audio: { analyzed: boolean; sourcesAnalyzed: number; sourceCount: number; meanVolumeDb?: number; maxVolumeDb?: number; clippingDetected: boolean }
  visual: { available: boolean; provider?: string; frameCount?: number; shotCount?: number; structuredSceneProfiles?: number; summary?: string; reason?: string }
  candidates: { available: boolean; items: BestSegmentCandidate[]; reason: string }
  timeline: { durationSeconds: number; videoClips: Array<{ id: string; mediaName: string; timelineStart: number; timelineEnd: number }>; subtitleCount: number; musicClipCount: number }
}

function formatClock(totalSeconds: number): string {
  const safe = Math.max(0, totalSeconds)
  const minutes = Math.floor(safe / 60)
  return `${String(minutes).padStart(2, '0')}:${(safe - minutes * 60).toFixed(0).padStart(2, '0')}`
}

export function buildVideoDigest(project: ProjectData, options: { candidateCount?: number; mediaId?: string } = {}): VideoDigest {
  const clips = getVideoClips(project)
  const assets = options.mediaId
    ? project.media.filter((asset) => asset.id === options.mediaId)
    : project.media.filter((asset) => clips.some((clip) => clip.mediaId === asset.id))
  const coverage = getEvidenceCoverage(project, options.mediaId)
  const analyses = assets.map((asset) => project.analysisByMedia[asset.id]).filter((item): item is AnalysisResult => Boolean(item))
  const scenes = analyses.flatMap((item) => item.scenes)
  const silences = analyses.flatMap((item) => item.silences)
  const transcript = analyses.flatMap((item) => item.transcript).sort((a, b) => a.start - b.start)
  const totalDuration = clips.reduce((sum, clip) => Math.max(sum, clip.position + clipDuration(clip)), 0)
  const words = transcript.reduce((sum, segment) => sum + countWords(segment.text), 0)
  const indexed = analyses.map((item) => item.visualIndex).filter((item): item is NonNullable<AnalysisResult['visualIndex']> => Boolean(item))
  const primaryVisual = indexed[0]
  const structuredProfiles = analyses.reduce((sum, item) => sum + (item.sceneVisuals?.length ?? 0), 0)
  const best = findBestSegments(project, { count: clampInt(options.candidateCount ?? 3, 1, 5), mediaId: options.mediaId })
  const excerpt = transcript.slice(0, 10).map((segment) => `[${formatClock(segment.start)}] ${segment.text.trim().slice(0, 160)}`).join('\n').slice(0, 1500)
  const volumes = analyses.map((item) => item.audio).filter((audio) => audio.analyzed)
  const names = new Map(project.media.map((asset) => [asset.id, asset.name]))
  return {
    generatedAt: new Date().toISOString(),
    video: {
      totalDurationSeconds: round2(totalDuration),
      clipCount: clips.length,
      media: assets.slice(0, 20).map((asset) => ({ mediaId: asset.id, name: asset.name.slice(0, 120), durationSeconds: round2(asset.duration) }))
    },
    coverage,
    scenes: {
      available: scenes.length > 0,
      count: scenes.length,
      samples: buildSceneProfiles(project, options.mediaId, 8).map((profile) => ({
        ...profile,
        visualSummary: profile.visualSummary.slice(0, 220),
        transcriptExcerpt: profile.transcriptExcerpt.slice(0, 220)
      }))
    },
    transcript: { available: transcript.length > 0, segmentCount: transcript.length, wordCount: words, excerpt },
    silence: {
      available: silences.length > 0,
      regionCount: silences.length,
      totalSeconds: round2(silences.reduce((sum, item) => sum + item.duration, 0)),
      longestSeconds: round2(silences.reduce((max, item) => Math.max(max, item.duration), 0))
    },
    audio: {
      analyzed: volumes.length > 0,
      sourcesAnalyzed: volumes.length,
      sourceCount: assets.length,
      ...(volumes[0]?.meanVolumeDb !== undefined ? { meanVolumeDb: volumes[0].meanVolumeDb } : {}),
      ...(volumes[0]?.maxVolumeDb !== undefined ? { maxVolumeDb: volumes[0].maxVolumeDb } : {}),
      clippingDetected: volumes.some((audio) => audio.clippingDetected)
    },
    visual: primaryVisual
      ? {
        available: true,
        provider: primaryVisual.provider,
        frameCount: primaryVisual.frameCount,
        shotCount: primaryVisual.shots.length,
        structuredSceneProfiles: structuredProfiles,
        summary: primaryVisual.summary.slice(0, 600)
      }
      : { available: false, reason: 'No visual index has been built. Visual selection used no image evidence; ask the user to confirm visual indexing from the eye button to enable it.' },
    candidates: { available: best.available && best.candidates.length > 0, items: best.candidates, reason: best.reason },
    timeline: {
      durationSeconds: round2(totalDuration),
      videoClips: clips.slice(0, 20).map((clip) => ({
        id: clip.id,
        mediaName: (names.get(clip.mediaId) ?? 'Missing media').slice(0, 80),
        timelineStart: round2(clip.position),
        timelineEnd: round2(clip.position + clipDuration(clip))
      })),
      subtitleCount: project.subtitles.length,
      musicClipCount: project.timeline.clips.filter((clip) => clip.trackId === 'track-music').length
    }
  }
}
