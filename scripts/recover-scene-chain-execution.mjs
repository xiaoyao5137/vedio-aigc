// Preserve the accepted prefix through scene 2 and rebuild scene 3 onward from
// the current workflow. The source remains immutable and all discarded outputs
// remain available in it for audit.
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'

const sourceId = process.argv[2] ?? 'record-concatfix-d6102a'
const id = process.argv[3] ?? `record-storychain-${randomUUID().slice(0, 8)}`
const normalizeAllocatedScene = value => {
  const scene = structuredClone(value)
  if (!scene?.sourceSceneId || !Array.isArray(scene.requiredBeats)) return scene
  const criteria = Array.isArray(scene.completionCriteria) ? scene.completionCriteria.map(String) : []
  scene.requiredBeats = scene.requiredBeats.map(beat => {
    if (criteria.includes('原节拍表演：' + beat.description)) return beat
    const visual = Array.isArray(beat.observable?.visual) ? beat.observable.visual : []
    const audio = Array.isArray(beat.observable?.audio) ? beat.observable.audio : []
    return { ...beat, description: [...visual, ...audio].join('；') }
  })
  scene.purpose = scene.requiredBeats.map(beat => beat.description).filter(Boolean).join('；')
  return scene
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
const client = await pool.connect()
try {
  await client.query('begin')
  const source = (await client.query('select * from execution_records where id=$1 for share', [sourceId])).rows[0]
  const workflow = (await client.query('select * from workflow_configs where id=$1 for share', [source.workflow_id])).rows[0]
  if (!source || !workflow) throw Error('source/workflow missing')
  const original = decodeExecutionState(source.result)
  const boundary = original.nodeRuns.findIndex(run => run.loopIndex === 2 && run.node.id === 'sanguo-shot-script')
  if (boundary < 0) throw Error('scene 3 boundary missing')
  const prefix = structuredClone(original.nodeRuns.slice(0, boundary))
  if (prefix.some(run => !['success', 'skipped'].includes(run.status))) throw Error('prefix is incomplete')
  const loop = workflow.nodes.find(node => node.id === 'sanguo-scene-loop')
  const byId = new Map(workflow.nodes.map(node => [node.id, node]))
  const sourceChildIds = original.nodeRuns.filter(run => run.loopIndex === 2).map(run => run.node.id)
  const orderedIds = sourceChildIds.filter(id => id !== 'sanguo-video-concat')
  const acceptedIndex = orderedIds.indexOf('sanguo-media-accept-accept-branch')
  orderedIds.splice(acceptedIndex + 1, 0, 'sanguo-video-concat')
  const children = orderedIds.map(id => byId.get(id))
  if (children.some(node => !node) || new Set(orderedIds).size !== orderedIds.length) throw Error('current loop children disagree with source')
  const sourceRounds = new Map()
  for (const run of original.nodeRuns.slice(boundary)) if (run.loopIndex !== undefined && !sourceRounds.has(run.loopIndex)) sourceRounds.set(run.loopIndex, run)
  let sequence = 0
  const pending = []
  for (const [loopIndex, template] of sourceRounds) for (const node of children) pending.push({
    id: `${id}:run-${sequence++}`, node: structuredClone(node), label: `第 ${loopIndex + 1} 轮 / ${node.title} -> ${node.resultVar ?? ''}`,
    status: 'idle', durationMs: 0, context: {}, inputs: {}, inputContext: {},
    loopNode: structuredClone(loop), loopGroupId: template.loopGroupId, loopIndex,
    loopItem: normalizeAllocatedScene(template.loopItem), ...(loopIndex === 2 && template.loopPrevious ? { loopPrevious: structuredClone(template.loopPrevious) } : {}),
    loopIsLast: loopIndex === Math.max(...sourceRounds.keys()) && node.id === children.at(-1)?.id,
  })
  const afterLoop = original.nodeRuns.slice(boundary).filter(run => run.loopIndex === undefined).map(run => byId.get(run.node.id)).filter(Boolean)
  for (const node of afterLoop) pending.push({ id: `${id}:run-${sequence++}`, node: structuredClone(node), label: node.title,
    status: 'idle', durationMs: 0, context: {}, inputs: {}, inputContext: {} })
  const context = structuredClone(prefix.at(-1)?.context ?? original.context ?? {})
  const state = { ...original, id, mode: 'step', historical: false, requestScopeId: id, selectedNodeId: 'sanguo-shot-script',
    nodeRuns: [...prefix, ...pending], context, branchHistory: (original.branchHistory ?? []).slice(0, 14),
    logs: [...(original.logs ?? []), `从 ${sourceId} 保留前两镜及其阶段视频；按 schema ${workflow.schema_version} 从第三镜重排，旧第三/四镜及后续记录只保留在源执行。`],
    storyChainRecovery: { sourceRecordId: sourceId, boundary, preservedRounds: 2, workflowSchema: workflow.schema_version, createdAt: new Date().toISOString() } }
  const encoded = encodeExecutionState(state)
  await client.query(`insert into execution_records(id,workflow_id,workflow_name,mode,title,runtime_inputs,result,succeeded_count,failed_count,total_count)
    values($1,$2,$3,'step',$4,$5,$6,$7,0,$8)`, [id, source.workflow_id, source.workflow_name,
    `剧情串联修复 · ${sourceId}`, source.runtime_inputs, encoded, prefix.filter(run => run.status === 'success').length, state.nodeRuns.length])
  await client.query('commit')
  console.log(JSON.stringify({ id, sourceId, boundary, preservedRuns: prefix.length, pendingRuns: pending.length,
    firstPending: pending[0]?.node.id, childOrder: children.map(node => node.id), workflowSchema: workflow.schema_version }))
} catch (error) {
  await client.query('rollback')
  throw error
} finally {
  client.release(); await pool.end()
}
