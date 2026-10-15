import assert from 'node:assert/strict'
import test from 'node:test'
import { assertA8B6ConcatFrames, assertA8B6NativeSecondTiming, assertA8B6ShotCompletion,
  assertA8B6SpeechBoundary,
  parseA8B6FrameMd5,
  requireA8B6TwoShotRuns } from '../server/sanguo-a8b6-two-shot-qa.mjs'

const nodes = [
  [11, 'sanguo-shot-script-accept'], [50, 'sanguo-scene-cut-approval'],
  [52, 'sanguo-video'], [54, 'sanguo-video-evidence'],
  [58, 'sanguo-media-review'], [59, 'sanguo-media-accept'],
  [63, 'sanguo-video-concat'], [64, 'sanguo-last-frame'],
  [67, 'sanguo-shot-script-accept'], [81, 'sanguo-first-frame-branch'],
  [106, 'sanguo-scene-cut-approval'], [108, 'sanguo-video'],
  [110, 'sanguo-video-evidence'], [114, 'sanguo-media-review'],
  [115, 'sanguo-media-accept'], [119, 'sanguo-video-concat'],
  [120, 'sanguo-last-frame'],
] as const

function state() {
  const nodeRuns: unknown[] = Array.from({ length: 464 }, (_, index) =>
    ({ status: 'skipped', loopIndex: Math.floor(index / 56), node: { id: 'other' } }))
  for (const [index, id] of nodes)
    nodeRuns[index] = { status: 'success', loopIndex: index <= 64 ? 0 : 1,
      node: { id }, output: {} }
  ;(nodeRuns[11] as { output: object }).output = { id: 'scene-01', duration: 14 }
  ;(nodeRuns[67] as { output: object }).output =
    { id: 'scene-02', duration: 10, audioType: '对白' }
  return { id: 'record-two-shots', workflowId: 'wf-sanguo-history-drama', nodeRuns }
}

test('both shots must be completed in one consecutive schema180 record', () => {
  const valid = state()
  assert.equal(requireA8B6TwoShotRuns(valid, valid.id).second.video.node.id, 'sanguo-video')
  ;(valid.nodeRuns[120] as { status: string }).status = 'idle'
  assert.throws(() => requireA8B6TwoShotRuns(valid, valid.id), /not completed/)
  assert.throws(() => requireA8B6TwoShotRuns(state(), 'record-other'), /same schema180/)
})

test('native frame parser uses decoded PTS and dimensions', () => {
  const text = '#tb 0: 1/24\n#dimensions 0: 1280x720\n'
    + '0, 0, 0, 1, 1382400, 00000000000000000000000000000000\n'
    + '0, 1, 1, 1, 1382400, 11111111111111111111111111111111\n'
  assert.deepEqual(parseA8B6FrameMd5(text).pts, [0, 1])
  assert.throws(() => parseA8B6FrameMd5(text.replace('1280x720', '640x360')),
    /1280x720/)
})

test('an accepted media node cannot hide an unfinished mandatory action', () => {
  const shot = { scheduleHash: 'schedule', pacing: { scheduleHash: 'schedule',
    beats: [{ id: 'tie', completion: { requiredThisClip: true } },
      { id: 'approach', completion: { requiredThisClip: true } }] } }
  const accepted = { passed: true, visualReview: { passed: true },
    manualDecisionRequired: false, durationCompletion: {
      passed: true, assessment: 'complete', scheduleHash: 'schedule',
      remainingMandatoryBeats: [], actualCompletionInterval: { lower: 9, upper: 9.5 },
      checks: [{ beatId: 'tie', status: 'complete' },
        { beatId: 'approach', status: 'complete' }] } }
  assert.equal(assertA8B6ShotCompletion(shot, accepted).requiredBeatIds.length, 2)
  const incomplete = structuredClone(accepted)
  incomplete.durationCompletion.checks[1].status = 'uncertain'
  assert.throws(() => assertA8B6ShotCompletion(shot, incomplete), /mandatory beat/)
})

test('concat retains all 337 plus the actual paid native frames at a single hard cut', () => {
  const first = { timebase: '1/24', pts: Array.from({ length: 337 }, (_, i) => i),
    hashes: Array.from({ length: 337 }, (_, i) => `a${i}`) }
  for (const count of [240, 241, 242]) {
    const second = { timebase: '1/24', pts: Array.from({ length: count }, (_, i) => i),
      hashes: Array.from({ length: count }, (_, i) => `b${i}`) }
    const concat = { timebase: '1/24', pts: Array.from({ length: 337 + count }, (_, i) => i + 1),
      hashes: [...first.hashes, ...second.hashes] }
    assert.equal(assertA8B6NativeSecondTiming(second).nativeFrameCount, count)
    assert.deepEqual(assertA8B6ConcatFrames(first, second, concat, second), {
      firstNormalizedFrames: 337, secondNativeFrames: count,
      secondNormalizedFrames: count, concatFrames: 337 + count,
      concatFirstPts: 1, cutBeforeConcatFrameIndex: 337,
      firstTailConcatFrameIndex: 336, secondFirstConcatFrameIndex: 337,
      cutPtsSeconds: 338 / 24, lastPtsSeconds: (337 + count) / 24,
      cutRelativePtsSeconds: 337 / 24, initialPtsOffsetSeconds: 1 / 24,
      lastRelativePtsSeconds: (336 + count) / 24,
      nominalApprovedSeconds: 24, secondNativeLastPtsSeconds: (count - 1) / 24,
    })
    const dropped = { ...concat, hashes: concat.hashes.filter((_, i) => i !== 337) }
    assert.throws(() => assertA8B6ConcatFrames(first, second, dropped, second), /lost, reordered/)
    const reordered = { ...concat, hashes: [...concat.hashes] }
    ;[reordered.hashes[336], reordered.hashes[337]] =
      [reordered.hashes[337], reordered.hashes[336]]
    assert.throws(() => assertA8B6ConcatFrames(first, second, reordered, second), /lost, reordered/)
  }
  const short = { timebase: '1/24', pts: Array.from({ length: 239 }, (_, i) => i),
    hashes: Array.from({ length: 239 }, (_, i) => `x${i}`) }
  assert.throws(() => assertA8B6NativeSecondTiming(short), /approved 10 seconds/)
})

test('fresh 14 second concat derives the seam from signed first native frames', () => {
  for (const firstCount of [335, 336, 338, 339]) {
    const first = { timebase: '1/24', pts: Array.from({ length: firstCount }, (_, i) => i),
      hashes: Array.from({ length: firstCount }, (_, i) => `first-${i}`) }
    const second = { timebase: '1/24', pts: Array.from({ length: 241 }, (_, i) => i),
      hashes: Array.from({ length: 241 }, (_, i) => `second-${i}`) }
    const concat = { timebase: '1/24',
      pts: Array.from({ length: firstCount + 241 }, (_, i) => i),
      hashes: [...first.hashes, ...second.hashes] }
    const result = assertA8B6ConcatFrames(first, second, concat,
      second, firstCount)
    assert.equal(result.cutBeforeConcatFrameIndex, firstCount)
    assert.equal(result.firstTailConcatFrameIndex, firstCount - 1)
    assert.equal(result.secondFirstConcatFrameIndex, firstCount)
    assert.equal(result.concatFrames, firstCount + 241)
    assert.throws(() => assertA8B6ConcatFrames(first, second,
      concat, second, 337), /lost, reordered/)
  }
})

test('independent TTS transfer and reliable Zhang dialogue leave a real speech gap', () => {
  const receipt = { narration: { ttsTrackSha256s: ['one', 'two', 'three'],
    compositionReceiptSha256: 'composition' }, picture: { sha256: 'picture' },
    output: { sha256: 'movie' } }
  const transfer = { status: 'confirmed', outputVideoSha256: 'movie',
    compositionReceiptSha256: 'composition', pictureSha256: 'picture',
    mixerVersion: 6, audioRole: 'narration',
    sourceSpeechIsolation: { status: 'confirmed', mode: 'full-source-mute',
      pictureSha256: 'picture', mixerVersion: 6 },
    lines: [0, 2.5, 9.5].map((start, index) => ({ status: 'confirmed',
      sourceWavSha256: ['one', 'two', 'three'][index], scheduledStart: start,
      observedEnd: { upper: [1.96, 5.82, 11.28][index] },
      sourceAsr: { reliable: true, boundaryStatus: 'reliable' },
      fullWindow: { passed: true }, lastWordWindow: { passed: true } })) }
  const speech = { passed: true, dialogueCompletenessVerified: true,
    lastSpeechEnd: 9.35,
    alignment: [{ actualStart: 3.05, actualEnd: 9.3,
    matchedEnd: 9.3, utteranceCandidateEnd: 9.35,
    endBoundaryRange: { lower: 9.3, upper: 9.35 },
    boundaryEvidenceVersion: 2, alignmentCoverage: 1,
    boundaryStatus: 'reliable', boundaryUncertaintyReasons: [],
    firstTokenMatched: true, lastTokenMatched: true,
    planned: { actorIds: ['张飞'] } }] }
  const source = { videoSha256: 'a'.repeat(64),
    evidenceVideoSha256: 'a'.repeat(64),
    nativeTiming: { approvedDurationSeconds: 10, nativeFrameCount: 241,
      firstPtsSeconds: 0, lastPtsSeconds: 10 },
    decodedAudioSampleCount: 160000 }
  const result = assertA8B6SpeechBoundary(transfer, speech, receipt, source)
  assert.equal(result.secondDialogueGlobalStart, 17.05)
  assert.ok(result.speechGapSeconds > 5)
  assert.equal(result.secondPlayableEndSeconds, 10)
  assert.ok(result.secondSpeechFreeTailSeconds >= .5)
  const exactHalfSecond = { ...speech, lastSpeechEnd: 9.5 }
  assert.equal(assertA8B6SpeechBoundary(transfer, exactHalfSecond,
    receipt, source).secondSpeechFreeTailSeconds, .5)
  assert.throws(() => assertA8B6SpeechBoundary({ ...transfer,
    sourceSpeechIsolation: { status: 'unverified', mode: 'unknown' } },
  speech, receipt, source),
  /lacks bound decoded speech evidence/)
  assert.throws(() => assertA8B6SpeechBoundary(transfer,
    { ...speech, lastSpeechEnd: 9.51 }, receipt, source),
  /measured tail pause/)
  assert.throws(() => assertA8B6SpeechBoundary(transfer,
    { ...speech, lastSpeechEnd: 9.5001 }, receipt, source),
  /measured tail pause/)
  assert.throws(() => assertA8B6SpeechBoundary(transfer, speech, receipt,
    { ...source, decodedAudioSampleCount: 156000 }),
  /measured tail pause/)
  assert.throws(() => assertA8B6SpeechBoundary(transfer, speech, receipt,
    { ...source, evidenceVideoSha256: 'b'.repeat(64) }),
  /source-bound evidence/)
  assert.throws(() => assertA8B6SpeechBoundary(transfer,
    { ...speech, alignment: [{ ...speech.alignment[0],
      endBoundaryRange: undefined }] }, receipt, source),
  /source-bound evidence/)
})
