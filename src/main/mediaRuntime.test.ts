import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mockedApp = vi.hoisted(() => ({ isPackaged: false }))
vi.mock('electron', () => ({ app: mockedApp }))
vi.mock('./logger', () => ({ writeLog: vi.fn() }))

import { checkMediaRuntime } from './mediaEngine'

afterEach(() => vi.unstubAllEnvs())

describe('startup media runtime check', () => {
  it('reports missing configured executables instead of silently falling back to PATH', async () => {
    const missingPath = join(tmpdir(), 'ai-video-editor-missing-runtime-binary')
    vi.stubEnv('FFMPEG_PATH', missingPath)
    vi.stubEnv('FFMPEG_BIN', '')
    vi.stubEnv('FFPROBE_PATH', missingPath)

    const status = await checkMediaRuntime()
    expect(status.ready).toBe(false)
    expect(status.packaged).toBe(false)
    expect(status.ffmpeg).toMatchObject({ available: false, path: missingPath, source: 'environment' })
    expect(status.ffmpeg.error).toContain('Configured FFMPEG executable was not found')
    expect(status.ffprobe).toMatchObject({ available: false, path: missingPath, source: 'environment' })
    expect(status.ffprobe.error).toContain('Configured FFPROBE executable was not found')
  })
})
