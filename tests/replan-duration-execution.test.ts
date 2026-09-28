import test from 'node:test'
import assert from 'node:assert/strict'
import { encodeExecutionState, decodeExecutionState } from '../src/execution-storage.ts'
import { prepareWorkflowRunContext } from '../src/workflow-run-context.ts'
import { prepareDurationReplan, replanDurationExecution, parseArguments } from '../scripts/replan-duration-execution.mjs'

const md5 = '0123456789abcdef0123456789abcdef'
const options = { sourceId: 'source', id: 'new-duration', createdAt: '2026-09-08T00:00:00.000Z' }
const children = ['sanguo-end-frame', 'sanguo-shot-script', 'sanguo-video', 'sanguo-media-accept', 'sanguo-duration-replan', 'sanguo-last-frame']
function fixture() {
  const scenes = [{ id: 'scene-1', requiredBeats: ['原始末尾跟唱'] }, { id: 'scene-2', requiredBeats: ['下场原剧情'] }]
  const context = { input: { episode_number: 1 }, approved_scene_outline: { passed: true, scenes }, scene_outline: { scenes }, branch: { visits: 4 }, retry: { attempt: 4 } }
  const node = (id: string) => ({ id, kind: id === 'sanguo-scene-loop' ? 'loop' : id === 'sanguo-duration-replan' ? 'branch' : id === 'sanguo-video' || id === 'sanguo-end-frame' ? 'video' : 'text', resultVar: id,
    title: id, prompt: 'current schema 115', ...(children.includes(id) ? { parentId: 'sanguo-scene-loop' } : {}),
    ...(id === 'sanguo-shot-script' ? { params: [{ name: 'pacingVersion', englishName: 'pacingVersion', value: 'duration-v2' }] } : {}),
    ...(id === 'sanguo-scene-loop' ? { childIds: children, loop: { itemVar: 'scene' } } : {}) })
  const prefixIds = Array.from({ length: 8 }, (_, i) => i === 5 ? 'sanguo-scene-outline-accept' : `prefix-${i}`)
  const workflow = { id: 'workflow', schema_version: 115, nodes: [...prefixIds, 'sanguo-scene-loop', ...children, 'episode-final'].map(node) }
  const loop = { ...node('sanguo-scene-loop'), childIds: children.filter(id => id !== 'sanguo-duration-replan') }
  const prefix = [...prefixIds, loop.id].map((id, i) => ({ id: `source-prefix-${i}`, node: id === loop.id ? loop : { ...node(id), prompt: 'approved prefix definition' }, status: 'success', context, inputs: { approved: true }, inputContext: context,
    output: { approved: true, index: i }, durationMs: 10 }))
  const oldContext = { ...context, shot: { text: 'old shot' }, video: { url: '/old-paid.mp4' }, media_accept: { passed: true } }
  const loops = scenes.flatMap((loopItem, loopIndex) => children.filter(id => id !== 'sanguo-duration-replan').map((id, index) => ({
    id: `source-loop-${loopIndex}-${index}`, node: { ...node(id), prompt: 'old generation' },
    status: loopIndex === 0 && index === 0 ? 'skipped' : loopIndex === 0 ? 'success' : 'idle',
    inputs: {}, inputContext: loopIndex === 0 && index === 0 ? context : oldContext, context: loopIndex === 0 && index === 0 ? context : oldContext,
    output: loopIndex === 0 && index === 0 ? undefined : { oldPaid: true }, durationMs: 20,
    revision: 8, attempt: 4, attempts: [{ output: { old: true } }], retryFeedback: { old: true },
    branchState: { visits: 3 }, branchCarry: { old: true }, routeInputContext: oldContext, loopPrevious: oldContext,
    loopNode: loop, loopItem, loopIndex, loopGroupId: 'original-group', loopIsLast: index === 4,
  })))
  const state = { id: 'source', workflowId: 'workflow', workflowName: '历史短剧', runtimeInputs: { input: { episode_number: 1 } }, requestScopeId: 'old-paid-scope',
    nodeRuns: [...prefix, ...loops], context: oldContext, branchHistory: [{ runs: loops }], logs: ['old failures'], customOldSnapshot: loops }
  return { state, workflow, source: { id: 'source', workflow_id: 'workflow', workflow_name: '历史短剧', result_md5: md5, runtime_inputs: state.runtimeInputs, result: encodeExecutionState(state) } }
}

test('new replan preserves approved prefix and stories while all downstream work, retries and histories are discarded', () => {
  const { source, workflow, state } = fixture(), before = structuredClone(source)
  const prepared = prepareDurationReplan(source, workflow, options), next = prepared.state
  assert.deepEqual(source, before)
  assert.equal(next.selectedNodeId, 'sanguo-shot-script')
  assert.equal(next.requestScopeId, options.id)
  assert.equal(next.historical, false)
  assert.deepEqual(next.runtimeInputs, state.runtimeInputs)
  assert.deepEqual(next.branchHistory, [])
  assert.equal(Object.hasOwn(next, 'customOldSnapshot'), false)
  assert.deepEqual(next.context.scene_outline, state.nodeRuns[8].context.scene_outline)
  for (let i = 0; i < 10; i++) {
    for (const key of ['id', 'status', 'context', 'inputs', 'inputContext', 'output']) assert.deepEqual(next.nodeRuns[i][key], state.nodeRuns[i][key])
  }
  assert.ok(next.nodeRuns[8].node.childIds.includes('sanguo-duration-replan'))
  assert.ok(next.nodeRuns[9].loopNode.childIds.includes('sanguo-duration-replan'))
  for (const run of next.nodeRuns.slice(10)) {
    assert.equal(run.status, 'idle'); assert.equal(run.durationMs, 0)
    assert.deepEqual(run.context, {}); assert.deepEqual(run.inputs, {}); assert.deepEqual(run.inputContext, {})
    for (const key of ['output', 'revision', 'attempt', 'attempts', 'retryFeedback', 'branchState', 'branchCarry', 'loopPrevious', 'routeInputContext']) assert.equal(Object.hasOwn(run, key), false)
    assert.equal(run.node.prompt, 'current schema 115')
    assert.deepEqual(run.loopItem, state.nodeRuns[8].context.scene_outline.scenes[run.loopIndex])
    if (run.node.id === 'sanguo-media-accept') assert.equal(next.nodeRuns[next.nodeRuns.indexOf(run) + 1].node.id, 'sanguo-duration-replan')
  }
  assert.equal(next.nodeRuns.filter(run => run.node.id === 'sanguo-duration-replan').length, 2)
  assert.deepEqual(decodeExecutionState(JSON.parse(JSON.stringify(prepared.encoded))), JSON.parse(JSON.stringify(next)))
  assert.equal(prepared.proof.prefixEvidencePreserved, true)
  assert.equal(prepared.proof.loopStoriesPreserved, true)
  // Real UI context preparation sees the original scene and approval, no paid result.
  const input = prepareWorkflowRunContext(next.nodeRuns, 10)!.inputContext
  assert.deepEqual(input.scene, state.nodeRuns[8].context.scene_outline.scenes[0])
  assert.equal(input.shot, undefined); assert.equal(input.video, undefined); assert.equal(input.media_accept, undefined)
})

test('newer compatible duration schemas are accepted and recorded exactly', () => {
  const f = fixture(); f.workflow.schema_version = 123
  const prepared = prepareDurationReplan(f.source, f.workflow, { ...options, id: 'newer-duration' })
  assert.equal(prepared.proof.workflowSchema, 123)
  assert.equal(prepared.state.durationReplan.workflowSchema, 123)
})

test('preparation refuses active, unapproved, wrong-prefix, obsolete workflow or altered-story sources', () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.state.nodeRuns[11].status = 'running' },
    (f: ReturnType<typeof fixture>) => { f.state.nodeRuns[5].status = 'failed' },
    (f: ReturnType<typeof fixture>) => { f.state.nodeRuns.shift() },
    (f: ReturnType<typeof fixture>) => { f.workflow.schema_version = 114 },
    (f: ReturnType<typeof fixture>) => { f.workflow.nodes = f.workflow.nodes.filter(n => n.id !== 'sanguo-duration-replan') },
    (f: ReturnType<typeof fixture>) => { f.state.nodeRuns[11] = { ...f.state.nodeRuns[11], loopItem: { id: 'altered', requiredBeats: ['modified'] } } as typeof f.state.nodeRuns[number] },
  ]) {
    const f = fixture(); mutate(f); f.source.result = encodeExecutionState(f.state)
    assert.throws(() => prepareDurationReplan(f.source, f.workflow, options), /DURATION_REPLAN_INVALID/)
  }
  assert.throws(() => prepareDurationReplan(fixture().source, fixture().workflow, { ...options, id: 'old-paid-scope' }), /NEW/)
})

function database(changed = false) {
  const f = fixture(), statements: string[] = []
  let inserted: Record<string, unknown> | undefined
  return { statements, async query(sql: string, params: unknown[] = []) {
    statements.push(sql)
    if (sql.startsWith('SELECT *') && sql.includes('workflow_configs')) return { rows: [f.workflow] }
    if (sql.startsWith('SELECT *')) return { rows: [f.source] }
    if (sql.startsWith('INSERT')) { assert.equal(params[4], '时长策略升级重排 · source'); inserted = JSON.parse(String(params[6])); return { rows: [] } }
    if (sql.startsWith('SELECT result')) return { rows: [{ result: inserted }] }
    if (sql.startsWith('SELECT md5')) return { rows: [{ result_md5: changed ? 'changed' : md5 }] }
    return { rows: [] }
  } }
}

test('default transaction only reads; explicit apply inserts exactly one new record and verifies unchanged source MD5', async () => {
  assert.equal(parseArguments(['--source', 'source']).apply, false)
  const readOnly = database(), preview = await replanDurationExecution(readOnly, options)
  assert.equal(preview.applied, false); assert.equal(readOnly.statements[0], 'BEGIN READ ONLY')
  assert.equal(readOnly.statements.some(sql => /INSERT|UPDATE|DELETE/.test(sql)), false)
  const db = database(), result = await replanDurationExecution(db, { ...options, apply: true })
  assert.equal(result.applied, true); assert.equal(result.sourceResultMd5After, md5)
  assert.equal(db.statements.filter(sql => sql.startsWith('INSERT')).length, 1)
  assert.equal(db.statements.some(sql => /UPDATE|DELETE/.test(sql)), false)
  assert.equal(db.statements.at(-1), 'COMMIT')
  const changed = database(true)
  await assert.rejects(replanDurationExecution(changed, { ...options, apply: true }), /source changed/)
  assert.equal(changed.statements.at(-1), 'ROLLBACK')
})
