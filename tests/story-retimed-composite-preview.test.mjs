import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import ffmpeg from 'ffmpeg-static'
import { assertApplyCas, assertVideoFrames, buildPlan, parseArgs, parseFrameMd5,
  duckVolumeExpression, renderDerivative } from '../scripts/preview-story-retimed-composite.mjs'

const run = promisify(execFile)
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const hash = value => sha256(JSON.stringify(value))

test('dry-run is default and apply needs all reviewed source hashes', () => {
  const base = ['--source-record', 'record-test', '--video', '/generated/source.mp4',
    '--evidence', '/generated/evidence.json']
  assert.equal(parseArgs(base).apply, false)
  assert.throws(() => parseArgs([...base, '--apply']), /expected-plan-sha256/)
  assert.throws(() => parseArgs([...base, '--dog-wav', '/generated/dog.wav']), /dog clip needs a QA WAV/)
  assert.throws(() => parseArgs([...base, '--video', '/generated/other.mp4']), /duplicate/)
  assert.throws(() => parseArgs([...base, '--duck-v4-meow']), /requires a disclosed dog WAV/)
  assert.equal(parseArgs([...base, '--source-end-frame-second', '9']).sourceEndFrameSecond, 9)
  assert.throws(() => parseArgs([...base, '--source-end-frame-second', '20']), /source-end-frame-second/)
})

test('alternate plan binds the native vocal duck and rejects overlay outside its quiet plateau', () => {
  const frames = Array.from({ length: 289 }, (_, i) => ({ second: i / 24, hash: i.toString(16).padStart(32, '0') }))
  const input = {
    record: { id: 'record-test', md5: 'e'.repeat(32), videoRunId: 'video-0', imageRunId: 'image-0', videoOutputSha256: 'f'.repeat(64) },
    image: { url: '/generated/image.png', sha256: 'c'.repeat(64) },
    video: { url: '/generated/source.mp4', sha256: 'a'.repeat(64), duration: 12.04, width: 720, height: 1280, fps: 24, frames },
    evidence: { url: '/generated/source.mp4', sha256: 'a'.repeat(64), duration: 12.04, width: 720, height: 1280,
      decoded: true, evidenceUrl: '/generated/evidence.json', receiptSha256: 'b'.repeat(64) },
    dog: { recordId: 'record-old', recordMd5: '1'.repeat(32), path: 'qa/story-roommates-20260930/dog.wav',
      sourceVideoUrl: '/generated/old.mp4', sourceVideoSha256: '2'.repeat(64),
      sourceEvidenceUrl: '/generated/old-evidence.json', sourceEvidenceSha256: '3'.repeat(64),
      extractStart: 7, extractDuration: .5, pcmSha256: '4'.repeat(64), sha256: 'd'.repeat(64), duration: .5 },
    dogAt: 3.95, duckV4Meow: true,
  }
  const alternate = buildPlan(input)
  const original = buildPlan({ ...input, duckV4Meow: false })
  assert.notEqual(alternate.planSha256, original.planSha256)
  assert.equal(alternate.plan.audio.nativeSourceAudioDuck.floorGain, .04)
  assert.throws(() => buildPlan({ ...input, dogAt: 3.2 }), /duck plateau/)
  assert.match(duckVolumeExpression(alternate.plan.audio.nativeSourceAudioDuck), /if\(lt\(t,3\.6\)/)
})

test('plan fixes the one-second trim and two-second hold, and CAS refuses drift', () => {
  const frames = Array.from({ length: 289 }, (_, i) => ({ second: i / 24, hash: i.toString(16).padStart(32, '0') }))
  const videoHash = 'a'.repeat(64), evidenceHash = 'b'.repeat(64), imageHash = 'c'.repeat(64)
  const dogHash = 'd'.repeat(64)
  const { plan, planSha256, retained } = buildPlan({
    record: { id: 'record-test', md5: 'e'.repeat(32), videoRunId: 'video-0', imageRunId: 'image-0', videoOutputSha256: 'f'.repeat(64) },
    image: { url: '/generated/image.png', sha256: imageHash },
    video: { url: '/generated/source.mp4', sha256: videoHash, duration: 12.04, width: 720, height: 1280, fps: 24, frames },
    evidence: { url: '/generated/source.mp4', sha256: videoHash, duration: 12.04, width: 720, height: 1280,
      decoded: true, evidenceUrl: '/generated/evidence.json', receiptSha256: evidenceHash },
    dog: { recordId: 'record-old', recordMd5: '1'.repeat(32), path: 'qa/story-roommates-20260930/dog.wav',
      sourceVideoUrl: '/generated/old.mp4', sourceVideoSha256: '2'.repeat(64),
      sourceEvidenceUrl: '/generated/old-evidence.json', sourceEvidenceSha256: '3'.repeat(64),
      extractStart: 7, extractDuration: .5, pcmSha256: '4'.repeat(64), sha256: dogHash, duration: .5 }, dogAt: 3.2,
  })
  assert.equal(plan.edit.targetDuration, 13.04)
  assert.equal(retained[0].second, 1)
  assert.equal(plan.audio.mode, 'composite-two-source-candidate')
  assert.equal(plan.acceptance.humanAccepted, false)
  assert.equal(planSha256, hash(plan))
  const shorter = buildPlan({
    record: { id: 'record-test', md5: 'e'.repeat(32), videoRunId: 'video-0', imageRunId: 'image-0', videoOutputSha256: 'f'.repeat(64) },
    image: { url: '/generated/image.png', sha256: imageHash },
    video: { url: '/generated/source.mp4', sha256: videoHash, duration: 12.04, width: 720, height: 1280, fps: 24, frames },
    evidence: { url: '/generated/source.mp4', sha256: videoHash, duration: 12.04, width: 720, height: 1280,
      decoded: true, evidenceUrl: '/generated/evidence.json', receiptSha256: evidenceHash },
    sourceEndFrameSecond: 9,
  })
  assert.equal(shorter.plan.edit.targetDuration, 10.04)
  assert.equal(shorter.plan.edit.sourceEndFrameSecond, 9)
  assert.equal(shorter.retained.length, 193)
  const cas = { 'expected-plan-sha256': planSha256, 'expected-record-md5': plan.record.resultMd5,
    'expected-video-sha256': videoHash, 'expected-evidence-sha256': evidenceHash,
    'expected-image-sha256': imageHash, 'expected-dog-record-md5': plan.audio.dogSourceRecordMd5,
    'expected-dog-source-video-sha256': plan.audio.dogSourceVideoSha256,
    'expected-dog-source-evidence-sha256': plan.audio.dogSourceEvidenceSha256,
    'expected-dog-wav-sha256': dogHash }
  assert.doesNotThrow(() => assertApplyCas(cas, { plan, planSha256 }))
  assert.throws(() => assertApplyCas({ ...cas, 'expected-dog-wav-sha256': '0'.repeat(64) }, { plan, planSha256 }), /changed since dry run/)
})

test('lossless local derivative keeps the decoded source suffix and clones its last frame', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'story-retimed-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const source = path.join(dir, 'source.mp4'), dog = path.join(dir, 'dog.wav'), output = path.join(dir, 'preview.mp4')
  await run(ffmpeg, ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=180x320:rate=10:duration=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3', '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source])
  await run(ffmpeg, ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=16000:duration=0.5',
    '-ac', '1', dog])
  const sourceHash = sha256(await readFile(source)), dogHash = sha256(await readFile(dog))
  await renderDerivative({ sourceFile: source, dogFile: dog, outputFile: output, targetDuration: 4,
    dogAt: 1.2, trimSeconds: 1, holdSeconds: 2 })
  const frameMd5 = async file => parseFrameMd5((await run(ffmpeg, ['-hide_banner', '-v', 'error', '-i', file,
    '-map', '0:v:0', '-f', 'framemd5', '-'])).stdout)
  const before = await frameMd5(source), after = await frameMd5(output)
  const proof = assertVideoFrames(before, after, 1, 2, 10)
  assert.equal(proof.retainedFrameCount, 20)
  assert.equal(proof.heldFrameCount, 20)
  assert.equal(proof.everyRetainedDecodedFrameMatched, true)
  assert.equal(sha256(await readFile(source)), sourceHash)
  assert.equal(sha256(await readFile(dog)), dogHash)
  const measured = await run(ffmpeg, ['-hide_banner', '-i', output, '-map', '0:a:0', '-f', 'null', '-'])
  assert.match(measured.stderr, /Audio:/)
  assert.match(measured.stderr, /Duration: 00:00:04\.0/)
})

test('crossfaded source-audio duck lowers the unwanted window without affecting neighboring audio', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'story-duck-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const source = path.join(dir, 'source.mp4'), plain = path.join(dir, 'plain.mp4'), ducked = path.join(dir, 'ducked.mp4')
  await run(ffmpeg, ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=180x320:r=10:d=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3', '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source])
  await renderDerivative({ sourceFile: source, outputFile: plain, targetDuration: 4,
    trimSeconds: 1, holdSeconds: 2 })
  const duck = { startSecond: .6, endSecond: 1.6, fadeSeconds: .1, floorGain: .04 }
  await renderDerivative({ sourceFile: source, outputFile: ducked, targetDuration: 4,
    trimSeconds: 1, holdSeconds: 2, duck })
  const rms = async (file, start, length) => {
    const { stdout } = await run(ffmpeg, ['-hide_banner', '-v', 'error', '-i', file, '-ss', String(start),
      '-t', String(length), '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'], { encoding: 'buffer', maxBuffer: 1024 * 1024 })
    let sum = 0
    for (let i = 0; i < stdout.length; i += 4) { const sample = stdout.readFloatLE(i); sum += sample * sample }
    return Math.sqrt(sum / (stdout.length / 4))
  }
  const beforePlain = await rms(plain, .2, .2), beforeDuck = await rms(ducked, .2, .2)
  const middlePlain = await rms(plain, 1.0, .2), middleDuck = await rms(ducked, 1.0, .2)
  assert.ok(beforeDuck / beforePlain > .8)
  assert.ok(middleDuck / middlePlain < .12)
})

test('optional exact source end frame keeps the bounded source interval and holds that endpoint', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'story-end-cut-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const source = path.join(dir, 'source.mp4'), output = path.join(dir, 'short.mp4')
  await run(ffmpeg, ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=180x320:rate=10:duration=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3', '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source])
  await renderDerivative({ sourceFile: source, outputFile: output, targetDuration: 3.1,
    trimSeconds: 1, holdSeconds: 2, sourceEndExclusiveSecond: 2.1 })
  const frameMd5 = async file => parseFrameMd5((await run(ffmpeg, ['-hide_banner', '-v', 'error', '-i', file,
    '-map', '0:v:0', '-f', 'framemd5', '-'])).stdout)
  const sourceFrames = await frameMd5(source), outputFrames = await frameMd5(output)
  const proof = assertVideoFrames(sourceFrames, outputFrames, 1, 2, 10, 2)
  assert.equal(proof.retainedFrameCount, 11)
  assert.equal(proof.heldFrameCount, 20)
  const { stderr } = await run(ffmpeg, ['-hide_banner', '-i', output, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'])
  assert.match(stderr, /Duration: 00:00:03\.1/)
})
