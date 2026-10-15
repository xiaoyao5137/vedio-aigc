import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { assertSceneCutReviewLedgerRecord } from '../server/scene-cut-frame-runtime.ts'
import { deriveSceneCutOpeningPlan } from '../server/scene-cut-opening-plan.ts'
import { SCENE_CUT_FIRST_FRAME_PROMPT_V172,
  SCENE_CUT_FRAME_REVIEW_PROMPT_V172 } from '../src/scene-cut-action-visibility-workflow.ts'
import { SCENE_CUT_FIRST_FRAME_PROMPT_V173,
  SCENE_CUT_FRAME_REVIEW_PROMPT_V173, SCENE_CUT_FRAME_REVIEW_PROMPT_V173_INITIAL,
  refreshSceneCutStagingReviewPrompt, upgradeSceneCutStagingWorkflow } from '../src/scene-cut-staging-workflow.ts'
import { renderWorkflowTemplate } from '../src/workflow-template.ts'

const shot = { id: 'street-shot', continuity: { mode: 'scene_cut' },
  visualTreatment: 'live_action', characters: ['主将', '俘虏'],
  visualPrompt: '东汉战后街口全景，主将在左，俘虏在右，近身军士在俘虏两侧及侧后方。俘虏身前留缺口，双腕未缚，军士手持绳索。动作执行：主将抬手，军士合拢和缚腕，主将走近。',
  camera: '同侧35毫米斜侧全景，双腕可见；主将后续走近。',
  pacing: { scheduleHash: 'street-schedule', beats: [
    { id: 'close', kind: 'action', completion: { requiredThisClip: true,
      evidenceAnchor: '主将抬手示意军士合拢，封住俘虏身前的缺口' } },
    { id: 'bind', kind: 'action', completion: { requiredThisClip: true,
      evidenceAnchor: '军士将俘虏双腕缚住' } },
    { id: 'approach', kind: 'action', completion: { requiredThisClip: true,
      evidenceAnchor: '主将走到俘虏面前' } },
  ], schedule: [{ beatId: 'close', startSecond: 0 }, { beatId: 'bind', startSecond: 2.5 },
    { beatId: 'approach', startSecond: 7.5 }] } }

test('schema173 is a two-prompt migration and preserves the archive and approved plan', () => {
  const archive = { id: 'sanguo-scene-cut-source-archive', params: [
    { englishName: 'identityPlateVersion', value: 'scene-cut-identity-plate-v4' }] }
  const plan = { id: 'sanguo-scene-cut-opening-plan', params: [{ value: '${shot_script}' }] }
  const image = { id: 'sanguo-scene-cut-first-frame', prompt: SCENE_CUT_FIRST_FRAME_PROMPT_V172 }
  const review = { id: 'sanguo-scene-cut-review', prompt: SCENE_CUT_FRAME_REVIEW_PROMPT_V172 }
  const manual = { id: 'manual', prompt: 'user retained' }
  const graph = { id: 'wf-sanguo-history-drama', schemaVersion: 172,
    nodes: [archive, plan, image, review, manual],
    edges: [{ id: 'edge', from: archive.id, to: plan.id }] }
  const migrated = upgradeSceneCutStagingWorkflow(graph)
  assert.equal(migrated.schemaVersion, 173)
  assert.equal(migrated.edges, graph.edges)
  assert.deepEqual(migrated.nodes.filter((node, index) => node !== graph.nodes[index]).map(node => node.id),
    [image.id, review.id])
  assert.equal(migrated.nodes[0], archive)
  assert.equal(migrated.nodes[1], plan)
  assert.equal(migrated.nodes[4], manual)
  assert.equal(upgradeSceneCutStagingWorkflow(migrated), migrated)
  assert.equal(upgradeSceneCutStagingWorkflow({ ...migrated, schemaVersion: 174 }).schemaVersion, 174)
  const edited = { ...graph, nodes: [archive, plan, { ...image, prompt: 'manual edit' }, review, manual] }
  assert.equal(upgradeSceneCutStagingWorkflow(edited), edited)
})

test('initial schema173 wardrobe contradiction refreshes only the exact managed review prompt', () => {
  const image = { id: 'sanguo-scene-cut-first-frame', prompt: SCENE_CUT_FIRST_FRAME_PROMPT_V173 }
  const review = { id: 'sanguo-scene-cut-review', prompt: SCENE_CUT_FRAME_REVIEW_PROMPT_V173_INITIAL }
  const custom = { id: 'manual', prompt: 'keep' }
  const graph = { id: 'wf-sanguo-history-drama', schemaVersion: 173,
    nodes: [image, review, custom], edges: [{ id: 'e', from: image.id, to: review.id }] }
  assert.notEqual(review.prompt, SCENE_CUT_FRAME_REVIEW_PROMPT_V173)
  const refreshed = refreshSceneCutStagingReviewPrompt(graph)
  assert.equal(refreshed.schemaVersion, 173)
  assert.equal(refreshed.edges, graph.edges)
  assert.equal(refreshed.nodes[0], image)
  assert.equal(refreshed.nodes[2], custom)
  assert.equal(refreshed.nodes[1].prompt, SCENE_CUT_FRAME_REVIEW_PROMPT_V173)
  assert.equal(refreshSceneCutStagingReviewPrompt(refreshed), refreshed)
  const edited = { ...graph, nodes: [image, { ...review, prompt: 'user edit' }, custom] }
  assert.equal(refreshSceneCutStagingReviewPrompt(edited), edited)
})

test('schema173 prompt keeps approved action but clears the action area and omits unapproved flags', () => {
  const opening = deriveSceneCutOpeningPlan(shot, 3)
  const prompt = renderWorkflowTemplate(SCENE_CUT_FIRST_FRAME_PROMPT_V173,
    { scene_cut_opening_state: opening })
  assert.match(prompt, /未要求旗帜时不要添加旗帜、幡或旗杆/)
  assert.doesNotMatch(prompt, /背景有旗帜时使用纯色无字布面/)
  assert.match(prompt, /最少近身人物.*其他已批准的匿名背景人物.*不要增加第二组操作者/s)
  assert.match(prompt, /只安排一名明确的持绳操作者和一根工作绳.*除非批准分镜明确要求多人共持/s)
  assert.match(prompt, /安全画幅.*四边留出足、手和绳端的空间/s)
  assert.match(prompt, /双手、工作段、自由端与未缚肢体.*彼此不重叠/s)
  assert.match(prompt, /“腰带到鞋底”.*外袍下摆、内层下摆与露靴起点/s)
  assert.match(prompt, /主将在左.*俘虏在右.*身前留缺口/s)
  assert.doesNotMatch(prompt, /动作执行：|主将后续走近。|主将走到俘虏面前。/)
})

test('schema173 reviewer distinguishes legible glyphs and material garment drift from minor perspective', () => {
  const review = SCENE_CUT_FRAME_REVIEW_PROMPT_V173
  assert.doesNotMatch(review, /或远景无法确认无字，readableGlyphsPresent=true/)
  assert.doesNotMatch(review, /内摆变窄、被外袍盖没或比例改变时 matches=false/)
  assert.match(review, /只有实见可辨文字或可辨拟字形时才填 readableGlyphsPresent=true/)
  assert.match(review, /完全看不出字形.*不得把“无法证明绝对无字”推断成“实见文字”/s)
  assert.match(review, /纯背景人员可留在远景.*不得进入动作区遮挡/s)
  assert.match(review, /仅一名持工作绳的操作者.*第二名合拢者不得另持重复绳索/s)
  assert.match(review, /腰带到鞋底.*约略相对位置/s)
  assert.match(review, /轻微偏差.*不得判 matches=false.*显著改变.*matches=false/s)
  assert.match(review, /关键部位被遮挡到无法核对时不确定仍不得通过/)
})

test('schema173 ledger accepts only the new managed reviewer prompt', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scene-cut-v173-ledger-'))
  try {
    await mkdir(path.join(root, 'public/generated'), { recursive: true })
    const image = Buffer.from('candidate image bytes')
    await writeFile(path.join(root, 'public/generated/candidate.jpg'), image)
    const expected = { evidence: { evidenceUrl: '/generated/evidence.json' }, shot,
      sources: { sourceContext: { approvedOutline: { scenes: [] } } },
      reviewImages: ['/generated/candidate.jpg'],
      openingStatePlan: deriveSceneCutOpeningPlan(shot, 3) }
    const review = { passed: false, issues: ['near guard hidden by captive'] }
    const makePrompt = (template: string) => renderWorkflowTemplate(template,
      { scene_cut_evidence: expected.evidence, shot_script: expected.shot,
        scene_cut_sources: expected.sources, scene_cut_opening_state: expected.openingStatePlan })
    const row = { id: 'model-run-v173-staging', channel: 'workflow',
      workflow_id: 'wf-sanguo-history-drama', node_id: 'sanguo-scene-cut-review',
      model_id: 'codex-local-vision', capability: 'text', provider: 'Codex', status: 'succeeded',
      request_data: { fingerprint: 'a'.repeat(64), params: expected,
        prompt: makePrompt(SCENE_CUT_FRAME_REVIEW_PROMPT_V173),
        reviewImageHashes: [{ url: expected.reviewImages[0],
          sha256: createHash('sha256').update(image).digest('hex') }] },
      response_data: { text: JSON.stringify(review) } }
    assert.equal(assertSceneCutReviewLedgerRecord(row, { ...review, model: row.model_id },
      expected, root, 173), row.id)
    assert.throws(() => assertSceneCutReviewLedgerRecord({ ...row,
      request_data: { ...row.request_data, prompt: makePrompt(SCENE_CUT_FRAME_REVIEW_PROMPT_V172) } },
    { ...review, model: row.model_id }, expected, root, 173), /SCENE_CUT_FRAME_BLOCKED/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
