import type {
  EditSnapshot,
  ExportSettings,
  MediaAsset,
  ProjectData,
  TimelineClip,
  TimelineTrack,
  TranscriptSegment
} from './types'

export const VIDEO_TRACK_ID = 'track-video'
export const AUDIO_TRACK_ID = 'track-audio'
export const SUBTITLE_TRACK_ID = 'track-subtitles'
export const TEXT_TRACK_ID = 'track-text'
export const MUSIC_TRACK_ID = 'track-music'

export function makeId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

export function defaultExportSettings(): ExportSettings {
  return {
    format: 'mp4',
    codec: 'h264',
    resolution: '1080p',
    aspectRatio: '16:9',
    fps: 30,
    quality: 'balanced'
  }
}

export function defaultTracks(): TimelineTrack[] {
  return [
    { id: VIDEO_TRACK_ID, name: 'Video', kind: 'video', muted: false, locked: false },
    { id: AUDIO_TRACK_ID, name: 'Audio', kind: 'audio', muted: false, locked: false },
    { id: SUBTITLE_TRACK_ID, name: 'Subtitles', kind: 'subtitles', muted: false, locked: false },
    { id: TEXT_TRACK_ID, name: 'Text', kind: 'text', muted: false, locked: false },
    { id: MUSIC_TRACK_ID, name: 'Music', kind: 'music', muted: false, locked: false }
  ]
}

export function createProject(name: string, rootPath: string): ProjectData {
  const now = new Date().toISOString()
  return {
    schemaVersion: 1,
    id: makeId(),
    name: name.trim() || 'Untitled project',
    rootPath,
    createdAt: now,
    updatedAt: now,
    media: [],
    analysisByMedia: {},
    timeline: { tracks: defaultTracks(), clips: [] },
    subtitles: [],
    exportSettings: defaultExportSettings(),
    chatMessages: [],
    operations: [],
    history: { undo: [], redo: [] }
  }
}

export function clipDuration(clip: TimelineClip): number {
  return Math.max(0, clip.sourceOut - clip.sourceIn)
}

export function getVideoClips(project: ProjectData): TimelineClip[] {
  return project.timeline.clips
    .filter((clip) => clip.trackId === VIDEO_TRACK_ID && clip.sourceOut > clip.sourceIn)
    .slice()
    .sort((a, b) => a.position - b.position)
}

export function getMusicClips(project: ProjectData): TimelineClip[] {
  return project.timeline.clips
    .filter((clip) => clip.trackId === MUSIC_TRACK_ID && clip.sourceOut > clip.sourceIn)
    .slice()
    .sort((a, b) => a.position - b.position)
}

export function projectDuration(project: ProjectData): number {
  return getVideoClips(project).reduce((total, clip) => total + clipDuration(clip), 0)
}

export function normalizeTimeline(clips: TimelineClip[]): TimelineClip[] {
  let cursor = 0
  return clips
    .filter((clip) => Number.isFinite(clip.sourceIn) && Number.isFinite(clip.sourceOut) && clip.sourceOut - clip.sourceIn > 0.025)
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((clip) => {
      const normalized = { ...clip, position: cursor }
      cursor += clipDuration(normalized)
      return normalized
    })
}

function snapshot(project: ProjectData): EditSnapshot {
  return JSON.parse(JSON.stringify({
    timeline: project.timeline,
    subtitles: project.subtitles,
    exportSettings: project.exportSettings
  })) as EditSnapshot
}

export function commitEdit(
  project: ProjectData,
  title: string,
  summary: string,
  kind: string,
  update: (current: ProjectData) => Pick<ProjectData, 'timeline' | 'subtitles' | 'exportSettings'>
): ProjectData {
  const before = snapshot(project)
  const nextValues = update(project)
  const operation = {
    id: makeId(),
    kind,
    title,
    summary,
    createdAt: new Date().toISOString()
  }
  return {
    ...project,
    ...nextValues,
    updatedAt: new Date().toISOString(),
    history: {
      undo: [...project.history.undo, before].slice(-50),
      redo: []
    },
    operations: [...project.operations, operation].slice(-500)
  }
}

function currentSnapshot(project: ProjectData): EditSnapshot {
  return snapshot(project)
}

export function undoEdit(project: ProjectData): ProjectData {
  const previous = project.history.undo.at(-1)
  if (!previous) return project
  return {
    ...project,
    timeline: previous.timeline,
    subtitles: previous.subtitles,
    exportSettings: previous.exportSettings,
    updatedAt: new Date().toISOString(),
    history: {
      undo: project.history.undo.slice(0, -1),
      redo: [...project.history.redo, currentSnapshot(project)].slice(-50)
    },
    operations: [...project.operations, {
      id: makeId(),
      kind: 'undo',
      title: 'Undo',
      summary: `Undid ${project.operations.at(-1)?.title ?? 'last edit'}`,
      createdAt: new Date().toISOString()
    }].slice(-500)
  }
}

export function redoEdit(project: ProjectData): ProjectData {
  const next = project.history.redo.at(-1)
  if (!next) return project
  return {
    ...project,
    timeline: next.timeline,
    subtitles: next.subtitles,
    exportSettings: next.exportSettings,
    updatedAt: new Date().toISOString(),
    history: {
      undo: [...project.history.undo, currentSnapshot(project)].slice(-50),
      redo: project.history.redo.slice(0, -1)
    },
    operations: [...project.operations, {
      id: makeId(),
      kind: 'redo',
      title: 'Redo',
      summary: `Redid ${project.operations.at(-1)?.title ?? 'last edit'}`,
      createdAt: new Date().toISOString()
    }].slice(-500)
  }
}

function replaceClips(project: ProjectData, clips: TimelineClip[]): ProjectData['timeline'] {
  const videoClips = normalizeTimeline(clips)
  return {
    ...project.timeline,
    clips: [
      ...project.timeline.clips.filter((clip) => clip.trackId !== VIDEO_TRACK_ID),
      ...videoClips
    ]
  }
}

export function addMediaToTimeline(project: ProjectData, assets: MediaAsset[]): ProjectData {
  if (!assets.length) return project
  const currentClips = getVideoClips(project)
  let cursor = currentClips.reduce((sum, clip) => sum + clipDuration(clip), 0)
  const appended = assets
    .filter((asset) => asset.duration > 0 && asset.width > 0 && asset.height > 0 && !asset.missing)
    .map((asset) => {
      const clip: TimelineClip = {
        id: makeId(),
        mediaId: asset.id,
        trackId: VIDEO_TRACK_ID,
        position: cursor,
        sourceIn: 0,
        sourceOut: asset.duration,
        gainDb: 0,
        label: asset.name
      }
      cursor += asset.duration
      return clip
    })
  if (!appended.length) return { ...project, media: [...project.media, ...assets] }
  return {
    ...project,
    media: [...project.media, ...assets],
    timeline: replaceClips(project, [...currentClips, ...appended]),
    updatedAt: new Date().toISOString()
  }
}

export function addAudioToTimeline(
  project: ProjectData,
  assets: MediaAsset[],
  position = 0,
  sourceRange?: { sourceIn?: number; sourceOut?: number; gainDb?: number }
): ProjectData {
  const mediaById = new Map(project.media.map((asset) => [asset.id, asset]))
  for (const asset of assets) if (!mediaById.has(asset.id)) mediaById.set(asset.id, asset)
  const media = [...mediaById.values()]
  const audioTrack = project.timeline.tracks.find((track) => track.id === MUSIC_TRACK_ID)
  const eligible = assets.filter((asset) => asset.hasAudio && asset.duration > 0 && !asset.missing && !audioTrack?.locked)
  if (!eligible.length) return media.length === project.media.length ? project : { ...project, media, updatedAt: new Date().toISOString() }

  let cursor = Math.max(0, Math.min(86_400, Number.isFinite(position) ? position : 0))
  const added = eligible.flatMap((asset) => {
    const requestedIn = Number.isFinite(sourceRange?.sourceIn) ? sourceRange!.sourceIn! : 0
    const requestedOut = Number.isFinite(sourceRange?.sourceOut) ? sourceRange!.sourceOut! : asset.duration
    const requestedGain = Number.isFinite(sourceRange?.gainDb) ? sourceRange!.gainDb! : 0
    const sourceIn = Math.max(0, Math.min(asset.duration, requestedIn))
    const sourceOut = Math.max(sourceIn, Math.min(asset.duration, requestedOut))
    if (sourceOut - sourceIn < 0.08) return []
    const clip: TimelineClip = {
      id: makeId(),
      mediaId: asset.id,
      trackId: MUSIC_TRACK_ID,
      position: cursor,
      sourceIn,
      sourceOut,
      gainDb: Math.max(-36, Math.min(12, requestedGain)),
      label: asset.name
    }
    cursor += clipDuration(clip)
    return [clip]
  })
  const withMedia = { ...project, media, updatedAt: new Date().toISOString() }
  if (!added.length) return media.length === project.media.length ? project : withMedia
  return commitEdit(withMedia, 'Add audio', `Added ${added.length} audio clip${added.length === 1 ? '' : 's'} to the Music track`, 'audio-add', (current) => ({
    ...current,
    timeline: { ...current.timeline, clips: [...current.timeline.clips, ...added] }
  }))
}

export function trimAudioClip(project: ProjectData, clipId: string, sourceIn: number, sourceOut: number): ProjectData {
  const clip = getMusicClips(project).find((candidate) => candidate.id === clipId)
  const asset = clip && project.media.find((item) => item.id === clip.mediaId)
  if (!clip || !asset || !Number.isFinite(asset.duration) || asset.duration <= 0
    || !Number.isFinite(sourceIn) || !Number.isFinite(sourceOut)
    || project.timeline.tracks.find((track) => track.id === MUSIC_TRACK_ID)?.locked) return project
  const start = Math.max(0, Math.min(asset.duration, sourceIn))
  const end = Math.max(start, Math.min(asset.duration, sourceOut))
  if (end - start < 0.08 || (Math.abs(start - clip.sourceIn) < 0.001 && Math.abs(end - clip.sourceOut) < 0.001)) return project
  return commitEdit(project, 'Trim audio clip', `Trimmed ${asset.name}`, 'audio-trim', (current) => ({
    ...current,
    timeline: { ...current.timeline, clips: current.timeline.clips.map((item) => item.id === clipId ? { ...item, sourceIn: start, sourceOut: end } : item) }
  }))
}

export function moveAudioClip(project: ProjectData, clipId: string, position: number): ProjectData {
  const clip = getMusicClips(project).find((candidate) => candidate.id === clipId)
  if (!clip || !Number.isFinite(position) || project.timeline.tracks.find((track) => track.id === MUSIC_TRACK_ID)?.locked) return project
  const nextPosition = Math.max(0, Math.min(86_400, position))
  if (Math.abs(nextPosition - clip.position) < 0.025) return project
  return commitEdit(project, 'Move audio clip', `Moved ${clip.label ?? 'audio'} to ${nextPosition.toFixed(2)}s`, 'audio-move', (current) => ({
    ...current,
    timeline: { ...current.timeline, clips: current.timeline.clips.map((item) => item.id === clipId ? { ...item, position: nextPosition } : item) }
  }))
}

export function removeAudioClip(project: ProjectData, clipId: string): ProjectData {
  if (!getMusicClips(project).some((clip) => clip.id === clipId)) return project
  if (project.timeline.tracks.find((track) => track.id === MUSIC_TRACK_ID)?.locked) return project
  return commitEdit(project, 'Remove audio clip', 'Removed an audio clip from the Music track', 'audio-delete', (current) => ({
    ...current,
    timeline: { ...current.timeline, clips: current.timeline.clips.filter((clip) => clip.id !== clipId) }
  }))
}

export function setAudioClipGain(project: ProjectData, clipId: string, gainDb: number): ProjectData {
  const clip = getMusicClips(project).find((candidate) => candidate.id === clipId)
  if (!clip || !Number.isFinite(gainDb) || project.timeline.tracks.find((track) => track.id === MUSIC_TRACK_ID)?.locked) return project
  const bounded = Math.max(-36, Math.min(12, gainDb))
  if (Math.abs(clip.gainDb - bounded) < 0.01) return project
  return commitEdit(project, 'Adjust audio clip volume', `Set audio clip gain to ${bounded.toFixed(1)} dB`, 'audio-gain', (current) => ({
    ...current,
    timeline: { ...current.timeline, clips: current.timeline.clips.map((item) => item.id === clipId ? { ...item, gainDb: bounded } : item) }
  }))
}

export function setTrackMuted(project: ProjectData, trackId: string, muted: boolean): ProjectData {
  const track = project.timeline.tracks.find((item) => item.id === trackId)
  if (!track || track.muted === muted) return project
  return commitEdit(project, muted ? 'Mute track' : 'Unmute track', `${muted ? 'Muted' : 'Unmuted'} ${track.name} track`, 'track-mute', (current) => ({
    ...current,
    timeline: { ...current.timeline, tracks: current.timeline.tracks.map((item) => item.id === trackId ? { ...item, muted } : item) }
  }))
}

export function splitClip(project: ProjectData, clipId: string, time: number): ProjectData {
  const clip = getVideoClips(project).find((candidate) => candidate.id === clipId)
  if (!clip) return project
  const localTime = time - clip.position
  if (localTime < 0.08 || localTime > clipDuration(clip) - 0.08) return project
  const sourceCut = clip.sourceIn + localTime
  const before: TimelineClip = { ...clip, sourceOut: sourceCut }
  const after: TimelineClip = { ...clip, id: makeId(), sourceIn: sourceCut, position: time }
  const clips = getVideoClips(project).flatMap((candidate) => candidate.id === clipId ? [before, after] : [candidate])
  return commitEdit(project, 'Split clip', `Split at ${time.toFixed(2)}s`, 'split', (current) => ({
    ...current,
    timeline: replaceClips(current, clips)
  }))
}

export function trimClip(
  project: ProjectData,
  clipId: string,
  sourceIn: number,
  sourceOut: number
): ProjectData {
  const clip = getVideoClips(project).find((candidate) => candidate.id === clipId)
  if (!clip) return project
  const asset = project.media.find((item) => item.id === clip.mediaId)
  const maxDuration = asset?.duration ?? clip.sourceOut
  const start = Math.max(0, Math.min(sourceIn, maxDuration))
  const end = Math.max(start, Math.min(sourceOut, maxDuration))
  if (end - start < 0.08 || (Math.abs(start - clip.sourceIn) < 0.001 && Math.abs(end - clip.sourceOut) < 0.001)) return project
  const clips = getVideoClips(project).map((candidate) => candidate.id === clipId
    ? { ...candidate, sourceIn: start, sourceOut: end }
    : candidate)
  return commitEdit(project, 'Trim clip', `Trimmed ${asset?.name ?? 'clip'}`, 'trim', (current) => ({
    ...current,
    timeline: replaceClips(current, clips)
  }))
}

export function deleteTimelineRange(project: ProjectData, start: number, end: number): ProjectData {
  const rangeStart = Math.max(0, Math.min(start, end))
  const rangeEnd = Math.max(rangeStart, Math.max(start, end))
  if (rangeEnd - rangeStart < 0.025) return project
  const before = getVideoClips(project)
  let changed = false
  const result: TimelineClip[] = []
  for (const clip of before) {
    const clipStart = clip.position
    const clipEnd = clipStart + clipDuration(clip)
    const overlapStart = Math.max(clipStart, rangeStart)
    const overlapEnd = Math.min(clipEnd, rangeEnd)
    if (overlapEnd <= overlapStart + 0.001) {
      result.push(clip)
      continue
    }
    changed = true
    const sourceAt = (time: number) => clip.sourceIn + (time - clipStart)
    if (overlapStart > clipStart + 0.025) {
      result.push({ ...clip, sourceOut: sourceAt(overlapStart) })
    }
    if (overlapEnd < clipEnd - 0.025) {
      result.push({
        ...clip,
        id: makeId(),
        sourceIn: sourceAt(overlapEnd),
        position: overlapEnd
      })
    }
  }
  if (!changed) return project
  const removed = Math.min(rangeEnd - rangeStart, projectDuration(project))
  return commitEdit(project, 'Delete timeline range', `Removed ${removed.toFixed(2)}s from the timeline`, 'delete-range', (current) => ({
    ...current,
    timeline: replaceClips(current, result)
  }))
}

export function createShortFromRange(
  project: ProjectData,
  start: number,
  end: number,
  aspectRatio: ExportSettings['aspectRatio'] = '9:16'
): ProjectData {
  const duration = projectDuration(project)
  const videoClips = getVideoClips(project)
  const musicClips = getMusicClips(project)
  if (!(['16:9', '9:16', '1:1'] as const).includes(aspectRatio) || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end - start < 0.08 || end > duration + 0.001
    || !videoClips.length || project.timeline.tracks.find((track) => track.id === VIDEO_TRACK_ID)?.locked) return project
  const subtitleTrackLocked = project.timeline.tracks.find((track) => track.id === SUBTITLE_TRACK_ID)?.locked
  const musicTrackLocked = project.timeline.tracks.find((track) => track.id === MUSIC_TRACK_ID)?.locked
  if ((subtitleTrackLocked && project.subtitles.length > 0) || (musicTrackLocked && musicClips.length > 0)) return project

  const keptVideo = videoClips.flatMap((clip) => {
    const overlapStart = Math.max(start, clip.position)
    const overlapEnd = Math.min(end, clip.position + clipDuration(clip))
    if (overlapEnd - overlapStart < 0.025) return []
    return [{
      ...clip,
      position: overlapStart - start,
      sourceIn: clip.sourceIn + overlapStart - clip.position,
      sourceOut: clip.sourceIn + overlapEnd - clip.position
    }]
  })
  if (!keptVideo.length) return project

  const keptMusic = musicClips.flatMap((clip) => {
    const overlapStart = Math.max(start, clip.position)
    const overlapEnd = Math.min(end, clip.position + clipDuration(clip))
    if (overlapEnd - overlapStart < 0.025) return []
    return [{
      ...clip,
      position: overlapStart - start,
      sourceIn: clip.sourceIn + overlapStart - clip.position,
      sourceOut: clip.sourceIn + overlapEnd - clip.position
    }]
  })
  const keptSubtitles = project.subtitles.flatMap((subtitle) => {
    const overlapStart = Math.max(start, subtitle.start)
    const overlapEnd = Math.min(end, subtitle.end)
    if (overlapEnd - overlapStart < 0.03) return []
    return [{ ...subtitle, start: overlapStart - start, end: overlapEnd - start }]
  })
  const nextClips = [
    ...project.timeline.clips.filter((clip) => clip.trackId !== VIDEO_TRACK_ID && clip.trackId !== MUSIC_TRACK_ID),
    ...keptVideo,
    ...keptMusic
  ]
  if (start <= 0.001 && Math.abs(end - duration) <= 0.001 && aspectRatio === project.exportSettings.aspectRatio
    && JSON.stringify(keptSubtitles) === JSON.stringify(project.subtitles)) return project
  return commitEdit(project, 'Create short', `Kept ${start.toFixed(2)}–${end.toFixed(2)}s and set ${aspectRatio} framing`, 'create-short', (current) => ({
    timeline: { ...current.timeline, clips: nextClips },
    subtitles: keptSubtitles,
    exportSettings: { ...current.exportSettings, aspectRatio }
  }))
}

export function reorderClip(project: ProjectData, clipId: string, targetId: string): ProjectData {
  const clips = getVideoClips(project)
  const fromIndex = clips.findIndex((clip) => clip.id === clipId)
  const toIndex = clips.findIndex((clip) => clip.id === targetId)
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return project
  const [moved] = clips.splice(fromIndex, 1)
  clips.splice(toIndex, 0, moved)
  const ordered = clips.map((clip, index) => ({ ...clip, position: index }))
  return commitEdit(project, 'Reorder clip', 'Moved a clip on the video track', 'move', (current) => ({
    ...current,
    timeline: replaceClips(current, ordered)
  }))
}

export function setClipGain(project: ProjectData, clipId: string, gainDb: number): ProjectData {
  const clip = getVideoClips(project).find((candidate) => candidate.id === clipId)
  if (!clip) return project
  const bounded = Math.max(-36, Math.min(12, gainDb))
  if (Math.abs(clip.gainDb - bounded) < 0.01) return project
  const clips = getVideoClips(project).map((candidate) => candidate.id === clipId ? { ...candidate, gainDb: bounded } : candidate)
  return commitEdit(project, 'Adjust clip audio', `Set clip gain to ${bounded.toFixed(1)} dB`, 'audio-gain', (current) => ({
    ...current,
    timeline: replaceClips(current, clips)
  }))
}

export function adjustProjectVolume(project: ProjectData, percent: number): ProjectData {
  const boundedPercent = Math.max(-100, Math.min(200, percent))
  const factor = Math.max(0.01, 1 + boundedPercent / 100)
  const deltaDb = 20 * Math.log10(factor)
  const clips = getVideoClips(project)
  if (!clips.length || Math.abs(deltaDb) < 0.01) return project
  return commitEdit(project, 'Adjust audio level', `${boundedPercent > 0 ? 'Raised' : 'Lowered'} clip audio by ${Math.abs(boundedPercent)}%`, 'audio-gain', (current) => ({
    ...current,
    timeline: replaceClips(current, clips.map((clip) => ({ ...clip, gainDb: Math.max(-36, Math.min(12, clip.gainDb + deltaDb)) })))
  }))
}

export function setAspectRatio(project: ProjectData, aspectRatio: ExportSettings['aspectRatio']): ProjectData {
  if (project.exportSettings.aspectRatio === aspectRatio) return project
  return commitEdit(project, 'Change aspect ratio', `Changed output framing to ${aspectRatio}`, 'aspect-ratio', (current) => ({
    ...current,
    exportSettings: { ...current.exportSettings, aspectRatio }
  }))
}

export function commitExportSettings(
  project: ProjectData,
  settings: ExportSettings,
  title = 'Change export settings',
  kind = 'export-settings'
): ProjectData {
  if (JSON.stringify(project.exportSettings) === JSON.stringify(settings)) return project
  const summary = `${settings.format.toUpperCase()} · ${settings.codec.toUpperCase()} · ${settings.resolution} · ${settings.aspectRatio} · ${settings.fps}fps · ${settings.quality}`
  return commitEdit(project, title, summary, kind, (current) => ({
    timeline: current.timeline,
    subtitles: current.subtitles,
    exportSettings: settings
  }))
}

export function removeSilenceFromTimeline(
  project: ProjectData,
  minimumDuration: number
): { project: ProjectData; removedSegments: number; removedDuration: number } {
  const threshold = Math.max(0.2, Math.min(30, minimumDuration))
  const clips = getVideoClips(project)
  const kept: TimelineClip[] = []
  let removedSegments = 0
  let removedDuration = 0

  for (const clip of clips) {
    const silences = project.analysisByMedia[clip.mediaId]?.silences ?? []
    const relevant = silences
      .filter((silence) => silence.duration >= threshold && silence.end > clip.sourceIn && silence.start < clip.sourceOut)
      .map((silence) => ({
        start: Math.max(clip.sourceIn, silence.start),
        end: Math.min(clip.sourceOut, silence.end)
      }))
      .filter((silence) => silence.end > silence.start)
      .sort((a, b) => a.start - b.start)

    let cursor = clip.sourceIn
    const merged: Array<{ start: number; end: number }> = []
    for (const silence of relevant) {
      const last = merged.at(-1)
      if (last && silence.start <= last.end + 0.02) last.end = Math.max(last.end, silence.end)
      else merged.push({ ...silence })
    }
    for (const silence of merged) {
      if (silence.start - cursor > 0.04) {
        kept.push({ ...clip, id: kept.length ? makeId() : clip.id, sourceIn: cursor, sourceOut: silence.start, position: 0 })
      }
      const cutStart = Math.max(cursor, silence.start)
      const cutEnd = Math.max(cutStart, silence.end)
      if (cutEnd - cutStart > 0.04) {
        removedSegments += 1
        removedDuration += cutEnd - cutStart
      }
      cursor = Math.max(cursor, silence.end)
    }
    if (clip.sourceOut - cursor > 0.04) {
      kept.push({ ...clip, id: cursor === clip.sourceIn ? clip.id : makeId(), sourceIn: cursor, sourceOut: clip.sourceOut, position: 0 })
    }
  }

  if (removedSegments === 0) return { project, removedSegments: 0, removedDuration: 0 }
  const nextProject = commitEdit(
    project,
    'Remove silence',
    `Removed ${removedSegments} silence segment${removedSegments === 1 ? '' : 's'} (${removedDuration.toFixed(1)}s)`,
    'remove-silence',
    (current) => ({ ...current, timeline: replaceClips(current, kept) })
  )
  return { project: nextProject, removedSegments, removedDuration }
}

export function getClipAtTime(project: ProjectData, time: number): TimelineClip | undefined {
  return getVideoClips(project).find((clip) => time >= clip.position && time < clip.position + clipDuration(clip))
}

export function addTranscriptSubtitles(project: ProjectData, segments: ProjectData['subtitles']): ProjectData {
  if (!segments.length || project.timeline.tracks.find((track) => track.id === SUBTITLE_TRACK_ID)?.locked) return project
  return commitEdit(project, 'Add subtitles', `Added ${segments.length} subtitle segments`, 'subtitles', (current) => ({
    ...current,
    subtitles: [...current.subtitles, ...segments].sort((a, b) => a.start - b.start)
  }))
}

export function addSubtitle(project: ProjectData, segment: Omit<TranscriptSegment, 'id'> & { id?: string }): ProjectData {
  const id = segment.id ?? makeId()
  const text = segment.text.trim()
  const duration = projectDuration(project)
  if (project.timeline.tracks.find((track) => track.id === SUBTITLE_TRACK_ID)?.locked
    || !text || text.length > 500 || !Number.isFinite(segment.start) || !Number.isFinite(segment.end)
    || segment.start < 0 || segment.end - segment.start < 0.08 || segment.end - segment.start > 30
    || segment.end > duration + 0.001) return project
  const subtitle: TranscriptSegment = { ...segment, id, text }
  return addTranscriptSubtitles(project, [subtitle])
}

export function updateSubtitle(
  project: ProjectData,
  subtitleId: string,
  changes: Partial<Pick<TranscriptSegment, 'start' | 'end' | 'text'>>
): ProjectData {
  const current = project.subtitles.find((item) => item.id === subtitleId)
  if (!current || project.timeline.tracks.find((track) => track.id === SUBTITLE_TRACK_ID)?.locked) return project
  const start = changes.start ?? current.start
  const end = changes.end ?? current.end
  const text = changes.text === undefined ? current.text : changes.text.trim()
  const duration = projectDuration(project)
  if (!text || text.length > 500 || !Number.isFinite(start) || !Number.isFinite(end)
    || start < 0 || end - start < 0.08 || end - start > 30 || end > duration + 0.001) return project
  if (start === current.start && end === current.end && text === current.text) return project
  return commitEdit(project, 'Edit subtitle', `Updated subtitle at ${start.toFixed(2)}s`, 'subtitle-edit', (project) => ({
    ...project,
    subtitles: project.subtitles.map((item) => item.id === subtitleId ? { ...item, start, end, text } : item)
  }))
}

export function deleteSubtitle(project: ProjectData, subtitleId: string): ProjectData {
  if (!project.subtitles.some((item) => item.id === subtitleId)
    || project.timeline.tracks.find((track) => track.id === SUBTITLE_TRACK_ID)?.locked) return project
  return commitEdit(project, 'Delete subtitle', 'Deleted a subtitle', 'subtitle-delete', (current) => ({
    ...current,
    subtitles: current.subtitles.filter((item) => item.id !== subtitleId)
  }))
}

export function generateTimelineSubtitles(project: ProjectData, mediaId?: string): ProjectData {
  const generated: ProjectData['subtitles'] = []
  for (const clip of getVideoClips(project)) {
    if (mediaId && clip.mediaId !== mediaId) continue
    const transcript = project.analysisByMedia[clip.mediaId]?.transcript ?? []
    for (const segment of transcript) {
      const start = Math.max(clip.sourceIn, segment.start)
      const end = Math.min(clip.sourceOut, segment.end)
      if (end - start < 0.03) continue
      generated.push({
        id: makeId(),
        start: clip.position + start - clip.sourceIn,
        end: clip.position + end - clip.sourceIn,
        text: segment.text,
        words: segment.words,
        speaker: segment.speaker
      })
    }
  }
  if (!generated.length) return project
  const existing = new Set(project.subtitles.map((item) => `${item.start.toFixed(2)}:${item.text}`))
  const unique = generated.filter((item) => !existing.has(`${item.start.toFixed(2)}:${item.text}`))
  if (!unique.length) return project
  return addTranscriptSubtitles(project, unique)
}
