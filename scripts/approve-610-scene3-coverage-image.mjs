#!/usr/bin/env node
// Sign the already-reviewed scene-3 first frame. No image or video generation.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'
import { validateCoverageCutVideoPayment, verifyCoverageCutFrameApproval } from '../server/coverage-cut-frame-approval.ts'

const out = path.resolve(process.argv[2] || 'logs/dramatic-expression/live-20260928/record-7cb4d1-readonly/loop3-media/scene3-coverage-first-frame-20260928-v1')
const sha = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value)
  ? value : JSON.stringify(value)).digest('hex')
const read = async name => JSON.parse(await readFile(path.join(out, name), 'utf8'))
const [plan, image, evidence, projected, review] = await Promise.all([
  read('plan-private.json'), read('image-result-proof.json'), read('image-evidence.json'),
  read('review-shot.json'), read('review-result-v2.json'),
])
assert.equal(review.attempt, 'v2')
assert.equal(review.httpStatus, 200)
assert.equal(review.ledgerBoundToActualAttachments, true)
assert.equal(review.report?.passed, true)
assert.equal(review.report.evidenceUrl, evidence.evidenceUrl)
assert.deepEqual(review.report.issues, [])
assert.ok(review.report.offscreenNotes.some(note => note.includes('未在新画面核实')))
assert.equal(image.imagePersistedLocally, true)
assert.equal(projected.sourceShotSha256, plan.shotSha256)
assert.equal(sha(projected.shot), projected.reviewShotSha256)
const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
try {
  const sourceMd5 = async () => (await db.query('select md5(result::text) as md5 from execution_records where id=$1',
    [plan.sourceId])).rows[0]?.md5
  assert.equal(await sourceMd5(), plan.sourceMd5)
  const taskCounts = async () => (await db.query(`select count(*)::int as n from model_execution_records
    where capability='video' and task_id is not null
      and created_at >= (select created_at from model_execution_records where task_id=$1 limit 1)`,
  [image.taskIds[0]])).rows[0].n
  const videoBefore = await taskCounts()
  assert.equal(videoBefore, 0, 'A new paid video task already exists after the image task')
  const intent = { format: 'scene3-coverage-image-approval-intent-v2', at: new Date().toISOString(),
    reviewRequestKey: review.requestKey, reviewLedgerId: review.ledger[0]?.id,
    evidenceUrl: evidence.evidenceUrl, imageTaskId: image.taskIds[0],
    reviewShotSha256: projected.reviewShotSha256, sourceMd5: plan.sourceMd5,
    videoTaskCountBefore: videoBefore, noProviderRequest: true }
  await writeFile(path.join(out, 'approval-intent-v2.json'), JSON.stringify(intent, null, 2) + '\n', { flag: 'wx' })
  const response = await fetch('http://127.0.0.1:5173/api/coverage-cut-frame-approval', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ review: review.report, evidence, shot: projected.shot,
      previousTail: plan.params.coverageSources.previousTail,
      referenceBindings: plan.params.coverageSources.referenceBindings }),
  })
  const body = await response.json()
  const proof = { format: 'scene3-coverage-image-approval-result-v2', at: new Date().toISOString(),
    reviewRequestKey: review.requestKey, reviewLedgerId: review.ledger[0]?.id,
    httpStatus: response.status, certificateIssued: response.ok,
    certificateSignature: response.ok ? body.signature : null,
    certificateSha256: response.ok ? sha(body) : null,
    error: response.ok ? null : body.error,
    verifiedCertificate: false, offlineVideoPaymentGate: false,
    videoTaskCountBefore: videoBefore, videoTaskCountAfter: await taskCounts(),
    sourceMd5After: await sourceMd5(), sourceUnchanged: false,
    providerVideoSubmitted: false }
  if (response.ok) {
    const verified = verifyCoverageCutFrameApproval(body)
    assert.equal(verified.signature, body.signature)
    const sources = plan.params.coverageSources
    const videoParams = { continuityMode: 'coverage_cut', coverageCutFrameGate: body,
      coveragePreviousTail: sources.previousTail, coverageShot: projected.shot,
      referenceImage: image.imageUrl, referenceImages: sources.referenceImages,
      referenceBindings: sources.referenceBindings }
    assert.equal(validateCoverageCutVideoPayment(videoParams).signature, body.signature)
    proof.verifiedCertificate = true
    proof.offlineVideoPaymentGate = true
    await writeFile(path.join(out, 'certificate-v2.json'), JSON.stringify(body, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  }
  proof.sourceUnchanged = proof.sourceMd5After === plan.sourceMd5
  assert.equal(proof.videoTaskCountAfter, videoBefore)
  assert.equal(proof.sourceUnchanged, true)
  await writeFile(path.join(out, 'approval-result-v2.json'), JSON.stringify(proof, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify(proof, null, 2))
  if (!response.ok) process.exitCode = 1
} finally { await db.end() }
