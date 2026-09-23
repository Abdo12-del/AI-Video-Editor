import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import type { MediaAsset, ProjectData } from '../shared/types'
import { addAudioToTimeline, MUSIC_TRACK_ID } from '../shared/project'

const mocks = vi.hoisted(() => ({
  showOpenDialog: vi.fn(),
  fromWebContents: vi.fn(() => ({})),
  probeMedia: vi.fn(),
  createThumbnail: vi.fn(),
  createWaveform: vi.fn(),
  writeLog: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: mocks.fromWebContents },
  dialog: { showOpenDialog: mocks.showOpenDialog }
}))
vi.mock('./mediaEngine', () => ({ probeMedia: mocks.probeMedia, createThumbnail: mocks.createThumbnail, createWaveform: mocks.createWaveform }))
vi.mock('./logger', () => ({ writeLog: mocks.writeLog }))

import { createNewProject, getActiveProjectFile, importAudio, importVideos, normalizeIncomingProject, openExistingProject, openProjectAtPath, saveActiveProject } from './projectStore'

let root = ''
const event = { sender: {} } as IpcMainInvokeEvent

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ai-video-project-store-'))
  mocks.showOpenDialog.mockReset()
  mocks.fromWebContents.mockClear()
  mocks.probeMedia.mockReset()
  mocks.createThumbnail.mockReset().mockImplementation(async (_filePath: string, thumbnailPath: string) => writeFile(thumbnailPath, 'thumbnail-image'))
  mocks.createWaveform.mockReset().mockImplementation(async (_filePath: string, waveformPath: string) => writeFile(waveformPath, 'waveform-image'))
  mocks.writeLog.mockReset().mockResolvedValue(undefined)
})

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
})

describe('local project persistence and media trust boundary', () => {
  it('rejects relative or missing recent-project roots', async () => {
    await expect(openProjectAtPath('relative/project')).rejects.toThrow(/location is invalid/i)
    await expect(openProjectAtPath(join(root, 'not-a-project'))).rejects.toThrow(/could not be found/i)
  })

  it('reopens project folders with Arabic names and spaces', async () => {
    const unicodeRoot = join(root, 'مشروع مونتاج 2025')
    await mkdir(unicodeRoot, { recursive: true })
    mocks.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [unicodeRoot] })
    const project = await createNewProject(event, 'مساحة تحرير')
    const reopened = await openProjectAtPath(unicodeRoot)
    expect(reopened.id).toBe(project?.id)
    expect(reopened.rootPath).toBe(unicodeRoot)
  })

  it('imports audio-only media with a local waveform and no video thumbnail', async () => {
    mocks.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [root] })
    const project = await createNewProject(event, 'Audio project')
    const sourcePath = join(root, 'background-music.wav')
    await writeFile(sourcePath, 'original-audio', 'utf8')
    mocks.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [sourcePath] })
    mocks.probeMedia.mockResolvedValue({
      name: 'background-music.wav', filePath: sourcePath, duration: 12, width: 0, height: 0,
      fps: 30, sizeBytes: 14, hasAudio: true, videoCodec: 'none', audioCodec: 'pcm_s16le'
    })

    const imported = await importAudio(event)

    expect(imported?.assets).toHaveLength(1)
    expect(imported?.assets[0]).toMatchObject({ width: 0, height: 0, hasAudio: true, videoCodec: 'none' })
    expect(imported?.assets[0].waveformUrl).toContain('aivideo://waveform/')
    expect(imported?.assets[0].thumbnailUrl).toBeUndefined()
    expect(mocks.createWaveform).toHaveBeenCalledTimes(1)
    expect(mocks.createThumbnail).not.toHaveBeenCalled()

    const edited = addAudioToTimeline(project!, imported!.assets)
    await saveActiveProject(edited)
    const saved = JSON.parse(await readFile(join(root, 'project.json'), 'utf8')) as ProjectData
    expect(saved.timeline.clips[0]).toMatchObject({ mediaId: imported!.assets[0].id, trackId: MUSIC_TRACK_ID, position: 0 })
    expect(saved.media[0].waveformPath).toBe(join('waveforms', `${imported!.assets[0].id}.png`))
  })

  it('creates, imports, safely saves stale renderer state, and reopens a project', async () => {
    mocks.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [root] })
    const project = await createNewProject(event, 'Local Project')
    expect(project?.name).toBe('Local Project')
    expect(getActiveProjectFile()).toBe(join(root, 'project.json'))

    const recent = await openProjectAtPath(root)
    expect(recent.id).toBe(project?.id)
    expect(recent.rootPath).toBe(root)

    const sourcePath = join(root, 'camera-original.mp4')
    await writeFile(sourcePath, 'original-source', 'utf8')
    const probe: Omit<MediaAsset, 'id' | 'importedAt' | 'thumbnailPath' | 'thumbnailUrl' | 'previewUrl'> = {
      name: 'camera-original.mp4', filePath: sourcePath, duration: 12, width: 1920, height: 1080,
      fps: 30, sizeBytes: 15, hasAudio: true, videoCodec: 'h264'
    }
    mocks.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [sourcePath] })
    mocks.probeMedia.mockResolvedValue(probe)
    const imported = await importVideos(event)
    expect(imported?.assets).toHaveLength(1)
    expect(imported?.assets[0].previewUrl).toContain('aivideo://media/')
    expect(imported?.assets[0].thumbnailUrl).toContain('aivideo://thumbnail/')
    expect(imported?.assets[0].waveformUrl).toContain('aivideo://waveform/')
    expect(imported?.assets[0].waveformPath).toContain(join('waveforms', `${imported!.assets[0].id}.png`))

    const edgeClip = { id: 'edge-clip', mediaId: imported!.assets[0].id, trackId: 'track-video', position: 0, sourceIn: 11.95, sourceOut: 12.02, gainDb: 0 }
    const clippedToSource = normalizeIncomingProject({
      ...project!, media: imported!.assets, timeline: { ...project!.timeline, clips: [edgeClip] }
    })
    expect(clippedToSource.timeline.clips[0]).toMatchObject({ sourceIn: 11.95, sourceOut: 12 })
    const emptyAfterClamp = { ...edgeClip, id: 'past-source', sourceIn: 12.02, sourceOut: 12.04 }
    expect(() => normalizeIncomingProject({
      ...project!, media: imported!.assets, timeline: { ...project!.timeline, clips: [emptyAfterClamp] }
    })).toThrow(/too short after matching/)

    const tampered = { ...project!, media: [{ ...imported!.assets[0], filePath: join(root, 'other.mp4') }] }
    expect(() => normalizeIncomingProject(tampered)).toThrow(/Relink/)

    // Simulate an autosave that began from the renderer snapshot captured before import completed.
    await saveActiveProject(project!)
    const saved = JSON.parse(await readFile(join(root, 'project.json'), 'utf8')) as { media: MediaAsset[] }
    expect(saved.media).toHaveLength(1)
    expect(saved.media[0].filePath).toBe(sourcePath)
    expect(saved.media[0].thumbnailPath).toBe(join('thumbnails', `${imported!.assets[0].id}.jpg`))
    expect(saved.media[0].waveformPath).toBe(join('waveforms', `${imported!.assets[0].id}.png`))
    expect(saved.media[0].waveformUrl).toBeUndefined()

    mocks.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [join(root, 'project.json')] })
    const reopened = await openExistingProject(event)
    expect(reopened?.id).toBe(project?.id)
    expect(reopened?.media[0].previewUrl).toBe(`aivideo://media/${imported!.assets[0].id}`)
    expect(reopened?.media[0].waveformUrl).toBe(`aivideo://waveform/${imported!.assets[0].id}`)
    expect(reopened?.media[0].missing).toBe(false)

    const movedRoot = join(root, 'moved-project')
    await mkdir(join(movedRoot, 'waveforms'), { recursive: true })
    await mkdir(join(movedRoot, 'thumbnails'), { recursive: true })
    await copyFile(join(root, 'project.json'), join(movedRoot, 'project.json'))
    await copyFile(imported!.assets[0].waveformPath!, join(movedRoot, 'waveforms', `${imported!.assets[0].id}.png`))
    await copyFile(imported!.assets[0].thumbnailPath!, join(movedRoot, 'thumbnails', `${imported!.assets[0].id}.jpg`))
    mocks.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [join(movedRoot, 'project.json')] })
    const moved = await openExistingProject(event)
    expect(moved?.rootPath).toBe(movedRoot)
    expect(moved?.media[0].thumbnailPath).toBe(join(movedRoot, 'thumbnails', `${imported!.assets[0].id}.jpg`))
    expect(moved?.media[0].thumbnailUrl).toBe(`aivideo://thumbnail/${imported!.assets[0].id}`)
    expect(moved?.media[0].waveformPath).toBe(join(movedRoot, 'waveforms', `${imported!.assets[0].id}.png`))
    expect(moved?.media[0].waveformUrl).toBe(`aivideo://waveform/${imported!.assets[0].id}`)
  })
})
