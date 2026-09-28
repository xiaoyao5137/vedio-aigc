import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { prepareCharacterIdentityAnchor } from '../server/character-identity-anchor.ts'

const face = { confidence: 1, yaw: 0, bounds: { x: 0.3, y: 0.2, width: 0.4, height: 0.4 },
  leftEye: [{ x: 0.4, y: 0.35 }, { x: 0.44, y: 0.36 }], rightEye: [{ x: 0.56, y: 0.35 }, { x: 0.6, y: 0.36 }],
  leftEyebrow: [{ x: 0.39, y: 0.3 }, { x: 0.45, y: 0.31 }], rightEyebrow: [{ x: 0.55, y: 0.31 }, { x: 0.61, y: 0.3 }], nose: [{ x: 0.48, y: 0.42 }, { x: 0.5, y: 0.46 }, { x: 0.52, y: 0.42 }] }
const detector = 'macos-vision-landmarks-v1'

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'identity-anchor-')), sourceUrl = 'https://example.com/same-actor.png?signature=original'
  const sourceFingerprint = createHash('sha256').update(sourceUrl).digest('hex'), snapshotUrl = `/generated/appearance-${sourceFingerprint.slice(0, 24)}.jpg`
  await mkdir(path.join(root, 'public/generated'), { recursive: true })
  await writeFile(path.join(root, 'public', snapshotUrl), await sharp({ create: { width: 900, height: 600, channels: 3, background: '#926a43' } }).jpeg().toBuffer())
  return { root, input: { assetId: 'same-actor', sourceUrl, sourceFingerprint, snapshotUrl } }
}

test('upper-face anchor derives from verified front panel landmarks and records pixel provenance', async () => {
  const { root, input } = await fixture()
  let calls = 0
  const detect = async () => { calls++; return { detector, faces: [face] } }
  try {
    const anchor = await prepareCharacterIdentityAnchor(input, { root, detect })
    assert.equal(anchor.sourceAssetId, input.assetId)
    assert.equal(anchor.version, 'facial-identity-anchor-v2')
    assert.equal(anchor.colorPolicy, 'geometry-only-grayscale')
    assert.match(anchor.anchorUrl, /-v2\.jpg$/)
    assert.equal(anchor.sourceSnapshotUrl, input.snapshotUrl)
    assert.equal(anchor.sourceUriFingerprint, input.sourceFingerprint)
    assert.deepEqual(anchor.frontPanel, { left: 0, top: 0, width: 300, height: 600 })
    assert.ok(anchor.cropBounds.top >= 160)
    assert.ok(anchor.cropBounds.top + anchor.cropBounds.height <= 276)
    const pixels = await readFile(path.join(root, 'public', anchor.anchorUrl))
    assert.equal(createHash('sha256').update(pixels).digest('hex'), anchor.anchorFingerprint)
    assert.equal((await sharp(pixels).metadata()).width, 512)
    const { data } = await sharp(pixels).toColourspace('srgb').raw().toBuffer({ resolveWithObject: true })
    for (let index = 0; index < data.length; index += 3) {
      assert.equal(data[index], data[index + 1])
      assert.equal(data[index + 1], data[index + 2])
    }
    await prepareCharacterIdentityAnchor(input, { root, detect })
    assert.equal(calls, 1)
    await writeFile(path.join(root, 'public', anchor.anchorUrl), 'corrupt derived file')
    await prepareCharacterIdentityAnchor(input, { root, detect })
    assert.equal(calls, 2)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('missing, ambiguous, turned or ungrounded face detections block instead of using the whole sheet', async () => {
  for (const faces of [[], [face, face], [{ ...face, confidence: 0.2 }], [{ ...face, yaw: 0.7 }], [{ ...face, nose: [] }], [{ ...face, nose: [{ x: 0.1, y: 0.2 }, { x: 0.2, y: 0.3 }] }]]) {
    const { root, input } = await fixture()
    try { await assert.rejects(prepareCharacterIdentityAnchor(input, { root, detect: async () => ({ detector, faces }) }), /FACIAL_IDENTITY_ANCHOR_UNAVAILABLE/) }
    finally { await rm(root, { recursive: true, force: true }) }
  }
  const { root, input } = await fixture()
  try {
    await assert.rejects(prepareCharacterIdentityAnchor({ ...input, snapshotUrl: '/generated/unrelated-face.jpg' }, { root }), /SOURCE_MISMATCH/)
    await assert.rejects(prepareCharacterIdentityAnchor({ ...input, sourceFingerprint: 'wrong-source' }, { root }), /SOURCE_MISMATCH/)
    await rm(path.join(root, 'public', input.snapshotUrl))
    await assert.rejects(prepareCharacterIdentityAnchor(input, { root }), /快照缺失/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('same-stage full-face anchor keeps source face color without leaking the costume sheet', async () => {
  const { root, input } = await fixture()
  const realistic = { ...face, bounds: { x: 0.35, y: 0.1, width: 0.3, height: 0.16 },
    leftEye: [{ x: 0.43, y: 0.16 }, { x: 0.45, y: 0.16 }], rightEye: [{ x: 0.55, y: 0.16 }, { x: 0.57, y: 0.16 }],
    leftEyebrow: [{ x: 0.42, y: 0.14 }, { x: 0.46, y: 0.14 }], rightEyebrow: [{ x: 0.54, y: 0.14 }, { x: 0.58, y: 0.14 }],
    nose: [{ x: 0.49, y: 0.19 }, { x: 0.5, y: 0.21 }, { x: 0.51, y: 0.19 }] }
  try {
    const anchor = await prepareCharacterIdentityAnchor(input, { root, mode: 'full-face', detect: async () => ({ detector, faces: [realistic] }) })
    assert.equal(anchor.version, 'facial-identity-anchor-v4')
    assert.equal(anchor.scope, 'full-face-identity-only')
    assert.equal(anchor.colorPolicy, 'source-color-face')
    assert.match(anchor.anchorUrl, /-full-face-v4\.jpg$/)
    assert.ok(anchor.cropBounds.width < anchor.frontPanel.width * 0.7)
    assert.ok(anchor.cropBounds.height < anchor.frontPanel.height * 0.5)
    const { data } = await sharp(await readFile(path.join(root, 'public', anchor.anchorUrl))).toColourspace('srgb').raw().toBuffer({ resolveWithObject: true })
    assert.notEqual(data[0], data[1], 'facial skin tone must remain in the source colors')
    assert.notEqual(data[1], data[2])
  } finally { await rm(root, { recursive: true, force: true }) }
})
