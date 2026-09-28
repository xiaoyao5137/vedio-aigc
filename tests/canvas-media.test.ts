import test from 'node:test'
import assert from 'node:assert/strict'
import { canvasMediaKind, resolveCanvasMedia } from '../src/canvas-media.ts'

const video = { kind: 'video' }
const image = { kind: 'image' }
const urls = (media: ReturnType<typeof resolveCanvasMedia>) => media.map(item => item.url)

test('extracts a local generated video and deduplicates provider wrapper aliases', () => {
  const url = '/generated/scene-1.mp4'
  const media = resolveCanvasMedia(video, { run: { status: 'success', output: {
    url, raw: { data: { task_result: { videos: [{ url }] } } }, params: { referenceImage: '/old.png' }, prompt: '/prompt.jpg',
  } } })
  assert.deepEqual(media, [{ url, kind: 'video', source: 'output', label: '生成结果', filename: 'scene-1.mp4' }])
})

test('recognizes extensionless provider media and typed image dictionaries', () => {
  const media = resolveCanvasMedia(video, { run: { output: { data: { task_result: {
    videos: [{ url: 'https://cdn.example.test/video-id?signature=1' }],
    images: { first: 'https://cdn.example.test/first', tail: { url: 'https://cdn.example.test/tail' } },
  } } } } })
  assert.deepEqual(media.map(item => item.kind), ['video', 'image', 'image'])
  assert.equal(media.length, 3)
})

test('prioritizes the final canonical video over an earlier raw provider video', () => {
  const media = resolveCanvasMedia(video, { run: { output: {
    raw: { data: { task_result: { videos: [{ url: '/provider-native.mp4' }] } } },
    url: '/narrated-final.mp4', narration: { audioUrl: '/narration.wav' },
  } } })
  assert.equal(media[0].url, '/narrated-final.mp4')
  assert.ok(urls(media).includes('/provider-native.mp4'))
})

test('supports persisted voice candidate previewUrl and extensionless sample URLs', () => {
  const output = { raw: { items: [{ characterName: '旁白', previewUrl: '/generated/voice-design.wav' }] },
    items: [{ characterName: '旁白', previewUrl: '/generated/voice-design.wav' }, { name: '角色', sampleURL: 'https://cdn.example.test/voice-sample' }],
  }
  const media = resolveCanvasMedia({ kind: 'audio', operation: 'character.voice-design' }, { run: { output } })
  assert.deepEqual(media.map(item => [item.url, item.kind, item.label]), [
    ['/generated/voice-design.wav', 'audio', '旁白'], ['https://cdn.example.test/voice-sample', 'audio', '角色'],
  ])
})

test('supports mapped image results and character lookup maps', () => {
  const media = resolveCanvasMedia(image, { run: { output: {
    items: [{ url: '/one.png', name: '人物一' }, { data: [{ url: '/two.png' }] }],
    byCharacter: { 张飞: { url: 'https://cdn.example.test/zhangfei' } },
  } } })
  assert.deepEqual(urls(media), ['/one.png', '/two.png', 'https://cdn.example.test/zhangfei'])
  assert.equal(media[0].label, '人物一')
})

test('uses data MIME and explicit media MIME ahead of a node fallback', () => {
  const media = resolveCanvasMedia(video, { run: { output: {
    items: [{ url: 'data:image/png;base64,YQ==' }, { url: '/download/tts-1', mimeType: 'audio/wav' }],
  } } })
  assert.deepEqual(media.map(item => item.kind), ['image', 'audio'])
})

test('recognizes TTS and browser-served extensionless generated routes', () => {
  const media = resolveCanvasMedia({ kind: 'audio', modelId: 'bailian-qwen-audio-tts' }, { run: { output: {
    url: '/api/generated-audio/42', raw: { data: { audio: { url: 'https://cdn.example.test/speech' } } },
  } } })
  assert.deepEqual(media.map(item => item.kind), ['audio', 'audio'])
  assert.equal(resolveCanvasMedia({ kind: 'code' }, { run: { output: { url: '/api/generated-images/42' } } })[0]?.kind, 'image')
})

test('does not mistake request metadata, references or arbitrary API URLs for output', () => {
  const media = resolveCanvasMedia(video, { run: { output: {
    request: { url: 'https://api.example.test/generate', images: ['/request.jpg'] },
    metadata: { videoUrl: '/metadata.mp4' }, prompt: '/prompt.jpg',
    referenceImage: '/ref.png', imageReferences: ['/ref2.png'], sourceVideoUrl: '/source.mp4', input: { url: '/input.mp4' },
    callback_url: 'https://api.example.test/callback.mp4', api: { url: 'https://api.example.test/jobs/1' },
    description: '/description.jpg', task_url: 'https://api.example.test/task/1',
  } } })
  assert.deepEqual(media, [])
})

test('does not fabricate an output from result variables or an idle/skipped stale result', () => {
  assert.deepEqual(resolveCanvasMedia(video, { context: { video_shot: { url: '/previous.mp4' } } }), [])
  for (const status of ['idle', 'skipped']) {
    assert.deepEqual(resolveCanvasMedia(video, { run: { status, output: { url: '/previous.mp4' } } }), [])
  }
})

test('keeps an uploaded reference distinct from the generated output even with the same URL', () => {
  const node = { kind: 'image', uploads: [{ dataUrl: '/same.png', name: '已确认人物.png' }] }
  const media = resolveCanvasMedia(node, { run: { output: { url: '/same.png' } } })
  assert.deepEqual(media.map(item => item.source), ['output', 'reference'])
  assert.equal(media[1].label, '已确认人物.png')
})

test('uses upload MIME for extensionless media and ignores non-media uploads', () => {
  const media = resolveCanvasMedia(video, { run: { status: 'idle' } })
  assert.deepEqual(media, [])
  assert.deepEqual(resolveCanvasMedia({ ...video, uploads: [
    { name: 'guide.pdf', dataUrl: '/uploads/guide', mimeType: 'application/pdf' },
    { name: 'voice.wav', dataUrl: '/uploads/voice', mimeType: 'audio/wav' },
    { name: 'face.png', dataUrl: '/uploads/face' },
  ] }).map(item => item.kind), ['audio', 'image'])
})

test('resolves literal and nested JSON media references without executing expressions', () => {
  const node = { ...video, params: [
    { name: '首帧', englishName: 'referenceImage', type: 'image', value: '${first_frame.url}' },
    { name: '参考图', englishName: 'referenceImages', type: 'json', value: '["${characters.images}", "${end_frame.url}"]' },
    { name: '音频', englishName: 'audio', type: 'json', value: '[${voice.items}]' },
    { name: '未解析', englishName: 'image', value: '${globalThis.process.exit()}' },
  ] }
  const media = resolveCanvasMedia(node, { context: {
    first_frame: { url: '/first.png' }, end_frame: { url: '/tail.png' }, characters: { images: ['/a.png', '/b.png'] }, voice: { items: [{ url: '/one.wav' }] },
  } })
  assert.deepEqual(urls(media), ['/first.png', '/a.png', '/b.png', '/tail.png', '/one.wav'])
  assert.ok(media.every(item => item.source === 'reference'))
})

test('captured inputs win over edited config and global contexts, including empty snapshots', () => {
  const node = { ...video, params: [{ name: '首帧', englishName: 'referenceImage', type: 'image', value: '${frame.url}' }] }
  const context = { frame: { url: '/latest-wrong.png' } }
  assert.deepEqual(urls(resolveCanvasMedia(node, { context, run: {
    inputs: { referenceImage: '/captured.png' }, inputContext: { frame: { url: '/context.png' } },
  } })), ['/captured.png'])
  assert.deepEqual(resolveCanvasMedia(node, { context, run: { inputs: {} } }), [])
  assert.deepEqual(resolveCanvasMedia(node, { context, run: { inputContext: {} } }), [])
  assert.deepEqual(resolveCanvasMedia(node, { context, run: {} }), [])
  assert.deepEqual(urls(resolveCanvasMedia(node, { context, run: { inputContext: { frame: { url: '/iteration-2.png' } } } })), ['/iteration-2.png'])
})

test('extracts operation-added captured media inputs without exposing prompt and request fields', () => {
  const media = resolveCanvasMedia(video, { run: { inputs: {
    videos: [{ url: '/clip.mp4' }], referenceImages: ['/cast.png'], audioUrl: '/tts.wav',
    prompt: '/secret.png', request: { url: '/request.mp4' }, endpoint: 'https://api.example.test/request',
  } } })
  assert.deepEqual(urls(media), ['/clip.mp4', '/cast.png', '/tts.wav'])
  assert.ok(media.every(item => item.source === 'reference'))
})

test('rejects executable, filesystem, unresolved and non-media data URL schemes', () => {
  const urlsToReject = ['javascript:alert(1)', 'file:///tmp/file.png', 'data:text/html,<script>x</script>', 'ftp://example.test/a.png', '${unresolved.url}', '//example.test/a.png', '/bad\npath.mp4']
  for (const url of urlsToReject) assert.deepEqual(resolveCanvasMedia(video, { run: { output: { url } } }), [], url)
  const safe = ['https://example.test/a.mp4', '/generated/a.mp4', './a.mp4', 'blob:https://example.test/abc', 'data:audio/wav;base64,YQ==']
  assert.equal(resolveCanvasMedia(video, { run: { output: safe } }).length, safe.length)
})

test('bounds traversal and handles cyclic values without mutating captured results', () => {
  const cyclic: Record<string, unknown> = { url: '/first.png' }
  cyclic.raw = cyclic
  assert.deepEqual(urls(resolveCanvasMedia(image, { run: { output: cyclic } })), ['/first.png'])
  const output = Object.freeze({ items: Object.freeze(Array.from({ length: 2000 }, (_, index) => Object.freeze({ url: `/${index}.png` }))) })
  assert.equal(resolveCanvasMedia(image, { run: { output } }).length, 96)
  assert.equal(output.items.length, 2000)
})

test('only generative or media operations receive a placeholder kind', () => {
  assert.equal(canvasMediaKind({ kind: 'audio' }), 'audio')
  assert.equal(canvasMediaKind({ kind: 'asset', operation: 'character.ensure' }), 'image')
  assert.equal(canvasMediaKind({ kind: 'code', operation: 'frame.first.resolve' }), 'image')
  assert.equal(canvasMediaKind({ kind: 'videoConcat' }), 'video')
  assert.equal(canvasMediaKind({ kind: 'text' }), undefined)
  assert.equal(canvasMediaKind({ kind: 'http' }), undefined)
})
