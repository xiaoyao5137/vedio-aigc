const baseUrl = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:5173'

async function post(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(`${path}: ${JSON.stringify(result)}`)
  return result.body ?? result
}

const localText = { id: 'local-history-llm', name: 'local', provider: 'Local', capability: 'text', settings: {}, testInput: '', testResult: '' }
const localImage = { id: 'local-image-simulator', name: 'local', provider: 'Local', capability: 'image', settings: {}, testInput: '', testResult: '' }
const localVideo = { id: 'local-video-simulator', name: 'local', provider: 'Local', capability: 'video', settings: {}, testInput: '', testResult: '' }

const sources = await post('/api/builtin-node-run', {
  operation: 'internet.retrieve',
  params: {
    query: '符水与饥民 后汉书 卷七十一 皇甫嵩朱儁列传',
    urls: ['https://zh.wikisource.org/zh-hans/%E5%BE%8C%E6%BC%A2%E6%9B%B8'],
    maxSources: 1,
    maxPassages: 3,
  },
})
const outlineModelOutput = await post('/api/node-run', {
  model: localText,
  operation: 'history.scene-outline',
  prompt: sources.text,
  params: { episodeTitle: '符水与饥民', citations: sources.citations, historicalSources: sources.text },
})
const outline = {
  ...outlineModelOutput,
  count: outlineModelOutput.scenes.length,
  totalDuration: outlineModelOutput.scenes.reduce((total, scene) => total + Number(scene.targetDuration), 0),
}

const shots = []
const videos = []
const assetNames = new Set()
let previousLastFrame
let reusedFirstFrames = 0
let nativeAudioClips = 0
for (const scene of outline.scenes) {
  const shot = await post('/api/node-run', {
    model: localText,
    operation: 'history.storyboard',
    prompt: `把本集《符水与饥民》的当前场景改写为短分镜。\n\n当前场景：${JSON.stringify(scene)}\n\n史料原文：${sources.text}`,
    params: {},
  })
  const characterLookup = await post('/api/builtin-node-run', {
    operation: 'character.lookup',
    params: { characters: shot.characters },
  })
  characterLookup.names.forEach((name) => assetNames.add(name))
  const missingNames = characterLookup.missingCharacters.map((item) => item.name)
  const generatedCharacters = missingNames.length
    ? await post('/api/node-run', {
        model: localImage,
        prompt: `为以下缺失人物生成东汉末年定妆三视图：${missingNames.join('、')}。真人历史电影质感，正面、侧面、背面，纯色背景，无文字无水印。`,
        params: { referenceImages: [], size: '1024x1024', n: missingNames.length },
      })
    : { items: [] }
  const referenceImages = [
    ...characterLookup.items.map((item) => item.url),
    ...(generatedCharacters.items ?? []).map((item) => item.url),
    ...(generatedCharacters.url ? [generatedCharacters.url] : []),
  ]
  const shouldReusePreviousTail = shot.firstFrameMode === 'reuse_previous_tail' && Boolean(previousLastFrame)
  const frame = shouldReusePreviousTail
    ? { url: previousLastFrame, resolvedMode: 'reuse_previous_tail' }
    : {
        ...(await post('/api/node-run', {
          model: localImage,
          prompt: shot.firstFramePrompt,
          params: { referenceImages, size: '720x1280' },
        })),
        resolvedMode: 'generate',
      }
  if (frame.resolvedMode === 'reuse_previous_tail') reusedFirstFrames += 1
  const video = await post('/api/node-run', {
    model: localVideo,
    prompt: `${shot.videoPrompt}\n运镜：${shot.camera}\n声音类型：${shot.audioType}\n同期声音与台词：${shot.audioText}`,
    params: { image: frame.url, duration: shot.duration, sound: 'on' },
  })
  previousLastFrame = video.lastFrameUrl || ''
  if (video.audioEmbedded) nativeAudioClips += 1
  shots.push(shot)
  videos.push(video)
}

const verification = await post('/api/builtin-node-run', {
  operation: 'history.verify',
  params: { citations: sources.citations, shots, expectedSceneCount: outline.count, expectedTotalDuration: outline.totalDuration, policy: '史事有据；合理拟制不得改变历史因果。' },
})
const timeline = await post('/api/builtin-node-run', {
  operation: 'timeline.compose',
  params: { storyboards: shots, videos, aspectRatio: '9:16', resolution: '1080x1920', format: 'mp4' },
})

if (!verification.passed) throw new Error(`historical verification failed: ${JSON.stringify(verification.violations)}`)
if (sources.sourceMode !== 'internet') throw new Error(`expected internet sources, got ${sources.sourceMode}`)
if (timeline.clipCount !== outline.count) throw new Error(`expected ${outline.count} clips, got ${timeline.clipCount}`)
if (timeline.totalDuration !== outline.totalDuration) throw new Error(`expected ${outline.totalDuration} seconds, got ${timeline.totalDuration}`)
if (reusedFirstFrames < 1) throw new Error('expected at least one reused previous tail frame')
if (nativeAudioClips !== videos.length) throw new Error(`expected ${videos.length} native-audio clips, got ${nativeAudioClips}`)

console.log(JSON.stringify({
  ok: true,
  citations: sources.count,
  characters: assetNames.size,
  scenes: outline.count,
  clips: timeline.clipCount,
  duration: timeline.totalDuration,
  reusedFirstFrames,
  nativeAudioClips,
  verificationPassed: verification.passed,
}, null, 2))
