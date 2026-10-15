import assert from 'node:assert/strict'
import test from 'node:test'
import { sceneCutEstablishmentBeat } from '../src/scene-cut-establishment.ts'
import { sceneCutStanceStartRequired } from '../src/scene-cut-t0-image-contract.ts'
import { sceneCutOpeningVisualContext } from '../server/scene-cut-opening-plan.ts'

test('already-bound straight posture is a visible t0 establishment', () => {
  const base = { kind: 'action', completion: { requiredThisClip: true,
    finalState: '严颜已缚而站直的起点及押解站位清楚可见。',
    evidenceAnchor: '严颜双腕已缚于身前，肩背挺直，停在距堂屋门槛数步的院中' } }
  assert.equal(sceneCutEstablishmentBeat(base), true)
  assert.equal(sceneCutStanceStartRequired(base), false)
  assert.equal(sceneCutEstablishmentBeat({ ...base, completion: { ...base.completion,
    evidenceAnchor: '严颜双腕已缚于身前，随后挺直身体' } }), false)
  assert.equal(sceneCutEstablishmentBeat({ ...base, completion: { ...base.completion,
    evidenceAnchor: '严颜双腕已缚于身前，随后迈步走向堂屋' } }), false)
})

test('opening projection retains established pose before a future action section', () => {
  const shot = { visualPrompt: '院中。首帧：严颜双腕已缚于身前，肩背挺直，距门槛数步。后续实拍动作锚点：三人向门槛走近。',
    camera: '侧前方全景。三人走近时跟拍。', characters: ['严颜'], pacing: { beats: [] } }
  const projected = sceneCutOpeningVisualContext(shot, 3)
  assert.match(projected.staticScene, /双腕已缚于身前，肩背挺直，距门槛数步/)
  assert.doesNotMatch(projected.staticScene, /三人向门槛走近/)
})
