import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveNativeFrameDisplayInterval } from '../src/media-frame-display.ts'
import { resolveNativeSequenceConfig, selectNativeReviewFrames, type NativeFrameArchive } from '../server/native-video-sequence.ts'
import { deriveRequirementReviewInputs, combineIndependentMediaReviews } from '../src/media-requirement-review.ts'
import { deriveMediaRequirements, validateMediaRequirementChecks } from '../src/media-requirement-coverage.ts'
import { deriveMediaSamplingReview } from '../src/media-sampling-review.ts'
import { deriveAdaptiveMediaSamplingPlan } from '../src/media-adaptive-sampling.ts'
import { validateMediaDefectEvidence } from '../src/media-defect-evidence.ts'

const resolvers = [resolveNativeFrameDisplayInterval, new Function('return (' + resolveNativeFrameDisplayInterval.toString() + ');')() as typeof resolveNativeFrameDisplayInterval]
const shot = { duration: 1.1, videoPrompt: '0.35-0.75秒：人物保持站立。' }
function fixture() {
  const archive: NativeFrameArchive = { version: 1, complete: true, sourceVideoSha256: 'b'.repeat(64), sourceVideoUrl: '/generated/source.mp4',
    decoder: 'fixture', recipe: 'fixture', timeBase: '1/1000', firstPTS: 0, metadataText: '', totalBytes: 11,
    frames: Array.from({ length: 11 }, (_, index) => ({ nativeFrameIndex: index, pts: index * 100, timeBase: '1/1000', durationPTS: 100,
      second: index / 10, width: 1280, height: 720, url: '/generated/' + index + '.jpg', sourceSha256: 'a'.repeat(64), byteLength: 1 })) }
  const selected = selectNativeReviewFrames(archive, [0, 1], resolveNativeSequenceConfig({ enabled: true, windows: [{ start: .35, end: .75 }] })!, 1.1)
  return { duration: 1.1, originalUrl: '/generated/source.mp4', frames: selected.frameReferences.map(frame => frame.url),
    frameTimes: selected.frameReferences.map(frame => frame.second), frameReferences: selected.frameReferences,
    nativeSequence: { version: 2, sourceVideoSha256: archive.sourceVideoSha256, archiveSha256: 'c'.repeat(64), totalNativeFrames: 11,
      selectedNativeFrameIndices: selected.frameReferences.map(frame => frame.nativeFrameIndex), windows: selected.windows, preservedSamples: selected.preservedSamples } }
}

test('display range is immutable and v2 URL/index/PTS/next-frame/duration bound; old receipts stay conservative', () => {
  for (const resolve of resolvers) {
    const source = fixture(), before = structuredClone(source)
    assert.deepEqual(resolve(source, 1), { startSecond: .3, endSecond: .4, endBasis: 'duration-pts' })
    assert.equal(resolve({ ...source, nativeSequence: { ...source.nativeSequence, version: 1 } }, 1), undefined)
    const edits = [
      (e: typeof source) => { e.frameReferences[1].displayEndSecond = .8 },
      (e: typeof source) => { e.frameReferences[1].displayStartSecond = .35 },
      (e: typeof source) => { e.frameReferences[1].url = 'different.jpg' },
      (e: typeof source) => { e.frameReferences[1].evidenceIndex = 0 },
      (e: typeof source) => { e.frameReferences[1].pts += 1 },
      (e: typeof source) => { e.frameReferences[1].nextFramePTS! += 1 },
      (e: typeof source) => { e.frameReferences[1].durationPTS = 1 },
      (e: typeof source) => { e.frameReferences[1].sourceSha256 = 'invented' },
      (e: typeof source) => { e.nativeSequence.selectedNativeFrameIndices[1] = 99 },
      (e: typeof source) => { e.nativeSequence.archiveSha256 = '' },
    ]
    for (const edit of edits) { const bad = structuredClone(source);edit(bad);assert.throws(() => resolve(bad, 1), /MEDIA_NATIVE_DISPLAY_INVALID/) }
    assert.deepEqual(source, before)
  }
})

test('boundary source frame survives local review, global coverage and sampling feedback without changing unknown status', () => {
  const evidence = fixture(), original = structuredClone(evidence), input = deriveRequirementReviewInputs(shot, evidence)[0]
  assert.deepEqual(input.frameReferences.map(frame => frame.index), [1, 2, 3, 4, 5])
  assert.equal(input.attachmentReferences[0].second, .3)
  assert.deepEqual(input.attachmentReferences[0].scopeIntersection, { startSecond: .35, endSecond: .4 })
  assert.equal(input.attachmentReferences[0].evidenceRole, 'boundary-context')
  const check = { requirementId: input.requirement.id, status: 'unobservable', evidence: '边界帧手部被遮挡，姿态无法确认。', frameIndices: [1] }
  const report = { decision: 'uncertain', passed: false, requirementChecks: [check] }, before = structuredClone(report)
  const coverage = validateMediaRequirementChecks(report, shot, evidence)
  assert.deepEqual(coverage.blockingUnobservableRequirements[0].frameIndices, [1])
  const sampling = deriveMediaSamplingReview(report, report, shot, evidence)
  assert.deepEqual(sampling.requirementChecks[0].frameIndices, [1]);assert.equal(sampling.decision, 'uncertain')
  const previous = { sourceUrl: evidence.originalUrl, round: 2, sampleTimes: [0, 1], requirementIds: [input.requirement.id],
    nativeSequence: { enabled: true as const, windows: [{ start: .35, end: .75 }], reviewMaxFrames: 160 } }
  assert.throws(() => deriveAdaptiveMediaSamplingPlan(shot, evidence, sampling, { maxFrames: 24, maxRounds: 2, nativeSequence: true, nativeReviewMaxFrames: 160 }, previous), /MEDIA_ADAPTIVE_SAMPLING_LIMIT/)
  assert.deepEqual(report, before);assert.deepEqual(evidence, original)
  const legacy = { ...evidence, nativeSequence: { ...evidence.nativeSequence, version: 1 } }
  assert.deepEqual(deriveRequirementReviewInputs(shot, legacy)[0].frameReferences.map(frame => frame.index), [2, 3, 4, 5])
  assert.throws(() => validateMediaRequirementChecks(report, shot, legacy), /引用帧不在原要求/)
})

test('a visible boundary contradiction can be scoped to its actual display intersection while outside evidence stays forbidden', () => {
  const evidence = fixture(), requirement = deriveMediaRequirements(shot)[0]
  const defect = { issueIndex: 0, status: 'confirmed', category: 'script', source: 'frame', frameIndices: [1],
    finding: '原帧显示人物实际坐在案后。', repair: '本时段人物保持站立。', requirementPath: 'videoPrompt', requirementQuote: requirement.requirementQuote,
    scope: 'interval', startSecond: .35, endSecond: .4,
    stateEvidence: { basis: 'visible-state-contradiction', violatedQuote: '人物保持站立', requiredStateQuote: '站立', observedState: '人物坐在案后', temporalBasis: 'sustained-state', persistenceQuote: '保持站立' } }
  const review = { decision: 'rejected', passed: false, issues: ['人物在该段坐下。'], defectEvidence: [defect] }
  assert.deepEqual(validateMediaDefectEvidence(review, evidence, { shot, policy: { requireScriptStateEvidence: true } }).issues, review.issues)
  const independentInputs = deriveRequirementReviewInputs(shot, evidence)
  assert.throws(() => combineIndependentMediaReviews(review, { items: [{ requirementId: requirement.id, status: 'complete', evidence: '边界原帧中人物站立。', frameIndices: [0] }] }, independentInputs), /审核分歧/)
  const outside = { ...review, defectEvidence: [{ ...defect, frameIndices: [0] }] }
  assert.throws(() => validateMediaDefectEvidence(outside, evidence, { shot }), /引用帧不在原要求/)
  const late = { ...review, defectEvidence: [{ ...defect, startSecond: .4, endSecond: .5 }] }
  assert.throws(() => validateMediaDefectEvidence(late, evidence, { shot }), /引用帧不在原要求/)
  const boundaryShot = { ...shot, visualPrompt: '人物站立。', lastFramePrompt: '人物站立。' }
  const inputs = deriveRequirementReviewInputs(boundaryShot, evidence)
  assert.deepEqual(inputs[0].frameReferences.map(frame => frame.index), [0])
  assert.deepEqual(inputs.at(-1)!.frameReferences.map(frame => frame.index), [evidence.frames.length - 1])
})
