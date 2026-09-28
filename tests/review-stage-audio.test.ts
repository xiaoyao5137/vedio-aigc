import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { encodeExecutionState, decodeExecutionState } from '../src/execution-storage.ts'
import { acceptPrincipleMedia } from '../src/principle-media-quality.ts'
import { prepareStageAudioReview, reviewStageAudio, parseArguments, rewriteLiveOutputReferences } from '../scripts/review-stage-audio.mjs'
import { createJsonHasher } from '../scripts/restore-branch-checkpoint.mjs'

const md5 = '0123456789abcdef0123456789abcdef'
const options = { sourceId: 'source', id: 'audio-review-copy', createdAt: '2026-09-26T09:00:00.000Z' }
const json = value => JSON.parse(JSON.stringify(value))

function fixture(mediaUrl = '/generated/clip-0.mp4') {
  const nodeRuns = [], stageOutputs = [], acceptedOutputs = []
  let current = {}, previousStage
  for (const loopIndex of [0, 1]) {
    const windows = [{ start: 0, end: 2, text: '黄天当立', beatId: 'line-' + loopIndex, actorIds: ['张角'] }]
    const shot = { id: 'shot-' + loopIndex, audioType: '对白', audioText: '张角：黄天当立', duration: 4, pacing: { scheduleHash: 'schedule-' + loopIndex, speechWindows: windows } }
    const take = { url: 'https://example.com/original-' + loopIndex + '.mp4', providerReceipt: 'PAID-' + loopIndex }
    const evidence = { originalUrl: take.url, url: loopIndex === 0 ? mediaUrl : '/generated/clip-1.mp4', evidenceUrl: '/generated/evidence-' + loopIndex + '.json',
      decoded: true, width: 1280, height: 720, duration: 4, hasAudio: true, meanVolumeDb: -25,
      frames: ['/generated/first.jpg', '/generated/last.jpg'], frameTimes: [0, 3.96], lastFrameUrl: '/generated/last.jpg', transcript: [{ start: .1, end: 2, text: '皇天当立' }],
      speechValidation: { passed: false, phoneticErrorRate: 0, dialogueCompletenessVerified: false, issues: ['句尾待复核'],
        alignment: [{ planned: windows[0], actualStart: .1, actualEnd: 2, alignmentCoverage: 1, firstTokenMatched: true, lastTokenMatched: true,
          boundaryEvidenceVersion: 2, boundaryStatus: 'uncertain', utteranceCandidateStart: .1, utteranceCandidateEnd: 2.4 }] } }
    const review = { version: 'principle-review-v1', decision: 'pass', issues: [], warnings: [] }
    const parameters = { qualityMode: 'principle-v1', qualityDisposition: loopIndex ? 'manual-review-v1' : 'strict-v1' }
    current = { input: { topic: '原始输入' }, loop: { index: loopIndex + 1, previous: previousStage ? { stage_video: previousStage } : {} } }
    const append = (resultVar, kind, output, inputs = {}) => {
      const inputContext = current
      current = { ...current, ...(output === undefined ? {} : { [resultVar]: output }) }
      const run = { id: resultVar + '-' + loopIndex, node: { id: resultVar, resultVar, kind }, status: 'success', output, inputs,
        inputContext, context: current, loopPrevious: previousStage ? { stage_video: previousStage } : {}, loopIndex, loopGroupId: 'scene-loop',
        attempt: 3, revision: 2, errorAttempt: 1, branchState: { visits: 3, counts: { true: 2, false: 1 } },
        attempts: [{ status: 'failed', output: { reason: '保留既有尝试', url: '/generated/older-paid.mp4' } }] }
      nodeRuns.push(run)
      return run
    }
    append('shot_script', 'code', shot)
    append('video_take', 'video', take)
    append('video_evidence', 'builtin', evidence)
    append('media_review', 'text', review)
    const accepted = json(acceptPrincipleMedia({ shot_script: shot, video_take: take, video_evidence: evidence, media_review: review }, parameters))
    delete accepted.audioEvidenceAssessment
    accepted.technicalValidation.speechVerified = true
    accepted.warnings = []; accepted.qualityReview.warnings = []
    accepted.executionLogs = ['保留原执行日志']
    append('video_shot', 'code', accepted, parameters)
    acceptedOutputs.push(accepted)
    const stage = { url: '/generated/stage-' + loopIndex + '.mp4', totalDuration: (loopIndex + 1) * 4,
      clips: acceptedOutputs.map((output, index) => ({ url: output.url, sourceUrl: output.url, sha256: String(index).repeat(64) })),
      qualityDisposition: parameters.qualityDisposition, voiceConsistency: { status: 'uncertain', fullVideoListened: false },
      qualityReview: { status: 'needs_attention', canProceed: true, principleIssues: [], warnings: [] } }
    append('stage_video', 'builtin', stage, { previousVideo: previousStage ?? null, currentVideo: accepted, qualityDisposition: parameters.qualityDisposition })
    previousStage = stage; stageOutputs.push(stage)
  }
  const idle = { id: 'pending', node: { id: 'next', kind: 'builtin' }, status: 'idle', context: current,
    inputs: { exactCopy: json(acceptedOutputs[0]), previous: json(stageOutputs[1]), sameUrlDifferentObject: { url: acceptedOutputs[0].url, marker: 'keep' } },
    routeInputContext: { loop: { previous: { stage_video: json(stageOutputs[0]) } } },
    attempts: [{ output: acceptedOutputs[0], status: 'success', preserve: 'historical-attempt' }] }
  nodeRuns.push(idle)
  const state = { id: 'source', workflowId: 'workflow', requestScopeId: 'original-paid-scope', nodeRuns, context: current, mode: 'step', logs: ['原始日志'],
    branchHistory: [{ from: 'gate', to: 'video_take', backwards: true, scene: nodeRuns.slice(0, 12) }],
    loopRerunHistory: [{ context: current }], runtimeInputs: { topic: '原始输入' } }
  const source = { id: state.id, workflow_id: state.workflowId, workflow_name: '原工作流', runtime_inputs: state.runtimeInputs, result_md5: md5, result: encodeExecutionState(state) }
  return { source, state, acceptedOutputs, stageOutputs }
}

test('review fork reassesses each original policy, retains media and archives superseded outputs without rewriting history', () => {
  const { source, state, acceptedOutputs, stageOutputs } = fixture(), before = json(source), hash = createJsonHasher()
  const prepared = prepareStageAudioReview(source, options), reviewed = prepared.state
  assert.deepEqual(source, before)
  assert.equal(reviewed.id, options.id)
  assert.equal(reviewed.requestScopeId, 'original-paid-scope')
  assert.equal(prepared.proof.reviewedSegmentCount, 2)
  assert.equal(prepared.proof.reviewedConcatCount, 2)
  for (const key of ['branchHistory', 'loopRerunHistory']) assert.equal(hash(reviewed[key]), hash(state[key]))
  for (const [index, run] of reviewed.nodeRuns.entries()) {
    const original = state.nodeRuns[index]
    assert.deepEqual(run.attempts.slice(0, original.attempts.length), original.attempts)
    for (const key of ['status', 'attempt', 'revision', 'errorAttempt', 'branchState']) assert.equal(hash(run[key] ?? null), hash(original[key] ?? null))
    if (run.node.kind === 'video') assert.deepEqual(run.output, original.output)
  }
  const acceptances = reviewed.nodeRuns.filter(run => run.node.resultVar === 'video_shot')
  assert.deepEqual(acceptances.map(run => run.output.qualityDisposition), ['strict-v1', 'manual-review-v1'])
  for (const [index, run] of acceptances.entries()) {
    assert.equal(run.output.technicalValidation.speechVerified, false)
    assert.equal(run.output.passed, true)
    assert.deepEqual(run.output.speechValidation, acceptedOutputs[index].speechValidation)
    assert.equal(run.output.url, acceptedOutputs[index].url)
    assert.deepEqual(run.output.raw, acceptedOutputs[index].raw)
    assert.deepEqual(run.output.executionLogs, acceptedOutputs[index].executionLogs)
    assert.deepEqual(run.attempts.at(-1).output, acceptedOutputs[index])
    assert.equal(run.attempts.at(-1).historical, true)
  }
  const finalStage = reviewed.nodeRuns.find(run => run.id === 'stage_video-1').output
  assert.equal(finalStage.clipReviews.length, 2)
  assert.ok(finalStage.clipReviews.every(review => review.audioEvidenceAssessment.speechVerified === false))
  assert.deepEqual(finalStage.clips, stageOutputs[1].clips)
  assert.equal(finalStage.url, stageOutputs[1].url)
  assert.equal(hash(decodeExecutionState(json(prepared.encoded))), hash(reviewed))
  for (const key of ['mediaOutputsPreserved', 'branchHistoryPreserved', 'priorAttemptsPreserved', 'statusAndBudgetsPreserved', 'roundTripVerified', 'sourceUnchanged']) assert.equal(prepared.proof[key], true)
})

test('exact hash replacement refreshes root/current/idle snapshots while historical and merely similar objects stay intact', () => {
  const { source, state, acceptedOutputs, stageOutputs } = fixture(), prepared = prepareStageAudioReview(source, options)
  const idle = prepared.state.nodeRuns.at(-1), oldIdle = state.nodeRuns.at(-1)
  assert.equal(idle.inputs.exactCopy.technicalValidation.speechVerified, false, 'structural copies must be refreshed too')
  assert.ok(idle.inputs.previous.clipReviews[0].audioEvidenceAssessment)
  assert.ok(idle.routeInputContext.loop.previous.stage_video.clipReviews[0].audioEvidenceAssessment)
  assert.deepEqual(idle.inputs.sameUrlDifferentObject, oldIdle.inputs.sameUrlDifferentObject)
  assert.deepEqual(idle.attempts[0].output, acceptedOutputs[0])
  assert.deepEqual(idle.attempts.at(-1).inputs, oldIdle.inputs)
  assert.equal(prepared.state.context.video_shot.technicalValidation.speechVerified, false)
  assert.ok(prepared.state.context.stage_video.clipReviews[1].audioEvidenceAssessment)
  assert.deepEqual(prepared.state.branchHistory[0].scene.find(run => run.id === 'stage_video-1').output, stageOutputs[1])
  const firstConcat = prepared.state.nodeRuns.find(run => run.id === 'stage_video-0')
  assert.equal(firstConcat.context.video_shot.technicalValidation.speechVerified, false)
  assert.ok(firstConcat.context.stage_video.clipReviews[0].audioEvidenceAssessment)
})

test('shared rewrite helper refreshes identical producers, live carry and explicit root fields while keeping repair history', () => {
  const { state, acceptedOutputs } = fixture(), before = json(state), original = acceptedOutputs[0], replacement = { ...original, replacementEvidence: 'verified-replacement' }
  const index = state.nodeRuns.findIndex(run => run.id === 'video_shot-0')
  state.nodeRuns.push({ id: 'same-producer', node: { id: 'producer', kind: 'code' }, status: 'success', output: json(original), attempts: [] })
  state.nodeRuns.at(-1).branchCarry = { gate: { state: { visits: 2, counts: { true: 1, false: 1 } }, currentVideo: original } }
  state.nodeRuns.at(-1).retryFeedback = { previousAcceptedVideo: original }
  const liveRoot = { current: original, stageMediaRepairHistory: [{ previous: original }] }
  const result = rewriteLiveOutputReferences(state, new Map([[index, { output: replacement, kind: 'verified-material-adoption' }]]), {
    sourceRecordId: 'source', createdAt: options.createdAt, historicalField: 'stageMediaRepairHistorical', method: 'verified-material-adoption', reason: '原片保留为历史',
  })
  assert.deepEqual(result.nodeRuns.at(-1).output, replacement)
  assert.deepEqual(result.nodeRuns.at(-1).branchCarry.gate.currentVideo, replacement)
  assert.deepEqual(result.nodeRuns.at(-1).branchCarry.gate.state, { visits: 2, counts: { true: 1, false: 1 } })
  assert.deepEqual(result.nodeRuns.at(-1).retryFeedback.previousAcceptedVideo, replacement)
  assert.deepEqual(result.nodeRuns.at(-1).attempts.at(-1).output, original)
  assert.equal(result.nodeRuns.at(-1).attempts.at(-1).stageMediaRepairHistorical.method, 'verified-material-adoption')
  const refreshed = result.refresh(liveRoot)
  assert.deepEqual(refreshed.current, replacement)
  assert.deepEqual(refreshed.stageMediaRepairHistory, liveRoot.stageMediaRepairHistory)
  assert.deepEqual(state.nodeRuns[index].output, before.nodeRuns[index].output)
})

test('old unknown clip placeholders cannot hide actual voice evidence, while exact-source listening failures remain visible', () => {
  const { state, source, stageOutputs } = fixture()
  state.nodeRuns.find(run => run.id === 'video_shot-0').output.voiceConsistency = { status: 'uncertain', method: 'manual-review-pending', reason: '原生成片段有已冻结命名音色' }
  for (const stage of stageOutputs) stage.clipReviews = stage.clips.map((clip, index) => ({ videoUrl: clip.url, sourceSha256: clip.sha256,
    voiceConsistency: index ? { status: 'failed', method: 'user-listening', note: '已实际听审，不可覆盖' } : { status: 'uncertain', method: 'not-reviewed' } }))
  source.result = encodeExecutionState(state)
  const result = prepareStageAudioReview(source, options), finalStage = result.state.nodeRuns.find(run => run.id === 'stage_video-1').output
  assert.equal(finalStage.clipReviews[0].voiceConsistency.method, 'manual-review-pending')
  assert.equal(finalStage.clipReviews[1].voiceConsistency.status, 'failed')
  assert.equal(finalStage.clipReviews[1].voiceConsistency.method, 'user-listening')
})

test('ambiguous whole-output replacements and malformed rewrite metadata reject before touching snapshots', () => {
  const { state, acceptedOutputs } = fixture(), index = state.nodeRuns.findIndex(run => run.id === 'video_shot-0')
  state.nodeRuns.push({ id: 'duplicate-value', node: { id: 'copy', kind: 'code' }, status: 'success', output: json(acceptedOutputs[0]) })
  const before = json(state), meta = { sourceRecordId: 'source', createdAt: options.createdAt }
  assert.throws(() => rewriteLiveOutputReferences(state, new Map([
    [index, { output: { ...acceptedOutputs[0], version: 2 } }], [state.nodeRuns.length - 1, { output: { ...acceptedOutputs[0], version: 3 } }],
  ]), meta), /ambiguous review replacements/)
  assert.throws(() => rewriteLiveOutputReferences(state, new Map(), { ...meta, historicalField: 'output' }), /audit metadata/)
  assert.throws(() => rewriteLiveOutputReferences(state, new Map([[-1, { output: {} }]]), meta), /stable run output/)
  assert.deepEqual(state, before)
})

test('saved video bytes and URLs are unchanged, with no model or network call during preparation', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stage-audio-review-')), file = path.join(dir, 'paid.mp4')
  const bytes = Buffer.from('immutable already-produced video bytes'), fetchBefore = globalThis.fetch
  let requests = 0
  try {
    await writeFile(file, bytes)
    globalThis.fetch = async () => { requests++; throw Error('network must not be called') }
    const { source } = fixture(file), prepared = prepareStageAudioReview(source, options)
    assert.equal(prepared.proof.segments[0].videoUrl, file)
    assert.equal(prepared.proof.concats.at(-1).clips[0].url, file)
    assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'), createHash('sha256').update(bytes).digest('hex'))
    assert.equal(requests, 0)
    assert.equal(prepared.proof.modelsCalled, 0)
    assert.equal(prepared.proof.mediaFilesWritten, 0)
  } finally { globalThis.fetch = fetchBefore; await rm(dir, { recursive: true, force: true }) }
})

test('invalid scope/media identities and unknown policies fail before modifying the source', () => {
  for (const change of [
    state => { state.nodeRuns[0].status = 'running' },
    state => { state.nodeRuns[1].id = state.nodeRuns[0].id },
    state => { state.nodeRuns.find(run => run.node.resultVar === 'video_shot').output = { ...state.nodeRuns.find(run => run.node.resultVar === 'video_shot').output, originalUrl: 'https://example.com/wrong.mp4' } },
    state => { state.nodeRuns.find(run => run.node.resultVar === 'video_shot').output.qualityDisposition = 'unknown-policy' },
    state => { state.nodeRuns.find(run => run.node.resultVar === 'video_shot').output.qualityPolicy = 'other-policy' },
    state => { state.nodeRuns[0].attempts = {} },
  ]) {
    const { state, source } = fixture(); change(state); source.result = encodeExecutionState(state)
    const before = json(source)
    assert.throws(() => prepareStageAudioReview(source, options), /STAGE_AUDIO_REVIEW_INVALID/)
    assert.deepEqual(source, before)
  }
  assert.throws(() => prepareStageAudioReview(fixture().source, { ...options, id: 'source' }), /NEW record/)
})

function fakeDatabase({ changed = false, corrupt = false, missing = false } = {}) {
  const { source } = fixture(), before = json(source), statements = []
  let inserted
  return { source, before, statements, async query(sql, params = []) {
    statements.push(sql)
    if (sql.startsWith('SELECT *')) return { rows: missing ? [] : [source] }
    if (sql.startsWith('INSERT INTO')) {
      assert.notEqual(params[0], source.id)
      assert.deepEqual(JSON.parse(params[5]), source.runtime_inputs)
      assert.match(params[4], /语音证据复核副本.*原视频未改/)
      inserted = JSON.parse(params[6])
      if (corrupt) inserted.id = 'bad-id'
      return { rows: [] }
    }
    if (sql.startsWith('SELECT result FROM')) return { rows: [{ result: inserted }] }
    if (sql.startsWith('SELECT md5')) return { rows: [{ result_md5: changed ? 'changed' : md5 }] }
    return { rows: [] }
  } }
}

test('default preview performs only reads and explicit apply inserts one new record without updating any source row', async () => {
  const dry = fakeDatabase(), proof = await reviewStageAudio(dry, options)
  assert.equal(dry.statements[0], 'BEGIN READ ONLY')
  assert.ok(dry.statements.every(sql => !/INSERT|UPDATE|DELETE/.test(sql)))
  assert.equal(proof.applied, false)
  assert.deepEqual(dry.source, dry.before)
  const apply = fakeDatabase(), result = await reviewStageAudio(apply, { ...options, apply: true, expectedMd5: md5 })
  assert.equal(apply.statements.filter(sql => sql.startsWith('INSERT INTO')).length, 1)
  assert.ok(apply.statements.every(sql => !/UPDATE|DELETE/.test(sql)))
  assert.equal(apply.statements.at(-1), 'COMMIT')
  assert.equal(result.applied, true)
  assert.equal(result.sourceResultMd5After, md5)
  assert.deepEqual(apply.source, apply.before)
})

test('stale source or bad readback rolls back; CLI does not infer apply from misspelled flags', async () => {
  for (const [db, extra, error] of [
    [fakeDatabase({ changed: true }), {}, /source changed/], [fakeDatabase({ corrupt: true }), {}, /inserted record/],
    [fakeDatabase({ missing: true }), {}, /not found/], [fakeDatabase(), { expectedMd5: 'f'.repeat(32) }, /source MD5 differs/],
  ]) {
    await assert.rejects(reviewStageAudio(db, { ...options, ...extra, apply: true }), error)
    assert.equal(db.statements.at(-1), 'ROLLBACK')
  }
  assert.equal(parseArguments(['--source', 'source']).apply, false)
  assert.equal(parseArguments(['--source', 'source', '--apply']).apply, true)
  for (const args of [[], ['--source'], ['--source', 'source', '--apply=true'], ['--source', 'source', '--apply', '--apply'], ['--source', 'source', '--expected-source-md5', 'bad']]) {
    assert.throws(() => parseArguments(args), /STAGE_AUDIO_REVIEW_INVALID/)
  }
})

test('CLI refuses an existing proof path before an apply transaction can begin', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stage-audio-proof-')), proof = path.join(dir, 'proof.json')
  try {
    await writeFile(proof, 'existing-proof-must-stay')
    await assert.rejects(promisify(execFile)(process.execPath, ['scripts/review-stage-audio.mjs', '--source', 'source', '--apply', '--proof', proof], {
      env: { ...process.env, DATABASE_URL: 'postgres://invalid:invalid@127.0.0.1:1/unavailable' },
    }), error => /EEXIST/.test(String(error.stderr)) && !/ECONNREFUSED/.test(String(error.stderr)))
    assert.equal(await readFile(proof, 'utf8'), 'existing-proof-must-stay')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
