import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { encodeExecutionGraph, decodeExecutionGraph, encodeExecutionState, decodeExecutionState } from '../src/execution-storage.ts'
import { driveRecord, targetOutcome } from '../scripts/workflow-drive-state.mjs'

const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

test('deduplicates structurally cloned branch history without losing any snapshot', () => {
  let snapshot: unknown = { observations: [{ time: 6.32, evidence: '手部动作尚未完成', certainty: 'uncertain' }], original: 'x'.repeat(4000) }
  for (let i = 0; i < 10; i++) snapshot = { retry: i, prior: wire(snapshot), context: wire(snapshot) }
  const state = { id: 'record', context: snapshot, branchHistory: [snapshot], nodeRuns: [{ node: { id: 'video', kind: 'video' }, status: 'success', output: { url: '/generated/original.mp4', raw: { taskId: 'paid-original' } }, context: wire(snapshot), routeInputContext: wire(snapshot), attempts: [{ output: { error: 'old rejection' }, context: snapshot }] }] }
  const before = JSON.stringify(state)
  const stored = encodeExecutionState(state)
  assert.ok(JSON.stringify(stored).length < before.length / 100)
  assert.deepEqual(decodeExecutionState(wire(stored)), wire(state))
  assert.equal(JSON.stringify(state), before)
  assert.deepEqual(stored.nodeRuns[0].output, state.nodeRuns[0].output)
  assert.equal(encodeExecutionState(stored), stored)
})

test('legacy records and user reference-looking values remain intact', () => {
  const state = { context: { slot: 0, ref: 4, _executionStorage: { format: 'user-data' } }, nodeRuns: [{ inputs: { slot: 0 }, output: { ref: 2, slot: 1 } }] }
  assert.equal(decodeExecutionState(state), state)
  assert.deepEqual(decodeExecutionState(wire(encodeExecutionState(state))), state)
})

test('JSON values round trip including unsafe object keys, unicode, arrays, and omitted fields', () => {
  const state = JSON.parse('{"__proto__":{"polluted":true},"constructor":2}')
  state.value = [undefined, NaN, Infinity, -Infinity, '汉代😀𐐷', new Date('2026-09-08T00:00:00Z')]
  state.omitted = undefined
  const restored = decodeExecutionGraph(encodeExecutionGraph(state))
  assert.deepEqual(restored, wire(state))
  assert.equal(({} as Record<string, unknown>).polluted, undefined)
})

test('unsupported values and malformed references fail explicitly rather than silently dropping evidence', () => {
  const cycle: Record<string, unknown> = {}; cycle.self = cycle
  assert.throws(() => encodeExecutionGraph(cycle), /EXECUTION_SERIALIZATION_INVALID/)
  assert.throws(() => encodeExecutionGraph({ value: 1n }), /EXECUTION_SERIALIZATION_INVALID/)
  assert.throws(() => decodeExecutionGraph({ format: 'execution-graph-v1', root: { ref: 0 }, nodes: [] }), /EXECUTION_STORAGE_INVALID/)
  assert.throws(() => decodeExecutionGraph({ format: 'execution-graph-v1', root: null, nodes: [{ kind: 'array', values: [{ ref: 0 }] }] }), /EXECUTION_STORAGE_INVALID/)
  const stored = encodeExecutionState({ context: {}, nodeRuns: [] })
  assert.throws(() => decodeExecutionState({ ...stored, context: { slot: 999 } }), /EXECUTION_STORAGE_INVALID/)
  assert.throws(() => decodeExecutionState({ _executionStorage: { format: 'future' } }), /EXECUTION_STORAGE_INVALID/)
})

test('plain output and run index retain all driver outcome distinctions before hydration', () => {
  for (const output of [{ url: '/video.mp4' }, { routeError: 'reject', url: '/video.mp4' }, { passed: false }, null, { text: ' ' }]) {
    const state = { requestScopeId: 'scope', context: { large: 'context' }, nodeRuns: [{ node: { id: 'video', kind: 'video' }, status: 'success', revision: 13, loopIndex: 0, output, inputContext: { previousReport: 'old' } }] }
    const raw = driveRecord({ id: 'record', workflow_id: 'workflow', result: state })
    const compact = driveRecord({ id: 'record', workflow_id: 'workflow', result: wire(encodeExecutionState(state)) })
    assert.deepEqual(compact, raw)
    assert.deepEqual(targetOutcome(compact, 'video'), targetOutcome(raw, 'video'))
  }
})

test('successful split-plan evidence and future segment references compact separately and reload with all hashes intact', () => {
  const draft = { segments: [{ id: 'scene-seg-1', pacing: { beats: [{ id: 'a', sourceBeatId: 'beat-04', textOrVocalization: '多谢大贤良师' }] } },
    { id: 'scene-seg-2', pacing: { beats: [{ id: 'b', sourceBeatId: 'beat-05', textOrVocalization: '多人跪下请求' }] } }] }
  const raw = { content: [{ type: 'text', text: JSON.stringify(draft) + '完整供应商原稿汉字😀'.repeat(1000) }] }
  const plan = { version: 'storyboard-split-plan-v1', raw, draft, rawSha256: hash(raw), draftSha256: hash(draft),
    source: { requestKey: 'source:generation-2', modelExecutionId: 'paid-ledger', status: 'succeeded', httpStatus: 200 },
    binding: { sourceRunId: 'source-run', originalScene: { id: 'scene', requiredBeats: ['beat-04', 'beat-05'] } },
    planHash: hash({ raw, draft }) }
  const reference = { sourceRunId: 'source-run', planHash: plan.planHash, segmentIndex: 1 }
  const sourceRun = { id: 'source-run', node: { id: 'shot-script' }, status: 'success', output: draft.segments[0], storyboardSplitPlan: plan }
  const futureRun = { id: 'future-run', node: { id: 'shot-script' }, status: 'idle', storyboardSplitCandidate: reference }
  const state = { nodeRuns: [sourceRun, futureRun], branchHistory: Array.from({ length: 10 }, () => wire({ nodeRuns: [sourceRun, futureRun] })) }
  const before = JSON.stringify(state)
  const stored = encodeExecutionState(state)
  const storedRuns = stored.nodeRuns as Array<Record<string, unknown>>
  assert.deepEqual(Object.keys(storedRuns[0].storyboardSplitPlan as object), ['slot'])
  assert.deepEqual(Object.keys(storedRuns[1].storyboardSplitCandidate as object), ['slot'])
  assert.deepEqual(storedRuns[0].output, draft.segments[0], 'accepted business output remains a public first segment')
  assert.equal(storedRuns[1].output, undefined, 'an unvalidated future segment does not become business output')
  assert.ok(JSON.stringify(stored).length < before.length / 5)
  const restored = decodeExecutionState<typeof state>(wire(stored))
  assert.deepEqual(restored, state)
  assert.equal(hash(restored.nodeRuns[0].storyboardSplitPlan), hash(plan))
  assert.equal(hash(restored.nodeRuns[1].storyboardSplitCandidate), hash(reference))
  assert.equal(JSON.stringify(state), before)
})

test('legacy raw records, legacy inline plan metadata and unknown run fields remain unchanged', () => {
  const old = { context: { old: true }, nodeRuns: [{ status: 'idle', futureMetadata: { version: 'unknown', slot: 42 } }] }
  assert.equal(decodeExecutionState(old), old)
  assert.deepEqual(decodeExecutionState(wire(encodeExecutionState(old))), old)
  const stored = wire(encodeExecutionState(old))
  const inlinePlan = { version: 'future-plan', slot: 'authored-property', unknown: { ref: 4 }, body: ['完整原稿'] }
  const inlineReference = { sourceRunId: 'source', planHash: 'opaque-preserved', segmentIndex: 2, unknown: true }
  const first = stored.nodeRuns[0] as Record<string, unknown>
  first.storyboardSplitPlan = inlinePlan
  first.storyboardSplitCandidate = inlineReference
  const restored = decodeExecutionState<{ nodeRuns: Array<Record<string, unknown>> }>(stored)
  assert.deepEqual(restored.nodeRuns[0].storyboardSplitPlan, inlinePlan)
  assert.deepEqual(restored.nodeRuns[0].storyboardSplitCandidate, inlineReference)
  assert.deepEqual(restored.nodeRuns[0].futureMetadata, old.nodeRuns[0].futureMetadata)
  assert.deepEqual(decodeExecutionState(wire(encodeExecutionState(restored))), restored)
})

test('corrupt compressed plan references fail explicitly and optional absent metadata is not invented', () => {
  for (const field of ['storyboardSplitPlan', 'storyboardSplitCandidate']) {
    const stored = encodeExecutionState({ context: {}, nodeRuns: [{ [field]: { complete: 'evidence' } }] })
    ;(stored.nodeRuns as Array<Record<string, unknown>>)[0][field] = { slot: 99999 }
    assert.throws(() => decodeExecutionState(wire(stored)), /EXECUTION_STORAGE_INVALID/)
  }
  const absent = { nodeRuns: [{ status: 'idle' }] }
  assert.deepEqual(decodeExecutionState(wire(encodeExecutionState(absent))), absent)
})
