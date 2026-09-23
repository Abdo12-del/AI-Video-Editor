import { describe, expect, it, vi } from 'vitest'
import type { MediaAsset, TimelineClip } from '../shared/types'

vi.mock('electron', () => ({ app: { isPackaged: false } }))
vi.mock('./logger', () => ({ writeLog: vi.fn() }))

import { buildMusicMixPlan } from './mediaEngine'

const music: MediaAsset = {
  id: 'music-1', name: 'music.wav', filePath: '/private/music.wav', duration: 10, width: 0, height: 0,
  fps: 30, sizeBytes: 1000, hasAudio: true, videoCodec: 'none', audioCodec: 'pcm_s16le', importedAt: new Date(0).toISOString()
}

const musicClip: TimelineClip = {
  id: 'music-clip-1', mediaId: music.id, trackId: 'track-music', position: 2,
  sourceIn: 1, sourceOut: 5, gainDb: -3, label: music.name
}

describe('independent music audio export graph', () => {
  it('trims, gains, delays, and mixes music with the video track audio', () => {
    const plan = buildMusicMixPlan([musicClip], new Map([[music.id, music]]), 2, 8)

    expect(plan.inputPaths).toEqual([music.filePath])
    expect(plan.clipIds).toEqual([musicClip.id])
    expect(plan.audioLabel).toBe('[outa_music_mix]')
    expect(plan.filters[0]).toContain('[2:a:0]atrim=start=1.000:end=5.000')
    expect(plan.filters[0]).toContain('volume=-3.00dB')
    expect(plan.filters[0]).toContain('adelay=2000|2000[musicmix0]')
    expect(plan.filters[1]).toBe('[outa][musicmix0]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[outa_music_mix]')
  })

  it('rejects non-finite clip values before building FFmpeg filters', () => {
    const malformed = [{ ...musicClip, gainDb: Number.NaN }, { ...musicClip, id: 'bad-source', sourceIn: Number.NaN }]
    const plan = buildMusicMixPlan(malformed, new Map([[music.id, music]]), 2, 8)

    expect(plan.inputPaths).toHaveLength(0)
    expect(plan.filters).toHaveLength(0)
    expect(plan.audioLabel).toBe('[outa]')
  })

  it('ignores clips outside the video duration and returns the base mix unchanged when there is nothing to mix', () => {
    const outside = { ...musicClip, position: 8 }
    const plan = buildMusicMixPlan([outside], new Map([[music.id, music]]), 1, 8, '[muted_base]')

    expect(plan.inputPaths).toHaveLength(0)
    expect(plan.filters).toHaveLength(0)
    expect(plan.audioLabel).toBe('[muted_base]')
    expect(plan.clipIds).toHaveLength(0)
  })
})
