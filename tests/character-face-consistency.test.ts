import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import sharp from 'sharp'
import { compareCharacterFaceSheets, SAME_STAGE_FACE_DISTANCE_REVIEW_THRESHOLD } from '../server/character-face-consistency.ts'

test('same-stage face evidence binds the actual candidate bytes and routes drift to review', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'face-consistency-test-'))
  const generated = path.join(root, 'public/generated')
  await mkdir(generated, { recursive: true })
  const snapshot = '/generated/appearance-aaaaaaaaaaaaaaaaaaaaaaaa.jpg'
  const candidate = '/generated/candidate.png'
  const sourceBytes = await sharp({ create: { width: 384, height: 216, channels: 3, background: '#777' } }).jpeg().toBuffer()
  const candidateBytes = await sharp({ create: { width: 384, height: 216, channels: 3, background: '#888' } }).png().toBuffer()
  const sourceSnapshotFingerprint = createHash('sha256').update(sourceBytes).digest('hex')
  const candidateContentSha256 = createHash('sha256').update(candidateBytes).digest('hex')
  await writeFile(path.join(root, 'public', snapshot), sourceBytes)
  await writeFile(path.join(root, 'public', candidate), candidateBytes)
  const input = { sourceAssetId: 'approved-actor', sourceSnapshotUrl: snapshot, sourceSnapshotFingerprint, candidateUrl: candidate }
  try {
    const pass = await compareCharacterFaceSheets(input, { root, calculate: async (source, target) => {
      assert.deepEqual(await readFile(source), sourceBytes)
      assert.deepEqual(await readFile(target), candidateBytes)
      return { detector: 'macos-vision-image-feature-v1', distance: SAME_STAGE_FACE_DISTANCE_REVIEW_THRESHOLD }
    } })
    assert.equal(pass.status, 'passed')
    assert.equal(pass.candidateContentSha256, candidateContentSha256)
    assert.equal(pass.sourceAssetId, input.sourceAssetId)
    assert.equal(pass.threshold, SAME_STAGE_FACE_DISTANCE_REVIEW_THRESHOLD)
    const drift = await compareCharacterFaceSheets(input, { root, calculate: async () => ({
      detector: 'macos-vision-image-feature-v1', distance: SAME_STAGE_FACE_DISTANCE_REVIEW_THRESHOLD + 0.01,
    }) })
    assert.equal(drift.status, 'needs_manual_review')
    assert.equal(drift.reason, 'distance-above-threshold')
    assert.equal(drift.candidateContentSha256, candidateContentSha256)
    const unavailable = await compareCharacterFaceSheets(input, { root, calculate: async () => { throw Error('Vision unavailable') } })
    assert.equal(unavailable.status, 'needs_manual_review')
    assert.equal(unavailable.reason, 'comparison-unavailable')
    assert.match(unavailable.diagnostic, /Vision unavailable/)
    let networkCalls = 0
    const redirect = await compareCharacterFaceSheets({ ...input, candidateUrl: 'https://example.com/portrait.png' }, {
      root, fetchImpl: (async (_url: string, init?: RequestInit) => {
        networkCalls++
        assert.equal(init?.redirect, 'manual')
        return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } })
      }) as typeof fetch,
      calculate: async () => { throw Error('must not compare redirected private image') },
    })
    assert.equal(networkCalls, 1)
    assert.equal(redirect.status, 'needs_manual_review')
    assert.match(redirect.diagnostic, /跳转后的地址不是公开 HTTPS/)
    await writeFile(path.join(root, 'public', snapshot), Buffer.from('tampered'))
    const invalidSource = await compareCharacterFaceSheets(input, { root, calculate: async () => { throw Error('must not compare') } })
    assert.equal(invalidSource.status, 'needs_manual_review')
    assert.match(invalidSource.diagnostic, /指纹不符/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
