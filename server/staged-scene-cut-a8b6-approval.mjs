/** A source-bound 14 second timing proposal for the already paid A8+B6 picture.
 * This only builds a candidate. A new storyboard review, storyboard acceptance,
 * opening plan, image review and frame certificate must be produced separately. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import pg from 'pg'
import { compileDurationSchedule, verifyDurationSchedule } from '../src/duration-schedule.ts'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { extractTextResponse, parseStructuredJson } from '../src/workflow-core.ts'
import { sceneCutShotSha256, verifySceneCutFrameApproval } from './scene-cut-frame-approval.ts'
import { sceneCutRebindSha256 } from './scene-cut-approval-rebind.ts'
import { assertSceneCutReviewLedgerRecord } from './scene-cut-frame-runtime.ts'
import { assertA8B6ConflictReviewHop, verifyA8B6FrameConflictReceipt,
  verifyA8B6FrameConflictReceiptSync } from './staged-scene-cut-a8b6-frame-conflict.mjs'

const SHA = /^[a-f0-9]{64}$/
const SOURCE_ID = 'record-4x5m31-original-repair-tail-guide-v2'
const SOURCE_MD5 = '34abee4a7c010616b837dbc175b69c56'
const TIMING_ID = 'record-4x5m31-a8b6-timing-approval-v3'
const REJECTED_FRAME_ID = 'record-4x5m31-a8b6-frame-reuse-v3'
const REJECTED_FRAME_MD5 = '01146ea0d4a7c0d6664f65d5eb9bc54e'
const FRAME_ID = 'record-4x5m31-a8b6-frame-conflict-review-v1'
const NODES_MD5 = '3ed9cf16e56b311458f4c6fa7e7f1e2e'
const EDGES_MD5 = '1d0a75acb3d4778a122a4cfd96a23b49'
const ORIGINAL_SHOT_SHA = 'cd192f86b554192ef9be23a3f34cb8e643fd6e1aa11144a7e5aa675c832947d7'
const AUDIO_TEXT = '刘备入益州后，转攻刘璋。\n旁白：他的部将张飞攻破江州，生擒刘璋的巴郡太守严颜。\n旁白：城破了，他会低头吗？'
const OLD_TRACK_WINDOWS = [[0, 2.5], [2.5, 7.1], [9.5, 11.75]]
const fail = reason => { throw Error(`STAGED_A8B6_APPROVAL_INVALID: ${reason}`) }
const sha = value => createHash('sha256').update(value).digest('hex')
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`
    : JSON.stringify(value ?? null)
const same = (a, b) => canonical(a) === canonical(b)

/** The approved picture first releases the guards at A f192/8.0 seconds;
 * B withdraws them before Zhang moves at B f30/9.25 seconds. Original TTS
 * stays at 0, 2.5 and 9.5 seconds. The changed narrative overlap is exposed
 * for a new creative review, never silently attributed to the old approval. */
export function buildA8B6TimingAmendment(approvedShot, approvedScene) {
  const old = approvedShot
  const beats = old?.pacing?.beats
  if (sceneCutShotSha256(old) !== ORIGINAL_SHOT_SHA
    || old?.id !== 'scene-01' || old.duration !== 13
    || old.audioType !== '旁白' || old.audioText !== AUDIO_TEXT
    || old.pacing?.version !== 'duration-v2'
    || approvedScene?.targetDuration !== 14
    || !Array.isArray(beats)
    || !same(beats.map(beat => beat.id), [
      'b01-close', 'b01-narration-1', 'b01-bind',
      'b01-narration-2', 'b01-approach', 'b01-narration-3']))
    fail('original approved shot, source scene or source obligations changed')
  verifyDurationSchedule(old, { scene: approvedScene,
    timingPolicy: old.pacing.timingPolicy })
  if (!same(old.pacing.speechWindows?.map(track => [track.start, track.end]),
    OLD_TRACK_WINDOWS)) fail('original three narration windows changed')
  const suffixMarker = '【声部与收束】'
  const suffixIndex = old.videoPrompt?.indexOf(suffixMarker) ?? -1
  if (suffixIndex < 0 || old.videoPrompt.slice(0, suffixIndex).trim()
    !== old.pacing.compiledVideoPrompt) fail('old compiled timeline changed')

  const candidate = structuredClone(old)
  for (const key of ['raw', 'text', 'issues', 'passed', 'executionLogs',
    'qualityPolicy', 'qualityReview', 'repairContext', 'qualityWarnings',
    'repairProvenance', 'scriptValidation', 'qualityDisposition',
    'manualDecisionRequired']) delete candidate[key]
  const oldActionWindow = '动作执行：0–2.5秒，张飞抬手示意军士合拢，封住严颜身前的缺口；2.5–7.5秒，军士将严颜双腕缚住，双腕及绕绳结绳过程无遮挡；7.5–9.5秒，张飞走到严颜面前，停在不遮挡双腕的位置；9.5–13秒，在场人物保留自然呼吸，旁白提出问题，无人开口回答。'
  const newActionWindow = '动作执行：0–2.5秒，张飞抬手示意军士合拢，封住严颜身前的缺口；2.5–8秒，军士将严颜双腕缚住，双腕及绕绳结绳过程无遮挡；8–9.25秒，军士双手从绳结撤开并恢复看押，严颜双腕仍在身前被缚；9.25–13秒，张飞走到严颜面前，停在不遮挡双腕的位置，9.5–11.75秒画外旁白与无台词走近并行，画内人物不配旁白口型；13–14秒，张飞站稳与严颜相对，保留自然呼吸微动，无人开口回答。'
  if (typeof old.visualPrompt !== 'string'
    || old.visualPrompt.split(oldActionWindow).length !== 2)
    fail('original visual prompt action window changed')
  candidate.visualPrompt = old.visualPrompt.replace(oldActionWindow, newActionWindow)
  candidate.duration = 14
  delete candidate.scheduleHash
  delete candidate.pacing.scheduleHash
  const selected = candidate.pacing.beats
  const bind = selected.find(beat => beat.id === 'b01-bind')
  const approach = selected.find(beat => beat.id === 'b01-approach')
  const finalNarration = selected.find(beat => beat.id === 'b01-narration-3')
  bind.durationEstimate = { ...bind.durationEstimate,
    lower: 6.5, expected: 6.75, upper: 6.75,
    source: '原生 A f192/8.0 秒首次脱手；至 B f30/全局9.25秒军士撤回看押位。',
    confidence: 'medium' }
  bind.textOrVocalization = '军士将严颜双腕缚住。2.5–8秒，近身军士控制严颜前臂，在身前并腕、绕绳、收紧并完成绳结，缠绕至结成持续可见；8–9.25秒，军士双手撤离绳结，在严颜两侧恢复看押姿态，严颜仍站立，双腕在身前缚妥且绳结可见。'
  bind.completion = { ...bind.completion,
    finalState: '严颜双腕在身前缚妥，军士双手已撤离腕部绳结并恢复两侧看押姿态。',
    evidenceAnchor: '2.5–8秒并腕绕绳结成；8–9.25秒军士撤手恢复看押，缚妥双腕与绳结仍可见' }
  approach.dependsOn = ['b01-bind', 'b01-narration-2']
  approach.overlapAllowedWith = ['b01-narration-3']
  approach.durationEstimate = { ...approach.durationEstimate,
    lower: 3.2, expected: 3.5, upper: 3.75,
    source: '原生 B 约 f30 起步，约 f120 停稳；包含走近与停步。',
    confidence: 'medium' }
  finalNarration.dependsOn = ['b01-bind']
  finalNarration.overlapAllowedWith = ['b01-approach']
  finalNarration.timingConstraint = { mode: 'hard',
    notBeforeSecond: 9.5, deadlineSecond: 11.75 }
  finalNarration.performanceInstruction = '画外旁白在张飞走近严颜期间提出问题，逗号处短停，问句轻收。画内人物不随旁白开口；张飞停稳后下一镜才开始问责。'
  const compiled = compileDurationSchedule(candidate, { scene: approvedScene,
    timingPolicy: old.pacing.timingPolicy })
  candidate.duration = compiled.duration
  candidate.pacing = compiled.pacing
  candidate.scheduleHash = compiled.scheduleHash
  candidate.videoPrompt = compiled.videoPrompt + '\n' + old.videoPrompt.slice(suffixIndex)
  candidate.timingEstimate = compiled.timingEstimate
  verifyDurationSchedule(candidate, { scene: approvedScene,
    timingPolicy: old.pacing.timingPolicy })
  if (candidate.duration !== 14 || !same(candidate.pacing.speechWindows
    .map(track => [track.start, track.end]), OLD_TRACK_WINDOWS)
    || !same(candidate.pacing.schedule.map(row => [row.beatId, row.startSecond, row.endSecond]), [
      ['b01-close', 0, 2.5], ['b01-narration-1', 0, 2.5],
      ['b01-bind', 2.5, 9.25], ['b01-narration-2', 2.5, 7.1],
      ['b01-approach', 9.25, 13],
      ['b01-narration-3', 9.5, 11.75]]))
    fail('candidate deviates from A8+B6 native action windows or original TTS')
  if (candidate.audioText !== old.audioText
    || candidate.lastFramePrompt !== old.lastFramePrompt
    || !same(candidate.characterVisuals, old.characterVisuals)
    || !same(candidate.initialCharacters, old.initialCharacters)
    || !same(candidate.endCharacters, old.endCharacters))
    fail('candidate changed approved wording, identities or end state')
  return { version: 'scene-cut-a8b6-timing-proposal-v1',
    sourceExecutionId: SOURCE_ID, sourceResultMd5: SOURCE_MD5,
    originalShotSha256: ORIGINAL_SHOT_SHA,
    candidateShotSha256: sceneCutShotSha256(candidate),
    amendedScheduleHash: compiled.scheduleHash,
    amendedShot: candidate,
    approvalState: 'requires-new-storyboard-and-frame-review' }
}

/** Signature and asset checks for a separately approved workflow branch.
 * Until its real model reviews and new frame certificate exist, this refuses
 * to return an approval. The A8+B6 composite verifier calls this interface. */
export function verifyA8B6WorkflowApprovalSync(qaPlanId, root = process.cwd()) {
  if (!SHA.test(String(qaPlanId))) fail('QA plan ID invalid')
  const directory = path.join(root, '.runtime/staged-scene-cut-a8b6-approval', qaPlanId)
  const bytes = readFileSync(path.join(directory, 'approval.json'))
  const approval = JSON.parse(bytes.toString('utf8'))
  const key = readFileSync(path.join(root, '.runtime/staged-scene-cut.key'))
  if (key.length !== 32) fail('approval signing key invalid')
  const { signature, ...body } = approval
  const expected = createHmac('sha256', key).update(canonical(body)).digest('hex')
  if (!SHA.test(String(signature))
    || !timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex')))
    fail('workflow approval signature invalid')
  const manifest = JSON.parse(readFileSync(path.join(root,
    '.runtime/staged-scene-cut-a8b6-qa', qaPlanId, 'manifest.json'), 'utf8'))
  const manifestBytes = readFileSync(path.join(root,
    '.runtime/staged-scene-cut-a8b6-qa', qaPlanId, 'manifest.json'))
  const wholeReviewBytes = readFileSync(path.join(root,
    '.runtime/staged-scene-cut-a8b6-qa', qaPlanId, 'whole-shot-review.json'))
  const conflict = verifyA8B6FrameConflictReceiptSync(qaPlanId, root)
  const { signature: manifestSignature, ...manifestBody } = manifest
  const expectedManifestSignature = createHmac('sha256', key)
    .update(canonical(manifestBody)).digest('hex')
  if (!SHA.test(String(manifestSignature))
    || !timingSafeEqual(Buffer.from(manifestSignature, 'hex'),
      Buffer.from(expectedManifestSignature, 'hex')))
    fail('QA source signature invalid')
  const certificate = approval.frameCertificate
  verifySceneCutFrameApproval(certificate, root)
  if (approval.version !== 'scene-cut-a8b6-workflow-approval-v1'
    || approval.qaPlanId !== qaPlanId
    || approval.sourceExecutionId !== SOURCE_ID
    || approval.sourceResultMd5 !== SOURCE_MD5
    || approval.originalShotSha256 !== ORIGINAL_SHOT_SHA
    || approval.originalShotSha256 !== manifest.source?.approvedShotSha256
    || approval.approvalState !== 'approved-in-new-schema180-branch'
    || approval.workflowSchemaVersion !== 180
    || approval.workflowNodesMd5 !== NODES_MD5
    || approval.workflowEdgesMd5 !== EDGES_MD5
    || approval.timingExecutionId !== TIMING_ID
    || approval.approvalExecutionId !== FRAME_ID
    || approval.reviewRetrySourceExecutionId !== REJECTED_FRAME_ID
    || approval.reviewRetrySourceResultMd5 !== REJECTED_FRAME_MD5
    || approval.conflictAdjudicationReceiptSha256 !== conflict.receiptSha256
    || !SHA.test(String(approval.conflictReviewMarkerSha256))
    || !/^[a-f0-9]{32}$/.test(String(approval.approvalResultMd5))
    || !/^[a-f0-9]{32}$/.test(String(approval.timingResultMd5))
    || approval.qaManifestSha256 !== sha(manifestBytes)
    || approval.wholeShotReviewSha256 !== sha(wholeReviewBytes)
    || !SHA.test(String(approval.imageReuseMarkerSha256))
    || !/^model-run-[\w-]+$/.test(String(approval.storyboardReviewExecutionId))
    || !/^model-run-[\w-]+$/.test(String(approval.frameReviewExecutionId))
    || !SHA.test(String(approval.amendedShotSha256))
    || approval.amendedShotSha256 !== sceneCutShotSha256(approval.amendedShot)
    || approval.amendedShot?.duration !== 14
    || approval.amendedShot?.pacing?.scheduleHash !== approval.amendedScheduleHash
    || approval.amendedShot?.scheduleHash !== approval.amendedScheduleHash
    || approval.amendedShot?.audioText !== AUDIO_TEXT
    || approval.amendedShot?.passed !== true
    || approval.amendedShot?.manualDecisionRequired !== false
    || !same(approval.amendedShot?.issues, [])
    || !same(approval.amendedShot?.qualityReview?.warnings?.map(w => w.code),
      ['manual_review_required'])
    || !same(approval.amendedShot?.pacing?.speechWindows?.map(track => [track.start, track.end]),
      OLD_TRACK_WINDOWS)
    || certificate.shotSha256 !== approval.amendedShotSha256
    || certificate.reviewExecutionId !== approval.frameReviewExecutionId
    || certificate.repairBinding !== undefined
    || approval.sceneCutFrameCertificateSha256 !== sha(canonical(certificate))
    || approval.sceneCutFrameApprovalSignature !== certificate.signature)
    fail('workflow approval is not bound to the independently reviewed 14 second shot and frame')
  return { approval, approvalSha256: sha(bytes) }
}

/** Re-read the actual schema180 record and both independent model ledgers.
 * The local signature alone cannot assert that its embedded approval ran. */
export async function verifyA8B6WorkflowApproval(qaPlanId, root = process.cwd()) {
  const verified = verifyA8B6WorkflowApprovalSync(qaPlanId, root)
  const { approval } = verified
  const signedConflict = await verifyA8B6FrameConflictReceipt(qaPlanId, root)
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL
    ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await db.connect()
  try {
    await db.query('BEGIN READ ONLY')
    const getRecord = async id => (await db.query(`SELECT id,workflow_id,result,
      md5(result::text) AS result_md5 FROM execution_records WHERE id=$1`, [id])).rows[0]
    const source = await getRecord(SOURCE_ID)
    const timing = await getRecord(TIMING_ID)
    const rejected = await getRecord(REJECTED_FRAME_ID)
    const current = await getRecord(FRAME_ID)
    const graph = (await db.query(`SELECT schema_version,md5(nodes::text) AS nodes_md5,
      md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1`,
    ['wf-sanguo-history-drama'])).rows[0]
    if (source?.result_md5 !== SOURCE_MD5
      || timing?.result_md5 !== approval.timingResultMd5
      || rejected?.result_md5 !== REJECTED_FRAME_MD5
      || current?.result_md5 !== approval.approvalResultMd5
      || current?.workflow_id !== 'wf-sanguo-history-drama'
      || graph?.schema_version !== 180 || graph.nodes_md5 !== NODES_MD5
      || graph.edges_md5 !== EDGES_MD5)
      fail('actual workflow rows or schema180 graph differ from signed approval')
    const sourceState = decodeExecutionState(source.result)
    const timingState = decodeExecutionState(timing.result)
    const rejectedState = decodeExecutionState(rejected.result)
    const state = decodeExecutionState(current.result)
    const runs = state.nodeRuns, parentRuns = timingState.nodeRuns
    const reuse = state.sceneCutA8B6ImageReuseRecovery
    const oldCert = verifySceneCutFrameApproval(sourceState.nodeRuns?.[50]?.output, root)
    assertA8B6ConflictReviewHop(rejectedState, state,
      rejected.result_md5, signedConflict, 'completed')
    if (state.id !== FRAME_ID || state.parentExecutionId !== REJECTED_FRAME_ID
      || timingState.id !== TIMING_ID || timingState.parentExecutionId !== SOURCE_ID
      || rejectedState.parentExecutionId !== TIMING_ID
      || timingState.sceneCutA8B6TimingRecovery?.qaPlanId !== qaPlanId
      || reuse?.version !== 'scene-cut-a8b6-image-reuse-v1'
      || reuse.sourceExecutionId !== SOURCE_ID || reuse.sourceResultMd5 !== SOURCE_MD5
      || reuse.parentExecutionId !== TIMING_ID
      || reuse.parentResultMd5 !== timing.result_md5
      || approval.reviewRetrySourceExecutionId !== REJECTED_FRAME_ID
      || approval.reviewRetrySourceResultMd5 !== rejected.result_md5
      || approval.conflictAdjudicationReceiptSha256 !== signedConflict.receiptSha256
      || approval.conflictReviewMarkerSha256 !== sceneCutRebindSha256(
        state.sceneCutA8B6ConflictReviewRecovery)
      || reuse.qaPlanId !== qaPlanId
      || reuse.originalFrameCertificateSha256 !== sceneCutRebindSha256(oldCert)
      || reuse.originalImageSha256 !== oldCert.sourceSha256s?.[0]
      || approval.imageReuseMarkerSha256 !== sceneCutRebindSha256(reuse)
      || !isDeepStrictEqual(runs.slice(0, 45), parentRuns.slice(0, 45))
      || !isDeepStrictEqual(runs.slice(0, 49), rejectedState.nodeRuns.slice(0, 49))
      || runs?.[9]?.status !== 'success' || runs?.[10]?.status !== 'success'
      || runs?.[11]?.status !== 'success' || runs?.[43]?.status !== 'success'
      || runs?.[45]?.status !== 'success' || runs?.[48]?.status !== 'success'
      || runs?.[49]?.status !== 'success' || runs?.[50]?.status !== 'success'
      || runs[10].output?.decision !== 'pass'
      || !isDeepStrictEqual(runs[10].output?.issues, [])
      || !isDeepStrictEqual(runs[10].output?.warnings, [])
      || runs[11].output?.passed !== true
      || runs[11].output?.manualDecisionRequired !== false
      || !isDeepStrictEqual(runs[11].output?.issues, [])
      || !isDeepStrictEqual(runs[11].output?.qualityReview?.warnings?.map(w => w.code),
        ['manual_review_required'])
      || !isDeepStrictEqual(runs[11].output, approval.amendedShot)
      || sceneCutShotSha256(runs[11].output) !== approval.amendedShotSha256
      || runs[43].output?.shotSha256 !== approval.amendedShotSha256
      || runs[49].output?.passed !== true
      || !isDeepStrictEqual(runs[49].output?.issues, [])
      || !isDeepStrictEqual(runs[50].output, approval.frameCertificate)
      || !isDeepStrictEqual(runs[45].output?.sourceBoundImageReuse,
        { ...reuse, reviewShotSha256: reuse.amendedShotSha256 }))
      fail('real branch lacks the newly reviewed script, reused image or frame certificate')
    const script = (await db.query(`SELECT * FROM model_execution_records WHERE id=$1`,
      [approval.storyboardReviewExecutionId])).rows[0]
    const scriptRequest = script?.request_data
    const scriptReview = runs[10].output
    const parsed = script && parseStructuredJson(extractTextResponse(script.response_data))
    const submitted = Object.fromEntries(Object.entries(scriptReview ?? {})
      .filter(([key]) => !['text', 'raw', 'model', 'reviewTransport'].includes(key)))
    if (script?.status !== 'succeeded' || script.provider === 'Local'
      || script.workflow_id !== 'wf-sanguo-history-drama'
      || script.node_id !== 'sanguo-shot-script-review'
      || script.capability !== 'text'
      || script.model_id !== scriptReview?.model
      || !new RegExp(`^${TIMING_ID}:attempt-[1-9]\\d*:revision-\\d+:sanguo-shot-script-review:0:scene-01:principle-review-1$`)
        .test(String(scriptRequest?.requestKey))
      || !SHA.test(String(scriptRequest?.fingerprint))
      || !isDeepStrictEqual(scriptRequest?.params?.candidate, runs[9].output)
      || !isDeepStrictEqual(script.response_data, scriptReview?.raw)
      || !isDeepStrictEqual(parsed, submitted))
      fail('storyboard decision does not match its actual successful model ledger')
    const frame = (await db.query(`SELECT * FROM model_execution_records WHERE id=$1`,
      [approval.frameReviewExecutionId])).rows[0]
    const frameId = assertSceneCutReviewLedgerRecord(frame, runs[49].output, {
      evidence: runs[48].output, shot: runs[11].output,
      sources: runs[41].output, reviewImages: runs[48].output?.reviewImages,
      openingStatePlan: runs[43].output,
    }, root, 180)
    if (frameId !== approval.frameReviewExecutionId
      || !String(frame.request_data?.requestKey).startsWith(`${FRAME_ID}:`))
      fail('frame conclusion does not match its actual current-branch model ledger')
    await db.query('COMMIT')
    return verified
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { await db.end() }
}
