export type UiLanguage = 'ar' | 'en' | 'fr'
export type AspectRatio = '16:9' | '9:16' | '1:1'
export type ResolutionPreset = '720p' | '1080p' | '4k'
export type ExportFormat = 'mp4' | 'mov' | 'webm'
export type VideoCodec = 'h264' | 'h265' | 'vp9'
export type TrackKind = 'video' | 'audio' | 'subtitles' | 'text' | 'music'

export interface MediaAsset {
  id: string
  name: string
  filePath: string
  previewUrl?: string
  thumbnailPath?: string
  thumbnailUrl?: string
  waveformPath?: string
  waveformUrl?: string
  duration: number
  width: number
  height: number
  fps: number
  sizeBytes: number
  hasAudio: boolean
  videoCodec: string
  audioCodec?: string
  importedAt: string
  missing?: boolean
}

export interface TimelineTrack {
  id: string
  name: string
  kind: TrackKind
  muted: boolean
  locked: boolean
}

export interface TimelineClip {
  id: string
  mediaId: string
  trackId: string
  position: number
  sourceIn: number
  sourceOut: number
  gainDb: number
  label?: string
}

export interface Scene {
  start: number
  end: number
  confidence?: number
}

export interface SilenceSegment {
  start: number
  end: number
  duration: number
}

export interface TranscriptWord {
  text: string
  start: number
  end: number
  confidence?: number
}

export interface TranscriptSegment {
  id: string
  start: number
  end: number
  text: string
  words?: TranscriptWord[]
  speaker?: string
}

export interface AudioMetrics {
  meanVolumeDb?: number
  maxVolumeDb?: number
  clippingDetected: boolean
  silenceCount: number
  analyzed: boolean
}

export interface VideoQuality {
  width: number
  height: number
  fps: number
  videoCodec: string
  bitrate?: number
  score?: number
  notes: string[]
}

export interface VisualMoment {
  timestampSeconds: number
  second: number
  shotIndex: number
  description: string
  visibleText?: string
}

export interface VisualShot {
  index: number
  start: number
  end: number
  description: string
}

export interface VisualIndex {
  provider: 'gemini'
  analyzedAt: string
  sampleIntervalSeconds: 1
  durationSeconds: number
  frameCount: number
  summary: string
  shots: VisualShot[]
  moments: VisualMoment[]
}

export interface SceneVisualProfile {
  /** 1-based detected-scene index this keyframe analysis belongs to. */
  sceneIndex: number
  start: number
  end: number
  keyframeTimestamp: number
  visualSummary: string
  subjects: string[]
  activity: string
  hasPerson: boolean
  hasOnScreenText: boolean
  textOnScreen?: string
  visualImportance: number
  provider: 'gemini'
  analyzedAt: string
}

export interface AnalysisResult {
  mediaId: string
  analyzedAt: string
  scenes: Scene[]
  silences: SilenceSegment[]
  transcript: TranscriptSegment[]
  audio: AudioMetrics
  quality: VideoQuality
  warnings: string[]
  visualIndex?: VisualIndex
  sceneVisuals?: SceneVisualProfile[]
}

export interface ExportSettings {
  format: ExportFormat
  codec: VideoCodec
  resolution: ResolutionPreset
  aspectRatio: AspectRatio
  fps: number
  quality: 'high' | 'balanced' | 'small'
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: string
  operationId?: string
}

export interface EditOperation {
  id: string
  kind: string
  title: string
  summary: string
  createdAt: string
  undone?: boolean
}

export interface EditSnapshot {
  timeline: {
    tracks: TimelineTrack[]
    clips: TimelineClip[]
  }
  subtitles: TranscriptSegment[]
  exportSettings: ExportSettings
}

export interface EditHistory {
  undo: EditSnapshot[]
  redo: EditSnapshot[]
}

export interface ProjectData {
  schemaVersion: number
  id: string
  name: string
  rootPath: string
  createdAt: string
  updatedAt: string
  media: MediaAsset[]
  analysisByMedia: Record<string, AnalysisResult>
  timeline: {
    tracks: TimelineTrack[]
    clips: TimelineClip[]
  }
  subtitles: TranscriptSegment[]
  exportSettings: ExportSettings
  chatMessages: ChatMessage[]
  operations: EditOperation[]
  history: EditHistory
}

export interface AppSettings {
  language: UiLanguage
  ollamaEnabled: boolean
  ollamaModel: string
  whisperBinaryPath: string
  whisperModelPath: string
}

export interface GeminiApiKeyStatus {
  configured: boolean
  secureStorageAvailable: boolean
}

export type GeminiConnectionErrorCode = 'missing-key' | 'storage-unavailable' | 'invalid-key' | 'rate-limited' | 'service-unavailable' | 'request-rejected' | 'network' | 'blocked' | 'unknown'

export interface GeminiConnectionResult {
  ok: boolean
  errorCode?: GeminiConnectionErrorCode
}

export type JobKind = 'analysis' | 'transcription' | 'export' | 'thumbnail'
export type JobStatus = 'running' | 'completed' | 'error' | 'cancelled'

export interface JobProgress {
  jobId: string
  kind: JobKind
  progress: number
  message: string
  status: JobStatus
  error?: string
}

export interface AnalysisResponse {
  analysisByMedia: Record<string, AnalysisResult>
  warnings: string[]
}

export interface MediaBinaryStatus {
  available: boolean
  path: string | null
  source: 'bundled' | 'environment' | 'missing'
  version?: string
  error?: string
}

export interface MediaRuntimeStatus {
  checkedAt: string
  packaged: boolean
  ready: boolean
  ffmpeg: MediaBinaryStatus
  ffprobe: MediaBinaryStatus
}

export interface ConversationStep {
  id: string
  /** Localized, user-friendly label (never raw tool names). */
  label: string
  state: 'done' | 'active' | 'pending' | 'failed'
}

export interface ConversationSnapshot {
  status: string
  hasPendingAction: boolean
  waitingForInput: boolean
  pendingQuestion?: string
  focusLabel?: string
}

export interface ChatResponse {
  reply: string
  project: ProjectData
  proposal?: {
    id: string
    title: string
    summary: string
    description: string
    action?:
      | { type: 'remove-silence'; minimumDuration: number }
      | { type: 'delete-range'; start: number; end: number }
      | { type: 'create-short'; start: number; end: number; aspectRatio: AspectRatio; baseUpdatedAt: string }
      | { type: 'open-export' }
  }
  /** User-visible pipeline (understand → analyze → confirm → execute → update). */
  steps?: ConversationStep[]
  /** Lightweight conversation-state snapshot for the chat UI. */
  conversation?: ConversationSnapshot
}

export interface ImportResponse {
  assets: MediaAsset[]
  warnings: string[]
}

export interface ExportRequest {
  project: ProjectData
  settings: ExportSettings
}

export interface ExportResponse {
  outputPath: string
  duration: number
  estimatedSizeBytes?: number
}

export interface DesktopBridge {
  createProject(name: string): Promise<ProjectData | null>
  openProject(): Promise<ProjectData | null>
  openRecentProject(rootPath: string): Promise<ProjectData>
  saveProject(project: ProjectData): Promise<{ ok: true }>
  importMedia(): Promise<ImportResponse | null>
  importAudio(): Promise<ImportResponse | null>
  importSubtitles(): Promise<{ fileName: string; segments: Array<{ start: number; end: number; text: string }>; skipped: number } | null>
  relinkMedia(mediaId: string): Promise<MediaAsset | null>
  analyze(project: ProjectData, mediaIds: string[], jobId: string): Promise<AnalysisResponse>
  analyzeVisuals(project: ProjectData, mediaId: string, jobId: string, consent: boolean): Promise<ProjectData>
  transcribe(project: ProjectData, mediaId: string, jobId: string): Promise<TranscriptSegment[]>
  chat(project: ProjectData, text: string, jobId: string): Promise<ChatResponse>
  exportVideo(request: ExportRequest, jobId: string): Promise<ExportResponse | null>
  cancelJob(jobId: string): Promise<void>
  getSettings(): Promise<AppSettings>
  saveSettings(settings: AppSettings): Promise<AppSettings>
  getGeminiApiKeyStatus(): Promise<GeminiApiKeyStatus>
  saveGeminiApiKey(key: string): Promise<GeminiApiKeyStatus>
  clearGeminiApiKey(): Promise<GeminiApiKeyStatus>
  testGeminiConnection(key?: string): Promise<GeminiConnectionResult>
  getMediaRuntimeStatus(): Promise<MediaRuntimeStatus>
  checkMediaRuntime(): Promise<MediaRuntimeStatus>
  pickWhisperBinary(): Promise<string | null>
  pickWhisperModel(): Promise<string | null>
  openLogs(): Promise<void>
  onJobProgress(callback: (progress: JobProgress) => void): () => void
}

declare global {
  interface Window {
    desktop: DesktopBridge
  }
}
