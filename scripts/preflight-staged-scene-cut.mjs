#!/usr/bin/env node
// Read-only by default. --save-plan writes only local guide JPEGs and a signed
// manifest after the caller has checked all three dry-run source hashes.
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import pg from 'pg'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { planStagedShot1, previewStageARequest, saveStagedPlan } from '../server/staged-scene-cut.mjs'

const invalid = message => { throw Error(`STAGED_SCENE_CUT_PREFLIGHT_INVALID: ${message}`) }
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const md5 = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value)
const args = process.argv.slice(2)
const options = { save: false }
for (let index = 0; index < args.length; index++) {
  const arg = args[index]
  if (arg === '--save-plan') { if (options.save) invalid('duplicate --save-plan'); options.save = true; continue }
  const field = { '--record': 'recordId', '--expected-result-md5': 'expectedResultMd5',
    '--expected-source-video-sha256': 'expectedVideoSha256',
    '--expected-plan-id': 'expectedPlanId', '--prompt-version': 'promptVersion' }[arg]
  if (!field || options[field] || !args[index + 1] || args[index + 1].startsWith('--'))
    invalid(`unknown, duplicate, or incomplete argument ${arg}`)
  options[field] = args[++index]
}
if (!/^record-[\w-]+$/.test(options.recordId ?? '')) invalid('--record is required')
if (options.expectedResultMd5 && !md5(options.expectedResultMd5)) invalid('expected result MD5 invalid')
if (options.expectedVideoSha256 && !sha(options.expectedVideoSha256)) invalid('expected video SHA-256 invalid')
if (options.expectedPlanId && !sha(options.expectedPlanId)) invalid('expected plan ID invalid')
if (options.promptVersion && !['v1', 'early-binding-v2', 'early-binding-v3', 'early-binding-v3-retry1',
  'early-binding-v3-compact1'].includes(options.promptVersion))
  invalid('prompt version invalid')
if (options.save && (!options.expectedResultMd5 || !options.expectedVideoSha256 || !options.expectedPlanId))
  invalid('--save-plan requires the three reviewed dry-run hashes')

const root = process.cwd()
const db = new pg.Client({ connectionString: process.env.DATABASE_URL
  ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
let row
try {
  const result = await db.query('select result, md5(result::text) as result_md5 from execution_records where id=$1', [options.recordId])
  if (result.rows.length !== 1) invalid('source record missing')
  row = result.rows[0]
} finally { await db.end() }
if (options.expectedResultMd5 && row.result_md5 !== options.expectedResultMd5) invalid('source record changed')
const state = decodeExecutionState(row.result)
const runs = state.nodeRuns
if (state.id !== options.recordId || runs?.[44]?.context?.shot_script?.id !== 'scene-01'
  || runs?.[50]?.node?.id !== 'sanguo-scene-cut-approval'
  || runs?.[52]?.node?.id !== 'sanguo-video'
  || runs[52].status !== 'success' || runs[58]?.output?.decision !== 'revise')
  invalid('record does not have a rejected scene-01 candidate and approved image')
const videoUrl = runs[52].output.url
if (typeof videoUrl !== 'string' || !/^\/generated\/[\w.-]+\.mp4$/.test(videoUrl)) invalid('rejected media is not local')
const file = path.join(root, 'public', videoUrl.slice(1))
const digest = createHash('sha256')
for await (const chunk of createReadStream(file)) digest.update(chunk)
const videoSha256 = digest.digest('hex')
if (options.expectedVideoSha256 && videoSha256 !== options.expectedVideoSha256) invalid('source video changed')
const plan = await planStagedShot1({ recordId: options.recordId, resultMd5: row.result_md5,
  promptVersion: options.promptVersion,
  shot: runs[44].context.shot_script, certificate: runs[50].output,
  videoParams: runs[52].output.params, rejectedVideoUrl: videoUrl,
  rejectedVideoSha256: videoSha256,
  narrationTracks: runs[52].output.raw?.narration?.tracks }, root)
if (options.expectedPlanId && plan.planId !== options.expectedPlanId) invalid('plan changed')
const preview = await previewStageARequest(plan, root)
const saved = options.save ? await saveStagedPlan(plan, root) : undefined
console.log(JSON.stringify({ mode: options.save ? 'saved-local-plan' : 'read-only-dry-run',
  planId: plan.planId, sourceRecordId: plan.sourceRecordId,
  sourceResultMd5: plan.sourceResultMd5, sourceVideoSha256: plan.rejectedVideo.sha256,
  approvedShotSha256: plan.approvedShotSha256, approvalSha256: plan.approvalSha256,
  promptVersion: plan.promptVersion ?? 'v1',
  phases: plan.phases.map(({ id, providerSeconds, acceptedSeconds, globalStart, seamFrame }) =>
    ({ id, providerSeconds, acceptedSeconds, globalStart, seamFrame })),
  guideFrames: Object.values(plan.guides).map(({ sourceFrameIndex, jpegSha256, url }) =>
    ({ sourceFrameIndex, jpegSha256, url, role: 'reference-only' })),
  phaseAPreview: preview, phaseB: 'blocked until signed task and native acceptance of phase A',
  ...(saved ? { manifestPath: saved.manifestPath } : {}),
  providerCalls: 0, databaseWrites: 0 }, null, 2))
