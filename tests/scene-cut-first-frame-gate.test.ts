import test from 'node:test'
import assert from 'node:assert/strict'
import { sceneCutEstablishmentBeat } from '../src/scene-cut-establishment.ts'

test('stopping beside a captive after crossing a threshold is a later action', () => {
  assert.equal(sceneCutEstablishmentBeat({ kind: 'action', dependsOn: ['action-cross-threshold'],
    completion: { requiredThisClip: true,
      evidenceAnchor: '军士停在严颜两侧，张飞站在厅内正面。',
      finalState: '军士分停严颜两侧，控制关系在同框内清楚可见。' } }), false)
})
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { executeCodeNode } from '../server/code-node.ts'
import { collectImageEvidence } from '../server/image-evidence.ts'
import { callKlingVideo } from '../server/model-adapters.ts'
import { archiveSceneCutSources, buildSceneCutIdentityPlate } from '../server/scene-cut-frame-storage.ts'
import { deriveSceneCutOpeningPlan } from '../server/scene-cut-opening-plan.ts'
import { issueSceneCutFrameApproval, validateSceneCutVideoPayment,
  verifySceneCutFrameApproval } from '../server/scene-cut-frame-approval.ts'
import { assertSceneCutReviewLedgerRecord, issueRecordedSceneCutFrameApproval, validateSceneCutPaidImageRequest,
  validateSceneCutPaidVideoRequest } from '../server/scene-cut-frame-runtime.ts'
import { SANGUO_FIRST_FRAME_BRANCH_CODE } from '../src/code-node-presets.ts'
import { upgradeCoverageCutFrameWorkflow } from '../src/coverage-cut-frame-gate.ts'
import { SCENE_CUT_FRAME_EVIDENCE_PLAN_CODE, SCENE_CUT_FRAME_REVIEW_PROMPT,
  SCENE_CUT_FIRST_FRAME_PROMPT, upgradeSceneCutFirstFrameWorkflow,
  upgradeSceneCutOpeningStateWorkflow, validateSceneCutFrameReview } from '../src/scene-cut-first-frame-gate.ts'
import { SCENE_CUT_FRAME_REVIEW_PROMPT_V167 } from '../src/scene-cut-t0-image-contract.ts'
import { SCENE_CUT_FIRST_FRAME_PROMPT_V168, SCENE_CUT_FRAME_REVIEW_PROMPT_V168,
  validateSceneCutStanceStartReview } from '../src/scene-cut-opening-plan-workflow.ts'
import { SCENE_CUT_FIRST_FRAME_PROMPT_V169, SCENE_CUT_FRAME_REVIEW_PROMPT_V169,
  validateSceneCutTravelStartReview } from '../src/scene-cut-travel-start-workflow.ts'
import { renderWorkflowTemplate } from '../src/workflow-template.ts'

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const shot = { id: 'scene-01', continuity: { mode: 'scene_cut' }, firstFrameMode: 'reference',
  visualTreatment: 'live_action', characters: ['严颜'], visualPrompt: '江州院落，严颜双腕身前待收绳',
  camera: '正面中景', characterEquipment: { '严颜': '身前麻绳' }, pacing: {
    beats: [{ id: 'bind', kind: 'action', textOrVocalization: '军士在严颜腕上收紧绳结。',
      completion: { modality: 'visual', requiredThisClip: true,
        evidenceAnchor: '军士在严颜腕上收紧绳结。', finalState: '绳结收紧' } },
    { id: 'stand', kind: 'action', textOrVocalization: '严颜将双脚踏稳，挺直背脊。',
      completion: { modality: 'visual', requiredThisClip: true,
        evidenceAnchor: '严颜将双脚踏稳，挺直背脊。', finalState: '背脊挺直' } }],
    schedule: [{ beatId: 'bind', startSecond: 0, endSecond: 1.9 },
      { beatId: 'stand', startSecond: 1.9, endSecond: 3.5 }],
  } }

test('single portrait is not mistaken for a vertical three-view sheet', async () => {
  const portrait = await sharp({ create: { width: 180, height: 480, channels: 3,
    background: { r: 90, g: 60, b: 30 } } }).png().toBuffer()
  const single = await buildSceneCutIdentityPlate(portrait)
  const vertical = await buildSceneCutIdentityPlate(portrait, 'vertical-three-view')
  assert.equal(single.layout, 'single-portrait')
  assert.equal(vertical.layout, 'vertical-three-view')
  assert.notEqual(single.lowerSha256, vertical.lowerSha256)
  await assert.rejects(buildSceneCutIdentityPlate(portrait, 'horizontal-three-view'),
    /SCENE_CUT_SOURCE_INVALID/)
})

test('schema 165 inserts signed scene-cut opening chain and preserves unrelated graph bytes', () => {
  const common = { title: 'kept', prompt: 'manual', params: [], uploads: [], loop: {},
    position: { x: 0, y: 0 } }
  const owner = { ...common, id: 'sanguo-scene-loop', kind: 'loop',
    childIds: ['sanguo-first-frame-branch', 'sanguo-video'] }
  const branch = { ...common, id: 'sanguo-first-frame-branch', kind: 'code',
    code: SANGUO_FIRST_FRAME_BRANCH_CODE }
  const video = { ...common, id: 'sanguo-video', kind: 'video', params: [] }
  const untouched = { ...common, id: 'user-custom-node', kind: 'code', code: 'return { manual: true }' }
  const base = upgradeCoverageCutFrameWorkflow({ id: 'wf-sanguo-history-drama',
    schemaVersion: 154, nodes: [owner, branch, untouched, video],
    edges: [{ id: 'old', from: branch.id, to: video.id }] })
  assert.equal(base.schemaVersion, 157)
  const input = { ...base, schemaVersion: 164 }
  const upgraded = upgradeSceneCutFirstFrameWorkflow(input)
  assert.equal(upgraded.schemaVersion, 165)
  assert.equal(upgraded.nodes.find(node => node.id === untouched.id), untouched)
  assert.equal(input.nodes.length + 6, upgraded.nodes.length)
  const ids = ['sanguo-scene-cut-source-archive', 'sanguo-scene-cut-first-frame',
    'sanguo-scene-cut-evidence-plan', 'sanguo-scene-cut-evidence',
    'sanguo-scene-cut-review', 'sanguo-scene-cut-approval']
  const order = upgraded.nodes.find(node => node.id === owner.id)!.childIds!
  assert.ok(order.indexOf('sanguo-coverage-approval') < order.indexOf(ids[0]))
  assert.ok(order.indexOf(ids.at(-1)!) < order.indexOf('sanguo-video-reference-router'))
  for (const id of ids) assert.deepEqual(upgraded.nodes.find(node => node.id === id)?.runIf,
    { path: 'first_frame_branch.shouldGenerateSceneFrame', equals: true })
  assert.equal(upgraded.nodes.find(node => node.id === ids[1])?.modelId, 'codex-gpt-image-2')
  assert.equal(upgraded.nodes.find(node => node.id === ids[0])?.params?.find(param =>
    param.englishName === 'referenceImages')?.value, '${first_frame_branch.referenceRequest.referenceImages}')
  assert.match(upgraded.nodes.find(node => node.id === branch.id)?.code ?? '',
    /shouldGenerateSceneFrame = requestedMode === 'reference'.*shot_script\.continuity\.mode/)
  const sequence = ['sanguo-coverage-approval', ...ids, 'sanguo-video-reference-router']
  for (let index = 0; index < sequence.length - 1; index++)
    assert.ok(upgraded.edges.some(edge => edge.from === sequence[index] && edge.to === sequence[index + 1]))
  assert.equal(upgraded.edges.some(edge => edge.from === sequence[0] && edge.to === sequence.at(-1)), false)
  const videoParams = upgraded.nodes.find(node => node.id === video.id)?.params ?? []
  assert.equal(videoParams.find(param => param.englishName === 'sceneCutFrameGate')?.value,
    '${scene_cut_frame_gate}')
  assert.equal(videoParams.find(param => param.englishName === 'sceneCutShot')?.value, '${shot_script}')
  assert.equal(upgradeSceneCutFirstFrameWorkflow(upgraded), upgraded)
  const oldSchema = { ...input, schemaVersion: 163 }
  assert.equal(upgradeSceneCutFirstFrameWorkflow(oldSchema), oldSchema)
  const oldImagePrompt = SCENE_CUT_FIRST_FRAME_PROMPT.split('\n【零秒动作余地优先于静态构图·v2】')[0]
  const oldReviewPrompt = SCENE_CUT_FRAME_REVIEW_PROMPT.split('\n【逐节拍剩余动作与空间·v2】')[0]
    .replace(',"actionStillPossible":false,"remainingActionEvidence":"实见的继续动作余地或空间路径"', '')
  const persisted165 = { ...upgraded, nodes: upgraded.nodes.map(node => node.id === 'sanguo-scene-cut-first-frame'
    ? { ...node, prompt: oldImagePrompt }
    : node.id === 'sanguo-scene-cut-review' ? { ...node, prompt: oldReviewPrompt } : node) }
  const tightened = upgradeSceneCutOpeningStateWorkflow(persisted165)
  assert.equal(tightened.schemaVersion, 166)
  assert.equal(tightened.nodes.length, persisted165.nodes.length)
  assert.equal(tightened.edges, persisted165.edges)
  assert.equal(tightened.nodes.find(node => node.id === 'sanguo-scene-cut-first-frame')?.prompt,
    SCENE_CUT_FIRST_FRAME_PROMPT)
  assert.equal(tightened.nodes.find(node => node.id === 'sanguo-scene-cut-review')?.prompt,
    SCENE_CUT_FRAME_REVIEW_PROMPT)
  assert.equal(upgradeSceneCutOpeningStateWorkflow(tightened), tightened)
  assert.equal(upgradeSceneCutFirstFrameWorkflow(tightened), tightened)
  assert.equal(upgradeCoverageCutFrameWorkflow(tightened), tightened)
  let repeatedlyHydrated = tightened
  for (let count = 0; count < 20; count++) {
    repeatedlyHydrated = upgradeSceneCutOpeningStateWorkflow(upgradeSceneCutFirstFrameWorkflow(
      upgradeCoverageCutFrameWorkflow(repeatedlyHydrated)))
    assert.equal(repeatedlyHydrated, tightened)
    assert.equal(repeatedlyHydrated.schemaVersion, 166)
  }
  const future = { ...tightened, schemaVersion: 167 }
  assert.equal(upgradeSceneCutOpeningStateWorkflow(future), future)
  assert.equal(upgradeSceneCutFirstFrameWorkflow(future), future)
  assert.equal(upgradeCoverageCutFrameWorkflow(future), future)
  const userEdited = { ...persisted165, nodes: persisted165.nodes.map(node => node.id === 'sanguo-scene-cut-review'
    ? { ...node, prompt: `${node.prompt}\n用户定制` } : node) }
  assert.equal(upgradeSceneCutOpeningStateWorkflow(userEdited), userEdited)
})

test('actual archived identity bytes, t=0 picture and independent model record sign exact paid inputs', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scene-cut-frame-'))
  try {
    const dir = path.join(root, 'public/generated')
    await mkdir(dir, { recursive: true })
    const triptych = await sharp({ create: { width: 900, height: 300, channels: 3,
      background: { r: 90, g: 70, b: 50 } } }).png().toBuffer()
    const candidate = await sharp({ create: { width: 320, height: 180, channels: 3,
      background: { r: 80, g: 60, b: 40 } } }).png().toBuffer()
    await writeFile(path.join(dir, 'yan-triptych.png'), triptych)
    await writeFile(path.join(dir, 'candidate.png'), candidate)
    const sources = await archiveSceneCutSources({ shot,
      referenceBindings: [{ characterName: '严颜', assetId: 'asset-yan',
        role: 'identity', metadata: { visualProfile: { referenceImage: '/generated/asset.png' } } }],
      referenceImages: ['/generated/yan-triptych.png'] }, root)
    await assert.rejects(archiveSceneCutSources({ shot,
      referenceBindings: [{ characterName: '严颜', assetId: 'asset-yan',
        url: '/generated/stale.png' }], referenceImages: ['/generated/yan-triptych.png'] }, root),
    /SCENE_CUT_SOURCE_INVALID/)
    assert.equal(sources.referenceBindings.length, 1)
    assert.deepEqual(sources.referenceImages, [sources.referenceBindings[0].url])
    assert.match(sources.referenceBindings[0].frontUrl, /^\/generated\/scene-cut-front-[a-f0-9]{64}\.jpg$/)
    assert.equal(sources.identityPlateVersion, 'scene-cut-identity-plate-v2')
    assert.equal(sha256(await readFile(path.join(root, 'public', sources.referenceBindings[0].frontUrl))),
      sources.referenceBindings[0].frontSha256)
    const original = await readFile(path.join(root, 'public', sources.referenceBindings[0].url))
    const plate = await buildSceneCutIdentityPlate(original)
    assert.deepEqual(await readFile(path.join(root, 'public', sources.referenceBindings[0].frontUrl)), plate.plate)
    assert.equal(sources.referenceBindings[0].upperSha256, plate.upperSha256)
    assert.equal(sources.referenceBindings[0].lowerSha256, plate.lowerSha256)
    assert.equal((await sharp(plate.plate).metadata()).width, 640)
    const paidImage = { model: { id: 'codex-gpt-image-2', provider: 'Codex', capability: 'image', settings: {} },
      prompt: '零秒画面', params: { referenceImages: sources.imageReferenceImages,
        sceneCutSources: sources, sceneCutShot: shot, singleFrame: true, size: '1536x864' },
      executionContext: { workflowId: 'wf-sanguo-history-drama', nodeId: 'sanguo-scene-cut-first-frame' } }
    await assert.doesNotReject(validateSceneCutPaidImageRequest(paidImage, root))
    await assert.rejects(validateSceneCutPaidImageRequest({ ...paidImage,
      params: { ...paidImage.params, referenceImages: ['data:image/jpeg;base64,bad'] } }, root),
    /SCENE_CUT_FRAME_BLOCKED/)
    const openingStatePlan = deriveSceneCutOpeningPlan(shot)
    const strictImage = { ...paidImage,
      prompt: renderWorkflowTemplate(SCENE_CUT_FIRST_FRAME_PROMPT_V168,
        { shot_script: shot, scene_cut_sources: sources, scene_cut_opening_state: openingStatePlan }),
      params: { ...paidImage.params, sceneCutOpeningPlan: openingStatePlan } }
    await assert.doesNotReject(validateSceneCutPaidImageRequest(strictImage, root, 168))
    await assert.rejects(validateSceneCutPaidImageRequest(paidImage, root, 168),
      /SCENE_CUT_FRAME_BLOCKED/)
    await assert.rejects(validateSceneCutPaidImageRequest({ ...strictImage,
      params: { ...strictImage.params, sceneCutOpeningPlan: { ...openingStatePlan, shotId: 'other' } } }, root, 168),
    /SCENE_CUT_FRAME_BLOCKED/)
    const travelingShot = { ...shot, visualPrompt: '江州院落全身画面，严颜待收绳，厅门在背后',
      pacing: { ...shot.pacing, beats: [...shot.pacing.beats,
        { id: 'escort', kind: 'action', textOrVocalization: '军士押严颜朝厅门走去。',
          completion: { modality: 'visual', requiredThisClip: true,
            evidenceAnchor: '军士押严颜朝厅门走去。', finalState: '到达厅门外' } }],
      schedule: [...shot.pacing.schedule, { beatId: 'escort', startSecond: 4, endSecond: 9 }] } }
    const openingStatePlanV2 = deriveSceneCutOpeningPlan(travelingShot, 2)
    const strictImageV2 = { ...paidImage,
      prompt: renderWorkflowTemplate(SCENE_CUT_FIRST_FRAME_PROMPT_V169,
        { shot_script: travelingShot, scene_cut_sources: sources,
          scene_cut_opening_state: openingStatePlanV2 }),
      params: { ...paidImage.params, sceneCutShot: travelingShot,
        sceneCutOpeningPlan: openingStatePlanV2 } }
    await assert.doesNotReject(validateSceneCutPaidImageRequest(strictImageV2, root, 169))
    await assert.rejects(validateSceneCutPaidImageRequest({ ...strictImageV2,
      prompt: renderWorkflowTemplate(SCENE_CUT_FIRST_FRAME_PROMPT_V168,
        { shot_script: travelingShot, scene_cut_sources: sources,
          scene_cut_opening_state: openingStatePlanV2 }) }, root, 169),
    /SCENE_CUT_FRAME_BLOCKED/)
    await assert.rejects(validateSceneCutPaidImageRequest(strictImageV2, root, 168),
      /SCENE_CUT_FRAME_BLOCKED/)
    const plan = await executeCodeNode({ code: SCENE_CUT_FRAME_EVIDENCE_PLAN_CODE,
      params: { frame: { url: '/generated/candidate.png' }, sources } })
    const evidence = await collectImageEvidence({ items: plan.items as Record<string, unknown>[] }, root)
    const review = { version: 'scene-cut-first-frame-review-v1', passed: true,
      evidenceUrl: evidence.evidenceUrl, frame: { sourceUrl: evidence.items[0].url,
        evidenceReferenceImage: evidence.items[0].referenceImage },
      assets: [{ characterName: '严颜', assetId: 'asset-yan', sourceUrl: evidence.items[1].url,
        evidenceReferenceImage: evidence.items[1].referenceImage }], firstRequiredVisualBeatId: 'bind',
      requiredVisualActionChecks: [
        { beatId: 'bind', observedT0: '双腕身前，绳端松开待收', terminalStateAlreadyPresent: false,
          actionStillPossible: true, remainingActionEvidence: '绳端仍有松量，军士可继续牵紧',
          manipulationStartCheck: { applicable: true, slackOrGapVisible: true,
            operatingEndUntensioned: true, unfinishedFastenerVisible: true,
            pixelEvidence: '腕绳有空隙，操作端弧线下垂，绳结尚未闭合' },
          approvedResetBeatId: '' },
        { beatId: 'stand', observedT0: '严颜屈膝，背脊未完全挺直', terminalStateAlreadyPresent: false,
          actionStillPossible: true, remainingActionEvidence: '双膝微屈，脊柱仍可伸展',
          stanceStartCheck: { applicable: true, bentKneeOrUnsettledWeightVisible: true,
            torsoNotFullyStraight: true, pixelEvidence: '双膝微屈，背脊前倾未直' },
          approvedResetBeatId: '' },
      ],
      observedOpening: { setting: '院落', characters: '严颜', bodyAndProps: '身前双腕、松绳',
        actionStart: '军士刚抓住绳端，尚未收紧' },
      wardrobeHemCheck: { applicable: true, originalHemAndFootwear: '灰褐长袍下摆、布靴',
        candidateHemAndFootwear: '灰褐长袍下摆、布靴', matches: true },
      hardChecks: { setting: true, castAndIdentity: true, wardrobeAndEquipment: true,
        bodyAndProps: true, actionStartNotCompleted: true, allRequiredVisualActionsOpen: true,
        singleFullFrame: true }, issues: [] }
    assert.match(SCENE_CUT_FRAME_REVIEW_PROMPT, /逐条检查所有 requiredThisClip 视觉动作/)
    assert.match(SCENE_CUT_FIRST_FRAME_PROMPT, /匿名群体演员：\$\{shot_script\.pacing\.actorGroups\}/)
    assert.equal(validateSceneCutFrameReview(review, evidence, shot, sources).firstRequiredVisualBeatId, 'bind')
    const risky = { ...review, passed: false, issues: ['首帧动作起点未核实'],
      hardChecks: { ...review.hardChecks, actionStartNotCompleted: false },
      requiredVisualActionChecks: [{ ...review.requiredVisualActionChecks[0],
        actionStillPossible: false }, review.requiredVisualActionChecks[1]] }
    assert.throws(() => validateSceneCutFrameReview(risky, evidence, shot, sources),
      /SCENE_CUT_FRAME_REJECTED/)
    const advisory = validateSceneCutFrameReview(risky, evidence, shot, sources,
      { allowReviewRisks: true })
    assert.equal(advisory.passed, true)
    assert.equal(advisory.deferredToUser, true)
    assert.equal(advisory.qualityRisks?.[0]?.issue, '首帧动作起点未核实')
    assert.equal(advisory.requiredVisualActionChecks[0].actionStillPossible, false)
    assert.equal(validateSceneCutFrameReview({ ...review,
      priorTail: { sourceUrl: '', evidenceReferenceImage: '' },
      transitionContinuityCheck: { applicable: false } }, evidence, shot, sources).passed, true)
    assert.throws(() => validateSceneCutFrameReview({ ...review,
      priorTail: { sourceUrl: '/generated/unapproved.png', evidenceReferenceImage: '' },
      transitionContinuityCheck: { applicable: false } }, evidence, shot, sources),
    /非批准省略切场/)
    assert.equal(validateSceneCutStanceStartReview(review, shot), true)
    assert.throws(() => validateSceneCutFrameReview({ ...review,
      hardChecks: { ...review.hardChecks, actionStartNotCompleted: false } }, evidence, shot, sources),
    /SCENE_CUT_FRAME_REJECTED/)
    let approvalLedgerQueries = 0
    await assert.rejects(issueRecordedSceneCutFrameApproval({ query: async () => {
      approvalLedgerQueries += 1
      return { rows: [] }
    } }, { review: { ...review, passed: false,
      issues: ['双脚及背脊已完全挺直，待收紧绳结无法从画面确认'] }, evidence, shot, sources }, root),
    /SCENE_CUT_FRAME_REJECTED:.*双脚及背脊已完全挺直/)
    assert.equal(approvalLedgerQueries, 0)
    assert.throws(() => validateSceneCutFrameReview({ ...review,
      requiredVisualActionChecks: review.requiredVisualActionChecks.slice(0, 1) }, evidence, shot, sources),
    /SCENE_CUT_FRAME_REJECTED/)
    assert.throws(() => validateSceneCutFrameReview({ ...review,
      requiredVisualActionChecks: [review.requiredVisualActionChecks[0],
        { ...review.requiredVisualActionChecks[1], observedT0: '已完全站直', terminalStateAlreadyPresent: true }] },
    evidence, shot, sources), /SCENE_CUT_FRAME_REJECTED/)
    assert.throws(() => validateSceneCutFrameReview({ ...review,
      requiredVisualActionChecks: [review.requiredVisualActionChecks[0],
        { ...review.requiredVisualActionChecks[1], actionStillPossible: false,
          remainingActionEvidence: '离目标已无可见距离' }] }, evidence, shot, sources),
    /SCENE_CUT_FRAME_REJECTED/)
    const expected = { evidence, shot, sources, reviewImages: evidence.reviewImages }
    const reviewed = { ...review, raw: { providerResponse: 'original model result' }, model: 'codex-local-vision' }
    const ledger = { id: 'model-run-scene-cut-fixture', channel: 'workflow',
      workflow_id: 'wf-sanguo-history-drama', node_id: 'sanguo-scene-cut-review',
      model_id: 'codex-local-vision', capability: 'text', provider: 'Codex', status: 'succeeded', request_data: {
        fingerprint: 'a'.repeat(64), params: expected,
        prompt: renderWorkflowTemplate(SCENE_CUT_FRAME_REVIEW_PROMPT_V167,
          { scene_cut_evidence: evidence, shot_script: shot, scene_cut_sources: sources }),
        reviewImageHashes: await Promise.all(evidence.reviewImages.map(async url => ({ url,
          sha256: sha256(await readFile(path.join(root, 'public', url))) }))),
      }, response_data: { text: JSON.stringify(review) } }
    const reviewExecutionId = assertSceneCutReviewLedgerRecord(ledger, reviewed, expected, root)
    const strictExpected = { ...expected, openingStatePlan }
    const strictLedger = { ...ledger, request_data: { ...ledger.request_data,
      params: strictExpected, prompt: renderWorkflowTemplate(SCENE_CUT_FRAME_REVIEW_PROMPT_V168,
        { scene_cut_evidence: evidence, shot_script: shot, scene_cut_sources: sources,
          scene_cut_opening_state: openingStatePlan }) } }
    assert.equal(assertSceneCutReviewLedgerRecord(strictLedger, reviewed, strictExpected, root), reviewExecutionId)
    const travelReview = { ...review, requiredVisualActionChecks: [...review.requiredVisualActionChecks,
      { beatId: 'escort', observedT0: '三人原地，尚未起步', terminalStateAlreadyPresent: false,
        actionStillPossible: true, remainingActionEvidence: '仍可转身走向背后的厅门',
        travelStartCheck: { applicable: true, atApprovedOrigin: true,
          feetInspectionRequired: true, allParticipantsFeetGrounded: true,
          noStrideInProgress: true, destinationNotReached: true, routeStillPossible: true,
          pixelEvidence: '三人双足均落地，厅门在背后仍可转身步行' },
        approvedResetBeatId: '' }] }
    const reviewedV2 = { ...travelReview, raw: { providerResponse: 'original model result' },
      model: 'codex-local-vision' }
    assert.equal(validateSceneCutTravelStartReview(travelReview, travelingShot), true)
    const strictExpectedV2 = { evidence, shot: travelingShot, sources,
      reviewImages: evidence.reviewImages, openingStatePlan: openingStatePlanV2 }
    const strictLedgerV2 = { ...ledger, request_data: { ...ledger.request_data,
      params: strictExpectedV2,
      prompt: renderWorkflowTemplate(SCENE_CUT_FRAME_REVIEW_PROMPT_V169,
        { scene_cut_evidence: evidence, shot_script: travelingShot, scene_cut_sources: sources,
          scene_cut_opening_state: openingStatePlanV2 }) },
    response_data: { text: JSON.stringify(travelReview) } }
    assert.equal(assertSceneCutReviewLedgerRecord(strictLedgerV2, reviewedV2,
      strictExpectedV2, root), reviewExecutionId)
    const schema169Pool = { query: async (sql: string) => ({ rows: sql.includes('select schema_version')
      ? [{ schema_version: 169 }] : [strictLedgerV2] }) }
    const certificateV2 = await issueRecordedSceneCutFrameApproval(schema169Pool,
      { review: reviewedV2, evidence, shot: travelingShot, sources,
        openingStatePlan: openingStatePlanV2 }, root)
    assert.equal(certificateV2.reviewExecutionId, reviewExecutionId)
    await assert.rejects(issueRecordedSceneCutFrameApproval(schema169Pool,
      { review: { ...reviewedV2,
        requiredVisualActionChecks: [...reviewedV2.requiredVisualActionChecks.slice(0, 2),
          { ...reviewedV2.requiredVisualActionChecks[2], travelStartCheck: {
            ...reviewedV2.requiredVisualActionChecks[2].travelStartCheck,
            noStrideInProgress: false } }] },
      evidence, shot: travelingShot, sources, openingStatePlan: openingStatePlanV2 }, root),
    /SCENE_CUT_FRAME_REJECTED/)
    await assert.rejects(issueRecordedSceneCutFrameApproval(schema169Pool,
      { review: reviewedV2, evidence, shot: travelingShot, sources,
        openingStatePlan }, root), /SCENE_CUT_FRAME_BLOCKED/)
    const schema168Pool = { query: async (sql: string) => ({ rows: sql.includes('select schema_version')
      ? [{ schema_version: 168 }] : [strictLedger] }) }
    const strictCertificate = await issueRecordedSceneCutFrameApproval(schema168Pool,
      { review: reviewed, evidence, shot, sources, openingStatePlan }, root)
    assert.equal(strictCertificate.reviewExecutionId, reviewExecutionId)
    await assert.rejects(issueRecordedSceneCutFrameApproval(schema168Pool,
      { review: reviewed, evidence, shot, sources }, root),
    /SCENE_CUT_FRAME_BLOCKED/)
    await assert.rejects(issueRecordedSceneCutFrameApproval(schema168Pool,
      { review: { ...reviewed, requiredVisualActionChecks: [reviewed.requiredVisualActionChecks[0],
        { ...reviewed.requiredVisualActionChecks[1], stanceStartCheck: {
          ...reviewed.requiredVisualActionChecks[1].stanceStartCheck,
          torsoNotFullyStraight: false } }] }, evidence, shot, sources,
        openingStatePlan }, root), /SCENE_CUT_FRAME_REJECTED/)
    assert.throws(() => assertSceneCutReviewLedgerRecord(ledger, { ...reviewed, model: 'other' }, expected, root),
    /SCENE_CUT_FRAME_BLOCKED/)
    assert.throws(() => assertSceneCutReviewLedgerRecord(ledger, { ...reviewed, unknown: true }, expected, root),
    /SCENE_CUT_FRAME_BLOCKED/)
    assert.throws(() => assertSceneCutReviewLedgerRecord({ ...ledger,
      request_data: { ...ledger.request_data, prompt: '随意提示词' } }, reviewed, expected, root),
    /SCENE_CUT_FRAME_BLOCKED/)
    const certificate = await issueSceneCutFrameApproval({ review: reviewed, evidence, shot, sources,
      reviewExecutionId }, root)
    assert.equal(verifySceneCutFrameApproval(certificate, root).signature, certificate.signature)
    const videoParams = { continuityMode: 'scene_cut', visualTreatment: 'live_action',
      referenceImage: '/generated/candidate.png', referenceImages: sources.referenceImages,
      referenceBindings: sources.referenceBindings, sceneCutFrameGate: certificate, sceneCutShot: shot }
    assert.equal(validateSceneCutVideoPayment(videoParams, root).signature, certificate.signature)
    await writeFile(path.join(dir, 'candidate.png'), triptych)
    assert.throws(() => verifySceneCutFrameApproval(certificate, root),
      /SCENE_CUT_FRAME_APPROVAL_INVALID/)
    await writeFile(path.join(dir, 'candidate.png'), candidate)
    assert.throws(() => validateSceneCutVideoPayment({ ...videoParams,
      referenceImage: '/generated/other.png' }, root), /SCENE_CUT_FRAME_APPROVAL_INVALID/)
    assert.throws(() => validateSceneCutVideoPayment({ ...videoParams,
      sceneCutShot: { ...shot, visualPrompt: 'changed' } }, root), /SCENE_CUT_FRAME_APPROVAL_INVALID/)
    assert.throws(() => validateSceneCutVideoPayment({ ...videoParams,
      referenceBindings: [{ ...sources.referenceBindings[0], sha256: '0'.repeat(64) }] }, root),
    /SCENE_CUT_FRAME_APPROVAL_INVALID/)
    const paidVideo = { model: { id: 'kling-v3', provider: 'Kling', capability: 'video', settings: {} },
      prompt: '视频', params: videoParams,
      executionContext: { workflowId: 'wf-sanguo-history-drama', nodeId: 'sanguo-video' } }
    assert.equal(validateSceneCutPaidVideoRequest(paidVideo, undefined, root), 'new-purchase')
    assert.throws(() => validateSceneCutPaidVideoRequest({ ...paidVideo,
      params: { ...videoParams, sceneCutFrameGate: undefined } }, undefined, root),
    /SCENE_CUT_FRAME_APPROVAL_INVALID/)
    assert.throws(() => validateSceneCutPaidVideoRequest({ ...paidVideo,
      params: { ...videoParams, continuityMode: 'coverage_cut' } }, undefined, root),
    /SCENE_CUT_FRAME_BLOCKED/)
    assert.throws(() => validateSceneCutPaidVideoRequest({ ...paidVideo,
      params: { ...videoParams, continuityMode: undefined } }, undefined, root),
    /SCENE_CUT_FRAME_BLOCKED/)
    assert.throws(() => validateSceneCutPaidVideoRequest({ ...paidVideo,
      params: { ...videoParams, sceneCutShot: undefined } }, undefined, root),
    /SCENE_CUT_FRAME_BLOCKED/)
    const otherShot = { ...shot, continuity: { mode: 'tail_continuation' } }
    assert.equal(validateSceneCutPaidVideoRequest({ ...paidVideo,
      params: { ...videoParams, continuityMode: 'tail_continuation', sceneCutShot: otherShot,
        sceneCutFrameGate: undefined } }, undefined, root), 'unrelated')
    let providerCalls = 0
    await assert.rejects(callKlingVideo({ id: 'kling-v3', provider: 'Kling', capability: 'video',
      settings: { endpoint: 'https://api.example.test/v1/videos', apiKey: 'fixture' } },
    '视频', { ...videoParams, sceneCutFrameGate: undefined }, {
      generatedAssetsDirectory: dir, fetch: async () => { providerCalls++; throw Error('paid provider called') },
    }), /SCENE_CUT_FRAME_APPROVAL_INVALID/)
    assert.equal(providerCalls, 0, 'adapter must reject before paid provider POST')
  } finally { await rm(root, { recursive: true, force: true }) }
})
