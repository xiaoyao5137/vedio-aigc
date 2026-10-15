#!/usr/bin/env node
// Re-review a previously signed, paid still under the amended shot. No media call.
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import pg from 'pg'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { manualRetryRuns } from '../src/run-invalidation.ts'
import { applyNodeOutputToContext, refreshPendingExecutionNodes } from '../src/workflow-core.ts'
import { prepareWorkflowRunContext } from '../src/workflow-run-context.ts'
import { sceneCutShotSha256, verifySceneCutFrameApproval } from '../server/scene-cut-frame-approval.ts'

const parentId = process.argv[2], sourceId = process.argv[3], apply = process.argv.includes('--apply')
if (!/^record-[\w-]+$/.test(parentId ?? '') || !/^record-[\w-]+$/.test(sourceId ?? '') || parentId === sourceId)
  throw Error('Provide failed parent and signed source record IDs')
const assert = (value, reason) => { if (!value) throw Error(`SCENE_CUT_APPROVED_IMAGE_REUSE_INVALID: ${reason}`) }
const sha = value => createHash('sha256').update(value).digest('hex')
const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
try {
  await db.query(apply ? 'BEGIN' : 'BEGIN READ ONLY')
  const parentRow = (await db.query(`select *,md5(result::text) as result_md5 from execution_records where id=$1${apply ? ' for share' : ''}`, [parentId])).rows[0]
  const sourceRow = (await db.query(`select *,md5(result::text) as result_md5 from execution_records where id=$1${apply ? ' for share' : ''}`, [sourceId])).rows[0]
  const workflow = (await db.query("select * from workflow_configs where id='wf-sanguo-history-drama'")).rows[0]
  assert(parentRow?.workflow_id === 'wf-sanguo-history-drama' && sourceRow?.workflow_id === parentRow.workflow_id
    && workflow?.schema_version === 183, 'source/graph missing')
  const parent = decodeExecutionState(parentRow.result), source = decodeExecutionState(sourceRow.result)
  const before = parent.nodeRuns, original = source.nodeRuns, index = 45
  const signed = verifySceneCutFrameApproval(original[50]?.output)
  const originalImage = original[45]?.output, imageUrl = originalImage?.url
  const imageSha = sha(readFileSync(`public${imageUrl}`))
  const currentShot = before[11]?.output
  const ledger = (await db.query(`select id,status,workflow_id,node_id,request_data,response_data from model_execution_records
    where workflow_id=$1 and node_id='sanguo-scene-cut-first-frame' and status='succeeded'
      and request_data->>'requestKey' like $2 order by created_at desc limit 1`, [parentRow.workflow_id, `${sourceId}:%`])).rows[0]
  assert(parent.id === parentId && source.id === sourceId
    && before[index]?.node.id === 'sanguo-scene-cut-first-frame'
    && before[50]?.node.id === 'sanguo-scene-cut-approval'
    && before[50].status === 'failed'
    && String(before[50].error ?? '').startsWith('SCENE_CUT_FRAME_REJECTED:')
    && before.slice(0, index).every(run => ['success', 'skipped'].includes(run.status))
    && signed.passed === true && signed.frame.sourceUrl === imageUrl
    && signed.sourceSha256s[0] === imageSha
    && original[11]?.output?.id === currentShot?.id && currentShot?.id === 'scene-01'
    && isDeepStrictEqual(original.slice(0, 9), before.slice(0, 9))
    && ledger?.response_data?.data?.[0]?.url === imageUrl,
  'old signed image is not compatible with current first-scene source')
  const ctx = prepareWorkflowRunContext(before, index)?.inputContext
  assert(ctx?.shot_script?.id === currentShot.id
    && isDeepStrictEqual(ctx.scene_cut_sources, before[41].output)
    && isDeepStrictEqual(ctx.scene_cut_opening_state, before[43].output),
  'amended shot context differs')
  const marker = { version: 'scene-cut-approved-image-reuse-v1', sourceExecutionId: sourceId,
    sourceResultMd5: sourceRow.result_md5, parentExecutionId: parentId,
    parentResultMd5: parentRow.result_md5, originalImageExecutionId: ledger.id,
    originalImageUrl: imageUrl, originalImageSha256: imageSha,
    originalShotSha256: signed.shotSha256, amendedShotSha256: sceneCutShotSha256(currentShot),
    firstPendingIndex: 46, firstPendingNodeId: before[46].node.id }
  const imageOutput = { ...originalImage, sourceBoundImageReuse: marker }
  const selected = { ...before[index], status: 'success', output: imageOutput,
    inputContext: ctx, inputs: { ...before[index].inputs, sourceBoundImageReuse: marker },
    context: applyNodeOutputToContext(ctx, before[index].node.resultVar, imageOutput),
    error: undefined, startedAt: undefined, durationMs: 0,
    revision: Number(before[index].revision ?? 0) + 1 }
  const replaced = before.map((run, at) => at === index ? selected : run)
  const runs = refreshPendingExecutionNodes({ ...workflow, schemaVersion: workflow.schema_version }, manualRetryRuns(replaced, index + 1))
  assert(runs.slice(0, index).every((run, at) => isDeepStrictEqual(run, before[at]))
    && runs[index].status === 'success' && runs.slice(index + 1).every(run => run.status === 'idle')
    && prepareWorkflowRunContext(runs, 46)?.inputContext?.first_frame?.url === imageUrl,
  'fresh review does not read original image under amended shot')
  const id = `record-${randomBytes(5).toString('hex')}`
  const state = { ...parent, id, parentExecutionId: parentId,
    requestScopeId: parent.requestScopeId ?? parent.id, generationScopeId: id,
    sceneCutApprovedImageReuse: marker, sceneCutAutoRetry: undefined,
    sceneCutImageCountRecovery: undefined, historical: false, mode: 'step',
    nodeRuns: runs, context: selected.context, selectedNodeId: runs[46].node.id,
    logs: [...parent.logs, `复用 ${sourceId} 已签首帧原始PNG；保留旧图账本，从本分镜第46节点重新独立采证审核。`] }
  if (apply) {
    await db.query(`insert into execution_records (id,workflow_id,workflow_name,mode,title,runtime_inputs,result,succeeded_count,failed_count,total_count)
      values ($1,$2,$3,'step',$4,$5::jsonb,$6::jsonb,$7,0,$8)`, [id,parentRow.workflow_id,parentRow.workflow_name,
      `已签首帧复审 · ${parentId}`,JSON.stringify(parentRow.runtime_inputs ?? {}),JSON.stringify(encodeExecutionState(state)),index+1,runs.length])
    const saved = decodeExecutionState((await db.query('select result from execution_records where id=$1', [id])).rows[0]?.result)
    assert(saved.id === id && saved.nodeRuns[46].status === 'idle' && saved.sceneCutApprovedImageReuse.originalImageSha256 === imageSha,
      'fork did not round trip')
  }
  assert((await db.query('select md5(result::text) as md5 from execution_records where id=$1', [parentId])).rows[0]?.md5 === parentRow.result_md5
    && (await db.query('select md5(result::text) as md5 from execution_records where id=$1', [sourceId])).rows[0]?.md5 === sourceRow.result_md5,
  'source changed')
  await db.query('COMMIT')
  console.log(JSON.stringify({ applied: apply, parentId, sourceId, parentMd5: parentRow.result_md5,
    sourceMd5: sourceRow.result_md5, newRecordId: apply ? id : null,
    firstPendingIndex: 46, originalImageUrl: imageUrl, imageSha256: imageSha, providerCalls: 0 }, null, 2))
} catch (error) { await db.query('ROLLBACK').catch(() => undefined); throw error
} finally { await db.end() }
