import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MediaRuntimeStatus } from '../shared/types'

const state = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => unknown>(),
  analyzeVideoVisuals: vi.fn(),
  analyzeMedia: vi.fn(),
  getGeminiApiKey: vi.fn(),
  activeProject: null as unknown
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, listener: (...args: any[]) => unknown) => state.handlers.set(channel, listener) },
  BrowserWindow: { fromWebContents: vi.fn() },
  dialog: {},
  shell: {}
}))
vi.mock('./mediaEngine', () => ({
  cancelMediaJob: vi.fn(), consumeCancelledJob: vi.fn(), analyzeMedia: state.analyzeMedia,
  checkMediaRuntime: vi.fn(), renderExport: vi.fn(), transcribeMedia: vi.fn()
}))
vi.mock('./logger', () => ({ getLogPath: vi.fn(), writeLog: vi.fn() }))
vi.mock('./projectStore', () => ({
  createNewProject: vi.fn(), getActiveProject: () => state.activeProject,
  getActiveProjectFile: vi.fn(() => 'project.json'), importAudio: vi.fn(), importVideos: vi.fn(),
  normalizeIncomingProject: vi.fn((project: unknown) => project), openExistingProject: vi.fn(),
  openProjectAtPath: vi.fn(), relinkMissingMedia: vi.fn(), saveActiveProject: vi.fn()
}))
vi.mock('./settingsStore', () => ({ loadSettings: vi.fn(), saveSettings: vi.fn() }))
vi.mock('./agentService', () => ({ sendAgentMessage: vi.fn() }))
vi.mock('./videoUnderstanding', () => ({ analyzeVideoVisuals: state.analyzeVideoVisuals }))
vi.mock('./geminiKeyStore', () => ({
  clearGeminiApiKey: vi.fn(), getGeminiApiKey: state.getGeminiApiKey,
  getGeminiApiKeyStatus: vi.fn(), saveGeminiApiKey: vi.fn()
}))
vi.mock('./geminiProvider', () => ({
  GeminiProviderError: class GeminiProviderError extends Error {}, testGeminiApiKey: vi.fn()
}))

import { registerIpcHandlers } from './ipc'

const runtime: MediaRuntimeStatus = {
  checkedAt: new Date(0).toISOString(), packaged: false, ready: true,
  ffmpeg: { available: true, path: 'ffmpeg', source: 'environment' },
  ffprobe: { available: true, path: 'ffprobe', source: 'environment' }
}

describe('visual-analysis IPC privacy guard', () => {
  beforeEach(() => {
    state.handlers.clear()
    vi.clearAllMocks()
    registerIpcHandlers(runtime)
  })

  it('rejects an absent or false consent flag before reading the API key or extracting/sending any frames', async () => {
    const handler = state.handlers.get('media:analyze-visuals')
    expect(handler).toBeTypeOf('function')
    const event = { sender: { send: vi.fn() } }
    await expect(handler!(event, {} as never, 'media-1', 'visual-job')).rejects.toThrow('Explicit user confirmation is required')
    await expect(handler!(event, {} as never, 'media-1', 'visual-job', false)).rejects.toThrow('Explicit user confirmation is required')
    expect(state.getGeminiApiKey).not.toHaveBeenCalled()
    expect(state.analyzeMedia).not.toHaveBeenCalled()
    expect(state.analyzeVideoVisuals).not.toHaveBeenCalled()
  })
})
