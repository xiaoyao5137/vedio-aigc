import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyModelFailure, modelRetryStopped } from '../src/model-failure.ts'
import { callAnthropicText, TEXT_TRANSPORT_DEADLINE_MS } from '../server/anthropic-text.ts'
import { retryHistoricalText } from '../src/storyboard-runtime.ts'
import { runPrincipleReview } from '../src/principle-review-runtime.ts'
import { errorRetryTransition } from '../src/node-retry.ts'

const model = { id: 'writer', provider: 'Anthropic', capability: 'text', settings: { apiKey: 'fixture', endpoint: 'http://localhost/messages', model: 'configured-model' } }
const unavailable = { error: { code: 'model_not_found', type: 'new_api_error', message: 'No available channel for model configured-model under group writer' } }
const success = () => Response.json({ content: [{ type: 'text', text: 'complete' }] })

test('classifies gateway error semantics before status without scanning successful text', () => {
  assert.equal(classifyModelFailure(503, unavailable), 'channel_unavailable')
  assert.equal(classifyModelFailure(502, { error: { type: 'authentication_error' } }), 'access_denied')
  assert.equal(classifyModelFailure(429, { error: { code: 'insufficient_quota' } }), 'quota_exhausted')
  assert.equal(classifyModelFailure(503, { error: { type: 'invalid_request_error' } }), 'invalid_request')
  assert.equal(classifyModelFailure(503, 'temporarily overloaded'), 'transient')
  assert.equal(classifyModelFailure(200, unavailable), 'other')
  assert.equal(classifyModelFailure(503, { content: [{ text: 'model_not_found' }] }), 'transient')
})

test('provider content rejection is permanent even when a gateway wraps it in HTTP 502 or 403', () => {
  const kling = { code: 0, data: { task_id: 'rejected-image', task_status: 'failed', task_status_msg: 'Failure to pass the risk control system' } }
  for (const status of [400, 403, 502, 503]) {
    assert.equal(classifyModelFailure(status, kling), 'content_rejected')
    assert.equal(classifyModelFailure(status, { provider_response: kling }), 'content_rejected')
    assert.equal(classifyModelFailure(status, { error: { upstream: kling } }), 'content_rejected')
    assert.equal(classifyModelFailure(status, { error: { code: 'content_policy_violation' } }), 'content_rejected')
  }
  assert.equal(classifyModelFailure(200, kling), 'other')
  assert.equal(classifyModelFailure(502, { data: { task_result: { message: 'Failure to pass the risk control system' }, prompt: 'content_policy_violation' } }), 'transient')
  assert.equal(classifyModelFailure(502, { data: { task_status_msg: 'Risk control system temporarily unavailable' } }), 'transient')
})

test('text content rejection stops before transport retry or explicit failover preparation', async () => {
  let calls = 0
  const upstream = { error: { type: 'content_policy_violation', message: 'Content rejected by safety moderation' } }
  const result = await callAnthropicText(model, 'original', undefined, {
    maxAttemptsBeforeFailover: 1,
    fetch: async () => { calls++; return Response.json(upstream, { status: 502 }) },
    sleep: async () => { assert.fail('content rejection cannot spend a retry wait') },
  })
  assert.equal(calls, 1)
  const error = (result.body as { error: { type: string; retryable: boolean; upstream: unknown } }).error
  assert.equal(error.type, 'MODEL_CONTENT_REJECTED')
  assert.equal(error.retryable, false)
  assert.deepEqual(error.upstream, upstream)
  assert.equal(result.transport.attempts[0].failureKind, 'content_rejected')
})

test('observed 429 followed by missing channels stops after three probes, preserving every actual response', async () => {
  let calls = 0
  const waits: number[] = []
  const result = await callAnthropicText(model, 'original', undefined, {
    fetch: async (_url, init) => {
      assert.equal(JSON.parse(String(init?.body)).model, 'configured-model')
      calls++
      return calls === 1 ? Response.json({ error: { message: 'All credentials reached the local RPM limit.' } }, { status: 429 }) : Response.json(unavailable, { status: 503 })
    }, sleep: async ms => { waits.push(ms) },
  })
  assert.equal(calls, 4)
  assert.equal(waits.length, 3)
  assert.deepEqual(result.transport.attempts.map(a => a.failureKind), ['transient', ...Array(3).fill('channel_unavailable')])
  const error = (result.body as { error: { type: string; retryable: boolean; upstream: unknown } }).error
  assert.equal(error.type, 'MODEL_CHANNEL_UNAVAILABLE')
  assert.equal(error.retryable, false)
  assert.deepEqual(error.upstream, unavailable)
})

test('missing channel may recover within probe budget; generic 503 retains ordinary retry behavior', async () => {
  for (const [body, failures] of [[unavailable, 2], ['temporarily unavailable', 4]] as const) {
    let calls = 0
    const result = await callAnthropicText(model, 'original', undefined, {
      fetch: async () => ++calls <= failures ? Response.json(body, { status: 503 }) : success(), sleep: async () => {},
    })
    assert.equal(calls, failures + 1)
    assert.equal(result.status, 200)
  }
})

test('HTTP, wrapped HTTP 200 and SSE errors use the same stop classification', async () => {
  for (const [detail, expected, callsExpected] of [
    [unavailable.error, 'MODEL_CHANNEL_UNAVAILABLE', 3],
    [{ type: 'authentication_error' }, 'MODEL_ACCESS_DENIED', 1],
    [{ code: 'insufficient_quota' }, 'MODEL_QUOTA_EXHAUSTED', 1],
    [{ type: 'invalid_request_error' }, 'MODEL_REQUEST_INVALID', 1],
    [{ message: "Model 'x' requires a PRO subscription. All available credentials are FREE tier." }, 'MODEL_ACCESS_DENIED', 1],
  ] as const) {
    for (const mode of ['http', 'wrapped', 'sse']) {
      let calls = 0
      const body = { type: 'error', error: detail }
      const result = await callAnthropicText(model, 'original', undefined, {
        fetch: async () => {
          calls++
          return mode === 'sse' ? new Response(`event: error\ndata: ${JSON.stringify(body)}\n\n`, { headers: { 'content-type': 'text/event-stream' } })
            : Response.json(body, { status: mode === 'http' ? 503 : 200 })
        }, sleep: async () => {},
      })
      assert.equal(calls, callsExpected, `${mode}/${expected}`)
      assert.equal((result.body as { error: { type: string } }).error.type, expected)
    }
  }
})

test('total time budget accounts for provider latency as well as waits and shrinks the request signal', async () => {
  let time = 0, calls = 0
  const result = await callAnthropicText(model, 'original', undefined, {
    now: () => time,
    fetch: async (_url, init) => {
      calls++
      assert.ok(init?.signal)
      assert.equal(init.signal.aborted, false)
      time += TEXT_TRANSPORT_DEADLINE_MS / 2
      return new Response('temporary upstream failure', { status: 524 })
    }, sleep: async ms => { time += ms },
  })
  assert.equal(calls, 2)
  assert.equal((result.body as { error: { type: string } }).error.type, 'MODEL_TRANSPORT_DEADLINE')
})

test('SSE rate limits recover with the same backoff as HTTP rate limits', async () => {
  let calls = 0
  const waits: number[] = []
  const result = await callAnthropicText(model, 'original', undefined, {
    fetch: async () => ++calls === 1 ? new Response('event: error\ndata: {"type":"error","error":{"type":"rate_limit_error"}}\n\n', { headers: { 'content-type': 'text/event-stream' } }) : success(),
    sleep: async ms => { waits.push(ms) },
  })
  assert.equal(result.status, 200)
  assert.equal(calls, 2)
  assert.deepEqual(waits, [30_000])
})

test('a delayed timer cannot submit another request after the total deadline', async () => {
  let time = 0, calls = 0
  const result = await callAnthropicText(model, 'original', undefined, {
    now: () => time, fetch: async () => { calls++; return new Response('overloaded', { status: 503 }) },
    sleep: async () => { time = TEXT_TRANSPORT_DEADLINE_MS + 1 },
  })
  assert.equal(calls, 1)
  assert.match(JSON.stringify(result.body), /MODEL_TRANSPORT_DEADLINE/)
})

test('writer, reviewer and workflow patterns cannot multiply an upstream stop decision', async () => {
  for (const code of ['MODEL_CONTENT_REJECTED', 'MODEL_CHANNEL_UNAVAILABLE', 'MODEL_ACCESS_DENIED', 'MODEL_QUOTA_EXHAUSTED', 'MODEL_REQUEST_INVALID', 'MODEL_TRANSPORT_DEADLINE']) {
    const message = `HTTP 503: ${JSON.stringify({ error: { type: code, retryable: false } })}`
    let calls = 0
    const fail = async () => { calls++; throw Error(message) }
    assert.ok(modelRetryStopped(message))
    await assert.rejects(retryHistoricalText(fail, async () => {}), new RegExp(code))
    assert.equal(calls, 1)
    calls = 0
    const review = await runPrincipleReview({ generate: fail, normalize: raw => raw })
    assert.equal(calls, 1)
    assert.equal(review.reviewTransport.upstreamStopped, true)
    assert.equal(review.reviewUnavailable, true)
    const runs = [{ node: { id: 'review', kind: 'text', resultVar: 'result', errorRetry: { retryFrom: 'review', maxAttempts: 20, patterns: ['HTTP 503'] } }, status: 'failed', context: {}, durationMs: 0 }]
    assert.equal(errorRetryTransition(runs, 0, message), undefined)
  }
})
