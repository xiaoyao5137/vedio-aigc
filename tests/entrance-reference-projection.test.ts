import test from 'node:test'
import assert from 'node:assert/strict'
import { compileDurationSchedule } from '../src/duration-schedule.ts'
import { prepareWorkflowMediaRequest, validateWorkflowMediaContract } from '../server/workflow-contracts.ts'
import { prepareThreeViewVideoReferences } from '../server/image-references.ts'
import { buildKlingVideoRequest, klingThreeViewVideoPrompt } from '../server/model-adapters.ts'
import { emptyOpeningShot } from './fixtures/duration-v2-empty-opening.ts'

function request(shot = emptyOpeningShot()) {
  const compiled = compileDurationSchedule(shot), actor = shot.characters[0]
  const params: Record<string, unknown> = { duration: shot.duration, pacingVersion: 'duration-v2', pacing: compiled.pacing,
    scheduleHash: compiled.scheduleHash, videoTimeline: compiled.videoPrompt, characters: shot.characters,
    initialCharacters: shot.initialCharacters, presentCharacters: shot.presentCharacters, audioType: shot.audioType, audioText: shot.audioText,
    sound: 'on', qualityMode: 'principle-v1', contentContractVersion: 'cinematic-v1', continuityMode: 'scene_cut', firstFrameMode: 'reference',
    referenceMode: 'three-view-all', referenceImages: ['/fixtures/approved-character-reference.png'],
    referenceBindings: [{ characterName: actor, continuityKey: 'approved-character', role: 'entering', entrance: shot.enteringCharacters[0] }],
    worldState: { settingId: 'market', characters: [{ name: actor, position: { status: 'unknown' }, heldProps: { status: 'unknown' }, pendingAction: { status: 'unknown' } }] } }
  return { model: { capability: 'video' }, executionContext: { workflowId: 'wf-sanguo-history-drama', nodeId: 'sanguo-video' },
    prompt: '【场景与开场实景】街市空镜开场，人物随后从右侧入画。\n【场景真实性硬约束】使用实际街市场景。\n' + compiled.videoPrompt, params }
}

test('real empty opening projects only its reference entrance onto the verified upper-budget window', async () => {
  const shot = emptyOpeningShot(), original = request(shot), before = JSON.stringify({ shot, original })
  assert.throws(() => validateWorkflowMediaContract(original), /首帧|entering/, 'the unchanged strict boundary rejects the original second clock')
  const prepared = prepareWorkflowMediaRequest(original)
  assert.notEqual(prepared, original)
  assert.doesNotThrow(() => validateWorkflowMediaContract(prepared))
  assert.equal(prepared.prompt, original.prompt)
  assert.equal(prepared.params.pacing, original.params.pacing)
  assert.equal(prepared.params.scheduleHash, original.params.scheduleHash)
  assert.deepEqual(prepared.params.initialCharacters, [])
  assert.deepEqual(prepared.params.referenceBindingProjection, { version: 'duration-v2-entrance-v1', scheduleHash: original.params.scheduleHash,
    changes: [{ characterName: '房植门生', beatId: 'beat-pacing-01', declared: { startSecond: 0, endSecond: 1.5 }, scheduled: { startSecond: 0, endSecond: 2 } }] })
  assert.equal(JSON.stringify({ shot, original }), before, 'author text, source entrance, schedule, and caller input are immutable')
  assert.equal(prepareWorkflowMediaRequest(prepared), prepared, 'retries preserve the original diagnostic and are idempotent')
  const imageParams = await prepareThreeViewVideoReferences(prepared.params, async () => { throw new Error('network is forbidden') })
  const prompt = klingThreeViewVideoPrompt(prepared.prompt, imageParams)
  const body = buildKlingVideoRequest({ id: 'kling', provider: 'Kling', capability: 'video', settings: {} }, prompt, imageParams)
  assert.match(String(body.prompt), /房植门生只能在0-2秒/)
  assert.match(String(body.prompt), /beat-pacing-01，0至2秒/)
  assert.doesNotMatch(String(body.prompt), /1\.5|declared|referenceBindingProjection/)
  assert.equal(body.duration, '15')
  assert.equal(body.sound, 'on')
})

test('entrance projection refuses damaged hashes or a request that omits the actual compiled timeline', () => {
  const original = request()
  assert.throws(() => prepareWorkflowMediaRequest({ ...original, params: { ...original.params, scheduleHash: 'duration-v2-damaged' } }), /排程哈希失效/)
  const pacing = structuredClone(original.params.pacing) as { schedule: Array<{ endSecond: number }> }
  pacing.schedule[0].endSecond = 1.5
  assert.throws(() => prepareWorkflowMediaRequest({ ...original, params: { ...original.params, pacing } }), /派生字段 schedule/)
  assert.throws(() => prepareWorkflowMediaRequest({ ...original, prompt: '只提供开场' }), /实际请求未使用/)
})

test('entrance projection never invents an action, changes actors or paths, or chooses among duplicate entrances', () => {
  for (const mutate of [
    (shot: ReturnType<typeof emptyOpeningShot>) => { shot.pacing.beats[0].textOrVocalization = '站在原地观看街市' },
    (shot: ReturnType<typeof emptyOpeningShot>) => { shot.enteringCharacters[0].name = '另一位人物' },
  ]) {
    const shot = emptyOpeningShot(); mutate(shot)
    assert.throws(() => prepareWorkflowMediaRequest(request(shot)), /STORYBOARD_ENTRANCE_BINDING_INVALID:/)
  }
  const ambiguous = emptyOpeningShot(), duplicate = { ...structuredClone(ambiguous.pacing.beats[0]), id: 'second-entrance' }
  ambiguous.pacing.beats.push(duplicate)
  ambiguous.pacing.beats[1].overlapAllowedWith.push(duplicate.id)
  assert.throws(() => prepareWorkflowMediaRequest(request(ambiguous)), /匹配 2 个已批准动作/)
})

test('an actor cannot speak before its compiled entrance finishes even with a valid schedule hash', () => {
  const shot = emptyOpeningShot(), voice = shot.pacing.beats[1]
  voice.actorIds = shot.characters
  voice.deliveryStyle = 'dialogue'
  voice.textOrVocalization = '请听我说'
  voice.completion.evidenceAnchor = voice.textOrVocalization
  shot.audioType = '对白'; shot.audioText = shot.characters[0] + ':' + voice.textOrVocalization
  assert.throws(() => prepareWorkflowMediaRequest(request(shot)), /编译入场尚未完成本人已发声/)
})

test('legacy requests and requests without entrance projections keep their original contract', () => {
  const original = request()
  const legacy = { ...original, params: { ...original.params, pacingVersion: 'dynamic-v1' } }
  const noEntrance = { ...original, params: { ...original.params, referenceBindings: [] } }
  assert.equal(prepareWorkflowMediaRequest(legacy), legacy)
  assert.equal(prepareWorkflowMediaRequest(noEntrance), noEntrance)
  assert.throws(() => validateWorkflowMediaContract(legacy), /首帧/)
  assert.throws(() => validateWorkflowMediaContract(noEntrance), /首帧|entering/)
})
