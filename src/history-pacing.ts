import { storyboardTimelineMatches } from './storyboard-timeline.ts'
import { DURATION_PACING_VERSION, resolveDurationPolicy } from './duration-policy.ts'
type RecordValue = Record<string, unknown>
export const HISTORY_PACING_VERSION = 'dynamic-v1'
export const HISTORY_SPEECH_RATE = 4.5
export const HISTORY_TAIL_SECONDS = 0.3

export function historyTailSeconds(shot: RecordValue) {
  if ((shot.pacing as RecordValue)?.version === DURATION_PACING_VERSION) return resolveDurationPolicy((shot.pacing as RecordValue).timingPolicy).endingReadabilityReserve
  return (shot.pacing as RecordValue)?.version === HISTORY_PACING_VERSION ? HISTORY_TAIL_SECONDS : 1.5
}

export function historyFrameTimes(duration: number) {
  return [0, ...[0.2, 0.45, 0.7, 0.9].map(fraction => Number((duration * fraction).toFixed(2))), Math.max(0, duration - 0.08)]
}

type TimeWindow = { startSecond: number; endSecond: number }

export function unionSeconds(windows: TimeWindow[]) {
  let end = 0; let total = 0
  for (const window of [...windows].sort((a, b) => a.startSecond - b.startSecond)) {
    total += Math.max(0, window.endSecond - Math.max(window.startSecond, end))
    end = Math.max(end, window.endSecond)
  }
  return total
}

/** Explicit windows make overlap auditable: giving a pause an emotional name
 * cannot add time, and parallel speech/action/performance count only once. */
export function performanceStoryboardTiming(pacing: RecordValue, speechSeconds: number, shot?: RecordValue) {
  if (pacing.performanceBeats !== undefined && !Array.isArray(pacing.performanceBeats)) throw new Error('STORYBOARD_PACING_INVALID: performanceBeats 必须是表演节拍数组')
  const beats = (pacing.performanceBeats ?? []) as RecordValue[]
  // Declared activity windows are a timing contract even without performance beats.
  // Only legacy inputs without windows retain the aggregate-duration fallback.
  if (!beats.length && pacing.activityWindows === undefined) return undefined
  const activities = pacing.activityWindows as RecordValue[]
  const validWindow = (row: RecordValue) => Number.isFinite(row.startSecond) && Number.isFinite(row.endSecond)
    && Number(row.startSecond) >= 0 && Number(row.endSecond) > Number(row.startSecond)
  const kinds = ['speech', 'action', 'reaction']
  const usefulText = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim())
  if (!Array.isArray(activities) || activities.some(row => !row || !validWindow(row) || !kinds.includes(String(row.kind)))) throw new Error('STORYBOARD_PACING_INVALID: 须提供合法的 activityWindows 以核算对白、动作、反应的并行时间')
  if (new Set(beats.map(beat => beat?.id)).size !== beats.length || beats.some(beat => !beat || !validWindow(beat)
    || !['id', 'purpose', 'stateChange', 'evidenceAnchor'].every(key => usefulText(beat[key]))
    || !Array.isArray(beat.overlapWith) || beat.overlapWith.some(kind => !kinds.includes(String(kind)))
    || new Set(beat.overlapWith).size !== beat.overlapWith.length)) throw new Error('STORYBOARD_PACING_INVALID: performanceBeats 必须有唯一 id、目的、可观察状态变化、声画锚点、有效时间和 overlapWith')
  const toWindow = (row: RecordValue): TimeWindow => ({ startSecond: Number(row.startSecond), endSecond: Number(row.endSecond) })
  const budgetIssues: string[] = []
  for (const kind of kinds) {
    const windows = activities.filter(row => row.kind === kind).map(toWindow)
    const expected = kind === 'speech' ? speechSeconds : Number(pacing[`${kind}Seconds`])
    const actual = unionSeconds(windows)
    const total = windows.reduce((sum, row) => sum + row.endSecond - row.startSecond, 0)
    if (!Number.isFinite(expected) || expected < 0 || Math.abs(actual - expected) > 0.06 || Math.abs(total - actual) > 0.01) {
      budgetIssues.push(`${kind} activityWindows 应覆盖 ${Number(expected.toFixed(2))} 秒，actual=${actual}、expected=${expected} 秒；窗口数=${windows.length}${windows.length ? '' : '（空窗）'}、同类窗口总长=${total} 秒、重复覆盖=${Number((total - actual).toFixed(6))} 秒，不能重复计时或拉长自然语速`)
    }
  }
  // Shapes are already valid, so these three independent budgets can all be
  // reported in one repair. Do not continue dependent beat checks on failure.
  if (budgetIssues.length) throw new Error(`STORYBOARD_PACING_INVALID: ${budgetIssues.join('；')}`)
  for (const beat of beats) {
    const intersecting = kinds.filter(kind => activities.some(row => row.kind === kind && Math.min(Number(row.endSecond), Number(beat.endSecond)) > Math.max(Number(row.startSecond), Number(beat.startSecond))))
    if (JSON.stringify([...intersecting].sort()) !== JSON.stringify([...(beat.overlapWith as string[])].sort())) throw new Error(`STORYBOARD_PACING_INVALID: ${beat.id} 的 overlapWith 必须与实际时间交集一致`)
    // Purpose is editorial metadata. Only its visible action anchor can verify
    // the beat is actually written into the provider's executable timeline.
    if (shot && (!String(shot.videoPrompt ?? '').includes(String(beat.evidenceAnchor))
      || !/(?:走|递|接|放下|转身|抬|伸|收|松开|退|停步|推|握|展开|合上|让开|拒|离开|回望|移开|落下|垂下)/.test(String(beat.stateChange)))) {
      throw new Error(`STORYBOARD_PACING_INVALID: ${beat.id} 的表演必须通过时间轴中的可观察行动改变状态，不能用心理标签或保持静帧充数`)
    }
    if (shot) {
      const script = String(shot.videoPrompt ?? '').split(/【(?!\s*(?:第\s*)?\d)/)[0]
      const ranges = storyboardTimelineMatches(script)
      const anchored = ranges.some((range, index) => script.slice(range.index! + range[0].length, ranges[index + 1]?.index).includes(String(beat.evidenceAnchor))
        && Number(range[1]) < Number(beat.endSecond) && Number(range[2]) > Number(beat.startSecond))
      if (!anchored) throw new Error(`STORYBOARD_PACING_INVALID: ${beat.id} 的 evidenceAnchor 必须出现在对应表演时间内，不能借另一时间的动作延长静帧`)
    }
  }
  const windows = [...activities, ...beats].map(toWindow).sort((a, b) => a.startSecond - b.startSecond)
  let end = 0
  for (const window of windows) {
    if (window.startSecond - end > 1.2 + 1e-9) throw new Error('STORYBOARD_PACING_INVALID: 表演时间轴存在超过 1.2 秒的未解释空等')
    end = Math.max(end, window.endSecond)
  }
  const activitySeconds = unionSeconds(activities.map(toWindow))
  const occupiedSeconds = unionSeconds(windows)
  return { performanceSeconds: Number(unionSeconds(beats.map(toWindow)).toFixed(2)),
    additionalPerformanceSeconds: Number((occupiedSeconds - activitySeconds).toFixed(2)),
    overlapSeconds: Number((activities.reduce((sum, row) => sum + Number(row.endSecond) - Number(row.startSecond), 0)
      + beats.reduce((sum, row) => sum + Number(row.endSecond) - Number(row.startSecond), 0) - occupiedSeconds).toFixed(2)),
    occupiedSeconds: Number(occupiedSeconds.toFixed(2)), plannedEndSecond: end }
}

/** Voice-over time is arithmetic, not opinion: the spoken characters of `audioText` at the natural
 * rate plus punctuation and line gaps. Exported so a repair can recompute the same number the
 * validator will use instead of asking the writer to redo division for a 45-character narration. */
export function speechBudgetSeconds(audioText: string) {
  const text = audioText.split(/\r?\n/).map(line => line.replace(/^\s*[^：:\n]{1,24}[：:]\s*/, '')).join('\n')
  const characters = [...text].filter(char => /\p{Script=Han}/u.test(char)).length
  return characters / HISTORY_SPEECH_RATE
    + (text.match(/[，,；;]/g) ?? []).length * 0.15
    + (text.match(/[。！？!?]/g) ?? []).length * 0.25
    + Math.max(0, text.split('\n').filter(Boolean).length - 1) * 0.2
}

export function dynamicStoryboardTiming(audioText: string, pacing: RecordValue, shot?: RecordValue) {
  const text = audioText.split(/\r?\n/).map(line => line.replace(/^\s*[^：:\n]{1,24}[：:]\s*/, '')).join('\n')
  const characters = [...text].filter(char => /\p{Script=Han}/u.test(char)).length
  const speechSeconds = speechBudgetSeconds(audioText)
  const actionSeconds = Number(pacing.actionSeconds)
  const reactionSeconds = Number(pacing.reactionSeconds)
  if (!Number.isFinite(actionSeconds) || actionSeconds < 0 || actionSeconds > 10
    || !Number.isFinite(reactionSeconds) || reactionSeconds < 0.3 || reactionSeconds > 1.2) {
    throw new Error('STORYBOARD_PACING_INVALID: actionSeconds 为非对白并行的必要动作时间 0–10 秒，reactionSeconds 为自然反应 0.3–1.2 秒；不能用站桩填满片长')
  }
  const performance = performanceStoryboardTiming(pacing, speechSeconds, shot)
  const rawRequiredSeconds = Number(((performance?.plannedEndSecond ?? speechSeconds + actionSeconds + reactionSeconds) + HISTORY_TAIL_SECONDS).toFixed(2))
  const requiredDuration = Math.max(3, Math.ceil(rawRequiredSeconds))
  return { speechCharacterCount: characters, speechSeconds: Number(speechSeconds.toFixed(2)), actionSeconds, reactionSeconds,
    tailSeconds: HISTORY_TAIL_SECONDS, speechRate: HISTORY_SPEECH_RATE, rawRequiredSeconds, requiredDuration, ...(performance ?? {}) }
}

/** A location change is legal only after the dramatic unit has resolved. */
export function validateNarrativeOutline(scenes: RecordValue[]) {
  for (const [index, scene] of scenes.entries()) {
    if (typeof scene.dramaticUnitId !== 'string' || !scene.dramaticUnitId.trim()
      || typeof scene.closesUnit !== 'boolean' || !Array.isArray(scene.completionCriteria) || !scene.completionCriteria.length
      || scene.completionCriteria.some(item => typeof item !== 'string' || !item.trim())) {
      throw new Error(`STORYBOARD_NARRATIVE_INCOMPLETE: ${scene.id} 缺少 dramaticUnitId、closesUnit 和具体动作及回应的 completionCriteria`)
    }
    const previous = scenes[index - 1]
    if (previous && previous.closesUnit === false && (scene.dramaticUnitId !== previous.dramaticUnitId || scene.continuityFromPrevious !== true)) {
      throw new Error(`STORYBOARD_NARRATIVE_INCOMPLETE: ${previous.id} 的戏尚未结束，${scene.id} 必须先续完同一剧情单元，不能直接换场`)
    }
    if (previous?.closesUnit === true && scene.dramaticUnitId === previous.dramaticUnitId) throw new Error('STORYBOARD_NARRATIVE_INCOMPLETE: 已结束的剧情单元不能标为继续，须使用新单元 id')
  }
  if (scenes.at(-1)?.closesUnit !== true) throw new Error('STORYBOARD_NARRATIVE_INCOMPLETE: 本集结尾仍有未完成的剧情动作与回应')
}

export function validateNarrativeShot(shot: RecordValue, scene: RecordValue) {
  const progress = shot.storyProgress as RecordValue | undefined
  if (!progress || progress.unitId !== scene.dramaticUnitId || typeof progress.actionResult !== 'string' || !progress.actionResult.trim()
    || typeof progress.response !== 'string' || !progress.response.trim() || !Array.isArray(progress.pendingActions)
    || progress.pendingActions.some(item => typeof item !== 'string' || !item.trim())
    || progress.status !== (scene.closesUnit ? 'complete' : 'continuing')
    || (scene.closesUnit ? progress.pendingActions.length !== 0 : progress.pendingActions.length === 0)) {
    throw new Error('STORYBOARD_NARRATIVE_INCOMPLETE: storyProgress 必须声明实际动作结果、对手回应和未完成动作，与本场是否结束一致')
  }
}

export function narrativeTransitionIssue(scene: RecordValue, previousShot?: RecordValue, previousVideo?: RecordValue) {
  if (!scene.dramaticUnitId || !previousShot) return undefined
  const progress = previousShot.storyProgress as RecordValue | undefined
  if (!progress) return '前镜缺少剧情完成状态；旧分镜须重新规划，不能直接继续新规则'
  if (progress.status === 'continuing' && (scene.dramaticUnitId !== progress.unitId || scene.continuityFromPrevious !== true)) return '前镜剧情尚未结束，必须先续完动作和回应，禁止换场'
  if (progress.status === 'complete') {
    const closure = (previousVideo?.visualReview as RecordValue)?.narrativeClosure as RecordValue | undefined
    if (!closure || closure.unitId !== progress.unitId || closure.complete !== true
      || typeof closure.actionEvidence !== 'string' || !closure.actionEvidence.trim()
      || typeof closure.responseEvidence !== 'string' || !closure.responseEvidence.trim()
      || !Array.isArray(closure.unresolvedActions) || closure.unresolvedActions.length) return '前镜实际成片尚未证明动作与回应完成，禁止凭 cut 标记换场'
  }
  return undefined
}
