import test from 'node:test'
import assert from 'node:assert/strict'
import { callAnthropicText } from '../server/anthropic-text.ts'
import { mapNodeInputs, MapInputItemError } from '../src/node-map.ts'

test('serial observation stops at the failed frame after five transient failures without multiplying transport retries', async () => {
  const model = { id: 'vision', provider: 'Custom', capability: 'text', settings: {
    apiKey: 'fixture', endpoint: 'https://example.test/messages', model: 'vision', stream: 'false',
  } }
  const submitted: number[] = []
  const statuses = Array.from({ length: 5 }, (_, index) => index % 3 === 1 && index < 4 ? 524 : 503)
  let calls = 0
  const waits: number[] = []
  const original = { media_metrics: { frames: [{ index: 0 }, { index: 1 }] } }
  await assert.rejects(mapNodeInputs({ sourcePath: 'media_metrics.frames', itemVar: 'frame', concurrency: 1 }, original, async (context, index) => {
    submitted.push(index)
    const result = await callAnthropicText(model, JSON.stringify(context.frame), undefined, {
      fetch: async (_url, init) => {
        assert.equal(JSON.parse(String(init?.body)).stream, false)
        assert.ok(calls < 5, 'observation cannot submit a sixth request after transport exhaustion')
        const status = statuses[calls++]
        return status === 524 ? new Response('error code: 524\n', { status })
          : Response.json({ error: { type: '<nil>', message: '模型过载，请稍后重试' }, type: 'error' }, { status })
      }, sleep: async ms => { waits.push(ms) },
    })
    assert.deepEqual(result.transport.attempts.map(item => item.status), statuses)
    if (result.status >= 400) throw new Error(`HTTP ${result.status}: ${JSON.stringify(result.body)}`)
    return result.body
  }), error => {
    assert.ok(error instanceof MapInputItemError)
    assert.equal(error.itemIndex, 0)
    assert.equal(error.sourcePath, 'media_metrics.frames')
    assert.match(error.message, /^MAP_ITEM_FAILED: media_metrics.frames\[0\].*HTTP 503:/)
    assert.match(error.message, /"type":"MODEL_TRANSPORT_EXHAUSTED"/)
    assert.match(error.message, /"retryExhausted":true/)
    return true
  })
  assert.equal(calls, 5)
  assert.equal(waits.length, 4)
  assert.ok(waits.every(ms => ms <= 60_000))
  assert.deepEqual(submitted, [0])
  assert.deepEqual(original, { media_metrics: { frames: [{ index: 0 }, { index: 1 }] } })
})
