import type { ProjectData } from './types'
import { clipDuration, getMusicClips, getVideoClips } from './project'

/**
 * Shared conversation-memory primitives for the editing agent.
 *
 * These helpers are intentionally UI- and runtime-agnostic (pure functions +
 * plain types) so the main process, the renderer, and unit tests can share
 * one interpretation of short replies ("yes"/"no"), references ("it", "this
 * clip") and pending actions. The stateful session store lives in
 * `src/main/conversationStore.ts`; Gemini only interprets language, the app
 * owns the state.
 */

/** Conversation state machine. IDLE never clears history/focus/decisions. */
export type ConversationStatus =
  | 'IDLE'
  | 'THINKING'
  | 'WAITING_FOR_CONFIRMATION'
  | 'EXECUTING'
  | 'WAITING_FOR_INPUT'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'

export type PendingActionType =
  | 'delete_silence'
  | 'delete_range'
  | 'delete_intro'
  | 'set_duration'
  | 'create_short'
  | 'add_music'
  | 'set_gain'
  | 'trim_clip'
  | 'set_aspect_ratio'
  | 'open_export'

/**
 * A stored "what the agent is waiting to do" record. Short user replies such
 * as "yes" are always interpreted against this record first, never as a
 * standalone request.
 */
export interface PendingAction {
  id: string
  /** Stable action type, e.g. "delete_silence". */
  type: PendingActionType
  /** Application tool used to execute it, e.g. "remove_silence". */
  tool: string
  parameters: Record<string, unknown>
  /** Why the action was proposed (evidence summary for the agent/user). */
  reason: string
  /** Exact confirmation question asked to the user. */
  question: string
  /** Project revision hash when the action was proposed. */
  projectRevision: string
  projectId: string
  createdAt: string
}

export type FocusKind = 'clip' | 'music' | 'subtitle' | 'media' | 'short-candidate' | 'silence' | 'none'

/** The clip/element the dialogue is currently about. */
export interface ConversationFocus {
  kind: FocusKind
  clipId?: string
  mediaId?: string
  subtitleId?: string
  /** 1-based video-clip number when kind === 'clip'. */
  index?: number
  label?: string
  updatedAt: string
}

export type ShortReplyKind = 'confirm' | 'cancel' | 'continue' | 'input' | 'question' | 'none'

export type WaitingInputKind =
  | 'volume_level'
  | 'trim_duration'
  | 'music_choice'
  | 'clip_action'

const ARABIC_INDIC_DIGITS: Record<string, string> = {
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4',
  '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9'
}

export function latinDigits(text: string): string {
  return text.replace(/[٠-٩]/g, (digit) => ARABIC_INDIC_DIGITS[digit] ?? digit)
}

/**
 * Aggressive normalization for intent matching across Arabic, English and
 * French: lowercases, strips diacritics/tatweel, unifies alef/hamza forms,
 * maps ة→ه and ى→ي, removes accents (exécute→execute) and punctuation.
 */
export function normalizeConversationText(text: string): string {
  return latinDigits(text)
    .toLowerCase()
    .replace(/[ٱأإآ]/g, 'ا')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[\u064b-\u065f\u0670\u0640]/g, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[؟?!.،,;:()«»""''`'’‘"“”\-_—–/\\|@#~^$*+=<>[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Light normalization for numeric extraction: keeps digits, dots, % words. */
function normalizeForNumbers(text: string): string {
  return latinDigits(text).toLowerCase().replace(/,/g, '.')
}

function padded(normalized: string): string {
  return ` ${normalized} `
}

function containsPhrase(normalizedPadded: string, phrase: string): boolean {
  return normalizedPadded.includes(` ${phrase} `)
}

function containsAny(normalizedPadded: string, phrases: string[]): boolean {
  return phrases.some((phrase) => containsPhrase(normalizedPadded, phrase))
}

const CANCEL_PHRASES = [
  // Arabic
  'لا', 'لاء', 'كلا', 'مش موافق', 'مو منفق', 'لا اريد', 'لا اريد ذلك', 'لا اريدها',
  'اترك', 'اتركه', 'اتركها', 'اتركهم', 'اتركيها', 'سيب', 'سيبها', 'سيبه', 'سيبهم',
  'خليه', 'خليها', 'خليهم', 'بلاش', 'الغاء', 'الغي', 'الغيه', 'كنسل',
  'لا تحذف', 'لا تحذفها', 'لا تفعل', 'لا تفعلها', 'لا تنفذ', 'لا تنفذها',
  'توقف', 'اوقف', 'قف', 'مش عايز', 'مش عاوز', 'مش حابب',
  // English
  'no', 'nope', 'nah', 'dont', 'don t', 'do not', 'leave it', 'leave them',
  'leave that', 'keep it', 'keep them', 'cancel', 'stop', 'abort', 'never mind',
  'not now', 'not really',
  // French
  'non', 'pas question', 'laisse', 'laisse le', 'laisse la', 'laisse les',
  'laissez', 'garde', 'garder', 'annule', 'annuler', 'stop', 'ne fais pas',
  'ne fait pas', 'ne supprime pas', 'ne le fait pas', 'pas du tout'
]

const CONFIRM_PHRASES = [
  // Arabic
  'نعم', 'اجل', 'ايوه', 'ايوا', 'موافق', 'موافقه', 'تمام', 'حاضر', 'ماشي',
  'اوك', 'اوكي', 'حسنا', 'طبعا', 'بالتاكيد', 'اكيد', 'نفذ', 'نفذه', 'نفذها',
  'نفذيها', 'افعل', 'افعلها', 'افعلها', 'اعملها', 'احذفها', 'احذفهم', 'امسحها',
  'نفذها', 'يلا', 'تمام نفذ', 'اي نعم',
  // English
  'yes', 'yeah', 'yep', 'yup', 'sure', 'ok', 'okay', 'confirm', 'confirmed',
  'agree', 'agreed', 'do it', 'go ahead', 'proceed', 'execute', 'fine',
  'alright', 'sounds good', 'delete it', 'delete them', 'remove it', 'remove them',
  // French
  'oui', 'ouais', 'd accord', 'daccord', 'ok', 'vas y', 'execute', 'executer',
  'fais le', 'fait le', 'supprime le', 'supprime la', 'supprime les', 'parfait',
  'tout a fait'
]

const CONTINUE_PHRASES = [
  'تابع', 'اكمل', 'كمل', 'استمر', 'واصل', 'استمري',
  'continue', 'carry on', 'go on',
  'continuer', 'continue', 'poursuis', 'poursuivre', 'enchaine'
]

const QUESTION_WORDS = [
  'ماذا', 'ماذ', 'لماذا', 'لماذ', 'اي', 'ايه', 'ما', 'متي', 'متي', 'كيف', 'كم',
  'هل', 'اين', 'مت', 'ليه', 'ازاي',
  'what', 'why', 'which', 'how', 'when', 'where',
  'quoi', 'pourquoi', 'quel', 'quelle', 'comment', 'quand', 'combien', 'ou'
]

/** Imperative verbs that target the focused element ("delete it", "قصه"). */
const FOCUSED_COMMAND_MARKERS = [
  'احذف', 'امسح', 'قص', 'قصر', 'اترك', 'كبر', 'صغر', 'خفض', 'اخفض', 'ارفع',
  'شغل', 'حرك', 'trim', 'cut', 'delete', 'remove', 'leave', 'enlarge',
  'coupe', 'supprime', 'retire', 'enleve', 'agrandis'
]

function tokensOf(normalized: string): string[] {
  return normalized ? normalized.split(' ') : []
}

/** Short replies are at most a few words; longer texts are new requests. */
export function isShortMessage(text: string): boolean {
  const normalized = normalizeConversationText(text)
  if (!normalized) return false
  const tokens = tokensOf(normalized)
  if (tokens.length > 4) return false
  if (normalized.length > 48) return false
  return true
}

/**
 * Classifies a user message as a reply to the agent's previous question.
 * Context-free on purpose: the caller (conversation manager) decides what a
 * "confirm" means based on the pending action, or treats long texts ('none')
 * as fresh requests.
 */
export function classifyShortReply(text: string): ShortReplyKind {
  const raw = text.trim()
  if (!raw) return 'none'
  const normalized = normalizeConversationText(raw)
  if (!normalized) return 'none'
  const paddedText = padded(normalized)
  const tokens = tokensOf(normalized)

  // Explicit numeric input ("50%", "30 seconds") is detectable at any length.
  if (extractPercent(raw) !== undefined || extractDurationSeconds(raw) !== undefined) {
    if (isShortMessage(raw)) return 'input'
  }
  if (!isShortMessage(raw)) return 'none'

  // Cancel wins over confirm ("لا، اتركها" contains a strong refusal).
  if (containsAny(paddedText, CANCEL_PHRASES)) return 'cancel'
  if (tokens.length === 1 && /^(لا+|لأ+|non+|no+)$/.test(tokens[0])) return 'cancel'

  if (containsAny(paddedText, CONTINUE_PHRASES)) return 'continue'
  if (containsAny(paddedText, CONFIRM_PHRASES)) return 'confirm'

  if (/[؟?]$/.test(raw.trim()) || QUESTION_WORDS.some((word) => tokens[0] === word)) return 'question'
  return 'none'
}

/**
 * True when the text looks like an imperative aimed at the focused element
 * ("احذفه", "trim it", "coupe-le") rather than a plain yes/no.
 */
export function looksLikeFocusedCommand(text: string): boolean {
  const normalized = normalizeConversationText(text)
  if (!normalized) return false
  const compact = normalized.replace(/\s+/g, ' ')
  return FOCUSED_COMMAND_MARKERS.some((marker) => {
    if (compact === marker) return true
    if (compact.startsWith(`${marker} `)) return true
    // Attached pronouns: قصه، احذفه، deleteit→(spaced) handled by phrases.
    if (/^[\u0600-\u06ff]+$/.test(compact.replace(/ /g, ''))) {
      const first = tokensOf(compact)[0] ?? ''
      if (first.startsWith(marker) && first.length <= marker.length + 3) return true
    }
    return padded(compact).includes(` ${marker} `)
  })
}

/** Extracts a volume/level percent ("50%", "40 بالمئة", "half"). Returns 0–200. */
export function extractPercent(text: string): number | undefined {
  const normalized = normalizeForNumbers(text)
  const match = normalized.match(/(\d+(?:\.\d+)?)\s*(%|٪|بالمئه|بالمئة|بالمائة|بالمية|percent|pour\s*cent)/)
  if (match) {
    return clamp(Number(match[1]), 0, 200)
  }
  if (/^\s*\d+(?:\.\d+)?\s*$/.test(normalized)) {
    const value = Number(normalized.trim())
    if (Number.isFinite(value) && value >= 0 && value <= 200) return value
  }
  if (/(^|\s)(نصف|النصف)($|\s)/.test(` ${normalizeConversationText(text)} `)) return 50
  if (/\bhalf\b/.test(normalized)) return 50
  return undefined
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum
  return Math.max(minimum, Math.min(maximum, value))
}

/** Extracts a duration in seconds ("30 ثانية", "2 minutes", "half a second"). */
export function extractDurationSeconds(text: string): number | undefined {
  const normalized = normalizeForNumbers(text)
  const plain = normalizeConversationText(text)
  const seconds = normalized.match(/(\d+(?:\.\d+)?)\s*(ثانية|ثانيه|ثواني|ثوان|s\b|sec|secs|second|seconds|seconde|secondes)/)
  if (seconds) return clamp(Number(seconds[1]), 0.1, 3600)
  const minutes = normalized.match(/(\d+(?:\.\d+)?)\s*(دقيقة|دقيقه|دقائق|دقايق|min|mins|minute|minutes)/)
  if (minutes) return clamp(Number(minutes[1]) * 60, 0.1, 3600)
  if (/(^|\s)(ثانيتين)($|\s)/.test(` ${plain} `)) return 2
  if (/(نصف ثانيه|half (a )?second|demi seconde)/.test(plain)) return 0.5
  if (/(ثانيه واحده|one second|une seconde)/.test(plain)) return 1
  const french = plain.match(/(^|\s)(deux|trois|quatre|cinq)\s+secondes?($|\s)/)
  if (french) {
    const map: Record<string, number> = { deux: 2, trois: 3, quatre: 4, cinq: 5 }
    return map[french[2]]
  }
  return undefined
}

export interface ReferenceResolution {
  focus: ConversationFocus | null
  /** 1-based clip number when the user names one explicitly. */
  ordinal?: number
  mentions: Array<'clip' | 'music' | 'subtitle' | 'silence' | 'demonstrative'>
  /** Short English hint for the language model / local planner. */
  hint: string
  invalidOrdinal?: { requested: number; available: number }
}

const ORDINAL_PHRASES: Array<{ phrases: string[]; value: number }> = [
  { phrases: ['الاول', 'الاولي', 'اول', 'first', '1st', 'premier', 'premiere'], value: 1 },
  { phrases: ['الثاني', 'الثانيه', 'التاني', 'التانيه', 'second', '2nd', 'deuxieme', 'seconde'], value: 2 },
  { phrases: ['الثالث', 'الثالثه', 'التالت', 'التالته', 'third', '3rd', 'troisieme'], value: 3 },
  { phrases: ['الرابع', 'الرابعه', 'fourth', '4th', 'quatrieme'], value: 4 },
  { phrases: ['الخامس', 'الخامسه', 'fifth', '5th', 'cinquieme'], value: 5 }
]

const LAST_PHRASES = ['الاخير', 'الاخيره', 'last', 'dernier', 'derniere']
const PREVIOUS_PHRASES = ['السابق', 'السابقه', 'previous', 'precedent', 'precedente']
const NEXT_PHRASES = ['التالي', 'التاليه', 'next', 'suivant', 'suivante']

const CLIP_NOUNS = ['مقطع', 'مقاطع', 'كليب', 'فيديو', 'لقطه', 'clip', 'video', 'plan', 'sequence', 'extrait']
const MUSIC_NOUNS = ['موسيق', 'موسيقا', 'صوت', 'اغني', 'اغنيه', 'نغمه', 'music', 'audio', 'song', 'track', 'musique', 'morceau', 'son']
const SUBTITLE_NOUNS = ['ترجم', 'ترجمه', 'subtitle', 'caption', 'soustitre', 'sous titre', 'legende']
const SILENCE_NOUNS = ['صمت', 'سكون', 'silence']
const DEMONSTRATIVES = [
  'هذا', 'هذه', 'هؤلاء', 'ذلك', 'تلك', 'نفس', 'الذي', 'التي', 'اللي',
  'this', 'that', 'these', 'those', 'same', 'it', 'them',
  'ce', 'cette', 'ces', 'celui', 'celle', 'meme', 'le', 'la', 'les'
]

/** Arabic attached-pronoun suffixes (ـه، ـها، ـهم…). */
const PRONOUN_SUFFIXES = ['ها', 'هم', 'هما', 'هن', 'ه', 'ك', 'ي', 'نا']

function stripPronounSuffix(token: string): string {
  for (const suffix of PRONOUN_SUFFIXES) {
    if (token.length > suffix.length + 1 && token.endsWith(suffix)) {
      return token.slice(0, -suffix.length)
    }
  }
  return token
}

function mentionsNoun(paddedText: string, tokens: string[], nouns: string[]): boolean {
  if (nouns.some((noun) => containsPhrase(paddedText, noun))) return true
  return tokens.some((token) => {
    if (token.length < 3) return false
    const stem = stripPronounSuffix(token)
    if (stem !== token && nouns.includes(stem)) return true
    // Arabic definite article: الصمت → صمت, المقطع → مقطع, الموسيقى → موسيق….
    if (token.startsWith('ال') && token.length > 4) {
      const bare = stripPronounSuffix(token.slice(2))
      if (nouns.includes(bare)) return true
      if (bare.length > 4 && nouns.some((noun) => noun.length >= 4 && bare.startsWith(noun))) return true
    }
    return false
  })
}

function formatClock(seconds: number): string {
  const safe = Math.max(0, seconds)
  const minutes = Math.floor(safe / 60)
  return `${String(minutes).padStart(2, '0')}:${(safe - minutes * 60).toFixed(0).padStart(2, '0')}`
}

/**
 * Resolves "this/that/the second one/cut it/…" against the project timeline
 * and the current focus. Pure: returns the newly resolved focus (or null when
 * the message carries no reference) plus an English hint for the planner.
 */
export function resolveReferences(
  text: string,
  project: ProjectData,
  currentFocus: ConversationFocus | null
): ReferenceResolution {
  const normalized = normalizeConversationText(text)
  const now = new Date().toISOString()
  const empty: ReferenceResolution = { focus: null, mentions: [], hint: '' }
  if (!normalized) return empty
  const paddedText = padded(normalized)
  const tokens = tokensOf(normalized)
  const clips = getVideoClips(project)
  const musicClips = getMusicClips(project)
  const mentions: ReferenceResolution['mentions'] = []
  if (mentionsNoun(paddedText, tokens, CLIP_NOUNS)) mentions.push('clip')
  if (mentionsNoun(paddedText, tokens, MUSIC_NOUNS)) mentions.push('music')
  if (mentionsNoun(paddedText, tokens, SUBTITLE_NOUNS)) mentions.push('subtitle')
  if (mentionsNoun(paddedText, tokens, SILENCE_NOUNS)) mentions.push('silence')
  const hasDemonstrative = DEMONSTRATIVES.some((word) => containsPhrase(paddedText, word))
    || tokens.some((token) => {
      if (token.length < 3) return false
      const stem = stripPronounSuffix(token)
      return stem !== token && FOCUSED_COMMAND_MARKERS.some((marker) => stem === marker || stem.startsWith(marker))
    })
  if (hasDemonstrative) mentions.push('demonstrative')

  // Explicit ordinals ("the second clip", "المقطع الثاني", "clip 2", "#2").
  let ordinal: number | undefined
  for (const entry of ORDINAL_PHRASES) {
    if (containsAny(paddedText, entry.phrases)) {
      ordinal = entry.value
      break
    }
  }
  if (ordinal === undefined) {
    const numbered = normalized.match(/(مقطع|clip|plan|رقم|number|n|#)\s*(\d{1,2})/)
    if (numbered) ordinal = Number(numbered[2])
  }
  if (ordinal === undefined && containsAny(paddedText, LAST_PHRASES)) ordinal = clips.length || undefined
  if (ordinal === undefined && containsAny(paddedText, PREVIOUS_PHRASES)) {
    ordinal = currentFocus?.kind === 'clip' && currentFocus.index
      ? currentFocus.index - 1
      : Math.max(1, clips.length - 1)
  }
  if (ordinal === undefined && containsAny(paddedText, NEXT_PHRASES)) {
    ordinal = currentFocus?.kind === 'clip' && currentFocus.index
      ? currentFocus.index + 1
      : 2
  }
  if (ordinal !== undefined) {
    if (!clips.length || ordinal < 1 || ordinal > clips.length) {
      return {
        focus: null,
        ordinal,
        mentions: mentions.includes('clip') ? mentions : [...mentions, 'clip'],
        hint: `The user mentioned clip #${ordinal}, but the timeline has ${clips.length} clip(s). Ask which clip they mean.`,
        invalidOrdinal: { requested: ordinal, available: clips.length }
      }
    }
    const clip = clips[ordinal - 1]
    const asset = project.media.find((item) => item.id === clip.mediaId)
    return {
      focus: {
        kind: 'clip', clipId: clip.id, mediaId: clip.mediaId, index: ordinal,
        label: asset?.name ?? `Clip ${ordinal}`, updatedAt: now
      },
      ordinal,
      mentions: mentions.includes('clip') ? mentions : [...mentions, 'clip'],
      hint: `The user refers to video clip #${ordinal} ("${(asset?.name ?? clip.id).slice(0, 80)}", timeline ${formatClock(clip.position)}–${formatClock(clip.position + clipDuration(clip))}).`
    }
  }

  if (mentions.includes('music')) {
    const clip = currentFocus?.kind === 'music' && currentFocus.clipId
      ? musicClips.find((item) => item.id === currentFocus.clipId) ?? musicClips.at(-1)
      : musicClips.at(-1)
    if (clip) {
      const asset = project.media.find((item) => item.id === clip.mediaId)
      return {
        focus: { kind: 'music', clipId: clip.id, mediaId: clip.mediaId, label: asset?.name ?? 'Music', updatedAt: now },
        mentions,
        hint: `The user refers to the music clip ("${(asset?.name ?? clip.id).slice(0, 80)}", timeline ${formatClock(clip.position)}).`
      }
    }
    const audio = project.media.find((item) => item.hasAudio && !item.missing && item.duration > 0)
    return {
      focus: audio ? { kind: 'media', mediaId: audio.id, label: audio.name, updatedAt: now } : null,
      mentions,
      hint: audio
        ? `The user refers to the audio "${audio.name.slice(0, 80)}" (no music clip on the timeline yet).`
        : 'The user refers to music, but the project has no audio yet.'
    }
  }

  if (mentions.includes('subtitle')) {
    const subtitle = currentFocus?.kind === 'subtitle' && currentFocus.subtitleId
      ? project.subtitles.find((item) => item.id === currentFocus.subtitleId) ?? project.subtitles[0]
      : project.subtitles[0]
    return {
      focus: subtitle ? { kind: 'subtitle', subtitleId: subtitle.id, label: subtitle.text.slice(0, 60), updatedAt: now } : null,
      mentions,
      hint: subtitle
        ? `The user refers to the subtitle "${subtitle.text.slice(0, 80)}" (${formatClock(subtitle.start)}–${formatClock(subtitle.end)}).`
        : 'The user refers to subtitles, but the timeline has none yet.'
    }
  }

  if (mentions.includes('silence')) {
    return { focus: { kind: 'silence', updatedAt: now }, mentions, hint: 'The user refers to the detected silence segments.' }
  }

  if (mentions.includes('clip') || mentions.includes('demonstrative')) {
    if (currentFocus && currentFocus.kind !== 'none') {
      const label = currentFocus.label ?? currentFocus.kind
      const detail = currentFocus.kind === 'clip' && currentFocus.index ? `video clip #${currentFocus.index}` : currentFocus.kind
      return { focus: currentFocus, mentions, hint: `The user refers to the same ${detail} ("${label.slice(0, 80)}") discussed before.` }
    }
    const first = clips[0]
    if (first && mentions.includes('clip')) {
      const asset = project.media.find((item) => item.id === first.mediaId)
      return {
        focus: { kind: 'clip', clipId: first.id, mediaId: first.mediaId, index: 1, label: asset?.name ?? 'Clip 1', updatedAt: now },
        mentions,
        hint: `The user refers to video clip #1 ("${(asset?.name ?? first.id).slice(0, 80)}").`
      }
    }
    return { focus: null, mentions, hint: '' }
  }

  return { focus: null, mentions, hint: '' }
}

export function makePendingId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `pending-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
