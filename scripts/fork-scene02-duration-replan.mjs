#!/usr/bin/env node
// Preserve the accepted first scene while replanning the rejected second scene.
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
  kind: 'shot-script-duration-replan',
  issue: '第2镜已有10.04秒实片的可复核审核：押解组尚在跨门和收步时张飞就迈步，违反“全部收步站稳后才迈一步”的依赖；ASR中完整台词到约9.8秒才结束，片尾只剩0.24秒，不足0.5秒反应和0.5秒可读收尾。该片已明确退回，不能沿用10秒排程。',
  instruction: '只重写第2镜拍摄脚本，完整保留上一已验收镜头、三国史事、原场三人及两名军士、同一厅堂空间、同一句张飞台词“大军都到了，你为什么不投降，还敢抵抗？”和严颜尚未开口的结尾。选择12秒整数时长（Kling允许3至15秒），而非原10秒；将所有 duration、selectedDuration、timeline、各 beat.schedule、视觉提示和文案统一改到12秒。0至2秒押解组跨门，2至2.6秒三人完全收步站稳，2.6秒之后张飞才从静止原位完整迈一步、落脚；张飞迈步绝不可与跨门/收步并行。台词在动作完成后开始，给生成语音实际偏晚约1.4秒留余量，台词结束后必须有至少0.5秒严颜静默反应和至少0.5秒可读结尾；可将张飞发问安排在3.2至10.2秒，反应10.2至10.8秒，结尾保持到12秒。禁止删字、缩写、加旁白、额外人物、跳切或把完成动作仅写进解释。零秒静图让严颜及两名军士全身和双脚清楚可见，位于门口外侧；张飞在厅内中立站定，双脚可见，不要求屈膝、起步或预先接近。所有依赖、首帧、末帧、音画计划和正向审核字段同步更新。',
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
  if (apply) {
    assert.equal(sourceRow.result_md5, expectedSourceMd5)
    assert.equal(workflow.nodes_md5, expectedNodesMd5)
  }
  const source = decodeExecutionState(sourceRow.result)
  const index = source.nodeRuns.findIndex(run => run.node.id === 'sanguo-shot-script' && run.loopIndex === 1)
  assert.equal(index, 67)
  assert.equal(source.nodeRuns[index]?.status, 'success')
  assert.equal(source.nodeRuns[65]?.node.id, 'sanguo-video-concat')
  assert.equal(source.nodeRuns[65]?.status, 'success')
  assert.equal(source.nodeRuns[66]?.node.id, 'sanguo-last-frame')
  assert.equal(source.nodeRuns[66]?.status, 'success')
  assert.ok(source.nodeRuns.slice(0, index).every(run => ['success', 'skipped'].includes(run.status)))
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
  const marker = { version: 'scene02-duration-replan-v1', sourceExecutionId: source.id,
    sourceResultMd5: sourceRow.result_md5, workflowNodesMd5: workflow.nodes_md5,
    workflowEdgesMd5: workflow.edges_md5, firstPendingIndex: index,
    firstPendingNodeId: runs[index].node.id, originalShotId: source.nodeRuns[index].output?.id }
  const state = { ...source, id, parentExecutionId: source.id,
    requestScopeId: source.requestScopeId ?? source.id, generationScopeId: id,
    scene02DurationReplan: marker, historical: false, mode: 'step',
    nodeRuns: runs, context: runs[index - 1].context, selectedNodeId: runs[index].node.id,
    logs: [...source.logs, `从 ${source.id} 重排第2镜的实测时长与动作依赖；第1镜和旧付费候选保留。`] }
  if (apply) {
    await db.query(`insert into execution_records
      (id,workflow_id,workflow_name,mode,title,runtime_inputs,result,succeeded_count,failed_count,total_count)
      values ($1,$2,$3,'step',$4,$5::jsonb,$6::jsonb,$7,0,$8)`, [
      id, sourceRow.workflow_id, sourceRow.workflow_name, `第2镜时长重排 · ${source.id}`,
      JSON.stringify(sourceRow.runtime_inputs ?? {}), JSON.stringify(encodeExecutionState(state)),
      runs.filter(run => run.status === 'success').length, runs.length])
    const saved = decodeExecutionState((await db.query('select result from execution_records where id=$1', [id])).rows[0].result)
    assert.deepEqual(saved.scene02DurationReplan, marker)
    assert.equal(saved.nodeRuns[index].status, 'idle')
  }
  const current = (await db.query('select md5(result::text) as md5 from execution_records where id=$1', [sourceId])).rows[0]
  assert.equal(current.md5, sourceRow.result_md5)
  await db.query(apply ? 'COMMIT' : 'ROLLBACK')
  console.log(JSON.stringify({ applied: apply, sourceId, sourceMd5: sourceRow.result_md5,
    workflowNodesMd5: workflow.nodes_md5, workflowEdgesMd5: workflow.edges_md5,
    newRecordId: apply ? id : null, firstPendingIndex: index, preservedPrefix: index,
    invalidatedSuffix: runs.length - index, providerCalls: 0 }))
} catch (error) {
  await db.query('ROLLBACK').catch(() => undefined)
  throw error
} finally { await db.end() }
