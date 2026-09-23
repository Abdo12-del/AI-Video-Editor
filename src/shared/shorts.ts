import type { ProjectData, TranscriptSegment } from './types'
import { getVideoClips } from './project'

export interface ShortCandidate {
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
  transcriptExcerpt: string
  evidence: {
    transcriptSegments: number
    wordCount: number
    speechCoveragePercent: number
    sceneBoundaryCount: number
    silenceSeconds: number
    averageTranscriptConfidence?: number
  }
}

export interface ShortCandidatesResult {
  available: boolean
  candidates: ShortCandidate[]
  reason?: string
}

function overlapDuration(rows: Array<{ start: number; end: number }>, start: number, end: number): number {
  const ranges = rows.map((row) => ({ start: Math.max(start, row.start), end: Math.min(end, row.end) }))
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

function diversityRatio(segments: TranscriptSegment[], wordCount: number): number {
  if (!wordCount) return 0
  const words = segments.flatMap((segment) => segment.text.toLocaleLowerCase().normalize('NFKC').match(/[\p{L}\p{N}]{2,}/gu) ?? [])
  return Math.min(1, new Set(words).size / wordCount)
}

function makeCandidate(
  project: ProjectData,
  clip: ReturnType<typeof getVideoClips>[number],
  maximumDuration: number,
  transcript: TranscriptSegment[],
  anchor: TranscriptSegment
): ShortCandidate | null {
  const asset = project.media.find((item) => item.id === clip.mediaId)
  if (!asset) return null
  if (!anchor.text.trim() || anchor.start < clip.sourceIn || anchor.start >= clip.sourceOut) return null
  const sourceStart = Math.max(clip.sourceIn, anchor.start - 1)
  const sourceEnd = Math.min(clip.sourceOut, sourceStart + maximumDuration)
  const durationSeconds = sourceEnd - sourceStart
  if (durationSeconds < Math.min(8, maximumDuration)) return null

  const included = transcript.filter((item) => item.text.trim() && item.end > sourceStart && item.start < sourceEnd).sort((left, right) => left.start - right.start)
  const wordCount = included.reduce((sum, item) => sum + countWords(item.text), 0)
  if (!wordCount) return null
  const speechSeconds = overlapDuration(included.map(({ start, end }) => ({ start, end })), sourceStart, sourceEnd)
  const silenceSeconds = overlapDuration((project.analysisByMedia[clip.mediaId]?.silences ?? []).map(({ start, end }) => ({ start, end })), sourceStart, sourceEnd)
  const sceneBoundaryCount = (project.analysisByMedia[clip.mediaId]?.scenes ?? []).filter((scene) => scene.start > sourceStart + 0.5 && scene.start < sourceEnd - 0.5).length
  const confidences = included.flatMap((item) => item.words ?? []).map((word) => word.confidence).filter((value): value is number => Number.isFinite(value))
  const averageTranscriptConfidence = confidences.length
    ? confidences.reduce((sum, value) => sum + Math.max(0, Math.min(1, value)), 0) / confidences.length
    : undefined
  const wordRate = wordCount / durationSeconds * 60
  const speechCoverage = Math.min(1, speechSeconds / durationSeconds)
  const diversity = diversityRatio(included, wordCount)
  const silenceRatio = Math.min(1, silenceSeconds / durationSeconds)
  const score = Math.round(Math.max(0, Math.min(100, (
    Math.min(1, wordRate / 165) * 0.46
    + Math.min(1, speechCoverage / 0.55) * 0.25
    + Math.min(1, sceneBoundaryCount / 4) * 0.12
    + Math.min(1, diversity / 0.55) * 0.17
    - silenceRatio * 0.28
  ) * 100)))
  const transcriptExcerpt = included.map((item) => item.text.trim()).join(' … ').slice(0, 700)
  const timelineStart = clip.position + sourceStart - clip.sourceIn
  return {
    id: `short-${clip.id}-${Math.round(sourceStart * 10)}`,
    clipId: clip.id,
    mediaId: asset.id,
    mediaName: asset.name.slice(0, 120),
    timelineStart: Number(timelineStart.toFixed(2)),
    timelineEnd: Number((timelineStart + durationSeconds).toFixed(2)),
    sourceStart: Number(sourceStart.toFixed(2)),
    sourceEnd: Number(sourceEnd.toFixed(2)),
    durationSeconds: Number(durationSeconds.toFixed(2)),
    score,
    transcriptExcerpt,
    evidence: {
      transcriptSegments: included.length,
      wordCount,
      speechCoveragePercent: Math.round(speechCoverage * 100),
      sceneBoundaryCount,
      silenceSeconds: Number(silenceSeconds.toFixed(2)),
      ...(averageTranscriptConfidence === undefined ? {} : { averageTranscriptConfidence: Number(averageTranscriptConfidence.toFixed(3)) })
    }
  }
}

export function findShortCandidates(project: ProjectData, maximumDuration = 30, limit = 5): ShortCandidatesResult {
  const maximum = Number.isFinite(maximumDuration) ? Math.max(8, Math.min(60, maximumDuration)) : 30
  const take = Number.isFinite(limit) ? Math.max(1, Math.min(8, Math.floor(limit))) : 5
  const clips = getVideoClips(project)
  if (!clips.length) return { available: false, candidates: [], reason: 'There are no video clips on the Timeline.' }
  const hasTranscript = clips.some((clip) => (project.analysisByMedia[clip.mediaId]?.transcript.length ?? 0) > 0)
  if (!hasTranscript) return { available: false, candidates: [], reason: 'No local transcript is available for current video clips. Run local transcription before searching for Shorts.' }

  const candidates = clips.flatMap((clip) => {
    const transcript = (project.analysisByMedia[clip.mediaId]?.transcript ?? [])
      .filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start)
      .slice(0, 2000)
    return transcript.map((segment) => makeCandidate(project, clip, maximum, transcript, segment))
      .filter((candidate): candidate is ShortCandidate => candidate !== null)
  }).sort((left, right) => right.score - left.score || left.timelineStart - right.timelineStart)

  const selected: ShortCandidate[] = []
  for (const candidate of candidates) {
    const duplicate = selected.some((existing) => {
      if (existing.clipId !== candidate.clipId) return false
      const overlap = Math.max(0, Math.min(existing.sourceEnd, candidate.sourceEnd) - Math.max(existing.sourceStart, candidate.sourceStart))
      return overlap / Math.min(existing.durationSeconds, candidate.durationSeconds) > 0.65
    })
    if (!duplicate) selected.push(candidate)
    if (selected.length >= take) break
  }
  return selected.length
    ? { available: true, candidates: selected }
    : { available: true, candidates: [], reason: 'The analyzed clips do not contain a transcript window long enough for the requested Short length.' }
}
