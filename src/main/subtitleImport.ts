import { parse } from '@plussub/srt-vtt-parser'

/* ------------------------------------------------------------------ *
 * Subtitle file import (internal adapter).
 *
 * OurSubtitles → SubtitleImportProvider → PlussubSubtitleParser.
 * The OSS parser only ever sees file text; every timestamp is
 * re-validated here before it can reach the project.
 * ------------------------------------------------------------------ */

export interface ImportedSubtitle {
  start: number
  end: number
  text: string
}

export interface SubtitleImportResult {
  segments: ImportedSubtitle[]
  skipped: number
}

export interface SubtitleImportProvider {
  readonly name: string
  parseFileContent(content: string, fileName: string): SubtitleImportResult
}

const MAX_FILE_BYTES = 5_000_000
const MAX_ENTRIES = 2000

/**
 * Drops WebVTT/SRT cue settings (`align:center position:10%`) from timing
 * lines. The underlying parser misreads trailing settings on VTT end
 * timestamps, so lines are normalized to `START --> END` first.
 */
function stripCueSettings(content: string): string {
  return content.split('\n').map((line) => {
    const arrow = line.indexOf('-->')
    if (arrow < 0) return line
    const left = line.slice(0, arrow).trim()
    const right = line.slice(arrow + 3)
    const end = right.match(/^\s*(\d{1,3}:\d{2}(?::\d{2})?[.,]\d{1,3})/)?.[1]
      ?? right.match(/^\s*(\d{1,3}:\d{2}(?::\d{2})?)/)?.[1]
    if (!left || !end) return line
    return `${left} --> ${end}`
  }).join('\n')
}

function cleanText(raw: string): string {
  return raw
    .replace(/<[^>]{1,60}>/g, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim().replace(/[ \t]{2,}/g, ' '))
    .filter(Boolean)
    .join('\n')
    .slice(0, 500)
}

export class PlussubSubtitleParser implements SubtitleImportProvider {
  readonly name = 'srt-vtt-parser'

  parseFileContent(content: string, fileName: string): SubtitleImportResult {
    const normalized = content.replace(/^﻿/, '')
    if (Buffer.byteLength(normalized, 'utf8') > MAX_FILE_BYTES) {
      throw new Error(`"${fileName}" is larger than the 5 MB subtitle import limit.`)
    }
    let entries: Array<{ from: number; to: number; text: string }>
    try {
      entries = parse(stripCueSettings(normalized)).entries ?? []
    } catch (error) {
      throw new Error(`"${fileName}" could not be parsed as SRT or WebVTT. ${String(error)}`)
    }
    const segments: ImportedSubtitle[] = []
    let skipped = 0
    for (const entry of entries.slice(0, MAX_ENTRIES)) {
      const start = Number(entry.from) / 1000
      const end = Number(entry.to) / 1000
      const text = cleanText(entry.text ?? '')
      if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 0.04 || start < 0 || !text) {
        skipped += 1
        continue
      }
      segments.push({ start: Number(start.toFixed(3)), end: Number(end.toFixed(3)), text })
    }
    if (entries.length > MAX_ENTRIES) skipped += entries.length - MAX_ENTRIES
    segments.sort((left, right) => left.start - right.start || left.end - right.end)
    return { segments, skipped }
  }
}
