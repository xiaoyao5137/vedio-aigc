/** A short story shot has to finish each visible action before its final hold.
 * This is a planning gate; actual completion still needs evidence from the
 * rendered video. */
import { renderLegacyTimedStoryVocalBeats, renderStoryVocalBeats, validateStoryVocalBeats } from './story-shot-vocals.ts'

export const STORY_SHOT_MIN_BEAT_SECONDS = 2
export const STORY_SHOT_ENDING_RESERVE_SECONDS = 1

type Value = Record<string, unknown>

export type StoryScriptSource = {
  version: 'story-script-source-v1'
  sourceExecutionId: string
  sourceRunId: string
  shots: Array<{ title: string; content: string; firstFramePrompt: string; requiredActions: string[];
    originalBeats: Array<{ action: string; completion: string }>;
    originalVocalSequence?: Array<{ speaker: string; utterance: string; responseToIndex: number | null }> }>
}

export class StoryShotTimingError extends Error {
  readonly code = 'STORY_SHOT_TIMING_INVALID'
  readonly issues: string[]

  constructor(issues: string[]) {
    super(`STORY_SHOT_TIMING_INVALID: ${issues.slice(0, 12).join('；')}${issues.length > 12 ? `；另有 ${issues.length - 12} 项` : ''}`)
    this.name = 'StoryShotTimingError'
    this.issues = issues
  }
}

function record(value: unknown): Value | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Value : undefined
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function second(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

const near = (left: number, right: number) => Math.abs(left - right) < 1e-6

type StoryContentAction = { action: string; startSecond?: number; endSecond?: number }

// A range may say “0—2秒” or “0秒—2秒”; a point such as “2秒后”
// binds the beat opening only. Untimed legacy content retains its words.
const CONTENT_RANGE_PREFIX = /^\s*第?\s*(\d+(?:\.\d+)?)\s*(?:秒(?:钟)?)?\s*(?:[—–\-~～]|至|到)\s*(\d+(?:\.\d+)?)\s*秒(?:钟)?(?:内|时|后)?\s*[，,:：]?\s*/u
const CONTENT_POINT_PREFIX = /^\s*第?\s*(\d+(?:\.\d+)?)\s*秒(?:钟)?(?:内|时|后)?\s*[，,:：]?\s*/u

function contentActions(content: string): StoryContentAction[] {
  return content.split(/[；;。\n]+/u).map(part => {
    const range = part.match(CONTENT_RANGE_PREFIX)
    if (range) return { action: part.slice(range[0].length).trim(), startSecond: Number(range[1]), endSecond: Number(range[2]) }
    const point = part.match(CONTENT_POINT_PREFIX)
    if (point) return { action: part.slice(point[0].length).trim(), startSecond: Number(point[1]) }
    return { action: part.trim() }
  }).filter(part => part.action)
}

function requiredActions(content: string): string[] {
  return contentActions(content).map(part => part.action)
}

function actionKey(value: string): string {
  return value.replace(/[\s，,。.!！?？：:；;、]/gu, '')
}

/** Carry the approved story itself into a retry fork. Only timing may change. */
export function createStoryScriptSource(output: unknown, provenance: { sourceExecutionId: string; sourceRunId: string }): StoryScriptSource {
  const shots = Array.isArray(output) ? output : record(output)?.shots
  if (!nonempty(provenance.sourceExecutionId) || !nonempty(provenance.sourceRunId) || !Array.isArray(shots) || !shots.length) {
    throw new StoryShotTimingError(['原剧本记录或分镜数组不完整，不能无来源重排'])
  }
  return {
    version: 'story-script-source-v1', ...provenance,
    shots: shots.map((candidate, index) => {
      const shot = record(candidate)
      if (!shot || !nonempty(shot.title) || !nonempty(shot.content) || !nonempty(shot.firstFramePrompt)) {
        throw new StoryShotTimingError([`原剧本第 ${index + 1} 镜缺少标题、正文或首帧，不能无来源重排`])
      }
      const actions = requiredActions(shot.content)
      if (!actions.length) throw new StoryShotTimingError([`原剧本第 ${index + 1} 镜没有可保留的动作正文`])
      const originalBeats = Array.isArray(shot.visualBeats) ? shot.visualBeats.map((candidateBeat, beatIndex) => {
        const beat = record(candidateBeat)
        if (!beat || !nonempty(beat.action) || !nonempty(beat.completion)) {
          throw new StoryShotTimingError([`原剧本第 ${index + 1} 镜第 ${beatIndex + 1} 项原节拍不完整`])
        }
        return { action: beat.action, completion: beat.completion }
      }) : []
      if (originalBeats.length && originalBeats.length !== actions.length) {
        throw new StoryShotTimingError([`原剧本第 ${index + 1} 镜的正文动作与逐项节拍数不一致，不能无来源重排`])
      }
      const vocals = Array.isArray(shot.vocalBeats) ? shot.vocalBeats.map(record) : undefined
      const originalVocalSequence = vocals?.map((beat, beatIndex) => ({
        speaker: String(beat?.speaker ?? ''), utterance: String(beat?.utterance ?? ''),
        responseToIndex: beat?.responseTo == null ? null
          : vocals.findIndex((candidate, index) => index < beatIndex && candidate?.id === beat.responseTo),
      }))
      return { title: shot.title, content: shot.content, firstFramePrompt: shot.firstFramePrompt,
        requiredActions: actions, originalBeats, ...(originalVocalSequence ? { originalVocalSequence } : {}) }
    }),
  }
}

export function readStoryScriptSource(value: unknown): StoryScriptSource {
  const source = record(value)
  if (!source || source.version !== 'story-script-source-v1' || !nonempty(source.sourceExecutionId)
    || !nonempty(source.sourceRunId) || !Array.isArray(source.shots) || !source.shots.length) {
    throw new StoryShotTimingError(['重试记录中的原剧本绑定无效'])
  }
  for (const [index, candidate] of source.shots.entries()) {
    const shot = record(candidate)
    const actions = shot?.requiredActions
    if (!shot || !nonempty(shot.title) || !nonempty(shot.content) || !nonempty(shot.firstFramePrompt)
      || !Array.isArray(actions) || !actions.length || actions.some(action => !nonempty(action))
      || JSON.stringify(actions) !== JSON.stringify(requiredActions(shot.content))
      || !Array.isArray(shot.originalBeats) || shot.originalBeats.some(candidateBeat => {
        const beat = record(candidateBeat)
        return !beat || !nonempty(beat.action) || !nonempty(beat.completion)
      }) || shot.originalBeats.length > 0 && shot.originalBeats.length !== actions.length
      || shot.originalVocalSequence !== undefined && (!Array.isArray(shot.originalVocalSequence)
        || shot.originalVocalSequence.some(candidateVocal => {
          const vocal = record(candidateVocal)
          return !vocal || !nonempty(vocal.speaker) || !nonempty(vocal.utterance)
            || vocal.responseToIndex !== null && (!Number.isSafeInteger(vocal.responseToIndex)
              || Number(vocal.responseToIndex) < 0)
        }))) {
      throw new StoryShotTimingError([`重试记录中的原剧本第 ${index + 1} 镜绑定无效`])
    }
  }
  return source as StoryScriptSource
}

export function storyScriptSourcePrompt(source: StoryScriptSource): string {
  return `\n【本次时长重排的原剧本，必须逐镜保留】来源记录 ${source.sourceExecutionId}、节点 ${source.sourceRunId}。` +
    '只能重排 duration、content 的秒点和 visualBeats 的时间窗；title 与每项剧情动作原句必须保留。' +
    'firstFramePrompt 必须以原文开头，只可在末尾补充不超过 140 字的主体相对位置、可见身体部位或接触前间隙澄清；不得加入新的道具或剧情。' +
    'visualBeats 按原动作顺序逐项填写；原稿没有 originalBeats 时，action 直接复制对应 requiredActions 原句，completion 写该动作实际可见的完成状态；' +
    '原稿已有 originalBeats 时，其 action 和 completion 必须保持。不得替换主题、道具、人物动作或增加新的结尾情节。' +
    '原稿有 originalVocalSequence 时，猫狗每声的说话人、拟声词、先后顺序和回应关系必须保留；叫声只关联对应剧情段落，不另指定秒点。' +
    `原剧本：${JSON.stringify(source.shots)}`
}

/** Validate the normalized wf-story JSON before its image/video loop begins.
 * `output` may be the raw shots array or `normalizeStructuredTextOutput`'s
 * `{shots, items, ...}` wrapper. The original value is returned unchanged. */
export function validateStoryShotTimingOutput<T>(output: T, options: { expectedCount?: number; source?: StoryScriptSource;
  requireAnimalInteraction?: boolean } = {}): T {
  const envelope = record(output)
  const shots = Array.isArray(output) ? output : envelope?.shots
  const issues: string[] = []
  if (!Array.isArray(shots) || shots.length === 0) {
    throw new StoryShotTimingError(['分镜剧本必须包含非空 shots 数组'])
  }
  if (options.expectedCount !== undefined && (!Number.isSafeInteger(options.expectedCount) || options.expectedCount < 1)) {
    issues.push('expectedCount 必须是正整数')
  } else if (options.expectedCount !== undefined && shots.length !== options.expectedCount) {
    issues.push(`分镜数量 ${shots.length} 与要求的 ${options.expectedCount} 不符`)
  }
  if (envelope?.items !== undefined && (!Array.isArray(envelope.items) || envelope.items.length !== shots.length)) {
    issues.push('items 与 shots 数量不一致')
  }
  const source = options.source ? readStoryScriptSource(options.source) : undefined
  if (source && shots.length !== source.shots.length) issues.push('重排后的分镜数量与原剧本不一致')

  shots.forEach((candidate, shotIndex) => {
    const shot = record(candidate)
    const label = `shots[${shotIndex}]`
    if (!shot) { issues.push(`${label} 必须是对象`); return }
    for (const field of ['title', 'content', 'camera', 'mood', 'firstFramePrompt']) {
      if (!nonempty(shot[field])) issues.push(`${label}.${field} 必须是非空文字`)
    }
    const original = source?.shots[shotIndex]
    if (original) {
      if (shot.title !== original.title) issues.push(`${label}.title 改写了原剧本标题`)
      if (!nonempty(shot.firstFramePrompt) || !shot.firstFramePrompt.startsWith(original.firstFramePrompt)
        || shot.firstFramePrompt.length - original.firstFramePrompt.length > 140) {
        issues.push(`${label}.firstFramePrompt 必须保留原剧本首帧原文；仅可追加简短的空间位置澄清`)
      }
      const currentActions = nonempty(shot.content) ? requiredActions(shot.content) : []
      if (currentActions.length !== original.requiredActions.length || currentActions.some((action, index) =>
        actionKey(action) !== actionKey(original.requiredActions[index]))) {
        issues.push(`${label}.content 丢失、增添或改写了原剧本动作；只允许改秒点`)
      }
      if (original.originalVocalSequence) {
        const vocals = Array.isArray(shot.vocalBeats) ? shot.vocalBeats.map(record) : []
        const sequence = vocals.map((beat, index) => ({ speaker: String(beat?.speaker ?? ''),
          utterance: String(beat?.utterance ?? ''), responseToIndex: beat?.responseTo == null ? null
            : vocals.findIndex((candidate, priorIndex) => priorIndex < index && candidate?.id === beat.responseTo) }))
        if (JSON.stringify(sequence) !== JSON.stringify(original.originalVocalSequence)) {
          issues.push(`${label}.ANIMAL_INTERACTION_INVALID: vocalBeats 改写了原剧本已确定的叫声或回应顺序`)
        }
      }
    }
    const duration = shot.duration
    if (typeof duration !== 'number' || !Number.isInteger(duration) || duration < 3 || duration > 15) {
      issues.push(`${label}.duration 必须是 3–15 秒整数；超过 15 秒须报错等待重排，不能截断`)
    }
    issues.push(...validateStoryVocalBeats(shot, { required: options.requireAnimalInteraction })
      .map(issue => `${label}.ANIMAL_INTERACTION_INVALID: ${issue}`))
    const beats = shot.visualBeats
    if (!Array.isArray(beats) || beats.length === 0) {
      issues.push(`${label}.visualBeats 必须逐项列出有可观察完成状态的动作或反应`)
      return
    }
    // Every newly planned script is checked here with expectedCount, including
    // the first generation. A timed shot is also checked when an old saved
    // record reaches the paid-video preflight through renderStoryShotTimedActions.
    // Untimed legacy media-review fixtures remain readable without claiming
    // they satisfy the current planning contract.
    const contentPlan = nonempty(shot.content) ? contentActions(shot.content) : []
    const hasTimedActions = contentPlan.some(part => part.startSecond !== undefined)
    const checkContentActions = options.expectedCount !== undefined || Boolean(original) || hasTimedActions
    if (checkContentActions && contentPlan.length !== beats.length) {
      issues.push(`${label}.visualBeats 必须与 content 中逐项动作一一对应；正文有 ${contentPlan.length} 项，节拍有 ${beats.length} 项`)
    }
    if (checkContentActions && hasTimedActions && contentPlan.some(part => part.startSecond === undefined)) {
      issues.push(`${label}.content 已使用数字秒点，须给每项动作标出起始秒点`)
    }
    if (original && beats.length !== original.requiredActions.length) {
      issues.push(`${label}.visualBeats 必须与原剧本逐项动作一一对应`)
    }
    const ids = new Set<string>()
    let previousEnd: number | undefined
    beats.forEach((candidateBeat, beatIndex) => {
      const beat = record(candidateBeat)
      const beatLabel = `${label}.visualBeats[${beatIndex}]`
      if (!beat) { issues.push(`${beatLabel} 必须是对象`); return }
      if (!nonempty(beat.id)) issues.push(`${beatLabel}.id 必须是非空文字`)
      else if (ids.has(beat.id.trim())) issues.push(`${beatLabel}.id ${beat.id.trim()} 重复`)
      else ids.add(beat.id.trim())
      if (!nonempty(beat.action)) issues.push(`${beatLabel}.action 必须描述实际可见动作或反应`)
      if (!nonempty(beat.completion)) issues.push(`${beatLabel}.completion 必须描述可观察的完成状态`)
      const contentAction = contentPlan[beatIndex]
      if (checkContentActions && contentAction && nonempty(beat.action) && actionKey(beat.action) !== actionKey(contentAction.action)) {
        issues.push(`${beatLabel}.action 必须按顺序复制 content 对应动作原句（只去掉秒点），不得合并、改写或遗漏`)
      }
      const requiredAction = original?.originalBeats[beatIndex]?.action ?? original?.requiredActions[beatIndex]
      if (requiredAction && nonempty(beat.action)
        && actionKey(beat.action) !== actionKey(requiredAction)) {
        issues.push(`${beatLabel}.action 必须保留对应的原剧本动作原句`)
      }
      const priorBeat = original?.originalBeats[beatIndex]
      if (priorBeat && (beat.action !== priorBeat.action || beat.completion !== priorBeat.completion)) {
        issues.push(`${beatLabel} 改写了原剧本已确定的动作或完成状态`)
      }
      const start = beat.startSecond, end = beat.endSecond
      if (!second(start) || !second(end) || end <= start) {
        issues.push(`${beatLabel} 必须有有效的 startSecond/endSecond 时间窗`)
        return
      }
      if (checkContentActions && contentAction?.startSecond !== undefined
        && (!near(start, contentAction.startSecond)
          || contentAction.endSecond !== undefined && !near(end, contentAction.endSecond))) {
        issues.push(`${beatLabel} 的 content 秒点与 visualBeats.startSecond/endSecond 不一致`)
      }
      if (beatIndex === 0 && !near(start, 0)) issues.push(`${beatLabel} 必须从 0 秒开始`)
      if (previousEnd !== undefined && !near(start, previousEnd)) {
        issues.push(`${beatLabel} 必须从上一动作结束处连续开始，不可重叠或留空档`)
      }
      if (end - start + 1e-6 < STORY_SHOT_MIN_BEAT_SECONDS) {
        issues.push(`${beatLabel} 只分配 ${Number((end - start).toFixed(2))} 秒，少于可读动作最小预算 ${STORY_SHOT_MIN_BEAT_SECONDS} 秒`)
      }
      if (typeof duration === 'number' && Number.isFinite(duration) && end > duration) {
        issues.push(`${beatLabel} 结束于 ${end} 秒，超出分镜时长 ${duration} 秒`)
      }
      previousEnd = end
    })
    if (typeof duration === 'number' && Number.isFinite(duration) && previousEnd !== undefined
      && duration - previousEnd + 1e-6 < STORY_SHOT_ENDING_RESERVE_SECONDS) {
      issues.push(`${label} 最后一项完成后须保留至少 ${STORY_SHOT_ENDING_RESERVE_SECONDS} 秒可读收尾`)
    }
  })
  if (issues.length) throw new StoryShotTimingError(issues)
  return output
}

/** Build the video motion instruction from the validated plan, so its action
 * list and timings cannot diverge from a second free-form timeline. */
export function renderStoryShotTimedActions(shot: unknown, vocalFormat: 'beat-bound' | 'legacy-timed' = 'beat-bound'): string {
  const value = record(shot)
  if (!value) throw new StoryShotTimingError(['分镜必须是对象'])
  // The paid-video preflight must check action coverage even when a saved
  // legacy shot has no numeric time prefixes in its content.
  validateStoryShotTimingOutput([value], { expectedCount: 1 })
  const beats = value.visualBeats as Value[]
  const lines = beats.map(beat => `${beat.startSecond}–${beat.endSecond} 秒：${String(beat.action).trim()}；完成时可见：${String(beat.completion).trim()}。`)
  const lastEnd = beats.at(-1)!.endSecond
  lines.push(`${lastEnd}–${value.duration} 秒：保持已完成状态，留给观众辨认，不新增剧情动作。`)
  const vocals = vocalFormat === 'legacy-timed' ? renderLegacyTimedStoryVocalBeats(value) : renderStoryVocalBeats(value)
  if (vocals) lines.push(`${vocalFormat === 'legacy-timed' ? '【角色叫声，须按时发出】' : '【各剧情段落的角色声音】'}\n${vocals}`)
  return lines.join('\n')
}
