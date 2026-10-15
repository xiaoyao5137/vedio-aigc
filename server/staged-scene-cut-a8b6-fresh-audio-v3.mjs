/** Independent, write-once source-audio isolation for each fresh native take. */
import { execFile } from 'node:child_process'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { isDeepStrictEqual, promisify } from 'node:util'
import { freshA8B6Directory, freshA8B6GeneratedFile } from
  './staged-scene-cut-a8b6-fresh-ledger.mjs'
import { readFreshA8B6MediaReceipt } from
  './staged-scene-cut-a8b6-fresh-phases.mjs'

const exec = promisify(execFile)
const ffmpeg = createRequire(import.meta.url)('ffmpeg-static')
const SHA = /^[a-f0-9]{64}$/
const MAX_AUDIO_STREAMS = 16
const MAX_ABS_SAMPLE = 1e-5
const invalid = reason => { throw Error(`A8B6_FRESH_AUDIO_V3_INVALID: ${reason}`) }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.entries(value)
    .filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`
    : JSON.stringify(value ?? null)
const phaseName = phase => {
  if (phase !== 'A' && phase !== 'B') invalid('phase must be A or B')
  return phase
}
const artifactName = phase => `phase-${phaseName(phase)}-audio-isolation-v3.json`

function noAudioStream(error, index) {
  const expected = `Stream map '0:a:${index}' matches no streams.\n`
    + "To ignore this, add a trailing '?' to the map."
  return error?.code === 1
    && String(error.stderr ?? '').trim() === expected
    && (!error.stdout || error.stdout.length === 0)
}

function decodedDuration(stderr) {
  const output = String(stderr ?? '')
  if (!/(?:^|\n)progress=end(?:\r?\n|$)/.test(output))
    invalid('ffmpeg did not finish decoding the audio stream')
  const matches = [...output.matchAll(/(?:^|\n)out_time_us=(\d+)(?:\r?\n|$)/g)]
  const microseconds = Number(matches.at(-1)?.[1])
  if (!Number.isSafeInteger(microseconds) || microseconds <= 0)
    invalid('ffmpeg audio duration witness is missing')
  return microseconds / 1e6
}

/** Decode every audio stream independently, preserving every channel. The
 * injected exec callback permits deterministic parser tests without media. */
export async function probeFreshA8B6AudioIsolationV3(filename,
  nativeLastPts, run = exec) {
  if (typeof filename !== 'string' || !filename.endsWith('.mp4')
    || !Number.isFinite(nativeLastPts) || nativeLastPts <= 0
    || typeof run !== 'function') invalid('audio probe input invalid')
  const streams = []
  for (let index = 0; index < MAX_AUDIO_STREAMS; index++) {
    let result
    try {
      result = await run(ffmpeg, ['-v', 'error', '-xerror', '-nostdin',
        '-i', filename, '-map', `0:a:${index}`, '-vn', '-c:a', 'pcm_f32le',
        '-f', 'f32le', '-progress', 'pipe:2', '-nostats', '-'],
      { encoding: 'buffer', timeout: 120000, maxBuffer: 64 * 1024 * 1024 })
    } catch (error) {
      if (noAudioStream(error, index)) {
        return streams.length === 0
          ? { status: 'no-audio-stream', witness: {
            probe: 'ffmpeg-static-all-streams-f32le-v1',
            probedStreamCount: 0, streams: [] } }
          : { status: 'decoded-silence', witness: {
            probe: 'ffmpeg-static-all-streams-f32le-v1',
            probedStreamCount: streams.length, streams } }
      }
      invalid(`ffmpeg audio stream ${index} could not decode: ${error?.message ?? error}`)
    }
    const bytes = result?.stdout
    if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length % 4)
      invalid(`audio stream ${index} has empty or malformed decoded samples`)
    const durationSeconds = decodedDuration(result.stderr)
    // Native PTS is the start of the last video frame. Allow AAC priming and
    // end padding while rejecting an audio stream that covers only a prefix.
    if (durationSeconds < nativeLastPts - 0.25
      || durationSeconds > nativeLastPts + 0.75
      || bytes.length / 4 < 8000 * (durationSeconds - 0.25))
      invalid(`audio stream ${index} is truncated or not phase-length`)
    let maxAbsSample = 0
    for (let offset = 0; offset < bytes.length; offset += 4) {
      const sample = bytes.readFloatLE(offset)
      if (!Number.isFinite(sample))
        invalid(`audio stream ${index} contains a non-finite sample`)
      maxAbsSample = Math.max(maxAbsSample, Math.abs(sample))
      if (maxAbsSample > MAX_ABS_SAMPLE)
        invalid(`audio stream ${index} contains non-silent source audio`)
    }
    streams.push({ index, decodedDurationSeconds: durationSeconds,
      sampleCount: bytes.length / 4, decodedSha256: sha(bytes), maxAbsSample })
  }
  invalid('audio stream count exceeds the guarded decoder limit')
}

async function signingKey(root) {
  const bytes = await readFile(path.join(root, '.runtime/staged-scene-cut.key'))
  if (bytes.length !== 32) invalid('staging signing key invalid')
  return bytes
}

function signature(body, key) {
  return createHmac('sha256', key).update(canonical(body)).digest('hex')
}

async function source(planId, phase, root) {
  const { media, mediaSha256, native } = await readFreshA8B6MediaReceipt(
    planId, phase, root)
  if (!SHA.test(String(media.videoSha256))
    || !SHA.test(String(mediaSha256))
    || !SHA.test(String(native.frameDigestSha256))
    || media.nativeFrameDigestSha256 !== native.frameDigestSha256)
    invalid('signed native media source is incomplete')
  const filename = freshA8B6GeneratedFile(media.videoUrl, 'video', root)
  return { media, mediaSha256, native, filename }
}

function expectedReceipt(planId, phase, sourceReceipt, probe) {
  const { media, mediaSha256, native } = sourceReceipt
  return { version: 'staged-a8b6-fresh-audio-isolation-v3',
    planId, phase, taskId: media.taskId, videoUrl: media.videoUrl,
    videoSha256: media.videoSha256, mediaSha256,
    nativeFrameDigestSha256: native.frameDigestSha256,
    status: probe.status, witness: probe.witness }
}

async function currentReceipt(planId, phase, root) {
  const signed = await source(planId, phase, root)
  const probe = await probeFreshA8B6AudioIsolationV3(
    signed.filename, signed.native.lastPts)
  if (sha(await readFile(signed.filename)) !== signed.media.videoSha256)
    invalid('archived native video changed during audio decode')
  return expectedReceipt(planId, phase, signed, probe)
}

/** Read-only preview for a human-visible write-once decision. */
export async function prepareFreshA8B6AudioIsolationV3(planId, phase,
  root = process.cwd()) {
  return currentReceipt(planId, phaseName(phase), root)
}

export function freshA8B6AudioIsolationV3BodySha256(body) {
  return sha(canonical(body))
}

/** A previous proof is reused only if its signature, source and fresh decode
 * still match. A different proof is never allowed to overwrite it. */
export async function saveFreshA8B6AudioIsolationV3(planId, phase,
  root = process.cwd(), expectedBodySha256) {
  const name = artifactName(phase)
  const body = await currentReceipt(planId, phase, root)
  if (expectedBodySha256 !== undefined
    && (!SHA.test(String(expectedBodySha256))
      || freshA8B6AudioIsolationV3BodySha256(body) !== expectedBodySha256))
    invalid('audio isolation changed since preview')
  const receipt = { ...body, signature: signature(body, await signingKey(root)) }
  const filename = path.join(freshA8B6Directory(planId, root), name)
  await mkdir(path.dirname(filename), { recursive: true })
  const bytes = Buffer.from(JSON.stringify(receipt, null, 2) + '\n')
  try { await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }) }
  catch (error) {
    if (error?.code !== 'EEXIST') throw error
    return readFreshA8B6AudioIsolationV3(planId, phase, root)
  }
  return { receipt, receiptSha256: sha(bytes) }
}

export async function readFreshA8B6AudioIsolationV3(planId, phase,
  root = process.cwd()) {
  const filename = path.join(freshA8B6Directory(planId, root),
    artifactName(phase))
  const bytes = await readFile(filename)
  let receipt
  try { receipt = JSON.parse(bytes.toString('utf8')) }
  catch { invalid('signed audio isolation JSON is malformed') }
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt))
    invalid('signed audio isolation receipt malformed')
  const { signature: actual, ...body } = receipt
  const expected = signature(body, await signingKey(root))
  if (!SHA.test(String(actual))
    || !timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex')))
    invalid('audio isolation signature changed')
  const current = await currentReceipt(planId, phase, root)
  if (!isDeepStrictEqual(body, current))
    invalid('audio isolation source binding or decoded witness changed')
  return { receipt, receiptSha256: sha(bytes) }
}
