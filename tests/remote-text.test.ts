import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { callRemoteText, supportsRemoteText } from '../server/remote-text.ts'
import type { ExternalModelConfig } from '../server/model-adapters.ts'
import { loadReviewImages, reviewImageContentBlocks, reviewImagesFingerprint } from '../server/review-images.ts'

const model: ExternalModelConfig = {
  id: 'saved-gateway-model', provider: 'OpenAI', capability: 'text',
  settings: { endpoint: 'https://gateway.test/v1/messages', apiKey: 'fixture-key', model: 'selected-model-exact', apiProtocol: 'anthropic-messages' },
}

const answer = { id: 'msg-fixture', type: 'message', stop_reason: 'end_turn', content: [{ type: 'text', text: '{"passed":true}' }] }
function streamAnswer() {
  const events = [
    { type: 'message_start', message: { ...answer, content: [] } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: answer.content[0].text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ]
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
}

async function imageFixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'remote-text-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  await mkdir(path.join(root, 'public', 'generated'), { recursive: true })
  const urls: string[] = []
  for (const [index, background] of ['#ab1133', '#2277ee', '#33cc55'].entries()) {
    const url = `/generated/frame-${index}.jpg`
    const bytes = await sharp({ create: { width: 12, height: 8, channels: 3, background } }).jpeg().toBuffer()
    await writeFile(path.join(root, 'public', url), bytes)
    urls.push(url)
  }
  return { root, urls }
}

test('protocol selection uses declared settings and provider, never model-name or endpoint guessing', () => {
  assert.equal(supportsRemoteText({ ...model, provider: 'Anthropic', settings: { ...model.settings, apiProtocol: '' } }), true)
  for (const provider of ['Anthropic', 'OpenAI', 'Custom']) assert.equal(supportsRemoteText({ ...model, provider }), true)
  for (const provider of ['OpenAI', 'Custom']) {
    for (const selectedModel of ['gpt-5.6-sol', 'claude-sonnet-4-6', 'anything']) {
      const settings = { endpoint: model.settings.endpoint, model: selectedModel }
      assert.equal(supportsRemoteText({ ...model, provider, settings }), false)
    }
  }
  for (const provider of ['Codex', 'Ollama', 'unknown']) assert.equal(supportsRemoteText({ ...model, provider }), false)
  for (const capability of ['image', 'video']) assert.equal(supportsRemoteText({ ...model, capability }), false)
  assert.equal(supportsRemoteText({ ...model, settings: { ...model.settings, apiProtocol: 'unknown-protocol' } }), false)
})

test('Anthropic defaults preserve plain-text requests; explicit gateway protocols use the exact selected model', async () => {
  for (const provider of ['Anthropic', 'OpenAI', 'Custom']) {
    const settings = { ...model.settings }
    if (provider === 'Anthropic') delete settings.apiProtocol
    const configured = Object.freeze({ ...model, provider, settings: Object.freeze(settings) })
    const params = Object.freeze({ maxTokens: '2048', temperature: 0 })
    let calls = 0
    const result = await callRemoteText(configured, 'Check the supplied requirement.', params, undefined, undefined, {
      fetch: async (url, init) => {
        calls++
        assert.equal(url, configured.settings.endpoint)
        assert.deepEqual(JSON.parse(String(init?.body)), { model: 'selected-model-exact', stream: true, max_tokens: 2048, temperature: 0,
          messages: [{ role: 'user', content: 'Check the supplied requirement.' }] })
        const headers = new Headers(init?.headers)
        assert.equal(headers.get('x-api-key'), 'fixture-key')
        assert.equal(headers.get('anthropic-version'), '2023-06-01')
        assert.equal(headers.get('accept'), 'text/event-stream')
        return streamAnswer()
      },
    })
    assert.equal(calls, 1)
    assert.equal(result.status, 200)
    assert.deepEqual((result.body as { content: unknown }).content, answer.content)
    assert.equal(result.transport.streaming, true)
    assert.deepEqual(params, { maxTokens: '2048', temperature: 0 })
    assert.equal(configured.settings.maxTokens, undefined)
  }
})

test('local original frames and detail labels reach Messages in their exact order without dropping any attachment', async t => {
  const { root, urls } = await imageFixture(t)
  const params = { reviewImages: [urls[2], urls[0], urls[1]], reviewImageDetail: { indices: [1], columns: 2, rows: 1, overlap: 0.25 },
    maxTokens: 4096, temperature: 0 }
  const before = structuredClone(params)
  const expected = await loadReviewImages(params.reviewImages, root, params.reviewImageDetail)
  let calls = 0
  const result = await callRemoteText(model, 'Inspect all original and detail evidence.', params, 'quality.requirement-review', undefined, {
    root,
    fetch: async (_url, init) => {
      calls++
      const body = JSON.parse(String(init?.body))
      assert.equal(body.model, model.settings.model)
      assert.equal(body.max_tokens, 4096)
      assert.equal(body.temperature, 0)
      assert.deepEqual(body.messages[0].content, [...reviewImageContentBlocks(expected), { type: 'text', text: 'Inspect all original and detail evidence.' }])
      assert.equal(body.messages[0].content.filter((block: { type: string }) => block.type === 'image').length, 5)
      return streamAnswer()
    },
  })
  assert.equal(calls, 1)
  assert.equal(result.status, 200)
  assert.deepEqual(params, before)
})

test('workflow snapshots transmit the already-fingerprinted PNG sequence evidence even after source files disappear', async t => {
  const { root, urls } = await imageFixture(t)
  const params = { reviewImages: urls, reviewImageDetail: { transport: { mode: 'sequence-grid', columns: 2, rows: 2 },
    frameMetadata: urls.map((url, index) => ({ url, evidenceIndex: 7 + index, nativeFrameIndex: 30 + index, time: index / 10 })) } }
  const frames = Object.freeze((await loadReviewImages(urls, root, params.reviewImageDetail)).map(frame => Object.freeze(frame)))
  const fingerprint = reviewImagesFingerprint('already-hashed', frames)
  await rm(path.join(root, 'public', 'generated'), { recursive: true })
  let calls = 0
  const result = await callRemoteText(model, 'Review the exact captured sequence.', params, 'history.media-review', frames, {
    root,
    fetch: async (_url, init) => {
      calls++
      const body = JSON.parse(String(init?.body))
      assert.deepEqual(body.messages[0].content, [...reviewImageContentBlocks(frames), { type: 'text', text: 'Review the exact captured sequence.' }])
      assert.equal(body.messages[0].content[1].source.media_type, 'image/png')
      assert.equal(body.messages[0].content[1].source.data, frames[0].bytes.toString('base64'))
      assert.match(body.messages[0].content[0].text, /evidenceIndex.*nativeFrameIndex/)
      assert.equal(body.max_tokens, 8192)
      assert.equal(body.temperature, 0)
      // Some Messages gateways return normal JSON even when stream is requested.
      return Response.json(answer)
    },
  })
  assert.equal(calls, 1)
  assert.equal(result.status, 200)
  assert.deepEqual(result.body, answer)
  assert.equal(reviewImagesFingerprint('already-hashed', frames), fingerprint)
})

test('unsupported or absent protocols fail explicitly before loading images or any remote side effect', async () => {
  const unsupported = [
    { ...model, settings: { ...model.settings, apiProtocol: 'openai-responses' } },
    { ...model, settings: { ...model.settings, apiProtocol: '' } },
    { ...model, provider: 'Anthropic', settings: { ...model.settings, apiProtocol: 'unknown' } },
    { ...model, provider: 'Codex' },
    { ...model, capability: 'image' },
  ]
  for (const configured of unsupported) {
    let sideEffects = 0
    await assert.rejects(callRemoteText(configured, 'Review.', { reviewImages: ['/generated/does-not-exist.jpg'] }, undefined, undefined, {
      fetch: async () => { sideEffects++; return streamAnswer() },
      sleep: async () => { sideEffects++ },
      onAttempt: async () => { sideEffects++ },
    }), /REMOTE_TEXT_PROTOCOL_UNSUPPORTED/)
    assert.equal(sideEffects, 0)
  }
})

test('invalid sampling or output settings fail before loading images or transport', async () => {
  for (const params of [{ maxTokens: 0 }, { maxTokens: 2.5 }, { maxTokens: null }, { temperature: 1.1 }, { temperature: '' }]) {
    let calls = 0
    await assert.rejects(callRemoteText(model, 'Review.', { ...params, reviewImages: ['/generated/does-not-exist.jpg'] }, undefined, undefined, {
      fetch: async () => { calls++; return streamAnswer() },
    }), /ANTHROPIC_CONFIG_INVALID/)
    assert.equal(calls, 0)
  }
})

test('invalid image input and empty supplied snapshots never become text-only remote calls', async t => {
  const { root, urls } = await imageFixture(t)
  for (const reviewImages of ['not-an-array', ['https://example.test/frame.jpg'], [...urls, '/generated/missing.jpg']]) {
    let calls = 0
    await assert.rejects(callRemoteText(model, 'Review.', { reviewImages }, undefined, undefined, {
      root, fetch: async () => { calls++; return streamAnswer() },
    }), /REVIEW_IMAGES_INVALID|ENOENT/)
    assert.equal(calls, 0)
  }
  let calls = 0
  await assert.rejects(callRemoteText(model, 'Review.', { reviewImages: urls }, undefined, [], {
    root, fetch: async () => { calls++; return streamAnswer() },
  }), /REVIEW_IMAGES_INVALID:.*快照为空/)
  assert.equal(calls, 0)
})
