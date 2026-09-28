import test from 'node:test'
import assert from 'node:assert/strict'
import { projectIndependentNarration, narrationTempo } from '../server/narration-projection.ts'

const params = { duration: 13, audioType: '旁白', audioText: '郭泰前来求见。', pacing: {
  timingPolicy: { speech: { narration: { referenceRate: 5.8, maximumRate: 6.5 } } },
  beats: [{ id: 'a', kind: 'action', textOrVocalization: '郭泰立于门外' }, { id: 'n', kind: 'speech', deliveryStyle: 'narration', actorIds: ['旁白'], textOrVocalization: '郭泰前来求见。' }],
  schedule: [{ beatId: 'n', startSecond: 0, endSecond: 12 }],
  timelineWindows: [{ beatQuotes: [{ beatId: 'a', quote: '郭泰立于门外' }, { beatId: 'n', quote: '画外旁白：郭泰前来求见。' }] }],
} }
test('provider projection retains actions and exact independent narration without changing source', () => {
  const before = JSON.stringify(params)
  const result = projectIndependentNarration('郭泰立于门外。同时，画外旁白：郭泰前来求见。\n人声类型：旁白\n【音轨文本】郭泰前来求见。', params)
  assert.equal(JSON.stringify(params), before)
  assert.match(result.prompt, /郭泰立于门外/)
  assert.doesNotMatch(result.prompt, /郭泰前来求见/)
  assert.equal(result.segments[0].text, params.audioText)
  assert.equal(result.segments[0].ttsRate, 5.8 / 4.5)
  assert.equal(result.segments[0].maximumRate, 6.5)
  assert.equal(result.params.sound, 'on')
  assert.deepEqual(result.params.characterVoices, [])
  assert.throws(() => projectIndependentNarration('', { ...params, audioText: '另一段台词' }), /不一致/)
})
test('narration audio text may mix bare lines with explicit narrator labels', () => {
  const mixed={...params,audioText:'郭泰前来求见。\n旁白：门内无人应答。',pacing:{...params.pacing,
    beats:[...params.pacing.beats,{id:'n2',kind:'speech',deliveryStyle:'narration',actorIds:['旁白'],textOrVocalization:'门内无人应答。'}],
    schedule:[{beatId:'n',startSecond:0,endSecond:6},{beatId:'n2',startSecond:6,endSecond:12}]}}
  const result=projectIndependentNarration('郭泰前来求见。门内无人应答。',mixed)
  assert.deepEqual(result.segments.map(segment=>segment.text),['郭泰前来求见。','门内无人应答。'])
  assert.throws(()=>projectIndependentNarration('',{...mixed,audioText:'郭泰前来求见。\n张角：门内无人应答。'}),/不一致/)
})
test('timing preserves complete speech and rejects excessive speed rather than truncating', () => {
  assert.equal(narrationTempo(10, 12, '一段旁白'), 1)
  assert.equal(narrationTempo(13, 12, '一段旁白'), 13 / 12)
  assert.throws(() => narrationTempo(18, 12, '一段旁白'), /NARRATION_DURATION_CONFLICT/)
})
