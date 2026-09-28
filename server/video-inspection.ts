import { historyTailSeconds } from '../src/history-pacing.ts'
import { speechMetrics } from './speech-metrics.ts'
import { validateSpeechEvidence } from './speech-quality.ts'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, readFile, rename, writeFile, access, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import sharp from 'sharp'
import { plannedSpeechWindows } from '../src/storyboard-runtime.ts'
import { isPublicInternetUrl } from './web-sources.ts'
import { collectNativeFrameArchive, NATIVE_REVIEW_SELECTION_VERSION, resolveNativeSequenceConfig, selectNativeReviewFrames, type NativeSequenceOptions } from './native-video-sequence.ts'

const require = createRequire(import.meta.url)
const ffmpeg = require('ffmpeg-static') as string
const exec = promisify(execFile)
type RecordValue = Record<string, unknown>
export type VideoSamplingOptions = { sampleTimes?: number[]; frameFractions?: number[]; nativeSequence?: NativeSequenceOptions }
export type VideoSamplingPlan = { mode: 'default' | 'sample-times' | 'frame-fractions'; requested: number[]; times: number[] }
const DEFAULT_FRAME_FRACTIONS = [0, .2, .45, .7, .9, 1]
const MAX_EVIDENCE_FRAMES = 24

function requestedVideoSampling(options: VideoSamplingOptions, maxFrames = MAX_EVIDENCE_FRAMES): Omit<VideoSamplingPlan, 'times'> {
  if (options.sampleTimes !== undefined && options.frameFractions !== undefined) throw new Error('MEDIA_CONFIG_INVALID: sampleTimes 与 frameFractions 不能同时配置')
  const mode = options.sampleTimes !== undefined ? 'sample-times' : options.frameFractions !== undefined ? 'frame-fractions' : 'default'
  const values = mode === 'sample-times' ? options.sampleTimes : mode === 'frame-fractions' ? options.frameFractions : DEFAULT_FRAME_FRACTIONS
  if (!Array.isArray(values) || !values.length || values.some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (mode !== 'sample-times' && value > 1))) {
    throw new Error(`MEDIA_CONFIG_INVALID: ${mode === 'sample-times' ? 'sampleTimes 须为非负有限秒数数组' : '抽帧比例须为 0–1 的有限数值数组'}`)
  }
  const requested = [...new Set(values)].sort((left, right) => left - right)
  if (requested.length > maxFrames) throw new Error(`MEDIA_CONFIG_INVALID: 抽帧计划最多 ${maxFrames} 张；禁止截断采样计划`)
  return { mode, requested }
}

/** Explicit plans are chronological and always include the actual opening and
 * decodable tail. Near-tail times clamp to duration-0.08 rather than seek past
 * the final frame. Keep the legacy default timing calculation unchanged. */
export function resolveVideoSamplingPlan(options: VideoSamplingOptions, duration: number): VideoSamplingPlan {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('MEDIA_CONFIG_INVALID: 抽帧需要有效的实际视频时长')
  const nativeConfig = resolveNativeSequenceConfig(options.nativeSequence)
  const maxFrames = nativeConfig?.reviewMaxFrames ?? MAX_EVIDENCE_FRAMES
  const plan = requestedVideoSampling(options, maxFrames)
  if (plan.mode === 'default') return { ...plan, times: DEFAULT_FRAME_FRACTIONS.map(fraction => Math.min(Number((duration * fraction).toFixed(2)), Math.max(0, duration - .08))) }
  if (plan.mode === 'sample-times' && plan.requested.some(second => second > duration)) throw new Error(`MEDIA_CONFIG_INVALID: sampleTimes 不得超过实际视频时长 ${duration} 秒`)
  const lastSecond = Math.max(0, Number((duration - .08).toFixed(6)))
  const selected = plan.requested.map(value => plan.mode === 'frame-fractions' ? Number((duration * value).toFixed(2)) : value)
  // A previous native PTS may have repeating decimals. Rounding it upwards
  // would map an already observed frame to the next frame on a later call.
  const times = [...new Set([0, ...selected.map(second => Math.min(nativeConfig ? second : Number(second.toFixed(6)), lastSecond)), lastSecond])].sort((left, right) => left - right)
  if (times.length > maxFrames) throw new Error(`MEDIA_CONFIG_INVALID: 含实际首尾帧的抽帧计划最多 ${maxFrames} 张；禁止截断采样计划`)
  return { ...plan, times }
}

type ReviewEvidenceInputs = Pick<Parameters<typeof collectVideoEvidence>[0],
  'audioText' | 'audioType' | 'speechWindows' | 'latestSpeechEnd' | 'previousTail' | 'qualityMode'>

/** Frame timing alone does not identify a speech/continuity assessment. Every
 * new non-native receipt gets a versioned namespace so even old unkeyed
 * reports remain untouched after migration. */
export function samplingEvidenceKey(videoKey: string, plan: Omit<VideoSamplingPlan, 'times'>, review: ReviewEvidenceInputs = {}): string {
  const base = plan.mode === 'default' ? videoKey
    : `${videoKey}-sampling-${createHash('sha256').update(JSON.stringify({ version: 1, ...plan })).digest('hex').slice(0, 16)}`
  const contract = { audioText: review.audioText, audioType: review.audioType, speechWindows: review.speechWindows,
    latestSpeechEnd: review.latestSpeechEnd, previousTail: review.previousTail, qualityMode: review.qualityMode }
  const digest = createHash('sha256').update(JSON.stringify({ version: 2, contract })).digest('hex').slice(0, 16)
  return `${base}-review-v2-${digest}`
}

export function parseFfmpegMetadata(stderr: string): RecordValue {
  const clock = stderr.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/)
  const duration = clock ? Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]) : NaN
  const videoLine = stderr.split('\n').find((line) => /Stream #.*Video:/.test(line)) ?? ''
  const dimensions = videoLine.match(/[, ](\d{2,5})x(\d{2,5})(?:[, [])/)
  return { format: { duration }, streams: [
    ...(dimensions ? [{ codec_type: 'video', width: Number(dimensions[1]), height: Number(dimensions[2]), duration }] : []),
    ...(/Stream #.*Audio:/.test(stderr) ? [{ codec_type: 'audio' }] : []),
  ] }
}

export function validateVideoMetadata(metadata: RecordValue, duration: number, ratio: string, requireAudio: boolean) {
  const streams = Array.isArray(metadata.streams) ? metadata.streams as RecordValue[] : []
  const video = streams.find((stream) => stream.codec_type === 'video' && Number(stream.width) > 0 && Number(stream.height) > 0)
  const audio = streams.find((stream) => stream.codec_type === 'audio')
  const actualDuration = Number(video?.duration ?? (metadata.format as RecordValue)?.duration)
  const problems: string[] = []
  if (!video) problems.push('没有可解码视频流')
  if (!Number.isFinite(actualDuration) || Math.abs(actualDuration - duration) > 0.5) problems.push(`实际时长 ${actualDuration} 秒与目标 ${duration} 秒不符`)
  const [w, h] = ratio.split(':').map(Number)
  if (video && w > 0 && h > 0 && Math.abs(Number(video.width) / Number(video.height) - w / h) > 0.04) problems.push(`实际画幅 ${video.width}×${video.height} 与 ${ratio} 不符`)
  if (requireAudio && !audio) problems.push('没有真实音轨，sound=on 请求参数不能证明成片有声')
  if (problems.length) throw new Error(`VIDEO_QUALITY_REJECTED: ${problems.join('；')}`)
  return { duration: actualDuration, width: Number(video?.width), height: Number(video?.height), hasAudio: Boolean(audio) }
}

type CollectedSpeechEvidence = {
  speechValidation?: RecordValue; transcript?: unknown; speechMetrics?: ReturnType<typeof speechMetrics>
  speechEvidenceStatus?: 'unavailable'; speechEvidenceError?: string
}

/** Only recognition is optional under the explicit principle policy. Keeping
 * this boundary around ASR prevents decoding or image failures from becoming
 * apparent media evidence, and never invents a passed speech validation. */
export async function collectOptionalSpeechEvidence(transcribe: () => Promise<unknown>, qualityMode?: string, requireValidation = true): Promise<CollectedSpeechEvidence> {
  try {
    const speech = await transcribe() as { speechValidation?: RecordValue; segments?: unknown }
    if (qualityMode === 'principle-v1' && requireValidation && (!speech || !speech.speechValidation
      || typeof speech.speechValidation !== 'object' || Array.isArray(speech.speechValidation))) {
      throw new Error('SPEECH_EVIDENCE_INVALID: 人声识别未返回结构化 speechValidation')
    }
    const speechValidation = speech.speechValidation
    return speechValidation ? { speechValidation, transcript: speech.segments,
      speechMetrics: speechMetrics((speechValidation.alignment ?? []) as RecordValue[]) }
      : { transcript: speech.segments }
  } catch (error) {
    if (qualityMode !== 'principle-v1') throw error
    return { speechEvidenceStatus: 'unavailable', speechEvidenceError: error instanceof Error ? error.message : String(error) }
  }
}

/** Inspect the delivered bytes, not a provider's optimistic status flag. Save a
 * durable local clip and actual tail so another round cannot reuse a URL echo. */
export async function collectVideoEvidence(options: { url: string; audioText?: string; audioType?: string; speechWindows?: RecordValue[]; latestSpeechEnd?: number; previousTail?: string; qualityMode?: string } & VideoSamplingOptions, root = process.cwd()) {
  if (!ffmpeg) throw new Error('视频检查缺少 ffmpeg')
  const nativeConfig = resolveNativeSequenceConfig(options.nativeSequence)
  const requestedSampling = requestedVideoSampling(options, nativeConfig?.reviewMaxFrames)
  const dir = path.resolve(root, 'public/generated')
  await mkdir(dir, { recursive: true })
  const key = createHash('sha256').update(options.url).digest('hex').slice(0, 20)
  // Downloaded media remains shared by URL. Every explicit sampling request
  // gets separate frame/report/rejection paths, preserving earlier evidence.
  let evidenceKey = nativeConfig
    ? `${key}-native-${createHash('sha256').update(JSON.stringify({ version: 2, requestedSampling, nativeConfig })).digest('hex').slice(0, 16)}`
    : samplingEvidenceKey(key, requestedSampling, options)
  const filename = `verified-${key}.mp4`
  const target = path.join(dir, filename)
  try { await access(target) } catch {
    let bytes: Buffer
    if (options.url.startsWith('/generated/') && /^\/generated\/[\w.-]+$/.test(options.url)) {
      bytes = await readFile(path.join(dir, options.url.slice('/generated/'.length)))
    } else {
      if (!isPublicInternetUrl(options.url)) throw new Error('视频检查仅支持公开视频 URL 或本地生成文件')
      const response = await fetch(options.url, { signal: AbortSignal.timeout(120_000) })
      if (!response.ok) throw new Error(`成片下载失败 HTTP ${response.status}`)
      const chunks: Uint8Array[] = []
      let size = 0
      if (!response.body) throw new Error('成片响应为空')
      for await (const chunk of response.body) {
        size += chunk.length
        if (size > 250 * 1024 * 1024) throw new Error('成片超过 250MB 检查上限')
        chunks.push(chunk)
      }
      bytes = Buffer.concat(chunks)
    }
    const temporary = `${target}.${Date.now()}.tmp`
    await writeFile(temporary, bytes)
    await rename(temporary, target)
  }
  try {
    const nativeArchive = nativeConfig ? await collectNativeFrameArchive(ffmpeg, target, dir, nativeConfig) : undefined
    const decoded = nativeArchive ? undefined : await exec(ffmpeg, ['-hide_banner', '-xerror', '-i', target, '-f', 'null', '-'], { timeout: 60_000 }).catch(async (error) => { await rm(target, { force: true }); throw error })
    const parsed = parseFfmpegMetadata(nativeArchive?.archive.metadataText ?? decoded!.stderr)
    const streams = parsed.streams as RecordValue[]
    const video = streams.find(s => s.codec_type === 'video')
    const metadata = { duration: Number((parsed.format as RecordValue).duration), width: Number(video?.width), height: Number(video?.height), hasAudio: streams.some(s => s.codec_type === 'audio') }
    if (!video || !Number.isFinite(metadata.duration)) throw new Error('MEDIA_DECODE_FAILED: 没有可解码视频流')
    const samplingPlan = resolveVideoSamplingPlan(options, metadata.duration)
    if (nativeArchive) evidenceKey = `${key}-native-${createHash('sha256').update(JSON.stringify({ version: 4, selectionVersion: NATIVE_REVIEW_SELECTION_VERSION,
      sourceVideoSha256: nativeArchive.archive.sourceVideoSha256, archiveSha256: nativeArchive.archiveSha256,
      requestedSampling, nativeConfig, audioText: options.audioText, audioType: options.audioType,
      speechWindows: options.speechWindows, latestSpeechEnd: options.latestSpeechEnd,
      previousTail: options.previousTail, qualityMode: options.qualityMode })).digest('hex').slice(0, 16)}`
    const nativeSelection = nativeArchive && nativeConfig ? selectNativeReviewFrames(nativeArchive.archive, samplingPlan.times, nativeConfig, metadata.duration) : undefined
    let meanVolumeDb: number | undefined
    if (metadata.hasAudio) {
      const { stderr } = await exec(ffmpeg, ['-hide_banner', '-i', target, '-vn', '-af', 'volumedetect', '-f', 'null', '-'], { timeout: 30_000 })
      meanVolumeDb = Number(stderr.match(/mean_volume:\s*(-?[\d.]+) dB/)?.[1] ?? '-Infinity')

    }
    const expectedAudioText = options.audioText
    const shouldDetectSpeech = metadata.hasAudio && (Boolean(expectedAudioText) || options.audioType === '环境声')
    const speechEvidence = shouldDetectSpeech ? await collectOptionalSpeechEvidence(async () => {
      const python = path.resolve(root, '.venv-quality/bin/python')
      try { await access(python) } catch { throw new Error('实际人声自检尚未安装：请运行 npm run setup:quality') }
      const args = [path.resolve(root, 'scripts/transcribe-quality.py'), target]
      if (expectedAudioText) args.push('--expected', expectedAudioText, '--latest-speech-end', String(options.latestSpeechEnd ?? metadata.duration), '--windows', JSON.stringify(options.speechWindows ?? []))
      const { stdout } = await exec(python, args, { timeout: 180_000, maxBuffer: 4 * 1024 * 1024 })
      return JSON.parse(stdout)
    }, options.qualityMode, Boolean(expectedAudioText)) : {}
    const times = nativeSelection ? nativeSelection.frameReferences.map(frame => frame.second) : samplingPlan.times
    const frames: string[] = nativeSelection ? nativeSelection.frameReferences.map(frame => frame.url) : []
    for (const [index, second] of (nativeSelection ? [] : times).entries()) {
      const frame = `verified-${evidenceKey}-frame-${index}.jpg`
      const framePath = path.join(dir, frame)
      try {
        const existing = await stat(framePath)
        if (!existing.isFile() || existing.size <= 0) throw new Error(`MEDIA_EVIDENCE_ARCHIVE_ERROR: 已有抽帧文件无效：${frame}`)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        await exec(ffmpeg, ['-hide_banner', '-v', 'error', '-y', '-ss', String(second), '-i', target, '-frames:v', '1', '-q:v', '2', framePath], { timeout: 30_000 })
      }
      frames.push(`/generated/${frame}`)
    }
    let firstFrameDifference: number | undefined
    if (options.previousTail) {
      if (!/^\/generated\/[\w.-]+\.jpg$/.test(options.previousTail)) throw new Error('续接验证缺少本地实际尾帧；请重跑前镜成片检查')
      const pixels = (url: string) => sharp(path.join(root, 'public', url)).resize(96, 54, { fit: 'fill' }).removeAlpha().raw().toBuffer()
      const [previous, first] = await Promise.all([pixels(options.previousTail), pixels(frames[0])])
      firstFrameDifference = previous.reduce((sum, pixel, i) => sum + Math.abs(pixel - first[i]), 0) / (previous.length * 255)

    }
    const report = { ...metadata, sha256: createHash('sha256').update(await readFile(target)).digest('hex'), meanVolumeDb: Number.isFinite(meanVolumeDb) ? meanVolumeDb : null,
      ...speechEvidence,
      ...(firstFrameDifference === undefined ? {} : { firstFrameDifference }), url: `/generated/${filename}`, originalUrl: options.url,
      lastFrameUrl: frames.at(-1)!, frames, frameTimes: times, evidenceVersion: nativeSelection ? 2 : 1, decoded: true,
      frameTimeSemantics: nativeSelection ? 'native-pts-relative-to-first-frame' : 'requested-seek',
      ...(nativeSelection && nativeArchive && nativeConfig ? { frameReferences: nativeSelection.frameReferences,
        nativeSequence: { version: NATIVE_REVIEW_SELECTION_VERSION, sourceVideoSha256: nativeArchive.archive.sourceVideoSha256,
          sourceVideoUrl: nativeArchive.archive.sourceVideoUrl, archiveUrl: nativeArchive.archiveUrl, archiveSha256: nativeArchive.archiveSha256,
          totalNativeFrames: nativeArchive.archive.frames.length, selectedNativeFrameIndices: nativeSelection.frameReferences.map(frame => frame.nativeFrameIndex),
          windows: nativeSelection.windows, preservedSamples: nativeSelection.preservedSamples, limits: nativeConfig } } : {}),
      samplingPlan: nativeSelection ? { mode: 'native-sequence', requested: samplingPlan.requested, times, baseSamplingPlan: samplingPlan } : samplingPlan,
      evidenceRequest: options, evidenceUrl: `/generated/verified-${evidenceKey}-evidence.json` }
    try { await writeFile(path.join(dir, `verified-${evidenceKey}-evidence.json`), JSON.stringify(report, null, 2), { flag: 'wx' }) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const saved = JSON.parse(await readFile(path.join(dir, `verified-${evidenceKey}-evidence.json`), 'utf8')) as typeof report
      if (saved.evidenceUrl !== report.evidenceUrl || saved.sha256 !== report.sha256
        || JSON.stringify(saved.frames) !== JSON.stringify(report.frames)
        || JSON.stringify(saved.frameTimes) !== JSON.stringify(report.frameTimes)) {
        throw new Error('MEDIA_EVIDENCE_ARCHIVE_ERROR: 已有报告与当前视频或采样不一致，不能覆盖历史证据', { cause: error })
      }
      return saved
    }
    return report
  } catch (error) {
    // Preserve playable rejected takes for inspection; only corrupt bytes above
    // are evicted. A QA failure must never force another paid generation.
    const message = error instanceof Error ? error.message : String(error)
    try { await writeFile(path.join(dir, `verified-${evidenceKey}-rejection.json`), JSON.stringify({ url: `/generated/${filename}`, originalUrl: options.url, samplingPlan: requestedSampling, error: message }, null, 2), { flag: 'wx' }) }
    catch (writeError) { if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError }
    throw new Error(`${message}；验收记录 /generated/verified-${evidenceKey}-rejection.json`, { cause: error })
  }
}

/** Compatibility for saved scripts. New graphs call collectVideoEvidence and
 * make acceptance decisions in separate configurable code and inference nodes. */
export async function inspectGeneratedVideo(options: { url: string; duration: number; aspectRatio: string; requireAudio?: boolean; audioText?: string; audioType?: string; videoPrompt?: string; pacing?: RecordValue; previousTail?: string } & VideoSamplingOptions, root = process.cwd()) {
  const evidence = await collectVideoEvidence({ url: options.url, audioText: options.audioText, audioType: options.audioType,
    speechWindows: options.videoPrompt ? plannedSpeechWindows(options as unknown as RecordValue) : [],
    latestSpeechEnd: options.duration - historyTailSeconds(options), previousTail: options.previousTail,
    sampleTimes: options.sampleTimes, frameFractions: options.frameFractions, nativeSequence: options.nativeSequence }, root)
  const metadata = { format: { duration: evidence.duration }, streams: [
    { codec_type: 'video', ...evidence }, ...(evidence.hasAudio ? [{ codec_type: 'audio' }] : []),
  ] }
  validateVideoMetadata(metadata, options.duration, options.aspectRatio, options.requireAudio !== false)
  if (options.requireAudio !== false && (evidence.meanVolumeDb == null || evidence.meanVolumeDb < -50)) throw new Error('VIDEO_QUALITY_REJECTED: 实际音轨接近静音')
  const speechValidation = evidence.speechValidation ? validateSpeechEvidence(evidence.speechValidation, options.videoPrompt ? plannedSpeechWindows(options as unknown as RecordValue).length : 0, options.duration - historyTailSeconds(options)) : undefined
  if (options.audioText && !speechValidation?.passed) throw new Error(`VIDEO_QUALITY_REJECTED: ${JSON.stringify(speechValidation)}`)
  if (evidence.firstFrameDifference !== undefined && evidence.firstFrameDifference > .1) throw new Error('VIDEO_QUALITY_REJECTED: 连续镜头首帧偏离前镜实际尾帧')
  return { ...evidence, ...(speechValidation ? { speechValidation } : {}), technicalValidation: { passed: true, scope: 'decoded-media', speechVerified: speechValidation?.passed === true, visualContinuityVerified: false } }
}
