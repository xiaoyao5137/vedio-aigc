import test from 'node:test'
import assert from 'node:assert/strict'
import { MEDIA_EVIDENCE_GAPS_PROMPT, validateMediaEvidenceGaps } from '../src/media-evidence-gaps.ts'

const validators = [validateMediaEvidenceGaps,
  new Function(`return (${validateMediaEvidenceGaps.toString()});`)() as typeof validateMediaEvidenceGaps]
const requirement = { requirementQuote: '1-4秒：人物保持持卷姿态，以眼神微动作表现闲谈时的礼貌。' }
const context = [
  { sourcePath: 'completionCriteria', value: ['本镜必须完成有关来意的信息陈述。'] },
  { sourcePath: 'storyProgress', value: { status: 'continuing', actionResult: '来意信息呈现完整。', response: '礼貌神态仅为日常闲谈表现，不承担决定、许可或事件回应。', pendingActions: ['下一镜接收卷宗。'] } },
  { sourcePath: 'pacing.performanceBeats', value: [] },
]
const policy = { allowNoncriticalEvidenceGaps: true }
const warning = () => ({ requirementQuote: '以眼神微动作表现闲谈时的礼貌', status: 'unobservable', evidence: '采样未覆盖细微眼神过程。', frameIndices: [0, 2],
  acceptanceImpact: { level: 'warning', policyRule: 'noncritical-performance-variation',
    reason: '原上下文将礼貌神态限定为日常闲谈表现，不承担行动结果、人物回应、因果或明确表演节拍；该未知不影响持卷姿态与信息陈述的实质义务。',
    contextReferences: [{ sourcePath: 'storyProgress', quote: '礼貌神态仅为日常闲谈表现，不承担决定、许可或事件回应。' }] } })
const blocking = (level = 'blocking') => ({ requirementQuote: '保持持卷姿态', status: 'unobservable', evidence: '卷宗与手部接触被遮挡。', frameIndices: [],
  acceptanceImpact: { level, reason: '物件归属仍须实际证据。' } })
const row = () => ({ status: 'unobservable', evidence: '人物躯干直立，面向对方。', frameIndices: [0, 2], scopeNotes: ['图片不能判断发音，声音交由音轨门禁。'], evidenceGaps: [warning()] })

test('an explicitly permitted warning retains its original unknown and source evidence without changing the report', () => {
  for (const validate of validators) {
    const check = row(), before = structuredClone({ check, requirement, context })
    assert.deepEqual(validate(check, requirement, [0, 1, 2], context, policy), { errors: [], blocking: false, nonblockingGapIndices: [0] })
    assert.deepEqual({ check, requirement, context }, before)
    assert.equal(check.status, 'unobservable');assert.equal(check.evidenceGaps[0].status, 'unobservable')
    assert.ok(check.scopeNotes[0].includes('不能判断'), '模态限制留在独立scopeNotes，不参加事实evidence的确定性正则')
  }
})

test('blocking and undetermined gaps remain blocking even beside a valid warning', () => {
  for (const validate of validators) for (const level of ['blocking', 'undetermined']) {
    const check = { ...row(), evidenceGaps: [warning(), blocking(level)] }
    assert.deepEqual(validate(check, requirement, [0, 1, 2], context, policy), { errors: [], blocking: true, nonblockingGapIndices: [0] })
  }
})

test('legacy unknowns remain blocking and any gap forbids claiming complete or incomplete', () => {
  for (const validate of validators) {
    for (const evidenceGaps of [undefined, []]) {
      assert.deepEqual(validate({ status: 'unobservable', evidenceGaps }, requirement, [0], context), { errors: [], blocking: true, nonblockingGapIndices: [] })
      assert.deepEqual(validate({ status: 'complete', evidenceGaps }, requirement, [0], context), { errors: [], blocking: false, nonblockingGapIndices: [] })
    }
    for (const status of ['complete', 'incomplete', undefined]) {
      const result = validate({ ...row(), status }, requirement, [0, 1, 2], context, policy)
      assert.equal(result.blocking, true);assert.deepEqual(result.nonblockingGapIndices, []);assert.match(result.errors.join(';'), /必须保留unobservable/)
    }
  }
})

test('warning requires explicit policy permission, the exact rule, a reason and real context references', () => {
  for (const validate of validators) {
    for (const option of [undefined, {}, { allowNoncriticalEvidenceGaps: false }, { allowNoncriticalEvidenceGaps: 'true' }]) {
      const result = validate(row(), requirement, [0, 1, 2], context, option as typeof policy)
      assert.equal(result.blocking, true);assert.deepEqual(result.nonblockingGapIndices, []);assert.match(result.errors.join(';'), /明确allowNoncriticalEvidenceGaps=true/)
    }
    for (const overrides of [{ policyRule: undefined }, { policyRule: 'minor-motion' }, { reason: '' }, { reason: '  ' }, { contextReferences: [] }, { contextReferences: undefined }]) {
      const gap = warning(), result = validate({ ...row(), evidenceGaps: [{ ...gap, acceptanceImpact: { ...gap.acceptanceImpact, ...overrides } }] }, requirement, [0, 1, 2], context, policy)
      assert.ok(result.errors.length);assert.equal(result.blocking, true);assert.deepEqual(result.nonblockingGapIndices, [])
    }
  }
})

test('gap quotes and frame indexes are tied to this requirement and this numbering domain', () => {
  for (const validate of validators) {
    for (const overrides of [{ requirementQuote: '另一镜头的礼貌动作' }, { requirementQuote: '' }, { status: 'observed' }, { evidence: '' },
      { frameIndices: [3] }, { frameIndices: [0, 0] }, { frameIndices: [-1] }, { frameIndices: ['0'] }, { frameIndices: [0.5] }, { frameIndices: undefined }]) {
      const result = validate({ ...row(), evidenceGaps: [{ ...warning(), ...overrides }] }, requirement, [0, 1, 2], context, policy)
      assert.ok(result.errors.length);assert.equal(result.blocking, true);assert.deepEqual(result.nonblockingGapIndices, [])
    }
    const gap = warning();gap.frameIndices = []
    assert.equal(validate({ ...row(), evidenceGaps: [gap] }, requirement, [0, 2], context, policy).blocking, false, '细项未知允许空引用，但整项实质事实仍有原图依据')
    const withoutImages = validate({ ...row(), frameIndices: [], evidenceGaps: [gap] }, requirement, [], context, policy)
    assert.equal(withoutImages.blocking, true);assert.deepEqual(withoutImages.nonblockingGapIndices, [])
    assert.match(withoutImages.errors.join(';'), /不能豁免整个无图要求/)
    for (const frameIndices of [undefined, [], [3], [0, 3], ['0'], [0, 0]]) {
      const missingFacts = validate({ ...row(), frameIndices, evidenceGaps: [gap] }, requirement, [0, 2], context, policy)
      assert.equal(missingFacts.blocking, true);assert.deepEqual(missingFacts.nonblockingGapIndices, [])
      assert.match(missingFacts.errors.join(';'), /实际引用支撑已确认的实质事实/)
    }
  }
})

test('context quotations match one original string at the exact source path, not keys, escaped JSON or joined fields', () => {
  for (const validate of validators) {
    const gap = warning(), references = [
      { sourcePath: 'missing', quote: '礼貌神态' },
      { sourcePath: 'completionCriteria', quote: '礼貌神态' },
      { sourcePath: 'storyProgress', quote: 'actionResult' },
      { sourcePath: 'storyProgress', quote: '来意信息呈现完整。礼貌神态' },
      { sourcePath: 'storyProgress', quote: '' },
    ]
    for (const reference of references) {
      const result = validate({ ...row(), evidenceGaps: [{ ...gap, acceptanceImpact: { ...gap.acceptanceImpact, contextReferences: [reference] } }] }, requirement, [0, 2], context, policy)
      assert.match(result.errors.join(';'), /唯一定位原sourcePath/);assert.equal(result.blocking, true)
    }
    assert.ok(validate(row(), requirement, [0, 2], [...context, context[1]], policy).errors.length, '重复原路径不能任意选择一个来源')
    const multiline = [{ sourcePath: 'note', value: ['第一行\n第二行'] }]
    const withQuote = (quote: string) => ({ ...row(), evidenceGaps: [{ ...gap, acceptanceImpact: { ...gap.acceptanceImpact, contextReferences: [{ sourcePath: 'note', quote }] } }] })
    assert.equal(validate(withQuote('第一行\n第二行'), requirement, [0, 2], multiline, policy).errors.length, 0)
    assert.ok(validate(withQuote('第一行\\n第二行'), requirement, [0, 2], multiline, policy).errors.length)
  }
})

test('references may resolve real nested fields and array indexes while prototype paths and missing fields remain invalid', () => {
  for (const validate of validators) {
    const gap = warning()
    const withReference = (sourcePath: string, quote: string) => ({ ...row(), evidenceGaps: [{ ...gap,
      acceptanceImpact: { ...gap.acceptanceImpact, contextReferences: [{ sourcePath, quote }] } }] })
    for (const [sourcePath, quote] of [['storyProgress.response', '礼貌神态仅为日常闲谈表现'],
      ['storyProgress.actionResult', '来意信息呈现完整。'], ['storyProgress.pendingActions[0]', '下一镜接收卷宗。'],
      ['storyProgress.pendingActions.0', '下一镜接收卷宗。'], ['completionCriteria[0]', '本镜必须完成有关来意的信息陈述。']]) {
      assert.deepEqual(validate(withReference(sourcePath, quote), requirement, [0, 2], context, policy), { errors: [], blocking: false, nonblockingGapIndices: [0] })
    }
    for (const sourcePath of ['storyProgress.missing', 'storyProgress.actionResult.extra', 'storyProgress.pendingActions[1]', 'storyProgress.pendingActions.length',
      'storyProgress.pendingActions[01]', 'storyProgress.__proto__', 'storyProgress.constructor.name', 'storyProgress.prototype', 'storyProgress.toString',
      'storyProgress..response', 'storyProgress["response"]', 'storyProgressX.response']) {
      const result = validate(withReference(sourcePath, '礼貌神态'), requirement, [0, 2], context, policy)
      assert.ok(result.errors.length, sourcePath);assert.equal(result.blocking, true);assert.deepEqual(result.nonblockingGapIndices, [])
    }
    const ownReserved = [{ sourcePath: 'storyProgress', value: JSON.parse('{"__proto__":"不准从原型路径引用","constructor":"不准从构造路径引用"}') }]
    assert.ok(validate(withReference('storyProgress.__proto__', '不准从原型路径引用'), requirement, [0, 2], ownReserved, policy).errors.length)
    const specific = [...context, { sourcePath: 'storyProgress.response', value: '更具体的原字段内容。' }]
    assert.equal(validate(withReference('storyProgress.response', '更具体的原字段内容。'), requirement, [0, 2], specific, policy).errors.length, 0)
    assert.ok(validate(withReference('storyProgress.response', '更具体的原字段内容。'), requirement, [0, 2], [...specific, specific.at(-1)!], policy).errors.length, '同等具体的根仍须唯一，不能任意选来源')
  }
})

test('the citation instructions and validator agree on string leaves in a serialized activity window', () => {
  const windows = [{ sourcePath: 'pacing.activityWindows', value: [{ kind: 'reaction', endSecond: 13.8, startSecond: 13.1 }] }]
  for (const validate of validators) {
    const withReference = (sourcePath: string, quote: string) => {
      const gap = warning()
      gap.acceptanceImpact.contextReferences = [{ sourcePath, quote }]
      return { ...row(), evidenceGaps: [gap] }
    }
    for (const sourcePath of ['pacing.activityWindows', 'pacing.activityWindows[0].kind']) {
      assert.equal(validate(withReference(sourcePath, 'reaction'), requirement, [0, 2], windows, policy).blocking, false)
    }
    for (const [sourcePath, quote] of [
      ['pacing.activityWindows', '"kind":"reaction","endSecond":13.8,"startSecond":13.1'],
      ['pacing.activityWindows', '"reaction"'], ['pacing.activityWindows[0].endSecond', '13.8'],
    ]) {
      const result = validate(withReference(sourcePath, quote), requirement, [0, 2], windows, policy)
      assert.equal(result.blocking, true);assert.ok(result.errors.length);assert.deepEqual(result.nonblockingGapIndices, [])
    }
    assert.deepEqual(validate({ ...row(), evidenceGaps: [blocking('undetermined')] }, requirement, [0, 2], windows, policy),
      { errors: [], blocking: true, nonblockingGapIndices: [] })
  }
  assert.match(MEDIA_EVIDENCE_GAPS_PROMPT, /一个字符串叶子的连续原文/)
  assert.match(MEDIA_EVIDENCE_GAPS_PROMPT, /不含JSON键名、结构引号、数值、转义或跨字段\/数组元素拼接/)
  assert.match(MEDIA_EVIDENCE_GAPS_PROMPT, /无可用原文不造引用，用undetermined/)
})

test('malformed optional fields or impact declarations fail safely and the shared contract keeps semantics out of code', () => {
  for (const validate of validators) {
    for (const scopeNotes of ['scope', [null], [''], [0]]) {
      const result = validate({ ...row(), scopeNotes }, requirement, [0, 2], context, policy)
      assert.ok(result.errors.length);assert.equal(result.blocking, true);assert.deepEqual(result.nonblockingGapIndices, [])
    }
    for (const evidenceGaps of ['hidden', {}, [null], [{}]]) assert.ok(validate({ ...row(), evidenceGaps }, requirement, [0, 2], context, policy).errors.length)
    for (const impact of [{ level: 'optional', reason: '不应自行发明级别。' }, { level: 'blocking' }, { level: 'blocking', reason: '关键未知。', contextReferences: 'source' }]) {
      assert.ok(validate({ ...row(), evidenceGaps: [{ ...blocking(), acceptanceImpact: impact }] }, requirement, [0, 2], context, policy).errors.length)
    }
  }
  assert.ok(MEDIA_EVIDENCE_GAPS_PROMPT.length < 1300)
  assert.match(MEDIA_EVIDENCE_GAPS_PROMPT, /不承担行动结果、人物回应、因果或明确表演节拍/)
  assert.match(MEDIA_EVIDENCE_GAPS_PROMPT, /不能仅因幅度轻微、采样未见或完成条件未重复列出而降级/)
  assert.match(MEDIA_EVIDENCE_GAPS_PROMPT, /代码只校验契约与来源绑定，不替你判断语义/)
  assert.match(MEDIA_EVIDENCE_GAPS_PROMPT, /不得自动把综合报告的uncertain\/false升级为accepted\/true/)
})
