import { requireStoryVocalHumanAcceptance } from './story-vocal-manual-acceptance.ts'

type Value = Record<string, unknown>

function record(value: unknown): Value {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Value : {}
}

/** A stage may contain a Sanguo quality-accepted clip or a story clip whose
 * completed beat review is bound to the exact decoded video. Neither contract
 * implies that the assembled video has received a separate viewing pass. */
export function requireConcatCurrentAcceptance(value: unknown, workflowId?: string, decision?: unknown): { sourceSha256?: string; riskReminder?: Value } {
  const current = record(value)
  const review = record(current.storyMediaReview)
  if (workflowId === 'wf-story' && !Object.hasOwn(current, 'storyMediaReview')) {
    throw Error('VIDEO_CONCAT_QUALITY_REQUIRED: 本镜缺少猫狗叫声与画面质检，禁止进入阶段拼接')
  }
  if (Object.hasOwn(current, 'storyMediaReview') && review.vocalEvidence === undefined
    && (workflowId === 'wf-story' || review.vocalPlanRequired === true)) {
    throw Error('VIDEO_CONCAT_QUALITY_REQUIRED: 本镜缺少逐声同源证据，禁止进入阶段拼接')
  }
  const uncertain = review.version === 'story-shot-media-review-v1'
    && review.reviewStatus === 'uncertain' && review.passed === false && review.retryable === false
  if (review.vocalEvidence !== undefined) {
    try { return requireStoryVocalHumanAcceptance(current) }
    catch { throw Error('VIDEO_CONCAT_QUALITY_REQUIRED: 本镜猫狗叫声与口型尚未通过绑定当前原片的逐声人工听审，禁止进入阶段拼接') }
  }
  if (!Object.hasOwn(current, 'storyMediaReview')
    && current.passed === true && record(current.qualityReview).canProceed === true) return {}
  const evidence = record(review.videoEvidence)
  const savedEvidence = record(current.videoEvidence)
  const hash = evidence.sha256
  // Older story-style workflows use native sound without a per-call vocal
  // plan. Their decoded source track is the audio source; no WAV is mixed in.
  const nativeTrack = workflowId !== 'wf-story' && review.vocalEvidence === undefined
    && review.vocalPlanRequired !== true && record(current.params).sound === 'on'
    && record(current.params).requiredSound === 'on'
    && evidence.hasAudio === true && savedEvidence.hasAudio === true
    && typeof evidence.meanVolumeDb === 'number' && evidence.meanVolumeDb > -60
    && savedEvidence.meanVolumeDb === evidence.meanVolumeDb
    && typeof current.originalUrl === 'string' && current.originalUrl.length > 0
    && review.videoUrl === current.originalUrl && evidence.originalUrl === current.originalUrl
    && savedEvidence.originalUrl === current.originalUrl
  const sourceBound = evidence.decoded === true && savedEvidence.decoded === true
    && typeof current.url === 'string' && current.url === evidence.url && current.url === savedEvidence.url
    && typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash) && hash === savedEvidence.sha256
    && typeof evidence.evidenceUrl === 'string' && evidence.evidenceUrl.length > 0
    && evidence.evidenceUrl === savedEvidence.evidenceUrl
  const route = record(decision)
  const risk = record(route.riskReminder)
  const riskPass = workflowId === 'wf-workplace-second-trial-v1'
    && route.value === true && route.passed === true
    && ['invalid', 'unavailable', 'uncertain'].includes(String(review.reviewStatus))
    && review.passed === false && review.retryable === false
    && risk.reviewStatus === review.reviewStatus && risk.sourceVideoSha256 === hash
    && Array.isArray(risk.issues) && risk.issues.length > 0
    && typeof risk.message === 'string' && risk.message.length > 0
    && record(evidence.technicalValidation).passed === true
    && record(savedEvidence.technicalValidation).passed === true
  if (nativeTrack && sourceBound && riskPass && review.version === 'story-shot-media-review-v1') {
    return { sourceSha256: hash as string, riskReminder: risk }
  }
  if (nativeTrack && sourceBound && review.version === 'story-shot-media-review-v1'
    && (uncertain && Array.isArray(review.beatChecks) && review.beatChecks.length > 0
      && review.beatChecks.every((check: unknown) => record(check).status !== 'incomplete')
      && record(review.endingHold).status !== 'incomplete'
      || review.passed === true && review.reviewStatus === 'passed'
      && Array.isArray(review.issues) && review.issues.length === 0
      && Array.isArray(review.beatChecks) && review.beatChecks.length > 0
      && review.beatChecks.every((check: unknown) => record(check).status === 'complete')
      && record(review.endingHold).status === 'complete')) return { sourceSha256: hash as string }
  throw Error('VIDEO_CONCAT_QUALITY_REQUIRED: 本镜尚未通过绑定当前原片的画面与音频质检，禁止进入阶段拼接')
}

export function assertConcatCurrentBytes(sourceSha256: string | undefined, sourceHashes: string[]) {
  if (sourceSha256 && sourceHashes.at(-1) !== sourceSha256) {
    throw Error('VIDEO_CONCAT_SOURCE_CHANGED: 本轮原片字节与已通过的逐动作复核证据不一致')
  }
}
