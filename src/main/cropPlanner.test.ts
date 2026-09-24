import { describe, expect, it } from 'vitest'
import {
  CenterCropProvider,
  SmartCropProvider,
  cropFilterOffsets,
  planClipCropFractions,
  smoothFractions,
  windowToFractions,
  type RawFrame
} from './cropPlanner'

function syntheticFrame(hot: [number, number, number, number]): RawFrame {
  const width = 96
  const height = 64
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4
      const inside = x >= hot[0] && x < hot[2] && y >= hot[1] && y < hot[3]
      data[index] = inside ? 230 : 20
      data[index + 1] = inside ? 60 : 22
      data[index + 2] = inside ? 40 : 25
      data[index + 3] = 255
    }
  }
  return { width, height, data }
}

describe('SmartCropProvider (real smartcrop.js engine)', () => {
  it('follows the interesting region instead of the frame center', async () => {
    const provider = new SmartCropProvider()
    expect(provider.name).toBe('smartcrop')
    const left = await provider.planCrop(syntheticFrame([8, 20, 30, 44]), 32, 64)
    const right = await provider.planCrop(syntheticFrame([66, 20, 88, 44]), 32, 64)
    const center = await provider.planCrop(syntheticFrame([38, 20, 58, 44]), 32, 64)
    expect(left.x).toBeLessThan(center.x)
    expect(right.x).toBeGreaterThan(center.x)
    expect(left).toMatchObject({ width: 32, height: 64 })
  })

  it('rejects corrupt frames and targets instead of guessing', async () => {
    const provider = new SmartCropProvider()
    await expect(provider.planCrop({ width: 4, height: 4, data: new Uint8ClampedArray(64) }, 9, 16)).rejects.toThrow(/8×8/)
    await expect(provider.planCrop({ width: 16, height: 16, data: new Uint8ClampedArray(10) }, 9, 16)).rejects.toThrow(/pixel buffer/)
    await expect(provider.planCrop(syntheticFrame([8, 20, 30, 44]), 0, 16)).rejects.toThrow(/positive target/)
  })
})

describe('CenterCropProvider fallback', () => {
  it('returns the centered fill window', async () => {
    const window = await new CenterCropProvider().planCrop(syntheticFrame([8, 20, 30, 44]), 32, 64)
    expect(window).toMatchObject({ x: 32, y: 0, width: 32, height: 64 })
  })
})

describe('crop math', () => {
  it('normalizes windows and smooths jitter across keyframes', () => {
    expect(windowToFractions({ x: 24, y: 0, width: 32, height: 64 }, 96, 64)).toEqual({ fx: 0.25, fy: 0 })
    expect(smoothFractions([])).toBeNull()
    expect(smoothFractions([{ fx: 0, fy: 0 }, { fx: 1, fy: 1 }], 0.5)).toEqual({ fx: 0.5, fy: 0.5 })
  })

  it('maps fractions onto even in-bounds FFmpeg crop offsets', () => {
    // 1920×1080 scaled to cover 1080×1920 → 3413×1920 surface.
    expect(cropFilterOffsets({ fx: 0, fy: 0 }, 3413, 1920, 1080, 1920)).toEqual({ x: 0, y: 0 })
    expect(cropFilterOffsets({ fx: 1, fy: 1 }, 3413, 1920, 1080, 1920)).toEqual({ x: 2328, y: 0 })
    const middle = cropFilterOffsets({ fx: 0.5, fy: 0.5 }, 3413, 1920, 1080, 1920)
    expect(middle.x % 2).toBe(0)
    expect(middle.x).toBeGreaterThan(0)
    expect(middle.x).toBeLessThanOrEqual(2329)
  })

  it('plans one stable window per clip and tolerates failed keyframes', async () => {
    let calls = 0
    const planned = await planClipCropFractions(async () => {
      calls += 1
      if (calls === 2) throw new Error('unreadable keyframe')
      return syntheticFrame([8, 20, 30, 44])
    }, 0, 10, 32, 64)
    expect(calls).toBe(3)
    expect(planned).not.toBeNull()
    expect(planned!.fx).toBeLessThan(0.2)
  })

  it('returns null when every keyframe fails so export keeps centered crop', async () => {
    const planned = await planClipCropFractions(async () => { throw new Error('no frames') }, 0, 10, 32, 64)
    expect(planned).toBeNull()
    expect(await planClipCropFractions(async () => syntheticFrame([8, 20, 30, 44]), 5, 5, 32, 64)).toBeNull()
  })
})
