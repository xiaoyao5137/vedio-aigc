import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  assertFreshA8B6JpegReviewRecovery,
  buildFreshA8B6ReviewEvidenceV2,
  readFreshA8B6ReviewRecoveryArtifact,
  saveFreshA8B6ReviewRecoveryArtifact,
  verifyFreshA8B6ApprovedReferenceBytes,
} from '../server/staged-scene-cut-a8b6-fresh-review.mjs'

const sha = (bytes: string | Buffer) => createHash('sha256')
  .update(bytes).digest('hex')
const planId = 'a'.repeat(64)
const videoSha256 = 'b'.repeat(64)
const originalSha256 = 'c'.repeat(64)
const transportSha256 = 'd'.repeat(64)
const nativeSha256 = 'e'.repeat(64)
const evidenceSha256 = 'f'.repeat(64)
const original = { kind: 'approved-new-first-frame', phase: 'CERT',
  frameIndex: -1, url: '/generated/V9.png', sha256: originalSha256 }
const native = { kind: 'provider-native-frame', phase: 'A', frameIndex: 192,
  url: '/generated/A-f192.jpg', sha256: nativeSha256,
  sourceVideoSha256: videoSha256 }
const evidence = { version: 'staged-a8b6-fresh-native-review-evidence-v1',
  planId, phase: 'A', taskId: '934036356547235843', videoSha256,
  mediaSha256: '1'.repeat(64), nativeFrameDigestSha256: '2'.repeat(64),
  frames: [original, native],
  reviewImages: [original.url, native.url] }
const reference = { ...original, url: '/generated/V9-compact.jpg',
  sha256: transportSha256,
  sourceOriginal: { url: original.url, sha256: originalSha256 } }
const requestKey = `staged-a8b6-fresh:${planId}:A:${videoSha256}:old-uuid`
const intent = { version: 'staged-a8b6-fresh-model-review-intent-v1',
  planId, phase: 'A', videoSha256, evidenceSha256,
  modelId: 'codex-local-vision', requestKey }
const failed = { id: 'model-run-format-error', channel: 'workflow',
  workflow_id: 'wf-sanguo-history-drama',
  node_id: 'staged-a8b6-fresh-phase-review',
  model_id: 'codex-local-vision', capability: 'text', provider: 'Codex',
  status: 'failed',
  error: 'REVIEW_IMAGES_INVALID: 审查只接受 /generated/ 下的本地 JPEG 帧',
  request_data: { operation: 'history.media-review', requestKey,
    prompt: `计划=${planId}，阶段=A，视频SHA256=${videoSha256}。附件顺序：CERT:f-1:${originalSha256}。`,
    params: { reviewImages: evidence.reviewImages } },
  response_data: {} }

test('v2 recovery replaces only CERT transport and preserves signed PNG source', () => {
  const v2 = buildFreshA8B6ReviewEvidenceV2(evidence,
    evidenceSha256, reference)
  assert.equal(v2.version, 'staged-a8b6-fresh-native-review-evidence-v2')
  assert.equal(v2.priorV1EvidenceSha256, evidenceSha256)
  assert.deepEqual(v2.frames[0], reference)
  assert.deepEqual(v2.frames[1], native)
  assert.deepEqual(v2.reviewImages, [reference.url, native.url])
  assert.throws(() => buildFreshA8B6ReviewEvidenceV2(evidence,
    evidenceSha256, { ...reference, sourceOriginal: {
      url: original.url, sha256: '0'.repeat(64) } }),
  /requires signed v1 PNG reference/)
})

test('JPEG retry requires unique exact failed format ledger and no model success', () => {
  const input = { intent, intentSha256: '3'.repeat(64),
    evidence, evidenceSha256, rows: [failed],
    modelId: 'codex-local-vision' }
  const bound = assertFreshA8B6JpegReviewRecovery(input)
  assert.equal(bound.failedModelExecutionId, failed.id)
  assert.equal(bound.failure, failed.error)
  assert.equal(bound.priorV1EvidenceSha256, evidenceSha256)
  for (const row of [
    { ...failed, status: 'succeeded' },
    { ...failed, error: 'provider timeout' },
    { ...failed, request_data: { ...failed.request_data,
      params: { reviewImages: [reference.url, native.url] } } },
  ]) assert.throws(() => assertFreshA8B6JpegReviewRecovery({ ...input,
    rows: [row] }), /failed ledger is not the exact JPEG-only preflight error/)
  assert.throws(() => assertFreshA8B6JpegReviewRecovery({ ...input,
    rows: [failed, { ...failed, id: 'model-run-another' }] }),
  /exactly one prior failed model ledger/)
})

test('v2 recovery evidence and intent files are signed and immutable', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'a8b6-review-recovery-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, '.runtime'), { recursive: true })
  await writeFile(path.join(root, '.runtime/staged-scene-cut.key'),
    Buffer.alloc(32, 7))
  const name = 'phase-A-review-evidence-v2.json'
  const body = buildFreshA8B6ReviewEvidenceV2(evidence,
    evidenceSha256, reference)
  const saved = await saveFreshA8B6ReviewRecoveryArtifact(planId,
    name, body, root)
  const read = await readFreshA8B6ReviewRecoveryArtifact(planId,
    name, root)
  assert.equal(saved.sha256, read.sha256)
  assert.equal(read.value.priorV1EvidenceSha256, evidenceSha256)
  await assert.rejects(() => saveFreshA8B6ReviewRecoveryArtifact(planId,
    name, { ...body, videoSha256: '0'.repeat(64) }, root),
  /existing recovery artifact differs/)
  const filename = path.join(root, '.runtime/staged-scene-cut-a8b6-fresh',
    planId, name)
  const changed = JSON.parse((await readFile(filename)).toString('utf8'))
  changed.frames[0].sha256 = '0'.repeat(64)
  await writeFile(filename, JSON.stringify(changed, null, 2) + '\n')
  await assert.rejects(() => readFreshA8B6ReviewRecoveryArtifact(planId,
    name, root), /signature changed/)
  assert.notEqual(sha(await readFile(filename)), saved.sha256)
})

test('CERT validates both compact JPEG and original V9 PNG byte hashes', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'a8b6-cert-dual-sha-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, 'public/generated'), { recursive: true })
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2])
  await writeFile(path.join(root, 'public/generated/V9-compact.jpg'), jpeg)
  await writeFile(path.join(root, 'public/generated/V9.png'), png)
  const bound = { ...reference, sha256: sha(jpeg),
    sourceOriginal: { url: original.url, sha256: sha(png) } }
  assert.equal(await verifyFreshA8B6ApprovedReferenceBytes(bound, root), true)
  await writeFile(path.join(root, 'public/generated/V9.png'),
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 3, 4]))
  await assert.rejects(() => verifyFreshA8B6ApprovedReferenceBytes(
    bound, root), /original V9 PNG bytes changed/)
  await writeFile(path.join(root, 'public/generated/V9.png'), png)
  await writeFile(path.join(root, 'public/generated/V9-compact.jpg'),
    Buffer.from([0xff, 0xd8, 0xff, 0xd8]))
  await assert.rejects(() => verifyFreshA8B6ApprovedReferenceBytes(
    bound, root), /compact JPEG or original V9 PNG bytes changed/)
})
