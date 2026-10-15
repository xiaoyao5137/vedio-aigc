import { createHash } from 'node:crypto'
import { decodeExecutionState } from '../src/execution-storage.ts'

type Value = Record<string, unknown>
type Queryable = { query: (sql: string, values: unknown[]) => Promise<{ rows: unknown[] }> }
const object = (value: unknown): Value => value && typeof value === 'object' && !Array.isArray(value) ? value as Value : {}
const fail = (message: string): never => { throw Error(`SCENE_CUT_SOURCE_LEDGER_INVALID: ${message}`) }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value ?? null)
}
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')

/** Read the persisted successful accept runs, rather than treating an HTTP
 * caller's outline text as the authority for a scene-cut exception. */
export function assertSceneCutAcceptedSourceRecord(record: unknown, input: {
  executionRecordId: unknown; approvedOutline: unknown; shot: unknown; previous?: unknown }) {
  const row = object(record), state = decodeExecutionState<Value>(object(row.result))
  const runs = Array.isArray(state.nodeRuns) ? state.nodeRuns.map(object) : []
  const scenes = Array.isArray(object(input.approvedOutline).scenes)
    ? (object(input.approvedOutline).scenes as unknown[]).map(object) : []
  const shot = object(input.shot), sceneIndex = scenes.findIndex(scene => scene.id === shot.id)
  if (typeof input.executionRecordId !== 'string' || !/^record-[\w-]+$/.test(input.executionRecordId)
    || row.id !== input.executionRecordId || row.workflow_id !== 'wf-sanguo-history-drama'
    || sceneIndex < 0) fail('执行记录、工作流或批准场景身份不匹配')
  const accepted = (nodeId: string, index?: number) => {
    const matches = runs.filter(run => run.status === 'success' && object(run.node).id === nodeId
      && (index === undefined || run.loopIndex === index))
    if (matches.length !== 1 || typeof matches[0].id !== 'string')
      fail(`缺少唯一成功的 ${nodeId} 接受节点`)
    return matches[0]
  }
  const outlineRun = accepted('sanguo-scene-outline-accept')
  const shotRun = accepted('sanguo-shot-script-accept', sceneIndex)
  const acceptedOutline = object(object(outlineRun.output).contextPatch).approved_scene_outline
    ?? outlineRun.output
  if (object(outlineRun.output).passed !== true || object(shotRun.output).passed !== true
    || canonical(acceptedOutline) !== canonical(input.approvedOutline)
    || canonical(shotRun.output) !== canonical(input.shot))
    fail('提交的大纲或分镜与持久化接受节点输出不同')
  const binding: Value = {
    version: 'scene-cut-source-ledger-v1', recordId: row.id,
    outlineRunId: outlineRun.id, outlineSha256: hash(acceptedOutline),
    shotRunId: shotRun.id, shotSha256: hash(shotRun.output),
  }
  if (sceneIndex > 0) {
    const previous = object(input.previous)
    const priorShotRun = accepted('sanguo-shot-script-accept', sceneIndex - 1)
    const priorVideoRun = accepted('sanguo-media-accept', sceneIndex - 1)
    const priorTailRun = accepted('sanguo-last-frame', sceneIndex - 1)
    if (canonical(priorShotRun.output) !== canonical(previous.shot_script)
      || canonical(priorVideoRun.output) !== canonical(previous.video_shot)
      || canonical(priorTailRun.output) !== canonical(previous.last_frame))
      fail('前镜已验收脚本、成片或真实末帧与同一执行记录不同')
    Object.assign(binding, {
      priorShotRunId: priorShotRun.id, priorShotSha256: hash(priorShotRun.output),
      priorVideoRunId: priorVideoRun.id, priorVideoResultSha256: hash(priorVideoRun.output),
      priorTailRunId: priorTailRun.id, priorTailResultSha256: hash(priorTailRun.output),
    })
  }
  return binding
}

export async function assertSceneCutAcceptedSourceLedger(pool: Queryable, shot: unknown,
  sources: unknown) {
  const archive = object(sources), context = object(archive.sourceContext)
  const accepted = object(context.acceptedRecordBinding)
  if (accepted.version !== 'scene-cut-source-ledger-v1'
    || typeof accepted.recordId !== 'string' || !/^record-[\w-]+$/.test(accepted.recordId))
    fail('冻结来源缺少已接受执行记录身份')
  const rows = await pool.query(`select id,workflow_id,result from execution_records
    where id=$1 and workflow_id='wf-sanguo-history-drama'`, [accepted.recordId])
  if (rows.rows.length !== 1) fail('冻结来源的执行记录不存在')
  const expected = assertSceneCutAcceptedSourceRecord(rows.rows[0], {
    executionRecordId: accepted.recordId, approvedOutline: context.approvedOutline,
    previous: context.previous, shot })
  if (canonical(expected) !== canonical(accepted)) fail('接受节点身份或输出已改变')
  return expected
}
