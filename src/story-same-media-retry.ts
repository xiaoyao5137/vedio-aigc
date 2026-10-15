type Value = Record<string, unknown>

export type StorySameMediaReviewRetry = {
  version: 'story-same-media-review-retry-v1'
  sourceExecutionId: string
  sourceRunId: string
  sourceLoopIndex: number | null
  sourceShotJson: string
  sourceUrl: string
  sourceVideoSha256: string | null
  sourceReviewStatus: string
  sourceOutput: Value
}

type StoryVideoRun = {
  id: string
  status: string
  node: { id: string }
  error?: string
  output?: unknown
  loopItem?: unknown
  loopIndex?: number
  retryFeedback?: unknown
}

const record = (value: unknown): Value | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Value : undefined
const videoUrl = (value: unknown): value is string => typeof value === 'string'
  && (/^\/generated\/[\w.-]+\.(?:mp4|mov|webm)$/i.test(value)
    || /^https?:\/\/[^\s]+\.(?:mp4|mov|webm)(?:\?[^\s]*)?$/i.test(value))

/** JSONB can reorder object keys when the fork is reloaded. Keep the shot
 * binding stable across persistence without relaxing any field or value. */
export function storyShotIdentity(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical)
    const object = record(item)
    return object ? Object.fromEntries(Object.keys(object).sort().map(key => [key, canonical(object[key])])) : item
  }
  return JSON.stringify(canonical(value)) ?? ''
}

/** Only a failed review with retained paid media is eligible for review-only
 * retry. A confirmed incomplete action remains an intentional new-candidate
 * choice; review uncertainty and reviewer outage must not buy a new video. */
export function selectStorySameMediaReviewRetry(run: StoryVideoRun | undefined, executionId: string): StorySameMediaReviewRetry | undefined {
  if (!run || run.node.id !== 'node-video') return undefined
  // A persisted running checkpoint can still belong to a live request in
  // another tab. Never turn it into a new paid generation (or a duplicate
  // review) merely because this tab cannot see that request. An explicitly
  // audited interruption must first be restored to an idle checkpoint.
  if (run.status === 'running') {
    readStorySameMediaReviewRetry(run.retryFeedback, run)
    throw new Error('STORY_VIDEO_RUNNING_RETRY_BLOCKED: 视频节点仍标记为运行中；请先核实原请求并恢复中断检查点，禁止重新购买视频或重复复核')
  }
  // A prepared review-only checkpoint can be retried from the UI before its
  // first review starts. Keep its validated pointer instead of clearing it and
  // silently turning that click into a paid video generation.
  if (run.status === 'idle') return readStorySameMediaReviewRetry(run.retryFeedback, run)
  if (run.status !== 'failed') return undefined
  const output = record(run.output)
  const review = record(output?.storyMediaReview)
  const reviewFailure = /^STORY_SHOT_[A-Z_-]+:/.test(String(run.error ?? output?.error ?? ''))
  if (review?.passed === false && review.retryable === true && review.reviewStatus === 'incomplete') return undefined
  if (!reviewFailure && !review) return undefined
  const url = output?.url
  if (!output || !videoUrl(url) || !executionId || !run.id || !record(run.loopItem)) {
    throw new Error('STORY_SAME_MEDIA_RETRY_INVALID: 已保存的原视频或原分镜绑定不完整，禁止重新购买视频')
  }
  return {
    version: 'story-same-media-review-retry-v1', sourceExecutionId: executionId, sourceRunId: run.id,
    sourceLoopIndex: Number.isSafeInteger(run.loopIndex) ? run.loopIndex! : null,
    sourceShotJson: storyShotIdentity(run.loopItem), sourceUrl: url,
    sourceVideoSha256: typeof record(review?.videoEvidence)?.sha256 === 'string' ? String(record(review?.videoEvidence)?.sha256) : null,
    sourceReviewStatus: typeof review?.reviewStatus === 'string' ? review.reviewStatus : 'unavailable',
    sourceOutput: output,
  }
}

export function withStorySameMediaReviewRetry(feedback: unknown, retry: StorySameMediaReviewRetry): Value {
  return { ...(record(feedback) ?? {}), storySameMediaReviewRetry: retry }
}

/** If a persisted retry pointer is malformed or belongs to another shot,
 * fail closed before any provider request can be made. */
export function readStorySameMediaReviewRetry(feedback: unknown, run: StoryVideoRun): StorySameMediaReviewRetry | undefined {
  const value = record(feedback)
  if (!value || !Object.hasOwn(value, 'storySameMediaReviewRetry')) return undefined
  const retry = record(value.storySameMediaReviewRetry)
  const sourceOutput = record(retry?.sourceOutput)
  if (retry?.version !== 'story-same-media-review-retry-v1' || !retry.sourceExecutionId
    || retry.sourceRunId !== run.id || retry.sourceLoopIndex !== (run.loopIndex ?? null)
    || retry.sourceShotJson !== storyShotIdentity(run.loopItem) || !videoUrl(retry.sourceUrl)
    || !sourceOutput || sourceOutput.url !== retry.sourceUrl) {
    throw new Error('STORY_SAME_MEDIA_RETRY_INVALID: 同素材复核来源与当前分镜不一致，禁止视频付费调用')
  }
  return retry as StorySameMediaReviewRetry
}

/** Used only after an external audit proves the old review request has ended.
 * Preserve the saved-media pointer and every resolved input while making the
 * checkpoint eligible for a single review-only retry. */
export function recoverInterruptedStorySameMediaReviewRun<Run extends StoryVideoRun & { startedAt?: number; durationMs?: number }>(run: Run): Run {
  if (run.status !== 'running' || run.node.id !== 'node-video'
    || !readStorySameMediaReviewRetry(run.retryFeedback, run)) {
    throw new Error('STORY_SAME_MEDIA_RECOVERY_INVALID: 仅允许恢复保留原片指针的运行中审核节点')
  }
  return { ...run, status: 'idle', startedAt: undefined, durationMs: 0 }
}

export function storySameMediaReviewProvenance(retry: StorySameMediaReviewRetry) {
  return { version: retry.version, sourceExecutionId: retry.sourceExecutionId, sourceRunId: retry.sourceRunId,
    sourceLoopIndex: retry.sourceLoopIndex, sourceUrl: retry.sourceUrl,
    sourceVideoSha256: retry.sourceVideoSha256, sourceReviewStatus: retry.sourceReviewStatus }
}

/** Review retries execute exactly the selected saved-media node. A successful
 * review leaves later image/video nodes pending for an explicit user action. */
export async function executeStorySameMediaReviewOnly<TState extends { nodeRuns: Array<{ status: string }> }>(
  index: number, state: TState, executeStep: (index: number, state: TState) => Promise<TState | undefined>,
): Promise<{ state: TState | undefined; passed: boolean }> {
  const reviewed = await executeStep(index, state)
  return { state: reviewed, passed: reviewed?.nodeRuns[index]?.status === 'success' }
}
