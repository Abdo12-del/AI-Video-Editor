import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import type { IpcMainInvokeEvent } from 'electron'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  addMediaToTimeline,
  getMusicClips,
  getVideoClips,
  projectDuration,
  trimClip
} from '../shared/project'
import type { AppSettings, ProjectData } from '../shared/types'

const journeyMocks = vi.hoisted(() => ({
  showOpenDialog: vi.fn(),
  fromWebContents: vi.fn(() => null),
  generateGeminiTurn: vi.fn(),
  writeLog: vi.fn()
}))

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => process.cwd() },
  BrowserWindow: { fromWebContents: journeyMocks.fromWebContents },
  dialog: { showOpenDialog: journeyMocks.showOpenDialog }
}))
vi.mock('./logger', () => ({ writeLog: journeyMocks.writeLog }))
vi.mock('./geminiProvider', () => ({
  generateGeminiTurn: journeyMocks.generateGeminiTurn,
  GeminiProviderError: class GeminiProviderError extends Error {
    code: string
    constructor(code: string) { super(code); this.code = code }
  }
}))

import { sendAgentMessage } from './agentService'
import { analyzeMedia, checkMediaRuntime, probeMedia, renderExport } from './mediaEngine'
import { createNewProject, getActiveProject, importAudio, importVideos, saveActiveProject } from './projectStore'

const require = createRequire(join(process.cwd(), 'package.json'))
const ffmpegPackagePath = (() => {
  try { return require('ffmpeg-static') as string | null } catch { return null }
})()
const ffprobePackagePath = (() => {
  try { return (require('ffprobe-static') as { path?: string }).path ?? null } catch { return null }
})()

function findPathExecutable(name: string): string | null {
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')
    : ['']
  for (const directory of (process.env.PATH || '').split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension}`)
      try {
        if (statSync(candidate).isFile()) return resolve(candidate)
      } catch {
        // Continue through PATH entries that do not contain this executable.
      }
    }
  }
  return null
}

function resolveTestBinary(environmentName: 'FFMPEG_PATH' | 'FFPROBE_PATH', packagePath: string | null, commandName: string): string | null {
  const override = process.env[environmentName]?.trim()
  if (override) return resolve(override)
  if (packagePath && existsSync(packagePath)) return resolve(packagePath)
  return findPathExecutable(commandName)
}

const ffmpegPath = resolveTestBinary('FFMPEG_PATH', ffmpegPackagePath, 'ffmpeg') ?? ''
const ffprobePath = resolveTestBinary('FFPROBE_PATH', ffprobePackagePath, 'ffprobe') ?? ''
const journeyRequested = process.env.RUN_MEDIA_E2E === '1'
const projectSettings: AppSettings = {
  language: 'en',
  ollamaEnabled: false,
  ollamaModel: 'qwen2.5:7b',
  whisperBinaryPath: '',
  whisperModelPath: ''
}
const progress = vi.fn()
const agentTestKey = 'scripted-agent-integration-secret-not-live'

let workingRoot = ''
let projectRoot = ''
let sourceVideoPath = ''
let sourceMusicPath = ''

function functionTurn(calls: Array<{ name: string; args: Record<string, unknown>; id?: string }>) {
  return {
    modelContent: { role: 'model', parts: calls.map((call) => ({ functionCall: call })) },
    text: '',
    functionCalls: calls
  }
}

function textTurn(text: string) {
  return { modelContent: { role: 'model', parts: [{ text }] }, text, functionCalls: [] }
}

function toolResultFromLastMessage(input: { contents: Array<Record<string, unknown>> }, toolName: string): Record<string, unknown> {
  const lastMessage = input.contents.at(-1) as { parts?: Array<Record<string, unknown>> } | undefined
  const part = lastMessage?.parts?.find((candidate) => {
    const functionResponse = candidate.functionResponse as { name?: unknown } | undefined
    return functionResponse?.name === toolName
  })
  const functionResponse = part?.functionResponse as { response?: { result?: unknown } } | undefined
  const result = functionResponse?.response?.result
  if (!result || typeof result !== 'object') throw new Error(`No ${toolName} function result was returned to the scripted model.`)
  return result as Record<string, unknown>
}

function makeRealFixtures(): void {
  const videoFilter = [
    'color=c=red:s=320x240:r=25:d=4[v0]',
    'color=c=blue:s=320x240:r=25:d=4[v1]',
    'color=c=green:s=320x240:r=25:d=4[v2]',
    'color=c=yellow:s=320x240:r=25:d=4[v3]',
    '[v0][v1][v2][v3]concat=n=4:v=1:a=0[v]',
    'anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=4,asetpts=PTS-STARTPTS[a0]',
    'sine=frequency=1000:sample_rate=48000:duration=4,pan=stereo|c0=c0|c1=c0,asetpts=PTS-STARTPTS[a1]',
    'anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=4,asetpts=PTS-STARTPTS[a2]',
    'sine=frequency=600:sample_rate=48000:duration=4,pan=stereo|c0=c0|c1=c0,asetpts=PTS-STARTPTS[a3]',
    '[a0][a1][a2][a3]concat=n=4:v=0:a=1[a]'
  ].join(';')
  execFileSync(ffmpegPath, [
    '-hide_banner', '-y', '-loglevel', 'error', '-filter_complex', videoFilter,
    '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', sourceVideoPath
  ], { stdio: 'ignore', timeout: 120_000, windowsHide: true })

  const musicFilter = [
    'sine=frequency=440:sample_rate=48000:duration=4,pan=stereo|c0=c0|c1=c0[a0]',
    'sine=frequency=880:sample_rate=48000:duration=4,pan=stereo|c0=c0|c1=c0[a1]',
    '[a0][a1]concat=n=2:v=0:a=1[a]'
  ].join(';')
  execFileSync(ffmpegPath, [
    '-hide_banner', '-y', '-loglevel', 'error', '-filter_complex', musicFilter,
    '-map', '[a]', '-c:a', 'pcm_s16le', '-ar', '48000', '-f', 'wav', sourceMusicPath
  ], { stdio: 'ignore', timeout: 60_000, windowsHide: true })
}

function meanVolumeInBand(filePath: string, start: number, frequency: number): number {
  const result = spawnSync(ffmpegPath, [
    '-hide_banner', '-nostats', '-loglevel', 'info', '-ss', start.toFixed(2), '-t', '0.8', '-i', filePath,
    '-vn', '-af', `bandpass=f=${frequency}:width_type=h:width=35,volumedetect`, '-f', 'null', '-'
  ], { encoding: 'utf8', timeout: 30_000, windowsHide: true })
  if (result.error || result.status !== 0) throw new Error(`Could not verify exported audio band: ${String(result.error ?? result.stderr)}`)
  const match = `${result.stderr}\n${result.stdout}`.match(/mean_volume:\s*(-?(?:Infinity|Inf)|-?\d+(?:\.\d+)?)\s*dB/i)
  if (!match) throw new Error(`FFmpeg did not report mean volume for ${frequency} Hz: ${result.stderr}`)
  return /inf/i.test(match[1]) ? Number.NEGATIVE_INFINITY : Number(match[1])
}

beforeAll(async () => {
  if (!journeyRequested) return
  if (!ffmpegPath || spawnSync(ffmpegPath, ['-version'], { stdio: 'ignore', windowsHide: true }).status !== 0) {
    throw new Error('The editor media journey requires a runnable FFmpeg. Set FFMPEG_PATH to its full executable path or install ffmpeg on PATH.')
  }
  if (!ffprobePath || spawnSync(ffprobePath, ['-version'], { stdio: 'ignore', windowsHide: true }).status !== 0) {
    throw new Error('The editor media journey requires a runnable FFprobe. Set FFPROBE_PATH to its full executable path or install ffprobe on PATH.')
  }
  process.env.FFMPEG_PATH = ffmpegPath
  process.env.FFPROBE_PATH = ffprobePath
  workingRoot = await mkdtemp(join(tmpdir(), 'ai-video-editor-journey-'))
  const originalsDirectory = join(workingRoot, 'Original media العربية 中文 with spaces')
  projectRoot = join(workingRoot, 'Project folder العربية with spaces')
  sourceVideoPath = join(originalsDirectory, 'مصدر vidéo with spaces.mp4')
  sourceMusicPath = join(originalsDirectory, 'موسيقى عربية with spaces.wav')
  await mkdir(originalsDirectory, { recursive: true })
  await mkdir(projectRoot, { recursive: true })
  makeRealFixtures()
}, 180_000)

afterAll(async () => {
  if (workingRoot) await rm(workingRoot, { recursive: true, force: true })
})

describe.skipIf(!journeyRequested)('real media editor journey (FFmpeg real; Gemini responses scripted)', () => {
  it('creates a project, imports and analyzes real media, runs editor tools, trims a Short, and verifies Unicode-path export and audio sync', async () => {
    const runtime = await checkMediaRuntime()
    expect(runtime.ready).toBe(true)
    expect(runtime.packaged).toBe(false)

    const videoHashBefore = createHash('sha256').update(await readFile(sourceVideoPath)).digest('hex')
    const musicHashBefore = createHash('sha256').update(await readFile(sourceMusicPath)).digest('hex')
    const ipcEvent = { sender: {} } as IpcMainInvokeEvent

    journeyMocks.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [projectRoot] })
    const created = await createNewProject(ipcEvent, 'Project العربية with spaces')
    expect(created?.rootPath).toBe(projectRoot)
    expect(await stat(join(projectRoot, 'project.json'))).toBeTruthy()

    journeyMocks.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [sourceVideoPath] })
    const videoImport = await importVideos(ipcEvent)
    expect(videoImport?.warnings).toEqual([])
    expect(videoImport?.assets).toHaveLength(1)
    const videoAsset = videoImport!.assets[0]
    expect(videoAsset.filePath).toBe(sourceVideoPath)
    expect(videoAsset.width).toBe(320)
    expect(videoAsset.hasAudio).toBe(true)
    expect(videoAsset.thumbnailPath && existsSync(videoAsset.thumbnailPath)).toBe(true)
    expect(videoAsset.waveformPath && existsSync(videoAsset.waveformPath)).toBe(true)

    let project = addMediaToTimeline(created!, videoImport!.assets)
    expect(getVideoClips(project)).toHaveLength(1)
    await saveActiveProject(project)
    project = getActiveProject()!

    const analysis = await analyzeMedia(videoAsset, projectRoot, projectSettings, 'journey-analysis', progress)
    expect(analysis.scenes.length).toBeGreaterThanOrEqual(3)
    expect(analysis.silences.length).toBeGreaterThanOrEqual(2)
    expect(analysis.audio.analyzed).toBe(true)
    project = { ...project, analysisByMedia: { ...project.analysisByMedia, [videoAsset.id]: analysis } }
    const originalTimelineClip = getVideoClips(project)[0]
    project = trimClip(project, originalTimelineClip.id, 0.25, videoAsset.duration - 0.25)
    expect(getVideoClips(project)[0].sourceIn).toBeCloseTo(0.25, 2)
    await saveActiveProject(project)

    journeyMocks.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [sourceMusicPath] })
    const audioImport = await importAudio(ipcEvent)
    expect(audioImport?.warnings).toEqual([])
    expect(audioImport?.assets).toHaveLength(1)
    const musicAsset = audioImport!.assets[0]
    expect(musicAsset.hasAudio).toBe(true)
    expect(musicAsset.width).toBe(0)
    project = getActiveProject()!
    expect(project.media.map((asset) => asset.id)).toContain(musicAsset.id)

    expect(projectDuration(project)).toBeCloseTo(15.5, 1)
    journeyMocks.generateGeminiTurn
      .mockResolvedValueOnce(functionTurn([{ id: 'add-music', name: 'add_audio', args: {
        media_id: musicAsset.id, position: 2, source_in: 0, source_out: 8, gain_db: -6
      } }]))
      .mockImplementationOnce(async (_key: string, input: { contents: Array<Record<string, unknown>> }) => {
        const added = toolResultFromLastMessage(input, 'add_audio')
        expect(added.ok).toBe(true)
        expect(typeof added.clipId).toBe('string')
        return functionTurn([{ id: 'trim-music', name: 'trim_audio_clip', args: {
          clip_id: added.clipId, source_in: 0.5, source_out: 7.5
        } }])
      })
      .mockImplementationOnce(async (_key: string, input: { contents: Array<Record<string, unknown>> }) => {
        expect(toolResultFromLastMessage(input, 'trim_audio_clip').ok).toBe(true)
        return functionTurn([{ id: 'caption', name: 'add_subtitle', args: {
          start: 5, end: 7, text: '字幕 مرحبًا'
        } }])
      })
      .mockImplementationOnce(async (_key: string, input: { contents: Array<Record<string, unknown>> }) => {
        expect(toolResultFromLastMessage(input, 'add_subtitle').ok).toBe(true)
        return functionTurn([{ id: 'short', name: 'create_short_from_range', args: {
          start: 4, end: 12, aspect_ratio: '9:16'
        } }])
      })
      .mockImplementationOnce(async (_key: string, input: { contents: Array<Record<string, unknown>> }) => {
        const short = toolResultFromLastMessage(input, 'create_short_from_range')
        expect(short.ok).toBe(true)
        expect(short.reviewRequired).toBe(false)
        return functionTurn([{ id: 'preview', name: 'preview_changes', args: {} }])
      })
      .mockImplementationOnce(async (_key: string, input: { contents: Array<Record<string, unknown>> }) => {
        const preview = toolResultFromLastMessage(input, 'preview_changes')
        expect(preview).toMatchObject({ durationSeconds: 8, clipCount: 1, audioClipCount: 1, subtitleCount: 1, aspectRatio: '9:16' })
        return textTurn('The scripted editor-tool journey completed; the project is ready for local preview and export.')
      })

    const agentResponse = await sendAgentMessage(
      project,
      'Add the imported music, trim it, add a timed caption, create an 8-second vertical Short from 4 to 12 seconds, then preview the actual project state.',
      projectSettings,
      'journey-agent',
      progress,
      agentTestKey
    )
    expect(journeyMocks.generateGeminiTurn).toHaveBeenCalledTimes(6)
    expect(agentResponse.reply).toContain('scripted editor-tool journey')
    expect(agentResponse.project.history.undo.length).toBeGreaterThanOrEqual(5)
    expect(projectDuration(agentResponse.project)).toBeCloseTo(8, 2)
    expect(agentResponse.project.exportSettings.aspectRatio).toBe('9:16')
    expect(agentResponse.project.subtitles).toHaveLength(1)
    expect(agentResponse.project.subtitles[0]).toMatchObject({ start: 1, end: 3, text: '字幕 مرحبًا' })
    expect(getVideoClips(agentResponse.project)[0].sourceIn).toBeCloseTo(4.25, 1)
    expect(getMusicClips(agentResponse.project)[0]).toMatchObject({ position: 0, sourceIn: 2.5, sourceOut: 7.5, gainDb: -6 })
    await saveActiveProject(agentResponse.project)

    const exportPath = join(workingRoot, 'Exports العربية 中文 with spaces', 'Short final.mp4')
    const exportSettings = { ...agentResponse.project.exportSettings, resolution: '720p' as const, fps: 25, quality: 'small' as const }
    const rendered = await renderExport({ project: agentResponse.project, settings: exportSettings }, exportPath, 'journey-export', progress)
    expect(rendered.outputPath).toBe(exportPath)
    expect((await stat(exportPath)).size).toBeGreaterThan(2_000)
    const output = await probeMedia(exportPath)
    expect(output.duration).toBeCloseTo(8, 1)
    expect(output.width).toBe(720)
    expect(output.height).toBe(1280)
    expect(output.hasAudio).toBe(true)

    expect(meanVolumeInBand(exportPath, 0.2, 440)).toBeGreaterThan(-35)
    expect(meanVolumeInBand(exportPath, 2.1, 880)).toBeGreaterThan(-35)
    expect(meanVolumeInBand(exportPath, 6.0, 880)).toBeLessThan(-45)
    expect(await readFile(join(projectRoot, 'cache', 'export-subtitles.ass'), 'utf8')).toContain('字幕 مرحبًا')

    const savedProject = JSON.parse(await readFile(join(projectRoot, 'project.json'), 'utf8')) as ProjectData
    expect(savedProject.exportSettings.aspectRatio).toBe('9:16')
    expect(savedProject.analysisByMedia[videoAsset.id].scenes.length).toBeGreaterThanOrEqual(3)
    expect(savedProject.media.map((asset) => asset.filePath)).toContain(sourceVideoPath)
    expect(savedProject.media.map((asset) => asset.filePath)).toContain(sourceMusicPath)
    expect(createHash('sha256').update(await readFile(sourceVideoPath)).digest('hex')).toBe(videoHashBefore)
    expect(createHash('sha256').update(await readFile(sourceMusicPath)).digest('hex')).toBe(musicHashBefore)
  }, 240_000)
})
