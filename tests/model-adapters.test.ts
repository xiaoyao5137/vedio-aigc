import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildKlingImageRequest,
  buildKlingVideoRequest,
  buildOpenAiImageRequest,
  callKlingImage,
  callOpenAiImage,
  createKlingToken,
  klingAuthorization,
  resolveKlingOmniVideoEndpoint,
  resolveKlingVideoEndpoint,
} from '../server/model-adapters.ts'

const qwenModel = {
  id: 'qwen-image-3-pro',
  provider: 'Ofox',
  capability: 'image',
  settings: {
    endpoint: 'https://api.ofox.ai/v1/images/generations',
    apiKey: 'shared-image-key',
    model: 'bailian/qwen-image-3.0-pro:free',
    size: '1024x1024',
    quality: 'high',
    outputFormat: 'png',
    n: '1',
  },
}

const klingImageModel = {
  id: 'kling-image-3',
  provider: 'Kling',
  capability: 'image',
  settings: {
    endpoint: 'https://api-beijing.klingai.com/v1/images/generations',
    apiKey: 'shared-kling-key',
    model: 'kling-v3',
    resolution: '1k',
    aspectRatio: '9:16',
    n: '1',
    pollIntervalMs: '100',
    taskTimeoutMs: '100',
  },
}

test('Qwen request uses Ofox model, input_images, and shared Bearer key', async () => {
  const requestBody = buildOpenAiImageRequest(qwenModel, '保持人物一致', {
    referenceImages: [{ url: 'https://example.com/one.png' }, { dataUrl: 'data:image/png;base64,aGVsbG8=' }],
  })
  assert.equal(requestBody.model, 'bailian/qwen-image-3.0-pro:free')
  assert.deepEqual(requestBody.input_images, ['https://example.com/one.png', 'aGVsbG8='])

  let sentBody: Record<string, unknown> | undefined
  const result = await callOpenAiImage(qwenModel, '保持人物一致', { referenceImage: 'https://example.com/one.png' }, async (_input, init) => {
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer shared-image-key')
    sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    return new Response(JSON.stringify({ data: [{ b64_json: 'aGVsbG8=', index: 0 }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  })
  assert.deepEqual(sentBody?.input_images, ['https://example.com/one.png'])
  assert.equal(result.status, 200)
  assert.equal((result.body as { data: Array<{ url: string }> }).data[0].url, 'data:image/png;base64,aGVsbG8=')
})

test('Kling Image 3 request follows the official kling-v3 image schema', () => {
  const request = buildKlingImageRequest(klingImageModel, '电影感人物肖像', {
    referenceImage: 'data:image/jpeg;base64,cmVmZXJlbmNl',
    negativePrompt: '不会随图生图请求发送',
    aspectRatio: '3:4',
  })
  assert.deepEqual(request, {
    model_name: 'kling-v3',
    prompt: '电影感人物肖像',
    resolution: '1k',
    n: 1,
    aspect_ratio: '3:4',
    image: 'cmVmZXJlbmNl',
  })
})

test('Kling image-to-video request uses only provider-standard fields and native sound', () => {
  const request = buildKlingVideoRequest({
    ...klingImageModel,
    id: 'keling3',
    capability: 'video',
    settings: { ...klingImageModel.settings, model: 'kling-v3', mode: 'pro', duration: '5' },
  }, '人物转身并说出对白，环境中有风声', {
    referenceImage: 'data:image/png;base64,aGVsbG8=',
    duration: 10,
    mode: 'pro',
    sound: 'on',
    negativePrompt: '人物变形、画面闪烁',
    title: '不应透传的镜头标题',
    camera: '不应作为独立参数透传',
  })
  assert.deepEqual(request, {
    model_name: 'kling-v3',
    prompt: '人物转身并说出对白，环境中有风声',
    duration: '10',
    mode: 'pro',
    sound: 'on',
    negative_prompt: '人物变形、画面闪烁',
    image: 'aGVsbG8=',
  })
})

test('Kling reference attachments use the Omni endpoint, image list, and prompt references', () => {
  const request = buildKlingVideoRequest({
    ...klingImageModel,
    id: 'keling3',
    capability: 'video',
    settings: { endpoint: 'https://api-singapore.klingai.com/v1/videos', apiKey: 'key', model: 'kling-v3' },
  }, '@参考附件1 站在 @参考附件2 的场景中', {
    referenceImages: ['data:image/png;base64,cGVyc29u', 'https://example.com/scene.png'],
    referenceImage: 'data:image/png;base64,c3RhcnQ=',
    endImage: 'data:image/png;base64,ZW5k',
    duration: 8,
  })
  assert.equal(request.model_name, 'kling-v3-omni')
  assert.equal(request.prompt, '<<<image_1>>> 站在 <<<image_2>>> 的场景中')
  assert.deepEqual(request.image_list, [
    { image_url: 'cGVyc29u' },
    { image_url: 'https://example.com/scene.png' },
    { image_url: 'c3RhcnQ=', type: 'first_frame' },
    { image_url: 'ZW5k', type: 'end_frame' },
  ])
  assert.equal('image' in request, false)
  assert.equal(resolveKlingOmniVideoEndpoint('https://api-singapore.klingai.com/v1/videos'), 'https://api-singapore.klingai.com/v1/videos/omni-video')
  assert.equal(resolveKlingOmniVideoEndpoint('https://api-singapore.klingai.com/v1/videos/image2video'), 'https://api-singapore.klingai.com/v1/videos/omni-video')
})

test('Kling Video 3 request forwards experience-level advanced controls with provider field names', () => {
  const request = buildKlingVideoRequest({
    ...klingImageModel,
    id: 'keling3',
    capability: 'video',
    settings: { endpoint: 'https://api-singapore.klingai.com/v1/videos', apiKey: 'key', model: 'kling-v3' },
  }, '多镜头追逐场景', {
    referenceImage: 'data:image/png;base64,c3RhcnQ=',
    endImage: 'data:image/png;base64,ZW5k',
    duration: 15,
    mode: 'pro',
    sound: 'on',
    cfgScale: 0.7,
    multiShot: true,
    shotType: 'customize',
    multiPrompt: [
      { index: 1, prompt: '远景建立环境', duration: 5 },
      { index: 2, prompt: '近景追随人物', duration: 10 },
    ],
    cameraControl: { type: 'simple', config: { zoom: 2 } },
    staticMask: 'data:image/png;base64,bWFzaw==',
    dynamicMasks: [{ mask: 'mask-1', trajectories: [{ x: 20, y: 30 }] }],
    callbackUrl: 'https://example.com/callback',
    externalTaskId: 'scene-001',
  })
  assert.deepEqual(request, {
    model_name: 'kling-v3',
    prompt: '多镜头追逐场景',
    duration: '15',
    mode: 'pro',
    sound: 'on',
    cfg_scale: 0.7,
    image: 'c3RhcnQ=',
    image_tail: 'ZW5k',
    static_mask: 'bWFzaw==',
    dynamic_masks: [{ mask: 'mask-1', trajectories: [{ x: 20, y: 30 }] }],
    multi_shot: true,
    shot_type: 'customize',
    multi_prompt: [
      { index: 1, prompt: '远景建立环境', duration: 5 },
      { index: 2, prompt: '近景追随人物', duration: 10 },
    ],
    camera_control: { type: 'simple', config: { zoom: 2 } },
    callback_url: 'https://example.com/callback',
    external_task_id: 'scene-001',
  })
})

test('Kling Video 3 text-to-video keeps aspect ratio and clamps duration to the supported range', () => {
  const request = buildKlingVideoRequest({
    ...klingImageModel,
    id: 'keling3',
    capability: 'video',
    settings: { endpoint: 'https://api-singapore.klingai.com/v1/videos', apiKey: 'key', model: 'kling-v3' },
  }, '城市延时摄影', { duration: 20, aspectRatio: '1:1', multiShot: false })
  assert.equal(request.duration, '15')
  assert.equal(request.aspect_ratio, '1:1')
  assert.equal(request.multi_shot, false)
  assert.equal('image_tail' in request, false)
})

test('Kling Video 3 fills provider-required fields when optional experience inputs are blank', () => {
  const request = buildKlingVideoRequest({
    ...klingImageModel,
    id: 'keling3',
    capability: 'video',
    settings: { endpoint: 'https://api-singapore.klingai.com/v1/videos', apiKey: 'key' },
  }, '', {})
  assert.equal(request.model_name, 'kling-v3')
  assert.equal(request.prompt, '让画面自然运动。')
  assert.equal(request.duration, '5')
  assert.equal(request.mode, 'std')
})

test('Kling video endpoint switches between text and image routes even when a concrete route is saved', () => {
  assert.equal(resolveKlingVideoEndpoint('https://api.example.com/v1/videos/image2video', false), 'https://api.example.com/v1/videos/text2video')
  assert.equal(resolveKlingVideoEndpoint('https://api.example.com/v1/videos/text2video', true), 'https://api.example.com/v1/videos/image2video')
  assert.equal(resolveKlingVideoEndpoint('https://api.example.com/v1/videos/', false), 'https://api.example.com/v1/videos/text2video')
})

test('Kling Image 3 adapter creates and polls a task until image URLs are ready', async () => {
  const requests: Array<{ url: string; method: string }> = []
  const responses = [
    { code: 0, data: { task_id: 'task-123', task_status: 'submitted' } },
    { code: 0, data: { task_id: 'task-123', task_status: 'succeed', task_result: { images: [{ index: 0, url: 'https://example.com/result.png' }] } } },
  ]
  const result = await callKlingImage(klingImageModel, '电影感人物肖像', {}, {
    fetch: async (input, init) => {
      requests.push({ url: String(input), method: String(init?.method) })
      const body = responses.shift()
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    },
    sleep: async (milliseconds) => assert.equal(milliseconds, 100),
  })
  assert.equal(result.status, 200)
  assert.deepEqual(requests, [
    { url: 'https://api-beijing.klingai.com/v1/images/generations', method: 'POST' },
    { url: 'https://api-beijing.klingai.com/v1/images/generations/task-123', method: 'GET' },
  ])
  assert.equal((result.body as { data: { task_result: { images: Array<{ url: string }> } } }).data.task_result.images[0].url, 'https://example.com/result.png')
})

test('Kling authentication supports the new API key and legacy JWT credentials', () => {
  assert.equal(klingAuthorization({ apiKey: 'new-key' }), 'Bearer new-key')
  const token = createKlingToken('access', 'secret', 1_700_000_000_000)
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as Record<string, unknown>
  assert.deepEqual(payload, { iss: 'access', exp: 1_700_001_800, nbf: 1_699_999_995 })
  assert.equal(klingAuthorization({ accessKey: 'access', secretKey: 'secret' }), `Bearer ${createKlingToken('access', 'secret')}`)
})
