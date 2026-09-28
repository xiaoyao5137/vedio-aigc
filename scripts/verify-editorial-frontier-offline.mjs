#!/usr/bin/env node
// Synthetic execution projection from the already saved HTTP code-gate result.
// No UI, database connection, workflow step, or provider request.
import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import { driveRecord, pendingManualDecision } from './workflow-drive-state.mjs'

const directory = path.resolve('logs/dramatic-expression/live-20260928/editorial-hold-http-probe')
const load = async name => (JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'))).envelope.body
const accepted693 = await load('response-693-grounded-map-empty-tent.json')
const accepted637 = await load('response-637-actual-old-review.json')
const writer = { id: '693-writer', node: { id: 'sanguo-scene-outline', kind: 'text' }, status: 'success', output: { text: 'saved writer candidate' } }
const review = { id: '693-reviewer', node: { id: 'sanguo-scene-outline-review', kind: 'text' }, status: 'success', output: { text: 'saved review' } }
const gate = (id, output) => ({ id: `${id}-gate`, node: { id: 'sanguo-scene-outline-accept', kind: 'code' }, status: 'success', output })
const next = { id: 'next-video', node: { id: 'sanguo-video', kind: 'video' }, status: 'idle' }
const project = runs => driveRecord({ id: 'synthetic-693-review-checkpoint', workflow_id: 'wf-sanguo-history-drama',
  created_at: '2026-09-28T00:00:00Z', result: { nodeRuns: runs } })

const pending = project([writer, review, gate('693', accepted693), next])
const frontier = pendingManualDecision(pending)
assert.equal(frontier?.id, 'sanguo-scene-outline-accept')
assert.equal(frontier?.index, 2)
assert.equal(pending.runs[3].status, 'idle')
const continued = project([writer, review, gate('693', accepted693),
  { id: 'branch-after-user-continue', node: { id: 'sanguo-scene-outline-accept-accept-branch', kind: 'branch' }, status: 'success', output: true }, next])
assert.equal(pendingManualDecision(continued), undefined, 'a later success represents explicit continuation')
const old637 = project([writer, review, gate('637', accepted637), next])
assert.equal(pendingManualDecision(old637), undefined, 'old no-code warning is not promoted to a manual hold')

const proof = { format: 'editorial-frontier-offline-v1', generatedAt: new Date().toISOString(),
  sourceResponses: ['response-693-grounded-map-empty-tent.json', 'response-637-actual-old-review.json'],
  pending693: { gateIndex: frontier.index, gateId: frontier.id, marker: frontier.outputSummary.manualDecisionRequired,
    nextStatus: pending.runs[3].status },
  continued693NotBlocked: true, old637NotBlocked: true, uiCalls: 0, databaseCalls: 0, providerCalls: 0 }
await fs.writeFile(path.join(directory, 'driver-frontier-offline.json'), JSON.stringify(proof, null, 2))
console.log(JSON.stringify(proof, null, 2))
