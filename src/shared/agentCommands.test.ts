import { describe, expect, it } from 'vitest'
import { parseAgentIntent } from './agentCommands'

describe('Arabic and English edit command parsing', () => {
  it('recognizes Arabic silence removal and defaults a spoken one second threshold', () => {
    expect(parseAgentIntent('احذف فترات الصمت التي تزيد عن ثانية.')).toEqual({ type: 'remove-silence', minimumDuration: 1 })
  })

  it('reads a numeric Arabic threshold and first-seconds cut', () => {
    expect(parseAgentIntent('احذف الصمت الذي يزيد عن 2.5 ثانية')).toEqual({ type: 'remove-silence', minimumDuration: 2.5 })
    expect(parseAgentIntent('احذف أول 10 ثوان')).toEqual({ type: 'delete-range', start: 0, end: 10 })
  })

  it('maps social format and volume instructions to constrained intents', () => {
    expect(parseAgentIntent('اجعل الفيديو مناسبًا لـ TikTok')).toEqual({ type: 'set-aspect-ratio', aspectRatio: '9:16', preset: 'TikTok / Reels' })
    expect(parseAgentIntent('ارفع الصوت 10%')).toEqual({ type: 'adjust-volume', percent: 10 })
  })

  it('recognizes undo and a protected smart-edit plan', () => {
    expect(parseAgentIntent('تراجع عن آخر تعديل')).toEqual({ type: 'undo' })
    expect(parseAgentIntent('اجعل الفيديو أكثر احترافية')).toEqual({ type: 'smart-plan' })
  })

  it('recognizes intro removal and routes best-part requests to analysis-first ranking', () => {
    expect(parseAgentIntent('قص المقدمة بعد تحليلك')).toEqual({ type: 'delete-intro' })
    expect(parseAgentIntent('قص أفضل جزء لريل')).toEqual({ type: 'find-best' })
  })

  it('routes generic best-moments requests to find-best with an optional count', () => {
    expect(parseAgentIntent('قص أفضل المقاطع من الفيديو.')).toEqual({ type: 'find-best' })
    expect(parseAgentIntent('اختر أفضل 3 مقاطع.')).toEqual({ type: 'find-best', count: 3 })
    expect(parseAgentIntent('اختر أهم ما في الفيديو')).toEqual({ type: 'find-best' })
    expect(parseAgentIntent('Cut the best moments from the video.')).toEqual({ type: 'find-best' })
    expect(parseAgentIntent('Pick the best 3 highlights.')).toEqual({ type: 'find-best', count: 3 })
    expect(parseAgentIntent('Choisis les 3 meilleurs moments.')).toEqual({ type: 'find-best', count: 3 })
  })

  it('keeps explicit Short requests on the Short flow', () => {
    expect(parseAgentIntent('اصنع لي Short من أفضل أجزاء الفيديو.')).toEqual({ type: 'request-short' })
    expect(parseAgentIntent('أنشئ Short عموديًا')).toEqual({ type: 'request-short', aspectRatio: '9:16' })
  })

  it('extracts the topic from part-about-X requests', () => {
    expect(parseAgentIntent('خذ الجزء الذي يتحدث فيه عن الذكاء الاصطناعي.')).toEqual({ type: 'find-topic', query: 'الذكاء الاصطناعي' })
    expect(parseAgentIntent('Take the part where he talks about color grading?')).toEqual({ type: 'find-topic', query: 'color grading' })
    expect(parseAgentIntent('Prends le passage où il parle de montage.')).toEqual({ type: 'find-topic', query: 'montage' })
  })

  it('supports common French editing commands as well as Arabic and English', () => {
    expect(parseAgentIntent('Supprime les silences de plus d’une seconde')).toEqual({ type: 'remove-silence', minimumDuration: 1 })
    expect(parseAgentIntent('Supprime les 10 premières secondes')).toEqual({ type: 'delete-range', start: 0, end: 10 })
    expect(parseAgentIntent('Annule')).toEqual({ type: 'undo' })
    expect(parseAgentIntent('Mets la vidéo au format TikTok')).toEqual({ type: 'set-aspect-ratio', aspectRatio: '9:16', preset: 'TikTok / Reels' })
    expect(parseAgentIntent('Augmente le volume de 15%')).toEqual({ type: 'adjust-volume', percent: 15 })
  })
})
