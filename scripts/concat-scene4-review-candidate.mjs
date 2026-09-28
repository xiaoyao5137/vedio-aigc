#!/usr/bin/env node
// Independent four-shot preview from preserved local media. No execution DB
// write, no workflow change, no regeneration, and no old concat replacement.
import { createHash } from 'node:crypto'
import { copyFile, readFile, writeFile, constants } from 'node:fs/promises'
import pg from 'pg'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { concatenateVideos } from '../server/video-concat.ts'

const candidateDir = process.argv[2]
if (!candidateDir || process.argv.length !== 3) throw Error('Usage: node scripts/concat-scene4-review-candidate.mjs EXISTING_CANDIDATE_DIR')
const sourceId = 'record-610-scene4-voice-repair-20260928-v1'
const sourceMd5 = 'df7ddd75cf661ae5ee5d60656854989c'
const latest = JSON.parse(await readFile(`${candidateDir}/candidate-evidence.json`, 'utf8'))
const paid = JSON.parse(await readFile(`${candidateDir}/paid-result-proof.json`, 'utf8'))
const previousThird = JSON.parse(await readFile('public/generated/verified-5e8e7e84ea39567a15a4-sampling-708d1e132e74a31c-evidence.json', 'utf8'))
if (paid.taskId !== '933466922573271098' || latest.videoUrl !== '/generated/verified-38ddc16e7d67eb4f8a77.mp4'
  || previousThird.url !== '/generated/verified-5e8e7e84ea39567a15a4.mp4') throw Error('Preserved media identity mismatch')
const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
let source, runs
try {
  source = (await db.query('SELECT id,result,md5(result::text) AS md5 FROM execution_records WHERE id=$1', [sourceId])).rows[0]
  if (source?.md5 !== sourceMd5) throw Error('Frozen scene source changed')
  const state = decodeExecutionState(source.result)
  runs = [0, 1, 2].map(loop => {
    const matches = state.nodeRuns.filter(item => item.node.id === 'sanguo-video' && item.loopIndex === loop)
    if (matches.length !== 1 || matches[0].status !== 'success') throw Error(`Shot ${loop + 1} saved video missing`)
    return matches[0]
  })
  if (previousThird.originalUrl !== runs[2].output.url) throw Error('Third decoded clip does not match saved third-shot provider result')
} finally { await db.end() }
const urls = [runs[0].output.url, runs[1].output.url, previousThird.url, latest.videoUrl]
const digest = value => createHash('sha256').update(value).digest('hex')
const inputHashes = await Promise.all(urls.map(async url => digest(await readFile('public' + url))))
if (inputHashes[2] !== previousThird.sha256 || inputHashes[3] !== latest.sha256) throw Error('Third or fourth candidate bytes changed')
const result = await concatenateVideos({ videos: urls, format: 'mp4', resolution: '720p', aspectRatio: '16:9' })
if (result.count !== 4 || result.sourceSha256.join(',') !== inputHashes.join(',')) throw Error('Concat did not preserve all four source identities and order')
const explicitUrl = '/generated/scene4-user-review-four-shot-candidate-20260928-v1.mp4'
await copyFile('public' + result.url, 'public' + explicitUrl, constants.COPYFILE_EXCL)
const outputHash = digest(await readFile('public' + explicitUrl))
const proof = { format: 'sanguo-four-shot-scene4-user-review-candidate-v1', label: '待用户验收候选',
  sourceExecution: sourceId, sourceExecutionMd5: sourceMd5, latestProviderTask: paid.taskId,
  sourceUrls: urls, sourceSha256: inputHashes, internalConcatUrl: result.url,
  candidateUrl: explicitUrl, candidateAbsolutePath: `${process.cwd()}/public${explicitUrl}`, candidateSha256: outputHash,
  concatMode: result.concatMode, width: result.width, height: result.height, fps: result.fps,
  audioSampleRate: result.audioSampleRate, executionRowsChanged: 0, workflowRowsChanged: 0,
  oldVideosOverwritten: false, mediaModelCalls: 0, technicalValidation: 'pending', aestheticAcceptance: 'pending-user' }
await writeFile(`${candidateDir}/four-shot-candidate-proof.json`, JSON.stringify(proof, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
console.log(JSON.stringify({ label: proof.label, candidateAbsolutePath: proof.candidateAbsolutePath,
  candidateUrl: proof.candidateUrl, candidateSha256: proof.candidateSha256,
  sourceSha256: inputHashes, concatMode: proof.concatMode, technicalValidation: proof.technicalValidation }, null, 2))
