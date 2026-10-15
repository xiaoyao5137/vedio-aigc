/** Strict, read-only facts for the two consecutive schema180 Sanguo shots.
 * Semantic space, costume and tied-wrist continuity still needs direct review. */
import { createHash } from 'node:crypto'

const invalid = reason => { throw Error(`SANGUO_A8B6_TWO_SHOT_QA_INVALID: ${reason}`) }
const success = run => run?.status === 'success'

export function parseA8B6FrameMd5(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const timebase = /^#tb 0: (\d+\/\d+)$/m.exec(text)?.[1]
  const dimensions = /^#dimensions 0: (\d+x\d+)$/m.exec(text)?.[1]
  const frameLines = lines.filter(line => /^0,/.test(line))
  const rows = frameLines.map(line => line.split(',').map(value => value.trim()))
  if (timebase !== '1/24' || dimensions !== '1280x720' || !rows.length
    || rows.some(row => row.length !== 6 || !/^\d+$/.test(row[2])
      || !/^[a-f0-9]{32}$/.test(row[5])))
    invalid('decoded video is not a 1280x720 24fps native frame sequence')
  return { timebase, dimensions,
    pts: rows.map(row => Number(row[2])), hashes: rows.map(row => row[5]),
    frameDigestSha256: createHash('sha256').update(frameLines.join('\n')).digest('hex') }
}

const EXPECTED = Object.freeze({
  first: { script: [11, 'sanguo-shot-script-accept'],
    certificate: [50, 'sanguo-scene-cut-approval'],
    video: [52, 'sanguo-video'], evidence: [54, 'sanguo-video-evidence'],
    review: [58, 'sanguo-media-review'], accept: [59, 'sanguo-media-accept'],
    concat: [63, 'sanguo-video-concat'], last: [64, 'sanguo-last-frame'] },
  second: { script: [67, 'sanguo-shot-script-accept'],
    firstFrame: [81, 'sanguo-first-frame-branch'],
    certificate: [106, 'sanguo-scene-cut-approval'],
    video: [108, 'sanguo-video'], evidence: [110, 'sanguo-video-evidence'],
    review: [114, 'sanguo-media-review'], accept: [115, 'sanguo-media-accept'],
    concat: [119, 'sanguo-video-concat'], last: [120, 'sanguo-last-frame'] },
})

export function requireA8B6TwoShotRuns(state, recordId) {
  const runs = state?.nodeRuns
  if (state?.id !== recordId || state.workflowId !== 'wf-sanguo-history-drama'
    || !Array.isArray(runs) || runs.length !== 464
    || runs.slice(0, 121).some(run => !['success', 'skipped'].includes(run?.status)))
    invalid('the same schema180 record has not completed both consecutive shot prefixes')
  const output = {}
  for (const [shot, roles] of Object.entries(EXPECTED)) {
    output[shot] = {}
    for (const [role, [index, id]] of Object.entries(roles)) {
      const run = runs[index]
      if (run?.node?.id !== id || run.loopIndex !== (shot === 'first' ? 0 : 1)
        || !success(run)) invalid(`${shot} ${role} is not the completed node ${index}`)
      output[shot][role] = run
    }
  }
  if (output.first.script.output?.id !== 'scene-01'
    || output.first.script.output?.duration !== 14
    || output.second.script.output?.id !== 'scene-02'
    || output.second.script.output?.duration !== 10
    || output.second.script.output?.audioType !== '对白')
    invalid('14+10 second accepted shot scripts changed')
  return output
}

/** A media-accept node can be successful while the visual action is still
 * uncertain. Require the accepted duration gate for every mandatory beat. */
export function assertA8B6ShotCompletion(shot, accepted) {
  const required = shot?.pacing?.beats?.filter(beat =>
    beat.completion?.requiredThisClip).map(beat => beat.id)
  const completion = accepted?.durationCompletion
  const checks = completion?.checks
  if (!Array.isArray(required) || !required.length
    || !Array.isArray(checks) || checks.length !== required.length
    || completion?.passed !== true || completion.assessment !== 'complete'
    || completion.scheduleHash !== shot?.pacing?.scheduleHash
    || completion.scheduleHash !== shot?.scheduleHash
    || completion.remainingMandatoryBeats?.length !== 0
    || required.some(id => checks.filter(check =>
      check.beatId === id && check.status === 'complete').length !== 1)
    || accepted?.passed !== true || accepted.visualReview?.passed !== true
    || accepted.manualDecisionRequired !== false)
    invalid('shot was accepted while a mandatory beat or direct visual review remained incomplete')
  return { requiredBeatIds: required,
    actualCompletionInterval: completion.actualCompletionInterval,
    assessment: completion.assessment }
}

/** Kling's nominal 10 s take may end on frame 239, 240 or 241. Use its
 * decoded PTS and the accepted script duration, never container duration. */
export function assertA8B6NativeSecondTiming(native) {
  const count = native?.hashes?.length
  if (native?.timebase !== '1/24' || !Number.isInteger(count)
    || count < 240 || count > 242
    || native.pts?.length !== count
    || native.pts.some((pts, index) => pts !== index)
    || Math.abs(native.pts.at(-1) / 24 - 10) > 1 / 24 + 1e-9)
    invalid('second paid take does not have a continuous native 24fps PTS sequence around approved 10 seconds')
  return { nativeFrameCount: count, firstPtsSeconds: 0,
    lastPtsSeconds: native.pts.at(-1) / 24, approvedDurationSeconds: 10 }
}

export function assertA8B6ConcatFrames(first, second, concat, secondNative,
  firstFrameCount = 337) {
  const native = assertA8B6NativeSecondTiming(secondNative)
  const secondFrameCount = native.nativeFrameCount
  if (!Number.isInteger(firstFrameCount)
    || firstFrameCount < 335 || firstFrameCount > 339
    || first?.timebase !== '1/24' || second?.timebase !== '1/24'
    || concat?.timebase !== '1/24'
    || first.hashes?.length !== firstFrameCount
    || second.hashes?.length !== secondFrameCount
    || concat.hashes?.length !== firstFrameCount + secondFrameCount
    || first.pts?.some((pts, index) => pts !== index)
    || second.pts?.some((pts, index) => pts !== index)
    || concat.pts?.some((pts, index) => pts !== concat.pts[0] + index)
    || concat.pts[0] < 0 || concat.pts[0] > 1
    || first.hashes.some((digest, index) => digest !== concat.hashes[index])
    || second.hashes.some((digest, index) =>
      digest !== concat.hashes[firstFrameCount + index]))
    invalid('24fps concat lost, reordered, retimed or inserted native frames at the 14+10 second seam')
  return { firstNormalizedFrames: firstFrameCount,
    secondNativeFrames: secondFrameCount,
    secondNormalizedFrames: secondFrameCount,
    concatFrames: firstFrameCount + secondFrameCount,
    concatFirstPts: concat.pts[0],
    cutBeforeConcatFrameIndex: firstFrameCount,
    firstTailConcatFrameIndex: firstFrameCount - 1,
    secondFirstConcatFrameIndex: firstFrameCount,
    cutPtsSeconds: concat.pts[firstFrameCount] / 24,
    cutRelativePtsSeconds: (concat.pts[firstFrameCount] - concat.pts[0]) / 24,
    initialPtsOffsetSeconds: concat.pts[0] / 24,
    lastPtsSeconds: concat.pts.at(-1) / 24,
    lastRelativePtsSeconds: (concat.pts.at(-1) - concat.pts[0]) / 24,
    nominalApprovedSeconds: 24,
    secondNativeLastPtsSeconds: native.lastPtsSeconds }
}

/** Proves a measured speech-free tail of the actual archived second take.
 * The caller binds its decoded frames/PCM and speech evidence to one SHA. */
export function assertA8B6SpeechBoundary(transfer, secondSpeech, receipt,
  secondSource) {
  const lines = transfer?.lines
  const expected = receipt?.narration?.ttsTrackSha256s
  if (transfer?.status !== 'confirmed'
    || transfer.outputVideoSha256 !== receipt.output?.sha256
    || transfer.compositionReceiptSha256 !== receipt.narration?.compositionReceiptSha256
    || transfer.pictureSha256 !== receipt.picture?.sha256
    || transfer.mixerVersion !== 6 || transfer.audioRole !== 'narration'
    || transfer.sourceSpeechIsolation?.status !== 'confirmed'
    || transfer.sourceSpeechIsolation?.mode !== 'full-source-mute'
    || transfer.sourceSpeechIsolation.pictureSha256 !== receipt.picture.sha256
    || transfer.sourceSpeechIsolation.mixerVersion !== 6
    || !Array.isArray(lines) || lines.length !== 3
    || !Array.isArray(expected) || expected.length !== 3
    || lines.some((line, index) => line.status !== 'confirmed'
      || line.sourceWavSha256 !== expected[index]
      || line.sourceAsr?.reliable !== true
      || line.sourceAsr?.boundaryStatus !== 'reliable'
      || line.fullWindow?.passed !== true || line.lastWordWindow?.passed !== true)
    || JSON.stringify(lines.map(line => line.scheduledStart)) !== JSON.stringify([0, 2.5, 9.5])
    || secondSpeech?.passed !== true
    || secondSpeech.dialogueCompletenessVerified !== true
    || !Array.isArray(secondSpeech.alignment)
    || secondSpeech.alignment.length !== 1)
    invalid('first TTS or second dialogue lacks bound decoded speech evidence')
  const firstEndUpper = Math.max(...lines.map(line => line.observedEnd?.upper ?? NaN))
  const dialogue = secondSpeech.alignment[0]
  const secondStart = dialogue?.actualStart, secondEnd = dialogue?.actualEnd
  const globalSecondStart = 14 + secondStart
  const timing = secondSource?.nativeTiming
  const samples = secondSource?.decodedAudioSampleCount
  const videoEnd = timing?.nativeFrameCount / 24
  const audioEnd = samples / 16000
  const playableEnd = Math.min(videoEnd, audioEnd)
  const speechEndUpper = Math.max(secondEnd,
    dialogue?.matchedEnd, dialogue?.utteranceCandidateEnd,
    dialogue?.endBoundaryRange?.upper, secondSpeech.lastSpeechEnd)
  const tailPause = playableEnd - speechEndUpper
  if (!Number.isFinite(firstEndUpper) || firstEndUpper > 14
    || dialogue?.boundaryStatus !== 'reliable'
    || dialogue?.boundaryEvidenceVersion !== 2
    || dialogue?.alignmentCoverage !== 1
    || !Array.isArray(dialogue?.boundaryUncertaintyReasons)
    || dialogue.boundaryUncertaintyReasons.length !== 0
    || dialogue?.firstTokenMatched !== true || dialogue?.lastTokenMatched !== true
    || !dialogue?.planned?.actorIds?.includes('张飞')
    || !Number.isFinite(secondStart) || !Number.isFinite(secondEnd)
    || secondStart < 0 || secondEnd <= secondStart
    || ![dialogue.matchedEnd, dialogue.utteranceCandidateEnd,
      dialogue.endBoundaryRange?.upper, secondSpeech.lastSpeechEnd]
      .every(value => Number.isFinite(value) && value >= secondEnd - .15)
    || !/^[a-f0-9]{64}$/.test(secondSource?.videoSha256 ?? '')
    || secondSource?.evidenceVideoSha256 !== secondSource.videoSha256
    || timing?.approvedDurationSeconds !== 10
    || !Number.isInteger(timing?.nativeFrameCount)
    || timing.nativeFrameCount < 240 || timing.nativeFrameCount > 242
    || timing.firstPtsSeconds !== 0
    || Math.abs(timing.lastPtsSeconds
      - (timing.nativeFrameCount - 1) / 24) > 1e-9
    || !Number.isInteger(samples) || samples <= 0
    || !Number.isFinite(audioEnd) || Math.abs(audioEnd - 10) > .15
    || !Number.isFinite(speechEndUpper) || speechEndUpper > playableEnd
    || tailPause < .5 - 1e-9
    || globalSecondStart - firstEndUpper < .25)
    invalid('first narration, second Zhang dialogue or measured tail pause lacks reliable source-bound evidence')
  return { firstNarrationLastObservedEndUpper: firstEndUpper,
    secondDialogueObservedStart: secondStart,
    secondDialogueObservedEndUpper: speechEndUpper,
    secondDialogueGlobalStart: globalSecondStart,
    speechGapSeconds: globalSecondStart - firstEndUpper,
    secondVideoSha256: secondSource.videoSha256,
    secondNativeFrameCount: timing.nativeFrameCount,
    secondAudioSampleCount: samples,
    secondPlayableEndSeconds: playableEnd,
    secondSpeechFreeTailSeconds: tailPause,
    requiredSpeechFreeTailSeconds: .5,
    crossShotVoiceOverlap: false,
    evidenceScope: 'source-bound decoded transfer, dialogue alignment, native frames and mono PCM; no human listening or visual stillness claim' }
}
