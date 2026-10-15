import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { executeCodeNode } from '../server/code-node.ts'
import { collectImageEvidence } from '../server/image-evidence.ts'
import { archiveSceneCutSources } from '../server/scene-cut-frame-storage.ts'
import { deriveSceneCutEllipsisProof, verifySceneCutEllipsisProof } from '../server/scene-cut-ellipsis-proof.ts'
import { assertSceneCutAcceptedSourceRecord } from '../server/scene-cut-source-ledger.ts'
import { assertSceneCutAcceptedSourceLedger } from '../server/scene-cut-source-ledger.ts'
import { validateSceneCutPaidImageRequest } from '../server/scene-cut-frame-runtime.ts'
import { deriveSceneCutOpeningPlan } from '../server/scene-cut-opening-plan.ts'
import { issueSceneCutFrameApproval, validateSceneCutVideoPayment,
  verifySceneCutFrameApproval } from '../server/scene-cut-frame-approval.ts'
import { SCENE_CUT_FRAME_EVIDENCE_PLAN_CODE, validateSceneCutFrameReview } from '../src/scene-cut-first-frame-gate.ts'
import { sceneCutEstablishmentBeat } from '../src/scene-cut-establishment.ts'
import { SCENE_CUT_FRAME_EVIDENCE_PLAN_CODE_V171, SCENE_CUT_FRAME_REVIEW_PROMPT_V171,
  upgradeSceneCutEllipsisWorkflow } from '../src/scene-cut-ellipsis-workflow.ts'
import { SCENE_CUT_FIRST_FRAME_PROMPT_V170,
  SCENE_CUT_FRAME_REVIEW_PROMPT_V170 } from '../src/scene-cut-opening-projection-workflow.ts'
import { renderWorkflowTemplate } from '../src/workflow-template.ts'

const interval = (second: number) => ({ lower: second, upper: second })
function fixture() {
  const first = { id: 'scene-01', dramaticUnitId: 'drama-01', visualTreatment: 'live_action',
    continuityMode: 'scene_cut', continuityFromPrevious: false, closesUnit: true,
    cast: ['主将', '俘虏'], requiredBeats: [{ id: 'b1', setting: '街口',
      observable: { visual: ['军士将俘虏双腕缚紧，主将走到面前'], audio: [] } }] }
  const second = { id: 'scene-02', dramaticUnitId: 'drama-02', visualTreatment: 'live_action',
    continuityMode: 'scene_cut', continuityFromPrevious: false, closesUnit: false,
    cast: ['主将', '俘虏'],
    adaptationBoundary: '由街口直接切至问讯，束缚和衣甲保持连续，不增拍无叙事增量的押送。',
    requiredBeats: [{ id: 'b2', setting: '问讯院落',
      observable: { visual: ['俘虏双腕被缚站在院落，主将开始问责'], audio: [] } }] }
  const approvedOutline = { passed: true, scenes: [first, second] }
  const priorShot = { id: 'scene-01', passed: true,
    storyProgress: { unitId: 'drama-01', status: 'complete', pendingActions: [] },
    pacing: { version: 'duration-v2', scheduleHash: 'schedule-1', beats: [
      { id: 'bind', sourceBeatId: 'b1', completion: { requiredThisClip: true } }] } }
  const shot = { id: 'scene-02', passed: true, continuity: { mode: 'scene_cut' },
    visualTreatment: 'live_action', firstFrameMode: 'reference', characters: ['主将', '俘虏'],
    visualPrompt: '东汉问讯院落，主将立于低阶，俘虏双腕已缚立于阶下。动作执行：随后主将俯身向俘虏发问。',
    camera: '东南侧平视全景。随后轻微跟摇。',
    pacing: { beats: [
      { id: 'establish', kind: 'action', completion: { requiredThisClip: true,
        evidenceAnchor: '主将站在低阶上；俘虏双腕被缚，站在阶下，两侧军士守住道路',
        finalState: '同一全景中清楚交代主将居阶上、俘虏被缚立于阶下的关系' } },
      { id: 'lean', kind: 'action', completion: { requiredThisClip: true,
        evidenceAnchor: '主将俯身向俘虏发问', finalState: '主将身体前倾' } },
    ], schedule: [{ beatId: 'establish', startSecond: 0 }, { beatId: 'lean', startSecond: 1.5 }] } }
  const lastFrameUrl = '/generated/prior-tail.png'
  const video = { qualityPolicy: 'principle-v1', qualityReview: { status: 'passed',
    canProceed: true, principleIssues: [] }, url: '/generated/prior.mp4',
    originalUrl: 'https://provider.example/prior.mp4',
    raw: { url: 'https://provider.example/prior.mp4', params: { scheduleHash: 'schedule-1' } },
    decoded: true, duration: 13, evidenceUrl: '/generated/prior-evidence.json',
    frames: ['/generated/prior-start.png', lastFrameUrl], lastFrameUrl,
    width: 320, height: 180, hasAudio: true, audioEmbedded: true,
    technicalValidation: { passed: true },
    visualReview: { passed: true, endingState: '主将走近俘虏，俘虏双腕已缚好',
      endingStateEvidence: { method: 'actual-tail-image', frame: lastFrameUrl } },
    durationCompletion: { applicable: true, assessment: 'complete', route: 'accept', passed: true,
      reasons: [], scheduleHash: 'schedule-1', evidenceRef: '/generated/prior-evidence.json',
      checks: [{ beatId: 'bind', sourceBeatId: 'b1', status: 'complete', reasons: [],
        observedStart: interval(2), observedEnd: interval(8) }],
      remainingMandatoryBeats: [], actualCompletionInterval: interval(8), requiredEndSecond: 9 } }
  const previous = { shot_script: priorShot, video_shot: video,
    last_frame: { available: true, url: lastFrameUrl, source: 'extracted-from-video' } }
  const runs = [
    { id: 'outline-run', node: { id: 'sanguo-scene-outline-accept' }, status: 'success', output: approvedOutline },
    { id: 'shot-1-run', node: { id: 'sanguo-shot-script-accept' }, loopIndex: 0, status: 'success', output: priorShot },
    { id: 'shot-2-run', node: { id: 'sanguo-shot-script-accept' }, loopIndex: 1, status: 'success', output: shot },
    { id: 'video-1-run', node: { id: 'sanguo-media-accept' }, loopIndex: 0, status: 'success', output: video },
    { id: 'tail-1-run', node: { id: 'sanguo-last-frame' }, loopIndex: 0, status: 'success', output: previous.last_frame },
  ]
  const record = { id: 'record-proof-test', workflow_id: 'wf-sanguo-history-drama', result: { nodeRuns: runs } }
  return { approvedOutline, priorShot, shot, video, previous, record }
}

test('accepted outline and prior media must match successful persisted node outputs', () => {
  const f = fixture()
  const binding = assertSceneCutAcceptedSourceRecord(f.record,
    { executionRecordId: f.record.id, approvedOutline: f.approvedOutline,
      shot: f.shot, previous: f.previous })
  assert.equal(binding.outlineRunId, 'outline-run')
  assert.equal(binding.priorVideoRunId, 'video-1-run')
  const patched = structuredClone(f.record)
  const outlineRun = patched.result.nodeRuns[0]
  outlineRun.output = { ...outlineRun.output,
    contextPatch: { approved_scene_outline: structuredClone(f.approvedOutline) } }
  assert.equal(assertSceneCutAcceptedSourceRecord(patched,
    { executionRecordId: patched.id, approvedOutline: f.approvedOutline,
      shot: f.shot, previous: f.previous }).outlineRunId, 'outline-run')
  outlineRun.output.contextPatch.approved_scene_outline.scenes[1].adaptationBoundary = '被改写'
  assert.throws(() => assertSceneCutAcceptedSourceRecord(patched,
    { executionRecordId: patched.id, approvedOutline: f.approvedOutline,
      shot: f.shot, previous: f.previous }), /SCENE_CUT_SOURCE_LEDGER_INVALID/)
  assert.throws(() => assertSceneCutAcceptedSourceRecord(f.record,
    { executionRecordId: f.record.id,
      approvedOutline: { ...f.approvedOutline, scenes: [...f.approvedOutline.scenes].reverse() },
      shot: f.shot, previous: f.previous }), /SCENE_CUT_SOURCE_LEDGER_INVALID/)
  assert.throws(() => assertSceneCutAcceptedSourceRecord(f.record,
    { executionRecordId: f.record.id, approvedOutline: f.approvedOutline,
      shot: f.shot, previous: { ...f.previous, video_shot: { ...f.video, duration: 12 } } }),
  /SCENE_CUT_SOURCE_LEDGER_INVALID/)
})

test('schema171 changes only five managed nodes and preserves legal cuts without an ellipsis tail', async () => {
  const nodes = [
    { id: 'sanguo-scene-cut-source-archive', params: [] },
    { id: 'sanguo-scene-cut-evidence-plan', code: SCENE_CUT_FRAME_EVIDENCE_PLAN_CODE },
    { id: 'sanguo-scene-cut-review', prompt: SCENE_CUT_FRAME_REVIEW_PROMPT_V170 },
    { id: 'sanguo-video', params: [] },
    { id: 'sanguo-video-evidence', params: [] },
    { id: 'manual', prompt: 'keep me', params: [] },
  ]
  const graph = { id: 'wf-sanguo-history-drama', schemaVersion: 170, nodes,
    edges: [{ id: 'edge', from: 'manual', to: 'sanguo-video' }] }
  const migrated = upgradeSceneCutEllipsisWorkflow(graph)
  assert.equal(migrated.schemaVersion, 171)
  assert.equal(migrated.edges, graph.edges)
  assert.equal(migrated.nodes.find(node => node.id === 'manual'), nodes.at(-1))
  assert.deepEqual(migrated.nodes.filter((node, index) => node !== nodes[index]).map(node => node.id),
    ['sanguo-scene-cut-source-archive', 'sanguo-scene-cut-evidence-plan',
      'sanguo-scene-cut-review', 'sanguo-video', 'sanguo-video-evidence'])
  assert.equal(upgradeSceneCutEllipsisWorkflow(migrated), migrated)
  assert.equal(upgradeSceneCutEllipsisWorkflow({ ...migrated, schemaVersion: 172 }).schemaVersion, 172)
  assert.match(migrated.nodes.find(node => node.id === 'sanguo-video-evidence')?.params?.find(
    param => param.englishName === 'visualTreatment')?.value ?? '', /video_take\.params\.visualTreatment/)
  assert.match(SCENE_CUT_FRAME_REVIEW_PROMPT_V171, /静态建立节拍.*terminalStateAlreadyPresent=true/s)
  const firstShot = { id: 'scene-01' }
  const outline = { scenes: [{ id: 'scene-01' }] }
  const independent = deriveSceneCutEllipsisProof({ shot: firstShot, approvedOutline: outline })
  assert.equal(independent.approvedEllipsis, undefined)
  const noTail = await executeCodeNode({ code: SCENE_CUT_FRAME_EVIDENCE_PLAN_CODE_V171,
    params: { frame: { url: '/generated/candidate.png' },
      sources: { version: 'scene-cut-sources-v1', referenceBindings: [] } } })
  assert.deepEqual((noTail.items as unknown[]).length, 1)
})

test('approved ellipsis signs the actual decoded prior tail, candidate and outline pair', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scene-cut-ellipsis-'))
  const dir = path.join(root, 'public/generated')
  await mkdir(dir, { recursive: true })
  const f = fixture()
  const tail = await sharp({ create: { width: 320, height: 180, channels: 3,
    background: '#6b584b' } }).png().toBuffer()
  const portrait = await sharp({ create: { width: 180, height: 360, channels: 3,
    background: '#805f42' } }).png().toBuffer()
  await writeFile(path.join(dir, 'prior.mp4'), Buffer.from('frozen accepted video bytes'))
  await writeFile(path.join(dir, 'prior-tail.png'), tail)
  await writeFile(path.join(dir, 'candidate.png'), tail)
  await writeFile(path.join(dir, 'actor-one.png'), portrait)
  await writeFile(path.join(dir, 'actor-two.png'), portrait)
  const acceptedRecordBinding = assertSceneCutAcceptedSourceRecord(f.record,
    { executionRecordId: f.record.id, approvedOutline: f.approvedOutline,
      shot: f.shot, previous: f.previous })
  const proof = deriveSceneCutEllipsisProof({ shot: f.shot,
    approvedOutline: f.approvedOutline, previous: f.previous }, root)
  assert.equal(proof.approvedEllipsis?.priorTailUrl, '/generated/prior-tail.png')
  const sources = await archiveSceneCutSources({ shot: f.shot,
    referenceBindings: [
      { characterName: '主将', assetId: 'actor-1' },
      { characterName: '俘虏', assetId: 'actor-2' }],
    referenceImages: ['/generated/actor-one.png', '/generated/actor-two.png'],
    identityPlateVersion: 'scene-cut-identity-plate-v3',
    sceneCutBoundaryVersion: 'scene-cut-approved-boundary-v1',
    approvedOutline: f.approvedOutline, previous: f.previous, acceptedRecordBinding }, root)
  assert.deepEqual(verifySceneCutEllipsisProof(sources, f.shot, root), proof)
  const mockPool = { query: async () => ({ rows: [f.record] }) }
  assert.deepEqual(await assertSceneCutAcceptedSourceLedger(mockPool, f.shot, sources),
    acceptedRecordBinding)
  const openingPlan = deriveSceneCutOpeningPlan(f.shot, 3)
  const paidImage = { model: { id: 'codex-gpt-image-2', provider: 'Codex',
    capability: 'image', settings: {} },
  prompt: renderWorkflowTemplate(SCENE_CUT_FIRST_FRAME_PROMPT_V170,
    { shot_script: f.shot, scene_cut_sources: sources, scene_cut_opening_state: openingPlan }),
  params: { sceneCutShot: f.shot, sceneCutSources: sources,
    sceneCutOpeningPlan: openingPlan, referenceImages: sources.imageReferenceImages,
    singleFrame: true, size: '1536x864' },
  executionContext: { workflowId: 'wf-sanguo-history-drama',
    nodeId: 'sanguo-scene-cut-first-frame' } }
  await assert.doesNotReject(validateSceneCutPaidImageRequest(paidImage, root, 171))
  await assert.rejects(validateSceneCutPaidImageRequest({ ...paidImage,
    params: { ...paidImage.params, sceneCutSources: { ...sources, approvedEllipsis: undefined } } }, root, 171),
  /SCENE_CUT_ELLIPSIS_INVALID/)
  const plan = await executeCodeNode({ code: SCENE_CUT_FRAME_EVIDENCE_PLAN_CODE_V171,
    params: { frame: { url: '/generated/candidate.png' }, sources } })
  assert.deepEqual((plan.items as { role: string }[]).map(item => item.role),
    ['candidate_first', 'identity', 'identity', 'prior_actual_tail'])
  const evidence = await collectImageEvidence({ items: plan.items as Record<string, unknown>[] }, root)
  const review = { version: 'scene-cut-first-frame-review-v1', passed: true,
    evidenceUrl: evidence.evidenceUrl,
    frame: { sourceUrl: evidence.items[0].url,
      evidenceReferenceImage: evidence.items[0].referenceImage },
    assets: sources.referenceBindings.map((binding, index) => ({ characterName: binding.characterName,
      assetId: binding.assetId, sourceUrl: binding.url,
      evidenceReferenceImage: evidence.items[index + 1].referenceImage })),
    priorTail: { sourceUrl: evidence.items.at(-1)!.url,
      evidenceReferenceImage: evidence.items.at(-1)!.referenceImage },
    firstRequiredVisualBeatId: 'establish',
    requiredVisualActionChecks: [
      { beatId: 'establish', observedT0: '主将立于阶上，俘虏已缚立阶下',
        terminalStateAlreadyPresent: true, establishedStateVisible: true, approvedResetBeatId: '' },
      { beatId: 'lean', observedT0: '主将仍立直，尚未俯身',
        terminalStateAlreadyPresent: false, actionStillPossible: true,
        remainingActionEvidence: '躯干仍可前倾', approvedResetBeatId: '' },
    ], observedOpening: { setting: '问讯院落', characters: '主将俘虏',
      bodyAndProps: '俘虏双腕被缚', actionStart: '主将尚未俯身' },
    hardChecks: { setting: true, castAndIdentity: true, wardrobeAndEquipment: true,
      bodyAndProps: true, actionStartNotCompleted: true,
      allRequiredVisualActionsOpen: true, singleFullFrame: true },
    transitionContinuityCheck: { applicable: true, sameCharacters: true,
      sameWardrobeAndEquipment: true, sameRestraintState: true,
      priorTailShowsCompletedState: true, newSettingLegible: true,
      relativeBlockingPlausible: true,
      pixelEvidence: { characters: '两人面容一致', wardrobeAndEquipment: '衣甲一致',
        restraint: '俘虏两腕同位已缚', completedState: '前尾两人已接近',
        newSetting: '院落台阶可见', blocking: '二人相对位置可成立' } }, issues: [] }
  assert.equal(sceneCutEstablishmentBeat(f.shot.pacing.beats[0]), true)
  assert.equal(sceneCutEstablishmentBeat(f.shot.pacing.beats[1]), false)
  const base = validateSceneCutFrameReview(review, evidence, f.shot, sources)
  assert.equal(base.priorTail?.sourceUrl, '/generated/prior-tail.png')
  const wrongTail = structuredClone(review)
  wrongTail.priorTail.sourceUrl = '/generated/candidate.png'
  assert.throws(() => validateSceneCutFrameReview(wrongTail, evidence, f.shot, sources),
    /SCENE_CUT_FRAME_REJECTED/)
  const uncertainRestraint = structuredClone(review)
  uncertainRestraint.transitionContinuityCheck.sameRestraintState = false
  assert.throws(() => validateSceneCutFrameReview(uncertainRestraint, evidence, f.shot, sources),
    /SCENE_CUT_FRAME_REJECTED/)
  const falseTableau = structuredClone(review)
  falseTableau.requiredVisualActionChecks[0].establishedStateVisible = false
  assert.throws(() => validateSceneCutFrameReview(falseTableau, evidence, f.shot, sources),
    /SCENE_CUT_FRAME_REJECTED/)
  const prematureLean = structuredClone(review)
  prematureLean.requiredVisualActionChecks[1].terminalStateAlreadyPresent = true
  assert.throws(() => validateSceneCutFrameReview(prematureLean, evidence, f.shot, sources),
    /SCENE_CUT_FRAME_REJECTED/)
  const certificate = await issueSceneCutFrameApproval({ review, evidence,
    shot: f.shot, sources, reviewExecutionId: 'model-run-ellipsis-test' }, root)
  assert.equal(verifySceneCutFrameApproval(certificate, root).approvedEllipsis?.priorTailSha256,
    proof.approvedEllipsis?.priorTailSha256)
  const paid = { continuityMode: 'scene_cut', sceneCutShot: f.shot,
    sceneCutFrameGate: certificate, sceneCutSources: sources,
    referenceImage: '/generated/candidate.png',
    referenceImages: sources.referenceImages,
    referenceBindings: sources.referenceBindings }
  assert.equal(validateSceneCutVideoPayment(paid, root).signature, certificate.signature)
  await writeFile(path.join(dir, 'prior.mp4'), Buffer.from('tampered prior video'))
  assert.throws(() => verifySceneCutFrameApproval(certificate, root),
    /SCENE_CUT_FRAME_APPROVAL_INVALID/)
  await writeFile(path.join(dir, 'prior.mp4'), Buffer.from('frozen accepted video bytes'))
  await writeFile(path.join(dir, 'prior-tail.png'), await sharp(tail).negate().png().toBuffer())
  assert.throws(() => verifySceneCutFrameApproval(certificate, root),
    /SCENE_CUT_FRAME_APPROVAL_INVALID/)
  assert.notDeepEqual(await readFile(path.join(dir, 'prior-tail.png')), tail)
})
