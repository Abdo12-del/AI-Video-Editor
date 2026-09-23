import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { app } from 'electron'
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { writeLog } from './logger'
import type {
  AnalysisResult,
  AppSettings,
  ExportRequest,
  ExportSettings,
  ExportResponse,
  JobKind,
  MediaAsset,
  MediaBinaryStatus,
  MediaRuntimeStatus,
  ProjectData,
  Scene,
  SilenceSegment,
  TimelineClip,
  TranscriptSegment,
  VideoQuality
} from '../shared/types'
import { AUDIO_TRACK_ID, clipDuration, getMusicClips, getVideoClips, MUSIC_TRACK_ID, projectDuration } from '../shared/project'

interface ProcessResult {
  stdout: string
  stderr: string
}

interface RunOptions {
  jobId?: string
  timeoutMs?: number
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
}

const activeProcesses = new Map<string, ChildProcessWithoutNullStreams>()
const cancelledJobs = new Set<string>()
const cancellationHandlers = new Map<string, Set<() => void>>()
const MAX_CAPTURE = 10_000_000

type MediaBinaryName = 'ffmpeg' | 'ffprobe'
type MediaBinaryResolution = { path: string | null; source: MediaBinaryStatus['source']; error?: string }

function resolveAsarUnpackedPath(raw: string): string {
  if (!app.isPackaged || !process.resourcesPath || !/app\.asar[\\/]/i.test(raw)) return raw
  const unpacked = raw.replace(/app\.asar(?=[\\/])/i, 'app.asar.unpacked')
  return existsSync(unpacked) ? unpacked : raw
}

function resolveEnvironmentBinary(name: MediaBinaryName): MediaBinaryResolution | null {
  const override = name === 'ffmpeg' ? process.env.FFMPEG_PATH || process.env.FFMPEG_BIN : process.env.FFPROBE_PATH
  if (!override?.trim()) return null
  const path = resolveAsarUnpackedPath(resolve(override.trim()))
  return existsSync(path)
    ? { path, source: 'environment' }
    : { path, source: 'environment', error: `Configured ${name.toUpperCase()} executable was not found at: ${path}` }
}

function resolveBundledBinary(name: MediaBinaryName): MediaBinaryResolution {
  try {
    let bundledPath: string | null | undefined
    if (name === 'ffmpeg') {
      // ffmpeg-static selects the binary downloaded for the current install platform.
      // Ignore its FFMPEG_BIN override in a packaged app so the installed app prefers its own bundled executable.
      const configuredFfmpegBin = process.env.FFMPEG_BIN
      if (app.isPackaged) delete process.env.FFMPEG_BIN
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        bundledPath = require('ffmpeg-static') as string | null
      } finally {
        if (app.isPackaged && configuredFfmpegBin !== undefined) process.env.FFMPEG_BIN = configuredFfmpegBin
      }
    } else {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      bundledPath = (require('ffprobe-static') as { path?: string }).path
    }
    if (bundledPath) {
      const path = resolveAsarUnpackedPath(resolve(bundledPath))
      return existsSync(path)
        ? { path, source: 'bundled' }
        : { path, source: 'missing', error: `Bundled ${name.toUpperCase()} executable is missing: ${path}` }
    }
    return { path: null, source: 'missing', error: `No bundled ${name.toUpperCase()} executable is available for ${process.platform}-${process.arch}.` }
  } catch (error) {
    return { path: null, source: 'missing', error: `Could not resolve bundled ${name.toUpperCase()}: ${String(error)}` }
  }
}

function resolveMediaBinary(name: MediaBinaryName): MediaBinaryResolution {
  const environment = resolveEnvironmentBinary(name)
  if (!app.isPackaged && environment) return environment

  const bundled = resolveBundledBinary(name)
  if (bundled.path && existsSync(bundled.path)) return bundled
  if (environment) return environment
  return bundled
}

function requireMediaBinary(name: MediaBinaryName): string {
  const resolved = resolveMediaBinary(name)
  if (!resolved.path || !existsSync(resolved.path)) {
    const hint = name === 'ffmpeg' ? 'FFMPEG_PATH' : 'FFPROBE_PATH'
    throw new Error(`${resolved.error ?? `${name.toUpperCase()} is unavailable.`} Reinstall the app or set ${hint} to a valid executable. The installed app does not fall back to a system PATH binary.`)
  }
  return resolved.path
}

function getFfmpegPath(): string {
  return requireMediaBinary('ffmpeg')
}

function getFfprobePath(): string {
  return requireMediaBinary('ffprobe')
}

async function checkMediaBinary(name: MediaBinaryName): Promise<MediaBinaryStatus> {
  const resolution = resolveMediaBinary(name)
  if (!resolution.path || !existsSync(resolution.path)) {
    return { available: false, path: resolution.path, source: resolution.source, error: resolution.error ?? `${name.toUpperCase()} executable was not found.` }
  }
  try {
    const { stdout, stderr } = await runCommand(resolution.path, ['-version'], { timeoutMs: 10_000 })
    const version = (stdout || stderr).split(/\r?\n/)[0]?.trim().slice(0, 240) || 'Version could not be read'
    return { available: true, path: resolution.path, source: resolution.source, version }
  } catch (error) {
    return { available: false, path: resolution.path, source: resolution.source, error: `${name.toUpperCase()} exists but failed its startup check: ${String(error)}` }
  }
}

export async function checkMediaRuntime(): Promise<MediaRuntimeStatus> {
  const [ffmpeg, ffprobe] = await Promise.all([checkMediaBinary('ffmpeg'), checkMediaBinary('ffprobe')])
  return {
    checkedAt: new Date().toISOString(),
    packaged: Boolean(app.isPackaged),
    ready: ffmpeg.available && ffprobe.available,
    ffmpeg,
    ffprobe
  }
}

function runCommand(command: string, args: string[], options: RunOptions = {}): Promise<ProcessResult> {
  if (options.jobId && cancelledJobs.has(options.jobId)) return Promise.reject(new Error('Operation cancelled by the user.'))
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { windowsHide: true, shell: false })
    const jobId = options.jobId
    if (jobId) activeProcesses.set(jobId, child)
    let stdout = ''
    let stderr = ''
    let settled = false
    let timer: NodeJS.Timeout | undefined

    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (jobId && activeProcesses.get(jobId) === child) activeProcesses.delete(jobId)
      if (error) reject(error)
      else resolvePromise({ stdout, stderr })
    }

    if (options.timeoutMs) {
      timer = setTimeout(() => {
        child.kill('SIGTERM')
        finish(new Error(`Process timed out after ${Math.round(options.timeoutMs! / 1000)} seconds`))
      }, options.timeoutMs)
    }
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stdout = `${stdout}${text}`.slice(-MAX_CAPTURE)
      options.onStdout?.(text)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stderr = `${stderr}${text}`.slice(-MAX_CAPTURE)
      options.onStderr?.(text)
    })
    child.on('error', (error) => finish(error))
    child.on('close', (code, signal) => {
      if (code === 0) finish()
      else {
        const description = signal ? `terminated by ${signal}` : `exited with code ${code}`
        const detail = stderr.trim().slice(-1800)
        finish(new Error(`${command} ${description}${detail ? `: ${detail}` : ''}`))
      }
    })
  })
}

export function cancelMediaJob(jobId: string): void {
  cancelledJobs.add(jobId)
  for (const handler of cancellationHandlers.get(jobId) ?? []) {
    try { handler() } catch { /* Cancellation is best effort; continue to stop the active media process. */ }
  }
  const child = activeProcesses.get(jobId)
  if (child) child.kill('SIGTERM')
}

export function registerMediaJobCancellation(jobId: string, handler: () => void): () => void {
  if (cancelledJobs.has(jobId)) {
    handler()
    return () => undefined
  }
  const handlers = cancellationHandlers.get(jobId) ?? new Set<() => void>()
  handlers.add(handler)
  cancellationHandlers.set(jobId, handlers)
  return () => {
    handlers.delete(handler)
    if (!handlers.size) cancellationHandlers.delete(jobId)
  }
}

export function consumeCancelledJob(jobId: string): boolean {
  const cancelled = cancelledJobs.has(jobId)
  cancelledJobs.delete(jobId)
  cancellationHandlers.delete(jobId)
  return cancelled
}

export function ensureMediaJobActive(jobId: string): void {
  throwIfCancelled(jobId)
}

function throwIfCancelled(jobId: string): void {
  if (cancelledJobs.has(jobId)) throw new Error('Operation cancelled by the user.')
}

function fractionToNumber(value?: string): number {
  if (!value) return 0
  const [top, bottom] = value.split('/').map(Number)
  if (!Number.isFinite(top)) return 0
  if (Number.isFinite(bottom) && bottom !== 0) return top / bottom
  return top
}

export async function probeMedia(filePath: string): Promise<Omit<MediaAsset, 'id' | 'importedAt' | 'thumbnailPath' | 'thumbnailUrl' | 'previewUrl'>> {
  if (!existsSync(filePath)) throw new Error('The selected video file could not be found.')
  const { stdout } = await runCommand(getFfprobePath(), [
    '-v', 'error',
    '-show_entries', 'format=duration,size,bit_rate:stream=codec_type,codec_name,width,height,r_frame_rate',
    '-of', 'json', filePath
  ], { timeoutMs: 30_000 })
  const data = JSON.parse(stdout) as {
    streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number; r_frame_rate?: string }>
    format?: { duration?: string; size?: string; bit_rate?: string }
  }
  const video = data.streams?.find((stream) => stream.codec_type === 'video')
  const audio = data.streams?.find((stream) => stream.codec_type === 'audio')
  if (!video && !audio) throw new Error('This file contains neither a video nor an audio stream.')
  const fileStat = await stat(filePath)
  const duration = Math.max(0, Number(data.format?.duration) || 0)
  return {
    name: basename(filePath),
    filePath,
    duration,
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    fps: fractionToNumber(video?.r_frame_rate) || 30,
    sizeBytes: Number(data.format?.size) || fileStat.size,
    hasAudio: Boolean(audio),
    videoCodec: video?.codec_name ?? 'none',
    audioCodec: audio?.codec_name
  }
}

export async function createThumbnail(filePath: string, thumbnailPath: string, time: number): Promise<void> {
  await mkdir(dirname(thumbnailPath), { recursive: true })
  const seek = Math.max(0, time).toFixed(3)
  try {
    await runCommand(getFfmpegPath(), [
      '-hide_banner', '-loglevel', 'error', '-ss', seek, '-i', filePath,
      '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', '-y', thumbnailPath
    ], { timeoutMs: 40_000 })
  } catch (error) {
    await rm(thumbnailPath, { force: true })
    throw error
  }
}

export async function extractVisualFramesPerSecond(asset: MediaAsset, outputDirectory: string, jobId: string, onProgress?: (percent: number) => void): Promise<string[]> {
  if (!existsSync(asset.filePath)) throw new Error(`${asset.name} is missing. Relink the source before visual analysis.`)
  if (asset.width <= 0 || asset.height <= 0 || asset.duration <= 0) throw new Error('Visual analysis requires a video source with a readable duration.')
  await mkdir(outputDirectory, { recursive: true })
  const framePattern = join(outputDirectory, 'frame-%06d.jpg')
  let progressBuffer = ''
  await runCommand(getFfmpegPath(), [
    '-hide_banner', '-loglevel', 'error', '-nostats', '-y', '-i', asset.filePath,
    '-map', '0:v:0', '-an', '-vf', 'fps=1,scale=512:-2:flags=fast_bilinear',
    '-q:v', '8', '-start_number', '0', '-progress', 'pipe:1', framePattern
  ], {
    jobId,
    timeoutMs: Math.max(60_000, asset.duration * 3_000),
    onStdout: (chunk) => {
      progressBuffer += chunk
      const values = [...progressBuffer.matchAll(/out_time_ms=(\d+)/g)]
      const latest = values.at(-1)?.[1]
      if (latest) onProgress?.(Math.max(0, Math.min(100, Number(latest) / 1_000_000 / asset.duration * 100)))
      progressBuffer = progressBuffer.slice(-2000)
    }
  })
  const files = (await readdir(outputDirectory))
    .filter((name) => /^frame-\d{6}\.jpg$/i.test(name))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    .map((name) => join(outputDirectory, name))
  if (!files.length) throw new Error('FFmpeg could not extract any still frames from this video.')
  return files
}

export async function extractVisualFrameAt(asset: MediaAsset, timeSeconds: number, outputPath: string, jobId: string): Promise<void> {
  if (!Number.isFinite(timeSeconds) || timeSeconds < 0 || timeSeconds >= asset.duration) throw new Error('Frame timestamp must fall inside the source video.')
  await mkdir(dirname(outputPath), { recursive: true })
  const attempts = [timeSeconds, Math.max(0, timeSeconds - 0.25)]
  let lastError: unknown
  for (const timestamp of attempts) {
    await rm(outputPath, { force: true })
    try {
      await runCommand(getFfmpegPath(), [
        '-hide_banner', '-loglevel', 'error', '-y', '-ss', timestamp.toFixed(3), '-i', asset.filePath,
        '-map', '0:v:0', '-an', '-sn', '-frames:v', '1', '-vf', 'scale=512:-2:flags=fast_bilinear', '-q:v', '8', outputPath
      ], { jobId, timeoutMs: 40_000 })
      if (existsSync(outputPath)) return
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(`FFmpeg did not produce a still frame at ${timeSeconds.toFixed(2)} seconds.${lastError ? ` ${String(lastError)}` : ''}`)
}

export async function createWaveform(filePath: string, waveformPath: string): Promise<void> {
  await mkdir(dirname(waveformPath), { recursive: true })
  try {
    await runCommand(getFfmpegPath(), [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', filePath,
      '-filter_complex', '[0:a:0]aformat=channel_layouts=mono,showwavespic=s=2048x128:scale=sqrt:colors=0x55ddc4[wave]',
      '-map', '[wave]', '-frames:v', '1', waveformPath
    ], { timeoutMs: 60_000 })
  } catch (error) {
    await rm(waveformPath, { force: true })
    throw error
  }
}

function parseSilences(stderr: string, duration: number): SilenceSegment[] {
  const starts = [...stderr.matchAll(/silence_start:\s*(-?[\d.]+)/g)].map((match) => Number(match[1]))
  const ends = [...stderr.matchAll(/silence_end:\s*(-?[\d.]+)/g)].map((match) => Number(match[1]))
  const silences: SilenceSegment[] = []
  for (let index = 0; index < starts.length; index += 1) {
    const start = Math.max(0, starts[index])
    const end = Math.max(start, Math.min(duration, ends[index] ?? duration))
    if (end - start > 0.03) silences.push({ start, end, duration: end - start })
  }
  return silences
}

async function detectSilences(asset: MediaAsset, jobId: string): Promise<SilenceSegment[]> {
  if (!asset.hasAudio) return []
  const { stderr } = await runCommand(getFfmpegPath(), [
    '-hide_banner', '-nostats', '-i', asset.filePath,
    '-vn', '-af', 'silencedetect=noise=-35dB:d=0.30', '-f', 'null', '-'
  ], { jobId, timeoutMs: Math.max(90_000, asset.duration * 8_000) })
  return parseSilences(stderr, asset.duration)
}

async function detectScenes(asset: MediaAsset, jobId: string, report?: (progress: number, message: string) => void): Promise<Scene[]> {
  if (asset.duration < 1) return [{ start: 0, end: asset.duration }]
  let progressBuffer = ''
  const { stderr } = await runCommand(getFfmpegPath(), [
    '-hide_banner', '-nostats', '-i', asset.filePath,
    '-vf', "select='gt(scene,0.34)',showinfo", '-an', '-vsync', '0', '-f', 'null', '-progress', 'pipe:1', '-'
  ], {
    jobId,
    timeoutMs: Math.max(90_000, asset.duration * 12_000),
    onStdout: (chunk) => {
      progressBuffer += chunk
      const latest = [...progressBuffer.matchAll(/out_time_ms=(\d+)/g)].at(-1)?.[1]
      if (latest) {
        const percent = Math.max(0, Math.min(100, Number(latest) / 1_000_000 / asset.duration * 100))
        report?.(percent, `Detecting scene changes (${Math.round(percent)}%)…`)
      }
      progressBuffer = progressBuffer.slice(-2000)
    }
  })
  const times = [...stderr.matchAll(/pts_time:([\d.]+)/g)]
    .map((match) => Number(match[1]))
    .filter((time) => Number.isFinite(time) && time > 0.15 && time < asset.duration - 0.1)
    .sort((a, b) => a - b)
    .filter((time, index, all) => index === 0 || time - all[index - 1] > 0.35)
    .slice(0, 1500)
  const boundaries = [0, ...times, asset.duration]
  return boundaries.slice(0, -1).map((start, index) => ({ start, end: boundaries[index + 1], confidence: 0.5 }))
}

async function analyzeAudio(asset: MediaAsset, jobId: string): Promise<AnalysisResult['audio']> {
  if (!asset.hasAudio) return { clippingDetected: false, silenceCount: 0, analyzed: false }
  try {
    const { stderr } = await runCommand(getFfmpegPath(), [
      '-hide_banner', '-nostats', '-i', asset.filePath,
      '-vn', '-af', 'volumedetect', '-f', 'null', '-'
    ], { jobId, timeoutMs: Math.max(90_000, asset.duration * 7_000) })
    const mean = stderr.match(/mean_volume:\s*(-?[\d.]+)\s*dB/i)
    const peak = stderr.match(/max_volume:\s*(-?[\d.]+)\s*dB/i)
    const maxVolumeDb = peak ? Number(peak[1]) : undefined
    return {
      meanVolumeDb: mean ? Number(mean[1]) : undefined,
      maxVolumeDb,
      clippingDetected: maxVolumeDb !== undefined && maxVolumeDb >= -0.1,
      silenceCount: 0,
      analyzed: true
    }
  } catch (error) {
    if (cancelledJobs.has(jobId)) throw error
    await writeLog('warn', 'audio_analysis_failed', { mediaId: asset.id, error: String(error) })
    return { clippingDetected: false, silenceCount: 0, analyzed: false }
  }
}

function parseWhisperTimestamp(value: unknown, numericUnit: 'seconds' | 'milliseconds' = 'seconds'): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return numericUnit === 'milliseconds' ? value / 1000 : value
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().replace(',', '.')
  if (/^\d+(?:\.\d+)?$/.test(normalized)) return Number(normalized)
  const parts = normalized.split(':').map(Number)
  if (parts.some((part) => !Number.isFinite(part))) return undefined
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return undefined
}

async function transcribeWithWhisper(
  asset: MediaAsset,
  projectRoot: string,
  settings: AppSettings,
  jobId: string,
  progress: (percent: number, message: string) => void
): Promise<TranscriptSegment[]> {
  if (!settings.whisperBinaryPath || !settings.whisperModelPath) return []
  if (!existsSync(settings.whisperBinaryPath) || !existsSync(settings.whisperModelPath)) {
    throw new Error('Whisper executable or model path no longer exists. Review Local AI settings.')
  }
  if (!asset.hasAudio) return []
  const audioPath = join(projectRoot, 'cache', `${asset.id}-16khz.wav`)
  const outputBase = join(projectRoot, 'transcripts', `${asset.id}`)
  await mkdir(dirname(audioPath), { recursive: true })
  await mkdir(dirname(outputBase), { recursive: true })
  progress(78, 'Preparing local speech recognition…')
  await runCommand(getFfmpegPath(), [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', asset.filePath,
    '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', audioPath
  ], { jobId, timeoutMs: Math.max(120_000, asset.duration * 15_000) })
  progress(85, 'Transcribing locally with Whisper…')
  const executable = settings.whisperBinaryPath
  const { stderr } = await runCommand(executable, [
    '-m', settings.whisperModelPath,
    '-f', audioPath,
    '-oj',
    '-of', outputBase,
    '-np'
  ], { jobId, timeoutMs: Math.max(180_000, asset.duration * 45_000) })
  throwIfCancelled(jobId)
  const jsonPath = `${outputBase}.json`
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(jsonPath, 'utf8'))
  } catch (error) {
    throw new Error(`Whisper did not produce a readable JSON transcript. ${stderr.slice(-500)} ${String(error)}`)
  }
  const root = parsed as { transcription?: unknown[]; segments?: unknown[] }
  const rawSegments = root.transcription ?? root.segments ?? []
  const result: TranscriptSegment[] = []
  for (const item of rawSegments) {
    const segment = item as {
      text?: string
      timestamps?: { from?: unknown; to?: unknown }
      offsets?: { from?: unknown; to?: unknown }
      tokens?: Array<{ text?: string; offsets?: { from?: unknown; to?: unknown }; t0?: number; t1?: number }>
    }
    const start = parseWhisperTimestamp(segment.timestamps?.from)
      ?? parseWhisperTimestamp(segment.offsets?.from, 'milliseconds')
    const end = parseWhisperTimestamp(segment.timestamps?.to)
      ?? parseWhisperTimestamp(segment.offsets?.to, 'milliseconds')
    const text = segment.text?.trim()
    if (start === undefined || end === undefined || !text) continue
    const words = (segment.tokens ?? []).flatMap((token) => {
      const wordText = token.text?.trim()
      const from = parseWhisperTimestamp(token.offsets?.from ?? token.t0, 'milliseconds')
      const to = parseWhisperTimestamp(token.offsets?.to ?? token.t1, 'milliseconds')
      if (!wordText || from === undefined || to === undefined || from < start - 0.5 || to > end + 0.5) return []
      return [{ text: wordText, start: Math.max(start, from), end: Math.min(end, to) }]
    })
    result.push({ id: randomUUID(), start, end, text, words: words.length ? words : undefined })
  }
  await writeFile(jsonPath, JSON.stringify(parsed, null, 2), 'utf8')
  return result.sort((a, b) => a.start - b.start)
}

function qualityInfo(asset: MediaAsset): VideoQuality {
  const notes: string[] = []
  if (asset.width <= 0 || asset.height <= 0) notes.push('Audio-only source; video quality is not applicable.')
  else {
    if (asset.width < 1280 || asset.height < 720) notes.push('Source resolution is below 720p.')
    if (asset.fps < 23) notes.push('Source frame rate is below 23 fps.')
  }
  return {
    width: asset.width,
    height: asset.height,
    fps: asset.fps,
    videoCodec: asset.videoCodec,
    notes
  }
}

export type ProgressReporter = (progress: number, message: string, kind?: JobKind) => void

export async function analyzeMedia(
  asset: MediaAsset,
  projectRoot: string,
  settings: AppSettings,
  jobId: string,
  report: ProgressReporter
): Promise<AnalysisResult> {
  if (!existsSync(asset.filePath)) throw new Error(`${asset.name} is missing. Relink the source before analysis.`)
  throwIfCancelled(jobId)
  await writeLog('info', 'analysis_started', { mediaId: asset.id, fileName: asset.name })
  report(4, `Inspecting ${asset.name}…`, 'analysis')
  const silences = await detectSilences(asset, jobId)
  throwIfCancelled(jobId)
  report(32, `Found ${silences.length} silence regions`, 'analysis')
  const scenes = asset.width > 0 && asset.height > 0
    ? await detectScenes(asset, jobId, (progress, message) => report(32 + progress * 0.33, message, 'analysis'))
    : []
  throwIfCancelled(jobId)
  report(65, `Indexed ${scenes.length} scenes`, 'analysis')
  const audio = await analyzeAudio(asset, jobId)
  throwIfCancelled(jobId)
  audio.silenceCount = silences.length
  report(77, 'Scoring audio and image metadata…', 'analysis')
  const warnings: string[] = []
  let transcript: TranscriptSegment[] = []
  if (settings.whisperBinaryPath && settings.whisperModelPath) {
    try {
      transcript = await transcribeWithWhisper(asset, projectRoot, settings, jobId, (percent, message) => report(percent, message, 'transcription'))
    } catch (error) {
      if (cancelledJobs.has(jobId)) throw error
      warnings.push(`Local transcription: ${String(error)}`)
      await writeLog('warn', 'transcription_failed', { mediaId: asset.id, error: String(error) })
    }
  } else {
    warnings.push('Speech-to-text is not configured. Set a Whisper.cpp executable and model in Settings to create a transcript locally.')
  }
  throwIfCancelled(jobId)
  report(98, 'Finishing the analysis index…', 'analysis')
  const result: AnalysisResult = {
    mediaId: asset.id,
    analyzedAt: new Date().toISOString(),
    scenes,
    silences,
    transcript,
    audio,
    quality: qualityInfo(asset),
    warnings
  }
  await writeLog('info', 'analysis_completed', { mediaId: asset.id, silences: silences.length, scenes: scenes.length, transcriptSegments: transcript.length })
  return result
}

function targetSize(settings: ExportSettings): { width: number; height: number } {
  const base = settings.resolution === '720p' ? 720 : settings.resolution === '4k' ? 2160 : 1080
  if (settings.aspectRatio === '9:16') return { width: base, height: Math.round(base * 16 / 9 / 2) * 2 }
  if (settings.aspectRatio === '1:1') return { width: base, height: base }
  return { width: Math.round(base * 16 / 9 / 2) * 2, height: base }
}

function safeNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error('Invalid numeric filter value.')
  return Math.max(0, value).toFixed(3)
}

export interface MusicMixPlan {
  inputPaths: string[]
  filters: string[]
  audioLabel: string
  clipIds: string[]
}

export function buildMusicMixPlan(
  clips: TimelineClip[],
  assetsById: ReadonlyMap<string, MediaAsset>,
  firstInputIndex: number,
  timelineDuration: number,
  baseAudioLabel = '[outa]'
): MusicMixPlan {
  const valid = clips.flatMap((clip) => {
    const asset = assetsById.get(clip.mediaId)
    if (!asset?.hasAudio || !asset.filePath || !Number.isFinite(asset.duration) || asset.duration <= 0
      || !Number.isFinite(clip.position) || !Number.isFinite(clip.sourceIn) || !Number.isFinite(clip.sourceOut)
      || !Number.isFinite(clip.gainDb) || clip.position >= timelineDuration) return []
    const sourceIn = Math.max(0, Math.min(asset.duration, clip.sourceIn))
    const sourceOut = Math.max(sourceIn, Math.min(asset.duration, clip.sourceOut))
    if (sourceOut - sourceIn < 0.025) return []
    return [{ clip, asset, sourceIn, sourceOut, position: Math.max(0, clip.position) }]
  }).sort((left, right) => left.position - right.position)
  const filters: string[] = []
  const labels: string[] = []
  for (let index = 0; index < valid.length; index += 1) {
    const { clip, sourceIn, sourceOut, position } = valid[index]
    const inputIndex = firstInputIndex + index
    const label = `musicmix${index}`
    const delayMs = Math.round(position * 1000)
    const gain = Math.max(-36, Math.min(12, clip.gainDb))
    filters.push(`[${inputIndex}:a:0]atrim=start=${safeNumber(sourceIn)}:end=${safeNumber(sourceOut)},asetpts=PTS-STARTPTS,volume=${gain.toFixed(2)}dB,aresample=48000,aformat=sample_rates=48000:channel_layouts=stereo,adelay=${delayMs}|${delayMs}[${label}]`)
    labels.push(`[${label}]`)
  }
  if (!labels.length) return { inputPaths: [], filters, audioLabel: baseAudioLabel, clipIds: [] }
  const outputLabel = '[outa_music_mix]'
  const mixInputs = [baseAudioLabel, ...labels]
  filters.push(`${mixInputs.join('')}amix=inputs=${mixInputs.length}:duration=first:dropout_transition=0:normalize=0${outputLabel}`)
  return { inputPaths: valid.map((item) => item.asset.filePath), filters, audioLabel: outputLabel, clipIds: valid.map((item) => item.clip.id) }
}

function outputOptions(settings: ExportSettings): string[] {
  const crf = settings.quality === 'high' ? '17' : settings.quality === 'small' ? '27' : '21'
  if (settings.codec === 'vp9') {
    return ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', settings.quality === 'high' ? '27' : settings.quality === 'small' ? '38' : '32', '-deadline', 'good', '-cpu-used', '2']
  }
  if (settings.codec === 'h265') return ['-c:v', 'libx265', '-preset', 'medium', '-crf', crf, ...(settings.format === 'mp4' ? ['-tag:v', 'hvc1'] : [])]
  return ['-c:v', 'libx264', '-preset', 'medium', '-crf', crf]
}

function assTime(seconds: number): string {
  const centiseconds = Math.max(0, Math.round(seconds * 100))
  const hours = Math.floor(centiseconds / 360000)
  const minutes = Math.floor((centiseconds % 360000) / 6000)
  const secs = (centiseconds % 6000) / 100
  return `${hours}:${String(minutes).padStart(2, '0')}:${secs.toFixed(2).padStart(5, '0')}`
}

function assText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\N').replace(/\{/g, '\\{').replace(/\}/g, '\\}')
}

function escapeFilterPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")
}

async function writeSubtitleFile(project: ProjectData, width: number, height: number): Promise<string | null> {
  const subtitles = project.subtitles.filter((item) => item.text.trim() && item.end > item.start).sort((a, b) => a.start - b.start)
  if (!subtitles.length) return null
  const path = join(project.rootPath, 'cache', 'export-subtitles.ass')
  await mkdir(dirname(path), { recursive: true })
  const fontSize = Math.round(Math.min(width, height) * 0.052)
  const content = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,Arial,${fontSize},&H00FFFFFF,&H0000E8FF,&H00101820,&H80071018,1,0,0,0,100,100,0,0,1,3,1,2,50,50,${Math.round(height * 0.055)},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...subtitles.map((item) => `Dialogue: 0,${assTime(item.start)},${assTime(item.end)},Default,,0,0,0,,${assText(item.text)}`)
  ].join('\n')
  await writeFile(path, content, 'utf8')
  return path
}

function approximateBitrate(settings: ExportSettings): number {
  const base = settings.resolution === '720p' ? 4 : settings.resolution === '4k' ? 28 : 9
  const codecFactor = settings.codec === 'h265' ? 0.65 : settings.codec === 'vp9' ? 0.7 : 1
  const qualityFactor = settings.quality === 'high' ? 1.45 : settings.quality === 'small' ? 0.55 : 1
  return base * codecFactor * qualityFactor
}

export function estimateExportSize(duration: number, settings: ExportSettings): number {
  return Math.max(0, duration) * (approximateBitrate(settings) + 0.192) * 1_000_000 / 8
}

async function canonicalFilePath(filePath: string): Promise<string> {
  try { return resolve(await realpath(filePath)) } catch { return resolve(filePath) }
}

function pathsEqual(left: string, right: string): boolean {
  const first = resolve(left)
  const second = resolve(right)
  return process.platform === 'win32' ? first.toLowerCase() === second.toLowerCase() : first === second
}

export async function renderExport(
  request: ExportRequest,
  outputPath: string,
  jobId: string,
  report: ProgressReporter
): Promise<ExportResponse> {
  const { project, settings } = request
  const clips = getVideoClips(project)
  if (!clips.length) throw new Error('Add at least one video clip to the timeline before exporting.')
  const duration = projectDuration(project)
  const embeddedAudioMuted = project.timeline.tracks.find((track) => track.id === AUDIO_TRACK_ID)?.muted ?? false
  const musicTrackMuted = project.timeline.tracks.find((track) => track.id === MUSIC_TRACK_ID)?.muted ?? false
  const musicClips = musicTrackMuted ? [] : getMusicClips(project)
  const usedMediaIds = new Set([...clips, ...musicClips].map((clip) => clip.mediaId))
  for (const asset of project.media) {
    if (usedMediaIds.has(asset.id) && (!existsSync(asset.filePath) || asset.missing)) throw new Error(`Relink ${asset.name} before exporting.`)
  }
  for (const clip of musicClips) {
    const asset = project.media.find((item) => item.id === clip.mediaId)
    if (!asset?.hasAudio) throw new Error(`Music clip ${clip.label ?? clip.id} does not reference an audio-capable source.`)
  }
  const destination = resolve(outputPath)
  const selectedExtension = extname(destination).toLowerCase()
  if (selectedExtension && selectedExtension !== `.${settings.format}`) {
    throw new Error(`The selected filename extension does not match the ${settings.format.toUpperCase()} export format.`)
  }
  const extension = selectedExtension || `.${settings.format}`
  const finalPath = selectedExtension ? destination : `${destination}${extension}`
  const outputIdentity = await canonicalFilePath(finalPath)
  for (const asset of project.media.filter((item) => usedMediaIds.has(item.id))) {
    const sourceIdentity = await canonicalFilePath(asset.filePath)
    if (pathsEqual(sourceIdentity, outputIdentity) || pathsEqual(asset.filePath, finalPath)) {
      throw new Error('Choose a new output file; the export must never overwrite an original video or audio source.')
    }
  }
  await mkdir(dirname(finalPath), { recursive: true })
  const temporaryPath = join(dirname(finalPath), `.${basename(finalPath, extname(finalPath))}-${randomUUID()}.part${extname(finalPath)}`)
  const { width, height } = targetSize(settings)
  const subtitlesPath = await writeSubtitleFile(project, width, height)
  const args = ['-hide_banner', '-y', '-loglevel', 'warning', '-progress', 'pipe:1', '-nostats']
  const assetsById = new Map(project.media.map((asset) => [asset.id, asset]))
  const filters: string[] = []
  const concatInputs: string[] = []
  let inputIndex = 0

  for (let index = 0; index < clips.length; index += 1) {
    const clip = clips[index]
    const asset = assetsById.get(clip.mediaId)
    if (!asset) throw new Error(`Timeline source ${clip.mediaId} is unavailable.`)
    args.push('-i', asset.filePath)
    const start = safeNumber(clip.sourceIn)
    const end = safeNumber(clip.sourceOut)
    const duration = safeNumber(clipDuration(clip))
    const videoLabel = `v${index}`
    const audioLabel = `a${index}`
    filters.push(`[${inputIndex}:v:0]trim=start=${start}:end=${end},setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,format=yuv420p[${videoLabel}]`)
    if (asset.hasAudio) {
      const gain = Math.max(-36, Math.min(12, clip.gainDb))
      filters.push(`[${inputIndex}:a:0]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS,volume=${gain.toFixed(2)}dB,aresample=48000,aformat=sample_rates=48000:channel_layouts=stereo[${audioLabel}]`)
    } else {
      filters.push(`anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${duration},asetpts=PTS-STARTPTS[${audioLabel}]`)
    }
    concatInputs.push(`[${videoLabel}][${audioLabel}]`)
    inputIndex += 1
  }
  filters.push(`${concatInputs.join('')}concat=n=${clips.length}:v=1:a=1[outv][outa]`)
  let mappedVideo = '[outv]'
  if (subtitlesPath) {
    filters.push(`[outv]subtitles=filename='${escapeFilterPath(subtitlesPath)}'[outcaption]`)
    mappedVideo = '[outcaption]'
  }
  let baseAudioLabel = '[outa]'
  if (embeddedAudioMuted) {
    filters.push('[outa]volume=0[audio_muted]')
    baseAudioLabel = '[audio_muted]'
  }
  const musicMix = buildMusicMixPlan(musicClips, assetsById, clips.length, duration, baseAudioLabel)
  for (const inputPath of musicMix.inputPaths) args.push('-i', inputPath)
  filters.push(...musicMix.filters)
  args.push('-filter_complex', filters.join(';'), '-map', mappedVideo, '-map', musicMix.audioLabel, ...outputOptions(settings))
  args.push('-r', String(Math.max(1, Math.min(120, Math.round(settings.fps)))))
  if (settings.codec === 'vp9') args.push('-c:a', 'libopus', '-b:a', '160k')
  else args.push('-c:a', 'aac', '-b:a', '192k')
  if (settings.format !== 'webm') args.push('-movflags', '+faststart')
  args.push(temporaryPath)

  await writeLog('info', 'export_started', { projectId: project.id, output: finalPath, duration, settings })
  report(0, 'Preparing FFmpeg export…', 'export')
  try {
    let progressText = ''
    await runCommand(getFfmpegPath(), args, {
      jobId,
      timeoutMs: Math.max(180_000, duration * 30_000),
      onStdout: (chunk) => {
        progressText += chunk
        const lines = progressText.split(/\r?\n/)
        progressText = lines.pop() ?? ''
        for (const line of lines) {
          const match = line.match(/^out_time_ms=(\d+)/)
          if (match) {
            const seconds = Number(match[1]) / 1_000_000
            const percent = Math.min(99, Math.max(1, seconds / Math.max(0.1, duration) * 100))
            report(percent, `Rendering ${percent.toFixed(0)}%`, 'export')
          }
        }
      }
    })
    throwIfCancelled(jobId)
    if (existsSync(finalPath)) await rm(finalPath, { force: true })
    await rename(temporaryPath, finalPath)
    const finalStat = await stat(finalPath)
    report(100, 'Export complete', 'export')
    await writeLog('info', 'export_completed', { projectId: project.id, output: finalPath, sizeBytes: finalStat.size })
    return { outputPath: finalPath, duration, estimatedSizeBytes: finalStat.size }
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    await writeLog('error', 'export_failed', { projectId: project.id, error: String(error) })
    throw error
  }
}

export async function transcribeMedia(
  asset: MediaAsset,
  projectRoot: string,
  settings: AppSettings,
  jobId: string,
  report: ProgressReporter
): Promise<TranscriptSegment[]> {
  return transcribeWithWhisper(asset, projectRoot, settings, jobId, (percent, message) => report(percent, message, 'transcription'))
}

export async function loadWhisperTranscript(
  asset: MediaAsset,
  projectRoot: string,
  settings: AppSettings,
  jobId: string,
  report: ProgressReporter
): Promise<TranscriptSegment[]> {
  const outputPath = join(projectRoot, 'transcripts', `${asset.id}.json`)
  if (!settings.whisperBinaryPath || !settings.whisperModelPath) throw new Error('Set a Whisper.cpp executable and model in Settings first.')
  if (existsSync(outputPath)) {
    try {
      const stored = JSON.parse(await readFile(outputPath, 'utf8')) as { transcription?: unknown[]; segments?: unknown[] }
      const rows = stored.transcription ?? stored.segments
      if (Array.isArray(rows) && rows.length && (rows[0] as { start?: unknown }).start !== undefined) {
        return rows as TranscriptSegment[]
      }
    } catch {
      // Regenerate invalid or old cached output below.
    }
  }
  const analysis = await analyzeMedia(asset, projectRoot, settings, jobId, report)
  return analysis.transcript
}
