// Exercise the actual HTTP route and database ledger with deterministic upstream faults.
// Does not use paid providers and is not a substitute for the real full-workflow test.
import { createServer } from 'node:http'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import pg from 'pg'
import sharp from 'sharp'
const imageBytes = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#abc123' } }).png().toBuffer()
const base = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:5178'
const counts = new Map()
const upstream = createServer(async (req, res) => {
  let body = ''
  for await (const part of req) body += part
  const count = (counts.get(req.url) ?? 0) + 1
  counts.set(req.url, count)
  if (req.url === '/pending-image') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ code: 0, data: { task_id: 'durable-image-task', task_status: 'submitted' } }))
    return
  }
  if (req.url === '/pending-image/durable-image-task') {
    if (count <= 3) { res.writeHead(524); res.end('error code: 524'); return }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ code: 0, data: { task_id: 'durable-image-task', task_status: 'succeed', task_result: { images: [{ url: 'https://example.test/durable.png' }] } } }))
    return
  }
  if (req.url === '/image-checkpoint') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ code: 0, data: { task_id: `${runId}-image-${count}`, task_status: 'succeed', task_result: { images: [{ url: `https://example.test/image-${count}.png` }] } } }))
    return
  }
  if (req.url === '/base64-image-checkpoint') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ data: [{ b64_json: imageBytes.toString('base64') }] }))
    return
  }
  assert.equal(JSON.parse(body).stream, true)
  if (req.url === '/always-524' || (req.url === '/recover-524' && count === 1)) {
    res.writeHead(524, { 'Content-Type': 'text/plain' }); res.end('error code: 524\n'); return
  }
  if (req.url === '/duplicate-request') await new Promise(resolve => setTimeout(resolve, 50))
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const send = value => res.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`)
  send({ type: 'message_start', message: { id: 'transport-test', content: [] } })
  send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
  send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: req.url === '/review-checkpoint' && JSON.parse(body).messages.at(-1).content.at(-1).text !== 'invalid-observation' ? '{"people":[],"setting":"empty courtyard"}' : '{"complete":true}' } })
  if (req.url === '/incomplete' && count === 1) { res.end(); return }
  send({ type: 'content_block_stop', index: 0 })
  send({ type: 'message_delta', delta: { stop_reason: 'end_turn' } })
  send({ type: 'message_stop' }); res.end()
})
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
const runId = `transport-regression-${Date.now()}`
const evidence = { runId, base, scope: 'actual-api-route-fault-injection', results: [] }
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
try {
  for (const scenario of ['recover-524', 'incomplete', 'always-524', 'duplicate-request', 'invalid-template']) {
    const makeRequest = () => fetch(`${base}/api/node-run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      model: { id: 'transport-test', name: '传输故障注入自测', provider: 'Anthropic', capability: 'text', settings: { apiKey: 'test-not-a-secret', model: 'test', endpoint: `http://127.0.0.1:${upstream.address().port}/${scenario}` } },
      prompt: scenario === 'invalid-template' ? '史料：[object Object]' : 'test', params: {}, operation: 'history.scene-outline', executionContext: { requestKey: `${runId}:${scenario}`, workflowId: runId, nodeId: scenario },
    }) })
    const response = scenario === 'duplicate-request' ? (await Promise.all([makeRequest(), makeRequest()]))[0] : await makeRequest()
    const result = await response.json()
    if (scenario === 'invalid-template') {
      assert.equal(response.status, 500); assert.match(JSON.stringify(result), /HISTORY_INPUT_SERIALIZATION/); assert.equal(counts.get('/invalid-template'), undefined)
      evidence.results.push({ scenario, apiStatus: response.status, upstreamRequests: 0 }); continue
    }
    assert.equal(result.status, scenario === 'always-524' ? 524 : 200)
    assert.equal(counts.get(`/${scenario}`), scenario === 'always-524' ? 3 : scenario === 'duplicate-request' ? 1 : 2)
    if (scenario === 'always-524') assert.equal(result.body.error.retryExhausted, true)
    else assert.equal(result.body.content[0].text, '{"complete":true}')
    if (scenario !== 'always-524') {
      const requestsBefore = counts.get(`/${scenario}`)
      const resumed = await (await makeRequest()).json()
      assert.equal(resumed.status, 200)
      assert.equal(counts.get(`/${scenario}`), requestsBefore, 'checkpoint must resume the same completed outline without another writer call')
    }
    const row = (await pool.query('select id,status,http_status,error,response_data from model_execution_records where workflow_id=$1 and node_id=$2', [runId, scenario])).rows[0]
    assert.equal(row.http_status, result.status)
    assert.equal(row.response_data.transport.attempts.length, counts.get(`/${scenario}`))
    if (scenario === 'always-524') assert.match(row.error, /524/)
    evidence.results.push({ scenario, apiStatus: result.status, requests: counts.get(`/${scenario}`), recordId: row.id, attempts: row.response_data.transport.attempts })
  }
  const reviewPath = `/generated/${runId}-review.jpg`
  await fs.writeFile(`public${reviewPath}`, await sharp(imageBytes).jpeg().toBuffer())
  try {
    const reviewRequest = (prompt = 'observe', key = `${runId}:review`) => fetch(`${base}/api/node-run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      model: { id: 'review-checkpoint-test', name: '审核恢复故障注入', provider: 'Anthropic', capability: 'text', settings: { apiKey: 'test-not-a-secret', model: 'test', endpoint: `http://127.0.0.1:${upstream.address().port}/review-checkpoint` } },
      prompt, params: { reviewImages: [reviewPath] }, operation: 'history.media-review', executionContext: { requestKey: key, workflowId: runId, nodeId: 'review' },
    }) }).then(response => response.json())
    const firstReview = await reviewRequest()
    assert.equal(firstReview.status, 200)
    const resumedReview = await reviewRequest()
    assert.equal(resumedReview.status, 200)
    assert.deepEqual(resumedReview.body.content, firstReview.body.content)
    assert.equal(counts.get('/review-checkpoint'), 1, 'identical completed frame observation must resume without another model call')
    await reviewRequest('new rubric')
    assert.equal(counts.get('/review-checkpoint'), 2, 'new review instructions must not reuse old conclusions')
    await fs.writeFile(`public${reviewPath}`, await sharp({ create: { width: 32, height: 32, channels: 3, background: '#552288' } }).jpeg().toBuffer())
    await reviewRequest()
    assert.equal(counts.get('/review-checkpoint'), 3, 'changed image bytes at the same path must invalidate the observation')
    await reviewRequest('observe', `${runId}:independent-review`)
    assert.equal(counts.get('/review-checkpoint'), 4, 'independent review uses a fresh request identity')
    await reviewRequest('invalid-observation')
    await reviewRequest('invalid-observation')
    assert.equal(counts.get('/review-checkpoint'), 6, 'malformed observation must not poison recovery with a cached invalid result')
    evidence.results.push({ scenario: 'review-checkpoint', resumedObservation: true, changedRubricInvalidated: true, changedImageBytesInvalidated: true, independentReviewFresh: true, invalidObservationNotReused: true, upstreamRequests: 6 })
  } finally { await fs.rm(`public${reviewPath}`, { force: true }) }
  const imageRequest = () => fetch(`${base}/api/node-run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    model: { id: 'image-checkpoint-test', name: '图片恢复故障注入', provider: 'Kling', capability: 'image', settings: { apiKey: 'test-not-a-secret', model: 'test', endpoint: `http://127.0.0.1:${upstream.address().port}/image-checkpoint` } },
    prompt: 'test portrait', params: { aspectRatio: '16:9' }, operation: 'character.three-view', executionContext: { requestKey: `${runId}:image`, workflowId: runId, nodeId: 'image' },
  }) })
  const firstImage = await (await imageRequest()).json()
  const resumedImage = await (await imageRequest()).json()
  assert.equal(firstImage.status, 200)
  assert.deepEqual(resumedImage, firstImage)
  assert.equal(counts.get('/image-checkpoint'), 1, 'review transport recovery must reuse the completed image')
  await pool.query("update model_execution_records set response_data=response_data || '{\"qualityRejected\":true}'::jsonb where workflow_id=$1 and node_id='image'", [runId])
  const replacedImage = await (await imageRequest()).json()
  assert.equal(replacedImage.status, 200)
  assert.notEqual(replacedImage.body.data.task_id, firstImage.body.data.task_id)
  assert.equal(counts.get('/image-checkpoint'), 2, 'a proven quality rejection must not be reused')
  evidence.results.push({ scenario: 'image-checkpoint', resumedWithoutPurchase: true, rejectedImageReplaced: true, upstreamRequests: 2 })
  const base64Request = () => fetch(`${base}/api/node-run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    model: { id: 'base64-checkpoint-test', name: '本地兼容接口图片恢复故障注入', provider: 'OpenAI', capability: 'image', settings: { apiKey: 'test-not-a-secret', model: 'test', endpoint: `http://127.0.0.1:${upstream.address().port}/base64-image-checkpoint` } },
    prompt: 'test portrait', params: {}, operation: 'character.three-view', executionContext: { requestKey: `${runId}:base64`, workflowId: runId, nodeId: 'base64-image' },
  }) })
  const firstBase64 = await (await base64Request()).json()
  assert.equal(firstBase64.status, 200)
  assert.match(firstBase64.body.data[0].url, /^\/generated\/image-.*\.png$/)
  assert.deepEqual(await fs.readFile(`public${firstBase64.body.data[0].url}`), imageBytes)
  assert.deepEqual(await (await base64Request()).json(), firstBase64)
  assert.equal(counts.get('/base64-image-checkpoint'), 1)
  await pool.query("update model_execution_records set response_data=response_data || '{\"qualityRejected\":true}'::jsonb where workflow_id=$1 and node_id='base64-image'", [runId])
  assert.equal((await (await base64Request()).json()).status, 200)
  assert.equal(counts.get('/base64-image-checkpoint'), 2)
  evidence.results.push({ scenario: 'base64-image-checkpoint', persistedBytesVerified: true, resumedWithoutPurchase: true, rejectedImageReplaced: true })
  const pendingImageRequest = () => fetch(`${base}/api/node-run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    model: { id: 'pending-image-test', name: '图片提交后断线恢复', provider: 'Kling', capability: 'image', settings: { apiKey: 'test-not-a-secret', model: 'test', pollIntervalMs: '100', endpoint: `http://127.0.0.1:${upstream.address().port}/pending-image` } },
    prompt: 'test pending image', params: {}, operation: 'character.three-view', executionContext: { requestKey: `${runId}:pending-image`, workflowId: runId, nodeId: 'pending-image' },
  }) })
  const interruptedImage = await pendingImageRequest()
  assert.equal(interruptedImage.status, 500)
  assert.match(JSON.stringify(await interruptedImage.json()), /durable-image-task/)
  const pendingLedger = (await pool.query("select status,task_id from model_execution_records where workflow_id=$1 and node_id='pending-image'", [runId])).rows[0]
  assert.equal(pendingLedger.status, 'processing')
  assert.equal(pendingLedger.task_id, 'durable-image-task')
  const resumedPendingImage = await (await pendingImageRequest()).json()
  assert.equal(resumedPendingImage.status, 200)
  assert.equal(resumedPendingImage.body.data.task_id, 'durable-image-task')
  assert.equal(counts.get('/pending-image'), 1)
  assert.equal(counts.get('/pending-image/durable-image-task'), 4)
  evidence.results.push({ scenario: 'pending-image-checkpoint', submittedOnce: true, resumedTaskId: 'durable-image-task', queries: 4 })
  await fs.mkdir('logs/quality-regression', { recursive: true })
  await fs.writeFile('logs/quality-regression/transport-regression.json', JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify(evidence))
} finally { upstream.close(); await pool.end() }
