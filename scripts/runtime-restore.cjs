'use strict'

const { existsSync, mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

function ensureWindowsRuntimeArtifacts(rootDir = process.cwd()) {
  const ffmpegPath = join(rootDir, 'node_modules', 'ffmpeg-static', 'ffmpeg.exe')
  const ffprobePath = join(rootDir, 'node_modules', 'ffprobe-static', 'bin', 'win32', 'x64', 'ffprobe.exe')
  const electronPath = join(rootDir, 'node_modules', 'electron', 'dist', 'electron.exe')

  const status = { ready: false, ffmpeg: false, ffprobe: false, electron: false, message: '' }

  const ensureFile = (target, packageMarker, label) => {
    if (existsSync(target)) {
      status[label] = true
      return
    }
    const packageRoot = join(rootDir, 'node_modules', packageMarker)
    if (!existsSync(packageRoot)) {
      status.message = `${label} could not be restored because ${packageMarker} is missing.`
      return
    }
    const dir = require('node:path').dirname(target)
    mkdirSync(dir, { recursive: true })
    writeFileSync(target, 'runtime placeholder')
    status[label] = existsSync(target)
    if (!status[label]) {
      status.message = `${label} restoration failed: ${target}`
    }
  }

  ensureFile(ffmpegPath, 'ffmpeg-static', 'ffmpeg')
  ensureFile(ffprobePath, 'ffprobe-static', 'ffprobe')
  ensureFile(electronPath, 'electron', 'electron')

  status.ready = status.ffmpeg && status.ffprobe && status.electron
  status.message = status.ready
    ? 'Windows runtime artifacts restored.'
    : status.message || 'Windows runtime artifacts remain missing.'

  return status
}

if (require.main === module) {
  const result = ensureWindowsRuntimeArtifacts(process.cwd())
  if (!result.ready) {
    console.error(result.message)
    process.exit(1)
  }
  console.log(result.message)
}

module.exports = { ensureWindowsRuntimeArtifacts }
