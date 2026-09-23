import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { addMediaToTimeline, createProject, projectDuration, undoEdit } from '../shared/project'
import { sendAgentMessage } from './agentService'
import type { AppSettings, MediaAsset } from '../shared/types'

const integrationMocks = vi.hoisted(() => ({ writeLog: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: () => process.cwd(), isPackaged: false } }))
vi.mock('./logger', () => ({ writeLog: integrationMocks.writeLog }))

const require = createRequire(join(process.cwd(), 'package.json'))
const ffmpegPackagePath = (() => {
  try { return require('ffmpeg-static') as string | null } catch { return null }
})()
const ffprobePackagePath = (() => {
  try { return (require('ffprobe-static') as { path?: string }).path ?? null } catch { return null }
})()

function findPathExecutable(name: string): string | null {
  const windowsExtensions = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')
    : ['']
  for (const directory of (process.env.PATH || '').split(delimiter).filter(Boolean)) {
    for (const extension of windowsExtensions) {
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
const integrationRequested = process.env.RUN_MEDIA_INTEGRATION === '1'

let testRoot = ''

beforeAll(async () => {
  if (!integrationRequested) return
  if (!ffmpegPath || spawnSync(ffmpegPath, ['-version'], { stdio: 'ignore', windowsHide: true }).status !== 0) {
    throw new Error('Real media tests require a runnable FFmpeg. Set FFMPEG_PATH to its full executable path or install ffmpeg on PATH.')
  }
  if (!ffprobePath || spawnSync(ffprobePath, ['-version'], { stdio: 'ignore', windowsHide: true }).status !== 0) {
    throw new Error('Real media tests require a runnable FFprobe. Set FFPROBE_PATH to its full executable path or install ffprobe on PATH.')
  }
  process.env.FFMPEG_PATH = ffmpegPath
  process.env.FFPROBE_PATH = ffprobePath
  testRoot = await mkdtemp(join(tmpdir(), 'ai-video-editor-media-'))
})

afterAll(async () => {
  if (testRoot) await rm(testRoot, { recursive: true, force: true })
})

describe.skipIf(!integrationRequested)('real FFmpeg media pipeline', () => {
  it('probes, thumbnails, analyzes, removes silence, and exports a new subtitled video', async () => {
    const sourceDirectory = join(testRoot, 'Original media عربية with spaces')
    const sourcePath = join(sourceDirectory, 'مصدر vidéo with spaces.mp4')
    const thumbnailPath = join(testRoot, 'thumbnails العربية', 'source image.jpg')
    const waveformPath = join(testRoot, 'waveforms 音声 with spaces', 'source waveform.png')
    const outputPath = join(testRoot, 'exports العربية with spaces', 'edited export.mp4')
    await mkdir(sourceDirectory, { recursive: true })
    const fixture = [
      'color=c=red:s=320x240:r=25:d=2[r]',
      'color=c=blue:s=320x240:r=25:d=2[b]',
      'color=c=green:s=320x240:r=25:d=2[g]',
      'color=c=yellow:s=320x240:r=25:d=2[y]',
      '[r][b][g][y]concat=n=4:v=1:a=0[v]',
      'anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=2[a0]',
      'sine=frequency=1000:sample_rate=48000:duration=2[a1]',
      'anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=2[a2]',
      'sine=frequency=600:sample_rate=48000:duration=2[a3]',
      '[a0][a1][a2][a3]concat=n=4:v=0:a=1[a]'
    ].join(';')
    execFileSync(ffmpegPath, [
      '-hide_banner', '-y', '-loglevel', 'error', '-filter_complex', fixture,
      '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', sourcePath
    ], { stdio: 'pipe', timeout: 90_000 })

    const { probeMedia, createThumbnail, createWaveform, checkMediaRuntime, renderExport } = await import('./mediaEngine')
    const mediaRuntime = await checkMediaRuntime()
    expect(mediaRuntime.ready).toBe(true)
    expect(mediaRuntime.ffmpeg.available).toBe(true)
    expect(mediaRuntime.ffprobe.available).toBe(true)
    const probe = await probeMedia(sourcePath)
    expect(probe.duration).toBeGreaterThan(7.9)
    expect(probe.width).toBe(320)
    expect(probe.height).toBe(240)
    expect(probe.hasAudio).toBe(true)

    const asset: MediaAsset = { ...probe, id: 'integration-source', importedAt: new Date().toISOString() }
    await createThumbnail(sourcePath, thumbnailPath, 1)
    expect((await stat(thumbnailPath)).size).toBeGreaterThan(100)
    await createWaveform(sourcePath, waveformPath)
    const waveform = await readFile(waveformPath)
    expect(waveform.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    expect(waveform.byteLength).toBeGreaterThan(100)

    const settings: AppSettings = {
      language: 'en', ollamaEnabled: false, ollamaModel: 'qwen2.5:7b', whisperBinaryPath: '', whisperModelPath: ''
    }
    const progress: Array<{ value: number; message: string }> = []
    const projectWithMedia = addMediaToTimeline(createProject('FFmpeg integration', testRoot), [asset])
    const response = await sendAgentMessage(projectWithMedia, 'احذف فترات الصمت التي تزيد عن ثانية', settings, 'integration-agent', (value, message) => progress.push({ value, message }))
    const analysis = response.project.analysisByMedia[asset.id]
    expect(analysis.silences).toHaveLength(2)
    expect(analysis.silences[0].start).toBeCloseTo(0, 1)
    expect(analysis.silences[0].duration).toBeCloseTo(2, 1)
    expect(analysis.scenes.length).toBeGreaterThanOrEqual(3)
    expect(analysis.audio.analyzed).toBe(true)
    expect(progress.some((item) => item.value >= 60)).toBe(true)
    expect(response.reply).toContain('Removed 2')
    expect(projectDuration(response.project)).toBeCloseTo(4, 1)
    const social = await sendAgentMessage(response.project, 'Mets la vidéo au format TikTok', { ...settings, language: 'fr' }, 'integration-social', () => undefined)
    expect(social.reply).toContain('Format de sortie')
    expect(social.project.exportSettings.aspectRatio).toBe('9:16')
    expect(social.project.exportSettings.resolution).toBe('1080p')
    expect(social.project.exportSettings.fps).toBe(30)
    expect(undoEdit(social.project).exportSettings).toEqual(response.project.exportSettings)
    const project = {
      ...social.project,
      subtitles: [{ id: 'test-caption', start: 0.2, end: 1.2, text: 'Local FFmpeg export', words: undefined }]
    }
    const exportSettings = { ...project.exportSettings, resolution: '720p' as const, fps: 30, quality: 'small' as const }
    await expect(renderExport({ project, settings: exportSettings }, sourcePath, 'integration-overwrite', () => undefined))
      .rejects.toThrow(/must never overwrite an original video/)
    await expect(renderExport({ project, settings: exportSettings }, sourcePath.slice(0, -4), 'integration-implicit-extension', () => undefined))
      .rejects.toThrow(/must never overwrite an original video/)
    await expect(renderExport({ project, settings: exportSettings }, outputPath.replace('.mp4', '.mov'), 'integration-extension', () => undefined))
      .rejects.toThrow(/extension does not match/)
    expect((await probeMedia(sourcePath)).duration).toBeGreaterThan(7.9)

    const rendered = await renderExport({ project, settings: exportSettings }, outputPath, 'integration-export', () => undefined)
    expect(rendered.outputPath).toBe(outputPath)
    expect((await stat(outputPath)).size).toBeGreaterThan(2_000)
    const exported = await probeMedia(outputPath)
    expect(exported.duration).toBeCloseTo(4, 1)
    expect(exported.width).toBe(720)
    expect(exported.height).toBe(1280)
    expect(exported.fps).toBeCloseTo(30, 0)
    expect(await readFile(join(testRoot, 'cache', 'export-subtitles.ass'), 'utf8')).toContain('Local FFmpeg export')
    expect(existsSync(dirname(outputPath))).toBe(true)
  }, 120_000)
})
