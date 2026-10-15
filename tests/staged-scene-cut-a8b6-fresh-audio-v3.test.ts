import assert from 'node:assert/strict'
import { test } from 'node:test'
import { probeFreshA8B6AudioIsolationV3 } from
  '../server/staged-scene-cut-a8b6-fresh-audio-v3.mjs'

const nativeLastPts = 8
const file = '/archive/new-A.mp4'
const progress = seconds => Buffer.from(
  `out_time_us=${Math.round(seconds * 1e6)}\nprogress=end\n`)

function noStream(index) {
  return Object.assign(new Error('audio stream absent'), { code: 1,
    stdout: Buffer.alloc(0), stderr: Buffer.from(
      `Stream map '0:a:${index}' matches no streams.\n`
      + "To ignore this, add a trailing '?' to the map.\n") })
}

function pcm({ seconds = 8, channels = 1, sample = 0 } = {}) {
  const bytes = Buffer.alloc(Math.round(seconds * 8000 * channels) * 4)
  if (sample !== 0) bytes.writeFloatLE(sample, 0)
  return bytes
}

function decoder(streams, { durations = [] } = {}) {
  const mapped = []
  const run = async (_binary, args) => {
    const index = Number(args[args.indexOf('-map') + 1].split(':').at(-1))
    mapped.push(index)
    if (index >= streams.length) throw noStream(index)
    return { stdout: streams[index], stderr: progress(durations[index] ?? 8) }
  }
  return { run, mapped }
}

test('missing audio stream produces a measured no-audio certificate', async () => {
  const { run, mapped } = decoder([])
  const result = await probeFreshA8B6AudioIsolationV3(file, nativeLastPts, run)
  assert.equal(result.status, 'no-audio-stream')
  assert.deepEqual(result.witness.streams, [])
  assert.equal(result.witness.probedStreamCount, 0)
  assert.deepEqual(mapped, [0])
})

test('six-second B source is accepted only when every decoded stream is silent', async () => {
  const BFile = '/archive/new-B.mp4'
  const silent = await probeFreshA8B6AudioIsolationV3(BFile, 6,
    decoder([pcm({ seconds: 6 })], { durations: [6] }).run)
  assert.equal(silent.status, 'decoded-silence')
  assert.equal(silent.witness.streams[0].decodedDurationSeconds, 6)
  const audible = pcm({ seconds: 6 })
  audible.writeFloatLE(0.01, 0)
  await assert.rejects(() => probeFreshA8B6AudioIsolationV3(BFile, 6,
    decoder([audible], { durations: [6] }).run),
  /non-silent source audio/)
})

test('all decoded channel samples must be silent, including a second audio stream', async () => {
  const first = pcm({ channels: 2 })
  first.writeFloatLE(1e-5, 0)
  const { run, mapped } = decoder([first, pcm()])
  const result = await probeFreshA8B6AudioIsolationV3(file, nativeLastPts, run)
  assert.equal(result.status, 'decoded-silence')
  assert.equal(result.witness.probedStreamCount, 2)
  assert.deepEqual(mapped, [0, 1, 2])
  assert.equal(result.witness.streams[0].sampleCount, 128000)
  assert.equal(result.witness.streams[0].decodedDurationSeconds, 8)
  assert.match(result.witness.streams[0].decodedSha256, /^[a-f0-9]{64}$/)

  const second = pcm()
  second.writeFloatLE(0.05, 0)
  await assert.rejects(() => probeFreshA8B6AudioIsolationV3(
    file, nativeLastPts, decoder([pcm(), second]).run),
  /non-silent source audio/)
})

test('opposite phase stereo cannot cancel before silence validation', async () => {
  const bytes = pcm({ channels: 2 })
  bytes.writeFloatLE(0.2, 0)
  bytes.writeFloatLE(-0.2, 4)
  await assert.rejects(() => probeFreshA8B6AudioIsolationV3(
    file, nativeLastPts, decoder([bytes]).run), /non-silent source audio/)
})

test('malformed, failed and truncated decodes cannot become no-audio proof', async () => {
  const malformed = async () => {
    throw Object.assign(new Error('Invalid data found when processing input'),
      { code: 1, stderr: Buffer.from('moov atom not found') })
  }
  await assert.rejects(() => probeFreshA8B6AudioIsolationV3(
    file, nativeLastPts, malformed), /could not decode/)
  await assert.rejects(() => probeFreshA8B6AudioIsolationV3(
    file, nativeLastPts, decoder([Buffer.alloc(3)]).run), /malformed decoded samples/)
  await assert.rejects(() => probeFreshA8B6AudioIsolationV3(
    file, nativeLastPts, decoder([pcm({ seconds: 1 })],
      { durations: [1] }).run), /truncated or not phase-length/)
  const incomplete = async () => ({ stdout: pcm(), stderr: Buffer.from(
    'out_time_us=8000000\nprogress=continue\n') })
  await assert.rejects(() => probeFreshA8B6AudioIsolationV3(
    file, nativeLastPts, incomplete), /did not finish decoding/)
})

test('non-finite float samples and unchecked stream counts fail closed', async () => {
  const bad = pcm()
  bad.writeFloatLE(Number.NaN, 0)
  await assert.rejects(() => probeFreshA8B6AudioIsolationV3(
    file, nativeLastPts, decoder([bad]).run), /non-finite sample/)
  await assert.rejects(() => probeFreshA8B6AudioIsolationV3(
    file, nativeLastPts, decoder(Array.from({ length: 16 }, () => pcm())).run),
  /guarded decoder limit/)
})
