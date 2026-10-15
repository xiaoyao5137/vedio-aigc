#!/usr/bin/env node
// Read-only, source-record audit for the first two Sanguo shots.
// This reports media evidence and review gaps; it never marks visual or voice quality accepted.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import pg from 'pg'
import sharp from 'sharp'
import ffmpeg from 'ffmpeg-static'
import { decodeExecutionState } from '../src/execution-storage.ts'

const args = process.argv.slice(2)
const options = { record: '', transcribeSource: false, decode: false }
for (let index = 0; index < args.length; index++) {
  const arg = args[index]
  if (arg === '--transcribe-source') options.transcribeSource = true
  else if (arg === '--decode') options.decode = true
  else if (arg === '--record' && !options.record && args[index + 1]) options.record = args[++index]
  else throw Error(`Unknown or incomplete argument: ${arg}`)
}
if (!/^record-[\w-]+$/.test(options.record)) {
  throw Error('Usage: node scripts/audit-two-shot-boundary.mjs --record record-ID [--transcribe-source] [--decode]')
}

const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const localGenerated = url => /^\/generated\/[\w.-]+$/.test(url ?? '')
  ? path.resolve('public', url.slice(1)) : null
const safeMediaUrl = url => localGenerated(url) ? url : url ? '[external media URL redacted]' : ''
const cleanSegments = segments => (Array.isArray(segments) ? segments : []).map(item => ({
  start: item.start, end: item.end, text: item.text,
}))
const overlapSeconds = (a, b) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start))
const run = (runs, id, loopIndex) => runs.filter(item => item.node?.id === id && item.loopIndex === loopIndex).at(-1)
const mandatoryChecksComplete = (shot, completion) => {
  const requiredIds = (shot.pacing?.beats ?? []).filter(beat => beat.completion?.requiredThisClip).map(beat => beat.id)
  const checks = Array.isArray(completion?.checks) ? completion.checks : []
  return completion?.passed === true && requiredIds.length > 0 && checks.length === requiredIds.length
    && requiredIds.every(id => checks.filter(check => check.beatId === id && check.status === 'complete').length === 1)
}
const fileEvidence = async (url, expectedSha256) => {
  const filename = localGenerated(url)
  if (!filename) return { url: safeMediaUrl(url), local: false, exists: false }
  try {
    const bytes = await readFile(filename)
    const sha256 = hash(bytes)
    return { url: safeMediaUrl(url), local: true, exists: true, bytes: bytes.length, sha256,
      ...(expectedSha256 ? { expectedSha256, hashMatches: sha256 === expectedSha256 } : {}) }
  } catch (error) {
    if (error?.code === 'ENOENT') return { url: safeMediaUrl(url), local: true, exists: false }
    throw error
  }
}
const pictureFile = url => typeof url !== 'string' || !url ? null
  : localGenerated(url) ?? path.resolve('public/generated', `narration-picture-${hash(url)}.mp4`)
const pictureEvidence = async (url, expectedSha256) => {
  const filename = pictureFile(url)
  if (!filename) return null
  try {
    const bytes = await readFile(filename)
    const sha256 = hash(bytes)
    return { exists: true, sha256, expectedSha256, hashMatches: sha256 === expectedSha256,
      sourceKind: localGenerated(url) ? 'local-generated' : 'cached-provider-picture' }
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, expectedSha256,
      sourceKind: localGenerated(url) ? 'local-generated' : 'cached-provider-picture' }
    throw error
  }
}
const muteCoverage = (plan, duration) => {
  if (!plan) return null
  const observations = Array.isArray(plan.observations) ? plan.observations : []
  const mutedWindows = Array.isArray(plan.mutedWindows) ? plan.mutedWindows : []
  const fullPictureAudioMuted = plan.status === 'fully-muted-unverified'
    && Number.isFinite(duration) && mutedWindows.some(window => window.start <= 0 && window.end >= duration)
  return { observationCount: observations.length,
    observations: observations.map(observation => ({ source: observation.source,
      start: observation.start, end: observation.end, text: observation.text,
      coveredByMute: mutedWindows.some(window => window.start <= observation.start && window.end >= observation.end) })),
    allObservedSourceSpeechMuted: fullPictureAudioMuted || observations.length > 0
      && observations.every(observation => mutedWindows.some(window =>
        window.start <= observation.start && window.end >= observation.end)),
    fullPictureAudioMuted,
    sourceSpeechAbsenceVerified: false,
    detectorAvailable: plan.detector !== 'unavailable',
    preservedOutsideWindows: plan.preservedOutsideWindows === true,
    fallbackReason: plan.fallbackReason ?? null }
}
const narrationTransfer = (transfer, evidence, media, shot) => {
  if (!transfer) return null
  const requiredNarrationIds = (shot.pacing?.beats ?? []).filter(beat => beat.completion?.requiredThisClip
    && beat.kind === 'speech' && (beat.deliveryStyle === 'narration' || beat.actorIds?.includes('旁白'))).map(beat => beat.id)
  const lines = Array.isArray(transfer.lines) ? transfer.lines : []
  return { version: transfer.version, method: transfer.method, status: transfer.status,
    evidenceRef: safeMediaUrl(transfer.evidenceRef), originalUrl: safeMediaUrl(transfer.originalUrl),
    outputVideoSha256: transfer.outputVideoSha256, compositionReceiptSha256: transfer.compositionReceiptSha256,
    pictureSha256: transfer.pictureSha256, mixerVersion: transfer.mixerVersion,
    sourceSpeechIsolation: transfer.sourceSpeechIsolation ? {
      version: transfer.sourceSpeechIsolation.version,
      status: transfer.sourceSpeechIsolation.status,
      mode: transfer.sourceSpeechIsolation.mode,
      pictureSha256: transfer.sourceSpeechIsolation.pictureSha256,
      mixerVersion: transfer.sourceSpeechIsolation.mixerVersion,
      boundToTransfer: transfer.sourceSpeechIsolation.version === 'source-speech-isolation-v1'
        && transfer.sourceSpeechIsolation.status === 'confirmed'
        && transfer.sourceSpeechIsolation.mode === 'full-source-mute'
        && transfer.sourceSpeechIsolation.pictureSha256 === transfer.pictureSha256
        && transfer.sourceSpeechIsolation.mixerVersion === transfer.mixerVersion,
    } : null,
    sampleRate: transfer.sampleRate, expectedAudioDuration: transfer.expectedAudioDuration,
    decodedAudioDuration: transfer.decodedAudioDuration, reason: transfer.reason ?? null,
    boundToCurrentEvidence: transfer.evidenceRef === evidence?.evidenceUrl
      && transfer.originalUrl === evidence?.originalUrl
      && transfer.outputVideoSha256 === evidence?.sha256
      && transfer.outputVideoSha256 === media.sha256,
    requiredNarrationBeatIds: requiredNarrationIds,
    allRequiredNarrationLinesConfirmed: requiredNarrationIds.length > 0 && requiredNarrationIds.every(id =>
      lines.filter(line => line.beatId === id && line.status === 'confirmed').length === 1),
    lines: lines.map(line => ({ id: line.id, beatId: line.beatId, text: line.text,
      status: line.status, scheduledStart: line.scheduledStart, scheduledEnd: line.scheduledEnd,
      observedStart: line.observedStart, observedEnd: line.observedEnd,
      sourceReceiptKey: line.sourceReceiptKey, sourceReceiptSha256: line.sourceReceiptSha256,
      sourceWavSha256: line.sourceWavSha256, fittedWavSha256: line.fittedWavSha256,
      sourceAsr: line.sourceAsr ? { receiptKey: line.sourceAsr.receiptKey,
        receiptSha256: line.sourceAsr.receiptSha256, reliable: line.sourceAsr.reliable,
        boundaryStatus: line.sourceAsr.boundaryStatus, recognizedText: line.sourceAsr.recognizedText,
        issues: line.sourceAsr.issues } : null,
      fullWindow: line.fullWindow ? { start: line.fullWindow.start, end: line.fullWindow.end,
        passed: line.fullWindow.passed, correlation: line.fullWindow.correlation } : null,
      lastWordWindow: line.lastWordWindow ? { start: line.lastWordWindow.start, end: line.lastWordWindow.end,
        passed: line.lastWordWindow.passed, correlation: line.lastWordWindow.correlation } : null })),
    scope: transfer.scope }
}
const decodeVideo = url => {
  const filename = localGenerated(url)
  if (!filename || !ffmpeg) return { attempted: false, reason: 'local FFmpeg video unavailable' }
  const result = spawnSync(ffmpeg, ['-hide_banner', '-v', 'error', '-xerror', '-i', filename, '-f', 'null', '-'],
    { encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024 })
  return { attempted: true, passed: result.status === 0, ...(result.status === 0 ? {} : { error: result.stderr?.trim().slice(-1000) || result.error?.message }) }
}
const imageDifference = async (leftUrl, rightUrl) => {
  const filenames = [leftUrl, rightUrl].map(localGenerated)
  if (filenames.some(filename => !filename)) return null
  try {
    const [left, right] = await Promise.all(filenames.map(filename =>
      sharp(filename).resize(96, 54, { fit: 'fill' }).removeAlpha().raw().toBuffer()))
    return left.reduce((sum, value, index) => sum + Math.abs(value - right[index]), 0) / (left.length * 255)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}
const transcribeSource = url => {
  if (!url || typeof url !== 'string') return { available: false, reason: 'no source picture URL' }
  const filename = url.startsWith('/generated/') ? localGenerated(url)
    : path.resolve('public/generated', `narration-picture-${hash(url)}.mp4`)
  const result = spawnSync(path.resolve('.venv-quality/bin/python'),
    [path.resolve('scripts/transcribe-quality.py'), filename],
    { encoding: 'utf8', timeout: 180_000, maxBuffer: 4 * 1024 * 1024 })
  if (result.status !== 0) return { available: false, filename,
    reason: result.stderr?.trim().slice(-1000) || result.error?.message || `exit ${result.status}` }
  const evidence = JSON.parse(result.stdout)
  return { available: true, filename, segments: cleanSegments(evidence.segments) }
}

await db.connect()
let row
try {
  await db.query('BEGIN READ ONLY')
  row = (await db.query('SELECT id, workflow_id, created_at, md5(result::text) AS result_md5, result FROM execution_records WHERE id=$1', [options.record])).rows[0]
  await db.query('COMMIT')
} catch (error) {
  await db.query('ROLLBACK').catch(() => undefined)
  throw error
} finally { await db.end() }
if (!row) throw Error(`Record not found: ${options.record}`)

const state = decodeExecutionState(row.result)
const runs = state.nodeRuns ?? []
const shots = []
for (const loopIndex of [0, 1]) {
  const script = run(runs, 'sanguo-shot-script', loopIndex)
  const video = run(runs, 'sanguo-video', loopIndex)
  const request = run(runs, 'sanguo-media-request', loopIndex)
  const evidence = run(runs, 'sanguo-video-evidence', loopIndex)
  const review = run(runs, 'sanguo-media-review', loopIndex)
  const accepted = run(runs, 'sanguo-media-accept', loopIndex)
  const firstFrame = run(runs, 'sanguo-first-frame-branch', loopIndex)
  const lastFrame = run(runs, 'sanguo-last-frame', loopIndex)
  const shot = script?.output ?? {}
  const clip = accepted?.output ?? evidence?.output ?? {}
  const narration = video?.output?.narration
  const transcript = cleanSegments(clip.transcript)
  const media = clip.url ? await fileEvidence(clip.url, clip.sha256) : { exists: false }
  const sourcePicture = narration?.pictureUrl
    ? await pictureEvidence(narration.pictureUrl, narration.pictureVoiceIsolation?.sourceSha256) : null
  const transfer = narrationTransfer(evidence?.output?.independentNarrationTransfer,
    evidence?.output, media, shot)
  const paidGate = video?.output?.params?.sceneCutFrameGate
  const outputOpening = evidence?.output?.sceneCutOutputFirstFrame
  shots.push({
    loopIndex, scriptStatus: script?.status ?? 'missing', videoStatus: video?.status ?? 'missing',
    evidenceStatus: evidence?.status ?? 'missing', acceptStatus: accepted?.status ?? 'missing',
    lastFrameStatus: lastFrame?.status ?? 'missing',
    shotId: shot.id, title: shot.title, durationPlanned: shot.duration,
    completionCriteria: shot.completionCriteria ?? [],
    requiredBeats: (shot.pacing?.beats ?? []).filter(beat => beat.completion?.requiredThisClip).map(beat => ({
      id: beat.id, kind: beat.kind, text: beat.textOrVocalization,
      expectedEnd: shot.pacing?.schedule?.find(item => item.beatId === beat.id)?.endSecond,
      finalState: beat.completion?.finalState,
    })),
    continuity: shot.continuity ?? null, firstFrameMode: shot.firstFrameMode,
    previousLastFrame: safeMediaUrl(firstFrame?.output?.previousLastFrame),
    shouldReusePreviousTail: firstFrame?.output?.shouldReusePreviousTail ?? false,
    requestPreviousTail: safeMediaUrl(request?.output?.previousTail),
    media, decodedInRecord: clip.decoded === true, durationActual: clip.duration,
    firstFrameUrl: safeMediaUrl(clip.frames?.[0]),
    lastFrameUrl: safeMediaUrl(lastFrame?.output?.url ?? clip.lastFrameUrl),
    transcript, latestTranscriptEnd: transcript.length ? Math.max(...transcript.map(item => item.end)) : null,
    nativeEvidence: clip.nativeSequence ? {
      version: clip.nativeSequence.version,
      totalNativeFrames: clip.nativeSequence.totalNativeFrames,
      selectedFrameCount: clip.frameReferences?.length ?? null,
      windows: (clip.nativeSequence.windows ?? []).map(window => ({
        start: window.start, end: window.end, complete: window.complete,
        selectedFrameCount: window.evidenceFrameIndices?.length ?? null,
      })),
    } : null,
    reviewDecision: review?.output?.decision ?? null,
    reviewWarnings: (review?.output?.warnings ?? []).map(item => item.code),
    acceptedByWorkflow: accepted?.output?.passed === true,
    sceneCutOpening: paidGate || outputOpening ? {
      approvalPresent: paidGate?.version === 'scene-cut-frame-gate-v1' && paidGate?.passed === true,
      approvedCandidateUrl: safeMediaUrl(paidGate?.frame?.sourceUrl),
      acceptedSourceRecordId: video?.output?.params?.sceneCutSources?.sourceContext?.acceptedRecordBinding?.recordId ?? null,
      approvedOutlineSha256: paidGate?.outlineBinding?.outlineSha256 ?? null,
      approvedSceneIndex: paidGate?.outlineBinding?.sceneIndex ?? null,
      approvedEllipsis: paidGate?.approvedEllipsis ? {
        previousSceneId: paidGate.approvedEllipsis.previousSceneId,
        currentSceneId: paidGate.approvedEllipsis.currentSceneId,
        priorVideoSha256: paidGate.approvedEllipsis.priorVideoSha256,
        priorTailUrl: safeMediaUrl(paidGate.approvedEllipsis.priorTailUrl),
        priorTailSha256: paidGate.approvedEllipsis.priorTailSha256,
        signedTailHashMatches: paidGate.sourceSha256s?.at(-1) === paidGate.approvedEllipsis.priorTailSha256,
      } : null,
      paidReferenceMatchesApproval: video?.output?.params?.referenceImage === paidGate?.frame?.sourceUrl,
      decodedOpeningStatus: outputOpening?.status ?? null,
      decodedOpeningVideoMatchesEvidence: outputOpening?.outputVideoSha256 === evidence?.output?.sha256,
      decodedOpeningEvidenceMatches: outputOpening?.evidenceUrl === evidence?.output?.evidenceUrl,
      decodedOpeningFrameMatches: outputOpening?.decodedFirstFrameUrl === evidence?.output?.frames?.[0],
      candidateHashMatchesApproval: outputOpening?.candidateSha256 === paidGate?.sourceSha256s?.[0],
      measuredPixelDifference: outputOpening?.difference ?? null,
      maximumPixelDifference: outputOpening?.maximumDifference ?? null,
    } : null,
    manualDecisionRequired: accepted?.output?.manualDecisionRequired === true,
    durationCompletion: accepted?.output?.durationCompletion ? {
      assessment: accepted.output.durationCompletion.assessment,
      passed: accepted.output.durationCompletion.passed,
      actualCompletionInterval: accepted.output.durationCompletion.actualCompletionInterval,
      remainingMandatoryBeats: accepted.output.durationCompletion.remainingMandatoryBeats,
      reasons: accepted.output.durationCompletion.reasons,
      checks: (accepted.output.durationCompletion.checks ?? []).map(check => ({
        beatId: check.beatId, sourceBeatId: check.sourceBeatId, status: check.status,
        observedStart: check.observedStart, observedEnd: check.observedEnd, reasons: check.reasons,
      })),
      allMandatoryBeatsComplete: mandatoryChecksComplete(shot, accepted.output.durationCompletion),
    } : null,
    audioSource: clip.audioSource?.kind ?? null,
    independentNarrationTransfer: transfer,
    narration: narration ? {
      route: narration.route, audioRole: narration.audioRole,
      environmentalTrack: narration.environmentalTrack,
      pictureVoiceIsolation: narration.pictureVoiceIsolation ? {
        version: narration.pictureVoiceIsolation.version,
        status: narration.pictureVoiceIsolation.status,
        detector: narration.pictureVoiceIsolation.detector,
        sourceSha256: narration.pictureVoiceIsolation.sourceSha256,
        mutedWindows: (narration.pictureVoiceIsolation.mutedWindows ?? []).map(window => ({
          start: window.start, end: window.end,
        })),
        ...muteCoverage(narration.pictureVoiceIsolation, shot.duration),
      } : null,
      sourcePicture,
      transferPictureHashMatchesSource: transfer?.pictureSha256
        ? transfer.pictureSha256 === narration.pictureVoiceIsolation?.sourceSha256
          && sourcePicture?.hashMatches === true : null,
      pictureUrlKind: narration.pictureUrl?.startsWith('/generated/') ? 'local' : 'remote',
      tracks: (narration.tracks ?? []).map(track => ({ beatId: track.beatId, start: track.start,
        end: track.end, text: track.text, duration: track.duration, url: safeMediaUrl(track.url) })),
    } : null,
    ...(options.decode && media.exists ? { freshDecode: decodeVideo(media.url) } : {}),
  })
}

const concat = run(runs, 'sanguo-video-concat', 1)?.output
const concatMedia = concat?.url ? await fileEvidence(concat.url) : { exists: false }
const concatDecode = options.decode && concatMedia.exists ? decodeVideo(concatMedia.url) : null
const boundary = {
  firstTailUrl: shots[0].lastFrameUrl, secondFirstUrl: shots[1].firstFrameUrl,
  firstFrameDifference: await imageDifference(shots[0].lastFrameUrl, shots[1].firstFrameUrl),
  secondPreviousTailWasAvailable: Boolean(shots[1].previousLastFrame),
  secondRequestedTailCheck: Boolean(shots[1].requestPreviousTail),
}
const sourceSpeech = options.transcribeSource && shots[0].narration
  ? transcribeSource(run(runs, 'sanguo-video', 0)?.output?.narration?.pictureUrl)
  : null
const sourceSpeechNarrationOverlaps = sourceSpeech?.available
  ? sourceSpeech.segments.flatMap(segment => (shots[0].narration?.tracks ?? []).map(track => {
    const overlapStart = Math.max(segment.start, track.start)
    const overlapEnd = Math.min(segment.end, track.end)
    return { sourceSpeech: segment, narrationBeatId: track.beatId,
      overlapSeconds: overlapSeconds(segment, track),
      coveredByPictureMute: (shots[0].narration?.pictureVoiceIsolation?.mutedWindows ?? []).some(window =>
        window.start <= overlapStart && window.end >= overlapEnd),
    }
  }).filter(item => item.overlapSeconds > 0)) : []
const concatClipUrls = (concat?.clips ?? []).map(item => safeMediaUrl(item.url))
const concatReferencesMatchShots = concatClipUrls.length === 2
  && concatClipUrls.every((url, index) => url === shots[index].media.url)
const report = {
  recordId: row.id, workflowId: row.workflow_id, createdAt: row.created_at,
  originalResultMd5: row.result_md5, auditMode: 'read-only', shots, boundary,
  concat: { count: concat?.count ?? 0, clips: concatClipUrls, referencesMatchShots: concatReferencesMatchShots,
    media: concatMedia, ...(concatDecode ? { freshDecode: concatDecode } : {}) },
  ...(sourceSpeech ? { sourceSpeech, sourceSpeechNarrationOverlaps } : {}),
  interpretation: {
    technicalTwoClipEvidence: shots.every(shot => shot.acceptStatus === 'success'
      && shot.media.exists && shot.media.hashMatches && shot.decodedInRecord && shot.durationActual > 0)
      && shots[0].media.sha256 !== shots[1].media.sha256
      && concat?.count === 2 && concatMedia.exists && concatReferencesMatchShots,
    durationGatesComplete: shots.every(shot => shot.durationCompletion?.allMandatoryBeatsComplete === true),
    sceneCutOutputFirstFramesMatched: shots.every(shot => shot.sceneCutOpening?.approvalPresent === true
      && shot.sceneCutOpening.paidReferenceMatchesApproval === true
      && shot.sceneCutOpening.decodedOpeningStatus === 'matched'
      && shot.sceneCutOpening.decodedOpeningVideoMatchesEvidence === true
      && shot.sceneCutOpening.decodedOpeningEvidenceMatches === true
      && shot.sceneCutOpening.decodedOpeningFrameMatches === true
      && shot.sceneCutOpening.candidateHashMatchesApproval === true),
    independentNarrationTransfersBound: shots.map(shot => shot.narration?.audioRole === 'narration'
      ? shot.independentNarrationTransfer?.status === 'confirmed'
        && shot.independentNarrationTransfer.boundToCurrentEvidence
        && shot.independentNarrationTransfer.sourceSpeechIsolation?.boundToTransfer === true
        && shot.independentNarrationTransfer.allRequiredNarrationLinesConfirmed
        && shot.narration.transferPictureHashMatchesSource === true : null),
    sourcePictureSpeechMuteCoverage: shots.map(shot => shot.narration?.pictureVoiceIsolation
      ? { detectorAvailable: shot.narration.pictureVoiceIsolation.detectorAvailable,
        allObservedSourceSpeechMuted: shot.narration.pictureVoiceIsolation.allObservedSourceSpeechMuted,
        sourceHashMatches: shot.narration.sourcePicture?.hashMatches === true } : null),
    freshDecodeAllMediaPassed: options.decode ? shots.every(shot => shot.freshDecode?.passed === true)
      && concatDecode?.passed === true : null,
    mixedSourceSpeechOverNarration: sourceSpeech?.available
      ? sourceSpeechNarrationOverlaps.some(item => !item.coveredByPictureMute) : null,
    visualActionCompletionNeedsReview: true,
    sceneCutAcceptabilityNeedsReview: true,
    voiceIdentityAndLipSyncNeedReview: true,
  },
}
console.log(JSON.stringify(report, null, 2))
