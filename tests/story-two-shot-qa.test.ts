import test from 'node:test'
import assert from 'node:assert/strict'
import { selectStoryTwoShotQaInputs } from '../scripts/qa-story-two-shots.mjs'
import { renderStoryShotTimedActions } from '../src/story-shot-timing.ts'

const shot = (title: string) => ({ title, content: '0—4秒，蓝猫把硬币推给柴犬；4—7秒，柴犬把纸袋推给蓝猫。',
  duration: 8, camera: '固定机位', mood: '轻松', firstFramePrompt: '蓝猫和柴犬在柜台前',
  visualBeats: [
    { id: 'coin', action: '蓝猫把硬币推给柴犬', completion: '硬币在柴犬爪边', startSecond: 0, endSecond: 4 },
    { id: 'bag', action: '柴犬把纸袋推给蓝猫', completion: '纸袋在蓝猫爪边', startSecond: 4, endSecond: 7 },
  ] })

function failedOneShotFixture() {
  const first = shot('早餐'), second = shot('午休')
  const loopGroupId = 'story-two-shot-group'
  const base = (id: string, status: string, loopIndex?: number) => ({ node: { id, modelId: id === 'node-image' ? 'codex-gpt-image-2' : id === 'node-video' ? 'keling3' : undefined },
    status, loopIndex, loopGroupId: loopIndex === undefined ? undefined : loopGroupId,
    loopItem: loopIndex === 0 ? first : second, inputContext: { shot: loopIndex === 0 ? first : second } })
  const image = { ...base('node-image', 'success', 0), output: { url: '/generated/first.png', model: 'codex-gpt-image-2' } }
  const evidence = { decoded: true, sha256: 'a'.repeat(64), url: '/generated/video.mp4',
    frames: ['/generated/f0.jpg', '/generated/f1.jpg', '/generated/f2.jpg', '/generated/f3.jpg'],
    frameTimes: [0, 2, 4, 7] }
  const video = { ...base('node-video', 'failed', 0), output: {
    url: evidence.url, model: 'keling3', prompt: renderStoryShotTimedActions(first),
    params: { duration: 8, referenceImage: { url: image.output.url } }, videoEvidence: evidence,
    storyMediaReview: { passed: false, retryable: false, reviewStatus: 'technical-failure', videoEvidence: evidence },
  } }
  return { workflowId: 'wf-story', nodeRuns: [base('node-input', 'success'), base('node-model-images', 'success'),
    { ...base('node-script', 'success'), output: { shots: [first, second], items: [first, second] } },
    base('node-loop', 'success'), image, video, base('node-image', 'idle', 1), base('node-video', 'idle', 1)] }
}

test('saved failed story video is inspectable only in an explicit single-shot QA scope', () => {
  const fixture = failedOneShotFixture()
  assert.throws(() => selectStoryTwoShotQaInputs(fixture), /latest inspectable/)
  const selected = selectStoryTwoShotQaInputs(fixture, { shotNumber: '1', allowFailed: true })
  assert.equal(selected.length, 1)
  assert.equal(selected[0].video.status, 'failed')
  assert.equal(selected[0].review.reviewStatus, 'technical-failure')
  assert.throws(() => selectStoryTwoShotQaInputs(fixture, { shotNumber: '2', allowFailed: true }), /latest inspectable/)
})

test('latest failed take cannot be hidden by an older successful take', () => {
  const fixture = failedOneShotFixture()
  const stale = structuredClone(fixture.nodeRuns[5])
  stale.status = 'success'
  fixture.nodeRuns.splice(5, 0, stale)
  assert.throws(() => selectStoryTwoShotQaInputs(fixture, { shotNumber: '1' }), /latest inspectable/)
})

test('QA binds each requested model to its saved output without assuming one provider', () => {
  const fixture = failedOneShotFixture()
  const image = fixture.nodeRuns[4], video = fixture.nodeRuns[5]
  image.node.modelId = 'another-image-model'
  image.output.model = 'another-image-model'
  video.node.modelId = 'another-video-model'
  video.output.model = 'another-video-model'
  assert.equal(selectStoryTwoShotQaInputs(fixture, { shotNumber: '1', allowFailed: true })[0].video, video)
  video.output.model = 'mismatched-model'
  assert.throws(() => selectStoryTwoShotQaInputs(fixture, { shotNumber: '1', allowFailed: true }), /model or loop binding/)
})
