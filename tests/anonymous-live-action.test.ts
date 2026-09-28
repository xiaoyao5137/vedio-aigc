import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { cinematicContinuityIssue, validateCinematicShot } from '../src/history-cinema.ts'
import { generateHistoricalStoryboard, historicalContinuityIssue, storyboardContinuityContext } from '../src/storyboard-runtime.ts'
import { validateWorkflowMediaContract } from '../server/workflow-contracts.ts'

type Value = Record<string, unknown>
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/anonymous-live-action-storyboard.json', import.meta.url), 'utf8'))

test('record-mp0ow5 anonymous live-action draft passes without buying another repair or inventing identities', async () => {
  const { scene, previousShot, candidate } = fixture()
  const before = structuredClone(candidate)
  let calls = 0
  const result = await generateHistoricalStoryboard({ prompt: '按已批准场景执行', expected: {
    scene, previousShot, pacingVersion: 'duration-v2', requireContinuityContract: true,
    requireDynamicPacing: true, requireNarrativeClosure: true, requireDramaContract: true,
    timingPolicy: candidate.pacing.timingPolicy,
  }, generate: async prompt => {
    calls++
    assert.match(prompt, /本镜没有批准的具名人物.*shotIntent.viewpointCharacter="观众"/)
    return candidate
  } })
  assert.equal(calls, 1)
  assert.deepEqual(candidate, before, 'the persisted provider response stays intact')
  for (const key of ['characters', 'presentCharacters', 'initialCharacters', 'enteringCharacters', 'endCharacters']) assert.deepEqual(result[key], [])
  assert.deepEqual((result.worldState as Value).characters, [])
  assert.equal((result.shotIntent as Value).viewpointCharacter, '观众')
  assert.equal(result.visualPrompt, before.visualPrompt)
  assert.equal(String(result.lastFramePrompt).split('【静态尾帧】')[0].trim(), before.lastFramePrompt)
  const pacing = result.pacing as { actorGroups: Value[]; beats: Value[] }
  assert.ok(pacing.actorGroups.some(group => String(group.label).includes('弟子')))
  assert.ok(pacing.actorGroups.some(group => String(group.label).includes('百姓')))
  assert.equal(pacing.beats.length, before.pacing.beats.length, 'approved crowd actions and speech are preserved')
  assert.doesNotThrow(() => validateCinematicShot(result, scene, previousShot))
  assert.doesNotThrow(() => validateCinematicShot(result, {}, previousShot), 'paid/replay gates recover the same contract from the accepted shot')
  const request = { model: { capability: 'video' }, executionContext: { workflowId: 'wf-sanguo-history-drama', nodeId: 'sanguo-video' },
    prompt: `【本镜影视处理】live_action / story\n【场景与开场画面】${result.visualPrompt}\n【视觉处理硬约束】真人实景，保持时代服化道。\n${result.videoPrompt}`,
    params: { duration: result.duration, pacingVersion: 'duration-v2', pacing: result.pacing, scheduleHash: result.scheduleHash,
      characters: [], presentCharacters: [], initialCharacters: [], referenceImages: [], sound: 'on',
      contentContractVersion: 'cinematic-v1', continuityMode: 'scene_cut', firstFrameMode: 'reference',
      audioType: result.audioType, audioText: result.audioText, videoTimeline: result.videoPrompt, worldState: result.worldState } }
  assert.doesNotThrow(() => validateWorkflowMediaContract(request), 'anonymous performers do not require invented named portrait assets')
  const tampered = structuredClone(request)
  ;(tampered.params.pacing as { sourceBeatRequirements: Value[] }).sourceBeatRequirements[0].anchors = ['张角持碗']
  assert.throws(() => validateWorkflowMediaContract(tampered), /排程|人物身份参考/, 'empty-identity eligibility does not bypass the signed action contract')
})

function anonymousContinuation() {
  const { candidate } = fixture()
  const prior = { ...candidate, characters: [], presentCharacters: [], initialCharacters: [], enteringCharacters: [], endCharacters: [],
    worldState: { settingId: 'market', characters: [] }, storyProgress: { unitId: 'market', status: 'continuing' },
    continuity: { mode: 'scene_cut', previousShotId: '', bridgeType: 'opening', bridgeAnchor: '' } }
  const url = '/generated/verified-anonymous-tail-frame-5.jpg'
  const video = { technicalValidation: { passed: true }, speechValidation: { passed: true },
    frames: [url], lastFrameUrl: url, visualReview: { passed: true, issues: [],
      endingState: '匿名弟子仍在集市空地，百姓聚拢在一旁。', endCharacters: [], presentCharacters: [],
      worldState: { settingId: 'market', characters: [] }, endingStateEvidence: { method: 'actual-tail-image', frame: url } } }
  const next = { ...prior, id: 'market-next', firstFrameMode: 'reuse_previous_tail', visualPrompt: video.visualReview.endingState,
    continuity: { mode: 'tail_continuation', previousShotId: prior.id, bridgeType: 'same_frame', bridgeAnchor: '' } }
  return { prior, video, next, url }
}

test('anonymous crowd continuation accepts real empty identity state across writer and paid-media gates', () => {
  const { prior, video, next, url } = anonymousContinuation()
  const input = { scene: { continuityFromPrevious: true }, loop: { previous: {
    shot_script: prior, video_shot: video, last_frame: { available: true, url },
  } } }
  const projected = storyboardContinuityContext(input)
  const previous = ((projected.loop as Value).previous as Value).shot_script as Value
  assert.deepEqual(previous.presentCharacters, [])
  assert.deepEqual(previous.endCharacters, [])
  assert.deepEqual(previous.worldState, { settingId: 'market', characters: [] })
  assert.equal(cinematicContinuityIssue(next, prior, video), undefined)
  assert.equal(historicalContinuityIssue(next, { params: { referenceImage: url }, firstFrameDifference: 0.01 }, prior, video), undefined)
  assert.equal(prior.worldState.characters.length, 0)
})

test('empty-cast eligibility cannot erase an inherited named participant or fabricate observation', () => {
  const { prior, next, video } = anonymousContinuation()
  const person = { name: '张角', position: { status: 'unknown' }, heldProps: { status: 'unknown' }, pendingAction: { status: 'unknown' } }
  const namedPrior = { ...prior, characters: ['张角'], presentCharacters: ['张角'], endCharacters: ['张角'],
    worldState: { settingId: 'market', characters: [person] } }
  assert.throws(() => validateCinematicShot(next, { cast: [], continuityFromPrevious: true }, namedPrior), /missing=\["张角"\]/)
  assert.throws(() => validateCinematicShot(prior, { cast: ['张角'] }), /必须保留仍在场的具名人物/)
  assert.throws(() => validateCinematicShot({ ...prior, beatDramaturgy: [] }, { editorialRole: 'story' }), /必须保留仍在场的具名人物/)
  assert.match(String(cinematicContinuityIssue(next, prior, { ...video, lastFrameUrl: '/generated/unrelated.jpg' })), /尾帧证据/)
})
