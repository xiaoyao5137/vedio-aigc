import { storyboardTimelineConsumerCode } from '../src/storyboard-timeline.ts'
import { resolveNativeFrameDisplayInterval } from '../src/media-frame-display.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveMediaRequirements, validateMediaRequirementChecks } from '../src/media-requirement-coverage.ts'
import { validateMediaDefectEvidence } from '../src/media-defect-evidence.ts'
import { validateMediaEvidenceGaps } from '../src/media-evidence-gaps.ts'

const shot = { duration: 14, visualPrompt: '门前人物双手拱于胸前。', lastFramePrompt: '人物双手仍拱于胸前。',
  videoPrompt: '0–1秒：人物双手拱于胸前。1–5.4秒：微微欠身，说出第一句。5.4–9.8秒：保持拱手姿态，说出第二句。9.8–14秒：说出第三句。【音轨】完整说出原台词。' }
const evidence = { frames: ['/0.jpg', '/1.jpg', '/2.jpg', '/3.jpg', '/4.jpg', '/5.jpg'], frameTimes: [0, 2.81, 6.32, 9.83, 12.64, 13.96], duration: 14.04,
  speechValidation: { alignment: [{ actualStart: .37, actualEnd: 4.29 }], phoneticErrorRate: .0217 } }
const policy = { timingTolerance: .25, maxPhoneticErrorRate: .2 }
const validators = [validateMediaRequirementChecks, new Function(`const resolveNativeFrameDisplayInterval=(${resolveNativeFrameDisplayInterval.toString()});const validateMediaEvidenceGaps=(${validateMediaEvidenceGaps.toString()});const deriveMediaRequirements=${storyboardTimelineConsumerCode(deriveMediaRequirements)};return (${validateMediaRequirementChecks.toString()});`)() as typeof validateMediaRequirementChecks]
const requirements = deriveMediaRequirements(shot)
function completeReport() {
  return { passed: true, issues: [] as string[], defectEvidence: [] as Record<string, unknown>[], warnings: [] as string[],
    requirementChecks: requirements.map(item => ({ requirementId: item.id, status: 'complete',
      frameIndices: item.scope === 'opening' ? [0] : item.scope === 'ending' ? [5]
        : evidence.frameTimes.flatMap((time, index) => time >= item.startSecond - policy.timingTolerance && time <= item.endSecond + policy.timingTolerance ? [index] : []),
      evidence: '引用实际帧中的身体姿态、人物与场景关系核对该时段实质要求。',
    })) as Array<Record<string, unknown>> }
}

function bindIncomplete(report: ReturnType<typeof completeReport>, index: number, finding: string, repair: string) {
  const requirement = requirements[index], check = report.requirementChecks[index]
  const defectIndex = report.defectEvidence.length, issueIndex = report.issues.length
  report.passed = false;report.issues.push('该原要求未完成：' + finding)
  report.defectEvidence.push({ issueIndex, status: 'confirmed', category: 'script', source: 'frame',
    requirementPath: requirement.requirementPath, requirementQuote: requirement.requirementQuote, scope: requirement.scope,
    ...(requirement.scope === 'interval' ? { startSecond: requirement.startSecond, endSecond: requirement.endSecond } : {}),
    frameIndices: check.frameIndices, finding, repair })
  report.requirementChecks[index] = { ...check, status: 'incomplete', evidence: finding, defectIndex }
}

test('requirements preserve exact candidate time windows and opening/ending sources with stable ids', () => {
  const original = structuredClone(shot)
  assert.equal(requirements.length, 6)
  assert.equal(new Set(requirements.map(item => item.id)).size, requirements.length)
  assert.deepEqual(deriveMediaRequirements(shot), requirements);assert.deepEqual(shot, original)
  for (const item of requirements) assert.ok(shot[item.requirementPath as keyof typeof shot].toString().includes(item.requirementQuote))
  assert.deepEqual(requirements.filter(item => item.scope === 'interval').map(item => [item.startSecond, item.endSecond]), [[0, 1], [1, 5.4], [5.4, 9.8], [9.8, 14]])
  assert.ok(!requirements.some(item => item.requirementQuote.includes('【音轨】')))
  const changed = deriveMediaRequirements({ ...shot, lastFramePrompt: '人物站在窗旁。' })
  assert.deepEqual(changed.slice(0, -1), requirements.slice(0, -1), '无关尾帧编辑不改变其他原要求标识')
  assert.throws(() => deriveMediaRequirements({ videoPrompt: '无时间轴的动作文字' }), /MEDIA_REQUIREMENTS_INVALID/)
  assert.throws(() => deriveMediaRequirements({ ...shot, duration: undefined }), /有效时间范围/)
})

test('missing a window or the ending obligation cannot pass by mentioning it only in warnings', () => {
  for (const validate of validators) {
    const report = completeReport()
    report.requirementChecks = report.requirementChecks.filter(row => row.requirementId !== requirements[3].id && row.requirementId !== requirements.at(-1)!.id)
    report.warnings = ['该时段及尾帧双手自然垂下，未保持原要求姿态']
    const original = structuredClone(report)
    assert.throws(() => validate(report, shot, evidence, policy), error => {
      assert.ok(error instanceof Error)
      assert.ok(error.message.includes(requirements[3].id));assert.ok(error.message.includes(requirements.at(-1)!.id))
      assert.match(error.message, /必须恰好复核一次.*逐项复核同一素材，不购买新视频/)
      return true
    })
    assert.deepEqual(report, original)
  }
})

test('real incomplete actions and ending states refuse with local repairs, independent of the action vocabulary', () => {
  for (const validate of validators) {
    for (const index of [3, requirements.length - 1]) {
      const report = completeReport()
      bindIncomplete(report, index, '引用帧中双手实际垂在身体两侧，与该原要求相反。', '仅恢复该原要求范围内的手部姿态，保留台词与其他动作。')
      const original = structuredClone(report), result = validate(report, shot, evidence, policy)
      assert.equal(result.issues.length, 1);assert.match(result.issues[0], /原要求未完成/)
      assert.equal(result.retryPrompt, '');assert.deepEqual(report, original)
      assert.equal(validateMediaDefectEvidence(report, evidence, { shot, policy }).retryPrompt, report.defectEvidence[0].repair)
    }
    const otherShot = { duration: 5, videoPrompt: '0–5秒：人物始终坐在案后。', lastFramePrompt: '人物坐在案后。' }
    const otherEvidence = { frames: ['/a.jpg', '/b.jpg'], frameTimes: [0, 4.96], duration: 5 }
    const otherRequirements = deriveMediaRequirements(otherShot)
    const checks = otherRequirements.map((item, index) => ({ requirementId: item.id, status: 'incomplete', frameIndices: [1], evidence: '人物实际站在门外。', defectIndex: index }))
    const defects = otherRequirements.map((item, index) => ({ issueIndex: index, status: 'confirmed', category: 'script', source: 'frame', requirementPath: item.requirementPath,
      requirementQuote: item.requirementQuote, scope: item.scope, ...(item.scope === 'interval' ? { startSecond: 0, endSecond: 5 } : {}), frameIndices: [1], finding: '人物实际站在门外。', repair: '恢复原要求的坐姿及案后位置。' }))
    const otherReport = { issues: ['中段原位置与坐姿未保持', '尾帧原位置与坐姿未保持'], defectEvidence: defects, requirementChecks: checks }
    assert.equal(validate(otherReport, otherShot, otherEvidence).issues.length, 2)
    assert.equal(validateMediaDefectEvidence(otherReport, otherEvidence, { shot: otherShot }).issues.length, 2)
  }
})

test('honest unobservable requirements remain explicit while false complete/incomplete certainty remains invalid', () => {
  for (const validate of validators) {
    const unknown = completeReport()
    unknown.requirementChecks[3] = { ...unknown.requirementChecks[3], status: 'unobservable', frameIndices: [], evidence: '双手被遮挡，无法确认原要求的持续姿态。' }
    const original = structuredClone(unknown), result = validate(unknown, shot, evidence, policy)
    assert.deepEqual(result.issues, []);assert.equal(result.retryPrompt, '')
    assert.deepEqual(result.unobservableRequirements, [{ requirementId: requirements[3].id, requirementPath: 'videoPrompt', scope: 'interval',
      evidence: '双手被遮挡，无法确认原要求的持续姿态。', frameIndices: [] }])
    assert.deepEqual(unknown, original, '保留未观察事实，不伪装为complete或生成重拍指令')
    for (const status of ['complete', 'incomplete']) {
      const report = completeReport()
      report.requirementChecks[3] = { ...report.requirementChecks[3], status, evidence: '双手被遮挡，无法确认原要求的持续姿态。', repair: '恢复要求' }
      assert.throws(() => validate(report, shot, evidence, policy), /REVIEW_RESULT_INVALID:.*状态与本项不确定证据矛盾.*不购买新视频/)
    }
  }
})

test('visual frame bounds use the configured sampling tolerance while natural ASR timing and microdetail warnings remain independent', () => {
  for (const validate of validators) {
    const report = completeReport()
    report.warnings = ['微微欠身和细微眼神未采样到；实际明确动作与状态已按原窗口核对。']
    assert.deepEqual(validate(report, shot, evidence, policy).issues, [], '实际ASR提前于计划秒数不引入新语音阈值，微差不等于核心要求不可观察')
    report.requirementChecks[3] = { ...report.requirementChecks[3], frameIndices: [3] }
    assert.equal(validate(report, shot, evidence, policy).issues.length, 0)
    assert.throws(() => validate(report, shot, evidence, { timingTolerance: 0 }), /引用帧不在原要求/)
    for (const [index, frameIndices] of [[0, [1]], [requirements.length - 1, [2]], [3, [0]], [3, []]] as const) {
      const patched = completeReport();patched.requirementChecks[index] = { ...patched.requirementChecks[index], frameIndices: [...frameIndices] }
      assert.throws(() => validate(patched, shot, evidence, policy), /(?:引用帧不在原要求|缺少有效实际帧编号)/)
    }
  }
})

test('binding an incomplete requirement to its actual defect reuses the same issue and repair without expanding the purchase feedback', () => {
  for (const validate of validators) {
    const report = completeReport(), requirement = requirements[3]
    report.passed = false;report.issues = ['原窗口内双手实际垂下']
    report.defectEvidence = [{ issueIndex: 0, status: 'confirmed', source: 'frame', category: 'script', requirementPath: 'videoPrompt',
      requirementQuote: '保持拱手姿态，说出第二句。', scope: 'interval', startSecond: 5.4, endSecond: 9.8, frameIndices: [2, 3],
      finding: '实际帧中双手垂下。', repair: '仅在原窗口内保持该姿态，保留全部台词和其他动作。' }]
    report.requirementChecks[3] = { requirementId: requirement.id, status: 'incomplete', frameIndices: [2, 3], evidence: '实际帧中双手垂下。', defectIndex: 0 }
    const original = structuredClone(report), coverage = validate(report, shot, evidence, policy)
    const defects = validateMediaDefectEvidence(report, evidence, { shot, policy })
    assert.deepEqual(coverage, { issues: defects.issues, retryPrompt: '', unobservableRequirements: [], blockingUnobservableRequirements: [] });assert.deepEqual(report, original)
    assert.equal([...new Set([defects.retryPrompt, coverage.retryPrompt].filter(Boolean))].join('；'), report.defectEvidence[0].repair)
    report.issues.push('尾部发生明确黑屏')
    report.defectEvidence.push({ issueIndex: 1, status: 'confirmed', source: 'frame', category: 'visual-artifact', rule: 'black-frame', frameIndices: [5], finding: '实际末帧全黑', repair: '修复末帧黑屏' })
    const withAnotherDefect = validateMediaDefectEvidence(report, evidence, { shot, policy })
    const combined = [...new Set([withAnotherDefect.retryPrompt, validate(report, shot, evidence, policy).retryPrompt].filter(Boolean))].join('；')
    assert.equal(combined, report.defectEvidence[0].repair + '；修复末帧黑屏', '绑定的修复子集不重复整段反馈')
    const wrong = structuredClone(report);wrong.requirementChecks[5] = { ...wrong.requirementChecks[5], status: 'incomplete', defectIndex: 0 }
    assert.throws(() => validate(wrong, shot, evidence, policy), /defectIndex 必须绑定同一原要求/)
  }
})

test('an ASR spelling difference below the real threshold cannot buy a retake through an untyped incomplete requirement', () => {
  const candidate = { duration: 4, videoPrompt: '0-4秒：人物站立，说出“吾师得封”。', lastFramePrompt: '人物站立。' }
  const actual = { duration: 4, frames: ['/0.jpg', '/1.jpg'], frameTimes: [0, 3.96],
    speechValidation: { phoneticErrorRate: .02, alignment: [{ actualStart: .4, actualEnd: 3.5 }] } }
  const review = { passed: false, decision: 'rejected', issues: [] as string[], defectEvidence: [] as Record<string, unknown>[],
    requirementChecks: deriveMediaRequirements(candidate).map((item, index) => ({ requirementId: item.id, status: index ? 'complete' : 'incomplete', frameIndices: [index],
      evidence: index ? '末帧人物站立。' : 'ASR将吾师识别成吴师，文字与要求不同。', ...(index ? {} : { repair: '重新生成并纠正吾师读音。' }) })) as Array<Record<string, unknown>> }
  const chainBody = `const coverage=validateMediaRequirementChecks(review,shot,evidence,policy);const defects=validateMediaDefectEvidence(review,evidence,{shot,policy});return {issues:[...new Set([...coverage.issues,...defects.issues])],retryPrompt:defects.retryPrompt,unobservableRequirements:coverage.unobservableRequirements,blockingUnobservableRequirements:coverage.blockingUnobservableRequirements};`
  const embedded = new Function(`const resolveNativeFrameDisplayInterval=(${resolveNativeFrameDisplayInterval.toString()});const validateMediaEvidenceGaps=(${validateMediaEvidenceGaps.toString()});const deriveMediaRequirements=${storyboardTimelineConsumerCode(deriveMediaRequirements)};const validateMediaRequirementChecks=(${validateMediaRequirementChecks.toString()});const validateMediaDefectEvidence=${storyboardTimelineConsumerCode(validateMediaDefectEvidence)};return function(review,shot,evidence,policy){${chainBody}};`)() as typeof validateMediaRequirementChecks
  const direct: typeof validateMediaRequirementChecks = (report, currentShot, currentEvidence, currentPolicy = {}) => {
    const coverage = validateMediaRequirementChecks(report, currentShot, currentEvidence, currentPolicy)
    const defects = validateMediaDefectEvidence(report, currentEvidence, { shot: currentShot, policy: currentPolicy })
    return { issues: [...new Set([...coverage.issues, ...defects.issues])], retryPrompt: defects.retryPrompt, unobservableRequirements: coverage.unobservableRequirements, blockingUnobservableRequirements: coverage.blockingUnobservableRequirements }
  }
  for (const validate of [direct, embedded]) {
    const original = structuredClone(review)
    assert.throws(() => validate(review, candidate, actual, policy), /REVIEW_RESULT_INVALID:.*incomplete 的 defectIndex 必须绑定.*未绑定不能触发重拍/)
    assert.deepEqual(review, original, '不猜填绑定，不改原报告，不返回任何购买反馈')
    const wronglyBound = structuredClone(review)
    wronglyBound.issues = ['ASR文字与台词字形不同']
    wronglyBound.defectEvidence = [{ issueIndex: 0, status: 'confirmed', category: 'speech', source: 'asr', rule: 'phonetic-error-rate',
      startSecond: .4, endSecond: 3.5, finding: 'ASR吾师被识别为吴师', repair: '重拍纠正发音' }]
    delete wronglyBound.requirementChecks[0].repair;wronglyBound.requirementChecks[0].defectIndex = 0
    assert.throws(() => validate(wronglyBound, candidate, actual, policy), /confirmed script\/source=frame/)
    const speechOnly = structuredClone(wronglyBound)
    speechOnly.requirementChecks[0] = { ...speechOnly.requirementChecks[0], status: 'complete', evidence: '帧0人物站立，所需视觉状态成立。' }
    delete speechOnly.requirementChecks[0].defectIndex
    assert.throws(() => validate(speechOnly, candidate, actual, policy), /phoneticErrorRate 未超过配置/,
      '改回合法语音类别后仍必须走真实音素阈值，不能因视觉覆盖完整绕过')
  }
})

test('incomplete requirements cannot add their own repairs or bind a different evidence source', () => {
  for (const validate of validators) {
    const report = completeReport()
    bindIncomplete(report, 3, '实际该时段双手垂下。', '恢复该时段原有姿态。')
    const withOwnRepair = structuredClone(report)
    withOwnRepair.requirementChecks[3].repair = report.defectEvidence[0].repair
    assert.throws(() => validate(withOwnRepair, shot, evidence, policy), /不得独立提供 repair/)
    const asrSource = structuredClone(report);asrSource.defectEvidence[0].source = 'asr'
    assert.throws(() => validate(asrSource, shot, evidence, policy), /confirmed script\/source=frame/)
  }
})

test('a verified defect survives a separate unobservable requirement without letting uncertainty enter its repair', () => {
  for (const validate of validators) {
    const report = completeReport()
    bindIncomplete(report, requirements.length - 1, '实际末帧双手垂下，违背原定末帧姿态。', '仅恢复原定末帧姿态。')
    report.requirementChecks[3] = { ...report.requirementChecks[3], status: 'unobservable', evidence: '缺少动作变化帧，无法判断该区间动作。' }
    const original = structuredClone(report), coverage = validate(report, shot, evidence, policy)
    const defects = validateMediaDefectEvidence(report, evidence, { shot, policy })
    assert.deepEqual(coverage.issues, report.issues)
    assert.equal(coverage.unobservableRequirements.length, 1)
    assert.equal(coverage.unobservableRequirements[0].requirementId, requirements[3].id)
    assert.equal(coverage.retryPrompt, '');assert.equal(defects.retryPrompt, '仅恢复原定末帧姿态。')
    assert.ok(!defects.retryPrompt.includes('区间动作'));assert.deepEqual(report, original)
    for (const patch of [{ frameIndices: [0] }, { repair: '把未观察区间也重拍' }, { defectIndex: 0 }, { frameIndices: undefined }]) {
      const invalid = structuredClone(report);invalid.requirementChecks[3] = { ...invalid.requirementChecks[3], ...patch }
      assert.throws(() => validate(invalid, shot, evidence, policy), /REVIEW_RESULT_INVALID:/, '已确证缺陷不能豁免unknown行的结构错误和越窗')
    }
  }
})

test('range diagnostics name every received and permitted real frame using the effective gate tolerance', () => {
  const candidate = { duration: 14, videoPrompt: '1-5.4秒：人物站立说话。5.4-9.8秒：保持原姿态。13.1-14秒：人物恢复直立。' }
  const actual = { frames: ['/0.jpg', '/1.jpg', '/2.jpg', '/3.jpg', '/4.jpg', '/5.jpg'], frameTimes: [0, 2.81, 6.32, 9.83, 12.64, 13.96], duration: 14.04 }
  const items = deriveMediaRequirements(candidate)
  const report = { requirementChecks: items.map((item, index) => ({ requirementId: item.id, status: 'complete', frameIndices: [[0, 1], [1, 2, 3], [4, 5]][index], evidence: '实际可见人物站立与姿态。' })) }
  for (const validate of validators) {
    const original = structuredClone(report)
    assert.throws(() => validate(report, candidate, actual, { timingTolerance: .25 }), error => {
      assert.ok(error instanceof Error)
      assert.ok(error.message.includes('原时间范围=[1,5.4]秒，实际容差=0.25秒，收到原帧=[{"index":0,"second":0},{"index":1,"second":2.81}]，合法原帧=[{"index":1,"second":2.81}]'))
      assert.ok(error.message.includes('原时间范围=[5.4,9.8]秒，实际容差=0.25秒，收到原帧=[{"index":1,"second":2.81},{"index":2,"second":6.32},{"index":3,"second":9.83}]，合法原帧=[{"index":2,"second":6.32},{"index":3,"second":9.83}]'))
      assert.ok(error.message.includes('原时间范围=[13.1,14]秒，实际容差=0.25秒，收到原帧=[{"index":4,"second":12.64},{"index":5,"second":13.96}]，合法原帧=[{"index":5,"second":13.96}]'))
      assert.match(error.message, /合法索引只限定采证范围，不证明complete/)
      return true
    })
    assert.deepEqual(report, original, '诊断不修改引用、不改变原判定')
    const middle = { requirementChecks: items.map((item, index) => ({ requirementId: item.id, status: 'complete', frameIndices: [[1], [3], [5]][index], evidence: '实际可见人物状态。' })) }
    assert.throws(() => validate(middle, candidate, actual, { timingTolerance: 0 }), error => {
      assert.ok(error instanceof Error)
      assert.ok(error.message.includes('实际容差=0秒，收到原帧=[{"index":3,"second":9.83}]，合法原帧=[{"index":2,"second":6.32}]'))
      return true
    })
  }
})

test('coverage retains every declared unknown and separates explicitly permitted gaps from blocking unknowns', () => {
  const source = { duration: 5, videoPrompt: '1-4秒：人物保持持卷姿态，以眼神微动作表现闲谈时的礼貌。',
    completionCriteria: ['本镜完成来意的信息陈述。'], storyProgress: { response: '礼貌神态仅为闲谈表现，不承担决定、许可或事件回应。' },
    pacing: { performanceBeats: [] } }
  const actual = { frames: ['/0', '/1', '/2', '/3'], frameTimes: [0, 1, 4, 4.96] }, requirement = deriveMediaRequirements(source)[0]
  const gap = { requirementQuote: '以眼神微动作表现闲谈时的礼貌', status: 'unobservable', evidence: '采样没有覆盖短暂眼神过程。', frameIndices: [1, 2],
    acceptanceImpact: { level: 'warning', policyRule: 'noncritical-performance-variation', reason: '原故事说明该神态不承担决定、许可或事件回应，未知不影响持卷与信息陈述。',
      contextReferences: [{ sourcePath: 'storyProgress', quote: source.storyProgress.response }] } }
  const report = { requirementChecks: [{ requirementId: requirement.id, status: 'unobservable', evidence: '帧1与2人物站立持卷。', frameIndices: [1, 2],
    scopeNotes: ['图片不能判断发音，由实际音轨门禁验收。'], evidenceGaps: [gap] }] }
  const enabled = { allowNoncriticalEvidenceGaps: true }
  for (const validate of validators) {
    const before = structuredClone({ source, actual, report }), result = validate(report, source, actual, enabled)
    assert.equal(result.unobservableRequirements.length, 1);assert.deepEqual(result.blockingUnobservableRequirements, [])
    assert.deepEqual(result.unobservableRequirements[0].evidenceGaps, report.requirementChecks[0].evidenceGaps)
    assert.deepEqual(result.unobservableRequirements[0].scopeNotes, report.requirementChecks[0].scopeNotes)
    assert.deepEqual({ source, actual, report }, before)
    for (const level of ['blocking', 'undetermined']) {
      const blocked = structuredClone(report);blocked.requirementChecks[0].evidenceGaps[0].acceptanceImpact.level = level
      const checked = validate(blocked, source, actual, enabled)
      assert.equal(checked.blockingUnobservableRequirements.length, 1)
      assert.deepEqual(checked.blockingUnobservableRequirements, checked.unobservableRequirements)
    }
    const legacy = { requirementChecks: [{ requirementId: requirement.id, status: 'unobservable', evidence: '缺少过程采样。', frameIndices: [] }] }
    assert.equal(validate(legacy, source, actual, enabled).blockingUnobservableRequirements.length, 1, '旧unknown不得因开启新政策而被隐式豁免')
    for (const option of [undefined, {}, { allowNoncriticalEvidenceGaps: false }]) assert.throws(() => validate(report, source, actual, option), /明确allowNoncriticalEvidenceGaps=true/)
    for (const patch of [{ requirementQuote: '另一项原文' }, { frameIndices: [0] }, { frameIndices: [3] }, { frameIndices: [999] },
      { acceptanceImpact: { ...gap.acceptanceImpact, contextReferences: [] } },
      { acceptanceImpact: { ...gap.acceptanceImpact, contextReferences: [{ sourcePath: 'pacing.performanceBeats', quote: source.storyProgress.response }] } }]) {
      const invalid = { requirementChecks: [{ ...report.requirementChecks[0], evidenceGaps: [{ ...gap, ...patch }] }] }, original = structuredClone(invalid)
      assert.throws(() => validate(invalid, source, actual, enabled), /REVIEW_RESULT_INVALID:.*evidenceGaps/)
      assert.deepEqual(invalid, original, '不猜测缺失来源，不改变gap或原报告')
    }
    const falseComplete = { requirementChecks: [{ ...report.requirementChecks[0], status: 'complete' }] }
    assert.throws(() => validate(falseComplete, source, actual, enabled), /必须保留unobservable/)
  }
})
