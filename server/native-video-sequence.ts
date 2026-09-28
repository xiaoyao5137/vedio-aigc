import { createHash } from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import { open, mkdir, mkdtemp, link, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

export type NativeSequenceOptions = {
  enabled: boolean
  windows?: Array<{ start: number; end: number }>
  reviewMaxFrames?: number
  archiveMaxFrames?: number
  archiveMaxBytes?: number
  decodeTimeoutMs?: number
}
export type NativeSequenceConfig = Required<NativeSequenceOptions>
export type NativeFrame = {
  nativeFrameIndex: number; pts: number; timeBase: string; durationPTS: number
  second: number; width: number; height: number; url: string; sourceSha256: string; byteLength: number
}
export const NATIVE_REVIEW_SELECTION_VERSION = 2
export type NativeFrameReference = NativeFrame & { index: number; evidenceIndex: number;
  displayStartSecond: number; displayEndSecond: number; displayEndBasis: 'duration-pts' | 'next-pts' | 'unavailable';
  nextNativeFrameIndex: number | null; nextFramePTS: number | null }
export type NativeFrameArchive = {
  version: 1; complete: true; sourceVideoSha256: string; sourceVideoUrl: string
  decoder: string; recipe: string; timeBase: string; firstPTS: number
  metadataText: string; frames: NativeFrame[]; totalBytes: number
}
const MIB = 1024 * 1024
const MAX_SOURCE_BYTES = 250 * MIB
const MAX_FRAME_BYTES = 5 * MIB
const MAX_METADATA_BYTES = 8 * MIB
const MAX_FRAME_PIXELS = 16_777_216
const RECIPE = 'native-jpeg-v1:copyts,noautorotate,showinfo,passthrough,mjpeg-q2'
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const invalid = (reason: string): never => { throw Error('MEDIA_NATIVE_SEQUENCE_INVALID: ' + reason) }
const limit = (reason: string): never => { throw Error('MEDIA_NATIVE_SEQUENCE_LIMIT: ' + reason + '；未截断或降低采样') }

export function resolveNativeSequenceConfig(value: unknown): NativeSequenceConfig | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('nativeSequence 必须是配置对象')
  const input = value as Record<string, unknown>
  if (typeof input.enabled !== 'boolean') invalid('enabled 必须是布尔值')
  if (!input.enabled) return undefined
  if (!Array.isArray(input.windows) || !input.windows.length || input.windows.length > 128 || input.windows.some(window =>
    !window || typeof window !== 'object' || !Number.isFinite(window.start) || !Number.isFinite(window.end) || window.start < 0 || window.end < window.start)) invalid('windows 必须为 1..128 个有效非负时间窗')
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const result = input[key] ?? fallback
    if (!Number.isSafeInteger(result) || Number(result) < min || Number(result) > max) invalid(`${key} 必须是 ${min}..${max} 的整数`)
    return Number(result)
  }
  const windows = (input.windows as Array<{ start: number; end: number }>).map(window => ({ start: window.start, end: window.end }))
    .sort((a, b) => a.start - b.start || a.end - b.end).filter((window, index, all) => !index || window.start !== all[index - 1].start || window.end !== all[index - 1].end)
  return { enabled: true, windows, reviewMaxFrames: integer('reviewMaxFrames', 160, 2, 3600),
    archiveMaxFrames: integer('archiveMaxFrames', 3600, 2, 10000),
    archiveMaxBytes: integer('archiveMaxBytes', 256 * MIB, 1, 512 * MIB),
    decodeTimeoutMs: integer('decodeTimeoutMs', 60000, 1000, 120000) }
}

/** Read PTS integers and rational time base, not showinfo's rounded pts_time.
 * Continuous means every decoded frame ordinal is present, never an fps grid. */
export function parseNativeFrameMetadata(stderr: string) {
  const bases = [...stderr.matchAll(/config in time_base:\s*(\d+)\/(\d+)/g)].map(match => [Number(match[1]), Number(match[2])])
  if (!bases.length || bases.some(([n, d]) => !Number.isSafeInteger(n) || !Number.isSafeInteger(d) || n <= 0 || d <= 0 || n !== bases[0][0] || d !== bases[0][1])) invalid('原生解码 time_base 缺失或变化')
  const [numerator, denominator] = bases[0], timeBase = `${numerator}/${denominator}`
  const rows = [...stderr.matchAll(/\bn:\s*(\d+)\s+pts:\s*(-?\d+)\s+pts_time:\s*\S+\s+duration:\s*(\d+)\s+duration_time:\s*\S+[^\n]*?\bs:(\d+)x(\d+)/g)]
  if (!rows.length) invalid('没有带真实 PTS 的解码帧')
  const firstPTS = Number(rows[0][2])
  const frames = rows.map((match, index) => {
    const nativeFrameIndex = Number(match[1]), pts = Number(match[2]), durationPTS = Number(match[3]), width = Number(match[4]), height = Number(match[5])
    if (nativeFrameIndex !== index || !Number.isSafeInteger(pts) || !Number.isSafeInteger(durationPTS) || durationPTS < 0
      || pts < firstPTS || index > 0 && pts <= Number(rows[index - 1][2])) invalid('原生帧编号缺失、重复或 PTS 非严格递增')
    if (!width || !height || width * height > MAX_FRAME_PIXELS) limit('原生帧像素尺寸超过限制')
    return { nativeFrameIndex, pts, timeBase, durationPTS, second: (pts - firstPTS) * numerator / denominator, width, height }
  })
  return { firstPTS, timeBase, frames }
}

/** Select real frame display intervals intersecting each window, retaining
 * original PTS and legacy seeks. A boundary support frame keeps its earlier
 * PTS; neither a requested boundary nor the container duration invents one. */
export function selectNativeReviewFrames(archive: NativeFrameArchive, sampleTimes: number[], config: NativeSequenceConfig, duration: number) {
  if (!Number.isFinite(duration) || duration <= 0 || !archive.complete || !archive.frames.length) invalid('原生档案或实际时长无效')
  if (sampleTimes.some(time => !Number.isFinite(time) || time < 0 || time > duration)) invalid('需保留的原采样时间无效')
  if (config.windows.some(window => window.end > duration + 1e-6)) invalid('连续时间窗不得超过实际视频时长')
  const frames = archive.frames
  const epsilon = 1e-9
  const match = /^(\d+)\/(\d+)$/.exec(archive.timeBase)
  const numerator = Number(match?.[1]), denominator = Number(match?.[2])
  if (!Number.isSafeInteger(archive.firstPTS) || !Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)
    || numerator <= 0 || denominator <= 0) invalid('显示区间缺少真实PTS时间基准')
  const displays = frames.map((frame, index) => {
    const next = frames[index + 1]
    if (frame.nativeFrameIndex !== index || frame.timeBase !== archive.timeBase || !Number.isSafeInteger(frame.pts)
      || frame.second !== (frame.pts - archive.firstPTS) * numerator / denominator || frame.second < 0 || frame.second > duration
      || !Number.isSafeInteger(frame.durationPTS) || frame.durationPTS < 0 || next && next.pts <= frame.pts) invalid('显示区间的原生帧编号、PTS或durationPTS无效')
    const durationEndPTS = frame.durationPTS > 0 ? frame.pts + frame.durationPTS : undefined
    if (durationEndPTS !== undefined && !Number.isSafeInteger(durationEndPTS)) invalid('显示区间的durationPTS相加超出安全整数范围')
    const endPTS = durationEndPTS === undefined ? next?.pts : Math.min(durationEndPTS, next?.pts ?? durationEndPTS)
    return { ...frame, displayStartSecond: frame.second,
      displayEndSecond: endPTS === undefined ? frame.second : Math.min(duration, (endPTS - archive.firstPTS) * numerator / denominator),
      displayEndBasis: (durationEndPTS !== undefined ? 'duration-pts' : next ? 'next-pts' : 'unavailable') as NativeFrameReference['displayEndBasis'],
      nextNativeFrameIndex: next?.nativeFrameIndex ?? null, nextFramePTS: next?.pts ?? null }
  })
  const samples = sampleTimes.map(requestedSecond => {
    const frame = frames.find(frame => frame.second + epsilon >= requestedSecond)
    // A valid seek within the final displayed frame refers to the actual tail.
    return { requestedSecond, nativeFrameIndex: (frame ?? frames.at(-1)!).nativeFrameIndex,
      actualSecond: (frame ?? frames.at(-1)!).second, mapping: frame ? 'first-native-pts-at-or-after-seek' : 'actual-tail-for-terminal-seek' }
  })
  const selected = new Set([0, frames.length - 1, ...samples.map(sample => sample.nativeFrameIndex)])
  const windows = config.windows.map(window => {
    const inWindow = frames.filter(frame => frame.second + epsilon >= window.start && frame.second <= window.end + epsilon)
    const ptsIndices = new Set(inWindow.map(frame => frame.nativeFrameIndex))
    const intersecting = displays.filter(frame => ptsIndices.has(frame.nativeFrameIndex)
      || frame.displayStartSecond <= window.end + epsilon && frame.displayEndSecond > window.start + epsilon)
    intersecting.forEach(frame => selected.add(frame.nativeFrameIndex))
    const uncoveredDisplaySpans: Array<{ start: number; end: number }> = []
    let coveredThrough = window.start
    for (const frame of intersecting) {
      const start = Math.max(window.start, frame.displayStartSecond), end = Math.min(window.end, frame.displayEndSecond)
      if (end <= start + epsilon) continue
      if (start > coveredThrough + epsilon) uncoveredDisplaySpans.push({ start: coveredThrough, end: start })
      coveredThrough = Math.max(coveredThrough, end)
    }
    if (coveredThrough < window.end - epsilon) uncoveredDisplaySpans.push({ start: coveredThrough, end: window.end })
    if (window.start === window.end && !intersecting.some(frame => Math.abs(frame.second - window.start) <= epsilon
      || frame.displayStartSecond <= window.start && frame.displayEndSecond > window.start)) uncoveredDisplaySpans.push({ ...window })
    const observedStartSecond = inWindow[0]?.second ?? null, observedEndSecond = inWindow.at(-1)?.second ?? null
    const boundarySpansWithoutFramePTS = !inWindow.length ? [{ start: window.start, end: window.end }]
      : [...(observedStartSecond! > window.start + epsilon ? [{ start: window.start, end: observedStartSecond! }] : []),
          ...(observedEndSecond! < window.end - epsilon ? [{ start: observedEndSecond!, end: window.end }] : [])]
    return { ...window, selectionVersion: NATIVE_REVIEW_SELECTION_VERSION, selectionComplete: true as const,
      complete: uncoveredDisplaySpans.length === 0, displayCoverageComplete: uncoveredDisplaySpans.length === 0,
      coverageSemantics: 'native-frame-display-intersection-v2' as const,
      nativeFrameIndices: intersecting.map(frame => frame.nativeFrameIndex), ptsInWindowNativeFrameIndices: [...ptsIndices],
      boundaryContextNativeFrameIndices: intersecting.filter(frame => !ptsIndices.has(frame.nativeFrameIndex)).map(frame => frame.nativeFrameIndex),
      observedStartSecond, observedEndSecond, boundarySpansWithoutFramePTS, uncoveredDisplaySpans }
  })
  if (selected.size > config.reviewMaxFrames) limit(`连续窗、原覆盖点与真实首尾共 ${selected.size} 帧，超过 reviewMaxFrames=${config.reviewMaxFrames}`)
  const frameReferences: NativeFrameReference[] = displays.filter(frame => selected.has(frame.nativeFrameIndex))
    .map((frame, index) => ({ ...frame, index, evidenceIndex: index }))
  const indexByNative = new Map(frameReferences.map(frame => [frame.nativeFrameIndex, frame.index]))
  return { frameReferences,
    windows: windows.map(window => ({ ...window, evidenceFrameIndices: window.nativeFrameIndices.map(index => indexByNative.get(index)!),
      boundaryContextEvidenceFrameIndices: window.boundaryContextNativeFrameIndices.map(index => indexByNative.get(index)!) })),
    preservedSamples: samples.map(sample => ({ ...sample, evidenceIndex: indexByNative.get(sample.nativeFrameIndex)! })) }
}

async function snapshotSource(source: string, snapshot: string) {
  const input = await open(source, 'r'), output = await open(snapshot, 'wx'), digest = createHash('sha256')
  let bytes = 0
  try {
    for await (const chunk of input.createReadStream({ autoClose: false })) {
      bytes += chunk.length
      if (bytes > MAX_SOURCE_BYTES) limit('源视频超过 250MiB')
      digest.update(chunk)
      await output.writeFile(chunk)
    }
  } finally { await input.close(); await output.close() }
  if (!bytes) invalid('源视频为空')
  return digest.digest('hex')
}

async function publishImmutable(source: string, destination: string, expectedSha256: string) {
  try { await link(source, destination) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if (sha256(await readBoundedFile(destination, MAX_SOURCE_BYTES)) !== expectedSha256) invalid('已有原生档案字节与内容身份冲突；保留原件并停止')
  }
}

async function readBoundedFile(filename: string, maxBytes: number) {
  const handle = await open(filename, 'r'), chunks: Buffer[] = []
  let totalBytes = 0
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      totalBytes += chunk.length
      if (totalBytes > maxBytes) limit('已有原生档案文件超过字节上限')
      chunks.push(chunk)
    }
  } finally { await handle.close() }
  return Buffer.concat(chunks, totalBytes)
}

/** The image2pipe reader enforces byte/frame limits during decoding. It never
 * uses -r, fps, interpolation, resize or silent frame truncation. */
async function decodeNativeJpegs(ffmpeg: string, source: string, stage: string, config: NativeSequenceConfig) {
  const child = spawn(ffmpeg, ['-hide_banner', '-nostdin', '-xerror', '-noautorotate', '-copyts', '-i', source, '-map', '0:v:0', '-an',
    '-vf', 'showinfo', '-vsync', '0', '-frames:v', String(config.archiveMaxFrames + 1), '-c:v', 'mjpeg', '-q:v', '2', '-f', 'image2pipe', '-'],
  { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = '', metadataBytes = 0, rejection: Error | undefined
  const stop = (error: Error) => { rejection ??= error; child.kill('SIGKILL') }
  const timer = setTimeout(() => stop(Error('MEDIA_NATIVE_SEQUENCE_LIMIT: 原生解码超过 decodeTimeoutMs；未截断或降低采样')), config.decodeTimeoutMs)
  const closed = new Promise<number | null>(resolve => {
    child.once('error', error => { rejection ??= error })
    child.once('close', code => resolve(code))
  })
  child.stderr.on('data', (chunk: Buffer) => {
    metadataBytes += chunk.length
    if (metadataBytes > MAX_METADATA_BYTES) stop(Error('MEDIA_NATIVE_SEQUENCE_LIMIT: 解码元数据超过 8MiB；未截断或降低采样'))
    else stderr += chunk.toString('utf8')
  })
  const files: Array<{ filename: string; sourceSha256: string; byteLength: number }> = []
  let pending = Buffer.alloc(0), totalBytes = 0
  try {
    for await (const chunk of child.stdout) {
      if (rejection) throw rejection
      totalBytes += chunk.length
      if (totalBytes > config.archiveMaxBytes) limit(`原生 JPEG 档案超过 archiveMaxBytes=${config.archiveMaxBytes}`)
      pending = Buffer.concat([pending, chunk])
      let end: number
      while ((end = pending.indexOf(Buffer.from([0xff, 0xd9]))) >= 0) {
        const bytes = pending.subarray(0, end + 2)
        if (bytes[0] !== 0xff || bytes[1] !== 0xd8) invalid('原生 JPEG 流边界损坏')
        if (bytes.length > MAX_FRAME_BYTES) limit('原生单帧超过 5MiB')
        if (files.length >= config.archiveMaxFrames) limit(`实际原生帧超过 archiveMaxFrames=${config.archiveMaxFrames}`)
        const filename = path.join(stage, `frame-${files.length}.jpg`)
        await writeFile(filename, bytes, { flag: 'wx' })
        files.push({ filename, sourceSha256: sha256(bytes), byteLength: bytes.length })
        pending = pending.subarray(end + 2)
      }
      if (pending.length > MAX_FRAME_BYTES) limit('原生单帧超过 5MiB')
    }
    const code = await closed
    if (rejection) throw rejection
    if (code !== 0) invalid('原生完整解码失败：' + stderr.split('\n').filter(line => /error|invalid|failed/i.test(line)).slice(-3).join('；'))
    if (pending.length || !files.length) invalid('原生 JPEG 流不完整')
    const metadata = parseNativeFrameMetadata(stderr)
    if (metadata.frames.length !== files.length) invalid('原生 PTS 与实际 JPEG 帧数不一致')
    return { ...metadata, files, totalBytes, metadataText: stderr.split('\n').filter(line => /Duration:|Stream #.*(?:Video:|Audio:)/.test(line)).join('\n') }
  } catch (error) {
    stop(error instanceof Error ? error : Error(String(error)))
    await closed
    throw rejection
  } finally { clearTimeout(timer) }
}

export async function collectNativeFrameArchive(ffmpeg: string, source: string, generatedDir: string, config: NativeSequenceConfig) {
  await mkdir(generatedDir, { recursive: true })
  const stage = await mkdtemp(path.join(generatedDir, '.native-sequence-'))
  try {
    // Decode exactly these private snapshot bytes; later source-file changes
    // cannot change the identity of a partially collected archive.
    const snapshot = path.join(stage, 'source.mp4'), sourceVideoSha256 = await snapshotSource(source, snapshot)
    const { stdout } = await promisify(execFile)(ffmpeg, ['-version'], { timeout: 5000, maxBuffer: 128 * 1024 })
    const decoder = stdout.split('\n')[0], recipeHash = sha256(JSON.stringify({ version: 1, decoder, recipe: RECIPE })).slice(0, 16)
    const namespace = `verified-native-${sourceVideoSha256.slice(0, 20)}-${recipeHash}`
    const archiveName = `${namespace}-archive.json`, archivePath = path.join(generatedDir, archiveName)
    const sourceVideoUrl = `/generated/${namespace}-source.mp4`
    let cached: Buffer | undefined
    try { cached = await readBoundedFile(archivePath, MAX_METADATA_BYTES) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (cached) {
      const archive = JSON.parse(cached.toString('utf8')) as NativeFrameArchive
      if (archive.version !== 1 || archive.complete !== true || archive.sourceVideoSha256 !== sourceVideoSha256 || archive.decoder !== decoder || archive.recipe !== RECIPE
        || archive.sourceVideoUrl !== sourceVideoUrl || !Array.isArray(archive.frames) || !archive.frames.length) invalid('已有原生档案身份或结构无效')
      if (archive.frames.length > config.archiveMaxFrames) limit('已有原生档案超过 archiveMaxFrames')
      const base = archive.timeBase?.match(/^(\d+)\/(\d+)$/), numerator = Number(base?.[1]), denominator = Number(base?.[2])
      if (!Number.isSafeInteger(archive.firstPTS) || !Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || numerator <= 0 || denominator <= 0) invalid('已有原生档案 PTS 基准无效')
      let totalBytes = 0
      for (const [index, frame] of archive.frames.entries()) {
        if (frame.nativeFrameIndex !== index || frame.url !== `/generated/${namespace}-frame-${index}.jpg` || frame.timeBase !== archive.timeBase
          || !Number.isSafeInteger(frame.pts) || !Number.isFinite(frame.second) || frame.second !== (frame.pts - archive.firstPTS) * numerator / denominator
          || index === 0 && frame.second !== 0 || index > 0 && frame.second <= archive.frames[index - 1].second
          || !Number.isSafeInteger(frame.durationPTS) || frame.durationPTS < 0 || !Number.isSafeInteger(frame.width) || !Number.isSafeInteger(frame.height)
          || frame.width <= 0 || frame.height <= 0 || frame.width * frame.height > MAX_FRAME_PIXELS) invalid('已有原生档案帧映射无效')
        const bytes = await readBoundedFile(path.join(generatedDir, path.basename(frame.url)), MAX_FRAME_BYTES)
        totalBytes += bytes.length
        if (bytes.length > MAX_FRAME_BYTES || totalBytes > config.archiveMaxBytes) limit('已有原生档案超过本次字节预算')
        if (bytes.length !== frame.byteLength || sha256(bytes) !== frame.sourceSha256) invalid('已有原生档案帧字节已变化')
      }
      if (archive.totalBytes !== totalBytes) invalid('已有原生档案字节总数不一致')
      await publishImmutable(snapshot, path.join(generatedDir, path.basename(sourceVideoUrl)), sourceVideoSha256)
      return { archive, archiveUrl: `/generated/${archiveName}`, archiveSha256: sha256(cached) }
    }
    const decoded = await decodeNativeJpegs(ffmpeg, snapshot, stage, config)
    const frames = decoded.frames.map((frame, index) => ({ ...frame, url: `/generated/${namespace}-frame-${index}.jpg`,
      sourceSha256: decoded.files[index].sourceSha256, byteLength: decoded.files[index].byteLength }))
    const archive: NativeFrameArchive = { version: 1, complete: true, sourceVideoSha256, sourceVideoUrl, decoder, recipe: RECIPE,
      timeBase: decoded.timeBase, firstPTS: decoded.firstPTS, metadataText: decoded.metadataText, frames, totalBytes: decoded.totalBytes }
    for (const [index, frame] of frames.entries()) await publishImmutable(decoded.files[index].filename, path.join(generatedDir, path.basename(frame.url)), frame.sourceSha256)
    await publishImmutable(snapshot, path.join(generatedDir, path.basename(sourceVideoUrl)), sourceVideoSha256)
    const bytes = Buffer.from(JSON.stringify(archive, null, 2)), stagedArchive = path.join(stage, archiveName)
    await writeFile(stagedArchive, bytes, { flag: 'wx' })
    await publishImmutable(stagedArchive, archivePath, sha256(bytes))
    return { archive, archiveUrl: `/generated/${archiveName}`, archiveSha256: sha256(bytes) }
  } finally { await rm(stage, { recursive: true, force: true }) }
}
