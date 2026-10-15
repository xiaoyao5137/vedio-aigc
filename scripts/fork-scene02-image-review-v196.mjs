#!/usr/bin/env node
// Re-review an already paid second-scene image under the corrected review contract.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { manualRetryRuns } from '../src/run-invalidation.ts'

const sourceId = process.argv.find(arg => arg.startsWith('--source='))?.split('=')[1]
const expectedSourceMd5 = process.argv.find(arg => arg.startsWith('--expected-source-md5='))?.split('=')[1]
const expectedNodesMd5 = process.argv.find(arg => arg.startsWith('--expected-nodes-md5='))?.split('=')[1]
const apply = process.argv.includes('--apply')
if (!/^record-[\w-]+$/.test(sourceId ?? '')) throw Error('Exact source record required')
if (apply && (!/^[a-f0-9]{32}$/i.test(expectedSourceMd5 ?? '')
  || !/^[a-f0-9]{32}$/i.test(expectedNodesMd5 ?? ''))) throw Error('Apply requires MD5 locks')
const db = new pg.Client({ connectionString: process.env.DATABASE_URL
  ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
try {
  await db.query(apply ? 'BEGIN ISOLATION LEVEL REPEATABLE READ' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  const sourceRow = (await db.query(`select *,md5(result::text) as result_md5 from execution_records
    where id=$1${apply ? ' for share' : ''}`, [sourceId])).rows[0]
  const workflow = (await db.query(`select schema_version,nodes,md5(nodes::text) as nodes_md5,
    md5(edges::text) as edges_md5 from workflow_configs where id='wf-sanguo-history-drama'`)).rows[0]
  assert.equal(sourceRow?.workflow_id, 'wf-sanguo-history-drama')
  assert.equal(workflow?.schema_version, 196)
  if (apply) {
    assert.equal(sourceRow.result_md5, expectedSourceMd5)
    assert.equal(workflow.nodes_md5, expectedNodesMd5)
  }
  const source = decodeExecutionState(sourceRow.result)
  const index = 107, imageIndex = 105, reviewIndex = 108
  assert.equal(source.nodeRuns[imageIndex]?.node.id, 'sanguo-scene-cut-first-frame')
  assert.equal(source.nodeRuns[imageIndex]?.status, 'success')
  assert.equal(source.nodeRuns[index]?.node.id, 'sanguo-scene-cut-evidence')
  assert.equal(source.nodeRuns[index]?.status, 'idle')
  assert.equal(source.nodeRuns[reviewIndex]?.node.id, 'sanguo-scene-cut-review')
  assert.equal(source.nodeRuns[reviewIndex]?.status, 'idle')
  assert.ok(source.nodeRuns.slice(0, index).every(run => ['success', 'skipped'].includes(run.status)))
  const imageUrl = source.nodeRuns[imageIndex].output?.url
  assert.match(imageUrl ?? '', /^\/generated\/[\w.-]+\.(?:png|jpe?g|webp)$/i)
  const managedNodes = new Map(workflow.nodes.map(node => [node.id, node]))
  const id = `record-${randomBytes(5).toString('hex')}`
  const runs = manualRetryRuns(source.nodeRuns, index).map((run, at) => at === reviewIndex
    ? { ...run, node: managedNodes.get(run.node.id) } : run)
  assert.ok(runs.slice(index).every(run => run.status === 'idle'))
  const marker = { version: 'scene02-image-review-v196', sourceExecutionId: source.id,
    sourceResultMd5: sourceRow.result_md5, workflowNodesMd5: workflow.nodes_md5,
    workflowEdgesMd5: workflow.edges_md5, firstPendingIndex: index,
    firstPendingNodeId: runs[index].node.id, imageIndex, imageUrl }
  const state = { ...source, id, parentExecutionId: source.id,
    requestScopeId: source.requestScopeId ?? source.id, generationScopeId: id,
    scene02ImageReviewContract: marker, historical: false, mode: 'step',
    nodeRuns: runs, context: runs[index - 1].context, selectedNodeId: runs[index].node.id,
    logs: [...source.logs, `从 ${source.id} 按修正契约复审已付费第2镜首帧；原图与第1镜保留。`] }
  if (apply) {
    await db.query(`insert into execution_records
      (id,workflow_id,workflow_name,mode,title,runtime_inputs,result,succeeded_count,failed_count,total_count)
      values ($1,$2,$3,'step',$4,$5::jsonb,$6::jsonb,$7,0,$8)`, [
      id, sourceRow.workflow_id, sourceRow.workflow_name, `第2镜首帧复审 · ${source.id}`,
      JSON.stringify(sourceRow.runtime_inputs ?? {}), JSON.stringify(encodeExecutionState(state)),
      runs.filter(run => run.status === 'success').length, runs.length])
    const saved = decodeExecutionState((await db.query('select result from execution_records where id=$1', [id])).rows[0].result)
    assert.deepEqual(saved.scene02ImageReviewContract, marker)
    assert.equal(saved.nodeRuns[imageIndex].output?.url, imageUrl)
  }
  const current = (await db.query('select md5(result::text) as md5 from execution_records where id=$1', [sourceId])).rows[0]
  assert.equal(current.md5, sourceRow.result_md5)
  await db.query(apply ? 'COMMIT' : 'ROLLBACK')
  console.log(JSON.stringify({ applied: apply, sourceId, sourceMd5: sourceRow.result_md5,
    workflowNodesMd5: workflow.nodes_md5, workflowEdgesMd5: workflow.edges_md5,
    newRecordId: apply ? id : null, preservedPrefix: index, imageUrl, providerCalls: 0 }))
} catch (error) {
  await db.query('ROLLBACK').catch(() => undefined)
  throw error
} finally { await db.end() }
