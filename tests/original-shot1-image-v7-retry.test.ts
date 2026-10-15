import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { SCENE_CUT_FIRST_FRAME_PROMPT_V177 } from '../src/scene-cut-controlled-edit-prompt.ts'
import { assertV7ImagePromptOnlyUpgrade, buildV7ImageRetryQueue,
  sceneCutImageRepairMarker } from '../scripts/fork-original-shot1-image-retry-v7.mjs'

const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')
const jsonSha = (value: unknown) => digest(JSON.stringify(value))
const sourceId = 'record-4x5m31-original-repair-v6'
const sourceMd5 = '21f1f7a2131fe7c3d0e97998d16245a3'
const imageSha = '2592c8f00f59d4511c85bdf9bf13fc67f539eb49ea4f91ee7780704626df5f73'
const reviewSha = 'd4a00dbe88ea9a5dabd6cfea6be4e8a2633a3da30f162440a908ddcddf6ee7dc'

function queues() {
  const prefix = Array.from({ length: 45 }, (_, index) => ({
    id: `accepted-${index}`, node: { id: `accepted-node-${index}`, prompt: 'locked' },
    status: 'success', loopIndex: 0, loopGroupId: 'scene-loop',
    loopNode: { id: 'scene-loop' }, output: { sourceIndex: index },
  }))
  const suffix = Array.from({ length: 8 }, (_, loopIndex) => [
    { id: `image-${loopIndex}`, node: { id: 'sanguo-scene-cut-first-frame',
      prompt: 'schema176 image', params: [{ id: 'frozen-param' }] },
    status: loopIndex === 0 ? 'success' : 'idle', loopIndex,
    loopGroupId: 'scene-loop', loopNode: { id: 'scene-loop' } },
    { id: `review-${loopIndex}`, node: { id: 'sanguo-scene-cut-review',
      prompt: 'schema174 independent review' },
    status: loopIndex === 0 ? 'success' : 'idle', loopIndex,
    loopGroupId: 'scene-loop', loopNode: { id: 'scene-loop' } },
  ]).flat()
  const source = [...prefix, ...suffix]
  const target = structuredClone(source)
  for (const run of target.slice(45)) {
    run.status = 'idle'
    if (run.node.id === 'sanguo-scene-cut-first-frame') run.node.prompt = SCENE_CUT_FIRST_FRAME_PROMPT_V177
  }
  return { source, target }
}

test('schema177 forks at index45 with exactly the original completed prefix and a fully idle suffix', () => {
  const { source, target } = queues()
  assert.deepEqual(assertV7ImagePromptOnlyUpgrade(source, target),
    { changedImagePrompts: 8, unchangedReviewPrompts: 8 })
  const { nodeRuns } = buildV7ImageRetryQueue(source, target)
  assert.deepEqual(nodeRuns.slice(0, 45), source.slice(0, 45))
  assert.deepEqual(nodeRuns.slice(45), target.slice(45))
  assert.equal(nodeRuns[45].node.id, 'sanguo-scene-cut-first-frame')
  assert.equal(nodeRuns[45].status, 'idle')
  assert.ok(nodeRuns.slice(45).every(run => run.status === 'idle'))

  const changedReviewer = structuredClone(target)
  changedReviewer[46].node.prompt = 'weaker reviewer'
  assert.throws(() => buildV7ImageRetryQueue(source, changedReviewer), /non-image node changed/)
  const changedImageParam = structuredClone(target)
  changedImageParam[45].node.params[0].id = 'different-ref-source'
  assert.throws(() => buildV7ImageRetryQueue(source, changedImageParam), /beyond the managed prompt/)
  const changedPrefix = structuredClone(target)
  changedPrefix[44].node.prompt = 'rewritten accepted shot'
  assert.throws(() => buildV7ImageRetryQueue(source, changedPrefix), /non-image node changed/)
  const staleImage = structuredClone(target)
  staleImage[45].node.prompt = 'schema176 image'
  assert.throws(() => buildV7ImageRetryQueue(source, staleImage), /beyond the managed prompt/)
  const activeSuffix = structuredClone(target)
  activeSuffix[45].status = 'running'
  assert.throws(() => buildV7ImageRetryQueue(source, activeSuffix), /suffix is not idle/)
})

function preparedReference() {
  const third = Buffer.from('third-reference-jpeg-for-receipt')
  const receipt = {
    version: 'scene-cut-rejected-image-edit-reference-v1', role: 'reference-only',
    sourceVerdict: 'rejected', approvedFirstFrame: false,
    requiresFreshIndependentReview: true,
    sourceExecutionId: sourceId, sourceResultMd5: sourceMd5,
    sourceImageSha256: imageSha, failedReviewOutputSha256: reviewSha,
    referenceOrder: [{ position: 1 }, { position: 2 },
      { position: 3, role: 'rejected-edit-source', sourceSha256: imageSha,
        jpegSha256: digest(third), bytes: third.length }],
  }
  return { receipt, receiptSha256: jsonSha(receipt),
    referenceImages: ['first-identity-board', 'second-identity-board',
      `data:image/jpeg;base64,${third.toString('base64')}`] }
}

function markerInput(prepared = preparedReference()) {
  return { sourceId, sourceMd5, parentId: 'record-4x5m31-original-repair-v5',
    parentMd5: 'b5ac0f516ad8a44ca175e506aaccc67d', originalId: 'record-4x5m31',
    originalMd5: '74e5e2f8afcf8f829694aef350629950',
    workflow: { schema_version: 177, nodes_md5: '66403a851ef7b3abba0dfa836d6727c1',
      edges_md5: '1d0a75acb3d4778a122a4cfd96a23b49' },
    prefixOutputsHash: 'c'.repeat(64), prepared }
}

test('repair marker embeds the exact rejected-image receipt and schema177 parent/prefix hashes', () => {
  const input = markerInput()
  const marker = sceneCutImageRepairMarker(input)
  assert.equal(marker.version, 'scene-cut-image-repair-schema177-fork-v1')
  assert.equal(marker.sourceExecutionId, sourceId)
  assert.equal(marker.sourceResultMd5, sourceMd5)
  assert.equal(marker.workflowSchemaVersion, 177)
  assert.equal(marker.preservedPrefixLength, 45)
  assert.equal(marker.firstPendingNodeId, 'sanguo-scene-cut-first-frame')
  assert.equal(marker.failedImageFileSha256, imageSha)
  assert.equal(marker.failedReviewOutputSha256, reviewSha)
  assert.equal(marker.repairPreparationSha256, input.prepared.receiptSha256)
  assert.deepEqual(marker.receipt, input.prepared.receipt)

  const changedThird = structuredClone(input.prepared)
  changedThird.referenceImages[2] = `data:image/jpeg;base64,${Buffer.from('tampered').toString('base64')}`
  assert.throws(() => sceneCutImageRepairMarker(markerInput(changedThird)), /third reference JPEG differs/)
  const changedReview = structuredClone(input.prepared)
  changedReview.receipt.failedReviewOutputSha256 = 'f'.repeat(64)
  changedReview.receiptSha256 = jsonSha(changedReview.receipt)
  assert.throws(() => sceneCutImageRepairMarker(markerInput(changedReview)), /receipt or parent chain changed/)
  const changedSource = { ...input, sourceMd5: '0'.repeat(32) }
  assert.throws(() => sceneCutImageRepairMarker(changedSource), /receipt or parent chain changed/)
})
