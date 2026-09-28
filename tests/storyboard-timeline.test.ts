import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseStoryboardTimeline, storyboardTimelineMatches } from '../src/storyboard-timeline.ts'
import { collectHistoricalStoryboardDiagnostics, repairStoryboardDialogueBindings, validateHistoricalStructuredOutput,
  validateStoryboardBeatCoverage, validateStoryboardSpeechActivityCoverage } from '../src/workflow-core.ts'
import { performanceStoryboardTiming } from '../src/history-pacing.ts'
import { plannedSpeechWindows } from '../src/storyboard-runtime.ts'
import { deriveMediaRequirements } from '../src/media-requirement-coverage.ts'
import { executeCodeNode } from '../server/code-node.ts'
import { VIDEO_REQUEST_CODE } from '../src/quality-node-presets.ts'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/storyboard-double-unit-timeline-rounds.json', import.meta.url), 'utf8'))
const base = { id: 'timeline', title: '交接', duration: 3, characters: ['周福'], initialCharacters: ['周福'],
  enteringCharacters: [], endCharacters: ['周福'], firstFrameMode: 'reference', camera: '中景', mood: '自然',
  continuity: { previousShotId: '', bridgeType: 'opening', bridgeAnchor: '' },
  visualPrompt: '周福立于案前。', lastFramePrompt: '周福放下印绶。', audioType: '对白', audioText: '周福：遵命。',
  pacing: { version: 'dynamic-v1', actionSeconds: .7, reactionSeconds: .5 },
  videoPrompt: '0-0.7秒：周福接稳印绶。0.7-1.7秒：周福开口说出“遵命”。1.7-3秒：周福放下印绶。',
  historicalBasis: '[史料1] 授官', adaptationBoundary: '动作对白拟制' }
const expected = { scene: { targetDuration: 3, continuityFromPrevious: false }, requireDynamicPacing: true }

for (const { attempt, candidate } of fixture) {
  test(`record-psw369 round ${attempt} recognizes original syntax and preserves its real half-second gap`, () => {
    const before = structuredClone(candidate)
    const beats = parseStoryboardTimeline(candidate.videoPrompt)
    assert.equal(beats.length, attempt < 4 ? 3 : 4)
    assert.equal(beats[0].startSecond, 0)
    assert.equal(beats[0].endSecond, 1)
    assert.equal(beats[1].startSecond, 1.5)
    const diagnostics = collectHistoricalStoryboardDiagnostics(candidate, { requireDynamicPacing: true })
    assert.ok(!diagnostics.some((issue: string) => issue.includes('当前识别到 0 段')))
    assert.ok(diagnostics.some((issue: string) => issue.includes('连续无重叠地覆盖到')))
    assert.deepEqual(candidate, before)
  })
}

const styles = [
  (a: string, b: string, sep: string) => `${a}${sep}${b}秒：`,
  (a: string, b: string, sep: string) => `${a} 秒 ${sep} ${b} 秒:`,
  (a: string, b: string, sep: string) => `（第 ${a}秒${sep}${b}秒）：`,
  (a: string, b: string, sep: string) => `[${a}${sep}${b}秒]:`,
  (a: string, b: string, sep: string) => `【${a}秒${sep}${b}秒】：`,
  (a: string, b: string, sep: string) => `(${a}${sep}${b})秒:`,
]
for (const separator of ['-', '–', '—', '~', '～', '至', '到']) {
  test(`all consumers share equivalent ${separator} ranges, units, brackets and colons`, async () => {
    for (const header of styles) {
      const videoPrompt = base.videoPrompt.replace(/(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)秒：/g,
        (_, start, end) => header(start, end, separator))
      const shot = { ...base, videoPrompt }
      const before = structuredClone(shot)
      assert.doesNotThrow(() => validateHistoricalStructuredOutput('history.storyboard', shot, expected))
      const beats = parseStoryboardTimeline(videoPrompt)
      assert.deepEqual(beats.map(beat => [beat.startSecond, beat.endSecond]), [[0, .7], [.7, 1.7], [1.7, 3]])
      for (const beat of beats) {
        assert.equal(videoPrompt.slice(beat.index, beat.bodyStart), beat.header)
        assert.equal(videoPrompt.slice(beat.bodyStart, beat.bodyEnd), beat.body)
      }
      const speech = [{ start: .7, end: 1.7, text: '遵命。' }]
      assert.deepEqual(plannedSpeechWindows(shot), speech)
      assert.deepEqual((await executeCodeNode({ code: VIDEO_REQUEST_CODE, context: { shot_script: shot } })).speechWindows, speech)
      assert.deepEqual(deriveMediaRequirements(shot).filter(item => item.scope === 'interval')
        .map(item => [item.startSecond, item.endSecond]), [[0, .7], [.7, 1.7], [1.7, 3]])
      assert.doesNotThrow(() => validateStoryboardSpeechActivityCoverage({ ...shot,
        pacing: { activityWindows: [{ kind: 'speech', startSecond: .7, endSecond: 1.7 }] } }))
      assert.throws(() => validateStoryboardSpeechActivityCoverage({ ...shot,
        pacing: { activityWindows: [{ kind: 'speech', startSecond: 0, endSecond: 1.7 }] } }), /未被逐字绑定/)
      const pacing = { actionSeconds: 3, reactionSeconds: 0,
        activityWindows: [{ kind: 'action', startSecond: 0, endSecond: 3 }], performanceBeats: [{ id: 'put',
          purpose: '完成交接', stateChange: '放下印绶', evidenceAnchor: '周福放下印绶', startSecond: 1.7, endSecond: 3, overlapWith: ['action'] }] }
      assert.equal(performanceStoryboardTiming(pacing, 0, shot)?.performanceSeconds, 1.3)
      assert.throws(() => performanceStoryboardTiming({ ...pacing, performanceBeats: [{ ...pacing.performanceBeats[0], startSecond: 0, endSecond: .7 }] }, 0, shot), /evidenceAnchor/)
      const cupShot = { ...shot, coveredBeatIds: ['cup'], videoPrompt: videoPrompt.replace('接稳印绶', '举起陶樽') }
      assert.doesNotThrow(() => validateStoryboardBeatCoverage(cupShot, { requiredBeats: [{ id: 'cup', description: '周福举杯', setting: '厅堂', mustShow: ['举杯'] }] }))
      assert.deepEqual(shot, before)
    }
  })
}

test('single points, malformed numbers, negative starts, gaps and overlaps are never converted to valid ranges', () => {
  for (const source of ['第0秒：甲入场。第1秒：甲转身。第3秒：甲停步。', '-1-0秒：动作', '0.0.0-1秒：动作']) {
    assert.equal(storyboardTimelineMatches(source).length, 0)
  }
  for (const start of ['0.6', '0.8']) {
    const shot = { ...base, videoPrompt: base.videoPrompt.replace('0.7-1.7秒', `${start}秒-1.7秒`) }
    assert.equal(parseStoryboardTimeline(shot.videoPrompt)[1].startSecond, Number(start))
    assert.throws(() => validateHistoricalStructuredOutput('history.storyboard', shot, expected), /连续无重叠/)
  }
  const reversed = parseStoryboardTimeline('2秒-1秒：动作')[0]
  assert.equal(reversed.startSecond, 2)
  assert.equal(reversed.endSecond, 1)
})

for (const count of [5, 6]) {
  test(`unambiguous dialogue repair supports ${count} valid beats and preserves original headers`, () => {
    const header = (start: number, end: number) => `【${start}秒-${end}秒】：`
    const videoPrompt = Array.from({ length: count }, (_, index) => header(index, index + 1)
      + (index === 1 ? '周福开口回应。' : `周福${index % 2 ? '合上' : '翻开'}案卷。`)).join('')
    const candidate = { audioType: '对白', audioText: '周福：遵命。', characters: ['周福'], videoPrompt }
    const repaired = repairStoryboardDialogueBindings(candidate)
    assert.ok(repaired)
    assert.equal(String(repaired.videoPrompt).split('遵命').length - 1, 1)
    assert.deepEqual(parseStoryboardTimeline(String(repaired.videoPrompt)).map(beat => beat.header),
      parseStoryboardTimeline(videoPrompt).map(beat => beat.header))
    assert.equal(candidate.videoPrompt, videoPrompt)
  })
}
