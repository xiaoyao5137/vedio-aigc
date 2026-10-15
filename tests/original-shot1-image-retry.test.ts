import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  assertImageReviewPromptOnlyUpgrade,
  assertV4IdentityBoardBytes,
} from '../scripts/fork-original-shot1-image-retry.mjs'

const sha256 = (value: Buffer) => createHash('sha256').update(value).digest('hex')

function imageReviewRuns(promptVersion: string) {
  const prefix = [{ node: { id: 'approved-shot', prompt: 'frozen' },
    loopIndex: 0, loopGroupId: 'scene-loop', loopNode: { id: 'scene-loop' } }]
  return [...prefix, ...Array.from({ length: 8 }, (_, loopIndex) => [
    { node: { id: 'sanguo-scene-cut-first-frame', prompt: `image-${promptVersion}`,
      params: [{ id: 'same-image-param' }] }, loopIndex, loopGroupId: 'scene-loop',
    loopNode: { id: 'scene-loop' } },
    { node: { id: 'sanguo-scene-cut-review', prompt: `review-${promptVersion}`,
      params: [{ id: 'same-review-param' }] }, loopIndex, loopGroupId: 'scene-loop',
    loopNode: { id: 'scene-loop' } },
    { node: { id: 'sanguo-video', prompt: 'unchanged', params: [] }, loopIndex,
      loopGroupId: 'scene-loop', loopNode: { id: 'scene-loop' } },
  ]).flat()]
}

test('schema173 image retry accepts only both prompt changes in all eight rounds', () => {
  const old = imageReviewRuns('v172')
  const updated = imageReviewRuns('v173')
  assert.deepEqual(assertImageReviewPromptOnlyUpgrade(old, updated, 1),
    { changedImagePrompts: 8, changedReviewPrompts: 8 })
  const changedParam = structuredClone(updated)
  changedParam[1].node.params[0].id = 'other-image-param'
  assert.throws(() => assertImageReviewPromptOnlyUpgrade(old, changedParam, 1), /changed more than/)
  const changedVideo = structuredClone(updated)
  changedVideo[3].node.prompt = 'new-video-contract'
  assert.throws(() => assertImageReviewPromptOnlyUpgrade(old, changedVideo, 1), /unexpected node change/)
  const unchangedReview = structuredClone(updated)
  unchangedReview[2].node.prompt = 'review-v172'
  assert.throws(() => assertImageReviewPromptOnlyUpgrade(old, unchangedReview, 1), /prompt did not change/)
  const reordered = structuredClone(updated)
  ;[reordered[1], reordered[2]] = [reordered[2], reordered[1]]
  assert.throws(() => assertImageReviewPromptOnlyUpgrade(old, reordered, 1), /topology/)
})

test('v4 identity board receipts bind each retained JPEG byte stream to its URL', () => {
  const bytes = [Buffer.from('first-identity-plate'), Buffer.from('second-identity-plate')]
  const archive = {
    identityPlateVersion: 'scene-cut-identity-plate-v4',
    referenceBindings: bytes.map(value => ({
      identityPlateVersion: 'scene-cut-identity-plate-v4',
      frontSha256: sha256(value),
      frontUrl: `/generated/scene-cut-front-${sha256(value)}.jpg`,
    })),
    imageReferenceImages: bytes.map(value => `data:image/jpeg;base64,${value.toString('base64')}`),
  }
  assert.deepEqual(assertV4IdentityBoardBytes(archive), bytes.map(value => ({
    frontSha256: sha256(value), bytes: value.length,
  })))
  const altered = structuredClone(archive)
  altered.imageReferenceImages[0] = `data:image/jpeg;base64,${Buffer.from('tampered').toString('base64')}`
  assert.throws(() => assertV4IdentityBoardBytes(altered), /byte receipt differs/)
  const changedURL = structuredClone(archive)
  changedURL.referenceBindings[1].frontUrl = '/generated/other.jpg'
  assert.throws(() => assertV4IdentityBoardBytes(changedURL), /byte receipt differs/)
})
