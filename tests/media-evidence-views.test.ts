import { storyboardTimelineConsumerCode } from '../src/storyboard-timeline.ts'
import { resolveNativeFrameDisplayInterval } from '../src/media-frame-display.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveMediaEvidenceViews } from '../src/media-evidence-views.ts'
import { deriveRequirementReviewInputs } from '../src/media-requirement-review.ts'
import { deriveMediaRequirements } from '../src/media-requirement-coverage.ts'

const views = [deriveMediaEvidenceViews, new Function(`const resolveNativeFrameDisplayInterval=(${resolveNativeFrameDisplayInterval.toString()});return (${deriveMediaEvidenceViews.toString()});`)() as typeof deriveMediaEvidenceViews]
const reviews = [deriveRequirementReviewInputs, new Function(`const resolveNativeFrameDisplayInterval=(${resolveNativeFrameDisplayInterval.toString()});const deriveMediaRequirements=${storyboardTimelineConsumerCode(deriveMediaRequirements)};return (${deriveRequirementReviewInputs.toString()});`)() as typeof deriveRequirementReviewInputs]
const native = () => {
  const frames = Array.from({length: 80}, (_, i) => '/generated/native-' + i + '.jpg'), frameTimes = frames.map((_, i) => i / 24)
  return { duration: 80 / 24, frames, frameTimes, frameReferences: frames.map((url, i) => ({ index: i, evidenceIndex: i, nativeFrameIndex: i, url, second: frameTimes[i], pts: i * 512,
    timeBase: '1/12288', sourceSha256: 'a'.repeat(64) })), nativeSequence: { preservedSamples: [0, 12, 24, 48, 79].map(evidenceIndex => ({ evidenceIndex, nativeFrameIndex: evidenceIndex })) } }
}
test('native authoritative view keeps all frames while the draft observer retains explicitly mapped sparse coverage', () => {
  for (const derive of views) {
    const evidence = native(), before = structuredClone(evidence), view = derive(evidence)
    assert.deepEqual(view.observerFrames.map(frame => frame.index), [0, 12, 24, 48, 79])
    assert.equal(view.reviewImageDetail.frameMetadata?.length, 80)
    assert.equal(view.reviewImageDetail.frameMetadata?.at(-1)?.nativeFrameIndex, 79)
    assert.deepEqual(evidence, before)
    const broken = native();broken.nativeSequence.preservedSamples[0].nativeFrameIndex = 5
    assert.throws(() => derive(broken), /MEDIA_EVIDENCE_VIEW_INVALID/)
  }
})
test('independent native pages use local evidence indices and keep native time provenance without changing global report mappings', () => {
  const shot = { duration: 80 / 24, videoPrompt: '1-2秒：人物举手。' }
  for (const derive of reviews) {
    const input = derive(shot, native())[0], metadata = input.reviewImageDetail!.frameMetadata as Array<Record<string, unknown>>
    assert.equal(input.frameReferences[0].index, 24)
    assert.equal(metadata[0].evidenceIndex, 0);assert.equal(metadata[0].nativeFrameIndex, 24)
    assert.equal(metadata[0].time, 1);assert.equal(metadata[0].pts, 12288)
    assert.equal(metadata.at(-1)?.evidenceIndex, 24);assert.equal(metadata.at(-1)?.nativeFrameIndex, 48)
    assert.equal(input.reviewImages.length, 25)
    const broken = native();broken.frameReferences[24].second = 99
    assert.throws(() => derive(shot, broken), /MEDIA_REQUIREMENT_REVIEW_INPUT_INVALID/)
  }
})
