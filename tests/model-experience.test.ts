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
