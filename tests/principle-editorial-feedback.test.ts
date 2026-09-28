import test from 'node:test'
import assert from 'node:assert/strict'
import { collectPrincipleEditorialFeedback } from '../src/principle-editorial-feedback.ts'

const candidate = () => ({
  scenes: [{ id: 'scene-04', purpose: '温情', requiredBeats: [{ id: 'beat-04', observable: {
    visual: ['刘备回身按住张飞肩膀，张飞看向撤离的士卒。'], audio: ['刘备：挡住就走，别恋战。', '张飞：知道。'],
  } }] }],
  qualityReview: { warnings: [] as unknown[] },
})

test('editorial feedback exposes actual candidate sound-picture locator and repair node', () => {
  const output = candidate()
  output.qualityReview.warnings.push({ itemId: 'scene-04', problem: '回应过短，关照的重量尚未落到行动上', repair: '在已分配场次内补可见的接招动作',
    evidence: { path: 'scenes.0.requiredBeats.0.observable.audio.1', quote: '张飞：知道。' } })
  assert.deepEqual(collectPrincipleEditorialFeedback(output), [{ status: 'located', itemId: 'scene-04',
    path: 'scenes.0.requiredBeats.0.observable.audio.1', quote: '张飞：知道。',
    problem: '回应过短，关照的重量尚未落到行动上', suggestion: '在已分配场次内补可见的接招动作', repairNode: 'sanguo-scene-outline' }])
})

test('stale, cross-scene, metadata, or unquoted claims remain visibly unverified', () => {
  const output = candidate()
  output.qualityReview.warnings.push(
    { itemId: 'scene-old', problem: '旧报告', evidence: { path: 'scenes.0.requiredBeats.0.observable.audio.1', quote: '张飞：知道。' } },
    { itemId: 'scene-04', problem: '编造原文', evidence: { path: 'scenes.0.requiredBeats.0.observable.audio.1', quote: '张飞：我不走。' } },
    { itemId: 'scene-04', problem: '只引用幕后标签', evidence: { path: 'scenes.0.purpose', quote: '温情' } },
    { itemId: 'scene-04', problem: '原型属性', evidence: { path: '__proto__.toString', quote: 'toString' } },
  )
  assert.deepEqual(collectPrincipleEditorialFeedback(output).map(item => item.status), Array(4).fill('unverified'))
})

test('single storyboard targets storyboard repair; no style quota is inferred from an empty report', () => {
  const shot = { id: 'shot-04', videoPrompt: '刘备策马离开，张飞留在桥头。', qualityReview: { warnings: [{
    itemId: 'shot-04', problem: '关系应答没有落到画面', suggestion: '只改本镜反应镜',
    path: 'videoPrompt', quote: '张飞留在桥头',
  }] } }
  assert.deepEqual(collectPrincipleEditorialFeedback(shot).map(({ status, repairNode }) => ({ status, repairNode })),
    [{ status: 'located', repairNode: 'sanguo-shot-script' }])
  assert.deepEqual(collectPrincipleEditorialFeedback({ ...shot, qualityReview: { warnings: [] } }), [])
  assert.deepEqual(collectPrincipleEditorialFeedback({ id: 'video', qualityReview: { warnings: ['采样不足'] } }), [])
})
