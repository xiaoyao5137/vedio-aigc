import test from 'node:test'
import assert from 'node:assert/strict'
import { callAnthropicText, readAnthropicMessage, resolveAnthropicTextConfig } from '../server/anthropic-text.ts'
import { retryHistoricalText } from '../src/storyboard-runtime.ts'
import { runPrincipleReview } from '../src/principle-review-runtime.ts'

const model = { id: 'test', provider: 'Anthropic', capability: 'text', settings: { apiKey: 'test', endpoint: 'http://localhost/messages', model: 'test' } }
const events = [
  { type: 'message_start', message: { id: 'msg-test', content: [], usage: { input_tokens: 10 } } },
  { type: 'ping' },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '{"title":"甘陵党议"}' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 12 } },
  { type: 'message_stop' },
]
function stream(input: Array<Record<string, unknown> & { type: string }> = events) {
  const bytes = new TextEncoder().encode(input.map(e => `event: ${e.type}\r\ndata: ${JSON.stringify(e)}\r\n\r\n`).join(''))
  return new Response(new ReadableStream({ start(controller) {
    // Split UTF-8 code points, CRLF and event boundaries across network chunks.
    for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7))
    controller.close()
  } }), { headers: { 'content-type': 'text/event-stream' } })
}

test('node token and zero-temperature overrides reach the real transport without mutating configuration', async () => {
  const configured = Object.freeze({ ...model, name: 'configured model', settings: Object.freeze({ ...model.settings, maxTokens: '300', temperature: '0.7', custom: 'preserved' }) })
  const params = Object.freeze({ maxTokens: 4096, temperature: 0, unrelated: 'node-only' })
  const resolved = resolveAnthropicTextConfig(configured, params)
  assert.notEqual(resolved, configured)
  assert.notEqual(resolved.settings, configured.settings)
  assert.equal(resolved.name, configured.name)
  assert.deepEqual(resolved.settings, { ...configured.settings, maxTokens: '4096', temperature: '0' })
  let calls = 0
  const content = [{ type: 'text', text: 'independent visual requirement review' }]
  const result = await callAnthropicText(resolved, content, undefined, {
    fetch: async (url, init) => {
      calls++
      assert.equal(url, configured.settings.endpoint)
      assert.deepEqual(JSON.parse(String(init?.body)), { model: 'test', stream: true, max_tokens: 4096, temperature: 0, messages: [{ role: 'user', content }] })
      return stream()
    },
  })
  assert.equal(result.status, 200)
  assert.equal(result.transport.streaming, true)
  assert.equal(calls, 1)
  assert.equal(configured.settings.maxTokens, '300')
  assert.equal(configured.settings.temperature, '0.7')
  assert.deepEqual(params, { maxTokens: 4096, temperature: 0, unrelated: 'node-only' })
})

test('absent node overrides retain model configuration and existing transport defaults', async () => {
  for (const [settings, maxTokens, temperature] of [
    [{ maxTokens: '300', temperature: '0.7' }, 300, 0.7],
    [{ maxTokens: '4096', temperature: '0' }, 4096, 0],
    [{}, 1200, 0.7],
    [{ maxTokens: '' }, 1200, 0.7],
  ] as const) {
    const configured = { ...model, settings: { ...model.settings, ...settings } }
    const resolved = resolveAnthropicTextConfig(configured, { maxTokens: undefined, temperature: undefined })
    assert.deepEqual(resolved, configured)
    const result = await callAnthropicText(resolved, 'test', undefined, {
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body))
        assert.equal(body.max_tokens, maxTokens)
        assert.equal(body.temperature, temperature)
        assert.equal(body.stream, true)
        assert.equal(new Headers(init?.headers).get('accept'), 'text/event-stream')
        return stream()
      },
    })
    assert.equal(result.transport.streaming, true)
  }
})

test('outer attempt deadline returns even when a response body ignores abort forever', async () => {
  let signal: AbortSignal | undefined
  const started = Date.now()
  const result = await callAnthropicText(model, 'test', 'history.scene-outline', {
    maxAttemptsBeforeFailover: 1,
    attemptTimeoutMs: 1000,
    fetch: async (_url, init) => {
      signal = init?.signal ?? undefined
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('event: message_start\ndata: {"type":"message_start","message":{"id":"stalled","content":[]}}\n\n'))
        // Deliberately never close and ignore abort, matching the broken proxy/body boundary.
      } }), { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  assert.equal(result.status, 502)
  assert.equal((result.body as { error: { type: string } }).error.type, 'MODEL_TRANSPORT_FAILOVER_READY')
  assert.match(JSON.stringify(result.body), /MODEL_TRANSPORT_ATTEMPT_TIMEOUT/)
  assert.equal(signal?.aborted, true)
  assert.ok(Date.now() - started < 2000)
})

test('explicit stream settings and node overrides choose the wire format without mutating inputs', async () => {
  const content = [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'fixture' } }, { type: 'text', text: 'Inspect original frames.' }]
  const jsonBody = { content: [{ type: 'text', text: '{"observations":["完整结果"]}' }], stop_reason: 'end_turn', usage: { input_tokens: 30, output_tokens: 12 } }
  for (const [setting, override, expected] of [
    ['false', undefined, false], ['true', undefined, true],
    ['true', false, false], ['false', true, true],
    ['true', 'false', false], ['false', 'true', true],
    [undefined, false, false], [undefined, true, true],
  ] as const) {
    const configured = Object.freeze({ ...model, settings: Object.freeze({ ...model.settings, ...(setting === undefined ? {} : { stream: setting }) }) })
    const params = Object.freeze({ stream: override })
    const before = structuredClone({ configured, params })
    const resolved = resolveAnthropicTextConfig(configured, params)
    assert.equal(resolved.settings.stream, String(expected))
    let calls = 0
    const result = await callAnthropicText(resolved, content, undefined, {
      fetch: async (url, init) => {
        calls++
        assert.equal(url, model.settings.endpoint)
        assert.equal(new Headers(init?.headers).get('accept'), expected ? 'text/event-stream' : 'application/json')
        assert.deepEqual(JSON.parse(String(init?.body)), {
          model: 'test', stream: expected, max_tokens: 1200, temperature: 0.7, messages: [{ role: 'user', content }],
        })
        return expected ? stream() : Response.json(jsonBody)
      },
    })
    assert.equal(result.status, 200)
    assert.equal(result.transport.streaming, expected)
    assert.equal(calls, 1)
    if (!expected) assert.deepEqual(result.body, jsonBody)
    assert.deepEqual({ configured, params }, before)
  }
})

test('numeric strings and temperature boundaries are supported with independent overrides', () => {
  const configured = { ...model, settings: { ...model.settings, maxTokens: '300', temperature: '0.7' } }
  assert.deepEqual(resolveAnthropicTextConfig(configured, { maxTokens: '4096' }).settings, { ...configured.settings, maxTokens: '4096' })
  assert.deepEqual(resolveAnthropicTextConfig(configured, { temperature: '0' }).settings, { ...configured.settings, temperature: '0' })
  assert.deepEqual(resolveAnthropicTextConfig(configured, { temperature: 1 }).settings, { ...configured.settings, temperature: '1' })
})

test('invalid explicit parameters fail before transport, sleep, or attempt reporting', async () => {
  for (const [key, invalid] of [
    ['maxTokens', [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '', ' ', 'invalid', null, true, []]],
    ['temperature', [-0.1, 1.1, NaN, Infinity, '', ' ', 'invalid', null, false, []]],
    ['stream', [0, 1, '', ' ', 'TRUE', 'False', ' false ', 'invalid', null, [], {}]],
  ] as const) {
    for (const value of invalid) {
      let sideEffects = 0
      await assert.rejects(async () => callAnthropicText(resolveAnthropicTextConfig(model, { [key]: value }), 'test', undefined, {
        fetch: async () => { sideEffects++; return stream() },
        sleep: async () => { sideEffects++ },
        onAttempt: async () => { sideEffects++ },
      }), new RegExp(`ANTHROPIC_CONFIG_INVALID: ${key}`))
      assert.equal(sideEffects, 0, `${key}=${String(value)}`)
    }
  }
})

test('direct transport callers also reject invalid model settings before submitting a request', async () => {
  const invalidSettings: Record<string, string>[] = [{ maxTokens: '0' }, { maxTokens: '1.5' }, { temperature: '2' }, { temperature: 'NaN' },
    ...['', ' ', '0', '1', 'TRUE', 'False', ' false ', 'invalid'].map(stream => ({ stream }))]
  for (const settings of invalidSettings) {
    let sideEffects = 0
    await assert.rejects(callAnthropicText({ ...model, settings: { ...model.settings, ...settings } }, 'test', 'history.review', {
      fetch: async () => { sideEffects++; return stream() },
      sleep: async () => { sideEffects++ },
      onAttempt: async () => { sideEffects++ },
    }), /ANTHROPIC_CONFIG_INVALID/)
    assert.equal(sideEffects, 0)
  }
})

test('assembles complete streamed response and usage across arbitrary chunks', async () => {
  const result = await readAnthropicMessage(stream())
  assert.equal(result.status, 200)
  assert.deepEqual((result.body as { content: unknown }).content, [{ type: 'text', text: '{"title":"甘陵党议"}' }])
  assert.deepEqual((result.body as { usage: unknown }).usage, { input_tokens: 10, output_tokens: 12 })
})

test('first outline request recovers raw HTTP 524 then 529 with streaming enabled', async () => {
  const waits: number[] = []
  let calls = 0
  const result = await callAnthropicText(model, 'outline', 'history.scene-outline', {
    fetch: async (_url, init) => {
      assert.equal(JSON.parse(String(init?.body)).stream, true)
      calls++
      if (calls === 1) return new Response('error code: 524\n', { status: 524 })
      if (calls === 2) return new Response('overloaded', { status: 529, headers: { 'retry-after': '4' } })
      return stream()
    }, sleep: async ms => { waits.push(ms) },
  })
  assert.equal(result.status, 200)
  assert.deepEqual(result.transport.attempts.map(a => a.status), [524, 529, 200])
  assert.deepEqual(waits, [1500, 4000])
})

test('a configured primary channel stops early for explicit model failover instead of repeating identical 524s', async () => {
  let calls = 0
  const result = await callAnthropicText(model, 'same governed outline', 'history.scene-outline', {
    fetch: async () => { calls++; return new Response('error code: 524\n', { status: 524 }) },
    sleep: async () => {}, maxAttemptsBeforeFailover: 2,
  })
  assert.equal(calls, 2)
  assert.deepEqual(result.transport.attempts.map(attempt => attempt.status), [524, 524])
  assert.equal((result.body as { error: { type: string } }).error.type, 'MODEL_TRANSPORT_FAILOVER_READY')
})

test('disconnect before message_stop retries whole text, never accepts partial JSON', async () => {
  let calls = 0
  const result = await callAnthropicText(model, 'outline', undefined, { fetch: async () => ++calls === 1 ? stream(events.slice(0, -1)) : stream(), sleep: async () => {} })
  assert.equal(calls, 2)
  assert.equal(result.status, 200)
  assert.match(result.transport.attempts[0].error!, /STREAM_INCOMPLETE/)
})

test('incomplete SSE exhausts the same request mode without silently switching transports', async () => {
  for (const streaming of [true, false]) {
    let calls = 0
    const result = await callAnthropicText({ ...model, settings: { ...model.settings, stream: String(streaming) } }, 'inspect', undefined, {
      fetch: async (_url, init) => {
        calls++
        assert.equal(JSON.parse(String(init?.body)).stream, streaming)
        assert.equal(new Headers(init?.headers).get('accept'), streaming ? 'text/event-stream' : 'application/json')
        // Even when a gateway disregards the JSON request, partial SSE cannot
        // pass because its text happens to contain syntactically complete JSON.
        return stream(events.slice(0, -1))
      },
      sleep: async () => {},
    })
    assert.equal(result.status, 502)
    assert.equal(result.transport.streaming, streaming)
    assert.equal(calls, 5)
    assert.deepEqual(result.transport.attempts.map(attempt => attempt.status), Array(5).fill(502))
    assert.match(JSON.stringify(result.body), /MODEL_TRANSPORT_EXHAUSTED/)
    assert.match(JSON.stringify(result.body), /STREAM_INCOMPLETE/)
    assert.equal(JSON.stringify(result.body).includes('甘陵党议'), false)
  }
})

test('nonstream responses retain truncation, structural validation and upstream retry handling', async () => {
  for (const [body, status, type, expectedCalls] of [
    [{ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"observations":[' }] }, 422, 'MODEL_OUTPUT_TRUNCATED', 1],
    [{ content: [{ type: 'text', text: ' \n' }] }, 422, 'MODEL_RESPONSE_INVALID', 1],
    [{ type: 'error', error: { type: 'authentication_error' } }, 401, 'MODEL_ACCESS_DENIED', 1],
    [{ type: 'error', error: { type: 'overloaded_error' } }, 529, 'MODEL_TRANSPORT_EXHAUSTED', 5],
  ] as const) {
    let calls = 0, sleeps = 0
    const result = await callAnthropicText({ ...model, settings: { ...model.settings, stream: 'false' } }, 'inspect', undefined, {
      fetch: async (_url, init) => {
        calls++
        assert.equal(JSON.parse(String(init?.body)).stream, false)
        return Response.json(body)
      },
      sleep: async () => { sleeps++ },
    })
    assert.equal(result.status, status)
    assert.equal(result.transport.streaming, false)
    assert.equal((result.body as { error: { type: string } }).error.type, type)
    assert.equal(calls, expectedCalls)
    assert.equal(sleeps, expectedCalls - 1)
  }
})

test('bounded transport failure does not multiply retries in storyboard or review', async () => {
  let calls = 0
  await assert.rejects(retryHistoricalText(async () => {
    const result = await callAnthropicText(model, 'outline', undefined, { fetch: async () => { calls++; return new Response('error code: 524\n', { status: 524 }) }, sleep: async () => {} })
    throw new Error(JSON.stringify(result.body))
  }, async () => {}), /MODEL_TRANSPORT_EXHAUSTED/)
  assert.equal(calls, 5)
})

test('principle review does not multiply an exhausted five-attempt upstream transport budget', async () => {
  let calls = 0, reviews = 0
  const reviewed = await runPrincipleReview({ maxAttempts: 20, generate: async () => {
    reviews++
    const result = await callAnthropicText(model, 'review', 'history.review', { fetch: async () => { calls++; return new Response('upstream unavailable', { status: 524 }) }, sleep: async () => {} })
    throw Error(JSON.stringify(result.body))
  }, normalize: value => value })
  assert.equal(calls, 5)
  assert.equal(reviews, 1)
  assert.equal(reviewed.reviewUnavailable, true)
  assert.equal(reviewed.reviewTransport.exhausted, true)
  assert.equal(reviewed.reviewTransport.upstreamExhausted, true)
  assert.match(reviewed.reviewTransport.attempts[0].error!, /MODEL_TRANSPORT_EXHAUSTED/)
  assert.match(reviewed.reviewTransport.attempts[0].error!, /已尝试 5 次/)
})

test('upstream transport may recover on its fifth attempt and all waits are capped at sixty seconds', async () => {
  for (const status of [429, 524]) {
    let calls = 0
    const waits: number[] = [], reports: unknown[] = []
    const result = await callAnthropicText(model, 'same original input', 'history.scene-outline', {
      fetch: async (_url, init) => {
        calls++
        assert.deepEqual(JSON.parse(String(init?.body)).messages, [{ role: 'user', content: 'same original input' }])
        return calls < 5 ? new Response('transient upstream failure', { status, headers: { 'retry-after': '120' } }) : stream()
      },
      sleep: async delay => { waits.push(delay) },
      onAttempt: async attempt => { reports.push(attempt) },
    })
    assert.equal(result.status, 200)
    assert.equal(calls, 5)
    assert.equal(waits.length, 4)
    assert.ok(waits.every(delay => delay <= 60_000))
    assert.equal(Math.max(...waits), 60_000)
    assert.deepEqual(result.transport.attempts.map(attempt => attempt.attempt), Array.from({ length: 5 }, (_, index) => index + 1))
    assert.deepEqual(reports, result.transport.attempts)
  }
})

test('transport exhaustion stops before attempt six with complete diagnostics and bounded backoff', async () => {
  for (const status of [429, 524]) {
    let calls = 0
    const waits: number[] = []
    const result = await callAnthropicText(model, 'same input', 'history.review', {
      fetch: async () => { calls++; return new Response('transient upstream failure', { status }) },
      sleep: async delay => { waits.push(delay) },
    })
    assert.equal(calls, 5)
    assert.equal(result.status, status)
    assert.equal(result.transport.attempts.length, 5)
    assert.equal(waits.length, 4)
    assert.ok(waits.every(delay => delay <= 60_000))
    assert.equal(Math.max(...waits), status === 429 ? 60_000 : 12_000)
    assert.equal((result.body as { error: { type: string; retryExhausted: boolean } }).error.type, 'MODEL_TRANSPORT_EXHAUSTED')
    assert.equal((result.body as { error: { retryExhausted: boolean } }).error.retryExhausted, true)
    assert.match(result.transport.attempts[4].error!, /transient upstream failure/)
  }
})

test('authentication failure is not retried', async () => {
  let calls = 0
  const result = await callAnthropicText(model, 'outline', undefined, { fetch: async () => { calls++; return new Response('invalid key', { status: 401 }) } })
  assert.equal(calls, 1)
  assert.equal(result.status, 401)
})

test('observed RPM limit without Retry-After gets a minute-scale bounded recovery window', async () => {
  const waits: number[] = []
  let calls = 0
  const result = await callAnthropicText(model, 'review', 'history.media-review', {
    fetch: async () => ++calls < 3 ? new Response('All credentials reached the local RPM limit.', { status: 429 }) : stream(),
    sleep: async ms => { waits.push(ms) },
  })
  assert.equal(result.status, 200)
  assert.equal(calls, 3)
  assert.deepEqual(waits, [30_000, 60_000])
})

test('HTTP 200 stream overload is treated as retryable failure', async () => {
  let calls = 0
  const result = await callAnthropicText(model, 'outline', undefined, { fetch: async () => ++calls === 1 ? new Response('event: error\ndata: {"type":"error","error":{"type":"overloaded_error"}}\n\n', { headers: { 'content-type': 'text/event-stream' } }) : stream(), sleep: async () => {} })
  assert.equal(calls, 2)
  assert.equal(result.status, 200)
})

test('token truncation is actionable, never passed as complete JSON', async () => {
  const truncated = events.map(e => e.type === 'message_delta' ? { ...e, delta: { stop_reason: 'max_tokens' } } : e)
  const result = await readAnthropicMessage(stream(truncated))
  assert.equal(result.status, 422)
})

test('gateway error bodies wrapped in HTTP 200 are not successful model answers', async () => {
  assert.equal((await readAnthropicMessage(new Response('error code: 524\n'))).status, 524)
  assert.equal((await readAnthropicMessage(new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error' } })))).status, 529)
  assert.equal((await readAnthropicMessage(new Response(JSON.stringify({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"scenes":[' }] })))).status, 422)
})

test('HTTP 200 HTML pages and empty or non-text JSON are invalid model answers with bounded structural diagnostics', async () => {
  const privateMarker = 'private-fixture-api-key'
  const invalidResponses = [
    new Response(`<html>${privateMarker}${'upstream failure '.repeat(10000)}</html>`, { headers: { 'content-type': 'text/html' } }),
    ...[null, [], {}, { content: [] }, { content: [{ type: 'text', text: '' }] },
      { content: [{ type: 'text', text: ' \r\n\t　' }] }, { content: [{ type: 'text', text: 123 }] },
      { content: [{ type: 'thinking', thinking: privateMarker }] },
      { content: [{ type: 'tool_use', input: { apiKey: privateMarker } }] },
      { content: [null, 'plain block', { text: privateMarker }] },
    ].map(body => Response.json(body)),
  ]
  for (const response of invalidResponses) {
    const result = await readAnthropicMessage(response)
    assert.equal(result.status, 422)
    const body = result.body as { error: { type: string; diagnostics: { streaming: boolean } } }
    assert.equal(body.error.type, 'MODEL_RESPONSE_INVALID')
    assert.equal(body.error.diagnostics.streaming, false)
    const serialized = JSON.stringify(result)
    assert.ok(serialized.length < 1024)
    assert.equal(serialized.includes(privateMarker), false)
    assert.equal(serialized.includes('<html>'), false)
  }
})

test('a completed SSE message still fails when it contains no usable text, including thinking-only and whitespace', async () => {
  for (const blocks of [[], [{ type: 'text', text: '' }], [{ type: 'text', text: ' \r\n\t　' }],
    [{ type: 'thinking', thinking: 'private-fixture-thinking' }], [{ type: 'text', text: 42 }],
  ]) {
    const completed = [
      { type: 'message_start', message: { content: [] } },
      ...blocks.map((content_block, index) => ({ type: 'content_block_start', index, content_block })),
      { type: 'message_stop' },
    ]
    const result = await readAnthropicMessage(stream(completed))
    assert.equal(result.status, 422)
    const body = result.body as { error: { type: string; diagnostics: { streaming: boolean; contentBlockCount: number } } }
    assert.equal(body.error.type, 'MODEL_RESPONSE_INVALID')
    assert.equal(body.error.diagnostics.streaming, true)
    assert.equal(body.error.diagnostics.contentBlockCount, blocks.length)
    assert.equal(JSON.stringify(result).includes('private-fixture-thinking'), false)
  }
})

test('valid text in JSON or completed SSE remains accepted without imposing message metadata on gateways', async () => {
  const content = [{ type: 'thinking', thinking: 'reasoning' }, { type: 'text', text: ' \n' }, { type: 'text', text: '  完整结果。\n' }]
  const jsonBody = { content }
  const jsonResult = await readAnthropicMessage(Response.json(jsonBody))
  assert.equal(jsonResult.status, 200)
  assert.deepEqual(jsonResult.body, jsonBody)
  const sseResult = await readAnthropicMessage(stream([
    { type: 'message_start', message: {} },
    ...content.map((content_block, index) => ({ type: 'content_block_start', index, content_block })),
    { type: 'message_stop' },
  ]))
  assert.equal(sseResult.status, 200)
  assert.deepEqual(sseResult.body, { content })
})

test('truncation and mapped upstream failures retain precedence over missing response text', async () => {
  for (const response of [Response.json({ stop_reason: 'max_tokens', content: [] }), stream([
    { type: 'message_start', message: { content: [] } },
    { type: 'message_delta', delta: { stop_reason: 'max_tokens' } },
    { type: 'message_stop' },
  ])]) {
    const result = await readAnthropicMessage(response)
    assert.equal(result.status, 422)
    assert.equal((result.body as { error: { type: string } }).error.type, 'MODEL_OUTPUT_TRUNCATED')
  }
  for (const [type, status] of [['authentication_error', 401], ['invalid_request_error', 400], ['rate_limit_error', 429], ['overloaded_error', 529]] as const) {
    const body = { type: 'error', error: { type }, content: [] }
    assert.deepEqual(await readAnthropicMessage(Response.json(body)), { status, body })
  }
  assert.deepEqual(await readAnthropicMessage(new Response('error code: 524\n')), { status: 524, body: 'error code: 524\n' })
  assert.deepEqual(await readAnthropicMessage(new Response('invalid key', { status: 401 })), { status: 401, body: 'invalid key' })
})

test('invalid completed responses fail the text call once and never log echoed credentials or a gateway page', async () => {
  let calls = 0, sleeps = 0
  const reports: unknown[] = []
  const result = await callAnthropicText(model, 'review', 'history.review', {
    fetch: async () => { calls++; return new Response('<html>private-fixture-key: gateway unavailable</html>') },
    sleep: async () => { sleeps++ },
    onAttempt: async attempt => { reports.push(attempt) },
  })
  assert.equal(result.status, 422)
  assert.equal((result.body as { error: { type: string } }).error.type, 'MODEL_RESPONSE_INVALID')
  assert.equal(calls, 1)
  assert.equal(sleeps, 0)
  assert.equal(result.transport.attempts.length, 1)
  assert.deepEqual(reports, result.transport.attempts)
  assert.equal(JSON.stringify({ result, reports }).includes('private-fixture-key'), false)
})

test('review sampling is stable while writer sampling and explicit zero are respected', async () => {
  for (const [operation, configured, expected] of [['history.review', '0.7', 0], ['history.media-review', '0.7', 0], ['history.scene-outline', '0.7', 0.7], ['history.scene-outline', '0', 0]] as const) {
    await callAnthropicText({ ...model, settings: { ...model.settings, temperature: configured } }, 'test', operation, {
      fetch: async (_url, init) => { assert.equal(JSON.parse(String(init?.body)).temperature, expected); return stream() },
    })
  }
})

test('the observed socket hang up and nested transport codes retry instead of becoming HTTP 422', async () => {
  for (const failure of [new Error('socket hang up'), new Error('connection failed', { cause: { code: 'ECONNRESET' } }), new Error('Premature close')]) {
    let attempts = 0
    const result = await callAnthropicText(model, 'test', 'history.review', { fetch: async () => { if (!attempts++) throw failure; return stream() }, sleep: async () => {} })
    assert.equal(result.status, 200)
    assert.equal(attempts, 2)
  }
})
