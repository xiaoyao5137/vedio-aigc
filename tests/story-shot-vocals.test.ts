import test from 'node:test'
import assert from 'node:assert/strict'
import { createStoryScriptSource, renderStoryShotTimedActions, StoryShotTimingError,
  validateStoryShotTimingOutput } from '../src/story-shot-timing.ts'
import { validateStoryVocalBeats } from '../src/story-shot-vocals.ts'
import { STORY_SHOT_VIDEO_PROMPT } from '../src/story-video-prompt.ts'

function shot() {
  return {
    title: '早餐回应', content: '0—2秒，芙伊放下加班账单望向卷毛；2—4秒，卷毛从沙发起身递来早餐。',
    camera: '固定中景', mood: '两位舍友在家互相回应', firstFramePrompt: '芙伊在桌前工作，卷毛在沙发上。', duration: 5,
    audioContractVersion: 'animal-interaction-v1',
    visualBeats: [
      { id: 'cat-look', action: '芙伊放下加班账单望向卷毛', completion: '芙伊看向卷毛', startSecond: 0, endSecond: 2 },
      { id: 'dog-breakfast', action: '卷毛从沙发起身递来早餐', completion: '卷毛把早餐递到芙伊面前', startSecond: 2, endSecond: 4 },
    ],
    vocalBeats: [
      { id: 'cat-call', speaker: '芙伊', utterance: '喵儿', startSecond: .8, endSecond: 1.3,
        visualBeatId: 'cat-look', responseTo: null },
      { id: 'dog-reply', speaker: '卷毛', utterance: '旺', startSecond: 2.5, endSecond: 3,
        visualBeatId: 'dog-breakfast', responseTo: 'cat-call' },
    ],
  }
}

test('a checked animal interaction binds voices to plot beats without vocal timestamps', () => {
  const planned = shot()
  for (const beat of planned.vocalBeats) {
    delete (beat as { startSecond?: number }).startSecond
    delete (beat as { endSecond?: number }).endSecond
  }
  assert.deepEqual(validateStoryVocalBeats(planned, { required: true }), [])
  assert.equal(validateStoryShotTimingOutput({ shots: [planned] }, { expectedCount: 1,
    requireAnimalInteraction: true }).shots[0], planned)
  const text = renderStoryShotTimedActions(planned)
  assert.match(text, /剧情段落 cat-look：芙伊（猫）.*“喵儿”/)
  assert.match(text, /剧情段落 dog-breakfast：卷毛（狗）.*“旺”.*回应对方/)
  assert.doesNotMatch(text, /0\.8–1\.3|2\.5–3 秒：卷毛/)
  assert.match(STORY_SHOT_VIDEO_PROMPT, /根据各段剧情安排对应角色的声音/)
  assert.doesNotMatch(STORY_SHOT_VIDEO_PROMPT, /每声按下列秒段|叫声要在指定秒段/)
})

test('silent plans, human reading, wrong speaker, detached sounds and nonresponses fail before paid media', () => {
  const missing = shot() as ReturnType<typeof shot> & { vocalBeats?: ReturnType<typeof shot>['vocalBeats'] }
  delete missing.vocalBeats
  assert.throws(() => validateStoryShotTimingOutput({ shots: [missing] }, { expectedCount: 1,
    requireAnimalInteraction: true }), (error: unknown) => error instanceof StoryShotTimingError
    && error.issues.some(issue => issue.includes('ANIMAL_INTERACTION_INVALID: vocalBeats')))
  const cases: Array<[string, (candidate: ReturnType<typeof shot>) => void]> = [
    ['utterance', candidate => { candidate.vocalBeats[1].utterance = '汪' }],
    ['speaker', candidate => { candidate.vocalBeats[1].speaker = '芙伊' }],
    ['visualBeatId', candidate => { candidate.vocalBeats[1].visualBeatId = 'cat-look' }],
    ['responseTo', candidate => { candidate.vocalBeats[1].responseTo = null }],
    ['time window', candidate => { candidate.vocalBeats[1].startSecond = 1.2 }],
    ['silent mood', candidate => { candidate.mood = '仅环境声与动作音效' }],
  ]
  for (const [label, mutate] of cases) {
    const candidate = shot(); mutate(candidate)
    assert.ok(validateStoryVocalBeats(candidate).length > 0, label)
    assert.throws(() => renderStoryShotTimedActions(candidate), /ANIMAL_INTERACTION_INVALID/, label)
  }
})

test('timing forks preserve the original caller, sound and response order while allowing new seconds', () => {
  const original = shot()
  const source = createStoryScriptSource({ shots: [original] }, { sourceExecutionId: 'record-source', sourceRunId: 'script' })
  assert.deepEqual(source.shots[0].originalVocalSequence, [
    { speaker: '芙伊', utterance: '喵儿', responseToIndex: null },
    { speaker: '卷毛', utterance: '旺', responseToIndex: 0 },
  ])
  const candidate = shot()
  candidate.vocalBeats[1].responseTo = null
  assert.throws(() => validateStoryShotTimingOutput({ shots: [candidate] }, { source,
    requireAnimalInteraction: true }), /ANIMAL_INTERACTION_INVALID/)
})
