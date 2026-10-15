#!/usr/bin/env node
// Retake the first shot script from the approved outline, preserving the source record.
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
const feedback = {
  kind: 'shot-script-action-replan',
  issue: '原首镜“收紧腕间绳结”要求静图同时表现已缚与宽大未收紧绳圈；连续多张实图都把绳圈画成贴腕，导致零秒硬审核明确失败。原片还把屈膝藏在长袍下。',
  instruction: '只重写第1镜的具体表演调度，保留史事、人物、场景、旁白、被俘仍不屈与押向厅堂的剧情顺序。保留上一版“牵引段由松转直、腕部已有束缚保持”作为首个视觉动作，绝不恢复收紧腕间绳结或重新绑缚。把上一版合写的“严颜肩背前倾再回正、抬头”拆成两个有先后排程的独立 requiredThisClip 视觉节拍：先“严颜受牵后肩背前倾、头略低”（终态为前倾），后“严颜肩背从前倾回正、抬头”（终态为回正抬头）。第一节拍的 completion.resetsBeatIds 必须明确列出第二节拍的 id，第二节拍 dependsOn 第一节拍且 schedule.startSecond 晚于第一节拍；这是批准动作内真实可见的姿态复位，避免零秒直立被误当作后一节拍提前完成。若重排时间，仍符合10秒节奏与旁白完整性。两个节拍都不使用“站直”“站稳”“踏稳”“屈膝”或同义腿膝动作；视觉提示词写清零秒中立站姿、牵引后前倾、再回正。所有动作的 textOrVocalization、completion.evidenceAnchor、completion.finalState、dependsOn、schedule 和 visualPrompt 必须同步，不得只改解释。保持批准三人、轴线、站位、全身景别和无旗幡无字场景。',
}
const db = new pg.Client({ connectionString: process.env.DATABASE_URL
  ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
try {
  await db.query(apply ? 'BEGIN ISOLATION LEVEL REPEATABLE READ' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  const sourceRow = (await db.query(`select *,md5(result::text) as result_md5 from execution_records
    where id=$1${apply ? ' for share' : ''}`, [sourceId])).rows[0]
  const workflow = (await db.query(`select id,schema_version,nodes,edges,md5(nodes::text) as nodes_md5,
    md5(edges::text) as edges_md5 from workflow_configs where id='wf-sanguo-history-drama'`)).rows[0]
  assert.equal(sourceRow?.workflow_id, 'wf-sanguo-history-drama')
  assert.equal(workflow?.schema_version, 195)
  if (apply) { assert.equal(sourceRow.result_md5, expectedSourceMd5); assert.equal(workflow.nodes_md5, expectedNodesMd5) }
  const source = decodeExecutionState(sourceRow.result)
  const index = source.nodeRuns.findIndex(run => run.node.id === 'sanguo-shot-script' && run.loopIndex === 0)
  assert.equal(index, 9)
  assert.equal(source.nodeRuns[index]?.status, 'success')
  assert.ok(source.nodeRuns.slice(0, index).every(run => ['success', 'skipped'].includes(run.status)))
  assert.equal(source.nodeRuns[47]?.node.id, 'sanguo-scene-cut-first-frame')
  const managedNodes = new Map(workflow.nodes.map(node => [node.id, node]))
  const id = `record-${randomBytes(5).toString('hex')}`
  const runs = manualRetryRuns(source.nodeRuns, index).map((run, at) => {
    if (at < index) return run
    if (at === index) return { ...run, retryFeedback: feedback }
    if (['sanguo-scene-cut-first-frame', 'sanguo-scene-cut-review-route'].includes(run.node.id))
      return { ...run, node: managedNodes.get(run.node.id) }
    return run
  })
  assert.equal(runs[index].status, 'idle')
  assert.ok(runs.slice(index).every(run => run.status === 'idle'))
  const marker = { version: 'scene01-action-replan-v1', sourceExecutionId: source.id,
    sourceResultMd5: sourceRow.result_md5, workflowNodesMd5: workflow.nodes_md5,
    workflowEdgesMd5: workflow.edges_md5, firstPendingIndex: index,
    firstPendingNodeId: runs[index].node.id, originalShotId: source.nodeRuns[index].output?.id }
  const state = { ...source, id, parentExecutionId: source.id,
    requestScopeId: source.requestScopeId ?? source.id, generationScopeId: id,
    scene01ActionReplan: marker, historical: false, mode: 'step',
    nodeRuns: runs, context: runs[index - 1].context, selectedNodeId: runs[index].node.id,
    logs: [...source.logs, `从 ${source.id} 重写第1镜可拍动作；批准大纲、输入与旧付费候选保留。`] }
  if (apply) {
    await db.query(`insert into execution_records
      (id,workflow_id,workflow_name,mode,title,runtime_inputs,result,succeeded_count,failed_count,total_count)
      values ($1,$2,$3,'step',$4,$5::jsonb,$6::jsonb,$7,0,$8)`, [
      id, sourceRow.workflow_id, sourceRow.workflow_name, `第1镜动作重排 · ${source.id}`,
      JSON.stringify(sourceRow.runtime_inputs ?? {}), JSON.stringify(encodeExecutionState(state)),
      runs.filter(run => run.status === 'success').length, runs.length])
    const saved = decodeExecutionState((await db.query('select result from execution_records where id=$1', [id])).rows[0].result)
    assert.deepEqual(saved.scene01ActionReplan, marker)
    assert.equal(saved.nodeRuns[index].status, 'idle')
  }
  const current = (await db.query('select md5(result::text) as md5 from execution_records where id=$1', [sourceId])).rows[0]
  assert.equal(current.md5, sourceRow.result_md5)
  await db.query(apply ? 'COMMIT' : 'ROLLBACK')
  console.log(JSON.stringify({ applied: apply, sourceId, sourceMd5: sourceRow.result_md5,
    workflowNodesMd5: workflow.nodes_md5, newRecordId: apply ? id : null,
    firstPendingIndex: index, preservedPrefix: index, invalidatedSuffix: runs.length - index,
    providerCalls: 0 }))
} catch (error) {
  await db.query('ROLLBACK').catch(() => undefined)
  throw error
} finally { await db.end() }
