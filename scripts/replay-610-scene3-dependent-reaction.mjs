#!/usr/bin/env node
// Replays only the already-paid scene-03 clip. No image/video provider request,
// execution-record mutation, or concatenation. Review is a separate step.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'
import { executeCodeNode } from '../server/code-node.ts'
import { decodeExecutionState } from '../src/execution-storage.ts'

const out = path.resolve('logs/dramatic-expression/live-20260928/record-7cb4d1-readonly/loop3-media/scene3-speech-reaction-replay-20260928-v1')
const shotPath = path.resolve('logs/dramatic-expression/live-20260928/record-7cb4d1-readonly/loop3-media/scene3-coverage-first-frame-20260928-v1/review-shot.json')
const videoPath = '/generated/verified-0b0aacb761a397cd143e.mp4'
const mode = process.argv[2] ?? ''
assert.deepEqual(process.argv.slice(2), ['--evidence'])
const sha = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex')
const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
try {
  const graph = (await db.query(`select schema_version,nodes from workflow_configs where id='wf-sanguo-history-drama'`)).rows[0]
  assert.equal(graph.schema_version, 157)
  const requestNode = graph.nodes.find(node => node.id === 'sanguo-media-request')
  const evidenceNode = graph.nodes.find(node => node.id === 'sanguo-video-evidence')
  assert.equal(requestNode.kind, 'code')
  assert.equal(evidenceNode.request.url, '/api/video-evidence')
  const source = (await db.query(`select result,md5(result::text) as md5 from execution_records where id=$1`,
    ['record-610-scene4-voice-repair-20260928-v1'])).rows[0]
  assert.equal(source.md5, 'df7ddd75cf661ae5ee5d60656854989c')
  const state = decodeExecutionState(source.result)
  const oldShot = state.nodeRuns.find(run => run.node.id === 'sanguo-shot-script' && run.loopIndex === 2)?.output
  const oldTake = state.nodeRuns.find(run => run.node.id === 'sanguo-video' && run.loopIndex === 2)?.output
  const historic = state.nodeRuns.find(run => run.node.resultVar === 'historical_sources')?.output
  const projection = JSON.parse(await readFile(shotPath, 'utf8'))
  assert.equal(sha(oldShot.pacing), sha(projection.shot.pacing))
  assert.equal(oldShot.audioText, projection.shot.audioText)
  assert.equal(oldTake.url ? typeof oldTake.url : '', 'string')
  assert.equal(historic.citations.length, 1)
  const generated = await executeCodeNode({ code: requestNode.code,
    context: { shot_script: projection.shot }, params: { qualityMode: 'principle-v1' } })
  assert.equal(generated.latestSpeechEnd, 6.149)
  assert.equal(generated.speechWindows[0].beatId, 'beat-03-question')
  for (const second of [5.999, 6.499, 6.899, 7.499]) assert.ok(generated.sampleTimes.includes(second))
  const request = { url: videoPath, audioText: generated.audioText, audioType: generated.audioType,
    speechWindows: generated.speechWindows, latestSpeechEnd: generated.latestSpeechEnd,
    sampleTimes: generated.sampleTimes, previousTail: generated.previousTail, qualityMode: 'principle-v1' }
  await mkdir(out, { recursive: true })
  const intent = { format: 'scene3-dependent-reaction-evidence-intent-v1', at: new Date().toISOString(),
    sourceId: 'record-610-scene4-voice-repair-20260928-v1', sourceMd5: source.md5,
    oldProviderTaskId: '933503343597989896', existingVideoUrl: videoPath,
    approvedShotSha256: sha(projection.shot), request, newImageOrVideoProviderRequests: 0,
    sourceExecutionWrites: 0, concatAllowed: false }
  await writeFile(path.join(out, 'evidence-intent.json'), JSON.stringify(intent, null, 2) + '\n', { flag: 'wx' })
  const response = await fetch('http://127.0.0.1:5173/api/video-evidence', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.timeout(240_000) })
  const body = await response.json()
  const proof = { format: 'scene3-dependent-reaction-evidence-result-v1', at: new Date().toISOString(),
    httpStatus: response.status, evidenceUrl: body.evidenceUrl, videoUrl: body.url, originalUrl: body.originalUrl,
    decoded: body.decoded, duration: body.duration, frameTimes: body.frameTimes, frames: body.frames,
    latestSpeechEnd: body.evidenceRequest?.latestSpeechEnd, speechWindows: body.evidenceRequest?.speechWindows,
    speechValidation: body.speechValidation, transcript: body.transcript,
    historicSources: historic, newImageOrVideoProviderRequests: 0,
    sourceExecutionWrites: 0, error: body.error ?? null }
  await writeFile(path.join(out, 'evidence-result.json'), JSON.stringify(proof, null, 2) + '\n', { flag: 'wx' })
  if (!response.ok) throw new Error(`Evidence HTTP ${response.status}: ${body.error}`)
  assert.equal(body.evidenceRequest.latestSpeechEnd, 6.149)
  assert.deepEqual(body.evidenceRequest.speechWindows, generated.speechWindows)
  assert.equal(body.frames.length, body.frameTimes.length)
  assert.ok(body.evidenceUrl.includes('-review-v2-'))
  console.log(JSON.stringify({ mode, httpStatus: response.status, evidenceUrl: body.evidenceUrl,
    decoded: body.decoded, frameTimes: body.frameTimes, speechValidationPassed: body.speechValidation?.passed,
    latestSpeechEnd: body.evidenceRequest.latestSpeechEnd,
    alignment: body.speechValidation?.alignment?.map(row => ({ matchedEnd: row.matchedEnd,
      boundaryStatus: row.boundaryStatus, alignmentCoverage: row.alignmentCoverage,
      lastTokenMatched: row.lastTokenMatched })) }, null, 2))
} finally { await db.end() }
