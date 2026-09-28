#!/usr/bin/env node
// Claim and inspect an already completed task. No generation request or
// execution/workflow mutation; only local evidence files are written.
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import pg from 'pg'
import { collectVideoEvidence } from '../server/video-inspection.ts'
import { createJsonHasher } from './restore-branch-checkpoint.mjs'

const out = process.argv[2]
if (!out || process.argv.length !== 3) throw Error('Usage: node scripts/inspect-preserved-scene4-candidate.mjs EXISTING_CANDIDATE_DIR')
const submitted = JSON.parse(await readFile(`${out}/request-submitted.json`, 'utf8'))
const privateRequest = JSON.parse(await readFile(`${out}/request-private.json`, 'utf8'))
if (submitted.requestKey !== privateRequest.requestKey) throw Error('Saved request identity mismatch')
const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
let row
try {
  const rows = (await db.query("SELECT * FROM model_execution_records WHERE request_data->>'requestKey'=$1 ORDER BY created_at", [submitted.requestKey])).rows
  if (rows.length !== 1 || rows[0].status !== 'succeeded' || rows[0].http_status !== 200) throw Error('The sole preserved paid task is not completed')
  row = rows[0]
  // The model ledger intentionally redacts the large historical voice preview
  // blob. Reproduce only that exact managed redaction before comparing.
  const expectedParams = structuredClone(privateRequest.params)
  const preview = expectedParams.voiceAssets?.[0]?.providerResult?.output?.preview_audio
  if (typeof preview?.data !== 'string' || !preview.data.length) throw Error('Saved voice preview binding is incomplete')
  preview.data = `[素材内容已隐藏，${preview.data.length} 字符]`
  if (row.request_data?.prompt !== privateRequest.prompt
    || createJsonHasher()(row.request_data?.params) !== createJsonHasher()(expectedParams)
    || row.model_id !== privateRequest.modelId) throw Error('Ledger request differs from the guarded candidate')
} finally { await db.end() }
const task = row.response_data?.data
const url = task?.task_result?.videos?.[0]?.url
if (task?.task_id !== row.task_id || task?.task_status !== 'succeed' || typeof url !== 'string' || !url.startsWith('https://'))
  throw Error('Completed task has no valid video identity or URL')
const safe = { format: 'scene4-preserved-paid-result-v1', ledgerId: row.id, taskId: row.task_id,
  requestKey: submitted.requestKey, status: row.status, httpStatus: row.http_status,
  providerDuration: task.task_result.videos[0].duration, finalUnitDeduction: task.final_unit_deduction,
  finalBalanceDeduction: task.final_balance_deduction, videoUrlSha256: createHash('sha256').update(url).digest('hex'),
  noNewGeneration: true, noExecutionMutation: true, noWorkflowMutation: true, concatRan: false }
await writeFile(`${out}/paid-result-private.json`, JSON.stringify({ ...safe, url }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
await writeFile(`${out}/paid-result-proof.json`, JSON.stringify(safe, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
const sampleTimes = Array.from({ length: 23 }, (_, i) => i * .5)
const evidence = await collectVideoEvidence({ url, sampleTimes,
  audioText: privateRequest.params.audioText, audioType: privateRequest.params.audioType,
  qualityMode: 'principle-v1', previousTail: '/generated/verified-5e8e7e84ea39567a15a4-sampling-708d1e132e74a31c-frame-7.jpg' })
const audit = { ...safe, evidenceUrl: evidence.evidenceUrl, videoUrl: evidence.url, sha256: evidence.sha256,
  duration: evidence.duration, width: evidence.width, height: evidence.height, hasAudio: evidence.hasAudio,
  meanVolumeDb: evidence.meanVolumeDb, frameCount: evidence.frames.length, frameTimes: evidence.frameTimes,
  frames: evidence.frames, previousTailDifference: evidence.firstFrameDifference,
  speechEvidenceStatus: evidence.speechEvidenceStatus ?? 'collected', speechValidation: evidence.speechValidation,
  transcript: evidence.transcript, decoded: evidence.decoded, continuityReview: 'pending-human-visual', concatRan: false }
await writeFile(`${out}/candidate-evidence.json`, JSON.stringify(audit, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
console.log(JSON.stringify({ taskId: safe.taskId, finalUnitDeduction: safe.finalUnitDeduction,
  videoUrl: audit.videoUrl, evidenceUrl: audit.evidenceUrl, duration: audit.duration,
  frameCount: audit.frameCount, previousTailDifference: audit.previousTailDifference,
  speechEvidenceStatus: audit.speechEvidenceStatus }, null, 2))
