import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import sharp from 'sharp'
import { loadReviewImages, reviewImageContentBlocks, reviewImagesFingerprint, REVIEW_IMAGE_LIMITS, REVIEW_SEQUENCE_LIMITS } from '../server/review-images.ts'

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'review-images-'))
  await mkdir(path.join(root, 'public/generated'), { recursive: true })
  t.after(() => rm(root, { recursive: true, force: true }))
  const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#274060' } }).jpeg().toBuffer()
  const save = async (name: string, bytes = jpeg) => {
    await writeFile(path.join(root, 'public/generated', name), bytes)
    return `/generated/${name}`
  }
  return { root, jpeg, save }
}

test('all 64 ordered JPEG frames reach the request, including frame 8 and the final frame', async t => {
  const { root, jpeg, save } = await fixture(t)
  const urls = await Promise.all(Array.from({ length: 64 }, (_, i) => save(`frame-${i}.jpg`)))
  const frames = await loadReviewImages(urls, root)
  assert.deepEqual(frames.map(frame => frame.url), urls)
  const blocks = reviewImageContentBlocks(frames)
  assert.equal(blocks.length, 64)
  assert.deepEqual(blocks[7], { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } })
  assert.deepEqual(blocks[63], blocks[7])

  const before = reviewImagesFingerprint('request', frames)
  const changed = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#902030' } }).jpeg().toBuffer()
  await save('frame-63.jpg', changed)
  const afterLast = await loadReviewImages(urls, root)
  assert.notEqual(reviewImagesFingerprint('request', afterLast), before)
  await save('frame-63.jpg')
  await save('frame-7.jpg', changed)
  assert.notEqual(reviewImagesFingerprint('request', await loadReviewImages(urls, root)), before)
  assert.equal(reviewImagesFingerprint('request', frames), before, 'sending the loaded snapshot is independent of later disk changes')
  assert.notEqual(reviewImagesFingerprint('request', frames.toReversed()), before)
  assert.notEqual(reviewImagesFingerprint('other request', frames), before)
})

test('more than 64 frames fails explicitly instead of silently truncating', async t => {
  const { root, save } = await fixture(t)
  const url = await save('frame.jpg')
  await assert.rejects(loadReviewImages(Array(65).fill(url), root), /REVIEW_IMAGES_INVALID:.*65.*64.*未提交任何截断审查/)
})

test('a frame over 5MiB and a request over 24MiB are rejected before decode', async t => {
  const { root, jpeg, save } = await fixture(t)
  const large = await save('large.jpg', Buffer.concat([jpeg, Buffer.alloc(REVIEW_IMAGE_LIMITS.fileBytes + 1 - jpeg.length)]))
  await assert.rejects(loadReviewImages([large], root), /单帧上限 5MiB/)
  // JPEG allows trailing data. Repeated attachments count toward the sent payload.
  const exactly4MiB = await save('four.jpg', Buffer.concat([jpeg, Buffer.alloc(4 * 1024 * 1024 - jpeg.length)]))
  assert.equal((await loadReviewImages(Array(6).fill(exactly4MiB), root)).length, 6)
  await assert.rejects(loadReviewImages(Array(7).fill(exactly4MiB), root), /合计.*24MiB.*未提交任何截断审查/)
  const exactly5MiB = await save('five.jpg', Buffer.concat([jpeg, Buffer.alloc(REVIEW_IMAGE_LIMITS.fileBytes - jpeg.length)]))
  assert.equal((await loadReviewImages([exactly5MiB], root))[0].bytes.length, REVIEW_IMAGE_LIMITS.fileBytes)
})

test('later invalid frames fail the whole request; extensions cannot disguise non-JPEG or truncated bytes', async t => {
  const { root, jpeg, save } = await fixture(t)
  const good = await save('good.jpg')
  const png = await sharp(jpeg).png().toBuffer()
  const fake = await save('fake.jpg', png)
  await assert.rejects(loadReviewImages([...Array(7).fill(good), fake], root), /实际内容不是 JPEG/)
  const truncated = await save('truncated.jpg', jpeg.subarray(0, jpeg.length - 10))
  await assert.rejects(loadReviewImages([truncated], root), /无法完整解码为 JPEG/)
  const empty = await save('empty.jpg', Buffer.alloc(0))
  await assert.rejects(loadReviewImages([empty], root), /无法完整解码为 JPEG/)
})

test('only local generated JPEG paths are accepted, including symlink containment', async t => {
  const { root, jpeg } = await fixture(t)
  for (const url of ['https://example.test/frame.jpg', 'data:image/jpeg;base64,AA==', '/generated/../secret.jpg', '/elsewhere/frame.jpg', '/generated/frame.png', 3]) {
    await assert.rejects(loadReviewImages([url], root), /只接受.*本地 JPEG/)
  }
  await writeFile(path.join(root, 'outside.jpg'), jpeg)
  await symlink(path.join(root, 'outside.jpg'), path.join(root, 'public/generated/link.jpg'))
  await assert.rejects(loadReviewImages(['/generated/link.jpg'], root), /generated 目录之外/)
  await assert.rejects(loadReviewImages('frame.jpg', root), /必须.*数组/)
  assert.deepEqual(await loadReviewImages(undefined, root), [])
  assert.deepEqual(await loadReviewImages([], root), [])
  assert.equal(reviewImagesFingerprint('no-images', []), 'no-images')
  assert.deepEqual(reviewImageContentBlocks([]), [])
})

test('detail attachments retain every original first and crop native source pixels with explicit frame/rectangle labels', async t => {
  const { root, save } = await fixture(t)
  const pixels = Buffer.from(Array.from({ length: 17 * 11 * 3 }, (_, i) => (i * 13) % 256))
  const jpeg = await sharp(pixels, { raw: { width: 17, height: 11, channels: 3 } }).jpeg({ quality: 95 }).toBuffer()
  const urls = [await save('first.jpg', jpeg), await save('later.jpg', jpeg), await save('tail.jpg', jpeg)]
  const config = { indices: [2, 0], columns: 3, rows: 2, overlap: .25 }
  const frames = await loadReviewImages(urls, root, config)
  assert.equal(frames.length, 15)
  assert.deepEqual(frames.slice(0, 3).map(frame => frame.url), urls)
  assert.deepEqual(frames.slice(0, 3).map(frame => frame.frameIndex), [0, 1, 2])
  for (const frame of frames.slice(0, 3)) {
    assert.deepEqual(frame.bytes, jpeg, 'original byte stream is not re-encoded')
    assert.equal(frame.kind, 'original')
    assert.deepEqual(frame.sourceRect, { left: 0, top: 0, width: 17, height: 11 })
  }
  assert.deepEqual(frames.slice(3).map(frame => frame.frameIndex), [...Array(6).fill(2), ...Array(6).fill(0)])
  const rects = [
    { left: 0, top: 0, width: 7, height: 7 }, { left: 5, top: 0, width: 7, height: 7 }, { left: 10, top: 0, width: 7, height: 7 },
    { left: 0, top: 4, width: 7, height: 7 }, { left: 5, top: 4, width: 7, height: 7 }, { left: 10, top: 4, width: 7, height: 7 },
  ]
  assert.deepEqual(frames.slice(3, 9).map(frame => frame.sourceRect), rects)
  for (const [index, frame] of frames.slice(3, 9).entries()) {
    assert.equal(frame.kind, 'detail')
    const expected = await sharp(jpeg, { failOn: 'warning' }).extract(rects[index]).jpeg({ quality: 90 }).toBuffer()
    assert.deepEqual(frame.bytes, expected, 'detail bytes come only from the declared native pixel rectangle')
    const metadata = await sharp(frame.bytes).metadata()
    assert.equal(metadata.width, rects[index].width)
    assert.equal(metadata.height, rects[index].height)
    assert.match(frame.label!, /frameIndex=2/)
    assert.match(frame.label!, /源像素矩形 left=\d+, top=\d+, width=7, height=7/)
  }
  const blocks = reviewImageContentBlocks(frames)
  assert.equal(blocks.filter(block => block.type === 'image').length, 15)
  assert.equal(blocks.filter(block => block.type === 'text').length, 15)
  assert.match(String(blocks[0].text), /原始完整帧 frameIndex=0/)
  assert.match(String(blocks[4].text), /原始完整帧 frameIndex=2/)
  assert.match(String(blocks[6].text), /原像素局部图 frameIndex=2/)
  config.indices[0] = 1
  assert.deepEqual(frames[0].detailConfig?.indices, [2, 0], 'loaded snapshot does not retain the caller mutable config array')
})

test('2x2 overlap detail tiles preserve full 1280x720 source coverage and valid boundaries', async t => {
  const { root, save } = await fixture(t)
  const jpeg = await sharp({ create: { width: 1280, height: 720, channels: 3, background: '#274060' } }).jpeg().toBuffer()
  const url = await save('wide.jpg', jpeg)
  const frames = await loadReviewImages([url], root, { indices: [0], columns: 2, rows: 2, overlap: .25 })
  assert.deepEqual(frames.slice(1).map(frame => frame.sourceRect), [
    { left: 0, top: 0, width: 732, height: 412 }, { left: 548, top: 0, width: 732, height: 412 },
    { left: 0, top: 308, width: 732, height: 412 }, { left: 548, top: 308, width: 732, height: 412 },
  ])
  const noOverlap = await loadReviewImages([url], root, { indices: [0], columns: 2, rows: 2, overlap: 0 })
  assert.deepEqual(noOverlap.at(-1)?.sourceRect, { left: 640, top: 360, width: 640, height: 360 })
  const oneTile = await loadReviewImages([url], root, { indices: [0], columns: 1, rows: 1, overlap: .99 })
  assert.deepEqual(oneTile[1].sourceRect, { left: 0, top: 0, width: 1280, height: 720 })
})

test('invalid detail indices, grids and overlap reject the whole request before crop or provider submission', async t => {
  const { root, save } = await fixture(t)
  const url = await save('frame.jpg')
  const valid = { indices: [0], columns: 2, rows: 2, overlap: .25 }
  for (const config of [null, true, [], {},
    ...[[], [-1], [1], [.5], ['0'], [0, 0]].map(indices => ({ ...valid, indices })),
    ...[0, -1, 1.5, 65, '2'].map(columns => ({ ...valid, columns })),
    ...[0, 1.5, '2'].map(rows => ({ ...valid, rows })),
    ...[-.1, 1, Number.NaN, Number.POSITIVE_INFINITY, '.25'].map(overlap => ({ ...valid, overlap })),
  ]) await assert.rejects(loadReviewImages([url], root, config), /REVIEW_IMAGES_INVALID:.*reviewImageDetail/)
  await assert.rejects(loadReviewImages([url], root, { ...valid, columns: 9, rows: 1 }), /网格数.*像素数/)
  await assert.rejects(loadReviewImages([], root, valid), /indices/)
  await assert.rejects(loadReviewImages(undefined, root, valid), /indices/)
})

test('detail images count toward the same 64-image and 24MiB budgets without truncation', async t => {
  const { root, jpeg, save } = await fixture(t)
  const config = { indices: [0], columns: 1, rows: 1, overlap: 0 }
  // Predicted attachment count rejects before even opening a source file.
  await assert.rejects(loadReviewImages(Array(64).fill('/generated/absent.jpg'), root, config), /共 65 张.*64.*未提交任何截断审查/)
  const url = await save('frame.jpg')
  const frames = await loadReviewImages(Array(63).fill(url), root, config)
  assert.equal(frames.length, 64)
  assert.equal(reviewImageContentBlocks(frames).filter(block => block.type === 'image').length, 64)
  const exactly4MiB = await save('four-detail.jpg', Buffer.concat([jpeg, Buffer.alloc(4 * 1024 * 1024 - jpeg.length)]))
  assert.equal((await loadReviewImages(Array(6).fill(exactly4MiB), root)).length, 6)
  await assert.rejects(loadReviewImages(Array(6).fill(exactly4MiB), root, config), /原帧及局部附件合计.*24MiB.*未提交任何截断审查/)
})

test('detail fingerprint covers labels, configuration and exact crop bytes while default behavior stays unchanged', async t => {
  const { root, jpeg, save } = await fixture(t)
  const url = await save('frame.jpg')
  const original = await loadReviewImages([url], root)
  assert.deepEqual(original, [{ url, bytes: jpeg }])
  assert.deepEqual(await loadReviewImages([url], root, undefined), original)
  const config = { indices: [0], columns: 1, rows: 1, overlap: 0 }
  const detail = await loadReviewImages([url], root, config)
  const fingerprint = reviewImagesFingerprint('request', detail)
  assert.notEqual(fingerprint, reviewImagesFingerprint('request', original))
  assert.notEqual(fingerprint, reviewImagesFingerprint('request', detail.map((frame, index) => index ? { ...frame, label: frame.label + ' label changed' } : frame)))
  assert.notEqual(fingerprint, reviewImagesFingerprint('request', detail.map((frame, index) => index ? { ...frame, bytes: Buffer.concat([frame.bytes, Buffer.from([0])]) } : frame)))
  // A 1x1 grid produces identical pixels for any overlap, so this specifically
  // proves configuration hashing independently of image bytes and crop labels.
  const otherConfig = await loadReviewImages([url], root, { ...config, overlap: .5 })
  assert.deepEqual(otherConfig[1].bytes, detail[1].bytes)
  assert.equal(otherConfig[1].label, detail[1].label)
  assert.notEqual(fingerprint, reviewImagesFingerprint('request', otherConfig))
})

const grid = { transport: { mode: 'sequence-grid', columns: 2, rows: 2 } }
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

test('sequence PNG pages preserve decoded source pixels, source order and complete native timestamp mappings', async t => {
  const { root, save } = await fixture(t)
  const originals = await Promise.all(['#de2233', '#228833', '#1133dc', '#dd9900', '#55eeee'].map(color => sharp({ create: { width: 17, height: 11, channels: 3, background: color } }).jpeg({ quality: 95 }).toBuffer()))
  const urls = await Promise.all(originals.map((bytes, i) => save('sequence-' + i + '.jpg', bytes)))
  const metadata = urls.map((url, i) => ({ evidenceIndex: i + 4, nativeFrameIndex: i + 24, url, time: (i + 24) / 24, pts: (i + 24) * 512, timeBase: '1/12288' }))
  const pending = loadReviewImages(urls, root, { ...grid, frameMetadata: metadata })
  metadata[0].nativeFrameIndex = 999
  const frames = await pending
  assert.equal(frames.length, 2)
  assert.equal(frames[0].kind, 'sequence-grid')
  assert.equal(frames[0].mimeType, 'image/png')
  assert.equal(frames[0].frameIndex, undefined)
  assert.equal(Object.hasOwn(frames[0], 'frameIndex'), false, 'a page must not masquerade as one source frame')
  assert.deepEqual(frames.map(f => f.attachmentIndex), [0, 1])
  assert.deepEqual(frames.flatMap(f => f.cells!.map(c => c.evidenceIndex)), [4, 5, 6, 7, 8])
  assert.equal(frames[0].cells![0].nativeFrameIndex, 24, 'metadata is snapshotted before asynchronous source IO')
  assert.deepEqual(frames[0].encoding, { format: 'png', lossless: true, reencoded: true, noResize: true })
  for (const frame of frames) {
    const size = await sharp(frame.bytes).metadata()
    assert.deepEqual([size.width, size.height], [34, 22])
    for (const cell of frame.cells!) {
      const sourceIndex = cell.evidenceIndex - 4
      assert.equal(cell.sourceSha256, sha256(originals[sourceIndex]))
      assert.equal(cell.url, urls[sourceIndex])
      assert.equal(cell.time, (sourceIndex + 24) / 24)
      assert.equal(cell.pts, (sourceIndex + 24) * 512)
      assert.equal(cell.timeBase, '1/12288')
      assert.deepEqual(cell.sourceRect, { left: 0, top: 0, width: 17, height: 11 })
      const actual = await sharp(frame.bytes).extract(cell.targetRect).removeAlpha().raw().toBuffer()
      const expected = await sharp(originals[sourceIndex]).removeAlpha().raw().toBuffer()
      assert.deepEqual(actual, expected, 'PNG cell pixels equal the native JPEG decoding with no resampling')
    }
  }
  assert.equal(frames[1].cells!.length, 1, 'padding is not represented as an observed source frame')
  assert.match(frames[1].label!, /空白余区不是证据帧/)
  const blocks = reviewImageContentBlocks(frames)
  assert.equal((blocks[1].source as Record<string, unknown>).media_type, 'image/png')
  assert.match(String(blocks[0].text), /evidenceIndex/)
  const before = reviewImagesFingerprint('base', frames)
  await save('sequence-0.jpg', originals[1])
  assert.equal(reviewImagesFingerprint('base', frames), before, 'later changes to original files do not alter loaded pages or their source hashes')
})

test('sequence transport supports 160 native frames while enforcing 64 final attachments and bounded source decoding', async t => {
  const { root, save } = await fixture(t)
  const url = await save('sequence.jpg')
  const pages = await loadReviewImages(Array(160).fill(url), root, grid)
  assert.equal(pages.length, 40)
  assert.deepEqual(pages.flatMap(page => page.cells!.map(cell => cell.evidenceIndex)), Array.from({ length: 160 }, (_, i) => i))
  assert.equal(pages[0].cells![0].nativeFrameIndex, undefined, 'evidence index is not invented as the native decode index')
  assert.equal((await loadReviewImages(Array(256).fill(url), root, grid)).length, 64)
  await assert.rejects(loadReviewImages(Array(257).fill('/generated/missing.jpg'), root, grid), /源帧上限256.*附件上限64/)
  assert.ok(REVIEW_SEQUENCE_LIMITS.totalPixels >= 160 * 1280 * 720)
  const big = await sharp({ create: { width: 4096, height: 4096, channels: 3, background: '#274060' } }).jpeg().toBuffer()
  const largeUrl = await save('decode-budget.jpg', big)
  await assert.rejects(loadReviewImages(Array(17).fill(largeUrl), root, grid), /解码像素.*合计256Mi/)
  const changedHeader = Buffer.from(big)
  const marker = changedHeader.indexOf(Buffer.from([0xff, 0xc0]))
  assert.ok(marker >= 0)
  changedHeader.writeUInt16BE(8192, marker + 5)
  changedHeader.writeUInt16BE(8192, marker + 7)
  await assert.rejects(loadReviewImages([await save('too-many-pixels.jpg', changedHeader)], root, grid), /解码像素.*单帧16Mi/)
})

test('sequence transport bounds local source JPEGs separately from transmitted pages', async t => {
  const { root, save } = await fixture(t)
  const source = await sharp(randomBytes(576 * 576 * 3), { raw: { width: 576, height: 576, channels: 3 } }).jpeg({ quality: 100 }).toBuffer()
  assert.ok(source.length * 64 > REVIEW_IMAGE_LIMITS.totalBytes && source.length * 64 < REVIEW_SEQUENCE_LIMITS.sourceBytes)
  const url = await save('sequence-larger-source.jpg', source)
  const pages = await loadReviewImages(Array(64).fill(url), root,
    { transport: { mode: 'sequence-grid', columns: 2, rows: 2, format: 'jpeg', quality: 90, chromaSubsampling: '4:4:4' } })
  assert.equal(pages.length, 16)
  assert.ok(pages.reduce((total, page) => total + page.bytes.length, 0) < REVIEW_SEQUENCE_LIMITS.transportBytes)
})

test('sequence grid rejects invalid metadata, transport choices and mixed crop settings without provider submission', async t => {
  const { root, save } = await fixture(t)
  const url = await save('sequence-invalid.jpg')
  const jpeg = { ...grid.transport, format: 'jpeg', quality: 95, chromaSubsampling: '4:4:4' }
  for (const config of [
    { ...grid, indices: [0], columns: 2, rows: 2, overlap: 0 },
    { transport: null }, { transport: { ...grid.transport, columns: 3 } },
    { transport: { ...grid.transport, format: 'webp' } }, { transport: { ...grid.transport, quality: 95 } },
    { transport: { ...jpeg, quality: undefined } }, { transport: { ...jpeg, quality: 0 } },
    { transport: { ...jpeg, quality: 101 } }, { transport: { ...jpeg, quality: 95.5 } },
    { transport: { ...jpeg, chromaSubsampling: '4:2:0' } },
    { ...grid, frameMetadata: [] }, { ...grid, frameMetadata: [null] },
    ...[{ evidenceIndex: -1 }, { nativeFrameIndex: .5 }, { time: -1 }, { time: Infinity }, { pts: .5 }, { pts: Number.MAX_SAFE_INTEGER + 1 },
      { timeBase: '0/24' }, { timeBase: '1/0' }, { url: '/generated/other.jpg' }, { extra: 'lost metadata' }].map(row => ({ ...grid, frameMetadata: [row] })),
  ]) await assert.rejects(loadReviewImages([url], root, config), /REVIEW_IMAGES_INVALID:.*reviewImageDetail/)
  await assert.rejects(loadReviewImages([url, url], root, { ...grid, frameMetadata: [{ evidenceIndex: 0 }, { evidenceIndex: 0 }] }), /evidenceIndex.*重复/)
  await assert.rejects(loadReviewImages([], root, grid), /至少需要一张原帧/)
})

test('explicit sequence JPEG quality is applied with no resizing and declared lossy provenance', async t => {
  const { root, save } = await fixture(t)
  const bytes = await sharp(randomBytes(40 * 24 * 3), { raw: { width: 40, height: 24, channels: 3 } }).jpeg({ quality: 98 }).toBuffer()
  const url = await save('quality.jpg', bytes)
  const config = { transport: { ...grid.transport, format: 'jpeg', quality: 95, chromaSubsampling: '4:4:4' } }
  const [page] = await loadReviewImages(Array(4).fill(url), root, config)
  const expected = await sharp({ create: { width: 80, height: 48, channels: 3, background: '#000000' } }).composite(Array.from({ length: 4 }, (_, i) => ({ input: bytes, left: i % 2 * 40, top: Math.floor(i / 2) * 24 }))).jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toBuffer()
  assert.deepEqual(page.bytes, expected)
  assert.equal(page.mimeType, 'image/jpeg')
  assert.deepEqual(page.encoding, { format: 'jpeg', lossless: false, reencoded: true, noResize: true, quality: 95, chromaSubsampling: '4:4:4' })
  assert.match(page.label!, /有损传输/)
  assert.doesNotMatch(page.label!, /无损/)
  assert.ok(page.cells!.every(cell => cell.sourceSha256 === sha256(bytes)))
  const fingerprint = reviewImagesFingerprint('request', [page])
  for (const changed of [
    { ...page, cells: page.cells!.map((c, i) => i ? c : { ...c, pts: 1 }) },
    { ...page, cells: page.cells!.map((c, i) => i ? c : { ...c, nativeFrameIndex: 100 }) },
    { ...page, cells: page.cells!.map((c, i) => i ? c : { ...c, sourceSha256: 'other-source' }) },
    { ...page, cells: page.cells!.map((c, i) => i ? c : { ...c, targetRect: { ...c.targetRect, left: 1 } }) },
    { ...page, encoding: { ...page.encoding!, quality: 90 } },
    { ...page, bytes: Buffer.concat([page.bytes, Buffer.from([0])]) },
  ]) assert.notEqual(reviewImagesFingerprint('request', [changed]), fingerprint)
})

test('sequence output byte limits reject lossless pages or requests without implicit quality fallback', async t => {
  const { root, save } = await fixture(t)
  const largeUrls = await Promise.all(Array.from({ length: 4 }, async (_, i) => save('large-grid-' + i + '.jpg', await sharp(randomBytes(1024 * 1024 * 3), { raw: { width: 1024, height: 1024, channels: 3 } }).jpeg({ quality: 90 }).toBuffer())))
  await assert.rejects(loadReviewImages(largeUrls, root, grid), /实际附件.*单图上限 5MiB.*不会自动降低质量/)
  const urls = await Promise.all(Array.from({ length: 52 }, async (_, i) => save('grid-total-' + i + '.jpg', await sharp(randomBytes(600 * 600 * 3), { raw: { width: 600, height: 600, channels: 3 } }).jpeg({ quality: 90 }).toBuffer())))
  await assert.rejects(loadReviewImages(urls, root, grid), /实际附件合计.*48MiB.*不会自动降低质量/)
})

test('large JPEG native review keeps all ordered frames and discloses one bounded quality for every page', async t => {
  const { root, save } = await fixture(t)
  const source = await sharp(randomBytes(500 * 500 * 3), { raw: { width: 500, height: 500, channels: 3 } }).jpeg({ quality: 65 }).toBuffer()
  const url = await save('adaptive-sequence.jpg', source)
  const count = 245
  const urls = Array(count).fill(url)
  const frameMetadata = urls.map((url, evidenceIndex) => ({ evidenceIndex, nativeFrameIndex: evidenceIndex + 8,
    url, time: (evidenceIndex + 8) / 24, pts: (evidenceIndex + 8) * 512, timeBase: '1/12288' }))
  const pages = await loadReviewImages(urls, root, { transport: { mode: 'sequence-grid', columns: 2, rows: 2,
    format: 'jpeg', quality: 90, chromaSubsampling: '4:4:4' }, frameMetadata })
  assert.equal(pages.length, 62)
  assert.ok(pages.reduce((bytes, page) => bytes + page.bytes.length, 0) <= REVIEW_SEQUENCE_LIMITS.transportBytes)
  assert.deepEqual(pages.flatMap(page => page.cells!.map(cell => cell.evidenceIndex)), Array.from({ length: count }, (_, index) => index))
  assert.deepEqual(pages.flatMap(page => page.cells!.map(cell => cell.nativeFrameIndex)), Array.from({ length: count }, (_, index) => index + 8))
  assert.ok(pages.every(page => page.encoding?.quality === 80 && page.encoding.requestedQuality === 90
    && page.encoding.chromaSubsampling === '4:4:4' && page.encoding.noResize === true))
  assert.ok(pages.every(page => /请求JPEG质量90.*实际质量80/.test(page.label!)))
  assert.equal(pages.at(-1)!.cells!.length, 1)
  assert.equal(pages.at(-1)!.cells![0].pts, (count - 1 + 8) * 512)
  assert.deepEqual([pages[0].cells![0].sourceRect.width, pages[0].cells![0].sourceRect.height], [500, 500])
  assert.deepEqual([pages[0].cells![0].targetRect.width, pages[0].cells![0].targetRect.height], [500, 500])
  const pageSize = await sharp(pages[0].bytes).metadata()
  assert.deepEqual([pageSize.width, pageSize.height], [1000, 1000])
  const fingerprint = reviewImagesFingerprint('request', pages)
  assert.notEqual(fingerprint, reviewImagesFingerprint('request', pages.map((page, index) => index
    ? page : { ...page, encoding: { ...page.encoding!, requestedQuality: 85 } })))
  assert.notEqual(fingerprint, reviewImagesFingerprint('request', pages.map((page, index) => index === pages.length - 1
    ? { ...page, bytes: Buffer.concat([page.bytes, Buffer.from([0])]) } : page)))
})

test('JPEG sequence fails closed when the complete review cannot fit at quality 80, and below-floor requests do not adapt', async t => {
  const { root, save } = await fixture(t)
  const source = await sharp(randomBytes(550 * 550 * 3), { raw: { width: 550, height: 550, channels: 3 } }).jpeg({ quality: 65 }).toBuffer()
  const url = await save('unfit-sequence.jpg', source)
  const urls = Array(245).fill(url)
  const config = (quality: number) => ({ transport: { mode: 'sequence-grid', columns: 2, rows: 2, format: 'jpeg', quality, chromaSubsampling: '4:4:4' } })
  await assert.rejects(loadReviewImages(urls, root, config(90)), /实际附件.*48MiB.*质量80.*未缩放或截断；未提交审查/)
  await assert.rejects(loadReviewImages(urls, root, config(79)), /实际附件.*48MiB.*质量79.*未缩放或截断；未提交审查/)
})
