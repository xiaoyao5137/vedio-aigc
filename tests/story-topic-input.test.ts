import test from 'node:test'
import assert from 'node:assert/strict'
import { generatedStoryTopicIssues, normalizeStoryTopics, validateStoryTopicInput } from '../src/story-topic-input.ts'

test('empty or omitted topic requests a model-generated topic for every video', () => {
  for (const empty of [undefined, null, '', []]) {
    assert.deepEqual(normalizeStoryTopics(empty), [])
    assert.equal(validateStoryTopicInput(empty, 6), '')
  }
  assert.deepEqual(generatedStoryTopicIssues([], { shots: [
    { topic: '迟到的电梯' }, { topic: '最后一份午餐' }, { topic: '雨天的共享伞' },
  ] }), [])
  assert.match(generatedStoryTopicIssues([], { shots: [{ topic: '重复' }, { topic: '重复' }] }).join(' '), /重复主题/)
  assert.match(generatedStoryTopicIssues([], { shots: [{ title: '无主题' }] }).join(' '), /缺少生成的主题/)
})

test('explicit topics retain one-to-one ordering and reject malformed input', () => {
  assert.equal(validateStoryTopicInput(['会议', '午休'], 2), '')
  assert.match(validateStoryTopicInput(['会议'], 2), /不一致/)
  assert.match(validateStoryTopicInput(['会议', 3], 2), /非空字符串/)
  assert.match(validateStoryTopicInput([], 1.5), /整数/)
  assert.deepEqual(generatedStoryTopicIssues(['会议', '午休'], { shots: [{ topic: '会议' }, { topic: '午休' }] }), [])
  assert.match(generatedStoryTopicIssues(['会议', '午休'], { shots: [{ topic: '午休' }, { topic: '会议' }] }).join(' '), /顺序不一致/)
})
