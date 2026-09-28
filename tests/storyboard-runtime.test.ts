import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { generateHistoricalStoryboard, storyboardCandidate, storyboardDiagnostics, sceneFromStoryboardSegment, loopIterationContext, storyboardContinuityContext, historicalContinuityIssue } from '../src/storyboard-runtime.ts'
import { validateHistoricalStoryboardSegments, validateHistoricalStructuredOutput, validateNoCompletedActionReplay, validateNoUnallocatedSplitActions } from '../src/workflow-core.ts'
import { chantScene, chantShot } from './fixtures/duration-v2-chant.ts'

const scene = { id: 's1', title: '诏书', sequence: 1, purpose: '宣诏与回应', targetDuration: 15, continuityFromPrevious: false,
  requiredBeats: [{ id: 'beat-01', description: '冀州官吏展诏', setting: '议事厅', mustShow: ['封侯诏书', '冀州官吏'] }],
  historicalBasis: '[史料1] 授爵', adaptationBoundary: '调度拟制' }
const shot = { id: 's1', title: '宣诏', duration: 15, characters: ['冀州官吏'], initialCharacters: ['冀州官吏'], enteringCharacters: [], endCharacters: ['冀州官吏'],
  continuity: { previousShotId: '', bridgeType: 'opening', bridgeAnchor: '' }, coveredBeatIds: ['beat-01'],
  firstFrameMode: 'reference', visualPrompt: '议事厅内，冀州官吏手捧封侯诏书。', lastFramePrompt: '冀州官吏捧住封侯诏书站定。',
  videoPrompt: '0-5秒：冀州官吏展开封侯诏书。5-10秒：镜头推进。10-13.5秒：冀州官吏站定。13.5-15秒：画面稳定。',
  audioType: '旁白', audioText: '封侯诏书传到了冀州。', camera: '固定中景', mood: '压抑', historicalBasis: '[史料1] 授爵', adaptationBoundary: '调度拟制' }

const jsonFence = (value: unknown) => '```json\n' + JSON.stringify(value, null, 2) + '\n```'

test('multiple complete fenced storyboard objects are retained as one split and pass the original full allocation gate', async () => {
  const first = chantShot()
  const second = { ...chantShot(), id: 'scene-01-seg02', coveredBeatIds: ['song-continued'], firstFrameMode: 'reuse_previous_tail',
    visualPrompt: first.lastFramePrompt, continuity: { previousShotId: first.id, bridgeType: 'same_frame', bridgeAnchor: '' },
    pacing: { ...chantShot().pacing, beats: chantShot().pacing.beats.map(beat => ({ ...beat, sourceBeatId: 'song-continued' })) } }
  const currentScene = { ...chantScene, cast: ['传唱歌谣的乡人'], requiredBeats: [...chantScene.requiredBeats, { ...chantScene.requiredBeats[0], id: 'song-continued' }] }
  const responseText = jsonFence(first) + '\n\n' + jsonFence(second)
  const response = { id: 'provider-response', role: 'assistant', content: [{ type: 'text', text: responseText }] }
  const before = structuredClone(response)
  const parsed = storyboardCandidate(response) as Record<string, unknown>
  assert.deepEqual(parsed.segments, [first, second])
  assert.equal(parsed.text, responseText)
  assert.equal(parsed.raw, response)
  const expected = { scene: currentScene, pacingVersion: 'duration-v2', requireDynamicPacing: true, requireContinuityContract: true }
  const accepted = validateHistoricalStoryboardSegments(parsed, expected)
  assert.deepEqual(accepted.flatMap(part => part.coveredBeatIds), ['song-spreads', 'song-continued'])
  const unknownField = storyboardCandidate(jsonFence(first) + '\n' + jsonFence({ ...second, unsafeExtraField: '未声明字段' }))
  assert.throws(() => validateHistoricalStoryboardSegments(unknownField, expected), /包含未声明字段：unsafeExtraField/)
  let calls = 0
  const result = await generateHistoricalStoryboard({ prompt: '完整生成全部原节拍', expected,
    generate: async prompt => {
      calls += 1
      assert.match(prompt, /已批准 scene.cast=\["传唱歌谣的乡人"\].*人物身份使用上述原全名/)
      assert.match(prompt, /人物字段不能放 group.id/)
      return response
    },
  })
  assert.equal(calls, 1, 'a complete provider response must not purchase a repair after discarding its second block')
  assert.equal((result.__storyboardSegments as unknown[]).length, 2)
  assert.deepEqual(response, before)
})

test('multiple alternate or repeated storyboard blocks are never silently selected as the successful candidate', () => {
  const first = chantShot()
  const alternate = { ...chantShot(), id: 'alternate-version' }
  const parsed = storyboardCandidate(jsonFence(first) + '\n版本二\n' + jsonFence(alternate)) as Record<string, unknown>
  assert.deepEqual(parsed.segments, [first, alternate])
  assert.throws(() => validateHistoricalStoryboardSegments(parsed, { scene: chantScene, pacingVersion: 'duration-v2' }), /恰好分配一次|覆盖全部剧情节拍/)
  const extraField = storyboardCandidate(jsonFence(first) + '\n' + jsonFence({ ...alternate, unsafeExtraField: '未声明字段' })) as Record<string, unknown>
  assert.equal((extraField.segments as Record<string, unknown>[])[1].unsafeExtraField, '未声明字段', 'normalization does not strip fields to make a candidate pass')
})

test('a damaged or incomplete later JSON block cannot disappear behind a valid first storyboard', () => {
  const first = jsonFence(chantShot())
  assert.throws(() => storyboardCandidate(first + '\n```json\n{"id": "broken",}\n```'), /第 2 个 JSON 代码块解析失败.*不能忽略损坏分段/)
  assert.throws(() => storyboardCandidate(first + '\n```json\n{"id": "unfinished"}'), /第 2 个 JSON 代码块未闭合/)
  assert.throws(() => storyboardCandidate(first + '\n' + jsonFence({ coveredBeatIds: ['second'] })), /第 2 个 JSON 代码块不是.*完整声画字段.*不能选取首块/)
  assert.throws(() => storyboardCandidate(first + '\n' + jsonFence({ segments: [chantShot(), chantShot()] })), /多个代码块必须全部为完整分镜/)
})

test('single storyboard blocks and existing segments wrappers retain their established normalization', () => {
  const current = chantShot()
  const single = storyboardCandidate(jsonFence(current)) as Record<string, unknown>
  assert.equal(single.id, current.id)
  assert.deepEqual(single.pacing, current.pacing)
  assert.equal(single.segments, undefined)
  const wrapper = { segments: [current, { ...current, id: 'second' }] }
  assert.deepEqual((storyboardCandidate(wrapper) as Record<string, unknown>).segments, wrapper.segments)
  assert.deepEqual((storyboardCandidate(jsonFence(wrapper)) as Record<string, unknown>).segments, wrapper.segments)
})

test('continuous production uses accepted actual tail state without rewriting prior evidence', () => {
  const url = '/generated/verified-abc-frame-5.jpg'
  const previous = { shot_script: shot, last_frame: { available: true, url }, video_shot: {
    technicalValidation: { passed: true }, speechValidation: { passed: true }, lastFrameUrl: url, frames: [url],
    visualReview: { passed: true, issues: [], endCharacters: ['冀州官吏'], endingState: '冀州官吏坐在左侧，双手捧封侯诏书。', endingStateEvidence: { method: 'actual-tail-image', frame: url } },
  } }
  const context = { scene: { continuityFromPrevious: true }, loop: { previous } }
  const before = JSON.stringify(context)
  const grounded = storyboardContinuityContext(context) as typeof context
  assert.equal(grounded.loop.previous.shot_script.lastFramePrompt, previous.video_shot.visualReview.endingState)
  assert.equal(JSON.stringify(context), before)
  assert.doesNotMatch(grounded.loop.previous.shot_script.videoPrompt, /0-5秒|13.5-15秒/)
  assert.match(grounded.loop.previous.shot_script.videoPrompt, /下一镜开始前的实际状态/)
  const next = { ...shot, firstFrameMode: 'reuse_previous_tail', visualPrompt: previous.video_shot.visualReview.endingState,
    continuity: { previousShotId: shot.id } }
  const video = { params: { referenceImage: url }, firstFrameDifference: 0.01 }
  assert.equal(historicalContinuityIssue(next, video, shot, previous.video_shot), undefined)
  assert.match(historicalContinuityIssue({ ...next, visualPrompt: shot.lastFramePrompt }, video, shot, previous.video_shot)!, /开场文本/)
  assert.match(historicalContinuityIssue(next, { ...video, firstFrameDifference: 0.11 }, shot, previous.video_shot)!, /实测首尾/)
  assert.match(historicalContinuityIssue(next, { ...video, params: { referenceImage: '/generated/foreign.jpg' } }, shot, previous.video_shot)!, /首帧引用/)
  for (const bad of [
    { ...previous, last_frame: { available: true, url: '/generated/foreign.jpg' } },
    { ...previous, video_shot: { ...previous.video_shot, technicalValidation: { passed: false } } },
    { ...previous, video_shot: { ...previous.video_shot, visualReview: { ...previous.video_shot.visualReview, endingStateEvidence: undefined } } },
  ]) assert.throws(() => storyboardContinuityContext({ ...context, loop: { previous: bad } }), /CONTINUITY_EVIDENCE_MISSING/)
  const cut = { ...context, scene: { continuityFromPrevious: false } }
  assert.equal(storyboardContinuityContext(cut), cut)
})

test('production failure replay diagnoses anchors and dialogue overflow together', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/storyboard-coverage-failure.json', import.meta.url), 'utf8'))
  const errors = storyboardDiagnostics(fixture.candidate, { scene: fixture.scene })
  assert.match(errors.join('\n'), /封侯诏书.*冀州官吏/)
  assert.match(errors.join('\n'), /口型锚点|时间段|预计需要/)
})

test('coverage repair edits the rejected shot before attempting any split', async () => {
  const broken = { ...shot, visualPrompt: '官员持文书', lastFramePrompt: '官员站定', audioText: '朝廷授爵。', videoPrompt: '0-5秒：官员展开文书。5-10秒：镜头推进。10-13.5秒：官员站定。13.5-15秒：画面稳定。' }
  const prompts: string[] = []
  const output = await generateHistoricalStoryboard({ prompt: '剧本', expected: { scene }, initialCandidate: broken,
    generate: async (prompt) => { prompts.push(prompt); return shot } })
  assert.equal(prompts.length, 1)
  assert.doesNotMatch(prompts[0], /【自动拆镜】/)
  assert.match(prompts[0], /封侯诏书/)
  assert.match(prompts[0], /官员持文书/)
  assert.equal(output.id, 's1')
})

test('titles and reference metadata cannot satisfy an absent filmed anchor', () => {
  assert.throws(() => validateHistoricalStructuredOutput('history.storyboard', { ...shot, title: '珍贵玉玺' }, {
    scene: { ...scene, requiredBeats: [{ ...scene.requiredBeats[0], mustShow: ['珍贵玉玺'] }] },
  }), /STORYBOARD_COVERAGE_INCOMPLETE/)
})

test('one complex beat may span consecutive segments without losing an anchor', () => {
  const a = { ...shot, beatCoverage: [{ beatId: 'beat-01', anchors: ['封侯诏书'] }] }
  const b = { ...shot, id: 's1-b', coveredBeatIds: ['beat-01'], beatCoverage: [{ beatId: 'beat-01', anchors: ['冀州官吏'] }],
    continuity: { previousShotId: 's1', bridgeType: 'same_frame', bridgeAnchor: '' }, firstFrameMode: 'reuse_previous_tail', visualPrompt: a.lastFramePrompt }
  const segments = validateHistoricalStoryboardSegments({ segments: [a, b] }, { scene, requireContinuityContract: true })
  assert.equal(segments.length, 2)
  const partition = sceneFromStoryboardSegment(scene, segments[1], 1, 2)
  assert.deepEqual((partition.requiredBeats as Array<Record<string, unknown>>)[0].mustShow, ['冀州官吏'])
  assert.equal((partition.requiredBeats as Array<Record<string, unknown>>)[0].description, '冀州官吏')
  assert.equal(partition.sequence, 2)
  assert.throws(() => validateHistoricalStoryboardSegments({ segments: [a, { ...b, beatCoverage: a.beatCoverage }] }, { scene }), /恰好分配一次/)
  const staleCompleted = { ...a, beatCoverage: [{ beatId: 'beat-01', anchors: ['上一镜已完成动作', '对白文本'] }] }
  assert.throws(() => validateHistoricalStoryboardSegments({ segments: [staleCompleted, b] }, { scene }),
    /未批准的锚点：上一镜已完成动作、对白文本.*previousScriptBeatDramaturgy.*纯音频分段的 anchors 应为 \[\]/)
})

test('a later queue round cannot replay a completed anonymous-group action from the same source beat', () => {
  const previous = { coveredBeatIds: ['beat-04'], storyProgress: { pendingActions: ['张角递出符水', '病患饮下符水'] } }
  const currentScene = { requiredBeats: [{ id: 'beat-04', description: '继续施治', setting: '村落', mustShow: ['张角递出符水', '病患饮下符水'] }] }
  const current = { coveredBeatIds: ['beat-04'], pacing: { beats: [
    { kind: 'action', sourceBeatId: 'beat-04', textOrVocalization: '病患挣扎起身，双膝跪下' },
    { kind: 'action', sourceBeatId: 'beat-04', textOrVocalization: '张角递出符水' },
  ] } }
  assert.throws(() => validateNoCompletedActionReplay(current, currentScene, previous), /重演了前镜已完成动作.*病患挣扎起身/)
  validateNoCompletedActionReplay({ ...current, pacing: { beats: current.pacing.beats.slice(1) } }, currentScene, previous)
})

test('an allocated split rejects actions belonging to its later sibling before media generation', () => {
  const allocated = { sourceSceneId: 'scene-03', completionCriteria: ['画面呈现：病患挣扎起身跪下'], requiredBeats: [{
    id: 'beat-04', description: '病患挣扎起身跪下', function: '完成跪拜', stateChange: '病患跪下', setting: '村落空地',
    mustShow: ['病患挣扎起身跪下'], observable: { visual: ['病患挣扎起身跪下'], audio: [] },
  }] }
  const shot = { pacing: { beats: [
    { kind: 'action', sourceBeatId: 'beat-04', textOrVocalization: '病患挣扎起身跪下' },
    { kind: 'action', sourceBeatId: 'beat-04', textOrVocalization: '张角从竹筒中倒出符水' },
  ] } }
  assert.throws(() => validateNoUnallocatedSplitActions(shot, allocated), /未分配动作.*倒出符水/)
  validateNoUnallocatedSplitActions({ pacing: { beats: shot.pacing.beats.slice(0, 1) } }, allocated)
})

test('continuous scripts reject stale previous id, teleporting cast, and rewritten opening positions', () => {
  const next = { ...shot, id: 's2', firstFrameMode: 'reuse_previous_tail', visualPrompt: shot.lastFramePrompt,
    continuity: { previousShotId: shot.id, bridgeType: 'same_frame', bridgeAnchor: '' } }
  const expected = { scene: { ...scene, continuityFromPrevious: true }, previousShot: shot, requireContinuityContract: true }
  assert.doesNotThrow(() => validateHistoricalStructuredOutput('history.storyboard', next, expected))
  assert.throws(() => validateHistoricalStructuredOutput('history.storyboard', { ...next, visualPrompt: '冀州官吏已经坐到右侧。' }, expected), /原样复制/)
  assert.throws(() => validateHistoricalStructuredOutput('history.storyboard', next, { ...expected, previousShot: { ...shot, id: 'new-take' } }), /previousShotId/)
  assert.throws(() => validateHistoricalStructuredOutput('history.storyboard', next, { ...expected, previousShot: { ...shot, endCharacters: ['李膺'] } }), /initialCharacters 必须与前镜/)
})

test('a claimed prop or sound match must reference evidence in both scenes', () => {
  const next = { ...shot, id: 's2', continuity: { previousShotId: shot.id, bridgeType: 'prop', bridgeAnchor: '封侯诏书' } }
  assert.doesNotThrow(() => validateHistoricalStructuredOutput('history.storyboard', next, { scene, previousShot: shot, requireContinuityContract: true }))
  assert.throws(() => validateHistoricalStructuredOutput('history.storyboard', { ...next, continuity: { ...next.continuity, bridgeAnchor: '远处雷声' } }, { scene, previousShot: shot, requireContinuityContract: true }), /只有声桥/)
})

test('step and full iterations clear skipped branch media and preserve explicit previous results', () => {
  const previous = { first_frame: { url: 'tail-1.jpg' }, video: { url: 'one.mp4' } }
  const context = loopIterationContext({ input: { episode: 1 }, ...previous, assets: { url: 'stale.jpg' } }, ['first_frame', 'video', 'assets', 'script'], 'scene', { id: 's2' }, 1, previous,
    [{ resultVar: 'script', output: { id: 's2', contextPatch: { input: { ratio: '16:9' } } } }])
  assert.equal(context.first_frame, undefined)
  assert.equal(context.assets, undefined)
  assert.deepEqual((context.loop as Record<string, unknown>).previous, previous)
  assert.deepEqual(context.input, { episode: 1, ratio: '16:9' })
})

test('revalidating a narrated split does not mistake its own negative lip-sync guard for an action', () => {
  const once = validateHistoricalStructuredOutput('history.storyboard', shot, { scene }) as Record<string, unknown>
  const clean = { ...once }
  delete clean.timingEstimate
  const twice = validateHistoricalStructuredOutput('history.storyboard', clean, { scene }) as Record<string, unknown>
  assert.equal(twice.videoPrompt, once.videoPrompt)
})

test('the next round copies its immutable opening instead of retrying a paraphrase', async () => {
  const output = await generateHistoricalStoryboard({ prompt: '续接', expected: { scene: { ...scene, id: 's2', continuityFromPrevious: true }, previousShot: shot, requireContinuityContract: true },
    initialCandidate: { ...shot, id: 's2', firstFrameMode: 'reference', visualPrompt: '冀州官吏仍然拿着诏书。' },
    generate: async () => { throw new Error('should not buy another text call to copy a string') },
  })
  assert.equal(output.visualPrompt, shot.lastFramePrompt)
  assert.equal(output.firstFrameMode, 'reuse_previous_tail')
  assert.equal((output.continuity as Record<string, unknown>).previousShotId, shot.id)
})

test('script acceptance respects actual full-view reference capacity before paid media', () => {
  const crowd = { ...shot, characters: ['冀州官吏', '李膺', '郡吏甲'], initialCharacters: ['冀州官吏', '李膺', '郡吏甲'] }
  assert.throws(() => validateHistoricalStructuredOutput('history.storyboard', crowd, { scene, requireContinuityContract: true }), /STORYBOARD_REFERENCE_OVERFLOW/)
})

test('the real repaired production failure retains every beat across three executable rounds', () => {
  const original = JSON.parse(readFileSync(new URL('./fixtures/storyboard-coverage-failure.json', import.meta.url), 'utf8'))
  const repaired = JSON.parse(readFileSync(new URL('./fixtures/storyboard-coverage-repaired.json', import.meta.url), 'utf8'))
  const segments = validateHistoricalStoryboardSegments({ segments: repaired.segments }, { scene: original.scene, requireContinuityContract: true, aspectRatio: '16:9' })
  assert.equal(segments.length, 3)
  assert.deepEqual(segments.flatMap(s => s.coveredBeatIds), original.scene.requiredBeats.map((b: { id: string }) => b.id))
})

test('repair prompts retain the actual rejected scene without reinjecting provider response envelopes', async () => {
  const candidate = JSON.parse(readFileSync(new URL('./fixtures/storyboard-parenthetical-speaker.json', import.meta.url), 'utf8'))
  let prompt = ''
  await generateHistoricalStoryboard({ prompt: '修复本场分镜', expected: { scene: { targetDuration: 15, continuityFromPrevious: false }, productionSpeechRate: 3 },
    initialCandidate: { ...candidate, audioText: candidate.audioText.replace('冀州官吏（功曹）', '未列人物'),
      raw: { text: 'UPSTREAM_METADATA_DO_NOT_REINJECT' }, text: 'UPSTREAM_METADATA_DO_NOT_REINJECT' },
    generate: async (input) => { prompt = input; return candidate },
  })
  assert.match(prompt, /说话人未列入/)
  assert.match(prompt, /封侯诏书/)
  assert.doesNotMatch(prompt, /UPSTREAM_METADATA_DO_NOT_REINJECT/)
})
