#!/usr/bin/env node
/** Read-only A8 paid-request preview for the independently reviewed local
 * first frame; --save-plan still requires a separate signed workflow approval. */
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { resolveKlingOmniVideoEndpoint } from '../server/model-adapters.ts'
import { verifyA8B6FrameConflictReceipt } from
  '../server/staged-scene-cut-a8b6-frame-conflict.mjs'
import { A8B6_FRESH_PREFLIGHT_SOURCE_IDS, readA8B6HistoricQaManifest,
  prepareA8B6FreshRegenerationPreflight } from
  '../server/staged-scene-cut-a8b6-fresh-preflight.mjs'
import { planFreshA8B6PhaseA, saveFreshA8B6PhaseAPlan } from
  '../server/staged-scene-cut-a8b6-fresh-ledger.mjs'

const invalid = message => { throw Error(`A8B6_LOCAL_V2_A_PLAN_INVALID: ${message}`) }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2), options = { save: false }
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--save-plan') {
    if (options.save) invalid('duplicate --save-plan')
    options.save = true
    continue
  }
  const field = { '--expected-fresh-id': 'freshId',
    '--expected-fresh-md5': 'freshMd5',
    '--expected-plan-id': 'planId', '--expected-request-sha256': 'requestSha256',
    '--expected-model-id': 'modelId',
    '--expected-endpoint-sha256': 'endpointSha256' }[argv[i]]
  if (!field || options[field] || !argv[i + 1] || argv[i + 1].startsWith('--'))
    invalid(`invalid or repeated ${argv[i]}`)
  options[field] = argv[++i]
}
if (!/^[a-f0-9]{32}$/.test(options.freshMd5 ?? ''))
  invalid('--expected-fresh-md5 is required')
if (options.freshId && !/^record-[\w-]+$/.test(options.freshId))
  invalid('--expected-fresh-id is invalid')
if (options.save && (!options.freshId
  || !/^[a-f0-9]{64}$/.test(options.planId ?? '')
  || !/^[a-f0-9]{64}$/.test(options.requestSha256 ?? '')
  || !options.modelId || !/^[a-f0-9]{64}$/.test(options.endpointSha256 ?? '')))
  invalid('--save-plan requires reviewed plan/request/model/endpoint locks')
const { SOURCE_ID, TIMING_ID, REJECTED_ID, RETRY_ID, QA_PLAN_ID } =
  A8B6_FRESH_PREFLIGHT_SOURCE_IDS
const { prepareA8B6LocalApprovedImageCandidateV2 } = await import(
  '../server/staged-scene-cut-a8b6-local-approved-candidate-v2.mjs')
const candidate = await prepareA8B6LocalApprovedImageCandidateV2(root)
const freshId = candidate.sourceRow?.id
if (!/^record-[\w-]+$/.test(String(freshId))
  || candidate.sourceRow?.result_md5 !== options.freshMd5
  || options.freshId && options.freshId !== freshId)
  invalid('approved local image candidate ID or CAS MD5 differs')
const qa = readA8B6HistoricQaManifest(root)
const conflict = await verifyA8B6FrameConflictReceipt(QA_PLAN_ID, root)
const db = new pg.Client({ connectionString: process.env.DATABASE_URL
  ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
let plan
try {
  await db.query('BEGIN READ ONLY')
  const ids = [SOURCE_ID, TIMING_ID, REJECTED_ID, RETRY_ID]
  const rows = (await db.query(`SELECT id,workflow_id,result,
    md5(result::text) AS result_md5 FROM execution_records WHERE id=ANY($1)`,
  [ids])).rows
  const byId = new Map(rows.map(row => [row.id, row]))
  if (rows.length !== 4)
    invalid('old source records missing')
  const workflowRow = (await db.query(`SELECT id,schema_version,nodes,
    md5(nodes::text) AS nodes_md5,md5(edges::text) AS edges_md5
    FROM workflow_configs WHERE id='wf-sanguo-history-drama'`)).rows[0]
  const ledgerRows = (await db.query(`SELECT * FROM model_execution_records
    WHERE workflow_id='wf-sanguo-history-drama'
      AND node_id='sanguo-scene-cut-review' AND status='succeeded'
      AND request_data->>'requestKey' LIKE $1
    ORDER BY created_at DESC LIMIT 20`, [`${RETRY_ID}:%`])).rows
  const preflight = prepareA8B6FreshRegenerationPreflight({
    sourceRow: byId.get(SOURCE_ID), timingRow: byId.get(TIMING_ID),
    rejectedRow: byId.get(REJECTED_ID), retryRow: byId.get(RETRY_ID),
    workflowRow, qa, conflict, ledgerRows, root })
  const videoNode = workflowRow.nodes?.find(node => node.id === 'sanguo-video')
  const model = videoNode && (await db.query(`SELECT id,provider,capability,settings
    FROM model_configs WHERE id=$1`, [videoNode.modelId])).rows[0]
  if (model?.id !== 'keling3' || model.provider !== 'Kling'
    || model.capability !== 'video' || !model.settings?.endpoint)
    invalid('configured paid video provider changed')
  const endpoint = resolveKlingOmniVideoEndpoint(model.settings.endpoint)
  const providerLock = { modelId: model.id,
    endpointSha256: createHash('sha256').update(endpoint).digest('hex') }
  plan = await planFreshA8B6PhaseA(preflight, candidate, providerLock, root)
  if (plan.source?.frameProvenanceVariant !== 'a8b6-local-composite-v2'
    || plan.source.localCompositeSourceReceiptSha256
      !== candidate.localCompositeSourceReceiptSha256
    || plan.source.imageModelExecutionId !== null)
    invalid('new A request did not select the source-bound local variant')
  if (options.planId && plan.planId !== options.planId
    || options.requestSha256 && plan.phaseAPreview.requestSha256 !== options.requestSha256
    || options.modelId && model.id !== options.modelId
    || options.endpointSha256 && providerLock.endpointSha256 !== options.endpointSha256)
    invalid('new A reviewed paid request/source/provider lock changed')
  if ((await db.query('SELECT md5(result::text) AS result_md5 FROM execution_records WHERE id=$1',
    [freshId])).rows[0]?.result_md5 !== options.freshMd5)
    invalid('new first-frame record changed during preflight')
  await db.query('ROLLBACK')
} catch (error) {
  await db.query('ROLLBACK').catch(() => undefined)
  throw error
} finally { await db.end() }
const saved = options.save ? await saveFreshA8B6PhaseAPlan(plan, root) : undefined
console.log(JSON.stringify({ mode: options.save ? 'signed-local-composite-v2-A-plan' : 'read-only-local-composite-v2-A-request-preview',
  planId: plan.planId, source: plan.source,
  phaseAPreview: plan.phaseAPreview,
  providerLock: plan.providerLock,
  compactTransport: { totalBytes: plan.compactTransport.totalBytes,
    entries: plan.compactTransport.entries.map(entry => ({ role: entry.role,
      sourceSha256: entry.source.sha256,
      transportSha256: entry.transport.sha256, bytes: entry.transport.byteLength })) },
  ...(saved ? { manifestSha256: saved.manifestSha256,
    manifestPath: saved.manifestPath } : {}),
  providerCalls: 0, databaseWrites: 0,
  mediaWrites: options.save ? 3 : 0 }, null, 2))
