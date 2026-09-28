#!/usr/bin/env node
// Technical QA of the independent four-shot preview: both streams, complete
// frame count, ordered clip boundaries and third/fourth coverage cut.
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import sharp from 'sharp'
import { parseFfmpegMetadata } from '../server/video-inspection.ts'

const dir = process.argv[2]
if (!dir || process.argv.length !== 3) throw Error('Usage: node scripts/verify-scene4-review-preview.mjs EXISTING_CANDIDATE_DIR')
const proof = JSON.parse(await readFile(`${dir}/four-shot-candidate-proof.json`, 'utf8'))
if (proof.label !== '待用户验收候选' || proof.sourceUrls.length !== 4) throw Error('Four-shot candidate proof invalid')
const ffmpeg = createRequire(import.meta.url)('ffmpeg-static')
const exec = promisify(execFile)
const file = url => `public${url}`
const digest = value => createHash('sha256').update(value).digest('hex')
const checked = await Promise.all([...proof.sourceUrls, proof.candidateUrl].map(async (url, i) => {
  const bytes = await readFile(file(url))
  const { stderr } = await exec(ffmpeg, ['-hide_banner', '-nostdin', '-xerror', '-i', file(url), '-f', 'null', '-'],
    { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 })
  const parsed = parseFfmpegMetadata(stderr)
  const frameCount = [...stderr.matchAll(/frame=\s*(\d+)/g)].map(match => Number(match[1])).at(-1)
  const video = parsed.streams.find(item => item.codec_type === 'video')
  const hasAudio = parsed.streams.some(item => item.codec_type === 'audio')
  if (digest(bytes) !== (i < 4 ? proof.sourceSha256[i] : proof.candidateSha256)
    || !video || !hasAudio || video.width !== 1280 || video.height !== 720 || !frameCount) throw Error(`Clip ${i + 1} failed decode or identity check`)
  return { url, sha256: digest(bytes), bytes: bytes.length, duration: parsed.format.duration,
    width: video.width, height: video.height, hasAudio, frameCount, decodedWithoutError: true }
}))
const sources = checked.slice(0, 4), output = checked[4]
const sumFrames = sources.reduce((sum, item) => sum + item.frameCount, 0)
const sumDuration = sources.reduce((sum, item) => sum + item.duration, 0)
if (sumFrames !== output.frameCount || Math.abs(sumDuration - output.duration) > .2) throw Error('Candidate dropped/duplicated frames or duration drift exceeded tolerance')
const outIndices = []
let next = 0
for (const source of sources) { outIndices.push([next, next + source.frameCount - 1]); next += source.frameCount }
const extract = async (url, index, destination) => {
  await exec(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-i', file(url),
    '-vf', `select=eq(n\\,${index})`, '-vsync', '0', '-frames:v', '1', destination], { timeout: 30_000 })
}
const pixels = path => sharp(path).resize(96, 54, { fit: 'fill' }).removeAlpha().raw().toBuffer()
const frameChecks = []
const layout = []
for (let shot = 0; shot < 4; shot++) {
  for (const [position, sourceIndex, outputIndex] of [
    ['first', 0, outIndices[shot][0]], ['last', sources[shot].frameCount - 1, outIndices[shot][1]],
  ]) {
    const sourceFrame = `${dir}/boundary-shot${shot + 1}-${position}-source.jpg`
    const outputFrame = `${dir}/boundary-shot${shot + 1}-${position}-concat.jpg`
    await extract(sources[shot].url, sourceIndex, sourceFrame)
    await extract(output.url, outputIndex, outputFrame)
    const [a, b] = await Promise.all([pixels(sourceFrame), pixels(outputFrame)])
    const meanPixelDifference = a.reduce((sum, value, i) => sum + Math.abs(value - b[i]), 0) / (a.length * 255)
    frameChecks.push({ shot: shot + 1, position, sourceFrameIndex: sourceIndex,
      outputFrameIndex: outputIndex, meanPixelDifference, sourceFrame, outputFrame })
    layout.push({ frame: outputFrame, label: `镜${shot + 1} ${position} 合片帧 #${outputIndex}` })
  }
}
if (frameChecks.some(item => item.meanPixelDifference > .08)) throw Error('A concat boundary differs materially from its preserved source frame')
const parts = []
for (const [i, item] of layout.entries()) {
  const x = (i % 4) * 640, y = Math.floor(i / 4) * 360
  const frame = await sharp(item.frame).resize(640, 360).toBuffer()
  const label = Buffer.from(`<svg width="640" height="40"><rect width="640" height="40" fill="#111c"/><text x="12" y="29" fill="white" font-family="Arial" font-size="24">${item.label}</text></svg>`)
  parts.push({ input: frame, left: x, top: y }, { input: label, left: x, top: y })
}
const boundaryContact = `${dir}/four-shot-boundary-contact.jpg`
await sharp({ create: { width: 2560, height: 720, channels: 3, background: '#000' } }).composite(parts).jpeg({ quality: 90 }).toFile(boundaryContact)
const { stderr: volumeStderr } = await exec(ffmpeg, ['-hide_banner', '-nostdin', '-i', file(output.url),
  '-vn', '-af', 'volumedetect', '-f', 'null', '-'], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 })
const meanVolumeDb = Number(volumeStderr.match(/mean_volume:\s*(-?[\d.]+) dB/)?.[1] ?? NaN)
if (!Number.isFinite(meanVolumeDb)) throw Error('Candidate audio stream volume could not be measured')
const report = { format: 'scene4-four-shot-preview-technical-qa-v1', label: proof.label,
  candidateAbsolutePath: proof.candidateAbsolutePath, candidateUrl: output.url, sources, output,
  sumSourceFrames: sumFrames, sumSourceDuration: Number(sumDuration.toFixed(3)),
  outputFrameRanges: outIndices, frameChecks, boundaryContact, meanVolumeDb,
  bothStreamsDecoded: true, frameSequenceComplete: true, sourceOrderVerified: true,
  thirdFourthJoinKind: 'same-axis-coverage-cut', noHumanAestheticAcceptance: true,
  lipSyncUnverified: true, voiceIdentityUnverified: true, technicalPassed: true }
await writeFile(`${dir}/four-shot-technical-qa.json`, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
console.log(JSON.stringify({ candidateAbsolutePath: report.candidateAbsolutePath,
  technicalPassed: true, sourceFrames: sources.map(item => item.frameCount),
  outputFrames: output.frameCount, outputDuration: output.duration, meanVolumeDb,
  boundaryMaxDifference: Math.max(...frameChecks.map(item => item.meanPixelDifference)), boundaryContact }, null, 2))
