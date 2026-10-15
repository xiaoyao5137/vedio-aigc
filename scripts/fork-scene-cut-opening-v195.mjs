#!/usr/bin/env node
// Create a new unpaid checkpoint at the opening plan; preserve the source and paid media.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { manualRetryRuns } from '../src/run-invalidation.ts'
import { deriveSceneCutOpeningPlan } from '../server/scene-cut-opening-plan.ts'

const sourceId = process.argv.find(arg => arg.startsWith('--source='))?.split('=')[1]
const sourceMd5 = process.argv.find(arg => arg.startsWith('--expected-source-md5='))?.split('=')[1]
const nodesMd5 = process.argv.find(arg => arg.startsWith('--expected-nodes-md5='))?.split('=')[1]
const apply = process.argv.includes('--apply')
if (!/^record-[\w-]+$/.test(sourceId ?? '')) throw Error('Exact source record required')
if (apply && (!/^[a-f0-9]{32}$/i.test(sourceMd5 ?? '') || !/^[a-f0-9]{32}$/i.test(nodesMd5 ?? '')))
  throw Error('Apply requires source and workflow MD5 locks')
const db = new pg.Client({ connectionString: process.env.DATABASE_URL
  ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
try {
  await db.query(apply ? 'BEGIN ISOLATION LEVEL REPEATABLE READ' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  const sourceRow = (await db.query(`select *,md5(result::text) as result_md5
    from execution_records where id=$1${apply ? ' for share' : ''}`, [sourceId])).rows[0]
  const workflow = (await db.query(`select id,schema_version,nodes,edges,md5(nodes::text) as nodes_md5,
    md5(edges::text) as edges_md5 from workflow_configs where id='wf-sanguo-history-drama'`)).rows[0]
  assert.equal(sourceRow?.workflow_id, 'wf-sanguo-history-drama')
  assert.equal(workflow?.schema_version, 195)
  if (apply) { assert.equal(sourceRow.result_md5, sourceMd5); assert.equal(workflow.nodes_md5, nodesMd5) }
  const source = decodeExecutionState(sourceRow.result)
  const index = source.nodeRuns.findIndex(run => run.node.id === 'sanguo-scene-cut-opening-plan' && run.loopIndex === 0)
  assert.equal(index, 45)
  assert.equal(source.nodeRuns[47]?.status, 'failed')
  assert.ok(source.nodeRuns.slice(0, index).every(run => ['success', 'skipped'].includes(run.status)))
  const shot = source.nodeRuns.find(run => run.node.id === 'sanguo-shot-script-accept' && run.loopIndex === 0)?.output
  const oldPlan = source.nodeRuns[index].output
  const nextPlan = deriveSceneCutOpeningPlan(shot, 4)
  assert.deepEqual(oldPlan, deriveSceneCutOpeningPlan(shot, 3))
  assert.equal(oldPlan.shotSha256, nextPlan.shotSha256)
  assert.match(oldPlan.openingVisualContext.staticScene, /双腕在身前已有绳索束缚/)
  assert.doesNotMatch(nextPlan.openingVisualContext.staticScene, /已有绳索束缚/)
  const managedNodes = new Map(workflow.nodes.map(node => [node.id, node]))
  for (const run of source.nodeRuns) assert.ok(managedNodes.has(run.node.id))
  const id = `record-${randomBytes(5).toString('hex')}`
  const runs = manualRetryRuns(source.nodeRuns, index).map((run, at) => {
    if (at < index || !['sanguo-scene-cut-first-frame', 'sanguo-scene-cut-review-route'].includes(run.node.id)) return run
    return { ...run, node: managedNodes.get(run.node.id) }
  })
  assert.equal(runs[index].status, 'idle')
  assert.equal(runs[47].node.prompt, managedNodes.get('sanguo-scene-cut-first-frame').prompt)
  assert.equal(runs[51].node.code, managedNodes.get('sanguo-scene-cut-review-route').code)
  const marker = { version: 'scene-cut-opening-v195-fork-v1', sourceExecutionId: source.id,
    sourceResultMd5: sourceRow.result_md5, workflowNodesMd5: workflow.nodes_md5,
    workflowEdgesMd5: workflow.edges_md5, firstPendingIndex: index,
    firstPendingNodeId: runs[index].node.id, shotSha256: nextPlan.shotSha256 }
  const state = { ...source, id, parentExecutionId: source.id,
    requestScopeId: source.requestScopeId ?? source.id, generationScopeId: id,
    sceneCutOpeningV195Recovery: marker, historical: false, mode: 'step',
    nodeRuns: runs, context: runs[index - 1].context, selectedNodeId: runs[index].node.id,
    logs: [...source.logs, `从 ${source.id} 重新投影第1镜零秒起点；原分镜、人物资产和付费候选保留。`] }
  if (apply) {
    await db.query(`insert into execution_records
      (id,workflow_id,workflow_name,mode,title,runtime_inputs,result,succeeded_count,failed_count,total_count)
      values ($1,$2,$3,'step',$4,$5::jsonb,$6::jsonb,$7,0,$8)`, [
      id, sourceRow.workflow_id, sourceRow.workflow_name, `换场零秒静态投影修复 · ${source.id}`,
      JSON.stringify(sourceRow.runtime_inputs ?? {}), JSON.stringify(encodeExecutionState(state)),
      runs.filter(run => run.status === 'success').length, runs.length])
    const saved = decodeExecutionState((await db.query('select result from execution_records where id=$1', [id])).rows[0].result)
    assert.equal(saved.nodeRuns[index].status, 'idle')
    assert.deepEqual(saved.sceneCutOpeningV195Recovery, marker)
  }
  const current = (await db.query('select md5(result::text) as md5 from execution_records where id=$1', [sourceId])).rows[0]
  assert.equal(current.md5, sourceRow.result_md5)
  await db.query(apply ? 'COMMIT' : 'ROLLBACK')
  console.log(JSON.stringify({ applied: apply, sourceId, sourceMd5: sourceRow.result_md5,
    workflowNodesMd5: workflow.nodes_md5, workflowEdgesMd5: workflow.edges_md5,
    newRecordId: apply ? id : null, firstPendingIndex: index,
    preservedPrefix: index, invalidatedSuffix: runs.length - index, providerCalls: 0 }))
} catch (error) {
  await db.query('ROLLBACK').catch(() => undefined)
  throw error
} finally { await db.end() }
