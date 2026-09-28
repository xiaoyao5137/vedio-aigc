import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { concatenateVideos, resolveVideoConcatSources } from '../server/video-concat.ts'
import { repairSanguoVideoMediaRoute, sanguoVideoConcatNode, upgradeSanguoVideoConcat } from '../src/video-concat-workflow.ts'
import { aggregateLoopOutputs } from '../src/workflow-core.ts'

const run = promisify(execFile)
const ffmpeg = createRequire(import.meta.url)('ffmpeg-static') as string

test('video concat expands the previous stage into original clips in stable order', () => {
  assert.deepEqual(resolveVideoConcatSources({
    previousVideo: { url: '/generated/stage.mp4', clips: [{ url: '/generated/one.mp4' }, { url: '/generated/two.mp4' }] },
    currentVideo: { url: '/generated/three.mp4' },
  }).map(item => item.url), ['/generated/one.mp4', '/generated/two.mp4', '/generated/three.mp4'])
  assert.throws(() => resolveVideoConcatSources({ currentVideo: { nope: true } }), /VIDEO_CONCAT_INVALID/)
})

test('a rolling loop variable keeps the latest stage video while ordinary outputs remain collected', () => {
  const rounds = [
    { stage_video: { url: '/generated/stage-1.mp4', count: 1 }, video_shot: { url: '/generated/one.mp4' } },
    { stage_video: { url: '/generated/stage-2.mp4', count: 2 }, video_shot: { url: '/generated/two.mp4' } },
  ]
  const output = aggregateLoopOutputs(rounds, { stage_video: 'latest' })
  assert.deepEqual(output.stage_video, rounds[1].stage_video)
  assert.deepEqual(output.video_shot, { items: rounds.map(round => round.video_shot), count: 2 })
})

test('generic video concat writes a reusable mp4 and preserves the source manifest', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'video-concat-'))
  const generated = path.join(root, 'public/generated')
  await mkdir(generated, { recursive: true })
  try {
    for (const [index, color] of ['red', 'blue'].entries()) {
      await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=320x180:r=25:d=0.4`,
        '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '0.4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(generated, `clip-${index}.mp4`)])
    }
    const first = await concatenateVideos({ videos: ['/generated/clip-0.mp4', '/generated/clip-1.mp4'], format: 'mp4' }, { root, ffmpeg })
    assert.equal(first.count, 2); assert.equal(first.clips.length, 2); assert.match(first.url, /^\/generated\/video-concat-[a-f0-9]+\.mp4$/)
    assert.equal(first.resolution, '720p'); assert.equal(first.width, 1280); assert.equal(first.height, 720); assert.equal(first.audioSampleRate, 48000)
    assert.ok((await readFile(path.join(root, 'public', first.url))).length > 0)
    const second = await concatenateVideos({ previousVideo: first, currentVideo: '/generated/clip-0.mp4' }, { root, ffmpeg })
    assert.equal(second.count, 3); assert.deepEqual(second.clips.map(clip => clip.url), ['/generated/clip-0.mp4', '/generated/clip-1.mp4', '/generated/clip-0.mp4'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('video concat normalizes heterogeneous stream order and keeps every later clip decodable', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'video-concat-heterogeneous-'))
  const generated = path.join(root, 'public/generated')
  await mkdir(generated, { recursive: true })
  try {
    for (const [index, color] of ['red', 'blue', 'green', 'yellow'].entries()) {
      const video = ['-f', 'lavfi', '-i', `color=c=${color}:s=${index % 2 ? '640x360' : '318x180'}:r=${index % 2 ? 30 : 24}:d=0.4`]
      const audio = ['-f', 'lavfi', '-i', `sine=frequency=${400 + index * 100}:sample_rate=${index % 2 ? 48000 : 44100}:duration=0.4`]
      const inputs = index < 2 ? [...video, ...audio] : [...audio, ...video]
      const videoMap = index < 2 ? '0:v:0' : '1:v:0'
      const audioMap = index < 2 ? '1:a:0' : '0:a:0'
      await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...inputs,
        '-map', videoMap, '-map', audioMap, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(generated, `clip-${index}.mp4`)])
    }
    const result = await concatenateVideos({ videos: [0, 1, 2, 3].map(index => `/generated/clip-${index}.mp4`) }, { root, ffmpeg })
    assert.equal(result.count, 4)
    assert.equal(result.concatMode, 'normalized-stream-copy')
    const output = path.join(root, 'public', result.url)
    await run(ffmpeg, ['-hide_banner', '-v', 'error', '-xerror', '-i', output, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'])
    const { stdout } = await run(ffmpeg, ['-hide_banner', '-v', 'error', '-i', output, '-map', '0:v:0', '-f', 'framemd5', '-'])
    const frames = stdout.split('\n').filter(line => line && !line.startsWith('#'))
    assert.ok(frames.length >= 36, `expected all four clips, got only ${frames.length} frames`)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('formal concat really encodes and decodes a 4K/24fps/48k deliverable', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'video-concat-4k-'))
  const generated = path.join(root, 'public/generated')
  await mkdir(generated, { recursive: true })
  try {
    await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=navy:s=320x180:r=24:d=0.15',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(generated, 'source.mp4')])
    const result = await concatenateVideos({ videos: ['/generated/source.mp4'], resolution: '4k', aspectRatio: '16:9' }, { root, ffmpeg })
    assert.equal(result.resolution, '4k'); assert.equal(result.width, 3840); assert.equal(result.height, 2160)
    const output = path.join(root, 'public', result.url)
    const inspected = await run(ffmpeg, ['-hide_banner', '-i', output, '-f', 'null', '-'])
    assert.match(inspected.stderr, /3840x2160/)
    assert.match(inspected.stderr, /24 fps/)
    assert.match(inspected.stderr, /48000 Hz, stereo/)
    await run(ffmpeg, ['-hide_banner', '-v', 'error', '-xerror', '-i', output, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('schema 141 inserts concat after acceptance and binds the accepted take', () => {
  const baseNode = (id: string, kind = 'code', resultVar = id) => ({ id, title: id, kind, resultVar, prompt: '', params: [], uploads: [],
    loop: { enabled: false, sourcePath: '', fallbackCount: 0, itemVar: 'item' }, position: { x: 0, y: 0 } })
  const workflow = { id: 'wf-sanguo-history-drama', schemaVersion: 137,
    nodes: [baseNode('sanguo-scene-loop', 'loop'), { ...baseNode('sanguo-video', 'video', 'video_take'), parentId: 'sanguo-scene-loop' },
      { ...baseNode('review'), parentId: 'sanguo-scene-loop' }, { ...baseNode('sanguo-media-accept-accept-branch', 'branch'), parentId: 'sanguo-scene-loop' },
      { ...baseNode('sanguo-last-frame'), parentId: 'sanguo-scene-loop' }],
    edges: [{ id: 'video-review', from: 'sanguo-video', to: 'review' },
      { id: 'accepted-tail', from: 'sanguo-media-accept-accept-branch', to: 'sanguo-last-frame', branch: 'true' }] }
  workflow.nodes[0].childIds = ['sanguo-video', 'review', 'sanguo-media-accept-accept-branch', 'sanguo-last-frame']
  const upgraded = upgradeSanguoVideoConcat(workflow)
  assert.equal(upgraded.schemaVersion, 141)
  assert.deepEqual(upgraded.nodes.map(node => node.id), ['sanguo-scene-loop', 'sanguo-video', 'sanguo-video-concat', 'review', 'sanguo-media-accept-accept-branch', 'sanguo-last-frame'])
  assert.deepEqual(upgraded.nodes[0].childIds, ['sanguo-video', 'sanguo-video-concat', 'review', 'sanguo-media-accept-accept-branch', 'sanguo-last-frame'])
  const concat = upgraded.nodes[2]
  assert.equal(concat.kind, 'videoConcat'); assert.equal(concat.operation, 'video.concat'); assert.equal(concat.resultVar, 'stage_video'); assert.equal(concat.loopResultMode, 'latest')
  assert.equal(concat.params.find(param => param.englishName === 'currentVideo')?.value, '${video_shot}')
  assert.equal(concat.params.find(param => param.englishName === 'previousVideo')?.value, '${loop.previous.stage_video}')
  assert.equal(concat.params.find(param => param.englishName === 'aspectRatio')?.value, '${input.aspect_ratio}')
  assert.equal(concat.params.find(param => param.englishName === 'resolution')?.value, '720p')
  assert.ok(!upgraded.edges.some(edge => edge.from === 'sanguo-video' && edge.to === 'sanguo-video-concat'))
  assert.ok(upgraded.edges.some(edge => edge.from === 'sanguo-media-accept-accept-branch' && edge.to === 'sanguo-video-concat' && edge.branch === 'true'))
  assert.ok(upgraded.edges.some(edge => edge.from === 'sanguo-video-concat' && edge.to === 'sanguo-last-frame'))
  assert.equal(upgradeSanguoVideoConcat(upgraded), upgraded)
})

test('schema 141 repairs the persisted concat binding without touching the producer', () => {
  const video = { id: 'sanguo-video', title: '参考生视频', kind: 'video', resultVar: 'video_take', prompt: '', params: [], uploads: [],
    loop: { enabled: false, sourcePath: '', fallbackCount: 0, itemVar: 'item' }, position: { x: 0, y: 0 }, parentId: 'sanguo-scene-loop' }
  const concat = { ...sanguoVideoConcatNode(video), params: [
    { id: 'previous', name: '上一轮阶段视频', englishName: 'previousVideo', type: 'json', required: false, value: '${loop.previous.stage_video}' },
    { id: 'current', name: '本轮分镜视频', englishName: 'currentVideo', type: 'json', required: true, value: '${video_shot}' },
  ] }
  const workflow = { id: 'wf-sanguo-history-drama', schemaVersion: 138, nodes: [video, concat], edges: [] }
  const upgraded = upgradeSanguoVideoConcat(workflow)
  assert.equal(upgraded.schemaVersion, 141)
  assert.equal(upgraded.nodes[1].params.find(param => param.englishName === 'currentVideo')?.value, '${video_shot}')
  assert.equal(upgraded.nodes[0], video)
})

test('schema 143 restores video to media evidence after moving concat behind acceptance', () => {
  const baseNode = (id: string, kind = 'code') => ({ id, title: id, kind, resultVar: id.replaceAll('-', '_'), prompt: '', params: [], uploads: [],
    loop: { enabled: false, sourcePath: '', fallbackCount: 0, itemVar: 'item' }, position: { x: 0, y: 0 }, parentId: 'sanguo-scene-loop' })
  const workflow = {
    id: 'wf-sanguo-history-drama', schemaVersion: 142,
    nodes: [baseNode('sanguo-video', 'video'), baseNode('sanguo-video-concat', 'videoConcat'), baseNode('sanguo-media-request')],
    edges: [
      { id: 'stale-video-concat', from: 'sanguo-video', to: 'sanguo-video-concat' },
      { id: 'stale-concat-evidence', from: 'sanguo-video-concat', to: 'sanguo-media-request' },
    ],
  }
  const repaired = repairSanguoVideoMediaRoute(workflow)
  assert.equal(repaired.schemaVersion, 143)
  assert.ok(repaired.edges.some(edge => edge.from === 'sanguo-video' && edge.to === 'sanguo-media-request'))
  assert.ok(!repaired.edges.some(edge => edge.from === 'sanguo-video' && edge.to === 'sanguo-video-concat'))
  assert.ok(!repaired.edges.some(edge => edge.from === 'sanguo-video-concat' && edge.to === 'sanguo-media-request'))
  assert.equal(repairSanguoVideoMediaRoute(repaired), repaired)
})
