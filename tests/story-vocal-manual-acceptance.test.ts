import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { applyStoryVocalReviewGate, bindStoryShotObservations,
  validateStoryShotAssessment } from '../server/story-media-review.ts'
import { assertStoryVocalHumanAssets, requireStoryVocalHumanAcceptance,
  storyVocalJsonSha256 } from '../server/story-vocal-manual-acceptance.ts'
import { requireConcatCurrentAcceptance } from '../server/video-concat-acceptance.ts'
import { parseStoryVocalHumanForkArgs, prepareStoryVocalHumanFork,
  storyVocalHumanReviewTemplate } from '../scripts/fork-story-vocal-human-accepted.mjs'

const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const nativeUrl = 'https://example.com/native-paid-take.mp4'
const shot = { title: '早晨', content: '芙伊工作，卷毛回应。', camera: '固定', mood: '对话',
  firstFramePrompt: '芙伊与卷毛同在家中，芙伊手边放着早餐袋。',
  duration: 7, audioContractVersion: 'animal-interaction-v1',
  visualBeats: [
    { id: 'cat', action: '芙伊拿起早餐袋并发声', completion: '芙伊站稳且拿着早餐袋', startSecond: 0, endSecond: 3 },
    { id: 'dog', action: '卷毛摇尾巴并发声', completion: '卷毛站稳并望向芙伊', startSecond: 3, endSecond: 6 },
  ], vocalBeats: [
    { id: 'cat-call', speaker: '芙伊', utterance: '喵儿', startSecond: 1, endSecond: 1.5,
      visualBeatId: 'cat', responseTo: null },
    { id: 'dog-call', speaker: '卷毛', utterance: '旺', startSecond: 4, endSecond: 4.5,
      visualBeatId: 'dog', responseTo: 'cat-call' },
  ] }
const frameTimes = [0, 1.5, 3, 4.5, 6, 6.5, 6.95]
const evidence = { decoded: true, sha256: 'a'.repeat(64), url: '/generated/verified-manual.mp4',
  originalUrl: nativeUrl, evidenceUrl: '/generated/verified-manual-evidence.json', duration: 7.04,
  frames: frameTimes.map((_, index) => `/generated/verified-manual-frame-${index}.jpg`), frameTimes }
const descriptions = [
  '芙伊面前有早餐袋，卷毛尾巴垂着。',
  '芙伊前爪握住早餐袋，卷毛尾巴垂着。',
  '芙伊站稳且拿着早餐袋，卷毛尾巴垂着。',
  '芙伊站稳且拿着早餐袋，卷毛摇动尾巴。',
  '芙伊站稳且拿着早餐袋，卷毛站稳并望向芙伊。',
  '芙伊站稳且拿着早餐袋，卷毛站稳并望向芙伊。',
  '芙伊站稳且拿着早餐袋，卷毛站稳并望向芙伊。',
]

function acceptedOutput() {
  const draft = { version: 'story-shot-observations-v1', sourceVideoSha256: evidence.sha256,
    evidenceUrl: evidence.evidenceUrl,
    frames: descriptions.map((description, frameIndex) => ({ frameIndex, second: frameTimes[frameIndex], description })) }
  const observations = bindStoryShotObservations(draft, evidence as Parameters<typeof bindStoryShotObservations>[1])
  const assessment = { version: 'story-shot-media-review-v1', sourceVideoSha256: evidence.sha256,
    evidenceUrl: evidence.evidenceUrl, passed: true, beatChecks: [
      { id: 'cat', status: 'complete', startFrameIndex: 0, completionFrameIndex: 2,
        startObservation: '芙伊面前有早餐袋', completionObservation: '芙伊站稳且拿着早餐袋', reason: '前爪拿起' },
      { id: 'dog', status: 'complete', startFrameIndex: 3, completionFrameIndex: 4,
        startObservation: '卷毛摇动尾巴', completionObservation: '卷毛站稳并望向芙伊', reason: '姿态变化' },
    ], endingHold: { status: 'complete', firstFrameIndex: 4, lastFrameIndex: 6,
      firstObservation: '卷毛站稳并望向芙伊', lastObservation: '卷毛站稳并望向芙伊', reason: '终态保持' }, issues: [] }
  const visual = validateStoryShotAssessment(shot, evidence as Parameters<typeof validateStoryShotAssessment>[1], observations, assessment)
  assert.equal(visual.passed, true)
  const vocalEvidence = { version: 'story-vocal-evidence-v1', sourceVideoUrl: evidence.url,
    sourceVideoSha256: evidence.sha256, acousticStatus: 'signal-present', semanticStatus: 'unverified',
    lipSyncStatus: 'unverified', windows: shot.vocalBeats.map((beat, index) => ({ ...beat,
      audioUrl: `/generated/manual-${index}.wav`, audioSha256: hash(`wav-${index}`),
      acousticStatus: 'signal-present', meanVolumeDb: -30, maxVolumeDb: -10 })) }
  const gated = applyStoryVocalReviewGate(visual, vocalEvidence as Parameters<typeof applyStoryVocalReviewGate>[1])
  const storyMediaReview = { version: 'story-shot-media-review-v1', videoUrl: nativeUrl,
    ...gated, observations, assessment,
    videoEvidence: evidence, vocalEvidence }
  const original = { url: evidence.url, originalUrl: nativeUrl, videoEvidence: evidence, storyMediaReview,
    passed: false, issues: gated.issues }
  const humanVocalAcceptance = { version: 'story-vocal-human-acceptance-v1',
    reviewMethod: 'human-listening-and-mouth-sync', verdict: 'pass', reviewer: 'Example human reviewer',
    reviewedAt: '2026-09-30T12:00:00.000Z', sourceRecordId: 'record-source',
    sourceResultMd5: 'b'.repeat(32), sourceRunId: 'node-video-review-loop-0',
    sourceVideoOutputSha256: storyVocalJsonSha256(original), sourceShotSha256: storyVocalJsonSha256(shot),
    sourceReviewSha256: storyVocalJsonSha256(storyMediaReview), sourceVideoSha256: evidence.sha256,
    sourceVideoUrl: evidence.url, sourceEvidenceUrl: evidence.evidenceUrl,
    reviewFile: 'qa/manual-report.json', reviewFileSha256: 'c'.repeat(64), shot,
    windows: vocalEvidence.windows.map(window => ({ ...shot.vocalBeats.find(beat => beat.id === window.id)!,
      audioUrl: window.audioUrl, audioSha256: window.audioSha256,
      heardAsExpected: true, mouthSyncConfirmed: true,
      observation: '实际听到指定动物叫声，嘴部张合与这段声音同步。' })) }
  return { ...original, humanVocalAcceptance }
}

test('manual cat/dog decision can release only visual-passed, exact-source vocal uncertainty', () => {
  const current = acceptedOutput()
  assert.deepEqual(requireStoryVocalHumanAcceptance(current), { sourceSha256: evidence.sha256 })
  assert.deepEqual(requireConcatCurrentAcceptance(current), { sourceSha256: evidence.sha256 })
  assert.equal(current.storyMediaReview.reviewStatus, 'uncertain')
  assert.equal(current.storyMediaReview.passed, false)
  assert.throws(() => requireConcatCurrentAcceptance({ ...current, humanVocalAcceptance: undefined }), /VIDEO_CONCAT_QUALITY_REQUIRED/)
  assert.throws(() => requireConcatCurrentAcceptance({ ...current, humanVocalAcceptance: undefined,
    passed: true, qualityReview: { canProceed: true } }), /VIDEO_CONCAT_QUALITY_REQUIRED/)
})

test('manual audio cannot bypass visual incompleteness, changed media or missing per-call mouth confirmation', () => {
  const current = acceptedOutput()
  const changes = [
    { ...current, url: '/generated/changed.mp4' },
    { ...current, paidSourceSha256: 'f'.repeat(64) },
    { ...current, videoEvidence: { ...current.videoEvidence, sha256: 'f'.repeat(64) } },
    { ...current, storyMediaReview: { ...current.storyMediaReview, beatChecks: [{ status: 'incomplete' }] } },
    { ...current, storyMediaReview: { ...current.storyMediaReview, assessment: {
      ...current.storyMediaReview.assessment, passed: false } } },
    { ...current, storyMediaReview: { ...current.storyMediaReview, vocalEvidence: {
      ...current.storyMediaReview.vocalEvidence, acousticStatus: 'silent-window' } } },
    { ...current, humanVocalAcceptance: { ...current.humanVocalAcceptance, windows: [
      current.humanVocalAcceptance.windows[0], { ...current.humanVocalAcceptance.windows[1], mouthSyncConfirmed: false },
    ] } },
    { ...current, humanVocalAcceptance: { ...current.humanVocalAcceptance, windows: [
      current.humanVocalAcceptance.windows[0], { ...current.humanVocalAcceptance.windows[1], audioSha256: 'f'.repeat(64) },
    ] } },
  ]
  for (const changed of changes) assert.throws(() => requireConcatCurrentAcceptance(changed), /VIDEO_CONCAT_QUALITY_REQUIRED/)
})

test('archived listening WAV bytes are rechecked before concat', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'story-vocal-manual-'))
  try {
    const generated = path.join(root, 'public/generated')
    await mkdir(generated, { recursive: true })
    await mkdir(path.join(root, 'qa'), { recursive: true })
    const current = acceptedOutput()
    for (const [index, window] of current.humanVocalAcceptance.windows.entries()) {
      const bytes = Buffer.from(`real-wav-${index}`)
      await writeFile(path.join(generated, path.basename(window.audioUrl)), bytes)
      const digest = hash(bytes.toString())
      window.audioSha256 = digest
      current.storyMediaReview.vocalEvidence.windows[index].audioSha256 = digest
    }
    current.humanVocalAcceptance.sourceReviewSha256 = storyVocalJsonSha256(current.storyMediaReview)
    const { humanVocalAcceptance: _, ...original } = current
    current.humanVocalAcceptance.sourceVideoOutputSha256 = storyVocalJsonSha256(original)
    const report = { ...current.humanVocalAcceptance, reviewFileSha256: undefined, shot: undefined }
    const reportBytes = JSON.stringify(report)
    await writeFile(path.join(root, 'qa/manual-report.json'), reportBytes)
    current.humanVocalAcceptance.reviewFileSha256 = hash(reportBytes)
    await assertStoryVocalHumanAssets(current, root)
    await writeFile(path.join(root, 'qa/manual-report.json'), 'changed report')
    await assert.rejects(assertStoryVocalHumanAssets(current, root), /STORY_VOCAL_MANUAL_ACCEPTANCE_INVALID/)
    await writeFile(path.join(root, 'qa/manual-report.json'), reportBytes)
    await writeFile(path.join(generated, 'manual-1.wav'), 'changed')
    await assert.rejects(assertStoryVocalHumanAssets(current, root), /STORY_VOCAL_MANUAL_ACCEPTANCE_INVALID/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('CAS fork records human decision separately and resumes at concat through the current branch', () => {
  const current = acceptedOutput()
  const { humanVocalAcceptance: human, ...originalOutput } = current
  const ids = ['node-input', 'node-model-images', 'node-script', 'node-script-review', 'node-loop',
    'node-image', 'node-video', 'node-video-review', 'node-video-review-result-branch', 'node-video-concat']
  const kinds = ['input', 'image', 'text', 'validation', 'loop', 'image', 'video', 'validation', 'branch', 'videoConcat']
  const variables = ['input', 'model_images', 'script_generation', 'script_review', 'shot_loop',
    'first_frame', 'video_shot', 'video_review', 'video_review_decision', 'stage_video']
  const nodes = ids.map((id, index) => ({ id, kind: kinds[index], resultVar: variables[index],
    loop: { enabled: false, itemVar: 'shot', sourcePath: '', fallbackCount: 0 }, params: [] }))
  const runs = nodes.map((node, index) => ({ id: `${node.id}-run`, node,
    status: index < 7 ? 'success' : index === 7 ? 'failed' : 'idle',
    output: index === 3 ? { shots: [shot], passed: true }
      : index === 6 ? { model: 'keling3', url: nativeUrl }
        : index === 7 ? originalOutput : undefined,
    context: {}, loopIndex: 0, revision: 0 }))
  const state = { id: 'record-source', workflowId: 'wf-story', nodeRuns: runs,
    context: {}, mode: 'step', logs: [] }
  const source = { id: state.id, workflow_id: 'wf-story', result_md5: 'b'.repeat(32), result: state }
  const workflow = { id: 'wf-story', nodes, edges: [
    { id: 'review-branch', from: ids[7], to: ids[8] },
    { id: 'branch-concat', from: ids[8], to: ids[9], branch: 'true' },
    { id: 'branch-retake', from: ids[8], to: ids[6], branch: 'false' },
  ], nodes_md5: 'c'.repeat(32), edges_md5: 'd'.repeat(32) }
  const report = { version: human.version, reviewMethod: human.reviewMethod, verdict: human.verdict,
    reviewer: human.reviewer, reviewedAt: human.reviewedAt, sourceRecordId: source.id,
    sourceResultMd5: source.result_md5, sourceRunId: runs[7].id,
    sourceVideoOutputSha256: storyVocalJsonSha256(originalOutput),
    sourceReviewSha256: storyVocalJsonSha256(originalOutput.storyMediaReview),
    sourceShotSha256: storyVocalJsonSha256(shot), sourceVideoSha256: evidence.sha256,
    sourceVideoUrl: evidence.url,
    windows: human.windows.map(window => ({ id: window.id, speaker: window.speaker,
      utterance: window.utterance, startSecond: window.startSecond, endSecond: window.endSecond,
      audioUrl: window.audioUrl, audioSha256: window.audioSha256,
      heardAsExpected: window.heardAsExpected, mouthSyncConfirmed: window.mouthSyncConfirmed,
      observation: window.observation })) }
  const loaded = { report, sha256: 'e'.repeat(64), file: 'qa/review.json' }
  const verified = { videoSha256: evidence.sha256,
    audioSha256: current.storyMediaReview.vocalEvidence.windows.map(window => window.audioSha256) }
  const pending = storyVocalHumanReviewTemplate(source, verified)
  assert.equal(pending.verdict, 'pending')
  assert.ok(pending.windows.every(window => window.heardAsExpected === false && window.mouthSyncConfirmed === false))
  const prepared = prepareStoryVocalHumanFork(source, workflow, loaded, verified, 'record-child')
  assert.equal(prepared.state.nodeRuns[7].status, 'success')
  assert.equal(prepared.state.nodeRuns[7].output.storyMediaReview.reviewStatus, 'uncertain')
  assert.equal(prepared.state.nodeRuns[7].output.storyMediaReview.passed, false)
  assert.equal(prepared.state.nodeRuns[8].status, 'success')
  assert.equal(prepared.state.nodeRuns[8].output.value, true)
  assert.equal(prepared.state.nodeRuns[9].status, 'idle')
  assert.equal(prepared.proof.firstPendingIndex, 9)
  assert.deepEqual(requireConcatCurrentAcceptance(prepared.state.nodeRuns[7].output), { sourceSha256: evidence.sha256 })
  assert.equal(storyVocalJsonSha256(source.result), storyVocalJsonSha256(state), 'source remains unchanged')

  const directState = { ...state, nodeRuns: runs.filter((_, index) => index !== 8) }
  const directWorkflow = { ...workflow, nodes: nodes.filter((_, index) => index !== 8),
    edges: [{ id: 'review-concat', from: ids[7], to: ids[9] }] }
  const direct = prepareStoryVocalHumanFork({ ...source, result: directState }, directWorkflow,
    loaded, verified, 'record-direct-child')
  assert.equal(direct.proof.firstPendingIndex, 8)
  assert.equal(direct.proof.manualBranchRouted, false)
  assert.equal(direct.state.nodeRuns[8].status, 'idle')
  assert.throws(() => storyVocalHumanReviewTemplate(source, { ...verified, videoSha256: 'f'.repeat(64) }),
    /source has visual defects, silent vocals or changed local media/)
  const visualFailure = structuredClone(source)
  visualFailure.result.nodeRuns[7].output.storyMediaReview.assessment.passed = false
  assert.throws(() => storyVocalHumanReviewTemplate(visualFailure, verified),
    /source has visual defects, silent vocals or changed local media/)
})

test('apply mode requires explicit reviewed CAS digests', () => {
  const base = ['--source-record', 'record-source', '--id', 'record-child', '--review-file', 'qa/review.json']
  assert.equal(parseStoryVocalHumanForkArgs(base).apply, false)
  assert.throws(() => parseStoryVocalHumanForkArgs([...base, '--apply']), /--apply requires every reviewed/)
  assert.equal(parseStoryVocalHumanForkArgs(['--source-record', 'record-source', '--template']).template, true)
  assert.throws(() => parseStoryVocalHumanForkArgs(['--source-record', 'record-source', '--template', '--apply']),
    /read-only/)
})
