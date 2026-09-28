import { anonymousVoiceRoles, explicitlyOffscreenSpeaker, voiceSpeakers } from '../src/character-voice.ts'
import { normalizePronunciationHints } from '../src/pronunciation-hints.ts'

type Row = Record<string, unknown>
const row = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}

/** The approved storyboard stays intact. Only the provider's picture/ambience
 * request omits off-screen speech; the final soundtrack uses the exact text. */
export function projectIndependentNarration(prompt: string, params: Row) {
  return projectIndependentSpeech(prompt, params, 'narration')
}

export function projectIndependentOffscreenDialogue(prompt: string, params: Row) {
  return projectIndependentSpeech(prompt, params, 'offscreen-dialogue')
}

function projectIndependentSpeech(prompt: string, params: Row, audioRole: 'narration' | 'offscreen-dialogue') {
  const dialogue = audioRole === 'offscreen-dialogue'
  if (dialogue && params.audioType !== '对白') throw Error('NARRATION_ROUTE_UNSUPPORTED: 角色画外对白必须保留 audioType=对白，不能改成旁白或环境声')
  const speakers = voiceSpeakers(params)
  const anonymous = dialogue ? anonymousVoiceRoles(params) : []
  const conflict = anonymous.find(role => role.stagingConflict)?.stagingConflict
  if (conflict) throw Error(`${conflict.code}: ${conflict.reason}`)
  if (speakers.length !== 1 || (dialogue ? anonymous.length !== 1 || !anonymous[0].offscreen || speakers[0] !== anonymous[0].name : speakers[0] !== '旁白')) throw Error('NARRATION_ROUTE_UNSUPPORTED: 独立音轨要求单一且明确的画外说话角色，禁止转换画内对白或混合声部')
  const speakerName = speakers[0]
  const pronunciationHints = normalizePronunciationHints(params.pronunciationHints, params.audioText)
  const roleDescription = dialogue ? `画外角色${speakerName}的对白` : '旁白'
  const pacing = row(params.pacing)
  const beats = Array.isArray(pacing.beats) ? pacing.beats.map(row) : []
  const narration = beats.filter(beat => beat.kind === 'speech')
  if (!narration.length || narration.some(beat => dialogue ? beat.deliveryStyle !== 'dialogue' : beat.deliveryStyle !== 'narration')) throw Error('NARRATION_SCHEDULE_INVALID: 缺少保持原声部类型的完整画外节拍')
  const schedule = Array.isArray(pacing.schedule) ? pacing.schedule.map(row) : []
  const narrationPolicy = row(row(row(pacing.timingPolicy).speech)[dialogue ? 'dialogue' : 'narration'])
  const referenceRate = Number(narrationPolicy.referenceRate ?? 4.5)
  const maximumRate = Number(narrationPolicy.maximumRate ?? 5)
  if (!Number.isFinite(referenceRate) || referenceRate <= 0 || !Number.isFinite(maximumRate)
    || maximumRate < referenceRate || maximumRate > 8) throw Error('NARRATION_SCHEDULE_INVALID: 旁白时长策略无效')
  // Bailian's rate=1 baseline corresponds to the original 4.5-char/s planning
  // profile. Ask the synthesizer for the approved brisk delivery first; a
  // bounded local tempo correction remains only for measured provider drift.
  const ttsRate = Math.max(.5, Math.min(2, referenceRate / 4.5))
  const segments = narration.map(beat => {
    const windows = schedule.filter(window => window.beatId === beat.id)
    const window = windows[0]
    const text = String(beat.textOrVocalization ?? '').trim()
    if (windows.length !== 1 || !text || typeof window.startSecond !== 'number' || typeof window.endSecond !== 'number' || window.startSecond < 0 || window.endSecond <= window.startSecond) throw Error('NARRATION_SCHEDULE_INVALID: 旁白节拍缺少唯一有效时间窗')
    const hints = pronunciationHints.filter(hint => text.includes(hint.term))
    return { beatId: String(beat.id), text, start: window.startSecond, end: window.endSecond, ttsRate, maximumRate,
      ...(hints.length ? { pronunciationHints: hints } : {}) }
  }).sort((a, b) => a.start - b.start)
  const spokenText = segments.map(segment => segment.text).join('')
  const boundaries = segments.map((_, index) => segments.slice(0, index + 1).reduce((total, segment) => total + segment.text.length, 0)).slice(0, -1)
  for (const hint of pronunciationHints) {
    let occurrence = spokenText.indexOf(hint.term)
    if (occurrence < 0) throw Error('PRONUNCIATION_HINT_INVALID: 合成节拍中缺少发音词条')
    while (occurrence >= 0) {
      if (boundaries.some(boundary => occurrence < boundary && boundary < occurrence + hint.term.length)) {
        throw Error('PRONUNCIATION_HINT_INVALID: 发音词条跨越独立合成节拍，须将每次出现的完整词条保留在同一节拍，禁止静默丢弃发音指导')
      }
      occurrence = spokenText.indexOf(hint.term, occurrence + 1)
    }
  }
  if (segments.some((segment, i) => i > 0 && segment.start < segments[i - 1].end)) throw Error('NARRATION_SCHEDULE_INVALID: 同一旁白音轨的时间窗不能重叠')
  const normalize = (text: string) => text.replace(/[\p{P}\p{Z}\s]/gu, '')
  // audioType=旁白 already fixes the speaker identity. Storyboard writers may
  // harmlessly mix bare lines with an explicit “旁白：” prefix; compare only
  // the spoken body, exactly as the duration compiler does, while retaining
  // every other label as content so a wrong speaker cannot be hidden.
  const audioBody = String(params.audioText ?? '').split(/\r?\n/).filter(line => line.trim())
    .map(line => {
      if (!dialogue) return line.replace(/^\s*旁白\s*[：:]\s*/, '')
      const label = line.match(/^\s*([^：:]+)[：:]\s*/)
      if (!label || label[1].replace(/（[^）]*）|\([^)]*\)/g, '').trim() !== speakerName
        || !explicitlyOffscreenSpeaker(label[1])) throw Error('NARRATION_SCHEDULE_INVALID: 角色对白必须逐句保持同一明确画外身份')
      return line.slice(label[0].length)
    }).join('')
  if (normalize(segments.map(segment => segment.text).join('')) !== normalize(audioBody)) throw Error('NARRATION_SCHEDULE_INVALID: 旁白节拍与完整音轨文本不一致')
  const duration = Number(params.duration)
  if (!Number.isFinite(duration) || segments.some(segment => segment.end > duration)) throw Error('NARRATION_SCHEDULE_INVALID: 旁白超出视频时长')
  const ids = new Set(segments.map(segment => segment.beatId))
  let projected = prompt
  const timeline = Array.isArray(pacing.timelineWindows) ? pacing.timelineWindows.map(row) : []
  for (const window of timeline) for (const quote of Array.isArray(window.beatQuotes) ? window.beatQuotes.map(row) : []) {
    if (ids.has(String(quote.beatId)) && typeof quote.quote === 'string') projected = projected.replaceAll(quote.quote, `此时${roleDescription}由独立音轨提供，画内人物按既定动作自然表演，不作说话口型。`)
  }
  for (const text of [String(params.audioText ?? ''), ...segments.map(segment => segment.text)].filter(Boolean)) projected = projected.replaceAll(text, '')
  projected = projected.replace(/^【声部与收束】.*$/gm, '').replace(/^人声类型：.*$/gm, '声音：仅场景环境音，无人声、对白或歌唱。')
  projected += `\n【独立画外配音】本次仅生成画面和与场景相符的自然环境音。${roleDescription}将在后期添加，本次不得生成任何可辨词语或配音；画内人物不朗读、不作说话口型，保留已批准的动作、视线、呼吸和微动。`
  const pictureParams = { ...params }
  delete pictureParams.pronunciationHints
  return { segments, duration, audioRole, speakerName, prompt: projected, params: { ...pictureParams, characterVoices: [], audioText: '', audioType: '环境声', sound: 'on', pacingVersion: 'independent-narration-v1' } }
}

/** A small tempo correction keeps pitch and the fixed voice unchanged. Never
 * truncate speech or silently stretch picture duration to hide an overrun. */
export function narrationTempo(actualSeconds: number, availableSeconds: number, text: string, maximumRate = 5) {
  if (!Number.isFinite(actualSeconds) || actualSeconds <= 0 || !Number.isFinite(availableSeconds) || availableSeconds <= 0) throw Error('NARRATION_TIMING_INVALID: 缺少实际音频时长')
  const tempo = Math.max(1, actualSeconds / availableSeconds)
  const count = Array.from(text.replace(/[\p{P}\p{Z}\s]/gu, '')).length
  if (tempo > 1.25 || count / (actualSeconds / tempo) > maximumRate) throw Error('NARRATION_DURATION_CONFLICT: 实际配音无法在自然语速内适配已批准时间窗，需要修订排程，禁止截断或过度加速')
  return tempo
}
