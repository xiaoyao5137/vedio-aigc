import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import ffmpeg from 'ffmpeg-static'
import { collectStoryVocalEvidence } from '../server/story-vocal-evidence.ts'
import { applyStoryVocalReviewGate, reviewStoryShotVideo } from '../server/story-media-review.ts'
import type { StoryVocalBeat } from '../src/story-shot-vocals.ts'

const exec = promisify(execFile)
const beats: StoryVocalBeat[] = [
  { id: 'cat', speaker: '芙伊', utterance: '喵儿', startSecond: .8, endSecond: 1.3,
    visualBeatId: 'first', responseTo: null },
  { id: 'dog', speaker: '卷毛', utterance: '旺', startSecond: 2.5, endSecond: 3,
    visualBeatId: 'second', responseTo: 'cat' },
]

test('source-bound timed clips expose silence without mislabeling a tone as a cat or dog', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'story-vocals-'))
  const generated = path.join(root, 'public/generated')
  await mkdir(generated, { recursive: true })
  const file = path.join(generated, 'source.mp4')
  try {
    const audio = '0.2*sin(2*PI*440*t)*between(t\\,0.8\\,1.3)'
    await exec(ffmpeg!, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=180x320:r=8:d=5',
      '-f', 'lavfi', '-i', `aevalsrc=${audio}:s=44100:d=5`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest', file], { timeout: 30_000 })
    const sha256 = createHash('sha256').update(await readFile(file)).digest('hex')
    const result = await collectStoryVocalEvidence({ url: '/generated/source.mp4', sha256, duration: 5 }, beats, root)
    assert.equal(result.sourceVideoSha256, sha256)
    assert.equal(result.acousticStatus, 'silent-window')
    assert.equal(result.windows[0].acousticStatus, 'signal-present')
    assert.equal(result.windows[1].acousticStatus, 'silent-window')
    assert.equal(result.semanticStatus, 'unverified')
    assert.equal(result.lipSyncStatus, 'unverified')
    for (const window of result.windows) {
      assert.match(window.audioUrl, /^\/generated\/story-vocal-[a-f0-9]{20}\.wav$/)
      assert.equal(window.audioSha256, createHash('sha256').update(await readFile(path.join(root, 'public', window.audioUrl))).digest('hex'))
    }
    let visualCalls = 0
    const shot = { title: '舍友回应', content: '芙伊抬头看向卷毛；卷毛从沙发起身回应。',
      camera: '固定机位', mood: '舍友在家', firstFramePrompt: '芙伊在桌前，卷毛在沙发。', duration: 5,
      audioContractVersion: 'animal-interaction-v1', vocalBeats: beats,
      visualBeats: [
        { id: 'first', action: '芙伊抬头看向卷毛', completion: '芙伊正看向卷毛', startSecond: 0, endSecond: 2 },
        { id: 'second', action: '卷毛从沙发起身回应', completion: '卷毛站在沙发边', startSecond: 2, endSecond: 4 },
      ] }
    const review = await reviewStoryShotVideo({ shot, videoUrl: '/generated/source.mp4', root,
      model: { id: 'vision', provider: 'Codex', capability: 'text' },
      execute: async () => { visualCalls++; throw Error('no visual review for silent vocal slot') } })
    assert.equal(review.reviewStatus, 'technical-failure')
    assert.equal(review.vocalEvidence?.acousticStatus, 'silent-window')
    assert.equal(visualCalls, 0)
    await assert.rejects(() => collectStoryVocalEvidence({ url: '/generated/source.mp4', sha256: '0'.repeat(64), duration: 5 }, beats, root),
      /SOURCE_CHANGED/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a visual pass plus non-silent audio is still pending same-material animal-call listening', () => {
  const visual = { passed: true, reviewStatus: 'passed' as const, retryable: false, issues: [] }
  const acoustic = { acousticStatus: 'signal-present', semanticStatus: 'unverified', lipSyncStatus: 'unverified' }
  const gated = applyStoryVocalReviewGate(visual, acoustic as never)
  assert.equal(gated.passed, false)
  assert.equal(gated.reviewStatus, 'uncertain')
  assert.match(gated.issues[0], /尚未证实.*叫声.*口型同步/)
  assert.deepEqual(applyStoryVocalReviewGate({ ...visual, passed: false, reviewStatus: 'incomplete' as const,
    issues: ['visual failure'] }, acoustic as never).issues, ['visual failure'])
})

test('untimed voice plan samples its whole linked plot segment for human listening', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'story-vocals-segment-'))
  const generated = path.join(root, 'public/generated')
  await mkdir(generated, { recursive: true })
  try {
    const file = path.join(generated, 'source.mp4')
    await exec(ffmpeg!, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=180x320:r=8:d=5',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest', file], { timeout: 30_000 })
    const sha256 = createHash('sha256').update(await readFile(file)).digest('hex')
    const untimed = beats.map(({ startSecond: _start, endSecond: _end, ...beat }) => beat)
    const result = await collectStoryVocalEvidence({ url: '/generated/source.mp4', sha256, duration: 5 },
      untimed, root, [{ id: 'first', startSecond: 0, endSecond: 2 },
        { id: 'second', startSecond: 2, endSecond: 4 }])
    assert.deepEqual(result.windows.map(window => [window.startSecond, window.endSecond]), [[0, 2], [2, 4]])
    assert.equal(result.semanticStatus, 'unverified')
  } finally { await rm(root, { recursive: true, force: true }) }
})
