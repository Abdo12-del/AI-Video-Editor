import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProject } from '../shared/project'
import type { AppSettings } from '../shared/types'

const liveGeminiRequested = process.env.RUN_LIVE_GEMINI === '1'
const apiKey = process.env.GEMINI_API_KEY?.trim() ?? ''

vi.mock('electron', () => ({ app: { isPackaged: false } }))
vi.mock('./logger', () => ({ writeLog: vi.fn().mockResolvedValue(undefined) }))

import { sendAgentMessage } from './agentService'

const settings: AppSettings = {
  language: 'en',
  ollamaEnabled: false,
  ollamaModel: 'qwen2.5:7b',
  whisperBinaryPath: '',
  whisperModelPath: ''
}
const jobReporter = vi.fn()

afterEach(() => vi.clearAllMocks())

describe.skipIf(!liveGeminiRequested)('opt-in live Gemini agent integration (Google API, no model mock)', () => {
  it('connects to Gemini and applies one registered editor tool to a fresh project', async () => {
    if (!apiKey) throw new Error('RUN_LIVE_GEMINI=1 requires GEMINI_API_KEY in the process environment; the key is never printed or stored by this test.')

    const project = createProject('Live Gemini integration', join(tmpdir(), 'ai-video-editor-live-gemini'))
    const response = await sendAgentMessage(
      project,
      'Inspect the project state, then use the registered change_aspect_ratio tool exactly once to set aspect_ratio to 9:16. Do not use any other mutating tool.',
      settings,
      'live-gemini-integration',
      jobReporter,
      apiKey
    )

    expect(response.project.exportSettings.aspectRatio).toBe('9:16')
    expect(response.project.history.undo).toHaveLength(1)
    expect(response.reply.trim().length).toBeGreaterThan(0)
  }, 180_000)
})
