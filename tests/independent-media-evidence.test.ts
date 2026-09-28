import test from 'node:test'
import assert from 'node:assert/strict'
import { upgradeQualityWorkflow, upgradeIndependentMediaEvidence, upgradeScopedMediaDefects, upgradeLiveMediaPolicy, MEDIA_DEFECT_EVIDENCE_CODE, SCOPED_MEDIA_DEFECT_EVIDENCE_CODE, COMPLETE_MEDIA_DEFECT_EVIDENCE_CODE, REQUIREMENT_REVIEW_METRICS_CODE, INDEPENDENT_MEDIA_REVIEW_VIEW_CODE } from '../src/quality-node-presets.ts'
import { resolveNodePolicy } from '../src/node-policy-input.ts'
import { refreshIndependentMediaReviewPrompt } from '../src/media-observation.ts'
import { nodePromptInputContext } from '../src/review-input.ts'
import { renderWorkflowTemplate, renderRetryFeedbackPrompt, resolveTemplateJsonValue } from '../src/workflow-template.ts'
import { reportFormatRetryFeedback } from '../src/review-retry.ts'
import { executeCodeNode } from '../server/code-node.ts'
import { deriveMediaRequirements } from '../src/media-requirement-coverage.ts'
import { deriveRequirementReviewInputs, type RequirementReviewInput } from '../src/media-requirement-review.ts'
import { deriveMediaEvidenceViews } from '../src/media-evidence-views.ts'

const base = { id: 'wf-sanguo-history-drama', schemaVersion: 59,
  nodes: ['sanguo-scene-outline', 'sanguo-shot-script', 'sanguo-character-image', 'sanguo-video', 'sanguo-last-frame', 'loop'].map(id => ({
    id, title: id, kind: id === 'sanguo-video' ? 'video' : id === 'sanguo-shot-script' ? 'text' : 'code', resultVar: id, modelId: 'configured-model', prompt: 'test', params: [], uploads: [],
    loop: { enabled: false, sourcePath: '', fallbackCount: 1, itemVar: 'item' }, position: { x: 0, y: 0 }, parentId: 'loop',
    ...(id === 'loop' ? { childIds: ['sanguo-shot-script', 'sanguo-character-image', 'sanguo-video', 'sanguo-last-frame'] } : {}),
  })), edges: [{ id: 'video-tail', from: 'sanguo-video', to: 'sanguo-last-frame' }] }
const observerSentinel = 'OBSERVER_DRAFT_SHOULD_NOT_ENTER_REVIEW_47d2'
const evidenceContext = {
  shot_script: { id: 'shot-current', videoPrompt: 'STATE_AND_ACTION_STANDARD', completionCriteria: ['ORIGINAL_COMPLETION_CRITERION'] },
  video_evidence: { frames: ['/generated/original-frame-0.jpg', '/generated/original-frame-1.jpg'], frameTimes: [0, 13.96],
    duration: 14.04, speechValidation: { alignment: [{ text: 'ACTUAL_ASR_WORDS', actualStart: 1, actualEnd: 2 }] } },
  media_metrics: { unitCriteria: ['ORIGINAL_COMPLETION_CRITERION'], requirements: [{id: 'req-1', requirementPath: 'videoPrompt', requirementQuote: 'STATE_AND_ACTION_STANDARD', scope: 'interval', startSecond: 0, endSecond: 14}], speech: [{ text: 'ACTUAL_ASR_WORDS', allowedSpan: 4.25, timingAssessment: 'within-allowance' }],
    tailTiming: { assessment: 'within-allowance', seconds: .65 }, policy: { maxIdleTailSeconds: 1.2 } },
  media_observations: { items: [{ index: 0, setting: observerSentinel, people: [{ heldObjects: observerSentinel }], tailObservation: observerSentinel }] },
}

test('schema95 shipped reviewer renders raw frames, ASR, computed limits and script standards without the observation payload', () => {
  const workflow = upgradeQualityWorkflow(base), reviewer = workflow.nodes.find(node => node.id === 'sanguo-media-review')!
  const param = (name: string) => reviewer.params.find(item => item.englishName === name)!
  const promptContext = nodePromptInputContext(evidenceContext, param('promptInputMode').value)
  const prompt = renderWorkflowTemplate(reviewer.prompt, promptContext) + renderRetryFeedbackPrompt(undefined)
  assert.ok(!prompt.includes(observerSentinel));assert.ok(!/\$\{media_observations(?:\.|\})/.test(reviewer.prompt))
  for (const actual of ['ACTUAL_ASR_WORDS', 'STATE_AND_ACTION_STANDARD', 'ORIGINAL_COMPLETION_CRITERION', '/generated/original-frame-0.jpg', '4.25', 'within-allowance']) {
    assert.ok(prompt.includes(actual), actual + ' must remain available to the reviewer')
  }
  assert.deepEqual(resolveTemplateJsonValue(param('reviewImages').value, evidenceContext), evidenceContext.video_evidence.frames)
  const views = deriveMediaEvidenceViews(evidenceContext.video_evidence)
  assert.equal(param('reviewImageDetail').value, '${media_metrics.reviewImageDetail}')
  assert.deepEqual(resolveTemplateJsonValue(param('reviewImageDetail').value,
    { ...evidenceContext, media_metrics: { ...evidenceContext.media_metrics, reviewImageDetail: views.reviewImageDetail } }),
  { indices: [0], columns: 2, rows: 2, overlap: .25 })
  for (const policy of ['defectEvidence', 'confirmed/uncertain', 'unknown', 'consistent=false须确证', '不是新的时间帧', '允许第一帧已经成立']) {
    assert.ok(prompt.includes(policy), policy + ' must remain in the current policy')
  }
  assert.deepEqual(evidenceContext.media_observations.items[0].people[0].heldObjects, observerSentinel, '独立观察仍在执行记录中，不能删除证据')
})

test('coverage module inventories authored windows in real metrics and requires bound defects independently of the complete gate', async () => {
  const latest = upgradeQualityWorkflow(base)
  const metricsNode = latest.nodes.find(node => node.id === 'sanguo-media-metrics')!
  const gate = latest.nodes.find(node => node.id === 'sanguo-media-accept')!
  const shot = { duration: 4, audioType: '环境声', audioText: '', storyProgress: {status: 'continuing', pendingActions: []}, completionCriteria: [], videoPrompt: '0-2秒：人物坐在案后。2-4秒：人物站起。', lastFramePrompt: '人物站在案旁。' }
  const evidence = { duration: 4, frames: ['/0.jpg', '/1.jpg', '/2.jpg'], frameTimes: [0, 2.8, 3.96] }
  const metrics = await executeCodeNode({ code: metricsNode.code!, params: { tailSeconds: .3, maxIdleTailSeconds: 1.2, timingToleranceSeconds: .25 }, context: { shot_script: shot, video_evidence: evidence, media_request: { speechWindows: [] } } })
  assert.deepEqual(metrics.requirements, deriveMediaRequirements(shot))
  assert.ok(gate.code!.includes(COMPLETE_MEDIA_DEFECT_EVIDENCE_CODE))
  const code = 'const shot=context.shot,review=context.review,e=context.evidence;\n' + COMPLETE_MEDIA_DEFECT_EVIDENCE_CODE + '\nreturn {issues,reportRepairPrompt};'
  const review = { passed: true, decision: 'accepted', issues: [], visualChecks: [], defectEvidence: [], requirementChecks: metrics.requirements.map((item: { id: string }, index: number) => ({ requirementId: item.id, status: 'complete', frameIndices: [[0], [1], [2]][index], evidence: ['人物坐在案后', '人物已站起', '末帧人物站在案旁'][index] })) }
  assert.deepEqual((await executeCodeNode({ code, params: { timingTolerance: .25 }, context: { shot, evidence, review } })).issues, [])
  await assert.rejects(() => executeCodeNode({ code, context: { shot, evidence, review: { ...review, requirementChecks: review.requirementChecks.slice(0, -1) } } }), /REVIEW_RESULT_INVALID:.*必须恰好复核一次/)
  const failed = structuredClone(review)
  Object.assign(failed.requirementChecks[2], { status: 'incomplete', evidence: '末帧人物实际坐在案后，与站立要求相反。' })
  await assert.rejects(() => executeCodeNode({ code, context: { shot, evidence, review: failed } }), /REVIEW_RESULT_INVALID:.*defectIndex/)
  Object.assign(failed.requirementChecks[2], { defectIndex: 0 })
  Object.assign(failed, { passed: false, decision: 'rejected', issues: ['末帧人物实际坐着，与站立要求相反。'], defectEvidence: [{ issueIndex: 0, status: 'confirmed', category: 'script', source: 'frame', frameIndices: [2], finding: '末帧人物实际坐着。', requirementPath: 'lastFramePrompt', requirementQuote: shot.lastFramePrompt, scope: 'ending', repair: '仅恢复原结尾要求的站姿。' }] })
  const result = await executeCodeNode({ code, context: { shot, evidence, review: failed } })
  assert.equal(result.issues.length, 1);assert.equal(result.reportRepairPrompt, '仅恢复原结尾要求的站姿。')
  const unknownOnly = structuredClone(review)
  Object.assign(unknownOnly.requirementChecks[0], { status: 'unobservable', frameIndices: [0], evidence: '该采样帧未展示完整过程。' })
  await assert.rejects(() => executeCodeNode({ code, context: { shot, evidence, review: unknownOnly } }), /REVIEW_RESULT_INVALID:.*不可观察且没有已确证拒绝依据/)
  const mixed = structuredClone(failed)
  mixed.requirementChecks[0] = unknownOnly.requirementChecks[0]
  const mixedResult = await executeCodeNode({ code, context: { shot, evidence, review: mixed } })
  assert.deepEqual(mixedResult.issues, result.issues);assert.equal(mixedResult.reportRepairPrompt, result.reportRepairPrompt, '未知要求不能进入仅针对确证缺陷的生成修复')
  const contradictory = structuredClone(failed)
  contradictory.requirementChecks[0].frameIndices = [2]
  Object.assign(contradictory, { defectEvidence: [{ issueIndex: 0, status: 'confirmed', category: 'speech', source: 'asr', rule: 'phonetic-error-rate', finding: 'ASR字形不同', repair: '纠正字形', startSecond: .5, endSecond: 2 }] })
  await assert.rejects(() => executeCodeNode({ code, params: { maxPhoneticErrorRate: .2 }, context: { shot, evidence: { ...evidence, speechValidation: { phoneticErrorRate: .02, alignment: [{ actualStart: 0, actualEnd: 4 }] } }, review: contradictory } }), error => {
    assert.ok(error instanceof Error);assert.match(error.message, /requirementCoverage:.*引用帧不在原要求/s);assert.match(error.message, /mediaDefects:.*实际 phoneticErrorRate 未超过/s);return true
  })
  assert.equal(upgradeQualityWorkflow(latest), latest)
})

async function latestGateFixture() {
  const workflow = upgradeQualityWorkflow(base), gate = workflow.nodes.find(node => node.id === 'sanguo-media-accept')!
  const metricsNode = workflow.nodes.find(node => node.id === 'sanguo-media-metrics')!
  const shot = { duration: 4, audioType: '环境声', audioText: '', characters: ['人物甲'], endCharacters: ['人物甲'],
    storyProgress: { unitId: 'scene-choice', status: 'continuing', pendingActions: [] }, completionCriteria: [],
    visualPrompt: '人物甲坐在案后。', videoPrompt: '0-2秒：人物甲坐在案后。2-4秒：人物甲保持站姿。', lastFramePrompt: '人物甲站在案旁。' }
  const evidence = { decoded: true, originalUrl: '/actual-video.mp4', evidenceUrl: '/actual-evidence.json', duration: 4, width: 1920, height: 1080, hasAudio: true, meanVolumeDb: -24,
    frames: ['/0.jpg', '/1.jpg', '/2.jpg', '/3.jpg', '/4.jpg'], frameTimes: [0, 1, 2, 3, 3.96], lastFrameUrl: '/4.jpg' }
  const request = { speechWindows: [] }, params = { durationTolerance: .5, aspectWidth: 16, aspectHeight: 9, aspectTolerance: .04, minVolumeDb: -50,
    maxPhoneticErrorRate: .2, tailSeconds: .3, timingTolerance: .25, maxFirstFrameDifference: .1, maxIdleTailSeconds: 1.2, maxRepairChars: 350, requireScriptStateEvidence: true,
    maxAdaptiveSamplingFrames:24,maxAdaptiveSamplingRounds:2 }
  const metrics = await executeCodeNode({ code: metricsNode.code!, params: { tailSeconds: .3, maxIdleTailSeconds: 1.2, timingToleranceSeconds: .25 },
    context: { shot_script: shot, video_evidence: evidence, media_request: request } })
  const inputs = metrics.requirementReviewInputs as RequirementReviewInput[]
  const mapped = { items: inputs.map(input => ({ requirementId: input.requirement.id, status: 'complete', evidence: '本次附件中人物的位置与姿态符合该范围要求。',
    frameIndices: input.attachmentReferences.map(frame => frame.index) }) as Record<string, unknown>), count: inputs.length }
  const review = { passed: true, decision: 'accepted', issues: [] as string[], defectEvidence: [] as Record<string, unknown>[],
    requirementChecks: inputs.map(input => ({ requirementId: input.requirement.id, status: 'complete', frameIndices: input.frameReferences.map(frame => frame.index), evidence: '综合报告声称该范围姿态均符合。' })),
    evidence: [{ source: 'frame', reference: 4, finding: '末帧人物站立。' }], endCharacters: ['人物甲'], endingState: '人物甲站在案旁。', warnings: [],
    narrativeClosure: { unitId: 'scene-choice', complete: false, actionEvidence: '人物由坐转为站立。', responseEvidence: '后续回应由下一镜继续。', unresolvedActions: [], criteriaChecks: [] },
    pacingReview: { passed: true, reason: '动作推进当前场景。', lastMeaningfulActionSecond: 3.96, performanceChecks: [] },
    tailTimingCheck: { assessment: 'not-applicable', reason: '环境声无语音时长判断。' }, speechChecks: [],
    visualChecks: [{ character: '人物甲', consistent: true, expectedObjects: '空手', actualObjectsByFrame: evidence.frames.map((_, index) => ({ index, objects: '空手' })), evidence: '原帧未见持物。' }],
    retryPrompt: '', text: '完整综合模型原文', raw: { content: [{ type: 'text', text: '完整综合模型原文' }] } }
  const context = { shot_script: shot, video_evidence: evidence, media_request: request, media_metrics: metrics, media_review: review, media_requirement_reviews: mapped,
    media_observations: { items: evidence.frames.map((_, index) => ({ index, setting: '案旁', people: [], tailObservation: '末尾人物位于案旁。' })) }, video_take: { params: { duration: 4 } } }
  return { workflow, gate, metricsNode, inputs, params, context }
}

test('schema103 actual metrics and complete VM gate use independent local image reviews without removing any validation block', async () => {
  const { workflow, gate, metricsNode, inputs, params, context } = await latestGateFixture()
  assert.equal(workflow.schemaVersion, 113)
  assert.equal(gate.params.find(param => param.englishName === 'requireScriptStateEvidence')?.value, 'true')
  const policySource = JSON.parse(workflow.nodes.find(node => node.id === 'sanguo-media-review')!.params.find(param => param.englishName === 'reviewPolicySource')!.value)
  assert.ok(policySource.fields.includes('requireScriptStateEvidence'))
  assert.ok(metricsNode.code!.includes(REQUIREMENT_REVIEW_METRICS_CODE))
  assert.ok(gate.code!.includes(INDEPENDENT_MEDIA_REVIEW_VIEW_CODE));assert.ok(gate.code!.includes(COMPLETE_MEDIA_DEFECT_EVIDENCE_CODE))
  assert.deepEqual(inputs, deriveRequirementReviewInputs(context.shot_script, context.video_evidence))
  assert.deepEqual(inputs.map(input => input.frameReferences.map(frame => frame.index)), [[0], [0, 1, 2], [2, 3, 4], [4]])
  const node = workflow.nodes.find(node => node.id === 'sanguo-requirement-review')!
  assert.deepEqual(node.mapInput, { sourcePath: 'media_metrics.requirementReviewInputs', itemVar: 'requirementInput', maxItems: 24, concurrency: 4 })
  const lastInput = inputs.at(-1)!, mappedContext = { ...context, requirementInput: lastInput }
  const prompt = renderWorkflowTemplate(node.prompt, nodePromptInputContext(mappedContext, 'normalized-results'))
  assert.match(prompt, /"index":\s*0/);assert.doesNotMatch(prompt, /"index":\s*4/, '模型不能看到尾帧的全片索引4并当成本次附件编号')
  assert.deepEqual(resolveTemplateJsonValue(node.params.find(param => param.englishName === 'reviewImages')!.value, mappedContext), ['/4.jpg'])
  const original = structuredClone(context), accepted = await executeCodeNode({ code: gate.code!, params, context })
  assert.equal(accepted.passed, true);assert.deepEqual(accepted.issues, [])
  assert.deepEqual(accepted.visualReview.independentReviewProvenance.primaryReview, context.media_review)
  assert.deepEqual(accepted.visualReview.raw, context.media_review.raw);assert.equal(accepted.visualReview.text, context.media_review.text)
  assert.deepEqual(context, original, 'VM派生验收视图不改原综合报告、原采证或映射结果')
})

test('complete embedded gate preserves independent interval and tail refusals over primary accepted and translates local indexes to original frames', async () => {
  const { gate, inputs, params, context } = await latestGateFixture()
  context.media_requirement_reviews.items[2] = { requirementId: inputs[2].requirement.id, status: 'incomplete', evidence: '本次附件1中人物实际坐在案后，与该范围保持站姿相反。', frameIndices: [1], repair: '仅在原时间窗内保持站姿。',
    defect: { basis: 'visible-state-contradiction', violatedQuote: '人物甲保持站姿', requiredStateQuote: '站姿', observedState: '人物坐在案后', temporalBasis: 'sustained-state', persistenceQuote: '保持站姿' } }
  context.media_requirement_reviews.items[3] = { requirementId: inputs[3].requirement.id, status: 'incomplete', evidence: '本次末帧人物实际仍坐在案后。', frameIndices: [0], repair: '仅恢复原结尾站姿。',
    defect: { basis: 'visible-state-contradiction', violatedQuote: '人物甲站在案旁', requiredStateQuote: '站在案旁', observedState: '人物坐在案后', temporalBasis: 'state-at-sample' } }
  const original = structuredClone(context), result = await executeCodeNode({ code: gate.code!, params, context })
  assert.equal(result.passed, false);assert.equal(result.visualReview.decision, 'rejected');assert.equal(result.issues.length, 2)
  assert.equal(context.media_review.passed, true);assert.equal(result.visualReview.independentReviewProvenance.primaryReview.passed, true)
  assert.deepEqual(result.visualReview.requirementChecks[2].frameIndices, [3]);assert.deepEqual(result.visualReview.requirementChecks[3].frameIndices, [4])
  assert.deepEqual(result.visualReview.defectEvidence.map((defect: Record<string, unknown>) => [defect.issueIndex, defect.category, defect.source, defect.scope, defect.frameIndices]),
    [[0, 'script', 'frame', 'interval', [3]], [1, 'script', 'frame', 'ending', [4]]])
  assert.equal(result.visualReview.defectEvidence[0].requirementQuote, context.shot_script.videoPrompt.slice(context.shot_script.videoPrompt.indexOf('2-4秒')))
  assert.equal(result.visualReview.defectEvidence[1].requirementQuote, context.shot_script.lastFramePrompt)
  assert.equal(result.retryPrompt, '仅在原时间窗内保持站姿。；仅恢复原结尾站姿。')
  assert.deepEqual(context, original)
  const mixed = structuredClone(context)
  mixed.media_review.decision = 'rejected';mixed.media_review.passed = false;mixed.media_review.issues = ['人物面部五官重复。']
  mixed.media_review.defectEvidence = [{ issueIndex: 0, category: 'visual-artifact', rule: 'visual-deformation', source: 'frame', status: 'confirmed', frameIndices: [1], finding: '实际帧1人物五官重复。', repair: '修复人物五官重复。' }]
  const withPrimaryDefect = await executeCodeNode({ code: gate.code!, params, context: mixed })
  assert.equal(withPrimaryDefect.passed, false);assert.equal(withPrimaryDefect.issues.length, 3)
  assert.deepEqual(withPrimaryDefect.visualReview.defectEvidence[0], mixed.media_review.defectEvidence[0])
  assert.deepEqual(withPrimaryDefect.visualReview.defectEvidence.map((defect: Record<string, unknown>) => defect.issueIndex), [0, 1, 2])
  assert.deepEqual(withPrimaryDefect.visualReview.requirementChecks.slice(2).map((check: Record<string, unknown>) => check.defectIndex), [1, 2])
  assert.equal(withPrimaryDefect.retryPrompt, '修复人物五官重复。；仅在原时间窗内保持站姿。；仅恢复原结尾站姿。')
})

test('complete embedded gate keeps unknown-only on same material and retains only proven repairs when unknown and confirmed requirements coexist', async () => {
  const { gate, inputs, params, context } = await latestGateFixture()
  context.media_requirement_reviews.items[2] = { requirementId: inputs[2].requirement.id, status: 'unobservable', evidence: '人物被前景遮挡，无法确认完整姿态。', frameIndices: [1] }
  const unknown = await executeCodeNode({ code: gate.code!, params, context })
  assert.match(String(unknown.routeError), /REVIEW_RESULT_INVALID:.*证据不足.*不能因此购买新视频/)
  assert.equal(unknown.passed, undefined)
  assert.equal(unknown.samplingRetryPlan.sourceUrl, context.video_evidence.originalUrl)
  assert.equal(unknown.samplingRetryPlan.round, 1)
  assert.ok(unknown.samplingRetryPlan.sampleTimes.length > context.video_evidence.frameTimes.length)
  context.media_requirement_reviews.items[3] = { requirementId: inputs[3].requirement.id, status: 'incomplete', evidence: '末帧人物实际坐着，与结尾站姿要求相反。', frameIndices: [0], repair: '恢复原要求的结尾站姿。',
    defect: { basis: 'visible-state-contradiction', violatedQuote: '人物甲站在案旁', requiredStateQuote: '站在案旁', observedState: '人物坐在案后', temporalBasis: 'state-at-sample' } }
  const mixed = await executeCodeNode({ code: gate.code!, params, context })
  assert.equal(mixed.passed, false);assert.equal(mixed.issues.length, 1)
  assert.equal(mixed.visualReview.requirementChecks[2].status, 'unobservable');assert.deepEqual(mixed.visualReview.requirementChecks[2].frameIndices, [3])
  assert.equal(mixed.retryPrompt, '恢复原要求的结尾站姿。');assert.doesNotMatch(mixed.retryPrompt, /遮挡|无法确认/)
  const wrongIndex = structuredClone(context);wrongIndex.media_requirement_reviews.items[3].frameIndices = [4]
  await assert.rejects(() => executeCodeNode({ code: gate.code!, params, context: wrongIndex }), /REVIEW_RESULT_INVALID:.*本次附件的有效局部编号0\.\.0/)
  const missing = structuredClone(context);missing.media_requirement_reviews.items.pop()
  await assert.rejects(() => executeCodeNode({ code: gate.code!, params, context: missing }), /REVIEW_RESULT_INVALID:.*必须恰好有一份独立审核/)
  const absent = { ...context, media_requirement_reviews: undefined }
  await assert.rejects(() => executeCodeNode({ code: gate.code!, params, context: absent }), /REVIEW_RESULT_INVALID:.*映射结果必须为items数组或数组/)
  for (const media_review of [null, undefined, [], '尚未完成综合报告']) {
    await assert.rejects(() => executeCodeNode({ code: gate.code!, params, context: { ...context, media_review } }),
      /REVIEW_RESULT_INVALID:.*primaryReview必须为实际综合报告对象.*复核同一素材，不购买新视频/)
  }
})

test('schema95 only changes the shipped reviewer prompt and preserves current media parameters, gates, observer and graph', () => {
  const latest = upgradeQualityWorkflow(base)
  const old = { ...latest, schemaVersion: 94, nodes: latest.nodes.map(node => node.id === 'sanguo-media-review'
    ? { ...node, prompt: '用户附加规则\n' + node.prompt + '\n无剧本逐帧观察：${media_observations}' } : node) }
  const original = structuredClone(old), upgraded = upgradeIndependentMediaEvidence(old)
  assert.equal(upgraded.schemaVersion, 95);assert.equal(upgraded.edges, old.edges)
  for (let index = 0; index < old.nodes.length; index += 1) {
    const before = old.nodes[index], after = upgraded.nodes[index]
    if (before.id === 'sanguo-media-review') {
      assert.ok(after.prompt.startsWith('用户附加规则\n'));assert.ok(!after.prompt.includes('${media_observations}'))
      assert.deepEqual({ ...after, prompt: before.prompt }, before, '只改prompt，原图及局部附件、模型和采证配置均保留')
      assert.equal(refreshIndependentMediaReviewPrompt(after.prompt), after.prompt)
    } else assert.equal(after, before, '验收代码、独立观察与其他节点均不动')
  }
  assert.deepEqual(old, original);assert.equal(upgradeIndependentMediaEvidence(upgraded), upgraded)
  const other = { ...old, id: 'user-workflow' };assert.equal(upgradeIndependentMediaEvidence(other), other)
})

test('report-format repair resolves only current declared inputs and does not import the separate observation node', () => {
  const workflow = upgradeQualityWorkflow(base), reviewer = workflow.nodes.find(node => node.id === 'sanguo-media-review')!
  const context = { ...evidenceContext, media_review: { decision: 'uncertain', passed: false, issues: [],
    defectEvidence: [], evidence: [{ source: 'frame', reference: 0, finding: 'REVIEWER_PREVIOUS_FINDING' }] } }
  const feedback = reportFormatRetryFeedback(reviewer, context, { kind: 'report-format', error: 'REVIEW_RESULT_INVALID: 补充defectEvidence的引用范围' })
  const promptContext = nodePromptInputContext({ ...context, retry: { feedback } }, 'normalized-results')
  const prompt = renderWorkflowTemplate(reviewer.prompt, promptContext) + renderRetryFeedbackPrompt(promptContext.retry.feedback)
  assert.ok(!prompt.includes(observerSentinel), '格式复核也不得重新注入单独的观察节点')
  assert.ok(prompt.includes('REVIEWER_PREVIOUS_FINDING'), '格式修复按现有策略仍带自身上一报告，不能宣称这一轮完全无先前报告')
})

test('schema96 publishes scoped defect validation and opt-in motion projection without changing the graph or paid-node inputs', () => {
  const current = upgradeQualityWorkflow(base)
  const latest = { ...current, nodes: current.nodes.map(node => node.code ? { ...node, code: node.code.replace(COMPLETE_MEDIA_DEFECT_EVIDENCE_CODE, SCOPED_MEDIA_DEFECT_EVIDENCE_CODE) } : node.id === 'sanguo-media-review' ? { ...node, prompt: '【缺陷需求范围与语音证据 v1】\n' + node.prompt } : node) }
  const stale = { ...latest, schemaVersion: 95, nodes: latest.nodes.map(node => node.id === 'sanguo-media-accept'
    ? { ...node, code: node.code!.replace(SCOPED_MEDIA_DEFECT_EVIDENCE_CODE, MEDIA_DEFECT_EVIDENCE_CODE) }
    : node.id === 'sanguo-video' ? { ...node, params: node.params.filter(param => param.englishName !== 'promptInputMode') } : node) }
  const original = structuredClone(stale), updated = upgradeScopedMediaDefects(stale)
  assert.equal(updated.schemaVersion, 96);assert.equal(updated.edges, stale.edges)
  assert.deepEqual(updated, { ...latest, schemaVersion: 96 })
  const gate = updated.nodes.find(node => node.id === 'sanguo-media-accept')!
  assert.ok(gate.code!.includes('(review,e,{shot,metrics:context.media_metrics,policy:params})'))
  const video = updated.nodes.find(node => node.id === 'sanguo-video')!, oldVideo = stale.nodes.find(node => node.id === 'sanguo-video')!
  assert.equal(video.params.at(-1)?.value, 'motion-state');assert.deepEqual({ ...video, params: oldVideo.params }, oldVideo)
  assert.deepEqual(stale, original);assert.equal(upgradeScopedMediaDefects(updated), updated)
  const custom = { ...stale, nodes: stale.nodes.map(node => node.id === gate.id ? { ...node, code: 'return customMediaRule(context);' } : node) }
  assert.equal(upgradeScopedMediaDefects(custom), custom, 'unmarked custom code must not be overwritten or declared upgraded')
})

test('independence projection removes repeated and renamed observation slots without changing media or user rules', () => {
  const original = '我的规则\n观察列表：${media_observations.items}\n完整：${ media_observations }\n编号：${media_observations.items.0}\n图片：${video_evidence.frames}'
  const updated = refreshIndependentMediaReviewPrompt(original)
  assert.ok(updated.startsWith('我的规则'));assert.ok(!updated.includes('${media_observations'))
  assert.ok(updated.includes('${video_evidence.frames}'));assert.equal(refreshIndependentMediaReviewPrompt(updated), updated)
  assert.ok(!renderWorkflowTemplate(updated, evidenceContext).includes(observerSentinel))
})

test('schema97 gives the reviewer actual gate thresholds and preserves independently editable policy fields', () => {
  const current = upgradeQualityWorkflow(base)
  const latest = { ...current, schemaVersion: 97, nodes: current.nodes.map(node => node.code ? { ...node, code: node.code.replace(COMPLETE_MEDIA_DEFECT_EVIDENCE_CODE, SCOPED_MEDIA_DEFECT_EVIDENCE_CODE) } : node.id === 'sanguo-media-review' ? { ...node, prompt: '【本次实际门禁配置】${params.reviewPolicy}\n' + node.prompt } : node) }
  const reviewer = latest.nodes.find(node => node.id === 'sanguo-media-review')!
  assert.equal(current.schemaVersion, 113)
  const source = JSON.parse(reviewer.params.find(param => param.englishName === 'reviewPolicySource')!.value)
  const reviewPolicy = resolveNodePolicy(source, latest.nodes, node => Object.fromEntries(node.params.map(param => [param.englishName, param.type === 'boolean' ? param.value === 'true' : Number(param.value)])))
  assert.equal(reviewPolicy?.maxPhoneticErrorRate, .2)
  const prompt = renderWorkflowTemplate(reviewer.prompt, { ...evidenceContext, params: { reviewPolicy } })
  assert.match(prompt, /"maxPhoneticErrorRate":\s*0\.2/);assert.ok(!prompt.includes('${params.reviewPolicy}'))
  const stale = { ...latest, schemaVersion: 96 }
  assert.deepEqual(upgradeLiveMediaPolicy(stale), latest);assert.equal(upgradeLiveMediaPolicy(latest), latest)
  assert.equal(upgradeLiveMediaPolicy({ ...stale, id: 'custom-workflow' }).schemaVersion, 96)
})
