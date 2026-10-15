/** The wf-story sound plan is a sequence of short, in-frame animal calls.
 * The written cues describe their sounds; they are not TTS dialogue. */
export const STORY_ANIMAL_AUDIO_CONTRACT_VERSION = 'animal-interaction-v1'

type Value = Record<string, unknown>

export type StoryVocalBeat = {
  id: string
  speaker: '芙伊' | '卷毛'
  utterance: '喵儿' | '旺'
  /** Present only in older saved shots; new scripts bind calls to a story beat. */
  startSecond?: number
  endSecond?: number
  visualBeatId: string
  responseTo: string | null
}

function record(value: unknown): Value | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Value : undefined
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const EPSILON = 1e-6

export function validateStoryVocalBeats(shot: unknown, options: { required?: boolean } = {}): string[] {
  const value = record(shot)
  const issues: string[] = []
  const active = options.required || value?.audioContractVersion !== undefined || value?.vocalBeats !== undefined
  if (!active) return issues
  if (!value || value.audioContractVersion !== STORY_ANIMAL_AUDIO_CONTRACT_VERSION) {
    issues.push(`audioContractVersion 必须为 ${STORY_ANIMAL_AUDIO_CONTRACT_VERSION}`)
  }
  const beats = value?.vocalBeats
  if (!Array.isArray(beats) || beats.length < 2) {
    issues.push('vocalBeats 每镜至少包含猫和狗各一声可听回应')
    return issues
  }
  const visual = Array.isArray(value?.visualBeats) ? value.visualBeats.map(record).filter((beat): beat is Value => Boolean(beat)) : []
  const visualById = new Map(visual.filter(beat => typeof beat.id === 'string').map(beat => [beat.id, beat]))
  const seenIds = new Set<string>()
  const valid: StoryVocalBeat[] = []
  for (const [index, candidate] of beats.entries()) {
    const beat = record(candidate), label = `vocalBeats[${index}]`
    if (!beat || typeof beat.id !== 'string' || !beat.id.trim() || seenIds.has(beat.id)) {
      issues.push(`${label}.id 必须唯一且非空`)
      continue
    }
    seenIds.add(beat.id)
    if (beat.speaker !== '芙伊' && beat.speaker !== '卷毛') {
      issues.push(`${label}.speaker 只能是芙伊或卷毛`)
      continue
    }
    const expected = beat.speaker === '芙伊' ? '喵儿' : '旺'
    if (beat.utterance !== expected) issues.push(`${label}.utterance ${beat.speaker}只能发“${expected}”`)
    const start = beat.startSecond, end = beat.endSecond
    const legacyTimed = start !== undefined || end !== undefined
    if (legacyTimed && (!finite(start) || !finite(end) || start < 0 || end - start < 0.2 - EPSILON || end - start > 1.5 + EPSILON)) {
      issues.push(`${label} 旧版叫声时间窗无效`)
      continue
    }
    if (legacyTimed && finite(value?.duration) && (end as number) > value.duration) issues.push(`${label} 叫声超出镜头时长`)
    const linked = typeof beat.visualBeatId === 'string' ? visualById.get(beat.visualBeatId) : undefined
    if (!linked || !finite(linked.startSecond) || !finite(linked.endSecond)
      || legacyTimed && ((start as number) < linked.startSecond - EPSILON || (end as number) > linked.endSecond + EPSILON)) {
      issues.push(`${label}.visualBeatId 必须指向对应的可见剧情段落`)
    } else if (!`${linked.action ?? ''}${linked.completion ?? ''}`.includes(beat.speaker)) {
      issues.push(`${label} 对应可见动作须出现发声角色 ${beat.speaker}`)
    }
    if (beat.responseTo !== null && (typeof beat.responseTo !== 'string' || !beat.responseTo.trim())) {
      issues.push(`${label}.responseTo 必须是上一声 id 或 null`)
    }
    valid.push(beat as StoryVocalBeat)
  }
  if (!valid.some(beat => beat.speaker === '芙伊') || !valid.some(beat => beat.speaker === '卷毛')) {
    issues.push('vocalBeats 每镜必须有芙伊“喵儿”和卷毛“旺”')
  }
  let interaction = false
  for (const [index, beat] of valid.entries()) {
    const beatPosition = visual.findIndex(item => item.id === beat.visualBeatId)
    const previous = valid[index - 1]
    const previousPosition = previous ? visual.findIndex(item => item.id === previous.visualBeatId) : -1
    if (previous && (beatPosition < previousPosition
      || finite(beat.startSecond) && finite(previous.endSecond) && beat.startSecond < previous.endSecond - EPSILON)) {
      issues.push(`vocalBeats ${beat.id} 与上一声顺序错误`)
    }
    if (beat.responseTo === null) continue
    const prior = valid.slice(0, index).find(row => row.id === beat.responseTo)
    if (!prior || prior.speaker === beat.speaker
      || visual.findIndex(item => item.id === prior.visualBeatId) >= beatPosition
      || finite(beat.startSecond) && finite(prior.endSecond)
        && (beat.startSecond < prior.endSecond - EPSILON || beat.startSecond - prior.endSecond > 3 + EPSILON)) {
      issues.push(`vocalBeats ${beat.id} 的 responseTo 必须指向先前另一角色的叫声`)
    } else interaction = true
  }
  if (!interaction) issues.push('vocalBeats 必须包含猫狗之间按时间回应的一来一回')
  const mood = String(value?.mood ?? '')
  if (/(?:仅环境声与动作音效|无人话、旁白、配音台词|全程无发音|全程无声|角色不发声)/u.test(mood)) {
    issues.push('mood 不得禁止猫狗按 vocalBeats 发出可听叫声')
  }
  return issues
}

export function renderStoryVocalBeats(shot: unknown): string {
  const value = record(shot)
  if (!value || !Array.isArray(value.vocalBeats)) return ''
  return (value.vocalBeats as StoryVocalBeat[]).map(beat =>
    `剧情段落 ${beat.visualBeatId}：${beat.speaker}${beat.speaker === '芙伊' ? '（猫）' : '（狗）'}发出自然${beat.speaker === '芙伊' ? '猫' : '犬'}叫“${beat.utterance}”，与本段的可见动作或反应相配${beat.responseTo ? '，回应对方' : ''}。`).join('\n')
}

/** Reproduce the reviewed sound timeline stored by older executions. New
 * scripts use beat-bound calls, but a saved paid request keeps its old clock. */
export function renderLegacyTimedStoryVocalBeats(shot: unknown): string {
  const value = record(shot)
  if (!value || !Array.isArray(value.vocalBeats)
    || value.vocalBeats.some(candidate => {
      const beat = record(candidate)
      return !beat || !finite(beat.startSecond) || !finite(beat.endSecond)
    })) return ''
  return (value.vocalBeats as StoryVocalBeat[]).map(beat =>
    `${beat.startSecond}–${beat.endSecond} 秒：${beat.speaker}${beat.speaker === '芙伊' ? '（猫）' : '（狗）'}在画面内发出清楚可听的真实${beat.speaker === '芙伊' ? '猫' : '犬'}叫“${beat.utterance}”，与嘴部和本段可见动作同步${beat.responseTo ? '，回应对方的叫声' : ''}。`).join('\n')
}
