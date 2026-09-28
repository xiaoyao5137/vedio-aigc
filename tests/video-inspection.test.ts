import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, readdir, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { collectOptionalSpeechEvidence, collectVideoEvidence, inspectGeneratedVideo, parseFfmpegMetadata, resolveVideoSamplingPlan, samplingEvidenceKey, validateVideoMetadata } from '../server/video-inspection.ts'
import { parseNativeFrameMetadata, resolveNativeSequenceConfig, selectNativeReviewFrames, type NativeFrameArchive } from '../server/native-video-sequence.ts'
const require = createRequire(import.meta.url)

test('only the explicit principle policy records ASR errors as unavailable evidence', async () => {
  const failures = [new Error('实际人声自检尚未安装'), new Error('ASR timed out'), new SyntaxError('invalid recognition JSON')]
  for (const failure of failures) {
    const transcribe = async () => { throw failure }
    assert.deepEqual(await collectOptionalSpeechEvidence(transcribe, 'principle-v1'), {
      speechEvidenceStatus: 'unavailable', speechEvidenceError: failure.message,
    })
    for (const mode of [undefined, 'strict', 'principle-v2']) {
      await assert.rejects(collectOptionalSpeechEvidence(transcribe, mode), error => error === failure)
    }
  }
  const speech = { speechValidation: { passed: false, issues: ['缺字'], alignment: [] }, segments: [{ text: '实际识别原文' }] }
  const before = structuredClone(speech)
  assert.deepEqual(await collectOptionalSpeechEvidence(async () => speech, 'principle-v1'), {
    speechValidation: speech.speechValidation, transcript: speech.segments, speechMetrics: [],
  })
  assert.deepEqual(speech, before)
  for (const invalid of [null, {}, { speechValidation: { alignment: 'malformed' } }]) {
    const result = await collectOptionalSpeechEvidence(async () => invalid, 'principle-v1')
    assert.equal(result.speechEvidenceStatus, 'unavailable')
    assert.equal(result.speechValidation, undefined)
    assert.equal(result.transcript, undefined)
  }
})

test('principle ASR unavailability preserves decoded audio and real frames without hiding media failures', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'principle-asr-evidence-'))
  try {
    const dir = path.join(root, 'public/generated'), ffmpeg = require('ffmpeg-static') as string
    await mkdir(dir, { recursive: true })
    execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:d=1', '-f', 'lavfi', '-i', 'sine=frequency=600:duration=1',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(dir, 'source.mp4')])
    const options = { url: '/generated/source.mp4', audioText: '完整原文', qualityMode: 'principle-v1' }
    const report = await collectVideoEvidence(options, root)
    assert.equal(report.decoded, true)
    assert.equal(report.sha256, createHash('sha256').update(await readFile(path.join(root, 'public', report.url))).digest('hex'))
    assert.equal(report.hasAudio, true)
    assert.equal(report.speechEvidenceStatus, 'unavailable')
    assert.match(report.speechEvidenceError!, /尚未安装/)
    assert.equal(report.speechValidation, undefined)
    assert.equal(report.frames.length, 6)
    for (const frame of report.frames) assert.ok((await stat(path.join(root, 'public', frame))).size > 0)
    const saved = JSON.parse(await readFile(path.join(root, 'public', report.evidenceUrl), 'utf8'))
    assert.equal(saved.sha256, report.sha256)
    assert.equal(saved.speechEvidenceStatus, 'unavailable')
    assert.equal(saved.speechValidation, undefined)
    await assert.rejects(collectVideoEvidence({ ...options, qualityMode: undefined }, root), /尚未安装/)
    await assert.rejects(collectVideoEvidence({ ...options, url: '/generated/missing.mp4' }, root), /ENOENT/)
    await writeFile(path.join(dir, 'corrupt.mp4'), 'not a video')
    await assert.rejects(collectVideoEvidence({ ...options, url: '/generated/corrupt.mp4' }, root), /Invalid data|moov atom|Invalid argument/)
    const blockedFrame = path.join(root, 'public', report.frames[0])
    await rm(blockedFrame)
    await mkdir(blockedFrame)
    await assert.rejects(collectVideoEvidence(options, root), /Command failed|Could not|Error|Is a directory/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('dynamic 3 and 8 second clips produce six decodable frames within their actual duration', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'history-short-video-qa-'))
  try {
    const dir = path.join(root, 'public/generated')
    await mkdir(dir, { recursive: true })
    const ffmpeg = require('ffmpeg-static') as string
    for (const duration of [3, 8]) {
      const filename = `short-${duration}.mp4`
      execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', `color=c=blue:s=320x180:d=${duration}`, '-f', 'lavfi', '-i', `sine=frequency=600:duration=${duration}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(dir, filename)])
      const report = await inspectGeneratedVideo({ url: `/generated/${filename}`, duration, aspectRatio: '16:9', pacing: { version: 'dynamic-v1' } }, root)
      assert.ok(Math.abs(report.duration - duration) < 0.1)
      assert.equal(report.frames.length, 6)
      assert.equal(new Set(report.frames).size, 6)
      for (const frame of report.frames) {
        const framePath = path.join(root, 'public', frame)
        assert.ok((await stat(framePath)).size > 0)
        execFileSync(ffmpeg, ['-v', 'error', '-i', framePath, '-f', 'null', '-'])
      }
      assert.equal(report.lastFrameUrl, report.frames.at(-1))
      assert.equal(report.technicalValidation.speechVerified, false)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('actual metadata, not requested sound or simulated SVG, controls technical acceptance', () => {
  assert.throws(() => validateVideoMetadata({ format: { duration: 15 }, streams: [] }, 15, '16:9', true), /没有可解码视频流/)
  const metadata = parseFfmpegMetadata('Duration: 00:00:15.04, start: 0\nStream #0:0: Video: h264, yuv420p, 1920x1080 [SAR 1:1 DAR 16:9], 30 fps\nStream #0:1: Audio: aac, 44100 Hz')
  assert.equal(validateVideoMetadata(metadata, 15, '16:9', true).hasAudio, true)
  assert.throws(() => validateVideoMetadata(metadata, 8, '16:9', true), /实际时长/)
  assert.throws(() => validateVideoMetadata(metadata, 15, '9:16', true), /实际画幅/)
})

test('real decoder extracts a tail from an MP4 and rejects silent bytes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'history-video-qa-'))
  try {
    const dir = path.join(root, 'public/generated')
    await mkdir(dir, { recursive: true })
    const ffmpeg = require('ffmpeg-static') as string
    execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=320x180:d=15', '-f', 'lavfi', '-i', 'sine=frequency=600:duration=15', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(dir, 'good.mp4')])
    const report = await inspectGeneratedVideo({ url: '/generated/good.mp4', duration: 15, aspectRatio: '16:9' }, root)
    assert.equal(report.frames.length, 6)
    assert.equal(report.hasAudio, true)
    assert.equal(report.technicalValidation.speechVerified, false)
    execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=320x180:d=15', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(dir, 'silent.mp4')])
    await assert.rejects(() => inspectGeneratedVideo({ url: '/generated/silent.mp4', duration: 15, aspectRatio: '16:9' }, root), /没有真实音轨/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('explicit sample times preserve bounded window evidence and always end on the actual decodable tail', () => {
  const plan = resolveVideoSamplingPlan({ sampleTimes: [14, 5.4, 1, 5.4, 13.1, 0, 3.2] }, 14.04)
  assert.equal(plan.mode, 'sample-times')
  assert.deepEqual(plan.times, [0, 1, 3.2, 5.4, 13.1, 13.96])
  assert.equal(plan.times.at(-1), 13.96, 'requested 14 seconds clamps to the actual safe tail at 13.96')
  const nearTail = resolveVideoSamplingPlan({ sampleTimes: [14.04, 14, 13.96, 3, 3] }, 14.04)
  assert.deepEqual(nearTail.times, [0, 3, 13.96])
  const noEndpoints = resolveVideoSamplingPlan({ sampleTimes: [1.1, 1.3] }, 3)
  assert.deepEqual(noEndpoints.times, [0, 1.1, 1.3, 2.92])
  const fractions = resolveVideoSamplingPlan({ frameFractions: [.8, .2, .2] }, 3)
  assert.deepEqual(fractions.times, [0, .6, 2.4, 2.92])
})

test('default six-frame times remain exactly unchanged while invalid or oversized plans fail without truncation', () => {
  const duration = 14.04
  assert.deepEqual(resolveVideoSamplingPlan({}, duration).times, [0, .2, .45, .7, .9, 1].map(f => Math.min(Number((duration * f).toFixed(2)), Math.max(0, duration - .08))))
  for (const sampleTimes of [[], null, '1,2', [-1], [Number.NaN], [Number.POSITIVE_INFINITY], ['1'], [duration + .001]]) {
    assert.throws(() => resolveVideoSamplingPlan({ sampleTimes } as never, duration), /MEDIA_CONFIG_INVALID/)
  }
  for (const frameFractions of [[], null, [-.1], [1.1], [Number.NaN], ['.5']]) {
    assert.throws(() => resolveVideoSamplingPlan({ frameFractions } as never, duration), /MEDIA_CONFIG_INVALID/)
  }
  assert.throws(() => resolveVideoSamplingPlan({ sampleTimes: [1], frameFractions: [.5] }, duration), /不能同时配置/)
  for (const invalidDuration of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) assert.throws(() => resolveVideoSamplingPlan({ sampleTimes: [0] }, invalidDuration), /实际视频时长/)
  const interiors = Array.from({ length: 22 }, (_, index) => (index + 1) / 10)
  assert.equal(resolveVideoSamplingPlan({ sampleTimes: interiors }, 3).times.length, 24)
  assert.throws(() => resolveVideoSamplingPlan({ sampleTimes: [...interiors, 2.3] }, 3), /含实际首尾帧.*24.*禁止截断/)
  assert.throws(() => resolveVideoSamplingPlan({ sampleTimes: Array.from({ length: 25 }, (_, i) => i / 10) }, 3), /24.*禁止截断/)
  assert.deepEqual(resolveVideoSamplingPlan({ sampleTimes: Array(30).fill(1) }, 3).times, [0, 1, 2.92], 'duplicate requests do not spend the frame budget')
})

test('real re-sampling isolates frame/report/rejection paths and preserves default evidence while sharing downloaded MP4 bytes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'video-sampling-qa-'))
  try {
    const dir = path.join(root, 'public/generated')
    await mkdir(dir, { recursive: true })
    const ffmpeg = require('ffmpeg-static') as string
    execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=25:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(dir, 'source.mp4')])
    const url = '/generated/source.mp4'
    const key = createHash('sha256').update(url).digest('hex').slice(0, 20)
    const legacyReceipt = path.join(dir, `verified-${key}-evidence.json`)
    await writeFile(legacyReceipt, 'saved legacy report must survive the v2 namespace')
    const defaultReport = await collectVideoEvidence({ url }, root)
    assert.equal(defaultReport.frameTimeSemantics, 'requested-seek')
    assert.equal(defaultReport.url, `/generated/verified-${key}.mp4`)
    assert.match(defaultReport.evidenceUrl, new RegExp(`^/generated/verified-${key}-review-v2-[a-f0-9]{16}-evidence\\.json$`))
    assert.match(defaultReport.frames[0], new RegExp(`^/generated/verified-${key}-review-v2-[a-f0-9]{16}-frame-0\\.jpg$`))
    assert.equal(await readFile(legacyReceipt, 'utf8'), 'saved legacy report must survive the v2 namespace')
    const originalFiles = await Promise.all([...defaultReport.frames, defaultReport.evidenceUrl].map(async file => ({ file, bytes: await readFile(path.join(root, 'public', file)) })))
    const cachedVideo = await stat(path.join(root, 'public', defaultReport.url))
    // Re-sampling must use the existing cached download, not require source bytes again.
    await rm(path.join(dir, 'source.mp4'))
    const first = await collectVideoEvidence({ url, sampleTimes: [.4, .6, 1.3, 2] }, root)
    assert.equal(first.url, defaultReport.url)
    assert.deepEqual(first.frameTimes, [0, .4, .6, 1.3, 1.92])
    assert.equal(first.lastFrameUrl, first.frames.at(-1))
    assert.match(first.evidenceUrl, /-sampling-[a-f0-9]+-review-v2-[a-f0-9]+-evidence\.json$/)
    assert.ok(first.frames.every(file => !defaultReport.frames.includes(file)))
    assert.equal(first.samplingPlan.mode, 'sample-times')
    for (const frame of first.frames) execFileSync(ffmpeg, ['-v', 'error', '-i', path.join(root, 'public', frame), '-f', 'null', '-'])
    const second = await collectVideoEvidence({ url, sampleTimes: [.4, .7, 1.3, 2] }, root)
    assert.notEqual(first.evidenceUrl, second.evidenceUrl)
    assert.ok(second.frames.every(file => !first.frames.includes(file)))
    const reordered = await collectVideoEvidence({ url, sampleTimes: [2, .6, .4, 1.3, .6] }, root)
    assert.equal(reordered.evidenceUrl, first.evidenceUrl, 'equivalent reordered/deduplicated plans share their evidence namespace')
    const customFractions = await collectVideoEvidence({ url, frameFractions: [0, .2, .45, .7, .9, 1] }, root)
    assert.notEqual(customFractions.evidenceUrl, defaultReport.evidenceUrl, 'even explicit legacy-equivalent fractions are isolated from default evidence')
    assert.ok(customFractions.frames.every(file => !defaultReport.frames.includes(file)))
    let rejectionUrl = ''
    await assert.rejects(collectVideoEvidence({ url, sampleTimes: [2.1] }, root), (error: Error) => {
      assert.match(error.message, /不得超过实际视频时长/)
      rejectionUrl = error.message.match(/\/generated\/verified-[\w-]+-rejection\.json/)?.[0] ?? ''
      assert.match(rejectionUrl, /-sampling-/)
      return true
    })
    assert.ok((await stat(path.join(root, 'public', rejectionUrl))).size > 0)
    assert.equal((await stat(path.join(root, 'public', defaultReport.url))).mtimeMs, cachedVideo.mtimeMs)
    for (const original of originalFiles) assert.deepEqual(await readFile(path.join(root, 'public', original.file)), original.bytes, `prior evidence preserved: ${original.file}`)
    const compatible = await inspectGeneratedVideo({ url, duration: 2, aspectRatio: '16:9', requireAudio: false, sampleTimes: [.4, .6, 1.3, 2] }, root)
    assert.notEqual(compatible.evidenceUrl, first.evidenceUrl, 'a later speech-end contract cannot overwrite the earlier sampling receipt')
    assert.deepEqual(compatible.frameTimes, first.frameTimes)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('non-native evidence keys isolate every speech and opening comparison input', () => {
  const plan = { mode: 'sample-times' as const, requested: [0, .5, 1] }
  const base = { audioText: '张飞：何故不降', audioType: '对白', speechWindows: [{ start: .2, end: .8, text: '何故不降' }],
    latestSpeechEnd: .8, previousTail: '/generated/prior.jpg', qualityMode: 'principle-v1' }
  const first = samplingEvidenceKey('source', plan, base)
  assert.equal(samplingEvidenceKey('source', structuredClone(plan), structuredClone(base)), first)
  assert.notEqual(samplingEvidenceKey('source', { ...plan, requested: [0, .6, 1] }, base), first)
  for (const changed of [
    { audioText: '张飞：为何不降' }, { audioType: '旁白' },
    { speechWindows: [{ start: .3, end: .8, text: '何故不降' }] }, { latestSpeechEnd: .7 },
    { previousTail: '/generated/other.jpg' }, { qualityMode: 'strict' },
  ]) assert.notEqual(samplingEvidenceKey('source', plan, { ...base, ...changed }), first)
  assert.match(samplingEvidenceKey('source', { mode: 'default', requested: [.0, .2, .45, .7, .9, 1] }), /^source-review-v2-[a-f0-9]{16}$/)
})

test('same video and sample times retain separate immutable reports for revised speech windows', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'video-speech-contract-qa-'))
  try {
    const dir = path.join(root, 'public/generated'), ffmpeg = require('ffmpeg-static') as string
    await mkdir(dir, { recursive: true })
    execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=25:duration=2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(dir, 'source.mp4')])
    const source = { url: '/generated/source.mp4', sampleTimes: [0, .5, 1, 2], audioText: '张飞：何故不降',
      audioType: '对白', speechWindows: [{ start: .2, end: .8, text: '何故不降' }], latestSpeechEnd: .8 }
    const first = await collectVideoEvidence(source, root)
    const original = await readFile(path.join(root, 'public', first.evidenceUrl))
    const revised = await collectVideoEvidence({ ...source, speechWindows: [{ start: .3, end: .9, text: '何故不降' }] }, root)
    const later = await collectVideoEvidence({ ...source, latestSpeechEnd: 1.2 }, root)
    assert.equal(first.url, revised.url)
    assert.deepEqual(first.frameTimes, revised.frameTimes)
    assert.notEqual(first.evidenceUrl, revised.evidenceUrl)
    assert.notEqual(first.evidenceUrl, later.evidenceUrl)
    assert.notEqual(revised.evidenceUrl, later.evidenceUrl)
    assert.deepEqual(await readFile(path.join(root, 'public', first.evidenceUrl)), original, 'prior report must survive another review contract byte-for-byte')
    const reportPath = path.join(root, 'public', first.evidenceUrl), framePath = path.join(root, 'public', first.frames[0])
    const past = new Date('2000-01-01T00:00:00Z')
    await Promise.all([utimes(reportPath, past, past), utimes(framePath, past, past)])
    const repeated = await collectVideoEvidence(source, root)
    assert.equal(repeated.evidenceUrl, first.evidenceUrl)
    assert.deepEqual(await readFile(path.join(root, 'public', first.evidenceUrl)), original)
    assert.equal((await stat(reportPath)).mtimeMs, past.getTime())
    assert.equal((await stat(framePath)).mtimeMs, past.getTime())
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('native metadata uses integer PTS and rational time base, including irregular frame intervals', () => {
  const line = (index: number, pts: number) => `[showinfo] n: ${index} pts: ${pts} pts_time: rounded duration: 2 duration_time: 0.002 fmt:yuv420p s:160x90\n`
  const metadata = '[showinfo] config in time_base: 1/1000, frame_rate: 24/1\n'
  const result = parseNativeFrameMetadata(metadata + line(0, 1000) + line(1, 1002) + line(2, 1007))
  assert.deepEqual(result.frames.map(frame => frame.second), [0, .002, .007])
  assert.equal(result.firstPTS, 1000)
  assert.equal(result.frames[2].pts, 1007)
  assert.equal(result.timeBase, '1/1000')
  assert.throws(() => parseNativeFrameMetadata(metadata + line(0, 0) + line(2, 2)), /编号缺失/)
  assert.throws(() => parseNativeFrameMetadata(metadata + line(0, 0) + line(1, 0)), /PTS 非严格递增/)
})

test('native sequence keeps every window frame and legacy coverage point without calling seek times actual PTS', () => {
  const frames = Array.from({ length: 337 }, (_, nativeFrameIndex) => ({ nativeFrameIndex, pts: nativeFrameIndex * 512, timeBase: '1/12288', durationPTS: 512,
    second: nativeFrameIndex / 24, width: 1280, height: 720, url: `/generated/frame-${nativeFrameIndex}.jpg`, sourceSha256: 'a'.repeat(64), byteLength: 1 }))
  const archive: NativeFrameArchive = { version: 1, complete: true, sourceVideoSha256: 'b'.repeat(64), sourceVideoUrl: '/generated/source.mp4', decoder: 'fixture',
    recipe: 'fixture', timeBase: '1/12288', firstPTS: 0, metadataText: '', frames, totalBytes: 337 }
  const nativeSequence = { enabled: true, windows: [{ start: 1, end: 5.4 }, { start: 13.1, end: 14.04 }] }
  const config = resolveNativeSequenceConfig(nativeSequence)!
  const actual24 = [0, .5, 1, 1.55, 2.1, 2.65, 3.2, 3.75, 4.3, 4.85, 5.4, 7.6, 9.8, 10.2125, 10.625, 11.0375, 11.45, 11.8625, 12.275, 12.6875, 13.1, 13.325, 13.55, 13.96]
  const before = structuredClone({ archive, config, actual24 })
  const result = selectNativeReviewFrames(archive, actual24, config, 14.04)
  assert.equal(result.frameReferences.length, 141)
  assert.deepEqual(result.windows[0].nativeFrameIndices, Array.from({ length: 106 }, (_, index) => 24 + index))
  assert.deepEqual(result.windows[1].nativeFrameIndices, Array.from({ length: 23 }, (_, index) => 314 + index))
  assert.deepEqual(result.windows[1].ptsInWindowNativeFrameIndices, Array.from({ length: 22 }, (_, index) => 315 + index))
  assert.deepEqual(result.windows[1].boundaryContextNativeFrameIndices, [314])
  assert.deepEqual(result.windows[1].uncoveredDisplaySpans, [])
  assert.equal(result.windows[1].complete, true)
  assert.equal(result.windows[1].observedEndSecond, 14)
  assert.deepEqual(result.windows[1].boundarySpansWithoutFramePTS.at(-1), { start: 14, end: 14.04 })
  assert.equal(result.preservedSamples.at(-1)?.actualSecond, 14)
  assert.equal(result.preservedSamples.at(-1)?.requestedSecond, 13.96)
  assert.equal(result.preservedSamples.at(-1)?.nativeFrameIndex, 336)
  assert.ok(result.preservedSamples.every(sample => result.frameReferences[sample.evidenceIndex].nativeFrameIndex === sample.nativeFrameIndex))
  assert.deepEqual({ archive, config, actual24 }, before)
  const reused = resolveVideoSamplingPlan({ sampleTimes: result.frameReferences.map(frame => frame.second), nativeSequence }, 14.04)
  const kept = selectNativeReviewFrames(archive, reused.times, { ...config, windows: [{ start: 0, end: 0 }] }, 14.04)
  assert.deepEqual(kept.frameReferences.map(frame => frame.nativeFrameIndex), result.frameReferences.map(frame => frame.nativeFrameIndex), 'a later native request retains all prior native PTS without six-decimal rounding into the next frame')
  assert.throws(() => selectNativeReviewFrames(archive, actual24, { ...config, reviewMaxFrames: 140 }, 14.04), /141.*reviewMaxFrames=140.*未截断/)
  assert.throws(() => selectNativeReviewFrames(archive, actual24, { ...config, windows: [{ start: 14, end: 15 }] }, 14.04), /不得超过实际视频时长/)
  assert.equal(resolveNativeSequenceConfig({ enabled: false }), undefined)
  for (const value of [{}, { enabled: true, windows: [] }, { ...nativeSequence, reviewMaxFrames: 0 }, { ...nativeSequence, archiveMaxFrames: 10001 },
    { ...nativeSequence, archiveMaxBytes: 0 }, { ...nativeSequence, decodeTimeoutMs: 120001 }]) assert.throws(() => resolveNativeSequenceConfig(value), /MEDIA_NATIVE_SEQUENCE_INVALID/)
})

test('real native decoding archives every source frame, preserves old files, and exposes sorted source-hashed review frames', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'native-sequence-qa-'))
  try {
    const dir = path.join(root, 'public/generated'), ffmpeg = require('ffmpeg-static') as string
    await mkdir(dir, { recursive: true })
    execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=24:duration=0.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(dir, 'native.mp4')])
    const url = '/generated/native.mp4', sampleTimes = [.07, .25]
    const old = await collectVideoEvidence({ url, sampleTimes }, root)
    const saved = await Promise.all([...old.frames, old.evidenceUrl].map(async file => ({ file, bytes: await readFile(path.join(root, 'public', file)) })))
    const nativeSequence = { enabled: true, windows: [{ start: .125, end: 1 / 3 }], reviewMaxFrames: 20 }
    const result = await collectVideoEvidence({ url, sampleTimes, nativeSequence }, root)
    assert.equal(result.evidenceVersion, 2)
    assert.equal(result.frameTimeSemantics, 'native-pts-relative-to-first-frame')
    assert.notEqual(result.evidenceUrl, old.evidenceUrl)
    const differentAudioType = await collectVideoEvidence({ url, sampleTimes, nativeSequence, audioType: '对白' }, root)
    const differentQualityMode = await collectVideoEvidence({ url, sampleTimes, nativeSequence, qualityMode: 'principle-v1' }, root)
    assert.notEqual(differentAudioType.evidenceUrl, result.evidenceUrl)
    assert.notEqual(differentQualityMode.evidenceUrl, result.evidenceUrl)
    assert.notEqual(differentQualityMode.evidenceUrl, differentAudioType.evidenceUrl)
    assert.equal(result.nativeSequence?.totalNativeFrames, 12)
    const refs = result.frameReferences!
    assert.deepEqual(refs.map(frame => frame.nativeFrameIndex), [0, 2, 3, 4, 5, 6, 7, 8, 11])
    assert.deepEqual(result.frameTimes, refs.map(frame => frame.second))
    assert.deepEqual(result.frames, refs.map(frame => frame.url))
    assert.equal(result.frameTimes.at(-1), 11 / 24)
    assert.ok(!result.frameTimes.includes(.07))
    for (const [index, frame] of refs.entries()) {
      assert.equal(frame.index, index)
      assert.equal(frame.evidenceIndex, index)
      const bytes = await readFile(path.join(root, 'public', frame.url))
      assert.equal(createHash('sha256').update(bytes).digest('hex'), frame.sourceSha256)
      assert.equal(frame.byteLength, bytes.length)
    }
    for (const sample of result.nativeSequence!.preservedSamples) {
      const oldIndex = old.frameTimes.indexOf(sample.requestedSecond)
      const bytes = await readFile(path.join(root, 'public', old.frames[oldIndex]))
      assert.equal(createHash('sha256').update(bytes).digest('hex'), refs[sample.evidenceIndex].sourceSha256, 'each retained legacy seek maps to the identical native JPEG bytes')
    }
    const archivePath = path.join(root, 'public', result.nativeSequence!.archiveUrl), archiveBytes = await readFile(archivePath)
    const archive = JSON.parse(archiveBytes.toString('utf8')) as NativeFrameArchive
    assert.equal(archive.frames.length, 12)
    assert.equal(archive.complete, true)
    assert.equal(createHash('sha256').update(archiveBytes).digest('hex'), result.nativeSequence!.archiveSha256)
    const sourceBytes = await readFile(path.join(root, 'public', result.nativeSequence!.sourceVideoUrl))
    assert.equal(createHash('sha256').update(sourceBytes).digest('hex'), result.nativeSequence!.sourceVideoSha256)
    assert.deepEqual(await readFile(path.join(dir, 'native.mp4')), sourceBytes)
    const again = await collectVideoEvidence({ url, sampleTimes, nativeSequence }, root)
    assert.equal(again.evidenceUrl, result.evidenceUrl)
    assert.deepEqual(await readFile(archivePath), archiveBytes)
    for (const file of saved) assert.deepEqual(await readFile(path.join(root, 'public', file.file)), file.bytes)
    await assert.rejects(collectVideoEvidence({ url, sampleTimes, nativeSequence: { ...nativeSequence, archiveMaxFrames: 2 } }, root), /超过 archiveMaxFrames/)
    const tamperedPath = path.join(root, 'public', archive.frames[4].url)
    await writeFile(tamperedPath, Buffer.from('changed bytes'))
    await assert.rejects(collectVideoEvidence({ url, sampleTimes, nativeSequence }, root), /帧字节已变化/)
    assert.equal((await readFile(tamperedPath)).toString(), 'changed bytes', 'cache corruption is reported, never overwritten to silently replace evidence')
    assert.ok(!(await readdir(dir)).some(name => name.startsWith('.native-sequence-')))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('native decoder byte and frame limits reject incomplete collection and keep the source video', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'native-sequence-limits-'))
  try {
    const dir = path.join(root, 'public/generated'), ffmpeg = require('ffmpeg-static') as string
    await mkdir(dir, { recursive: true })
    execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=24:duration=0.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(dir, 'source.mp4')])
    const source = await readFile(path.join(dir, 'source.mp4'))
    const request = { url: '/generated/source.mp4', nativeSequence: { enabled: true, windows: [{ start: 0, end: .5 }] } }
    await assert.rejects(collectVideoEvidence({ ...request, nativeSequence: { ...request.nativeSequence, archiveMaxFrames: 3 } }, root), /archiveMaxFrames=3.*未截断/)
    await assert.rejects(collectVideoEvidence({ ...request, nativeSequence: { ...request.nativeSequence, archiveMaxBytes: 1 } }, root), /archiveMaxBytes=1.*未截断/)
    assert.deepEqual(await readFile(path.join(dir, 'source.mp4')), source)
    assert.ok(!(await readdir(dir)).some(name => name.endsWith('-archive.json') || name.startsWith('.native-sequence-')))
  } finally { await rm(root, { recursive: true, force: true }) }
})
