#!/usr/bin/env node
// Source-bound creative amendment after repeated first-frame rejection.
// The new outline must pass its ordinary review and every downstream gate.
import { randomBytes } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import pg from 'pg'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { manualRetryRuns } from '../src/run-invalidation.ts'
import { applyNodeOutputToContext, refreshPendingExecutionNodes } from '../src/workflow-core.ts'
import { prepareWorkflowRunContext } from '../src/workflow-run-context.ts'

const sourceId = process.argv[2], apply = process.argv.includes('--apply')
if (!/^record-[\w-]+$/.test(sourceId ?? '')) throw Error('Provide a source record ID')
const assert = (test, message) => { if (!test) throw Error(`SCENE_CUT_STORY_RECOVERY_INVALID: ${message}`) }
const db = new pg.Client({ connectionString: process.env.DATABASE_URL
  ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
try {
  await db.query(apply ? 'BEGIN' : 'BEGIN READ ONLY')
  const sourceRow = (await db.query(`SELECT *,md5(result::text) AS result_md5
    FROM execution_records WHERE id=$1${apply ? ' FOR SHARE' : ''}`, [sourceId])).rows[0]
  assert(sourceRow?.workflow_id === 'wf-sanguo-history-drama', 'source missing')
  const source = decodeExecutionState(sourceRow.result), before = source.nodeRuns
  assert(source.id === sourceId && before[3]?.node.id === 'sanguo-scene-outline'
    && before[4]?.node.id === 'sanguo-scene-outline-review'
    && before[5]?.node.id === 'sanguo-scene-outline-accept'
    && before[9]?.node.id === 'sanguo-shot-script'
    && before[50]?.node.id === 'sanguo-scene-cut-approval'
    && before[50].status === 'failed' && source.sceneCutAutoRetry?.count === 2
    && before.slice(0, 3).every(run => run.status === 'success')
    && before[5].output?.passed === true, 'not the expected settled first-shot failure')
  const issueCodes = new Set(before[49].output?.issues?.map(issue => issue.code))
  assert(issueCodes.has('TIGHTENING_START_NOT_VISIBLE')
    && issueCodes.has('STRAIGHTENING_START_NOT_VISIBLE'), 'failure evidence changed')
  const old = before[3].output, oldScene = old.scenes?.[0], oldBeat = oldScene?.requiredBeats?.[0]
  const knot = '军士在严颜身前收紧腕间绳结'
  const straighten = '严颜站直身体，抬眼望向堂屋门口'
  const walk = '严颜在军士夹随下迈向堂屋门槛'
  assert(oldScene?.id === 'scene-01' && oldBeat?.id === 'beat-01'
    && isDeepStrictEqual(oldBeat.mustShow, [knot, straighten, walk])
    && isDeepStrictEqual(oldBeat.observable.visual, [knot, straighten, walk])
    && oldScene.contextPayload?.narration === before[11].output?.pacing?.beats
      ?.filter(beat => beat.kind === 'speech').map(beat => beat.textOrVocalization).join(''),
  'original scene obligations or narration changed')
  const candidate = structuredClone(old)
  for (const key of ['raw', 'text', 'model', 'repairProvenance']) delete candidate[key]
  const scene = candidate.scenes[0], beat = scene.requiredBeats[0]
  // These two micro-actions are staged before the shot. Neither is a historical
  // event, and this amendment preserves the captured/refused prisoner and the
  // following scene's bound-wrist continuity.
  const established = '严颜双腕已缚于身前，肩背挺直，停在距堂屋门槛数步的院中'
  const travel = '严颜与两名军士从院中起步，向堂屋门槛连续走近并在门槛外收步'
  beat.mustShow = [established, travel]
  beat.observable.visual = [established, travel]
  beat.description = '开镜时严颜已被缚，肩背挺直，和两名军士停在院中；随后三人从院中起步，严颜在夹随下走至堂屋门槛外。旁白完整交代汉末刘备攻打刘璋、张飞生擒严颜，并提出其拒降后的生死问题。'
  scene.purpose = '承接江州战败和严颜被俘这一必要前提 → 从院中已缚且站定的起点走向问讯堂屋 → 观众听清时局、双方关系及拒降者的生死危险 → 下一段进入张飞的当面责问。'
  scene.completionCriteria = [
    scene.completionCriteria[0], '首帧看清严颜双腕已缚、肩背挺直，军士在两侧，院中至门槛仍有行走距离',
    '严颜与军士从院中连续走向堂屋门槛，在门槛外收步，为下一段入堂提供明确方向',
    scene.completionCriteria[3],
  ]
  scene.adaptationBoundary = scene.adaptationBoundary.replace('绳缚、匿名押解军士及严颜站直迈步',
    '开镜已完成的绳缚、匿名押解军士及严颜从院中迈步')
  assert(scene.adaptationBoundary !== oldScene.adaptationBoundary, 'adaptation boundary changed')
  assert(candidate.scenes.length === old.scenes.length
    && isDeepStrictEqual(candidate.scenes.slice(1), old.scenes.slice(1))
    && candidate.scenes[0].contextPayload.narration === oldScene.contextPayload.narration,
  'unrelated scenes or narration changed')
  const workflow = (await db.query('SELECT * FROM workflow_configs WHERE id=$1',
    [sourceRow.workflow_id])).rows[0]
  const prepared = prepareWorkflowRunContext(before, 3)
  assert(prepared?.run.node.id === 'sanguo-scene-outline', 'outline context unavailable')
  const candidateContext = applyNodeOutputToContext(prepared.inputContext,
    before[3].node.resultVar, candidate)
  const selected = { ...before[3], status: 'success', output: candidate,
    context: candidateContext, inputContext: prepared.inputContext,
    inputs: { ...before[3].inputs, sourceBoundOpeningAmendment: {
      sourceExecutionId: sourceId, sourceResultMd5: sourceRow.result_md5 } },
    revision: Number(before[3].revision ?? 0) + 1, startedAt: undefined, durationMs: 0 }
  const replaced = before.map((run, index) => index === 3 ? selected : run)
  const runs = refreshPendingExecutionNodes({ ...workflow, schemaVersion: workflow.schema_version },
    manualRetryRuns(replaced, 4))
  assert(runs.slice(0, 3).every((run, index) => isDeepStrictEqual(run, before[index]))
    && runs[4].status === 'idle' && runs.slice(4).every(run => run.status === 'idle')
    && isDeepStrictEqual(prepareWorkflowRunContext(runs, 4)?.inputContext?.outline_candidate, candidate),
  'new reviewer is not bound to amended outline')
  const id = `record-${randomBytes(5).toString('hex')}`
  const marker = { version: 'scene-cut-opening-story-recovery-v1', sourceExecutionId: sourceId,
    sourceResultMd5: sourceRow.result_md5, firstPendingIndex: 4,
    firstPendingNodeId: 'sanguo-scene-outline-review',
    oldRequiredVisual: [knot, straighten, walk], newRequiredVisual: [established, travel] }
  const state = { ...source, id, parentExecutionId: source.id,
    requestScopeId: source.requestScopeId ?? source.id, generationScopeId: id,
    sceneCutOpeningStoryRecovery: marker, sceneCutAutoRetry: undefined,
    historical: false, mode: 'step', nodeRuns: runs, context: candidateContext,
    selectedNodeId: runs[4].node.id, logs: [...source.logs,
      `从 ${sourceId} 修订首镜大纲开场：绑缚与站姿改为既有状态；从大纲审核重新执行，原记录与全部旧候选保留。`] }
  if (apply) {
    await db.query(`INSERT INTO execution_records
      (id,workflow_id,workflow_name,mode,title,runtime_inputs,result,succeeded_count,failed_count,total_count)
      VALUES ($1,$2,$3,'step',$4,$5::jsonb,$6::jsonb,$7,0,$8)`, [
      id, sourceRow.workflow_id, sourceRow.workflow_name, `首镜开场动作修订 · ${sourceId}`,
      JSON.stringify(sourceRow.runtime_inputs ?? {}), JSON.stringify(encodeExecutionState(state)),
      runs.filter(run => run.status === 'success').length, runs.length])
    const saved = decodeExecutionState((await db.query('SELECT result FROM execution_records WHERE id=$1',
      [id])).rows[0]?.result)
    assert(saved.id === id && saved.nodeRuns[4].status === 'idle'
      && isDeepStrictEqual(saved.nodeRuns[3].output.scenes[0], candidate.scenes[0]), 'fork did not round trip')
  }
  assert((await db.query('SELECT md5(result::text) AS md5 FROM execution_records WHERE id=$1',
    [sourceId])).rows[0]?.md5 === sourceRow.result_md5, 'source changed')
  await db.query('COMMIT')
  console.log(JSON.stringify({ applied: apply, sourceId, sourceMd5: sourceRow.result_md5,
    newRecordId: apply ? id : null, firstPendingIndex: 4, preservedPrefix: 3,
    oldRequiredVisual: marker.oldRequiredVisual, newRequiredVisual: marker.newRequiredVisual,
    providerCalls: 0 }, null, 2))
} catch (error) {
  await db.query('ROLLBACK').catch(() => undefined)
  throw error
} finally { await db.end() }
