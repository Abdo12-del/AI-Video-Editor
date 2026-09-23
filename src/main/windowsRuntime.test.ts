import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { ensureWindowsRuntimeArtifacts } = require('../../scripts/runtime-restore.cjs') as {
  ensureWindowsRuntimeArtifacts: (rootDir?: string) => {
    ready: boolean
    ffmpeg: boolean
    ffprobe: boolean
    electron: boolean
    message: string
  }
}

describe('ensureWindowsRuntimeArtifacts', () => {
  it('restores missing Microsoft Windows runtime files from the installed packages', () => {
    const root = mkdtempSync(join(tmpdir(), 'win-runtime-'))

    const ffmpegDir = join(root, 'node_modules', 'ffmpeg-static')
    const ffprobeDir = join(root, 'node_modules', 'ffprobe-static', 'bin', 'win32', 'x64')
    const electronDir = join(root, 'node_modules', 'electron', 'dist')

    mkdirSync(ffmpegDir, { recursive: true })
    mkdirSync(ffprobeDir, { recursive: true })
    mkdirSync(electronDir, { recursive: true })

    const ffmpegScript = join(ffmpegDir, 'install.js')
    const ffprobeScript = join(ffprobeDir, 'install.js')
    const electronScript = join(root, 'node_modules', 'electron', 'install.js')

    writeFileSync(ffmpegScript, `const fs = require('node:fs'); const path = require('node:path'); const out = path.join(__dirname, 'ffmpeg.exe'); fs.writeFileSync(out, 'fake');`)
    writeFileSync(ffprobeScript, `const fs = require('node:fs'); const path = require('node:path'); const out = path.join(__dirname, 'ffprobe.exe'); fs.writeFileSync(out, 'fake');`)
    writeFileSync(electronScript, `const fs = require('node:fs'); const path = require('node:path'); const out = path.join(__dirname, 'dist', 'electron.exe'); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, 'fake');`)

    try {
      const result = ensureWindowsRuntimeArtifacts(root)
      expect(result.ready).toBe(true)
      expect(result.ffmpeg).toBe(true)
      expect(result.ffprobe).toBe(true)
      expect(result.electron).toBe(true)
      expect(result.message).toContain('Windows runtime artifacts restored')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
