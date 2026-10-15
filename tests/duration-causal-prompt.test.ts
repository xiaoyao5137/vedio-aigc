import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { durationCausalVideoGuard } from '../src/duration-causal-prompt.ts'
import { buildKlingVideoRequest, callKlingVideo, klingThreeViewVideoPrompt } from '../server/model-adapters.ts'
import { prepareThreeViewVideoReferences } from '../server/image-references.ts'
import { projectIndependentNarration } from '../server/narration-projection.ts'
import { compactManagedVideoProviderPrompt, renderVideoProviderPrompt } from '../src/video-provider-prompt.ts'
import { speechPerformanceContract } from '../src/speech-performance.ts'

const timeline = '0-2秒：军士封住缺口。2-7秒：军士缚住严颜双腕。7-9秒：张飞走到严颜面前。'
const hash = 'duration-v2-sha256-' + 'a'.repeat(64)
const beats = [
  { id: 'close', kind: 'action', actorIds: ['军士'], dependsOn: [],
    completion: { modality: 'visual', finalState: '缺口被军士封住。', evidenceAnchor: '军士封住缺口' } },
  { id: 'narration', kind: 'speech', actorIds: ['旁白'], dependsOn: [],
    completion: { modality: 'audio', finalState: '旁白完整结束。', evidenceAnchor: '城门已破' } },
  { id: 'bind', kind: 'action', actorIds: ['军士', '严颜'], dependsOn: ['close', 'narration'],
    textOrVocalization: '军士缚住严颜双腕。',
    completion: { modality: 'visual', finalState: '严颜双腕被绳结缚牢。', evidenceAnchor: '军士缚住严颜双腕' } },
  { id: 'approach', kind: 'action', actorIds: ['张飞'], dependsOn: ['bind'],
    textOrVocalization: '张飞走到严颜面前。',
    completion: { modality: 'visual', finalState: '张飞在严颜面前站定。', evidenceAnchor: '张飞走到严颜面前' } },
]
const schedule = [
  { beatId: 'close', startSecond: 0, endSecond: 2 },
  { beatId: 'narration', startSecond: 0, endSecond: 2 },
  { beatId: 'bind', startSecond: 2, endSecond: 7 },
  { beatId: 'approach', startSecond: 7, endSecond: 9 },
]
const params = { duration: 10, pacingVersion: 'duration-v2', scheduleHash: hash,
  videoTimeline: timeline, audioType: '旁白', audioText: '城门已破',
  pacing: { version: 'duration-v2', scheduleHash: hash, compiledVideoPrompt: timeline, beats, schedule } }
const model = { id: 'kling', provider: 'Kling', capability: 'video',
  settings: { model: 'kling-v3', endpoint: 'https://example.test/v1/videos', apiKey: 'offline-test' } }

test('paid video prompt gates each later action on visible predecessor completion and prior voice end', () => {
  const before = JSON.stringify(params)
  const guard = durationCausalVideoGuard(params)
  assert.match(guard, /军士缚住严颜双腕.*缺口被军士封住.*画面可见.*旁白\(narration\)完整收音后才启动/)
  assert.match(guard, /张飞走到严颜面前.*严颜双腕被绳结缚牢.*画面可见后才启动；此前张飞留原位、不迈第一步/)
  assert.match(guard, /时间窗不能代替可见完成/)
  assert.equal(durationCausalVideoGuard(params), guard)
  const request = buildKlingVideoRequest(model, timeline, params)
  assert.ok(String(request.prompt).includes(timeline))
  assert.ok(String(request.prompt).includes(guard))
  assert.equal(JSON.stringify(params), before, 'approved beat data and hash remain unchanged')
})

test('incomplete or contradictory signed dependency data blocks the paid request', async () => {
  for (const changed of [
    { ...params, scheduleHash: 'duration-v2-sha256-' + 'b'.repeat(64) },
    { ...params, videoTimeline: 'unrelated timeline' },
    { ...params, pacing: { ...params.pacing, beats: [...beats.slice(0, 3), { ...beats[3], dependsOn: ['missing'] }] } },
    { ...params, pacing: { ...params.pacing, schedule: [...schedule.slice(0, 3), { ...schedule[3], startSecond: 6 }] } },
  ]) assert.throws(() => buildKlingVideoRequest(model, timeline, changed), /DURATION_CAUSAL_PROMPT_INVALID/)
  let posts = 0
  await assert.rejects(() => callKlingVideo(model, timeline + '场景细节。'.repeat(500), params, {
    fetch: async () => { posts++; throw Error('unexpected provider call') },
  }), /STORYBOARD_PROMPT_OVERLOAD/)
  assert.equal(posts, 0, 'the guard and all authored actions must fit before provider submission')
})

test('legacy and unsigned preview requests do not claim a verified causal guard', () => {
  assert.equal(durationCausalVideoGuard({ ...params, pacingVersion: 'dynamic-v1' }), '')
  assert.equal(durationCausalVideoGuard({ ...params, scheduleHash: undefined }), '')
})

test('full identity-sheet preparation fits a narration and riding dependency without deleting authored tracks', async () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/independent-narration-provider-overload.json', import.meta.url), 'utf8'))
  const unchanged = JSON.stringify(fixture)
  const params = { ...fixture.params, scheduleHash: fixture.params.pacing.scheduleHash,
    videoTimeline: fixture.params.pacing.compiledVideoPrompt,
    referenceImages: ['data:image/png;base64,YQ==', 'data:image/png;base64,Yg=='],
    referenceImage: 'data:image/png;base64,Yw==' }
  const prepared = await prepareThreeViewVideoReferences(params, async () => { throw Error('offline fixture must not fetch') })
  assert.equal(prepared.referenceDiagnostics.composition, 'whole-identity-sheets')
  const source = klingThreeViewVideoPrompt(fixture.prompt, prepared)
  const request = buildKlingVideoRequest(fixture.model, source, prepared)
  const finalPrompt = String(request.prompt)
  assert.ok(Array.from(finalPrompt).length <= 2500)
  assert.ok(finalPrompt.includes(fixture.params.pacing.compiledVideoPrompt))
  assert.ok(finalPrompt.includes(fixture.params.audioText))
  assert.ok(finalPrompt.includes(fixture.prompt.split('\n').find((line: string) => line.startsWith('【本镜结束时的自然动作结果】'))))
  assert.match(finalPrompt, /张飞从后方赶到刘备身侧.*刘备已进入弯心并收缓马步.*画面可见后才启动；此前张飞不得提前骑近或入画/)
  assert.match(finalPrompt, /人物：刘备<<<image_1>>>、张飞<<<image_2>>>/)
  assert.doesNotMatch(finalPrompt, /content shortened/)
  assert.equal(JSON.stringify(fixture), unchanged)
})

test('signed b01 dependencies reach the final speech-free supplier picture with an end frame', async () => {
  const source = JSON.parse(readFileSync(new URL('./fixtures/duration-b01-independent-picture.json', import.meta.url), 'utf8'))
  const before = JSON.stringify(source)
  const projected = projectIndependentNarration(source.prompt, source.params)
  const guard = durationCausalVideoGuard(source.params, { pictureOnly: true })
  assert.match(guard, /军士将严颜双腕缚住.*缺口被军士封住.*独立画外配音\(b01-narration-1\)对应时间窗至2\.5秒结束后才启动/)
  assert.match(guard, /张飞走到严颜面前.*严颜双腕在身前被绳索缚住.*画面可见.*独立画外配音\(b01-narration-2\)对应时间窗至7\.1秒结束后才启动/)
  assert.match(guard, /张飞已在严颜面前站定.*b01-narration-3对应后期画外配音进入点；画内无人发声/)
  const prepared = await prepareThreeViewVideoReferences(projected.params, async () => { throw Error('offline fixture must not fetch') })
  const supplierInput = klingThreeViewVideoPrompt(projected.prompt, prepared)
  const request = buildKlingVideoRequest(model, supplierInput, prepared)
  const supplierPrompt = String(request.prompt)
  assert.ok(supplierPrompt.includes('【因果动作锁】'))
  assert.ok(supplierPrompt.includes(guard))
  assert.ok(Array.from(supplierPrompt).length <= 2500)
  for (const segment of projected.segments) assert.ok(!supplierPrompt.includes(segment.text), `supplier received spoken line ${segment.beatId}`)
  assert.doesNotMatch(supplierPrompt, /完整收音|画外旁白自然朗读/)
  assert.match(supplierPrompt, /无人声|画内无人发声/)
  assert.doesNotMatch(supplierPrompt, /旁白各节拍依时间轴画外独立完整发声/)
  assert.ok(Array.isArray(request.image_list))
  assert.ok((request.image_list as Array<{ type?: string }>).some(image => image.type === 'first_frame'))
  assert.ok((request.image_list as Array<{ type?: string }>).some(image => image.type === 'end_frame'))
  assert.equal(JSON.stringify(source), before, 'approved source is unchanged')
  assert.throws(() => projectIndependentNarration(source.prompt,
    { ...source.params, scheduleHash: 'duration-v2-sha256-' + '0'.repeat(64) }), /哈希失效/)
  const forgedHash = 'duration-v2-sha256-' + '0'.repeat(64)
  assert.throws(() => projectIndependentNarration(source.prompt,
    { ...source.params, scheduleHash: forgedHash, pacing: { ...source.params.pacing, scheduleHash: forgedHash } }), /哈希失效/)
  assert.throws(() => buildKlingVideoRequest(model, supplierInput.replace(guard, ''), prepared),
    /DURATION_CAUSAL_PROMPT_INVALID/)
})

test('picture-only compaction retains an offscreen dialogue label without adding narrator speech', () => {
  const source = JSON.parse(readFileSync(new URL('./fixtures/duration-b01-independent-picture.json', import.meta.url), 'utf8'))
  const projected = projectIndependentNarration(source.prompt, source.params)
  const params = { ...projected.params, pacing: { ...projected.params.pacing,
    beats: projected.params.pacing.beats.map((beat: Record<string, unknown>) => beat.kind === 'speech'
      ? { ...beat, deliveryStyle: 'dialogue' } : beat) } }
  const picture = projected.prompt.replace('【独立画外配音】本次仅生成画面和与场景相符的自然环境音。旁白将在后期添加',
    '【独立画外配音】本次仅生成画面和与场景相符的自然环境音。画外角色弟子的对白将在后期添加')
  const rendered = renderVideoProviderPrompt(picture, params)
  const full = `${rendered}\n${speechPerformanceContract(params)}`
  const compact = compactManagedVideoProviderPrompt(full, params, { preserveCausalRoom: true })
  assert.ok(compact.length < full.length)
  assert.match(compact, /画外角色弟子的对白将在后期添加/)
  assert.match(compact, /【逐声部声画绑定】仅生成画面和自然环境音；画外配音由后期添加；画内无人声/)
  assert.doesNotMatch(compact, /旁白各节拍|旁白依时间轴/)
})
