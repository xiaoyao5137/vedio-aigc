import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { assertSceneCutReviewLedgerRecord,
  validateSceneCutPaidImageRequest } from '../server/scene-cut-frame-runtime.ts'
import { archiveSceneCutSources } from '../server/scene-cut-frame-storage.ts'
import { deriveSceneCutOpeningPlan } from '../server/scene-cut-opening-plan.ts'
import { sceneCutActionPerformerFeetRequired,
  validateSceneCutActionVisibilityReview } from '../src/scene-cut-action-visibility-workflow.ts'
import { SCENE_CUT_FIRST_FRAME_PROMPT_V173,
  SCENE_CUT_FRAME_REVIEW_PROMPT_V173 } from '../src/scene-cut-staging-workflow.ts'
import { SCENE_CUT_FIRST_FRAME_PROMPT_V174,
  SCENE_CUT_FRAME_REVIEW_PROMPT_V174, upgradeSceneCutActionStartWorkflow,
  validateSceneCutActionStartReview } from '../src/scene-cut-action-start-workflow.ts'
import { sceneCutManipulationStartRequired } from '../src/scene-cut-t0-image-contract.ts'
import { validateSceneCutOpeningProjectionReview } from '../src/scene-cut-opening-projection-workflow.ts'
import { renderWorkflowTemplate } from '../src/workflow-template.ts'

const shot = { id: 'street-shot', firstFrameMode: 'reference',
  continuity: { mode: 'scene_cut' }, visualTreatment: 'live_action',
  visualPrompt: '东汉街口全景，发令者在左，俘虏在右，军士分立俘虏两侧；双腕未缚，身前缺口尚开。',
  camera: '同侧斜侧全景，人物全身、双腕与脚下地面可见。',
  pacing: { scheduleHash: 'street-schedule', beats: [
    { id: 'close', kind: 'action', completion: { requiredThisClip: true,
      evidenceAnchor: '主将抬手示意军士合拢，封住俘虏身前的缺口' } },
    { id: 'bind', kind: 'action', textOrVocalization: '军士将俘虏双腕缚住。之后绕绳、收紧并结绳。',
      completion: { requiredThisClip: true, evidenceAnchor: '军士将俘虏双腕缚住' } },
    { id: 'approach', kind: 'action', completion: { requiredThisClip: true,
      evidenceAnchor: '主将走到俘虏面前' } },
  ], schedule: [{ beatId: 'close', startSecond: 0 }, { beatId: 'bind', startSecond: 2.5 },
    { beatId: 'approach', startSecond: 7.5 }] } }

test('feet inspection follows the opening frame when the camera widens later', () => {
  assert.equal(sceneCutActionPerformerFeetRequired({
    camera: '单个连续镜头。开场斜正面中景，取人物头部至大腿；随后摄影机放宽至全景，保留脚步。',
    visualPrompt: '首帧为单一时刻；人物随后押行。',
  }), false)
  assert.equal(sceneCutActionPerformerFeetRequired({ camera: '开场全景，三人脚部可见。' }), true)
})

const validReview = () => ({ passed: true,
  wardrobeHemCheck: { applicable: true, matches: true,
    originalHemAndFootwear: '原图腰带0到鞋底1，外摆0.7、内摆0.85、露靴0.15。',
    candidateHemAndFootwear: '候选相同归一化地标，外摆0.71、内摆0.86、露靴0.14。' },
  requiredVisualActionChecks: [
    { beatId: 'close', gestureClosureStartCheck: {
      applicable: true, gestureNotRaised: true, gapStillOpen: true,
      guardsBeforeClosure: true, allApprovedPerformersCovered: true,
      visibilityEvidence: '发令手低位，缺口空；两名军士仍分立原侧位。',
      actionHandsUnoccluded: false, actionPerformersFeetAndGroundVisible: false,
      performerStartChecks: [
        { role: '左侧合拢者', atApprovedOrigin: true,
          hipKneeOrSupportCueVisible: true, hiddenLimbCouldBeAdvancing: false,
          gapIntrusion: false, pixelEvidence: '上身及髋线在左侧起点，一条承重腿落地，另一远端手脚局部遮挡；身体未前倾或入缺口。' },
        { role: '右侧合拢者', atApprovedOrigin: true,
          hipKneeOrSupportCueVisible: true, hiddenLimbCouldBeAdvancing: false,
          gapIntrusion: false, pixelEvidence: '髋膝与两脚在右侧原地，重心未前移。' },
      ] } },
    { beatId: 'bind', manipulationStartCheck: { applicable: false }, bindingStartCheck: {
      applicable: true, targetStillUnbound: true, bindingMaterialSeparate: true,
      bindingActionSpaceVisible: true, uniqueWorkingRopeOperator: true,
      operatorHandVisible: true,
      workingRopeVisible: true, oneFreeEndVisible: true, ropeSlackVisible: true,
      noWristContactOrClosedKnot: true, targetRegionUnoccluded: true,
      visibilityEvidence: '一名操作者持一根松绳，工作段及一个带穗的自由端可辨；另一端藏在手中，双腕分离未缚。',
      operatorHandAndRopeEndsVisible: false } },
    { beatId: 'approach' },
  ] })

test('projection gate accepts schema174 per-performer and binding evidence without old summary field', () => {
  const review = validReview()
  assert.equal(validateSceneCutOpeningProjectionReview(review, shot, 174), true)
  assert.throws(() => validateSceneCutOpeningProjectionReview(review, shot, 173),
    /动作 close.*缺少起点像素证据/)
  const legacy = structuredClone(review)
  legacy.requiredVisualActionChecks[0].gestureClosureStartCheck.pixelEvidence = '发令手低，双侧军士守在原位。'
  legacy.requiredVisualActionChecks[1].bindingStartCheck.pixelEvidence = '双腕未缚，松绳与腕分离。'
  assert.equal(validateSceneCutOpeningProjectionReview(legacy, shot, 173), true)
  for (const [field, value] of [
    ['guardsBeforeClosure', false], ['allApprovedPerformersCovered', false],
    ['visibilityEvidence', ''],
  ] as const) {
    const rejected = structuredClone(review)
    Object.assign(rejected.requiredVisualActionChecks[0].gestureClosureStartCheck,
      { [field]: value })
    assert.throws(() => validateSceneCutOpeningProjectionReview(rejected, shot, 174),
      /动作 close.*缺少起点像素证据/)
  }
  for (const [field, value] of [
    ['hipKneeOrSupportCueVisible', false], ['hiddenLimbCouldBeAdvancing', true],
    ['gapIntrusion', true], ['pixelEvidence', ''],
  ] as const) {
    const rejected = structuredClone(review)
    Object.assign(rejected.requiredVisualActionChecks[0].gestureClosureStartCheck
      .performerStartChecks[0], { [field]: value })
    assert.throws(() => validateSceneCutOpeningProjectionReview(rejected, shot, 174),
      /动作 close.*缺少起点像素证据/)
  }
  for (const field of ['operatorHandVisible', 'workingRopeVisible', 'oneFreeEndVisible',
    'ropeSlackVisible', 'noWristContactOrClosedKnot', 'targetRegionUnoccluded'] as const) {
    const rejected = structuredClone(review)
    rejected.requiredVisualActionChecks[1].bindingStartCheck[field] = false
    assert.throws(() => validateSceneCutOpeningProjectionReview(rejected, shot, 174),
      /动作 bind.*缺少绳与肢体分离的像素证据/)
  }
})

test('schema174 changes only image and review prompts, retaining v4 archive and approved plan', () => {
  const archive = { id: 'sanguo-scene-cut-source-archive', params: [
    { englishName: 'identityPlateVersion', value: 'scene-cut-identity-plate-v4' }] }
  const plan = { id: 'sanguo-scene-cut-opening-plan', code: 'preserve' }
  const image = { id: 'sanguo-scene-cut-first-frame', prompt: SCENE_CUT_FIRST_FRAME_PROMPT_V173 }
  const review = { id: 'sanguo-scene-cut-review', prompt: SCENE_CUT_FRAME_REVIEW_PROMPT_V173 }
  const manual = { id: 'manual', prompt: 'user edit' }
  const graph = { id: 'wf-sanguo-history-drama', schemaVersion: 173,
    nodes: [archive, plan, image, review, manual], edges: [{ id: 'e', from: plan.id, to: image.id }] }
  const migrated = upgradeSceneCutActionStartWorkflow(graph)
  assert.equal(migrated.schemaVersion, 174)
  assert.equal(migrated.edges, graph.edges)
  assert.deepEqual(migrated.nodes.filter((node, index) => node !== graph.nodes[index])
    .map(node => node.id), [image.id, review.id])
  assert.equal(migrated.nodes[0], archive)
  assert.equal(migrated.nodes[1], plan)
  assert.equal(migrated.nodes[4], manual)
  assert.equal(upgradeSceneCutActionStartWorkflow(migrated), migrated)
  assert.equal(upgradeSceneCutActionStartWorkflow({ ...migrated, schemaVersion: 175 }).schemaVersion, 175)
  const edited = { ...graph, nodes: [archive, plan, { ...image, prompt: 'custom image' }, review, manual] }
  assert.equal(upgradeSceneCutActionStartWorkflow(edited), edited)
})

test('schema174 prompt uses source-relative garment landmarks and removes old all-limbs/two-ends review orders', () => {
  assert.match(SCENE_CUT_FIRST_FRAME_PROMPT_V174, /腰带上沿记为纵向 0、双靴鞋底记为纵向 1/)
  assert.match(SCENE_CUT_FIRST_FRAME_PROMPT_V174, /不得把外摆与内摆一起向鞋底拉长、缩短露靴段/)
  assert.match(SCENE_CUT_FRAME_REVIEW_PROMPT_V174, /performerStartChecks.*髋膝.*承重/s)
  assert.match(SCENE_CUT_FRAME_REVIEW_PROMPT_V174, /至少一个可辨且松弛的自由端/)
  assert.match(SCENE_CUT_FRAME_REVIEW_PROMPT_V174, /另一端可以在手中，不要求两端都展开/)
  assert.doesNotMatch(SCENE_CUT_FRAME_REVIEW_PROMPT_V174,
    /执行者有任一脚掌、脚跟或其接触地面被遮挡、裁出画幅，就不能证明其尚未起步/)
  assert.doesNotMatch(SCENE_CUT_FRAME_REVIEW_PROMPT_V174,
    /检查每位执行者仍在批准起点，手、道具、工作绳两端和批准景别中的足部是否各自完整且无遮挡/)
  assert.doesNotMatch(SCENE_CUT_FRAME_REVIEW_PROMPT_V174, /张飞|严颜/)
  assert.equal(sceneCutManipulationStartRequired(shot.pacing.beats[1]), false)
  const rendered = renderWorkflowTemplate(SCENE_CUT_FIRST_FRAME_PROMPT_V174,
    { scene_cut_opening_state: deriveSceneCutOpeningPlan(shot, 3) })
  assert.doesNotMatch(rendered, /之后绕绳、收紧并结绳/)
})

test('partially occluded closer may pass only with per-performer stationary body evidence', () => {
  const review = validReview()
  assert.equal(validateSceneCutActionStartReview(review, shot), true)
  assert.throws(() => validateSceneCutActionVisibilityReview(review, shot),
    /SCENE_CUT_FRAME_REJECTED/)
  for (const [field, value] of [
    ['hipKneeOrSupportCueVisible', false], ['hiddenLimbCouldBeAdvancing', true],
    ['gapIntrusion', true], ['atApprovedOrigin', false],
  ] as const) {
    const rejected = structuredClone(review)
    Object.assign(rejected.requiredVisualActionChecks[0].gestureClosureStartCheck
      .performerStartChecks[0], { [field]: value })
    assert.throws(() => validateSceneCutActionStartReview(rejected, shot),
      /合拢动作.*可见正证/)
  }
  const noCoverage = structuredClone(review)
  noCoverage.requiredVisualActionChecks[0].gestureClosureStartCheck.allApprovedPerformersCovered = false
  assert.throws(() => validateSceneCutActionStartReview(noCoverage, shot), /合拢动作/)
  const missingCloser = structuredClone(review)
  missingCloser.requiredVisualActionChecks[0].gestureClosureStartCheck.performerStartChecks.pop()
  assert.throws(() => validateSceneCutActionStartReview(missingCloser, shot), /合拢动作/)
})

test('one visible slack free end is enough; ambiguous loop or wrist contact is rejected', () => {
  const review = validReview()
  assert.equal(validateSceneCutActionStartReview(review, shot), true)
  for (const field of ['oneFreeEndVisible', 'ropeSlackVisible',
    'noWristContactOrClosedKnot', 'operatorHandVisible', 'workingRopeVisible',
    'targetRegionUnoccluded', 'bindingActionSpaceVisible',
    'uniqueWorkingRopeOperator'] as const) {
    const rejected = structuredClone(review)
    rejected.requiredVisualActionChecks[1].bindingStartCheck[field] = false
    assert.throws(() => validateSceneCutActionStartReview(rejected, shot), /缚住动作/)
  }
  const changedClothes = structuredClone(review)
  changedClothes.wardrobeHemCheck.matches = false
  assert.throws(() => validateSceneCutActionStartReview(changedClothes, shot), /连续衣摆比例/)
  assert.equal(validateSceneCutActionStartReview(changedClothes, shot,
    { visualDetailsAdvisory: true }), true)
  const misclassified = structuredClone(review)
  misclassified.requiredVisualActionChecks[1].manipulationStartCheck.applicable = true
  assert.throws(() => validateSceneCutActionStartReview(misclassified, shot), /缚住动作/)
  const oldVerdict = structuredClone(review)
  oldVerdict.passed = false
  assert.throws(() => validateSceneCutActionStartReview(oldVerdict, shot), /原结论未通过/)
})

test('schema174 review ledger binds new managed prompt and same original attachments', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scene-cut-v174-ledger-'))
  try {
    await mkdir(path.join(root, 'public/generated'), { recursive: true })
    const image = Buffer.from('same candidate image bytes')
    await writeFile(path.join(root, 'public/generated/candidate.jpg'), image)
    const expected = { evidence: { evidenceUrl: '/generated/evidence.json' }, shot,
      sources: { sourceContext: { approvedOutline: { scenes: [] } } },
      reviewImages: ['/generated/candidate.jpg'],
      openingStatePlan: deriveSceneCutOpeningPlan(shot, 3) }
    await writeFile(path.join(root, 'public/generated/evidence.json'),
      JSON.stringify(expected.evidence))
    const review = { passed: false, issues: ['hem differs'] }
    const makePrompt = (template: string) => renderWorkflowTemplate(template,
      { scene_cut_evidence: expected.evidence, shot_script: expected.shot,
        scene_cut_sources: expected.sources, scene_cut_opening_state: expected.openingStatePlan })
    const row = { id: 'model-run-v174-action-start', channel: 'workflow',
      workflow_id: 'wf-sanguo-history-drama', node_id: 'sanguo-scene-cut-review',
      model_id: 'codex-local-vision', capability: 'text', provider: 'Codex', status: 'succeeded',
      request_data: { fingerprint: 'a'.repeat(64), params: expected,
        prompt: makePrompt(SCENE_CUT_FRAME_REVIEW_PROMPT_V174),
        reviewImageHashes: [{ url: expected.reviewImages[0],
          sha256: createHash('sha256').update(image).digest('hex') }] },
      response_data: { text: JSON.stringify(review) } }
    assert.equal(assertSceneCutReviewLedgerRecord(row, { ...review, model: row.model_id },
      expected, root, 174), row.id)
    assert.throws(() => assertSceneCutReviewLedgerRecord({ ...row,
      request_data: { ...row.request_data, prompt: makePrompt(SCENE_CUT_FRAME_REVIEW_PROMPT_V173) } },
    { ...review, model: row.model_id }, expected, root, 174), /SCENE_CUT_FRAME_BLOCKED/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('schema174 paid image request uses the new prompt with the unchanged v4 identity board', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scene-cut-v174-image-'))
  try {
    await mkdir(path.join(root, 'public/generated'), { recursive: true })
    const triptych = await sharp({ create: { width: 900, height: 600, channels: 3,
      background: '#755d45' } }).png().toBuffer()
    await writeFile(path.join(root, 'public/generated/triptych.png'), triptych)
    const imageShot = { ...shot, characters: ['俘虏'] }
    const sources = await archiveSceneCutSources({ shot: imageShot,
      referenceBindings: [{ characterName: '俘虏', assetId: 'asset-captive',
        referenceLayout: 'horizontal-three-view' }],
      referenceImages: ['/generated/triptych.png'],
      identityPlateVersion: 'scene-cut-identity-plate-v4',
      sceneCutBoundaryVersion: 'scene-cut-approved-boundary-v1',
      approvedOutline: { scenes: [{ id: imageShot.id }] },
      acceptedRecordBinding: { version: 'scene-cut-source-ledger-v1' } }, root)
    const opening = deriveSceneCutOpeningPlan(imageShot, 3)
    const params = { sceneCutShot: imageShot, sceneCutSources: sources,
      sceneCutOpeningPlan: opening, referenceImages: sources.imageReferenceImages,
      singleFrame: true, size: '1536x864' }
    const request = { model: { id: 'codex-gpt-image-2', provider: 'Codex',
      capability: 'image', settings: {} },
    prompt: renderWorkflowTemplate(SCENE_CUT_FIRST_FRAME_PROMPT_V174,
      { shot_script: imageShot, scene_cut_sources: sources, scene_cut_opening_state: opening }),
    params, executionContext: { workflowId: 'wf-sanguo-history-drama',
      nodeId: 'sanguo-scene-cut-first-frame' } }
    await assert.doesNotReject(validateSceneCutPaidImageRequest(request, root, 174))
    await assert.rejects(validateSceneCutPaidImageRequest({ ...request,
      prompt: renderWorkflowTemplate(SCENE_CUT_FIRST_FRAME_PROMPT_V173,
        { shot_script: imageShot, scene_cut_sources: sources, scene_cut_opening_state: opening }) },
    root, 174), /SCENE_CUT_FRAME_BLOCKED/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
