import test from 'node:test'
import assert from 'node:assert/strict'
import { executeCodeNode } from '../server/code-node.ts'
import { migrateBranchWorkflow, refreshReportRetryBranches } from '../src/branch-migration.ts'
import { branchRunContext, orderRouteNodes, routeBranch, type BranchRun } from '../src/workflow-branch.ts'
import { reportFormatRetryFeedback } from '../src/review-retry.ts'
import { renderRetryFeedbackPrompt } from '../src/workflow-template.ts'

const node = (id: string, kind = 'code') => ({ id, title: id, kind, resultVar: id, code: 'return {};', prompt: '', position: { x: 0, y: 0 },
  params: [] as Array<{ id: string; name: string; englishName?: string; type: string; value: string; required: boolean }> })
const edge = (from: string, to: string) => ({ id: `${from}-${to}`, from, to })
const error = 'REVIEW_RESULT_INVALID: 缺少逐人动作审核证据：s2 / 房家宾客'
const candidate = { scenes: [{ id: 's1', cast: ['周家宾客'], requiredBeats: [{ id: 'b1' }] }, { id: 's2', cast: ['房家宾客'], requiredBeats: [{ id: 'b2' }] }] }
const previousReport = { passed: true, checks: [{ itemId: 's1', character: '周家宾客' }], evidence: [{ itemId: 'invented-report-scene' }] }

function workflow() {
  const reviewer = { ...node('review', 'text'), prompt: '审核 ${params.candidate}。前镜 ${loop.previous.shot_script}。',
    params: [{ id: 'candidate', name: '当前候选', englishName: 'candidate', type: 'json', value: '${draft}', required: true }] }
  const gate = { ...node('gate'), code: `throw Error(${JSON.stringify(error)});`, errorRetry: { retryFrom: 'review', maxAttempts: 2, patterns: ['REVIEW_RESULT_INVALID:', 'NETWORK:'] } }
  return migrateBranchWorkflow({ nodes: [node('writer', 'text'), reviewer, gate, node('done')], edges: [edge('writer', 'review'), edge('review', 'gate'), edge('gate', 'done')] })
}

test('actual error branch → routeBranch → branchRunContext preserves the failed report and exact candidate coverage', async () => {
  const w = workflow(), original = { draft: structuredClone(candidate) }
  const gate = w.nodes.find(node => node.id === 'gate')!
  const gateOutput = await executeCodeNode({ code: gate.code, context: { ...original, review: previousReport } })
  const failureContext = { ...original, review: previousReport, gate: gateOutput,
    loop: { previous: { shot_script: { id: 'older-shot', characters: ['旧镜人物'] } } }, branch: { visits: 0, counts: { true: 0, false: 0 } } }
  const branch = w.nodes.find(node => node.kind === 'branch')!
  const output = await executeCodeNode({ code: branch.code, params: { patterns: ['REVIEW_RESULT_INVALID:'], maxAttempts: 2 }, context: failureContext })
  assert.deepEqual(output.feedback, { kind: 'report-format', error })
  const runs: BranchRun[] = orderRouteNodes(w).ordered.map(n => ({ id: n.id, node: n, status: n.id === branch.id ? 'running' : 'success', durationMs: 0,
    context: failureContext, inputContext: original, output: n.id === 'writer' ? candidate : n.id === 'review' ? previousReport : undefined }))
  const transition = routeBranch(w, runs, runs.findIndex(run => run.node.id === branch.id), output, failureContext)
  const target = transition.runs[transition.index]
  assert.equal(target.node.id, 'review')
  assert.equal(transition.runs[0].status, 'success', 'report correction never rewinds the candidate writer')
  assert.equal(transition.runs[0].output, candidate)
  assert.equal(target.output, undefined, 'the failed report must not masquerade as a current accepted output')
  const resumed = branchRunContext(target, {})
  const feedback = (resumed.retry as { feedback: Record<string, unknown> }).feedback
  assert.deepEqual(feedback.previousReport, previousReport)
  assert.equal(feedback.error, error)
  assert.deepEqual(feedback.coverage, [
    { path: 'draft.scenes.0', itemId: 's1', characters: ['周家宾客'], beatIds: ['b1'] },
    { path: 'draft.scenes.1', itemId: 's2', characters: ['房家宾客'], beatIds: ['b2'] },
  ])
  assert.deepEqual(resumed.draft, candidate)
  assert.equal(resumed.review, undefined)
  assert.equal(transition.runs.find(run => run.node.id === branch.id)!.branchState!.counts.false, 1)
  assert.equal((branchRunContext({ attempt: 2 }, resumed).retry as { feedback: unknown }).feedback, '', 'the feedback is local to the reviewer')
  await assert.rejects(executeCodeNode({ code: branch.code, params: { patterns: ['REVIEW_RESULT_INVALID:'], maxAttempts: 2 }, context: {
    ...failureContext, branch: { visits: 1, counts: { true: 0, false: 1 } },
  } }), /异常复核达到上限 2/)
})

test('old error strings get the same report context, while business and transport errors stay unchanged', () => {
  const w = workflow(), reviewer = w.nodes.find(node => node.id === 'review')!, branch = w.nodes.find(node => node.kind === 'branch')!
  const context = { draft: candidate, review: previousReport }
  const runs: BranchRun[] = orderRouteNodes(w).ordered.map(n => ({ id: n.id, node: n, status: 'success', durationMs: 0, inputContext: { draft: candidate }, context }))
  const index = runs.findIndex(run => run.node.id === branch.id)
  const routed = routeBranch(w, runs, index, { value: false, feedback: error }, context)
  assert.deepEqual((routed.runs[routed.index].retryFeedback as Record<string, unknown>).previousReport, previousReport)
  for (const feedback of ['NETWORK: connection refused', { scope: 'scene', previousCandidate: candidate }, { kind: 'report-format', error: 'NETWORK: timeout' }]) {
    const routed = routeBranch(w, runs, index, { value: false, feedback }, context)
    assert.equal(routed.runs[routed.index].retryFeedback, feedback)
  }
  assert.equal(reportFormatRetryFeedback({ ...reviewer, kind: 'video' }, context, error), error)
})

test('media review coverage comes from its declared current shot, and missing reports are not invented', () => {
  const shot = { id: 's3', characters: ['周家宾客'], beatDramaturgy: [{ beatId: 'b3' }] }
  const target = { kind: 'text', resultVar: 'media_review', prompt: '${shot_script}\n${video_evidence}\n${loop.previous.shot_script}' }
  const result = reportFormatRetryFeedback(target, { shot_script: shot, video_evidence: { frames: ['/actual.jpg'] } }, error) as Record<string, unknown>
  assert.equal(result.previousReportAvailable, false)
  assert.equal(result.previousReport, undefined)
  assert.deepEqual(result.coverage, [{ path: 'shot_script', itemId: 's3', characters: ['周家宾客'], beatIds: ['b3'] }])
  assert.doesNotMatch(String(result.instruction), /dramaturgyReview|validEvidenceRefs|uncovered/)
})

test('media report repair preserves the draft as evidence but corrects disproved refusal conclusions without inventing another schema', () => {
  const report = { decision: 'rejected', passed: false, issues: ['ASR字形不同，但音素错误率未超阈值，不构成错音拒绝依据'], defectEvidence: [], warnings: ['帧中仍有原要求动作差异'] }
  const context = { shot_script: { id: 'shot-1', characters: ['甲'] }, video_evidence: { frames: ['/real.jpg'] }, media_review: report }
  const original = structuredClone(context)
  const feedback = reportFormatRetryFeedback({ kind: 'text', resultVar: 'media_review', prompt: '${shot_script}\n${video_evidence}' }, context,
    'REVIEW_RESULT_INVALID: defectEvidence 必须逐项覆盖全部 issues') as Record<string, unknown>
  assert.deepEqual(feedback.previousReport, report);assert.deepEqual(context, original)
  assert.doesNotMatch(String(feedback.instruction), /dramaturgyReview|validEvidenceRefs|uncovered/)
  assert.match(String(feedback.instruction), /不保留已被否定的结论/)
  assert.match(String(feedback.instruction), /重新核对 issues、逐项检查与最终判定的一致性/)
  assert.match(String(feedback.instruction), /真实有据缺陷仍须保留，未知仍为未知/)
})

// The real reviewer kept re-emitting `passed` with empty evidenceRefs on retry because the
// feedback never said which indexes exist or that one index may serve several dimensions.
test('dramaturgy retry feedback hands back the exact index budget and the previous verdicts', () => {
  const dramaturgyReview = { version: 'dramaturgy-v1', passed: true, evidence: [{ itemId: 's1' }, { itemId: 's2' }],
    orientation: { status: 'passed', reason: '处境清楚', evidenceRefs: [] },
    payoff: { status: 'not_applicable', reason: '结尾回应不在本镜', evidenceRefs: [] } }
  const target = { kind: 'text', resultVar: 'shot_script_review', params: [{ englishName: 'candidate', value: '${shot_candidate}' }] }
  const result = reportFormatRetryFeedback(target, { shot_candidate: candidate,
    shot_script_review: { passed: true, issues: [], evidence: [], dramaturgyReview } },
  'REVIEW_RESULT_INVALID: 叙事报告 orientation缺少声画证据索引') as Record<string, unknown>
  const dramaturgy = result.dramaturgy as Record<string, unknown>
  assert.equal(dramaturgy.evidenceCount, 2)
  assert.deepEqual(dramaturgy.validEvidenceRefs, [0, 1])
  assert.equal(dramaturgy.indexReuseAllowed, true)
  assert.equal(dramaturgy.notApplicableAllowed, true)
  assert.deepEqual(dramaturgy.checks, [{ key: 'orientation', status: 'passed', evidenceRefs: [] },
    { key: 'payoff', status: 'not_applicable', evidenceRefs: [] }])
  const instruction = String(result.instruction)
  assert.match(instruction, /全部修完再返回/)
  assert.match(instruction, /同一条索引可被多个分项复用/)
  assert.match(instruction, /不属于编造通过/)
  assert.deepEqual((result.previousReport as Record<string, unknown>).dramaturgyReview, dramaturgyReview)
  // Reviewers without a dramaturgy report keep the feedback shape they already had.
  const plain = reportFormatRetryFeedback(target, { shot_candidate: candidate }, error) as Record<string, unknown>
  assert.equal('dramaturgy' in plain, false)
})

test('report-format feedback names both audio-visual coverage channels and keeps earlier declarations', () => {
  const dramaturgyReview = { version: 'dramaturgy-v1', passed: true, evidence: [{ itemId: 's1' }, { itemId: 's2' }],
    uncovered: [{ itemId: 's2', reason: '空镜由 s1 承担', coveredBy: 's1' }],
    orientation: { status: 'passed', reason: '处境清楚', evidenceRefs: [0] } }
  const target = { kind: 'text', resultVar: 'scene_outline_review', params: [{ englishName: 'candidate', value: '${draft}' }] }
  const context = { draft: candidate, scene_outline_review: { passed: true, issues: [], evidence: [], dramaturgyReview } }
  const result = reportFormatRetryFeedback(target, context, 'REVIEW_RESULT_INVALID: 叙事报告 s3缺少声画覆盖') as Record<string, unknown>
  const channels = result.dramaturgyCoverageChannels as Record<string, unknown>
  assert.match(String(channels.evidence), /itemId 单场逐字引用（不支持 itemIds）/)
  assert.match(String(channels.uncovered), /已被 evidence 引用的、与本场同一个 dramaticSceneId/)
  assert.deepEqual(channels.neverUncoverable, ['候选首场', '候选末场', 'episodeDrama.openingPromise.beatIds 所属场', 'episodeDrama.payoff.beatIds 所属场', '单场候选'])
  assert.equal(channels.alreadyCitedCannotBeDeclared, true)
  assert.equal(channels.everyDramaticSceneNeedsOneCitation, true)
  const instruction = String(result.instruction)
  assert.match(instruction, /在 uncovered 里声明由同一场完整戏内哪个已落点短段承担/)
  assert.match(instruction, /不重排、不改写、不删除/)
  // The previous report comes back whole: the reviewer may keep every established row.
  assert.deepEqual(((result.previousReport as Record<string, unknown>).dramaturgyReview as Record<string, unknown>).uncovered, dramaturgyReview.uncovered)
  // Reviewers without a dramaturgy evidence list keep the feedback shape they already had.
  const plain = reportFormatRetryFeedback(target, { draft: candidate }, error) as Record<string, unknown>
  assert.equal('dramaturgyCoverageChannels' in plain, false)
})

test('historical report repair names the missing source-evidence scene independently from dramaturgy coverage', () => {
  const scenes = Array.from({ length: 11 }, (_, index) => ({ id: `scene-${String(index + 1).padStart(2, '0')}`,
    cast: ['周福门生'], requiredBeats: [{ id: `beat-${index + 1}` }] }))
  const ids = scenes.map(scene => scene.id)
  const report = { passed: false, issues: [{ itemId: 'scene-07', problem: '原演员名单问题', repair: '按实际声画核对' }],
    evidence: [{ itemIds: ids.filter(id => id !== 'scene-07'), sourceSpanId: 'actual-span', supports: '该实际原文支持这些场次' }],
    dramaturgyReview: { evidence: ids.filter(id => id !== 'scene-07').map(itemId => ({ itemId, path: 'actual.path', quote: '原声画正文' })),
      uncovered: [{ itemId: 'scene-07', reason: '声画由同场另段承担', coveredBy: 'scene-06' }],
      issues: [{ itemId: 'scene-07', path: 'scenes.6.cast', quote: '原演员名单' }] } }
  const target = { kind: 'text', operation: 'history.script-review', resultVar: 'scene_outline_review',
    params: [{ englishName: 'candidate', value: '${draft}' }] }
  const context = { draft: { scenes }, historical_sources: { citations: [{ text: '实际史料原文' }] }, scene_outline_review: report }
  const before = JSON.stringify(context)
  const result = reportFormatRetryFeedback(target, context, 'REVIEW_RESULT_INVALID: scene-07 缺少逐场史料引证') as Record<string, unknown>
  const source = result.sourceEvidenceCoverage as Record<string, unknown>
  const drama = result.dramaturgyCoverageChannels as Record<string, unknown>
  assert.deepEqual(source.expectedItemIds, ids)
  assert.deepEqual(source.declaredItemIds, ids.filter(id => id !== 'scene-07'))
  assert.deepEqual(source.missingItemIds, ['scene-07'])
  assert.match(String(source.shared), /允许.*itemIds/)
  assert.match(String(source.noExemption), /uncovered.*不能豁免史料引证/)
  assert.deepEqual(drama.declaredUncoveredItemIds, ['scene-07'])
  assert.deepEqual(drama.missingItemIds, [], 'an uncovered declaration belongs only to the audio-visual layer')
  assert.equal(source.declarationOnly, true)
  assert.equal(drama.declarationOnly, true)
  assert.deepEqual(result.previousReport, report)
  assert.equal(JSON.stringify(context), before)
  const prompt = renderRetryFeedbackPrompt(result)
  assert.match(prompt, /sourceEvidenceCoverage/)
  assert.match(prompt, /"missingItemIds":\["scene-07"\]/)
  assert.match(prompt, /review\.evidence 是报告最外层的事实史料引证/)
  assert.match(prompt, /review\.dramaturgyReview\.evidence 是候选中的实际声画落点/)
})

test('fixing an invalid issue locator preserves both existing evidence layers and shared source declarations', () => {
  const target = { kind: 'text', operation: 'history.script-review', resultVar: 'review', params: [{ englishName: 'candidate', value: '${draft}' }] }
  const report = { passed: false, evidence: [{ itemIds: ['s1', 's2'], sourceSpanId: 'source-span', supports: '当前史料共同支持' }],
    dramaturgyReview: { evidence: [{ itemId: 's1', quote: '实际声画一' }, { itemId: 's2', quote: '实际声画二' }],
      issues: [{ itemId: 's2', path: 'scenes.1.cast', quote: '演员名单', problem: '无实际声画定位' }] } }
  const context = { draft: candidate, historical_sources: { citations: [{ text: '原文' }] }, review: report }
  const result = reportFormatRetryFeedback(target, context, 'REVIEW_RESULT_INVALID: 叙事报告 issues[0] 证据必须定位实际 beat/action/dialogue，不能用幕后意图：scenes.1.cast') as Record<string, unknown>
  assert.deepEqual((result.sourceEvidenceCoverage as Record<string, unknown>).missingItemIds, [])
  assert.deepEqual((result.dramaturgyCoverageChannels as Record<string, unknown>).missingItemIds, [])
  assert.deepEqual(result.previousReport, report)
  assert.match(String(result.instruction), /不能通过删除任何一层 evidence.*缩小 itemIds 来修复 issue/)
  assert.match(String(result.instruction), /不能补造动作引文/)
  const noSource = reportFormatRetryFeedback(target, { draft: candidate, review: report }, error) as Record<string, unknown>
  assert.equal('sourceEvidenceCoverage' in noSource, false)
  const noCandidate = reportFormatRetryFeedback({ ...target, params: [] }, context, error) as Record<string, unknown>
  assert.equal('sourceEvidenceCoverage' in noCandidate, false)
  const media = reportFormatRetryFeedback({ ...target, operation: 'history.media-review' }, context, error) as Record<string, unknown>
  assert.equal('sourceEvidenceCoverage' in media, false, 'upstream historical sources do not change the current media review contract')
})

test('source-citation retries also expose independent dramaturgy locator and index failures without rewriting the draft', () => {
  const draft = { scenes: candidate.scenes.map((scene, index) => ({ ...scene, dramaticSceneId: `drama-${index}`,
    requiredBeats: [{ ...scene.requiredBeats[0], observable: { visual: [`${scene.cast[0]}转身离开`], audio: [] } }] })) }
  const evidence = draft.scenes.map((scene, index) => ({ itemId: scene.id, beatId: scene.requiredBeats[0].id,
    path: `scenes.${index}.requiredBeats.0.observable.visual.0`, quote: scene.requiredBeats[0].observable.visual[0], finding: '人物实际转身离开' }))
  const check = { status: 'passed', reason: '当前声画已呈现', evidenceRefs: [0] }
  const report = { passed: false, evidence: [{ itemId: 's1', sourceSpanId: 'actual-span', supports: '来源支持' }],
    dramaturgyReview: { version: 'dramaturgy-v1', passed: false, evidence, warnings: [], repairScope: 'scene',
      issues: [{ code: 'indistinct_character_action', itemId: 's2', beatId: 'b2', path: 'scenes.1.cast', quote: '房家宾客',
        problem: '演员名单无法证明声画行动', repair: '核对实际声画', scope: 'scene' }],
      orientation: check, dramaticProgression: check, characterDistinction: check, payoff: { ...check, evidenceRefs: [2] } } }
  const target = { kind: 'text', operation: 'history.script-review', resultVar: 'review', params: [{ englishName: 'candidate', value: '${draft}' }] }
  const context = { draft, historical_sources: { citations: [{ text: '原文' }] }, review: report }
  const before = JSON.stringify(context)
  const initialError = 'REVIEW_RESULT_INVALID: s2 缺少逐场史料引证'
  const result = reportFormatRetryFeedback(target, context, initialError) as Record<string, unknown>
  assert.equal(result.error, initialError, 'independent diagnostics never replace the routed original error')
  assert.deepEqual((result.sourceEvidenceCoverage as Record<string, unknown>).missingItemIds, ['s2'])
  assert.match(String(result.dramaturgyValidationError), /issues\[0\].*scenes\.1\.cast/)
  assert.match(String(result.dramaturgyValidationError), /payoff.*\[2\].*不是有效证据索引/)
  assert.match(String(result.instruction), /同时修正这些已知问题/)
  assert.deepEqual(result.previousReport, report)
  assert.equal(JSON.stringify(context), before)
  const repaired = structuredClone(context)
  repaired.review.dramaturgyReview.issues = []
  repaired.review.dramaturgyReview.passed = true
  repaired.review.dramaturgyReview.payoff.evidenceRefs = [1]
  const sourceOnly = reportFormatRetryFeedback(target, repaired, initialError) as Record<string, unknown>
  assert.equal('dramaturgyValidationError' in sourceOnly, false, 'a valid independent report is not given an invented format defect')
  const media = reportFormatRetryFeedback({ ...target, operation: 'history.media-review' }, context, initialError) as Record<string, unknown>
  assert.equal('dramaturgyValidationError' in media, false)
})

test('embedded code refresh changes only legacy report-error feedback and is idempotent', async () => {
  const old = { ...node('custom-error', 'branch'), code: `const error=context.gate?.routeError;\nif(!error)return true;\nif(branch.counts.false>6)throw Error('custom limit');\nreturn { value: false, feedback: error };` }
  const content = { ...node('business', 'branch'), code: 'return { value: false, feedback: error };' }
  const w = { nodes: [old, content], edges: [] }
  const updated = refreshReportRetryBranches(w)
  assert.equal(updated.nodes[1], content)
  assert.equal(updated.edges, w.edges)
  assert.ok(updated.nodes[0].code.startsWith(old.code.split('return { value: false')[0]))
  assert.equal(refreshReportRetryBranches(updated), updated)
  const context = { gate: { routeError: error }, branch: { counts: { false: 0 } } }
  assert.deepEqual((await executeCodeNode({ code: updated.nodes[0].code, context })).feedback, { kind: 'report-format', error })
  assert.equal((await executeCodeNode({ code: updated.nodes[0].code, context: { ...context, gate: { routeError: 'NETWORK: no connection' } } })).feedback, 'NETWORK: no connection')
})
