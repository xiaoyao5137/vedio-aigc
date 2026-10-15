#!/usr/bin/env node
/** Replays the accepted original scene-02 candidate into a NEW schema180
 * record after the fresh 14s first shot's actual node64 tail is complete.
 * Dry-run by default. It never calls a provider. */
import { pathToFileURL } from 'node:url'
import pg from 'pg'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { sceneCutRebindSha256 } from '../server/scene-cut-approval-rebind.ts'
import { prepareScene2RegenerationPreflight } from
  '../server/staged-scene2-regeneration-preflight.mjs'
import { prepareFreshA8B6Scene2Replay } from
  '../server/staged-scene-cut-a8b6-fresh-scene2-replay.mjs'

const ORIGINAL_ID = 'record-4x5m31'
const ORIGINAL_MD5 = '74e5e2f8afcf8f829694aef350629950'
const NODES_MD5 = '3ed9cf16e56b311458f4c6fa7e7f1e2e'
const EDGES_MD5 = '1d0a75acb3d4778a122a4cfd96a23b49'
const ID = /^record-[\w-]+$/
const MD5 = /^[a-f0-9]{32}$/
const SHA = /^[a-f0-9]{64}$/
const fail = reason => { throw Error(`A8B6_FRESH_SCENE2_FORK_INVALID: ${reason}`) }

export function parseFreshScene2ForkArgs(values) {
  const options = { apply: false }
  const fields = { '--source': 'sourceId', '--id': 'id',
    '--expected-source-md5': 'sourceMd5',
    '--expected-nodes-md5': 'nodesMd5',
    '--expected-edges-md5': 'edgesMd5',
    '--expected-plan-sha256': 'planSha256' }
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
      fail(`unknown or incomplete ${flag}`)
    options[field] = values[++index]
  }
  if (options.sourceId !== undefined && !ID.test(options.sourceId)
    || options.id !== undefined && (!ID.test(options.id)
      || options.id === options.sourceId || options.id === ORIGINAL_ID)
    || options.sourceMd5 !== undefined && !MD5.test(options.sourceMd5)
    || options.nodesMd5 !== undefined && !MD5.test(options.nodesMd5)
    || options.edgesMd5 !== undefined && !MD5.test(options.edgesMd5)
    || options.planSha256 !== undefined && !SHA.test(options.planSha256))
    fail('source, new ID, MD5, or SHA argument is malformed')
  if (options.apply && (!options.sourceId || !options.id || !options.sourceMd5
    || !options.nodesMd5 || !options.edgesMd5 || !options.planSha256))
    fail('--apply requires a new ID and every reviewed source, graph, and plan hash')
  return options
}

async function main() {
  const options = parseFreshScene2ForkArgs(process.argv.slice(2))
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL
    ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await db.connect()
  try {
    await db.query(options.apply ? 'BEGIN' : 'BEGIN READ ONLY')
    const suffix = options.apply ? ' FOR SHARE' : ''
    const row = async id => (await db.query(`SELECT *,md5(result::text) AS result_md5
      FROM execution_records WHERE id=$1${suffix}`, [id])).rows[0]
    const original = await row(ORIGINAL_ID)
    if (original?.result_md5 !== ORIGINAL_MD5) fail('original approved source changed')
    if (!options.sourceId) {
      if (options.apply) fail('first-shot source ID missing')
      await db.query('ROLLBACK')
      console.log(JSON.stringify({ mode: 'read-only', status: 'blocked-formal-first-shot-source-missing',
        requiredSource: 'completed fresh A8+B6 scene-01 node64, exact saved record/MD5',
        providerCalls: 0, databaseWrites: 0 }, null, 2))
      return
    }
    const source = await row(options.sourceId)
    if (!source) fail('first-shot source record does not exist')
    if (options.sourceMd5 && source.result_md5 !== options.sourceMd5)
      fail('first-shot source MD5 differs from reviewed input')
    const first = decodeExecutionState(source.result)
    const marker = first.sceneCutCompositeRecovery
    if (marker?.version !== 'source-bound-composite-a8b6-fresh-first-shot-v1')
      fail('source is not the fresh 14s composite fork')
    const parent = await row(marker.sourceExecutionId)
    const imageApproval = await row(marker.imageApprovalExecutionId)
    if (!parent || !imageApproval) fail('signed router or image approval ancestor missing')
    const workflow = (await db.query(`SELECT *,md5(nodes::text) AS nodes_md5,
      md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1${suffix}`,
    [source.workflow_id])).rows[0]
    if (workflow?.schema_version !== 180 || workflow.nodes_md5 !== NODES_MD5
      || workflow.edges_md5 !== EDGES_MD5) fail('schema180 graph changed')
    if (options.nodesMd5 && options.nodesMd5 !== workflow.nodes_md5
      || options.edgesMd5 && options.edgesMd5 !== workflow.edges_md5)
      fail('reviewed graph hash changed')
    const prepared = prepareScene2RegenerationPreflight(original, source,
      parent, process.cwd(), imageApproval)
    if (prepared.status !== 'ready-for-new-image-review-only')
      fail(`formal first-shot tail not ready: ${prepared.status}`)
    if (options.planSha256 && options.planSha256 !== prepared.planSha256)
      fail('reviewed scene-02 preflight plan hash changed')
    if (options.id && (await db.query('SELECT 1 FROM execution_records WHERE id=$1',
      [options.id])).rowCount) fail('destination record already exists')
    const { state, proof } = prepareFreshA8B6Scene2Replay(source, original,
      workflow, prepared, { id: options.id })
    if (options.apply) {
      await db.query(`INSERT INTO execution_records
        (id,workflow_id,workflow_name,mode,title,runtime_inputs,result,
          succeeded_count,failed_count,total_count)
        VALUES ($1,$2,$3,'step',$4,$5::jsonb,$6::jsonb,$7,0,$8)`, [
        state.id, source.workflow_id, source.workflow_name,
        `原第二镜脚本复核 · 新14秒首镜 ${source.id}`,
        JSON.stringify(source.runtime_inputs ?? {}),
        JSON.stringify(encodeExecutionState(state)),
        state.nodeRuns.filter(run => run.status === 'success').length,
        state.nodeRuns.length,
      ])
      const saved = await row(state.id)
      if (!saved || sceneCutRebindSha256(decodeExecutionState(saved.result))
        !== sceneCutRebindSha256(state))
        fail('inserted second-shot checkpoint differs from reviewed state')
      const sourceAfter = await row(source.id)
      const originalAfter = await row(ORIGINAL_ID)
      const graphAfter = (await db.query(`SELECT md5(nodes::text) AS nodes_md5,
        md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1`,
      [source.workflow_id])).rows[0]
      if (sourceAfter?.result_md5 !== source.result_md5
        || originalAfter?.result_md5 !== ORIGINAL_MD5
        || graphAfter?.nodes_md5 !== workflow.nodes_md5
        || graphAfter?.edges_md5 !== workflow.edges_md5)
        fail('source, original, or graph changed during fork')
      await db.query('COMMIT')
    } else await db.query('ROLLBACK')
    console.log(JSON.stringify({ mode: options.apply ? 'applied' : 'read-only',
      status: options.apply ? 'new-scene2-review-pending' : 'ready-to-fork-scene2-review',
      sourceId: source.id, sourceResultMd5: source.result_md5,
      originalId: ORIGINAL_ID, workflowNodesMd5: workflow.nodes_md5,
      workflowEdgesMd5: workflow.edges_md5, scene2PreflightPlanSha256: prepared.planSha256,
      actualFirstTailSha256: prepared.plan.source.actualFirstTailSha256,
      firstVideoSha256: prepared.plan.source.firstAcceptedVideoSha256,
      ...proof, databaseWrites: options.apply ? 1 : 0 }, null, 2))
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { await db.end() }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
