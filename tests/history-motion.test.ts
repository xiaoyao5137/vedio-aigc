import test from 'node:test'
import assert from 'node:assert/strict'
import { crossingPositionIssue, expectedCrossingPositions, historicalCrossingIssue } from '../src/history-motion.ts'
const shot = { characters: ['周家宾客己', '房家宾客己'], endCharacters: ['周家宾客己', '房家宾客己'], visualPrompt: '周家宾客己站在画面左侧，蓝衣；房家宾客己站在画面右侧，褐衣。', videoPrompt: '两人相向侧身错身而过。', lastFramePrompt: '周家宾客己已行至画面中偏右，垂目；房家宾客己已行至画面中偏左，垂目。' }
test('explicit crossing requires observed screen positions to swap, even if the critic says passed', () => {
  const bad = '画面左侧为周家宾客己，蓝衣；画面右侧为房家宾客己，褐衣。'
  assert.equal(expectedCrossingPositions(shot).length, 2)
  assert.match(crossingPositionIssue(shot, bad)!, /VIDEO_QUALITY_REJECTED/)
  assert.match(historicalCrossingIssue(shot, { lastFrameUrl: 'tail.jpg', visualReview: { passed: true, endingState: bad, endingStateEvidence: { method: 'actual-tail-image', frame: 'tail.jpg' } } })!, /VIDEO_QUALITY_REJECTED/)
  assert.equal(crossingPositionIssue(shot, '画面右侧为周家宾客己，蓝衣；画面左侧为房家宾客己，褐衣。'), undefined)
  assert.equal(crossingPositionIssue(shot, '周家宾客己位于画面右侧；房家宾客己位于画面左侧。'), undefined)
})
test('body directions cannot substitute for visible locations and ordinary cuts are unaffected', () => {
  assert.match(crossingPositionIssue(shot, '周家宾客己右肩偏转；房家宾客己左肩偏转。')!, /VIDEO_REVIEW_INVALID/)
  assert.match(crossingPositionIssue(shot, '周家宾客己右手指向画面右侧；房家宾客己望向画面左侧。')!, /VIDEO_REVIEW_INVALID/)
  assert.match(historicalCrossingIssue(shot, { visualReview: { passed: true } })!, /实际尾帧来源/)
  assert.equal(crossingPositionIssue({ ...shot, videoPrompt: '双方相对说话。' }, ''), undefined)
})
