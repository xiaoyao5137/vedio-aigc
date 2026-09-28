import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { createRequire } from 'node:module'
import { mkdir, readFile, rename, writeFile, access } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import sharp from 'sharp'
import type { ExternalModelConfig } from './model-adapters.ts'
import type { ModelAdapterResult } from './model-adapters.ts'
import { buildBailianTtsParameters, callBailianTts, pcmToWav } from './bailian-tts.ts'
import { originalVoiceScope } from './bailian-voice-design.ts'
import { narrationTempo, projectIndependentNarration } from './narration-projection.ts'
import { isPublicInternetUrl } from './web-sources.ts'
import { parseFfmpegMetadata, validateVideoMetadata } from './video-inspection.ts'
import { videoDimensions, type VideoResolution } from '../src/video-output-profile.ts'
import { pronunciationInstruction } from '../src/pronunciation-hints.ts'
import { assertHistoricalMapCleanPlatePrompt } from './historical-map-clean-plate.ts'

const exec = promisify(execFile)
const ffmpeg = createRequire(import.meta.url)('ffmpeg-static') as string
type NarrationAsset = { voiceId: string; accountScope: string; targetModel: string; modelId: string; characterId: string; synthesisSeed: number; characterName?: string; audioRole?: string }
type Segment = ReturnType<typeof projectIndependentNarration>['segments'][number]
type EdgeNormalization = { version: 'narration-edge-silence-v1'; sourceUrl: string; sourceSha256: string; sourceSampleCount: number; sourceDuration: number;
  sampleRate: number; trimStartSamples: number; trimEndSamples: number; thresholdDb: -50; minimumSilenceSeconds: 0.08; paddingSeconds: 0.05; maximumTrimSeconds: 0.1;
  leadingSilence?: { start: number; end: number }; trailingSilence?: { start: number; end: number }; derivedUrl: string; derivedSha256: string; derivedSampleCount: number; derivedDuration: number }
type Track = Segment & { url: string; sourceDuration: number; duration: number; tempo: number; voiceId: string; sha256: string; normalization?: EdgeNormalization;
  synthesis?: { model: string; rate: number; seed: number; instruction: string } }
export type IllustrationLayerPlan = {
  characterName: string
  x: number
  y: number
  scale: number
  enterStart: number
  enterDuration: number
  enterFromX: number
  enterFromY: number
  exitStart: number
  exitDuration: number
}
type IllustrationReferenceBinding = { characterName?: unknown; role?: unknown }
const pending = new Map<string, Promise<Track>>()
const pendingSyntheses = new Map<string, Promise<NarrationSynthesisReceipt['result']>>()
export const NARRATION_SYNTHESIS_RECEIPT_DIRECTORY = '.runtime/narration-syntheses'
const audioUrl = (url: string) => /^\/generated\/tts-(?:[\da-f-]+|edge-[\da-f]{64})\.wav$/.test(url)
const canonicalJson = (value: unknown): string => Array.isArray(value) ? '[' + value.map(canonicalJson).join(',') + ']'
  : value && typeof value === 'object' ? '{' + Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => JSON.stringify(key) + ':' + canonicalJson(item)).join(',') + '}' : JSON.stringify(value ?? null)

/** The model receives only the map plate and its two boundary frames. Named
 * portrait sheets remain local inputs for the deterministic overlay step. */
export function projectHistoricalMapPortraitPicture(prompt: string, params: Record<string, unknown>) {
  assertHistoricalMapCleanPlatePrompt(prompt)
  const instruction = '【地图底片制作】只生成无字、无箭头、无路线线条、无人物的古代历史地理底片；地名、行军路线及具名人物静图均由本地后期叠层。'
  return { prompt: prompt.includes(instruction) ? prompt : `${prompt}\n${instruction}`,
    params: { ...params, referenceImages: [], referenceBindings: [], referenceMode: '' } }
}

export function narrationSynthesisParameters(model: ExternalModelConfig, voice: NarrationAsset, segment: Segment) {
  const instruction = [model.settings.instruction, pronunciationInstruction(segment.pronunciationHints, segment.text)].filter(Boolean).join('\n')
  return { voice: voice.voiceId, characterName: voice.characterName ?? '旁白', rate: segment.ttsRate, seed: voice.synthesisSeed,
    ...(instruction ? { instruction } : {}) }
}

/** Audio identity excludes scheduling; PostgreSQL JSON key order is immaterial. */
export function narrationSynthesisReceiptIdentity(model: ExternalModelConfig, voice: NarrationAsset, segment: Segment) {
  const { voiceId, accountScope, targetModel, modelId, characterId, synthesisSeed, characterName, audioRole } = voice
  return { version: 'narration-synthesis-v1' as const, modelId: model.id, provider: model.provider, targetModel: model.settings.model,
    voice: { voiceId, accountScope, targetModel, modelId, characterId, synthesisSeed, ...(characterName ? { characterName } : {}), ...(audioRole ? { audioRole } : {}) },
    text: segment.text, synthesisParameters: buildBailianTtsParameters(model.settings, narrationSynthesisParameters(model, voice, segment)),
    pronunciationHints: segment.pronunciationHints ?? [] }
}
export function rawReceiptKey(model: ExternalModelConfig, voice: NarrationAsset, segment: Segment) {
  return createHash('sha256').update(canonicalJson(narrationSynthesisReceiptIdentity(model, voice, segment))).digest('hex')
}
export const narrationSynthesisReceiptKey = rawReceiptKey
export type NarrationSynthesisReceipt = { version: 'narration-synthesis-v1'; identityKey: string; identity: ReturnType<typeof narrationSynthesisReceiptIdentity>;
  result: Awaited<ReturnType<typeof callBailianTts>>['body'] & { sampleCount: number }; createdAt: string; recoveryProof?: unknown }

function readPcmWave(bytes: Buffer) {
  if (bytes.length < 44 || bytes.length > 64 * 1024 * 1024 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE'
    || bytes.readUInt32LE(4) + 8 !== bytes.length) throw Error('NARRATION_RECEIPT_INVALID: 原始PCM WAV格式或长度无效')
  let sampleRate = 0, data: Buffer | undefined
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const kind = bytes.toString('ascii', offset, offset + 4), size = bytes.readUInt32LE(offset + 4), start = offset + 8
    if (start + size > bytes.length) throw Error('NARRATION_RECEIPT_INVALID: WAV数据块不完整')
    if (kind === 'fmt ') {
      if (size < 16 || bytes.readUInt16LE(start) !== 1 || bytes.readUInt16LE(start + 2) !== 1 || bytes.readUInt16LE(start + 14) !== 16
        || bytes.readUInt16LE(start + 12) !== 2) throw Error('NARRATION_RECEIPT_INVALID: 仅支持完整16位单声道PCM')
      sampleRate = bytes.readUInt32LE(start + 4)
      if (![8000, 16000, 22050, 24000, 44100, 48000].includes(sampleRate) || bytes.readUInt32LE(start + 8) !== sampleRate * 2) throw Error('NARRATION_RECEIPT_INVALID: PCM采样率无效')
    } else if (kind === 'data') { if (data) throw Error('NARRATION_RECEIPT_INVALID: WAV存在多个数据块'); data = bytes.subarray(start, start + size) }
    offset = start + size + size % 2
  }
  if (!sampleRate || !data?.length || data.length % 2) throw Error('NARRATION_RECEIPT_INVALID: PCM样本不完整')
  return { pcm: data, sampleRate, sampleCount: data.length / 2, duration: data.length / (2 * sampleRate) }
}

async function validatedRawSynthesis(result: NarrationSynthesisReceipt['result'], identity: ReturnType<typeof narrationSynthesisReceiptIdentity>, root: string) {
  if (result.status !== 'succeeded' || !/^\/generated\/tts-[\da-f-]+\.wav$/.test(result.url) || result.voice !== identity.voice.voiceId
    || result.model !== identity.targetModel || result.transcript !== identity.text || result.rate !== identity.synthesisParameters.rate || result.seed !== identity.voice.synthesisSeed
    || (result.instruction ?? '') !== (identity.synthesisParameters.instruction ?? '')) throw Error('NARRATION_RECEIPT_INVALID: 已保存原始合成身份不匹配')
  const bytes = await readFile(path.join(root, 'public', result.url)), wave = readPcmWave(bytes)
  if (createHash('sha256').update(bytes).digest('hex') !== result.sha256 || result.sampleRate !== wave.sampleRate || result.sampleCount !== wave.sampleCount
    || result.channels !== 1 || result.format !== 'wav' || result.bytes !== bytes.length || Math.abs(result.duration - wave.duration) > 1 / wave.sampleRate) throw Error('NARRATION_RECEIPT_INVALID: 原始音频字节或样本证据不匹配')
  return { bytes, ...wave }
}

async function rawSynthesis(model: ExternalModelConfig, voice: NarrationAsset, segment: Segment, root: string, synthesize: typeof callBailianTts) {
  const identity = narrationSynthesisReceiptIdentity(model, voice, segment), identityKey = rawReceiptKey(model, voice, segment), pendingKey = root + ':' + identityKey
  const prior = pendingSyntheses.get(pendingKey)
  if (prior) return prior
  const work = (async () => {
    const directory = path.join(root, NARRATION_SYNTHESIS_RECEIPT_DIRECTORY); await mkdir(directory, { recursive: true })
    const receipt = path.join(directory, identityKey + '.json')
    let saved: NarrationSynthesisReceipt | undefined
    try {
      saved = JSON.parse(await readFile(receipt, 'utf8')) as NarrationSynthesisReceipt
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (saved !== undefined) {
      if (saved.version !== 'narration-synthesis-v1' || saved.identityKey !== identityKey || canonicalJson(saved.identity) !== canonicalJson(identity)) throw Error('NARRATION_RECEIPT_INVALID: 原始合成回执请求身份不匹配')
      await validatedRawSynthesis(saved.result, identity, root)
      return saved.result
    }
    const response = await synthesize(model, segment.text, narrationSynthesisParameters(model, voice, segment), { root })
    const bytes = await readFile(path.join(root, 'public', response.body.url)), wave = readPcmWave(bytes)
    const result = { ...response.body, sampleCount: wave.sampleCount }
    await validatedRawSynthesis(result, identity, root)
    // Persist a completed paid response before any fit or normalization can fail.
    const completedReceipt: NarrationSynthesisReceipt = { version: 'narration-synthesis-v1', identityKey, identity, result, createdAt: new Date().toISOString() }
    const temporary = receipt + '.' + randomUUID() + '.tmp'
    await writeFile(temporary, JSON.stringify(completedReceipt)); await rename(temporary, receipt)
    return result
  })()
  pendingSyntheses.set(pendingKey, work)
  try { return await work } finally { pendingSyntheses.delete(pendingKey) }
}

async function normalizeEdgeSilence(result: NarrationSynthesisReceipt['result'], root: string) {
  const bytes = await readFile(path.join(root, 'public', result.url)), wave = readPcmWave(bytes)
  const detected = await exec(ffmpeg, ['-hide_banner', '-i', path.join(root, 'public', result.url), '-af', 'silencedetect=noise=-50dB:d=0.08', '-f', 'null', '-'],
    { maxBuffer: 1024 * 1024, timeout: 60000 })
  const intervals: Array<{ start: number; end: number }> = []
  let start: number | undefined
  for (const match of detected.stderr.matchAll(/silence_(start|end):\s*([\d.]+)/g)) {
    if (match[1] === 'start') start = Number(match[2])
    else if (start !== undefined) { intervals.push({ start, end: Number(match[2]) }); start = undefined }
  }
  if (start !== undefined) intervals.push({ start, end: wave.duration })
  const tolerance = 2 / wave.sampleRate
  const leading = intervals.find(interval => interval.start <= tolerance), trailing = intervals.findLast(interval => Math.abs(interval.end - wave.duration) <= tolerance)
  if (leading && leading.end >= wave.duration - tolerance) return undefined // An all-silent file cannot be repaired as speech.
  const trimStartSamples = Math.floor(Math.min(.1, Math.max(0, (leading?.end ?? 0) - .05)) * wave.sampleRate)
  const trimEndSamples = Math.floor(Math.min(.1, Math.max(0, wave.duration - (trailing?.start ?? wave.duration) - .05)) * wave.sampleRate)
  if (!trimStartSamples && !trimEndSamples) return undefined
  // Confirm the removed samples themselves are quiet, independently of the
  // detector's decimal timestamps. Internal silence is never touched.
  const quiet = (from: number, to: number) => { for (let sample = from; sample < to; sample++) if (Math.abs(wave.pcm.readInt16LE(sample * 2)) > 104) return false; return true }
  if (!quiet(0, trimStartSamples) || !quiet(wave.sampleCount - trimEndSamples, wave.sampleCount)) return undefined
  const pcm = wave.pcm.subarray(trimStartSamples * 2, (wave.sampleCount - trimEndSamples) * 2), derived = pcmToWav(pcm, wave.sampleRate)
  const sha256 = createHash('sha256').update(derived).digest('hex'), url = `/generated/tts-edge-${sha256}.wav`
  const destination = path.join(root, 'public', url)
  try { const existing = await readFile(destination); if (!existing.equals(derived)) throw Error('NARRATION_RECEIPT_INVALID: 派生音频字节发生变化') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    try { await writeFile(destination, derived, { flag: 'wx' }) }
    catch (writeError) { if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST' || !(await readFile(destination)).equals(derived)) throw writeError }
  }
  const sampleCount = pcm.length / 2, duration = sampleCount / wave.sampleRate
  const normalization: EdgeNormalization = { version: 'narration-edge-silence-v1', sourceUrl: result.url, sourceSha256: result.sha256,
    sourceSampleCount: wave.sampleCount, sourceDuration: wave.duration, sampleRate: wave.sampleRate, trimStartSamples, trimEndSamples,
    thresholdDb: -50, minimumSilenceSeconds: .08, paddingSeconds: .05, maximumTrimSeconds: .1,
    ...(leading ? { leadingSilence: leading } : {}), ...(trailing ? { trailingSilence: trailing } : {}),
    derivedUrl: url, derivedSha256: sha256, derivedSampleCount: sampleCount, derivedDuration: duration }
  return { url, sha256, duration, normalization }
}

/** Once the paid picture task succeeds, a local mixing failure must never buy
 * another picture on retry. The receipt is transport state, not an asset row. */
export async function cachedNarrationPicture(identity: unknown, call: () => Promise<ModelAdapterResult>, root = process.cwd()): Promise<ModelAdapterResult> {
  const directory = path.join(root, '.runtime/narration-pictures')
  await mkdir(directory, { recursive: true })
  const receipt = path.join(directory, createHash('sha256').update(JSON.stringify(identity)).digest('hex') + '.json')
  try { return JSON.parse(await readFile(receipt, 'utf8')) as ModelAdapterResult }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const result = await call()
  const body = result.body as { data?: { task_status?: string; task_result?: { videos?: Array<{ url?: string }> } } }
  if (result.status < 400 && body?.data?.task_status === 'succeed' && body.data.task_result?.videos?.[0]?.url) {
    const temporary = receipt + '.' + randomUUID() + '.tmp'
    await writeFile(temporary, JSON.stringify(result)); await rename(temporary, receipt)
  }
  return result
}

export async function synthesizeNarrationTrack(model: ExternalModelConfig, voice: NarrationAsset, segment: Segment, root = process.cwd(), dependencies: { synthesize?: typeof callBailianTts } = {}): Promise<Track> {
  if (model.id !== voice.modelId || model.settings.model !== voice.targetModel || originalVoiceScope(model) !== voice.accountScope || !voice.voiceId
    || !Number.isInteger(voice.synthesisSeed) || voice.synthesisSeed < 1 || voice.synthesisSeed > 65535) throw Error('VOICE_BINDING_INVALID: 旁白原创音色与当前 TTS 服务或合成配置不一致')
  const synthesisParameters = narrationSynthesisParameters(model, voice, segment)
  // Instructions change audio identity. A retry must not reuse an old track
  // after correcting a reading or changing the configured delivery guidance.
  const identity = synthesisParameters.instruction || segment.pronunciationHints?.length
    ? { version: 2, voice, segment, synthesisParameters } : { version: 1, voice, segment }
  const key = createHash('sha256').update(JSON.stringify(identity)).digest('hex')
  const pendingKey = root + ':' + key
  const existing = pending.get(pendingKey)
  if (existing) return existing
  const work = (async () => {
    const directory = path.join(root, '.runtime/narration-tracks')
    await mkdir(directory, { recursive: true })
    const receipt = path.join(directory, key + '.json')
    let savedTrack: Track | undefined
    try {
      savedTrack = JSON.parse(await readFile(receipt, 'utf8')) as Track
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (savedTrack !== undefined) {
      const track = savedTrack
      if (!audioUrl(track.url) || track.voiceId !== voice.voiceId) throw Error('NARRATION_RECEIPT_INVALID: 已保存音轨身份不匹配')
      const bytes = await readFile(path.join(root, 'public', track.url))
      if (createHash('sha256').update(bytes).digest('hex') !== track.sha256) throw Error('NARRATION_RECEIPT_INVALID: 已保存音频字节发生变化')
      return track
    }
    const result = await rawSynthesis(model, voice, segment, root, dependencies.synthesize ?? callBailianTts)
    let fitted = { url: result.url, sha256: result.sha256, duration: result.duration, normalization: undefined as EdgeNormalization | undefined }
    let tempo: number
    try { tempo = narrationTempo(result.duration, segment.end - segment.start, segment.text, segment.maximumRate) }
    catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('NARRATION_DURATION_CONFLICT:')) throw error
      let normalized: Awaited<ReturnType<typeof normalizeEdgeSilence>>
      try { normalized = await normalizeEdgeSilence(result, root) } catch { throw error }
      if (!normalized) throw error
      // Keep the same cap and approved window. A derived file is not permission
      // to truncate speech or force another provider synthesis.
      tempo = narrationTempo(normalized.duration, segment.end - segment.start, segment.text, segment.maximumRate)
      fitted = normalized
    }
    const track: Track = { ...segment, url: fitted.url, sourceDuration: fitted.duration, duration: fitted.duration / tempo, tempo, voiceId: voice.voiceId, sha256: fitted.sha256,
      ...(fitted.normalization ? { normalization: fitted.normalization } : {}),
      synthesis: { model: result.model, rate: result.rate, seed: result.seed, instruction: result.instruction } }
    const temporary = receipt + '.' + randomUUID() + '.tmp'
    await writeFile(temporary, JSON.stringify(track)); await rename(temporary, receipt)
    return track
  })()
  pending.set(pendingKey, work)
  try { return await work } finally { pending.delete(pendingKey) }
}

async function localPicture(url: string, root: string) {
  const directory = path.join(root, 'public/generated')
  if (/^\/generated\/[\w.-]+\.mp4$/.test(url)) return path.join(root, 'public', url)
  if (!isPublicInternetUrl(url)) throw Error('NARRATION_VIDEO_INVALID: 仅接受供应商公开视频或本地生成文件')
  const filename = path.join(directory, 'narration-picture-' + createHash('sha256').update(url).digest('hex') + '.mp4')
  try { await access(filename); return filename } catch { /* First download. */ }
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) })
  if (!response.ok || !response.body) throw Error(`NARRATION_VIDEO_INVALID: 视频下载失败 HTTP ${response.status}`)
  const chunks: Uint8Array[] = []; let bytes = 0
  for await (const chunk of response.body) {
    bytes += chunk.length
    if (bytes > 250 * 1024 * 1024) throw Error('NARRATION_VIDEO_INVALID: 视频超过 250MB')
    chunks.push(chunk)
  }
  const temporary = filename + '.' + randomUUID() + '.tmp'
  await writeFile(temporary, Buffer.concat(chunks)); await rename(temporary, filename)
  return filename
}

async function localStillImage(url: string, root: string) {
  const directory = path.join(root, 'public/generated')
  if (/^\/generated\/[\w.-]+\.(?:png|jpe?g|webp)$/i.test(url)) return path.join(root, 'public', url)
  const data = url.match(/^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/i)?.[1]
  if (data) {
    const bytes = Buffer.from(data, 'base64')
    if (!bytes.length || bytes.length > 40 * 1024 * 1024) throw Error('STATIC_ILLUSTRATION_INVALID: 内嵌图片为空或超过 40MB')
    const filename = path.join(directory, 'static-source-' + createHash('sha256').update(bytes).digest('hex') + '.img')
    try { await access(filename) } catch { await writeFile(filename, bytes) }
    return filename
  }
  if (!isPublicInternetUrl(url)) throw Error('STATIC_ILLUSTRATION_INVALID: 仅接受供应商公开图片或本地生成图片')
  const filename = path.join(directory, 'static-source-' + createHash('sha256').update(url).digest('hex') + '.img')
  try { await access(filename); return filename } catch { /* First download. */ }
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) })
  if (!response.ok || !response.body) throw Error(`STATIC_ILLUSTRATION_INVALID: 图片下载失败 HTTP ${response.status}`)
  const chunks: Uint8Array[] = []; let bytes = 0
  for await (const chunk of response.body) {
    bytes += chunk.length
    if (bytes > 40 * 1024 * 1024) throw Error('STATIC_ILLUSTRATION_INVALID: 图片超过 40MB')
    chunks.push(chunk)
  }
  const temporary = filename + '.' + randomUUID() + '.tmp'
  await writeFile(temporary, Buffer.concat(chunks)); await rename(temporary, filename)
  return filename
}

async function illustrationCard(imageUrl: string, size: number, root: string) {
  const source = await localStillImage(imageUrl, root)
  const metadata = await sharp(source, { failOn: 'error' }).metadata()
  if (!metadata.width || !metadata.height) throw Error('ILLUSTRATION_MOTION_INVALID: 人物插画尺寸不可读')
  const panelWidth = metadata.width / metadata.height >= 1.5 ? Math.floor(metadata.width / 3) : metadata.width
  const cropSize = Math.min(panelWidth, metadata.height)
  const left = Math.max(0, Math.floor((panelWidth - cropSize) / 2))
  const directory = path.join(root, 'public/generated')
  const key = createHash('sha256').update(JSON.stringify({ version: 3, imageUrl, size, crop: 'front-cutout-north' })).digest('hex')
  const destination = path.join(directory, `illustration-card-${key}.png`)
  try { await access(destination) } catch {
    const { data, info } = await sharp(source, { failOn: 'error' })
      .extract({ left, top: 0, width: cropSize, height: cropSize })
      .resize(size, size, { fit: 'cover', position: 'north' })
      .ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const cornerOffsets = [0, (info.width - 1) * 4, (info.height - 1) * info.width * 4, (info.height * info.width - 1) * 4]
    const background = [0, 1, 2].map(channel => Math.round(cornerOffsets.reduce((sum, offset) => sum + data[offset + channel], 0) / cornerOffsets.length))
    for (let offset = 0; offset < data.length; offset += 4) {
      const distance = Math.max(...background.map((value, channel) => Math.abs(data[offset + channel] - value)))
      if (distance <= 18) data[offset + 3] = 0
      else if (distance < 58) data[offset + 3] = Math.round(data[offset + 3] * (distance - 18) / 40)
    }
    await sharp(data, { raw: info }).png().toFile(destination)
  }
  return destination
}

/** A map portrait is a named, reviewed asset. Never fall back to an image by
 * array position, another character's sheet, or a generated stand-in. Check
 * this before synthesizing speech or submitting a paid map-video request. */
export async function validateHistoricalMapPortraitInputs(characterImages: unknown, referenceBindings: unknown,
  authoredLayers: unknown, duration: number, root = process.cwd()): Promise<IllustrationLayerPlan[]> {
  if (!Number.isFinite(duration) || duration < 3 || duration > 15) throw Error('MAP_PORTRAIT_INVALID: 时长必须为 3–15 秒')
  if (!Array.isArray(authoredLayers) || !authoredLayers.length || authoredLayers.length > 2
    || !Array.isArray(characterImages) || characterImages.length !== authoredLayers.length
    || !Array.isArray(referenceBindings) || referenceBindings.length !== authoredLayers.length) {
    throw Error('MAP_PORTRAIT_INVALID: 人物图层、已绑定角色资产和参考图片必须一一对应，最多两人')
  }
  const names = new Set<string>()
  const layers = authoredLayers.map((value, index): IllustrationLayerPlan => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(`MAP_PORTRAIT_INVALID: 第 ${index + 1} 个人物图层无效`)
    const layer = value as Record<string, unknown>
    const name = layer.characterName
    if (typeof name !== 'string' || !name.trim() || name !== name.trim() || names.has(name)
      ) {
      throw Error(`MAP_PORTRAIT_INVALID: 第 ${index + 1} 个人物图层缺少唯一姓名`)
    }
    names.add(name)
    const numeric = (key: keyof Omit<IllustrationLayerPlan, 'characterName'>, min: number, max: number) => {
      const number = layer[key]
      if (typeof number !== 'number' || !Number.isFinite(number) || number < min || number > max) {
        throw Error(`MAP_PORTRAIT_INVALID: ${name}.${key} 不在 ${min}–${max} 范围内`)
      }
      return number
    }
    const x = numeric('x', 0, 1), y = numeric('y', 0, 1), scale = numeric('scale', .1, .46)
    const enterFromX = numeric('enterFromX', 0, 1), enterFromY = numeric('enterFromY', 0, 1)
    const enterStart = numeric('enterStart', 0, duration), enterDuration = numeric('enterDuration', .2, 1.5)
    const exitStart = numeric('exitStart', 0, duration), exitDuration = numeric('exitDuration', .2, 1.5)
    if (enterStart + enterDuration > exitStart || exitStart + exitDuration > duration + .001) {
      throw Error(`MAP_PORTRAIT_INVALID: ${name} 图层的进场、停留和退场时间不完整`)
    }
    return { characterName: name, x, y, scale, enterStart, enterDuration, enterFromX, enterFromY, exitStart, exitDuration }
  })
  const orderedLayers = referenceBindings.map((value, index) => {
    const binding = value as IllustrationReferenceBinding | null
    const name = binding && typeof binding === 'object' ? binding.characterName : undefined
    if (typeof name !== 'string' || !name.trim() || name !== name.trim() || binding?.role !== 'identity'
      || typeof characterImages[index] !== 'string' || !characterImages[index].trim()) {
      throw Error(`MAP_PORTRAIT_INVALID: 第 ${index + 1} 个已绑定角色缺少唯一姓名或图片`)
    }
    const layer = layers.find(item => item.characterName === name)
    if (!layer || referenceBindings.filter(item => item && typeof item === 'object' && item.characterName === name).length !== 1) {
      throw Error(`MAP_PORTRAIT_INVALID: ${name} 的人物图层与已绑定角色资产不一一对应`)
    }
    return layer
  })
  await Promise.all(characterImages.map(async (imageUrl, index) => {
    const name = orderedLayers[index].characterName
    try {
      const source = await localStillImage(imageUrl, root)
      const metadata = await sharp(source, { failOn: 'error' }).metadata()
      if (!metadata.width || !metadata.height) throw Error('图片尺寸不可读')
    } catch (error) {
      throw Error(`MAP_PORTRAIT_ASSET_MISSING: ${name} 已绑定人物图片不可用；禁止生成替身`, { cause: error })
    }
  }))
  return orderedLayers
}

/** Keep the sourced geographic map moving underneath inert, named portraits.
 * The supplier's map clip remains the picture and environmental-sound source;
 * independent narration is mixed in only after this local composition. */
export async function composeHistoricalMapPortraitVideo(pictureUrl: string, characterImages: string[], duration: number,
  aspectRatio: string, root = process.cwd(), referenceBindings: IllustrationReferenceBinding[] = [], authoredLayers: unknown = [],
  resolution: VideoResolution = '720p') {
  const layers = await validateHistoricalMapPortraitInputs(characterImages, referenceBindings, authoredLayers, duration, root)
  let size: [number, number]
  try { size = videoDimensions(resolution, aspectRatio) } catch { throw Error(`MAP_PORTRAIT_INVALID: 不支持画幅 ${aspectRatio}`) }
  const source = await localPicture(pictureUrl, root)
  const sourceProbe = await exec(ffmpeg, ['-hide_banner', '-i', source, '-f', 'null', '-'], { maxBuffer: 4 * 1024 * 1024, timeout: 120000 })
  validateVideoMetadata(parseFfmpegMetadata(sourceProbe.stderr), duration, aspectRatio, true)
  const [width, height] = size
  const cards = await Promise.all(characterImages.map((url, index) => illustrationCard(url, Math.max(96, Math.round(width * layers[index].scale)), root)))
  const directory = path.join(root, 'public/generated'); await mkdir(directory, { recursive: true })
  const sourceHash = createHash('sha256')
  for await (const chunk of createReadStream(source)) sourceHash.update(chunk)
  const sourceSha256 = sourceHash.digest('hex')
  const key = createHash('sha256').update(JSON.stringify({ version: 1, pictureUrl, sourceSha256, characterImages, layers, duration, aspectRatio, resolution,
    route: 'historical-map-portrait-overlay-v1' })).digest('hex')
  const filename = `historical-map-portraits-${key}.mp4`, destination = path.join(directory, filename)
  try { await access(destination) } catch {
    const temporary = path.join(directory, `historical-map-portraits-${key}-${randomUUID()}.mp4`)
    const inputs = ['-i', source, ...cards.flatMap(card => ['-loop', '1', '-i', card])]
    // Fit the whole map instead of cropping its geography to fill the output.
    const filters = [`[0:v]scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=24[bg]`]
    let base = 'bg'
    cards.forEach((_card, index) => {
      const layer = layers[index]
      const cardSize = Math.max(96, Math.round(width * layer.scale))
      const x = Math.round(width * layer.x - cardSize / 2), y = Math.round(height * layer.y - cardSize / 2)
      const fromX = Math.round(width * layer.enterFromX - cardSize / 2), fromY = Math.round(height * layer.enterFromY - cardSize / 2)
      const enterEnd = layer.enterStart + layer.enterDuration
      filters.push(`[${index + 1}:v]format=rgba,fade=t=in:st=${layer.enterStart}:d=${layer.enterDuration}:alpha=1,fade=t=out:st=${layer.exitStart}:d=${layer.exitDuration}:alpha=1[layer${index}]`)
      filters.push(`[${base}][layer${index}]overlay=x='${x}+(${fromX}-${x})*max(0,(${enterEnd}-t)/${layer.enterDuration})':y='${y}+(${fromY}-${y})*max(0,(${enterEnd}-t)/${layer.enterDuration})':enable='between(t,${layer.enterStart},${duration})'[v${index}]`)
      base = `v${index}`
    })
    filters.push(`[${base}]format=yuv420p[vout]`)
    await exec(ffmpeg, ['-hide_banner', '-xerror', ...inputs, '-t', String(duration), '-filter_complex', filters.join(';'),
      '-map', '[vout]', '-map', '0:a:0', '-r', '24', '-c:v', 'libx264', '-crf', '17', '-preset', 'medium', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '192k', '-movflags', '+faststart', temporary],
    { maxBuffer: 8 * 1024 * 1024, timeout: 10 * 60 * 1000 })
    await rename(temporary, destination)
  }
  const decoded = await exec(ffmpeg, ['-hide_banner', '-xerror', '-i', destination, '-f', 'null', '-'], { maxBuffer: 4 * 1024 * 1024, timeout: 120000 })
  const metadata = validateVideoMetadata(parseFfmpegMetadata(decoded.stderr), duration, aspectRatio, true)
  return { url: `/generated/${filename}`, sourceVideoUrl: pictureUrl, characterImages, illustrationLayers: layers, metadata,
    resolution, width, height, fps: 24, audioSampleRate: 48000, environmentalTrack: 'preserved',
    route: 'historical-map-portrait-overlay-v1' as const, motion: 'map-video-with-static-portraits' as const }
}

/** Compose inert character artwork as 2D cards over a stable background.
 * Cards may fade, translate and vary in layout size, but their internal pixels
 * never articulate: no walking, lip movement, pose or facial animation. */
export async function composeIllustrationMotionVideo(imageUrl: string, characterImages: string[], duration: number, aspectRatio: string,
  root = process.cwd(), referenceBindings: IllustrationReferenceBinding[] = [], authoredLayers: unknown = [], resolution: VideoResolution = '720p') {
  if (!Number.isFinite(duration) || duration < 3 || duration > 15) throw Error('STATIC_ILLUSTRATION_INVALID: 时长必须为 3–15 秒')
  let size: [number, number]
  try { size = videoDimensions(resolution, aspectRatio) } catch { throw Error(`STATIC_ILLUSTRATION_INVALID: 不支持画幅 ${aspectRatio}`) }
  const directory = path.join(root, 'public/generated'); await mkdir(directory, { recursive: true })
  const source = await localStillImage(imageUrl, root)
  const references = characterImages.filter(value => typeof value === 'string' && value.trim()).slice(0, 7)
  const [width, height] = size
  const fallbackRatio = references.length <= 1 ? .22 : references.length === 2 ? .18 : references.length <= 4 ? .15 : .12
  const bindings = references.map((_url, index) => String(referenceBindings[index]?.characterName ?? '').trim())
  const candidates = Array.isArray(authoredLayers) ? authoredLayers.filter(value => value && typeof value === 'object') as Array<Record<string, unknown>> : []
  const byName = new Map(candidates.map(value => [String(value.characterName ?? '').trim(), value]))
  const finite = (value: unknown, fallback: number) => Number.isFinite(Number(value)) ? Number(value) : fallback
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
  const columns = references.length <= 3 ? Math.max(1, references.length) : Math.ceil(references.length / 2)
  const layers: IllustrationLayerPlan[] = references.map((_url, index) => {
    const row = references.length <= 3 ? 0 : Math.floor(index / columns)
    const column = references.length <= 3 ? index : index % columns
    const fallbackX = (column + 1) / (columns + 1)
    const fallbackY = references.length <= 3 ? .48 : row === 0 ? .3 : .63
    const sourceLayer = byName.get(bindings[index]) ?? candidates[index] ?? {}
    const scale = clamp(finite(sourceLayer.scale, fallbackRatio), .1, .46)
    const x = clamp(finite(sourceLayer.x, fallbackX), scale / 2, 1 - scale / 2)
    const y = clamp(finite(sourceLayer.y, fallbackY), scale * width / height / 2, 1 - scale * width / height / 2)
    const enterStart = clamp(finite(sourceLayer.enterStart, Math.min(duration * .28, .2 + index * .38)), 0, duration - .6)
    const enterDuration = clamp(finite(sourceLayer.enterDuration, Math.min(.65, Math.max(.35, duration * .08))), .2, Math.min(1.5, duration - enterStart - .4))
    const enterEnd = enterStart + enterDuration
    const requestedExitDuration = clamp(finite(sourceLayer.exitDuration, .55), .2, 1.5)
    const exitStart = clamp(finite(sourceLayer.exitStart, duration - requestedExitDuration), enterEnd + .2, duration - .2)
    const exitDuration = clamp(requestedExitDuration, .2, Math.min(1.5, duration - exitStart))
    const defaultDirection = x < .5 ? -.04 : .04
    return { characterName: bindings[index], x, y, scale, enterStart, enterDuration,
      enterFromX: clamp(finite(sourceLayer.enterFromX, x + defaultDirection), 0, 1),
      enterFromY: clamp(finite(sourceLayer.enterFromY, y + .02), 0, 1),
      exitStart, exitDuration }
  })
  const cards = await Promise.all(references.map((value, index) => illustrationCard(value, Math.max(96, Math.round(width * layers[index].scale)), root)))
  const key = createHash('sha256').update(JSON.stringify({ version: 8, imageUrl, references, layers, duration, aspectRatio, resolution, route: 'layered-2d-authored-layout' })).digest('hex')
  const filename = `illustration-motion-${key}.mp4`, destination = path.join(directory, filename)
  try { await access(destination) } catch {
    const temporary = path.join(directory, `illustration-motion-${key}-${randomUUID()}.mp4`)
    const inputs = ['-loop', '1', '-i', source, ...cards.flatMap(card => ['-loop', '1', '-i', card]),
      '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000']
    const filters = [`[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1[bg]`]
    let base = 'bg'
    cards.forEach((_card, index) => {
      const layer = layers[index]
      const cardSize = Math.max(96, Math.round(width * layer.scale))
      const x = Math.round(width * layer.x - cardSize / 2)
      const y = Math.round(height * layer.y - cardSize / 2)
      const enterStart = layer.enterStart
      const enterDuration = layer.enterDuration
      const enterEnd = enterStart + enterDuration
      const fromX = Math.round(width * layer.enterFromX - cardSize / 2)
      const fromY = Math.round(height * layer.enterFromY - cardSize / 2)
      filters.push(`[${index + 1}:v]format=rgba,fade=t=in:st=${enterStart}:d=${enterDuration}:alpha=1,fade=t=out:st=${layer.exitStart}:d=${layer.exitDuration}:alpha=1[layer${index}]`)
      filters.push(`[${base}][layer${index}]overlay=x='${x}+(${fromX}-${x})*max(0,(${enterEnd}-t)/${enterDuration})':y='${y}+(${fromY}-${y})*max(0,(${enterEnd}-t)/${enterDuration})':enable='between(t,${enterStart},${duration})'[v${index}]`)
      base = `v${index}`
    })
    if (!cards.length) {
      filters.push(`[bg]zoompan=z='min(zoom+0.00035,1.035)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${width}x${height}:fps=24,fade=t=in:st=0:d=0.45,fade=t=out:st=${Math.max(0.5, duration - 0.55)}:d=0.5[vout]`)
    } else filters.push(`[${base}]format=yuv420p[vout]`)
    await exec(ffmpeg, ['-hide_banner', '-xerror', ...inputs, '-t', String(duration), '-filter_complex', filters.join(';'),
      '-map', '[vout]', '-map', `${cards.length + 1}:a:0`, '-r', '24', '-c:v', 'libx264', '-crf', '17', '-preset', 'medium', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '128k', '-shortest', '-movflags', '+faststart', temporary], { maxBuffer: 8 * 1024 * 1024, timeout: 10 * 60 * 1000 })
    await rename(temporary, destination)
  }
  const decoded = await exec(ffmpeg, ['-hide_banner', '-xerror', '-i', destination, '-f', 'null', '-'], { maxBuffer: 4 * 1024 * 1024, timeout: 120000 })
  const metadata = validateVideoMetadata(parseFfmpegMetadata(decoded.stderr), duration, aspectRatio, true)
  return { url: `/generated/${filename}`, imageUrl, characterImages: references, illustrationLayers: layers, metadata, resolution, width, height, fps: 24, audioSampleRate: 48000, route: 'layered-illustration-v1', motion: 'layered-2d' as const }
}

/** Keep the generated environmental track. The original supplier result and
 * its URL remain evidence; downstream nodes receive the composed video URL. */
export async function composeNarration(pictureUrl: string, tracks: Track[], duration: number, aspectRatio: string, root = process.cwd(), resolution: VideoResolution = '720p', audioRole: 'narration' | 'offscreen-dialogue' = 'narration') {
  if (!tracks.length || tracks.some(track => !audioUrl(track.url))) throw Error('NARRATION_TRACK_INVALID: 缺少完整本地旁白音轨')
  if (tracks.some(track => track.start + track.duration > duration + .001)) throw Error('NARRATION_DURATION_CONFLICT: 配音超出视频，禁止截断')
  const directory = path.join(root, 'public/generated'); await mkdir(directory, { recursive: true })
  const picture = await localPicture(pictureUrl, root)
  const inspected = await exec(ffmpeg, ['-hide_banner', '-i', picture, '-f', 'null', '-'], { maxBuffer: 4 * 1024 * 1024, timeout: 120000 })
  validateVideoMetadata(parseFfmpegMetadata(inspected.stderr), duration, aspectRatio, true)
  const [width, height] = videoDimensions(resolution, aspectRatio)
  const key = createHash('sha256').update(JSON.stringify({ version: 2, pictureUrl, tracks, duration, aspectRatio, resolution })).digest('hex')
  const filename = `narrated-${key}.mp4`, destination = path.join(directory, filename)
  try { await access(destination) } catch {
    const inputs = tracks.flatMap(track => ['-i', path.join(root, 'public', track.url)])
    const filters = tracks.map((track, i) => `[${i + 1}:a]atempo=${track.tempo},adelay=${Math.round(track.start * 1000)}:all=1[n${i}]`)
    filters.push(`[0:a]${tracks.map((_track, i) => `[n${i}]`).join('')}amix=inputs=${tracks.length + 1}:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95:level=false[a]`)
    const temporary = path.join(directory, `narrated-${key}-${randomUUID()}.mp4`)
    await exec(ffmpeg, ['-hide_banner', '-xerror', '-i', picture, ...inputs, '-filter_complex', filters.join(';'), '-map', '0:v:0', '-map', '[a]',
      '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=24`,
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '192k', '-movflags', '+faststart', temporary], { maxBuffer: 4 * 1024 * 1024, timeout: 10 * 60 * 1000 })
    await rename(temporary, destination)
  }
  const decoded = await exec(ffmpeg, ['-hide_banner', '-xerror', '-i', destination, '-f', 'null', '-'], { maxBuffer: 4 * 1024 * 1024, timeout: 120000 })
  const metadata = validateVideoMetadata(parseFfmpegMetadata(decoded.stderr), duration, aspectRatio, true)
  return { url: `/generated/${filename}`, pictureUrl, tracks, metadata, resolution, width, height, fps: 24, audioSampleRate: 48000,
    route: audioRole === 'offscreen-dialogue' ? 'independent-offscreen-dialogue-v1' : 'independent-narration-v1', audioRole,
    environmentalTrack: 'preserved', voiceConsistency: { status: 'uncertain', reason: `原创 TTS 音色已复用，成片仍需检查${audioRole === 'offscreen-dialogue' ? '角色画外对白' : '旁白'}、环境音与画内口型` } }
}
