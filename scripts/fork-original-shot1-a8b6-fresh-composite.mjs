#!/usr/bin/env node
/** Bind a signed A8+B6 fresh composite to schema180 node52 without a provider
 * request. The router, signed image approval, paid phases and receipt remain
 * immutable parents. Dry-run by default; apply requires all reviewed CAS pins. */
import { pathToFileURL } from 'node:url'
import pg from 'pg'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { sceneCutRebindSha256 } from '../server/scene-cut-approval-rebind.ts'
import { verifyFreshA8B6CompositeReceipt } from
  '../server/staged-scene-cut-a8b6-fresh-composite.mjs'
import { prepareFreshA8B6SourceBoundFork } from
  '../server/staged-scene-cut-a8b6-fresh-source-bound-fork.mjs'

const WORKFLOW_ID = 'wf-sanguo-history-drama'
const NODES_MD5 = '3ed9cf16e56b311458f4c6fa7e7f1e2e'
const EDGES_MD5 = '1d0a75acb3d4778a122a4cfd96a23b49'
const ID = /^record-[\w-]+$/
const MD5 = /^[a-f0-9]{32}$/
const SHA = /^[a-f0-9]{64}$/
const V8_VARIANT = 'a8b6-local-composite-v8'
const V8_ROUTER_ID = 'record-4x5m31-a8b6-local-v8-router-v1'
const V9_VARIANT = 'a8b6-local-composite-v9'
const V9_ROUTER_ID = 'record-4x5m31-a8b6-local-v9-router-v1'
const fail = reason => { throw Error(`A8B6_FRESH_SOURCE_BOUND_FORK_INVALID: ${reason}`) }

export function parseFreshSourceBoundForkArgs(values) {
  const options = { apply: false }
  const fields = { '--source': 'sourceId', '--id': 'id',
    '--plan': 'planId', '--expected-source-md5': 'sourceMd5',
    '--expected-image-md5': 'imageMd5',
    '--expected-manifest-sha256': 'manifestSha256',
    '--expected-receipt-sha256': 'receiptSha256',
    '--expected-nodes-md5': 'nodesMd5',
    '--expected-edges-md5': 'edgesMd5' }
  for (let index = 0; index < values.length; index++) {
    const flag = values[index]
    if (flag === '--apply') {
      if (options.apply) fail('duplicate --apply')
      options.apply = true
      continue
    }
    const field = fields[flag]
    if (!field || options[field] !== undefined
      || !values[index + 1] || values[index + 1].startsWith('--'))
      fail(`unknown, duplicate or incomplete ${flag}`)
    options[field] = values[++index]
  }
  if (!ID.test(String(options.sourceId))
    || !SHA.test(String(options.planId))
    || options.id !== undefined && (!ID.test(options.id)
      || options.id === options.sourceId)
    || options.sourceMd5 !== undefined && !MD5.test(options.sourceMd5)
    || options.imageMd5 !== undefined && !MD5.test(options.imageMd5)
    || options.manifestSha256 !== undefined
      && !SHA.test(options.manifestSha256)
    || options.receiptSha256 !== undefined
      && !SHA.test(options.receiptSha256)
    || options.nodesMd5 !== undefined && options.nodesMd5 !== NODES_MD5
    || options.edgesMd5 !== undefined && options.edgesMd5 !== EDGES_MD5)
    fail('source, plan, child or reviewed hash argument is malformed')
  if (options.apply && (!options.id || !options.sourceMd5
    || !options.imageMd5 || !options.manifestSha256
    || !options.receiptSha256 || !options.nodesMd5
    || !options.edgesMd5))
    fail('--apply requires child ID, router/image CAS, receipt and graph hashes')
  return options
}

async function main() {
  const options = parseFreshSourceBoundForkArgs(process.argv.slice(2))
  let verified
  try { verified = await verifyFreshA8B6CompositeReceipt(options.planId) }
  catch (error) {
    fail(`signed A/B composite receipt unavailable or invalid: ${error instanceof Error
      ? error.message : String(error)}`)
  }
  if (options.manifestSha256 && options.manifestSha256
      !== verified.manifestSha256
    || options.receiptSha256 && options.receiptSha256
      !== verified.receiptSha256)
    fail('reviewed manifest or composite receipt changed')
  if (verified.manifest.source?.frameProvenanceVariant === V8_VARIANT
    && options.sourceId !== V8_ROUTER_ID)
    fail('V8 composite must continue from the independently approved V8 router')
  if (verified.manifest.source?.frameProvenanceVariant === V9_VARIANT
    && options.sourceId !== V9_ROUTER_ID)
    fail('V9 composite must continue from the independently approved V9 router')
  const imageId = verified.manifest.source.freshFrameExecutionId
  if (!ID.test(String(imageId))) fail('signed image approval record ID invalid')
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL
    ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await db.connect()
  try {
    await db.query(options.apply ? 'BEGIN' : 'BEGIN READ ONLY')
    const suffix = options.apply ? ' FOR SHARE' : ''
    const row = async id => (await db.query(`SELECT *,md5(result::text) AS result_md5
      FROM execution_records WHERE id=$1${suffix}`, [id])).rows[0]
    const source = await row(options.sourceId)
    const image = await row(imageId)
    const workflow = (await db.query(`SELECT *,md5(nodes::text) AS nodes_md5,
      md5(edges::text) AS edges_md5 FROM workflow_configs
      WHERE id=$1${suffix}`, [WORKFLOW_ID])).rows[0]
    if (!source || !image || workflow?.schema_version !== 180
      || workflow.nodes_md5 !== NODES_MD5
      || workflow.edges_md5 !== EDGES_MD5)
      fail('router, image approval or schema180 graph unavailable')
    if (options.sourceMd5 && options.sourceMd5 !== source.result_md5
      || options.imageMd5 && options.imageMd5 !== image.result_md5
      || options.nodesMd5 && options.nodesMd5 !== workflow.nodes_md5
      || options.edgesMd5 && options.edgesMd5 !== workflow.edges_md5)
      fail('reviewed router/image/graph CAS changed')
    if (options.id && (await db.query('SELECT 1 FROM execution_records WHERE id=$1',
      [options.id])).rowCount)
      fail('destination child already exists')
    const { state, proof } = prepareFreshA8B6SourceBoundFork(source,
      image, workflow, verified, { id: options.id })
    if (options.apply) {
      await db.query(`INSERT INTO execution_records
        (id,workflow_id,workflow_name,mode,title,runtime_inputs,result,
          succeeded_count,failed_count,total_count)
        VALUES ($1,$2,$3,'step',$4,$5::jsonb,$6::jsonb,$7,0,$8)`, [
        state.id, source.workflow_id, source.workflow_name,
        `首镜 A8+B6 成片重新采证 · ${source.id}`,
        JSON.stringify(source.runtime_inputs ?? {}),
        JSON.stringify(encodeExecutionState(state)),
        state.nodeRuns.filter(run => run.status === 'success').length,
        state.nodeRuns.length ])
      const saved = await row(state.id)
      if (!saved || sceneCutRebindSha256(decodeExecutionState(saved.result))
        !== sceneCutRebindSha256(state))
        fail('saved child differs from reviewed source-bound checkpoint')
    }
    const sourceAfter = await row(source.id)
    const imageAfter = await row(image.id)
    const graphAfter = (await db.query(`SELECT schema_version,
      md5(nodes::text) AS nodes_md5,
      md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1`,
    [WORKFLOW_ID])).rows[0]
    if (sourceAfter?.result_md5 !== source.result_md5
      || imageAfter?.result_md5 !== image.result_md5
      || graphAfter?.schema_version !== workflow.schema_version
      || graphAfter.nodes_md5 !== workflow.nodes_md5
      || graphAfter.edges_md5 !== workflow.edges_md5)
      fail('router, image approval or workflow changed during fork')
    const verifiedAfter = await verifyFreshA8B6CompositeReceipt(options.planId)
    if (verifiedAfter.manifestSha256 !== verified.manifestSha256
      || verifiedAfter.receiptSha256 !== verified.receiptSha256)
      fail('signed composite changed during fork')
    await db.query(options.apply ? 'COMMIT' : 'ROLLBACK')
    console.log(JSON.stringify({ mode: options.apply ? 'applied' : 'read-only',
      ...proof, sourceId: source.id, sourceResultMd5: source.result_md5,
      imageApprovalId: image.id, imageApprovalResultMd5: image.result_md5,
      frameProvenanceVariant:
        verified.manifest.source.frameProvenanceVariant ?? 'fresh-image',
      applied: options.apply, databaseWrites: options.apply ? 1 : 0 }, null, 2))
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { await db.end() }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  main().catch(error => { console.error(error instanceof Error
    ? error.message : String(error)); process.exitCode = 1 })
