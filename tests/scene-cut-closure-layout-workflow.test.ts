import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { archiveSceneCutSources } from '../server/scene-cut-frame-storage.ts'
import { deriveSceneCutOpeningPlan } from '../server/scene-cut-opening-plan.ts'
import { assertSceneCutReviewLedgerRecord,
  validateSceneCutPaidImageRequest } from '../server/scene-cut-frame-runtime.ts'
import { SCENE_CUT_FIRST_FRAME_PROMPT_V174,
  SCENE_CUT_FRAME_REVIEW_PROMPT_V174 } from '../src/scene-cut-action-start-workflow.ts'
import { SCENE_CUT_FIRST_FRAME_PROMPT_V175,
  upgradeSceneCutClosureLayoutWorkflow } from '../src/scene-cut-closure-layout-workflow.ts'
import { renderWorkflowTemplate } from '../src/workflow-template.ts'

const shot = { id: 'two-sided-closure-shot', firstFrameMode: 'reference',
  continuity: { mode: 'scene_cut' }, visualTreatment: 'live_action',
  characters: ['主将', '俘虏'],
  visualPrompt: '东汉街口斜侧全景：主将在左，俘虏在右，匿名军士分别位于俘虏两侧及侧后方。首帧双腕未缚、身前缺口仍开。',
  camera: '同一侧35毫米斜侧全景，保留人物双脚、双腕与脸。',
  pacing: { scheduleHash: 'layout-schedule', beats: [
    { id: 'close', kind: 'action', textOrVocalization: '主将抬手示意两侧军士合拢，封住俘虏身前缺口。',
      completion: { requiredThisClip: true,
        evidenceAnchor: '主将抬手示意军士合拢，封住俘虏身前的缺口' } },
    { id: 'bind', kind: 'action', completion: { requiredThisClip: true,
      evidenceAnchor: '军士将俘虏双腕缚住' } },
  ], schedule: [{ beatId: 'close', startSecond: 0 },
    { beatId: 'bind', startSecond: 2.5 }] } }

test('schema175 updates only the image prompt and leaves the schema174 review contract frozen', () => {
  const archive = { id: 'sanguo-scene-cut-source-archive', params: [{ value: 'v4' }] }
  const plan = { id: 'sanguo-scene-cut-opening-plan', code: 'preserved' }
  const image = { id: 'sanguo-scene-cut-first-frame', prompt: SCENE_CUT_FIRST_FRAME_PROMPT_V174 }
  const review = { id: 'sanguo-scene-cut-review', prompt: SCENE_CUT_FRAME_REVIEW_PROMPT_V174 }
  const manual = { id: 'manual', prompt: 'keep user edit' }
  const graph = { id: 'wf-sanguo-history-drama', schemaVersion: 174,
    nodes: [archive, plan, image, review, manual],
    edges: [{ id: 'e', from: plan.id, to: image.id }] }
  const migrated = upgradeSceneCutClosureLayoutWorkflow(graph)
  assert.equal(migrated.schemaVersion, 175)
  assert.equal(migrated.edges, graph.edges)
  assert.deepEqual(migrated.nodes.filter((node, index) => node !== graph.nodes[index])
    .map(node => node.id), [image.id])
  assert.equal(migrated.nodes[0], archive)
  assert.equal(migrated.nodes[1], plan)
  assert.equal(migrated.nodes[3], review)
  assert.equal(migrated.nodes[4], manual)
  assert.equal(upgradeSceneCutClosureLayoutWorkflow(migrated), migrated)
  assert.equal(upgradeSceneCutClosureLayoutWorkflow({ ...migrated, schemaVersion: 176 })
    .schemaVersion, 176)
  const edited = { ...graph, nodes: [archive, plan, { ...image, prompt: 'custom' }, review, manual] }
  assert.equal(upgradeSceneCutClosureLayoutWorkflow(edited), edited)
})

test('schema175 image prompt places approved closers on visible side flanks without adding cast or action', () => {
  const prompt = renderWorkflowTemplate(SCENE_CUT_FIRST_FRAME_PROMPT_V175,
    { scene_cut_opening_state: deriveSceneCutOpeningPlan(shot, 3) })
  assert.match(prompt, /仅当批准节拍确有多人从目标两侧合拢缺口时/)
  assert.match(prompt, /分别在目标画面左侧和右侧的侧翼/)
  assert.match(prompt, /与目标身体横向错开.*髋膝.*两只靴.*脚下接地地面/s)
  assert.match(prompt, /筐箱、堆物、立柱等场景遮挡物留在执行者身后/)
  assert.match(prompt, /近画边的持绳者.*整只外侧靴和足下留白必须入画/)
  assert.match(prompt, /不把目标推到极右或极左边缘/)
  assert.match(prompt, /侧后方出现、但不执行本条合拢动作的背景人物放在更远景深/)
  assert.match(prompt, /单人合拢或其他动作不增设第二名执行者/)
  assert.match(prompt, /唯一持绳操作者可以同时是已批准的合拢者/)
  assert.match(prompt, /主将在左.*俘虏在右.*身前缺口仍开/s)
  assert.doesNotMatch(prompt, /主将抬手示意两侧军士合拢/)
})

test('schema175 paid image accepts only new prompt, while review ledger still expects schema174 text', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scene-cut-v175-layout-'))
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
    const context = { shot_script: imageShot, scene_cut_sources: sources,
      scene_cut_opening_state: opening }
    const request = { model: { id: 'codex-gpt-image-2', provider: 'Codex',
      capability: 'image', settings: {} },
    prompt: renderWorkflowTemplate(SCENE_CUT_FIRST_FRAME_PROMPT_V175, context),
    params: { sceneCutShot: imageShot, sceneCutSources: sources,
      sceneCutOpeningPlan: opening, referenceImages: sources.imageReferenceImages,
      singleFrame: true, size: '1536x864' },
    executionContext: { workflowId: 'wf-sanguo-history-drama',
      nodeId: 'sanguo-scene-cut-first-frame' } }
    await assert.doesNotReject(validateSceneCutPaidImageRequest(request, root, 175))
    await assert.rejects(validateSceneCutPaidImageRequest({ ...request,
      prompt: renderWorkflowTemplate(SCENE_CUT_FIRST_FRAME_PROMPT_V174, context) },
    root, 175), /SCENE_CUT_FRAME_BLOCKED/)

    const frameJpeg = Buffer.from('frozen review attachment')
    await writeFile(path.join(root, 'public/generated/candidate.jpg'), frameJpeg)
    const expected = { evidence: { evidenceUrl: '/generated/evidence.json' },
      shot: imageShot, sources, reviewImages: ['/generated/candidate.jpg'],
      openingStatePlan: opening }
    const review = { passed: false, issues: ['closer hidden'] }
    const reviewPrompt = renderWorkflowTemplate(SCENE_CUT_FRAME_REVIEW_PROMPT_V174,
      { scene_cut_evidence: expected.evidence, shot_script: imageShot,
        scene_cut_sources: sources, scene_cut_opening_state: opening })
    const row = { id: 'model-run-v175-review-unchanged', channel: 'workflow',
      workflow_id: 'wf-sanguo-history-drama', node_id: 'sanguo-scene-cut-review',
      model_id: 'codex-local-vision', capability: 'text', provider: 'Codex', status: 'succeeded',
      request_data: { fingerprint: 'a'.repeat(64), params: expected, prompt: reviewPrompt,
        reviewImageHashes: [{ url: expected.reviewImages[0],
          sha256: createHash('sha256').update(frameJpeg).digest('hex') }] },
      response_data: { text: JSON.stringify(review) } }
    assert.equal(assertSceneCutReviewLedgerRecord(row, { ...review, model: row.model_id },
      expected, root, 175), row.id)
  } finally { await rm(root, { recursive: true, force: true }) }
})
