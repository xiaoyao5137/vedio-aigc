import test from 'node:test'
import assert from 'node:assert/strict'
import { sceneCutStanceStartRequired } from '../src/scene-cut-t0-image-contract.ts'

test('another actor standing still as a prerequisite does not require the mover to start bent', () => {
  assert.equal(sceneCutStanceStartRequired({ kind: 'action', actorIds: ['张飞'],
    completion: { requiredThisClip: true, modality: 'visual',
      evidenceAnchor: '张飞向严颜走近一步。起步发生在严颜与两名军士全部收步站稳之后。',
      finalState: '张飞完成一步靠近。' } }), false)
})
import { deriveSceneCutOpeningPlan, sceneCutOpeningVisualContext } from '../server/scene-cut-opening-plan.ts'

test('image-only opening removes a completed binding phrase before a tightening beat', () => {
  const shot = { visualPrompt: '院落。首帧为单一时刻：严颜站在院中，双腕已缚于身前；军士在近旁。后续连续动作：军士收紧绳结。',
    camera: '平视侧前方中全景。随后跟移。', characters: ['严颜'],
    pacing: { beats: [{ id: 'knot', kind: 'action', completion: {
      requiredThisClip: true, evidenceAnchor: '军士收紧严颜腕间绳结' } }] } }
  const approved = sceneCutOpeningVisualContext(shot, 2)
  const image = sceneCutOpeningVisualContext(shot, 3)
  assert.match(approved.staticScene, /双腕已缚于身前/)
  assert.doesNotMatch(image.staticScene, /已缚/)
  assert.match(image.staticScene, /双腕并置于身前/)
  assert.equal(image.openingCamera, '平视侧前方中全景。')
})

test('visible straightening reaction enters the same zero-second plan as actions', () => {
  const shot = { id: 'scene-01', continuity: { mode: 'scene_cut' }, visualTreatment: 'live_action',
    visualPrompt: '院落。首帧：严颜站在院中，双腕已缚于身前。后续动作：军士收紧绳结。',
    camera: '平视侧前方中全景。', characters: ['严颜'],
    pacing: { beats: [
      { id: 'knot', kind: 'action', completion: { requiredThisClip: true,
        modality: 'visual', evidenceAnchor: '军士收紧严颜腕间绳结' } },
      { id: 'straighten', kind: 'reaction', completion: { requiredThisClip: true,
        modality: 'visual', evidenceAnchor: '严颜站直身体' } },
      { id: 'speech', kind: 'speech', completion: { requiredThisClip: true,
        modality: 'audio', evidenceAnchor: '严颜说话' } },
    ], schedule: [{ beatId: 'knot', startSecond: 0 },
      { beatId: 'straighten', startSecond: 2 }, { beatId: 'speech', startSecond: 3 }] } }
  const plan = deriveSceneCutOpeningPlan(shot, 3)
  assert.deepEqual(plan.requiredVisualActions.map(item => item.beatId), ['knot', 'straighten'])
  assert.ok(plan.requiredVisualActions[1].categories.includes('stance_straightening'))
  assert.match(plan.positiveOpeningDescription, /前倾/)
})

test('v4 still projection removes a completed wrist binding without changing the approved shot', () => {
  const shot = { id: 'scene-01', continuity: { mode: 'scene_cut' }, visualTreatment: 'live_action',
    visualPrompt: '江州外院。首帧为单一时刻：严颜在外院站立，双腕在身前已有绳索束缚，两名军士在旁；后续动作：收紧腕间绳结。',
    camera: '侧面中全景。', characters: ['严颜'],
    pacing: { beats: [{ id: 'bind', kind: 'action', completion: { requiredThisClip: true,
      modality: 'visual', evidenceAnchor: '军士收紧严颜腕间绳结' } }],
    schedule: [{ beatId: 'bind', startSecond: 0 }] } }
  const legacy = deriveSceneCutOpeningPlan(shot, 3)
  const repaired = deriveSceneCutOpeningPlan(shot, 4)
  assert.match(legacy.openingVisualContext.staticScene, /已有绳索束缚/)
  assert.doesNotMatch(repaired.openingVisualContext.staticScene, /已有绳索束缚/)
  assert.match(repaired.openingVisualContext.staticScene, /绳圈尚宽松敞开/)
  assert.equal(repaired.shotSha256, legacy.shotSha256)
  assert.deepEqual(repaired.requiredVisualActions, legacy.requiredVisualActions)
})
