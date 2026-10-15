import test from 'node:test'
import assert from 'node:assert/strict'
import { createStoryScriptSource, readStoryScriptSource, renderStoryShotTimedActions, storyScriptSourcePrompt,
  StoryShotTimingError, validateStoryShotTimingOutput } from '../src/story-shot-timing.ts'

function shot() {
  return {
    title: '早餐到爪', content: '蓝猫把硬币推过柜台；柴犬把纸袋推向蓝猫。', duration: 5,
    camera: '固定机位', mood: '清晨轻松', firstFramePrompt: '猫和狗在早餐柜台两侧。',
    visualBeats: [
      { id: 'coin', action: '蓝猫把硬币推过柜台', completion: '硬币停在柴犬面前', startSecond: 0, endSecond: 2 },
      { id: 'bag', action: '柴犬把纸袋推向蓝猫', completion: '纸袋停在蓝猫前爪旁', startSecond: 2, endSecond: 4 },
    ],
  }
}

test('accepts a complete ordered plan and keeps the normalized output unchanged', () => {
  const first = shot(), second = { ...shot(), title: '办公室', visualBeats: shot().visualBeats.map(beat => ({ ...beat })) }
  const output = { shots: [first, second], items: [first, second], text: 'source', raw: { provider: 'test' } }
  const before = structuredClone(output)
  assert.equal(validateStoryShotTimingOutput(output, { expectedCount: 2 }), output)
  assert.deepEqual(output, before)
  assert.match(renderStoryShotTimedActions(first), /4–5 秒：保持已完成状态/)
  assert.match(renderStoryShotTimedActions(first), /纸袋停在蓝猫前爪旁/)
})

test('old two-action three-second script cannot enter the paid image and video loop', () => {
  const old = { ...shot(), duration: 3, content: '0—1秒推硬币；1—3秒推纸袋。' }
  delete (old as Record<string, unknown>).visualBeats
  assert.throws(() => validateStoryShotTimingOutput({ shots: [old] }), (error: unknown) =>
    error instanceof StoryShotTimingError && error.issues.some(issue => issue.includes('visualBeats')))
  const cramped = shot(); cramped.duration = 3
  cramped.visualBeats[0].endSecond = 1
  cramped.visualBeats[1].startSecond = 1
  cramped.visualBeats[1].endSecond = 3
  assert.throws(() => validateStoryShotTimingOutput({ shots: [cramped] }), (error: unknown) =>
    error instanceof StoryShotTimingError && error.issues.some(issue => issue.includes('最小预算'))
      && error.issues.some(issue => issue.includes('可读收尾')))
})

test('first planning output requires one ordered beat for each complete content action', () => {
  const complete = shot()
  assert.doesNotThrow(() => validateStoryShotTimingOutput({ shots: [complete] }, { expectedCount: 1 }))

  const merged = { ...shot(), visualBeats: [shot().visualBeats[0]] }
  assert.throws(() => validateStoryShotTimingOutput({ shots: [merged] }, { expectedCount: 1 }),
    /visualBeats 必须与 content 中逐项动作一一对应/)

  const reversed = shot()
  reversed.visualBeats.reverse()
  assert.throws(() => validateStoryShotTimingOutput({ shots: [reversed] }, { expectedCount: 1 }),
    /必须按顺序复制 content 对应动作原句/)

  const rewritten = shot()
  rewritten.visualBeats[1].action = '柴犬只看着纸袋'
  assert.throws(() => validateStoryShotTimingOutput({ shots: [rewritten] }, { expectedCount: 1 }),
    /不得合并、改写或遗漏/)
})

test('a timed saved shot cannot reach paid video with a collapsed beat list', () => {
  const legacy = { ...shot(), content: '0—2秒，蓝猫把硬币推过柜台；2—4秒，柴犬把纸袋推向蓝猫。',
    visualBeats: [shot().visualBeats[0]] }
  assert.throws(() => renderStoryShotTimedActions(legacy), /逐项动作一一对应/)

  const untimedLegacy = { ...shot(), visualBeats: [shot().visualBeats[0]] }
  assert.throws(() => renderStoryShotTimedActions(untimedLegacy), /逐项动作一一对应/)
})

test('content time ranges and points bind to each corresponding visual beat', () => {
  for (const content of [
    '0—2秒，蓝猫把硬币推过柜台；2—4秒，柴犬把纸袋推向蓝猫。',
    '第0秒—2秒内：蓝猫把硬币推过柜台；第2至4秒：柴犬把纸袋推向蓝猫。',
    '0-2 秒：蓝猫把硬币推过柜台;2~4 秒：柴犬把纸袋推向蓝猫。',
    '0秒时，蓝猫把硬币推过柜台；2秒后，柴犬把纸袋推向蓝猫。',
  ]) {
    const timed = { ...shot(), content }
    assert.doesNotThrow(() => validateStoryShotTimingOutput({ shots: [timed] }, { expectedCount: 1 }), content)
    assert.doesNotThrow(() => renderStoryShotTimedActions(timed), content)
  }

  const wrongEnd = { ...shot(), content: '0—3秒，蓝猫把硬币推过柜台；2—4秒，柴犬把纸袋推向蓝猫。' }
  assert.throws(() => validateStoryShotTimingOutput({ shots: [wrongEnd] }, { expectedCount: 1 }),
    /content 秒点与 visualBeats\.startSecond\/endSecond 不一致/)
  assert.throws(() => renderStoryShotTimedActions(wrongEnd), /content 秒点与 visualBeats\.startSecond\/endSecond 不一致/)

  const wrongStart = { ...shot(), content: '0—2秒，蓝猫把硬币推过柜台；3—4秒，柴犬把纸袋推向蓝猫。' }
  assert.throws(() => validateStoryShotTimingOutput({ shots: [wrongStart] }, { expectedCount: 1 }),
    /content 秒点与 visualBeats\.startSecond\/endSecond 不一致/)

  const partlyTimed = { ...shot(), content: '0—2秒，蓝猫把硬币推过柜台；柴犬把纸袋推向蓝猫。' }
  assert.throws(() => validateStoryShotTimingOutput({ shots: [partlyTimed] }, { expectedCount: 1 }),
    /须给每项动作标出起始秒点/)
})

test('rejects bad count, range, missing completion, duplicate IDs and non-contiguous timing', () => {
  const wrongCount = { shots: [shot()] }
  assert.throws(() => validateStoryShotTimingOutput(wrongCount, { expectedCount: 2 }), /分镜数量 1 与要求的 2 不符/)
  const bad = shot()
  bad.duration = 16
  bad.visualBeats[1].id = 'coin'
  bad.visualBeats[1].completion = ''
  bad.visualBeats[1].startSecond = 2.5
  assert.throws(() => validateStoryShotTimingOutput({ shots: [bad] }), (error: unknown) => {
    if (!(error instanceof StoryShotTimingError)) return false
    assert.ok(error.issues.some(issue => issue.includes('3–15 秒整数')))
    assert.ok(error.issues.some(issue => issue.includes('重复')))
    assert.ok(error.issues.some(issue => issue.includes('completion')))
    assert.ok(error.issues.some(issue => issue.includes('不可重叠或留空档')))
    return true
  })
})

test('permits a single readable action in three seconds but requires the final second free', () => {
  const one = shot(); one.duration = 3; one.visualBeats = [one.visualBeats[0]]
  one.content = '蓝猫把硬币推过柜台。'
  assert.doesNotThrow(() => validateStoryShotTimingOutput([one]))
  one.visualBeats[0].endSecond = 2.5
  assert.throws(() => renderStoryShotTimedActions(one), /可读收尾/)
})

test('a retry fork preserves every source action and title while allowing timing and spatial clarification', () => {
  const original = [
    { title: '交换', content: '0—1秒，甲把信递给乙；1—3秒，乙把钥匙交给甲。',
      firstFramePrompt: '甲乙在同一张桌子的两侧，信在甲手中，钥匙在乙手中。' },
    { title: '回应', content: '0—2秒，乙走到窗前；2—3秒，甲抬头看向乙。',
      firstFramePrompt: '乙在窗边，甲坐在桌旁。' },
  ]
  const sourceOutput = { shots: original, raw: { source: 'completed record' } }
  const before = structuredClone(sourceOutput)
  const source = createStoryScriptSource(sourceOutput, { sourceExecutionId: 'record-source', sourceRunId: 'node-script-source' })
  assert.deepEqual(sourceOutput, before, 'creating a fork source must leave the original record untouched')
  assert.equal(readStoryScriptSource(structuredClone(source)).sourceExecutionId, 'record-source')
  assert.match(storyScriptSourcePrompt(source), /每项剧情动作原句必须保留/)
  const candidate = { shots: [
    { ...original[0], content: '0—3秒，甲把信递给乙；3—6秒，乙把钥匙交给甲。', duration: 7,
      firstFramePrompt: original[0].firstFramePrompt + '两人的手和信、钥匙完整可见。', camera: '固定机位', mood: '平静',
      visualBeats: [
        { id: 'letter', action: '甲把信递给乙', completion: '信在乙手中', startSecond: 0, endSecond: 3 },
        { id: 'key', action: '乙把钥匙交给甲', completion: '钥匙在甲手中', startSecond: 3, endSecond: 6 },
      ] },
    { ...original[1], content: '0—3秒，乙走到窗前；3—6秒，甲抬头看向乙。', duration: 7,
      camera: '固定机位', mood: '安静', visualBeats: [
        { id: 'walk', action: '乙走到窗前', completion: '乙站在窗前', startSecond: 0, endSecond: 3 },
        { id: 'look', action: '甲抬头看向乙', completion: '甲目光落在乙身上', startSecond: 3, endSecond: 6 },
      ] },
  ] }
  assert.equal(validateStoryShotTimingOutput(candidate, { expectedCount: 2, source }), candidate)
  const changedTitle = structuredClone(candidate); changedTitle.shots[0].title = '另一个故事'
  assert.throws(() => validateStoryShotTimingOutput(changedTitle, { source }), /改写了原剧本标题/)
  const changedProp = structuredClone(candidate); changedProp.shots[0].visualBeats[0].action = '甲把银行卡递给乙'
  assert.throws(() => validateStoryShotTimingOutput(changedProp, { source }), /原剧本动作原句/)
  const missingAction = structuredClone(candidate); missingAction.shots[0].visualBeats.pop()
  assert.throws(() => validateStoryShotTimingOutput(missingAction, { source }), /逐项动作一一对应/)
  const changedSetup = structuredClone(candidate); changedSetup.shots[1].firstFramePrompt = '两人坐在卧室里，枕头在桌上。'
  assert.throws(() => validateStoryShotTimingOutput(changedSetup, { source }), /原剧本首帧原文/)
})
