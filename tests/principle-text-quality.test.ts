import test from 'node:test'
import assert from 'node:assert/strict'
import { executeCodeNode } from '../server/code-node.ts'
import { renderWorkflowTemplate } from '../src/workflow-template.ts'
import { acceptPrincipleTextQuality, PRINCIPLE_TEXT_ACCEPT_CODE, PRINCIPLE_TEXT_REVIEW_PROMPT } from '../src/principle-text-quality.ts'
import { DRAMATIC_EXPRESSION_TEXT_REVIEW_PROMPT } from '../src/dramatic-expression.ts'

const candidate = { contentContractVersion: 'cinematic-v1', historicalLocks: [{ id: 'lock1', fact: '宾客自发结交' }], scenes: [
  { id: 'scene-07', dramaticSceneId: 'd7', cast: ['周福门生', '房植门生'], requiredBeats: [{ id: 'b7', description: '周福门生当面收回招呼，房植门生转身离开。', observable: { visual: ['二人收回招呼后转身离开。'], audio: [] } }] },
] }
const citations = [{ index: 1, content: '二家賓客，互相譏揣，遂各樹朋徒。' }]
const report = () => ({ version: 'principle-review-v1', decision: 'pass', issues: [] as Record<string, unknown>[], warnings: [] as unknown[] })
const groundedIssue = () => ({ code: 'core_plot_loss', itemId: 'scene-07', problem: '已批准的交印动作被替换成直接离开', repair: '保留交印动作及其回应', evidence: { source: 'candidate', path: 'scenes.0.requiredBeats.0.description', quote: '房植门生转身离开', sourceQuote: '周福门生将印信递给房植门生' } })
const sourceCandidate = { id: 'scene-07', requiredBeats: [{ id: 'b7', description: '周福门生将印信递给房植门生，后者接过。' }] }

test('clean principle report proceeds without legacy per-scene evidence or dramaturgy schema', () => {
  const review = report()
  const result = acceptPrincipleTextQuality({ candidate, review, citations })
  assert.equal(result.passed, true)
  assert.equal(result.qualityReview.status, 'passed')
  assert.deepEqual(result.scenes, candidate.scenes)
  assert.deepEqual(result.qualityReview.rawReport, review)
  assert.equal('factualReview' in result, false)
  assert.equal('passed' in review, false)
})

test('unparseable, absent, uncertain and advisory reports preserve attention without forcing regeneration', () => {
  for (const review of [undefined, 'not-json', { passed: false }, { ...report(), decision: 'uncertain' }, { ...report(), decision: 'revise', issues: [{ code: 'missing_response', problem: '停顿不够戏剧化' }] }]) {
    const result = acceptPrincipleTextQuality({ candidate, review, citations })
    assert.equal(result.passed, true)
    assert.equal(result.qualityReview.status, 'needs_attention')
    assert.deepEqual(result.issues, [])
    assert.equal(result.qualityReview.rawReport, review ?? null)
  }
  assert.equal(acceptPrincipleTextQuality({ candidate, review: '```json\n' + JSON.stringify(report()) + '\n```' }).qualityReview.status, 'passed')
})

test('only current same-scene candidate and actual supplied source ground a blocking principle issue', () => {
  const review = { ...report(), decision: 'revise', issues: [groundedIssue()] }
  const result = acceptPrincipleTextQuality({ candidate, review, citations, sourceCandidate })
  assert.equal(result.passed, false)
  assert.equal(result.qualityReview.status, 'rejected')
  assert.equal(result.issues[0].itemId, 'scene-07')
  assert.deepEqual(result.repairContext.previousCandidate, candidate)
  assert.deepEqual(result.repairContext.historicalLocks, candidate.historicalLocks)
  assert.equal(result.repairContext.scope, 'scene')
  for (const issue of [
    { ...groundedIssue(), code: 'style_preference' },
    { ...groundedIssue(), itemId: 'scene-old' },
    { ...groundedIssue(), evidence: { ...groundedIssue().evidence, quote: '从未出现的候选文本' } },
    { ...groundedIssue(), evidence: { ...groundedIssue().evidence, sourceQuote: '并不存在的来源原文' } },
    { ...groundedIssue(), evidence: { ...groundedIssue().evidence, path: 'scenes.0.cast.0', quote: '周福门生' } },
    { ...groundedIssue(), evidence: { ...groundedIssue().evidence, source: 'report' } },
    { ...groundedIssue(), evidence: { ...groundedIssue().evidence, path: '__proto__.description' } },
  ]) {
    const accepted = acceptPrincipleTextQuality({ candidate, review: { ...review, issues: [issue] }, citations, sourceCandidate })
    assert.equal(accepted.passed, true)
    assert.equal(accepted.qualityReview.status, 'needs_attention')
  }
})

test('historical report issues require real source content and cannot use candidate prose as historical authority', () => {
  const issue = { ...groundedIssue(), code: 'historical_causality' }
  const review = { ...report(), decision: 'revise', issues: [issue] }
  assert.equal(acceptPrincipleTextQuality({ candidate, review, citations, sourceCandidate }).passed, true)
  issue.evidence.sourceQuote = '互相譏揣，遂各樹朋徒'
  assert.equal(acceptPrincipleTextQuality({ candidate, review, citations, sourceCandidate }).passed, false)
})

test('malformed envelope or contradictory conclusion cannot conceal grounded principle errors', () => {
  const review = { passed: true, decision: 'pass', issues: [groundedIssue()] }
  const before = structuredClone(review)
  const result = acceptPrincipleTextQuality({ candidate, review, citations, sourceCandidate })
  assert.equal(result.passed, false)
  assert.equal(result.qualityReview.status, 'rejected')
  assert.deepEqual(review, before)
  assert.deepEqual(result.qualityReview.rawReport, before)
})
test('explicitly uncertain source-bound guesses do not automatically rewrite the current candidate', () => {
  const review = { ...report(), decision: 'uncertain', issues: [groundedIssue()] }
  const result = acceptPrincipleTextQuality({ candidate, review, citations, sourceCandidate })
  assert.equal(result.passed, true)
  assert.equal(result.qualityReview.status, 'needs_attention')
  assert.deepEqual(result.qualityReview.rawReport, review)
  assert.ok(JSON.stringify(result.qualityReview.warnings).includes('证据不确定'))
})

test('source-scoped historical agency guard remains blocking even without a usable model report', async () => {
  const wrong = structuredClone(candidate)
  wrong.scenes[0].requiredBeats[0].description = '周福召集同道，组织朋徒对抗房植。'
  const input = { candidate: wrong, review: '{bad', citations }
  const direct = acceptPrincipleTextQuality(input)
  assert.equal(direct.passed, false)
  assert.equal(direct.issues[0].verifiedBy, 'historical-agency-guard')
  assert.equal(direct.issues[0].itemId, 'scene-07')
  const embedded = await executeCodeNode({ code: PRINCIPLE_TEXT_ACCEPT_CODE, params: { candidate: wrong, review: input.review }, context: { historical_sources: { citations } } })
  assert.deepEqual(embedded, { ...direct, executionLogs: [] })
  const clean = await executeCodeNode({ code: PRINCIPLE_TEXT_ACCEPT_CODE, params: { candidate, review: report() }, context: { historical_sources: { citations } } })
  assert.equal(clean.passed, true)
})

test('gate preserves repair budgets and matches isolated sandbox for source-bound storyboard review', async () => {
  const shot = { id: 'shot-01', videoPrompt: '房植门生转身离开。', repairProvenance: { generationAttempts: 3, candidateVersion: 4, episodeRewriteCount: 1 } }
  const issue = { ...groundedIssue(), itemId: shot.id, evidence: { ...groundedIssue().evidence, path: 'videoPrompt' } }
  const review = { ...report(), decision: 'revise', issues: [issue] }
  const direct = acceptPrincipleTextQuality({ candidate: shot, review, citations, sourceCandidate })
  const embedded = await executeCodeNode({ code: PRINCIPLE_TEXT_ACCEPT_CODE, params: { candidate: shot, review }, context: { historical_sources: { citations }, scene: sourceCandidate } })
  assert.deepEqual(embedded, { ...direct, executionLogs: [] })
  assert.equal(direct.repairContext.generationAttempts, 3)
  assert.equal(direct.repairContext.candidateVersion, 5)
  assert.equal(direct.repairContext.episodeRewriteCount, 1)
})

test('missing or unusable candidates cannot be promoted by optional review handling', () => {
  for (const input of [null, 'json', {}, { scenes: [] }, { scenes: [{}] }, { scenes: [{ id: 'empty' }] }, { scenes: 'bad' }, { id: 'shot-01' }]) {
    assert.throws(() => acceptPrincipleTextQuality({ candidate: input, review: report() }), /PRINCIPLE_TEXT_INPUT_INVALID/)
  }
  assert.match(PRINCIPLE_TEXT_REVIEW_PROMPT, /无需 passed、逐场 evidence/)
  assert.match(PRINCIPLE_TEXT_REVIEW_PROMPT, /不能要求每段重复完整戏/)
})

test('replacement reviewer prompt renders the real current candidate, source text and allocated scene', () => {
  const prompt = renderWorkflowTemplate(PRINCIPLE_TEXT_REVIEW_PROMPT, { params: { candidate }, historical_sources: { citations }, scene: sourceCandidate })
  assert.ok(prompt.includes(candidate.scenes[0].requiredBeats[0].description))
  assert.ok(prompt.includes(citations[0].content))
  assert.ok(prompt.includes(sourceCandidate.requiredBeats[0].description))
  assert.match(prompt, /当前原史料明确反证.*即位、死亡.*historical_era 原则问题/)
  assert.match(prompt, /不能以“戏剧逻辑可接受”或“历史精确度建议”降为 warnings/)
  assert.match(prompt, /仍须提交当前候选 quote 与原史料 sourceQuote.*普通拟制日常对白和服饰小差仍作为建议/)
  assert.equal(prompt.includes('${'), false)
})

test('dramatic expression advice renders with current script and preserves approved speech without a retake', () => {
  const shot = { id: 'shot-style', videoPrompt: '门生抿嘴收回招呼。', audioText: '门生：吾不敢苟同。' }
  const before = structuredClone(shot)
  const warning = { code: 'dialogue_clarity', itemId: shot.id, problem: '此句文言表达增加首次观看者理解负担',
    repair: '在上游大纲下次改编时采用自然现代汉语，当前分镜保留已批准台词',
    evidence: { source: 'candidate', path: 'audioText', quote: '吾不敢苟同' } }
  const review = { ...report(), warnings: [warning] }
  const result = acceptPrincipleTextQuality({ candidate: shot, review, sourceCandidate: shot })
  assert.equal(result.passed, true)
  assert.equal(result.qualityReview.status, 'needs_attention')
  assert.deepEqual(result.issues, [])
  assert.equal(result.audioText, shot.audioText)
  assert.deepEqual(shot, before)
  assert.deepEqual(result.qualityReview.warnings, [warning])
  assert.deepEqual(result.qualityReview.rawReport, review)
  const prompt = renderWorkflowTemplate(PRINCIPLE_TEXT_REVIEW_PROMPT, { params: { candidate: shot }, historical_sources: { citations }, scene: shot })
  assert.equal(prompt.split(DRAMATIC_EXPRESSION_TEXT_REVIEW_PROMPT).length - 1, 1)
  assert.ok(prompt.indexOf(DRAMATIC_EXPRESSION_TEXT_REVIEW_PROMPT) < prompt.indexOf('【当前候选，所有问题仅限此版本】'))
  assert.ok(prompt.includes(shot.audioText))
  assert.equal(prompt.includes('${'), false)
})
