import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import os from 'node:os'
import sharp from 'sharp'
import { cachedNarrationPicture, composeHistoricalMapPortraitVideo, composeIllustrationMotionVideo, composeNarration,
  projectHistoricalMapPortraitPicture, validateHistoricalMapPortraitInputs } from '../server/independent-narration.ts'
import { buildKlingVideoRequest } from '../server/model-adapters.ts'
const exec = promisify(execFile)
const ffmpeg = createRequire(import.meta.url)('ffmpeg-static') as string

test('mixing retry recalls the paid picture, preserves duration, and excludes its tail audio', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'narration-mix-'))
  const dir = path.join(root, 'public/generated'); await mkdir(dir, { recursive: true })
  try {
    let calls = 0
    const call = async () => { calls++; return { status: 200, body: { data: { task_status: 'succeed', task_result: { videos: [{ url: '/generated/picture.mp4' }] } } } } }
    await cachedNarrationPicture({ execution: 'first' }, call, root)
    await cachedNarrationPicture({ execution: 'first' }, call, root)
    assert.equal(calls, 1)
    await exec(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:d=3', '-f', 'lavfi', '-i', 'sine=frequency=100:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(dir, 'picture.mp4')])
    await exec(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', path.join(dir, 'tts-aaaaaaaa.wav')])
    const result = await composeNarration('/generated/picture.mp4', [{ beatId: 'n', text: '旁白', start: 0, end: 2, url: '/generated/tts-aaaaaaaa.wav', sourceDuration: 1, duration: 1, tempo: 1, voiceId: 'original', sha256: 'fixture' }], 3, '16:9', root)
    assert.ok(Math.abs(result.metadata.duration - 3) < .1)
    const samples = async (filename: string) => {
      const { stdout } = await exec(ffmpeg, ['-v', 'error', '-ss', '2', '-i', filename, '-t', '0.5', '-vn',
        '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'], { encoding: 'buffer', maxBuffer: 1024 * 1024 })
      const bytes = stdout as Buffer, count = bytes.length / 4
      let square = 0
      for (let i = 0; i < count; i++) square += bytes.readFloatLE(i * 4) ** 2
      return Math.sqrt(square / count)
    }
    const pictureTail = await samples(path.join(dir, 'picture.mp4'))
    const finalTail = await samples(path.join(root, 'public', result.url))
    assert.ok(pictureTail > .01, `fixture picture tail must have source audio: ${pictureTail}`)
    assert.ok(finalTail < .001, `independent narration must not retain supplier tail audio: ${finalTail}`)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('illustration route moves a flat character card and includes an audio track', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'static-illustration-'))
  const dir = path.join(root, 'public/generated'); await mkdir(dir, { recursive: true })
  try {
    await exec(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360', '-frames:v', '1', path.join(dir, 'tableau.png')])
    await exec(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=white:s=900x300', '-vf', 'drawbox=x=80:y=20:w=140:h=260:color=purple:t=fill', '-frames:v', '1', path.join(dir, 'character.png')])
    const layout = [{ characterName: '张角', x: .73, y: .55, scale: .28, enterStart: .1, enterDuration: .4,
      enterFromX: .82, enterFromY: .58, exitStart: 3.3, exitDuration: .5 }]
    const result = await composeIllustrationMotionVideo('/generated/tableau.png', ['/generated/character.png'], 4, '16:9', root,
      [{ characterName: '张角' }], layout)
    assert.equal(result.route, 'layered-illustration-v1')
    assert.equal(result.motion, 'layered-2d')
    assert.ok(Math.abs(result.metadata.duration - 4) < .1)
    assert.equal(result.metadata.hasAudio, true)
    assert.deepEqual(result.illustrationLayers, layout)
    const frames = await exec(ffmpeg, ['-v', 'error', '-i', path.join(root, 'public', result.url), '-map', '0:v:0', '-f', 'framemd5', '-'])
    const hashes = frames.stdout.split('\n').filter(line => line && !line.startsWith('#')).map(line => line.split(',').at(-1)?.trim())
    assert.ok(hashes.length > 50)
    assert.ok(new Set(hashes).size > 20)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('tableau-only illustration route encodes standard decimal fade durations', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'static-tableau-'))
  const dir = path.join(root, 'public/generated'); await mkdir(dir, { recursive: true })
  try {
    await exec(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360', '-frames:v', '1', path.join(dir, 'tableau.png')])
    const result = await composeIllustrationMotionVideo('/generated/tableau.png', [], 3, '16:9', root)
    assert.equal(result.metadata.hasAudio, true)
    assert.ok(Math.abs(result.metadata.duration - 3) < .1)
    await exec(ffmpeg, ['-v', 'error', '-i', path.join(root, 'public', result.url), '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('historical map portraits require each named, readable asset and a valid static layer', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'map-portrait-inputs-'))
  const dir = path.join(root, 'public/generated'); await mkdir(dir, { recursive: true })
  const layer = { characterName: '张飞', x: .72, y: .5, scale: .24, enterStart: .2, enterDuration: .4,
    enterFromX: .78, enterFromY: .5, exitStart: 2.5, exitDuration: .5 }
  try {
    await exec(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=white:s=320x320', '-frames:v', '1', path.join(dir, 'zhangfei.png')])
    const image = '/generated/zhangfei.png', binding = { characterName: '张飞', role: 'identity' }
    assert.deepEqual(await validateHistoricalMapPortraitInputs([image], [binding], [layer], 3, root), [layer])
    await assert.rejects(validateHistoricalMapPortraitInputs([], [binding], [layer], 3, root), /一一对应/)
    await assert.rejects(validateHistoricalMapPortraitInputs([image], [{ ...binding, characterName: '刘备' }], [layer], 3, root), /同名|绑定/)
    await assert.rejects(validateHistoricalMapPortraitInputs(['/generated/missing.png'], [binding], [layer], 3, root), /MAP_PORTRAIT_ASSET_MISSING/)
    await assert.rejects(validateHistoricalMapPortraitInputs([image], [binding], [{ ...layer, exitStart: .3 }], 3, root), /进场|停留|退场/)
    await assert.rejects(validateHistoricalMapPortraitInputs([image, image], [binding, binding], [layer, layer], 3, root), /唯一姓名/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('map supplier receives only geographic first and end frames while portrait references stay for local composition', () => {
  const params = { visualTreatment: 'animated', animationStyle: 'historical_map', editorialRole: 'episode_opening',
    animationAesthetic: 'historical_cartography', referenceImage: 'https://example.com/map-first.png',
    endImage: 'https://example.com/map-last.png', referenceImages: ['https://example.com/zhangfei.png'],
    referenceBindings: [{ characterName: '张飞', role: 'identity' }], referenceMode: 'three-view-all',
    subtitlePolicy: 'none', duration: 3, sound: 'on', pacingVersion: 'independent-narration-v1',
    audioType: '环境声', audioText: '', characterVoices: [] }
  const before = structuredClone(params)
  assert.throws(() => projectHistoricalMapPortraitPicture('地图上路线渐显。', params),
    /HISTORICAL_MAP_PLATE_PROMPT_CONFLICT/)
  assert.throws(() => projectHistoricalMapPortraitPicture('让张飞肖像在地图上淡入。', params),
    /HISTORICAL_MAP_PLATE_PROMPT_CONFLICT/)
  const projected = projectHistoricalMapPortraitPicture('山川地形缓慢推移，地理方位保持连续。', params)
  assert.deepEqual(params, before)
  assert.equal(projected.params.referenceImage, params.referenceImage)
  assert.equal(projected.params.endImage, params.endImage)
  assert.deepEqual(projected.params.referenceImages, [])
  assert.deepEqual(projected.params.referenceBindings, [])
  assert.equal(projected.params.referenceMode, '')
  assert.match(projected.prompt, /无字、无箭头、无路线线条、无人物/)
  assert.deepEqual(projectHistoricalMapPortraitPicture(projected.prompt, projected.params), projected)
  const model = { id: 'offline', name: 'offline', capability: 'video', provider: 'Kling',
    settings: { model: 'kling-v3-omni', mode: 'std', sound: 'on' } } as Parameters<typeof buildKlingVideoRequest>[0]
  const supplier = buildKlingVideoRequest(model, projected.prompt, projected.params)
  assert.deepEqual(supplier.image_list, [
    { image_url: 'https://example.com/map-first.png', type: 'first_frame' },
    { image_url: 'https://example.com/map-last.png', type: 'end_frame' },
  ])
  assert.doesNotMatch(String(supplier.prompt), /zhangfei\.png|@参考附件/)
  assert.match(String(supplier.prompt), /无字幕硬约束/)
})

test('historical map portrait composition keeps the moving map and environmental audio under inert portrait layers', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'map-portrait-video-'))
  const dir = path.join(root, 'public/generated'); await mkdir(dir, { recursive: true })
  const layer = { characterName: '张飞', x: .72, y: .52, scale: .24, enterStart: .2, enterDuration: .4,
    enterFromX: .82, enterFromY: .52, exitStart: 2.5, exitDuration: .5 }
  try {
    await exec(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=24:d=3', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=3',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(dir, 'map.mp4')])
    await exec(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=white:s=300x300', '-vf', 'drawbox=x=80:y=20:w=140:h=260:color=purple:t=fill',
      '-frames:v', '1', path.join(dir, 'zhangfei.png')])
    const result = await composeHistoricalMapPortraitVideo('/generated/map.mp4', ['/generated/zhangfei.png'], 3, '16:9', root,
      [{ characterName: '张飞', role: 'identity' }], [layer])
    assert.equal(result.route, 'historical-map-portrait-overlay-v1')
    assert.equal(result.sourceVideoUrl, '/generated/map.mp4')
    assert.equal(result.metadata.hasAudio, true)
    assert.deepEqual(result.illustrationLayers, [layer])
    assert.ok(Math.abs(result.metadata.duration - 3) < .1)
    const output = path.join(root, 'public', result.url)
    const probe = await exec(ffmpeg, ['-hide_banner', '-i', output, '-f', 'null', '-'])
    assert.match(probe.stderr, /Audio:/)
    assert.doesNotMatch(probe.stderr, /Subtitle:/)
    const wav = await exec(ffmpeg, ['-hide_banner', '-i', output, '-vn', '-af', 'volumedetect', '-f', 'null', '-'])
    assert.match(wav.stderr, /mean_volume: -\d+(?:\.\d+)? dB/)
    const first = path.join(dir, 'map-early.png'), late = path.join(dir, 'map-late.png')
    const sourceLate = path.join(dir, 'source-late.png')
    await exec(ffmpeg, ['-v', 'error', '-ss', '0.1', '-i', output, '-frames:v', '1', first])
    await exec(ffmpeg, ['-v', 'error', '-ss', '1.5', '-i', output, '-frames:v', '1', late])
    await exec(ffmpeg, ['-v', 'error', '-ss', '1.5', '-i', path.join(dir, 'map.mp4'), '-vf', 'scale=1280:720', '-frames:v', '1', sourceLate])
    const [earlyLeft, lateLeft] = await Promise.all([first, late].map(filename => sharp(filename)
      .extract({ left: 0, top: 0, width: 320, height: 360 }).resize(64, 72).removeAlpha().raw().toBuffer()))
    const difference = earlyLeft.reduce((sum, byte, index) => sum + Math.abs(byte - lateLeft[index]), 0) / earlyLeft.length
    assert.ok(difference > 2, 'the map under the static portrait must remain a moving clip')
    const portraitRegion = (filename: string) => sharp(filename).extract({ left: 840, top: 295, width: 160, height: 160 })
      .resize(32, 32).removeAlpha().raw().toBuffer()
    const [withPortrait, mapOnly] = await Promise.all([portraitRegion(late), portraitRegion(sourceLate)])
    const portraitDifference = withPortrait.reduce((sum, byte, index) => sum + Math.abs(byte - mapOnly[index]), 0) / withPortrait.length
    assert.ok(portraitDifference > 12, 'the reviewed portrait must visibly appear above the map')
  } finally { await rm(root, { recursive: true, force: true }) }
})
