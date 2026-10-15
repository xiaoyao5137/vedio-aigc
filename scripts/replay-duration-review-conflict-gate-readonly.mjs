#!/usr/bin/env node
// Re-evaluate the saved first-shot review with the schema180 candidate gate.
// PostgreSQL stays in a read-only transaction; the code node runs in process.
import assert from 'node:assert/strict'
import pg from 'pg'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { prepareWorkflowRunContext } from '../src/workflow-run-context.ts'
import { renderWorkflowTemplate } from '../src/workflow-template.ts'
import { executeCodeNode } from '../server/code-node.ts'
import { upgradeDurationReviewConflictWorkflow } from '../src/duration-review-conflict-workflow.ts'

const recordId = process.argv[2] ?? 'record-9p80o5'
const client = new pg.Client({ connectionString: process.env.DATABASE_URL
  ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await client.connect()
try {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  const workflow = (await client.query(
    "select id,schema_version,nodes,edges,md5(nodes::text) as nodes_md5,md5(edges::text) as edges_md5 from workflow_configs where id='wf-sanguo-history-drama'",
  )).rows[0]
  assert.equal(workflow?.schema_version, 179)
  const candidate = upgradeDurationReviewConflictWorkflow({ id: workflow.id, schemaVersion: workflow.schema_version,
    nodes: workflow.nodes, edges: workflow.edges })
  const record = (await client.query(
    'select id,workflow_id,result,md5(result::text) as result_md5 from execution_records where id=$1',
    [recordId],
  )).rows[0]
  assert.ok(record)
  const state = decodeExecutionState(record.result)
  assert.equal(state.id, recordId)
  assert.equal(state.workflowId, workflow.id)
  const reviewRun = state.nodeRuns[58], gateRun = state.nodeRuns[59]
  assert.equal(reviewRun?.node?.id, 'sanguo-media-review')
  assert.equal(gateRun?.node?.id, 'sanguo-media-accept')
  assert.equal(reviewRun.status, 'success')
  const prepared = prepareWorkflowRunContext(state.nodeRuns, 59)
  assert.ok(prepared)
  const context = prepared.inputContext
  assert.equal(context.media_review?.decision, 'revise')
  assert.ok(context.media_review?.issues?.some(issue => issue.code === 'core_event_contradiction'))
  const gate = candidate.nodes.find(node => node.id === 'sanguo-media-accept')
  assert.ok(gate?.code)
  const params = Object.fromEntries(gate.params.map(param => {
    const key = param.englishName || param.name
    const source = String(param.value)
    const exact = /^\$\{([^}]+)\}$/.exec(source.trim())
    let value = exact ? exact[1].trim().split('.').reduce((row, part) => row?.[part], context)
      : renderWorkflowTemplate(source, context)
    assert.notEqual(value, undefined, 'unresolved gate parameter ' + key)
    if (!exact && param.type === 'number') value = Number(value)
    else if (!exact && param.type === 'boolean') value = value === 'true'
    else if (!exact && param.type === 'json') value = JSON.parse(value)
    return [key, value]
  }))
  assert.equal(params.qualityMode, 'principle-v1')
  assert.equal(params.qualityDisposition, 'manual-review-v1')
  const before = JSON.stringify(context)
  const result = await executeCodeNode({ code: gate.code, context, params })
  assert.equal(JSON.stringify(context), before, 'saved context changed during local replay')
  assert.equal(result.passed, true)
  assert.equal(result.manualDecisionRequired, true)
  assert.equal(result.qualityReview?.manualDecisionRequired, true)
  assert.equal(result.durationCompletion?.assessment, 'uncertain')
  assert.equal(result.routeError, undefined)
  assert.equal(result.samplingRetryPlan, undefined)
  assert.deepEqual(result.qualityReview.rawReport, context.media_review)
  const qualified = result.qualityReview.principleIssues.filter(issue =>
    issue.code === 'core_event_contradiction' && issue.evidence?.source === 'frame')
  assert.ok(qualified.length > 0)
  assert.equal(result.originalUrl, context.video_take.url)
  await client.query('ROLLBACK')
  console.log(JSON.stringify({ recordId, reviewIndex: 58, gateIndex: 59,
    sourceSchema: 179, targetSchema: 180, sourceNodesMd5: workflow.nodes_md5,
    sourceEdgesMd5: workflow.edges_md5, sourceRecordMd5: record.result_md5,
    reviewDecision: context.media_review.decision, qualifiedIssueCount: qualified.length,
    qualifiedIssueFrameIndices: qualified.map(issue => issue.evidence.frameIndices),
    durationAssessment: result.durationCompletion.assessment,
    manualDecisionRequired: result.manualDecisionRequired, routeError: null,
    samplingRetryPlan: false, savedReviewPreserved: true, executionWrites: 0, providerCalls: 0 }, null, 2))
} catch (error) {
  await client.query('ROLLBACK').catch(() => undefined)
  throw error
} finally {
  await client.end()
}
