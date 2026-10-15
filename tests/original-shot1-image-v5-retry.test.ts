import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  assertFailedReviewReceipt,
  assertImageBytes,
  assertImagePromptOnlyUpgrade,
} from '../scripts/fork-original-shot1-image-retry-v5.mjs'

const sha256 = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const byteSha256 = (value: Buffer) => createHash('sha256').update(value).digest('hex')

function sceneRuns(imagePrompt: string) {
  const prefix = [{ node: { id: 'sanguo-scene-cut-opening-plan', prompt: 'approved plan' },
    loopIndex: 0, loopGroupId: 'scene-loop', loopNode: { id: 'scene-loop' } }]
  return [...prefix, ...Array.from({ length: 8 }, (_, loopIndex) => [
    { node: { id: 'sanguo-scene-cut-first-frame', prompt: imagePrompt, params: [{ id: 'same' }] },
      loopIndex, loopGroupId: 'scene-loop', loopNode: { id: 'scene-loop' } },
    { node: { id: 'sanguo-scene-cut-review', prompt: 'frozen-v174-review' },
      loopIndex, loopGroupId: 'scene-loop', loopNode: { id: 'scene-loop' } },
  ]).flat()]
}

test('schema175 accepts eight image prompt changes and freezes every review node', () => {
  const old = sceneRuns('schema174-image')
  const target = sceneRuns('schema175-image')
  assert.deepEqual(assertImagePromptOnlyUpgrade(old, target),
    { changedImagePrompts: 8, unchangedReviewPrompts: 8 })
  const changedReview = structuredClone(target)
  changedReview[2].node.prompt = 'weaker review'
  assert.throws(() => assertImagePromptOnlyUpgrade(old, changedReview), /non-image node changed/)
  const changedParam = structuredClone(target)
  changedParam[1].node.params[0].id = 'new image behavior'
  assert.throws(() => assertImagePromptOnlyUpgrade(old, changedParam), /beyond its prompt/)
  const sameImage = structuredClone(target)
  sameImage[1].node.prompt = 'schema174-image'
  assert.throws(() => assertImagePromptOnlyUpgrade(old, sameImage), /beyond its prompt/)
})

test('schema175 keeps the exact failed review and old paid image as parent evidence', () => {
  const url = '/generated/old-v4.png'
  const output = { passed: false, issues: [{ code: 'CLOSURE_PERFORMER_START_UNCONFIRMED' }],
    frame: { sourceUrl: url }, raw: { decision: 'revise' } }
  const run = { node: { id: 'sanguo-scene-cut-review' }, status: 'success', output }
  assert.equal(assertFailedReviewReceipt(run, url, sha256(output)), sha256(output))
  assert.throws(() => assertFailedReviewReceipt({ ...run, output: { ...output, issues: [] } }, url, sha256(output)), /review receipt changed/)
  assert.throws(() => assertFailedReviewReceipt(run, '/generated/new.png', sha256(output)), /review receipt changed/)
  const bytes = Buffer.from('paid v4 first frame')
  assert.equal(assertImageBytes(bytes, byteSha256(bytes)), byteSha256(bytes))
  assert.throws(() => assertImageBytes(Buffer.from('changed'), byteSha256(bytes)), /image bytes differ/)
})
