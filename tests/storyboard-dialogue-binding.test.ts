import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { repairStoryboardDialogueBindings } from '../src/workflow-core.ts'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/storyboard-dialogue-binding-rounds.json', import.meta.url), 'utf8'))
const headers = (value: string) => value.match(/\d+(?:\.\d+)?-\d+(?:\.\d+)?秒/g)
const original = { audioType: '对白', audioText: '甲：把文书交给来使。', characters: ['甲', '乙'],
  pacing: { version: 'dynamic-v1', actionSeconds: 0, reactionSeconds: 0.5 },
  videoPrompt: '0-2秒：甲翻开案卷。2-5秒：甲开口回应，乙垂手聆听。5-6秒：甲合上案卷。',
}

for (const { round, candidate } of fixture.rounds) {
  test(`real writer round ${round} is left unchanged when long or partially bound speech needs author repair`, () => {
    const before = structuredClone(candidate)
    assert.equal(repairStoryboardDialogueBindings(candidate), undefined)
    assert.deepEqual(candidate, before)
  })
}

test('one empty explicit speaker slot receives the exact line once without changing time ranges or actions', () => {
  const before = structuredClone(original)
  const repaired = repairStoryboardDialogueBindings(original)!
  assert.ok(repaired)
  const prompt = String(repaired.videoPrompt)
  assert.equal(prompt.split('把文书交给来使').length - 1, 1)
  assert.match(prompt, /2-5秒：甲开口回应，乙垂手聆听。甲开口说出“把文书交给来使。”/)
  assert.deepEqual(headers(prompt), headers(original.videoPrompt))
  assert.equal(repaired.audioText, original.audioText)
  assert.match(prompt, /甲翻开案卷/)
  assert.match(prompt, /甲合上案卷/)
  assert.deepEqual(original, before)
})

test('unquoted partial dialogue across beats cannot be supplemented with the complete line again', () => {
  const candidate = { ...original, audioText: '甲：城门关闭之前，须将文书送达。',
    videoPrompt: '0-3秒：甲开口说出:城门关闭之前。3-6秒：甲继续说出:须将文书送达。6-7秒：甲合上案卷。',
  }
  const before = structuredClone(candidate)
  assert.equal(repairStoryboardDialogueBindings(candidate), undefined)
  assert.deepEqual(candidate, before)
})

test('quoted halves are not merged into a new time range', () => {
  const candidate = { ...original, audioText: '甲：城门关闭之前，须将文书送达。',
    videoPrompt: '0-3秒：甲开口说出“城门关闭之前”。3-6秒：甲继续说出“须将文书送达”。6-7秒：甲合上案卷。7-8秒：乙转身离开。',
  }
  assert.equal(repairStoryboardDialogueBindings(candidate), undefined)
})

test('multiple plausible speaking slots and a mere actor presence do not permit guessing', () => {
  const ambiguous = { ...original, videoPrompt: '0-3秒：甲抬眼问道。3-6秒：甲继续说道。6-7秒：甲合上案卷。' }
  assert.equal(repairStoryboardDialogueBindings(ambiguous), undefined)
  const absent = { ...original, videoPrompt: '0-3秒：甲翻开案卷。3-6秒：甲看向乙。6-7秒：甲合上案卷。' }
  assert.equal(repairStoryboardDialogueBindings(absent), undefined)
})

test('insufficient slots and occupied utterances are not expanded or overwritten', () => {
  const short = { ...original, videoPrompt: '0-1秒：甲开口回应。1-2秒：乙垂手聆听。2-3秒：甲合上案卷。' }
  assert.equal(repairStoryboardDialogueBindings(short), undefined)
  const occupied = { ...original, videoPrompt: '0-2秒：甲翻开案卷。2-5秒：甲开口说出“天气晴朗”。5-6秒：甲合上案卷。' }
  assert.equal(repairStoryboardDialogueBindings(occupied), undefined)
})

test('two lines cannot claim one empty slot and duplicate bound speech is not treated as repaired', () => {
  const multiple = { ...original, audioText: original.audioText + '\n甲：随后关门。' }
  const before = structuredClone(multiple)
  assert.equal(repairStoryboardDialogueBindings(multiple), undefined)
  assert.deepEqual(multiple, before)
  const duplicate = { ...original,
    videoPrompt: '0-2秒：甲开口说出“把文书交给来使”。2-5秒：甲继续说出“把文书交给来使”。5-6秒：甲合上案卷。',
  }
  assert.equal(repairStoryboardDialogueBindings(duplicate), undefined)
})
