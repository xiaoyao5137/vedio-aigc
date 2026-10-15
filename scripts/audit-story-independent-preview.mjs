#!/usr/bin/env node
// Read-only proof for a two-shot preview fork. Never treats generated media as accepted media.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import ffmpeg from 'ffmpeg-static'
import pg from 'pg'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { renderStoryShotTimedActions } from '../src/story-shot-timing.ts'
import { parseFfmpegMetadata, validateVideoMetadata } from '../server/video-inspection.ts'

const [recordId, outputFile] = process.argv.slice(2)
assert.match(recordId ?? '', /^record-[\w-]+$/)
if (outputFile) assert.ok(!outputFile.startsWith('public/generated/'))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
try {
  const row = (await db.query('SELECT result,md5(result::text) AS md5 FROM execution_records WHERE id=$1', [recordId])).rows[0]
  assert.ok(row)
  const state = decodeExecutionState(row.result), runs = state.nodeRuns
  const marker = state.storyIndependentPreview
  assert.equal(state.id, recordId)
  assert.equal(marker?.version, 'story-independent-two-shot-preview-v1')
  assert.equal((await db.query('SELECT md5(result::text) AS md5 FROM execution_records WHERE id=$1', [marker.sourceExecutionId])).rows[0]?.md5, marker.sourceResultMd5)
  assert.deepEqual([9, 10, 14, 15].map(i => runs[i].status), Array(4).fill('skipped'))
  assert.ok([6, 7, 8, 11, 12, 13].every(i => runs[i].status === 'success'))
  assert.ok([8, 13].every(i => runs[i].output?.storyMediaReview?.videoEvidence?.decoded === true))
  const shots = []
  for (const [number, imageIndex, videoIndex, reviewIndex] of [[1, 6, 7, 8], [2, 11, 12, 13]]) {
    const script = runs[3].output.shots[number - 1]
    const image = runs[imageIndex], video = runs[videoIndex], review = runs[reviewIndex].output.storyMediaReview
    const evidence = review.videoEvidence
    assert.equal(image.loopIndex, number - 1)
    assert.equal(video.loopIndex, number - 1)
    assert.equal(review.videoUrl, video.output.url)
    assert.equal(evidence.originalUrl, video.output.url)
    assert.equal(video.inputs.referenceImage.url ?? video.inputs.referenceImage, image.output.url)
    assert.equal(Number(video.output.params.duration), script.duration)
    assert.ok(video.output.prompt.includes(renderStoryShotTimedActions(script)))
    assert.match(evidence.url, /^\/generated\/[\w.-]+\.mp4$/)
    const file = path.resolve('public', evidence.url.slice(1))
    const bytes = await readFile(file)
    assert.equal(sha(bytes), evidence.sha256)
    const decoded = spawnSync(ffmpeg, ['-hide_banner', '-nostdin', '-xerror', '-i', file, '-f', 'null', '-'],
      { maxBuffer: 8_000_000, encoding: 'utf8' })
    assert.equal(decoded.status, 0, decoded.stderr?.slice(-1000))
    const metadata = validateVideoMetadata(parseFfmpegMetadata(decoded.stderr), script.duration, '9:16', true)
    assert.ok(evidence.frames.length >= 4)
    assert.equal(evidence.frames.length, evidence.frameTimes.length)
    shots.push({ number, title: script.title, plannedSeconds: script.duration,
      video: evidence.url, sha256: evidence.sha256, bytes: bytes.length,
      duration: metadata.duration, width: metadata.width, height: metadata.height,
      hasAudio: metadata.hasAudio, frameEvidenceCount: evidence.frames.length,
      reviewStatus: review.reviewStatus, passed: review.passed === true,
      retryable: review.retryable === true, issues: review.issues,
      beatStatuses: review.beatChecks?.map(check => ({ id: check.id, status: check.status })),
      endingHoldStatus: review.endingHold?.status ?? null,
      vocalAcousticStatus: review.vocalEvidence?.acousticStatus ?? null,
      vocalSemanticStatus: review.vocalEvidence?.semanticStatus ?? null })
  }
  assert.notEqual(shots[0].sha256, shots[1].sha256)
  const report = { version: 'story-independent-two-shot-audit-v1', recordId,
    recordResultMd5: row.md5, sourceExecutionId: marker.sourceExecutionId,
    sourceResultMd5: marker.sourceResultMd5, sourceUnchanged: true,
    firstAndSecondConcatSkipped: true, bothVideoFilesDecoded: true,
    bothReviewsPassed: shots.every(shot => shot.passed),
    humanAccepted: false, shots }
  if (outputFile) await writeFile(outputFile, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify(report, null, 2))
} finally { await db.end() }
