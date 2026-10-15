/** Machine evidence for an independent narration track surviving the final mix.
 * A source TTS receipt and isolated ASR establish what was supplied; decoded
 * output is compared with the exact mixer and with each line removed. This
 * does not certify tone, pronunciation, speaker identity, or lip sync. */
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { createReadStream } from 'node:fs'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { pcmToWav } from './bailian-tts.ts'

const exec = promisify(execFile)
const ffmpeg = createRequire(import.meta.url)('ffmpeg-static') as string
const SHA = /^[a-f\d]{64}$/
const GENERATED_WAV = /^\/generated\/tts-(?:[\da-f-]+|edge-[\da-f]{64})\.wav$/
const COMPOSED_VIDEO = /^\/generated\/narrated-([a-f\d]{64})\.mp4$/
const SAMPLE_RATE = 16000
const MEDIUM_MODEL = 'Systran/faster-whisper-medium'
const MEDIUM_REVISION = '08e178d48790749d25932bbc082711ddcfdfbc4f'
const MEDIUM_VERSION = `${MEDIUM_MODEL}@${MEDIUM_REVISION}`
const roundTime = (seconds: number) => Math.round(seconds * 1000) / 1000
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const canonicalJson = (value: unknown): string => Array.isArray(value) ? '[' + value.map(canonicalJson).join(',') + ']'
  : value && typeof value === 'object' ? '{' + Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => JSON.stringify(key) + ':' + canonicalJson(item)).join(',') + '}' : JSON.stringify(value ?? null)

export type NarrationTrackRecipe = { beatId: string; text: string; start: number; end: number; url: string; sha256: string;
  sourceDuration: number; duration: number; tempo: number; voiceId: string; synthesisReceiptKey?: string;
  synthesis?: { model: string; rate: number; seed: number; instruction: string };
  normalization?: { sourceUrl: string; sourceSha256: string; derivedUrl: string; derivedSha256: string;
    trimStartSamples: number; trimEndSamples: number; sampleRate: number; sourceSampleCount: number; derivedSampleCount: number } }
export type PictureVoiceRecipe = { status: string; detector?: string; sourceSha256?: string; preservedOutsideWindows?: boolean;
  observations?: Array<{ source: string; start: number; end: number; text?: string }>;
  mutedWindows: Array<{ start: number; end: number }> }
type CompositionReceipt = { version: 'narration-composition-v1'; key: string; outputUrl: string; outputSha256: string;
  pictureUrl: string; pictureLocalUrl: string; pictureSha256: string; tracks: NarrationTrackRecipe[]; duration: number;
  audioRole: 'narration' | 'offscreen-dialogue'; pictureVoiceIsolation: PictureVoiceRecipe;
  filterGraph: string; audioDuration: number; mixerVersion?: 5 | 6 }
type Range = { lower: number; upper: number }
type SignalWindow = { start: number; end: number; samples: number; correlation: number; normalizedError: number;
  noTrackErrorRatio: number; contributionRms: number; actualRms: number; passed: boolean }

async function fileSha256(filename: string) {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(filename)) digest.update(chunk)
  return digest.digest('hex')
}

async function readIfExists(filename: string) {
  try { return await readFile(filename) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}

function pictureAudioFilter(plan: PictureVoiceRecipe, duration: number) {
  if (!plan.mutedWindows.length) return 'anull'
  return plan.mutedWindows.map(window => {
    const fadeStart = roundTime(Math.max(0, window.start - .08))
    const fadeEnd = roundTime(Math.min(duration, window.end + .08))
    const fadeOut = roundTime(Math.max(.001, window.start - fadeStart))
    const fadeIn = roundTime(Math.max(.001, fadeEnd - window.end))
    const expression = `if(lt(t,${fadeStart}),1,if(lt(t,${window.start}),(${window.start}-t)/${fadeOut},if(lt(t,${window.end}),0,if(lt(t,${fadeEnd}),(t-${window.end})/${fadeIn},1))))`
    return `volume='${expression}':eval=frame`
  }).join(',')
}

/** The same graph builds the delivered soundtrack and the independently
 * decoded expected mix. Explicit padding protects the picture's audio tail. */
export function buildNarrationMixFilter(tracks: NarrationTrackRecipe[], pictureVoiceIsolation: PictureVoiceRecipe,
  duration: number, omitTrack = -1, mixerVersion: 5 | 6 = 6) {
  if (!tracks.length || tracks.some(track => !Number.isFinite(track.tempo) || track.tempo <= 0
    || !Number.isFinite(track.start) || track.start < 0) || !Number.isFinite(duration) || duration <= 0) {
    throw Error('NARRATION_TRANSFER_RECIPE_INVALID: 音轨或时长无效')
  }
  const filters = tracks.flatMap((track, i) => i === omitTrack ? []
    : [`[${i + 1}:a]atempo=${track.tempo},adelay=${Math.round(track.start * 1000)}:all=1[n${i}]`])
  filters.push(`[0:a]${pictureAudioFilter(pictureVoiceIsolation, duration)}[ambient]`)
  const labels = ['[ambient]', ...tracks.flatMap((_track, i) => i === omitTrack ? [] : [`[n${i}]`])]
  // The supplier's audio stream can end before its picture. Keep later TTS
  // lines alive until their own end; atrim still fixes the delivered duration.
  filters.push(`${labels.join('')}${labels.length === 1 ? 'anull' : `amix=inputs=${labels.length}:duration=${mixerVersion === 5 ? 'first' : 'longest'}:dropout_transition=0:normalize=0`},alimiter=limit=0.95:level=false,apad,atrim=duration=${duration}[a]`)
  return filters.join(';')
}

/** The transfer test proves TTS arrived; this independently proves that the
 * same composition did not carry unverified supplier speech underneath it. */
export function assessPictureVoiceIsolation(plan: PictureVoiceRecipe, duration: number, pictureSha256: string, mixerVersion: number) {
  const unavailable = (reason: string) => ({ version: 'source-speech-isolation-v1' as const,
    status: 'unverified' as const, reason, pictureSha256, mixerVersion })
  if (!Number.isFinite(duration) || duration <= 0 || plan.sourceSha256 !== pictureSha256
    || !Array.isArray(plan.mutedWindows) || ![5, 6].includes(mixerVersion)) return unavailable('source-or-recipe-unbound')
  const windows = plan.mutedWindows
  if (windows.some(window => !Number.isFinite(window.start) || !Number.isFinite(window.end)
    || window.start < 0 || window.end <= window.start || window.end > duration + .001)) return unavailable('mute-window-invalid')
  if (plan.status === 'fully-muted-unverified' && plan.preservedOutsideWindows === false
    && windows.some(window => window.start <= 0 && window.end >= duration - .001)) {
    return { version: 'source-speech-isolation-v1' as const, status: 'confirmed' as const,
      mode: 'full-source-mute' as const, pictureSha256, mixerVersion }
  }
  // Covering detected windows still leaves undetected supplier speech audible.
  // Old local-mute receipts remain readable, but need a same-picture full remix.
  if (plan.status === 'locally-muted') return unavailable('partial-source-audio-preserved')
  return unavailable('source-speech-absence-or-mute-unverified')
}

async function decodedPcm(filename: string) {
  const { stdout } = await exec(ffmpeg, ['-v', 'error', '-xerror', '-i', filename, '-map', '0:a:0', '-vn',
    '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 'f32le', '-'], { encoding: 'buffer', timeout: 120000, maxBuffer: 128 * 1024 * 1024 })
  const bytes = stdout as Buffer
  if (bytes.length % 4 || !bytes.length) throw Error('NARRATION_TRANSFER_DECODE_FAILED: 成片音轨解码为空或不完整')
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4)
}

export async function decodedAudioDuration(filename: string) {
  return (await decodedPcm(filename)).length / SAMPLE_RATE
}

async function expectedPcm(receipt: CompositionReceipt, root: string, omitTrack = -1) {
  const picture = path.join(root, 'public', receipt.pictureLocalUrl)
  const inputs = receipt.tracks.flatMap(track => ['-i', path.join(root, 'public', track.url)])
  const graph = buildNarrationMixFilter(receipt.tracks, receipt.pictureVoiceIsolation, receipt.duration, omitTrack, receipt.mixerVersion ?? 5)
  const { stdout } = await exec(ffmpeg, ['-v', 'error', '-xerror', '-i', picture, ...inputs,
    '-filter_complex', graph, '-map', '[a]', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 'f32le', '-'],
  { encoding: 'buffer', timeout: 120000, maxBuffer: 128 * 1024 * 1024 })
  const bytes = stdout as Buffer
  if (bytes.length % 4 || !bytes.length) throw Error('NARRATION_TRANSFER_DECODE_FAILED: 预期混音解码为空或不完整')
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4)
}

/** Compare real decoded samples, including a counterfactual without this line.
 * Ambient-only similarity cannot pass because noTrackErrorRatio collapses. */
export function measureNarrationWindow(expected: Float32Array, actual: Float32Array, withoutLine: Float32Array,
  start: number, end: number): SignalWindow {
  const first = Math.max(0, Math.floor(start * SAMPLE_RATE)), last = Math.ceil(end * SAMPLE_RATE)
  if (end <= start || last - first < SAMPLE_RATE * .12 || last > expected.length || last > actual.length || last > withoutLine.length) {
    return { start, end, samples: 0, correlation: 0, normalizedError: Infinity,
      noTrackErrorRatio: 0, contributionRms: 0, actualRms: 0, passed: false }
  }
  let sumExpected = 0, sumActual = 0, sumExpectedSquare = 0, sumActualSquare = 0, cross = 0
  let errorSquare = 0, noTrackErrorSquare = 0, contributionSquare = 0
  const count = last - first
  for (let i = first; i < last; i++) {
    const e = expected[i], a = actual[i], absent = withoutLine[i]
    sumExpected += e; sumActual += a; sumExpectedSquare += e * e; sumActualSquare += a * a; cross += e * a
    errorSquare += (a - e) ** 2; noTrackErrorSquare += (a - absent) ** 2; contributionSquare += (e - absent) ** 2
  }
  const covariance = cross - sumExpected * sumActual / count
  const varianceExpected = sumExpectedSquare - sumExpected ** 2 / count
  const varianceActual = sumActualSquare - sumActual ** 2 / count
  const correlation = varianceExpected > 0 && varianceActual > 0 ? covariance / Math.sqrt(varianceExpected * varianceActual) : 0
  const error = Math.sqrt(errorSquare / count), noTrackError = Math.sqrt(noTrackErrorSquare / count)
  const expectedRms = Math.sqrt(sumExpectedSquare / count), actualRms = Math.sqrt(sumActualSquare / count)
  const contributionRms = Math.sqrt(contributionSquare / count)
  const normalizedError = error / Math.max(expectedRms, .001)
  const noTrackErrorRatio = noTrackError / Math.max(error, .00001)
  return { start, end, samples: count, correlation, normalizedError, noTrackErrorRatio, contributionRms, actualRms,
    passed: correlation >= .98 && normalizedError <= .15 && noTrackErrorRatio >= 3
      && contributionRms >= .003 && actualRms >= .003 }
}

export async function saveNarrationCompositionReceipt(input: Omit<CompositionReceipt, 'version' | 'outputSha256' | 'pictureLocalUrl'> & {
  outputFile: string; pictureFile: string }, root: string) {
  const { outputFile, pictureFile, ...saved } = input
  const relativePicture = path.relative(path.join(root, 'public'), pictureFile).split(path.sep).join('/')
  if (COMPOSED_VIDEO.exec(input.outputUrl)?.[1] !== input.key || !SHA.test(input.pictureSha256)
    || !/^generated\/[\w.-]+\.mp4$/.test(relativePicture)
    || input.filterGraph !== buildNarrationMixFilter(input.tracks, input.pictureVoiceIsolation, input.duration)
    || (await fileSha256(pictureFile)) !== input.pictureSha256) throw Error('NARRATION_TRANSFER_RECIPE_INVALID: 合成来源身份无效')
  const outputSha256 = await fileSha256(outputFile)
  const receipt: CompositionReceipt = { version: 'narration-composition-v1', ...saved,
    pictureLocalUrl: '/' + relativePicture, outputSha256, mixerVersion: 6 }
  const dir = path.join(root, '.runtime/narration-compositions')
  await mkdir(dir, { recursive: true })
  const filename = path.join(dir, `${input.key}.json`)
  const bytes = JSON.stringify(receipt)
  try { await writeFile(filename, bytes, { flag: 'wx' }) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || await readFile(filename, 'utf8') !== bytes) {
      throw new Error('NARRATION_TRANSFER_RECIPE_INVALID: 已存合成回执与实际成片不符', { cause: error })
    }
  }
  return receipt
}

function wavePcm(bytes: Buffer) {
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw Error('WAV_INVALID')
  let sampleRate = 0, pcm: Buffer | undefined
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const type = bytes.toString('ascii', offset, offset + 4), size = bytes.readUInt32LE(offset + 4), start = offset + 8
    if (start + size > bytes.length) throw Error('WAV_INVALID')
    if (type === 'fmt ') {
      if (bytes.readUInt16LE(start) !== 1 || bytes.readUInt16LE(start + 2) !== 1 || bytes.readUInt16LE(start + 14) !== 16) throw Error('WAV_INVALID')
      sampleRate = bytes.readUInt32LE(start + 4)
    } else if (type === 'data') pcm = bytes.subarray(start, start + size)
    offset = start + size + size % 2
  }
  if (!sampleRate || !pcm?.length || pcm.length % 2) throw Error('WAV_INVALID')
  return { pcm, sampleRate, sampleCount: pcm.length / 2 }
}

async function validateTrackReceipt(track: NarrationTrackRecipe, root: string) {
  if (!SHA.test(String(track.synthesisReceiptKey)) || !SHA.test(track.sha256) || !GENERATED_WAV.test(track.url)) throw Error('TTS_RECEIPT_MISSING')
  const receiptBytes = await readFile(path.join(root, '.runtime/narration-syntheses', track.synthesisReceiptKey + '.json'))
  const receipt = JSON.parse(receiptBytes.toString()) as { version: string; identityKey: string; identity: Record<string, unknown>;
    result: { url: string; sha256: string; transcript: string; voice: string; model: string; rate: number; seed: number;
      instruction?: string; sampleCount: number; duration: number } }
  const identity = receipt.identity, voice = identity.voice as Record<string, unknown>
  if (receipt.version !== 'narration-synthesis-v1' || receipt.identityKey !== track.synthesisReceiptKey
    || hash(canonicalJson(identity)) !== track.synthesisReceiptKey || identity.text !== track.text
    || voice?.voiceId !== track.voiceId || receipt.result.transcript !== track.text
    || receipt.result.voice !== track.voiceId || receipt.result.model !== track.synthesis?.model
    || receipt.result.rate !== track.synthesis?.rate || receipt.result.seed !== track.synthesis?.seed
    || (receipt.result.instruction ?? '') !== (track.synthesis?.instruction ?? '')
    || !GENERATED_WAV.test(receipt.result.url) || !SHA.test(receipt.result.sha256)) throw Error('TTS_RECEIPT_IDENTITY_MISMATCH')
  const rawBytes = await readFile(path.join(root, 'public', receipt.result.url))
  if (hash(rawBytes) !== receipt.result.sha256) throw Error('TTS_RECEIPT_SOURCE_CHANGED')
  const raw = wavePcm(rawBytes)
  if (raw.sampleCount !== receipt.result.sampleCount || Math.abs(raw.sampleCount / raw.sampleRate - receipt.result.duration) > 1 / raw.sampleRate) {
    throw Error('TTS_RECEIPT_SAMPLES_MISMATCH')
  }
  const fittedBytes = await readFile(path.join(root, 'public', track.url))
  if (hash(fittedBytes) !== track.sha256) throw Error('TTS_TRACK_CHANGED')
  if (track.normalization) {
    const n = track.normalization
    if (n.sourceUrl !== receipt.result.url || n.sourceSha256 !== receipt.result.sha256 || n.derivedUrl !== track.url
      || n.derivedSha256 !== track.sha256 || n.sourceSampleCount !== raw.sampleCount || n.sampleRate !== raw.sampleRate
      || !Number.isSafeInteger(n.trimStartSamples) || !Number.isSafeInteger(n.trimEndSamples)
      || n.trimStartSamples < 0 || n.trimEndSamples < 0 || n.trimStartSamples + n.trimEndSamples >= raw.sampleCount
      || n.derivedSampleCount !== raw.sampleCount - n.trimStartSamples - n.trimEndSamples) throw Error('TTS_NORMALIZATION_MISMATCH')
    const derived = pcmToWav(raw.pcm.subarray(n.trimStartSamples * 2, (raw.sampleCount - n.trimEndSamples) * 2), raw.sampleRate)
    if (!derived.equals(fittedBytes)) throw Error('TTS_NORMALIZATION_BYTES_MISMATCH')
  } else if (receipt.result.sha256 !== track.sha256 || receipt.result.url !== track.url) throw Error('TTS_TRACK_RECEIPT_MISMATCH')
  return { key: track.synthesisReceiptKey, sha256: receipt.result.sha256, receiptSha256: hash(receiptBytes),
    sourceSamples: raw.sampleCount, sourceSampleRate: raw.sampleRate }
}

type IsolatedAsrResult = { speechValidation?: { alignment?: Array<Record<string, unknown>>; passed?: boolean; issues?: string[]; method?: string } }
type SourceAsrWindow = { beatId: string; text: string; start: number; end: number; actorIds: string[] }
type SourceAsrDependencies = {
  transcribe?: (model: 'small' | 'medium', modelPath: string, wav: string, text: string, windows: SourceAsrWindow[], duration: number, root: string) => Promise<Buffer>
  resolveMediumModel?: () => Promise<string | undefined>
}

function assessIsolatedAsr(result: IsolatedAsrResult, track: NarrationTrackRecipe, key: string, bytes: Buffer,
  model: 'small' | 'medium') {
  const alignment = result.speechValidation?.alignment?.[0]
  const end = alignment?.endBoundaryRange as Range | undefined, start = alignment?.startBoundaryRange as Range | undefined
  const reliable = result.speechValidation?.method === `local-whisper-${model}-phonetic-alignment`
    && result.speechValidation?.passed === true && result.speechValidation.alignment?.length === 1
    && Array.isArray(result.speechValidation.issues) && result.speechValidation.issues.length === 0
    && alignment?.boundaryStatus === 'reliable' && alignment.boundaryEvidenceVersion === 2
    && alignment.alignmentCoverage === 1 && alignment.firstTokenMatched === true && alignment.lastTokenMatched === true
    && Array.isArray(alignment.boundaryUncertaintyReasons) && alignment.boundaryUncertaintyReasons.length === 0
    && Number.isFinite(start?.lower) && Number.isFinite(start?.upper) && Number.isFinite(end?.lower) && Number.isFinite(end?.upper)
    && start!.lower >= 0 && end!.upper <= track.sourceDuration + .15 && end!.lower > start!.upper
    && typeof (alignment.rawUtteranceCandidate as Record<string, unknown> | undefined)?.text === 'string'
    && String((alignment.rawUtteranceCandidate as Record<string, unknown>).text).trim().length > 0
  return { receiptKey: key, receiptSha256: hash(bytes), method: 'isolated-source-asr-v2' as const, reliable: Boolean(reliable),
    start: reliable ? start! : null, end: reliable ? end! : null,
    recognizedText: (alignment?.rawUtteranceCandidate as Record<string, unknown> | undefined)?.text ?? null,
    boundaryStatus: alignment?.boundaryStatus ?? 'unavailable', issues: result.speechValidation?.issues ?? [] }
}

async function transcribeIsolatedSource(model: 'small' | 'medium', modelPath: string, wav: string, text: string,
  windows: SourceAsrWindow[], duration: number, root: string) {
  const python = path.join(root, '.venv-quality/bin/python'), script = path.join(root, 'scripts/transcribe-quality.py')
  const { stdout } = await exec(python, [script, wav, '--model', modelPath, '--model-label', model,
    '--expected', text, '--windows', JSON.stringify(windows), '--latest-speech-end', String(duration)],
  { timeout: 180000, maxBuffer: 8 * 1024 * 1024 })
  return Buffer.from(stdout)
}

async function localMediumModel() {
  const hub = process.env.HF_HUB_CACHE ?? path.join(process.env.HF_HOME ?? path.join(os.homedir(), '.cache/huggingface'), 'hub')
  const snapshot = path.join(hub, 'models--Systran--faster-whisper-medium', 'snapshots', MEDIUM_REVISION)
  try { await access(path.join(snapshot, 'model.bin')); return snapshot }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}

/** The existing small receipt is immutable. Only an uncertain isolated-source
 * boundary may trigger a locally installed, pinned medium model. Its own
 * receipt binds the WAV, expected text/window, model revision and validator. */
export async function sourceAsr(track: NarrationTrackRecipe, root: string, dependencies: SourceAsrDependencies = {}) {
  const wav = path.join(root, 'public', track.url)
  if (await fileSha256(wav) !== track.sha256) throw Error('TTS_TRACK_CHANGED')
  const windows: SourceAsrWindow[] = [{ beatId: track.beatId, text: track.text, start: 0, end: track.sourceDuration, actorIds: ['旁白'] }]
  const key = hash(JSON.stringify({ version: 1, sha256: track.sha256, text: track.text, beatId: track.beatId, duration: track.sourceDuration }))
  const dir = path.join(root, '.runtime/narration-source-asr')
  await mkdir(dir, { recursive: true })
  const filename = path.join(dir, `${key}.json`)
  let bytes: Buffer
  try { bytes = await readFile(filename) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    bytes = await (dependencies.transcribe ?? transcribeIsolatedSource)('small', 'small', wav, track.text, windows, track.sourceDuration, root)
    try { await writeFile(filename, bytes, { flag: 'wx' }) }
    catch (writeError) { if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError; bytes = await readFile(filename) }
  }
  const primary = assessIsolatedAsr(JSON.parse(bytes.toString()) as IsolatedAsrResult, track, key, bytes, 'small')
  if (primary.reliable || primary.boundaryStatus === 'reliable') return primary
  const codeFiles = ['transcribe-quality.py', 'speech_boundaries.py', 'speech_pronunciation.py']
  const codeBytes = await Promise.all(codeFiles.map(name => readFile(path.join(root, 'scripts', name))))
  const identity = { version: 'isolated-source-asr-medium-v1', modelVersion: MEDIUM_VERSION,
    fittedWavSha256: track.sha256, expectedText: track.text, windows, latestSpeechEnd: track.sourceDuration,
    validatorSha256: hash(Buffer.concat(codeBytes)) }
  const mediumKey = hash(canonicalJson(identity))
  const mediumDir = path.join(root, '.runtime/narration-source-asr-medium')
  await mkdir(mediumDir, { recursive: true })
  const mediumFilename = path.join(mediumDir, `${mediumKey}.json`)
  let mediumBytes = await readIfExists(mediumFilename)
  if (!mediumBytes) {
    const modelPath = await (dependencies.resolveMediumModel ?? localMediumModel)()
    if (!modelPath) return primary
    let result: IsolatedAsrResult
    try {
      const resultBytes = await (dependencies.transcribe ?? transcribeIsolatedSource)('medium', modelPath, wav, track.text, windows, track.sourceDuration, root)
      result = JSON.parse(resultBytes.toString()) as IsolatedAsrResult
      if (result.speechValidation?.method !== 'local-whisper-medium-phonetic-alignment') throw Error('NARRATION_ASR_MODEL_MISMATCH')
    } catch (error) {
      return { ...primary, secondaryAsr: { status: 'unavailable', modelVersion: MEDIUM_VERSION,
        reason: error instanceof Error ? error.message : String(error) } }
    }
    mediumBytes = Buffer.from(JSON.stringify({ version: 'isolated-source-asr-medium-v1', identityKey: mediumKey,
      identity, result, createdAt: new Date().toISOString() }))
    try { await writeFile(mediumFilename, mediumBytes, { flag: 'wx' }) }
    catch (writeError) { if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError; mediumBytes = await readFile(mediumFilename) }
  }
  const mediumReceipt = JSON.parse(mediumBytes.toString()) as { version?: string; identityKey?: string; identity?: unknown; result?: IsolatedAsrResult }
  if (mediumReceipt.version !== 'isolated-source-asr-medium-v1' || mediumReceipt.identityKey !== mediumKey
    || canonicalJson(mediumReceipt.identity) !== canonicalJson(identity)
    || mediumReceipt.result?.speechValidation?.method !== 'local-whisper-medium-phonetic-alignment') throw Error('NARRATION_ASR_RECEIPT_MISMATCH')
  const medium = assessIsolatedAsr(mediumReceipt.result, track, mediumKey, mediumBytes, 'medium')
  const mediumEvidence = { ...medium, method: 'isolated-source-asr-v3' as const, modelVersion: MEDIUM_VERSION, primaryAsr: primary }
  return medium.reliable ? mediumEvidence : { ...primary, secondaryAsr: mediumEvidence }
}

function timeRange(seconds: number): Range { return { lower: roundTime(Math.max(0, seconds - .08)), upper: roundTime(seconds + .08) } }

/** Returns undefined for other routes; a failed proof remains visible but can
 * never be used by the completion gate. */
export async function collectIndependentNarrationTransferEvidence(originalUrl: string, outputFile: string,
  evidenceRef: string, outputVideoSha256: string, root = process.cwd()) {
  const match = COMPOSED_VIDEO.exec(originalUrl)
  if (!match) return undefined
  let isolationProof: ReturnType<typeof assessPictureVoiceIsolation> | undefined
  let boundReceipt: { pictureSha256: string; mixerVersion: number; receiptSha256: string;
    audioRole: 'narration' | 'offscreen-dialogue' } | undefined
  try {
    const receiptBytes = await readFile(path.join(root, '.runtime/narration-compositions', match[1] + '.json'))
    const receipt = JSON.parse(receiptBytes.toString()) as CompositionReceipt
    if (receipt.version !== 'narration-composition-v1' || receipt.key !== match[1] || receipt.outputUrl !== originalUrl
      || receipt.outputSha256 !== outputVideoSha256 || await fileSha256(outputFile) !== outputVideoSha256
      || !['narration', 'offscreen-dialogue'].includes(receipt.audioRole) || !SHA.test(receipt.pictureSha256)
      || !/^\/generated\/[\w.-]+\.mp4$/.test(receipt.pictureLocalUrl)
      || await fileSha256(path.join(root, 'public', receipt.pictureLocalUrl)) !== receipt.pictureSha256
      || !Array.isArray(receipt.tracks) || !receipt.tracks.length
      || ![5, 6].includes(receipt.mixerVersion ?? 5)
      || receipt.filterGraph !== buildNarrationMixFilter(receipt.tracks, receipt.pictureVoiceIsolation, receipt.duration, -1, receipt.mixerVersion ?? 5)) {
      throw Error('COMPOSITION_RECEIPT_MISMATCH')
    }
    isolationProof = assessPictureVoiceIsolation(receipt.pictureVoiceIsolation, receipt.duration,
      receipt.pictureSha256, receipt.mixerVersion ?? 5)
    boundReceipt = { pictureSha256: receipt.pictureSha256, mixerVersion: receipt.mixerVersion ?? 5,
      receiptSha256: hash(receiptBytes), audioRole: receipt.audioRole }
    const actual = await decodedPcm(outputFile), expected = await expectedPcm(receipt, root)
    const audioDuration = actual.length / SAMPLE_RATE
    if (audioDuration < receipt.duration - .05) throw Error('FINAL_AUDIO_TAIL_TRUNCATED')
    if (receipt.audioRole === 'offscreen-dialogue') return {
      version: 'independent-track-transfer-v1', method: 'independent-track-transfer', status: 'unverified',
      evidenceRef, originalUrl, outputVideoSha256, compositionReceiptSha256: hash(receiptBytes),
      pictureSha256: receipt.pictureSha256, mixerVersion: receipt.mixerVersion ?? 5, audioRole: receipt.audioRole,
      sourceSpeechIsolation: isolationProof, decodedAudioDuration: audioDuration,
      expectedAudioDuration: expected.length / SAMPLE_RATE, sampleRate: SAMPLE_RATE, lines: [],
      reason: 'OFFSCREEN_TRACK_TRANSFER_NOT_EVALUATED',
      scope: 'source-audio-isolation-only;offscreen-dialogue-requires-separate-speech-and-lip-review',
    }
    const lines = []
    for (const [index, track] of receipt.tracks.entries()) {
      const source = await validateTrackReceipt(track, root)
      const asr = await sourceAsr(track, root)
      const withoutLine = await expectedPcm(receipt, root, index)
      const start = asr.start ? track.start + asr.start.lower / track.tempo : track.start
      const end = asr.end ? track.start + asr.end.upper / track.tempo : track.start + track.duration
      const full = measureNarrationWindow(expected, actual, withoutLine, start, end)
      const tail = measureNarrationWindow(expected, actual, withoutLine, Math.max(start, end - .35), Math.min(receipt.duration, end + .03))
      const confirmed = asr.reliable && full.passed && tail.passed && end <= receipt.duration + .001
      lines.push({ id: `independent-track-${index}`, beatId: track.beatId, text: track.text, actorIds: ['旁白'],
        sourceReceiptKey: source.key, sourceReceiptSha256: source.receiptSha256, sourceWavSha256: source.sha256,
        fittedWavSha256: track.sha256, sourceSamples: source.sourceSamples, sourceSampleRate: source.sourceSampleRate,
        voiceId: track.voiceId, scheduledStart: track.start, scheduledEnd: track.end, tempo: track.tempo,
        sourceAsr: asr, observedStart: asr.reliable ? timeRange(start) : null,
        observedEnd: asr.reliable ? timeRange(end) : null, fullWindow: full, lastWordWindow: tail,
        status: confirmed ? 'confirmed' : 'unverified' })
    }
    return { version: 'independent-track-transfer-v1', method: 'independent-track-transfer',
      status: lines.every(line => line.status === 'confirmed') ? 'confirmed' : 'unverified',
      evidenceRef, originalUrl, outputVideoSha256, compositionReceiptSha256: hash(receiptBytes),
      pictureSha256: receipt.pictureSha256, mixerVersion: receipt.mixerVersion ?? 5, audioRole: receipt.audioRole,
      sourceSpeechIsolation: isolationProof, decodedAudioDuration: audioDuration,
      expectedAudioDuration: expected.length / SAMPLE_RATE, sampleRate: SAMPLE_RATE,
      lines, scope: 'source-TTS-phonetic-boundary-and-final-audio-transfer;not-pronunciation-or-human-listening' }
  } catch (error) {
    return { version: 'independent-track-transfer-v1', method: 'independent-track-transfer', status: 'unverified',
      evidenceRef, originalUrl, outputVideoSha256, lines: [],
      ...(boundReceipt && isolationProof ? { pictureSha256: boundReceipt.pictureSha256,
        mixerVersion: boundReceipt.mixerVersion, compositionReceiptSha256: boundReceipt.receiptSha256,
        audioRole: boundReceipt.audioRole, sourceSpeechIsolation: isolationProof } : {}),
      reason: error instanceof Error ? error.message : String(error) }
  }
}
