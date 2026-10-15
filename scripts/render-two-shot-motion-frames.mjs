#!/usr/bin/env node
// Render every saved native video frame into a fresh local QA directory.
// Reads one execution record and its existing media. Never calls a model or provider.
import { createHash } from 'node:crypto'
import { readFile, mkdir, readdir, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import pg from 'pg'
import sharp from 'sharp'
import ffmpeg from 'ffmpeg-static'
import { decodeExecutionState } from '../src/execution-storage.ts'

const root = path.resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
const options = { record: '', out: '', count: 2, evidenceOnly: false }
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--record' && !options.record && args[index + 1]) options.record = args[++index]
  else if (args[index] === '--out' && !options.out && args[index + 1]) options.out = args[++index]
  else if (args[index] === '--count' && args[index + 1]) options.count = Number(args[++index])
  else if (args[index] === '--evidence-only') options.evidenceOnly = true
  else throw Error(`Unknown or incomplete argument: ${args[index]}`)
}
if (!/^record-[\w-]+$/.test(options.record) || !options.out || ![1, 2].includes(options.count)) {
  throw Error('Usage: node scripts/render-two-shot-motion-frames.mjs --record record-ID --out FRESH_QA_DIR [--count 1|2] [--evidence-only]')
}
const out = path.resolve(options.out)
const mediaRoot = path.join(root, 'public/generated')
const relativeToMedia = path.relative(mediaRoot, out)
if (!relativeToMedia || relativeToMedia !== '..' && !relativeToMedia.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeToMedia)) {
  throw Error('QA output must not be inside public/generated')
}
const localVideo = url => /^\/generated\/[\w.-]+\.mp4$/.test(url ?? '') ? path.join(root, 'public', url) : null
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const latest = (runs, id, loopIndex) => runs.filter(run => run.status === 'success'
  && run.node?.id === id && run.loopIndex === loopIndex).at(-1)
const ffmpegRun = args => {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'info', '-xerror', ...args],
    { encoding: 'utf8', timeout: 180_000, maxBuffer: 16 * 1024 * 1024 })
  if (result.status !== 0) throw Error(`FFmpeg failed: ${result.stderr?.slice(-1200) || result.error?.message}`)
  return result.stderr
}
const frameTimes = stderr => [...stderr.matchAll(/\bn:\s*(\d+)\s+pts:\s*(-?\d+)\s+pts_time:\s*(-?[\d.]+)/g)]
  .map(match => ({ index: Number(match[1]), pts: Number(match[2]), second: Number(match[3]) }))
const sheet = async (frames, destination) => {
  const columns = 6, tileWidth = 320, tileHeight = 180, labelHeight = 26
  const cells = await Promise.all(frames.map(async (frame, index) => ({
    input: await sharp(frame.path).resize(tileWidth, tileHeight, { fit: 'contain', background: '#111' })
      .extend({ bottom: labelHeight, background: '#eee' })
      .composite([{ input: Buffer.from(`<svg width="${tileWidth}" height="${labelHeight}"><text x="8" y="18" font-size="13" font-family="Arial" fill="#111">S${frame.shot} n=${frame.index} t=${frame.second.toFixed(3)}</text></svg>`),
        left: 0, top: tileHeight }]).jpeg({ quality: 89 }).toBuffer(),
    left: index % columns * tileWidth,
    top: Math.floor(index / columns) * (tileHeight + labelHeight),
  })))
  await sharp({ create: { width: columns * tileWidth,
    height: Math.ceil(frames.length / columns) * (tileHeight + labelHeight),
    channels: 3, background: '#eee' } }).composite(cells).jpeg({ quality: 92 }).toFile(destination)
  return destination
}

const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
let row
await db.connect()
try {
  await db.query('BEGIN READ ONLY')
  row = (await db.query('SELECT id, workflow_id, md5(result::text) AS result_md5, result FROM execution_records WHERE id=$1', [options.record])).rows[0]
  await db.query('COMMIT')
} catch (error) {
  await db.query('ROLLBACK').catch(() => undefined)
  throw error
} finally { await db.end() }
if (!row) throw Error(`Record not found: ${options.record}`)
const state = decodeExecutionState(row.result)
const runs = state.nodeRuns ?? []
const inputs = Array.from({ length: options.count }, (_value, loopIndex) => loopIndex).map(loopIndex => {
  const accepted = latest(runs, 'sanguo-media-accept', loopIndex)
  const evidence = latest(runs, 'sanguo-video-evidence', loopIndex)
  const script = latest(runs, 'sanguo-shot-script', loopIndex)
  const clip = options.evidenceOnly ? evidence?.output : accepted?.output
  if (!clip || !evidence?.output?.decoded || !script?.output
    || !options.evidenceOnly && !clip.passed
    || clip.url !== evidence.output.url || clip.sha256 !== evidence.output.sha256
    || clip.originalUrl !== evidence.output.originalUrl) {
    throw Error(`Shot ${loopIndex + 1} has no matching ${options.evidenceOnly ? 'decoded' : 'accepted'} clip and saved evidence`)
  }
  const filename = localVideo(clip.url)
  if (!filename) throw Error(`Shot ${loopIndex + 1} media is not a local generated video`)
  return { loopIndex, clip, evidence: evidence.output, script: script.output, filename,
    acceptStatus: accepted?.status ?? 'missing' }
})
for (const input of inputs) {
  const actual = sha256(await readFile(input.filename))
  if (actual !== input.clip.sha256) throw Error(`Shot ${input.loopIndex + 1} local media hash differs from saved evidence`)
}
await mkdir(out, { recursive: true })
if ((await readdir(out)).length) throw Error('QA output must be an empty fresh directory')
await writeFile(path.join(out, '.audit-run'), JSON.stringify({ recordId: options.record, sourceResultMd5: row.result_md5 }), { flag: 'wx' })

const report = { version: 'two-shot-native-motion-frames-v1', recordId: options.record,
  workflowId: row.workflow_id, sourceResultMd5: row.result_md5, databaseReadOnly: true,
  modelsCalled: 0, providersCalled: 0, mediaRegenerated: false, visualJudgment: 'pending',
  requestedShotCount: options.count, evidenceOnly: options.evidenceOnly,
  shots: [], boundarySheet: null }
for (const input of inputs) {
  const number = input.loopIndex + 1
  const directory = path.join(out, `shot-${number}`)
  await mkdir(directory)
  const stderr = ffmpegRun(['-i', input.filename, '-map', '0:v:0', '-an', '-vf', 'showinfo,scale=640:-2',
    '-fps_mode', 'passthrough', '-q:v', '3', path.join(directory, 'frame-%05d.jpg')])
  const times = frameTimes(stderr)
  const filenames = (await readdir(directory)).filter(name => /^frame-\d{5}\.jpg$/.test(name)).sort()
  if (!times.length || filenames.length !== times.length || times.some((frame, index) => frame.index !== index
    || index > 0 && frame.second <= times[index - 1].second)) {
    throw Error(`Shot ${number} extraction does not match monotonically ordered native frames`)
  }
  const savedCount = input.evidence.nativeSequence?.totalNativeFrames
  if (savedCount && times.length !== savedCount) throw Error(`Shot ${number} native frame count differs from saved evidence`)
  const frames = times.map((frame, index) => ({ shot: number, ...frame,
    path: path.join(directory, filenames[index]) }))
  const sheets = []
  for (let start = 0; start < frames.length; start += 48) {
    sheets.push(await sheet(frames.slice(start, start + 48),
      path.join(out, `shot-${number}-frames-${String(start).padStart(4, '0')}-${String(Math.min(start + 47, frames.length - 1)).padStart(4, '0')}.jpg`)))
  }
  report.shots.push({ shot: number, shotId: input.script.id, url: input.clip.url,
    sha256: input.clip.sha256, evidenceUrl: input.evidence.evidenceUrl,
    acceptStatusAtAudit: input.acceptStatus,
    nativeFrameCount: frames.length, firstSecond: frames[0].second,
    lastSecond: frames.at(-1).second, savedNativeFrameCount: savedCount ?? null,
    frames: frames.map(({ index, pts, second, path }) => ({ index, pts, second, path })),
    contactSheets: sheets })
  console.log(JSON.stringify({ stage: 'shot-rendered', shot: number, frames: frames.length, sheets: sheets.length }))
}
if (report.shots.length === 2) {
  const boundaryFrames = [
    ...report.shots[0].frames.slice(-24).map(frame => ({ ...frame, shot: 1 })),
    ...report.shots[1].frames.slice(0, 24).map(frame => ({ ...frame, shot: 2 })),
  ]
  report.boundarySheet = await sheet(boundaryFrames, path.join(out, 'boundary-last-first-native-frames.jpg'))
}
await writeFile(path.join(out, 'audit.json'), JSON.stringify(report, null, 2), { flag: 'wx' })
console.log(JSON.stringify({ stage: 'complete', out, boundarySheet: report.boundarySheet,
  nativeFrameCounts: report.shots.map(shot => shot.nativeFrameCount), visualJudgment: 'pending' }))
