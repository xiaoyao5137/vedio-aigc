import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { isPublicInternetUrl } from './web-sources.ts'
import { videoDimensions, type VideoResolution } from '../src/video-output-profile.ts'

const exec = promisify(execFile)
const bundledFfmpeg = createRequire(import.meta.url)('ffmpeg-static') as string
const MAX_CLIPS = 200
const MAX_CLIP_BYTES = 500 * 1024 * 1024
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024

type VideoReference = { url: string; sourceUrl?: string; sha256?: string }
export type VideoConcatRequest = {
  videos?: unknown
  previousVideo?: unknown
  currentVideo?: unknown
  format?: unknown
  resolution?: unknown
  aspectRatio?: unknown
  aspect_ratio?: unknown
}
export type VideoConcatResult = {
  url: string
  clips: VideoReference[]
  count: number
  format: 'mp4'
  concatMode: 'normalized-stream-copy'
  sourceSha256: string[]
  resolution: VideoResolution
  width: number
  height: number
  fps: 24
  audioSampleRate: 48000
}

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
function invalid(reason: string): never { throw Error('VIDEO_CONCAT_INVALID: ' + reason) }

function videoUrl(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  return typeof record.url === 'string' && record.url.trim() ? record.url.trim() : undefined
}

/** Preserve original clip order. A previous concat result contributes its source
 * clips instead of the already-concatenated file, so every round rebuilds from
 * originals and never accumulates generational encoding loss. */
export function resolveVideoConcatSources(request: VideoConcatRequest): VideoReference[] {
  const sources: VideoReference[] = []
  const append = (value: unknown) => {
    if (value === undefined || value === null || value === '') return
    if (Array.isArray(value)) { value.forEach(append); return }
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>
      if (Array.isArray(record.clips)) { record.clips.forEach(append); return }
      if (Array.isArray(record.items) && !videoUrl(record)) { record.items.forEach(append); return }
    }
    const url = videoUrl(value)
    if (!url) invalid('视频输入必须是 URL、含 url 的对象、数组，或已有拼接结果')
    sources.push({ url, sourceUrl: url })
  }
  append(request.videos)
  append(request.previousVideo)
  append(request.currentVideo)
  if (!sources.length) invalid('至少需要一个视频输入')
  if (sources.length > MAX_CLIPS) invalid(`视频片段不能超过 ${MAX_CLIPS} 个`)
  return sources
}

async function boundedRemoteVideo(url: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) })
  if (!response.ok || !response.body) invalid(`视频下载失败 HTTP ${response.status}`)
  const body = response.body
  const chunks: Uint8Array[] = []
  let bytes = 0
  for await (const chunk of body) {
    bytes += chunk.length
    if (bytes > MAX_CLIP_BYTES) invalid('单个视频超过 500MB')
    chunks.push(chunk)
  }
  if (!bytes) invalid('视频内容为空')
  return Buffer.concat(chunks, bytes)
}

async function materializeVideo(reference: VideoReference, root: string, cacheDir: string) {
  const bytes = /^\/generated\/[\w.-]+\.(?:mp4|mov|webm)$/i.test(reference.url)
    ? await readFile(path.join(root, 'public', reference.url))
    : isPublicInternetUrl(reference.url)
      ? await boundedRemoteVideo(reference.url)
      : invalid('仅接受 /generated/ 下的本地视频或公开 HTTP(S) 视频 URL')
  if (!bytes.length || bytes.length > MAX_CLIP_BYTES) invalid('单个视频必须在 1B 到 500MB 之间')
  const digest = sha256(bytes)
  const filename = path.join(cacheDir, `${digest}.video`)
  try { await access(filename) } catch { await writeFile(filename, bytes, { flag: 'wx' }).catch(async error => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }) }
  return { filename, bytes: bytes.length, reference: { ...reference, sha256: digest } }
}

async function hasAudioStream(filename: string, ffmpeg: string, run: typeof exec) {
  try {
    await run(ffmpeg, [
      '-hide_banner', '-nostdin', '-v', 'error', '-i', filename,
      '-map', '0:a:0', '-t', '0.001', '-f', 'null', '-',
    ], { timeout: 30000, maxBuffer: 1024 * 1024 })
    return true
  } catch (error) {
    const detail = error && typeof error === 'object' && 'stderr' in error ? String((error as { stderr?: unknown }).stderr) : ''
    if (/matches no streams|does not contain any stream/i.test(detail)) return false
    throw error
  }
}

/** The concat demuxer can only stream-copy files whose stream order and codec
 * parameters are identical. Provider videos do not guarantee either (some put
 * AAC before H.264, while locally narrated clips use the opposite order), so
 * normalize every original once and cache that clean intermediate. */
async function normalizeVideo(
  item: Awaited<ReturnType<typeof materializeVideo>>,
  cacheDir: string,
  ffmpeg: string,
  run: typeof exec,
  width: number,
  height: number,
  profileKey: string,
) {
  const filename = path.join(cacheDir, `normalized-v3-${profileKey}-${item.reference.sha256}.mp4`)
  try { await access(filename); return filename } catch { /* build it below */ }
  const temporary = `${filename}.${randomUUID()}.tmp.mp4`
  const hasAudio = await hasAudioStream(item.filename, ffmpeg, run)
  const inputs = hasAudio
    ? ['-i', item.filename]
    : ['-i', item.filename, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo']
  const audioInput = hasAudio ? '0:a:0' : '1:a:0'
  try {
    await run(ffmpeg, [
      '-hide_banner', '-nostdin', '-y', ...inputs,
      '-map', '0:v:0', '-map', audioInput,
      '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=24,setpts=PTS-STARTPTS`,
      '-af', 'aresample=48000,asetpts=PTS-STARTPTS,apad',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '192k',
      '-shortest', '-movflags', '+faststart', temporary,
    ], { timeout: 10 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 })
    await rename(temporary, filename)
  } finally {
    await rm(temporary, { force: true })
  }
  return filename
}

export async function concatenateVideos(
  request: VideoConcatRequest,
  options: { root?: string; ffmpeg?: string; run?: typeof exec } = {},
): Promise<VideoConcatResult> {
  if (request.format !== undefined && String(request.format).toLowerCase() !== 'mp4') invalid('当前输出格式仅支持 mp4')
  const resolution = String(request.resolution ?? '720p').toLowerCase() as VideoResolution
  if (resolution !== '720p' && resolution !== '4k') invalid(`当前输出分辨率仅支持 720p 或 4k，收到 ${resolution}`)
  const aspectRatio = String(request.aspectRatio ?? request.aspect_ratio ?? '16:9')
  let width: number
  let height: number
  try { [width, height] = videoDimensions(resolution, aspectRatio) } catch (error) { invalid(error instanceof Error ? error.message : String(error)) }
  const profileKey = `${resolution}-${width}x${height}-24fps-48k`
  const root = options.root ?? process.cwd()
  const generatedDir = path.join(root, 'public/generated')
  const cacheDir = path.join(root, '.runtime/video-concat-sources')
  const ffmpeg = options.ffmpeg ?? bundledFfmpeg
  const run = options.run ?? exec
  await mkdir(generatedDir, { recursive: true }); await mkdir(cacheDir, { recursive: true })
  const materialized = []
  let totalBytes = 0
  for (const source of resolveVideoConcatSources(request)) {
    const item = await materializeVideo(source, root, cacheDir)
    totalBytes += item.bytes
    if (totalBytes > MAX_TOTAL_BYTES) invalid('本次视频输入总量超过 2GB')
    materialized.push(item)
  }
  const normalized = []
  for (const item of materialized) normalized.push(await normalizeVideo(item, cacheDir, ffmpeg, run, width, height, profileKey))
  const identity = sha256(JSON.stringify({ version: 3, format: 'mp4', resolution, width, height, fps: 24, audioSampleRate: 48000, sources: materialized.map(item => item.reference.sha256) }))
  const filename = `video-concat-${identity.slice(0, 32)}.mp4`
  const destination = path.join(generatedDir, filename)
  try { await access(destination) } catch {
    const listFile = path.join(cacheDir, `${identity}-${randomUUID()}.txt`)
    const temporary = path.join(generatedDir, `.${filename}-${randomUUID()}.tmp.mp4`)
    await writeFile(listFile, normalized.map(filename => `file '${filename}'`).join('\n') + '\n', { flag: 'wx' })
    try {
      await run(ffmpeg, [
        '-hide_banner', '-nostdin', '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
        '-map', '0:v:0', '-map', '0:a?', '-c', 'copy', '-movflags', '+faststart', temporary,
      ], { timeout: 10 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 })
      await run(ffmpeg, [
        '-hide_banner', '-nostdin', '-v', 'error', '-xerror', '-i', temporary,
        '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-',
      ], { timeout: 10 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 })
      await rename(temporary, destination)
    } catch (error) {
      const detail = error && typeof error === 'object' && 'stderr' in error ? String((error as { stderr?: unknown }).stderr).split('\n').slice(-8).join('；') : String(error)
      throw Error(`VIDEO_CONCAT_FAILED: 视频流参数不兼容或拼接失败；请统一编码、分辨率和音轨后重试。${detail}`, { cause: error })
    } finally {
      await rm(listFile, { force: true }); await rm(temporary, { force: true })
    }
  }
  return {
    url: `/generated/${filename}`,
    clips: materialized.map(item => item.reference),
    count: materialized.length,
    format: 'mp4',
    concatMode: 'normalized-stream-copy',
    sourceSha256: materialized.map(item => item.reference.sha256!),
    resolution,
    width,
    height,
    fps: 24,
    audioSampleRate: 48000,
  }
}
