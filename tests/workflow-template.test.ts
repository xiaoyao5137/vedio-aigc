import test from 'node:test'
import assert from 'node:assert/strict'
import { renderRetryFeedbackPrompt, renderWorkflowTemplate, resolveTemplateJsonValue, stringifyTemplateValue } from '../src/workflow-template.ts'

test('actual source citations and beat arrays preserve their full structured content', () => {
  const context = { historical_sources: { citations: [{ index: 1, content: '二家賓客，互相譏揣，遂各樹朋徒。' }] }, scene: { requiredBeats: [{ id: 'beat-01', mustShow: ['封侯诏书', '冀州官吏'] }] } }
  const prompt = renderWorkflowTemplate('史料：${historical_sources.citations}\n节拍：${scene.requiredBeats}', context)
  assert.match(prompt, /二家賓客/)
  assert.match(prompt, /封侯诏书/)
  assert.match(prompt, /冀州官吏/)
  assert.doesNotMatch(prompt, /\[object Object\]/)
})

test('history rerun inputs retain array types instead of becoming invalid comma text', () => {
  assert.deepEqual(JSON.parse(stringifyTemplateValue(['主题一', '主题二'])), ['主题一', '主题二'])
  assert.equal(renderWorkflowTemplate('${missing.path}|${value}', { value: '原样台词' }), '|原样台词')
})

test('retry feedback stays advice and never overrides the generation contract', () => {
  assert.equal(renderRetryFeedbackPrompt(''), '')
  assert.equal(renderRetryFeedbackPrompt(undefined), '')
  const suffix = renderRetryFeedbackPrompt({ issues: [{ itemId: 'scene-02', repair: '删除担忧台词，或在台词后补充（拟制）标注' }] })
  assert.match(suffix, /【本次重试反馈】/)
  assert.match(suffix, /删除担忧台词/)
  assert.match(suffix, /以契约为准/)
  assert.match(suffix, /adaptationBoundary/)
})

test('report-format retry renders only report correction instructions, preserving sources without unrelated creation rules', () => {
  const feedback = { kind: 'report-format', error: 'REVIEW_RESULT_INVALID: 该拒绝与实际阈值矛盾',
    previousReport: { decision: 'rejected', issues: ['低于阈值的识别差异'] }, coverage: [{ itemId: 'current-candidate' }] }
  const original = structuredClone(feedback), suffix = renderRetryFeedbackPrompt(feedback)
  assert.match(suffix, /【本次报告复核】/);assert.match(suffix, /低于阈值的识别差异/)
  assert.match(suffix, /current-candidate/);assert.match(suffix, /一次修正全部/)
  assert.match(suffix, /纠正已被否定的结论/);assert.match(suffix, /不改动候选/)
  assert.doesNotMatch(suffix, /adaptationBoundary|audioText|拟制|dramaturgyReview|生成契约|场景、节拍与台词/)
  assert.deepEqual(feedback, original)
})

test('json parameters keep the per-item reference until the loop supplies it', () => {
  // The literal template used to reach the vision model as an image address, so every 独立画面观察
  // frame of a finished clip failed with “审查只接受 /generated/ 下的本地 JPEG 帧”.
  assert.deepEqual(resolveTemplateJsonValue(JSON.parse('["${frame.url}"]'), { frame: { url: '/generated/a-frame-0.jpg' } }), ['/generated/a-frame-0.jpg'])
  // A whole-string placeholder resolves to the value itself, so structures stay structured.
  assert.deepEqual(resolveTemplateJsonValue(JSON.parse('["${scene.beats}"]'), { scene: { beats: [{ id: 'b1' }, { id: 'b2' }] } }), [[{ id: 'b1' }, { id: 'b2' }]])
  assert.equal(resolveTemplateJsonValue('${frame.setting}', { frame: { setting: '庭院' } }), '庭院')
})

test('unresolved, absent and plain json values are never silently rewritten', () => {
  assert.equal(resolveTemplateJsonValue('${missing.url}', {}), '${missing.url}')
  assert.equal(resolveTemplateJsonValue('普通文本', { frame: { url: '/x' } }), '普通文本')
  assert.deepEqual(resolveTemplateJsonValue(JSON.parse('{"count":2,"names":["甲"]}'), {}), { count: 2, names: ['甲'] })
  // Interpolation inside a longer sentence stays text, which is what a prompt parameter expects.
  assert.equal(resolveTemplateJsonValue('图中是${frame.person}', { frame: { person: '张俭' } }), '图中是张俭')
  assert.equal(renderWorkflowTemplate('${a.b}和${a.c}', { a: { b: 'x', c: 'y' } }), 'x和y')
  assert.equal(stringifyTemplateValue(null), '')
})
