import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppSettings,
  DesktopBridge,
  ExportRequest,
  JobProgress,
  ProjectData
} from '../shared/types'

const desktop: DesktopBridge = {
  createProject: (name) => ipcRenderer.invoke('project:create', name),
  openProject: () => ipcRenderer.invoke('project:open'),
  openRecentProject: (rootPath) => ipcRenderer.invoke('project:open-recent', rootPath),
  saveProject: (project: ProjectData) => ipcRenderer.invoke('project:save', project),
  importMedia: () => ipcRenderer.invoke('media:import'),
  importAudio: () => ipcRenderer.invoke('media:import-audio'),
  importSubtitles: () => ipcRenderer.invoke('subtitles:import'),
  relinkMedia: (mediaId) => ipcRenderer.invoke('media:relink', mediaId),
  analyze: (project, mediaIds, jobId) => ipcRenderer.invoke('project:analyze', project, mediaIds, jobId),
  analyzeVisuals: (project, mediaId, jobId, consent) => ipcRenderer.invoke('media:analyze-visuals', project, mediaId, jobId, consent),
  transcribe: (project, mediaId, jobId) => ipcRenderer.invoke('media:transcribe', project, mediaId, jobId),
  chat: (project, text, jobId) => ipcRenderer.invoke('agent:chat', project, text, jobId),
  exportVideo: (request: ExportRequest, jobId) => ipcRenderer.invoke('export:render', request, jobId),
  cancelJob: (jobId) => ipcRenderer.invoke('job:cancel', jobId),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings: AppSettings) => ipcRenderer.invoke('settings:save', settings),
  getGeminiApiKeyStatus: () => ipcRenderer.invoke('gemini:key:status'),
  saveGeminiApiKey: (key: string) => ipcRenderer.invoke('gemini:key:save', key),
  clearGeminiApiKey: () => ipcRenderer.invoke('gemini:key:clear'),
  testGeminiConnection: (key?: string) => ipcRenderer.invoke('gemini:connection:test', key),
  getMediaRuntimeStatus: () => ipcRenderer.invoke('media:runtime:get'),
  checkMediaRuntime: () => ipcRenderer.invoke('media:runtime:check'),
  pickWhisperBinary: () => ipcRenderer.invoke('settings:pick-whisper-binary'),
  pickWhisperModel: () => ipcRenderer.invoke('settings:pick-whisper-model'),
  openLogs: () => ipcRenderer.invoke('logs:open'),
  onJobProgress: (callback: (progress: JobProgress) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: JobProgress) => callback(progress)
    ipcRenderer.on('job:progress', listener)
    return () => ipcRenderer.removeListener('job:progress', listener)
  }
}

contextBridge.exposeInMainWorld('desktop', desktop)
