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
import { SCENE_CUT_FRAME_REVIEW_PROMPT_V174 } from '../src/scene-cut-action-start-workflow.ts'
import { SCENE_CUT_FIRST_FRAME_PROMPT_V175 } from '../src/scene-cut-closure-layout-workflow.ts'
import { SCENE_CUT_FIRST_FRAME_PROMPT_V176,
  upgradeSceneCutClosureStartLayoutWorkflow } from '../src/scene-cut-closure-start-layout-workflow.ts'
import { SCENE_CUT_FIRST_FRAME_PROMPT_V177 } from '../src/scene-cut-controlled-edit-prompt.ts'
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

test('schema176 updates only the image prompt and leaves the schema174 review contract frozen', () => {
  const archive = { id: 'sanguo-scene-cut-source-archive', params: [{ value: 'v4' }] }
  const plan = { id: 'sanguo-scene-cut-opening-plan', code: 'preserved' }
  const image = { id: 'sanguo-scene-cut-first-frame', prompt: SCENE_CUT_FIRST_FRAME_PROMPT_V175 }
  const review = { id: 'sanguo-scene-cut-review', prompt: SCENE_CUT_FRAME_REVIEW_PROMPT_V174 }
  const manual = { id: 'manual', prompt: 'keep user edit' }
  const graph = { id: 'wf-sanguo-history-drama', schemaVersion: 175,
    nodes: [archive, plan, image, review, manual],
    edges: [{ id: 'e', from: plan.id, to: image.id }] }
  const migrated = upgradeSceneCutClosureStartLayoutWorkflow(graph)
  assert.equal(migrated.schemaVersion, 176)
  assert.equal(migrated.edges, graph.edges)
  assert.deepEqual(migrated.nodes.filter((node, index) => node !== graph.nodes[index])
    .map(node => node.id), [image.id])
  assert.equal(migrated.nodes[0], archive)
  assert.equal(migrated.nodes[1], plan)
  assert.equal(migrated.nodes[3], review)
  assert.equal(migrated.nodes[4], manual)
  assert.equal(upgradeSceneCutClosureStartLayoutWorkflow(migrated), migrated)
  assert.equal(upgradeSceneCutClosureStartLayoutWorkflow({ ...migrated, schemaVersion: 177 })
    .schemaVersion, 177)
  const edited = { ...graph, nodes: [archive, plan, { ...image, prompt: 'custom' }, review, manual] }
  assert.equal(upgradeSceneCutClosureStartLayoutWorkflow(edited), edited)
})

test('schema176 image prompt places approved closers on visible side flanks without adding cast or action', () => {
  const prompt = renderWorkflowTemplate(SCENE_CUT_FIRST_FRAME_PROMPT_V176,
    { scene_cut_opening_state: deriveSceneCutOpeningPlan(shot, 3) })
  assert.ok(prompt.startsWith('【零秒首帧最先执行的动作区布局·v11】'))
  assert.match(prompt, /左合拢执行者 — 目标人物 — 右侧持绳合拢执行者/)
  assert.match(prompt, /完整髋部、双膝、两条腿、双靴.*目标袍摆左缘外/s)
  assert.match(prompt, /左执行者不得藏在目标正后方、筐箱后方或右侧人群内/)
  assert.match(prompt, /不能由发令者或远景守兵充当/)
  assert.match(prompt, /发令者仍在批准的左侧距离.*缺口仍敞开/s)
  assert.match(prompt, /右侧持绳执行者保持批准右侧起点，完整身形和双靴留在画内/)
  assert.match(prompt, /持绳手握工作绳中段.*膝下、踝上.*浅色地面背景前.*截断头或少量散股/s)
  assert.match(prompt, /末梢端点与回折绳股、手、衣甲、靴子和地面之间留出可见背景间隙/)
  assert.match(prompt, /要验证的端头不能藏在拳内.*绳的另一端可留在手中/s)
  assert.match(prompt, /单纯垂环绝不是自由端/)
  assert.match(prompt, /保留批准机位轴线、场所、人物数量与左右关系/)
  assert.match(prompt, /主将在左.*俘虏在右.*身前缺口仍开/s)
  assert.doesNotMatch(prompt, /主将抬手示意两侧军士合拢/)
})

test('schema176 paid image accepts only new prompt, while review ledger still expects schema174 text', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scene-cut-v176-layout-'))
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
    prompt: renderWorkflowTemplate(SCENE_CUT_FIRST_FRAME_PROMPT_V176, context),
    params: { sceneCutShot: imageShot, sceneCutSources: sources,
      sceneCutOpeningPlan: opening, referenceImages: sources.imageReferenceImages,
      singleFrame: true, size: '1536x864' },
    executionContext: { workflowId: 'wf-sanguo-history-drama',
      nodeId: 'sanguo-scene-cut-first-frame' } }
    await assert.doesNotReject(validateSceneCutPaidImageRequest(request, root, 176))
    await assert.rejects(validateSceneCutPaidImageRequest({ ...request,
      prompt: renderWorkflowTemplate(SCENE_CUT_FIRST_FRAME_PROMPT_V175, context) },
    root, 176), /SCENE_CUT_FRAME_BLOCKED/)

    const request177 = { ...request,
      prompt: renderWorkflowTemplate(SCENE_CUT_FIRST_FRAME_PROMPT_V177, context) }
    await assert.doesNotReject(validateSceneCutPaidImageRequest(request177, root, 177))
    await assert.rejects(validateSceneCutPaidImageRequest(request, root, 177),
      /SCENE_CUT_FRAME_BLOCKED/)

    const frameJpeg = Buffer.from('frozen review attachment')
    await writeFile(path.join(root, 'public/generated/candidate.jpg'), frameJpeg)
    const expected = { evidence: { evidenceUrl: '/generated/evidence.json' },
      shot: imageShot, sources, reviewImages: ['/generated/candidate.jpg'],
      openingStatePlan: opening }
    const review = { passed: false, issues: ['closer hidden'] }
    const reviewPrompt = renderWorkflowTemplate(SCENE_CUT_FRAME_REVIEW_PROMPT_V174,
      { scene_cut_evidence: expected.evidence, shot_script: imageShot,
        scene_cut_sources: sources, scene_cut_opening_state: opening })
    const row = { id: 'model-run-v176-review-unchanged', channel: 'workflow',
      workflow_id: 'wf-sanguo-history-drama', node_id: 'sanguo-scene-cut-review',
      model_id: 'codex-local-vision', capability: 'text', provider: 'Codex', status: 'succeeded',
      request_data: { fingerprint: 'a'.repeat(64), params: expected, prompt: reviewPrompt,
        reviewImageHashes: [{ url: expected.reviewImages[0],
          sha256: createHash('sha256').update(frameJpeg).digest('hex') }] },
      response_data: { text: JSON.stringify(review) } }
    assert.equal(assertSceneCutReviewLedgerRecord(row, { ...review, model: row.model_id },
      expected, root, 176), row.id)
  } finally { await rm(root, { recursive: true, force: true }) }
})
