import test from 'node:test'
import assert from 'node:assert/strict'
import { modelExperienceFields, parseModelExperienceParams, restoreModelExperienceRequest } from '../src/model-experience.ts'

const klingVideoModel = {
  provider: 'Kling',
  capability: 'video',
  settings: { model: 'kling-v3', endpoint: 'https://api-singapore.klingai.com/v1/videos' },
}

test('Kling Video 3 experience exposes per-call generation and advanced controls', () => {
  const fields = modelExperienceFields(klingVideoModel)
  assert.deepEqual(fields.map((field) => field.key), [
    'referenceImage',
    'endImage',
    'referenceImages',
    'duration',
    'aspectRatio',
    'mode',
    'sound',
    'negativePrompt',
    'cfgScale',
    'multiShot',
    'shotType',
    'multiPrompt',
    'cameraControl',
    'staticMask',
    'dynamicMasks',
    'callbackUrl',
    'externalTaskId',
  ])
  assert.equal(fields.find((field) => field.key === 'duration')?.group, 'generation')
  assert.equal(fields.find((field) => field.key === 'aspectRatio')?.group, 'generation')
  assert.equal(fields.find((field) => field.key === 'aspectRatio')?.defaultValue, '16:9')
  assert.equal(fields.find((field) => field.key === 'referenceImage')?.control, 'image')
  assert.equal(fields.find((field) => field.key === 'endImage')?.control, 'image')
  assert.equal(fields.find((field) => field.key === 'referenceImages')?.control, 'images')
  assert.equal(fields.every((field) => field.required === false), true)
})

test('experience values are converted to request types and JSON is validated', () => {
  const params = parseModelExperienceParams(klingVideoModel, {
    duration: '12',
    cfgScale: '0.8',
    multiShot: true,
    shotType: 'customize',
    multiPrompt: '[{"index":1,"prompt":"建立镜头","duration":5}]',
    referenceImages: ['data:image/png;base64,b25l', 'data:image/png;base64,dHdv'],
  })
  assert.equal(params.duration, 12)
  assert.equal(params.cfgScale, 0.8)
  assert.equal(params.multiShot, true)
  assert.deepEqual(params.multiPrompt, [{ index: 1, prompt: '建立镜头', duration: 5 }])
  assert.deepEqual(params.referenceImages, ['data:image/png;base64,b25l', 'data:image/png;base64,dHdv'])
  assert.throws(() => parseModelExperienceParams(klingVideoModel, { multiPrompt: '[' }), /自定义分镜必须是有效 JSON/)
  assert.throws(() => parseModelExperienceParams(klingVideoModel, { duration: '16' }), /时长（秒）不能大于 15/)
})

test('static model settings only seed legacy defaults and remain separate from parsed call params', () => {
  const params = parseModelExperienceParams({
    ...klingVideoModel,
    settings: { ...klingVideoModel.settings, duration: '10', aspectRatio: '16:9', apiKey: 'secret-key' },
  })
  assert.equal(params.duration, 10)
  assert.equal(params.aspectRatio, '16:9')
  assert.equal('apiKey' in params, false)
  assert.equal('endpoint' in params, false)
})

test('inactive Kling controls are omitted from the per-call payload', () => {
  const textToVideo = parseModelExperienceParams(klingVideoModel, {
    referenceImage: '',
    endImage: 'https://example.com/end.png',
    multiShot: false,
    shotType: 'customize',
    multiPrompt: '[{"index":1,"prompt":"不会发送","duration":3}]',
  })
  assert.equal('endImage' in textToVideo, false)
  assert.equal('shotType' in textToVideo, false)
  assert.equal('multiPrompt' in textToVideo, false)
  assert.equal(textToVideo.aspectRatio, '16:9')
})

test('execution request restores prompt and typed experience controls', () => {
  const restored = restoreModelExperienceRequest(klingVideoModel, {
    prompt: '让人物转身看向城门',
    params: {
      duration: 10,
      cfgScale: 0.7,
      multiShot: true,
      shotType: 'customize',
      multiPrompt: [{ index: 1, prompt: '推近人物', duration: 5 }],
      referenceImages: ['https://example.com/one.png'],
    },
  })
  assert.equal(restored.prompt, '让人物转身看向城门')
  assert.equal(restored.values.duration, '10')
  assert.equal(restored.values.cfgScale, '0.7')
  assert.equal(restored.values.multiShot, true)
  assert.equal(restored.values.multiPrompt, '[\n  {\n    "index": 1,\n    "prompt": "推近人物",\n    "duration": 5\n  }\n]')
  assert.deepEqual(restored.values.referenceImages, ['https://example.com/one.png'])
})

test('execution request reports sanitized media that must be uploaded again', () => {
  const restored = restoreModelExperienceRequest(klingVideoModel, {
    params: {
      referenceImage: '[内容已隐藏，12000 字符]',
      referenceImages: ['[内容已隐藏，18000 字符]'],
      duration: 5,
    },
  })
  assert.deepEqual(restored.values, { duration: '5' })
  assert.deepEqual(restored.omittedFields, ['首帧参考图', '参考附件'])
})

test('remote Messages text experience exposes review frames and sampling controls only for supported protocols', () => {
  for (const provider of ['Anthropic', 'OpenAI', 'Custom']) {
    const model = { provider, capability: 'text', settings: { apiProtocol: 'anthropic-messages', maxTokens: '2048', temperature: '0' } }
    const fields = modelExperienceFields(model)
    assert.deepEqual(fields.map(field => field.key), ['reviewImages', 'reviewImageDetail', 'maxTokens', 'temperature', 'stream'])
    assert.equal(fields.find(field => field.key === 'reviewImages')?.control, 'json')
    assert.equal(fields.find(field => field.key === 'reviewImageDetail')?.control, 'json')
    assert.ok(fields.every(field => field.required === false && !['image', 'images'].includes(field.control)))
    assert.deepEqual(parseModelExperienceParams(model), { reviewImages: [], maxTokens: 2048, temperature: 0 })
    for (const capability of ['image', 'video', 'audio']) {
      assert.ok(modelExperienceFields({ ...model, capability }).every(field => !['reviewImages', 'reviewImageDetail'].includes(field.key)))
    }
  }
  assert.deepEqual(parseModelExperienceParams({ provider: 'Anthropic', capability: 'text', settings: {} }), {
    reviewImages: [], maxTokens: 4096, temperature: 0.3,
  })
  for (const provider of ['OpenAI', 'Custom']) {
    for (const apiProtocol of ['', 'responses', 'chat-completions']) {
      assert.deepEqual(modelExperienceFields({ provider, capability: 'text', settings: { apiProtocol } }), [])
    }
  }
})

test('remote Messages stream override inherits settings by omission and restores false as a valid select value', () => {
  for (const provider of ['Anthropic', 'OpenAI', 'Custom']) {
    for (const configuredStream of ['', 'true', 'false']) {
      const model = { provider, capability: 'text', settings: { apiProtocol: 'anthropic-messages', stream: configuredStream } }
      const original = structuredClone(model)
      const field = modelExperienceFields(model).find(item => item.key === 'stream')!
      assert.equal(field.control, 'select')
      assert.equal(field.defaultValue, '')
      assert.deepEqual(field.options?.map(item => item.value), ['', 'true', 'false'])
      assert.equal(field.options?.[0].label, '沿用模型配置')
      assert.equal(Object.hasOwn(parseModelExperienceParams(model), 'stream'), false)
      assert.equal(Object.hasOwn(parseModelExperienceParams(model, { stream: '' }), 'stream'), false)
      for (const stream of [true, false, 'true', 'false']) {
        const request = { prompt: '检查本次响应。', params: { stream } }
        const restored = restoreModelExperienceRequest(model, request)
        assert.equal(restored.values.stream, String(stream))
        assert.deepEqual(restored.omittedFields, [])
        assert.equal(parseModelExperienceParams(model, restored.values).stream, String(stream))
      }
      assert.deepEqual(model, original)
    }
  }
})

test('remote Messages review replay retains every frame, detail mapping and per-call override without mutating configuration', () => {
  const reviewImages = Array.from({ length: 56 }, (_, index) => `/generated/frame-${index}.jpg`)
  const sequenceImages = Array.from({ length: 160 }, (_, index) => `/generated/sequence-${index}.jpg`)
  const imageRequests = [
    { reviewImages, reviewImageDetail: { indices: [0, 55], columns: 2, rows: 2, overlap: 0.1 } },
    { reviewImages: sequenceImages, reviewImageDetail: {
      transport: { mode: 'sequence-grid', columns: 2, rows: 2, format: 'png' },
      frameMetadata: sequenceImages.map((url, evidenceIndex) => ({ url, evidenceIndex, time: evidenceIndex / 30 })),
    } },
  ]
  for (const provider of ['Anthropic', 'OpenAI', 'Custom']) {
    const model = { provider, capability: 'text', settings: { apiProtocol: 'anthropic-messages', maxTokens: '2048', temperature: '0.7' } }
    const original = structuredClone(model)
    for (const images of imageRequests) {
      const request = { prompt: '按实际帧顺序审核完整画面。', params: { ...images, maxTokens: 8192, temperature: 0 } }
      const restored = restoreModelExperienceRequest(model, request)
      assert.equal(restored.prompt, request.prompt)
      assert.deepEqual(restored.omittedFields, [])
      assert.deepEqual(parseModelExperienceParams(model, restored.values), request.params)
    }
    assert.deepEqual(model, original)
    assert.deepEqual(parseModelExperienceParams(model), { reviewImages: [], maxTokens: 2048, temperature: 0.7 })
    assert.throws(() => parseModelExperienceParams(model, { reviewImages: '[' }), /审核原帧必须是有效 JSON/)
    assert.throws(() => parseModelExperienceParams(model, { reviewImageDetail: '{' }), /原帧局部细节必须是有效 JSON/)
    assert.throws(() => parseModelExperienceParams(model, { maxTokens: '0' }), /最大输出 Token不能小于 1/)
    assert.throws(() => parseModelExperienceParams(model, { temperature: '1.1' }), /随机性不能大于 1/)
  }
})

test('Codex text experience exposes local review JSON and per-call controls without uploaders or credentials', () => {
  const model = { provider: 'Codex', capability: 'text', settings: { model: 'configured-model', executablePath: '/local/bin/codex', apiKey: 'unrelated-old-setting', endpoint: 'https://unused.test' } }
  const fields = modelExperienceFields(model)
  assert.deepEqual(fields.map(field => field.key), ['reviewImages', 'reviewImageDetail', 'reasoningEffort', 'timeoutMs'])
  assert.equal(fields.find(field => field.key === 'reviewImages')?.control, 'json')
  assert.equal(fields.find(field => field.key === 'reviewImageDetail')?.control, 'json')
  assert.ok(fields.every(field => !['image', 'images'].includes(field.control)), '本地原帧不走七张 dataURL 上传器')
  assert.deepEqual(fields.find(field => field.key === 'reasoningEffort')?.options?.map(item => item.value), ['', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
  assert.deepEqual(parseModelExperienceParams(model), { reviewImages: [], timeoutMs: 180000 })
  for (const capability of ['image', 'video', 'audio']) assert.deepEqual(modelExperienceFields({ ...model, capability }), [])
})

test('Codex review requests preserve complete local-frame arrays and detail configuration across replay', () => {
  const model = { provider: 'Codex', capability: 'text', settings: { reasoningEffort: 'high', timeoutMs: '240000' } }
  const original = structuredClone(model), reviewImages = Array.from({ length: 15 }, (_, index) => '/generated/frame-' + index + '.jpg')
  const reviewImageDetail = { indices: [0, 14], columns: 2, rows: 2, overlap: .1 }
  const request = { prompt: '逐项检查实际帧与原要求。', params: { reviewImages, reviewImageDetail, reasoningEffort: 'xhigh', timeoutMs: 300000 } }
  const restored = restoreModelExperienceRequest(model, request)
  assert.equal(restored.prompt, request.prompt);assert.deepEqual(restored.omittedFields, [])
  assert.deepEqual(parseModelExperienceParams(model, restored.values), request.params, '还原和重发不截断帧数组或丢失局部配置')
  assert.deepEqual(parseModelExperienceParams(model), { reviewImages: [], reasoningEffort: 'high', timeoutMs: 240000 })
  assert.deepEqual(model, original, '体验覆盖不修改模型配置')
  assert.throws(() => parseModelExperienceParams(model, { reviewImages: '[' }), /审核原帧必须是有效 JSON/)
  assert.throws(() => parseModelExperienceParams(model, { reviewImageDetail: '{' }), /原帧局部细节必须是有效 JSON/)
  assert.throws(() => parseModelExperienceParams(model, { timeoutMs: '0' }), /调用超时（ms）不能小于 1/)
  assert.throws(() => parseModelExperienceParams(model, { timeoutMs: '3600001' }), /调用超时（ms）不能大于 3600000/)
})
