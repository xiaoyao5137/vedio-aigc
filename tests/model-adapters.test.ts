import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import {
  buildKlingImageRequest,
  buildKlingVideoRequest,
  buildOpenAiImageRequest,
  callKlingImage,
  callKlingVideo,
  callOpenAiImage,
  createKlingToken,
  hardenKlingDialoguePrompt,
  imageSizeToAspectRatio,
  klingAuthorization,
  klingIdentityReferencePrompt,
  klingThreeViewVideoPrompt,
  KLING_PROMPT_MAX_LENGTH,
  limitKlingPrompt,
  omitGenericCrowdVideoReferences,
  parseResponseBody,
  parseMacOsHttpsProxy,
  resolveKlingLocalImage,
  resolveModelProxyUrl,
  resolveKlingOmniVideoEndpoint,
  resolveKlingVideoEndpoint,
  fetchWithModelNetwork,
  usesTrustedModelDns,
} from '../server/model-adapters.ts'

test('provider response bodies are read once and preserve non-JSON errors', async () => {
  const jsonResponse = new Response(JSON.stringify({ error: 'structured failure' }))
  assert.deepEqual(await parseResponseBody(jsonResponse), { error: 'structured failure' })

  const textResponse = new Response('upstream gateway failure')
  assert.equal(await parseResponseBody(textResponse), 'upstream gateway failure')

  const emptyResponse = new Response(null, { status: 204 })
  assert.deepEqual(await parseResponseBody(emptyResponse), {})
})

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

test('trusted model transport aborts a live response body after headers, even when SSE heartbeats keep the socket active', async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('event: ping\ndata: {}\n\n')
    const heartbeat = setInterval(() => response.write('event: ping\ndata: {}\n\n'), 10)
    response.once('close', () => clearInterval(heartbeat))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const deadline = new AbortController()
  const response = await fetchWithModelNetwork(`http://127.0.0.1:${address.port}/messages`, {
    signal: deadline.signal,
  })
  const started = Date.now()
  const timeout = setTimeout(() => deadline.abort(new Error('body deadline')), 80)
  try {
    await assert.rejects(response.text(), /abort|timeout|operation was aborted|body deadline/i)
  } finally { clearTimeout(timeout) }
  assert.ok(Date.now() - started < 1000, 'body read must not outlive the request deadline')
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

test('explicit Kling prompt overflow policy rejects an oversized prompt before paid submission', async () => {
  const model = { ...klingImageModel, id: 'keling3', capability: 'video',
    settings: { ...klingImageModel.settings, model: 'kling-v3' } }
  const params = { duration: 7, sound: 'on', promptOverflowPolicy: 'reject' }
  const overflowing = `OPENING:${'动作连续。'.repeat(520)}:ENDING`
  assert.ok(Array.from(overflowing).length > KLING_PROMPT_MAX_LENGTH)
  assert.throws(() => buildKlingVideoRequest(model, overflowing, params), /STORYBOARD_PROMPT_OVERLOAD/)
  let submissions = 0
  await assert.rejects(() => callKlingVideo(model, overflowing, params, {
    fetch: async () => { submissions++; throw Error('unexpected paid submission') },
  }), /STORYBOARD_PROMPT_OVERLOAD/)
  assert.equal(submissions, 0)
  assert.equal(buildKlingVideoRequest(model, 'a'.repeat(KLING_PROMPT_MAX_LENGTH), params).prompt, 'a'.repeat(KLING_PROMPT_MAX_LENGTH))
  assert.throws(() => buildKlingVideoRequest(model, '短提示', { promptOverflowPolicy: 'typo' }), /KLING_PROMPT_OVERFLOW_POLICY_INVALID/)
})

test('required video prompt text survives into the paid Kling payload or blocks submission', async () => {
  const model = { ...klingImageModel, id: 'keling3', capability: 'video',
    settings: { ...klingImageModel.settings, model: 'kling-v3' } }
  const required = '0–4 秒：蓝猫把硬币推到柴犬爪边；4–7 秒：柴犬把纸袋推到蓝猫爪边；7–8 秒：保持完成状态。'
  const params = { duration: 8, sound: 'on', requiredPromptText: required }
  const accepted = buildKlingVideoRequest(model, `单格竖屏连续画面。${required}自然动作音效。`, params)
  assert.ok(String(accepted.prompt).includes(required))
  assert.equal(accepted.duration, '8')
  assert.equal(accepted.sound, 'on')
  assert.equal(Object.hasOwn(accepted, 'requiredPromptText'), false, 'workflow-only guard is not a provider field')

  assert.throws(() => buildKlingVideoRequest(model, '单格竖屏连续画面，只有氛围，没有逐项动作。', params),
    /VIDEO_REQUIRED_PROMPT_TEXT_MISSING/)
  for (const invalid of ['', [], 0]) {
    assert.throws(() => buildKlingVideoRequest(model, `单格竖屏。${required}`, { ...params, requiredPromptText: invalid }),
      /VIDEO_REQUIRED_PROMPT_TEXT_INVALID/)
  }

  const longPrompt = `${'前景布置。'.repeat(500)}${required}${'背景布置。'.repeat(500)}`
  assert.ok(longPrompt.includes(required), 'the authored prompt does contain the complete required text')
  assert.ok(Array.from(longPrompt).length > KLING_PROMPT_MAX_LENGTH)
  assert.throws(() => buildKlingVideoRequest(model, longPrompt, { ...params, promptOverflowPolicy: 'truncate' }),
    /VIDEO_REQUIRED_PROMPT_TEXT_MISSING/, 'truncating the final provider payload must not delete a required action')

  let submissions = 0
  await assert.rejects(() => callKlingVideo(model, '只有氛围。', params, {
    fetch: async () => { submissions++; throw Error('unexpected paid submission') },
  }), /VIDEO_REQUIRED_PROMPT_TEXT_MISSING/)
  assert.equal(submissions, 0)
})

test('video duration and native sound must match configured acceptance requirements before payment', async () => {
  const model = { ...klingImageModel, id: 'keling3', capability: 'video',
    settings: { ...klingImageModel.settings, model: 'kling-v3' } }
  const complete = { duration: 8, expectedDuration: 8, sound: 'on', requiredSound: 'on' }
  const accepted = buildKlingVideoRequest(model, '完整动作在第 7 秒结束，第 8 秒保持终态。', complete)
  assert.equal(accepted.duration, '8')
  assert.equal(accepted.sound, 'on')
  assert.equal(Object.hasOwn(accepted, 'expectedDuration'), false)
  assert.equal(Object.hasOwn(accepted, 'requiredSound'), false)

  assert.throws(() => buildKlingVideoRequest(model, '完整动作。', { ...complete, duration: 3 }),
    /VIDEO_EXPECTED_DURATION_MISMATCH/)
  for (const invalid of [0, -1, 'bad']) {
    assert.throws(() => buildKlingVideoRequest(model, '完整动作。', { ...complete, expectedDuration: invalid }),
      /VIDEO_EXPECTED_DURATION_INVALID/)
  }
  assert.throws(() => buildKlingVideoRequest(model, '完整动作。', { ...complete, sound: 'off' }),
    /VIDEO_REQUIRED_SOUND_MISSING/)

  let submissions = 0
  for (const wrong of [{ ...complete, duration: 3 }, { ...complete, sound: 'off' }]) {
    await assert.rejects(() => callKlingVideo(model, '完整动作。', wrong, {
      fetch: async () => { submissions++; throw Error('unexpected paid submission') },
    }), /VIDEO_EXPECTED_DURATION_MISMATCH|VIDEO_REQUIRED_SOUND_MISSING/)
  }
  assert.equal(submissions, 0)
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

test('Kling v3 rejects invalid durations before submission instead of silently changing them', () => {
  const model = {
    ...klingImageModel,
    capability: 'video',
    settings: { ...klingImageModel.settings, model: 'kling-v3', duration: '5' },
  }
  for (const duration of [2, '2', 16, '16', 3.5, 'invalid']) {
    assert.throws(() => buildKlingVideoRequest(model, '完成整个动作', { duration }), /KLING_DURATION_INVALID/)
  }
  assert.throws(() => buildKlingVideoRequest({ ...model, settings: { ...model.settings, duration: '16' } }, '完成整个动作', {}), /KLING_DURATION_INVALID/)
  assert.throws(() => buildKlingVideoRequest(model, '完成整个动作', { referenceImages: ['character-reference'], duration: 16 }), /KLING_DURATION_INVALID/)
  for (const duration of [3, 15]) {
    assert.equal(buildKlingVideoRequest(model, '完成整个动作', { duration }).duration, String(duration))
  }
})

test('Kling final request preserves validated actions, gaze, prop transfer, and the ending', () => {
  const source = '【场景与开场实景】两人隔案相对。0-5秒：甲将拜帖递至乙面前，目光注视乙。5-10秒：甲开口说出“请过目”，手仍持拜帖。10-13.5秒：乙拒接，甲收回拜帖。13.5-15秒：甲保持冷笑，手握拜帖，乙避开目光。\n【同期对白硬约束】按时发声。\n运镜：保持两人的侧面关系\n【必须生成的同期人声原文】甲：请过目'
  const hardened = hardenKlingDialoguePrompt(source)
  assert(hardened.startsWith(source))
  assert.match(hardened, /手仍持拜帖/)
  assert.match(hardened, /甲保持冷笑/)
  assert.match(hardened, /保持两人的侧面关系/)
  assert.doesNotMatch(hardened, /正对镜头保持头肩中近景/)
  assert.throws(() => buildKlingVideoRequest({ id: 'kling', provider: 'Kling', capability: 'video', settings: { model: 'kling-v3' } }, source + '布景'.repeat(1600), { referenceImage: 'https://cdn.example.com/first.png', duration: 15 }), /已阻止截断剧情/)
})


test('Kling adapter converts browser-relative runtime images to valid base64 before submission', async (t) => {
  const generatedAssetsDirectory = await mkdtemp(path.join(tmpdir(), 'video-aigc-generated-'))
  t.after(() => rm(generatedAssetsDirectory, { recursive: true, force: true }))
  const tailBytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#334455' } }).jpeg().toBuffer()
  await writeFile(path.join(generatedAssetsDirectory, 'tail.jpg'), tailBytes)

  const resolved = await resolveKlingLocalImage('/generated/tail.jpg', generatedAssetsDirectory)
  assert.equal(resolved, `data:image/jpeg;base64,${tailBytes.toString('base64')}`)

  let submitted: Record<string, unknown> | undefined
  const result = await callKlingVideo({
    ...klingImageModel,
    id: 'keling3',
    capability: 'video',
    settings: { ...klingImageModel.settings, endpoint: 'https://api-singapore.klingai.com/v1/videos', model: 'kling-v3' },
  }, '人物自然运动', {
    referenceImages: ['data:image/png;base64,Y2hhcmFjdGVy'],
    referenceImage: '/generated/tail.jpg',
  }, {
    generatedAssetsDirectory,
    fetch: async (_input, init) => {
      submitted = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(JSON.stringify({
        code: 0,
        data: { task_id: 'local-tail-task', task_status: 'succeed', task_result: { videos: [{ url: 'https://example.com/video.mp4' }] } },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    },
  })

  assert.equal(result.status, 200)
  const imageList = submitted?.image_list as Array<{ image_url: string; type?: string }>
  assert.deepEqual(imageList, [
    { image_url: 'Y2hhcmFjdGVy' },
    { image_url: tailBytes.toString('base64'), type: 'first_frame' },
  ])
  assert.ok(imageList.every((item) => !item.image_url.startsWith('/generated/')))
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

test('formal 4K profile forces Kling Omni and the native 4K request field', () => {
  const request = buildKlingVideoRequest({
    ...klingImageModel,
    id: 'keling3',
    capability: 'video',
    settings: { endpoint: 'https://api-singapore.klingai.com/v1/videos', apiKey: 'key', model: 'kling-v3' },
  }, '汉代城门远景，镜头缓慢推进', {
    outputProfile: 'production-omni-4k', model_name: 'kling-v3-omni', resolution: '4k', mode: 'pro', aspectRatio: '16:9', duration: 5,
  })
  assert.equal(request.model_name, 'kling-v3-omni')
  assert.equal(request.resolution, '4k')
  assert.equal(request.mode, 'pro')
  assert.equal(request.aspect_ratio, '16:9')
  assert.deepEqual(request.image_list, [])

  const debug = buildKlingVideoRequest({
    ...klingImageModel, capability: 'video', settings: { ...klingImageModel.settings, model: 'kling-v3' },
  }, '低成本调试镜头', { outputProfile: 'debug-720p', resolution: '720p', mode: 'std' })
  assert.equal(debug.model_name, 'kling-v3')
  assert.equal(debug.mode, 'std')
  assert.equal('resolution' in debug, false)
})

test('Kling video prompt binds independently derived front, side, and back identity references', () => {
  const prompt = klingThreeViewVideoPrompt('人物挥剑转身', {
    referenceMode: 'three-view-all',
    referenceImages: ['front', 'side', 'back'],
  })
  assert.match(prompt, /@参考附件1正面、@参考附件2侧面、@参考附件3背面/)
  assert.match(prompt, /只定义人物身份，不代表分镜或画面分栏/)
  assert.match(prompt, /参考图背景隔离/)
  assert.match(prompt, /纯色底.*不是故事场景/)
  assert.match(prompt, /不得生成幕布、棚拍/)
  assert.match(prompt, /中性站姿、手臂姿势和朝向不是本镜动作要求/)
  assert.match(prompt, /对应时段执行.*持续到该时段结束/)
  const request = buildKlingVideoRequest({
    ...klingImageModel,
    capability: 'video',
    settings: { ...klingImageModel.settings, model: 'kling-v3' },
  }, prompt, { referenceImages: ['front', 'side', 'back'], referenceImage: 'start' })
  assert.match(String(request.prompt), /<<<image_1>>>正面、<<<image_2>>>侧面、<<<image_3>>>背面/)
  const continuous = klingThreeViewVideoPrompt('同场回应', {
    referenceMode: 'three-view-all', referenceImages: ['front', 'side', 'back'], referenceImage: '/generated/tail.jpg',
  })
  assert.match(continuous, /实际首帧优先/)
  assert.match(continuous, /不改变首帧环境/)
  assert.match(continuous, /开场仍以该首帧为准/)
  assert.match(continuous, /衣襟和开合结构保持附件原貌/)
  assert.doesNotMatch(continuous, /重建完整环境/)
})

test('Kling entrant references preserve identity without allowing a frame-one appearance', () => {
  const prompt = klingThreeViewVideoPrompt('0-3秒：年长党人从门口连续步入。', {
    referenceMode: 'three-view-all',
    referenceImages: ['front', 'side', 'back'],
    referenceBindings: [{
      characterName: '年长党人',
      role: 'entering',
      entrance: { name: '年长党人', startSecond: 0, endSecond: 3, path: '门口' },
    }],
  })

  assert.match(prompt, /年长党人：@参考附件1正面/)
  assert.match(prompt, /入场人物在首帧不得出现/)
  assert.match(prompt, /0-3秒从门口连续走入/)
  assert.match(prompt, /禁止闪现、变形生成、切镜补人或提前出现/)
})

test('Kling front-only identity references also isolate their studio background', () => {
  const prompt = klingThreeViewVideoPrompt('【场景与开场实景】东汉宫殿内真人实景。', {
    referenceMode: 'three-view-front',
    referenceImages: ['front-a', 'front-b', 'front-c'],
    referenceBindings: [{ characterName: '桓帝' }, { characterName: '周福' }, { characterName: '侍从' }],
  })

  assert.match(prompt, /参考图背景隔离/)
  assert.match(prompt, /以文字中的“场景与开场实景”重建完整环境/)
  assert.match(prompt, /东汉宫殿内真人实景/)
  assert.match(prompt, /身份参考与动作分离/)
})

test('generic numbered crowd entrants keep identity attachments beside the previous tail', () => {
  const params = omitGenericCrowdVideoReferences({
    referenceMode: 'three-view-all', referenceImages: ['a', 'b', 'c', 'd', 'e', 'f'],
    referenceBindings: [
      { role: 'entering', characterName: '饥民甲', entrance: { startSecond: 0, endSecond: 3, path: '画面左后方' } },
      { role: 'entering', characterName: '饥民乙', entrance: { startSecond: 0, endSecond: 3, path: '画面右后方' } },
    ],
  })
  assert.equal(params.referenceMode, 'three-view-all')
  assert.deepEqual(params.referenceImages, ['a', 'b', 'c', 'd', 'e', 'f'])
  assert.match(klingThreeViewVideoPrompt('0-3秒：二人连续入画。', params), /首帧人物锁定.*饥民甲只能在0-3秒.*饥民乙只能在0-3秒/)

  const named = omitGenericCrowdVideoReferences({
    referenceMode: 'three-view-all', referenceImages: ['a', 'b', 'c'],
    referenceBindings: [{ role: 'entering', characterName: '张角' }],
  })
  assert.equal(named.referenceMode, 'three-view-all')
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
    referenceDiagnostics: { composition: 'text-only-multi-character' },
    referenceBindings: [{ characterName: '许劭' }, { characterName: '求评者' }],
  })
  assert.match(imagePrompt, /本次不使用会诱导拼版的单人人物附件/)
  assert.match(imagePrompt, /许劭、求评者/)
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

test('Kling Video 3 text-to-video keeps aspect ratio at the supported duration boundary', () => {
  const request = buildKlingVideoRequest({
    ...klingImageModel,
    id: 'keling3',
    capability: 'video',
    settings: { endpoint: 'https://api-singapore.klingai.com/v1/videos', apiKey: 'key', model: 'kling-v3' },
  }, '城市延时摄影', { duration: 15, aspectRatio: '1:1', multiShot: false })
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

test('Kling image and video content rejections preserve the provider task and stop without resubmitting', async () => {
  const videoModel = { ...klingImageModel, capability: 'video', settings: { ...klingImageModel.settings, endpoint: 'https://api-beijing.klingai.com/v1/videos/image2video' } }
  const failure = { code: 0, data: { task_id: 'rejected-task', task_status: 'failed', task_status_msg: 'Failure to pass the risk control system' } }
  for (const [call, model] of [[callKlingImage, klingImageModel], [callKlingVideo, videoModel]] as const) {
    for (const mode of ['immediate', 'poll', 'resume', 'gateway-poll']) {
      const methods: string[] = []
      const result = await call(model, 'original request', mode === 'resume' ? { resumeTaskId: 'rejected-task' } : {}, {
        sleep: async () => {},
        fetch: async (_url, init) => {
          methods.push(String(init?.method))
          if (init?.method === 'POST' && mode !== 'immediate') return Response.json({ code: 0, data: { task_id: 'rejected-task', task_status: 'submitted' } })
          return Response.json(failure, { status: mode === 'gateway-poll' ? 502 : 200 })
        },
      })
      assert.equal(result.status, 422, `${model.capability}/${mode}`)
      const body = result.body as { error: { type: string; retryable: boolean; provider: string }; task_id: string; provider_response: unknown }
      assert.equal(body.error.type, 'MODEL_CONTENT_REJECTED')
      assert.equal(body.error.retryable, false)
      assert.equal(body.error.provider, 'Kling')
      assert.equal(body.task_id, 'rejected-task')
      assert.deepEqual(body.provider_response, failure)
      assert.deepEqual(methods, mode === 'immediate' ? ['POST'] : mode === 'resume' ? ['GET'] : ['POST', 'GET'])
    }
  }
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

test('Kling singleFrame contract rejects a triptych and accepts one continuous frame', async () => {
  const triptych = await sharp({ create: { width: 300, height: 900, channels: 3, background: '#ffffff' } })
    .composite([
      { input: await sharp({ create: { width: 300, height: 300, channels: 3, background: '#222222' } }).png().toBuffer(), top: 0, left: 0 },
      { input: await sharp({ create: { width: 300, height: 300, channels: 3, background: '#eeeeee' } }).png().toBuffer(), top: 300, left: 0 },
      { input: await sharp({ create: { width: 300, height: 300, channels: 3, background: '#555555' } }).png().toBuffer(), top: 600, left: 0 },
    ])
    .png()
    .toBuffer()
  const singleFrame = await sharp({ create: { width: 300, height: 900, channels: 3, background: '#eeeeee' } })
    .composite([{ input: await sharp({ create: { width: 300, height: 600, channels: 3, background: '#666666' } }).png().toBuffer(), top: 300, left: 0 }])
    .png()
    .toBuffer()
  const completedImage = (image: Buffer) => new Response(JSON.stringify({
    code: 0,
    data: { task_id: 'single-frame', task_status: 'succeed', task_result: { images: [{ url: `data:image/png;base64,${image.toString('base64')}` }] } },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })

  const rejected = await callKlingImage(klingImageModel, '一张静止首帧照片', { singleFrame: 'true' }, {
    fetch: async () => completedImage(triptych),
  })
  assert.equal(rejected.status, 502)
  assert.equal((rejected.body as { rejected_layout: string }).rejected_layout, 'vertical-triptych')
  assert.match(String((rejected.body as { error: string }).error), /单幅画面布局检查/)

  const accepted = await callKlingImage(klingImageModel, '一张静止首帧照片', { singleFrame: true }, {
    fetch: async () => completedImage(singleFrame),
  })
  assert.equal(accepted.status, 200)
  assert.equal((accepted.body as { data: { task_result: { images: Array<{ url: string }> } } }).data.task_result.images.length, 1)
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

test('Kling persists an accepted task before polling and resumes without another POST', async () => {
  const model = { ...klingImageModel, capability: 'video', settings: { ...klingImageModel.settings, endpoint: 'https://api-beijing.klingai.com/v1/videos/image2video' } }
  let saved = false
  const result = await callKlingVideo(model, '动作', {}, {
    onTaskSubmitted: async (result, endpoint) => {
      assert.equal((result.body as { data: { task_id: string } }).data.task_id, 'accepted')
      assert.match(endpoint, /text2video$/)
      saved = true
    },
    sleep: async () => { assert.equal(saved, true) },
    fetch: async (_url, init) => new Response(JSON.stringify({ code: 0, data: init?.method === 'POST'
      ? { task_id: 'accepted', task_status: 'submitted' }
      : { task_id: 'accepted', task_status: 'succeed', task_result: { videos: [{ url: 'https://example.com/clip.mp4' }] } } })),
  })
  assert.equal(result.status, 200)
  const methods: string[] = []
  await callKlingVideo(model, '动作', { resumeTaskId: 'accepted', resumeQueryMode: 'omni' }, {
    fetch: async (url, init) => {
      assert.match(String(url), /omni-video\/accepted$/)
      methods.push(String(init?.method))
      return new Response(JSON.stringify({ code: 0, data: { task_id: 'accepted', task_status: 'succeed', task_result: { videos: [{ url: 'https://example.com/clip.mp4' }] } } }))
    },
  })
  assert.deepEqual(methods, ['GET'])
})

test('Kling query 524 and socket reset recover against the same task with one POST', async () => {
  const model = { ...klingImageModel, capability: 'video', settings: { ...klingImageModel.settings, endpoint: 'https://api-beijing.klingai.com/v1/videos/image2video' } }
  let posts = 0
  let gets = 0
  const result = await callKlingVideo(model, '动作', {}, { sleep: async () => {}, fetch: async (url, init) => {
    if (init?.method === 'POST') { posts++; return new Response(JSON.stringify({ code: 0, data: { task_id: 'paid-once', task_status: 'submitted' } })) }
    assert.match(String(url), /paid-once$/)
    gets++
    if (gets === 1) return new Response('error code: 524\n', { status: 524 })
    if (gets === 2) throw new Error('ECONNRESET')
    return new Response(JSON.stringify({ code: 0, data: { task_id: 'paid-once', task_status: 'succeed', task_result: { videos: [{ url: 'https://example.com/clip.mp4' }] } } }))
  } })
  assert.equal(result.status, 200)
  assert.equal(posts, 1)
  assert.equal(gets, 3)
})

test('Kling transient task queries recover on attempt five without repeating the paid POST', async () => {
  const model = { ...klingImageModel, capability: 'video', settings: { ...klingImageModel.settings, endpoint: 'https://api-beijing.klingai.com/v1/videos/image2video' } }
  let posts = 0, gets = 0
  const delays: number[] = []
  const result = await callKlingVideo(model, '动作', {}, { sleep: async delay => { delays.push(delay) }, fetch: async (url, init) => {
    if (init?.method === 'POST') { posts++; return new Response(JSON.stringify({ code: 0, data: { task_id: 'twenty-query', task_status: 'submitted' } })) }
    assert.match(String(url), /twenty-query$/)
    gets++
    if (gets < 5) {
      if (gets % 2) throw Error('ECONNRESET')
      return new Response('error code: 524', { status: 524 })
    }
    return new Response(JSON.stringify({ code: 0, data: { task_id: 'twenty-query', task_status: 'succeed', task_result: { videos: [{ url: 'https://example.com/clip.mp4' }] } } }))
  } })
  assert.equal(result.status, 200)
  assert.equal(posts, 1)
  assert.equal(gets, 5)
  assert.ok(delays.every(delay => delay <= 30_000), 'larger retry budget must not create exponentially unbounded sleeps')
})

test('Kling failed task queries stop at five while permanent failures stop immediately', async () => {
  const model = { ...klingImageModel, capability: 'video', settings: { ...klingImageModel.settings, endpoint: 'https://api-beijing.klingai.com/v1/videos/image2video' } }
  for (const status of [524, 401]) {
    let gets = 0
    const result = await callKlingVideo(model, '动作', { resumeTaskId: 'accepted-before-test' }, { sleep: async () => {}, fetch: async (_url, init) => {
      assert.equal(init?.method, 'GET')
      gets++
      return new Response('upstream failure', { status })
    } })
    assert.equal(result.status, status)
    assert.equal(gets, status === 524 ? 5 : 1)
  }
})

test('Image 3.0 directed correction uses the documented Omni endpoint and image_list', async () => {
  const model = { id: 'image', provider: 'Kling', capability: 'image', settings: { apiKey: 'test', model: 'kling-v3', endpoint: 'https://example.test/v1/images/generations' } }
  const requests: { url: string; body: Record<string, unknown> }[] = []
  await callKlingImage(model, '修改<<<image_1>>>的面部', { referenceImage: 'https://example.test/reference.png', imageEdit: true, aspectRatio: '16:9' }, {
    fetch: async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) })
      return new Response(JSON.stringify({ code: 0, data: { task_id: 'edit-task', task_status: 'succeed', task_result: { images: [{ url: 'https://example.test/result.png' }] } } }))
    },
  })
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'https://example.test/v1/images/omni-image')
  assert.equal(requests[0].body.model_name, 'kling-v3-omni')
  assert.deepEqual(requests[0].body.image_list, [{ image: 'https://example.test/reference.png' }])
  assert.equal(requests[0].body.image, undefined)
  const ordinary = buildKlingImageRequest(model, '普通图生图', { referenceImage: 'https://example.test/reference.png' })
  assert.equal(ordinary.model_name, 'kling-v3')
  assert.equal(ordinary.image_list, undefined)
})

test('accepted Kling images retain task identity and resume with GET only', async () => {
  const calls: Array<{ url: string; method: string }> = []
  const accepted: string[] = []
  const model = { ...klingImageModel, settings: { ...klingImageModel.settings, model: 'kling-v3', endpoint: 'https://api-beijing.klingai.com/v1/images/generations' } }
  const params = { referenceImage: 'data:image/png;base64,aGVsbG8=', imageEdit: true }
  await assert.rejects(callKlingImage(model, '修正角色外观', params, {
    fetch: async (url, init) => {
      calls.push({ url: String(url), method: String(init?.method) })
      return new Response(JSON.stringify({ code: 0, data: { task_id: 'persisted-image', task_status: 'submitted' } }), { status: 200 })
    },
    onTaskSubmitted: async (result, endpoint) => {
      accepted.push(endpoint)
      assert.equal((result.body as { data: { task_id: string } }).data.task_id, 'persisted-image')
      throw new Error('simulated process interruption after checkpoint')
    },
  }), /simulated process interruption/)
  const resumed = await callKlingImage(model, '修正角色外观', { ...params, resumeTaskId: 'persisted-image' }, {
    fetch: async (url, init) => {
      calls.push({ url: String(url), method: String(init?.method) })
      return new Response(JSON.stringify({ code: 0, data: { task_id: 'persisted-image', task_status: 'succeed', task_result: { images: [{ url: 'https://example.test/accepted.png' }] } } }), { status: 200 })
    },
  })
  assert.equal(resumed.status, 200)
  assert.deepEqual(accepted, ['https://api-beijing.klingai.com/v1/images/omni-image'])
  assert.deepEqual(calls, [
    { url: 'https://api-beijing.klingai.com/v1/images/omni-image', method: 'POST' },
    { url: 'https://api-beijing.klingai.com/v1/images/omni-image/persisted-image', method: 'GET' },
  ])
})
