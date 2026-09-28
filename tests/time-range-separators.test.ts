import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { performanceStoryboardTiming } from '../src/history-pacing.ts'
import { plannedSpeechWindows } from '../src/storyboard-runtime.ts'
import { executeCodeNode } from '../server/code-node.ts'
import { VIDEO_REQUEST_CODE, upgradeVideoRequestTimeSeparators } from '../src/quality-node-presets.ts'
import { SANGUO_CINEMATIC_STORYBOARD_PROMPT, SANGUO_STORYBOARD_PROMPT_BEFORE_AUDIO_LINE_BINDING, SANGUO_STORYBOARD_PROMPT_BEFORE_TRUSTED_TAIL_STATE,
  STORYBOARD_AUDIO_COVERAGE_BEFORE_LINE_BINDING, STORYBOARD_AUDIO_COVERAGE_LINE_BINDING,
  STORYBOARD_DIALOGUE_BEFORE_LINE_BINDING, STORYBOARD_DIALOGUE_LINE_BINDING } from '../src/storyboard-prompt.ts'

// Exact saved request from workflow-before-schema111.json: schema111 does not alter this node.
const savedRequest = JSON.parse(readFileSync(new URL('./fixtures/managed-video-request-before-time-separators.json', import.meta.url), 'utf8'))
const fixture = () => ({ id: 'wf-sanguo-history-drama', schemaVersion: 111, nodes: [
  { ...structuredClone(savedRequest), modelId: 'retained-local-model', code: '// user-before\n' + savedRequest.code + '\n// user-after' },
  { ...structuredClone(savedRequest), id: 'sanguo-shot-script', kind: 'text', code: undefined, modelId: 'retained-writer-model',
    prompt: '导演前缀\n' + SANGUO_STORYBOARD_PROMPT_BEFORE_AUDIO_LINE_BINDING + '\n导演后缀' },
  { ...structuredClone(savedRequest), id: 'sanguo-video', kind: 'video', code: undefined, modelId: 'retained-video-model', prompt: '原付费视频配置' },
], edges: [{ id: 'preserve-edge', from: 'sanguo-video', to: 'sanguo-media-request' }] })

for (const separator of ['-', '–', '—', '~', '～', '至', '到']) {
  test(`timeline consumers accept ${separator} without changing dialogue or action windows`, async () => {
    const shot = { duration: 4, audioType: '对白', audioText: '甲：把印绶放下。\n甲：现在退后。',
      videoPrompt: `0${separator}0.5秒：甲持印绶。0.5${separator}2秒：甲开口说出：把印绶放下。2${separator}3秒：甲放下印绶并开口说出：现在退后。3${separator}4秒：甲站定。` }
    const before = structuredClone(shot)
    const expected = [{ start: .5, end: 2, text: '把印绶放下。' }, { start: 2, end: 3, text: '现在退后。' }]
    assert.deepEqual(plannedSpeechWindows(shot), expected)
    assert.deepEqual((await executeCodeNode({ code: VIDEO_REQUEST_CODE, context: { shot_script: shot } })).speechWindows, expected)
    const pacing = { actionSeconds: 3, reactionSeconds: 0, activityWindows: [{ kind: 'action', startSecond: 0, endSecond: 3 }],
      performanceBeats: [{ id: 'place', purpose: '归还印绶', stateChange: '放下印绶', evidenceAnchor: '甲放下印绶', startSecond: 2, endSecond: 3, overlapWith: ['action'] }] }
    const timing = performanceStoryboardTiming(pacing, 0, shot)
    assert.equal(timing?.performanceSeconds, 1)
    assert.equal(timing?.plannedEndSecond, 3)
    assert.throws(() => performanceStoryboardTiming({ ...pacing, performanceBeats: [{ ...pacing.performanceBeats[0], startSecond: 0, endSecond: 1, overlapWith: ['action'] }] }, 0, shot), /evidenceAnchor 必须出现在对应表演时间内/)
    assert.deepEqual(shot, before)
  })
}

test('schema112 only updates exact managed parser and audio clauses, preserving the actual saved request', () => {
  const source = fixture(), before = structuredClone(source), next = upgradeVideoRequestTimeSeparators(source)
  assert.equal(next.schemaVersion, 112)
  assert.deepEqual(source, before)
  assert.equal(next.edges, source.edges)
  assert.equal(upgradeVideoRequestTimeSeparators(next), next)
  assert.equal(next.nodes[0].code, source.nodes[0].code.replace('[-—~～至到]', '[-–—~～至到]'))
  assert.equal(next.nodes[1].prompt, '导演前缀\n' + SANGUO_STORYBOARD_PROMPT_BEFORE_TRUSTED_TAIL_STATE + '\n导演后缀')
  for (const [i, node] of source.nodes.entries()) {
    assert.deepEqual({ ...next.nodes[i], code: undefined, prompt: undefined }, { ...node, code: undefined, prompt: undefined })
    assert.equal(next.nodes[i].params, node.params)
  }
  assert.equal(next.nodes[2], source.nodes[2])
})

test('schema112 accepts already current managed clauses once without replacing their surrounding code', () => {
  const source = fixture()
  source.nodes[0].code = source.nodes[0].code.replace('[-—~～至到]', '[-–—~～至到]')
  source.nodes[1].prompt = '自定义前缀\n' + SANGUO_CINEMATIC_STORYBOARD_PROMPT + '\n自定义后缀'
  const next = upgradeVideoRequestTimeSeparators(source)
  assert.equal(next.schemaVersion, 112)
  for (let i = 0; i < source.nodes.length; i++) assert.equal(next.nodes[i], source.nodes[i])
})

test('schema112 refuses custom, missing or ambiguous parser/writer anchors atomically', () => {
  for (const edit of [
    (w: ReturnType<typeof fixture>) => { w.nodes[0].code = 'return customSampling(context);' },
    (w: ReturnType<typeof fixture>) => { w.nodes[0].code = w.nodes[0].code.replace("split('【')[0]", "split('【')[1]") },
    (w: ReturnType<typeof fixture>) => { w.nodes[0].code += savedRequest.code },
    (w: ReturnType<typeof fixture>) => { w.nodes[0].kind = 'text' },
    (w: ReturnType<typeof fixture>) => { w.nodes.push(w.nodes[0]) },
    (w: ReturnType<typeof fixture>) => { w.nodes[1].prompt = '用户自定义分镜规则' },
    (w: ReturnType<typeof fixture>) => { w.nodes[1].prompt = w.nodes[1].prompt.replace(STORYBOARD_AUDIO_COVERAGE_BEFORE_LINE_BINDING, '用户修改后的覆盖义务') },
    (w: ReturnType<typeof fixture>) => { w.nodes[1].prompt += STORYBOARD_DIALOGUE_BEFORE_LINE_BINDING },
    (w: ReturnType<typeof fixture>) => { w.nodes[1].prompt += STORYBOARD_AUDIO_COVERAGE_LINE_BINDING },
    (w: ReturnType<typeof fixture>) => { w.nodes[1].kind = 'code' },
    (w: ReturnType<typeof fixture>) => { w.nodes.splice(1, 1) },
  ]) {
    const source = fixture(); edit(source)
    const before = structuredClone(source)
    assert.equal(upgradeVideoRequestTimeSeparators(source), source)
    assert.deepEqual(source, before)
  }
  for (const schemaVersion of [110, 112, 113]) {
    const source = { ...fixture(), schemaVersion }
    assert.equal(upgradeVideoRequestTimeSeparators(source), source)
  }
  const other = { ...fixture(), id: 'custom-workflow' }
  assert.equal(upgradeVideoRequestTimeSeparators(other), other)
})

test('real en-dash candidate yields identical local and persisted speech windows plus scoped sampling', async () => {
  // Original raw fields from record-807mmd round1; this verifies parsing, not story acceptance.
  const shot = JSON.parse(readFileSync(new URL('./fixtures/time-range-en-dash-shot.json', import.meta.url), 'utf8'))
  const before = structuredClone(shot)
  const expected = [{ start: .5, end: 7.4, text: shot.audioText.replace(/^[^：:]+[：:]/, '') }]
  assert.throws(() => new Function('context', 'params', savedRequest.code)({ shot_script: shot }, { maxSamplingFrames: 24 }), /对白缺少时间窗/)
  const source = fixture(), next = upgradeVideoRequestTimeSeparators(source)
  const result = await executeCodeNode({ code: next.nodes[0].code, params: { maxSamplingFrames: 24 }, context: { shot_script: shot } })
  assert.deepEqual(plannedSpeechWindows(shot), expected)
  assert.deepEqual(result.speechWindows, expected)
  const sampleTimes = result.sampleTimes as number[]
  for (const second of [0, .5, 3.95, 7.4, 8]) assert.ok(sampleTimes.includes(second), String(second))
  assert.ok(sampleTimes.length <= 24)
  assert.equal(result.audioText, shot.audioText)
  assert.deepEqual(shot, before)
})

test('writer migration preserves all non-audio obligations and the exact previously deployed schema111 body', () => {
  const old = SANGUO_STORYBOARD_PROMPT_BEFORE_AUDIO_LINE_BINDING, next = SANGUO_STORYBOARD_PROMPT_BEFORE_TRUSTED_TAIL_STATE
  assert.equal(old.length, 5994)
  assert.equal(createHash('sha256').update(old).digest('hex'), '893ea781aa9eec62c371df25d3bc2bec2336d5e95d5568caca8d6bbd48958b64')
  assert.equal(next.replace(STORYBOARD_AUDIO_COVERAGE_LINE_BINDING, STORYBOARD_AUDIO_COVERAGE_BEFORE_LINE_BINDING)
    .replace(STORYBOARD_DIALOGUE_LINE_BINDING, STORYBOARD_DIALOGUE_BEFORE_LINE_BINDING), old)
  assert.match(STORYBOARD_AUDIO_COVERAGE_LINE_BINDING, /同一角色.*正文按序连接.*不改字序或说话归属/)
  assert.match(STORYBOARD_AUDIO_COVERAGE_LINE_BINDING, /visual 与 mustShow 锚点还须作为连续子串原样写进 visualPrompt\/videoPrompt/)
  assert.match(STORYBOARD_DIALOGUE_LINE_BINDING, /每行对白至多6秒.*beatDramaturgy.audio仍逐项保留完整原义务/)
})
