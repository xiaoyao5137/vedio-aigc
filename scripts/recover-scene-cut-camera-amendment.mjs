#!/usr/bin/env node
// Change only the opening shot's camera axis and resulting blocking. The
// amended candidate enters the ordinary storyboard review at node 10.
import { randomBytes } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import pg from 'pg'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { manualRetryRuns } from '../src/run-invalidation.ts'
import { applyNodeOutputToContext, refreshPendingExecutionNodes } from '../src/workflow-core.ts'
import { prepareWorkflowRunContext } from '../src/workflow-run-context.ts'
import { compileDurationSchedule, verifyDurationSchedule } from '../src/duration-schedule.ts'
import { sceneCutShotSha256 } from '../server/scene-cut-frame-approval.ts'

const sourceId = process.argv[2], apply = process.argv.includes('--apply')
if (!/^record-[\w-]+$/.test(sourceId ?? '')) throw Error('Provide a source record ID')
const assert = (value, reason) => { if (!value) throw Error(`SCENE_CUT_CAMERA_AMENDMENT_INVALID: ${reason}`) }
const db = new pg.Client({ connectionString: process.env.DATABASE_URL
  ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
try {
  await db.query(apply ? 'BEGIN' : 'BEGIN READ ONLY')
  const row = (await db.query(`SELECT *,md5(result::text) AS result_md5
    FROM execution_records WHERE id=$1${apply ? ' FOR SHARE' : ''}`, [sourceId])).rows[0]
  assert(row?.workflow_id === 'wf-sanguo-history-drama', 'source missing')
  const source = decodeExecutionState(row.result), before = source.nodeRuns
  assert(source.id === sourceId && before[9]?.node.id === 'sanguo-shot-script'
    && before[10]?.node.id === 'sanguo-shot-script-review'
    && before[11]?.node.id === 'sanguo-shot-script-accept'
    && before[11].output?.passed === true
    && before[50]?.node.id === 'sanguo-scene-cut-approval'
    && before[50].status === 'failed'
    && before[49].output?.issues?.some(issue => issue.code === 'opening_camera_mismatch')
    && before.slice(0, 9).every(run => ['success', 'skipped'].includes(run.status)),
  'source is not a camera-only rejected first shot')
  const original = before[9].output, accepted = before[11].output
  assert(original.id === 'scene-01' && original.camera === accepted.camera
    && original.visualPrompt === accepted.visualPrompt && original.duration === 9
    && original.pacing?.beats?.map(beat => beat.id).join(',')
      === 'action-01,speech-01,action-02,speech-02,speech-03'
    && original.camera.startsWith('机位在堂屋门侧、院中行进轴线一侧'),
  'approved shot changed')
  const candidate = structuredClone(original)
  for (const key of ['raw', 'text', 'model', 'repairProvenance', 'scriptValidation',
    'qualityWarnings', 'qualityDisposition', 'manualDecisionRequired']) delete candidate[key]
  candidate.camera = '机位在院落内、距三人约数步处，朝堂屋正立面平视拍摄，约35毫米全身全景；开镜人物面向镜头，堂屋门、门槛与三人之间的院地同框。门槛位于三人身后，画面完整保留双方靴子及腕间绳结。三人转身后镜头保持同一轴线轻微跟摇，记录他们走向身后堂屋门槛，不切镜、不越轴；末帧仍可辨门槛外的收步位置。'
  candidate.shotIntent.cameraReason = '从院落朝堂屋正立面拍全身全景，开镜同时看清严颜已缚的双腕、两侧军士和身后门槛；三人转身后沿可见院地走向门口，保留起步到收步的连续变化。'
  candidate.visualPrompt = candidate.visualPrompt.replace(
    '首帧为单一时刻全身全景：',
    '首帧为院落内朝堂屋正立面拍摄的单一时刻全身全景，堂屋门与台阶位于三人身后：')
  candidate.lastFramePrompt = candidate.lastFramePrompt.replace('同一院落与堂屋门侧机位。',
    '同一院落与从院中朝堂屋正立面拍摄的机位。')
  candidate.pacing.beats[0].textOrVocalization = '严颜双腕已缚于身前，肩背挺直，停在距堂屋门槛数步的院中。两名军士原本分立严颜两侧，三人面向院中镜头保持起步前的位置；堂屋门槛在身后，腕间绳结与双腕无遮挡，不重演捆绑。'
  candidate.pacing.beats[2].textOrVocalization = '严颜与两名军士从院中起步，向堂屋门槛连续走近并在门槛外收步。三人先转身面向身后堂屋，再从原站位连续迈步；严颜保持肩背挺直，双腕仍缚于身前，两名军士从原有两侧位置夹随，随严颜收步，不越过门槛。'
  candidate.pacing.beats[2].durationEstimate.source = '包含开镜后的转身、院中约三步行走和门槛外收步，动作与画外旁白可并行。'
  const oldSuffix = original.videoPrompt.slice(original.videoPrompt.indexOf('【声部与收束】'))
  assert(oldSuffix.startsWith('【声部与收束】')
    && candidate.visualPrompt !== original.visualPrompt
    && candidate.lastFramePrompt !== original.lastFramePrompt, 'camera prose not amended')
  delete candidate.scheduleHash
  delete candidate.pacing.scheduleHash
  const scene = before[9].inputContext.scene
  const compiled = compileDurationSchedule(candidate, { scene,
    timingPolicy: original.pacing.timingPolicy })
  candidate.duration = compiled.duration
  candidate.pacing = compiled.pacing
  candidate.scheduleHash = compiled.scheduleHash
  candidate.videoPrompt = compiled.videoPrompt + '\n' + oldSuffix
  candidate.timingEstimate = compiled.timingEstimate
  verifyDurationSchedule(candidate, { scene, timingPolicy: original.pacing.timingPolicy })
  assert(candidate.duration <= 15 && candidate.duration >= 9
    && candidate.audioText === original.audioText
    && isDeepStrictEqual(candidate.pacing.beats.filter(beat => beat.kind === 'speech'),
      original.pacing.beats.filter(beat => beat.kind === 'speech'))
    && isDeepStrictEqual(candidate.characterVisuals, original.characterVisuals)
    && isDeepStrictEqual(candidate.beatDramaturgy, original.beatDramaturgy)
    && isDeepStrictEqual(candidate.completionCriteria, original.completionCriteria),
  'amendment changed speech, cast, source obligations or exceeded duration')
  const workflow = (await db.query('SELECT * FROM workflow_configs WHERE id=$1',
    [row.workflow_id])).rows[0]
  const prepared = prepareWorkflowRunContext(before, 9)
  assert(prepared?.run.node.id === 'sanguo-shot-script'
    && isDeepStrictEqual(prepared.inputContext.scene, scene), 'source context changed')
  const candidateContext = applyNodeOutputToContext(prepared.inputContext,
    before[9].node.resultVar, candidate)
  const selected = { ...before[9], status: 'success', output: candidate,
    context: candidateContext, inputContext: prepared.inputContext,
    inputs: { ...before[9].inputs, sourceBoundCameraAmendment: {
      sourceExecutionId: sourceId, sourceResultMd5: row.result_md5,
      sourceShotSha256: sceneCutShotSha256(accepted) } },
    revision: Number(before[9].revision ?? 0) + 1, startedAt: undefined, durationMs: 0 }
  const replaced = before.map((run, index) => index === 9 ? selected : run)
  const runs = refreshPendingExecutionNodes({ ...workflow, schemaVersion: workflow.schema_version },
    manualRetryRuns(replaced, 10))
  assert(runs.slice(0, 9).every((run, index) => isDeepStrictEqual(run, before[index]))
    && runs[10].status === 'idle'
    && runs.slice(10).every(run => run.status === 'idle')
    && isDeepStrictEqual(prepareWorkflowRunContext(runs, 10)?.inputContext?.shot_candidate, candidate),
  'new reviewer is not bound to camera amendment')
  const id = `record-${randomBytes(5).toString('hex')}`
  const marker = { version: 'scene-cut-camera-amendment-v1', sourceExecutionId: sourceId,
    sourceResultMd5: row.result_md5, originalShotSha256: sceneCutShotSha256(accepted),
    candidateShotSha256: sceneCutShotSha256(candidate),
    firstPendingIndex: 10, firstPendingNodeId: before[10].node.id }
  const state = { ...source, id, parentExecutionId: source.id,
    requestScopeId: source.requestScopeId ?? source.id, generationScopeId: id,
    sceneCutCameraAmendment: marker, sceneCutAutoRetry: undefined,
    sceneCutImageCountRecovery: undefined, historical: false, mode: 'step',
    nodeRuns: runs, context: candidateContext, selectedNodeId: runs[10].node.id,
    logs: [...source.logs, `从 ${sourceId} 源绑定修订机位；只改首镜镜头轴线与转身走位，等待独立分镜审核及全新首帧。`] }
  if (apply) {
    await db.query(`INSERT INTO execution_records
      (id,workflow_id,workflow_name,mode,title,runtime_inputs,result,succeeded_count,failed_count,total_count)
      VALUES ($1,$2,$3,'step',$4,$5::jsonb,$6::jsonb,$7,0,$8)`, [
      id, row.workflow_id, row.workflow_name, `首镜机位修订 · ${sourceId}`,
      JSON.stringify(row.runtime_inputs ?? {}), JSON.stringify(encodeExecutionState(state)),
      runs.filter(run => run.status === 'success').length, runs.length])
    const saved = decodeExecutionState((await db.query('SELECT result FROM execution_records WHERE id=$1',
      [id])).rows[0]?.result)
    assert(saved.id === id && saved.nodeRuns[10].status === 'idle'
      && sceneCutShotSha256(saved.nodeRuns[9].output) === marker.candidateShotSha256,
    'fork did not round trip')
  }
  assert((await db.query('SELECT md5(result::text) AS md5 FROM execution_records WHERE id=$1',
    [sourceId])).rows[0]?.md5 === row.result_md5, 'source changed')
  await db.query('COMMIT')
  console.log(JSON.stringify({ applied: apply, sourceId, sourceMd5: row.result_md5,
    newRecordId: apply ? id : null, firstPendingIndex: 10,
    originalShotSha256: marker.originalShotSha256,
    candidateShotSha256: marker.candidateShotSha256,
    duration: candidate.duration, preservedPrefix: 9, providerCalls: 0 }, null, 2))
} catch (error) {
  await db.query('ROLLBACK').catch(() => undefined)
  throw error
} finally { await db.end() }
