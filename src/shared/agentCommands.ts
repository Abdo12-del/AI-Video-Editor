import type { AspectRatio } from './types'

export type AgentIntent =
  | { type: 'remove-silence'; minimumDuration: number }
  | { type: 'find-silence'; minimumDuration: number }
  | { type: 'delete-range'; start: number; end: number }
  | { type: 'delete-intro' }
  | { type: 'set-duration'; duration: number }
  | { type: 'set-aspect-ratio'; aspectRatio: AspectRatio; preset: string }
  | { type: 'adjust-volume'; percent: number }
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

export function parseAgentIntent(message: string): AgentIntent {
  const text = message.trim().toLowerCase()
  if (!text) return { type: 'unknown' }

  if (/\b(undo)\b|تراجع|الغاء آخر تعديل|ألغِ آخر تعديل|إلغاء آخر تعديل|\bannul(?:e|er)\b/.test(text)) return { type: 'undo' }
  if (/\b(redo)\b|إعادة آخر تعديل|أعد آخر تعديل|اعادة آخر تعديل|\b(?:rétablis|retablis|rétablir|retablir)\b/.test(text)) return { type: 'redo' }

  if (/(?:قص|احذف|أزل|إزالة|حذف).*(?:المقدمة|المقدم|البداية)|(?:المقدمة|البداية).*(?:قص|احذف|أزل|إزالة|حذف)|remove.*(?:intro|opening)|(?:intro|opening).*(?:remove|cut|delete)/i.test(text)) {
    return { type: 'delete-intro' }
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
  if (isSilence && /احذف|أزل|ازالة|إزالة|قص|remove|delete|cut|trim|supprime|supprimer|retire|retirer|enlève|enlever|coupe|couper/.test(text)) {
    return { type: 'remove-silence', minimumDuration: numericDuration(text) ?? 1 }
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

  if (/\b(?:raise|increase|boost|lower|reduce|decrease)\b|ارفع|زد|زِد|اخفض|خفّض|خفض|augmente|augmenter|monte|monter|diminue|diminuer|réduis|reduis|réduire|reduire|baisse|baisser/.test(text) && /صوت|volume|audio/.test(text)) {
    const percentage = text.match(/(\d+(?:[.,]\d+)?)\s*%/)
    const value = percentage ? Number(percentage[1].replace(',', '.')) : 10
    const isLower = /lower|reduce|decrease|اخفض|خفّض|خفض|diminue|diminuer|réduis|reduis|réduire|reduire|baisse|baisser/.test(text)
    return { type: 'adjust-volume', percent: Math.max(-100, Math.min(200, isLower ? -value : value)) }
  }

  if (/احذف|قص|delete|remove|cut|supprime|supprimer|retire|retirer|enlève|enlever|coupe|couper/.test(text)) {
    const duration = secondsFromText(text)
    if (duration !== undefined && /أول|البداية|من البداية|first|beginning|start|premi(?:ère|ere)s?|début|debut/.test(text)) {
      return { type: 'delete-range', start: 0, end: duration }
    }
    const range = text.match(/(\d+(?:[.,]\d+)?)\s*(?:إلى|الى|to|à|-)\s*(\d+(?:[.,]\d+)?)\s*(?:ثانية|ثواني|ثوان|secondes?|secs?)?/i)
    if (range) return { type: 'delete-range', start: Number(range[1].replace(',', '.')), end: Number(range[2].replace(',', '.')) }
  }

  if (/مدته|لمدة|بطول|اجعل(?:ه|ي)?\s*(?:مدته)?|duration|exactly|durée|duree|pendant|exactement/.test(text)) {
    const duration = secondsFromText(text)
    if (duration !== undefined) return { type: 'set-duration', duration }
  }

  if (/\?|؟|ماذا|ما\s+الذي|أين|متى|كم|what|where|when|how|summari[sz]e|لخص|استخرج|\b(?:quoi|où|ou|quand|comment|combien|pourquoi|résume|resume)\b/.test(text)) return { type: 'question' }
  return { type: 'unknown' }
}
