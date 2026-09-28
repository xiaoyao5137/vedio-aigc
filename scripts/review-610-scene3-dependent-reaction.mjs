#!/usr/bin/env node
// Exactly one independent text+vision review of the already-paid scene-03
// video evidence. Never calls a video/image generator or alters an execution.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'
import { renderWorkflowTemplate } from '../src/workflow-template.ts'
import { extractTextResponse, normalizeStructuredTextOutput, parseStructuredJson } from '../src/workflow-core.ts'
import { PRINCIPLE_MEDIA_REVIEW_PROMPT } from '../src/principle-media-quality.ts'

assert.deepEqual(process.argv.slice(2), ['--review'])
const out = path.resolve('logs/dramatic-expression/live-20260928/record-7cb4d1-readonly/loop3-media/scene3-speech-reaction-replay-20260928-v1')
const shotPath = path.resolve('logs/dramatic-expression/live-20260928/record-7cb4d1-readonly/loop3-media/scene3-coverage-first-frame-20260928-v1/review-shot.json')
const sha = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex')
const read = name => readFile(path.join(out, name), 'utf8').then(JSON.parse)
const [prior, projection] = await Promise.all([read('evidence-result.json'), readFile(shotPath, 'utf8').then(JSON.parse)])
assert.equal(prior.httpStatus, 200)
const evidence = JSON.parse(await readFile(path.resolve('public', prior.evidenceUrl.slice(1)), 'utf8'))
assert.equal(evidence.evidenceUrl, prior.evidenceUrl)
assert.equal(evidence.evidenceRequest.latestSpeechEnd, 6.149)
assert.equal(evidence.frames.length, 12)
const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
try {
  const graph = (await db.query(`select schema_version,nodes from workflow_configs where id='wf-sanguo-history-drama'`)).rows[0]
  assert.equal(graph.schema_version, 157)
  const node = graph.nodes.find(item => item.id === 'sanguo-media-review')
  assert.equal(node.prompt, PRINCIPLE_MEDIA_REVIEW_PROMPT)
  assert.equal(node.operation, 'history.media-review')
  assert.equal(node.outputMode, 'json')
  const model = (await db.query('select id,name,provider,capability,settings from model_configs where id=$1', [node.modelId])).rows[0]
  assert.equal(model.provider, 'Codex')
  assert.equal(model.capability, 'text')
  const prompt = renderWorkflowTemplate(node.prompt, {
    shot_script: projection.shot, video_evidence: evidence,
    historical_sources: prior.historicSources, subtitlePolicy: 'none' })
  assert.ok(prompt.includes(evidence.evidenceUrl))
  assert.ok(prompt.includes('"actorIds"'))
  assert.ok(prompt.includes('6.149'))
  assert.ok(prompt.includes('严颜'))
  assert.equal(prompt.includes('${'), false)
  const params = { reviewImages: evidence.frames, promptInputMode: 'normalized-results', qualityDisposition: 'manual-review-v1',
    qualityMode: 'principle-v1', maxReviewAttempts: 1, subtitlePolicy: 'none', temperature: 0 }
  const beforeMediaCount = Number((await db.query(`select count(*)::int as count from model_execution_records
    where workflow_id='wf-sanguo-history-drama' and capability in ('image','video')`)).rows[0].count)
  const requestKey = `scene3-dependent-reaction-independent-review:${randomUUID()}`
  const intent = { format: 'scene3-dependent-reaction-review-intent-v1', at: new Date().toISOString(), requestKey,
    schemaVersion: 157, modelId: model.id, nodeId: node.id,
    promptSha256: sha(prompt), promptChars: prompt.length, evidenceUrl: evidence.evidenceUrl,
    videoUrl: evidence.originalUrl, evidenceFrameUrls: evidence.frames, evidenceFrameCount: evidence.frames.length,
    approvedShotSha256: sha(projection.shot), mediaLedgerCountBefore: beforeMediaCount,
    newImageOrVideoRequestsAllowed: 0, executionWritesAllowed: 0 }
  await writeFile(path.join(out, 'review-intent.json'), JSON.stringify(intent, null, 2) + '\n', { flag: 'wx' })
  const request = { model, prompt, operation: node.operation, params,
    executionContext: { workflowId: 'wf-sanguo-history-drama', workflowName: '三国原著史料短剧（分步生成）',
      nodeId: node.id, nodeName: node.title, requestKey } }
  const response = await fetch('http://127.0.0.1:5173/api/node-run', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request), signal: AbortSignal.timeout(300_000) })
  const envelope = await response.json()
  const ledger = (await db.query(`select id,channel,workflow_id,node_id,capability,provider,status,http_status,
    request_data,response_data,created_at from model_execution_records where request_data->>'requestKey'=$1 order by created_at`,
  [requestKey])).rows
  const afterMediaCount = Number((await db.query(`select count(*)::int as count from model_execution_records
    where workflow_id='wf-sanguo-history-drama' and capability in ('image','video')`)).rows[0].count)
  const succeeded = ledger.find(row => row.status === 'succeeded')
  let report, bindingError
  try {
    assert.equal(response.status, 200)
    assert.equal(envelope.status, 200)
    assert.ok(succeeded)
    assert.equal(succeeded.channel, 'workflow')
    assert.equal(succeeded.workflow_id, 'wf-sanguo-history-drama')
    assert.equal(succeeded.node_id, node.id)
    assert.equal(succeeded.capability, 'text')
    assert.equal(succeeded.provider, 'Codex')
    assert.equal(succeeded.request_data.prompt, prompt)
    assert.equal(sha(succeeded.request_data.params.reviewImages), sha(evidence.frames))
    assert.equal(succeeded.request_data.reviewImageHashes.length, evidence.frames.length)
    for (const [index, url] of evidence.frames.entries()) {
      const bytes = await readFile(path.resolve('public', url.slice(1)))
      assert.equal(succeeded.request_data.reviewImageHashes[index].url, url)
      assert.equal(succeeded.request_data.reviewImageHashes[index].sha256, sha(bytes))
    }
    report = parseStructuredJson(extractTextResponse(succeeded.response_data))
    assert.ok(report && !Array.isArray(report))
    assert.equal(report.version, 'principle-review-v1')
    assert.ok(['pass', 'revise', 'uncertain'].includes(String(report.decision)))
    assert.ok(Array.isArray(report.issues))
    assert.deepEqual(parseStructuredJson(extractTextResponse(envelope.body)), report)
    assert.equal(afterMediaCount, beforeMediaCount)
  } catch (error) { bindingError = error instanceof Error ? error.message : String(error) }
  const normalized = report && !bindingError
    ? { ...normalizeStructuredTextOutput(envelope.body, extractTextResponse(envelope.body), 'json'), model: node.modelId }
    : null
  const result = { format: 'scene3-dependent-reaction-review-result-v1', at: new Date().toISOString(), requestKey,
    httpStatus: response.status, nodeStatus: envelope.status, ledger: ledger.map(row => ({ id: row.id,
      provider: row.provider, capability: row.capability, status: row.status, httpStatus: row.http_status })),
    ledgerBoundToCurrentFrames: !bindingError, bindingError: bindingError ?? null,
    evidenceUrl: evidence.evidenceUrl, report: report ?? null, normalizedReview: normalized,
    mediaLedgerCountBefore: beforeMediaCount, mediaLedgerCountAfter: afterMediaCount,
    newImageOrVideoProviderRequests: afterMediaCount - beforeMediaCount,
    executionWrites: 0, concatRan: false }
  await writeFile(path.join(out, 'review-result-private.json'), JSON.stringify({ ...result, envelope }, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 })
  await writeFile(path.join(out, 'review-result.json'), JSON.stringify({ ...result, normalizedReview: undefined }, null, 2) + '\n',
    { flag: 'wx' })
  console.log(JSON.stringify({ requestKey, httpStatus: response.status, ledgerBoundToCurrentFrames: !bindingError,
    bindingError, report, mediaLedgerCountBefore: beforeMediaCount, mediaLedgerCountAfter: afterMediaCount }, null, 2))
  if (bindingError) process.exitCode = 1
} finally { await db.end() }
