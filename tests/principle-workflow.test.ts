import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { upgradePrincipleQuality } from '../src/principle-workflow.ts'
import { PRINCIPLE_TEXT_REVIEW_PROMPT } from '../src/principle-text-quality.ts'
import { executeCodeNode } from '../server/code-node.ts'
import { PRINCIPLE_MEDIA_REVIEW_PROMPT } from '../src/principle-media-quality.ts'
const node = (id: string, kind: string, code = 'return {legacy:true};') => ({ id, kind, code, prompt: 'original custom wording', params: [], modelId: 'saved-model', resultVar: id })
const input = { id: 'wf-sanguo-history-drama', schemaVersion: 115, nodes: [node('sanguo-scene-outline','text'),node('sanguo-shot-script','text'),
  node('sanguo-scene-outline-review','text'),node('sanguo-scene-outline-accept','code'),node('sanguo-media-observe','text'),node('sanguo-requirement-review','text'),node('unrelated','code')] }
test('principle configuration is explicit, idempotent and leaves frozen runs/legacy code intact', async () => {
  const before = structuredClone(input), result = upgradePrincipleQuality(input)
  assert.equal(result.schemaVersion,117); assert.deepEqual(input,before); assert.equal(upgradePrincipleQuality(result),result)
  assert.equal(result.nodes[2].prompt, PRINCIPLE_TEXT_REVIEW_PROMPT); assert.equal(result.nodes[2].modelId,'saved-model')
  assert.equal(result.nodes[0].params.find(p=>p.englishName==='maxGenerationAttempts')?.value,'5')
  assert.deepEqual(result.nodes.at(-1),input.nodes.at(-1))
  const code = result.nodes[3].code
  const strict = await executeCodeNode({code,params:{},context:{}}); assert.equal(strict.legacy,true)
  const principal = await executeCodeNode({code,params:{qualityMode:'principle-v1',candidate:{id:'shot',videoPrompt:'一人走到门口'},review:{reviewUnavailable:true}},context:{}})
  assert.equal(principal.passed,true); assert.equal(principal.qualityReview.status,'needs_attention')
  assert.equal(principal.qualityReview.rawReport.reviewUnavailable,true)
  assert.deepEqual(result.nodes[4].runIf,{path:'media_metrics.requireDetailedReview',equals:true})
  assert.deepEqual(result.nodes[5].runIf,result.nodes[4].runIf)
})

test('principle migration upgrades all writer and review budgets to the requested five attempts', () => {
  const configured = (id: string, name: string, value: string) => ({ ...node(id, 'text'), params: [{ id: 'custom-' + id, name, englishName: name, value, type: 'number', required: true }] })
  const workflow = { id: input.id, schemaVersion: 116, nodes: [
    configured('sanguo-scene-outline', 'maxGenerationAttempts', '12'),
    configured('sanguo-shot-script', 'maxGenerationAttempts', 'bad'),
    configured('sanguo-scene-outline-review', 'maxReviewAttempts', '6'),
    configured('sanguo-shot-script-review', 'maxReviewAttempts', '12'),
    configured('sanguo-episode-review', 'maxReviewAttempts', '2'),
  ] }
  const before = structuredClone(workflow), result = upgradePrincipleQuality(workflow)
  const limit = (index: number, name: string) => result.nodes[index].params.find(value => value.englishName === name)
  assert.equal(limit(0, 'maxGenerationAttempts')?.value, '5')
  assert.equal(limit(0, 'maxGenerationAttempts')?.id, 'custom-sanguo-scene-outline')
  assert.equal(limit(1, 'maxGenerationAttempts')?.value, '5')
  assert.equal(limit(2, 'maxReviewAttempts')?.value, '5')
  assert.equal(limit(3, 'maxReviewAttempts')?.value, '5')
  assert.equal(limit(4, 'maxReviewAttempts')?.value, '5')
  assert.equal(result.schemaVersion, 117)
  assert.equal(upgradePrincipleQuality(result), result)
  assert.deepEqual(workflow, before)
  for (const id of ['sanguo-scene-outline', 'sanguo-shot-script']) {
    for (const [value, expected] of [['4', '5'], ['5', '5'], ['8', '5'], ['20', '5'], ['99', '5']]) {
      const migrated = upgradePrincipleQuality({ id: input.id, schemaVersion: 116, nodes: [configured(id, 'maxGenerationAttempts', value)] })
      assert.equal(migrated.nodes[0].params.find(param => param.englishName === 'maxGenerationAttempts')?.value, expected, `${id}: ${value}`)
      assert.equal(upgradePrincipleQuality(migrated), migrated)
    }
  }
})

test('principle video migration explicitly carries reference policy while preserving the saved request contract', () => {
  const video = { ...node('sanguo-video', 'video'), params: [{ id: 'refs', name: 'referenceImages', englishName: 'referenceImages',
    type: 'images', required: false, value: '${first_frame_branch.referenceRequest.referenceImages}' }] }
  const workflow = { id: input.id, schemaVersion: 116, nodes: [video, node('unrelated-video', 'video')] }
  const before = structuredClone(workflow), migrated = upgradePrincipleQuality(workflow)
  assert.deepEqual(workflow, before)
  assert.deepEqual(migrated.nodes[0].params[0], video.params[0])
  assert.equal(migrated.nodes[0].params.find(value => value.englishName === 'qualityMode')?.value, 'principle-v1')
  assert.deepEqual(migrated.nodes[1], workflow.nodes[1])
  assert.equal(upgradePrincipleQuality(migrated), migrated)
})

test('same-schema saved media policy refreshes its managed block and source prompt without changing legacy code or frozen input', async () => {
  const staleCode = '// PRINCIPLE_POLICY_START\nif (params.qualityMode === "principle-v1") return {oldFrameOnlyGate:true};\n// PRINCIPLE_POLICY_END\nreturn {customStrictGate:true};'
  const workflow = { id: input.id, schemaVersion: 116, nodes: [node('sanguo-media-accept', 'code', staleCode), node('sanguo-media-review', 'text')] }
  const before = structuredClone(workflow), migrated = upgradePrincipleQuality(workflow)
  assert.equal(migrated.schemaVersion, 117)
  assert.ok(migrated.nodes[1].prompt.startsWith(PRINCIPLE_MEDIA_REVIEW_PROMPT.split('只判断成片')[0]))
  assert.match(migrated.nodes[1].prompt, /duration-v2的必需节拍、先后顺序与收尾余量/)
  assert.match(migrated.nodes[1].prompt, /duration-v2逐节拍完成证据/)
  assert.equal(migrated.nodes[0].code.includes('oldFrameOnlyGate'), false)
  assert.equal(migrated.nodes[0].code.split('// PRINCIPLE_POLICY_START').length - 1, 1)
  assert.equal(upgradePrincipleQuality(migrated), migrated)
  assert.deepEqual(workflow, before)
  const strict = await executeCodeNode({ code: migrated.nodes[0].code, params: {}, context: {} })
  assert.equal(strict.customStrictGate, true)
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/principle-media-fuik-era.json', import.meta.url), 'utf8'))
  Object.assign(fixture.context.media_review.issues[0].evidence, fixture.verifiedSourceProof)
  fixture.context.shot_script.pacing.version = 'dynamic-v1'
  const accepted = await executeCodeNode({ code: migrated.nodes[0].code, params: { qualityMode: 'principle-v1' }, context: fixture.context })
  assert.equal(accepted.passed, false)
  assert.equal(accepted.qualityReview.principleIssues[0].code, 'historical_era')
})

test('principle media accept cannot bypass duration-v2 completion evidence', async () => {
  const workflow = upgradePrincipleQuality({ id: input.id, schemaVersion: 158,
    nodes: [node('sanguo-media-accept', 'code'), node('sanguo-media-request', 'code')] })
  const acceptCode = workflow.nodes[0].code
  const shot = { duration: 9, pacing: { version: 'duration-v2', scheduleHash: 'active-schedule', timingPolicy: { endingReadabilityReserve: .5 },
    beats: [{ id: 'bind', sourceBeatId: 'source-bind', kind: 'action', actorIds: ['guard'], dependsOn: [],
      completion: { requiredThisClip: true, finalState: '双腕绑好', modality: 'visual' }, timingConstraint: { mode: 'reference' } }],
    schedule: [{ beatId: 'bind', sourceBeatId: 'source-bind', timingConstraint: { mode: 'reference' } }] } }
  const context = { shot_script: shot, video_take: { url: '/generated/active.mp4', params: { scheduleHash: 'active-schedule' } },
    video_evidence: { url: '/generated/active.mp4', originalUrl: '/generated/active.mp4', evidenceUrl: '/generated/active.json',
      duration: 9, decoded: true, frameTimes: [0, 8.9], frames: ['/generated/first.jpg', '/generated/last.jpg'] },
    media_review: { decision: 'pass', issues: [] } }
  const result = await executeCodeNode({ code: acceptCode, params: { qualityMode: 'principle-v1' }, context })
  assert.equal(result.passed, false)
  assert.equal(result.durationCompletion.assessment, 'uncertain')
  assert.ok(result.durationCompletion.remainingMandatoryBeats.includes('bind'))
  const staleVideo = await executeCodeNode({ code: acceptCode, params: { qualityMode: 'principle-v1' },
    context: { ...context, video_take: { ...context.video_take, params: { scheduleHash: 'stale' } } } })
  assert.match(staleVideo.routeError, /DURATION_CONTRACT_INVALID/)
})

test('schema 163 hydration retains the native sequence transport in the active principle branch', () => {
  const workflow = { id: input.id, schemaVersion: 163,
    nodes: [node('sanguo-media-metrics', 'code'), node('sanguo-media-review', 'text')] }
  const upgraded = upgradePrincipleQuality(workflow)
  assert.match(upgraded.nodes[0].code, /NATIVE_PRINCIPLE_SEQUENCE_GRID_SCHEMA163/)
  assert.equal(upgraded.nodes[1].params.find(param => param.englishName === 'reviewImageDetail')?.value,
    '${media_metrics.nativeReviewImageDetail}')
  assert.equal(upgradePrincipleQuality(upgraded), upgraded)
})
