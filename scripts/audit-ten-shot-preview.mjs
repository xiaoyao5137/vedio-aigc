// Read-only DB/media audit. Writes evidence only under a fresh QA directory.
// No workflow execution, provider/model requests, concat, or DB mutations.
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readdir, realpath, rename, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import pg from 'pg'
import sharp from 'sharp'
import ffmpeg from 'ffmpeg-static'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { parseFfmpegMetadata } from '../server/video-inspection.ts'

const exec = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fail = message => { throw Error(`PREVIEW_AUDIT_INVALID: ${message}`) }
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const progress = (stage, details = {}) => console.log(JSON.stringify({ stage, ...details }))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

export function parseArguments(args) {
  const options = { count: 10 }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help') { options.help = true; continue }
    const key = { '--record': 'recordId', '--out': 'out', '--expected-reference': 'expectedReference', '--count': 'count' }[args[i]]
    if (!key || key !== 'count' && options[key] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) fail(`unknown or incomplete argument ${args[i]}`)
    options[key] = args[++i]
  }
  if (options.help) return options
  if (!/^record-[\w-]+$/.test(options.recordId ?? '')) fail('--record RECORD is required')
  options.count = Number(options.count)
  if (!Number.isSafeInteger(options.count) || options.count < 1 || options.count > 200) fail('--count must be 1..200 (default 10)')
  if (options.expectedReference && !/^\/generated\/[\w.-]+\.(?:jpg|jpeg|png|webp)$/i.test(options.expectedReference)) fail('--expected-reference must be a local /generated/ image URL')
  options.out = path.resolve(root, options.out ?? `logs/zhangfei-ten-shots-20260927/qa/${options.recordId}`)
  for (const sourceDir of ['public/generated', '.runtime/video-concat-sources']) {
    const relative = path.relative(path.join(root, sourceDir), options.out)
    if (!relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) fail('QA output must not be inside a media source directory')
  }
  return options
}

export function localVideo(url) {
  if (!/^\/generated\/[\w.-]+\.(?:mp4|mov|webm)$/i.test(url ?? '')) fail(`nonlocal or invalid video URL: ${url}`)
  return path.join(root, 'public', url)
}

/** Select the cumulative prefix from saved successful producers, not attempts
 * or compressed branch history. The concat itself supplies authoritative order. */
export function selectPreview(state, count) {
  if (!Array.isArray(state.nodeRuns)) fail('decoded state has no nodeRuns')
  const runs = state.nodeRuns
  const candidates = runs.map((run, index) => ({ run, index })).filter(({ run }) => run.status === 'success'
    && run.node?.resultVar === 'stage_video' && run.loopIndex === count - 1
    && run.output?.count === count && run.output?.clips?.length === count)
  const selected = candidates.at(-1)
  if (!selected) fail(`no successful ${count}-clip concat at loopIndex ${count - 1}; complete that concat before auditing`)
  const stage = selected.run.output
  localVideo(stage.url)
  if (!Array.isArray(stage.sourceSha256) || stage.sourceSha256.length !== count) fail('concat sourceSha256 length differs from clip count')
  if (!['720p', '4k'].includes(stage.resolution) || ![stage.width, stage.height].every(value => Number.isSafeInteger(value) && value > 0)
    || stage.fps !== 24 || stage.audioSampleRate !== 48000) fail('concat has no supported output profile')
  const prior = runs.slice(0, selected.index + 1)
  const shots = stage.clips.map((clip, loopIndex) => {
    if (!object(clip) || !/^[a-f\d]{64}$/i.test(clip.sha256 ?? '') || clip.sha256 !== stage.sourceSha256[loopIndex]) fail(`clip ${loopIndex + 1} lacks consistent source hashes`)
    localVideo(clip.url)
    const accepted = prior.filter(run => run.status === 'success' && run.node?.resultVar === 'video_shot'
      && run.loopGroupId === selected.run.loopGroupId && run.loopIndex === loopIndex && run.output?.url === clip.url).at(-1)
    if (!accepted) fail(`clip ${loopIndex + 1} has no corresponding successful video_shot in this loop group`)
    const scope = prior.slice(0, prior.lastIndexOf(accepted) + 1).filter(run => run.status === 'success'
      && run.loopGroupId === accepted.loopGroupId && run.loopIndex === loopIndex)
    const latest = name => scope.filter(run => run.node?.resultVar === name).at(-1)
    const context = accepted.inputContext ?? {}
    const evidence = context.video_evidence ?? latest('video_evidence')?.output
    const take = context.video_take ?? latest('video_take')?.output
    const script = context.shot_script ?? latest('shot_script')?.output
    if (!evidence || evidence.url !== clip.url || evidence.originalUrl !== take?.url || accepted.output.originalUrl !== take?.url) fail(`clip ${loopIndex + 1} saved take/evidence/acceptance do not bind the same media`)
    if (evidence.decoded !== true || accepted.output.passed !== true || evidence.sha256 !== clip.sha256
      || accepted.output.sha256 !== clip.sha256) fail(`clip ${loopIndex + 1} saved decoded evidence/acceptance do not bind the same SHA256 bytes`)
    if (!script) fail(`clip ${loopIndex + 1} has no saved shot script`)
    const normalized = path.join(root, '.runtime/video-concat-sources', `normalized-v3-${stage.resolution}-${stage.width}x${stage.height}-24fps-48k-${clip.sha256}.mp4`)
    return { loopIndex, clip, accepted, scope, evidence, take, script, normalized }
  })
  return { concatRun: selected.run, stage, shots }
}

export function parseFrameMd5(stdout) {
  const base = stdout.match(/^#tb\s+0:\s*(\d+)\/(\d+)\s*$/m)
  if (!base || Number(base[1]) <= 0 || Number(base[2]) <= 0) fail('framemd5 lacks video time base')
  const timeBase = Number(base[1]) / Number(base[2])
  const frames = stdout.split('\n').filter(line => line.trim() && !line.startsWith('#')).map((line, index) => {
    const fields = line.split(',').map(value => value.trim())
    if (fields.length !== 6 || fields[0] !== '0' || !/^[a-f\d]{32}$/i.test(fields[5])) fail('invalid video framemd5 row')
    const pts = Number(fields[2]), duration = Number(fields[3]), byteLength = Number(fields[4])
    if (![pts, duration, byteLength].every(Number.isSafeInteger) || duration < 0 || byteLength <= 0) fail('invalid decoded frame metadata')
    return { index, pts, duration, byteLength, md5: fields[5] }
  })
  if (!frames.length || frames.some((frame, index) => index > 0 && frame.pts <= frames[index - 1].pts)) fail('empty or nonmonotonic video frames')
  return { timeBase: `${base[1]}/${base[2]}`, frames: frames.map(frame => ({ ...frame, second: (frame.pts - frames[0].pts) * timeBase })) }
}

async function hashFile(filename) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filename)) hash.update(chunk)
  return hash.digest('hex')
}

async function canonicalDestination(filename) {
  const suffix = []
  let ancestor = filename
  for (;;) {
    try { return path.resolve(await realpath(ancestor), ...suffix) } catch (error) {
      if (error.code !== 'ENOENT' || path.dirname(ancestor) === ancestor) throw error
      suffix.unshift(path.basename(ancestor))
      ancestor = path.dirname(ancestor)
    }
  }
}

async function checkDestination(out) {
  const destination = await canonicalDestination(out)
  for (const sourceDir of ['public/generated', '.runtime/video-concat-sources']) {
    const relative = path.relative(await canonicalDestination(path.join(root, sourceDir)), destination)
    if (!relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) fail('QA destination resolves inside a media source directory')
  }
}

async function runFfmpeg(args, timeout = 10 * 60 * 1000) {
  return exec(ffmpeg, ['-hide_banner', '-nostdin', ...args], { timeout, maxBuffer: 16 * 1024 * 1024 })
}

async function probe(filename) {
  const { stderr } = await runFfmpeg(['-i', filename, '-t', '0', '-f', 'null', '-'])
  const metadata = parseFfmpegMetadata(stderr)
  const video = metadata.streams.find(stream => stream.codec_type === 'video')
  const audio = stderr.split('\n').find(line => /Stream #.*Audio:/.test(line)) ?? ''
  const videoLine = stderr.split('\n').find(line => /Stream #.*Video:/.test(line)) ?? ''
  if (!video || !Number.isFinite(metadata.format.duration) || metadata.format.duration <= 0) fail(`invalid media metadata: ${filename}`)
  return { duration: metadata.format.duration, width: video.width, height: video.height, hasAudio: Boolean(audio),
    videoStream: videoLine.trim(), audioStream: audio.trim(), metadataText: stderr }
}

async function decodeBoth(filename) {
  const { stderr } = await runFfmpeg(['-v', 'error', '-xerror', '-i', filename, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'])
  if (stderr.trim()) fail(`dual-stream decode reported errors: ${filename}: ${stderr.slice(-2000)}`)
  return { passed: true, streams: ['0:v:0', '0:a:0'], complete: true }
}

async function frameHashes(filename, output) {
  const { stdout } = await runFfmpeg(['-v', 'error', '-xerror', '-i', filename, '-map', '0:v:0', '-an', '-fps_mode', 'passthrough', '-f', 'framemd5', '-'])
  const parsed = parseFrameMd5(stdout)
  await writeFile(output, stdout, { flag: 'wx' })
  return { ...parsed, file: output, evidenceSha256: digest(stdout) }
}

function referenceHits(value, expected, prefix = '', seen = new WeakSet()) {
  if (typeof value === 'string') return value === expected ? [prefix] : []
  if (!value || typeof value !== 'object' || seen.has(value)) return []
  seen.add(value)
  return Object.entries(value).flatMap(([key, item]) => referenceHits(item, expected, prefix ? `${prefix}.${key}` : key, seen))
}

async function sheet(items, columns, destination) {
  const width = 384, height = 216, labelHeight = 26
  const tiles = await Promise.all(items.map(async (item, index) => ({
    input: await sharp(item.path).resize(width, height, { fit: 'contain', background: '#151515' }).extend({ bottom: labelHeight, background: '#eeeeee' }).composite([
      { input: Buffer.from(`<svg width="${width}" height="${labelHeight}"><text x="8" y="18" font-size="13" font-family="Arial" fill="#111">${item.label}</text></svg>`), top: height, left: 0 },
    ]).jpeg({ quality: 92 }).toBuffer(), left: index % columns * width, top: Math.floor(index / columns) * (height + labelHeight),
  })))
  await sharp({ create: { width: columns * width, height: Math.ceil(items.length / columns) * (height + labelHeight), channels: 3, background: '#eeeeee' } }).composite(tiles).jpeg({ quality: 95 }).toFile(destination)
  return destination
}

export async function audit(options) {
  await checkDestination(options.out)
  await mkdir(options.out, { recursive: true })
  await checkDestination(options.out)
  if ((await readdir(options.out)).length) fail('QA directory is not empty; choose a fresh directory to preserve prior evidence')
  const marker = await open(path.join(options.out, '.audit-run'), 'wx')
  await marker.writeFile(JSON.stringify({ recordId: options.recordId, startedAt: new Date().toISOString() }))
  await marker.close()
  const report = { version: 'actual-preview-media-audit-v1', recordId: options.recordId, expectedCount: options.count,
    startedAt: new Date().toISOString(), databaseReadOnly: true, modelsCalled: 0, mediaRegenerated: false,
    fullVideoWatched: false, fullVideoListened: false, subjectiveReview: 'pending', technicalPassed: false, clips: [], warnings: [] }
  try {
    const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
    let row
    await db.connect()
    try {
      row = (await db.query('SELECT id,workflow_id,result,md5(result::text) AS result_md5 FROM execution_records WHERE id=$1', [options.recordId])).rows[0]
      if (!row) fail('execution record not found')
    } finally { await db.end() }
    const state = decodeExecutionState(row.result)
    if (state.id !== row.id || state.workflowId !== row.workflow_id) fail('decoded execution identity mismatch')
    report.sourceResultMd5 = row.result_md5
    report.workflowId = row.workflow_id
    const selected = selectPreview(state, options.count)
    report.concatRunId = selected.concatRun.id
    report.loopGroupId = selected.concatRun.loopGroupId
    report.finalUrl = selected.stage.url
    report.finalFile = localVideo(selected.stage.url)
    report.savedQuality = { manualReviewRequired: selected.stage.manualReviewRequired, qualityDisposition: selected.stage.qualityDisposition,
      fullVideoListened: selected.stage.voiceConsistency?.fullVideoListened, qualityWarningCount: selected.stage.qualityWarnings?.length ?? 0 }
    if (options.expectedReference) {
      report.expectedReference = { url: options.expectedReference, sha256: await hashFile(path.join(root, 'public', options.expectedReference)),
        scope: 'saved-input-reference-presence-only; actual identity requires visual review' }
    }
    const mediaDir = path.join(options.out, 'media'), framesDir = path.join(options.out, 'frames')
    await mkdir(mediaDir); await mkdir(framesDir)
    const expectedFrames = []
    for (const shot of selected.shots) {
      const label = String(shot.loopIndex + 1).padStart(2, '0')
      progress('clip-start', { clip: shot.loopIndex + 1, url: shot.clip.url })
      const file = localVideo(shot.clip.url), actualSha256 = await hashFile(file)
      if (actualSha256 !== shot.clip.sha256) fail(`clip ${label} bytes differ from concat source SHA`)
      const [raw, normalized] = await Promise.all([probe(file), probe(shot.normalized)])
      if (normalized.width !== selected.stage.width || normalized.height !== selected.stage.height || !/Video: h264/.test(normalized.videoStream)
        || !/24 tbr/.test(normalized.videoStream) || !/Audio: aac/.test(normalized.audioStream) || !/48000 Hz, stereo/.test(normalized.audioStream)) fail(`clip ${label} normalized profile mismatch`)
      const rawDecode = await decodeBoth(file), normalizedDecode = await decodeBoth(shot.normalized)
      const hashes = await frameHashes(shot.normalized, path.join(mediaDir, `clip-${label}-normalized.framemd5`))
      const finalStartFrame = expectedFrames.length
      expectedFrames.push(...hashes.frames.map(frame => frame.md5))
      const relevantRuns = shot.scope.filter(run => ['video_take', 'first_frame', 'first_frame_candidate', 'first_frame_images', 'character_assets'].includes(run.node?.resultVar))
      const referencePaths = options.expectedReference ? relevantRuns.flatMap(run => referenceHits(run.inputs, options.expectedReference, `${run.id}.inputs`)
        .concat(referenceHits({ character_assets: run.inputContext?.character_assets, character_lookup: run.inputContext?.character_lookup,
          character_visual_context: run.inputContext?.character_visual_context }, options.expectedReference, `${run.id}.inputContext`))) : []
      const entry = { order: shot.loopIndex + 1, loopIndex: shot.loopIndex, acceptedRunId: shot.accepted.id, shotId: shot.script.id,
        sourceUrl: shot.clip.url, originalUrl: shot.take.url, sourceFile: file, sourceSha256: actualSha256, sourceShaMatches: true,
        plannedDuration: shot.script.duration, raw: { ...raw, metadataText: undefined }, normalized: { ...normalized, metadataText: undefined, file: shot.normalized },
        rawDecode, normalizedDecode, nativeFrameCount: hashes.frames.length, finalStartFrame, finalEndFrame: expectedFrames.length - 1,
        frameHashesFile: hashes.file, frameHashesEvidenceSha256: hashes.evidenceSha256,
        savedEvidence: { url: shot.evidence.evidenceUrl, sha256: shot.evidence.sha256, decoded: shot.evidence.decoded,
          firstFrameDifference: shot.evidence.firstFrameDifference, speechEvidenceStatus: shot.evidence.speechEvidenceStatus },
        shot: { characters: shot.script.characters, characterVisuals: shot.script.characterVisuals, action: shot.script.action,
          actions: shot.script.actions, storyProgress: shot.script.storyProgress, audioType: shot.script.audioType, audioText: shot.script.audioText },
        savedWarnings: shot.accepted.output.qualityWarnings ?? shot.accepted.output.qualityReview?.warnings ?? [], referencePaths }
      report.clips.push(entry)
      await writeFile(path.join(mediaDir, `clip-${label}-metadata.txt`), `ORIGINAL\n${raw.metadataText}\nNORMALIZED\n${normalized.metadataText}`, { flag: 'wx' })
      await writeFile(path.join(options.out, `shot-${label}.json`), JSON.stringify(shot.script, null, 2), { flag: 'wx' })
      progress('clip-complete', { clip: entry.order, rawDuration: raw.duration, normalizedDuration: normalized.duration, nativeFrameCount: entry.nativeFrameCount })
    }
    progress('final-decode-start')
    const final = await probe(report.finalFile)
    report.final = { ...final, metadataText: undefined, sha256: await hashFile(report.finalFile), decode: await decodeBoth(report.finalFile) }
    if (final.width !== selected.stage.width || final.height !== selected.stage.height || !/Video: h264/.test(final.videoStream)
      || !/24 tbr/.test(final.videoStream) || !/Audio: aac/.test(final.audioStream) || !/48000 Hz, stereo/.test(final.audioStream)) fail('final output profile mismatch')
    await writeFile(path.join(mediaDir, 'final-metadata.txt'), final.metadataText, { flag: 'wx' })
    const hashes = await frameHashes(report.finalFile, path.join(mediaDir, 'final.framemd5'))
    const mismatch = expectedFrames.findIndex((hash, index) => hash !== hashes.frames[index]?.md5)
    report.videoFrameProof = { expectedFrameCount: expectedFrames.length, actualFrameCount: hashes.frames.length,
      allFramesMatchInOrder: mismatch === -1 && expectedFrames.length === hashes.frames.length,
      firstMismatchFrame: mismatch === -1 ? null : mismatch, sourceSequenceSha256: digest(expectedFrames.join('\n')),
      finalSequenceSha256: digest(hashes.frames.map(frame => frame.md5).join('\n')), finalFrameHashesFile: hashes.file,
      frameTimeBase: hashes.timeBase, frameTimeSemantics: 'framemd5-output-PTS-relative-to-first-video-frame; images select actual decoded frame indices',
      comparison: 'decoded-pixel-MD5 of every normalized source video frame against final frames; excludes audio content' }
    report.duration = { rawSum: report.clips.reduce((sum, clip) => sum + clip.raw.duration, 0),
      normalizedSum: report.clips.reduce((sum, clip) => sum + clip.normalized.duration, 0), final: final.duration, toleranceSeconds: 0.5 }
    report.duration.difference = final.duration - report.duration.normalizedSum
    if (!report.videoFrameProof.allFramesMatchInOrder || Math.abs(report.duration.difference) > report.duration.toleranceSeconds) fail('final frame sequence or normalized total duration mismatch')
    const picks = report.clips.flatMap(clip => [clip.finalStartFrame, clip.finalStartFrame + Math.floor((clip.nativeFrameCount - 1) / 2), clip.finalEndFrame])
    const cuts = report.clips.slice(1).map(clip => ({ beforeShot: clip.order - 1, afterShot: clip.order,
      indices: [clip.finalStartFrame - 2, clip.finalStartFrame - 1, clip.finalStartFrame, clip.finalStartFrame + 1]
        .filter(index => index >= 0 && index < hashes.frames.length) }))
    const indices = [...new Set([...picks, ...cuts.flatMap(cut => cut.indices)])].sort((a, b) => a - b)
    const select = indices.map(index => `eq(n\\,${index})`).join('+')
    await runFfmpeg(['-v', 'error', '-xerror', '-i', report.finalFile, '-map', '0:v:0', '-an', '-vf', `select=${select}`,
      '-fps_mode', 'passthrough', '-q:v', '2', path.join(framesDir, 'selected-%03d.jpg')])
    const extracted = new Map()
    for (const [ordinal, index] of indices.entries()) {
      const filename = path.join(framesDir, `frame-${String(index).padStart(5, '0')}.jpg`)
      await rename(path.join(framesDir, `selected-${String(ordinal + 1).padStart(3, '0')}.jpg`), filename)
      extracted.set(index, { path: filename, nativeFrameIndex: index, second: hashes.frames[index].second, sha256: await hashFile(filename) })
    }
    report.shotFrames = report.clips.map(clip => ({ shot: clip.order, frames: [clip.finalStartFrame,
      clip.finalStartFrame + Math.floor((clip.nativeFrameCount - 1) / 2), clip.finalEndFrame].map((index, ordinal) => ({ role: ['first', 'middle', 'last'][ordinal], ...extracted.get(index) })) }))
    report.boundaries = cuts.map(cut => ({ ...cut, frames: cut.indices.map(index => extracted.get(index)) }))
    report.contactSheets = []
    for (let start = 0; start < report.shotFrames.length; start += 5) {
      const group = report.shotFrames.slice(start, start + 5)
      report.contactSheets.push(await sheet(group.flatMap(shot => shot.frames.map(frame => ({ ...frame,
        label: `S${shot.shot} ${frame.role}  n=${frame.nativeFrameIndex} t=${frame.second.toFixed(3)}` }))), 3,
      path.join(options.out, `shots-${String(start + 1).padStart(2, '0')}-${String(start + group.length).padStart(2, '0')}.jpg`)))
    }
    if (report.boundaries.length) report.contactSheets.push(await sheet(report.boundaries.flatMap(cut => cut.frames.map(frame => ({ ...frame,
      label: `S${cut.beforeShot}>S${cut.afterShot}  n=${frame.nativeFrameIndex} t=${frame.second.toFixed(3)}` }))), 4, path.join(options.out, 'boundaries.jpg')))
    const volume = await runFfmpeg(['-i', report.finalFile, '-vn', '-af', 'volumedetect', '-f', 'null', '-'])
    const silence = await runFfmpeg(['-i', report.finalFile, '-vn', '-af', 'silencedetect=noise=-50dB:d=0.25', '-f', 'null', '-'])
    await writeFile(path.join(mediaDir, 'audio-volume.txt'), volume.stderr, { flag: 'wx' })
    await writeFile(path.join(mediaDir, 'audio-silence.txt'), silence.stderr, { flag: 'wx' })
    const wav = path.join(options.out, 'final-audio.wav')
    await runFfmpeg(['-v', 'error', '-xerror', '-i', report.finalFile, '-map', '0:a:0', '-vn', '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', wav])
    report.audio = { hasAudio: final.hasAudio, meanVolumeDb: Number(volume.stderr.match(/mean_volume:\s*(-?[\d.]+) dB/)?.[1] ?? '-Infinity'),
      maxVolumeDb: Number(volume.stderr.match(/max_volume:\s*(-?[\d.]+) dB/)?.[1] ?? '-Infinity'), silenceDetectionThresholdDb: -50,
      silenceDetectionMinimumSeconds: 0.25, silenceEvents: silence.stderr.split('\n').filter(line => /silence_(?:start|end):/.test(line)),
      listeningFile: wav, listeningFileSha256: await hashFile(wav), listened: false,
      note: 'Stream decode, level and silence evidence do not certify speech, speaker, effects, lip-sync, or complete listening.' }
    if (report.clips.some(clip => options.expectedReference && !clip.referencePaths.length && clip.shot.characters?.includes('张飞'))) report.warnings.push('Expected image URL is not visible in every saved per-shot input scope. Element-ID-only or first-frame binding needs separate provenance verification; this audit does not infer it.')
    report.technicalPassed = true
    report.completedAt = new Date().toISOString()
    await writeFile(path.join(options.out, 'audit.json'), JSON.stringify(report, null, 2), { flag: 'wx' })
    progress('audit-complete', { recordId: options.recordId, technicalPassed: true, clips: report.clips.length,
      duration: final.duration, frameCount: hashes.frames.length, out: options.out, fullVideoListened: false, subjectiveReview: 'pending' })
    return report
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error)
    report.stoppedAt = new Date().toISOString()
    await writeFile(path.join(options.out, 'failed-audit.json'), JSON.stringify(report, null, 2), { flag: 'wx' })
    throw error
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  if (options.help) {
    console.log('node scripts/audit-ten-shot-preview.mjs --record RECORD [--out FRESH_DIR] [--expected-reference /generated/IMAGE.jpg] [--count 10]\nReads one saved record and existing local clips/caches. Writes QA evidence only. No models, concat, DB writes, or automatic content/listening approval. Existing QA directory markers are never overwritten.')
    return
  }
  await audit(options)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
