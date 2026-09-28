import { storyboardTimelineConsumerCode } from '../src/storyboard-timeline.ts'
import { resolveNativeFrameDisplayInterval } from '../src/media-frame-display.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { validateMediaDefectEvidence, MEDIA_DEFECT_EVIDENCE_PROMPT, refreshMediaDefectEvidencePrompt, refreshScopedMediaDefectPrompt } from '../src/media-defect-evidence.ts'
import { validateScriptStateEvidence } from '../src/script-state-evidence.ts'

const evidence = { frames: ['/0.jpg', '/1.jpg'], duration: 14.04,
  speechValidation: { alignment: [{ actualStart: 1, actualEnd: 3 }] } }
const uncertainComplaint = '帧0空间归属不明确，可能手持物、发饰或背景投影，需确认是否计划外道具'
const uncertainFinding = '当前证据不足以排除计划外道具可能性'
const confirmedFinding = '帧0右手五指环握木杆，木杆轮廓与手掌接触，帧1同样可见'
const validators = [validateMediaDefectEvidence,
  new Function(`const resolveNativeFrameDisplayInterval=(${resolveNativeFrameDisplayInterval.toString()});const validateScriptStateEvidence=(${validateScriptStateEvidence.toString()});return ${storyboardTimelineConsumerCode(validateMediaDefectEvidence)}`)() as typeof validateMediaDefectEvidence]

test('the actual uncertain prop refusal must be reviewed on the same material, even if labeled confirmed', () => {
  for (const validate of validators) {
    const report = { issues: [uncertainComplaint], visualChecks: [{ character: '甲', consistent: false, evidence: uncertainFinding }] }
    assert.throws(() => validate(report, evidence), /REVIEW_RESULT_INVALID:.*defectEvidence.*不购买新视频/)
    for (const status of ['confirmed', 'uncertain']) {
      const value = { ...report, defectEvidence: [{ issueIndex: 0, visualCheckIndex: 0, status,
        source: 'frame', frameIndices: [0], finding: uncertainFinding, repair: '去掉疑似道具' }] }
      const original = structuredClone(value)
      assert.throws(() => validate(value, evidence), /REVIEW_RESULT_INVALID:.*(?:声称 confirmed|全部拒绝项仍为 uncertain)/)
      assert.deepEqual(value, original, '不得把unknown改成confirmed或重写原报告')
    }
  }
})

test('per-defect certainty preserves a real refusal and its repair despite another uncertain object', () => {
  for (const validate of validators) {
    const report = { issues: ['甲实际手持计划外木杆', uncertainComplaint],
      visualChecks: [{ character: '甲', consistent: false, evidence: confirmedFinding }, { character: '乙', consistent: false, evidence: uncertainFinding }],
      warnings: ['另一名背景人物被遮挡，无法确认'], retryPrompt: '修正木杆，并去掉乙可能持有的物体',
      defectEvidence: [
        { issueIndex: 0, visualCheckIndex: 0, status: 'confirmed', source: 'frame', frameIndices: [0, 1], finding: confirmedFinding, repair: '保留全部剧情与其他角色，只去掉甲手中木杆' },
        { issueIndex: 1, visualCheckIndex: 1, status: 'uncertain', finding: uncertainFinding },
      ] }
    const original = structuredClone(report), result = validate(report, evidence)
    assert.deepEqual(result.issues, ['甲实际手持计划外木杆'])
    assert.equal(result.retryPrompt, '保留全部剧情与其他角色，只去掉甲手中木杆')
    assert.equal(result.uncertainDefects.length, 1);assert.deepEqual(report, original)
    const missing = { ...report, defectEvidence: report.defectEvidence.slice(0, 1) }
    assert.throws(() => validate(missing, evidence), /逐项覆盖全部/)
    assert.throws(() => validate({ ...report, defectEvidence: [...report.defectEvidence, report.defectEvidence[0]] }, evidence), /越界或重复/)
    assert.throws(() => validate({ ...report, defectEvidence: [{ ...report.defectEvidence[0], frameIndices: [9] }, report.defectEvidence[1]] }, evidence), /有效实际采样帧编号/)
  }
})

test('confirmed ASR defects require actual alignment support while an accepted report needs no fabricated defects', () => {
  for (const validate of validators) {
    assert.deepEqual(validate({ issues: [], visualChecks: [{ consistent: true }] }, evidence).issues, [])
    const report = { issues: ['实际台词遗漏明确关键词'], defectEvidence: [{ issueIndex: 0, status: 'confirmed', source: 'asr',
      startSecond: 1, endSecond: 3, finding: '实际1至3秒ASR中该关键词未出现', repair: '保留其他内容，完整说出原句' }] }
    assert.deepEqual(validate(report, evidence).issues, report.issues)
    assert.throws(() => validate({ ...report, defectEvidence: [{ ...report.defectEvidence[0], endSecond: 4 }] }, evidence), /实际ASR对齐范围/)
  }
})

test('the reviewer permits an already established opening state and retains explicit action obligations', () => {
  assert.match(MEDIA_DEFECT_EVIDENCE_PROMPT, /允许第一帧已经成立/)
  assert.match(MEDIA_DEFECT_EVIDENCE_PROMPT, /不能自行增加/)
  assert.match(MEDIA_DEFECT_EVIDENCE_PROMPT, /真实明确要求的动作缺失仍须拒绝/)
  const prompt = refreshMediaDefectEvidencePrompt('用户自定义规则')
  assert.ok(prompt.startsWith('用户自定义规则'));assert.equal(refreshMediaDefectEvidencePrompt(prompt), prompt)
})

test('scoped script defects bind original time windows, preserve a real holding failure, and never extend opening poses to the entire clip', () => {
  const actual = { frames: ['/0.jpg', '/1.jpg', '/2.jpg', '/3.jpg', '/4.jpg', '/5.jpg'], frameTimes: [0, 2.81, 6.32, 9.83, 12.64, 13.96], duration: 14.04 }
  const shot = { videoPrompt: '0–1秒：双手拱于胸前。1–5.4秒：说出第一句。5.4–9.8秒：保持拱手姿态，说出第二句。9.8–14秒：说出第三句。',
    visualPrompt: '人物双手拱于胸前。', lastFramePrompt: '人物双手拱于胸前，站在门旁。' }
  const contract = { shot, policy: { timingTolerance: .25 } }
  const defect = { issueIndex: 0, status: 'confirmed', source: 'frame', category: 'script', scope: 'interval', requirementPath: 'videoPrompt',
    requirementQuote: '保持拱手姿态，说出第二句。', startSecond: 5.4, endSecond: 9.8, frameIndices: [2, 3], finding: '帧2与3双手实际垂下，未保持该时段明确要求的拱手姿态', repair: '仅在原文要求的时段保持拱手，保留台词与其他动作' }
  for (const validate of validators) {
    const report = { issues: ['指定时段未保持拱手姿态'], defectEvidence: [defect] }
    assert.deepEqual(validate(report, actual, contract).issues, report.issues, '真实5.4–9.8秒保持要求的失败必须仍然拒绝')
    const check = (patch: Record<string, unknown>, config = contract) => validate({ ...report, defectEvidence: [{ ...defect, ...patch }] }, actual, config)
    assert.throws(() => check({ startSecond: 0, endSecond: 14 }), /时间范围超出原要求/)
    assert.throws(() => check({ requirementQuote: '双手拱于胸前。', startSecond: 0, endSecond: 1, frameIndices: [1] }), /引用帧不在/)
    assert.throws(() => check({ requirementQuote: '全片始终双手拱于胸前' }), /requirementQuote 不在/)
    assert.throws(() => check({ requirementPath: '不存在' }), /未指向当前分镜/)
    assert.throws(() => check({ startSecond: 5.4, endSecond: 5.5, frameIndices: [2] }), /引用帧不在/)
    assert.throws(() => check({ requirementPath: 'visualPrompt', requirementQuote: '双手拱于胸前', scope: 'whole-shot', frameIndices: [0, 1, 2, 3, 4, 5] }), /开场状态只约束首帧/)
    assert.throws(() => check({ requirementPath: 'lastFramePrompt', requirementQuote: '双手拱于胸前', scope: 'whole-shot', frameIndices: [2] }), /lastFramePrompt 只约束实际尾帧/)
    const ending = { ...defect, requirementPath: 'lastFramePrompt', requirementQuote: '双手拱于胸前', scope: 'ending', frameIndices: [5], startSecond: 13.96, endSecond: 13.96 }
    assert.equal(validate({ ...report, defectEvidence: [ending] }, actual, contract).issues.length, 1)
    const secondsAlias = { shot, policy: { timingToleranceSeconds: .25 } }
    assert.equal(validate(report, actual, secondsAlias).issues.length, 1, '正常采样边界同样接受metrics命名的容差')
    const fromMetrics = { shot, metrics: { policy: { timingToleranceSeconds: .25 } } }
    assert.equal(validate(report, actual, fromMetrics).issues.length, 1)
  }
})

test('scoped speech rejects spelling-only claims below phonetic thresholds while preserving actual phonetic and pacing defects', () => {
  const actual = { ...evidence, speechValidation: { phoneticErrorRate: .0217,
    alignment: [{ actualStart: .37, actualEnd: 4.29 }, { actualStart: 4.73, actualEnd: 9.47 }, { actualStart: 10.31, actualEnd: 13.39 }] } }
  const contract = { policy: { maxPhoneticErrorRate: .2 }, metrics: { speech: [{ elapsed: 3.92, allowedSpan: 5.8, timingAssessment: 'within-allowance' }] } }
  const defect = { issueIndex: 0, status: 'confirmed', source: 'asr', category: 'speech', rule: 'phonetic-error-rate', startSecond: .37, endSecond: 13.39,
    finding: 'ASR为同音字替代且对齐覆盖率0.923', repair: '要求发音区分同音字' }
  for (const validate of validators) {
    const report = { issues: ['原始ASR文字字形与台词不同'], defectEvidence: [defect] }
    assert.throws(() => validate(report, actual, contract), /phoneticErrorRate 未超过配置.*同音字/)
    const real = { ...report, defectEvidence: [{ ...defect, finding: '实际多句包含非同音发音错误与漏词，音素错误率0.4', repair: '完整准确读出原台词' }] }
    assert.equal(validate(real, { ...actual, speechValidation: { ...actual.speechValidation, phoneticErrorRate: .4 } }, contract).issues.length, 1)
    const timing = { ...report, defectEvidence: [{ ...defect, rule: 'speech-timing', speechIndex: 0, startSecond: .37, endSecond: 4.29, finding: '实际语速拖慢', repair: '以正常语速完整说出原句' }] }
    assert.throws(() => validate(timing, actual, contract), /该句实际跨度在含容差/)
    const slow = { ...contract, metrics: { speech: [{ elapsed: 6, allowedSpan: 5, timingAssessment: 'outside-allowance' }] } }
    assert.equal(validate(timing, actual, slow).issues.length, 1)
  }
})

test('scoped visual artifacts keep existing identity, era and continuity failures available without invented script requirements', () => {
  for (const validate of validators) {
    for (const rule of ['black-frame', 'visual-deformation', 'unexpected-overlay', 'object-discontinuity', 'identity-mismatch', 'era-anachronism', 'spatial-discontinuity']) {
      const report = { issues: ['实际存在明确视觉缺陷'], defectEvidence: [{ issueIndex: 0, status: 'confirmed', category: 'visual-artifact', rule,
        source: 'frame', frameIndices: [0, 1], finding: '实际帧证据明确显示该缺陷', repair: '修复该缺陷，保留原剧情' }] }
      assert.equal(validate(report, evidence, {}).issues.length, 1)
    }
    const pose = { issues: ['全片须保持开场姿态'], defectEvidence: [{ issueIndex: 0, status: 'confirmed', category: 'visual-artifact', rule: 'hold-opening-pose',
      source: 'frame', frameIndices: [0, 1], finding: '后续双手已放下', repair: '全片保持拱手' }] }
    assert.throws(() => validate(pose, evidence, {}), /特定姿态.*须改用script/)
  }
  const prompt = refreshScopedMediaDefectPrompt('自定义规则')
  assert.equal(refreshScopedMediaDefectPrompt(prompt), prompt);assert.ok(!prompt.includes('5.4'))
})

test('one invalid report returns every independent defect diagnostic without repairing fields or returning purchase instructions', () => {
  const actual = { ...evidence, frameTimes: [0, 7], speechValidation: { ...evidence.speechValidation, phoneticErrorRate: .0217 } }
  const contract = { shot: { videoPrompt: '0–1秒：双手拱于胸前。5–9秒：保持拱手姿态。9–14秒：放下双手。' }, policy: { maxPhoneticErrorRate: .2 } }
  const report = { issues: ['规定时间内双手垂下', 'ASR字形不同', '画面主体变形', '首帧为全黑画面'], defectEvidence: [
    { issueIndex: 0, status: 'confirmed', category: 'script', requirementPath: 'videoPrompt', requirementQuote: '保持拱手姿态。',
      scope: 'opening', startSecond: 5, endSecond: 9, frameIndices: [1], finding: '帧1双手垂下', repair: '在规定时段保持拱手' },
    { issueIndex: 1, status: 'confirmed', category: 'speech', rule: 'phonetic-error-rate', maxPhoneticErrorRate: .02,
      startSecond: 1, endSecond: 3, finding: 'ASR字形与原文不同', repair: '纠正读音' },
    { issueIndex: 2, status: 'confirmed', source: 'frame', category: 'visual-artifact', rule: 'visual-deformation',
      frameIndices: [99], finding: '主体疑似变形' },
    { issueIndex: 3, status: 'confirmed', source: 'frame', category: 'visual-artifact', rule: 'black-frame',
      frameIndices: [0], finding: '首帧全黑且无有效画面内容', repair: '修复首帧黑屏，保留其他内容' },
  ] }
  for (const validate of validators) {
    const original = structuredClone(report)
    assert.throws(() => validate(report, actual, contract), error => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /^REVIEW_RESULT_INVALID:/)
      assert.match(error.message, /defectEvidence\[0\].*source frame\/asr/)
      assert.match(error.message, /defectEvidence\[0\] scope 必须为原要求对应的 interval/)
      assert.match(error.message, /defectEvidence\[1\].*source frame\/asr/)
      assert.match(error.message, /defectEvidence\[1\].*phoneticErrorRate 未超过配置.*实际值=0\.0217，配置阈值=0\.2/)
      assert.match(error.message, /defectEvidence\[2\] 声称 confirmed/)
      assert.match(error.message, /defectEvidence\[2\].*局部 repair/)
      assert.match(error.message, /defectEvidence\[2\].*有效实际采样帧编号/)
      assert.ok(!error.message.includes('defectEvidence[3]'), '真实黑屏缺陷不应被改写成非法或通过')
      assert.equal(error.message.match(/REVIEW_RESULT_INVALID:/g)?.length, 1)
      assert.equal(error.message.match(/不购买新视频/g)?.length, 1)
      return true
    }, '存在合法缺陷也不得把非法报告返回购买分支')
    assert.deepEqual(report, original, '原始报告与虚构阈值保留为复核证据，不能自动猜补source/scope或改成passed')
    assert.equal(report.defectEvidence[0].source, undefined)
  }
})

test('invalid row bindings do not hide errors in other rows and remain one same-material review failure', () => {
  const report = { issues: ['甲缺陷', '乙缺陷'], visualChecks: [{ consistent: false, evidence: '实际可见缺陷' }], defectEvidence: [
    { issueIndex: 9, visualCheckIndex: 9, status: 'confirmed', finding: '实际可见缺陷' },
    { issueIndex: 1, status: 'confirmed', source: 'frame', frameIndices: [9], finding: '实际可见缺陷', repair: '只修复此缺陷' },
  ] }
  for (const validate of validators) {
    const original = structuredClone(report)
    assert.throws(() => validate(report, evidence), error => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /defectEvidence\[0\]\.issueIndex 越界或重复/)
      assert.match(error.message, /defectEvidence\[0\]\.visualCheckIndex 必须唯一绑定/)
      assert.match(error.message, /defectEvidence\[1\].*有效实际采样帧编号/)
      assert.match(error.message, /逐项覆盖全部/)
      assert.match(error.message, /复核同一素材，不购买新视频$/)
      return true
    })
    assert.deepEqual(report, original)
  }
})

test('strict primary script evidence blocks the actual invented hand lowering repair while legacy gates remain compatible', () => {
  const actual = { duration: 14.04, frames: ['/8.jpg', '/9.jpg', '/10.jpg'], frameTimes: [13.1, 13.55, 13.96] }
  const shot = { videoPrompt: '13.1-14秒:说完后门客恢复直立姿态,面容平和,目光望向前方。', lastFramePrompt: '门客双手拱于胸前。' }
  // The refusal fields are preserved from the observed report; adding a valid
  // time/quote binding used to be enough to publish this invented instruction.
  const row = { issueIndex: 0, status: 'confirmed', category: 'script', source: 'frame', frameIndices: [0, 1, 2],
    startSecond: 13.1, endSecond: 14, scope: 'interval', requirementPath: 'videoPrompt', requirementQuote: shot.videoPrompt,
    finding: '双手始终保持拱于胸前，未观察到手臂放下。恢复直立姿态应包含双手放下至身体两侧的动作。',
    repair: '双手从拱手姿态自然放下至身体两侧，确保末帧双手自然垂于身侧。' }
  const report = { issues: ['末帧仍拱手，与恢复直立姿态不符'], defectEvidence: [row] }
  for (const validate of validators) {
    const original = structuredClone(report)
    assert.equal(validate(report, actual, { shot }).retryPrompt, row.repair, 'explicit opt-in keeps old custom gate behavior')
    const strict = { shot, policy: { requireScriptStateEvidence: true } }
    assert.throws(() => validate(report, actual, strict), /REVIEW_RESULT_INVALID:.*stateEvidence.*不购买新视频/)
    const invented = { ...report, defectEvidence: [{ ...row, stateEvidence: { basis: 'visible-state-contradiction', violatedQuote: '恢复直立姿态',
      requiredStateQuote: '双手放下', observedState: '双手拱于胸前', temporalBasis: 'state-at-sample' } }] }
    assert.throws(() => validate(invented, actual, strict), /stateEvidence.*逐字绑定/)
    assert.throws(() => validate(invented, actual, { shot }), /stateEvidence.*逐字绑定/, 'a supplied malformed contract is never ignored')
    assert.deepEqual(report, original)
  }
})

test('strict primary state evidence preserves real held-pose failure, speech and artifact rules, and accepted empty defects', () => {
  const actual = { duration: 6, frames: ['/0.jpg', '/1.jpg'], frameTimes: [0, 3] }
  const quote = '2-5秒：人物保持双手拱于胸前。', shot = { videoPrompt: quote }
  const row = { issueIndex: 0, status: 'confirmed', category: 'script', source: 'frame', frameIndices: [1], startSecond: 2, endSecond: 5,
    scope: 'interval', requirementPath: 'videoPrompt', requirementQuote: quote, finding: '双手分离下垂于身体两侧', repair: '仅在2-5秒保持双手拱于胸前。',
    stateEvidence: { basis: 'visible-state-contradiction', violatedQuote: '保持双手拱于胸前', requiredStateQuote: '双手拱于胸前',
      observedState: '双手分离下垂于身体两侧', temporalBasis: 'sustained-state', persistenceQuote: '保持双手拱于胸前' } }
  for (const validate of validators) {
    const policy = { requireScriptStateEvidence: true }
    assert.equal(validate({ issues: ['明确保持姿态被解除'], defectEvidence: [row] }, actual, { shot, policy }).retryPrompt, row.repair)
    assert.deepEqual(validate({ issues: [], defectEvidence: [] }, actual, { shot, policy }).issues, [])
    const artifact = { issues: ['首帧黑屏'], defectEvidence: [{ issueIndex: 0, status: 'confirmed', category: 'visual-artifact', rule: 'black-frame', source: 'frame', frameIndices: [0], finding: '首帧为黑屏', repair: '恢复首帧画面' }] }
    assert.equal(validate(artifact, actual, { shot, policy }).issues.length, 1)
  }
})
