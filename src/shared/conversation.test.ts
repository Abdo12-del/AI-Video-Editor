import { describe, expect, it } from 'vitest'
import {
  classifyShortReply,
  extractDurationSeconds,
  extractPercent,
  isShortMessage,
  looksLikeFocusedCommand,
  normalizeConversationText,
  resolveReferences
} from './conversation'
import { addMediaToTimeline, createProject } from './project'
import type { MediaAsset, ProjectData } from './types'

function asset(id: string, name: string, duration: number, hasAudio = true): MediaAsset {
  return {
    id, name, filePath: `/private/source/${name}`, duration,
    width: 1920, height: 1080, fps: 30, sizeBytes: 1024, hasAudio,
    videoCodec: 'h264', audioCodec: 'aac', importedAt: new Date().toISOString()
  }
}

function twoClipProject(): ProjectData {
  let project = createProject('Refs', '/tmp/aivideo-refs')
  project = addMediaToTimeline(project, [asset('media-1', 'One.mp4', 60), asset('media-2', 'Two.mp4', 60)])
  return project
}

describe('normalizeConversationText', () => {
  it('strips Arabic diacritics and tatweel', () => {
    expect(normalizeConversationText('نَعَم')).toBe('نعم')
    expect(normalizeConversationText('نــعم')).toBe('نعم')
  })
  it('unifies alef forms and maps ة→ه / ى→ي', () => {
    expect(normalizeConversationText('أكمل')).toBe('اكمل')
    expect(normalizeConversationText('ثانية')).toBe('ثانيه')
    expect(normalizeConversationText('الأولى')).toBe('الاولي')
  })
  it('converts Arabic-Indic digits and strips French accents', () => {
    expect(normalizeConversationText('٥٠٪')).toBe('50٪')
    expect(normalizeConversationText('Exécute.')).toBe('execute')
    expect(normalizeConversationText('D’accord, vas-y !')).toBe('d accord vas y')
  })
})

describe('isShortMessage', () => {
  it('accepts bare references and short replies only', () => {
    expect(isShortMessage('نعم')).toBe(true)
    expect(isShortMessage('the second clip')).toBe(true)
    expect(isShortMessage('')).toBe(false)
    expect(isShortMessage('Add the imported theme and mute that track.')).toBe(false)
  })
})

describe('classifyShortReply', () => {
  const table: Array<[string, ReturnType<typeof classifyShortReply>]> = [
    // Arabic confirm
    ['نعم', 'confirm'], ['نعم.', 'confirm'], ['أيوه', 'confirm'], ['تمام', 'confirm'],
    ['تمام، نفذ', 'confirm'], ['نفذ', 'confirm'], ['نفذها', 'confirm'], ['حاضر', 'confirm'],
    ['ماشي', 'confirm'], ['أجل', 'confirm'],
    // Arabic cancel (refusal wins over any confirm word)
    ['لا', 'cancel'], ['لا، اتركه', 'cancel'], ['لا أريد ذلك', 'cancel'],
    ['إلغاء', 'cancel'], ['بلاش', 'cancel'], ['مش عايز', 'cancel'],
    // Arabic continue
    ['أكمل', 'continue'], ['تابع', 'continue'], ['كمل', 'continue'],
    // English
    ['yes', 'confirm'], ['Yes, do it.', 'confirm'], ['ok', 'confirm'], ['go ahead', 'confirm'],
    ['no', 'cancel'], ['No, leave it', 'cancel'], ['cancel', 'cancel'],
    ['continue', 'continue'], ['go on', 'continue'],
    // French
    ['oui', 'confirm'], ['Oui.', 'confirm'], ["D'accord.", 'confirm'], ['vas-y', 'confirm'],
    ['Exécute.', 'confirm'], ['non', 'cancel'], ['Non, laisse-le', 'cancel'], ['annule', 'cancel'],
    ['continue', 'continue'], ['poursuis', 'continue'],
    // Explicit values
    ['50%', 'input'], ['50%.', 'input'], ['40 بالمئة', 'input'], ['نصف', 'input'],
    ['30 seconds', 'input'], ['30 ثانية', 'input'],
    // Questions
    ['أي مقطع؟', 'question'], ['which one?', 'question'], ['lequel ?', 'question'],
    // Fresh requests / noise
    ['', 'none'], ['احذف فترات الصمت الطويلة من فضلك', 'none'],
    ['Add the imported theme and mute that track.', 'none'],
    ['Make the video vertical, raise volume, and add a caption.', 'none']
  ]
  it.each(table)('%s → %s', (input, expected) => {
    expect(classifyShortReply(input)).toBe(expected)
  })
})

describe('extractPercent', () => {
  it('reads percents with units, bare numbers, and halves', () => {
    expect(extractPercent('50%')).toBe(50)
    expect(extractPercent('50%.')).toBe(50)
    expect(extractPercent('40 بالمئة')).toBe(40)
    expect(extractPercent('50')).toBe(50)
    expect(extractPercent('نصف')).toBe(50)
    expect(extractPercent('half')).toBe(50)
    expect(extractPercent('0%')).toBe(0)
  })
  it('clamps to 0–200 and ignores plain clip numbers', () => {
    expect(extractPercent('300%')).toBe(200)
    expect(extractPercent('clip 2')).toBeUndefined()
    expect(extractPercent('no number here')).toBeUndefined()
  })
})

describe('extractDurationSeconds', () => {
  it('reads seconds, minutes, and word durations', () => {
    expect(extractDurationSeconds('30 seconds')).toBe(30)
    expect(extractDurationSeconds('30 ثانية')).toBe(30)
    expect(extractDurationSeconds('30s')).toBe(30)
    expect(extractDurationSeconds('2 minutes')).toBe(120)
    expect(extractDurationSeconds('half a second')).toBe(0.5)
    expect(extractDurationSeconds('deux secondes')).toBe(2)
  })
  it('clamps and ignores bare ordinals', () => {
    expect(extractDurationSeconds('5000 seconds')).toBe(3600)
    expect(extractDurationSeconds('clip 2')).toBeUndefined()
    expect(extractDurationSeconds('hello')).toBeUndefined()
  })
})

describe('looksLikeFocusedCommand', () => {
  it('detects imperatives with attached pronouns', () => {
    expect(looksLikeFocusedCommand('احذفه')).toBe(true)
    expect(looksLikeFocusedCommand('قصه')).toBe(true)
    expect(looksLikeFocusedCommand('delete it')).toBe(true)
    expect(looksLikeFocusedCommand('نعم')).toBe(false)
    expect(looksLikeFocusedCommand('hello world')).toBe(false)
  })
})

describe('resolveReferences', () => {
  it('resolves ordinals across languages', () => {
    const project = twoClipProject()
    const ar = resolveReferences('المقطع الثاني', project, null)
    expect(ar.ordinal).toBe(2)
    expect(ar.focus?.kind).toBe('clip')
    expect(ar.focus?.index).toBe(2)
    expect(ar.mentions).toContain('clip')
    expect(resolveReferences('the second clip', project, null).ordinal).toBe(2)
    expect(resolveReferences('clip 1', project, null).ordinal).toBe(1)
    expect(resolveReferences('the last clip', project, null).ordinal).toBe(2)
  })
  it('reports out-of-range ordinals without a focus', () => {
    const project = twoClipProject()
    const refs = resolveReferences('clip 9', project, null)
    expect(refs.invalidOrdinal).toEqual({ requested: 9, available: 2 })
    expect(refs.focus).toBeNull()
    expect(refs.hint).toContain('clip #9')
  })
  it('keeps the focused clip for pronouns', () => {
    const project = twoClipProject()
    const focus = resolveReferences('المقطع الثاني', project, null).focus
    expect(focus).not.toBeNull()
    const refs = resolveReferences('احذفه', project, focus)
    expect(refs.mentions).toContain('demonstrative')
    expect(refs.focus?.clipId).toBe(focus?.clipId)
    expect(refs.focus?.index).toBe(2)
  })
  it('resolves music, subtitle, and silence mentions', () => {
    const project = twoClipProject()
    const music = resolveReferences('the music', project, null)
    expect(music.mentions).toContain('music')
    expect(music.focus?.kind).toBe('media')
    const subtitle = resolveReferences('the subtitle', project, null)
    expect(subtitle.mentions).toContain('subtitle')
    expect(subtitle.focus).toBeNull()
    const silence = resolveReferences('فترات الصمت', project, null)
    expect(silence.mentions).toContain('silence')
    expect(silence.focus?.kind).toBe('silence')
  })
  it('detects ال-prefixed Arabic nouns', () => {
    const project = twoClipProject()
    expect(resolveReferences('احذف المقطع', project, null).mentions).toContain('clip')
    expect(resolveReferences('أضف الموسيقى', project, null).mentions).toContain('music')
    expect(resolveReferences('أين الترجمة؟', project, null).mentions).toContain('subtitle')
  })
  it('returns empty references for plain text', () => {
    const refs = resolveReferences('hello there', twoClipProject(), null)
    expect(refs).toEqual({ focus: null, mentions: [], hint: '' })
  })
})
