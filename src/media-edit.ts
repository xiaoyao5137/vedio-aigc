/** Derive an edit proposal from measured endpoints. This never edits media or
 * accepts its quality. Keep it self-contained for editable, persisted code nodes. */
export function deriveIdleTailEdit(input: {
  duration: number
  lastMeaningfulActionSecond: number
  lastSpeechEnd?: number
  performanceChecks?: Array<{ status?: unknown; endSecond?: unknown }>
  durationCompletion?: {
    applicable?: unknown; assessment?: unknown; passed?: unknown
    actualCompletionInterval?: { lower?: unknown; upper?: unknown } | null
    requiredEndSecond?: unknown
  }
  maxIdleTailSeconds: number
  tailSeconds: number
}) {
  const { duration, maxIdleTailSeconds, tailSeconds } = input
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(maxIdleTailSeconds) || maxIdleTailSeconds < 0
    || !Number.isFinite(tailSeconds) || tailSeconds < 0) {
    throw new Error('MEDIA_EDIT_CONFIG_INVALID: 裁尾需要有效原素材时长、空等预算和剪辑余量；不得因此重新生成视频')
  }
  const endpoints = [input.lastMeaningfulActionSecond, input.lastSpeechEnd ?? 0,
    ...(input.performanceChecks ?? []).filter(check => check.status === 'observed').map(check => check.endSecond as number)]
  const completion = input.durationCompletion
  let completionProtectedEnd = 0
  if (completion !== undefined) {
    const interval = completion.actualCompletionInterval
    if (completion.applicable !== true || completion.assessment !== 'complete' || completion.passed !== true
      || !interval || !Number.isFinite(interval.lower) || !Number.isFinite(interval.upper)
      || Number(interval.lower) < 0 || Number(interval.upper) < Number(interval.lower)
      || !Number.isFinite(completion.requiredEndSecond) || Number(completion.requiredEndSecond) < Number(interval.upper)
      || Number(completion.requiredEndSecond) > duration) {
      throw new Error('REVIEW_RESULT_INVALID: duration-v2裁剪缺少本素材已通过的逐节拍完成上界与可读余量，不能裁掉未完成或未知动作')
    }
    endpoints.push(Number(interval.upper))
    completionProtectedEnd = Number(completion.requiredEndSecond)
  }
  if (endpoints.some(second => !Number.isFinite(second) || second < 0 || second > duration)) {
    throw new Error('REVIEW_RESULT_INVALID: 裁尾所用实际动作、表演或ASR结束时刻缺失或超出原素材；应复核同一素材')
  }
  const lastRequiredSecond = Math.max(...endpoints)
  const idleSeconds = Number((duration - lastRequiredSecond).toFixed(3))
  if (duration - lastRequiredSecond <= maxIdleTailSeconds) return { lastRequiredSecond, idleSeconds, edit: null }
  const trimOut = Number(Math.min(duration, Math.max(lastRequiredSecond + tailSeconds, completionProtectedEnd)).toFixed(3))
  if (trimOut <= 0 || duration - trimOut <= .001) {
    throw new Error('MEDIA_EDIT_CONFIG_INVALID: 空等超预算但配置没有有效净裁切范围；应复核剪辑余量而非重新生成视频')
  }
  return { lastRequiredSecond, idleSeconds, edit: { trimIn: 0, trimOut, sourceDuration: duration,
    keptSeconds: trimOut, removedSeconds: Number((duration - trimOut).toFixed(3)), status: 'required' as const } }
}
