// Read-only calibration audit. Never generates media, invokes ASR, or writes DB rows.
// node scripts/audit-duration-calibration.mjs --limit 50
// node scripts/audit-duration-calibration.mjs --input logs/duration-design-2026-09-08/latest-execution.json
import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import pg from 'pg'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { durationCalibrationRecord, aggregateDurationCalibration } from '../src/duration-observability.ts'

const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {}
const rows = value => Array.isArray(value) ? value : []

export async function collectDurationCalibrationRecords(executions, root = process.cwd()) {
  const samples = [], diagnostics = [], hashes = new Map()
  const mediaHash = async video => {
    const stored = video.sourceSha256 ?? video.nativeSequence?.sourceVideoSha256
    if (typeof stored === 'string' && /^[a-f0-9]{64}$/i.test(stored)) return stored
    const url = video.url
    if (typeof url !== 'string' || !/^\/generated\/[\w.-]+\.mp4$/.test(url)) return null
    if (!hashes.has(url)) hashes.set(url, (async () => {
      try {
        const hash = createHash('sha256')
        for await (const chunk of createReadStream(path.join(root, 'public', url))) hash.update(chunk)
        return hash.digest('hex')
      } catch (error) { diagnostics.push({ mediaUrl: url, issue: 'local-media-hash-unavailable', error: error.code ?? error.message }); return null }
    })())
    return hashes.get(url)
  }
  for (const execution of executions) {
    let state
    try { state = decodeExecutionState(execution.result ?? execution) } catch (error) {
      diagnostics.push({ executionId: execution.id, issue: 'execution-decode-failed', error: error.message }); continue
    }
    const scenes = [rows(state.nodeRuns), ...rows(state.branchHistory).map(branch => rows(branch.scene))]
    for (const scene of scenes) for (const [index, run] of scene.entries()) {
      if (!['video_evidence', 'video_shot'].includes(run.node?.resultVar)) continue
      const previous = resultVar => scene.slice(0, index + 1).reverse().find(other => other.node?.resultVar === resultVar
        && other.loopGroupId === run.loopGroupId && other.loopIndex === run.loopIndex && other.output)?.output
      for (const snapshot of [...rows(run.attempts), run]) {
        const output = object(snapshot.output)
        if (!Object.keys(output).length) continue
        const context = object(snapshot.context ?? snapshot.inputContext ?? run.context ?? run.inputContext)
        const shot = context.shot_script ?? previous('shot_script') ?? context.shot_candidate ?? previous('shot_candidate')
        if (!shot?.pacing && !shot?.timingEstimate) continue
        const evidence = output.decoded ? output : object(context.video_evidence ?? previous('video_evidence'))
        if (!evidence.decoded || !evidence.url) continue
        const video = run.node.resultVar === 'video_shot' ? { ...evidence, ...output } : evidence
        const take = object(context.video_take ?? previous('video_take'))
        const model = object(take.model)
        // Keep configured/provider identifiers explicit; never use the reviewer model.
        const recordedVersion = take.params?.model_name ?? take.params?.modelVersion ?? model.version
        const modelVersion = String(recordedVersion || 'unknown')
        const configuredModelId = String(model.id ?? (typeof take.model === 'string' ? take.model : ''))
        const hash = await mediaHash(video)
        samples.push({ ...durationCalibrationRecord({ shot, video: { ...video, sourceSha256: hash }, modelVersion }),
          executionId: execution.id ?? state.id, runId: run.id ?? run.node?.id, loopIndex: run.loopIndex,
          configuredModelId, modelVersionSource: recordedVersion ? 'recorded-provider-version' : 'unrecorded-configured-id-only',
          mediaUrl: evidence.url, createdAt: execution.created_at ?? execution.createdAt ?? null })
      }
    }
  }
  return { samples, diagnostics }
}

async function main() {
  const args = process.argv.slice(2), option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback
  if (args.includes('--help')) {
    console.log('Read-only: node scripts/audit-duration-calibration.mjs [--limit 50] [--input execution.json] [--output logs/duration-v2-implementation]')
    return
  }
  const input = option('--input'), limit = Number(option('--limit', '50'))
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('--limit must be an integer from 1 to 1000')
  let executions
  if (input) {
    const value = JSON.parse(await fs.readFile(path.resolve(input), 'utf8'))
    executions = Array.isArray(value) ? value : Array.isArray(value.records) ? value.records : [value.record ?? value]
  } else {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
    const client = await pool.connect()
    try {
      await client.query('BEGIN READ ONLY')
      executions = (await client.query("select id, created_at, result from execution_records where workflow_id = $1 order by created_at desc limit $2", ['wf-sanguo-history-drama', limit])).rows
      await client.query('COMMIT')
    } finally { client.release(); await pool.end() }
  }
  const { samples, diagnostics } = await collectDurationCalibrationRecords(executions)
  const report = { auditedAt: new Date().toISOString(), source: input ? 'saved-executions' : 'read-only-database-snapshot',
    executionsInspected: executions.length, scope: 'historical-duration-evidence-not-new-media-acceptance',
    ...aggregateDurationCalibration(samples), diagnostics }
  const directory = path.resolve(option('--output', 'logs/duration-v2-implementation'))
  await fs.mkdir(directory, { recursive: true })
  const destination = path.join(directory, 'duration-calibration-' + report.auditedAt.replace(/[:.]/g, '-') + '.json')
  await fs.writeFile(destination, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ report: destination, executionsInspected: report.executionsInspected, uniqueMediaCount: report.uniqueMediaCount,
    duplicatesRemoved: report.duplicatesRemoved, missingMediaHashRecords: report.missingMediaHashRecords, groups: report.groups, diagnostics: diagnostics.length }, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1 })
