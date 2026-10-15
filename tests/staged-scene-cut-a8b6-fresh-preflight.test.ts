import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { assertA8B6FreshCandidateNotHistorical,
  assertA8B6FreshRejectGate, assertA8B6OriginalNarration } from
  '../server/staged-scene-cut-a8b6-fresh-preflight.mjs'

const SHA = 'a'.repeat(64)
const receiptSha = 'b'.repeat(64)
const oldImageSha = '1d400ca2ab2b74b93fae1dd100d5aa1a274aa1875c25c940ab8efa85ac2dde2d'
const parentId = 'record-4x5m31-a8b6-frame-reuse-v3'
const parentMd5 = '01146ea0d4a7c0d6664f65d5eb9bc54e'
const retryId = 'record-4x5m31-a8b6-frame-conflict-review-v1'
const planId = 'edd1d9d046a5ed5eb7cd8dc1a0bde1de276f819fb04279297b2cf4d89208f016'
const canonical = (value: unknown): string => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.entries(value).filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`
    : JSON.stringify(value ?? null)
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')

function rejectedFixture() {
  const parentRuns = Array.from({ length: 464 }, (_, index) => ({
    node: { id: index === 49 ? 'sanguo-scene-cut-review' : `node-${index}` },
    status: 'idle' as string, output: undefined as unknown,
  }))
  parentRuns[49] = { ...parentRuns[49], status: 'success',
    output: { passed: false,
      issues: [{ code: 'wardrobe_hem_proportion_mismatch' }] } }
  const retryRuns = structuredClone(parentRuns)
  retryRuns[49] = { ...retryRuns[49], status: 'success',
    output: { passed: false,
      issues: [{ code: 'identity_facial_hair_age_drift' },
        { code: 'inner_hem_proportion_mismatch' }] } }
  const conflict = { receiptSha256: receiptSha, receipt: {
    qaPlanId: planId, rejectedExecutionId: parentId,
    rejectedResultMd5: parentMd5, sourceImageSha256: oldImageSha,
    modelExecutionId: 'model-run-conflict', rejectedReviewSha256: SHA,
  } }
  const parent = { id: parentId, requestScopeId: 'scope', workflowId: 'workflow',
    nodeRuns: parentRuns }
  const retry = { id: retryId, parentExecutionId: parentId,
    generationScopeId: retryId, requestScopeId: 'scope', workflowId: 'workflow',
    nodeRuns: retryRuns, sceneCutA8B6ConflictReviewRecovery: {
      version: 'scene-cut-a8b6-conflict-review-retry-v1', qaPlanId: planId,
      sourceExecutionId: parentId, sourceResultMd5: parentMd5,
      workflowSchemaVersion: 180,
      workflowNodesMd5: '3ed9cf16e56b311458f4c6fa7e7f1e2e',
      workflowEdgesMd5: '1d0a75acb3d4778a122a4cfd96a23b49',
      adjudicationReceiptSha256: receiptSha,
      adjudicationModelExecutionId: 'model-run-conflict',
      rejectedReviewSha256: SHA, originalImageSha256: oldImageSha,
      preservedPrefixLength: 49,
      preservedPrefixSha256: hash(parentRuns.slice(0, 49)),
      firstPendingIndex: 49, firstPendingNodeId: 'sanguo-scene-cut-review',
    } }
  return { parent, retry, conflict }
}

test('fresh fallback opens only after the exact identity and hem rejection', () => {
  const { parent, retry, conflict } = rejectedFixture()
  assert.deepEqual(assertA8B6FreshRejectGate(parent, retry, parentMd5, conflict)
    .rejectionIssues, ['identity_facial_hair_age_drift',
    'inner_hem_proportion_mismatch'])
  retry.nodeRuns[49].status = 'idle'
  assert.throws(() => assertA8B6FreshRejectGate(parent, retry, parentMd5, conflict),
    /has not produced the exact independent identity\/hem rejection/)
})

test('fallback rejects changed historical prefix and an unrelated review issue', () => {
  const { parent, retry, conflict } = rejectedFixture()
  retry.nodeRuns[45].status = 'failed'
  assert.throws(() => assertA8B6FreshRejectGate(parent, retry, parentMd5, conflict),
    /has not produced/)
  retry.nodeRuns[45] = structuredClone(parent.nodeRuns[45])
  retry.nodeRuns[49].output = { passed: false, issues: [{ code: 'wrong_actor' }] }
  assert.throws(() => assertA8B6FreshRejectGate(parent, retry, parentMd5, conflict),
    /has not produced/)
})

test('three original WAVs keep exact 14 second approved narration windows', () => {
  const windows = [[0, 2.5], [2.5, 7.1], [9.5, 11.75]]
  const tracks = windows.map(([start, end], index) => ({
    beatId: `b01-narration-${index + 1}`, start, end,
    url: `/generated/track-${index + 1}.wav`, sha256: SHA,
    text: `line-${index + 1}`, voiceId: 'original-voice',
  }))
  const speech = windows.map(([start, end]) => ({ start, end }))
  assert.equal(assertA8B6OriginalNarration(tracks, structuredClone(tracks),
    speech, '/tmp', () => SHA).length, 3)
  assert.throws(() => assertA8B6OriginalNarration(tracks,
    tracks.map((track, index) => index === 2 ? { ...track, text: 'changed' } : track),
    speech, '/tmp', () => SHA), /original narration recipe differs/)
  assert.throws(() => assertA8B6OriginalNarration(tracks, tracks,
    speech, '/tmp', () => 'c'.repeat(64)), /WAV\/text\/window changed/)
})

test('future fresh candidate cannot inherit old A or B bytes, task or URL', () => {
  const preflight = { forbiddenSources: [
    { sha256: oldImageSha, url: '/generated/old.png' },
    { sha256: '1'.repeat(64), url: '/generated/old-13.mp4' },
    { sha256: '2'.repeat(64), url: '/generated/old-A.mp4', taskId: 'old-A' },
    { sha256: '3'.repeat(64), url: '/generated/old-B.mp4', taskId: 'old-B' },
    { sha256: '4'.repeat(64), url: '/generated/qa-picture.mp4' },
    { sha256: '5'.repeat(64), url: '/generated/qa-narrated.mp4' },
  ] }
  const fresh = { firstFrameSha256: '6'.repeat(64),
    phaseA: { taskId: 'new-A', videoUrl: '/generated/new-A.mp4',
      videoSha256: '7'.repeat(64) },
    phaseB: { taskId: 'new-B', videoUrl: '/generated/new-B.mp4',
      videoSha256: '8'.repeat(64) } }
  assert.equal(assertA8B6FreshCandidateNotHistorical(preflight, fresh), true)
  assert.throws(() => assertA8B6FreshCandidateNotHistorical(preflight,
    { ...fresh, phaseA: { ...fresh.phaseA, videoSha256: '2'.repeat(64) } }),
  /reuses historical image\/video bytes/)
  assert.throws(() => assertA8B6FreshCandidateNotHistorical(preflight,
    { ...fresh, phaseB: { ...fresh.phaseB, taskId: 'old-B' } }),
  /reuses a historical provider task/)
})
