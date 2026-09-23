const { spawnSync } = require('node:child_process')
const { basename, dirname, join } = require('node:path')
const { existsSync } = require('node:fs')

function fail(message) {
  console.error(`Windows release preflight failed: ${message}`)
  process.exit(1)
}

if (process.platform !== 'win32' || process.arch !== 'x64') {
  fail(`run this on Windows x64. Current host is ${process.platform}-${process.arch}; ffmpeg-static installs a host-specific binary, so cross-packaging here could put the wrong executable in the installer.`)
}

let ffmpegPath
let ffprobePath
let electronRoot
const configuredFfmpegBin = process.env.FFMPEG_BIN
try {
  // The release must contain the npm-bundled binary, not an arbitrary host override.
  delete process.env.FFMPEG_BIN
  ffmpegPath = require('ffmpeg-static')
  ffprobePath = require('ffprobe-static').path
  electronRoot = dirname(require.resolve('electron/package.json'))
} catch (error) {
  fail(`required runtime packages could not be resolved: ${String(error)}`)
} finally {
  if (configuredFfmpegBin !== undefined) process.env.FFMPEG_BIN = configuredFfmpegBin
}

function verifyExecutable(label, filePath) {
  if (typeof filePath !== 'string' || !existsSync(filePath)) fail(`${label} executable is missing: ${String(filePath)}`)
  if (basename(filePath).toLowerCase().endsWith('.exe') === false) fail(`${label} is not a Windows .exe: ${filePath}`)
  const result = spawnSync(filePath, ['-version'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 })
  if (result.error || result.status !== 0) {
    fail(`${label} could not run. ${String(result.error ?? result.stderr ?? `exit ${result.status}`)}`)
  }
  const version = String(result.stdout || result.stderr).split(/\r?\n/)[0]?.trim() || 'version unavailable'
  console.log(`${label} available: ${filePath}`)
  console.log(`  ${version}`)
}

verifyExecutable('FFmpeg', ffmpegPath)
verifyExecutable('FFprobe', ffprobePath)
const electronExe = join(electronRoot, 'dist', 'electron.exe')
if (!existsSync(electronExe)) fail(`Electron Windows runtime is missing: ${electronExe}. Re-run npm ci on Windows.`)
console.log(`Electron available: ${electronExe}`)
console.log('Windows x64 runtime preflight passed; NSIS packaging can proceed.')
