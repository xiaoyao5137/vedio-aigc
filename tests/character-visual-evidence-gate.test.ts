import test from 'node:test'
import assert from 'node:assert/strict'
import { acceptPrincipleImages, PRINCIPLE_MEDIA_RUNTIME_CODE } from '../src/principle-media-quality.ts'
import { executeCodeNode } from '../server/code-node.ts'
import { runWorkflowToCompletion } from '../src/workflow-runner.ts'
import type { StepRunStatus } from '../src/workflow-core.ts'

function yanImage() {
  const visualContext = { version: 'character-visual-context-v1', age: { stage: 'mature', basis: 'artistic', asOf: '江州战役' },
    look: { key: 'jiangzhou', description: '灰褐战袍与旧色札甲' },
    appearanceConstraints: { hair: 'dark', facialHair: 'dark', build: '成熟武将' } }
  const item = { characterName: '严颜', url: '/generated/yan-jiangzhou.png', metadata: { visualContext } }
  return { character_candidates: { items: [item] },
    character_image_evidence: { items: [{ characterName: '严颜', url: item.url, decoded: true, referenceImage: '/generated/yan-evidence.jpg' }] },
    character_portraits: { characters: [{ name: '严颜', visualContext }] },
    character_image_review: { version: 'principle-review-v1', decision: 'pass', issues: [], warnings: [], items: [{ imageIndex: 0,
      characterName: '严颜', appearance: '成熟男性，灰褐战袍，面形偏长，黑色发髻与较长的下颌胡须。',
      visualContextEvidence: { ageStage: 'unknown', hair: 'dark', facialHair: 'graying', finding: '正面和侧面下颌胡须清晰可见成束灰白发丝，头顶发髻仍为黑色。' } }] } }
}

test('a clear image-bound beard contradiction survives a pass headline without buying a manual redraw', async () => {
  const input = yanImage(), before = structuredClone(input)
  const accepted = acceptPrincipleImages(input, { qualityDisposition: 'manual-review-v1' })
  assert.equal(accepted.passed, true, 'manual review preserves the paid image and lets a person choose a retry')
  assert.equal(accepted.qualityReview.decision, 'revise')
  assert.equal(accepted.qualityReview.status, 'needs_attention')
  assert.equal(accepted.qualityReview.automaticRetakeAllowed, false)
  assert.equal(accepted.manualDecisionRequired, false, 'beard shade alone does not halt the run')
  assert.deepEqual(accepted.qualityReview.principleIssues[0].evidence.conflicts,
    [{ field: 'facialHair', expected: 'dark', actual: 'graying' }])
  assert.equal(accepted.items[0].metadata.quality.assetDecision, 'revise')
  assert.equal(accepted.items[0].metadata.quality.manualReviewRequired, true)
  assert.equal(accepted.items[0].metadata.visualProfile.visualContextEvidence.facialHair, 'graying',
    'future asset recall must see the observed mismatch rather than only the generation request')
  assert.deepEqual(accepted.qualityReview.rawReport, input.character_image_review)
  assert.deepEqual(input, before)
  const code = await executeCodeNode({ code: PRINCIPLE_MEDIA_RUNTIME_CODE + '\nreturn principleMediaQuality.acceptImages(context,params);',
    context: input, params: { qualityDisposition: 'manual-review-v1' } })
  assert.equal(code.qualityReview.decision, 'revise', 'saved workflow code uses the same evidence-bound gate')
  assert.equal(code.items[0].metadata.visualProfile.visualContextEvidence.facialHair, 'graying')
})

test('gray-brown shade uncertainty and unbound model complaints remain human review, not a confirmed failure', () => {
  const uncertain = yanImage()
  uncertain.character_image_review.items[0].visualContextEvidence = {
    ageStage: 'unknown', hair: 'dark', facialHair: 'unknown', finding: '下颌须呈灰褐色，受光线影响，无法确认是否有真正的花白须丝。' }
  uncertain.character_image_review.warnings.push('严颜下颌胡须是否花白不确定，建议人工查看。')
  const result = acceptPrincipleImages(uncertain, { qualityDisposition: 'manual-review-v1' })
  assert.equal(result.passed, true)
  assert.equal(result.qualityReview.decision, 'uncertain')
  assert.equal(result.qualityReview.principleIssues.length, 0)
  assert.equal(result.items[0].metadata.quality.assetDecision, 'uncertain')
  assert.equal(result.items[0].metadata.visualProfile.visualContextEvidence, undefined,
    'ambiguous beard shade must not become durable negative evidence')

  const unbound = yanImage()
  unbound.character_image_review.items[0].imageIndex = 9
  unbound.character_image_review.issues = [{ code: 'appearance_constraint_contradiction', characterName: '严颜',
    problem: '疑似胡须偏灰', repair: '重新生成', evidence: { imageIndex: 0, finding: '下颌须可能偏灰' } }]
  const unboundResult = acceptPrincipleImages(unbound, { qualityDisposition: 'manual-review-v1' })
  assert.equal(unboundResult.qualityReview.principleIssues.length, 0)
  assert.equal(unboundResult.items[0].metadata.quality.assetDecision, 'uncertain')
})

test('confirmed beard contradiction requests manual review without purchasing a strict-mode redraw', () => {
  const strict = acceptPrincipleImages(yanImage())
  assert.equal(strict.passed, true)
  assert.equal(strict.qualityReview.decision, 'revise')
  assert.equal(strict.qualityReview.automaticRetakeAllowed, false)
  const adult = yanImage()
  adult.character_image_review.items[0].visualContextEvidence = {
    ageStage: 'adult', hair: 'dark', facialHair: 'dark', finding: '正面可见黑色头发与黑色胡须，面貌属于成年阶段，无法精确分辨成年与成熟阶段。' }
  const accepted = acceptPrincipleImages(adult)
  assert.equal(accepted.passed, true)
  assert.equal(accepted.qualityReview.principleIssues.length, 0)
})

test('a verified wrong identity pauses at the saved image gate; an explicitly resumed run preserves the image', async () => {
  const input = yanImage()
  input.character_image_review.decision = 'revise'
  input.character_image_review.issues = [{ code: 'wrong_character', characterName: '严颜', problem: '实际是女演员，和本场男将身份相反',
    repair: '人工检查此图后从人物图片节点重做', evidence: { imageIndex: 0, finding: '正面和侧面均可见不同性别的人物，面部与身体造型不符严颜男将。' } }]
  const accepted = acceptPrincipleImages(input, { qualityDisposition: 'manual-review-v1' })
  assert.equal(accepted.passed, true)
  assert.equal(accepted.manualDecisionRequired, true)
  assert.equal(accepted.qualityReview.manualDecisionRequired, true)
  assert.equal(accepted.qualityReview.automaticRetakeAllowed, false)
  assert.equal(accepted.items[0].metadata.quality.assetDecision, 'revise')
  const runs = [
    { id: 'image-gate', node: { id: 'sanguo-character-accept' }, status: 'idle' as StepRunStatus, output: undefined as unknown },
    { id: 'archive', node: { id: 'sanguo-character-archive' }, status: 'idle' as StepRunStatus, output: undefined as unknown },
  ]
  const calls: string[] = []
  const execute = async (index: number, state: { nodeRuns: typeof runs }) => {
    calls.push(state.nodeRuns[index].id)
    return { nodeRuns: state.nodeRuns.map((run, at) => at === index
      ? { ...run, status: 'success' as StepRunStatus, output: index === 0 ? accepted : { archivedCount: 1 } } : run) }
  }
  const paused = await runWorkflowToCompletion({ nodeRuns: runs }, execute)
  assert.deepEqual(calls, ['image-gate'])
  assert.equal(paused.nodeRuns[1].status, 'idle')
  const resumed = await runWorkflowToCompletion(paused, execute)
  assert.deepEqual(calls, ['image-gate', 'archive'])
  assert.equal(resumed.nodeRuns[1].status, 'success')
})

test('required costume can stop only when the observed missing piece is literally required by this scene', () => {
  const input = yanImage()
  input.character_image_review.decision = 'revise'
  input.character_image_review.issues = [{ code: 'required_costume_contradiction', characterName: '严颜',
    problem: '本场要求的旧色札甲完全缺失', repair: '人工检查三视图后局部重做',
    evidence: { imageIndex: 0, expected: '旧色札甲', finding: '正面、侧面、背面均只见布袍，胸背与腰腹没有任何甲片。' } }]
  const accepted = acceptPrincipleImages(input, { qualityDisposition: 'manual-review-v1' })
  assert.equal(accepted.manualDecisionRequired, true)
  const unbound = yanImage()
  unbound.character_image_review.decision = 'revise'
  unbound.character_image_review.issues = [{ ...input.character_image_review.issues[0], evidence: {
    imageIndex: 0, expected: '从未要求的金盔', finding: '正面、侧面、背面均只见布袍，没有金盔。' } }]
  assert.equal(acceptPrincipleImages(unbound, { qualityDisposition: 'manual-review-v1' }).manualDecisionRequired, false)
})
