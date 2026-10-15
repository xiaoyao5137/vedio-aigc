#!/usr/bin/env node
// Deterministic, disclosed post-production foley for a near-silent generated
// video. The paid source remains untouched; every decoded video frame in the
// derivative must match it. Default is a read-only dry run.
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { link, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import ffmpeg from 'ffmpeg-static'

const exec = promisify(execFile)
const sampleRate = 44100
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const fail = message => { throw Error(`PROCEDURAL_FOLEY_INVALID: ${message}`) }
const round = value => Math.round(value * 10) / 10

function parseArgs(args) {
  const options = { apply: false }
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]
    if (flag === '--apply') { options.apply = true; continue }
    if (flag === '--help') { options.help = true; continue }
    if (flag !== '--source' && flag !== '--recipe') fail(`unknown argument ${flag}`)
    if (options[flag.slice(2)] || !args[index + 1]) fail(`missing or duplicate ${flag}`)
    options[flag.slice(2)] = args[++index]
  }
  if (!options.help && (!options.source || !options.recipe)) fail('--source and --recipe are required')
  return options
}

async function command(args, timeout = 120000) {
  try { return await exec(ffmpeg, args, { timeout, maxBuffer: 8 * 1024 * 1024 }) }
  catch (error) { fail(`ffmpeg failed: ${String(error.stderr ?? error.message).slice(-1200)}`) }
}

async function localSource(url, root) {
  if (!/^\/generated\/[\w.-]+\.mp4$/.test(url)) fail('source must be a generated MP4 URL')
  const dir = await realpath(path.join(root, 'public/generated'))
  const filename = await realpath(path.join(dir, path.basename(url)))
  if (!filename.startsWith(dir + path.sep) || !(await stat(filename)).isFile()) fail('unsafe or missing source')
  return { dir, filename }
}

function validateRecipe(recipe, duration) {
  if (!recipe || recipe.version !== 'procedural-foley-v1' || !Number.isSafeInteger(recipe.seed)
    || recipe.seed < 1 || recipe.seed > 0xffffffff || !Number.isFinite(recipe.targetLufs)
    || recipe.targetLufs < -30 || recipe.targetLufs > -20
    || !recipe.ambience || !Number.isFinite(recipe.ambience.ventilationHz)
    || recipe.ambience.ventilationHz < 40 || recipe.ambience.ventilationHz > 100
    || !Number.isFinite(recipe.ambience.strength) || recipe.ambience.strength < 0 || recipe.ambience.strength > .3
    || !Array.isArray(recipe.events) || recipe.events.length < 2 || recipe.events.length > 24) fail('recipe values are invalid')
  for (const event of recipe.events) {
    if (!['breath', 'fabric-touch'].includes(event?.type) || !Number.isFinite(event.start)
      || !Number.isFinite(event.duration) || !Number.isFinite(event.strength)
      || event.start < 0 || event.duration <= 0 || event.start + event.duration > duration + .02
      || event.strength <= 0 || event.strength > 1) fail('recipe event is invalid or exceeds video duration')
  }
}

async function frameHashes(filename) {
  const result = await command(['-hide_banner', '-v', 'error', '-xerror', '-i', filename,
    '-map', '0:v:0', '-f', 'framemd5', '-'])
  const frames = result.stdout.split(/\r?\n/).filter(line => line.trim() && !line.startsWith('#'))
    .map(line => line.split(',').at(-1)?.trim() ?? '')
  if (!frames.length || frames.some(value => !/^[a-f0-9]{32}$/i.test(value))) fail('video frame hashes unavailable')
  return frames
}

async function analyze(filename) {
  const decoded = await command(['-hide_banner', '-xerror', '-i', filename, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'])
  const parts = decoded.stderr.match(/Duration:\s*(\d+):(\d+):([\d.]+)/)
  if (!parts) fail('media duration unavailable')
  const duration = Number(parts[1]) * 3600 + Number(parts[2]) * 60 + Number(parts[3])
  const volume = await command(['-hide_banner', '-i', filename, '-map', '0:a:0', '-af', 'volumedetect', '-f', 'null', '-'])
  const meanDbfs = Number(volume.stderr.match(/mean_volume:\s*(-?[\d.]+) dB/)?.[1])
  const maxDbfs = Number(volume.stderr.match(/max_volume:\s*(-?[\d.]+) dB/)?.[1])
  const loud = await command(['-hide_banner', '-i', filename, '-map', '0:a:0', '-af', 'ebur128=peak=true', '-f', 'null', '-'])
  const summary = loud.stderr.slice(loud.stderr.lastIndexOf('Summary:'))
  const integratedLufs = Number(summary.match(/\bI:\s*(-?[\d.]+) LUFS/)?.[1])
  const truePeakDbfs = Number(summary.match(/True peak:[\s\S]*?Peak:\s*(-?[\d.]+) dBFS/)?.[1])
  if (![duration, meanDbfs, maxDbfs, integratedLufs, truePeakDbfs].every(Number.isFinite)) fail('audio analysis unavailable')
  const frames = await frameHashes(filename)
  return { sha256: hash(await readFile(filename)), duration, audio: { meanDbfs, maxDbfs, integratedLufs, truePeakDbfs },
    videoFrameCount: frames.length, videoFramesSha256: hash(frames.join('\n')), frames }
}

// The envelope and filtered noise below model quiet breaths and soft fabric
// contact. They are expressly synthetic post-production sounds, not a claim
// that the video provider captured these actions.
function renderWav(recipe, duration) {
  const count = Math.round(duration * sampleRate)
  const pcm = Buffer.alloc(count * 4)
  let state = recipe.seed >>> 0
  const random = () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5
    return (state >>> 0) / 0x80000000 - 1
  }
  const lp = (previous, input, hz) => previous + (1 - Math.exp(-2 * Math.PI * hz / sampleRate)) * (input - previous)
  let low = 0, mid = 0, highBase = 0
  const values = new Float64Array(count)
  let squareSum = 0, maxAbs = 0
  for (let i = 0; i < count; i++) {
    const t = i / sampleRate
    const noise = random()
    low = lp(low, noise, 125)
    mid = lp(mid, noise, 1450)
    highBase = lp(highBase, noise, 170)
    const airy = mid - highBase
    const ventilation = recipe.ambience.strength * (0.20 * Math.sin(2 * Math.PI * recipe.ambience.ventilationHz * t)
      + 0.12 * Math.sin(2 * Math.PI * recipe.ambience.ventilationHz * 2 * t) + 0.45 * low)
    let value = ventilation
    for (const event of recipe.events) {
      const phase = (t - event.start) / event.duration
      if (phase < 0 || phase >= 1) continue
      const envelope = Math.sin(Math.PI * phase) ** 2
      if (event.type === 'breath') {
        value += event.strength * envelope * airy * .72
      } else {
        const rough = (mid - low) * (.7 + .3 * Math.sin(2 * Math.PI * 14 * (t - event.start)))
        const impact = Math.sin(2 * Math.PI * 115 * (t - event.start)) * Math.exp(-33 * (t - event.start))
        value += event.strength * (envelope * rough * .85 + impact * .17)
      }
    }
    // Smooth fades keep the generated bed from clicking at edit boundaries.
    const fade = Math.min(1, t / .12, (duration - t) / .12)
    value *= Math.max(0, fade)
    values[i] = value
    squareSum += value * value
    maxAbs = Math.max(maxAbs, Math.abs(value))
  }
  const rms = Math.sqrt(squareSum / count)
  if (rms < .0001 || maxAbs / rms > 40) fail('synthetic waveform is silent or dominated by impulses')
  const gain = Math.min(.84 / maxAbs, .04 / rms)
  for (let i = 0; i < count; i++) {
    const value = Math.max(-1, Math.min(1, values[i] * gain))
    const integer = Math.round(value * 32767)
    pcm.writeInt16LE(integer, i * 4)
    pcm.writeInt16LE(integer, i * 4 + 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22)
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 4, 28)
  header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34); header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

async function putNew(filename, bytes) {
  const temporary = `${filename}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, bytes, { flag: 'wx' })
    await link(temporary, filename).catch(error => { if (error.code !== 'EEXIST') throw error })
  } finally { await rm(temporary, { force: true }) }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log('node scripts/remediate-video-foley.mjs --source /generated/SOURCE.mp4 --recipe RECIPE.json [--apply]\nDefault dry-run; --apply creates a disclosed same-video foley derivative and manifest. No DB or provider calls.')
    return
  }
  const root = process.cwd()
  const { dir, filename } = await localSource(options.source, root)
  const recipeFile = await realpath(path.resolve(options.recipe))
  if (!(await stat(recipeFile)).isFile()) fail('recipe file missing')
  const recipeBytes = await readFile(recipeFile)
  const recipe = JSON.parse(recipeBytes.toString('utf8'))
  const source = await analyze(filename)
  if (source.duration < 1 || source.duration > 15 || source.audio.meanDbfs >= -50 || source.audio.maxDbfs > -40) {
    fail('source is outside short near-silent video remediation scope')
  }
  validateRecipe(recipe, source.duration)
  const recipeSha256 = hash(recipeBytes)
  const stem = `foley-${source.sha256.slice(0, 16)}-${recipeSha256.slice(0, 16)}`
  const urls = { wavUrl: `/generated/${stem}.wav`, outputUrl: `/generated/${stem}.mp4`, manifestUrl: `/generated/${stem}.json` }
  if (!options.apply) {
    console.log(JSON.stringify({ applied: false, sourceUrl: options.source, sourceSha256: source.sha256,
      sourceAudio: source.audio, videoFrameCount: source.videoFrameCount,
      videoFramesSha256: source.videoFramesSha256, recipeSha256, recipe, ...urls }, null, 2))
    return
  }
  const sourceBefore = source.sha256
  const wavFile = path.join(dir, path.basename(urls.wavUrl))
  const outputFile = path.join(dir, path.basename(urls.outputUrl))
  const manifestFile = path.join(dir, path.basename(urls.manifestUrl))
  const wav = renderWav(recipe, source.duration)
  await putNew(wavFile, wav)
  if (hash(await readFile(wavFile)) !== hash(wav)) fail('existing foley WAV differs from recipe')
  const temporary = `${outputFile}.${randomUUID()}.tmp.mp4`
  try {
    await command(['-hide_banner', '-v', 'error', '-xerror', '-n', '-i', filename, '-i', wavFile,
      '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
      '-af', `loudnorm=I=${recipe.targetLufs}:TP=-2:LRA=6`, '-movflags', '+faststart',
      '-t', String(source.duration), temporary])
    await link(temporary, outputFile).catch(error => { if (error.code !== 'EEXIST') throw error })
  } finally { await rm(temporary, { force: true }) }
  const output = await analyze(outputFile)
  if (output.videoFrameCount !== source.videoFrameCount || output.videoFramesSha256 !== source.videoFramesSha256
    || output.frames.some((frame, index) => frame !== source.frames[index])
    || Math.abs(output.duration - source.duration) > .08
    || output.audio.meanDbfs < -50 || Math.abs(output.audio.integratedLufs - recipe.targetLufs) > 2
    || output.audio.truePeakDbfs > -1) fail('derived video frames, duration or audio failed verification')
  if (hash(await readFile(filename)) !== sourceBefore) fail('paid source changed')
  const manifest = { version: recipe.version, sourceUrl: options.source, sourceSha256: source.sha256,
    sourceAudio: source.audio, sourceDuration: source.duration, recipe, recipeSha256,
    wavUrl: urls.wavUrl, wavSha256: hash(wav), outputUrl: urls.outputUrl, outputSha256: output.sha256,
    outputAudio: output.audio, outputDuration: output.duration,
    videoCodecHandling: 'stream-copy', audioCodecHandling: 'new procedural foley AAC; original audio retained in source file',
    videoFrameCount: output.videoFrameCount, sourceVideoFramesSha256: source.videoFramesSha256,
    outputVideoFramesSha256: output.videoFramesSha256, everyDecodedVideoFrameMatched: true,
    audioSource: 'deterministic post-production DSP synthesis; no external recording, model or provider',
    soundContentSemanticReview: 'pending-human-listen', originalLedgerAndExecutionUnchanged: true }
  await putNew(manifestFile, Buffer.from(JSON.stringify(manifest, null, 2) + '\n'))
  const saved = JSON.parse(await readFile(manifestFile, 'utf8'))
  if (JSON.stringify(saved) !== JSON.stringify(manifest)) fail('existing manifest differs')
  console.log(JSON.stringify({ applied: true, ...urls, manifestSha256: hash(await readFile(manifestFile)),
    sourceSha256: source.sha256, outputSha256: output.sha256, sourceAudio: source.audio,
    outputAudio: output.audio, videoFrameCount: output.videoFrameCount,
    sameDecodedVideoFramesSha256: output.videoFramesSha256, everyDecodedVideoFrameMatched: true }, null, 2))
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
