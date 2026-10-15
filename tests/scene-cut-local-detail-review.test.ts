import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { A8B6_LOCAL_V8_REVIEW_IMAGE_DETAIL as detail,
  A8B6_LOCAL_V9_REVIEW_IMAGE_DETAIL as v9Detail } from
  '../src/scene-cut-a8b6-local-detail-review.ts'
import { loadReviewImages } from '../server/review-images.ts'
import { assertSceneCutReviewDetailAttachments,
  assertSceneCutReviewLedgerRecord } from
  '../server/scene-cut-frame-runtime.ts'

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const marker = { version: 'scene-cut-a8b6-local-first-frame-v8' }

test('V8 ledger details are exact native crops of the archived first-frame JPEG', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'scene-cut-local-detail-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, 'public/generated'), { recursive: true })
  const pixels = Buffer.from(Array.from({ length: 1536 * 864 * 3 },
    (_, index) => index * 17 % 251))
  const first = await sharp(pixels,
    { raw: { width: 1536, height: 864, channels: 3 } })
    .jpeg({ quality: 92 }).toBuffer()
  const context = await sharp({ create: { width: 32, height: 32,
    channels: 3, background: '#80663f' } }).jpeg().toBuffer()
  const urls = ['/generated/first.jpg', '/generated/identity.jpg',
    '/generated/reference.jpg']
  for (const [index, url] of urls.entries()) await writeFile(
    path.join(root, 'public', url.slice(1)), index === 0 ? first : context)
  const frames = await loadReviewImages(urls, root, detail)
  assert.equal(frames.length, 7)
  assert.deepEqual(frames.slice(3).map(frame => frame.sourceRect), [
    { left: 0, top: 0, width: 878, height: 494 },
    { left: 658, top: 0, width: 878, height: 494 },
    { left: 0, top: 370, width: 878, height: 494 },
    { left: 658, top: 370, width: 878, height: 494 },
  ], 'upper-right and lower-right crops cover the narrow gate wall and right pier base')
  assert.deepEqual(frames.slice(0, 3).map(frame => frame.bytes),
    [first, context, context], 'every original attachment stays unmodified')
  for (const frame of frames.slice(3)) {
    assert.equal(frame.url, urls[0])
    const nativeCrop = await sharp(first).extract(frame.sourceRect!)
      .jpeg({ quality: 90 }).toBuffer()
    assert.deepEqual(frame.bytes, nativeCrop)
  }
  const hashes = frames.map(frame => ({ url: frame.url,
    sha256: sha(frame.bytes) }))
  const attachments = frames.map((frame, index) => ({
    attachmentIndex: index, fileName: `image-${index}.jpg`, url: frame.url,
    kind: frame.kind, frameIndex: frame.frameIndex, label: frame.label,
    sourceRect: frame.sourceRect, sha256: sha(frame.bytes),
    byteLength: frame.bytes.length,
  }))
  const expected = { evidence: {}, shot: {}, sources: {}, reviewImages: urls,
    sceneCutLocalComposite: marker }
  const row = { channel: 'workflow', workflow_id: 'wf-sanguo-history-drama',
    node_id: 'sanguo-scene-cut-review', capability: 'text',
    provider: 'Codex', status: 'succeeded', id: 'model-run-v8-details',
    model_id: 'codex-local-vision',
    request_data: { fingerprint: 'a'.repeat(64), params: { ...expected,
      reviewImageDetail: detail }, reviewImageHashes: hashes },
    response_data: { raw: { provider: 'Codex', attachments } } }
  assert.equal(await assertSceneCutReviewDetailAttachments(row, expected, root), true)
  assert.equal(v9Detail, detail)
  const v9Expected = { ...expected,
    sceneCutLocalComposite: { version: 'scene-cut-a8b6-local-first-frame-v9' } }
  const v9Row = { ...row, id: 'model-run-v9-details',
    request_data: { ...row.request_data,
      params: { ...row.request_data.params,
        sceneCutLocalComposite: v9Expected.sceneCutLocalComposite,
        reviewImageDetail: v9Detail } } }
  assert.equal(await assertSceneCutReviewDetailAttachments(v9Row, v9Expected,
    root), true)
  await assert.rejects(assertSceneCutReviewDetailAttachments({ ...v9Row,
    response_data: { raw: { provider: 'Codex', attachments:
      attachments.slice(0, -1) } } }, v9Expected, root),
  /模型附件与归档首帧原像素裁片不一致/)
  assert.throws(() => assertSceneCutReviewLedgerRecord(row, {}, expected,
    root, 180), /模型实际审核图片不完整/,
  'the synchronous ledger check must not skip source-pixel recomputation')

  const withHashes = (reviewImageHashes: typeof hashes) => ({ ...row,
    request_data: { ...row.request_data, reviewImageHashes } })
  await assert.rejects(assertSceneCutReviewDetailAttachments(withHashes(
    hashes.map((entry, index) => index === 6
      ? { ...entry, sha256: '0'.repeat(64) } : entry)), expected, root),
  /附件与归档首帧原像素裁片不一致/)
  await assert.rejects(assertSceneCutReviewDetailAttachments({ ...row,
    response_data: { raw: { provider: 'Codex', attachments:
      attachments.map((entry, index) => index === 4
        ? { ...entry, sourceRect: { ...entry.sourceRect, left: 1 } }
        : entry) } } }, expected, root), /附件与归档首帧原像素裁片不一致/)
  await assert.rejects(assertSceneCutReviewDetailAttachments({ ...row,
    request_data: { ...row.request_data,
      params: { ...row.request_data.params,
        reviewImageDetail: { ...detail, overlap: 0 } } } }, expected, root),
  /局部审图配置或模型附件来源不匹配/)
  await assert.rejects(assertSceneCutReviewDetailAttachments(row,
    { ...expected, sceneCutLocalComposite: { version:
      'scene-cut-a8b6-local-first-frame-v7' } }, root),
  /局部审图配置或模型附件来源不匹配/)
  await writeFile(path.join(root, 'public/generated/first.jpg'), context)
  await assert.rejects(assertSceneCutReviewDetailAttachments(row, expected, root),
    /附件与归档首帧原像素裁片不一致/,
  'changing the archived JPEG invalidates every dependent detail')
})
