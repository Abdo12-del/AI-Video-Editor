import { BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { basename, join } from 'node:path'
import { cancelMediaJob, consumeCancelledJob, analyzeMedia, checkMediaRuntime, renderExport, transcribeMedia } from './mediaEngine'
import { getLogPath, writeLog } from './logger'
import {
  createNewProject,
  getActiveProject,
  getActiveProjectFile,
  importAudio,
  importVideos,
  normalizeIncomingProject,
  openExistingProject,
  openProjectAtPath,
  relinkMissingMedia,
  saveActiveProject
} from './projectStore'
import { loadSettings, saveSettings } from './settingsStore'
import { sendAgentMessage } from './agentService'
import { clearGeminiApiKey, getGeminiApiKey, getGeminiApiKeyStatus, saveGeminiApiKey } from './geminiKeyStore'
import { GeminiProviderError, testGeminiApiKey } from './geminiProvider'
import type { AnalysisResponse, AppSettings, ExportRequest, ExportSettings, GeminiConnectionErrorCode, JobKind, JobProgress, MediaRuntimeStatus, ProjectData } from '../shared/types'

function sendProgress(
  event: IpcMainInvokeEvent,
  jobId: string,
  kind: JobKind,
  progress: number,
  message: string,
  status: JobProgress['status'] = 'running',
  error?: string
): void {
  const payload: JobProgress = { jobId, kind, progress: Math.max(0, Math.min(100, progress)), message, status, error }
  event.sender.send('job:progress', payload)
}

function safeExportSettings(settings: ExportSettings): ExportSettings {
  const format = ['mp4', 'mov', 'webm'].includes(settings.format) ? settings.format : 'mp4'
  const codec = ['h264', 'h265', 'vp9'].includes(settings.codec) ? settings.codec : 'h264'
  const resolution = ['720p', '1080p', '4k'].includes(settings.resolution) ? settings.resolution : '1080p'
  const aspectRatio = ['16:9', '9:16', '1:1'].includes(settings.aspectRatio) ? settings.aspectRatio : '16:9'
  const quality = ['high', 'balanced', 'small'].includes(settings.quality) ? settings.quality : 'balanced'
  const fps = Math.max(1, Math.min(120, Math.round(Number(settings.fps) || 30)))
  if (format === 'webm' && codec !== 'vp9') throw new Error('WebM export uses VP9 in this MVP. Choose VP9 or use MP4/MOV.')
  if (format !== 'webm' && codec === 'vp9') throw new Error('VP9 is exported as WebM in this MVP. Choose H.264/H.265 or switch to WebM.')
  return { format, codec, resolution, aspectRatio, quality, fps }
}

function reportJobFailure(event: IpcMainInvokeEvent, jobId: string, kind: JobKind, error: unknown): string {
  const message = String(error)
  const cancelled = consumeCancelledJob(jobId)
  sendProgress(event, jobId, kind, 0, cancelled ? 'Cancelled' : 'Operation failed', cancelled ? 'cancelled' : 'error', cancelled ? undefined : message)
  return message
}

function exportName(project: ProjectData, format: string): string {
  const cleanName = project.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80) || 'video'
  return `${cleanName}_export.${format}`
}

function assertProjectOpen(): ProjectData {
  const project = getActiveProject()
  if (!project || !getActiveProjectFile()) throw new Error('Create or open a project first.')
  return project
}

export function registerIpcHandlers(initialMediaRuntime: MediaRuntimeStatus): void {
  let mediaRuntime = initialMediaRuntime
  ipcMain.handle('media:runtime:get', async () => mediaRuntime)
  ipcMain.handle('media:runtime:check', async () => {
    mediaRuntime = await checkMediaRuntime()
    await writeLog(mediaRuntime.ready ? 'info' : 'error', 'media_runtime_check', { mediaRuntime })
    return mediaRuntime
  })

  ipcMain.handle('project:create', async (event, name: string) => createNewProject(event, String(name ?? '').slice(0, 160)))
  ipcMain.handle('project:open', async (event) => openExistingProject(event))
  ipcMain.handle('project:open-recent', async (_event, rootPath: string) => openProjectAtPath(rootPath))
  ipcMain.handle('project:save', async (_event, project: ProjectData) => saveActiveProject(project))
  ipcMain.handle('media:import', async (event) => importVideos(event))
  ipcMain.handle('media:import-audio', async (event) => importAudio(event))
  ipcMain.handle('media:relink', async (event, mediaId: string) => relinkMissingMedia(event, String(mediaId)))

  ipcMain.handle('project:analyze', async (event, input: ProjectData, mediaIds: string[], jobId: string): Promise<AnalysisResponse> => {
    const active = assertProjectOpen()
    const project = normalizeIncomingProject(input)
    if (project.id !== active.id) throw new Error('The requested project is not active.')
    const settings = await loadSettings()
    const uniqueIds = [...new Set(Array.isArray(mediaIds) && mediaIds.length ? mediaIds : project.media.map((asset) => asset.id))]
    const assets = uniqueIds.map((id) => project.media.find((asset) => asset.id === id)).filter((asset) => asset !== undefined)
    if (!assets.length) throw new Error('Import a video before starting analysis.')
    const analysisByMedia = { ...project.analysisByMedia }
    const warnings: string[] = []
    try {
      for (let index = 0; index < assets.length; index += 1) {
        const asset = assets[index]
        const result = await analyzeMedia(asset, project.rootPath, settings, jobId, (local, message, kind) => {
          const progress = (index / assets.length) * 100 + (local / assets.length)
          sendProgress(event, jobId, kind ?? 'analysis', progress, `${asset.name}: ${message}`)
        })
        analysisByMedia[asset.id] = result
        warnings.push(...result.warnings.map((warning) => `${asset.name}: ${warning}`))
      }
      const latest = assertProjectOpen()
      if (latest.id !== project.id) throw new Error('Project changed while analysis was running.')
      const updated = { ...latest, analysisByMedia: { ...latest.analysisByMedia, ...analysisByMedia }, updatedAt: new Date().toISOString() }
      await saveActiveProject(updated)
      sendProgress(event, jobId, 'analysis', 100, 'Analysis complete', 'completed')
      return { analysisByMedia, warnings }
    } catch (error) {
      const message = reportJobFailure(event, jobId, 'analysis', error)
      if (!message.includes('cancel')) await writeLog('error', 'analysis_job_failed', { projectId: project.id, jobId, error: message })
      throw error
    }
  })

  ipcMain.handle('media:transcribe', async (event, input: ProjectData, mediaId: string, jobId: string) => {
    const project = normalizeIncomingProject(input)
    const asset = project.media.find((item) => item.id === mediaId)
    if (!asset) throw new Error('Media source not found.')
    const settings = await loadSettings()
    try {
      const transcript = await transcribeMedia(asset, project.rootPath, settings, jobId, (progress, message, kind) => sendProgress(event, jobId, kind ?? 'transcription', progress, message))
      const old = project.analysisByMedia[mediaId]
      const analysis = old ?? {
        mediaId,
        analyzedAt: new Date().toISOString(),
        scenes: [],
        silences: [],
        transcript: [],
        audio: { clippingDetected: false, silenceCount: 0, analyzed: false },
        quality: { width: asset.width, height: asset.height, fps: asset.fps, videoCodec: asset.videoCodec, notes: [] },
        warnings: []
      }
      const next = { ...project, analysisByMedia: { ...project.analysisByMedia, [mediaId]: { ...analysis, transcript, analyzedAt: new Date().toISOString() } } }
      await saveActiveProject(next)
      sendProgress(event, jobId, 'transcription', 100, `Created ${transcript.length} transcript segments`, 'completed')
      return transcript
    } catch (error) {
      reportJobFailure(event, jobId, 'transcription', error)
      throw error
    }
  })

  ipcMain.handle('agent:chat', async (event, input: ProjectData, text: string, jobId: string) => {
    const project = normalizeIncomingProject(input)
    const settings = await loadSettings()
    try {
      const geminiApiKey = await getGeminiApiKey()
      const result = await sendAgentMessage(project, String(text).slice(0, 5000), settings, jobId, (progress, message, kind) => {
        sendProgress(event, jobId, kind ?? 'analysis', progress, message)
      }, geminiApiKey)
      await saveActiveProject(result.project)
      sendProgress(event, jobId, 'analysis', 100, 'Assistant finished', 'completed')
      const active = assertProjectOpen()
      return { ...result, project: active }
    } catch (error) {
      const message = reportJobFailure(event, jobId, 'analysis', error)
      if (!message.toLowerCase().includes('cancel')) await writeLog('error', 'agent_request_failed', { projectId: project.id, error: message })
      throw error
    }
  })

  ipcMain.handle('export:render', async (event, request: ExportRequest, jobId: string) => {
    const active = assertProjectOpen()
    const project = normalizeIncomingProject(request.project)
    if (project.id !== active.id) throw new Error('The requested project is not active.')
    const settings = safeExportSettings(request.settings)
    const root = project.rootPath
    const parent = BrowserWindow.fromWebContents(event.sender)
    const selection = await dialog.showSaveDialog(parent!, {
      title: 'Export edited video',
      defaultPath: join(root, 'exports', exportName(project, settings.format)),
      buttonLabel: 'Export video',
      filters: [{ name: `${settings.format.toUpperCase()} video`, extensions: [settings.format] }]
    })
    if (selection.canceled || !selection.filePath) {
      consumeCancelledJob(jobId)
      sendProgress(event, jobId, 'export', 0, 'Export cancelled', 'cancelled')
      return null
    }
    const updatedProject = { ...project, exportSettings: settings, updatedAt: new Date().toISOString() }
    await saveActiveProject(updatedProject)
    try {
      return await renderExport({ project: updatedProject, settings }, selection.filePath, jobId, (progress, message, kind) => {
        sendProgress(event, jobId, kind ?? 'export', progress, message)
      })
    } catch (error) {
      reportJobFailure(event, jobId, 'export', error)
      throw error
    }
  })

  ipcMain.handle('job:cancel', async (_event, jobId: string) => {
    cancelMediaJob(String(jobId))
  })
  ipcMain.handle('settings:get', async () => loadSettings())
  ipcMain.handle('settings:save', async (_event, settings: AppSettings) => saveSettings(settings))
  ipcMain.handle('gemini:key:status', async () => getGeminiApiKeyStatus())
  ipcMain.handle('gemini:key:save', async (_event, key: string) => saveGeminiApiKey(String(key ?? '')))
  ipcMain.handle('gemini:key:clear', async () => clearGeminiApiKey())
  ipcMain.handle('gemini:connection:test', async (_event, providedKey?: unknown) => {
    let key = typeof providedKey === 'string' ? providedKey.trim() : ''
    if (!key) {
      const status = await getGeminiApiKeyStatus()
      if (!status.secureStorageAvailable) return { ok: false, errorCode: 'storage-unavailable' as const }
      try { key = await getGeminiApiKey() ?? '' } catch { return { ok: false, errorCode: 'storage-unavailable' as const } }
    }
    if (!key) return { ok: false, errorCode: 'missing-key' as const }
    try {
      await testGeminiApiKey(key)
      return { ok: true as const }
    } catch (error) {
      return { ok: false, errorCode: error instanceof GeminiProviderError ? error.code : 'unknown' as GeminiConnectionErrorCode }
    }
  })
  ipcMain.handle('settings:pick-whisper-binary', async (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender)
    const selection = await dialog.showOpenDialog(parent!, {
      title: 'Select whisper.cpp executable',
      properties: ['openFile'],
      filters: [{ name: 'Application', extensions: ['exe'] }, { name: 'All files', extensions: ['*'] }]
    })
    return selection.canceled ? null : selection.filePaths[0]
  })
  ipcMain.handle('settings:pick-whisper-model', async (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender)
    const selection = await dialog.showOpenDialog(parent!, {
      title: 'Select a local Whisper GGML model',
      properties: ['openFile'],
      filters: [{ name: 'GGML model', extensions: ['bin', 'ggml'] }, { name: 'All files', extensions: ['*'] }]
    })
    return selection.canceled ? null : selection.filePaths[0]
  })
  ipcMain.handle('logs:open', async () => {
    const logPath = getLogPath()
    await writeLog('info', 'logs_opened', { logPath: basename(logPath) })
    await shell.openPath(logPath)
  })
}
