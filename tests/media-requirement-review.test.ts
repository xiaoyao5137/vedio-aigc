import { storyboardTimelineConsumerCode } from '../src/storyboard-timeline.ts'
import { resolveNativeFrameDisplayInterval } from '../src/media-frame-display.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveMediaRequirements, validateMediaRequirementChecks } from '../src/media-requirement-coverage.ts'
import { validateMediaDefectEvidence } from '../src/media-defect-evidence.ts'
import { validateScriptStateEvidence } from '../src/script-state-evidence.ts'
import { validateMediaEvidenceGaps, MEDIA_EVIDENCE_GAPS_PROMPT } from '../src/media-evidence-gaps.ts'
import { REQUIREMENT_MEDIA_REVIEW_PROMPT, deriveRequirementReviewInputs, combineIndependentMediaReviews, type RequirementReviewInput } from '../src/media-requirement-review.ts'

const shot = { duration: 7.5, visualPrompt: '人物坐在案后。',
  videoPrompt: '0–1秒：人物坐在案后。1–4秒：人物持续举起右臂，说出第一句。4–7.5秒：人物放下右臂，说出第二句。', lastFramePrompt: '人物坐在案后，双手放在案上。' }
const evidence = { duration: 7.54, frames: Array.from({ length: 9 }, (_, index) => '/frame-' + index + '.jpg'), frameTimes: [0, .5, 1, 2.5, 4, 4.02, 5.75, 7.5, 7.52] }
const inputs = deriveRequirementReviewInputs(shot, evidence)
const derivations = [deriveRequirementReviewInputs,
  new Function(`const resolveNativeFrameDisplayInterval=(${resolveNativeFrameDisplayInterval.toString()});const deriveMediaRequirements=${storyboardTimelineConsumerCode(deriveMediaRequirements)};return (${deriveRequirementReviewInputs.toString()});`)() as typeof deriveRequirementReviewInputs]
const combinations = [combineIndependentMediaReviews,
  new Function(`const resolveNativeFrameDisplayInterval=(${resolveNativeFrameDisplayInterval.toString()});const validateMediaEvidenceGaps=(${validateMediaEvidenceGaps.toString()});const validateScriptStateEvidence=(${validateScriptStateEvidence.toString()});return (${combineIndependentMediaReviews.toString()});`)() as typeof combineIndependentMediaReviews]
function reports(input: RequirementReviewInput[] = inputs) {
  return input.map(item => ({ requirementId: item.requirement.id, status: 'complete', evidence: '本次引用附件中的位置、身体姿态符合该范围的原要求。', frameIndices: item.attachmentReferences.map(frame => frame.index) }) as Record<string, unknown>)
}
function primary() {
  return { decision: 'accepted', passed: true, issues: [] as string[], defectEvidence: [] as Record<string, unknown>[], requirementChecks: [{ requirementId: 'primary-placeholder', status: 'complete' }],
    warnings: ['轻微眼神未单独采证。'], speechChecks: [{ natural: true }], visualChecks: [] as Record<string, unknown>[], worldState: { location: { status: 'observed', value: '室内', evidence: '原图室内' } },
    raw: { content: [{ type: 'text', text: '原始综合报告内容' }] }, text: '原始综合报告内容' }
}
const intervalDefect = { basis: 'visible-state-contradiction', violatedQuote: '人物持续举起右臂', requiredStateQuote: '举起右臂', observedState: '右臂垂在身体侧方', temporalBasis: 'sustained-state', persistenceQuote: '持续举起右臂' }
const endingDefect = { basis: 'visible-state-contradiction', violatedQuote: '双手放在案上', requiredStateQuote: '双手放在案上', observedState: '双手垂在身体侧方', temporalBasis: 'state-at-sample' }

test('independent input selects only exact requirement frames and exposes local attachment indexes to the small prompt', () => {
  for (const derive of derivations) {
    const original = structuredClone({ shot, evidence }), result = derive(shot, evidence)
    assert.deepEqual(result.map(item => item.frameReferences.map(frame => frame.index)), [[0], [0, 1, 2], [2, 3, 4], [4, 5, 6, 7], [8]])
    assert.deepEqual(result[2].attachmentReferences, [{ index: 0, second: 1 }, { index: 1, second: 2.5 }, { index: 2, second: 4 }])
    assert.deepEqual(result.at(-1)!.attachmentReferences, [{ index: 0, second: 7.52 }])
    assert.deepEqual(result[2].reviewImages, ['/frame-2.jpg', '/frame-3.jpg', '/frame-4.jpg'])
    assert.deepEqual(result.map(item => item.requirement), deriveMediaRequirements(shot))
    assert.deepEqual({ shot, evidence }, original)
    assert.ok(!result[2].frameReferences.some(frame => frame.second === 4.02), '不借用旧门禁容差扩张独立语义范围')
    const arithmetic = derive({ duration: 1, videoPrompt: '0.3–0.6秒：人物站立。' }, { frames: ['/a', '/b', '/c'], frameTimes: [0, .1 + .2, .2 + .4] })
    assert.deepEqual(arithmetic[0].frameReferences.map(frame => frame.index), [1, 2], '仅允许浮点运算误差')
  }
  assert.match(REQUIREMENT_MEDIA_REVIEW_PROMPT, /\$\{requirementInput\.attachmentReferences\}/)
  assert.doesNotMatch(REQUIREMENT_MEDIA_REVIEW_PROMPT, /\$\{requirementInput\.(?:frameReferences|reviewImages)\}|media_observations|\$\{shot_script\}|\$\{video_evidence\}/)
  assert.match(REQUIREMENT_MEDIA_REVIEW_PROMPT, /保持姿态却实际解除是反证/)
  assert.match(REQUIREMENT_MEDIA_REVIEW_PROMPT, /\$\{requirementInput\.compatibleRequirements\}/)
  assert.match(REQUIREMENT_MEDIA_REVIEW_PROMPT, /violatedQuote.*requiredStateQuote.*observedState/)
  assert.match(REQUIREMENT_MEDIA_REVIEW_PROMPT, /图片不能判断发音/)
})

test('criticality context preserves complete authored criteria, story stage and performance beats without classifying requirements', () => {
  const candidate = { ...shot,
    completionCriteria: ['接收者明确许可交付，物件归属完成变化。'],
    storyProgress: { status: 'continuing', unitId: 'unit-1', actionResult: '递交者等待回应。', response: '接收者决定是否许可。', pendingActions: ['后续场景公开物件内容。'] },
    pacing: {
      performanceBeats: [{ id: 'permission', purpose: '细微回应承担是否交付的决定。', visibleStateChange: '接收者从等待到以轻微动作明确许可。', startSecond: 1, endSecond: 4 }],
      activityWindows: [{ kind: 'reaction', startSecond: 1, endSecond: 4 }],
    },
  }
  for (const derive of derivations) {
    const before = structuredClone(candidate), result = derive(candidate, evidence)
    const expected = [
      { sourcePath: 'completionCriteria', value: before.completionCriteria },
      { sourcePath: 'storyProgress', value: before.storyProgress },
      { sourcePath: 'pacing.performanceBeats', value: before.pacing.performanceBeats },
      { sourcePath: 'pacing.activityWindows', value: before.pacing.activityWindows },
    ]
    assert.ok(result.every(input => JSON.stringify(input.criticalityContext) === JSON.stringify(expected)))
    assert.deepEqual(result.map(input => input.requirement), deriveMediaRequirements(candidate), '上下文不改原要求或推导优先级')
    ;(result[0].criticalityContext[0].value as string[]).push('只修改返回副本')
    assert.deepEqual(candidate, before, '原分镜及其他单项输入不被返回副本修改')
    assert.deepEqual(result[1].criticalityContext, expected)
    assert.deepEqual(derive(shot, evidence)[0].criticalityContext, [], '缺失原字段不补造完成条件、阶段或关键性')
  }
  assert.match(REQUIREMENT_MEDIA_REVIEW_PROMPT, /\$\{requirementInput\.criticalityContext\}/)
  assert.match(REQUIREMENT_MEDIA_REVIEW_PROMPT, /原计划仅解释关键性，不能证明实际发生/)
  assert.match(REQUIREMENT_MEDIA_REVIEW_PROMPT, /完成条件或节拍未列出不等于可忽略时间线/)
  assert.match(REQUIREMENT_MEDIA_REVIEW_PROMPT, /实质要求未重复仍须实证/)
  assert.match(REQUIREMENT_MEDIA_REVIEW_PROMPT, /不能仅因幅度轻微、采样未见或完成条件未重复列出而降级/)
  assert.match(REQUIREMENT_MEDIA_REVIEW_PROMPT, /关键性不明保留unobservable\/undetermined/)
})

test('authored microaction criticality context cannot promote an unobservable result or remove its evidence gap', () => {
  const candidate = { duration: 3, videoPrompt: '0-3秒：接收者轻微点头许可交付。',
    completionCriteria: ['接收者已以点头明确许可交付。'], storyProgress: { status: 'complete', unitId: 'permission', pendingActions: [] },
    pacing: { performanceBeats: [{ id: 'permission', visibleStateChange: '从等待到点头许可交付。', startSecond: 0, endSecond: 3 }] },
  }
  const media = { duration: 3.04, frames: ['/first', '/last'], frameTimes: [0, 2.96] }
  for (const derive of derivations) for (const combine of combinations) {
    const input = derive(candidate, media), rows = reports(input)
    rows[0] = { ...rows[0], status: 'unobservable', evidence: '静态采样无法确认承担交付许可的点头动作。' }
    const before = structuredClone(rows), result = combine(primary(), rows, input)
    assert.equal(result.decision, 'uncertain');assert.equal(result.passed, false)
    assert.deepEqual(rows, before, '不将 unknown 改写为已观察或完成')
    assert.equal(validateMediaRequirementChecks(result, candidate, media).unobservableRequirements.length, 1)
    assert.deepEqual((result.independentReviewProvenance as Record<string, unknown>).inputs, input, '来源上下文随原始审核完整保留')
  }
})

test('invalid evidence cannot silently reindex images and empty windows remain explicitly unobservable', () => {
  for (const derive of derivations) {
    for (const bad of [{ frames: ['/a'], frameTimes: [] }, { frames: ['/a'], frameTimes: [1] }, { frames: ['/a', '/b'], frameTimes: [0, NaN] },
      { frames: ['/a', '/b', '/c'], frameTimes: [0, 3, 2] }, { frames: [''], frameTimes: [0] }]) assert.throws(() => derive(shot, bad), /MEDIA_REQUIREMENT_REVIEW_INPUT_INVALID/)
    const sparse = derive(shot, { frames: ['/first', '/last'], frameTimes: [0, 7.52] })
    assert.equal(sparse[2].evidenceStatus, 'unobservable');assert.deepEqual(sparse[2].reviewImages, [])
    const empty = derive(shot, { frames: [], frameTimes: [] })
    assert.equal(empty.length, inputs.length);assert.ok(empty.every(item => item.evidenceStatus === 'unobservable'))
    for (const combine of combinations) {
      const rows = reports(empty)
      assert.throws(() => combine(primary(), rows, empty), /没有该范围的原图，只能unobservable/)
      for (const row of rows) { row.status = 'unobservable';row.evidence = '本时间窗没有原图片附件，视觉要求无法确认。' }
      const result = combine(primary(), { items: rows, count: rows.length }, empty)
      assert.equal(result.passed, false);assert.equal(result.decision, 'uncertain');assert.deepEqual(result.issues, [])
      assert.ok((result.requirementChecks as Record<string, unknown>[]).every(row => row.status === 'unobservable'))
    }
  }
})

test('independent window and ending counterevidence override a falsely accepted primary without losing its raw report', () => {
  for (const combine of combinations) {
    const original = primary(), rows = reports()
    rows[2] = { requirementId: inputs[2].requirement.id, status: 'incomplete', evidence: '附件1中右臂实际垂在身体侧方，与该范围持续举臂的原要求相反。', frameIndices: [1], repair: '仅在原要求时间窗内保持举臂，保留其他动作与台词。', defect: intervalDefect }
    rows[4] = { requirementId: inputs[4].requirement.id, status: 'incomplete', evidence: '末帧双手实际垂在身体侧方，未在案上。', frameIndices: [0], repair: '仅恢复原要求的结尾双手位置。', defect: endingDefect }
    const before = structuredClone({ original, rows, inputs }), result = combine(original, { items: rows, count: rows.length }, inputs)
    assert.equal(result.decision, 'rejected');assert.equal(result.passed, false)
    assert.deepEqual(result.raw, original.raw);assert.deepEqual(result.speechChecks, original.speechChecks);assert.deepEqual(result.worldState, original.worldState)
    assert.deepEqual((result.independentReviewProvenance as Record<string, unknown>).primaryReview, original)
    const checks = result.requirementChecks as Record<string, unknown>[], defects = result.defectEvidence as Record<string, unknown>[]
    assert.deepEqual(checks[2].frameIndices, [3]);assert.deepEqual(checks[4].frameIndices, [8])
    assert.equal(checks[2].defectIndex, 0);assert.equal(checks[4].defectIndex, 1)
    assert.equal(defects[0].requirementQuote, inputs[2].requirement.requirementQuote)
    assert.deepEqual(defects[0].stateEvidence, intervalDefect)
    assert.deepEqual(defects[0].independentDefect, intervalDefect)
    assert.deepEqual([defects[0].startSecond, defects[0].endSecond], [1, 4]);assert.equal(defects[1].scope, 'ending')
    assert.equal(defects[1].startSecond, undefined, '尾帧缺陷不伪用计划片长替代真实尾帧时刻')
    assert.equal(validateMediaRequirementChecks(result, shot, evidence).issues.length, 2)
    const validated = validateMediaDefectEvidence(result, evidence, { shot, policy: { requireScriptStateEvidence: true } })
    assert.equal(validated.issues.length, 2);assert.equal(validated.retryPrompt, rows[2].repair + '；' + rows[4].repair)
    assert.deepEqual({ original, rows, inputs }, before)
  }
})

test('primary confirmed defects and their bindings remain intact when independent reviews add defects or complete all requirements', () => {
  for (const combine of combinations) {
    const original = primary();original.decision = 'rejected';original.passed = false
    original.issues.push('画面人物面部存在明确畸变。')
    original.defectEvidence.push({ issueIndex: 0, visualCheckIndex: 0, status: 'confirmed', category: 'visual-artifact', source: 'frame', rule: 'visual-deformation', frameIndices: [1], finding: '面部实际出现重复五官。', repair: '修复面部重复五官。' })
    original.visualChecks.push({ consistent: false, evidence: '面部实际出现重复五官。' })
    const rows = reports(), allComplete = combine(original, rows, inputs)
    assert.equal(allComplete.passed, false);assert.equal(allComplete.decision, 'rejected')
    assert.deepEqual(allComplete.issues, original.issues);assert.deepEqual(allComplete.defectEvidence, original.defectEvidence)
    rows[4] = { requirementId: inputs[4].requirement.id, status: 'incomplete', evidence: '末帧双手实际位于身体侧方。', frameIndices: [0], repair: '恢复原结尾手部位置。', defect: endingDefect }
    rows[2] = { requirementId: inputs[2].requirement.id, status: 'unobservable', evidence: '右臂被遮挡，无法确认原姿态。', frameIndices: [1] }
    const result = combine(original, rows, inputs), defects = result.defectEvidence as Record<string, unknown>[]
    assert.deepEqual(defects[0], original.defectEvidence[0]);assert.equal(defects[1].issueIndex, 1)
    assert.equal((result.requirementChecks as Record<string, unknown>[])[4].defectIndex, 1)
    const coverage = validateMediaRequirementChecks(result, shot, evidence), validated = validateMediaDefectEvidence(result, evidence, { shot })
    assert.equal(coverage.unobservableRequirements.length, 1);assert.equal(validated.issues.length, 2)
    assert.equal(validated.retryPrompt, '修复面部重复五官。；恢复原结尾手部位置。')
    assert.doesNotMatch(validated.retryPrompt, /遮挡|无法确认/)
  }
})

test('complete independent checks never promote an originally false or absent decision to true', () => {
  for (const combine of combinations) {
    for (const value of [primary(), { ...primary(), passed: false, decision: 'uncertain' }, { issues: [], raw: 'raw-only' }]) {
      const result = combine(value, reports(), inputs)
      assert.equal(result.passed, (value as Record<string, unknown>).passed);assert.equal(result.decision, (value as Record<string, unknown>).decision)
    }
    const original = primary(), rows = reports();rows[2] = { requirementId: inputs[2].requirement.id, status: 'unobservable', evidence: '该姿态被前景遮挡。', frameIndices: [1] }
    const result = combine(original, rows, inputs)
    assert.equal(result.passed, false);assert.equal(result.decision, 'uncertain');assert.deepEqual(result.issues, []);assert.deepEqual(result.defectEvidence, [])
    assert.deepEqual(validateMediaRequirementChecks(result, shot, evidence).unobservableRequirements[0].frameIndices, [3])
  }
})

test('missing, duplicate, foreign and global frame indexes are report errors, never guessed into a retake', () => {
  for (const combine of combinations) {
    for (const rows of [reports().slice(1), [...reports(), reports()[0]], [...reports(), { ...reports()[0], requirementId: 'foreign' }]]) {
      assert.throws(() => combine(primary(), rows, inputs), /REVIEW_RESULT_INVALID:.*(?:恰好有一份|不属于本次原要求)/)
    }
    for (const wrongRefs of [[8], [0, 0], [], [-1], [1.1], ['0']]) {
      const rows = reports();rows[4] = { ...rows[4], frameIndices: wrongRefs }
      assert.throws(() => combine(primary(), rows, inputs), /frameIndices必须是本次附件的有效局部编号/)
    }
    const rows = reports();rows[2] = { ...rows[2], status: 'incomplete', evidence: '无法确认是否保持要求。', repair: '恢复要求。' }
    rows[4] = { ...rows[4], status: 'incomplete' }
    assert.throws(() => combine(primary(), rows, inputs), error => { assert.ok(error instanceof Error);assert.match(error.message, /确定状态与不确定证据矛盾/);assert.match(error.message, /必须有明确局部repair/);return true })
    const malformed = { ...primary(), issues: '不能丢弃的问题' }
    assert.throws(() => combine(malformed, reports(), inputs), /不能丢弃原拒绝/)
  }
})

test('speech judgments and unknown repair directives cannot be reclassified as confirmed visual script defects', () => {
  for (const combine of combinations) {
    const rows = reports()
    rows[2] = { ...rows[2], status: 'incomplete', evidence: 'ASR出现同音字，认为台词有错音。', repair: '修复发音。' }
    assert.throws(() => combine(primary(), rows, inputs), /图片不能证明语音或ASR缺陷/)
    for (const status of ['complete', 'unobservable']) {
      const wrong = reports();wrong[2] = { ...wrong[2], status, repair: '恢复原姿态。' }
      assert.throws(() => combine(primary(), wrong, inputs), /只有确证incomplete可以提供repair/)
    }
  }
})

test('compatibility inputs contain only actual overlaps and do not inherit adjacent obligations across a window', () => {
  for (const derive of derivations) {
    const candidate = { duration: 5, visualPrompt: '人物站立，神态恭谨。', videoPrompt: '0-1秒：人物双手抱于胸前。1-4秒：人物保持原姿态。4-5秒：人物恢复直立。', lastFramePrompt: '人物双手抱于胸前。' }
    const result = derive(candidate, { frames: ['/0', '/1', '/2', '/3'], frameTimes: [0, 1, 4, 4.96] })
    assert.deepEqual(result[0].compatibleRequirements.map(item => [item.requirementPath, item.overlapStartSecond, item.overlapEndSecond]), [['videoPrompt', 0, 0]])
    assert.ok(result[0].compatibleRequirements[0].requirementQuote.includes('双手抱于胸前'), '同一首帧其他属性约束可防站立被推断为双手必须垂放')
    assert.deepEqual(result[3].compatibleRequirements.map(item => [item.scope, item.overlapStartSecond, item.overlapEndSecond]), [['interval', 4, 4], ['ending', 4.96, 4.96]])
    assert.ok(!result[3].compatibleRequirements.some(item => item.scope === 'opening'), '开场手势不自动继承到结尾')
    assert.deepEqual(result[4].compatibleRequirements.map(item => [item.scope, item.overlapStartSecond, item.overlapEndSecond]), [['interval', 4.96, 4.96]])
  }
})

test('invented body attributes and unsampled transient actions fail the refusal contract without accepting or editing the report', () => {
  const candidate = { duration: 4, videoPrompt: '0-1秒：人物双手抱于胸前。1-3秒：人物微微欠身。3-4秒：人物恢复直立。', lastFramePrompt: '人物双手抱于胸前。' }
  const input = deriveRequirementReviewInputs(candidate, { frames: ['/0', '/1', '/2', '/3'], frameTimes: [0, 1, 3, 3.96] })
  for (const combine of combinations) {
    const rows = reports(input)
    rows[2] = { ...rows[2], status: 'incomplete', evidence: '人物双手实际仍在胸前。', repair: '把双手放下。',
      defect: { basis: 'visible-state-contradiction', violatedQuote: '人物恢复直立', requiredStateQuote: '双手放下', observedState: '双手抱于胸前', temporalBasis: 'state-at-sample' } }
    const original = structuredClone(rows)
    assert.throws(() => combine(primary(), rows, input), /逐字绑定violatedQuote及其requiredStateQuote/)
    assert.deepEqual(rows, original, '不把无效报告自动改成complete，也不修改原repair')
    for (const requiredStateQuote of ['微微欠身', '欠身']) {
      const transient = reports(input)
      transient[1] = { ...transient[1], status: 'incomplete', evidence: '采样帧中人物身体直立。', repair: '重拍并扩大欠身动作。',
        defect: { basis: 'visible-state-contradiction', violatedQuote: '人物微微欠身', requiredStateQuote, observedState: '人物身体直立', temporalBasis: 'state-at-sample' } }
      assert.throws(() => combine(primary(), transient, input), /原状态含轻微或短暂限定且未要求持续/)
    }
    const absent = reports(input)
    absent[0] = { ...absent[0], status: 'incomplete', evidence: '手部没有呈现要求状态。', repair: '恢复手部姿态。',
      defect: { basis: 'visible-state-contradiction', violatedQuote: '人物双手抱于胸前', requiredStateQuote: '双手抱于胸前', observedState: '未观察到双手位置', temporalBasis: 'state-at-sample' } }
    assert.throws(() => combine(primary(), absent, input), /正面可见反证/)
    const noContract = reports(input);noContract[0] = { ...noContract[0], status: 'incomplete', repair: '修改姿态。' }
    assert.throws(() => combine(primary(), noContract, input), /incomplete需defect逐字绑定/)
    const actual = reports(input)
    actual[0] = { ...actual[0], status: 'incomplete', evidence: '附件0清楚显示双臂下垂，双手分离位于身体两侧。', repair: '只恢复原窗口要求的胸前合抱。',
      defect: { basis: 'visible-state-contradiction', violatedQuote: '人物双手抱于胸前', requiredStateQuote: '双手抱于胸前', observedState: '双手分离下垂至身体两侧', temporalBasis: 'state-at-sample' } }
    const refused = combine(primary(), actual, input)
    assert.equal(refused.passed, false);assert.equal(refused.decision, 'rejected');assert.equal((refused.issues as unknown[]).length, 1, '窗口内明确静态状态的真实反证不需要额外出现保持二字')
  }
})

test('noncritical independent warnings are retained separately while uncertain core evidence still cannot claim completion', () => {
  for (const combine of combinations) {
    const rows = reports(), original = primary()
    rows[2].warnings = ['微小头部变化未被采样，无法确认。']
    const result = combine(original, rows, inputs)
    assert.equal(result.passed, true);assert.deepEqual(result.issues, [])
    assert.deepEqual(result.warnings, [...original.warnings, inputs[2].requirement.id + '：微小头部变化未被采样，无法确认。'])
    assert.deepEqual((result.independentReviewProvenance as Record<string, unknown>).mappedOutput, rows)
    rows[2].evidence = '持续手臂姿态被遮挡，无法确认。'
    assert.throws(() => combine(original, rows, inputs), /确定状态与不确定证据矛盾/)
    rows[2] = { ...reports()[2], warnings: '无法确认' }
    assert.throws(() => combine(original, rows, inputs), /warnings必须为非空文本数组/)
  }
})

test('a complete independent requirement and primary confirmed script defect on the same actual frame require joint review', () => {
  for (const combine of combinations) {
    const original = primary(), input = inputs[2], quote = input.requirement.requirementQuote
    original.passed = false;original.decision = 'rejected';original.issues = ['右臂已下垂，未保持举臂。']
    original.defectEvidence = [{ issueIndex: 0, status: 'confirmed', category: 'script', source: 'frame', requirementPath: 'videoPrompt',
      requirementQuote: quote, scope: 'interval', startSecond: 1, endSecond: 4, frameIndices: [3], finding: '右臂已下垂。', repair: '保持举臂。', stateEvidence: intervalDefect }]
    const rows = reports(), before = structuredClone({ original, rows, inputs })
    assert.throws(() => combine(original, rows, inputs), error => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /REVIEW_RESULT_INVALID:.*审核分歧/)
      assert.match(error.message, /共同实际帧\[3\]/)
      assert.match(error.message, /不能自动选边、改写原报告或购买重拍/)
      return true
    })
    assert.deepEqual({ original, rows, inputs }, before)
    const identified = structuredClone(original);identified.defectEvidence[0].requirementId = input.requirement.id
    assert.throws(() => combine(identified, rows, inputs), /审核分歧/, 'explicit requirement identity uses the same original frame contract')
    const unknown = structuredClone(rows);unknown[2] = { ...unknown[2], status: 'unobservable', evidence: '右臂被前景遮挡，无法确认姿态。' }
    assert.equal(combine(original, unknown, inputs).passed, false, 'unknown does not overturn a primary refusal')
  }
})

test('disagreement protection does not compare unrelated requirements or frames and leaves invalid ranges for their validator', () => {
  for (const combine of combinations) {
    const original = primary(), input = inputs[2]
    original.passed = false;original.decision = 'rejected';original.issues = ['右臂姿态不符。']
    const defect = { issueIndex: 0, status: 'confirmed', category: 'script', source: 'frame', requirementPath: 'videoPrompt',
      requirementQuote: input.requirement.requirementQuote, scope: 'interval', startSecond: 1, endSecond: 4, frameIndices: [3], finding: '右臂下垂。', repair: '保持举臂。', stateEvidence: intervalDefect }
    const rows = reports();rows[2].frameIndices = [0]
    assert.equal(combine({ ...original, defectEvidence: [defect] }, rows, inputs).passed, false, 'no shared cited frame is not a proven contradiction')
    for (const patch of [{ requirementId: 'another-requirement' }, { requirementQuote: '别项原文' }, { requirementPath: 'lastFramePrompt' },
      { scope: 'ending' }, { startSecond: 8, endSecond: 9 }, { frameIndices: [999] }]) {
      const result = combine({ ...original, defectEvidence: [{ ...defect, ...patch }] }, reports(), inputs)
      assert.equal(result.passed, false)
      assert.deepEqual(result.defectEvidence, [{ ...defect, ...patch }], 'the combiner must not repair invalid primary evidence')
    }
  }
})

function gapFixture() {
  const source = { duration: 5, videoPrompt: '1-4秒：人物保持持卷姿态，以眼神微动作表现闲谈时的礼貌。',
    completionCriteria: ['本镜必须完成来意的信息陈述。'],
    storyProgress: { response: '礼貌神态仅为日常闲谈表现，不承担决定、许可或事件回应。' },
    pacing: { performanceBeats: [] },
  }
  const media = { frames: ['/0', '/1', '/2', '/3', '/4', '/5'], frameTimes: [0, .5, 1, 2.5, 4, 4.96], duration: 5 }
  const input = deriveRequirementReviewInputs(source, media)
  const gap = { requirementQuote: '以眼神微动作表现闲谈时的礼貌', status: 'unobservable', evidence: '静态采样无法确认眼神的短暂变化。', frameIndices: [0, 2],
    acceptanceImpact: { level: 'warning', policyRule: 'noncritical-performance-variation',
      reason: '原故事上下文明确礼貌神态不承担决定、许可或回应；该未知不影响持续持卷及信息陈述。',
      contextReferences: [{ sourcePath: 'storyProgress', quote: source.storyProgress.response }] } }
  const rows = [{ requirementId: input[0].requirement.id, status: 'unobservable', evidence: '1秒和4秒人物持卷站立，面向交谈者。', frameIndices: [0, 2],
    scopeNotes: ['图片不能判断发音，声音由实际音轨门禁核对。'], evidenceGaps: [gap] }]
  return { source, media, input, rows }
}

test('permitted evidence gaps preserve unknowns and map local frames without demoting acceptance or promoting an uncertain primary', () => {
  for (const combine of combinations) {
    const { source, media, input, rows } = gapFixture(), original = primary()
    const before = structuredClone({ source, media, input, rows, original }), policy = { allowNoncriticalEvidenceGaps: true }
    const result = combine(original, { items: rows }, input, policy), checks = result.requirementChecks as typeof rows
    assert.equal(result.passed, true);assert.equal(result.decision, 'accepted')
    assert.equal(checks[0].status, 'unobservable');assert.equal(checks[0].evidenceGaps[0].status, 'unobservable')
    assert.deepEqual(checks[0].frameIndices, [2, 4]);assert.deepEqual(checks[0].evidenceGaps[0].frameIndices, [2, 4])
    assert.deepEqual(checks[0].scopeNotes, rows[0].scopeNotes)
    const coverage = validateMediaRequirementChecks(result, source, media, policy)
    assert.equal(coverage.unobservableRequirements.length, 1);assert.deepEqual(coverage.blockingUnobservableRequirements, [])
    assert.deepEqual((result.independentReviewProvenance as Record<string, unknown>).mappedOutput, { items: rows })
    assert.deepEqual({ source, media, input, rows, original }, before)
    for (const first of [{ ...original, decision: 'uncertain', passed: false }, { ...original, passed: false }, { issues: [], raw: 'no-decision' }]) {
      const derived = combine(first, rows, input, policy)
      assert.equal(derived.passed, (first as Record<string, unknown>).passed)
      assert.equal(derived.decision, (first as Record<string, unknown>).decision, '合法warning只能避免额外降级，不能升级综合原判定')
    }
    checks[0].evidenceGaps[0].acceptanceImpact.contextReferences[0].quote = '修改派生视图不污染原引用'
    assert.deepEqual(rows, before.rows)
  }
})

test('independent gap exemptions reject missing policy, source binding and local frame evidence and keep blocking unknowns', () => {
  for (const combine of combinations) {
    const { input, rows } = gapFixture(), policy = { allowNoncriticalEvidenceGaps: true }
    for (const option of [undefined, {}, { allowNoncriticalEvidenceGaps: false }]) {
      assert.throws(() => combine(primary(), rows, input, option), /明确allowNoncriticalEvidenceGaps=true/)
    }
    for (const change of [
      (row: typeof rows[0]) => { row.evidenceGaps[0].requirementQuote = '另一原要求的微动作' },
      (row: typeof rows[0]) => { row.evidenceGaps[0].frameIndices = [4] },
      (row: typeof rows[0]) => { row.evidenceGaps[0].acceptanceImpact.contextReferences = [] },
      (row: typeof rows[0]) => { row.evidenceGaps[0].acceptanceImpact.contextReferences[0].quote = '捏造原文' },
      (row: typeof rows[0]) => { row.status = 'complete' },
    ]) {
      const invalid = structuredClone(rows);change(invalid[0]);const before = structuredClone(invalid)
      assert.throws(() => combine(primary(), invalid, input, policy), /REVIEW_RESULT_INVALID:.*evidenceGaps/)
      assert.deepEqual(invalid, before)
    }
    const noContext = structuredClone(input);noContext[0].criticalityContext = []
    assert.throws(() => combine(primary(), rows, noContext, policy), /唯一定位原sourcePath/)
    for (const level of ['blocking', 'undetermined']) {
      const blocked = structuredClone(rows);blocked[0].evidenceGaps[0].acceptanceImpact.level = level
      const result = combine(primary(), blocked, input, policy)
      assert.equal(result.decision, 'uncertain');assert.equal(result.passed, false)
      assert.equal((result.requirementChecks as typeof rows)[0].status, 'unobservable')
    }
    const methodOnly = reports(input)
    methodOnly[0].scopeNotes = ['图片不能判断发音，交由音轨门禁。']
    assert.equal(combine(primary(), methodOnly, input).passed, true, '方法限制不冒充本项原要求的事实未知')
  }
  assert.ok(REQUIREMENT_MEDIA_REVIEW_PROMPT.includes(MEDIA_EVIDENCE_GAPS_PROMPT))
  assert.match(REQUIREMENT_MEDIA_REVIEW_PROMPT, /\$\{params\.reviewPolicy\}/)
  assert.match(REQUIREMENT_MEDIA_REVIEW_PROMPT, /任何未知都列evidenceGaps且本行保持unobservable/)
})
