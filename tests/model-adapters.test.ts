import test from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import {
  buildKlingImageRequest,
  buildKlingVideoRequest,
  buildOpenAiImageRequest,
  callKlingImage,
  callKlingVideo,
  callOpenAiImage,
  createKlingToken,
  imageSizeToAspectRatio,
  klingAuthorization,
  klingIdentityReferencePrompt,
  klingThreeViewVideoPrompt,
  KLING_PROMPT_MAX_LENGTH,
  limitKlingPrompt,
  parseMacOsHttpsProxy,
  resolveModelProxyUrl,
  resolveKlingOmniVideoEndpoint,
  resolveKlingVideoEndpoint,
  usesTrustedModelDns,
} from '../server/model-adapters.ts'

test('known model gateways bypass polluted system DNS', () => {
  assert.equal(usesTrustedModelDns('https://api.ofox.ai/v1/images/generations'), true)
  assert.equal(usesTrustedModelDns('https://doro.lol/v1/messages'), true)
  assert.equal(usesTrustedModelDns('https://api.anthropic.com/v1/messages'), false)
})

test('model requests use explicit proxy settings and honor no-proxy hosts', () => {
  const endpoint = new URL('https://doro.lol/v1/messages')
  assert.equal(resolveModelProxyUrl(endpoint, { HTTPS_PROXY: 'http://127.0.0.1:7890' }), 'http://127.0.0.1:7890')
  assert.equal(resolveModelProxyUrl(endpoint, { HTTPS_PROXY: 'http://127.0.0.1:7890', NO_PROXY: '.doro.lol' }), '')
})

test('model requests discover an enabled macOS HTTPS proxy', () => {
  const systemProxy = `
    HTTPSEnable : 1
    HTTPSPort : 7890
    HTTPSProxy : 127.0.0.1
  `
  assert.equal(parseMacOsHttpsProxy(systemProxy), 'http://127.0.0.1:7890')
  assert.equal(resolveModelProxyUrl(new URL('https://doro.lol'), {}, systemProxy), 'http://127.0.0.1:7890')
  assert.equal(parseMacOsHttpsProxy(systemProxy.replace('HTTPSEnable : 1', 'HTTPSEnable : 0')), '')
})

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

test('Kling image adapter converts workflow size into the requested aspect ratio', () => {
  assert.equal(imageSizeToAspectRatio('1024x1024'), '1:1')
  assert.equal(imageSizeToAspectRatio('720x1280'), '9:16')
  assert.equal(imageSizeToAspectRatio('invalid'), undefined)
  assert.equal(buildKlingImageRequest(klingImageModel, '角色定妆', { size: '1024x1024' }).aspect_ratio, '1:1')
  assert.equal(buildKlingImageRequest(klingImageModel, '竖屏首帧', { size: '720x1280' }).aspect_ratio, '9:16')
  assert.equal(buildKlingImageRequest(klingImageModel, '显式比例优先', { size: '1024x1024', aspectRatio: '3:4' }).aspect_ratio, '3:4')
})

test('Kling requests cap oversized prompts while preserving opening and ending constraints', () => {
  const oversizedPrompt = `OPENING:${'a'.repeat(2600)}:ENDING_AUDIO`
  const limited = limitKlingPrompt(oversizedPrompt)
  assert.equal(Array.from(limited).length, KLING_PROMPT_MAX_LENGTH)
  assert.match(limited, /^OPENING:/)
  assert.match(limited, /\[content shortened to fit Kling prompt limit\]/)
  assert.match(limited, /:ENDING_AUDIO$/)

  const imageRequest = buildKlingImageRequest(klingImageModel, oversizedPrompt, {})
  assert.equal(Array.from(String(imageRequest.prompt)).length, KLING_PROMPT_MAX_LENGTH)

  const videoRequest = buildKlingVideoRequest({
    ...klingImageModel,
    capability: 'video',
    settings: { ...klingImageModel.settings, model: 'kling-v3' },
  }, `@参考附件1 ${oversizedPrompt}`, { referenceImages: ['character-reference'] })
  const videoPrompt = String(videoRequest.prompt)
  assert.equal(Array.from(videoPrompt).length, KLING_PROMPT_MAX_LENGTH)
  assert.match(videoPrompt, /^<<<image_1>>> OPENING:/)
  assert.match(videoPrompt, /:ENDING_AUDIO$/)
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

test('Kling video prompt binds independently derived front, side, and back identity references', () => {
  const prompt = klingThreeViewVideoPrompt('人物挥剑转身', {
    referenceMode: 'three-view-all',
    referenceImages: ['front', 'side', 'back'],
  })
  assert.match(prompt, /@参考附件1正面、@参考附件2侧面、@参考附件3背面/)
  assert.match(prompt, /只定义人物身份，不代表分镜或画面分栏/)
  const request = buildKlingVideoRequest({
    ...klingImageModel,
    capability: 'video',
    settings: { ...klingImageModel.settings, model: 'kling-v3' },
  }, prompt, { referenceImages: ['front', 'side', 'back'], referenceImage: 'start' })
  assert.match(String(request.prompt), /<<<image_1>>>正面、<<<image_2>>>侧面、<<<image_3>>>背面/)
})

test('Kling omni video omits a target tail when no first frame is available', () => {
  const request = buildKlingVideoRequest({
    ...klingImageModel,
    capability: 'video',
    settings: { ...klingImageModel.settings, model: 'kling-v3' },
  }, '人物参考生视频', {
    referenceImages: ['character-front'],
    endImage: 'target-tail',
    aspectRatio: '9:16',
  })
  assert.equal(request.model_name, 'kling-v3-omni')
  assert.deepEqual(request.image_list, [
    { image_url: 'character-front' },
  ])
  assert.equal(request.aspect_ratio, '9:16')
  assert.equal('image' in request, false)
})

test('Kling tail-only input falls back to text-to-video instead of sending an invalid tail', () => {
  const request = buildKlingVideoRequest({
    ...klingImageModel,
    capability: 'video',
    settings: { ...klingImageModel.settings, model: 'kling-v3' },
  }, '文字生视频', {
    endImage: 'target-tail',
    aspectRatio: '9:16',
  })
  assert.equal(request.model_name, 'kling-v3')
  assert.equal(request.aspect_ratio, '9:16')
  assert.equal('image_list' in request, false)
  assert.equal('image_tail' in request, false)
})

test('Kling prompts bind reference groups to explicit character names', () => {
  const imagePrompt = klingIdentityReferencePrompt('许劭俯视求评者', {
    referenceDiagnostics: { composition: 'primary-panel' },
    referenceBindings: [{ characterName: '许劭' }, { characterName: '求评者' }],
  })
  assert.match(imagePrompt, /只包含许劭的单人正面参考/)
  assert.match(imagePrompt, /求评者必须与其共同出现在同一个连续场景内/)
  assert.match(imagePrompt, /上下三段/)
  assert.match(imagePrompt, /任何可读文字/)

  const videoPrompt = klingThreeViewVideoPrompt('许劭俯视求评者', {
    referenceMode: 'three-view-all',
    referenceImages: ['a', 'b', 'c', 'd', 'e', 'f'],
    referenceBindings: [{ characterName: '许劭' }, { characterName: '求评者' }],
  })
  assert.match(videoPrompt, /许劭：@参考附件1正面/)
  assert.match(videoPrompt, /求评者：@参考附件4正面/)
})

test('Kling single-character reference prompt forbids copying a sheet or storyboard layout', () => {
  const prompt = klingIdentityReferencePrompt('人物从震惊转为愤怒，手中拿着榜文', {
    referenceDiagnostics: { composition: 'single-panel' },
    referenceBindings: [{ characterName: '张俭' }],
  })
  assert.match(prompt, /单个人物正面身份参考/)
  assert.match(prompt, /只生成一个单一时间点/)
  assert.match(prompt, /分镜、拼贴、分栏、上下三段/)
  assert.match(prompt, /带文字的道具必须虚焦/)
  assert.match(prompt, /只表现动作完成后的最终状态/)
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

test('Kling tail-frame adapter rejects a successful vertical triptych result', async () => {
  const referenceSheet = await sharp({ create: { width: 900, height: 300, channels: 3, background: '#777777' } }).png().toBuffer()
  const output = await sharp({ create: { width: 300, height: 900, channels: 3, background: '#ffffff' } })
    .composite([
      { input: await sharp({ create: { width: 300, height: 300, channels: 3, background: '#111111' } }).png().toBuffer(), top: 0, left: 0 },
      { input: await sharp({ create: { width: 300, height: 300, channels: 3, background: '#eeeeee' } }).png().toBuffer(), top: 300, left: 0 },
      { input: await sharp({ create: { width: 300, height: 300, channels: 3, background: '#444444' } }).png().toBuffer(), top: 600, left: 0 },
    ])
    .png()
    .toBuffer()
  const outputUrl = `data:image/png;base64,${output.toString('base64')}`
  const result = await callKlingImage(klingImageModel, '三人同处一个连续场景', {
    referenceMode: 'three-view-front',
    referenceImages: [`data:image/png;base64,${referenceSheet.toString('base64')}`],
    referenceBindings: [{ characterName: '李膺' }],
  }, {
    fetch: async () => new Response(JSON.stringify({
      code: 0,
      data: { task_id: 'tail-1', task_status: 'succeed', task_result: { images: [{ index: 0, url: outputUrl }] } },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  })
  assert.equal(result.status, 502)
  assert.equal((result.body as { rejected_layout: string }).rejected_layout, 'vertical-triptych')
})

test('Kling workflow video adapter waits for a submitted task until a video URL is ready', async () => {
  const model = {
    ...klingImageModel,
    id: 'keling3',
    capability: 'video',
    settings: {
      ...klingImageModel.settings,
      endpoint: 'https://api-beijing.klingai.com/v1/videos/image2video',
      model: 'kling-v3',
    },
  }
  const requests: Array<{ url: string; method: string }> = []
  const responses = [
    { code: 0, data: { task_id: 'video-task-123', task_status: 'submitted' } },
    { code: 0, data: { task_id: 'video-task-123', task_status: 'succeed', task_result: { videos: [{ url: 'https://example.com/result.mp4' }] } } },
  ]
  const result = await callKlingVideo(model, '人物自然转身', { referenceImage: 'data:image/png;base64,aGVsbG8=' }, {
    fetch: async (input, init) => {
      requests.push({ url: String(input), method: String(init?.method) })
      return new Response(JSON.stringify(responses.shift()), { status: 200, headers: { 'Content-Type': 'application/json' } })
    },
    sleep: async (milliseconds) => assert.equal(milliseconds, 100),
  })
  assert.equal(result.status, 200)
  assert.deepEqual(requests, [
    { url: 'https://api-beijing.klingai.com/v1/videos/image2video', method: 'POST' },
    { url: 'https://api-beijing.klingai.com/v1/videos/image2video/video-task-123', method: 'GET' },
  ])
  assert.equal((result.body as { data: { task_result: { videos: Array<{ url: string }> } } }).data.task_result.videos[0].url, 'https://example.com/result.mp4')
})

test('Kling workflow video adapter rejects a completed task without a video URL', async () => {
  const model = {
    ...klingImageModel,
    id: 'keling3',
    capability: 'video',
    settings: { ...klingImageModel.settings, endpoint: 'https://api-beijing.klingai.com/v1/videos/image2video' },
  }
  const result = await callKlingVideo(model, '人物自然转身', { referenceImage: 'https://example.com/frame.png' }, {
    fetch: async () => new Response(JSON.stringify({
      code: 0,
      data: { task_id: 'video-task-empty', task_status: 'succeed', task_result: { videos: [] } },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  })
  assert.equal(result.status, 502)
  assert.match(String((result.body as { error: string }).error), /没有视频 URL/)
})

test('Kling authentication supports the new API key and legacy JWT credentials', () => {
  assert.equal(klingAuthorization({ apiKey: 'new-key' }), 'Bearer new-key')
  const token = createKlingToken('access', 'secret', 1_700_000_000_000)
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as Record<string, unknown>
  assert.deepEqual(payload, { iss: 'access', exp: 1_700_001_800, nbf: 1_699_999_995 })
  assert.equal(klingAuthorization({ accessKey: 'access', secretKey: 'secret' }), `Bearer ${createKlingToken('access', 'secret')}`)
})
