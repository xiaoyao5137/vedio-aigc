type Value = Record<string, unknown>

function object(value: unknown): Value {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Value : {}
}

function label(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Render signed duration-v2 dependencies as event gates at the paid video
 * boundary. The stored script and schedule remain byte-for-byte unchanged.
 * A clock window is a target; the successor must wait for actual completion. */
export function durationCausalVideoGuard(params: Value, options: { pictureOnly?: boolean } = {}): string {
  if (params.pacingVersion !== 'duration-v2') return ''
  const pacing = object(params.pacing)
  if (pacing.version !== 'duration-v2' || !Array.isArray(pacing.beats)
    || !pacing.beats.some(beat => {
      const item = object(beat)
      return (item.kind === 'action' || item.kind === 'reaction' || options.pictureOnly && item.kind === 'speech')
        && Array.isArray(item.dependsOn) && item.dependsOn.length > 0
    })) return ''
  // Standalone model previews can carry an unsigned pacing draft. The paid
  // workflow supplies the top-level verified hash before this guard applies.
  if (params.scheduleHash === undefined) return ''
  // Only a complete, signed compiler result is eligible. The workflow paid
  // gate verifies the hash itself; this local check prevents a stale/partial
  // adapter payload from silently omitting the event instruction.
  if (!label(pacing.scheduleHash).startsWith('duration-v2-sha256-')
    || pacing.scheduleHash !== params.scheduleHash
    || !label(pacing.compiledVideoPrompt)
    || !label(params.videoTimeline).includes(label(pacing.compiledVideoPrompt))
    || !Array.isArray(pacing.schedule)) {
    throw new Error('DURATION_CAUSAL_PROMPT_INVALID: 动作依赖缺少当前已编译排程，已阻止付费视频请求')
  }
  const beats = pacing.beats.map(object)
  const byId = new Map(beats.map(beat => [label(beat.id), beat]))
  const schedule = new Map(pacing.schedule.map((row: unknown) => {
    const item = object(row)
    return [label(item.beatId), item] as const
  }))
  const groups = new Map((Array.isArray(pacing.actorGroups) ? pacing.actorGroups : []).map((group: unknown) => {
    const item = object(group)
    return [label(item.id), label(item.label)] as const
  }))
  const rows: string[] = []
  for (const successor of beats) {
    if (successor.kind !== 'action' && successor.kind !== 'reaction') continue
    const dependencies = Array.isArray(successor.dependsOn) ? successor.dependsOn : []
    if (!dependencies.length) continue
    const start = Number(schedule.get(label(successor.id))?.startSecond)
    const prerequisites = dependencies.map(value => {
      const id = label(value), prior = byId.get(id), finish = Number(schedule.get(id)?.endSecond)
      if (!id || !prior || !Number.isFinite(start) || !Number.isFinite(finish) || finish > start + .001) {
        throw new Error(`DURATION_CAUSAL_PROMPT_INVALID: ${label(successor.id)} 前置 ${id || '未知'} 不属于有效排程`)
      }
      const completion = object(prior.completion)
      const speaker = Array.isArray(prior.actorIds) ? prior.actorIds.map(id => groups.get(label(id)) || label(id)).filter(Boolean).join('、') : ''
      if (prior.kind === 'speech' || prior.kind === 'vocalization') {
        return options.pictureOnly
          ? `独立画外配音(${id})对应时间窗至${finish}秒结束`
          : `${speaker || '该声部'}(${id})完整收音${completion.modality === 'audio-visual' ? '且画内对应口型结束' : ''}`
      }
      if (completion.modality === 'visual' || completion.modality === 'audio-visual') {
        const finalState = label(completion.finalState)
        if (!finalState) throw new Error(`DURATION_CAUSAL_PROMPT_INVALID: ${id} 缺少可见完成态`)
        return `「${finalState}」画面可见${completion.modality === 'audio-visual' ? options.pictureOnly
          ? `且独立画外配音(${id})对应时间窗至${finish}秒结束`
          : `且${speaker || '该声部'}(${id})完整收音` : ''}`
      }
      return options.pictureOnly ? `独立画外配音(${id})对应时间窗至${finish}秒结束` : `${speaker || '该声部'}(${id})完整收音`
    })
    const anchor = label(object(successor.completion).evidenceAnchor)
      || label(successor.textOrVocalization).split(/[。；;！!？?]/)[0]
    if (!anchor) throw new Error(`DURATION_CAUSAL_PROMPT_INVALID: ${label(successor.id)} 缺少后继动作锚点`)
    const action = label(successor.textOrVocalization)
    const travelling = /走|步|靠近|接近|赶到|奔|跑|骑|入画|离开|上前|前进|退至|移向/.test(action)
    const actors = Array.isArray(successor.actorIds) ? successor.actorIds.map(id => groups.get(label(id)) || label(id)).filter(Boolean) : []
    const hold = travelling ? `；此前${actors.length === 1 ? actors[0] : '执行者'}${/骑马|骑行|乘马|坐骑/.test(action) ? '不得提前骑近或入画' : '留原位、不迈第一步'}` : ''
    rows.push(`「${anchor}」须在${prerequisites.join('且')}后才启动${hold}`)
  }
  if (options.pictureOnly) for (const successor of beats) {
    if (successor.kind !== 'speech') continue
    for (const dependency of Array.isArray(successor.dependsOn) ? successor.dependsOn : []) {
      const prior = byId.get(label(dependency))
      if (prior?.kind !== 'action' && prior?.kind !== 'reaction') continue
      const finalState = label(object(prior.completion).finalState)
      const priorEnd = Number(schedule.get(label(dependency))?.endSecond)
      const speechStart = Number(schedule.get(label(successor.id))?.startSecond)
      if (!finalState || !Number.isFinite(priorEnd) || !Number.isFinite(speechStart)
        || priorEnd > speechStart + .001) throw new Error(`DURATION_CAUSAL_PROMPT_INVALID: ${label(successor.id)} 前置 ${label(dependency)} 不属于有效排程`)
      rows.push(`「${finalState}」须先画面可见，才到${label(successor.id)}对应后期画外配音进入点；画内无人发声`)
    }
  }
  return rows.length ? `【因果动作锁】${rows.join('；')}。前置未完成时只延续原动作，后继动作不得抢先；时间窗不能代替可见完成。` : ''
}
