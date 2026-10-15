import test from 'node:test'
import assert from 'node:assert/strict'
import { executeStorySameMediaReviewOnly, readStorySameMediaReviewRetry, recoverInterruptedStorySameMediaReviewRun, selectStorySameMediaReviewRetry,
  storySameMediaReviewProvenance, storyShotIdentity, withStorySameMediaReviewRetry } from '../src/story-same-media-retry.ts'

function run() {
  return { id: 'video-1', status: 'failed', node: { id: 'node-video' }, loopIndex: 1,
    loopItem: { title: '公司的午睡搭子', duration: 6 }, error: 'STORY_SHOT_UNCERTAIN: 证据不足',
    output: { url: '/generated/video-a.mp4', originalUrl: 'https://example.com/video.mp4',
      storyMediaReview: { passed: false, retryable: false, reviewStatus: 'uncertain',
        videoEvidence: { sha256: 'a'.repeat(64) } } } }
}

test('review uncertainty forks the exact paid video and preserves source identity', () => {
  const source = run(), retry = selectStorySameMediaReviewRetry(source, 'record-parent')!
  assert.equal(retry.sourceUrl, '/generated/video-a.mp4')
  assert.equal(retry.sourceExecutionId, 'record-parent')
  assert.equal(retry.sourceVideoSha256, 'a'.repeat(64))
  const feedback = withStorySameMediaReviewRetry({ existing: true }, retry)
  assert.equal(readStorySameMediaReviewRetry(feedback, source), retry)
  assert.equal((feedback as { existing: boolean }).existing, true)
  assert.deepEqual(storySameMediaReviewProvenance(retry), {
    version: 'story-same-media-review-retry-v1', sourceExecutionId: 'record-parent', sourceRunId: 'video-1',
    sourceLoopIndex: 1, sourceUrl: '/generated/video-a.mp4', sourceVideoSha256: 'a'.repeat(64), sourceReviewStatus: 'uncertain' })
  assert.equal(storyShotIdentity({ duration: 6, title: '公司的午睡搭子' }), retry.sourceShotJson,
    'JSONB key reordering must not invalidate a resumed review-only fork')
})

test('reviewer outage without a report still selects the retained paid URL', () => {
  const source = run()
  source.error = 'STORY_SHOT_REVIEW_UNAVAILABLE: 审核服务暂不可用'
  source.output.storyMediaReview = undefined as never
  assert.equal(selectStorySameMediaReviewRetry(source, 'record-parent')?.sourceReviewStatus, 'unavailable')
})

test('confirmed incomplete action permits a new candidate; a success cannot be retried as same media', () => {
  const source = run()
  source.output.storyMediaReview.retryable = true
  source.output.storyMediaReview.reviewStatus = 'incomplete'
  assert.equal(selectStorySameMediaReviewRetry(source, 'record-parent'), undefined)
  source.status = 'success'
  assert.equal(selectStorySameMediaReviewRetry(source, 'record-parent'), undefined)
})

test('a malformed or stale pointer fails closed instead of calling the video provider', () => {
  const source = run(), retry = selectStorySameMediaReviewRetry(source, 'record-parent')!
  assert.throws(() => readStorySameMediaReviewRetry({ storySameMediaReviewRetry: { ...retry, sourceUrl: '/generated/other.mp4' } }, source), /来源与当前分镜不一致/)
  assert.throws(() => readStorySameMediaReviewRetry({ storySameMediaReviewRetry: retry }, { ...source, loopItem: { title: 'other' } }), /来源与当前分镜不一致/)
  source.output.url = ''
  assert.throws(() => selectStorySameMediaReviewRetry(source, 'record-parent'), /禁止重新购买视频/)
})

test('successful saved-media review executes one node and leaves the next paid nodes pending', async () => {
  const state = { nodeRuns: [{ status: 'success' }, { status: 'idle' }, { status: 'idle' }, { status: 'idle' }] }
  const calls: number[] = []
  const result = await executeStorySameMediaReviewOnly(1, state, async index => {
    calls.push(index)
    return { nodeRuns: state.nodeRuns.map((run, at) => at === index ? { status: 'success' } : run) }
  })
  assert.deepEqual(calls, [1])
  assert.equal(result.passed, true)
  assert.deepEqual(result.state?.nodeRuns.map(run => run.status), ['success', 'success', 'idle', 'idle'])
})

test('retrying an idle review-only checkpoint keeps its saved-media pointer', () => {
  const failed = run(), retry = selectStorySameMediaReviewRetry(failed, 'record-parent')!
  const idle = { ...failed, status: 'idle', output: undefined,
    retryFeedback: withStorySameMediaReviewRetry(undefined, retry) }
  assert.equal(selectStorySameMediaReviewRetry(idle, 'record-review-only'), retry)
  assert.throws(() => selectStorySameMediaReviewRetry({ ...idle, loopItem: { title: 'other' } }, 'record-review-only'),
    /来源与当前分镜不一致/)
})

test('a running video checkpoint cannot start another paid video or concurrent review', () => {
  const source = run(), retry = selectStorySameMediaReviewRetry(source, 'record-parent')!
  const running = { ...source, status: 'running', output: undefined, startedAt: 1234, durationMs: 0,
    retryFeedback: withStorySameMediaReviewRetry(undefined, retry) }
  assert.throws(() => selectStorySameMediaReviewRetry(running, 'record-review-only'), /STORY_VIDEO_RUNNING_RETRY_BLOCKED/)
  const idle = recoverInterruptedStorySameMediaReviewRun(running)
  assert.equal(idle.status, 'idle')
  assert.equal(idle.startedAt, undefined)
  assert.equal(idle.durationMs, 0)
  assert.equal(selectStorySameMediaReviewRetry(idle, 'record-review-only'), retry)
  assert.equal(running.status, 'running', 'recovery must not mutate the in-flight snapshot')
})

test('an unbound or stale running checkpoint fails closed before any provider call', () => {
  const source = run(), retry = selectStorySameMediaReviewRetry(source, 'record-parent')!
  assert.throws(() => selectStorySameMediaReviewRetry({ ...source, status: 'running' }, 'record-stale'),
    /STORY_VIDEO_RUNNING_RETRY_BLOCKED/)
  assert.throws(() => recoverInterruptedStorySameMediaReviewRun({ ...source, status: 'running' }),
    /STORY_SAME_MEDIA_RECOVERY_INVALID/)
  const stale = { ...source, status: 'running', retryFeedback: withStorySameMediaReviewRetry(undefined,
    { ...retry, sourceUrl: '/generated/other.mp4' }) }
  assert.throws(() => selectStorySameMediaReviewRetry(stale, 'record-stale'), /来源与当前分镜不一致/)
  assert.throws(() => recoverInterruptedStorySameMediaReviewRun(stale), /来源与当前分镜不一致/)
})
