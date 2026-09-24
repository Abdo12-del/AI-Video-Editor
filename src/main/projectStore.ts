import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { BrowserWindow, dialog, type IpcMainInvokeEvent } from 'electron'
import { createProject, MUSIC_TRACK_ID, VIDEO_TRACK_ID } from '../shared/project'
import type { MediaAsset, ProjectData, TimelineClip } from '../shared/types'
import { createThumbnail, createWaveform, probeMedia } from './mediaEngine'
import { PlussubSubtitleParser, type ImportedSubtitle } from './subtitleImport'
import { writeLog } from './logger'

const projectFolders = ['media', 'cache', 'thumbnails', 'waveforms', 'transcripts', 'previews', 'exports']
let activeProjectFile: string | null = null
let activeProject: ProjectData | null = null
let projectPersistenceQueue: Promise<void> = Promise.resolve()

export class ProjectStoreError extends Error {}

function projectRelativePath(rootPath: string, filePath?: string): string | undefined {
  if (!filePath) return undefined
  const root = resolve(rootPath)
  const relativePath = relative(root, resolve(filePath))
  if (!relativePath || relativePath === '.' || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) return undefined
  return relativePath
}

function resolveProjectArtifact(rootPath: string, storedPath: string | undefined, fallbackPath: string): string | undefined {
  const root = resolve(rootPath)
  if (storedPath) {
    const candidate = resolve(root, storedPath)
    if (projectRelativePath(root, candidate) && existsSync(candidate)) return candidate
  }
  const fallback = join(root, fallbackPath)
  return existsSync(fallback) ? fallback : undefined
}

function hydrateProject(project: ProjectData): ProjectData {
  const rootPath = dirname(activeProjectFile ?? project.rootPath)
  return {
    ...project,
    rootPath,
    media: project.media.map((asset) => {
      const thumbnailPath = resolveProjectArtifact(rootPath, asset.thumbnailPath, join('thumbnails', `${asset.id}.jpg`))
      const waveformPath = resolveProjectArtifact(rootPath, asset.waveformPath, join('waveforms', `${asset.id}.png`))
      return {
        ...asset,
        previewUrl: existsSync(asset.filePath) ? `aivideo://media/${encodeURIComponent(asset.id)}` : undefined,
        thumbnailPath,
        thumbnailUrl: thumbnailPath ? `aivideo://thumbnail/${encodeURIComponent(asset.id)}` : undefined,
        waveformPath,
        waveformUrl: waveformPath ? `aivideo://waveform/${encodeURIComponent(asset.id)}` : undefined,
        missing: !existsSync(asset.filePath)
      }
    })
  }
}

function diskProject(project: ProjectData): ProjectData {
  const rootPath = dirname(activeProjectFile ?? project.rootPath)
  return {
    ...project,
    rootPath,
    media: project.media.map(({ previewUrl: _previewUrl, thumbnailUrl: _thumbnailUrl, waveformUrl: _waveformUrl, missing: _missing, ...asset }) => ({
      ...asset,
      thumbnailPath: projectRelativePath(rootPath, asset.thumbnailPath),
      waveformPath: projectRelativePath(rootPath, asset.waveformPath)
    }))
  }
}

function freshProjectId(): string {
  return randomUUID()
}

export function getActiveProject(): ProjectData | null {
  return activeProject
}

export function getActiveProjectFile(): string | null {
  return activeProjectFile
}

function validateLoadedProject(value: unknown, projectFile: string): ProjectData {
  if (!value || typeof value !== 'object') throw new ProjectStoreError('This file is not a valid AI Video Editor project.')
  const input = value as Partial<ProjectData>
  if (typeof input.id !== 'string' || typeof input.name !== 'string' || !Array.isArray(input.media) || !input.timeline || !Array.isArray(input.timeline.clips)) {
    throw new ProjectStoreError('The project file is missing required project or timeline data.')
  }
  const rootPath = dirname(projectFile)
  const media = input.media.map((item) => {
    const asset = item as MediaAsset
    if (!asset || typeof asset.id !== 'string' || typeof asset.filePath !== 'string') throw new ProjectStoreError('The project contains an invalid media reference.')
    const duration = Number.isFinite(asset.duration) ? Math.max(0, asset.duration) : 0
    return {
      ...asset,
      duration,
      width: Number.isFinite(asset.width) ? Math.max(0, asset.width) : 0,
      height: Number.isFinite(asset.height) ? Math.max(0, asset.height) : 0,
      fps: Number.isFinite(asset.fps) ? Math.max(1, Math.min(120, asset.fps)) : 30,
      sizeBytes: Number.isFinite(asset.sizeBytes) ? Math.max(0, asset.sizeBytes) : 0,
      previewUrl: undefined,
      thumbnailUrl: undefined,
      missing: !existsSync(asset.filePath)
    }
  })
  const mediaIds = new Set(media.map((item) => item.id))
  const clips = input.timeline.clips.flatMap((raw) => {
    const clip = raw as TimelineClip
    if (!clip || !mediaIds.has(clip.mediaId) || typeof clip.id !== 'string') return []
    const trackId = clip.trackId === MUSIC_TRACK_ID ? MUSIC_TRACK_ID : clip.trackId === VIDEO_TRACK_ID || !clip.trackId ? VIDEO_TRACK_ID : null
    if (!trackId) return []
    const asset = media.find((item) => item.id === clip.mediaId)!
    if (trackId === MUSIC_TRACK_ID ? !asset.hasAudio : asset.width <= 0 || asset.height <= 0) return []
    const sourceIn = Math.max(0, Math.min(asset.duration, Number(clip.sourceIn) || 0))
    const sourceOut = Math.max(sourceIn, Math.min(asset.duration, Number(clip.sourceOut) || 0))
    if (sourceOut - sourceIn < 0.025) return []
    return [{
      ...clip,
      trackId,
      position: Math.max(0, Number(clip.position) || 0),
      sourceIn,
      sourceOut,
      gainDb: Math.max(-36, Math.min(12, Number(clip.gainDb) || 0))
    }]
  })
  const created = createProject(input.name, rootPath)
  const knownTracks = Array.isArray(input.timeline.tracks) ? input.timeline.tracks : created.timeline.tracks
  const tracks = created.timeline.tracks.map((track) => {
    const candidate = knownTracks.find((item) => item?.id === track.id)
    return { ...track, muted: Boolean(candidate?.muted), locked: Boolean(candidate?.locked) }
  })
  const loaded = {
    ...created,
    ...input,
    schemaVersion: 1,
    rootPath,
    name: input.name.slice(0, 160),
    media,
    analysisByMedia: input.analysisByMedia && typeof input.analysisByMedia === 'object' ? input.analysisByMedia : {},
    timeline: { tracks, clips },
    subtitles: Array.isArray(input.subtitles) ? input.subtitles : [],
    chatMessages: Array.isArray(input.chatMessages) ? input.chatMessages.slice(-500) : [],
    operations: Array.isArray(input.operations) ? input.operations.slice(-500) : [],
    history: input.history && Array.isArray(input.history.undo) && Array.isArray(input.history.redo)
      ? { undo: input.history.undo.slice(-50), redo: input.history.redo.slice(-50) }
      : { undo: [], redo: [] }
  } as ProjectData
  return loaded
}

export function normalizeIncomingProject(input: ProjectData): ProjectData {
  if (!activeProject || !activeProjectFile) throw new ProjectStoreError('Create or open a project first.')
  if (!input || input.id !== activeProject.id) throw new ProjectStoreError('This project is no longer active. Reopen it and try again.')
  if (!Array.isArray(input.media) || !input.timeline || !Array.isArray(input.timeline.clips)) throw new ProjectStoreError('Invalid project state.')
  const trusted = new Map(activeProject.media.map((asset) => [asset.id, asset]))
  const incomingIds = new Set<string>()
  const media = input.media.map((asset) => {
    const canonical = trusted.get(asset.id)
    if (!canonical || canonical.filePath !== asset.filePath) throw new ProjectStoreError('Media references can only be changed with Relink.')
    incomingIds.add(asset.id)
    return { ...canonical, name: canonical.name }
  })
  for (const asset of activeProject.media) if (!incomingIds.has(asset.id)) media.push(asset)
  const mediaMap = new Map(media.map((asset) => [asset.id, asset]))
  const clips = input.timeline.clips.map((clip) => {
    const asset = mediaMap.get(clip.mediaId)
    if (!asset) throw new ProjectStoreError('A timeline clip refers to unavailable media.')
    const trackId = clip.trackId === MUSIC_TRACK_ID ? MUSIC_TRACK_ID : clip.trackId === VIDEO_TRACK_ID || !clip.trackId ? VIDEO_TRACK_ID : null
    if (!trackId) throw new ProjectStoreError('A timeline clip refers to an unsupported track.')
    if (trackId === MUSIC_TRACK_ID ? !asset.hasAudio : asset.width <= 0 || asset.height <= 0) {
      throw new ProjectStoreError('A clip was placed on a track unsupported by its source media.')
    }
    const sourceIn = Number(clip.sourceIn)
    const sourceOut = Number(clip.sourceOut)
    const position = Number(clip.position)
    const gainDb = Number(clip.gainDb)
    if (![sourceIn, sourceOut, position, gainDb].every(Number.isFinite)) throw new ProjectStoreError('A timeline edit contains an invalid value.')
    if (!Number.isFinite(asset.duration) || asset.duration <= 0 || sourceIn < 0 || sourceOut <= sourceIn || sourceOut > asset.duration + 0.05 || position < 0 || position > 86_400 || Math.abs(gainDb) > 36) {
      throw new ProjectStoreError('A timeline edit is outside the source media range.')
    }
    const safeSourceIn = Math.min(sourceIn, asset.duration)
    const safeSourceOut = Math.min(sourceOut, asset.duration)
    if (safeSourceOut - safeSourceIn < 0.025) throw new ProjectStoreError('A timeline clip is too short after matching it to the source duration.')
    return { ...clip, trackId, sourceIn: safeSourceIn, sourceOut: safeSourceOut, position, gainDb: Math.max(-36, Math.min(12, gainDb)) }
  })
  const incomingTracks = new Map((Array.isArray(input.timeline.tracks) ? input.timeline.tracks : []).map((track) => [track.id, track]))
  const tracks = activeProject.timeline.tracks.map((track) => {
    const incoming = incomingTracks.get(track.id)
    return { ...track, muted: Boolean(incoming?.muted), locked: Boolean(incoming?.locked) }
  })
  const clean: ProjectData = {
    ...input,
    rootPath: dirname(activeProjectFile),
    name: String(input.name).slice(0, 160),
    media,
    timeline: { tracks, clips },
    updatedAt: new Date().toISOString()
  }
  if (JSON.stringify(clean).length > 30_000_000) throw new ProjectStoreError('Project data is too large to save safely.')
  return clean
}

function persistProject(project: ProjectData, afterPersist?: () => void): Promise<void> {
  if (!activeProjectFile) throw new ProjectStoreError('There is no open project file.')
  const path = activeProjectFile
  const tempPath = `${path}.${randomUUID()}.tmp`
  const contents = JSON.stringify(diskProject(project), null, 2)
  const operation = projectPersistenceQueue.then(async () => {
    try {
      await writeFile(tempPath, contents, 'utf8')
      await rename(tempPath, path)
      afterPersist?.()
    } catch (error) {
      await rm(tempPath, { force: true })
      throw error
    }
  })
  projectPersistenceQueue = operation.then(() => undefined, () => undefined)
  return operation
}

export async function createNewProject(event: IpcMainInvokeEvent, name: string): Promise<ProjectData | null> {
  const parent = BrowserWindow.fromWebContents(event.sender)
  const selection = await dialog.showOpenDialog(parent!, {
    title: 'Choose a folder for your new project',
    buttonLabel: 'Create project here',
    properties: ['openDirectory', 'createDirectory']
  })
  if (selection.canceled || !selection.filePaths[0]) return null
  const rootPath = selection.filePaths[0]
  const projectFile = join(rootPath, 'project.json')
  if (existsSync(projectFile)) throw new ProjectStoreError('A project.json file already exists in that folder. Open it instead or choose a new folder.')
  for (const folder of projectFolders) await mkdir(join(rootPath, folder), { recursive: true })
  const project = createProject(name, rootPath)
  activeProjectFile = projectFile
  activeProject = project
  await persistProject(project)
  await writeLog('info', 'project_created', { projectId: project.id, rootPath })
  return hydrateProject(project)
}

async function activateProjectFile(projectFile: string): Promise<ProjectData> {
  const parsed = JSON.parse(await readFile(projectFile, 'utf8')) as unknown
  const project = validateLoadedProject(parsed, projectFile)
  activeProjectFile = projectFile
  for (const folder of projectFolders) await mkdir(join(dirname(projectFile), folder), { recursive: true })
  activeProject = hydrateProject(project)
  await writeLog('info', 'project_opened', { projectId: project.id, rootPath: dirname(projectFile) })
  return activeProject
}

export async function openExistingProject(event: IpcMainInvokeEvent): Promise<ProjectData | null> {
  const parent = BrowserWindow.fromWebContents(event.sender)
  const selection = await dialog.showOpenDialog(parent!, {
    title: 'Open AI Video Editor project',
    buttonLabel: 'Open project',
    properties: ['openFile'],
    filters: [{ name: 'AI Video Editor project', extensions: ['json'] }]
  })
  if (selection.canceled || !selection.filePaths[0]) return null
  return activateProjectFile(selection.filePaths[0])
}

export async function openProjectAtPath(rootPath: string): Promise<ProjectData> {
  if (typeof rootPath !== 'string' || !rootPath.trim() || rootPath.includes('\0') || rootPath.length > 32_768 || !isAbsolute(rootPath)) {
    throw new ProjectStoreError('The recent project location is invalid.')
  }
  const projectFile = join(resolve(rootPath), 'project.json')
  if (!existsSync(projectFile)) throw new ProjectStoreError('The recent project file could not be found.')
  return activateProjectFile(projectFile)
}

export async function saveActiveProject(input: ProjectData): Promise<{ ok: true }> {
  const project = normalizeIncomingProject(input)
  const projectFile = activeProjectFile
  await persistProject(project, () => {
    if (activeProjectFile === projectFile && activeProject?.id === project.id) activeProject = hydrateProject(project)
  })
  await writeLog('info', 'project_saved', { projectId: project.id })
  return { ok: true }
}

type ImportMediaKind = 'video' | 'audio'

async function importProjectMedia(event: IpcMainInvokeEvent, kind: ImportMediaKind): Promise<{ assets: MediaAsset[]; warnings: string[] } | null> {
  if (!activeProject || !activeProjectFile) throw new ProjectStoreError('Create or open a project first.')
  const parent = BrowserWindow.fromWebContents(event.sender)
  const videoExtensions = ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'mpeg', 'mpg']
  const audioExtensions = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wma', 'aiff', 'aif']
  const selection = await dialog.showOpenDialog(parent!, {
    title: kind === 'video' ? 'Import video files' : 'Import audio files',
    buttonLabel: kind === 'video' ? 'Import videos' : 'Import audio',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: kind === 'video' ? 'Video files' : 'Audio files', extensions: kind === 'video' ? videoExtensions : audioExtensions }]
  })
  if (selection.canceled) return null
  const assets: MediaAsset[] = []
  const warnings: string[] = []
  for (const filePath of selection.filePaths) {
    try {
      const probe = await probeMedia(filePath)
      const hasVideo = probe.width > 0 && probe.height > 0
      if (kind === 'video' && !hasVideo) throw new Error('This file does not contain a video stream.')
      if (kind === 'audio' && !probe.hasAudio) throw new Error('This file does not contain an audio stream.')
      const id = freshProjectId()
      const projectRoot = dirname(activeProjectFile)
      const thumbnailPath = hasVideo ? join(projectRoot, 'thumbnails', `${id}.jpg`) : undefined
      const waveformPath = probe.hasAudio ? join(projectRoot, 'waveforms', `${id}.png`) : undefined
      if (thumbnailPath) {
        try { await createThumbnail(filePath, thumbnailPath, Math.min(1.2, probe.duration / 3)) }
        catch (error) {
          warnings.push(`${basename(filePath)} imported without a thumbnail: ${String(error)}`)
          await writeLog('warn', 'thumbnail_failed', { fileName: basename(filePath), error: String(error) })
        }
      }
      if (waveformPath) {
        try { await createWaveform(filePath, waveformPath) }
        catch (error) {
          warnings.push(`${basename(filePath)} imported without an audio waveform: ${String(error)}`)
          await writeLog('warn', 'waveform_failed', { fileName: basename(filePath), error: String(error) })
        }
      }
      const storedThumbnailPath = thumbnailPath && existsSync(thumbnailPath) ? thumbnailPath : undefined
      const storedWaveformPath = waveformPath && existsSync(waveformPath) ? waveformPath : undefined
      assets.push({
        ...probe,
        id,
        importedAt: new Date().toISOString(),
        thumbnailPath: storedThumbnailPath,
        thumbnailUrl: storedThumbnailPath ? `aivideo://thumbnail/${encodeURIComponent(id)}` : undefined,
        waveformPath: storedWaveformPath,
        waveformUrl: storedWaveformPath ? `aivideo://waveform/${encodeURIComponent(id)}` : undefined,
        previewUrl: existsSync(filePath) ? `aivideo://media/${encodeURIComponent(id)}` : undefined
      })
    } catch (error) {
      warnings.push(`${basename(filePath)} could not be imported: ${String(error)}`)
      await writeLog('error', 'media_import_failed', { fileName: basename(filePath), kind, error: String(error) })
    }
  }
  if (assets.length) {
    activeProject = { ...activeProject, media: [...activeProject.media, ...assets] }
    await writeLog('info', 'media_imported', { projectId: activeProject.id, count: assets.length, kind })
  }
  return { assets, warnings }
}

export function importVideos(event: IpcMainInvokeEvent): Promise<{ assets: MediaAsset[]; warnings: string[] } | null> {
  return importProjectMedia(event, 'video')
}

export function importAudio(event: IpcMainInvokeEvent): Promise<{ assets: MediaAsset[]; warnings: string[] } | null> {
  return importProjectMedia(event, 'audio')
}

export async function importSubtitleFile(event: IpcMainInvokeEvent): Promise<{ fileName: string; segments: ImportedSubtitle[]; skipped: number } | null> {
  const parent = BrowserWindow.fromWebContents(event.sender)
  const selection = await dialog.showOpenDialog(parent!, {
    title: 'Import subtitles',
    buttonLabel: 'Import',
    properties: ['openFile'],
    filters: [{ name: 'Subtitle files', extensions: ['srt', 'vtt'] }]
  })
  if (selection.canceled || !selection.filePaths[0]) return null
  const filePath = selection.filePaths[0]
  const fileName = basename(filePath)
  const content = await readFile(filePath, 'utf8')
  const { segments, skipped } = new PlussubSubtitleParser().parseFileContent(content, fileName)
  await writeLog('info', 'subtitles_imported', { fileName, imported: segments.length, skipped })
  return { fileName, segments, skipped }
}

export async function relinkMissingMedia(event: IpcMainInvokeEvent, mediaId: string): Promise<MediaAsset | null> {
  if (!activeProject || !activeProjectFile) throw new ProjectStoreError('Open a project before relinking media.')
  const existing = activeProject.media.find((asset) => asset.id === mediaId)
  if (!existing) throw new ProjectStoreError('Media reference was not found in this project.')
  const expectsVideo = existing.width > 0 && existing.height > 0
  const extensions = expectsVideo
    ? ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'mpeg', 'mpg']
    : ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wma', 'aiff', 'aif']
  const parent = BrowserWindow.fromWebContents(event.sender)
  const selection = await dialog.showOpenDialog(parent!, {
    title: `Relink ${existing.name}`,
    buttonLabel: 'Relink source',
    properties: ['openFile'],
    filters: [{ name: expectsVideo ? 'Video files' : 'Audio files', extensions }]
  })
  if (selection.canceled || !selection.filePaths[0]) return null
  const filePath = selection.filePaths[0]
  const probe = await probeMedia(filePath)
  if (expectsVideo && (probe.width <= 0 || probe.height <= 0)) throw new ProjectStoreError('Choose a source file with a video stream.')
  if (!expectsVideo && !probe.hasAudio) throw new ProjectStoreError('Choose a source file with an audio stream.')
  const projectRoot = dirname(activeProjectFile)
  const thumbnailPath = probe.width > 0 && probe.height > 0 ? join(projectRoot, 'thumbnails', `${mediaId}.jpg`) : undefined
  const waveformPath = probe.hasAudio ? join(projectRoot, 'waveforms', `${mediaId}.png`) : undefined
  if (thumbnailPath) await createThumbnail(filePath, thumbnailPath, Math.min(1.2, probe.duration / 3)).catch(() => undefined)
  if (waveformPath) await createWaveform(filePath, waveformPath).catch(() => undefined)
  const replacement: MediaAsset = {
    ...probe,
    id: existing.id,
    importedAt: existing.importedAt,
    previewUrl: `aivideo://media/${encodeURIComponent(mediaId)}`,
    thumbnailPath: thumbnailPath && existsSync(thumbnailPath) ? thumbnailPath : undefined,
    thumbnailUrl: thumbnailPath && existsSync(thumbnailPath) ? `aivideo://thumbnail/${encodeURIComponent(mediaId)}` : undefined,
    waveformPath: waveformPath && existsSync(waveformPath) ? waveformPath : undefined,
    waveformUrl: waveformPath && existsSync(waveformPath) ? `aivideo://waveform/${encodeURIComponent(mediaId)}` : undefined,
    missing: false
  }
  activeProject = {
    ...activeProject,
    media: activeProject.media.map((asset) => asset.id === mediaId ? replacement : asset),
    analysisByMedia: { ...activeProject.analysisByMedia }
  }
  delete activeProject.analysisByMedia[mediaId]
  await writeLog('info', 'media_relinked', { projectId: activeProject.id, mediaId, filePath })
  return replacement
}
