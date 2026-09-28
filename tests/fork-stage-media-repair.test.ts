import test from 'node:test'
import assert from 'node:assert/strict'
import { encodeExecutionState, decodeExecutionState } from '../src/execution-storage.ts'
import { prepareStageMediaRepair, forkStageMediaRepair, parseArguments } from '../scripts/fork-stage-media-repair.mjs'
import { createJsonHasher } from '../scripts/restore-branch-checkpoint.mjs'

const json = value => JSON.parse(JSON.stringify(value))
const options = { sourceId: 'source', id: 'media-repair-copy', createdAt: '2026-09-26T10:00:00.000Z' }
const md5 = '0123456789abcdef0123456789abcdef'
function fixture() {
  const nodeRuns = [], saved = [], stages = []
  let current = {}, previous
  const makeMedia = (index, suffix = '') => {
    const shot = { id: `shot-${index}`, dramaticSceneId: `scene-${index}`, audioType: '对白', audioText: `张角${suffix ? '' : '（画外）'}：请饮符水。`, scheduleHash: `schedule-${index}${suffix}`, firstFrameMode: index ? 'reuse_previous_tail' : 'reference' }
    const params = { scheduleHash: shot.scheduleHash, audioText: shot.audioText, providerReceipt: `paid-${index}${suffix}` }
    const take = { url: `https://example.com/original-${index}${suffix}.mp4`, params, providerReceipt: params.providerReceipt }
    const evidence = { originalUrl: take.url, url: `/generated/clip-${index}${suffix}.mp4`, evidenceUrl: `/generated/evidence-${index}${suffix}.json`,
      decoded: true, width: 1280, height: 720, duration: 4, hasAudio: true, frames: [`/generated/first-${index}${suffix}.jpg`, `/generated/tail-${index}${suffix}.jpg`], lastFrameUrl: `/generated/tail-${index}${suffix}.jpg`,
      evidenceRequest: { url: take.url, scheduleHash: shot.scheduleHash, audioText: shot.audioText } }
    const accepted = { ...evidence, params, passed: true, extractedLastFrameUrl: evidence.lastFrameUrl, qualityPolicy: 'principle-v1', qualityDisposition: 'manual-review-v1',
      technicalValidation: { speechVerified: true }, qualityReview: { canProceed: true, principleIssues: [], warnings: [] }, voiceConsistency: { status: 'uncertain', method: 'manual-review-pending' } }
    return { shot, take, evidence, accepted }
  }
  for (const index of [0, 1, 2]) {
    const media = makeMedia(index); saved.push(media)
    current = { input: { topic: '已确认的原始故事' }, loop: { index: index + 1, previous: previous ? { stage_video: previous } : {} } }
    const add = (resultVar, output, inputs = {}) => {
      const inputContext = current
      current = { ...current, [resultVar]: output }
      const run = { id: `${resultVar}-${index}`, node: { id: resultVar, resultVar, kind: resultVar === 'video_take' ? 'video' : 'code' }, status: 'success', output,
        inputs, inputContext, context: current, loopPrevious: previous ? { stage_video: previous } : {}, loopIndex: index, loopGroupId: 'scene-loop', historical: false,
        attempt: 3, revision: 2, errorAttempt: 1, attempts: [{ status: 'failed', output: { paidReceipt: 'previous-paid-attempt' } }] }
      nodeRuns.push(run); return run
    }
    add('shot_candidate', media.shot)
    add('shot_script_review', { decision: 'pass', reviewedShotId: media.shot.id })
    add('shot_script', media.shot)
    add('video_take', media.take, media.take.params)
    add('media_request', { url: media.take.url, requestId: `request-${index}` })
    add('video_evidence', media.evidence, media.evidence.evidenceRequest)
    add('media_metrics', { url: media.evidence.url, decoded: true })
    add('media_review', { decision: 'pass', videoUrl: media.evidence.url }, { reviewImages: media.evidence.frames })
    add('video_shot', media.accepted)
    const clips = saved.map((entry, clipIndex) => ({ url: entry.accepted.url, sha256: String(clipIndex + 1).repeat(64) }))
    const stage = { url: `/generated/stage-${index}.mp4`, count: clips.length, totalDuration: clips.length * 4, clips, sourceSha256: clips.map(clip => clip.sha256), qualityDisposition: 'manual-review-v1' }
    add('stage_video', stage, { previousVideo: previous ?? null, currentVideo: media.accepted })
    add('last_frame', { url: media.evidence.lastFrameUrl, available: true })
    previous = stage; stages.push(stage)
  }
  nodeRuns.push({ id: 'pending', node: { id: 'pending', kind: 'code' }, status: 'idle', context: current,
    inputs: { replacement: json(saved[1].accepted), merelySimilar: { url: saved[1].accepted.url } },
    retryFeedback: { lastAccepted: saved[1].accepted }, branchCarry: { gate: { currentVideo: saved[1].accepted, state: { visits: 3 } } }, attempts: [] })
  const state = { id: 'source', workflowId: 'workflow', nodeRuns, context: current, mode: 'step', logs: ['原始日志'], requestScopeId: 'paid-scope', generationScopeId: 'original-generation',
    branchHistory: [{ scene: nodeRuns.slice(0, 22) }], loopRerunHistory: [{ context: current }], loopRerun: { context: { accepted: saved[1].accepted } }, runtimeInputs: { topic: '原始确认' } }
  const replacement = makeMedia(1, '-repaired'), ref = value => ({ old: json(value[0]), new: json(value[1]) })
  const repair = { loopIndex: 1, reason: '可见说话人须为同期声', ...Object.fromEntries(['shot', 'take', 'evidence', 'accepted'].map(role => [role, ref([saved[1][role], replacement[role]])])),
    outputs: ['media_request', 'media_metrics'].map(resultVar => {
      const run = nodeRuns.find(run => run.id === `${resultVar}-1`)
      return { runId: run.id, old: json(run.output), new: { ...run.output, url: resultVar === 'media_request' ? replacement.take.url : replacement.evidence.url } }
    }), continuity: {
      incoming: { status: 'verified', videoUrl: replacement.evidence.url, reason: '复核新首帧与上段尾帧', evidenceRefs: ['/audit/incoming.json'] },
      outgoing: { status: 'verified', videoUrl: replacement.evidence.url, reason: '复核新尾帧与已付费下一镜', evidenceRefs: ['/audit/outgoing.json'], dependentRunIds: ['video_take-2'] },
    } }
  const concats = stages.slice(1).map((old, offset) => {
    const clips = old.clips.map((clip, index) => index === 1 ? { ...clip, url: replacement.accepted.url, sha256: 'a'.repeat(64) } : json(clip))
    return { loopIndex: offset + 1, old: json(old), new: { ...json(old), url: old.url.replace('.mp4', '-repaired.mp4'), clips, sourceSha256: clips.map(clip => clip.sha256) } }
  })
  const source = { id: state.id, workflow_id: state.workflowId, workflow_name: '原工作流', runtime_inputs: state.runtimeInputs, result_md5: md5, result: encodeExecutionState(state) }
  return { state, source, manifest: { format: 'stage-media-repair-v1', sourceRecordId: source.id, repairs: [repair], concats }, replacement, saved }
}

test('precomputed repair refreshes producer/context/request/tail snapshots and every concat, archiving original runs once', () => {
  const { state, source, manifest, replacement, saved } = fixture(), sourceBefore = json(source), manifestBefore = json(manifest), hash = createJsonHasher()
  const prepared = prepareStageMediaRepair(source, manifest, options), next = prepared.state
  assert.deepEqual(source, sourceBefore); assert.deepEqual(manifest, manifestBefore)
  assert.equal(next.parentExecutionId, source.id); assert.equal(next.requestScopeId, 'paid-scope'); assert.equal(next.generationScopeId, 'original-generation')
  for (const field of ['branchHistory', 'loopRerunHistory']) assert.equal(hash(next[field]), hash(state[field]))
  for (const [index, run] of next.nodeRuns.entries()) {
    const old = state.nodeRuns[index]
    assert.deepEqual(run.attempts.slice(0, old.attempts.length), old.attempts)
    assert.ok(run.attempts.length <= old.attempts.length + 1)
    for (const field of ['attempt', 'revision', 'errorAttempt', 'status']) assert.equal(run[field], old[field])
  }
  const run = id => next.nodeRuns.find(run => run.id === id)
  assert.deepEqual(run('shot_candidate-1').output, replacement.shot)
  assert.deepEqual(run('video_take-1').inputs, replacement.take.params)
  assert.deepEqual(run('video_evidence-1').inputs, replacement.evidence.evidenceRequest)
  assert.equal(run('media_review-1').output.reviewUnavailable, true)
  assert.equal(run('media_review-1').output.decision, undefined)
  assert.deepEqual(run('media_review-1').inputs.reviewImages, replacement.evidence.frames)
  assert.equal(run('last_frame-1').output.url, replacement.evidence.lastFrameUrl)
  assert.deepEqual(run('video_take-0').output, saved[0].take)
  assert.deepEqual(run('video_take-2').output, saved[2].take)
  assert.deepEqual(run('pending').inputs.replacement, replacement.accepted)
  assert.deepEqual(run('pending').inputs.merelySimilar, { url: saved[1].accepted.url })
  assert.deepEqual(run('pending').branchCarry.gate.currentVideo, replacement.accepted)
  assert.deepEqual(next.loopRerun.context.accepted, replacement.accepted)
  for (const index of [1, 2]) assert.equal(run(`stage_video-${index}`).output.clips[1].url, replacement.accepted.url)
  assert.equal(next.context.stage_video.url, '/generated/stage-2-repaired.mp4')
  assert.equal(hash(decodeExecutionState(json(prepared.encoded))), hash(next))
  for (const field of ['originalChangedRunsArchived', 'priorAttemptsPreserved', 'statusAndCountersPreserved', 'sourceUnchanged', 'roundTripVerified']) assert.equal(prepared.proof[field], true)
  assert.equal(prepared.proof.modelsCalled, 0); assert.equal(prepared.proof.mediaFilesWritten, 0)
})

test('stale old output, missing cumulative concat, changed prefix bytes and unverified paid tail dependencies fail closed', () => {
  for (const [change, expected] of [
    [manifest => { manifest.repairs[0].take.old.providerReceipt = 'wrong-paid-take' }, /old output/],
    [manifest => { manifest.concats.pop() }, /every affected/],
    [manifest => { manifest.concats[0].new.clips[0].sha256 = 'f'.repeat(64); manifest.concats[0].new.sourceSha256[0] = 'f'.repeat(64) }, /unrelated paid clip/],
    [manifest => { manifest.repairs[0].continuity.outgoing.status = 'not-applicable' }, /requires verified continuity/],
    [manifest => { manifest.repairs[0].continuity.outgoing.dependentRunIds = [] }, /name dependent paid run/],
    [manifest => { manifest.repairs[0].outputs = [] }, /fresh supplemental output/],
    [manifest => { manifest.repairs[0].outputs[0].new = manifest.repairs[0].outputs[0].old }, /supplemental replacement is unchanged/],
    [manifest => { manifest.repairs[0].accepted.new.originalUrl = 'different-take' }, /different original videos/],
  ]) {
    const { source, manifest } = fixture(); change(manifest)
    const before = json(source)
    assert.throws(() => prepareStageMediaRepair(source, manifest, options), expected)
    assert.deepEqual(source, before)
  }
})

test('a passed media flag cannot import an active human hold or explicit concat rejection', () => {
  for (const [label, change] of [
    ['top-level manual hold', manifest => { manifest.repairs[0].accepted.new.manualDecisionRequired = true }],
    ['nested manual hold', manifest => { manifest.repairs[0].accepted.new.qualityReview.manualDecisionRequired = true }],
    ['candidate concat refusal', manifest => { manifest.repairs[0].accepted.new.concatAllowed = false }],
    ['nested concat refusal', manifest => { manifest.repairs[0].accepted.new.qualityReview.concatAllowed = false }],
    ['quality gate refusal', manifest => { manifest.repairs[0].accepted.new.qualityReview.canProceed = false }],
    ['quality gate rejection', manifest => { manifest.repairs[0].accepted.new.qualityReview.status = 'rejected' }],
    ['technical rejection', manifest => { manifest.repairs[0].accepted.new.technicalValidation.passed = false }],
    ['repair concat refusal', manifest => { manifest.repairs[0].concatAllowed = false }],
    ['manifest concat refusal', manifest => { manifest.concatAllowed = false }],
  ]) {
    const { source, manifest } = fixture(); change(manifest)
    const sourceBefore = json(source), manifestBefore = json(manifest)
    assert.throws(() => prepareStageMediaRepair(source, manifest, options), /manual hold|media rejection|forbids concat/, label)
    assert.deepEqual(source, sourceBefore, `${label}: source unchanged`)
    assert.deepEqual(manifest, manifestBefore, `${label}: manifest unchanged`)
  }
  const { source, manifest } = fixture()
  const approved = manifest.repairs[0].accepted.new
  approved.manualDecisionRequired = false
  approved.concatAllowed = true
  approved.qualityReview = { ...approved.qualityReview, manualReviewRequired: true, manualDecisionRequired: false,
    status: 'needs_attention', canProceed: true }
  assert.equal(prepareStageMediaRepair(source, manifest, options).proof.replacedConcatCount, 2,
    'manual review alone is not an unresolved hold after the current candidate is approved')
})

test('optional saved-audio reassessment shares one archive pass and feeds unchanged sources into repaired concat reviews', () => {
  const { source, manifest, saved } = fixture()
  manifest.reassessSavedAudio = true
  const prepared = prepareStageMediaRepair(source, manifest, options), runs = prepared.state.nodeRuns
  assert.equal(prepared.proof.audioReassessment.reviewedSegmentCount, 3)
  assert.equal(prepared.proof.audioReassessment.reviewedConcatCount, 3)
  const acceptance = runs.find(run => run.id === 'video_shot-0')
  assert.equal(acceptance.output.url, saved[0].accepted.url)
  assert.equal(acceptance.output.technicalValidation.speechVerified, false)
  assert.equal(runs.find(run => run.id === 'stage_video-2').output.clipReviews[0].technicalValidation.speechVerified, false)
  assert.ok(runs.every(run => run.attempts.length <= (run.id === 'pending' ? 1 : 2)))
  manifest.concats.pop()
  assert.throws(() => prepareStageMediaRepair(source, manifest, options), /every affected/)
})

test('new media and passed=true cannot close an unresolved user-reported speaking-without-audio target', () => {
  const { source, manifest } = fixture(), repair = manifest.repairs[0]
  repair.evidence.new.sha256 = 'a'.repeat(64)
  repair.accepted.new.targetedRepairAssessment = { version: 'targeted-audio-visual-repair-v1', videoUrl: repair.evidence.new.url,
    sha256: 'a'.repeat(64), duration: 4, targets: [{ id: 'reported-mouth', status: 'resolved',
      sourceDefect: { code: 'unvoiced_visible_speech', videoUrl: repair.evidence.old.url, sha256: '2'.repeat(64), actorId: '张角', startSecond: 2, endSecond: 4 },
      userReport: { reference: 'user-message-1', quote: '张角动嘴没有配音' } }] }
  assert.throws(() => prepareStageMediaRepair(source, manifest, options), /unresolved audio-visual repair targets/)
  repair.accepted.new.targetedRepairAssessment.targets[0].status = 'unverified'
  assert.throws(() => prepareStageMediaRepair(source, manifest, options), /unresolved audio-visual repair targets/)
})

test('repair importer preserves reported source defects instead of losing them on URL replacement', () => {
  const { source, manifest } = fixture(), repair = manifest.repairs[0], state = decodeExecutionState(source.result)
  const report = { id: 'user-defect', version: 'audio-visual-event-review-v1', videoUrl: repair.evidence.old.url, sha256: '2'.repeat(64), duration: 4,
    reviewer: { kind: 'user', id: 'user' }, reviewedAt: '2026-09-26T10:00:00Z', method: 'user-report',
    userReport: { reference: 'user-message-1', quote: '张角动嘴没有配音' },
    events: [{ id: 'mouth', code: 'unvoiced_visible_speech', status: 'reported', actorId: '张角', startSecond: 2, endSecond: 4, finding: '用户实播反馈未修复' }] }
  const acceptRun = state.nodeRuns.find(run => run.id === 'video_shot-1'), evidenceRun = state.nodeRuns.find(run => run.id === 'video_evidence-1')
  acceptRun.output = { ...acceptRun.output, audioVisualEventReviews: [report] }
  evidenceRun.output = { ...evidenceRun.output, sha256: '2'.repeat(64) }
  repair.accepted.old = json(acceptRun.output); repair.evidence.old = json(evidenceRun.output)
  source.result = encodeExecutionState(state)
  assert.throws(() => prepareStageMediaRepair(source, manifest, options), /dropped an unresolved user-reported/)
})

test('preview is read-only, explicit apply inserts one new record and failed readback rolls back', async () => {
  for (const apply of [false, true]) {
    const { source, manifest } = fixture(), statements = []
    let inserted
    const client = { async query(sql, params = []) {
      statements.push(sql)
      if (sql.startsWith('SELECT *')) return { rows: [source] }
      if (sql.startsWith('INSERT INTO')) { assert.notEqual(params[0], source.id); inserted = JSON.parse(params[6]) }
      if (sql.startsWith('SELECT result FROM')) return { rows: [{ result: inserted }] }
      if (sql.startsWith('SELECT md5')) return { rows: [{ result_md5: md5 }] }
      return { rows: [] }
    } }
    const proof = await forkStageMediaRepair(client, { ...options, apply, expectedMd5: md5 }, manifest)
    assert.equal(proof.applied, apply)
    assert.equal(statements[0], apply ? 'BEGIN' : 'BEGIN READ ONLY')
    assert.equal(statements.filter(sql => sql.startsWith('INSERT')).length, apply ? 1 : 0)
    assert.ok(statements.every(sql => !/UPDATE|DELETE/.test(sql)))
    assert.equal(statements.at(-1), 'COMMIT')
  }
  const { source, manifest } = fixture(), statements = []
  const corrupt = { async query(sql) {
    statements.push(sql)
    if (sql.startsWith('SELECT *')) return { rows: [source] }
    if (sql.startsWith('SELECT result FROM')) return { rows: [] }
    return { rows: [] }
  } }
  await assert.rejects(forkStageMediaRepair(corrupt, { ...options, apply: true }, manifest), /inserted record differs/)
  assert.equal(statements.at(-1), 'ROLLBACK')
  assert.equal(parseArguments(['--source', 'source', '--manifest', 'repair.json']).apply, false)
  assert.throws(() => parseArguments(['--source', 'source', '--manifest', 'repair.json', '--apply=true']), /unknown/)
})
