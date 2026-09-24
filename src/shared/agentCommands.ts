import type { AspectRatio } from './types'

export type AgentIntent =
  | { type: 'remove-silence'; minimumDuration: number }
  | { type: 'find-silence'; minimumDuration: number }
  | { type: 'delete-range'; start: number; end: number }
  | { type: 'delete-intro' }
  | { type: 'delete-focused' }
  | { type: 'set-duration'; duration: number }
  | { type: 'set-aspect-ratio'; aspectRatio: AspectRatio; preset: string }
  | { type: 'adjust-volume'; percent: number }
  | { type: 'set-gain'; level: number; target: 'music' | 'clip' | 'project' }
  | { type: 'add-music' }
  | { type: 'trim-focused'; duration?: number }
  | { type: 'request-short'; aspectRatio?: AspectRatio }
  | { type: 'find-best'; count?: number }
  | { type: 'find-topic'; query: string }
  | { type: 'subtitle-style' }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'smart-plan' }
  | { type: 'analyze' }
  | { type: 'question' }
  | { type: 'unknown' }

function numericDuration(text: string): number | undefined {
  const number = text.match(/(\d+(?:[.,]\d+)?|\d+\s*\/\s*\d+)\s*(ثانية|ثواني|ثوان|ثانيتين|seconde|secondes|second|seconds|secs?|s\b)/i)
  if (number) {
    const fraction = number[1].match(/^(\d+)\s*\/\s*(\d+)$/)
    if (fraction) return Number(fraction[1]) / Number(fraction[2])
    return Number(number[1].replace(',', '.'))
  }
  if (/نصف\s*(?:ثانية|ثانيه)|half\s+(?:a\s+)?second/i.test(text)) return 0.5
  if (/ثانيتين|two\s+seconds/i.test(text)) return 2
  if (/ثانية\s+واحدة|واحدة\s+ثانية|one\s+second|une?\s+seconde/i.test(text)) return 1
  const frenchNumber = text.match(/\b(deux|trois|quatre|cinq)\s+secondes?\b/i)?.[1]
  if (frenchNumber) return ({ deux: 2, trois: 3, quatre: 4, cinq: 5 } as const)[frenchNumber.toLowerCase() as 'deux' | 'trois' | 'quatre' | 'cinq']
  if (/demi[-\s]?seconde|half\s+(?:a\s+)?second/i.test(text)) return 0.5
  return undefined
}

function secondsFromText(text: string): number | undefined {
  const ordinalSeconds = text.match(/(\d+(?:[.,]\d+)?)\s+(?:premier|première|premieres|premières|first)\s+(?:seconde|secondes|second|seconds)/i)
  if (ordinalSeconds) return Math.max(0.1, Math.min(3600, Number(ordinalSeconds[1].replace(',', '.'))))
  const seconds = numericDuration(text)
  if (seconds !== undefined) return Math.max(0.1, Math.min(3600, seconds))
  const minutes = text.match(/(\d+(?:[.,]\d+)?)\s*(دقيقة|دقائق|دقيقه|minute|minutes|min\b)/i)
  if (minutes) return Math.max(0.1, Math.min(3600, Number(minutes[1].replace(',', '.')) * 60))
  if (/دقيقة\s+واحدة|one\s+minute|une\s+minute/i.test(text)) return 60
  return undefined
}

function gainTarget(text: string): 'music' | 'clip' | 'project' {
  if (/موسيق|موسيقا|music|musique/.test(text)) return 'music'
  if (/مقطع|كليب|clip|plan/.test(text)) return 'clip'
  return 'project'
}

function shortAspectRatio(text: string): AspectRatio | undefined {
  if (/9\s*:\s*16|عمودي|vertical|portrait/.test(text)) return '9:16'
  if (/1\s*:\s*1|مربع|square|carré|carre/.test(text)) return '1:1'
  if (/16\s*:\s*9|أفقي|landscape|paysage/.test(text)) return '16:9'
  return undefined
}

function cleanTopicQuery(raw: string): string | undefined {
  const query = raw
    .replace(/^(?:عن|about|on|de|du|des|sur)\s+/i, '')
    .replace(/^['"«»“”\s:：-]+|['"«»“”\s:：?.؟!-]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
  return query.length >= 2 ? query : undefined
}

/** Extracts the "X" from "the part where he talks about X" (ar/en/fr). */
function topicQuery(message: string): string | undefined {
  const patterns = [
    /(?:الجزء|المقطع|اللقطة|الأجزاء|الاجزاء|المقاطع|اللقطات|اللحظة|اللحظات|المشهد|المشاهد)\s+(?:الذي|التي|اللي|اللى)\s+(?:يتحدث|يتكلم|يتحدثون|يتكلمون|تتحدث|تتكلم|تحدث|تكلم)\s+(?:فيه|فيها|فيهم)\s+عن\s+(.+?)\s*[؟?.!]*$/,
    /(?:الجزء|المقطع|اللقطة|المشهد)\s+(?:الذي|التي|اللي|اللى)\s+(?:يذكر|تذكر|ذكر|يتناول|يناقش|يشرح)\s+(.+?)\s*[؟?.!]*$/,
    /(?:الجزء|المقطع|اللقطة)\s+عن\s+(.+?)\s*[؟?.!]*$/,
    /\bwhere\s+(?:he|she|they|it|you|we)\s+(?:talk|talks|speaks?|discuss(?:es)?|mention(?:s)?|explain(?:s)?)\s+(?:about\s+)?(.+?)\s*[?.!]*$/i,
    /\b(?:the\s+)?(?:part|clip|moment|segment|scene)\s+(?:about|on)\s+(.+?)\s*[?.!]*$/i,
    /\bo[ùu]\s+(?:il|elle|ils|elles|on)\s+parle(?:nt)?\s+(?:de\s+|d['’])?\s*(.+?)\s*[?.!]*$/i,
    /\b(?:le\s+|la\s+)?(?:passage|moment|partie|extrait)\s+(?:sur|concernant)\s+(.+?)\s*[?.!]*$/i
  ]
  for (const pattern of patterns) {
    const match = message.match(pattern)
    if (match?.[1]) {
      const query = cleanTopicQuery(match[1])
      if (query) return query
    }
  }
  return undefined
}

function bestCount(text: string): number | undefined {
  const latinized = text.replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
  const match = latinized.match(/(?:أفضل|افضل|أحسن|احسن|best|meilleurs?)\s+(\d{1,2})\b|(\d{1,2})\s*(?:مقاطع|مقطع|لقطات|لقطة|أجزاء|اجزاء|لحظات|لحظة|مشاهد|مشهد|best|moments?|clips?|parts?|segments?|meilleurs?|passages?|extraits?)\b/i)
  if (!match) return undefined
  const value = Number(match[1] ?? match[2])
  return Number.isFinite(value) && value >= 1 && value <= 8 ? value : undefined
}

function wantsBestSegments(text: string): boolean {
  if (/(أفضل|افضل|أحسن|احسن)\s+.{0,24}(مقاطع|مقطع|لقطات|لقطة|أجزاء|اجزاء|جزء|لحظات|لحظة|مشاهد|مشهد)/.test(text)) return true
  if (/أهم\s+ما\s+في/.test(text)) return true
  if (/\bbest\s+(?:\d{1,2}\s+)?(moments?|highlights?|clips?|parts?|segments?|scenes?|shots?|bits?)\b/i.test(text)) return true
  if (/\bhighlights?\b/i.test(text) && !/\b(?:ball|match|game)\b/i.test(text)) return true
  if (/\bmeilleurs?\s+(moments?|passages?|extraits?|morceaux?)\b/i.test(text)) return true
  return false
}

export function parseAgentIntent(message: string): AgentIntent {
  const text = message.trim().toLowerCase()
  if (!text) return { type: 'unknown' }

  if (/\b(undo)\b|تراجع|الغاء آخر تعديل|ألغِ آخر تعديل|إلغاء آخر تعديل|\bannul(?:e|er)\b/.test(text)) return { type: 'undo' }
  if (/\b(redo)\b|إعادة آخر تعديل|أعد آخر تعديل|اعادة آخر تعديل|\b(?:rétablis|retablis|rétablir|retablir)\b/.test(text)) return { type: 'redo' }

  if (/(?:قص|احذف|أزل|إزالة|حذف).*(?:المقدمة|المقدم|البداية)|(?:المقدمة|البداية).*(?:قص|احذف|أزل|إزالة|حذف)|remove.*(?:intro|opening)|(?:intro|opening).*(?:remove|cut|delete)/i.test(text)) {
    return { type: 'delete-intro' }
  }

  if (/(أضف|اضف|أضيفي|ضيف|حط|add|ajoute|ajouter|mets|mettre).*(موسيق|موسيقا|صوت|أغني|اغني|غنية|نغمة|music|audio|son|musique|morceau)|(موسيق|موسيقا|music|musique).*(أضف|اضف|ضيف|حط|add|ajoute|ajouter)/i.test(text)) {
    return { type: 'add-music' }
  }

  if (/حلل\s*(?:الفيديو|المشروع)?|تحليل\s*(?:الفيديو|المشروع)?|analy[sz]e\s+(?:the\s+)?video|\banalys(?:e|er)\b/.test(text)) {
    return { type: 'analyze' }
  }
  if (/أكثر\s*احتراف|احترافي|smart\s*edit|make\s+(?:it|the video)\s+more\s+professional|\b(?:professionnel|professionnelle|améliore|ameliore|optimise)\b/.test(text)) {
    return { type: 'smart-plan' }
  }

  const isSilence = /صمت|الصمت|سكون|silence|silent/.test(text)
  if (isSilence && /(?:ابحث|اعثر|اوجد|جد|find|show|where|أين|cherche|recherche|trouve|affiche|où|ou)/.test(text) && !/(?:احذف|أزل|إزالة|قص|remove|delete|cut|supprime|retire|enlève|enleve|coupe)/.test(text)) {
    return { type: 'find-silence', minimumDuration: numericDuration(text) ?? 1 }
  }
  if (isSilence && /احذف|أزل|ازالة|إزالة|قص|أريد حذف|اريد حذف|حذف|remove|delete|cut|trim|supprime|supprimer|retire|retirer|enlève|enlever|coupe|couper/.test(text)) {
    return { type: 'remove-silence', minimumDuration: numericDuration(text) ?? 1 }
  }

  if (/(أريد|اريد|اعمل|أنشئ|انشئ|اصنع|سوي|create|make|build|fais|crée|cree|prépare|prepare).*(short|reel|ريل|ريلز|شورت|قصير|tiktok|تيك\s*توك)|(short|reel|ريل|ريلز|شورت|فيديو قصير|مقطع قصير|tiktok|تيك\s*توك).*(أنشئ|انشئ|اعمل|اصنع|أريد|اريد|create|make|build)/i.test(text)) {
    const aspectRatio = shortAspectRatio(text)
    return aspectRatio ? { type: 'request-short', aspectRatio } : { type: 'request-short' }
  }

  // Topic selection ("the part where he talks about X") and generic "best
  // moments" requests run analysis-first; they must win over generic
  // delete/trim/question fallbacks below.
  const topic = topicQuery(message)
  if (topic) return { type: 'find-topic', query: topic }
  if (wantsBestSegments(text)) {
    const count = bestCount(text)
    return count === undefined ? { type: 'find-best' } : { type: 'find-best', count }
  }

  const aspectRatio = /9\s*:\s*16|تيك\s*توك|tiktok|ريلز|reels|عمودي|vertical|shorts|portrait/.test(text)
    ? '9:16'
    : /1\s*:\s*1|مربع|square|carré|carre/.test(text)
      ? '1:1'
      : /16\s*:\s*9|أفقي|landscape|paysage/.test(text)
        ? '16:9'
        : undefined
  if (aspectRatio && /اجعل|حوّل|حول|غيّر|غير|نسبة|مناسب|make|convert|change|format|aspect|mets|mettre|passe|transforme/.test(text)) {
    const preset = /tiktok|تيك\s*توك|ريلز|reels|shorts/.test(text) ? 'TikTok / Reels' : aspectRatio
    return { type: 'set-aspect-ratio', aspectRatio, preset }
  }

  // Absolute level ("إلى 50%", "to 40%", "à 50%") must win over relative volume.
  const absoluteLevel = text.match(/(?:إلى|الى|à)\s*(\d+(?:[.,]\d+)?)\s*(%|٪|بالمئة|بالمائه|بالمية|percent|pour\s*cent)|(?:^|\s)to\s+(\d+(?:[.,]\d+)?)\s*(%|percent)/i)
  if (absoluteLevel && /(صوت|موسيق|موسيقا|volume|audio|music|musique|son|gain|level|niveau)/i.test(text)) {
    const level = Number((absoluteLevel[1] ?? absoluteLevel[3]).replace(',', '.'))
    if (Number.isFinite(level)) {
      return { type: 'set-gain', level: Math.max(0, Math.min(200, level)), target: gainTarget(text) }
    }
  }

  if (/\b(?:raise|increase|boost|lower|reduce|decrease)\b|ارفع|زد|زِد|اخفض|خفّض|خفض|augmente|augmenter|monte|monter|diminue|diminuer|réduis|reduis|réduire|reduire|baisse|baisser/.test(text) && /صوت|موسيق|موسيقا|volume|audio|music|musique/.test(text)) {
    const percentage = text.match(/(\d+(?:[.,]\d+)?)\s*%/)
    const value = percentage ? Number(percentage[1].replace(',', '.')) : 10
    const isLower = /lower|reduce|decrease|اخفض|خفّض|خفض|diminue|diminuer|réduis|reduis|réduire|reduire|baisse|baisser/.test(text)
    return { type: 'adjust-volume', percent: Math.max(-100, Math.min(200, isLower ? -value : value)) }
  }

  // Comparative music/clip volume without an explicit value ("اجعل الموسيقى أخفض").
  if (/(اجعل|خلي|خلى|make|set|render|rends|mettre).*(موسيق|موسيقا|صوت|music|musique|audio|son).*(أخفض|اخفض|أخفضي|اخفضي|أعلى|اعلى|أوطى|اوطى|اهدى|اهمس|quieter|louder|lower|higher|plus bas|plus haut|moins fort|plus fort)/i.test(text)) {
    const isLower = /(أخفض|اخفض|أخفضي|اخفضي|أوطى|اوطى|اهدى|اهمس|quieter|lower|plus bas|moins fort)/i.test(text)
    return { type: 'adjust-volume', percent: isLower ? -10 : 10 }
  }

  // Explicit range deletes win over focused ones ("supprime les 10 premières
  // secondes" is a range, not "delete it").
  if (/احذف|قص|delete|remove|cut|supprime|supprimer|retire|retirer|enlève|enlever|coupe|couper/.test(text)) {
    const duration = secondsFromText(text)
    if (duration !== undefined && /أول|البداية|من البداية|first|beginning|start|premi(?:ère|ere)s?|début|debut/.test(text)) {
      return { type: 'delete-range', start: 0, end: duration }
    }
    const range = text.match(/(\d+(?:[.,]\d+)?)\s*(?:إلى|الى|to|à|-)\s*(\d+(?:[.,]\d+)?)\s*(?:ثانية|ثواني|ثوان|secondes?|secs?)?/i)
    if (range) return { type: 'delete-range', start: Number(range[1].replace(',', '.')), end: Number(range[2].replace(',', '.')) }
  }

  // Focused delete ("احذفه", "احذف هذا المقطع", "delete it", "supprime-le").
  if (/(احذفه|احذفها|احذفيه|احذفيها|امسحه|امسحها|delete it|remove it|delete that|supprime[-\s]?le|supprime[-\s]?la|retire[-\s]?le)/i.test(text) ||
    /(احذف|امسح|delete|remove|supprime|retire).*(المقطع|الكليب|clip|plan|this clip|that clip|ce clip|ce plan)/i.test(text) ||
    /(احذف|امسح|delete|remove|supprime|retire).*(الموسيق|الترجم|music|musique|subtitle|sous-titre)/i.test(text)) {
    return { type: 'delete-focused' }
  }

  // Focused trim ("قصه", "قصه إلى 30 ثانية", "قص هذا المقطع", "trim it", "coupe-le").
  if (/(قصه|قصها|trim it|cut it|shorten it|coupe[-\s]?le|coupe[-\s]?la|raccourcis[-\s]?le)/i.test(text) ||
    (/(قص|قصر|trim|shorten|raccourcis|coupe)/i.test(text) && /(ثاني|second|seconde|مقطع|كليب|clip|plan|this|that|ce|cette)/i.test(text))) {
    const duration = secondsFromText(text)
    return duration === undefined ? { type: 'trim-focused' } : { type: 'trim-focused', duration }
  }

  if (/(ترجم|subtitle|caption|sous-titre|soustitre).*(أكبر|اكبر|أصغر|اصغر|كبر|صغر|تكبير|تصغير|bigger|smaller|larger|agrand|plus grand|plus petit)/i.test(text)) {
    return { type: 'subtitle-style' }
  }

  if (/مدته|لمدة|بطول|اجعل(?:ه|ي)?\s*(?:مدته)?|duration|exactly|durée|duree|pendant|exactement/.test(text)) {
    const duration = secondsFromText(text)
    if (duration !== undefined) return { type: 'set-duration', duration }
  }

  if (/\?|؟|ماذا|ما\s+الذي|أين|متى|كم|what|where|when|how|summari[sz]e|لخص|استخرج|\b(?:quoi|où|ou|quand|comment|combien|pourquoi|résume|resume)\b/.test(text)) return { type: 'question' }
  return { type: 'unknown' }
}
