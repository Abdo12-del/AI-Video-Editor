import { describe, expect, it } from 'vitest'
import { PlussubSubtitleParser } from './subtitleImport'

const parser = new PlussubSubtitleParser()

const SRT_SAMPLE = `1
00:00:01,500 --> 00:00:04,000
Hello <b>world</b>

2
00:00:05,000 --> 00:00:06,250 position:10%,line-left
Second line
line two

3
00:00:08,000 --> 00:00:07,000
Backwards cue

4
00:00:09,000 --> 00:00:10,000

`

const VTT_SAMPLE = `WEBVTT

NOTE this is a comment

00:01.000 --> 00:04.000
Hi <i>there</i>

00:05.500 --> 00:07.000 align:center
Second cue
`

describe('PlussubSubtitleParser (real srt-vtt-parser engine)', () => {
  it('parses SRT cues, strips tags, and drops invalid entries', () => {
    const result = parser.parseFileContent(SRT_SAMPLE, 'caps.srt')
    expect(result.segments).toEqual([
      { start: 1.5, end: 4, text: 'Hello world' },
      { start: 5, end: 6.25, text: 'Second line\nline two' }
    ])
    expect(result.skipped).toBe(2)
  })

  it('parses WebVTT cues and ignores NOTE blocks', () => {
    const result = parser.parseFileContent(VTT_SAMPLE, 'caps.vtt')
    expect(result.segments).toEqual([
      { start: 1, end: 4, text: 'Hi there' },
      { start: 5.5, end: 7, text: 'Second cue' }
    ])
    expect(result.skipped).toBe(0)
  })

  it('tolerates a UTF-8 BOM prefix', () => {
    const result = parser.parseFileContent(`﻿${VTT_SAMPLE}`, 'bom.vtt')
    expect(result.segments).toHaveLength(2)
  })

  it('sorts cues by time and caps pathological files', () => {
    const flipped = `1
00:00:10,000 --> 00:00:12,000
Later

2
00:00:01,000 --> 00:00:02,000
Earlier
`
    const result = parser.parseFileContent(flipped, 'order.srt')
    expect(result.segments.map((segment) => segment.start)).toEqual([1, 10])
    expect(() => parser.parseFileContent('x'.repeat(6_000_000), 'huge.srt')).toThrow(/5 MB/)
  })

  it('rejects non-subtitle files with a named error instead of inventing cues', () => {
    expect(() => parser.parseFileContent('not a subtitle file at all', 'notes.txt')).toThrow(/notes\.txt.*could not be parsed/)
  })
})
