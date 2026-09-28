import { deriveMediaRequirements } from './media-requirement-coverage.ts'

/** Deterministic requested times, not claims about decoded frames. Inspection
 * must clamp an endpoint to the last real frame and return its actual time.
 * Persisted code can embed this function after binding deriveMediaRequirements. */
export function deriveMediaSamplingPlan(shot: Record<string, unknown>, options: { maxFrames?: number } = {}) {
  const invalid = (reason: string): never => { throw Error('MEDIA_SAMPLING_PLAN_INVALID: ' + reason) }
  const duration = Number(shot.duration)
  if (!Number.isFinite(duration) || duration <= 0) invalid('分镜 duration 必须是有限正数，无法为未知时长推定采证')
  if (!options || typeof options !== 'object' || Array.isArray(options)) invalid('采样配置必须是包含 maxFrames 的对象')
  const maxFrames = options.maxFrames === undefined ? 24 : options.maxFrames
  if (!Number.isSafeInteger(maxFrames) || maxFrames < 2 || maxFrames > 24) invalid('maxFrames 必须是 2..24 的整数，以保留首尾采证且不超过采证服务上限')
  let requirements: ReturnType<typeof deriveMediaRequirements>
  try { requirements = deriveMediaRequirements(shot) } catch (error) {
    if (error instanceof Error && error.message.startsWith('MEDIA_REQUIREMENTS_INVALID:')) invalid('原时间窗无法提取；' + error.message)
    throw error
  }
  const intervals = requirements.filter(requirement => requirement.scope === 'interval')
  const requested = [0, duration]
  for (const interval of intervals) {
    const start = interval.startSecond, end = interval.endSecond
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > duration) {
      invalid('原时间窗 ' + interval.id + ' [' + start + ',' + end + '] 必须在 [0,' + duration + '] 内且具有正长度；不能裁掉越界原要求')
    }
    const midpoint = start + (end - start) / 2
    if (midpoint <= start || midpoint >= end) invalid('原时间窗 ' + interval.id + ' 太短，数值精度不足以区分起点、中点和终点')
    requested.push(start, midpoint, end)
  }
  requested.sort((left, right) => left - right)
  const sampleTimes: number[] = []
  for (const time of requested) {
    const previous = sampleTimes.at(-1)
    // Equivalent arithmetic results such as 0.15 and (0.1 + 0.2) / 2
    // describe one requested frame, while genuinely distinct times remain.
    if (previous === undefined || Math.abs(time - previous) > Number.EPSILON * 8 * Math.max(1, Math.abs(time), Math.abs(previous))) sampleTimes.push(time)
    else if (time === duration) sampleTimes[sampleTimes.length - 1] = duration
  }
  if (sampleTimes.length > maxFrames) {
    invalid('全部原时间窗起点/中点/终点及首尾需要 ' + sampleTimes.length + ' 帧，超过 maxFrames=' + maxFrames
      + '；未截断或忽略任何时间窗。请在服务上限 24 内调整采样预算，或调整原分镜时间窗配置；单独设置大于 24 的预算不能解决。原时间窗='
      + JSON.stringify(intervals.map(interval => ({ id: interval.id, startSecond: interval.startSecond, endSecond: interval.endSecond }))))
  }
  return { duration, maxFrames, sampleTimes }
}
