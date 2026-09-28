#!/usr/bin/env node
// Exactly one new Kling image task for the prepared 610 scene-03 coverage shot.
// A second invocation never POSTs; inspect the saved task/ledger instead.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'

const out = path.resolve(process.argv[2] || 'logs/dramatic-expression/live-20260928/record-7cb4d1-readonly/loop3-media/scene3-coverage-first-frame-20260928-v1')
const sha = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex')
const plan = JSON.parse(await readFile(path.join(out, 'plan-private.json'), 'utf8'))
assert.equal(plan.format, 'scene3-coverage-first-frame-preflight-v1')
assert.equal(plan.schemaVersion, 156)
assert.equal(plan.imageNodeId, 'sanguo-coverage-first-frame')
assert.equal(plan.params.referenceImage, plan.params.coverageSources.previousTail.url)
assert.equal(plan.params.imageEdit, true)
assert.equal(plan.params.coverageSources.previousTail.source, 'extracted-from-video')
assert.equal(plan.promptSha256, sha(plan.prompt))
for (const item of [plan.params.coverageSources.previousTail, ...plan.params.coverageSources.referenceBindings]) {
  assert.equal(item.sha256, sha(await readFile(path.resolve(`public${item.url}`))))
}
const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
try {
  const workflow = (await db.query("select schema_version from workflow_configs where id='wf-sanguo-history-drama'")).rows[0]
  assert.equal(workflow.schema_version, 156)
  const source = (await db.query('select md5(result::text) as md5 from execution_records where id=$1', [plan.sourceId])).rows[0]
  assert.equal(source?.md5, plan.sourceMd5)
  const existing = (await db.query("select id,status,task_id from model_execution_records where request_data->>'requestKey'=$1", [plan.requestKey])).rows
  assert.equal(existing.length, 0, 'Unique paid image requestKey already used; inspect ledger, do not submit again')
  const model = (await db.query('select id,name,provider,capability,settings from model_configs where id=$1', [plan.imageModelId])).rows[0]
  assert.equal(model?.provider, 'Kling')
  assert.equal(model.capability, 'image')
  assert.match(String(model.settings?.model), /^kling-v3/)
  const request = { model, prompt: plan.prompt, params: plan.params, operation: plan.imageOperation,
    executionContext: { workflowId: 'wf-sanguo-history-drama', workflowName: '三国原著史料短剧（分步生成）',
      nodeId: plan.imageNodeId, nodeName: '同场切镜新机位首帧', requestKey: plan.requestKey } }
  const intent = { format: 'scene3-coverage-first-frame-submit-intent-v1', at: new Date().toISOString(),
    requestKey: plan.requestKey, requestSha256: sha({ modelId: model.id, prompt: request.prompt,
      params: request.params, operation: request.operation, executionContext: request.executionContext }),
    sourceMd5: plan.sourceMd5, shotSha256: plan.shotSha256, previousTailSha256: plan.params.coverageSources.previousTail.sha256,
    assetIds: plan.params.coverageSources.referenceBindings.map(item => item.assetId), maxNewImageTasks: 1,
    videoTaskSubmissionAllowed: false }
  await writeFile(path.join(out, 'image-submit-intent.json'), JSON.stringify(intent, null, 2) + '\n', { flag: 'wx' })
  const response = await fetch('http://127.0.0.1:5173/api/node-run', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
  })
  const envelope = await response.json()
  const ledger = (await db.query(`select id,status,task_id,http_status,error,response_data,
    request_data->>'requestKey' as request_key,request_data->>'fingerprint' as request_fingerprint,
    created_at from model_execution_records where request_data->>'requestKey'=$1 order by created_at`, [plan.requestKey])).rows
  const taskIds = [...new Set(ledger.map(row => row.task_id).filter(Boolean))]
  assert.ok(taskIds.length <= 1, 'More than one paid image task was created; stop')
  const result = envelope.body && typeof envelope.body === 'object' ? envelope.body : {}
  const data = result.data && typeof result.data === 'object' ? result.data : {}
  const imageUrl = data.task_result?.images?.[0]?.url
  const imageBytes = typeof imageUrl === 'string' && /^\/generated\/[\w.-]+\.(?:png|jpe?g|webp)$/i.test(imageUrl)
    ? await readFile(path.resolve(`public${imageUrl}`)) : undefined
  const proof = { format: 'scene3-coverage-first-frame-paid-result-v1', at: new Date().toISOString(),
    requestKey: plan.requestKey, httpStatus: response.status, nodeStatus: envelope.status,
    imageModelId: model.id, taskIds, taskCount: taskIds.length,
    ledger: ledger.map(row => ({ id: row.id, status: row.status, taskId: row.task_id,
      httpStatus: row.http_status, requestFingerprint: row.request_fingerprint, error: row.error,
      finalUnitDeduction: row.response_data?.data?.final_unit_deduction ?? null })),
    imageUrl: imageUrl ?? null, imageSha256: imageBytes ? sha(imageBytes) : null,
    finalUnitDeduction: data.final_unit_deduction ?? null,
    imagePersistedLocally: Boolean(imageBytes), videoTaskCount: 0,
    sourceExecutionWriteCount: 0 }
  await writeFile(path.join(out, 'image-result-private.json'), JSON.stringify({ ...proof, response: envelope }, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 })
  await writeFile(path.join(out, 'image-result-proof.json'), JSON.stringify(proof, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify(proof, null, 2))
  if (response.status !== 200 || envelope.status !== 200 || !imageBytes || taskIds.length !== 1) process.exitCode = 1
} finally { await db.end() }
