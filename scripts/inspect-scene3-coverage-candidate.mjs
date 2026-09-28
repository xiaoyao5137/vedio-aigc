#!/usr/bin/env node
// Inspect the sole saved candidate task; never POST a second video request.
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import pg from 'pg'
import { collectVideoEvidence } from '../server/video-inspection.ts'
import { createJsonHasher } from './restore-branch-checkpoint.mjs'

const out = process.argv[2]
if (!out || process.argv.length !== 3) throw Error('Usage: node scripts/inspect-scene3-coverage-candidate.mjs EXISTING_CANDIDATE_DIR')
const frozen = JSON.parse(await readFile(`${out}/request-private.json`, 'utf8'))
const submitted = JSON.parse(await readFile(`${out}/request-submitted.json`, 'utf8'))
if (frozen.requestKey !== submitted.requestKey) throw Error('Frozen candidate request identity mismatch')
const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
let row
try {
  const rows = (await db.query("SELECT * FROM model_execution_records WHERE request_data->>'requestKey'=$1 ORDER BY created_at", [frozen.requestKey])).rows
  if (rows.length !== 1 || rows[0].status !== 'succeeded' || rows[0].http_status !== 200) throw Error('Sole paid task not completed successfully')
  row = rows[0]
  const expectedParams = structuredClone(frozen.params)
  const preview = expectedParams.voiceAssets?.[0]?.providerResult?.output?.preview_audio
  if (typeof preview?.data === 'string' && preview.data.length) preview.data = `[素材内容已隐藏，${preview.data.length} 字符]`
  const h = createJsonHasher()
  if (row.request_data?.prompt !== frozen.prompt || h(row.request_data?.params) !== h(expectedParams)
    || row.model_id !== frozen.modelId) throw Error('Paid ledger differs from frozen request')
} finally { await db.end() }
const task = row.response_data?.data
const url = task?.task_result?.videos?.[0]?.url
if (task?.task_id !== row.task_id || task?.task_status !== 'succeed' || typeof url !== 'string' || !url.startsWith('https://')) {
  throw Error('Completed task has no valid video')
}
const safe = { format: 'scene3-coverage-cut-paid-result-v1', ledgerId: row.id, taskId: row.task_id,
  requestKey: submitted.requestKey, status: row.status, httpStatus: row.http_status,
  providerDuration: task.task_result.videos[0].duration, finalUnitDeduction: task.final_unit_deduction,
  videoUrlSha256: createHash('sha256').update(url).digest('hex'),
  noNewGeneration: true, executionWrites: 0, workflowWrites: 0 }
await writeFile(`${out}/paid-result-private.json`, JSON.stringify({ ...safe, url }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
await writeFile(`${out}/paid-result-proof.json`, JSON.stringify(safe, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
const evidence = await collectVideoEvidence({ url, sampleTimes: Array.from({ length: 19 }, (_, index) => Math.min(8.9, index * .5)),
  audioText: frozen.params.audioText, audioType: frozen.params.audioType, qualityMode: 'principle-v1' })
const audit = { ...safe, evidenceUrl: evidence.evidenceUrl, videoUrl: evidence.url, sha256: evidence.sha256,
  duration: evidence.duration, width: evidence.width, height: evidence.height, hasAudio: evidence.hasAudio,
  meanVolumeDb: evidence.meanVolumeDb, frameCount: evidence.frames.length, frameTimes: evidence.frameTimes,
  frames: evidence.frames, speechEvidenceStatus: evidence.speechEvidenceStatus ?? 'collected',
  speechValidation: evidence.speechValidation, transcript: evidence.transcript, decoded: evidence.decoded,
  creativeAcceptance: 'pending-independent-visual-review', concatRan: false }
await writeFile(`${out}/candidate-evidence.json`, JSON.stringify(audit, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
console.log(JSON.stringify({ taskId: safe.taskId, finalUnitDeduction: safe.finalUnitDeduction,
  videoUrl: audit.videoUrl, evidenceUrl: audit.evidenceUrl, duration: audit.duration,
  frameCount: audit.frameCount, speechEvidenceStatus: audit.speechEvidenceStatus }, null, 2))
