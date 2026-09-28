import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { collectHistoricalStoryboardDiagnostics, reconcileStoryboardPacingBudget, repairStoryboardDialogueBindings,
  repairStoryboardNarrationEntrances, validateHistoricalStructuredOutput, validateStoryboardBeatCoverage,
  validateStoryboardSpeechActivityCoverage } from '../src/workflow-core.ts'

// Only the timing-domain projection of two real writer responses is retained.
// No runtime dependency on local logs, DB or model services; Unicode ranges are original bytes.
const actualTimingCandidates = [
  {
    "round": 1,
    "modelExecutionId": "model-run-mtrzjs0a-lhtcnlp",
    "rawResponseTextSha256": "7cd98dda2a30ebfa586f1e782f981b930314579bb8c3fa1fb33107ce7f342f92",
    "candidate": {
      "duration": 8,
      "audioType": "对白",
      "audioText": "周福门客:当今天子为蠡吾侯时,曾受学于吾师周公。如今即位,擢吾师为尚书,实乃师恩之报。",
      "pacing": {
        "version": "dynamic-v1",
        "actionSeconds": 0,
        "reactionSeconds": 0,
        "activityWindows": [
          {
            "kind": "speech",
            "startSecond": 0.5,
            "endSecond": 7.4
          }
        ]
      },
      "videoPrompt": "0.0–0.5秒:周福门客站立在宅院门前,身着青灰色交领深衣外罩青灰色长袍,面容清癯,目光平视前方,右手自然垂于身侧,左手轻抚腰带,保持端正站姿。0.5–7.4秒:周福门客开口说出:当今天子为蠡吾侯时,曾受学于吾师周公。如今即位,擢吾师为尚书,实乃师恩之报。说话过程中面部表情庄重,目光始终望向前方,身体保持稳定站姿,左手始终轻抚腰带,右手在说到'擢吾师为尚书'时微微抬起做出强调手势后放下。7.4–8.0秒:周福门客说完话后保持站立姿态,表情平静,右手自然垂于身侧,左手轻抚腰带,目光望向前方。"
    }
  },
  {
    "round": 2,
    "modelExecutionId": "model-run-mtrzkl6x-6wx7c8j",
    "rawResponseTextSha256": "c4d9e764633fd5b2b12cb7b191e7b675e8cd1524cb64d68da714d8298c1b7fe4",
    "candidate": {
      "duration": 12,
      "audioType": "对白",
      "audioText": "周福门客:当今天子为蠡吾侯时,曾受学于吾师周公。\n周福门客:如今即位,擢吾师为尚书,实乃师恩之报。\n周福门客:同郡河南尹房伯武,亦有名当朝。",
      "pacing": {
        "version": "dynamic-v1",
        "actionSeconds": 1,
        "reactionSeconds": 0.5,
        "activityWindows": [
          {
            "kind": "action",
            "startSecond": 0,
            "endSecond": 1
          },
          {
            "kind": "speech",
            "startSecond": 1,
            "endSecond": 5.8
          },
          {
            "kind": "reaction",
            "startSecond": 5.8,
            "endSecond": 6.3
          },
          {
            "kind": "speech",
            "startSecond": 6.3,
            "endSecond": 10.8
          },
          {
            "kind": "reaction",
            "startSecond": 10.8,
            "endSecond": 11.3
          }
        ]
      },
      "videoPrompt": "0.0–1.0秒:周福门客站立在宅院门前,身着青灰色交领深衣外罩青灰色长袍,面容清癯,目光平视前方,双手自然垂于身侧,保持端正站姿。1.0–5.8秒:周福门客开口说出完整台词:当今天子为蠡吾侯时,曾受学于吾师周公。如今即位,擢吾师为尚书,实乃师恩之报。说话过程中面部表情庄重,目光始终望向前方,身体保持稳定站姿,双手自然垂于身侧。5.8–6.3秒:周福门客说完第一段话后保持站立姿态,表情平静,双手自然垂于身侧。6.3–10.8秒:周福门客微微点头后继续开口说出完整台词:同郡河南尹房伯武,亦有名当朝。说话过程中保持点头后的姿态,面部表情平和,目光望向前方,双手自然垂于身侧。10.8–11.3秒:周福门客说完话后保持站立姿态,表情平静,双手自然垂于身侧,目光望向前方。"
    }
  }
]

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const base = { id: 'test-shot', title: '门前回应', duration: 3, characters: ['周福门客'],
  initialCharacters: ['周福门客'], enteringCharacters: [], endCharacters: ['周福门客'],
  visualPrompt: '东汉宅院门前，周福门客面向来客。', camera: '固定中景', mood: '平静',
  firstFrameMode: 'reference', lastFramePrompt: '周福门客放下手臂。',
  continuity: { previousShotId: '', bridgeType: 'opening', bridgeAnchor: '' },
  audioType: '对白', audioText: '周福门客：遵命。',
  pacing: { version: 'dynamic-v1', actionSeconds: 0.7, reactionSeconds: 0.5 },
  videoPrompt: '0–0.7秒：周福门客抬手回应。0.7–1.7秒：周福门客开口说出“遵命”。1.7–3秒：周福门客收回手臂。',
  historicalBasis: '[史料1] 门客陈述', adaptationBoundary: '动作对白拟制',
}
const expected = { scene: { targetDuration: 3, continuityFromPrevious: false }, requireDynamicPacing: true }

for (const { round, candidate } of actualTimingCandidates) {
  test(`real writer round ${round} retains native en-dash bytes while independent timing failures remain blocked`, () => {
    const shot = { ...base, ...candidate }
    const before = hash(shot)
    const bytes = Buffer.from(shot.videoPrompt, 'utf8')
    assert.ok(shot.videoPrompt.includes('–'))
    const diagnostics = collectHistoricalStoryboardDiagnostics(shot, expected)
    assert.ok(diagnostics.some(error => error.includes('speech activityWindows 应覆盖')))
    assert.ok(!diagnostics.some(error => error.includes('当前识别到 0 段')))
    if (round === 1) assert.ok(diagnostics.some(error => error.includes('超过单条口型锚点 6 秒')))
    if (round === 2) assert.ok(diagnostics.some(error => error.includes('连续无重叠地覆盖到 duration=12 秒')))
    assert.throws(() => validateHistoricalStructuredOutput('history.storyboard', shot, expected), /STORYBOARD_PACING_INVALID/)
    assert.equal(hash(shot), before)
    assert.deepEqual(Buffer.from(shot.videoPrompt, 'utf8'), bytes)
  })
}

test('a complete en-dash timeline is recognized without rewriting the caller and gaps still fail', () => {
  const before = hash(base)
  const validated = validateHistoricalStructuredOutput('history.storyboard', base, expected) as Record<string, unknown>
  assert.ok(String(validated.videoPrompt).includes(base.videoPrompt))
  assert.equal(hash(base), before)
  for (const changed of ['0.8–1.7秒', '0.6–1.7秒']) {
    const invalid = { ...base, videoPrompt: base.videoPrompt.replace('0.7–1.7秒', changed) }
    assert.throws(() => validateHistoricalStructuredOutput('history.storyboard', invalid, expected), /连续无重叠/)
  }
})

test('en-dash speech coverage cannot silently skip a falsely charged opening interval', () => {
  const candidate = { audioType: '对白', audioText: '甲：天气晴朗。\n甲：请到门前。',
    videoPrompt: '0–0.5秒：甲看向门口。0.5–2秒：甲开口说出：天气晴朗。2–3.5秒：甲开口说出：请到门前。3.5–4秒：甲转身。',
    pacing: { activityWindows: [{ kind: 'speech', startSecond: 0, endSecond: 3.5 }] },
  }
  const before = hash(candidate)
  assert.throws(() => validateStoryboardSpeechActivityCoverage(candidate), /未被逐字绑定台词的时间段完整覆盖/)
  assert.doesNotThrow(() => validateStoryboardSpeechActivityCoverage({ ...candidate,
    pacing: { activityWindows: [{ kind: 'speech', startSecond: 0.5, endSecond: 3.5 }] } }))
  assert.equal(hash(candidate), before)
})

test('conservative dialogue binding recognizes an en-dash slot and preserves original ranges and actions', () => {
  const candidate = { audioType: '对白', audioText: '甲：把文书交给来使。', characters: ['甲', '乙'],
    pacing: { version: 'dynamic-v1', actionSeconds: 0, reactionSeconds: 0.5 },
    videoPrompt: '0–2秒：甲翻开案卷。2–5秒：甲开口回应，乙垂手聆听。5–6秒：甲合上案卷。',
  }
  const before = hash(candidate)
  const repaired = repairStoryboardDialogueBindings(candidate)!
  assert.ok(repaired)
  assert.equal(String(repaired.videoPrompt).split('把文书交给来使').length - 1, 1)
  assert.match(String(repaired.videoPrompt), /2–5秒：甲开口回应，乙垂手聆听。甲开口说出/)
  assert.deepEqual(String(repaired.videoPrompt).match(/\d+–\d+秒/g), candidate.videoPrompt.match(/\d+–\d+秒/g))
  assert.equal(repaired.audioText, candidate.audioText)
  assert.equal(hash(candidate), before)
})

test('en-dash clock reconciliation matches ASCII behavior and never changes the input', () => {
  const candidate = { ...base, duration: 3, audioText: '周福门客：当今天子为蠡吾侯时,曾受学于吾师周公。',
    videoPrompt: '0–0.5秒：周福门客抬手。0.5–2.5秒：周福门客开口说出：当今天子为蠡吾侯时,曾受学于吾师周公。2.5–3秒：周福门客收手。',
  }
  const before = hash(candidate)
  const repaired = reconcileStoryboardPacingBudget(candidate)
  assert.ok(repaired)
  assert.match(String(repaired.videoPrompt), /0–1秒/)
  assert.deepEqual({ ...repaired, videoPrompt: String(repaired.videoPrompt).replaceAll('–', '-') },
    reconcileStoryboardPacingBudget({ ...candidate, videoPrompt: candidate.videoPrompt.replaceAll('–', '-') }))
  assert.equal(repaired.audioText, candidate.audioText)
  assert.equal(hash(candidate), before)
})

test('narration entrance repair consumes en-dash ranges with the same bounded result as ASCII', () => {
  const candidate = { audioType: '旁白', audioText: '来使进入厅堂。', duration: 8,
    enteringCharacters: [{ name: '来使', startSecond: 0.5, endSecond: 2.5, path: '画面右侧门口' }],
    videoPrompt: '0.5–2.5秒：来使从画面右侧门口连续走入。2.5–4秒：主人接过文书。4–6.5秒：主人展开文书。6.5–8秒：二人静止。',
  }
  const before = hash(candidate)
  const repaired = repairStoryboardNarrationEntrances(candidate)
  assert.ok(repaired)
  assert.deepEqual(repaired, repairStoryboardNarrationEntrances({ ...candidate, videoPrompt: candidate.videoPrompt.replaceAll('–', '-') }))
  assert.equal(hash(candidate), before)
})

test('visible entrance matching understands en-dash ranges and still rejects speaking before entry finishes', () => {
  const candidate = { ...base, duration: 15, pacing: undefined, characters: ['甲', '来使'], initialCharacters: ['甲'], endCharacters: ['甲', '来使'],
    enteringCharacters: [{ name: '来使', startSecond: 0, endSecond: 4, path: '画面右侧门口' }],
    visualPrompt: '东汉厅堂内，甲立于案旁。', lastFramePrompt: '甲与来使同立于案旁。',
    audioText: '来使：请看文书。',
    videoPrompt: '0–4秒：来使从画面右侧门口连续步入，先出现身体轮廓再完整入画，并开口说出“请看文书”。4–9秒：甲接过文书。9–13.5秒：甲展开文书。13.5–15秒：二人静止。',
  }
  const before = hash(candidate)
  assert.throws(() => validateHistoricalStructuredOutput('history.storyboard', candidate,
    { scene: { targetDuration: 15, continuityFromPrevious: false } }), /完成入场前就开始说话/)
  assert.equal(hash(candidate), before)
})

test('an en-dash cup action satisfies only an enacted movement and keeps negation blocked', () => {
  const scene = { requiredBeats: [{ id: 'beat-cup', description: '门客举杯', setting: '厅堂', mustShow: ['举杯'] }] }
  const candidate = { characters: ['门客'], coveredBeatIds: ['beat-cup'],
    videoPrompt: '0–2秒：门客举起陶樽。2–4秒：门客向来使致意。4–5秒：门客放下陶樽。',
  }
  const before = hash(candidate)
  assert.doesNotThrow(() => validateStoryboardBeatCoverage(candidate, scene))
  for (const action of ['门客没有举起陶樽', '门客提到举起陶樽', '门客说出“举起陶樽”']) {
    assert.throws(() => validateStoryboardBeatCoverage({ ...candidate,
      videoPrompt: candidate.videoPrompt.replace('门客举起陶樽', action) }, scene), /STORYBOARD_COVERAGE_INCOMPLETE/)
  }
  assert.equal(hash(candidate), before)
})
