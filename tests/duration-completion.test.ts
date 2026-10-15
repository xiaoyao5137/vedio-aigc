import test from 'node:test'
import assert from 'node:assert/strict'
import { assessDurationCompletion } from '../src/duration-completion.ts'

const assessors = [assessDurationCompletion, new Function('return (' + assessDurationCompletion.toString() + ')')() as typeof assessDurationCompletion]
const point = (second: number) => ({ lower: second, upper: second })
const beat = (id: string, kind = 'reaction', modality = 'visual') => ({ id, sourceBeatId: 'required-' + id, actorIds: ['villagers'],
  kind, textOrVocalization: kind === 'speech' ? '天下规矩房伯武' : '点头并作出回应', dependsOn: [] as string[], overlapAllowedWith: [],
  completion: { requiredThisClip: true, finalState: '回应结束', modality, evidenceAnchor: '原requiredBeat的回应' },
  timingConstraint: { mode: 'reference' } as Record<string, unknown> })
function fixture() {
  const b = beat('response')
  const shot = { duration: 9, pacing: { version: 'duration-v2', scheduleHash: 'schedule-a', timingPolicy: { endingReadabilityReserve: .5 },
    beats: [b], schedule: [{ beatId: b.id, sourceBeatId: b.sourceBeatId, startSecond: 4, endSecond: 5, timingConstraint: b.timingConstraint }] } }
  const frameTimes = [0, 5, 5.5, 6], indices = [0, 10, 11, 12]
  const evidence = { duration: 9, decoded: true, evidenceUrl: '/generated/evidence-a.json', frames: frameTimes.map((_, i) => '/generated/frame-' + i + '.jpg'), frameTimes,
    nativeSequence: { sourceVideoSha256: 'a'.repeat(64), archiveSha256: 'b'.repeat(64), totalNativeFrames: 18,
      selectedNativeFrameIndices: indices, windows: [{ start: 5, end: 6, complete: true }] },
    frameReferences: frameTimes.map((time, i) => ({ index: i, evidenceIndex: i, nativeFrameIndex: indices[i], pts: time * 2,
      timeBase: '1/2', second: time, url: '/generated/frame-' + i + '.jpg', sourceSha256: 'c'.repeat(64) })),
    speechValidation: { alignment: [] as Record<string, unknown>[], lastSpeechEnd: 6 }, audioObservations: [] as Record<string, unknown>[] }
  const row = { beatId: b.id, sourceBeatId: b.sourceBeatId, status: 'complete', reason: '实际连续原帧显示人群完成点头回应。',
    observedStart: point(5), observedEnd: point(6),
    visual: { frameIndices: [1, 2, 3], observedChange: '低头后抬起恢复面向主唱。', observedFinalState: '抬头回应已经结束。' },
    audio: { evidenceIds: [] as string[] }, defect: undefined as Record<string, unknown> | undefined }
  return { shot, evidence, review: { durationCompletion: { scheduleHash: 'schedule-a', evidenceRef: evidence.evidenceUrl, checks: [row] } } }
}

test('v1 behavior is not replaced by the v2 completion gate', () => {
  for (const assess of assessors) assert.deepEqual(assess({ pacing: { version: 'dynamic-v1' } }, {}, {}).route, 'legacy')
})

test('reference-window shift can complete with real continuous source frames and readable ending', () => {
  for (const assess of assessors) {
    const f = fixture(), before = structuredClone(f), result = assess(f.shot, f.evidence, f.review)
    assert.equal(result.assessment, 'complete'); assert.equal(result.route, 'accept')
    assert.deepEqual(result.actualCompletionInterval, point(6)); assert.equal(result.requiredEndSecond, 6.5)
    assert.deepEqual(f, before)
  }
})

test('sound tail, a single still, missing native frames and stale material cannot certify response', () => {
  for (const assess of assessors) for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.review.durationCompletion.checks[0].visual.frameIndices = [3] },
    (f: ReturnType<typeof fixture>) => { f.review.durationCompletion.checks[0].visual.frameIndices = [1, 3] },
    (f: ReturnType<typeof fixture>) => { f.evidence.frameReferences[2].pts = 123 },
    (f: ReturnType<typeof fixture>) => { f.review.durationCompletion.evidenceRef = '/generated/old-evidence.json' },
    (f: ReturnType<typeof fixture>) => { f.review.durationCompletion.scheduleHash = 'old-schedule' },
    (f: ReturnType<typeof fixture>) => { f.review.durationCompletion.checks = [] },
    (f: ReturnType<typeof fixture>) => { f.review.durationCompletion.checks[0].visual.observedChange = '无法确认是否完整点头。' },
    (f: ReturnType<typeof fixture>) => { f.review.durationCompletion.checks[0].visual.observedChange = '无法完全确认点头。' },
    (f: ReturnType<typeof fixture>) => { f.review.durationCompletion.checks[0].visual.observedFinalState = 'unobservable' },
  ]) {
    const f = fixture(); mutate(f)
    const result = assess(f.shot, f.evidence, f.review)
    assert.equal(result.assessment, 'uncertain'); assert.equal(result.route, 'same-media-evidence'); assert.equal(result.passed, false)
    assert.ok(result.evidenceRequests.length)
  }
})

test('uncertain action requests a bounded native window while retaining the legal search range', () => {
  for (const assess of assessors) {
    const f = fixture()
    delete (f.evidence as Record<string, unknown>).nativeSequence
    const result = assess(f.shot, f.evidence, f.review)
    const request = result.evidenceRequests.find(item => item.beatId === 'response')!
    assert.equal(request.kind, 'native-sequence')
    assert.equal(request.startSecond, 4.5)
    assert.equal(request.endSecond, 6.5)
    assert.deepEqual(request.searchWindow, { start: 0, end: 9 })
  }
})

test('hard timing is not relaxed by reference scopes or measurement tolerance', () => {
  for (const assess of assessors) {
    const f = fixture(), constraint = { mode: 'hard', deadlineSecond: 5 }
    f.shot.pacing.beats[0].timingConstraint = constraint; f.shot.pacing.schedule[0].timingConstraint = constraint
    const result = assess(f.shot, f.evidence, f.review)
    assert.equal(result.assessment, 'incomplete'); assert.equal(result.route, 'replan')
    f.shot.pacing.beats[0].timingConstraint = { mode: 'hard', deadlineSecond: 6.1 }
    f.shot.pacing.schedule[0].timingConstraint = f.shot.pacing.beats[0].timingConstraint
    f.review.durationCompletion.checks[0].observedEnd = { lower: 6, upper: 6.2 }
    assert.equal(assess(f.shot, f.evidence, f.review).assessment, 'uncertain')
  }
})

test('confirmed truncation replans, while a sampled window end cannot be called the video end', () => {
  for (const assess of assessors) {
    const f = fixture(), row = f.review.durationCompletion.checks[0]
    row.status = 'incomplete'; row.defect = { kind: 'truncated', reason: '实际末帧中接收者仍在伸手，物件仍在交出者手中。' }
    row.visual.observedChange = '实际末帧中接收者仍在伸手，物件尚在交出者手中。'
    assert.equal(assess(f.shot, f.evidence, f.review).route, 'same-media-evidence')
    f.evidence.nativeSequence.totalNativeFrames = 13; f.evidence.duration = 6.04
    assert.equal(assess(f.shot, f.evidence, f.review).route, 'replan')
    assert.equal(assess(f.shot, f.evidence, f.review).minimumAdditionalSeconds, null, '从截断下界不能伪造剩余动作精确时长')
  }
})

test('readability reserve is added to completion upper bound without borrowing measurement tolerance', () => {
  for (const assess of assessors) {
    const f = fixture(); f.evidence.duration = 6.3
    let result = assess(f.shot, f.evidence, f.review)
    assert.equal(result.assessment, 'incomplete'); assert.ok(Math.abs(result.minimumAdditionalSeconds! - .2) < 1e-7)
    f.evidence.duration = 6.6; f.review.durationCompletion.checks[0].observedEnd = { lower: 6, upper: 6.2 }
    result = assess(f.shot, f.evidence, f.review)
    assert.equal(result.assessment, 'uncertain'); assert.equal(result.route, 'same-media-evidence'); assert.ok(result.evidenceRequests.length)
  }
})

test('incomplete terminal phonetic alignment never substitutes an earlier matched word for completion', () => {
  for (const assess of assessors) {
    const f = fixture(), b = beat('response', 'speech', 'audio')
    f.shot.pacing.beats = [b]
    const row = f.review.durationCompletion.checks[0]; row.observedStart = point(.37); row.observedEnd = point(4.99); row.audio.evidenceIds = ['speech-0']
    f.evidence.speechValidation.alignment = [{ planned: { text: b.textOrVocalization, beatId: b.id, sourceBeatId: b.sourceBeatId, actorIds: b.actorIds }, actualStart: .37, actualEnd: 4.99,
      boundaryStatus: 'uncertain', firstTokenMatched: true, lastTokenMatched: false, startBoundaryRange: point(.37), endBoundaryRange: { lower: 4.99, upper: 5.53 } }]
    assert.equal(assess(f.shot, f.evidence, f.review).route, 'same-media-evidence')
    Object.assign(f.evidence.speechValidation.alignment[0], { boundaryStatus: 'reliable', firstTokenMatched: true, lastTokenMatched: true,
      boundaryEvidenceVersion: 2, alignmentCoverage: 1, boundaryUncertaintyReasons: [],
      endBoundaryRange: point(5.53) }); row.observedEnd = point(5.53)
    assert.equal(assess(f.shot, f.evidence, f.review).route, 'accept')
  }
})

test('independent narration accepts only bound source receipt and decoded full plus final-word transfer', () => {
  const transferFixture = () => {
    const f = fixture(), b = { ...beat('response', 'speech', 'audio'), actorIds: ['旁白'], deliveryStyle: 'narration' }
    f.shot.pacing.beats = [b]
    f.evidence.sha256 = 'd'.repeat(64)
    f.evidence.originalUrl = '/generated/narrated-' + 'e'.repeat(64) + '.mp4'
    const row = f.review.durationCompletion.checks[0]
    row.reason = '成片解码音轨逐句与独立旁白源音轨一致，末词已进入成片。'
    row.observedStart = point(4); row.observedEnd = point(4.8)
    row.audio.evidenceIds = ['independent-track-0']
    const window = (start: number, end: number) => ({ start, end, samples: Math.round((end - start) * 16000),
      correlation: .999, normalizedError: .03, noTrackErrorRatio: 12, contributionRms: .08, actualRms: .1, passed: true })
    f.evidence.independentNarrationTransfer = { version: 'independent-track-transfer-v1', method: 'independent-track-transfer',
      status: 'confirmed', audioRole: 'narration', evidenceRef: f.evidence.evidenceUrl, originalUrl: f.evidence.originalUrl,
      outputVideoSha256: f.evidence.sha256, compositionReceiptSha256: '2'.repeat(64), pictureSha256: '3'.repeat(64),
      mixerVersion: 5, sourceSpeechIsolation: { version: 'source-speech-isolation-v1', status: 'confirmed',
        mode: 'full-source-mute', pictureSha256: '3'.repeat(64), mixerVersion: 5 },
      sampleRate: 16000, decodedAudioDuration: 9, expectedAudioDuration: 9, lines: [{
        id: 'independent-track-0', beatId: b.id, text: b.textOrVocalization, actorIds: ['旁白'],
        sourceReceiptKey: 'a'.repeat(64), sourceReceiptSha256: 'b'.repeat(64), sourceWavSha256: 'c'.repeat(64),
        fittedWavSha256: 'c'.repeat(64), sourceAsr: { method: 'isolated-source-asr-v2', reliable: true,
          recognizedText: b.textOrVocalization, boundaryStatus: 'reliable', receiptKey: 'e'.repeat(64),
          receiptSha256: 'f'.repeat(64), issues: [] },
        scheduledStart: 4, scheduledEnd: 5, observedStart: point(4), observedEnd: point(4.8),
        fullWindow: window(4, 4.8), lastWordWindow: window(4.45, 4.8), status: 'confirmed',
      }] }
    return f
  }
  for (const assess of assessors) {
    const valid = transferFixture()
    assert.equal(assess(valid.shot, valid.evidence, valid.review).route, 'accept')
    const current = transferFixture()
    current.evidence.independentNarrationTransfer.mixerVersion = 6
    current.evidence.independentNarrationTransfer.sourceSpeechIsolation.mixerVersion = 6
    current.evidence.independentNarrationTransfer.sourceSpeechIsolation.mode = 'full-source-mute'
    assert.equal(assess(current.shot, current.evidence, current.review).route, 'accept')
    const oldPreserved = transferFixture()
    oldPreserved.evidence.independentNarrationTransfer.sourceSpeechIsolation.status = 'unverified'
    oldPreserved.evidence.independentNarrationTransfer.sourceSpeechIsolation.mode = 'preserved'
    assert.equal(assess(oldPreserved.shot, oldPreserved.evidence, oldPreserved.review).route,
      'same-media-evidence', 'a v5 preserved/empty-detection source track cannot certify a narration line')
    const medium = transferFixture(), mediumAsr = medium.evidence.independentNarrationTransfer.lines[0].sourceAsr as Record<string, unknown>
    Object.assign(mediumAsr, { method: 'isolated-source-asr-v3', modelVersion: 'Systran/faster-whisper-medium@08e178d48790749d25932bbc082711ddcfdfbc4f',
      primaryAsr: { method: 'isolated-source-asr-v2', reliable: false, boundaryStatus: 'uncertain',
        receiptKey: '1'.repeat(64), receiptSha256: '2'.repeat(64) } })
    assert.equal(assess(medium.shot, medium.evidence, medium.review).route, 'accept')
    for (const mutate of [
      (asr: Record<string, unknown>) => { asr.modelVersion = 'unknown-model' },
      (asr: Record<string, unknown>) => { (asr.primaryAsr as Record<string, unknown>).reliable = true },
      (asr: Record<string, unknown>) => { (asr.primaryAsr as Record<string, unknown>).boundaryStatus = 'reliable' },
      (asr: Record<string, unknown>) => { (asr.primaryAsr as Record<string, unknown>).receiptSha256 = 'wrong' },
    ]) {
      const stale = transferFixture(), asr = stale.evidence.independentNarrationTransfer.lines[0].sourceAsr as Record<string, unknown>
      Object.assign(asr, structuredClone(mediumAsr)); mutate(asr)
      assert.equal(assess(stale.shot, stale.evidence, stale.review).route, 'same-media-evidence')
    }
    for (const mutate of [
      (f: ReturnType<typeof transferFixture>) => { f.evidence.sha256 = '1'.repeat(64) },
      (f: ReturnType<typeof transferFixture>) => { f.evidence.independentNarrationTransfer.originalUrl = '/generated/wrong.mp4' },
      (f: ReturnType<typeof transferFixture>) => { f.evidence.independentNarrationTransfer.sourceSpeechIsolation.status = 'unverified' },
      (f: ReturnType<typeof transferFixture>) => { f.evidence.independentNarrationTransfer.sourceSpeechIsolation.mode = 'observed-speech-muted' },
      (f: ReturnType<typeof transferFixture>) => { f.evidence.independentNarrationTransfer.sourceSpeechIsolation.pictureSha256 = '4'.repeat(64) },
      (f: ReturnType<typeof transferFixture>) => { f.evidence.independentNarrationTransfer.evidenceRef = '/generated/stale.json' },
      (f: ReturnType<typeof transferFixture>) => { f.evidence.independentNarrationTransfer.lines[0].sourceReceiptKey = 'wrong' },
      (f: ReturnType<typeof transferFixture>) => { f.evidence.independentNarrationTransfer.lines[0].sourceAsr.reliable = false },
      (f: ReturnType<typeof transferFixture>) => { f.evidence.independentNarrationTransfer.lines[0].lastWordWindow.noTrackErrorRatio = 1 },
      (f: ReturnType<typeof transferFixture>) => { f.evidence.independentNarrationTransfer.lines[0].lastWordWindow.end = 9.2 },
      (f: ReturnType<typeof transferFixture>) => { f.evidence.independentNarrationTransfer.lines[0].scheduledEnd = 6 },
      (f: ReturnType<typeof transferFixture>) => { f.shot.pacing.beats[0].actorIds = ['张飞'] },
    ]) {
      const f = transferFixture(); mutate(f)
      assert.equal(assess(f.shot, f.evidence, f.review).route, 'same-media-evidence')
    }
  }
})

test('nonlexical group vocalization requires trusted audio, actors and melody evidence', () => {
  for (const assess of assessors) {
    const f = fixture(), b = { ...beat('response', 'vocalization', 'audio-visual'), vocalization: { melodyRelation: 'same-as-main-singer' } }
    f.shot.pacing.beats = [b]
    const row = f.review.durationCompletion.checks[0]; row.audio.evidenceIds = ['group-hum']
    assert.equal(assess(f.shot, f.evidence, f.review).route, 'same-media-evidence')
    f.evidence.audioObservations = [{ id: 'group-hum', evidenceRef: f.evidence.evidenceUrl, method: 'human-listen', status: 'confirmed',
      actorIds: ['villagers'], finding: '可听见群体完成短促哼唱，与主唱曲调一致。', audibility: 'observed', completionCue: 'observed',
      melodyRelation: 'observed', observedStart: point(5), observedEnd: point(6) }]
    assert.equal(assess(f.shot, f.evidence, f.review).route, 'accept')
    f.evidence.audioObservations[0].melodyRelation = 'unverified'
    assert.equal(assess(f.shot, f.evidence, f.review).route, 'same-media-evidence')
    f.evidence.audioObservations[0].melodyRelation = 'observed'; f.evidence.audioObservations[0].actorIds = ['main-singer']
    assert.equal(assess(f.shot, f.evidence, f.review).route, 'same-media-evidence')
  }
})

test('actual dependency inversion replans, unresolved predecessor cannot be hidden by array order', () => {
  for (const assess of assessors) {
    const f = fixture(), prior = beat('speech', 'speech', 'audio'), b = f.shot.pacing.beats[0]
    b.dependsOn = ['speech']; f.shot.pacing.beats.push(prior)
    f.shot.pacing.schedule.push({ beatId: prior.id, sourceBeatId: prior.sourceBeatId, startSecond: 1, endSecond: 4, timingConstraint: prior.timingConstraint })
    f.evidence.speechValidation.alignment = [{ planned: { text: prior.textOrVocalization, beatId: prior.id, sourceBeatId: prior.sourceBeatId, actorIds: prior.actorIds }, boundaryStatus: 'reliable', firstTokenMatched: true,
      boundaryEvidenceVersion: 2, alignmentCoverage: 1, boundaryUncertaintyReasons: [],
      lastTokenMatched: true, startBoundaryRange: point(2), endBoundaryRange: point(5.5) }]
    f.review.durationCompletion.checks.push({ ...structuredClone(f.review.durationCompletion.checks[0]), beatId: 'speech', sourceBeatId: prior.sourceBeatId,
      observedStart: point(2), observedEnd: point(5.5), audio: { evidenceIds: ['speech-0'] } })
    assert.equal(assess(f.shot, f.evidence, f.review).route, 'replan')
    f.evidence.speechValidation.alignment[0].boundaryStatus = 'uncertain'
    assert.equal(assess(f.shot, f.evidence, f.review).route, 'same-media-evidence')
  }
})

test('completed audio can precede visual completion, and a visual truncation does not claim audio truncation', () => {
  for (const assess of assessors) {
    const f = fixture(), b = { ...beat('response', 'vocalization', 'audio-visual'), vocalization: { melodyRelation: 'same-as-main-singer' } }
    f.shot.pacing.beats = [b]
    const row = f.review.durationCompletion.checks[0]; row.audio.evidenceIds = ['group-hum']
    f.evidence.audioObservations = [{ id: 'group-hum', evidenceRef: f.evidence.evidenceUrl, method: 'human-listen', status: 'confirmed',
      actorIds: ['villagers'], finding: '群体短促哼唱已完整结束，随后继续点头。', audibility: 'observed', completionCue: 'observed',
      melodyRelation: 'observed', observedStart: point(5), observedEnd: point(5.5) }]
    let result = assess(f.shot, f.evidence, f.review)
    assert.equal(result.route, 'accept'); assert.deepEqual(result.actualCompletionInterval, point(6))
    row.status = 'incomplete'; row.defect = { kind: 'truncated', modality: 'visual', reason: '实际末帧仍在伸手，接物动作未完成。' }
    row.visual.observedChange = '实际末帧仍在伸手，物件尚未接住。'
    f.evidence.nativeSequence.totalNativeFrames = 13; f.evidence.duration = 6.04
    result = assess(f.shot, f.evidence, f.review)
    assert.equal(result.route, 'replan'); assert.equal(result.checks[0].defect?.modality, 'visual')
    assert.equal(f.evidence.audioObservations[0].completionCue, 'observed', '不改写已完整声音来迎合整体缺陷')
  }
})

test('identical words from a different timing beat or actor cannot be reused as speech evidence', () => {
  for (const assess of assessors) {
    const f = fixture(), b = beat('response', 'speech', 'audio')
    f.shot.pacing.beats = [b]
    const row = f.review.durationCompletion.checks[0]; row.audio.evidenceIds = ['speech-0']
    f.evidence.speechValidation.alignment = [{ planned: { text: b.textOrVocalization, beatId: 'other', sourceBeatId: 'required-other', actorIds: b.actorIds },
      boundaryStatus: 'reliable', firstTokenMatched: true, lastTokenMatched: true, boundaryEvidenceVersion: 2, alignmentCoverage: 1,
      boundaryUncertaintyReasons: [], startBoundaryRange: point(5), endBoundaryRange: point(6) }]
    assert.equal(assess(f.shot, f.evidence, f.review).route, 'same-media-evidence')
    f.evidence.speechValidation.alignment[0].planned = { text: b.textOrVocalization, beatId: b.id, sourceBeatId: b.sourceBeatId, actorIds: ['someone-else'] }
    assert.equal(assess(f.shot, f.evidence, f.review).route, 'same-media-evidence')
  }
})
