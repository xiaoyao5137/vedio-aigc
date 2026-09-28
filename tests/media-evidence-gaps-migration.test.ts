import test from 'node:test'
import assert from 'node:assert/strict'
import { upgradeStructuredMediaEvidenceGaps, upgradeMediaContextQuoteContract, upgradeSharedMediaCriticalityContext, COMPLETE_MEDIA_DEFECT_EVIDENCE_CODE, INDEPENDENT_MEDIA_REVIEW_VIEW_CODE, ADAPTIVE_MEDIA_REVIEW_GUARD_CODE } from '../src/quality-node-presets.ts'
import { CANONICAL_MEDIA_REVIEW_PROMPT } from '../src/canonical-media-review.ts'
import { REQUIREMENT_MEDIA_REVIEW_PROMPT } from '../src/media-requirement-review.ts'
import { MEDIA_EVIDENCE_GAPS_PROMPT } from '../src/media-evidence-gaps.ts'

const param = (name: string, value: string, type = 'json') => ({ id: name, name, englishName: name, type, value, required: true })
const node = (id: string, kind: string) => ({ id, kind, title: id, resultVar: id, prompt: '', params: [] as ReturnType<typeof param>[], uploads: [], position: { x: 0, y: 0 } })
const fixture = () => ({ id: 'wf-sanguo-history-drama', schemaVersion: 106, nodes: [
  { ...node('sanguo-media-accept', 'code'), code: COMPLETE_MEDIA_DEFECT_EVIDENCE_CODE + '\n' + INDEPENDENT_MEDIA_REVIEW_VIEW_CODE + '\n' + ADAPTIVE_MEDIA_REVIEW_GUARD_CODE,
    params: [param('maxAdaptiveSamplingFrames', '24', 'number'), param('maxAdaptiveSamplingRounds', '2', 'number')] },
  { ...node('sanguo-media-review', 'text'), prompt: '保留用户前缀\n' + CANONICAL_MEDIA_REVIEW_PROMPT + '\n保留用户后缀', params: [param('reviewPolicySource', JSON.stringify({ nodeId: 'sanguo-media-accept', fields: ['maxAdaptiveSamplingFrames'] }))] },
  { ...node('sanguo-requirement-review', 'text'), prompt: '单项前缀\n' + REQUIREMENT_MEDIA_REVIEW_PROMPT + '\n单项后缀' },
  { ...node('sanguo-media-accept-error-branch', 'branch'), code: 'return branch.counts.false < params.maxAttempts;', params: [param('maxAttempts', '4', 'number')] },
  { ...node('sanguo-video', 'video'), prompt: '已付费素材的原生成要求', params: [param('duration', '14', 'number')] },
], edges: [{ id: 'existing-retry', from: 'sanguo-media-accept-error-branch', to: 'sanguo-media-request', branch: 'false' as const }] })

test('structured gap deployment refreshes marked validators and both live policies while preserving paid generation and budgets', () => {
  const source = fixture(), before = structuredClone(source), next = upgradeStructuredMediaEvidenceGaps(source)
  assert.equal(next.schemaVersion, 107);assert.equal(next.edges, source.edges)
  assert.equal(upgradeStructuredMediaEvidenceGaps(next), next);assert.deepEqual(source, before)
  const gate = next.nodes[0]
  assert.equal(gate.params.find(item => item.englishName === 'allowNoncriticalEvidenceGaps')?.value, 'true')
  assert.ok(gate.code?.includes('blockingUnobservableRequirements'))
  assert.ok(gate.code?.includes('validateMediaEvidenceGaps'))
  for (const id of ['sanguo-media-review', 'sanguo-requirement-review']) {
    const reviewer = next.nodes.find(item => item.id === id)!
    const policy = JSON.parse(reviewer.params.find(item => item.englishName === 'reviewPolicySource')!.value)
    assert.equal(policy.nodeId, gate.id);assert.ok(policy.fields.includes('allowNoncriticalEvidenceGaps'))
    assert.ok(reviewer.prompt.includes('${params.reviewPolicy}'))
  }
  assert.ok(next.nodes[2].prompt.startsWith('单项前缀\n'));assert.ok(next.nodes[2].prompt.endsWith('\n单项后缀'));
  assert.ok(next.nodes[1].prompt.startsWith('保留用户前缀\n'));assert.ok(next.nodes[1].prompt.endsWith('\n保留用户后缀'))
  for (const id of ['sanguo-media-accept-error-branch', 'sanguo-video']) assert.equal(next.nodes.find(item => item.id === id), source.nodes.find(item => item.id === id))
})

test('explicit strict gap policy and custom review policy sources are retained; unknown custom gate is never rewritten', () => {
  const source = fixture();source.nodes[0].params.push(param('allowNoncriticalEvidenceGaps', 'false', 'boolean'))
  const custom = param('reviewPolicySource', '{"nodeId":"custom-gate","fields":["strict"]}')
  source.nodes[2].params.push(custom)
  const next = upgradeStructuredMediaEvidenceGaps(source)
  assert.equal(next.nodes[0].params, source.nodes[0].params)
  assert.equal(next.nodes[2].params.find(item => item.englishName === 'reviewPolicySource'), custom)
  const unmanaged = { ...source, nodes: source.nodes.map(item => item.id === source.nodes[0].id ? { ...item, code: 'return customReview(context);' } : item) }
  assert.equal(upgradeStructuredMediaEvidenceGaps(unmanaged), unmanaged)
  const other = { ...source, id: 'custom-workflow' };assert.equal(upgradeStructuredMediaEvidenceGaps(other), other)
})

test('schema108 clarifies marked citation prompts and preserves every model, parameter, budget and surrounding custom rule', () => {
  const current = upgradeStructuredMediaEvidenceGaps(fixture())
  const oldShared = '【观察事实与未证实细项】\n旧共享条款：quote取原值片段。\n不得自动把综合报告的uncertain/false升级为accepted/true。'
  const source = { ...current, nodes: current.nodes.map(node => ['sanguo-media-review', 'sanguo-requirement-review'].includes(node.id) ? {
    ...node, modelId: 'existing-vision-model', prompt: node.prompt.replace(MEDIA_EVIDENCE_GAPS_PROMPT, oldShared)
      .replace('完成条件[sourcePath=completionCriteria]：', '完成条件：')
      .replace('表演节奏[可引sourcePath=pacing.performanceBeats/pacing.activityWindows]：', '表演节奏：')
      .replace('剧情进展[sourcePath=storyProgress]：', '剧情进展：'),
    params: [...node.params, param('temperature', '.17', 'number'), param('maxTokens', '777', 'number')],
  } : node) }
  const before = structuredClone(source), next = upgradeMediaContextQuoteContract(source)
  assert.equal(next.schemaVersion, 108);assert.equal(next.edges, source.edges);assert.deepEqual(source, before)
  assert.equal(upgradeMediaContextQuoteContract(next), next)
  for (const [index, node] of next.nodes.entries()) {
    const original = source.nodes[index]
    if (!['sanguo-media-review', 'sanguo-requirement-review'].includes(node.id)) { assert.equal(node, original);continue }
    assert.ok(node.prompt.includes(MEDIA_EVIDENCE_GAPS_PROMPT));assert.ok(!node.prompt.includes('旧共享条款'))
    assert.equal(node.params, original.params)
    assert.deepEqual({ ...node, prompt: '' }, { ...original, prompt: '' })
    assert.equal(node.params.filter(item => item.englishName === 'temperature').length, 1)
  }
  assert.ok(next.nodes[1].prompt.startsWith('保留用户前缀\n'));assert.ok(next.nodes[1].prompt.endsWith('\n保留用户后缀'))
  assert.ok(next.nodes[2].prompt.startsWith('单项前缀\n'));assert.ok(next.nodes[2].prompt.endsWith('\n单项后缀'))
  assert.ok(next.nodes[1].prompt.includes('sourcePath=completionCriteria'))
  assert.ok(next.nodes[1].prompt.includes('sourcePath=pacing.performanceBeats/pacing.activityWindows'))
  assert.ok(next.nodes[1].prompt.includes('sourcePath=storyProgress'))
})

test('schema108 does not rewrite custom or ambiguous contracts and never adds temperature to an existing reviewer', () => {
  const source = upgradeStructuredMediaEvidenceGaps(fixture())
  const next = upgradeMediaContextQuoteContract(source)
  assert.ok(next.nodes.every(node => !node.params.some(item => item.englishName === 'temperature')))
  for (const prompt of ['自定义审核，不采用共享契约。', source.nodes[2].prompt + '\n' + MEDIA_EVIDENCE_GAPS_PROMPT]) {
    const custom = { ...source, nodes: source.nodes.map(node => node.id === 'sanguo-requirement-review' ? { ...node, prompt } : node) }
    assert.equal(upgradeMediaContextQuoteContract(custom), custom)
  }
  const other = { ...source, id: 'another-workflow' };assert.equal(upgradeMediaContextQuoteContract(other), other)
})

test('schema109 shares authored field semantics without changing models, policies, execution code or custom surrounding text', () => {
  const current = upgradeMediaContextQuoteContract(upgradeStructuredMediaEvidenceGaps(fixture()))
  const oldShared = MEDIA_EVIDENCE_GAPS_PROMPT.replace(/关键性依原文与上下文：[^\n]*\n/, '')
  const source = { ...current, nodes: current.nodes.map(node => ['sanguo-media-review', 'sanguo-requirement-review'].includes(node.id)
    ? { ...node, modelId: 'existing-local-review-model', prompt: node.prompt.replace(MEDIA_EVIDENCE_GAPS_PROMPT, oldShared),
      params: [...node.params, param('timeoutMs', '600000', 'number'), param('reasoningEffort', 'high', 'text')] } : node) }
  const before = structuredClone(source), next = upgradeSharedMediaCriticalityContext(source)
  assert.equal(next.schemaVersion, 109);assert.equal(next.edges, source.edges);assert.deepEqual(source, before)
  assert.equal(upgradeSharedMediaCriticalityContext(next), next)
  for (const [index, node] of next.nodes.entries()) {
    const original = source.nodes[index]
    if (!['sanguo-media-review', 'sanguo-requirement-review'].includes(node.id)) { assert.equal(node, original);continue }
    assert.deepEqual({ ...node, prompt: '' }, { ...original, prompt: '' });assert.equal(node.params, original.params)
    assert.equal(node.prompt.split(MEDIA_EVIDENCE_GAPS_PROMPT).length, 2)
    assert.ok(!node.params.some(item => item.englishName === 'temperature'))
  }
  assert.ok(next.nodes[1].prompt.startsWith('保留用户前缀\n'));assert.ok(next.nodes[1].prompt.endsWith('\n保留用户后缀'))
  assert.ok(next.nodes[2].prompt.startsWith('单项前缀\n'));assert.ok(next.nodes[2].prompt.endsWith('\n单项后缀'))
  for (const prompt of ['自定义规则', source.nodes[2].prompt.replace('【观察事实与未证实细项结束】', ''),
    source.nodes[2].prompt + '\n' + oldShared]) {
    const custom = { ...source, nodes: source.nodes.map(node => node.id === 'sanguo-requirement-review' ? { ...node, prompt } : node) }
    assert.equal(upgradeSharedMediaCriticalityContext(custom), custom)
  }
  const other = { ...source, id: 'another-workflow' };assert.equal(upgradeSharedMediaCriticalityContext(other), other)
})

test('both reviewers distinguish authored completion, story, performance and timing context without deciding criticality in code', () => {
  for (const prompt of [REQUIREMENT_MEDIA_REVIEW_PROMPT, CANONICAL_MEDIA_REVIEW_PROMPT]) {
    assert.ok(prompt.includes(MEDIA_EVIDENCE_GAPS_PROMPT))
    for (const text of ['completionCriteria=剧情完成条件', 'storyProgress=阶段/结果/待续行动',
      'pacing.performanceBeats=明确表演节拍', 'pacing.activityWindows=活动时间预算',
      'kind/起止时间本身不建立独立回应、因果或节拍义务', '须读原条目和剧情语义',
      '合法引文不等于关键性依据', '原文明定的结果/回应/因果/节拍动作即使轻微仍关键',
      '完成条件或节拍未列出不等于可忽略时间线', '实质要求未重复仍须实证',
      '关键性不明保留unobservable/undetermined', '不得自动把综合报告的uncertain/false升级为accepted/true']) {
      assert.ok(prompt.includes(text), 'missing shared semantic boundary: ' + text)
    }
  }
  assert.equal(REQUIREMENT_MEDIA_REVIEW_PROMPT.split('关键性依原文与上下文').length, 2)
  assert.ok(CANONICAL_MEDIA_REVIEW_PROMPT.length <= 9000)
})
