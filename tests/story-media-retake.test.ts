import test from 'node:test'
import assert from 'node:assert/strict'
import { failedStoryMediaReviewIndexForVideo, planStoryMediaBranchRetake, planStoryMediaRetake } from '../src/story-media-retake.ts'
import { prepareWorkflowRunContext } from '../src/workflow-run-context.ts'
import { renderRetryFeedbackPrompt } from '../src/workflow-template.ts'

const sha = 'a'.repeat(64)
const sourceUrl = 'https://vendor.example/paid.mp4?token=secret'
const localUrl = '/generated/verified-paid.mp4'
const evidenceUrl = '/generated/verified-paid-evidence.json'
const shot = { title: '早餐会面', duration: 14, visualBeats: [
  { id: 'screen', endSecond: 4, completion: '平板显示蓝橙色样稿' },
  { id: 'payment', endSecond: 8, completion: '店员收到纸钞，卷毛拿到早餐袋' },
  { id: 'meet', endSecond: 12, completion: '卷毛提着早餐与芙伊同侧查看样稿' },
] }
const frames = Array.from({ length: 5 }, (_, index) => `/generated/frame-${index}.jpg`)
const times = [0, 4, 8, 12, 13.95]
const descriptions = ['首帧', '平板背面不可见', '纸钞仍在台面',
  '平板显示灰猫及植物；早餐袋留在柜台', '平板显示灰猫及植物；早餐袋留在柜台']

function fixture() {
  const videoEvidence = { decoded: true, url: localUrl, originalUrl: sourceUrl, sha256: sha, evidenceUrl,
    frames, frameTimes: times }
  const beatChecks = [
    { id: 'screen', status: 'uncertain', reason: '平板内容不可见' },
    { id: 'payment', status: 'uncertain', reason: '店员毛爪被遮挡' },
    { id: 'meet', status: 'incomplete', evidenceFrameIndices: [3, 4],
      evidenceObservations: ['平板显示灰猫及植物；早餐袋留在柜台', '平板显示灰猫及植物；早餐袋留在柜台'],
      reason: '平板与早餐袋均未达到要求' },
  ]
  const endingHold = { status: 'incomplete', firstFrameIndex: 3, lastFrameIndex: 4,
    firstObservation: '平板显示灰猫及植物；早餐袋留在柜台',
    lastObservation: '平板显示灰猫及植物；早餐袋留在柜台', reason: '片尾未达到预期状态' }
  const video = { node: { id: 'node-video', kind: 'video' }, status: 'success', loopGroupId: 'loop-1', loopIndex: 0,
    loopItem: structuredClone(shot), output: { url: sourceUrl, raw: { paidTaskId: 'paid-1' } } }
  const review = { node: { id: 'node-video-review', kind: 'validation', operation: 'story.media-review' },
    status: 'failed', loopGroupId: 'loop-1', loopIndex: 0, loopItem: structuredClone(shot),
    inputs: { shot: structuredClone(shot), video: { url: sourceUrl } },
    output: { url: localUrl, originalUrl: sourceUrl, passed: false, videoEvidence: structuredClone(videoEvidence),
      storyMediaReview: { version: 'story-shot-media-review-v1', videoUrl: sourceUrl, passed: false,
        reviewStatus: 'incomplete', retryable: true,
        videoEvidence, beatChecks: structuredClone(beatChecks), endingHold: structuredClone(endingHold),
        observations: { version: 'story-shot-observations-v1', sourceVideoSha256: sha, evidenceUrl,
          frames: frames.map((frameUrl, frameIndex) => ({ frameIndex, second: times[frameIndex], frameUrl,
            description: descriptions[frameIndex] })) },
        assessment: { version: 'story-shot-media-review-v1', sourceVideoSha256: sha, evidenceUrl,
          passed: false, beatChecks, endingHold } } } }
  return [video, review]
}

test('plans an explicit retake from only the proven incomplete action of the same paid shot', () => {
  const runs = fixture(), before = structuredClone(runs)
  const plan = planStoryMediaRetake(runs, 1)
  assert.equal(plan?.videoIndex, 0)
  assert.match(plan!.feedback, /动作 meet.*平板显示灰猫及植物.*目标.*卷毛提着早餐/)
  assert.match(plan!.feedback, /待观察：screen、payment/)
  assert.doesNotMatch(plan!.feedback, /token=secret|vendor\.example|paid\.mp4/)
  assert.ok(plan!.feedback.length <= 550)
  assert.deepEqual(runs, before)
})

test('uncertain, unavailable, invalid or unbound review never selects paid generation', () => {
  for (const status of ['uncertain', 'unavailable', 'invalid', 'technical-failure']) {
    const runs = fixture()
    runs[1].output.storyMediaReview.reviewStatus = status
    assert.equal(planStoryMediaRetake(runs, 1), undefined)
  }
  const noRetry = fixture()
  noRetry[1].output.storyMediaReview.retryable = false
  assert.equal(planStoryMediaRetake(noRetry, 1), undefined)
  const success = fixture()
  success[1].status = 'success'
  assert.equal(planStoryMediaRetake(success, 1), undefined)
  const otherNode = fixture()
  otherNode[1].node.operation = 'history.media-review'
  assert.equal(planStoryMediaRetake(otherNode, 1), undefined)
})

test('the review must be the first blocking run and cannot discard completed downstream work', () => {
  const earlierFailed = [{ node: { id: 'earlier', kind: 'text' }, status: 'failed' }, ...fixture()]
  assert.equal(planStoryMediaRetake(earlierFailed, 2), undefined)
  const earlierIdle = [{ node: { id: 'earlier', kind: 'text' }, status: 'idle' }, ...fixture()]
  assert.equal(planStoryMediaRetake(earlierIdle, 2), undefined)
  for (const status of ['success', 'running']) {
    const laterDone = [...fixture(), { node: { id: 'later', kind: 'videoConcat' }, status }]
    assert.equal(planStoryMediaRetake(laterDone, 1), undefined)
  }
  const laterIdle = [...fixture(), { node: { id: 'later', kind: 'videoConcat' }, status: 'idle' }]
  assert.equal(planStoryMediaRetake(laterIdle, 1)?.videoIndex, 0)
})

test('video, loop, shot and source evidence must all match the failed review', () => {
  const changed = [
    (runs: ReturnType<typeof fixture>) => { runs[0].loopIndex = 1 },
    (runs: ReturnType<typeof fixture>) => { runs[0].loopGroupId = 'another-loop' },
    (runs: ReturnType<typeof fixture>) => { runs[0].loopItem = { ...shot, title: '另一镜' } },
    (runs: ReturnType<typeof fixture>) => { runs[1].inputs.shot = { ...shot, title: '另一镜' } },
    (runs: ReturnType<typeof fixture>) => { Reflect.deleteProperty(runs[1].inputs, 'shot') },
    (runs: ReturnType<typeof fixture>) => { runs[1].inputs.video.url = 'https://vendor.example/another.mp4' },
    (runs: ReturnType<typeof fixture>) => { runs[1].output.storyMediaReview.videoEvidence.sha256 = 'b'.repeat(64) },
    (runs: ReturnType<typeof fixture>) => { runs[1].output.videoEvidence.sha256 = 'b'.repeat(64) },
    (runs: ReturnType<typeof fixture>) => { runs[1].output.videoEvidence.url = '/generated/other.mp4' },
    (runs: ReturnType<typeof fixture>) => { runs[1].output.storyMediaReview.videoEvidence.url = sourceUrl },
    (runs: ReturnType<typeof fixture>) => { Reflect.deleteProperty(runs[1].output.storyMediaReview.videoEvidence, 'originalUrl') },
    (runs: ReturnType<typeof fixture>) => { runs[1].output.storyMediaReview.videoEvidence.decoded = false },
    (runs: ReturnType<typeof fixture>) => { runs[1].output.storyMediaReview.beatChecks[2].status = 'complete' },
    (runs: ReturnType<typeof fixture>) => { runs[1].output.storyMediaReview.endingHold.status = 'complete' },
    (runs: ReturnType<typeof fixture>) => { runs[1].output.storyMediaReview.assessment.endingHold.status = 'complete' },
    (runs: ReturnType<typeof fixture>) => { runs[1].output.storyMediaReview.observations.frames[3].frameUrl = '/generated/other.jpg' },
  ]
  for (const mutation of changed) {
    const runs = fixture()
    mutation(runs)
    assert.equal(planStoryMediaRetake(runs, 1), undefined)
  }
})

test('an incomplete label needs matching quotations at the planned end and actual tail', () => {
  const altered = [
    (runs: ReturnType<typeof fixture>) => { runs[1].output.storyMediaReview.assessment.beatChecks[2].evidenceFrameIndices = [2, 4] },
    (runs: ReturnType<typeof fixture>) => { runs[1].output.storyMediaReview.assessment.beatChecks[2].evidenceFrameIndices = [3, 3] },
    (runs: ReturnType<typeof fixture>) => { runs[1].output.storyMediaReview.assessment.beatChecks[2].evidenceObservations[1] = '另一个结果' },
    (runs: ReturnType<typeof fixture>) => { runs[1].output.storyMediaReview.observations.frames[4].description = '片尾看不清楚' },
  ]
  for (const mutation of altered) {
    const runs = fixture()
    mutation(runs)
    runs[1].output.storyMediaReview.beatChecks = structuredClone(runs[1].output.storyMediaReview.assessment.beatChecks)
    assert.equal(planStoryMediaRetake(runs, 1), undefined)
  }
  const uncertainOnly = fixture()
  uncertainOnly[1].output.storyMediaReview.assessment.beatChecks[2].status = 'uncertain'
  uncertainOnly[1].output.storyMediaReview.beatChecks = structuredClone(uncertainOnly[1].output.storyMediaReview.assessment.beatChecks)
  assert.equal(planStoryMediaRetake(uncertainOnly, 1), undefined)
})

test('feedback has a fixed bound and removes media addresses from cited text', () => {
  const runs = fixture()
  const quoted = `画面未完成 ${sourceUrl} ` + '画面细节'.repeat(70)
  runs[1].output.storyMediaReview.observations.frames[3].description = quoted
  runs[1].output.storyMediaReview.observations.frames[4].description = quoted
  runs[1].output.storyMediaReview.assessment.beatChecks[2].evidenceObservations = [quoted, quoted]
  runs[1].output.storyMediaReview.beatChecks = structuredClone(runs[1].output.storyMediaReview.assessment.beatChecks)
  runs[1].output.storyMediaReview.assessment.endingHold.firstObservation = quoted
  runs[1].output.storyMediaReview.assessment.endingHold.lastObservation = quoted
  runs[1].output.storyMediaReview.endingHold = structuredClone(runs[1].output.storyMediaReview.assessment.endingHold)
  const plan = planStoryMediaRetake(runs, 1)
  assert.ok(plan)
  assert.ok(plan.feedback.length <= 550)
  assert.doesNotMatch(plan.feedback, /vendor\.example|token=secret/)
})

test('the retake feedback reaches the video prompt through the pending run context', () => {
  const runs = fixture()
  const plan = planStoryMediaRetake(runs, 1)
  assert.ok(plan)
  const pendingVideo = { ...runs[0], node: { ...runs[0].node, resultVar: 'video_shot' },
    status: 'idle', retryFeedback: plan.feedback, context: {}, attempt: 1 }
  const prepared = prepareWorkflowRunContext([pendingVideo], 0)
  const promptAddition = renderRetryFeedbackPrompt(prepared?.inputContext.retry?.feedback)
  assert.match(promptAddition, /动作 meet.*平板显示灰猫及植物/)
  assert.match(promptAddition, /保留全部原始目标/)
  assert.doesNotMatch(promptAddition, /vendor\.example|token=secret/)
})

test('a direct video retry resolves to the failed review in the same loop and shot', () => {
  const runs = fixture()
  assert.equal(failedStoryMediaReviewIndexForVideo(runs, 0), 1)
  assert.equal(failedStoryMediaReviewIndexForVideo(runs, 1), undefined)
  runs[1].loopGroupId = 'another-loop'
  assert.equal(failedStoryMediaReviewIndexForVideo(runs, 0), undefined)
})

test('a graph false edge requires the same proven review before a paid video retake', () => {
  const runs = fixture()
  runs[1].status = 'success'
  const branch = { node: { id: 'node-video-review-result-branch', kind: 'branch' }, status: 'running',
    loopGroupId: 'loop-1', loopIndex: 0, loopItem: structuredClone(shot) }
  const routed = [...runs, branch]
  assert.equal(planStoryMediaBranchRetake(routed, 2)?.videoIndex, 0)
  const altered = structuredClone(routed)
  altered[1].output.storyMediaReview.reviewStatus = 'uncertain'
  assert.equal(planStoryMediaBranchRetake(altered, 2), undefined)
  const wrongShot = structuredClone(routed)
  wrongShot[2].loopItem = { ...shot, title: '另一镜' }
  assert.equal(planStoryMediaBranchRetake(wrongShot, 2), undefined)
  const wrongBranch = structuredClone(routed)
  wrongBranch[2].node.id = 'other-branch'
  assert.equal(planStoryMediaBranchRetake(wrongBranch, 2), undefined)
})
