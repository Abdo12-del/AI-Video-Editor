import smartcrop from 'smartcrop'

/* ------------------------------------------------------------------ *
 * Content-aware crop planning (internal adapter).
 *
 * OurExport → CropPlannerProvider → SmartCropProvider (smartcrop.js).
 * smartcrop.js only ever sees raw RGBA bytes of low-resolution
 * keyframes; every coordinate stays inside this adapter. Center crop
 * remains the automatic fallback whenever planning fails.
 * ------------------------------------------------------------------ */

export interface RawFrame {
  width: number
  height: number
  data: Uint8ClampedArray
}

export interface CropWindow {
  x: number
  y: number
  width: number
  height: number
}

/** Top-left corner of the chosen window as 0..1 fractions of the analyzed frame. */
export interface CropFractions {
  fx: number
  fy: number
}

export interface CropPlannerProvider {
  readonly name: string
  planCrop(frame: RawFrame, targetWidth: number, targetHeight: number): Promise<CropWindow>
}

interface NodeImageHandle {
  width: number
  height: number
  data: Uint8ClampedArray
}

/** Pure-JS pixel backend: smartcrop.js runs in Electron main with no DOM canvas. */
const nodeImageOperations = {
  open: async (image: RawFrame): Promise<NodeImageHandle> => ({ width: image.width, height: image.height, data: image.data }),
  resample: async (image: NodeImageHandle, width: number, height: number): Promise<NodeImageHandle> => {
    const targetWidth = Math.max(1, Math.round(width))
    const targetHeight = Math.max(1, Math.round(height))
    const output = new Uint8ClampedArray(targetWidth * targetHeight * 4)
    for (let y = 0; y < targetHeight; y += 1) {
      const sourceY = Math.min(image.height - 1, Math.floor((y * image.height) / targetHeight))
      for (let x = 0; x < targetWidth; x += 1) {
        const sourceX = Math.min(image.width - 1, Math.floor((x * image.width) / targetWidth))
        const source = (sourceY * image.width + sourceX) * 4
        const target = (y * targetWidth + x) * 4
        output[target] = image.data[source]
        output[target + 1] = image.data[source + 1]
        output[target + 2] = image.data[source + 2]
        output[target + 3] = image.data[source + 3]
      }
    }
    return { width: targetWidth, height: targetHeight, data: output }
  },
  getData: async (image: NodeImageHandle): Promise<NodeImageHandle> => image
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

function assertValidFrame(frame: RawFrame): void {
  if (!Number.isInteger(frame.width) || !Number.isInteger(frame.height) || frame.width < 8 || frame.height < 8) {
    throw new Error('Crop analysis needs a frame of at least 8×8 pixels.')
  }
  if (!(frame.data instanceof Uint8ClampedArray) || frame.data.length !== frame.width * frame.height * 4) {
    throw new Error('Crop analysis received a frame whose pixel buffer does not match its dimensions.')
  }
}

export class SmartCropProvider implements CropPlannerProvider {
  readonly name = 'smartcrop'

  async planCrop(frame: RawFrame, targetWidth: number, targetHeight: number): Promise<CropWindow> {
    assertValidFrame(frame)
    if (!(targetWidth > 0) || !(targetHeight > 0)) throw new Error('Crop planning needs a positive target size.')
    // boost[] is reserved: a future face/person detector can bias the window without changing this API.
    const result = await smartcrop.crop(frame, { width: targetWidth, height: targetHeight, imageOperations: nodeImageOperations })
    const top = result.topCrop
    if (!top || ![top.x, top.y, top.width, top.height].every((value) => Number.isFinite(value))) {
      throw new Error('The crop engine returned an unreadable window.')
    }
    const width = clamp(Math.round(top.width), 1, frame.width)
    const height = clamp(Math.round(top.height), 1, frame.height)
    return {
      x: clamp(Math.round(top.x), 0, frame.width - width),
      y: clamp(Math.round(top.y), 0, frame.height - height),
      width,
      height
    }
  }
}

export class CenterCropProvider implements CropPlannerProvider {
  readonly name = 'center'

  async planCrop(frame: RawFrame, targetWidth: number, targetHeight: number): Promise<CropWindow> {
    assertValidFrame(frame)
    if (!(targetWidth > 0) || !(targetHeight > 0)) throw new Error('Crop planning needs a positive target size.')
    const scale = Math.min(frame.width / targetWidth, frame.height / targetHeight)
    const width = clamp(Math.round(targetWidth * scale), 1, frame.width)
    const height = clamp(Math.round(targetHeight * scale), 1, frame.height)
    return {
      x: Math.round((frame.width - width) / 2),
      y: Math.round((frame.height - height) / 2),
      width,
      height
    }
  }
}

export function windowToFractions(window: CropWindow, frameWidth: number, frameHeight: number): CropFractions {
  if (!(frameWidth > 0) || !(frameHeight > 0)) return { fx: 0, fy: 0 }
  return { fx: clamp(window.x / frameWidth, 0, 1), fy: clamp(window.y / frameHeight, 0, 1) }
}

/** Exponential moving average over per-keyframe windows; kills reframing jitter. */
export function smoothFractions(points: CropFractions[], alpha = 0.5): CropFractions | null {
  if (!points.length) return null
  const weight = clamp(alpha, 0.05, 1)
  let fx = points[0].fx
  let fy = points[0].fy
  for (const point of points.slice(1)) {
    fx += weight * (point.fx - fx)
    fy += weight * (point.fy - fy)
  }
  return { fx: clamp(fx, 0, 1), fy: clamp(fy, 0, 1) }
}

/**
 * One stable crop window per timeline clip: samples near 25/50/75% so a
 * single transition or black frame cannot hijack the framing. Returns
 * null when every keyframe fails so the caller keeps centered crop.
 */
export async function planClipCropFractions(
  extractFrame: (timeSeconds: number) => Promise<RawFrame>,
  clipStart: number,
  clipEnd: number,
  targetWidth: number,
  targetHeight: number,
  provider: CropPlannerProvider = new SmartCropProvider()
): Promise<CropFractions | null> {
  const duration = clipEnd - clipStart
  if (!(duration > 0)) return null
  const fractions = duration < 1 ? [0.5] : [0.25, 0.5, 0.75]
  const points: CropFractions[] = []
  for (const fraction of fractions) {
    try {
      const frame = await extractFrame(clipStart + duration * fraction)
      const window = await provider.planCrop(frame, targetWidth, targetHeight)
      points.push(windowToFractions(window, frame.width, frame.height))
    } catch {
      // A failed keyframe is skipped; the remaining samples still decide.
    }
  }
  return smoothFractions(points)
}

/**
 * Maps normalized fractions onto FFmpeg `crop=W:H:X:Y` coordinates of the
 * already-scaled frame. Coordinates are even (yuv420p) with a small safety
 * margin so filter rounding can never push the window out of bounds.
 */
export function cropFilterOffsets(
  fractions: CropFractions,
  scaledWidth: number,
  scaledHeight: number,
  targetWidth: number,
  targetHeight: number
): { x: number; y: number } {
  const margin = 4
  const maxX = Math.max(0, Math.round(scaledWidth - targetWidth - margin))
  const maxY = Math.max(0, Math.round(scaledHeight - targetHeight - margin))
  const x = clamp(Math.round(fractions.fx * scaledWidth), 0, maxX) & ~1
  const y = clamp(Math.round(fractions.fy * scaledHeight), 0, maxY) & ~1
  return { x, y }
}
