#!/usr/bin/env node
// Independent image review only; never submits a video. One immutable request
// key protects the Codex model ledger from accidental repeated review calls.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'
import { renderWorkflowTemplate } from '../src/workflow-template.ts'
import { extractTextResponse, parseStructuredJson } from '../src/workflow-core.ts'
import { COVERAGE_CUT_FRAME_REVIEW_PROMPT } from '../src/coverage-cut-frame-gate.ts'
import { assertCoverageCutReviewLedgerRecord } from '../server/coverage-cut-review-ledger.ts'

const out = path.resolve(process.argv[2] || 'logs/dramatic-expression/live-20260928/record-7cb4d1-readonly/loop3-media/scene3-coverage-first-frame-20260928-v1')
const attempt = process.argv[3] || 'v1'
assert.match(attempt, /^v[1-9]\d*$/)
const suffix = attempt === 'v1' ? '' : `-${attempt}`
const sha = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex')
const plan = JSON.parse(await readFile(path.join(out, 'plan-private.json'), 'utf8'))
const image = JSON.parse(await readFile(path.join(out, 'image-result-proof.json'), 'utf8'))
const evidence = JSON.parse(await readFile(path.join(out, 'image-evidence.json'), 'utf8'))
const projection = JSON.parse(await readFile(path.join(out, 'review-shot.json'), 'utf8'))
assert.equal(image.taskCount, 1)
assert.equal(image.imagePersistedLocally, true)
assert.equal(evidence.items[1].url, image.imageUrl)
assert.equal(evidence.items[0].url, plan.params.coverageSources.previousTail.url)
assert.equal(projection.sourceShotSha256, plan.shotSha256)
assert.equal(sha(projection.shot), projection.reviewShotSha256)
const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
try {
  const workflow = (await db.query("select schema_version,nodes from workflow_configs where id='wf-sanguo-history-drama'")).rows[0]
  assert.equal(workflow.schema_version, 156)
  const node = workflow.nodes.find(item => item.id === 'sanguo-coverage-review')
  assert.equal(node?.kind, 'text')
  assert.equal(node.prompt, COVERAGE_CUT_FRAME_REVIEW_PROMPT, 'Saved reviewer prompt differs from reviewed source')
  const model = (await db.query('select id,name,provider,capability,settings from model_configs where id=$1', [node.modelId])).rows[0]
  assert.equal(model?.provider, 'Codex')
  assert.equal(model.capability, 'text')
  const params = { reviewImages: evidence.reviewImages, evidence,
    shot: projection.shot, previousTail: plan.params.coverageSources.previousTail,
    referenceBindings: plan.params.coverageSources.referenceBindings, temperature: 0 }
  const prompt = renderWorkflowTemplate(node.prompt, { coverage_evidence: evidence, shot_script: projection.shot })
  assert.ok(prompt.includes('只按附件实际像素审核'))
  assert.ok(prompt.includes(`采证报告地址：${evidence.evidenceUrl}`))
  assert.ok(prompt.includes('画外的既有配角，不要求其在新画面中可见'))
  const requestKey = `scene3-coverage-image-review:${randomUUID()}`
  const request = { model, prompt, params,
    executionContext: { workflowId: 'wf-sanguo-history-drama', workflowName: '三国原著史料短剧（分步生成）',
      nodeId: node.id, nodeName: node.title, requestKey } }
  const intent = { format: 'scene3-coverage-image-independent-review-intent-v1', attempt, at: new Date().toISOString(),
    requestKey, modelId: model.id, promptSha256: sha(prompt), promptChars: prompt.length,
    evidenceUrl: evidence.evidenceUrl, reviewImageUrls: evidence.reviewImages,
    shotSha256: projection.reviewShotSha256, imageTaskId: image.taskIds[0],
    imageSha256: image.imageSha256, videoTaskSubmissionAllowed: false }
  await writeFile(path.join(out, `review-intent${suffix}.json`), JSON.stringify(intent, null, 2) + '\n', { flag: 'wx' })
  const response = await fetch('http://127.0.0.1:5173/api/node-run', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
  })
  const envelope = await response.json()
  const ledger = (await db.query(`select id,channel,workflow_id,node_id,capability,provider,status,
    http_status,error,request_data,response_data,created_at from model_execution_records
    where request_data->>'requestKey'=$1 order by created_at`, [requestKey])).rows
  let report, bindingError
  try {
    report = parseStructuredJson(extractTextResponse(envelope.body))
    if (!report || Array.isArray(report)) throw new Error('No structured image review JSON')
    const succeeded = ledger.find(row => row.status === 'succeeded')
    assertCoverageCutReviewLedgerRecord(succeeded, report, { evidence, shot: projection.shot,
      previousTail: params.previousTail, referenceBindings: params.referenceBindings,
      reviewImages: params.reviewImages })
  } catch (error) { bindingError = error instanceof Error ? error.message : String(error) }
  const proof = { format: 'scene3-coverage-image-independent-review-result-v1', attempt, at: new Date().toISOString(),
    requestKey, httpStatus: response.status, nodeStatus: envelope.status,
    ledger: ledger.map(row => ({ id: row.id, provider: row.provider, status: row.status,
      httpStatus: row.http_status, error: row.error, taskId: row.task_id ?? null })),
    report: report ?? null, ledgerBoundToActualAttachments: !bindingError, bindingError: bindingError ?? null,
    evidenceUrl: evidence.evidenceUrl, imageTaskId: image.taskIds[0],
    videoTaskCount: 0, sourceExecutionWriteCount: 0 }
  await writeFile(path.join(out, `review-result-private${suffix}.json`), JSON.stringify({ ...proof, response: envelope }, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 })
  await writeFile(path.join(out, `review-result${suffix}.json`), JSON.stringify(proof, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify(proof, null, 2))
  if (response.status !== 200 || envelope.status !== 200 || bindingError) process.exitCode = 1
} finally { await db.end() }
