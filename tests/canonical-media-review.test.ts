import test from 'node:test'
import assert from 'node:assert/strict'
import { CANONICAL_MEDIA_REVIEW_PROMPT, isCanonicalMediaReviewPrompt } from '../src/canonical-media-review.ts'
import { renderWorkflowTemplate } from '../src/workflow-template.ts'
import { nodePromptInputContext } from '../src/review-input.ts'
import { deriveMediaRequirements, validateMediaRequirementChecks } from '../src/media-requirement-coverage.ts'
import { validateMediaDefectEvidence } from '../src/media-defect-evidence.ts'
import { MEDIA_EVIDENCE_GAPS_PROMPT } from '../src/media-evidence-gaps.ts'
import { MEDIA_REQUIREMENT_SCOPE_RULES } from '../src/media-review-rubric.ts'

test('canonical media contract renders the current requirements, actual media and gate policy without observer or stale review payloads', () => {
  const observer = 'PRIVATE_OBSERVER_GUESSED_PROP_513'
  const previousReview = 'STALE_REVIEW_REJECTED_713'
  const requirements = [{ id: 'hold-1', requirementPath: 'lastFramePrompt', requirementQuote: '甲尾帧仍保持拱手', scope: 'ending', startSecond: 9.84, endSecond: 9.84 }]
  const context = {
    shot_script: { lastFramePrompt: '甲尾帧仍保持拱手', completionCriteria: ['原口头回答条件'], characters: ['甲'], endCharacters: ['甲'],
      presentCharacters: ['甲'], continuity: { mode: 'coverage_cut' }, worldState: { settingId: 'actual-room' },
      pacing: { performanceBeats: [] }, storyProgress: { unitId: 'unit-current' }, contentContractVersion: 'cinematic-v1', audioType: '对白', audioText: '实际回答',
      scriptValidation: { passed: false, reason: previousReview }, repairProvenance: { issues: [previousReview] } },
    video_evidence: { frames: ['/generated/actual-frame.jpg'], frameTimes: [9.84], duration: 10,
      speechValidation: { alignment: [{ text: '实际回答', actualStart: 1.25, actualEnd: 2.75 }] } },
    media_metrics: { requirements, unitCriteria: ['原口头回答条件'], speech: [{ text: '实际回答', elapsed: 1.5, allowedSpan: 2.25, timingAssessment: 'within-allowance' }],
      tailTiming: { assessment: 'within-allowance' }, policy: { timingToleranceSeconds: .25 } },
    params: { reviewPolicy: { maxPhoneticErrorRate: .17, maxIdleTailSeconds: 1.4, maxRepairChars: 280 } },
    media_observations: { items: [{ heldObjects: observer }] },
    media_review: { passed: false, issues: [previousReview] },
  }
  const rendered = renderWorkflowTemplate(CANONICAL_MEDIA_REVIEW_PROMPT, nodePromptInputContext(context, 'normalized-results'))
  for (const actual of ['hold-1', '甲尾帧仍保持拱手', '原口头回答条件', '/generated/actual-frame.jpg', '9.84', '实际回答', '1.25', '2.25', '0.17', '1.4', '280']) {
    assert.ok(rendered.includes(actual), 'missing current source ' + actual)
  }
  assert.ok(!rendered.includes(observer));assert.ok(!rendered.includes(previousReview))
  assert.ok(!rendered.includes('${'))
  for (const label of ['完成条件[sourcePath=completionCriteria]',
    '表演节奏[可引sourcePath=pacing.performanceBeats/pacing.activityWindows]', '剧情进展[sourcePath=storyProgress]']) {
    assert.ok(rendered.includes(label), 'missing accepted criticality context source path: ' + label)
  }
  const slots = [...CANONICAL_MEDIA_REVIEW_PROMPT.matchAll(/\$\{([^}]+)\}/g)].map(match => match[1]).sort()
  assert.deepEqual(slots, ['media_metrics.requirements', 'media_metrics.policy', 'media_metrics.speech', 'media_metrics.tailTiming',
    'media_metrics.unitCompletionRequired', 'media_metrics.deferredActions', 'media_metrics.unitCriteria', 'params.reviewPolicy',
    'shot_script.contentContractVersion', 'shot_script.audioType', 'shot_script.audioText', 'shot_script.characters', 'shot_script.endCharacters',
    'shot_script.presentCharacters', 'shot_script.continuity', 'shot_script.worldState', 'shot_script.pacing', 'shot_script.storyProgress', 'video_evidence'].sort())
})

test('one parseable JSON template exposes every base and conditional gate field family together', () => {
  const marker = '【唯一完整JSON模板】', end = '【唯一完整JSON模板结束】'
  assert.equal(CANONICAL_MEDIA_REVIEW_PROMPT.split(marker).length, 2)
  const section = CANONICAL_MEDIA_REVIEW_PROMPT.split(marker)[1].split(end)[0]
  const template = JSON.parse(section.slice(section.indexOf('{')).trim())
  assert.deepEqual(Object.keys(template).sort(), [
    'decision', 'passed', 'issues', 'warnings', 'retryPrompt', 'evidence', 'endingState', 'endCharacters', 'requirementChecks',
    'narrativeClosure', 'pacingReview', 'speechChecks', 'tailTimingCheck', 'visualChecks', 'defectEvidence',
    'presentCharacters', 'worldState', 'presenceChecks', 'continuityReview',
  ].sort())
  assert.deepEqual(Object.keys(template.requirementChecks[0]).sort(), ['requirementId', 'status', 'frameIndices', 'evidence', 'defectIndex', 'scopeNotes', 'evidenceGaps'].sort())
  assert.equal(template.requirementChecks[0].status, 'incomplete')
  assert.deepEqual(template.requirementChecks[0].scopeNotes, [])
  assert.deepEqual(template.requirementChecks[0].evidenceGaps, [])
  assert.equal(Object.hasOwn(template.requirementChecks[0], 'repair'), false)
  assert.deepEqual(Object.keys(template.narrativeClosure).sort(), ['unitId', 'complete', 'actionEvidence', 'responseEvidence', 'unresolvedActions', 'criteriaChecks'].sort())
  assert.deepEqual(Object.keys(template.pacingReview.performanceChecks[0]).sort(), ['beatId', 'status', 'evidence', 'observedStateChange', 'startSecond', 'endSecond', 'frameIndices'].sort())
  assert.deepEqual(Object.keys(template.visualChecks[0]).sort(), ['character', 'consistent', 'expectedObjects', 'actualObjectsByFrame', 'evidence'].sort())
  assert.deepEqual(Object.keys(template.defectEvidence[0]).sort(), ['issueIndex', 'visualCheckIndex', 'status', 'category', 'source', 'frameIndices', 'startSecond', 'endSecond', 'finding', 'repair', 'requirementPath', 'requirementQuote', 'scope', 'stateEvidence', 'rule', 'speechIndex'].sort())
  assert.deepEqual(Object.keys(template.defectEvidence[0].stateEvidence).sort(), ['basis', 'violatedQuote', 'requiredStateQuote', 'observedState', 'temporalBasis'].sort())
  for (const field of ['position', 'heldProps', 'pendingAction']) assert.equal(typeof template.worldState.characters[0][field].status, 'string')
  assert.deepEqual(Object.keys(template.continuityReview.checks[0]).sort(), ['character', 'field', 'status', 'evidence', 'frameIndices'].sort())
})

test('the consolidated rules retain scoped evidence, explicit hold obligations, uncertainty and unapplied-edit boundaries', () => {
  for (const required of [
    '微差容许不能豁免明确宏观义务', 'opening只用首帧', 'ending只用实际最后一帧',
    '不能从局部时间窗或开场状态外推全片', '不是新的时间帧', '允许第一帧已经成立',
    '无可用帧时[]且unobservable', 'unknown不携带事实value',
    'object-discontinuity与spatial-discontinuity至少两张不同原帧', 'phoneticErrorRate必须超过本次配置阈值',
    'outside-allowance且elapsed>allowedSpan', '裁尾尚未实施并重新采证前不得宣称素材已accepted',
    '由门禁抛出MEDIA_EDIT_REQUIRED交给剪辑处理', '其他rejected必须有确证缺陷',
    '混合时间窗分开记录实见事实与未知', '不构成缺陷或新的语速阈值',
    '上一报告是草稿', '复核source/category/引用范围及争议结论', '不能以“只修格式”为由沿袭错误指控',
    'incomplete必须有defectIndex', 'confirmed、category=script、source=frame缺陷及有效issueIndex',
    'requirementChecks不允许repair', '不得用未绑定incomplete触发重拍或绕过语音阈值',
    'coverage只复用已验证issue、不产生repair', 'requirementChecks仅incomplete填defectIndex',
    '另填stateEvidence', 'observedState为同一属性的正面可见反证', '不能借未采到证明缺失或增写目标属性',
    'persistenceQuote', '短暂过程漏采不能改称持续反证',
  ]) assert.ok(CANONICAL_MEDIA_REVIEW_PROMPT.includes(required), 'lost review boundary: ' + required)
  assert.ok(!CANONICAL_MEDIA_REVIEW_PROMPT.includes('只拒绝'))
  assert.ok(!CANONICAL_MEDIA_REVIEW_PROMPT.includes('按剪辑裁尾放行'))
  assert.ok(CANONICAL_MEDIA_REVIEW_PROMPT.length <= 9000, 'one complete contract should remain bounded and readable')
})

test('an incomplete requirement binds a fully typed frame defect and never creates a second repair instruction', () => {
  const shot = { duration: 4, lastFramePrompt: '末尾人物仍保持原有姿态' }
  const requirement = deriveMediaRequirements(shot)[0]
  const issue = '实际尾帧已解除原有姿态', repair = '恢复原定尾帧姿态，其余保持'
  const review = {
    issues: [issue], defectEvidence: [{ issueIndex: 0, status: 'confirmed', category: 'script', source: 'frame', frameIndices: [1], finding: '3.96秒实际尾帧可见原姿态已解除',
      requirementPath: requirement.requirementPath, requirementQuote: requirement.requirementQuote, scope: requirement.scope, repair }],
    requirementChecks: [{ requirementId: requirement.id, status: 'incomplete', frameIndices: [1], evidence: '3.96秒末帧可见原姿态已解除', defectIndex: 0 }],
  }
  const evidence = { frames: ['first', 'tail'], frameTimes: [0, 3.96], duration: 4 }
  assert.deepEqual(validateMediaDefectEvidence(review, evidence, { shot, metrics: {}, policy: {} }), { issues: [issue], retryPrompt: repair, uncertainDefects: [] })
  assert.deepEqual(validateMediaRequirementChecks(review, shot, evidence), { issues: [issue], retryPrompt: '', unobservableRequirements: [], blockingUnobservableRequirements: [] })
})

test('canonical identity requires an ordered complete marker pair and permits surrounding user rules', () => {
  assert.equal(isCanonicalMediaReviewPrompt(CANONICAL_MEDIA_REVIEW_PROMPT), true)
  assert.equal(isCanonicalMediaReviewPrompt('用户前言\n' + CANONICAL_MEDIA_REVIEW_PROMPT + '\n用户后记'), true)
  assert.equal(isCanonicalMediaReviewPrompt('【独立成片验收完整契约 v1】残缺文本'), false)
  assert.equal(isCanonicalMediaReviewPrompt('【独立成片验收完整契约结束】'), false)
  assert.equal(isCanonicalMediaReviewPrompt('【独立成片验收完整契约结束】【独立成片验收完整契约 v1】'), false)
})

test('both reviewers share an explicit gap policy while method notes cannot replace unknown requirements', () => {
  assert.ok(CANONICAL_MEDIA_REVIEW_PROMPT.includes(MEDIA_EVIDENCE_GAPS_PROMPT))
  assert.ok(CANONICAL_MEDIA_REVIEW_PROMPT.includes(MEDIA_REQUIREMENT_SCOPE_RULES))
  for (const field of ['scopeNotes', 'evidenceGaps', 'acceptanceImpact', 'contextReferences', 'allowNoncriticalEvidenceGaps', 'noncritical-performance-variation']) {
    assert.ok(CANONICAL_MEDIA_REVIEW_PROMPT.includes(field), 'missing evidence policy field ' + field)
  }
  assert.match(CANONICAL_MEDIA_REVIEW_PROMPT, /warning只表示政策允许未知不阻断，未知仍保留/)
  assert.match(CANONICAL_MEDIA_REVIEW_PROMPT, /原计划仅解释关键性，不能证明实际发生/)
  assert.match(MEDIA_REQUIREMENT_SCOPE_RULES, /确定evidence仅写实见/)
  assert.match(MEDIA_REQUIREMENT_SCOPE_RULES, /非关键未知也不能改写成已完成/)
  assert.doesNotMatch(MEDIA_REQUIREMENT_SCOPE_RULES, /证据备注/)
})
