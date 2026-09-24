import { describe, expect, it } from 'vitest'
import { addAudioToTimeline, addMediaToTimeline, addSubtitle, AUDIO_TRACK_ID, commitExportSettings, createProject, createShortFromRange, deleteSubtitle, deleteTimelineRange, getMusicClips, importSubtitles, MUSIC_TRACK_ID, moveAudioClip, redoEdit, removeAudioClip, removeSilenceFromTimeline, reorderClip, setAudioClipGain, setTrackMuted, splitClip, trimAudioClip, trimClip, undoEdit, updateSubtitle } from './project'
import type { AnalysisResult, MediaAsset } from './types'
import { VIDEO_TRACK_ID } from './project'

const asset: MediaAsset = {
  id: 'media-1', name: 'sample.mp4', filePath: 'C:/sample.mp4', duration: 20, width: 1920, height: 1080,
  fps: 30, sizeBytes: 1000, hasAudio: true, videoCodec: 'h264', importedAt: new Date(0).toISOString()
}

function seededProject() {
  return addMediaToTimeline(createProject('test', 'C:/Project'), [asset])
}

describe('non-destructive timeline operations', () => {
  it('splits a source clip at the requested timeline time', () => {
    const project = seededProject()
    const clip = project.timeline.clips[0]
    const split = splitClip(project, clip.id, 7)
    expect(split.timeline.clips).toHaveLength(2)
    expect(split.timeline.clips[0].sourceOut).toBe(7)
    expect(split.timeline.clips[1].sourceIn).toBe(7)
    expect(split.timeline.clips[1].position).toBe(7)
  })

  it('trims source in/out points without modifying the media and records one undoable edit', () => {
    const project = seededProject()
    const clip = project.timeline.clips[0]
    const trimmed = trimClip(project, clip.id, 2, 14)
    expect(trimmed.timeline.clips[0]).toMatchObject({ sourceIn: 2, sourceOut: 14, position: 0 })
    expect(trimmed.history.undo).toHaveLength(1)
    expect(trimClip(trimmed, clip.id, 2, 2.05)).toBe(trimmed)
    expect(undoEdit(trimmed).timeline.clips[0]).toMatchObject({ sourceIn: 0, sourceOut: 20 })
  })

  it('deletes a timeline range by keeping source ranges on either side', () => {
    const project = seededProject()
    const deleted = deleteTimelineRange(project, 5, 9)
    expect(deleted.timeline.clips).toHaveLength(2)
    expect(deleted.timeline.clips.map((clip) => [clip.sourceIn, clip.sourceOut])).toEqual([[0, 5], [9, 20]])
    expect(deleted.timeline.clips[1].position).toBe(5)
  })

  it('adds, moves, adjusts, mutes and removes independent audio clips with undoable history', () => {
    const music: MediaAsset = {
      ...asset, id: 'music-1', name: 'music.wav', filePath: 'C:/music.wav', width: 0, height: 0,
      hasAudio: true, videoCodec: 'none', audioCodec: 'pcm_s16le'
    }
    const added = addAudioToTimeline(seededProject(), [music])
    const clip = getMusicClips(added)[0]
    expect(added.media.some((item) => item.id === music.id)).toBe(true)
    expect(clip).toMatchObject({ mediaId: music.id, trackId: MUSIC_TRACK_ID, position: 0, sourceIn: 0, sourceOut: music.duration })
    expect(added.history.undo).toHaveLength(1)

    const trimmed = trimAudioClip(added, clip.id, 1, 9)
    expect(getMusicClips(trimmed)[0]).toMatchObject({ sourceIn: 1, sourceOut: 9, position: 0 })
    expect(trimAudioClip(trimmed, clip.id, 1, 1.05)).toBe(trimmed)
    const moved = moveAudioClip(trimmed, clip.id, 2.5)
    expect(getMusicClips(moved)[0]).toMatchObject({ sourceIn: 1, sourceOut: 9, position: 2.5 })
    const louder = setAudioClipGain(moved, clip.id, 6)
    expect(getMusicClips(louder)[0].gainDb).toBe(6)
    const muted = setTrackMuted(louder, MUSIC_TRACK_ID, true)
    expect(muted.timeline.tracks.find((track) => track.id === MUSIC_TRACK_ID)?.muted).toBe(true)
    expect(undoEdit(muted).timeline.tracks.find((track) => track.id === MUSIC_TRACK_ID)?.muted).toBe(false)
    expect(redoEdit(undoEdit(muted)).timeline.tracks.find((track) => track.id === MUSIC_TRACK_ID)?.muted).toBe(true)
    expect(setTrackMuted(muted, AUDIO_TRACK_ID, true).timeline.tracks.find((track) => track.id === AUDIO_TRACK_ID)?.muted).toBe(true)

    const removed = removeAudioClip(muted, clip.id)
    expect(getMusicClips(removed)).toHaveLength(0)
    expect(getMusicClips(undoEdit(removed))).toHaveLength(1)
  })

  it('adds, edits and deletes timed subtitles with range validation and undo/redo', () => {
    const project = seededProject()
    const added = addSubtitle(project, { start: 1, end: 2, text: 'First caption' })
    const subtitle = added.subtitles[0]
    expect(subtitle).toMatchObject({ start: 1, end: 2, text: 'First caption' })
    expect(added.history.undo).toHaveLength(1)
    expect(addSubtitle(added, { start: 21, end: 22, text: 'Outside the timeline' })).toBe(added)

    const edited = updateSubtitle(added, subtitle.id, { start: 2.5, end: 3.5, text: 'Updated caption' })
    expect(edited.subtitles[0]).toMatchObject({ start: 2.5, end: 3.5, text: 'Updated caption' })
    expect(updateSubtitle(edited, subtitle.id, { end: 21 })).toBe(edited)
    const deleted = deleteSubtitle(edited, subtitle.id)
    expect(deleted.subtitles).toHaveLength(0)
    expect(undoEdit(deleted).subtitles).toHaveLength(1)
    expect(redoEdit(undoEdit(deleted)).subtitles).toHaveLength(0)
  })

  it('imports subtitle files in one undoable edit with range validation', () => {
    const project = seededProject()
    const { project: next, imported, skipped } = importSubtitles(project, [
      { start: 5, end: 6, text: 'Second' },
      { start: 1, end: 2, text: 'First' },
      { start: 21, end: 22, text: 'Outside the timeline' },
      { start: 3, end: 3.02, text: 'Too short' },
      { start: 4, end: 5, text: '   ' }
    ])
    expect(imported).toBe(2)
    expect(skipped).toBe(3)
    expect(next.subtitles.map((item) => item.text)).toEqual(['First', 'Second'])
    expect(next.history.undo).toHaveLength(1)
    expect(undoEdit(next).subtitles).toHaveLength(0)
    expect(next.operations.at(-1)).toMatchObject({ kind: 'subtitle-import' })
    const empty = importSubtitles(project, [{ start: 21, end: 22, text: 'Outside' }])
    expect(empty.imported).toBe(0)
    expect(empty.project).toBe(project)
  })

  it('extracts a Short range while retiming included music and subtitles in one undoable edit', () => {
    const project = seededProject()
    const music: MediaAsset = { ...asset, id: 'music-1', name: 'theme.wav', duration: 8, width: 0, height: 0, videoCodec: 'none' }
    const withMusic = addAudioToTimeline(project, [music], 2)
    const withCaptions = addSubtitle(addSubtitle(withMusic, { id: 'caption-1', start: 1, end: 7, text: 'Opening caption' }), { id: 'caption-2', start: 6, end: 9, text: 'Selected caption' })
    const short = createShortFromRange(withCaptions, 5, 15, '9:16')

    expect(short).not.toBe(withCaptions)
    expect(short.timeline.clips.find((clip) => clip.trackId === VIDEO_TRACK_ID)).toMatchObject({ sourceIn: 5, sourceOut: 15, position: 0 })
    expect(getMusicClips(short)[0]).toMatchObject({ sourceIn: 3, sourceOut: 8, position: 0 })
    expect(short.subtitles).toEqual([
      expect.objectContaining({ id: 'caption-1', start: 0, end: 2 }),
      expect.objectContaining({ id: 'caption-2', start: 1, end: 4 })
    ])
    expect(short.exportSettings.aspectRatio).toBe('9:16')
    expect(short.history.undo).toHaveLength(4)
    expect(undoEdit(short).subtitles).toHaveLength(2)
    expect(undoEdit(short).exportSettings.aspectRatio).toBe('16:9')

    const locked = { ...withCaptions, timeline: { ...withCaptions.timeline, tracks: withCaptions.timeline.tracks.map((track) => track.id === MUSIC_TRACK_ID ? { ...track, locked: true } : track) } }
    expect(createShortFromRange(locked, 5, 15)).toBe(locked)
    expect(createShortFromRange(withCaptions, -1, 15)).toBe(withCaptions)
  })

  it('reorders clips while retaining the new order after timeline normalization', () => {
    const second: MediaAsset = { ...asset, id: 'media-2', name: 'second.mp4', duration: 5 }
    const project = addMediaToTimeline(createProject('test', 'C:/Project'), [asset, second])
    const [first, last] = project.timeline.clips
    const reordered = reorderClip(project, last.id, first.id)
    expect(reordered.timeline.clips.map((clip) => clip.mediaId)).toEqual(['media-2', 'media-1'])
    expect(reordered.timeline.clips.map((clip) => clip.position)).toEqual([0, 5])
  })

  it('restores the prior edit state on undo and reapplies it on redo', () => {
    const project = seededProject()
    const edited = deleteTimelineRange(project, 5, 9)
    const undone = undoEdit(edited)
    expect(undone.timeline.clips).toHaveLength(1)
    expect(undone.timeline.clips[0].sourceOut).toBe(20)
    expect(redoEdit(undone).timeline.clips).toHaveLength(2)
  })

  it('records export-setting changes in the same undo/redo history as Timeline edits', () => {
    const project = seededProject()
    const edited = commitExportSettings(project, { ...project.exportSettings, aspectRatio: '9:16', resolution: '1080p', fps: 30 })
    expect(edited.exportSettings.aspectRatio).toBe('9:16')
    expect(undoEdit(edited).exportSettings).toEqual(project.exportSettings)
    expect(redoEdit(undoEdit(edited)).exportSettings.aspectRatio).toBe('9:16')
  })

  it('removes detected silence only from the editable source range', () => {
    const project = seededProject()
    const analysis: AnalysisResult = {
      mediaId: asset.id,
      analyzedAt: new Date().toISOString(),
      scenes: [],
      silences: [{ start: 4, end: 7, duration: 3 }, { start: 14, end: 15, duration: 1 }],
      transcript: [],
      audio: { clippingDetected: false, silenceCount: 2, analyzed: true },
      quality: { width: 1920, height: 1080, fps: 30, videoCodec: 'h264', notes: [] },
      warnings: []
    }
    const result = removeSilenceFromTimeline({ ...project, analysisByMedia: { [asset.id]: analysis } }, 2)
    expect(result.removedSegments).toBe(1)
    expect(result.removedDuration).toBe(3)
    expect(result.project.timeline.clips.filter((clip) => clip.trackId === VIDEO_TRACK_ID)).toHaveLength(2)
    expect(result.project.timeline.clips.map((clip) => [clip.sourceIn, clip.sourceOut])).toEqual([[0, 4], [7, 20]])
  })
})
