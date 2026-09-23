import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import {
  Activity, AudioLines, Bot, Captions, Check, ChevronDown, CircleAlert, Clapperboard, Clock3,
  Download, FileText, Film, FolderOpen, Gauge, HardDrive, History, Languages, LoaderCircle, Maximize,
  ChevronRight, CircleHelp, FileAudio, FileVideo, Keyboard, Layers, LayoutGrid, List, Pause, PanelLeftClose, PanelRightClose,
  Play, Plus, Redo2, Search, Send, Settings2, Scissors, Music2, VolumeX, Sparkles, Subtitles, TextCursorInput, Trash2, Undo2,
  Upload, Volume2, WandSparkles, Waves, X, ZoomIn, ZoomOut
} from 'lucide-react'
import type {
  AnalysisResult, AppSettings, AspectRatio, ChatMessage, ExportSettings, GeminiApiKeyStatus, GeminiConnectionErrorCode,
  JobProgress, MediaAsset, MediaRuntimeStatus, ProjectData, ResolutionPreset, TimelineClip, TranscriptSegment, UiLanguage, VideoCodec
} from '../shared/types'
import {
  addAudioToTimeline, addMediaToTimeline, addSubtitle, AUDIO_TRACK_ID, clipDuration, commitExportSettings, createShortFromRange, deleteSubtitle, deleteTimelineRange,
  generateTimelineSubtitles, getClipAtTime, getMusicClips, getVideoClips, MUSIC_TRACK_ID, projectDuration, redoEdit, reorderClip,
  moveAudioClip, removeAudioClip, setAudioClipGain, setClipGain, setTrackMuted, splitClip, trimAudioClip, trimClip, undoEdit, updateSubtitle, makeId
} from '../shared/project'
import { translate } from './i18n'

const initialSettings: AppSettings = {
  language: 'ar', ollamaEnabled: false, ollamaModel: 'qwen2.5:7b', whisperBinaryPath: '', whisperModelPath: ''
}

type RightTab = 'assistant' | 'transcript' | 'subtitles' | 'history'
type Workspace = 'library' | 'project' | 'video' | 'audio' | 'text' | 'effects' | 'transitions'
type MediaFilter = 'all' | 'video' | 'audio'
type MediaView = 'grid' | 'list'
type MediaSort = 'name' | 'duration' | 'size'
type AppMenu = 'file' | 'edit' | 'view' | 'project' | 'tools' | 'help'
type RecentProject = { rootPath: string; name: string; lastOpenedAt: string }
type JobState = JobProgress & { startedAt: number }

const RECENT_PROJECTS_KEY = 'ai-video-editor.recent-projects.v1'

function readRecentProjects(): RecentProject[] {
  try {
    const raw = window.localStorage.getItem(RECENT_PROJECTS_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is RecentProject => Boolean(item && typeof item === 'object'
      && typeof item.rootPath === 'string' && item.rootPath.length > 0
      && typeof item.name === 'string' && typeof item.lastOpenedAt === 'string' && Number.isFinite(Date.parse(item.lastOpenedAt)))).slice(0, 8)
  } catch { return [] }
}

function writeRecentProject(project: ProjectData): RecentProject[] {
  const item: RecentProject = { rootPath: project.rootPath, name: project.name, lastOpenedAt: new Date().toISOString() }
  const recent = [item, ...readRecentProjects().filter((entry) => entry.rootPath !== item.rootPath)].slice(0, 8)
  try { window.localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(recent)) } catch { /* Recents are a convenience, not project data. */ }
  return recent
}
type ClipTrimDrag = {
  clipId: string
  edge: 'left' | 'right'
  pointerId: number
  startX: number
  initialSourceIn: number
  initialSourceOut: number
  sourceIn: number
  sourceOut: number
}

function formatTime(value: number, decimals = false): string {
  const safe = Math.max(0, Number.isFinite(value) ? value : 0)
  const minutes = Math.floor(safe / 60)
  const seconds = safe - minutes * 60
  const text = decimals ? seconds.toFixed(1).padStart(4, '0') : String(Math.floor(seconds)).padStart(2, '0')
  return `${String(minutes).padStart(2, '0')}:${text}`
}

function formatBytes(bytes: number): string {
  if (bytes < 1_000_000) return `${Math.max(0, bytes / 1000).toFixed(0)} KB`
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`
  return `${(bytes / 1_000_000_000).toFixed(2)} GB`
}

function rangeLabel(start: number, end: number): string {
  return `${formatTime(start, true)} → ${formatTime(end, true)}`
}

function makeMessage(role: ChatMessage['role'], content: string, operationId?: string): ChatMessage {
  return { id: makeId(), role, content, createdAt: new Date().toISOString(), operationId }
}

function geminiErrorTranslationKey(code?: GeminiConnectionErrorCode): string {
  switch (code) {
    case 'missing-key': return 'geminiErrorMissingKey'
    case 'storage-unavailable': return 'geminiErrorStorageUnavailable'
    case 'invalid-key': return 'geminiErrorInvalidKey'
    case 'rate-limited': return 'geminiErrorRateLimited'
    case 'service-unavailable': return 'geminiErrorServiceUnavailable'
    case 'request-rejected': return 'geminiErrorRequestRejected'
    case 'network': return 'geminiErrorNetwork'
    case 'blocked': return 'geminiErrorBlocked'
    default: return 'geminiErrorUnknown'
  }
}

export default function App() {
  const [settings, setSettings] = useState<AppSettings>(initialSettings)
  const [geminiKeyStatus, setGeminiKeyStatus] = useState<GeminiApiKeyStatus>({ configured: false, secureStorageAvailable: false })
  const [mediaRuntime, setMediaRuntime] = useState<MediaRuntimeStatus | null>(null)
  const [project, setProject] = useState<ProjectData | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [projectName, setProjectName] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [showShortcuts, setShowShortcuts] = useState(false)
  const [workspace, setWorkspace] = useState<Workspace>('library')
  const [rightTab, setRightTab] = useState<RightTab>('assistant')
  const [showMediaSidebar, setShowMediaSidebar] = useState(true)
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>(readRecentProjects)
  const [mediaSearch, setMediaSearch] = useState('')
  const [mediaFilter, setMediaFilter] = useState<MediaFilter>('all')
  const [mediaView, setMediaView] = useState<MediaView>('list')
  const [mediaSort, setMediaSort] = useState<MediaSort>('name')
  const [mediaImportMenu, setMediaImportMenu] = useState(false)
  const [openMenu, setOpenMenu] = useState<AppMenu | null>(null)
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null)
  const [selectedMusicClipId, setSelectedMusicClipId] = useState<string | null>(null)
  const [selectedSubtitleId, setSelectedSubtitleId] = useState<string | null>(null)
  const [draggedAudioClipId, setDraggedAudioClipId] = useState<string | null>(null)
  const [playhead, setPlayhead] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [seekToken, setSeekToken] = useState(0)
  const [volume, setVolume] = useState(0.8)
  const [zoom, setZoom] = useState(1)
  const [previewZoom, setPreviewZoom] = useState(1)
  const [chatDraft, setChatDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving' | 'unsaved'>('saved')
  const [activeJob, setActiveJob] = useState<JobState | null>(null)
  const uiLocked = busy || activeJob?.status === 'running'
  const [toast, setToast] = useState('')
  const [chatError, setChatError] = useState('')
  const [pendingPlan, setPendingPlan] = useState<NonNullable<Awaited<ReturnType<typeof window.desktop.chat>>['proposal']> | null>(null)
  const [showExport, setShowExport] = useState(false)
  const [transcriptSearch, setTranscriptSearch] = useState('')
  const [settingsSaved, setSettingsSaved] = useState(false)
  const [exportSettings, setExportSettings] = useState<ExportSettings | null>(null)
  const exportSettingsRef = useRef<ExportSettings | null>(null)
  const [draggedClipId, setDraggedClipId] = useState<string | null>(null)
  const [clipTrimDrag, setClipTrimDrag] = useState<ClipTrimDrag | null>(null)
  const clipTrimDragRef = useRef<ClipTrimDrag | null>(null)
  const [showInspector, setShowInspector] = useState(true)
  const videoRef = useRef<HTMLVideoElement>(null)
  const audioPreviewRefs = useRef<Map<string, HTMLAudioElement>>(new Map())
  const timelineScrollRef = useRef<HTMLDivElement>(null)
  const chatScrollRef = useRef<HTMLDivElement>(null)
  const jobIdRef = useRef<string | null>(null)
  const pendingSeekRef = useRef(0)
  const wasPlayingRef = useRef(false)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const t = useCallback((key: string) => translate(settings.language, key), [settings.language])
  const isArabic = settings.language === 'ar'
  const geminiReady = geminiKeyStatus.configured && geminiKeyStatus.secureStorageAvailable

  useEffect(() => {
    if (!window.desktop) return
    void window.desktop.getSettings().then(setSettings).catch((error) => setToast(String(error)))
    void window.desktop.getGeminiApiKeyStatus().then(setGeminiKeyStatus).catch(() => undefined)
    void window.desktop.getMediaRuntimeStatus().then(setMediaRuntime).catch((error) => setToast(String(error)))
  }, [])

  useEffect(() => {
    const html = document.documentElement
    html.lang = settings.language
    html.dir = isArabic ? 'rtl' : 'ltr'
  }, [settings.language, isArabic])

  useEffect(() => { setShowMediaSidebar(true) }, [workspace])

  useEffect(() => {
    if (!openMenu && !mediaImportMenu) return
    const dismiss = (event: PointerEvent) => {
      if (!(event.target instanceof Element)) return
      if (openMenu && !event.target.closest('.menu-anchor')) setOpenMenu(null)
      if (mediaImportMenu && !event.target.closest('.import-menu-anchor')) setMediaImportMenu(false)
    }
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') { setOpenMenu(null); setMediaImportMenu(false) } }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', escape) }
  }, [openMenu, mediaImportMenu])

  useEffect(() => {
    if (!window.desktop) return
    return window.desktop.onJobProgress((progress) => {
      if (progress.jobId !== jobIdRef.current) return
      setActiveJob({ ...progress, startedAt: Date.now() })
      if (progress.status === 'error') setToast(progress.error || progress.message)
      if (progress.status === 'completed' || progress.status === 'error' || progress.status === 'cancelled') {
        window.setTimeout(() => setActiveJob((current) => current?.jobId === progress.jobId ? null : current), 2800)
      }
    })
  }, [])

  useEffect(() => {
    if (!project || !window.desktop) return
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    setSaveStatus('saving')
    saveTimerRef.current = setTimeout(() => {
      void window.desktop.saveProject(project)
        .then(() => setSaveStatus('saved'))
        .catch((error) => { setSaveStatus('unsaved'); setToast(`Save failed: ${String(error)}`) })
    }, 450)
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current) }
  }, [project])

  useEffect(() => {
    chatScrollRef.current?.scrollTo({ top: chatScrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [project?.chatMessages.length, busy, pendingPlan])

  const videoClips = useMemo(() => project ? getVideoClips(project) : [], [project])
  const musicClips = useMemo(() => project ? getMusicClips(project) : [], [project])
  const duration = useMemo(() => project ? projectDuration(project) : 0, [project])
  const selectedMusicClip = useMemo(() => musicClips.find((clip) => clip.id === selectedMusicClipId), [musicClips, selectedMusicClipId])
  const selectedSubtitle = useMemo(() => project?.subtitles.find((subtitle) => subtitle.id === selectedSubtitleId), [project?.subtitles, selectedSubtitleId])
  const selectedClip = useMemo(() => selectedMusicClipId ? undefined : videoClips.find((clip) => clip.id === selectedClipId) ?? videoClips[0], [videoClips, selectedClipId, selectedMusicClipId])
  const activeClip = useMemo(() => project ? getClipAtTime(project, playhead) ?? (playhead >= duration && duration > 0 ? videoClips.at(-1) : videoClips[0]) : undefined, [project, playhead, duration, videoClips])
  const activeAsset = project?.media.find((asset) => asset.id === activeClip?.mediaId)
  const selectedAsset = project?.media.find((asset) => asset.id === selectedClip?.mediaId)
  const selectedMusicAsset = project?.media.find((asset) => asset.id === selectedMusicClip?.mediaId)
  const embeddedAudioMuted = project?.timeline.tracks.find((track) => track.id === AUDIO_TRACK_ID)?.muted ?? false
  const musicTrackMuted = project?.timeline.tracks.find((track) => track.id === MUSIC_TRACK_ID)?.muted ?? false
  const analysis = activeAsset && project ? project.analysisByMedia[activeAsset.id] : undefined
  const timelineExtent = Math.max(duration, ...musicClips.map((clip) => clip.position + clipDuration(clip)))
  const timelineWidth = Math.max(720, (timelineExtent + 8) * 34 * zoom)
  const pixelsPerSecond = 34 * zoom
  const markerInterval = pixelsPerSecond >= 60 ? 2 : pixelsPerSecond >= 30 ? 5 : 10
  const effectiveMediaFilter: MediaFilter = workspace === 'video' ? 'video' : workspace === 'audio' ? 'audio' : mediaFilter
  const mediaCounts = useMemo(() => ({
    all: project?.media.length ?? 0,
    video: project?.media.filter((asset) => asset.width > 0 && asset.height > 0).length ?? 0,
    audio: project?.media.filter((asset) => asset.width <= 0 && asset.hasAudio).length ?? 0
  }), [project?.media])
  const visibleMedia = useMemo(() => {
    if (!project) return []
    const query = mediaSearch.trim().toLocaleLowerCase(settings.language)
    return project.media
      .filter((asset) => effectiveMediaFilter === 'all'
        || (effectiveMediaFilter === 'video' ? asset.width > 0 && asset.height > 0 : asset.width <= 0 && asset.hasAudio))
      .filter((asset) => !query || `${asset.name} ${asset.filePath}`.toLocaleLowerCase(settings.language).includes(query))
      .slice()
      .sort((first, second) => mediaSort === 'name'
        ? first.name.localeCompare(second.name, settings.language, { sensitivity: 'base' })
        : mediaSort === 'duration' ? second.duration - first.duration : second.sizeBytes - first.sizeBytes)
  }, [project?.media, effectiveMediaFilter, mediaSearch, mediaSort, settings.language])

  const audioPreviewRefCallbacks = useMemo(() => {
    const callbacks = new Map<string, (element: HTMLAudioElement | null) => void>()
    for (const clip of musicClips) callbacks.set(clip.id, (element) => {
      if (element) audioPreviewRefs.current.set(clip.id, element)
      else { audioPreviewRefs.current.get(clip.id)?.pause(); audioPreviewRefs.current.delete(clip.id) }
    })
    return callbacks
  }, [musicClips])

  const showToast = useCallback((message: string) => {
    setToast(message)
    window.setTimeout(() => setToast((current) => current === message ? '' : current), 5500)
  }, [])

  useEffect(() => {
    for (const clip of musicClips) {
      const audio = audioPreviewRefs.current.get(clip.id)
      if (!audio) continue
      const active = playing && !musicTrackMuted && playhead >= clip.position && playhead < clip.position + clipDuration(clip)
      if (!active) {
        if (!audio.paused) audio.pause()
        continue
      }
      const targetTime = clip.sourceIn + playhead - clip.position
      try { if (audio.readyState >= 1 && Math.abs(audio.currentTime - targetTime) > 0.35) audio.currentTime = targetTime } catch { /* Wait until the source metadata is ready. */ }
      audio.volume = Math.max(0, Math.min(1, volume * 10 ** (clip.gainDb / 20)))
      if (audio.paused) void audio.play().catch(() => undefined)
    }
  }, [musicClips, musicTrackMuted, playhead, playing, volume])

  useEffect(() => () => {
    for (const audio of audioPreviewRefs.current.values()) audio.pause()
    audioPreviewRefs.current.clear()
  }, [])

  const refreshMediaRuntime = async () => {
    try { setMediaRuntime(await window.desktop.checkMediaRuntime()) }
    catch (error) { showToast(String(error)) }
  }

  const markJobFailure = (jobId: string, error: unknown) => {
    if (jobIdRef.current !== jobId) return
    jobIdRef.current = null
    const message = String(error)
    setActiveJob((current) => current?.jobId === jobId
      ? { ...current, status: 'error', message: 'Operation failed', error: message }
      : current)
    window.setTimeout(() => setActiveJob((current) => current?.jobId === jobId ? null : current), 2800)
  }

  const loadProject = (next: ProjectData | null) => {
    if (!next) return
    setProject(next)
    setRecentProjects(writeRecentProject(next))
    setWorkspace('library')
    setShowMediaSidebar(true)
    setShowInspector(true)
    setMediaFilter('all')
    setMediaSearch('')
    setRightTab('assistant')
    setOpenMenu(null)
    const first = getVideoClips(next)[0]
    const firstMusic = getMusicClips(next)[0]
    setSelectedClipId(first?.id ?? null)
    setSelectedMusicClipId(first ? null : (firstMusic?.id ?? null))
    setSelectedSubtitleId(next.subtitles[0]?.id ?? null)
    setPlayhead(0)
    setSeekToken((value) => value + 1)
    setPlaying(false)
    setPendingPlan(null)
    setChatError('')
  }

  const createNewProject = async (event: FormEvent) => {
    event.preventDefault()
    if (!window.desktop) return
    if (activeJob?.status === 'running') { showToast(t('waitForJob')); return }
    setBusy(true)
    try {
      if (project) {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
        await window.desktop.saveProject(project)
      }
      const next = await window.desktop.createProject(projectName || (isArabic ? 'مشروعي الجديد' : 'Untitled project'))
      if (next) loadProject(next)
      setShowCreate(false)
      setProjectName('')
    } catch (error) {
      showToast(String(error))
    } finally { setBusy(false) }
  }

  const openProject = async () => {
    if (!window.desktop) return
    if (activeJob?.status === 'running') { showToast(t('waitForJob')); return }
    setBusy(true)
    try {
      if (project) {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
        await window.desktop.saveProject(project)
      }
      loadProject(await window.desktop.openProject())
    } catch (error) { showToast(String(error)) }
    finally { setBusy(false) }
  }

  const openRecent = async (recent: RecentProject) => {
    if (!window.desktop) return
    if (activeJob?.status === 'running') { showToast(t('waitForJob')); return }
    setBusy(true)
    try {
      if (project) {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
        await window.desktop.saveProject(project)
      }
      loadProject(await window.desktop.openRecentProject(recent.rootPath))
    } catch (error) { showToast(`${t('openRecentProject')}: ${String(error)}`) }
    finally { setBusy(false) }
  }

  const forgetRecent = (rootPath: string) => {
    const next = recentProjects.filter((item) => item.rootPath !== rootPath)
    setRecentProjects(next)
    try { window.localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(next)) } catch { /* The visible state still updates. */ }
  }

  const saveNow = async () => {
    if (!project || !window.desktop) return
    setSaveStatus('saving')
    try {
      await window.desktop.saveProject(project)
      setSaveStatus('saved')
      showToast(t('saved'))
    } catch (error) { setSaveStatus('unsaved'); showToast(`Save failed: ${String(error)}`) }
  }

  const seekTo = useCallback((time: number, autoplay = false) => {
    setPlayhead(Math.max(0, Math.min(duration, time)))
    setSeekToken((value) => value + 1)
    if (autoplay) setPlaying(true)
  }, [duration])

  useEffect(() => {
    const video = videoRef.current
    if (!video || !activeClip || !activeAsset?.previewUrl) return
    const localTime = Math.max(0, Math.min(clipDuration(activeClip), playhead - activeClip.position))
    const targetTime = activeClip.sourceIn + localTime
    pendingSeekRef.current = targetTime
    const currentUrl = video.getAttribute('src')
    if (currentUrl !== activeAsset.previewUrl) {
      video.setAttribute('src', activeAsset.previewUrl)
      video.load()
    } else if (video.readyState >= 1) {
      try { video.currentTime = targetTime } catch { /* Metadata will make the seek available. */ }
    }
    if (playing) void video.play().catch(() => setPlaying(false))
  }, [activeClip?.id, activeAsset?.previewUrl, seekToken])

  useEffect(() => {
    if (videoRef.current) videoRef.current.volume = volume
  }, [volume, activeAsset?.previewUrl])

  const handleVideoLoaded = () => {
    const video = videoRef.current
    if (!video) return
    try { video.currentTime = pendingSeekRef.current } catch { /* Ignore a seek before metadata. */ }
    if (playing || wasPlayingRef.current) {
      wasPlayingRef.current = false
      void video.play().catch(() => setPlaying(false))
    }
  }

  const handleTimeUpdate = () => {
    const video = videoRef.current
    if (!video || !activeClip || !project) return
    const current = video.currentTime
    const nextPosition = activeClip.position + Math.max(0, current - activeClip.sourceIn)
    setPlayhead(Math.min(duration, nextPosition))
    if (current >= activeClip.sourceOut - 0.04) {
      const index = videoClips.findIndex((clip) => clip.id === activeClip.id)
      const nextClip = videoClips[index + 1]
      if (nextClip) {
        wasPlayingRef.current = playing
        setSelectedClipId(nextClip.id)
        seekTo(nextClip.position, playing)
      } else {
        video.pause()
        setPlaying(false)
        setPlayhead(duration)
      }
    }
  }

  const togglePlay = () => {
    const video = videoRef.current
    if (!video || !activeClip) return
    if (playing) {
      video.pause()
      setPlaying(false)
    } else {
      if (playhead >= duration - 0.05) seekTo(0)
      setPlaying(true)
      void video.play().catch(() => setPlaying(false))
    }
  }

  useEffect(() => {
    const onShortcut = (event: globalThis.KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const isTyping = target?.matches('input, textarea, select, [contenteditable="true"]')
      if (isTyping) return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault(); void saveNow()
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (uiLocked) return
        setProject((current) => current ? event.shiftKey ? redoEdit(current) : undoEdit(current) : current)
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
        event.preventDefault(); if (uiLocked) return; setProject((current) => current ? redoEdit(current) : current)
      } else if (event.code === 'Space' && project) {
        event.preventDefault(); togglePlay()
      }
    }
    window.addEventListener('keydown', onShortcut)
    return () => window.removeEventListener('keydown', onShortcut)
  }, [project, saveNow, uiLocked])

  const runAnalysis = async (sourceProject: ProjectData, mediaIds?: string[]) => {
    if (!window.desktop || !sourceProject.media.length) return
    if (activeJob?.status === 'running') { showToast(t('waitForJob')); return }
    const jobId = makeId()
    jobIdRef.current = jobId
    setActiveJob({ jobId, kind: 'analysis', progress: 0, message: t('analyze'), status: 'running', startedAt: Date.now() })
    try {
      const result = await window.desktop.analyze(sourceProject, mediaIds ?? sourceProject.media.map((asset) => asset.id), jobId)
      setProject((current) => current?.id === sourceProject.id
        ? { ...current, analysisByMedia: { ...current.analysisByMedia, ...result.analysisByMedia }, updatedAt: new Date().toISOString() }
        : current)
      if (result.warnings.length) showToast(result.warnings[0])
      setRightTab('transcript')
    } catch (error) {
      markJobFailure(jobId, error)
      showToast(`Analysis failed: ${String(error)}`)
    }
  }

  const importVideos = async () => {
    if (!project || !window.desktop) return
    if (uiLocked) { showToast(t('waitForJob')); return }
    setBusy(true)
    try {
      const result = await window.desktop.importMedia()
      if (!result?.assets.length) {
        if (result?.warnings.length) showToast(result.warnings[0])
        return
      }
      const next = addMediaToTimeline(project, result.assets)
      const firstNewClip = next.timeline.clips.find((clip) => result.assets.some((asset) => asset.id === clip.mediaId) && clip.trackId === 'track-video')
      setProject(next)
      setSelectedMusicClipId(null)
      setSelectedClipId(firstNewClip?.id ?? next.timeline.clips[0]?.id ?? null)
      setPlayhead(Math.max(0, duration))
      if (result.warnings.length) showToast(result.warnings[0])
      setRightTab('transcript')
      setShowInspector(true)
      void runAnalysis(next, result.assets.map((asset) => asset.id))
    } catch (error) { showToast(`Import failed: ${String(error)}`) }
    finally { setBusy(false) }
  }

  const importAudio = async () => {
    if (!project || !window.desktop) return
    if (uiLocked) { showToast(t('waitForJob')); return }
    setBusy(true)
    try {
      const result = await window.desktop.importAudio()
      if (!result?.assets.length) {
        if (result?.warnings.length) showToast(result.warnings[0])
        return
      }
      const next = addAudioToTimeline(project, result.assets, 0)
      const firstNewClip = getMusicClips(next).find((clip) => result.assets.some((asset) => asset.id === clip.mediaId))
      setProject(next)
      setSelectedClipId(null)
      setSelectedMusicClipId(firstNewClip?.id ?? null)
      setShowInspector(true)
      setPlayhead(0)
      if (result.warnings.length) showToast(result.warnings[0])
      void runAnalysis(next, result.assets.map((asset) => asset.id))
    } catch (error) { showToast(`Audio import failed: ${String(error)}`) }
    finally { setBusy(false) }
  }

  const relinkMedia = async (mediaId: string) => {
    if (!project || !window.desktop) return
    if (uiLocked) { showToast(t('waitForJob')); return }
    try {
      const updated = await window.desktop.relinkMedia(mediaId)
      if (!updated) return
      setProject((current) => current ? {
        ...current,
        media: current.media.map((asset) => asset.id === mediaId ? updated : asset),
        timeline: {
          ...current.timeline,
          clips: current.timeline.clips.map((clip) => clip.mediaId === mediaId ? { ...clip, sourceOut: Math.min(clip.sourceOut, updated.duration) } : clip)
        },
        analysisByMedia: Object.fromEntries(Object.entries(current.analysisByMedia).filter(([id]) => id !== mediaId))
      } : current)
      showToast('Source relinked. Re-analyze to refresh the index.')
    } catch (error) { showToast(String(error)) }
  }

  const updateProject = (next: ProjectData) => setProject(next)

  const applySplit = () => {
    if (!project || !selectedClip || uiLocked) return
    const next = splitClip(project, selectedClip.id, playhead)
    if (next !== project) updateProject(next)
    else showToast('Place the playhead inside the selected clip before splitting.')
  }

  const applyTrim = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!project || !selectedClip || uiLocked) return
    const form = new FormData(event.currentTarget)
    const sourceIn = Number(form.get('sourceIn'))
    const sourceOut = Number(form.get('sourceOut'))
    const next = trimClip(project, selectedClip.id, sourceIn, sourceOut)
    if (next === project) showToast('Trim values must leave at least 0.08 seconds.')
    else updateProject(next)
  }

  const applyAudioTrim = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!project || !selectedMusicClip || uiLocked) return
    const form = new FormData(event.currentTarget)
    const sourceIn = Number(form.get('sourceIn'))
    const sourceOut = Number(form.get('sourceOut'))
    const next = trimAudioClip(project, selectedMusicClip.id, sourceIn, sourceOut)
    if (next === project) showToast('Trim values must leave at least 0.08 seconds.')
    else updateProject(next)
  }

  const beginClipTrim = (event: ReactPointerEvent<HTMLDivElement>, clip: TimelineClip, edge: ClipTrimDrag['edge']) => {
    if (uiLocked) return
    event.preventDefault()
    event.stopPropagation()
    const drag: ClipTrimDrag = {
      clipId: clip.id,
      edge,
      pointerId: event.pointerId,
      startX: event.clientX,
      initialSourceIn: clip.sourceIn,
      initialSourceOut: clip.sourceOut,
      sourceIn: clip.sourceIn,
      sourceOut: clip.sourceOut
    }
    clipTrimDragRef.current = drag
    setClipTrimDrag(drag)
    setSelectedClipId(clip.id)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const updateClipTrim = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = clipTrimDragRef.current
    if (!drag || drag.pointerId !== event.pointerId || !project) return
    event.preventDefault()
    const clip = getVideoClips(project).find((item) => item.id === drag.clipId)
    const asset = project.media.find((item) => item.id === clip?.mediaId)
    const delta = (event.clientX - drag.startX) / pixelsPerSecond
    const minimum = 0.08
    const next: ClipTrimDrag = drag.edge === 'left'
      ? { ...drag, sourceIn: Math.max(0, Math.min(drag.initialSourceOut - minimum, drag.initialSourceIn + delta)) }
      : { ...drag, sourceOut: Math.max(drag.initialSourceIn + minimum, Math.min(asset?.duration ?? drag.initialSourceOut, drag.initialSourceOut + delta)) }
    clipTrimDragRef.current = next
    setClipTrimDrag(next)
  }

  const finishClipTrim = (event: ReactPointerEvent<HTMLDivElement>, cancelled = false) => {
    const drag = clipTrimDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    clipTrimDragRef.current = null
    setClipTrimDrag(null)
    if (cancelled || !project) return
    const next = trimClip(project, drag.clipId, drag.sourceIn, drag.sourceOut)
    if (next !== project) setProject(next)
  }

  const handleTrimKeyDown = (event: KeyboardEvent<HTMLDivElement>, clip: TimelineClip, edge: ClipTrimDrag['edge']) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    event.stopPropagation()
    if (!project || uiLocked) return
    const asset = project.media.find((item) => item.id === clip.mediaId)
    const delta = (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 1 : 1 / Math.max(1, project.exportSettings.fps))
    const sourceIn = edge === 'left'
      ? Math.max(0, Math.min(clip.sourceOut - 0.08, clip.sourceIn + delta))
      : clip.sourceIn
    const sourceOut = edge === 'right'
      ? Math.max(clip.sourceIn + 0.08, Math.min(asset?.duration ?? clip.sourceOut, clip.sourceOut + delta))
      : clip.sourceOut
    const next = trimClip(project, clip.id, sourceIn, sourceOut)
    if (next !== project) setProject(next)
  }

  const deleteSelectedClip = () => {
    if (!project || !selectedClip || uiLocked) return
    const next = deleteTimelineRange(project, selectedClip.position, selectedClip.position + clipDuration(selectedClip))
    updateProject(next)
    setSelectedClipId(getVideoClips(next)[0]?.id ?? null)
    setPlayhead(Math.min(playhead, projectDuration(next)))
  }

  const setVolumeForClip = (value: number) => {
    if (!project || !selectedClip || uiLocked) return
    updateProject(setClipGain(project, selectedClip.id, value))
  }

  const setVolumeForAudioClip = (value: number) => {
    if (!project || !selectedMusicClip || uiLocked) return
    updateProject(setAudioClipGain(project, selectedMusicClip.id, value))
  }

  const deleteSelectedAudioClip = () => {
    if (!project || !selectedMusicClip || uiLocked) return
    const next = removeAudioClip(project, selectedMusicClip.id)
    setProject(next)
    setSelectedMusicClipId(getMusicClips(next)[0]?.id ?? null)
  }

  const toggleTrackMute = (trackId: string) => {
    if (!project || uiLocked) return
    const current = project.timeline.tracks.find((track) => track.id === trackId)?.muted ?? false
    setProject(setTrackMuted(project, trackId, !current))
  }

  const setExportField = <K extends keyof ExportSettings>(key: K, value: ExportSettings[K]) => {
    if (!project) return
    const updated = { ...(exportSettingsRef.current ?? project.exportSettings), [key]: value }
    exportSettingsRef.current = updated
    setExportSettings(updated)
    setProject((current) => current ? commitExportSettings(current, updated) : current)
  }

  const doExport = async () => {
    if (!project || !window.desktop) return
    if (uiLocked) { showToast(t('waitForJob')); return }
    const selected = exportSettings ?? project.exportSettings
    const jobId = makeId()
    jobIdRef.current = jobId
    setActiveJob({ jobId, kind: 'export', progress: 0, message: t('busyExport'), status: 'running', startedAt: Date.now() })
    try {
      const result = await window.desktop.exportVideo({ project, settings: selected }, jobId)
      if (result) showToast(`${t('exportSuccess')}: ${result.outputPath}`)
      setShowExport(false)
    } catch (error) { markJobFailure(jobId, error); showToast(`Export failed: ${String(error)}`) }
  }

  const sendChat = async (event?: FormEvent, forcedText?: string) => {
    event?.preventDefault()
    const text = (forcedText ?? chatDraft).trim()
    if (!text || !project || !window.desktop || uiLocked) { if (text && uiLocked) showToast(t('waitForJob')); return }
    setChatDraft('')
    setBusy(true)
    setChatError('')
    setPendingPlan(null)
    const userMessage = makeMessage('user', text)
    const withUser = { ...project, chatMessages: [...project.chatMessages, userMessage].slice(-500) }
    setProject(withUser)
    const jobId = makeId()
    jobIdRef.current = jobId
    setActiveJob({ jobId, kind: 'analysis', progress: 0, message: 'AI', status: 'running', startedAt: Date.now() })
    try {
      const response = await window.desktop.chat(withUser, text, jobId)
      const assistantMessage = makeMessage('assistant', response.reply)
      setProject({
        ...response.project,
        chatMessages: [...withUser.chatMessages, assistantMessage].slice(-500)
      })
      if (response.proposal) setPendingPlan(response.proposal)
    } catch (error) {
      markJobFailure(jobId, error)
      const message = String(error)
      setChatError(message)
      setProject((current) => current ? { ...current, chatMessages: [...current.chatMessages, makeMessage('assistant', `حدث خطأ أثناء تنفيذ الطلب: ${message}`)].slice(-500) } : current)
    } finally { setBusy(false) }
  }

  const applyProposal = async () => {
    const action = pendingPlan?.action
    if (!action) return
    if (action.type === 'open-export') {
      setPendingPlan(null)
      setShowExport(true)
      return
    }
    if (action.type === 'create-short') {
      if (!project || uiLocked) return
      if (action.baseUpdatedAt !== project.updatedAt) { setPendingPlan(null); showToast(t('shortPlanStale')); return }
      const next = createShortFromRange(project, action.start, action.end, action.aspectRatio)
      if (next === project) { showToast(t('shortApplyFailed')); return }
      setPendingPlan(null)
      updateProject(next)
      setSelectedClipId(getVideoClips(next)[0]?.id ?? null)
      setSelectedMusicClipId(null)
      setSelectedSubtitleId(next.subtitles[0]?.id ?? null)
      setPlayhead(0)
      setSeekToken((value) => value + 1)
      setPlaying(false)
      setRightTab('subtitles')
      setShowInspector(true)
      showToast(t('shortApplied'))
      return
    }
    const command = action.type === 'remove-silence'
      ? isArabic ? `احذف فترات الصمت التي تزيد عن ${action.minimumDuration} ثانية` : settings.language === 'fr' ? `Supprime les silences de plus de ${action.minimumDuration} secondes` : `Remove silences longer than ${action.minimumDuration} seconds`
      : isArabic ? `احذف من ${action.start} إلى ${action.end} ثانية` : settings.language === 'fr' ? `Supprime de ${action.start} à ${action.end} secondes` : `Delete ${action.start} to ${action.end} seconds`
    setPendingPlan(null)
    await sendChat(undefined, command)
  }

  const changeLanguage = async (language: UiLanguage) => {
    const next = { ...settings, language }
    setSettings(next)
    try { await window.desktop?.saveSettings(next) } catch (error) { showToast(String(error)) }
  }

  const applySettings = async (next: AppSettings) => {
    try {
      const saved = await window.desktop.saveSettings(next)
      setSettings(saved)
      setSettingsSaved(true)
      window.setTimeout(() => setSettingsSaved(false), 2200)
    } catch (error) { showToast(String(error)) }
  }

  const handleTranscriptSeek = (segment: TranscriptSegment, mediaId: string) => {
    if (!project) return
    const clip = getVideoClips(project).find((item) => item.mediaId === mediaId && segment.start >= item.sourceIn && segment.start <= item.sourceOut)
    if (!clip) return
    setSelectedMusicClipId(null)
    setSelectedClipId(clip.id)
    seekTo(clip.position + segment.start - clip.sourceIn)
  }

  const selectSubtitle = (subtitleId: string) => {
    const subtitle = project?.subtitles.find((item) => item.id === subtitleId)
    if (!subtitle) return
    setSelectedSubtitleId(subtitleId)
    setRightTab('subtitles')
    setShowInspector(true)
    seekTo(subtitle.start)
  }

  const addManualSubtitle = () => {
    if (!project) return
    if (uiLocked) { showToast(t('waitForJob')); return }
    if (duration < 0.08) { showToast(t('subtitleNeedsVideo')); return }
    const start = Math.min(playhead, Math.max(0, duration - 0.08))
    const subtitle: TranscriptSegment = { id: makeId(), start, end: Math.min(duration, start + 2), text: t('newSubtitle') }
    const next = addSubtitle(project, subtitle)
    if (next === project) { showToast(t('subtitleSaveError')); return }
    updateProject(next)
    setSelectedSubtitleId(subtitle.id)
    setRightTab('subtitles')
    setShowInspector(true)
    seekTo(start)
  }

  const saveSubtitle = (subtitleId: string, changes: Pick<TranscriptSegment, 'text' | 'start' | 'end'>): boolean => {
    if (!project || uiLocked) return false
    const next = updateSubtitle(project, subtitleId, changes)
    if (next === project) return false
    updateProject(next)
    return true
  }

  const removeSubtitle = (subtitleId: string): boolean => {
    if (!project || uiLocked) return false
    const next = deleteSubtitle(project, subtitleId)
    if (next === project) return false
    updateProject(next)
    setSelectedSubtitleId(next.subtitles[0]?.id ?? null)
    return true
  }

  const addCaptions = () => {
    if (!project || !activeAsset) return
    if (uiLocked) { showToast(t('waitForJob')); return }
    const next = generateTimelineSubtitles(project, activeAsset.id)
    if (next === project) showToast('No new transcript segments to add.')
    else {
      const added = next.subtitles.find((item) => !project.subtitles.some((existing) => existing.id === item.id))
      updateProject(next)
      if (added) setSelectedSubtitleId(added.id)
      setRightTab('subtitles')
      setShowInspector(true)
      showToast(t('captionsAdded'))
    }
  }

  const cancelActiveJob = async () => {
    if (!activeJob || !window.desktop) return
    jobIdRef.current = null
    await window.desktop.cancelJob(activeJob.jobId)
    setActiveJob({ ...activeJob, status: 'cancelled', message: 'Cancelled' })
    window.setTimeout(() => setActiveJob((current) => current?.jobId === activeJob.jobId ? null : current), 2800)
  }

  const openExportDialog = () => {
    if (!project) return
    exportSettingsRef.current = project.exportSettings
    setExportSettings(project.exportSettings)
    setShowExport(true)
  }

  const executeMenuAction = (action: string) => {
    setOpenMenu(null)
    if (uiLocked && ['new', 'open', 'import-video', 'import-audio', 'delete', 'split', 'analyze'].includes(action)) {
      showToast(t('waitForJob'))
      return
    }
    switch (action) {
      case 'new': setProjectName(''); setShowCreate(true); break
      case 'open': void openProject(); break
      case 'save': void saveNow(); break
      case 'export': openExportDialog(); break
      case 'import-video': void importVideos(); break
      case 'import-audio': void importAudio(); break
      case 'undo': if (project && !uiLocked) setProject(undoEdit(project)); break
      case 'redo': if (project && !uiLocked) setProject(redoEdit(project)); break
      case 'split': applySplit(); break
      case 'delete': if (selectedMusicClip) deleteSelectedAudioClip(); else deleteSelectedClip(); break
      case 'toggle-library': setShowMediaSidebar((value) => !value); break
      case 'toggle-inspector': setShowInspector((value) => !value); break
      case 'project-details': setWorkspace('project'); setShowMediaSidebar(true); break
      case 'analyze': if (project) void runAnalysis(project); break
      case 'subtitles': setRightTab('subtitles'); setShowInspector(true); break
      case 'assistant': setRightTab('assistant'); setShowInspector(true); break
      case 'settings': setShowSettings(true); break
      case 'shortcuts': setShowShortcuts(true); break
      case 'logs': void window.desktop.openLogs(); break
    }
  }

  const menuDefinitions: Array<{ id: AppMenu; label: string; items: Array<{ action: string; label: string; icon: React.ReactNode; shortcut?: string; disabled?: boolean }> }> = [
    { id: 'file', label: t('menuFile'), items: [
      { action: 'new', label: t('menuNewProject'), icon: <Plus size={14} /> },
      { action: 'open', label: t('menuOpenProject'), icon: <FolderOpen size={14} /> },
      { action: 'import-video', label: t('menuImportVideo'), icon: <FileVideo size={14} /> },
      { action: 'import-audio', label: t('menuImportAudio'), icon: <FileAudio size={14} /> },
      { action: 'save', label: t('menuSave'), icon: <Check size={14} />, shortcut: 'Ctrl S' },
      { action: 'export', label: t('menuExport'), icon: <Download size={14} /> }
    ] },
    { id: 'edit', label: t('menuEdit'), items: [
      { action: 'undo', label: t('menuUndo'), icon: <Undo2 size={14} />, shortcut: 'Ctrl Z', disabled: !project?.history.undo.length },
      { action: 'redo', label: t('menuRedo'), icon: <Redo2 size={14} />, shortcut: 'Ctrl Shift Z', disabled: !project?.history.redo.length },
      { action: 'split', label: t('menuSplit'), icon: <Scissors size={14} />, disabled: !selectedClip },
      { action: 'delete', label: t('menuDelete'), icon: <Trash2 size={14} />, disabled: !selectedClip && !selectedMusicClip }
    ] },
    { id: 'view', label: t('menuView'), items: [
      { action: 'toggle-library', label: t('menuShowLibrary'), icon: <PanelLeftClose size={14} /> },
      { action: 'toggle-inspector', label: t('menuShowInspector'), icon: <PanelRightClose size={14} /> },
      { action: 'shortcuts', label: t('menuShortcuts'), icon: <Keyboard size={14} /> }
    ] },
    { id: 'project', label: t('menuProject'), items: [
      { action: 'project-details', label: t('projectOverview'), icon: <FolderOpen size={14} /> },
      { action: 'analyze', label: t('menuAnalyze'), icon: <Activity size={14} />, disabled: !project?.media.length },
      { action: 'export', label: t('menuExport'), icon: <Download size={14} />, disabled: !videoClips.length }
    ] },
    { id: 'tools', label: t('menuTools'), items: [
      { action: 'assistant', label: t('menuAssistant'), icon: <Sparkles size={14} /> },
      { action: 'subtitles', label: t('menuSubtitles'), icon: <Captions size={14} /> },
      { action: 'settings', label: t('menuSettings'), icon: <Settings2 size={14} /> }
    ] },
    { id: 'help', label: t('menuHelp'), items: [
      { action: 'shortcuts', label: t('menuShortcuts'), icon: <Keyboard size={14} /> },
      { action: 'logs', label: t('logs'), icon: <FileText size={14} /> }
    ] }
  ]

  if (!project) {
    return <div className="welcome-page" dir={isArabic ? 'rtl' : 'ltr'}>
      <header className="welcome-topbar">
        <div className="brand-lockup"><span className="brand-mark"><Clapperboard size={21} /></span><span><strong>AI Video Editor</strong><small>{t('tagline')}</small></span></div>
        <div className="welcome-controls">
          <label className="language-select"><Languages size={15} /><select value={settings.language} onChange={(event) => void changeLanguage(event.target.value as UiLanguage)} aria-label={t('language')}><option value="ar">العربية</option><option value="en">English</option><option value="fr">Français</option></select><ChevronDown size={13} /></label>
          <button className="welcome-icon" type="button" title={t('settings')} onClick={() => setShowSettings(true)}><Settings2 size={17} /></button>
        </div>
      </header>
      {mediaRuntime && !mediaRuntime.ready && <MediaRuntimeBanner status={mediaRuntime} t={t} onRetry={() => void refreshMediaRuntime()} />}
      <main className="welcome-main">
        <div className="welcome-copy">
          <div className="eyebrow"><Sparkles size={14} /> {t('localOnly')}</div>
          <h1>{t('welcomeTitle')}</h1>
          <p>{t('welcomeDescription')}</p>
          <div className="welcome-actions">
            <button className="button button-primary button-large" type="button" onClick={() => setShowCreate(true)}><Plus size={18} />{t('newProject')}</button>
            <button className="button button-outline button-large" type="button" onClick={() => void openProject()}><FolderOpen size={18} />{t('openProject')}</button>
          </div>
          <section className="recent-projects" aria-label={t('recentProjects')}>
            <div className="recent-projects-heading"><h2>{t('recentProjects')}</h2><span>{recentProjects.length}</span></div>
            {recentProjects.length ? <div className="recent-project-list">{recentProjects.slice(0, 4).map((recent) => <div className="recent-project-row" key={recent.rootPath}>
              <button className="recent-project-open" type="button" onClick={() => void openRecent(recent)} disabled={busy}>
                <span className="recent-project-icon"><FolderOpen size={16} /></span>
                <span className="recent-project-copy"><strong title={recent.name}>{recent.name}</strong><small>{t('recentProjectMeta').replace('{date}', new Intl.DateTimeFormat(settings.language, { dateStyle: 'medium' }).format(new Date(recent.lastOpenedAt)))}</small></span>
                <ChevronRight size={15} />
              </button>
              <button className="recent-project-remove" type="button" title={t('removeRecentProject')} aria-label={t('removeRecentProject')} onClick={() => forgetRecent(recent.rootPath)}><X size={13} /></button>
            </div>)}</div> : <p className="recent-projects-empty">{t('noRecentHint')}</p>}
          </section>
          <div className="feature-row">
            <div><span><HardDrive size={17} /></span><b>{t('featureLocal')}</b></div>
            <div><span><Scissors size={17} /></span><b>{t('featureTimeline')}</b></div>
            <div><span><Bot size={17} /></span><b>{t('featureAgent')}</b></div>
          </div>
        </div>
        <section className="welcome-overview" aria-label={t('projectOverview')}>
          <div className="welcome-overview-header"><span className="section-kicker">{t('localWorkspace')}</span><span className="welcome-ready-chip"><span className="status-dot" />{t('localOnly')}</span></div>
          <div className="welcome-overview-mark"><Clapperboard size={27} /></div>
          <h2>{t('welcomeTitle')}</h2><p>{t('welcomeDescription')}</p>
          <div className="welcome-overview-features"><div><HardDrive size={15} /><span>{t('featureLocal')}</span><Check size={14} /></div><div><Scissors size={15} /><span>{t('featureTimeline')}</span><Check size={14} /></div><div><Bot size={15} /><span>{t('featureAgent')}</span><Check size={14} /></div></div>
          <div className="welcome-overview-footer"><span><FileVideo size={14} />{t('assetVideo')}</span><span><FileAudio size={14} />{t('assetAudio')}</span><span><Subtitles size={14} />{t('subtitlesTrack')}</span></div>
        </section>
      </main>
      <footer className="welcome-footer"><span><span className="status-dot" /> {t('localStatus')}</span><span>{t('localWorkspace')}</span></footer>
      {showCreate && <Modal title={t('newProject')} onClose={() => setShowCreate(false)}>
        <form className="modal-form" onSubmit={(event) => void createNewProject(event)}>
          <label className="field-label">{t('projectName')}<input autoFocus value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder={isArabic ? 'مثال: مقابلة البودكاست' : 'e.g. Podcast interview'} maxLength={120} /></label>
          <p className="modal-note"><HardDrive size={15} /> {t('chooseFolder')}. A project.json and local cache folders will be created; media stays where it is.</p>
          <div className="modal-actions"><button className="button button-quiet" type="button" onClick={() => setShowCreate(false)}>{t('cancel')}</button><button className="button button-primary" type="submit" disabled={busy}><Plus size={16} />{t('create')}</button></div>
        </form>
      </Modal>}
      {showSettings && <SettingsModal settings={settings} t={t} onClose={() => setShowSettings(false)} onSave={applySettings} saved={settingsSaved} onGeminiStatusChange={setGeminiKeyStatus} />}
      {toast && <Toast message={toast} onClose={() => setToast('')} t={t} />}
    </div>
  }



  return <div className={`editor-app ${isArabic ? 'locale-ar' : 'locale-ltr'}`} dir={isArabic ? 'rtl' : 'ltr'}>
    <header className="topbar">
      <div className="topbar-start">
        <div className="topbar-brand">
          <span className="brand-mark small"><Clapperboard size={17} /></span>
          <div className="project-heading"><strong title={project.name}>{project.name}</strong><span>{project.media.length} {t('media')} <i /> {formatTime(duration)} {t('duration')}</span></div>
          <span className={`autosave-state ${saveStatus === 'unsaved' ? 'autosave-error' : ''}`}><span className="status-dot" />{t(saveStatus)}</span>
        </div>
        <nav className="app-menu-bar" aria-label={t('mainNavigation')}>
          {menuDefinitions.map((menu) => <div className="menu-anchor" key={menu.id}>
            <button className={`menu-trigger ${openMenu === menu.id ? 'menu-trigger-open' : ''}`} type="button" aria-haspopup="menu" aria-expanded={openMenu === menu.id} onClick={() => setOpenMenu((current) => current === menu.id ? null : menu.id)}>{menu.label}</button>
            {openMenu === menu.id && <div className="menu-popover" role="menu">{menu.items.map((item, index) => <Fragment key={`${item.action}-${index}`}>
              {(menu.id === 'file' && index === 4) || (menu.id === 'edit' && index === 2) ? <div className="menu-separator" /> : null}
              <button className="menu-item" type="button" role="menuitem" disabled={Boolean(item.disabled) || (uiLocked && ['new', 'open', 'import-video', 'import-audio', 'delete', 'split', 'analyze'].includes(item.action))} onClick={() => executeMenuAction(item.action)}>
                <span className="menu-item-icon">{item.icon}</span><span className="menu-item-label">{item.label}</span>{item.shortcut && <kbd>{item.shortcut}</kbd>}
              </button>
            </Fragment>)}
              {menu.id === 'file' && recentProjects.length > 0 && <><div className="menu-separator" /><div className="menu-group-title">{t('recentProjects')}</div>{recentProjects.slice(0, 3).map((recent) => <button className="menu-item recent-menu-item" type="button" role="menuitem" key={recent.rootPath} onClick={() => { setOpenMenu(null); void openRecent(recent) }}><span className="menu-item-icon"><FolderOpen size={14} /></span><span className="menu-item-label">{recent.name}</span></button>)}</>}
            </div>}
          </div>)}
        </nav>
      </div>
      <div className="topbar-actions">
        <label className="topbar-language-select" title={t('language')}><Languages size={15} /><select value={settings.language} onChange={(event) => void changeLanguage(event.target.value as UiLanguage)} aria-label={t('language')}><option value="ar">AR</option><option value="en">EN</option><option value="fr">FR</option></select></label>
        <span className="topbar-separator" />
        <button className="icon-button" type="button" title={t(showMediaSidebar ? 'menuShowLibrary' : 'menuShowLibrary')} aria-pressed={showMediaSidebar} onClick={() => setShowMediaSidebar((value) => !value)}><PanelLeftClose size={16} /></button>
        <button className="icon-button" type="button" title={t('menuShowInspector')} aria-pressed={showInspector} onClick={() => setShowInspector((value) => !value)}><PanelRightClose size={16} /></button>
        <span className="topbar-separator" />
        <button className="icon-button" title={t('undo')} disabled={!project.history.undo.length || uiLocked} onClick={() => setProject(undoEdit(project))}><Undo2 size={17} /></button>
        <button className="icon-button" title={t('redo')} disabled={!project.history.redo.length || uiLocked} onClick={() => setProject(redoEdit(project))}><Redo2 size={17} /></button>
        <button className="button button-quiet topbar-save" type="button" onClick={() => void saveNow()}><Check size={15} />{t('save')}</button>
        <button className="button button-outline topbar-import" type="button" onClick={() => void importVideos()} disabled={uiLocked}><Upload size={15} /><span>{t('import')}</span></button>
        <button className="button button-primary topbar-export" type="button" onClick={openExportDialog} disabled={!videoClips.length || uiLocked}><Download size={15} /><span>{t('export')}</span></button>
      </div>
    </header>

    {mediaRuntime && !mediaRuntime.ready && <MediaRuntimeBanner status={mediaRuntime} t={t} onRetry={() => void refreshMediaRuntime()} />}
    <div className={`editor-layout ${showMediaSidebar ? '' : 'hide-media'} ${showInspector ? '' : 'hide-inspector'}`} dir="ltr">
      <nav className="nav-rail" aria-label={t('mainNavigation')}>
        <div className="rail-brand"><Clapperboard size={18} /></div>
        <div className="rail-divider" />
        <button className={`rail-button ${workspace === 'library' ? 'active' : ''}`} type="button" title={t('navLibrary')} aria-current={workspace === 'library' ? 'page' : undefined} onClick={() => { setWorkspace('library'); setMediaFilter('all'); setShowMediaSidebar(true) }}><Film size={18} /><span>{t('navLibrary')}</span></button>
        <button className={`rail-button ${workspace === 'project' ? 'active' : ''}`} type="button" title={t('navProject')} aria-current={workspace === 'project' ? 'page' : undefined} onClick={() => { setWorkspace('project'); setShowMediaSidebar(true) }}><FolderOpen size={18} /><span>{t('navProject')}</span></button>
        <button className={`rail-button ${workspace === 'video' ? 'active' : ''}`} type="button" title={t('navVideo')} aria-current={workspace === 'video' ? 'page' : undefined} onClick={() => { setWorkspace('video'); setShowMediaSidebar(true) }}><FileVideo size={18} /><span>{t('navVideo')}</span></button>
        <button className={`rail-button ${workspace === 'audio' ? 'active' : ''}`} type="button" title={t('navAudio')} aria-current={workspace === 'audio' ? 'page' : undefined} onClick={() => { setWorkspace('audio'); setShowMediaSidebar(true) }}><AudioLines size={18} /><span>{t('navAudio')}</span></button>
        <button className={`rail-button ${rightTab === 'subtitles' ? 'active' : ''}`} type="button" title={t('navSubtitles')} aria-current={rightTab === 'subtitles' ? 'page' : undefined} onClick={() => { setWorkspace('library'); setRightTab('subtitles'); setShowInspector(true); setShowMediaSidebar(true) }}><Captions size={18} /><span>{t('navSubtitles')}</span></button>
        <button className={`rail-button ${workspace === 'text' ? 'active' : ''}`} type="button" title={t('navText')} aria-current={workspace === 'text' ? 'page' : undefined} onClick={() => { setWorkspace('text'); setShowMediaSidebar(true) }}><TextCursorInput size={18} /><span>{t('navText')}</span></button>
        <button className={`rail-button ${workspace === 'effects' ? 'active' : ''}`} type="button" title={t('navEffects')} aria-current={workspace === 'effects' ? 'page' : undefined} onClick={() => { setWorkspace('effects'); setShowMediaSidebar(true) }}><WandSparkles size={18} /><span>{t('navEffects')}</span></button>
        <button className={`rail-button ${workspace === 'transitions' ? 'active' : ''}`} type="button" title={t('navTransitions')} aria-current={workspace === 'transitions' ? 'page' : undefined} onClick={() => { setWorkspace('transitions'); setShowMediaSidebar(true) }}><Layers size={18} /><span>{t('navTransitions')}</span></button>
        <button className={`rail-button ${rightTab === 'assistant' ? 'active' : ''}`} type="button" title={t('navAssistant')} aria-current={rightTab === 'assistant' ? 'page' : undefined} onClick={() => { setWorkspace('library'); setRightTab('assistant'); setShowInspector(true); setShowMediaSidebar(true) }}><Bot size={18} /><span>{t('navAssistant')}</span></button>
        <div className="rail-spacer" />
        <button className="rail-button" type="button" title={t('settings')} onClick={() => setShowSettings(true)}><Settings2 size={18} /><span>{t('navSettings')}</span></button>
      </nav>

      <aside className="media-sidebar" dir={isArabic ? 'rtl' : 'ltr'}>
        {workspace === 'library' || workspace === 'video' || workspace === 'audio' ? <>
          <div className="panel-heading library-panel-heading">
            <div><span className="section-kicker">{t('projectSection')}</span><h2>{t(workspace === 'video' ? 'navVideo' : workspace === 'audio' ? 'navAudio' : 'navLibrary')}</h2></div>
            <div className="library-heading-actions">
              <button className="icon-button" type="button" title={t('menuShowLibrary')} onClick={() => setShowMediaSidebar(false)}><PanelLeftClose size={15} /></button>
              <div className="import-menu-anchor">
                <button id="media-import-button" className="square-button" type="button" title={t('import')} aria-label={t('import')} aria-expanded={mediaImportMenu} onClick={() => setMediaImportMenu((value) => !value)} disabled={uiLocked}><Plus size={17} /></button>
                {mediaImportMenu && <div className="import-popover">
                  <button type="button" onClick={() => { setMediaImportMenu(false); void importVideos() }} disabled={uiLocked}><FileVideo size={14} />{t('menuImportVideo')}</button>
                  <button type="button" onClick={() => { setMediaImportMenu(false); void importAudio() }} disabled={uiLocked}><FileAudio size={14} />{t('menuImportAudio')}</button>
                </div>}
              </div>
            </div>
          </div>
          <div className="media-toolbar">
            <label className="media-search"><Search size={14} /><input value={mediaSearch} onChange={(event) => setMediaSearch(event.target.value)} placeholder={t('mediaSearchPlaceholder')} aria-label={t('mediaSearchPlaceholder')} /><button type="button" title={t('toastDismiss')} aria-label={t('toastDismiss')} onClick={() => setMediaSearch('')} disabled={!mediaSearch}><X size={13} /></button></label>
            <div className="media-filter-row">
              <div className="media-filter-tabs" role="tablist" aria-label={t('media')}>
                <button className={effectiveMediaFilter === 'all' ? 'active' : ''} type="button" role="tab" aria-selected={effectiveMediaFilter === 'all'} onClick={() => { setWorkspace('library'); setMediaFilter('all') }}>{t('mediaFilterAll')}<span>{mediaCounts.all}</span></button>
                <button className={effectiveMediaFilter === 'video' ? 'active' : ''} type="button" role="tab" aria-selected={effectiveMediaFilter === 'video'} onClick={() => { setWorkspace('library'); setMediaFilter('video') }}>{t('mediaFilterVideo')}<span>{mediaCounts.video}</span></button>
                <button className={effectiveMediaFilter === 'audio' ? 'active' : ''} type="button" role="tab" aria-selected={effectiveMediaFilter === 'audio'} onClick={() => { setWorkspace('library'); setMediaFilter('audio') }}>{t('mediaFilterAudio')}<span>{mediaCounts.audio}</span></button>
              </div>
              <div className="media-view-switch" role="group" aria-label={t('media')}>
                <button className={mediaView === 'grid' ? 'active' : ''} type="button" title={t('mediaViewGrid')} aria-pressed={mediaView === 'grid'} onClick={() => setMediaView('grid')}><LayoutGrid size={14} /></button>
                <button className={mediaView === 'list' ? 'active' : ''} type="button" title={t('mediaViewList')} aria-pressed={mediaView === 'list'} onClick={() => setMediaView('list')}><List size={14} /></button>
              </div>
            </div>
            <div className="media-sort-row"><span>{t('mediaItemsCount').replace('{count}', String(visibleMedia.length))}</span><label><span>{t('mediaSortName')}</span><select value={mediaSort} onChange={(event) => setMediaSort(event.target.value as MediaSort)} aria-label={t('mediaSortName')}><option value="name">{t('mediaSortName')}</option><option value="duration">{t('mediaSortDuration')}</option><option value="size">{t('mediaSortSize')}</option></select></label></div>
          </div>
          <div className={`media-list media-list-${mediaView}`}>
            {visibleMedia.length ? visibleMedia.map((asset) => {
              const isVideo = asset.width > 0 && asset.height > 0
              const relatedVideoClip = videoClips.find((item) => item.mediaId === asset.id)
              const relatedAudioClip = musicClips.find((item) => item.mediaId === asset.id)
              const isSelected = relatedVideoClip?.id === selectedClipId || relatedAudioClip?.id === selectedMusicClipId
              return <article className={`media-card ${isSelected ? 'media-card-active' : ''} ${asset.missing ? 'media-card-missing' : ''}`} key={asset.id} draggable={!asset.missing && !uiLocked} onDragStart={(event) => { event.dataTransfer.effectAllowed = asset.hasAudio ? 'copyMove' : 'move'; if (isVideo) event.dataTransfer.setData('application/x-ai-video-editor-video', asset.id); if (asset.hasAudio) event.dataTransfer.setData('application/x-ai-video-editor-audio', asset.id); event.dataTransfer.setData('text/plain', asset.id) }}>
                <button className="media-card-main" type="button" onClick={() => {
                  if (relatedVideoClip) { setSelectedMusicClipId(null); setSelectedClipId(relatedVideoClip.id); seekTo(relatedVideoClip.position) }
                  else if (relatedAudioClip) { setSelectedClipId(null); setSelectedMusicClipId(relatedAudioClip.id); seekTo(relatedAudioClip.position) }
                }}>
                  <div className="media-thumb" style={asset.thumbnailUrl ? { backgroundImage: `linear-gradient(180deg, transparent 45%, rgba(5,8,12,.62)), url("${asset.thumbnailUrl}")` } : undefined}>
                    {!isVideo && <span className="media-audio-icon"><AudioLines size={18} /></span>}
                    {isVideo && <span className="media-thumb-play"><Play size={12} fill="currentColor" /></span>}
                    <span className="media-thumb-duration">{formatTime(asset.duration)}</span>
                  </div>
                  <span className="media-card-copy"><strong title={asset.name}>{asset.name}</strong><small>{isVideo ? `${asset.width} × ${asset.height}` : t('audioOnly')}<i />{formatBytes(asset.sizeBytes)}</small><small className="media-card-technical">{isVideo ? `${asset.fps.toFixed(0)} FPS · ${asset.videoCodec.toUpperCase()}` : (asset.audioCodec ?? 'AUDIO').toUpperCase()}</small></span>
                </button>
                {asset.missing && <button className="relink-inline" type="button" onClick={() => void relinkMedia(asset.id)} disabled={uiLocked}>{t('relink')}</button>}
              </article>
            }) : <div className="empty-media"><span>{project.media.length ? <Search size={23} /> : <Film size={23} />}</span><strong>{project.media.length ? t('noFilteredMedia') : t('noMedia')}</strong><small>{project.media.length ? t('mediaItemsCount').replace('{count}', '0') : t('importHint')}</small>{!project.media.length && <div className="empty-media-actions"><button className="button button-outline" type="button" onClick={() => void importVideos()}><Plus size={14} />{t('addVideo')}</button><button className="button button-quiet" type="button" onClick={() => void importAudio()}><AudioLines size={14} />{t('importAudio')}</button></div>}</div>}
          </div>
          <div className="media-drop-hint"><Music2 size={12} /><span>{t('dragAudioToTimeline')}</span></div>
          <div className="sidebar-privacy"><HardDrive size={15} /><span>{t('localOnly')}</span><span className="sidebar-privacy-count">{mediaCounts.all}</span></div>
        </> : workspace === 'project' ? <>
          <div className="panel-heading"><div><span className="section-kicker">{t('projectSection')}</span><h2>{t('projectOverview')}</h2></div><button className="icon-button" type="button" title={t('menuShowLibrary')} onClick={() => setShowMediaSidebar(false)}><PanelLeftClose size={15} /></button></div>
          <div className="project-panel-scroll">
            <section className="project-identity-card"><span className="project-identity-mark"><Clapperboard size={19} /></span><div><span className="section-kicker">{t('projectSection')}</span><strong title={project.name}>{project.name}</strong></div><code dir="ltr" title={project.rootPath}>{project.rootPath}</code></section>
            <div className="project-stat-grid"><div><strong>{project.media.length}</strong><span>{t('projectMediaAssets')}</span></div><div><strong>{videoClips.length}</strong><span>{t('projectVideoClips')}</span></div><div><strong>{project.subtitles.length}</strong><span>{t('projectSubtitles')}</span></div><div><strong>{formatTime(duration)}</strong><span>{t('duration')}</span></div></div>
            <dl className="project-metadata"><div><dt>{t('projectCreated')}</dt><dd>{new Intl.DateTimeFormat(settings.language, { dateStyle: 'medium' }).format(new Date(project.createdAt))}</dd></div><div><dt>{t('projectSavedAt')}</dt><dd>{new Intl.DateTimeFormat(settings.language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(project.updatedAt))}</dd></div><div><dt>{t('projectFrameRate')}</dt><dd>{project.exportSettings.fps} FPS</dd></div><div><dt>{t('projectAspectRatio')}</dt><dd>{project.exportSettings.aspectRatio}</dd></div></dl>
            <div className="project-actions"><span className="section-kicker">{t('projectActions')}</span><button className="button button-outline" type="button" onClick={() => void saveNow()}><Check size={14} />{t('save')}</button><button className="button button-outline" type="button" onClick={() => void runAnalysis(project)} disabled={!project.media.length || uiLocked}><Activity size={14} />{t('analyzeProject')}</button><button className="button button-primary" type="button" onClick={openExportDialog} disabled={!videoClips.length || uiLocked}><Download size={14} />{t('export')}</button></div>
            <div className="project-output-note"><SlidersHorizontalFallback /><span><strong>{t('outputSettings')}</strong><small>{project.exportSettings.resolution} · {project.exportSettings.format.toUpperCase()} · {project.exportSettings.quality}</small></span><button type="button" onClick={openExportDialog} title={t('menuExport')}><ChevronRight size={15} /></button></div>
          </div>
        </> : <>
          <div className="panel-heading"><div><span className="section-kicker">{t('projectSection')}</span><h2>{t(workspace === 'text' ? 'navText' : workspace === 'effects' ? 'navEffects' : 'navTransitions')}</h2></div><button className="icon-button" type="button" title={t('menuShowLibrary')} onClick={() => setShowMediaSidebar(false)}><PanelLeftClose size={15} /></button></div>
          <div className="workspace-coming-soon"><span className="coming-soon-icon">{workspace === 'text' ? <TextCursorInput size={22} /> : workspace === 'effects' ? <WandSparkles size={22} /> : <Layers size={22} />}</span><span className="coming-soon-badge">{t('comingSoon')}</span><h3>{t(workspace === 'text' ? 'navText' : workspace === 'effects' ? 'navEffects' : 'navTransitions')}</h3><p>{t(workspace === 'text' ? 'textComingSoon' : workspace === 'effects' ? 'effectsComingSoon' : 'transitionsComingSoon')}</p></div>
        </>}
      </aside>

      <main className="workbench" dir={isArabic ? 'rtl' : 'ltr'}>
        <div className="preview-header">
          <div className="preview-title"><span className="section-kicker">01 / {t('editor')}</span><h2>{t('preview')}</h2></div>
          <div className="preview-meta"><span className="preview-live-dot" />{activeAsset ? `${activeAsset.width} × ${activeAsset.height}` : t('noMedia')}<i />{project.exportSettings.fps} FPS</div>
          <label className="preview-aspect-picker"><span>{t('chooseAspect')}</span><select value={project.exportSettings.aspectRatio} onChange={(event) => setExportField('aspectRatio', event.target.value as AspectRatio)} aria-label={t('chooseAspect')}><option value="16:9">16:9</option><option value="9:16">9:16</option><option value="1:1">1:1</option></select></label>
          <button className="icon-button" type="button" title={t('menuShowInspector')} aria-pressed={showInspector} onClick={() => setShowInspector((value) => !value)}><PanelRightClose size={16} /></button>
        </div>
        <section className="preview-stage">
          {activeAsset?.previewUrl && activeClip ? <div className={`video-stage ratio-${project.exportSettings.aspectRatio.replace(':', '-')}`}>
            <video ref={videoRef} src={activeAsset.previewUrl} style={{ transform: `scale(${previewZoom})` }} muted={embeddedAudioMuted} onLoadedMetadata={handleVideoLoaded} onTimeUpdate={handleTimeUpdate} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} playsInline />
            {musicClips.map((clip) => {
              const asset = project.media.find((item) => item.id === clip.mediaId)
              return <audio key={`preview-${clip.id}`} ref={audioPreviewRefCallbacks.get(clip.id)} src={asset?.previewUrl} preload="metadata" hidden />
            })}
            {(() => {
              const caption = project.subtitles.find((item) => playhead >= item.start && playhead < item.end)
              return caption ? <div className="preview-caption">{caption.text}</div> : null
            })()}
            <div className="preview-corner top-left"><span className="live-pill">{t('previewLive')}</span></div>
          </div> : <div className="preview-placeholder">
            <div className="placeholder-glow" /><div className="placeholder-icon"><Film size={31} /></div>
            <strong>{t('noMedia')}</strong><span>{t('importHint')}</span>
            <button className="button button-primary" type="button" onClick={() => void importVideos()}><Upload size={15} />{t('import')}</button>
          </div>}
        </section>
        <div className="transport-bar">
          <div className="transport-controls">
            <button className="transport-skip" type="button" title={t('previousFrame')} onClick={() => seekTo(playhead - 1 / Math.max(1, project.exportSettings.fps))} disabled={!activeClip}><span>◂</span></button>
            <button className="play-control" type="button" onClick={togglePlay} disabled={!activeClip} title={playing ? t('pause') : t('play')}>{playing ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}</button>
            <button className="transport-skip" type="button" title={t('nextFrame')} onClick={() => seekTo(playhead + 1 / Math.max(1, project.exportSettings.fps))} disabled={!activeClip}><span>▸</span></button>
            <span className="timecode" dir="ltr"><b>{formatTime(playhead, true)}</b><i>/</i>{formatTime(duration, true)}</span>
          </div>
          <label className="transport-scrub"><span className="sr-only">{t('seekTimeline')}</span><input type="range" min="0" max={Math.max(0.01, duration)} step="0.01" value={Math.min(playhead, Math.max(0.01, duration))} aria-label={t('seekTimeline')} disabled={!activeClip || duration <= 0} onChange={(event) => seekTo(Number(event.target.value))} style={{ '--range-progress': `${duration ? playhead / duration * 100 : 0}%` } as CSSProperties} /></label>
          <div className="transport-tools">
            <div className="preview-zoom-inline" title={t('previewScale')}><button type="button" aria-label={t('previewScale')} onClick={() => setPreviewZoom((value) => Math.max(0.75, Math.round((value - 0.1) * 100) / 100))}><ZoomOut size={14} /></button><input type="range" min="0.75" max="1.5" step="0.05" value={previewZoom} aria-label={t('previewScale')} onChange={(event) => setPreviewZoom(Number(event.target.value))} /><span>{Math.round(previewZoom * 100)}%</span><button type="button" aria-label={t('previewScale')} onClick={() => setPreviewZoom((value) => Math.min(1.5, Math.round((value + 0.1) * 100) / 100))}><ZoomIn size={14} /></button></div>
            <div className="volume-inline"><Volume2 size={15} /><input aria-label={t('previewVolume')} type="range" min="0" max="1" step="0.05" value={volume} onChange={(event) => { const value = Number(event.target.value); setVolume(value); if (videoRef.current) videoRef.current.volume = value }} /></div>
            <button className="icon-button" type="button" title={t('fullscreen')} onClick={() => void videoRef.current?.requestFullscreen()} disabled={!activeAsset}><Maximize size={16} /></button>
          </div>
        </div>
        <div className="editor-section-divider"><span>{t('timeline')}</span><i /><span className="timeline-duration-chip"><Clock3 size={12} />{formatTime(duration, true)}</span><button className="icon-button" type="button" title={t('split')} aria-label={t('split')} onClick={applySplit} disabled={!selectedClip || uiLocked}><Scissors size={15} /></button><button className="icon-button" type="button" title={t('menuDelete')} aria-label={t('menuDelete')} onClick={() => selectedMusicClip ? deleteSelectedAudioClip() : deleteSelectedClip()} disabled={(!selectedClip && !selectedMusicClip) || uiLocked}><Trash2 size={15} /></button></div>
        <section className="timeline-panel" aria-label={t('timeline')}>
          <div className="timeline-controls-row">
            <div className="timeline-toolset"><button className="timeline-mini-button" type="button" title={t('undo')} onClick={() => setProject(undoEdit(project))} disabled={!project.history.undo.length || uiLocked}><Undo2 size={14} /></button><button className="timeline-mini-button" type="button" title={t('redo')} onClick={() => setProject(redoEdit(project))} disabled={!project.history.redo.length || uiLocked}><Redo2 size={14} /></button><button className="timeline-mini-button" type="button" title={t('split')} onClick={applySplit} disabled={!selectedClip || uiLocked}><Scissors size={14} /></button><button className="timeline-mini-button" type="button" title={t('importAudio')} onClick={() => void importAudio()} disabled={uiLocked}><Music2 size={14} /></button></div>
            <div className="timeline-zoom"><button type="button" title={t('zoomOut')} onClick={() => setZoom((value) => Math.max(0.45, value - 0.15))}><ZoomOut size={14} /></button><div className="zoom-track"><i style={{ width: `${Math.min(100, zoom * 42)}%` }} /></div><button type="button" title={t('zoomIn')} onClick={() => setZoom((value) => Math.min(2.1, value + 0.15))}><ZoomIn size={14} /></button></div>
          </div>
          <div className="timeline-content">
            <div className="track-labels">
              <div className="track-label ruler-label">00:00</div>
              <div className="track-label video-label"><span className="track-type video-type"><Film size={13} /></span><span>{t('videoTrack')}</span></div>
              <div className="track-label audio-label"><span className="track-type audio-type"><AudioLines size={13} /></span><span>{t('audioTrack')}</span><button className="track-mute-button" type="button" title={t(embeddedAudioMuted ? 'unmuteTrack' : 'muteTrack')} aria-label={t(embeddedAudioMuted ? 'unmuteTrack' : 'muteTrack')} aria-pressed={embeddedAudioMuted} onClick={() => toggleTrackMute(AUDIO_TRACK_ID)} disabled={uiLocked}>{embeddedAudioMuted ? <VolumeX size={12} /> : <Volume2 size={12} />}</button></div>
              <div className="track-label music-label"><span className="track-type music-type"><Music2 size={13} /></span><span>{t('musicTrack')}</span><button className="track-mute-button" type="button" title={t(musicTrackMuted ? 'unmuteTrack' : 'muteTrack')} aria-label={t(musicTrackMuted ? 'unmuteTrack' : 'muteTrack')} aria-pressed={musicTrackMuted} onClick={() => toggleTrackMute(MUSIC_TRACK_ID)} disabled={uiLocked}>{musicTrackMuted ? <VolumeX size={12} /> : <Volume2 size={12} />}</button></div>
              <div className="track-label subtitle-label"><span className="track-type subtitle-type"><Subtitles size={13} /></span><span>{t('subtitlesTrack')}</span></div>
              <div className="track-label text-label"><span className="track-type text-type"><FileText size={13} /></span><span>{t('textTrack')}</span><small className="track-coming-soon">{t('comingSoon')}</small></div>
            </div>
            <div className="timeline-scroll" ref={timelineScrollRef}>
              <div className="timeline-canvas" style={{ width: `${timelineWidth}px`, backgroundSize: `${pixelsPerSecond}px 100%` }}>
                <div className="timeline-ruler" onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect()
                  const x = event.clientX - rect.left
                  seekTo(x / pixelsPerSecond)
                }}>
                  {Array.from({ length: Math.ceil(timelineExtent / markerInterval) + 2 }, (_, index) => index * markerInterval).map((time) => <span key={time} className="ruler-tick" style={{ left: `${time * pixelsPerSecond}px` }}><i />{formatTime(time)}</span>)}
                  <div className="playhead-line ruler-playhead" style={{ left: `${playhead * pixelsPerSecond}px` }} />
                </div>
                <div className="timeline-lane video-lane" onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect()
                  const at = (event.clientX - rect.left) / pixelsPerSecond
                  seekTo(at)
                }}>
                  {videoClips.map((clip, index) => {
                    const asset = project.media.find((item) => item.id === clip.mediaId)
                    const displayedSourceIn = clipTrimDrag?.clipId === clip.id ? clipTrimDrag.sourceIn : clip.sourceIn
                    const displayedSourceOut = clipTrimDrag?.clipId === clip.id ? clipTrimDrag.sourceOut : clip.sourceOut
                    const displayedDuration = displayedSourceOut - displayedSourceIn
                    const clipStyle: CSSProperties = {
                      left: `${clip.position * pixelsPerSecond}px`,
                      width: `${Math.max(48, displayedDuration * pixelsPerSecond - 3)}px`,
                      backgroundImage: asset?.thumbnailUrl ? `linear-gradient(180deg,rgba(18,28,42,.12),rgba(11,17,27,.82)),url("${asset.thumbnailUrl}")` : undefined
                    }
                    return <div key={clip.id} className={`timeline-clip ${selectedClipId === clip.id ? 'timeline-clip-selected' : ''}`} style={clipStyle} draggable={!uiLocked && !clipTrimDrag} onDragStart={(event) => { if (uiLocked || clipTrimDragRef.current) { event.preventDefault(); return }; event.dataTransfer.effectAllowed = 'move'; setDraggedClipId(clip.id) }} onDragEnd={() => setDraggedClipId(null)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
                      event.preventDefault()
                      if (!project || uiLocked) { setDraggedClipId(null); return }
                      const droppedMediaId = event.dataTransfer.getData('application/x-ai-video-editor-video')
                      const sourceClipId = draggedClipId ?? videoClips.find((candidate) => candidate.mediaId === droppedMediaId)?.id
                      if (sourceClipId) {
                        const next = reorderClip(project, sourceClipId, clip.id)
                        if (next !== project) setProject(next)
                        setSelectedMusicClipId(null)
                        setSelectedClipId(sourceClipId)
                      }
                      setDraggedClipId(null)
                    }} onClick={(event) => { event.stopPropagation(); setSelectedMusicClipId(null); setSelectedClipId(clip.id); seekTo(clip.position) }}>
                      <div className="clip-handle left-handle" role="slider" tabIndex={0} aria-label={t('trimStart')} aria-valuemin={0} aria-valuemax={clip.sourceOut - 0.08} aria-valuenow={displayedSourceIn} aria-valuetext={formatTime(displayedSourceIn, true)} title={t('trimStart')} onKeyDown={(event) => handleTrimKeyDown(event, clip, 'left')} onPointerDown={(event) => beginClipTrim(event, clip, 'left')} onPointerMove={updateClipTrim} onPointerUp={(event) => finishClipTrim(event)} onPointerCancel={(event) => finishClipTrim(event, true)} onClick={(event) => event.stopPropagation()} />
                      <div className="clip-name"><Film size={12} /><span>{asset?.name ?? `Clip ${index + 1}`}</span></div><span className="clip-time-label">{formatTime(displayedDuration)}</span>
                      <div className="clip-handle right-handle" role="slider" tabIndex={0} aria-label={t('trimEnd')} aria-valuemin={clip.sourceIn + 0.08} aria-valuemax={asset?.duration ?? clip.sourceOut} aria-valuenow={displayedSourceOut} aria-valuetext={formatTime(displayedSourceOut, true)} title={t('trimEnd')} onKeyDown={(event) => handleTrimKeyDown(event, clip, 'right')} onPointerDown={(event) => beginClipTrim(event, clip, 'right')} onPointerMove={updateClipTrim} onPointerUp={(event) => finishClipTrim(event)} onPointerCancel={(event) => finishClipTrim(event, true)} onClick={(event) => event.stopPropagation()} />
                    </div>
                  })}
                  {videoClips.length === 0 && <button className="timeline-empty-button" type="button" onClick={() => void importVideos()}><Plus size={14} />{t('emptyTimeline')}</button>}
                </div>
                <div className="timeline-lane audio-lane">
                  {videoClips.map((clip) => {
                    const asset = project.media.find((item) => item.id === clip.mediaId)
                    const sourceIn = clipTrimDrag?.clipId === clip.id ? clipTrimDrag.sourceIn : clip.sourceIn
                    const sourceOut = clipTrimDrag?.clipId === clip.id ? clipTrimDrag.sourceOut : clip.sourceOut
                    const visibleDuration = Math.max(0.001, sourceOut - sourceIn)
                    return <div key={`audio-${clip.id}`} className="audio-clip" style={{ left: `${clip.position * pixelsPerSecond}px`, width: `${Math.max(48, visibleDuration * pixelsPerSecond - 3)}px` }}>
                      {asset?.waveformUrl && <img className="audio-waveform" src={asset.waveformUrl} alt="" draggable={false} style={{ width: `${asset.duration / visibleDuration * 100}%`, left: `${-sourceIn / visibleDuration * 100}%` }} />}
                      <span className="audio-gain-label">{clip.gainDb > 0 ? '+' : ''}{clip.gainDb.toFixed(0)} dB</span>
                    </div>
                  })}
                </div>
                <div className="timeline-lane music-lane" onDragOver={(event) => {
                  const acceptsAudioClip = draggedAudioClipId || Array.from(event.dataTransfer.types).includes('application/x-ai-video-editor-audio-clip')
                  const acceptsMedia = Array.from(event.dataTransfer.types).includes('application/x-ai-video-editor-audio')
                  if (acceptsAudioClip || acceptsMedia) { event.preventDefault(); event.dataTransfer.dropEffect = acceptsAudioClip ? 'move' : 'copy'; event.currentTarget.classList.add('timeline-drop-active') }
                }} onDragLeave={(event) => event.currentTarget.classList.remove('timeline-drop-active')} onDrop={(event) => {
                  event.preventDefault()
                  event.currentTarget.classList.remove('timeline-drop-active')
                  if (!project || uiLocked) { setDraggedAudioClipId(null); return }
                  const rect = event.currentTarget.getBoundingClientRect()
                  const target = Math.max(0, Math.round(((event.clientX - rect.left) / pixelsPerSecond) * 10) / 10)
                  const movingClipId = draggedAudioClipId ?? event.dataTransfer.getData('application/x-ai-video-editor-audio-clip')
                  const mediaId = event.dataTransfer.getData('application/x-ai-video-editor-audio')
                  if (movingClipId) {
                    const next = moveAudioClip(project, movingClipId, target)
                    setProject(next)
                    setSelectedMusicClipId(movingClipId)
                    setSelectedClipId(null)
                  } else if (mediaId) {
                    const asset = project.media.find((item) => item.id === mediaId)
                    if (asset?.hasAudio && !asset.missing) {
                      const next = addAudioToTimeline(project, [asset], target)
                      const added = getMusicClips(next).find((clip) => clip.mediaId === mediaId && !musicClips.some((existing) => existing.id === clip.id))
                      if (next !== project && added) {
                        setProject(next)
                        setSelectedMusicClipId(added.id)
                        setSelectedClipId(null)
                      }
                    }
                  }
                  setDraggedAudioClipId(null)
                }}>
                  {musicClips.map((clip) => {
                    const asset = project.media.find((item) => item.id === clip.mediaId)
                    const selected = selectedMusicClipId === clip.id
                    const visibleDuration = Math.max(0.001, clipDuration(clip))
                    return <div key={clip.id} className={`music-clip ${selected ? 'music-clip-selected' : ''}`} style={{ left: `${clip.position * pixelsPerSecond}px`, width: `${Math.max(28, visibleDuration * pixelsPerSecond - 3)}px` }} draggable={!uiLocked && !project.timeline.tracks.find((track) => track.id === MUSIC_TRACK_ID)?.locked} onDragStart={(event) => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-ai-video-editor-audio-clip', clip.id); setDraggedAudioClipId(clip.id) }} onDragEnd={() => setDraggedAudioClipId(null)} onClick={(event) => { event.stopPropagation(); setSelectedMusicClipId(clip.id); setSelectedClipId(null); seekTo(clip.position) }} title={`${asset?.name ?? t('musicTrack')} · ${formatTime(clipDuration(clip))}`}>
                      {asset?.waveformUrl && <img className="music-waveform" src={asset.waveformUrl} alt="" draggable={false} style={{ width: `${asset.duration / visibleDuration * 100}%`, left: `${-clip.sourceIn / visibleDuration * 100}%` }} />}
                      <span className="music-clip-name"><Music2 size={11} /><span>{asset?.name ?? clip.label ?? t('musicTrack')}</span></span><span className="music-gain-label">{clip.gainDb > 0 ? '+' : ''}{clip.gainDb.toFixed(0)} dB</span>
                    </div>
                  })}
                  {!musicClips.length && <button className="timeline-empty-button music-empty-button" type="button" onClick={() => void importAudio()}><Plus size={13} />{t('importAudio')}</button>}
                </div>
                <div className="timeline-lane subtitle-lane">
                  {project.subtitles.map((subtitle) => <div key={subtitle.id} className={`subtitle-clip ${selectedSubtitleId === subtitle.id ? 'subtitle-clip-selected' : ''}`} title={subtitle.text} style={{ left: `${subtitle.start * pixelsPerSecond}px`, width: `${Math.max(28, (subtitle.end - subtitle.start) * pixelsPerSecond - 2)}px` }} onClick={() => selectSubtitle(subtitle.id)}><span>{subtitle.text}</span></div>)}
                </div>
                <div className="timeline-lane text-lane"><span className="text-lane-hint" title={t('textComingSoon')}>{t('comingSoon')}</span></div>
                <div className="playhead-line timeline-playhead" style={{ left: `${playhead * pixelsPerSecond}px` }}><span /></div>
              </div>
            </div>
          </div>
        </section>
        {activeJob && <div className={`job-footer ${activeJob.status === 'error' ? 'job-error' : ''}`}>
          <span className="job-icon">{activeJob.status === 'running' ? <LoaderCircle className="spin" size={14} /> : activeJob.status === 'completed' ? <Check size={14} /> : <CircleAlert size={14} />}</span><span className="job-label">{activeJob.message}</span><div className="job-progress-track"><i style={{ width: `${activeJob.progress}%` }} /></div><b>{Math.round(activeJob.progress)}%</b>{activeJob.status === 'running' && <button type="button" className="job-cancel" onClick={() => void cancelActiveJob()}><X size={13} /></button>}
        </div>}
      </main>

      <aside className="assistant-sidebar" dir={isArabic ? 'rtl' : 'ltr'}>
<div className="context-inspector">
          <div className="context-inspector-heading"><div><span className="section-kicker">{t('inspector')}</span><h2>{t('properties')}</h2></div><button className="icon-button" type="button" title={t('menuShowInspector')} onClick={() => setShowInspector(false)}><PanelRightClose size={15} /></button></div>
          <div className="context-inspector-body">
            {selectedMusicClip && selectedMusicAsset ? <>
              <div className="inspector-source-card"><span className="inspector-source-icon audio-source"><AudioLines size={17} /></span><div><span className="inspector-kind">{t('assetAudio')}</span><strong title={selectedMusicAsset.name}>{selectedMusicAsset.name}</strong><small>{formatTime(selectedMusicAsset.duration)} · {formatBytes(selectedMusicAsset.sizeBytes)}</small></div></div>
              <section className="inspector-section"><h3>{t('clipTiming')}</h3><div className="inspector-readonly-grid"><div><span>{t('clipPosition')}</span><strong>{formatTime(selectedMusicClip.position, true)}</strong></div><div><span>{t('clipDuration')}</span><strong>{formatTime(clipDuration(selectedMusicClip), true)}</strong></div><div className="inspector-readonly-wide"><span>{t('sourceRange')}</span><strong>{rangeLabel(selectedMusicClip.sourceIn, selectedMusicClip.sourceOut)}</strong></div></div></section>
              <form className="audio-position-form" onSubmit={(event) => { event.preventDefault(); if (!project) return; const position = Number(new FormData(event.currentTarget).get('position')); setProject(moveAudioClip(project, selectedMusicClip.id, position)) }}>
                <label>{t('audioPosition')}<input name="position" type="number" min="0" max="86400" step="0.1" defaultValue={selectedMusicClip.position.toFixed(1)} key={`${selectedMusicClip.id}-position-${selectedMusicClip.position}`} /></label><button className="button button-outline" type="submit" disabled={uiLocked}>{t('moveAudio')}</button>
              </form>
              <form className="trim-form inspector-trim-form" onSubmit={applyAudioTrim}>
                <label>{t('trimStart')}<input name="sourceIn" type="number" min="0" max={selectedMusicAsset.duration} step="0.1" defaultValue={selectedMusicClip.sourceIn.toFixed(1)} key={`${selectedMusicClip.id}-audio-in-${selectedMusicClip.sourceIn}`} /></label>
                <label>{t('trimEnd')}<input name="sourceOut" type="number" min="0.1" max={selectedMusicAsset.duration} step="0.1" defaultValue={selectedMusicClip.sourceOut.toFixed(1)} key={`${selectedMusicClip.id}-audio-out-${selectedMusicClip.sourceOut}`} /></label>
                <button className="button button-outline trim-submit" type="submit" disabled={uiLocked}>{t('applyTrim')}</button>
              </form>
              <label className="gain-control"><span><Volume2 size={14} />{t('audioClipVolume')}<b>{selectedMusicClip.gainDb.toFixed(1)} dB</b></span><input type="range" min="-36" max="12" step="0.5" value={selectedMusicClip.gainDb} disabled={uiLocked} onChange={(event) => setVolumeForAudioClip(Number(event.target.value))} /></label>
              {selectedMusicAsset.missing && <button className="button button-outline inspector-relink" type="button" onClick={() => void relinkMedia(selectedMusicAsset.id)} disabled={uiLocked}><FolderOpen size={14} />{t('relink')}</button>}
              <button className="inspector-delete" type="button" onClick={deleteSelectedAudioClip} disabled={uiLocked}><Trash2 size={14} />{t('removeAudio')}</button>
            </> : selectedClip && selectedAsset ? <>
              <div className="inspector-source-card"><span className="inspector-source-icon video-source"><Film size={17} /></span><div><span className="inspector-kind">{t('assetVideo')}</span><strong title={selectedAsset.name}>{selectedAsset.name}</strong><small>{selectedAsset.width} × {selectedAsset.height} · {selectedAsset.fps.toFixed(0)} FPS</small></div></div>
              <section className="inspector-section"><h3>{t('clipTiming')}</h3><div className="inspector-readonly-grid"><div><span>{t('clipPosition')}</span><strong>{formatTime(selectedClip.position, true)}</strong></div><div><span>{t('clipDuration')}</span><strong>{formatTime(clipDuration(selectedClip), true)}</strong></div><div className="inspector-readonly-wide"><span>{t('sourceRange')}</span><strong>{rangeLabel(selectedClip.sourceIn, selectedClip.sourceOut)}</strong></div></div></section>
              <form className="trim-form inspector-trim-form" onSubmit={applyTrim}>
                <label>{t('trimStart')}<input name="sourceIn" type="number" min="0" max={selectedAsset.duration} step="0.1" defaultValue={selectedClip.sourceIn.toFixed(1)} key={`${selectedClip.id}-in-${selectedClip.sourceIn}`} /></label>
                <label>{t('trimEnd')}<input name="sourceOut" type="number" min="0.1" max={selectedAsset.duration} step="0.1" defaultValue={selectedClip.sourceOut.toFixed(1)} key={`${selectedClip.id}-out-${selectedClip.sourceOut}`} /></label>
                <button className="button button-outline trim-submit" type="submit" disabled={uiLocked}>{t('applyTrim')}</button>
              </form>
              <label className="gain-control"><span><Volume2 size={14} />{t('clipVolume')}<b>{selectedClip.gainDb.toFixed(1)} dB</b></span><input type="range" min="-24" max="12" step="0.5" value={selectedClip.gainDb} disabled={uiLocked} onChange={(event) => setVolumeForClip(Number(event.target.value))} /></label>
              {selectedAsset.missing && <button className="button button-outline inspector-relink" type="button" onClick={() => void relinkMedia(selectedAsset.id)} disabled={uiLocked}><FolderOpen size={14} />{t('relink')}</button>}
              <button className="inspector-delete" type="button" onClick={deleteSelectedClip} disabled={uiLocked}><Trash2 size={14} />{t('deleteClip')}</button>
            </> : <div className="inspector-empty"><SlidersHorizontalFallback /><span>{t('propertiesEmpty')}</span></div>}
          </div>
        </div>
        <div className="assistant-lower-panel">
        <div className="assistant-tabs" role="tablist" aria-label={t('menuTools')}>
          <button className={rightTab === 'assistant' ? 'active' : ''} type="button" role="tab" aria-selected={rightTab === 'assistant'} onClick={() => setRightTab('assistant')}><Sparkles size={14} />AI</button>
          <button className={rightTab === 'transcript' ? 'active' : ''} type="button" role="tab" aria-selected={rightTab === 'transcript'} onClick={() => setRightTab('transcript')}><FileText size={14} />{t('transcript')}</button>
          <button className={rightTab === 'subtitles' ? 'active' : ''} type="button" role="tab" aria-selected={rightTab === 'subtitles'} onClick={() => setRightTab('subtitles')}><Subtitles size={14} />{t('subtitlesTrack')}</button>
          <button className={rightTab === 'history' ? 'active' : ''} type="button" role="tab" aria-selected={rightTab === 'history'} onClick={() => setRightTab('history')}><History size={14} />{t('history')}</button>
        </div>
        {rightTab === 'assistant' ? <>
          <div className="assistant-title-row"><div className="assistant-avatar"><WandSparkles size={18} /></div><div><strong>{t('assistant')}</strong><span><i className="status-dot" />{geminiReady ? t('geminiProviderName') : t('geminiSetupNeeded')}</span></div><button className="icon-button" type="button" title={t('settings')} onClick={() => setShowSettings(true)}><Settings2 size={15} /></button></div>
          <div className="privacy-callout"><HardDrive size={14} /><span>{t('assistantPrivacy')}</span></div>
          <div className="chat-messages" ref={chatScrollRef}>
            {project.chatMessages.length === 0 ? <div className="chat-welcome"><div className="chat-welcome-icon"><Bot size={22} /></div><span className="chat-label">{t('localAgent')}</span><p>{t('assistantWelcome')}</p><div className="suggestion-list">
              <button type="button" disabled={uiLocked} onClick={() => void sendChat(undefined, t('promptRemoveSilence'))}><Waves size={14} />{t('suggestionRemoveSilence')}<span>↗</span></button>
              <button type="button" disabled={uiLocked} onClick={() => void sendChat(undefined, t('promptTikTok'))}><Film size={14} />{t('suggestionTikTok')}<span>↗</span></button>
              <button type="button" disabled={uiLocked} onClick={() => void sendChat(undefined, t('promptSmartEdit'))}><Sparkles size={14} />{t('suggestionSmartEdit')}<span>↗</span></button>
            </div></div> : project.chatMessages.map((message) => <div className={`chat-message ${message.role === 'user' ? 'chat-message-user' : 'chat-message-assistant'}`} key={message.id}>
              {message.role === 'assistant' && <span className="message-avatar"><Sparkles size={12} /></span>}
              <div className="message-body"><div className="message-content">{message.content}</div><span className="message-time">{new Date(message.createdAt).toLocaleTimeString(settings.language, { hour: '2-digit', minute: '2-digit' })}</span></div>
            </div>)}
            {busy && <div className="chat-message chat-message-assistant"><span className="message-avatar"><Sparkles size={12} /></span><div className="message-body"><div className="thinking-indicator"><i /><i /><i /></div><span className="message-time">{t('loading')}</span></div></div>}
            {chatError && <div className="chat-error"><CircleAlert size={14} />{chatError}</div>}
            {pendingPlan && <div className="plan-card"><div className="plan-card-head"><span><WandSparkles size={15} />{t('planReady')}</span><button type="button" onClick={() => setPendingPlan(null)}><X size={14} /></button></div><strong>{pendingPlan.title}</strong><p>{pendingPlan.summary}</p><pre>{pendingPlan.description}</pre><div className="plan-actions"><button type="button" className="button button-primary" onClick={() => void applyProposal()} disabled={!pendingPlan.action}><Check size={14} />{t('applyPlan')}</button><button type="button" className="button button-quiet" onClick={() => setPendingPlan(null)}>{t('dismissPlan')}</button></div></div>}
          </div>
          <form className="chat-composer" onSubmit={(event) => void sendChat(event)}>
            <textarea value={chatDraft} onChange={(event) => setChatDraft(event.target.value)} onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendChat() } }} placeholder={t('askAnything')} rows={2} disabled={uiLocked} />
            <div className="composer-toolbar"><span><span className="composer-dot" />{geminiReady ? t('geminiProviderName') : t('geminiSetupNeeded')}</span><button className="send-button" type="submit" disabled={!chatDraft.trim() || uiLocked} title={t('send')}>{busy ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}</button></div>
          </form>
        </> : rightTab === 'transcript' ? <TranscriptPanel activeAsset={activeAsset} analysis={analysis} search={transcriptSearch} setSearch={setTranscriptSearch} t={t} onAnalyze={() => void runAnalysis(project, activeAsset ? [activeAsset.id] : undefined)} onSetup={() => setShowSettings(true)} onSeek={handleTranscriptSeek} onCaptions={addCaptions} /> : rightTab === 'subtitles' ? <SubtitleEditorPanel subtitles={project.subtitles} selected={selectedSubtitle} duration={duration} t={t} disabled={uiLocked} onAdd={addManualSubtitle} onSelect={selectSubtitle} onSave={saveSubtitle} onDelete={removeSubtitle} /> : <HistoryPanel project={project} t={t} />}
        </div>
      </aside>
    </div>
    {showCreate && <Modal title={t('newProject')} onClose={() => setShowCreate(false)}>
      <form className="modal-form" onSubmit={(event) => void createNewProject(event)}>
        <label className="field-label">{t('projectName')}<input autoFocus value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder={isArabic ? 'مثال: مقابلة البودكاست' : 'e.g. Podcast interview'} maxLength={120} /></label>
        <p className="modal-note"><HardDrive size={15} /> {t('chooseFolder')}. Source media remains in its original location.</p>
        <div className="modal-actions"><button className="button button-quiet" type="button" onClick={() => setShowCreate(false)}>{t('cancel')}</button><button className="button button-primary" type="submit" disabled={busy}><Plus size={16} />{t('create')}</button></div>
      </form>
    </Modal>}
    {showSettings && <SettingsModal settings={settings} t={t} onClose={() => setShowSettings(false)} onSave={applySettings} saved={settingsSaved} onGeminiStatusChange={setGeminiKeyStatus} />}
    {showExport && <ExportModal project={project} value={exportSettings ?? project.exportSettings} duration={duration} t={t} onChange={setExportField} onClose={() => setShowExport(false)} onExport={() => void doExport()} busy={activeJob?.kind === 'export' && activeJob.status === 'running'} locked={uiLocked} />}
    {showShortcuts && <Modal title={t('shortcutsTitle')} onClose={() => setShowShortcuts(false)}><div className="shortcuts-panel">
      <div className="shortcuts-intro"><CircleHelp size={19} /><span>{t('mainNavigation')}</span></div>
      <div className="shortcut-row"><span>{t('shortcutSpace')}</span><kbd>Space</kbd></div>
      <div className="shortcut-row"><span>{t('shortcutSave')}</span><kbd>Ctrl / ⌘ + S</kbd></div>
      <div className="shortcut-row"><span>{t('shortcutUndo')}</span><kbd>Ctrl / ⌘ + Z</kbd></div>
      <div className="shortcut-row"><span>{t('shortcutRedo')}</span><kbd>Ctrl / ⌘ + Shift + Z</kbd><kbd>Ctrl / ⌘ + Y</kbd></div>
    </div></Modal>}
    {toast && <Toast message={toast} onClose={() => setToast('')} t={t} />}
  </div>
}

function MediaRuntimeBanner({ status, t, onRetry }: { status: MediaRuntimeStatus; t: (key: string) => string; onRetry: () => void }) {
  const binaries = [
    { label: 'FFmpeg', check: status.ffmpeg },
    { label: 'FFprobe', check: status.ffprobe }
  ]
  return <section className="media-runtime-banner" role="alert">
    <div className="media-runtime-heading"><CircleAlert size={18} /><div><strong>{t('mediaRuntimeUnavailable')}</strong><span>{t('mediaRuntimeHint')}</span></div></div>
    <div className="media-runtime-binaries">{binaries.map(({ label, check }) => <div className={`media-runtime-item ${check.available ? 'runtime-ok' : 'runtime-error'}`} key={label}>
      <b>{label}</b><span>{check.available ? t('available') : t('missing')}</span>
      <small>{check.version ?? check.error ?? check.path ?? ''}</small>
    </div>)}</div>
    <button className="button button-quiet" type="button" onClick={onRetry}>{t('checkAgain')}</button>
  </section>
}

function TranscriptPanel({ activeAsset, analysis, search, setSearch, t, onAnalyze, onSetup, onSeek, onCaptions }: {
  activeAsset?: MediaAsset; analysis?: AnalysisResult; search: string; setSearch: (value: string) => void; t: (key: string) => string;
  onAnalyze: () => void; onSetup: () => void; onSeek: (segment: TranscriptSegment, mediaId: string) => void; onCaptions: () => void
}) {
  const transcript = analysis?.transcript ?? []
  const query = search.trim().toLocaleLowerCase()
  const matching = query ? transcript.filter((segment) => segment.text.toLocaleLowerCase().includes(query)) : transcript
  const wordCount = transcript.reduce((sum, segment) => sum + (segment.words?.length ?? segment.text.split(/\s+/).filter(Boolean).length), 0)
  return <div className="transcript-panel">
    <div className="side-heading"><div><span className="section-kicker">{t('analysisIndex')}</span><h2>{t('transcript')}</h2></div><button className="icon-button" type="button" title={t('rerunAnalysis')} onClick={onAnalyze}><Activity size={16} /></button></div>
    {activeAsset ? <div className="analysis-target"><span className="media-target-icon"><Film size={14} /></span><div><strong>{activeAsset.name}</strong><small>{formatTime(activeAsset.duration)} · {activeAsset.width}×{activeAsset.height}</small></div><span className={analysis ? 'analysis-check' : 'analysis-pending'}>{analysis ? <Check size={13} /> : <span />}</span></div> : <div className="analysis-placeholder">{t('noMedia')}</div>}
    {analysis ? <>
      <div className="analysis-metrics"><div><strong>{analysis.scenes.length}</strong><span>{t('scenes')}</span></div><div><strong>{analysis.silences.length}</strong><span>{t('silences')}</span></div><div><strong>{wordCount}</strong><span>{t('transcriptWords')}</span></div></div>
      <div className="analysis-signal"><div className="signal-title"><span><AudioLines size={14} />{t('audioLevel')}</span><strong>{analysis.audio.meanVolumeDb === undefined ? '—' : `${analysis.audio.meanVolumeDb.toFixed(1)} dB`}</strong></div><div className="signal-meter"><i style={{ width: `${analysis.audio.meanVolumeDb === undefined ? 0 : Math.max(5, Math.min(100, 100 + analysis.audio.meanVolumeDb))}%` }} /></div>{analysis.audio.clippingDetected && <small className="signal-warning"><CircleAlert size={12} />{t('clipping')}</small>}</div>
      {analysis.warnings.length > 0 && <div className="analysis-warning"><CircleAlert size={14} /><span>{analysis.warnings[0]}</span>{!analysis.transcript.length && <button type="button" onClick={onSetup}>{t('setupWhisper')}</button>}</div>}
      <div className="transcript-search"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('findTranscript')} /><span>{matching.length}</span></div>
      {transcript.length > 0 && <button className="button button-outline captions-button" type="button" onClick={onCaptions}><Captions size={15} />{t('addCaptions')}</button>}
      <div className="transcript-list">
        {matching.length ? matching.map((segment) => <button className="transcript-row" key={segment.id} type="button" onClick={() => activeAsset && onSeek(segment, activeAsset.id)}><span className="transcript-time">{formatTime(segment.start, true)}</span><span className="transcript-text">{segment.text}</span><span className="transcript-play"><Play size={11} fill="currentColor" /></span></button>) : <div className="transcript-empty"><FileText size={20} /><span>{transcript.length ? t('noTranscriptMatches') : t('noTranscript')}</span>{!transcript.length && <small>{t('transcriptHint')}</small>}</div>}
      </div>
      <div className="analysis-subsection"><div className="analysis-subsection-head"><strong><Clapperboard size={14} />{t('sceneIndex')}</strong><span>{analysis.scenes.length}</span></div>{analysis.scenes.slice(0, 10).map((scene, index) => <div className="scene-row" key={`${scene.start}-${index}`}><span className="scene-number">{String(index + 1).padStart(2, '0')}</span><span>{rangeLabel(scene.start, scene.end)}</span><i style={{ width: `${Math.max(20, Math.min(85, (scene.end - scene.start) * 8))}%` }} /></div>)}{analysis.scenes.length > 10 && <small className="more-scenes">+{analysis.scenes.length - 10} more scenes</small>}</div>
      {analysis.silences.length > 0 && <div className="analysis-subsection silence-list"><div className="analysis-subsection-head"><strong><Waves size={14} />{t('silences')}</strong><span>{analysis.silences.length}</span></div>{analysis.silences.slice(0, 6).map((silence, index) => <div className="silence-row" key={`${silence.start}-${index}`}><span>{rangeLabel(silence.start, silence.end)}</span><b>{silence.duration.toFixed(1)}s</b></div>)}</div>}
    </> : <div className="no-analysis-card"><div><Activity size={19} /></div><p>{t('noAnalysis')}</p><button className="button button-primary" type="button" onClick={onAnalyze}><Sparkles size={14} />{t('startAnalysis')}</button><small>FFmpeg · local, background processing</small></div>}
    {analysis && !transcript.length && <div className="transcript-setup-compact"><MicIcon /><span>{t('transcriptHint')}</span><button type="button" onClick={onSetup}>{t('setupWhisper')}</button></div>}
  </div>
}

function SubtitleEditorPanel({ subtitles, selected, duration, t, disabled, onAdd, onSelect, onSave, onDelete }: {
  subtitles: TranscriptSegment[]; selected?: TranscriptSegment; duration: number; t: (key: string) => string; disabled: boolean
  onAdd: () => void; onSelect: (id: string) => void; onSave: (id: string, changes: Pick<TranscriptSegment, 'text' | 'start' | 'end'>) => boolean; onDelete: (id: string) => boolean
}) {
  const [text, setText] = useState(selected?.text ?? '')
  const [start, setStart] = useState(selected ? String(selected.start) : '')
  const [end, setEnd] = useState(selected ? String(selected.end) : '')
  const [error, setError] = useState('')
  useEffect(() => {
    setText(selected?.text ?? '')
    setStart(selected ? String(selected.start) : '')
    setEnd(selected ? String(selected.end) : '')
    setError('')
  }, [selected?.id, selected?.text, selected?.start, selected?.end])
  const ordered = subtitles.slice().sort((a, b) => a.start - b.start)
  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!selected || disabled) return
    const parsedStart = Number(start)
    const parsedEnd = Number(end)
    if (!text.trim() || text.trim().length > 500 || !Number.isFinite(parsedStart) || !Number.isFinite(parsedEnd)
      || parsedStart < 0 || parsedEnd > duration || parsedEnd - parsedStart < 0.08 || parsedEnd - parsedStart > 30) {
      setError(t('subtitleSaveError'))
      return
    }
    const changed = text.trim() !== selected.text || parsedStart !== selected.start || parsedEnd !== selected.end
    if (!changed) { setError(''); return }
    if (!onSave(selected.id, { text, start: parsedStart, end: parsedEnd })) setError(t('subtitleSaveError'))
    else setError('')
  }
  const remove = () => {
    if (selected && !disabled && onDelete(selected.id)) setError('')
  }
  return <div className="subtitle-editor-panel">
    <div className="side-heading"><div><span className="section-kicker">{t('subtitlesTrack')}</span><h2>{t('subtitleEditor')}</h2></div><button className="icon-button" type="button" title={t('addSubtitle')} aria-label={t('addSubtitle')} onClick={onAdd} disabled={disabled || duration < 0.08}><Plus size={16} /></button></div>
    <div className="subtitle-editor-count">{t('subtitleCount').replace('{count}', String(subtitles.length))}<span>{formatTime(duration)}</span></div>
    <div className="subtitle-list">
      {ordered.length ? ordered.map((subtitle, index) => <button key={subtitle.id} type="button" className={`subtitle-list-row ${selected?.id === subtitle.id ? 'subtitle-list-row-selected' : ''}`} onClick={() => onSelect(subtitle.id)}>
        <span className="subtitle-list-index">{String(index + 1).padStart(2, '0')}</span><span className="subtitle-list-time">{formatTime(subtitle.start, true)}</span><span className="subtitle-list-text">{subtitle.text}</span>
      </button>) : <div className="subtitle-editor-empty"><Subtitles size={20} /><span>{t('noSubtitles')}</span><small>{t('subtitleEditorHint')}</small><button className="button button-outline" type="button" onClick={onAdd} disabled={disabled || duration < 0.08}><Plus size={13} />{t('addSubtitle')}</button></div>}
    </div>
    {selected && <form className="subtitle-detail" onSubmit={save}>
      <div className="subtitle-detail-heading"><strong>{t('editSubtitle')}</strong><span>{formatTime(selected.start, true)}–{formatTime(selected.end, true)}</span></div>
      <label className="subtitle-text-field">{t('subtitleText')}<textarea value={text} maxLength={500} rows={3} onChange={(event) => setText(event.target.value)} disabled={disabled} /></label>
      <div className="subtitle-time-fields">
        <label>{t('subtitleStart')}<input type="number" min="0" max={duration} step="0.05" value={start} onChange={(event) => setStart(event.target.value)} disabled={disabled} /></label>
        <label>{t('subtitleEnd')}<input type="number" min="0" max={duration} step="0.05" value={end} onChange={(event) => setEnd(event.target.value)} disabled={disabled} /></label>
      </div>
      {error && <div className="subtitle-form-error" role="alert">{error}</div>}
      <div className="subtitle-detail-actions"><button className="button button-quiet" type="button" onClick={remove} disabled={disabled}><Trash2 size={13} />{t('deleteSubtitle')}</button><button className="button button-primary" type="submit" disabled={disabled}><Check size={13} />{t('saveSubtitle')}</button></div>
    </form>}
  </div>
}

function HistoryPanel({ project, t }: { project: ProjectData; t: (key: string) => string }) {
  return <div className="history-panel"><div className="side-heading"><div><span className="section-kicker">NON-DESTRUCTIVE EDITS</span><h2>{t('history')}</h2></div><History size={17} /></div>
    <div className="history-state"><span className="history-state-icon"><Check size={15} /></span><div><strong>{t('currentVersion')}</strong><small>{t('operationCount').replace('{count}', String(project.operations.length))}</small></div></div>
    {project.operations.length ? <div className="history-list">{project.operations.slice().reverse().map((operation, index) => <div className={`history-row ${index === 0 ? 'history-row-current' : ''}`} key={operation.id}><span className="history-index">{String(project.operations.length - index).padStart(2, '0')}</span><div><strong>{operation.title}</strong><small>{operation.summary}</small><time>{new Date(operation.createdAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</time></div><span className="history-kind">{operation.kind}</span></div>)}</div> : <div className="history-empty"><History size={22} /><span>{t('noEdits')}</span><small>{t('historyHint')}</small></div>}
  </div>
}

function ExportModal({ project, value, duration, t, onChange, onClose, onExport, busy, locked }: {
  project: ProjectData; value: ExportSettings; duration: number; t: (key: string) => string;
  onChange: <K extends keyof ExportSettings>(key: K, value: ExportSettings[K]) => void; onClose: () => void; onExport: () => void; busy: boolean; locked: boolean
}) {
  const height = value.resolution === '720p' ? 720 : value.resolution === '4k' ? 2160 : 1080
  const width = value.aspectRatio === '9:16' ? height : value.aspectRatio === '1:1' ? height : Math.round(height * 16 / 9)
  const outputHeight = value.aspectRatio === '9:16' ? Math.round(height * 16 / 9) : height
  const bitrate = (value.resolution === '4k' ? 28 : value.resolution === '720p' ? 4 : 9) * (value.codec === 'h265' ? 0.65 : value.codec === 'vp9' ? 0.7 : 1) * (value.quality === 'high' ? 1.45 : value.quality === 'small' ? 0.55 : 1)
  const sizeMb = Math.round(duration * (bitrate + 0.192) * 125) / 1000
  const setFormat = (format: ExportSettings['format']) => {
    onChange('format', format)
    if (format === 'webm') onChange('codec', 'vp9')
    else if (value.codec === 'vp9') onChange('codec', 'h264')
  }
  const setCodec = (codec: VideoCodec) => {
    onChange('codec', codec)
    onChange('format', codec === 'vp9' ? 'webm' : value.format === 'webm' ? 'mp4' : value.format)
  }
  return <Modal title={t('exportVideo')} onClose={onClose} wide>
    <div className="export-modal-body">
      <div className="export-settings-grid">
        <label className="field-label">{t('format')}<select value={value.format} onChange={(event) => setFormat(event.target.value as ExportSettings['format'])}><option value="mp4">MP4</option><option value="mov">MOV</option><option value="webm">WebM</option></select></label>
        <label className="field-label">{t('codec')}<select value={value.codec} onChange={(event) => setCodec(event.target.value as VideoCodec)}><option value="h264">H.264 / AVC</option><option value="h265">H.265 / HEVC</option><option value="vp9">VP9</option></select></label>
        <label className="field-label">{t('resolution')}<select value={value.resolution} onChange={(event) => onChange('resolution', event.target.value as ResolutionPreset)}><option value="720p">720p</option><option value="1080p">1080p</option><option value="4k">4K</option></select></label>
        <label className="field-label">{t('aspect')}<select value={value.aspectRatio} onChange={(event) => onChange('aspectRatio', event.target.value as AspectRatio)}><option value="16:9">{t('landscape')}</option><option value="9:16">{t('portrait')}</option><option value="1:1">{t('square')}</option></select></label>
        <label className="field-label">{t('frameRate')}<select value={value.fps} onChange={(event) => onChange('fps', Number(event.target.value))}><option value={24}>24 FPS</option><option value={25}>25 FPS</option><option value={30}>30 FPS</option><option value={50}>50 FPS</option><option value={60}>60 FPS</option></select></label>
        <label className="field-label">{t('quality')}<select value={value.quality} onChange={(event) => onChange('quality', event.target.value as ExportSettings['quality'])}><option value="high">{t('high')}</option><option value="balanced">{t('balanced')}</option><option value="small">{t('small')}</option></select></label>
      </div>
      <div className="export-summary"><div className="export-summary-icon"><Download size={20} /></div><div className="export-summary-main"><strong>{project.name}_export.{value.format}</strong><span>{width} × {outputHeight} · {value.fps} FPS · {value.codec.toUpperCase()}</span></div><div className="export-summary-size"><small>{t('estimatedSize')}</small><b>~{sizeMb < 1000 ? `${sizeMb.toFixed(0)} MB` : `${(sizeMb / 1000).toFixed(2)} GB`}</b></div></div>
      <div className="export-subtitle-note"><Subtitles size={15} />{project.subtitles.length ? `${t('subtitlesBurned')} ${project.subtitles.length} segments` : 'No subtitle clips on the timeline.'}</div>
      <div className="modal-actions export-actions"><button className="button button-quiet" type="button" onClick={onClose} disabled={busy || locked}>{t('cancel')}</button><button className="button button-primary" type="button" onClick={onExport} disabled={!project.timeline.clips.length || busy || locked}>{busy ? <LoaderCircle className="spin" size={15} /> : <Download size={15} />}{busy ? t('busyExport') : t('startExport')}</button></div>
    </div>
  </Modal>
}

function SettingsModal({ settings, t, onClose, onSave, saved, onGeminiStatusChange }: {
  settings: AppSettings; t: (key: string) => string; onClose: () => void; onSave: (settings: AppSettings) => void; saved: boolean
  onGeminiStatusChange: (status: GeminiApiKeyStatus) => void
}) {
  const [draft, setDraft] = useState(settings)
  const [whisperBinary, setWhisperBinary] = useState(settings.whisperBinaryPath)
  const [whisperModel, setWhisperModel] = useState(settings.whisperModelPath)
  const [geminiStatus, setGeminiStatus] = useState<GeminiApiKeyStatus>({ configured: false, secureStorageAvailable: false })
  const [geminiKeyDraft, setGeminiKeyDraft] = useState('')
  const [geminiBusy, setGeminiBusy] = useState(false)
  const [geminiMessage, setGeminiMessage] = useState('')
  const [geminiMessageSuccess, setGeminiMessageSuccess] = useState(false)
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    void window.desktop.getGeminiApiKeyStatus().then((status) => {
      setGeminiStatus(status)
      onGeminiStatusChange(status)
    }).catch(() => setGeminiMessage(t('geminiErrorUnknown')))
  }, [onGeminiStatusChange, t])
  const selectBinary = async () => {
    const path = await window.desktop.pickWhisperBinary()
    if (path) { setWhisperBinary(path); setDraft((current) => ({ ...current, whisperBinaryPath: path })) }
  }
  const selectModel = async () => {
    const path = await window.desktop.pickWhisperModel()
    if (path) { setWhisperModel(path); setDraft((current) => ({ ...current, whisperModelPath: path })) }
  }
  const saveGeminiKey = async () => {
    const key = geminiKeyDraft.trim()
    if (!key) {
      setGeminiMessage(t('geminiErrorMissingKey'))
      setGeminiMessageSuccess(false)
      return
    }
    if (key.length < 20 || key.length > 512 || /[\r\n\0]/.test(key)) {
      setGeminiMessage(t('geminiErrorKeyFormat'))
      setGeminiMessageSuccess(false)
      return
    }
    setGeminiBusy(true)
    setGeminiMessage('')
    try {
      const status = await window.desktop.saveGeminiApiKey(key)
      setGeminiStatus(status)
      onGeminiStatusChange(status)
      setGeminiKeyDraft('')
      setGeminiMessage(status.configured ? t('geminiKeySaved') : t('geminiErrorUnknown'))
      setGeminiMessageSuccess(status.configured)
    } catch {
      setGeminiMessage(!geminiStatus.secureStorageAvailable ? t('geminiErrorStorageUnavailable') : t('geminiErrorUnknown'))
      setGeminiMessageSuccess(false)
    } finally { setGeminiBusy(false) }
  }
  const testGemini = async () => {
    setGeminiBusy(true)
    setGeminiMessage('')
    try {
      const result = await window.desktop.testGeminiConnection(geminiKeyDraft.trim() || undefined)
      setGeminiMessage(result.ok ? t('geminiConnectionSuccess') : t(geminiErrorTranslationKey(result.errorCode)))
      setGeminiMessageSuccess(result.ok)
    } catch {
      setGeminiMessage(t('geminiErrorUnknown'))
      setGeminiMessageSuccess(false)
    } finally { setGeminiBusy(false) }
  }
  const clearGeminiKey = async () => {
    setGeminiBusy(true)
    setGeminiMessage('')
    try {
      const status = await window.desktop.clearGeminiApiKey()
      setGeminiStatus(status)
      onGeminiStatusChange(status)
      setGeminiKeyDraft('')
      setGeminiMessage(t('geminiKeyCleared'))
      setGeminiMessageSuccess(true)
    } catch {
      setGeminiMessage(t('geminiErrorUnknown'))
      setGeminiMessageSuccess(false)
    } finally { setGeminiBusy(false) }
  }
  const save = async (event: FormEvent) => {
    event.preventDefault()
    setLoading(true)
    try { onSave({ ...draft, whisperBinaryPath: whisperBinary, whisperModelPath: whisperModel }) }
    finally { setLoading(false) }
  }
  return <Modal title={t('settings')} onClose={onClose} wide>
    <form className="settings-form" onSubmit={(event) => void save(event)}>
      <div className="settings-section"><div className="settings-section-heading"><span className="settings-icon"><Languages size={17} /></span><div><h3>{t('language')}</h3><p>Arabic · English · Français</p></div></div>
        <label className="field-label inline-setting">{t('language')}<select value={draft.language} onChange={(event) => setDraft({ ...draft, language: event.target.value as UiLanguage })}><option value="ar">العربية</option><option value="en">English</option><option value="fr">Français</option></select></label>
      </div>
      <div className="settings-section gemini-settings-section"><div className="settings-section-heading"><span className="settings-icon gemini-settings-icon"><Sparkles size={17} /></span><div><h3>{t('geminiTitle')}</h3><p>{t('geminiHelp')}</p></div></div>
        <label className="field-label gemini-key-label">{t('geminiApiKey')}<input type="password" value={geminiKeyDraft} onChange={(event) => setGeminiKeyDraft(event.target.value)} placeholder={geminiStatus.configured ? '••••••••••••••••' : t('geminiKeyPlaceholder')} autoComplete="off" autoCapitalize="off" spellCheck={false} maxLength={512} /></label>
        <div className={`gemini-key-status ${geminiStatus.configured && geminiStatus.secureStorageAvailable ? 'gemini-status-ready' : 'gemini-status-warning'}`}><span className="status-dot" />{geminiStatus.secureStorageAvailable ? t(geminiStatus.configured ? 'geminiKeyConfigured' : 'geminiKeyNotConfigured') : t('geminiStorageUnavailable')}</div>
        <div className="gemini-key-actions"><button className="button button-primary" type="button" onClick={() => void saveGeminiKey()} disabled={geminiBusy || !geminiKeyDraft.trim() || !geminiStatus.secureStorageAvailable}><Check size={14} />{t('saveGeminiKey')}</button><button className="button button-outline" type="button" onClick={() => void testGemini()} disabled={geminiBusy || (!geminiKeyDraft.trim() && !geminiStatus.configured)}><Activity size={14} />{t('testGeminiConnection')}</button><button className="button button-quiet" type="button" onClick={() => void clearGeminiKey()} disabled={geminiBusy || !geminiStatus.configured}>{t('clearGeminiKey')}</button></div>
        {geminiMessage && <p className={`gemini-key-message ${geminiMessageSuccess ? 'is-success' : 'is-error'}`} role="status">{geminiMessage}</p>}
      </div>
      <div className="settings-section"><div className="settings-section-heading"><span className="settings-icon whisper-settings-icon"><AudioLines size={17} /></span><div><h3>{t('whisperTitle')}</h3><p>{t('transcriptHint')}</p></div></div>
        <div className="path-setting"><label className="field-label">{t('whisperBinary')}<div className="path-input"><input value={whisperBinary} readOnly placeholder="C:\\whisper.cpp\\whisper-cli.exe" /><button className="button button-outline" type="button" onClick={() => void selectBinary()}>{t('browse')}</button></div></label></div>
        <div className="path-setting"><label className="field-label">{t('whisperModel')}<div className="path-input"><input value={whisperModel} readOnly placeholder="ggml-large-v3-turbo.bin" /><button className="button button-outline" type="button" onClick={() => void selectModel()}>{t('browse')}</button></div></label></div>
      </div>
      <div className="settings-privacy"><HardDrive size={16} /><span><strong>{t('privacy')}</strong><small>{t('settingsAbout')}</small></span></div>
      <div className="settings-footer"><button className="button button-quiet" type="button" onClick={() => void window.desktop.openLogs()}><FileText size={15} />{t('logs')}</button><div><button className="button button-quiet" type="button" onClick={onClose}>{t('cancel')}</button><button className="button button-primary" type="submit" disabled={loading}><Check size={15} />{saved ? t('settingsSaved') : t('save')}</button></div></div>
    </form>
  </Modal>
}

function Modal({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><div className={`modal-card ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
    <div className="modal-header"><div><span className="section-kicker">AI VIDEO EDITOR</span><h2>{title}</h2></div><button className="icon-button" type="button" onClick={onClose}><X size={17} /></button></div>{children}
  </div></div>
}

function Toast({ message, onClose, t }: { message: string; onClose: () => void; t: (key: string) => string }) {
  return <div className="toast-message"><span><Check size={15} /></span><p>{message}</p><button type="button" title={t('toastDismiss')} onClick={onClose}><X size={14} /></button></div>
}

function SlidersHorizontalFallback() {
  return <span className="inspector-fallback"><Gauge size={17} /></span>
}

function MicIcon() {
  return <span className="mic-icon-small"><AudioLines size={15} /></span>
}
