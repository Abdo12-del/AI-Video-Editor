declare module 'smartcrop' {
  export interface SmartCropRect {
    x: number
    y: number
    width: number
    height: number
  }

  export interface SmartCropBoost extends SmartCropRect {
    weight: number
  }

  /** Handle-based pixel access so smartcrop.js runs in Node without a DOM canvas. */
  export interface SmartCropImageOperations<Handle = unknown> {
    open(image: unknown): Promise<Handle>
    resample(image: Handle, width: number, height: number): Promise<Handle>
    getData(image: Handle): Promise<{ width: number; height: number; data: Uint8ClampedArray }>
  }

  export interface SmartCropOptions {
    width: number
    height: number
    minScale?: number
    boost?: SmartCropBoost[]
    ruleOfThirds?: boolean
    debug?: boolean
    imageOperations?: SmartCropImageOperations
  }

  export interface SmartCropResult {
    topCrop: SmartCropRect
  }

  const smartcrop: {
    crop(image: unknown, options: SmartCropOptions): Promise<SmartCropResult>
  }
  export default smartcrop
}
