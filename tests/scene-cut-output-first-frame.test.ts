import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import sharp from 'sharp'
import { acceptPrincipleMedia, PRINCIPLE_MEDIA_RUNTIME_CODE } from '../src/principle-media-quality.ts'
import { executeCodeNode } from '../server/code-node.ts'
import { issueSceneCutFrameApproval } from '../server/scene-cut-frame-approval.ts'
import { collectVideoEvidence } from '../server/video-inspection.ts'

const ffmpeg = createRequire(import.meta.url)('ffmpeg-static') as string
const exec = promisify(execFile)
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')

function fixture() {
  const shot = { id: 'scene-02', visualTreatment: 'live_action', duration: 8,
    audioType: '环境声', audioText: '', characters: ['张飞', '严颜'],
    continuity: { mode: 'scene_cut', bridgeType: 'cut', previousShotId: 'scene-01', bridgeAnchor: '省略场间押送' },
    pacing: { version: 'duration-v2', scheduleHash: 'schedule-02', speechWindows: [] } }
  const candidate = '/generated/approved-opening.png'
  const first = '/generated/scene-02-decoded-frame-0.jpg'
  const outlineBinding = { outlineSha256: '1'.repeat(64), currentSceneId: shot.id,
    currentSceneSha256: '2'.repeat(64), sceneIndex: 1 }
  const approvedEllipsis = { version: 'scene-cut-approved-ellipsis-v1', previousSceneId: 'scene-01',
    currentSceneId: shot.id, previousSceneSha256: '3'.repeat(64),
    currentSceneSha256: outlineBinding.currentSceneSha256, priorShotSha256: '4'.repeat(64),
    priorVideoUrl: '/generated/prior.mp4', priorVideoSha256: '5'.repeat(64),
    priorTailUrl: '/generated/prior-tail.jpg', priorTailSha256: '6'.repeat(64) }
  const sceneCutSources = { version: 'scene-cut-sources-v1', outlineBinding,
    approvedEllipsis: structuredClone(approvedEllipsis),
    sourceContext: { approvedOutline: { scenes: [{ id: 'scene-01' }, { id: 'scene-02' }] },
      previous: { shot_script: { id: 'scene-01' } },
      acceptedRecordBinding: { version: 'scene-cut-source-ledger-v1', recordId: 'record-test',
        outlineSha256: outlineBinding.outlineSha256, shotSha256: 'c'.repeat(64),
        priorShotSha256: approvedEllipsis.priorShotSha256 } } }
  const certificate = { version: 'scene-cut-frame-gate-v1', passed: true, signature: 'a'.repeat(64),
    frame: { sourceUrl: candidate }, sourceSha256s: ['b'.repeat(64), approvedEllipsis.priorTailSha256],
    shotSha256: 'c'.repeat(64), outlineBinding: structuredClone(outlineBinding),
    approvedEllipsis: structuredClone(approvedEllipsis),
    priorTail: { sourceUrl: approvedEllipsis.priorTailUrl, evidenceReferenceImage: '/generated/tail-review.jpg' } }
  const url = 'https://provider.example/scene-02.mp4'
  const evidenceUrl = '/generated/scene-02-evidence.json', videoSha256 = 'd'.repeat(64)
  return { shot_script: shot,
    video_take: { url, params: { scheduleHash: shot.pacing.scheduleHash, continuityMode: 'scene_cut',
      referenceImage: candidate, sceneCutShot: structuredClone(shot), sceneCutSources,
      sceneCutFrameGate: certificate } },
    video_evidence: { decoded: true, originalUrl: url, url: '/generated/scene-02-verified.mp4', sha256: videoSha256,
      evidenceUrl, duration: 8, width: 1280, height: 720, frames: [first, '/generated/scene-02-decoded-tail.jpg'],
      frameTimes: [0, 7.96], lastFrameUrl: '/generated/scene-02-decoded-tail.jpg', hasAudio: true, meanVolumeDb: -20,
      evidenceRequest: { sceneCutFrameGate: structuredClone(certificate), sceneCutReferenceImage: candidate },
      sceneCutOutputFirstFrame: { version: 'scene-cut-output-first-frame-v1', status: 'matched',
        evidenceUrl, outputVideoSha256: videoSha256, decodedFirstFrameUrl: first,
        decodedFirstFrameSha256: 'e'.repeat(64), candidateUrl: candidate,
        candidateSha256: 'b'.repeat(64), approvalSignature: certificate.signature,
        difference: .02, maximumDifference: .1 } },
    media_review: { version: 'principle-review-v1', decision: 'pass', issues: [], warnings: [],
      endingState: '问责开始', endCharacters: ['张飞', '严颜'] } }
}

test('final scene-cut acceptance binds the paid opening to the decoded video first frame', async () => {
  const input = fixture()
  assert.equal(acceptPrincipleMedia(input).passed, true)
  const code = PRINCIPLE_MEDIA_RUNTIME_CODE + '\nreturn principleMediaQuality.acceptMedia(context,params);'
  assert.equal((await executeCodeNode({ code, context: input })).passed, true)
  for (const mutate of [
    (row: ReturnType<typeof fixture>) => { delete (row.video_take.params as Record<string, unknown>).sceneCutFrameGate },
    (row: ReturnType<typeof fixture>) => { delete (row.video_evidence as Record<string, unknown>).sceneCutOutputFirstFrame },
    (row: ReturnType<typeof fixture>) => { row.video_evidence.evidenceRequest.sceneCutFrameGate.signature = 'f'.repeat(64) },
    (row: ReturnType<typeof fixture>) => { row.video_evidence.sceneCutOutputFirstFrame.outputVideoSha256 = 'f'.repeat(64) },
    (row: ReturnType<typeof fixture>) => { row.video_evidence.sceneCutOutputFirstFrame.decodedFirstFrameUrl = '/generated/stale.jpg' },
    (row: ReturnType<typeof fixture>) => { row.video_evidence.sceneCutOutputFirstFrame.candidateSha256 = 'f'.repeat(64) },
    (row: ReturnType<typeof fixture>) => { row.video_evidence.sceneCutOutputFirstFrame.status = 'unverified' },
    (row: ReturnType<typeof fixture>) => { row.video_evidence.sceneCutOutputFirstFrame.difference = .22 },
    (row: ReturnType<typeof fixture>) => { row.video_take.params.sceneCutShot.pacing.scheduleHash = 'mutated' },
    (row: ReturnType<typeof fixture>) => { row.video_take.params.sceneCutSources.outlineBinding.currentSceneSha256 = 'f'.repeat(64) },
    (row: ReturnType<typeof fixture>) => { row.video_take.params.sceneCutSources.approvedEllipsis.priorTailSha256 = 'f'.repeat(64) },
    (row: ReturnType<typeof fixture>) => { delete (row.video_take.params.sceneCutFrameGate as Record<string, unknown>).priorTail },
    (row: ReturnType<typeof fixture>) => { row.video_take.params.sceneCutFrameGate.approvedEllipsis.priorTailUrl = '/generated/other-tail.jpg' },
    (row: ReturnType<typeof fixture>) => { delete (row.video_take.params.sceneCutSources.sourceContext as Record<string, unknown>).acceptedRecordBinding },
    (row: ReturnType<typeof fixture>) => { row.video_take.params.sceneCutFrameGate.outlineBinding.outlineSha256 = 'f'.repeat(64) },
  ]) {
    const stale = fixture(); mutate(stale)
    assert.throws(() => acceptPrincipleMedia(stale, { qualityDisposition: 'manual-review-v1' }),
      /SCENE_CUT_OUTPUT_FIRST_FRAME_UNVERIFIED/)
    await assert.rejects(executeCodeNode({ code, context: stale, params: { qualityDisposition: 'manual-review-v1' } }),
      /SCENE_CUT_OUTPUT_FIRST_FRAME_UNVERIFIED/)
  }
})

test('approved ellipsis requires the signed prior tail, while an independently bridged cut does not', () => {
  const approved = fixture()
  delete (approved.video_take.params.sceneCutFrameGate as Record<string, unknown>).approvedEllipsis
  approved.video_evidence.evidenceRequest.sceneCutFrameGate = structuredClone(approved.video_take.params.sceneCutFrameGate)
  assert.throws(() => acceptPrincipleMedia(approved), /SCENE_CUT_OUTPUT_FIRST_FRAME_UNVERIFIED/)

  const withoutTail = fixture()
  withoutTail.video_take.params.sceneCutFrameGate.sourceSha256s.pop()
  withoutTail.video_evidence.evidenceRequest.sceneCutFrameGate = structuredClone(withoutTail.video_take.params.sceneCutFrameGate)
  assert.throws(() => acceptPrincipleMedia(withoutTail), /SCENE_CUT_OUTPUT_FIRST_FRAME_UNVERIFIED/)

  const bridged = fixture()
  bridged.shot_script.continuity.bridgeAnchor = '前镜可听钟声贯穿场景切换'
  bridged.video_take.params.sceneCutShot = structuredClone(bridged.shot_script)
  delete (bridged.video_take.params.sceneCutFrameGate as Record<string, unknown>).approvedEllipsis
  delete (bridged.video_take.params.sceneCutFrameGate as Record<string, unknown>).priorTail
  bridged.video_take.params.sceneCutFrameGate.sourceSha256s.pop()
  delete (bridged.video_take.params.sceneCutSources as Record<string, unknown>).approvedEllipsis
  bridged.video_evidence.evidenceRequest.sceneCutFrameGate = structuredClone(bridged.video_take.params.sceneCutFrameGate)
  assert.equal(acceptPrincipleMedia(bridged).passed, true)
})

test('the first scene opening also requires the decoded output to match its signed candidate', () => {
  const opening = fixture()
  opening.shot_script.id = 'scene-01'
  opening.shot_script.continuity = { mode: 'scene_cut', bridgeType: 'opening', previousShotId: '', bridgeAnchor: '' }
  opening.video_take.params.sceneCutShot = structuredClone(opening.shot_script)
  opening.video_take.params.sceneCutSources.outlineBinding.currentSceneId = 'scene-01'
  opening.video_take.params.sceneCutSources.outlineBinding.sceneIndex = 0
  opening.video_take.params.sceneCutSources.sourceContext.approvedOutline.scenes = [{ id: 'scene-01' }]
  delete (opening.video_take.params.sceneCutSources as Record<string, unknown>).approvedEllipsis
  opening.video_take.params.sceneCutFrameGate.outlineBinding = structuredClone(opening.video_take.params.sceneCutSources.outlineBinding)
  delete (opening.video_take.params.sceneCutFrameGate as Record<string, unknown>).approvedEllipsis
  delete (opening.video_take.params.sceneCutFrameGate as Record<string, unknown>).priorTail
  opening.video_take.params.sceneCutFrameGate.sourceSha256s = ['b'.repeat(64)]
  opening.video_evidence.evidenceRequest.sceneCutFrameGate = structuredClone(opening.video_take.params.sceneCutFrameGate)
  assert.equal(acceptPrincipleMedia(opening).passed, true)
  opening.video_evidence.sceneCutOutputFirstFrame.status = 'unverified'
  assert.throws(() => acceptPrincipleMedia(opening), /SCENE_CUT_OUTPUT_FIRST_FRAME_UNVERIFIED/)
})

test('actual decoded t=0 is compared with the signed candidate and archived for same-media review', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'scene-cut-output-'))
  const dir = path.join(root, 'public/generated')
  try {
    await mkdir(dir, { recursive: true })
    const candidateUrl = '/generated/candidate.png'
    const candidate = await sharp({ create: { width: 320, height: 180, channels: 3,
      background: { r: 0, g: 0, b: 255 } } }).png().toBuffer()
    await writeFile(path.join(dir, 'candidate.png'), candidate)
    const reference = await sharp(candidate).resize({ width: 1600, height: 1200,
      fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer()
    const referenceImage = `/generated/image-evidence-${sha256(candidate).slice(0, 24)}.jpg`
    await writeFile(path.join(root, 'public', referenceImage), reference)
    const item = { role: 'candidate_first', url: candidateUrl, referenceImage, decoded: true,
      measurement: { width: 320, height: 180, format: 'png', bytes: candidate.length } }
    const items = [item]
    const evidenceUrl = `/generated/image-evidence-${sha256(JSON.stringify(items)).slice(0, 24)}.json`
    const evidence = { evidenceUrl, items, reviewImages: [referenceImage] }
    await writeFile(path.join(root, 'public', evidenceUrl), JSON.stringify(evidence))
    const shot = { id: 'scene-02', continuity: { mode: 'scene_cut' }, visualTreatment: 'live_action',
      firstFrameMode: 'reference', pacing: { beats: [], schedule: [] } }
    const sources = { version: 'scene-cut-sources-v1', shotId: shot.id, referenceBindings: [] }
    const review = { version: 'scene-cut-first-frame-review-v1', passed: true, evidenceUrl,
      frame: { sourceUrl: candidateUrl, evidenceReferenceImage: referenceImage }, assets: [],
      firstRequiredVisualBeatId: '', requiredVisualActionChecks: [],
      observedOpening: { setting: '院落', characters: '张飞与严颜', bodyAndProps: '双腕受缚', actionStart: '尚未发问' },
      hardChecks: { setting: true, castAndIdentity: true, wardrobeAndEquipment: true,
        bodyAndProps: true, actionStartNotCompleted: true, allRequiredVisualActionsOpen: true,
        singleFullFrame: true }, issues: [] }
    const certificate = await issueSceneCutFrameApproval({ review, evidence, shot, sources,
      reviewExecutionId: 'model-run-output-test' }, root)
    const makeVideo = async (name: string, color: string) => {
      await exec(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=320x180:d=3:r=24`,
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3',
        '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
        path.join(dir, name)])
      return collectVideoEvidence({ url: `/generated/${name}`, continuityMode: 'scene_cut',
        visualTreatment: 'live_action', sceneCutFrameGate: certificate,
        sceneCutReferenceImage: candidateUrl }, root)
    }
    const matching = await makeVideo('matching.mp4', 'blue')
    assert.equal(matching.sceneCutOutputFirstFrame?.status, 'matched')
    assert.equal(matching.sceneCutOutputFirstFrame?.outputVideoSha256, matching.sha256)
    assert.equal(matching.sceneCutOutputFirstFrame?.decodedFirstFrameUrl, matching.frames[0])
    assert.equal(matching.sceneCutOutputFirstFrame?.candidateSha256, sha256(candidate))
    assert.equal(matching.sceneCutOutputFirstFrame?.decodedFirstFrameSha256,
      sha256(await readFile(path.join(root, 'public', matching.frames[0]))))
    const changed = await makeVideo('changed.mp4', 'red')
    assert.equal(changed.sceneCutOutputFirstFrame?.status, 'unverified')
    assert.ok(Number(changed.sceneCutOutputFirstFrame?.difference) > .1)
    for (const branch of [
      { continuityMode: 'tail_continuation', visualTreatment: 'live_action', sceneCutFrameGate: undefined },
      { continuityMode: 'coverage_cut', visualTreatment: 'live_action', sceneCutFrameGate: null },
      { continuityMode: 'scene_cut', visualTreatment: 'animated', sceneCutFrameGate: '' },
    ]) {
      const unrelated = await collectVideoEvidence({ url: '/generated/matching.mp4',
        ...branch, sceneCutReferenceImage: candidateUrl }, root)
      assert.equal(unrelated.sceneCutOutputFirstFrame, undefined,
        'a shared evidence node must not apply a live-action cut gate to another branch')
    }
    for (const gate of [undefined, null, '', {}]) {
      await assert.rejects(collectVideoEvidence({ url: '/generated/matching.mp4',
        continuityMode: 'scene_cut', visualTreatment: 'live_action', sceneCutFrameGate: gate,
        sceneCutReferenceImage: candidateUrl }, root), /SCENE_CUT_OUTPUT_EVIDENCE_INVALID/)
    }
    await assert.rejects(collectVideoEvidence({ url: '/generated/matching.mp4',
      continuityMode: 'coverage_cut', visualTreatment: 'live_action', sceneCutFrameGate: certificate,
      sceneCutReferenceImage: candidateUrl }, root), /SCENE_CUT_OUTPUT_EVIDENCE_INVALID/)
    await assert.rejects(collectVideoEvidence({ url: '/generated/matching.mp4',
      sceneCutFrameGate: { ...certificate, signature: '0'.repeat(64) },
      sceneCutReferenceImage: candidateUrl }, root), /SCENE_CUT_FRAME_APPROVAL_INVALID/)
    await assert.rejects(collectVideoEvidence({ url: '/generated/matching.mp4',
      sceneCutFrameGate: certificate, sceneCutReferenceImage: '/generated/other.png' }, root),
    /SCENE_CUT_OUTPUT_EVIDENCE_INVALID/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
