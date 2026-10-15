import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { loadCodexReferenceImages, loadCodexTextFrames } from '../server/codex-reference-images.ts'
import { reviewImagesFingerprint, REVIEW_IMAGE_LIMITS, type LoadedReviewImage } from '../server/review-images.ts'

const jpeg = async (color: string) => sharp({ create: { width: 12, height: 8, channels: 3, background: color } }).jpeg().toBuffer()
const dataUrl = (bytes: Buffer) => `data:image/jpeg;base64,${bytes.toString('base64')}`

test('uploaded reference objects become ordered, immutable Codex JPEG attachments and affect the checkpoint fingerprint', async () => {
  const first = await jpeg('#2277ee'), second = await jpeg('#ee7722')
  const sources = [{ name: '蓝猫', url: dataUrl(first) }, { name: '柴犬', url: dataUrl(second) }]
  const snapshot = await loadCodexTextFrames({ referenceImages: sources })
  assert.deepEqual(snapshot.map(frame => frame.bytes), [first, second])
  assert.deepEqual(snapshot.map(frame => frame.label), ['上传参考图 1', '上传参考图 2'])
  assert.ok(snapshot.every(frame => frame.mimeType === 'image/jpeg' && !frame.url.includes('base64')))
  assert.equal(snapshot[0].url, `upload-reference:1:${createHash('sha256').update(first).digest('hex')}`)
  const fingerprint = reviewImagesFingerprint('text-request', snapshot)
  assert.notEqual(fingerprint, 'text-request', 'new image transport cannot reuse a text-only checkpoint')
  assert.notEqual(fingerprint, reviewImagesFingerprint('text-request', await loadCodexReferenceImages(sources.toReversed())))
  assert.notEqual(fingerprint, reviewImagesFingerprint('text-request', await loadCodexReferenceImages([{ url: dataUrl(first) }, { url: dataUrl(await jpeg('#339933')) }])))
  assert.deepEqual(sources, [{ name: '蓝猫', url: dataUrl(first) }, { name: '柴犬', url: dataUrl(second) }], 'node inputs stay unchanged')
})

test('uploaded references reject unsupported sources, malformed Base64 and incomplete JPEG before Codex is invoked', async () => {
  const valid = await jpeg('#2277ee')
  const invalid = [
    'https://example.test/reference.jpg', '/generated/frame.jpg', 'data:image/png;base64,' + valid.toString('base64'),
    'data:image/jpeg;base64,@@@@', 'data:image/jpeg;base64,AB==',
    dataUrl(await sharp(valid).png().toBuffer()), dataUrl(valid.subarray(0, valid.length - 10)), { name: 'missing URL' },
  ]
  for (const source of invalid) await assert.rejects(loadCodexReferenceImages([dataUrl(valid), source]), /CODEX_REFERENCE_IMAGES_INVALID/)
  assert.deepEqual(await loadCodexReferenceImages(undefined), [])
  assert.deepEqual(await loadCodexReferenceImages([]), [])
})

test('uploaded and local review frames share the count and byte budgets while reviewImages remains local only', async () => {
  const valid = dataUrl(await jpeg('#2277ee'))
  await assert.rejects(loadCodexReferenceImages(Array(65).fill(valid)), /超过 64 张/)
  await assert.rejects(loadCodexReferenceImages([valid], Array.from({ length: 64 }, () => ({ url: '/generated/frame.jpg', bytes: Buffer.from([1]) }))), /超过 64 张/)
  const prior: LoadedReviewImage[] = Array.from({ length: 6 }, (_, index) => ({ url: `/generated/frame-${index}.jpg`, bytes: Buffer.alloc(4 * 1024 * 1024) }))
  await assert.rejects(loadCodexReferenceImages([valid], prior), /合计超过 24MiB/)
  const oversized = Buffer.concat([await jpeg('#2277ee'), Buffer.alloc(REVIEW_IMAGE_LIMITS.fileBytes)])
  await assert.rejects(loadCodexReferenceImages(dataUrl(oversized)), /单图 5MiB 上限/)
  await assert.rejects(loadCodexTextFrames({ reviewImages: [valid] }), /REVIEW_IMAGES_INVALID:.*本地 JPEG/)
})
