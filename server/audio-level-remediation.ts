import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { link, open, readFile, realpath, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import ffmpeg from 'ffmpeg-static'

const exec = promisify(execFile)
const TARGET_LUFS = -23
const LOW_MEAN_DBFS = -50
const MIN_MEAN_DBFS = -65
const MIN_PEAK_DBFS = -40
const TRUE_PEAK_CEILING_DBFS = -1.5
const MAX_GAIN_DB = 30

type AudioLevels = { meanDbfs: number; maxDbfs: number; integratedLufs: number; truePeakDbfs: number;
  silenceSecondsBelowMinus50: number; activeSecondsAboveMinus50: number }
type MediaAnalysis = { sha256: string; bytes: number; duration: number; videoFrameCount: number;
  videoFramesSha256: string; videoFrameHashes: string[]; audio: AudioLevels }
export type AudioLevelRemediationPlan = { version: 'audio-level-remediation-v1'; sourceUrl: string;
  source: MediaAnalysis; targetLufs: number; gainDb: number; predictedMeanDbfs: number;
  predictedTruePeakDbfs: number; outputUrl: string; manifestUrl: string; root: string }

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const fail = (code: string, detail: string): never => { throw Error(`${code}: ${detail}`) }
const finite = (value: string | undefined, label: string) => {
  const number = Number(value)
  if (!value || !Number.isFinite(number)) return fail('AUDIO_REMEDIATION_ANALYSIS_INVALID', label)
  return number
}

/** An RMS threshold alone would reject sparse but genuine action sounds.
 * Require a measurable sound interval and a peak that can be raised without
 * clipping; this does not claim that the sound matches the pictured action. */
export function chooseAudioLevelGain(sound: AudioLevels, duration: number, targetLufs = TARGET_LUFS) {
  if (!Number.isFinite(targetLufs) || targetLufs < -30 || targetLufs > -16) {
    return fail('AUDIO_REMEDIATION_TARGET_INVALID', '目标响度须在 -30 至 -16 LUFS')
  }
  if (sound.meanDbfs >= LOW_MEAN_DBFS) return fail('AUDIO_REMEDIATION_NOT_NEEDED', '原片平均音量已达到验收阈值')
  if (sound.meanDbfs <= MIN_MEAN_DBFS || sound.maxDbfs <= MIN_PEAK_DBFS
    || sound.activeSecondsAboveMinus50 < Math.max(0.5, duration * 0.1)) {
    return fail('AUDIO_REMEDIATION_NO_MEANINGFUL_SOUND', '真实音效不足，不能放大噪声伪装成有声视频')
  }
  const gainDb = Math.round((targetLufs - sound.integratedLufs) * 10) / 10
  const predictedTruePeakDbfs = Math.round((sound.truePeakDbfs + gainDb) * 10) / 10
  const predictedMeanDbfs = Math.round((sound.meanDbfs + gainDb) * 10) / 10
  if (gainDb <= 0 || gainDb > MAX_GAIN_DB || predictedTruePeakDbfs > TRUE_PEAK_CEILING_DBFS
    || predictedMeanDbfs < LOW_MEAN_DBFS) {
    return fail('AUDIO_REMEDIATION_UNSAFE_GAIN', '无法在不削波的前提下把真实音轨提升到可用响度')
  }
  return { gainDb, predictedMeanDbfs, predictedTruePeakDbfs }
}

async function localVideo(sourceUrl: string, root: string): Promise<string> {
  if (!/^\/generated\/[A-Za-z0-9._-]+\.mp4$/.test(sourceUrl)) return fail('AUDIO_REMEDIATION_SOURCE_INVALID', '只接受本地生成的 MP4')
  const generated = await realpath(path.join(root, 'public/generated'))
  const filename = await realpath(path.join(generated, path.basename(sourceUrl)))
  if (!filename.startsWith(generated + path.sep) || !(await stat(filename)).isFile()) {
    return fail('AUDIO_REMEDIATION_SOURCE_INVALID', '原片不在生成媒体目录')
  }
  return filename
}

async function ffmpegText(args: string[], maxBuffer = 4 * 1024 * 1024): Promise<{ stdout: string; stderr: string }> {
  try { return await exec(ffmpeg!, args, { timeout: 120_000, maxBuffer }) }
  catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? '')
    if (/matches no streams|Stream map '0:a:0' matches no streams/i.test(stderr)) {
      return fail('AUDIO_REMEDIATION_NO_TRACK', '原片没有真实音轨')
    }
    return fail('AUDIO_REMEDIATION_DECODE_FAILED', '原片音视频无法完整解码')
  }
}

async function videoFrameHashes(filename: string): Promise<string[]> {
  const { stdout } = await ffmpegText(['-hide_banner', '-v', 'error', '-xerror', '-i', filename,
    '-map', '0:v:0', '-f', 'framemd5', '-'])
  const hashes = stdout.split(/\r?\n/).filter(line => line.trim() && !line.startsWith('#'))
    .map(line => line.split(',').at(-1)?.trim() ?? '')
  if (!hashes.length || hashes.some(hash => !/^[a-f0-9]{32}$/i.test(hash))) {
    return fail('AUDIO_REMEDIATION_VIDEO_INVALID', '逐帧解码散列缺失')
  }
  return hashes
}

async function analyze(filename: string): Promise<MediaAnalysis> {
  const bytes = await readFile(filename)
  if (!bytes.length || bytes.length > 250 * 1024 * 1024) return fail('AUDIO_REMEDIATION_SOURCE_INVALID', '原片大小无效')
  const decoded = await ffmpegText(['-hide_banner', '-xerror', '-i', filename,
    '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'])
  const duration = finite(decoded.stderr.match(/Duration:\s*(\d+):(\d+):([\d.]+)/)?.slice(1).reduce((acc, part, i) => acc + Number(part) * [3600, 60, 1][i], 0)?.toString(), '视频时长缺失')
  if (duration < 1 || duration > 600) return fail('AUDIO_REMEDIATION_SOURCE_INVALID', '视频时长超出处理范围')
  const volume = await ffmpegText(['-hide_banner', '-i', filename, '-map', '0:a:0', '-af', 'volumedetect', '-f', 'null', '-'])
  const meanDbfs = finite(volume.stderr.match(/mean_volume:\s*(-?[\d.]+) dB/)?.[1], '均值音量缺失')
  const maxDbfs = finite(volume.stderr.match(/max_volume:\s*(-?[\d.]+) dB/)?.[1], '峰值音量缺失')
  const loudness = await ffmpegText(['-hide_banner', '-i', filename, '-map', '0:a:0', '-af', 'ebur128=peak=true', '-f', 'null', '-'])
  const summary = loudness.stderr.slice(loudness.stderr.lastIndexOf('Summary:'))
  const integratedLufs = finite(summary.match(/\bI:\s*(-?[\d.]+) LUFS/)?.[1], '综合响度缺失')
  const truePeakDbfs = finite(summary.match(/True peak:[\s\S]*?Peak:\s*(-?[\d.]+) dBFS/)?.[1], '真实峰值缺失')
  const silence = await ffmpegText(['-hide_banner', '-i', filename, '-map', '0:a:0', '-af', 'silencedetect=noise=-50dB:d=0.2', '-f', 'null', '-'])
  const silenceSecondsBelowMinus50 = [...silence.stderr.matchAll(/silence_duration:\s*([\d.]+)/g)]
    .reduce((sum, match) => sum + Number(match[1]), 0)
  const hashes = await videoFrameHashes(filename)
  return { sha256: sha256(bytes), bytes: bytes.length, duration, videoFrameCount: hashes.length,
    videoFramesSha256: sha256(hashes.join('\n')), videoFrameHashes: hashes,
    audio: { meanDbfs, maxDbfs, integratedLufs, truePeakDbfs,
      silenceSecondsBelowMinus50, activeSecondsAboveMinus50: Math.max(0, duration - silenceSecondsBelowMinus50) } }
}

export async function planAudioLevelRemediation(sourceUrl: string, options: { root?: string; targetLufs?: number } = {}): Promise<AudioLevelRemediationPlan> {
  const root = path.resolve(options.root ?? process.cwd())
  const filename = await localVideo(sourceUrl, root)
  const source = await analyze(filename)
  const targetLufs = options.targetLufs ?? TARGET_LUFS
  const { gainDb, predictedMeanDbfs, predictedTruePeakDbfs } = chooseAudioLevelGain(source.audio, source.duration, targetLufs)
  const key = sha256(JSON.stringify({ version: 1, sourceSha256: source.sha256, targetLufs, gainDb })).slice(0, 20)
  const stem = `audio-leveled-${source.sha256.slice(0, 16)}-${key}`
  return { version: 'audio-level-remediation-v1', sourceUrl, source, targetLufs, gainDb,
    predictedMeanDbfs, predictedTruePeakDbfs, outputUrl: `/generated/${stem}.mp4`,
    manifestUrl: `/generated/${stem}.json`, root }
}

export async function applyAudioLevelRemediation(plan: AudioLevelRemediationPlan) {
  if (plan.version !== 'audio-level-remediation-v1') return fail('AUDIO_REMEDIATION_PLAN_INVALID', '计划版本无效')
  const current = await planAudioLevelRemediation(plan.sourceUrl, { root: plan.root, targetLufs: plan.targetLufs })
  if (current.source.sha256 !== plan.source.sha256 || current.outputUrl !== plan.outputUrl
    || current.gainDb !== plan.gainDb || current.source.videoFramesSha256 !== plan.source.videoFramesSha256) {
    return fail('AUDIO_REMEDIATION_SOURCE_CHANGED', '原片或处理计划发生变化')
  }
  const sourceFile = await localVideo(plan.sourceUrl, plan.root)
  const generated = path.join(plan.root, 'public/generated')
  const outputFile = path.join(generated, path.basename(plan.outputUrl))
  const manifestFile = path.join(generated, path.basename(plan.manifestUrl))
  let outputExists = false
  try { outputExists = (await stat(outputFile)).isFile() } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  if (!outputExists) {
    const temporary = path.join(generated, `.${path.basename(plan.outputUrl)}.${randomUUID()}.tmp.mp4`)
    try {
      await ffmpegText(['-hide_banner', '-v', 'error', '-xerror', '-n', '-i', sourceFile,
        '-map', '0:v:0', '-map', '0:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
        '-af', `volume=${plan.gainDb}dB`, '-movflags', '+faststart', temporary])
      await link(temporary, outputFile).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
    } finally { await rm(temporary, { force: true }) }
  }
  const output = await analyze(outputFile)
  if (output.videoFrameCount !== current.source.videoFrameCount
    || output.videoFramesSha256 !== current.source.videoFramesSha256
    || output.videoFrameHashes.some((hash, index) => hash !== current.source.videoFrameHashes[index])) {
    return fail('AUDIO_REMEDIATION_VIDEO_CHANGED', '派生片逐帧画面与原片不一致')
  }
  if (Math.abs(output.duration - current.source.duration) > .08 || output.audio.meanDbfs < LOW_MEAN_DBFS
    || Math.abs(output.audio.integratedLufs - plan.targetLufs) > 2 || output.audio.truePeakDbfs > -1) {
    return fail('AUDIO_REMEDIATION_OUTPUT_INVALID', '派生音轨时长、响度或真实峰值未通过复核')
  }
  if (sha256(await readFile(sourceFile)) !== current.source.sha256) {
    return fail('AUDIO_REMEDIATION_SOURCE_CHANGED', '处理后原片散列变化')
  }
  const manifest = { version: plan.version, sourceUrl: plan.sourceUrl, sourceSha256: current.source.sha256,
    outputUrl: plan.outputUrl, outputSha256: output.sha256, sourceAudio: current.source.audio,
    outputAudio: output.audio, targetLufs: plan.targetLufs, appliedGainDb: plan.gainDb,
    videoCodecHandling: 'stream-copy', audioCodecHandling: 'AAC re-encode',
    videoFrameCount: output.videoFrameCount, sourceVideoFramesSha256: current.source.videoFramesSha256,
    outputVideoFramesSha256: output.videoFramesSha256, everyDecodedVideoFrameMatched: true,
    originalLedgerAndExecutionUnchanged: true, soundContentSemanticReview: 'not-verified' }
  const temporaryManifest = path.join(generated, `.${path.basename(plan.manifestUrl)}.${randomUUID()}.tmp`)
  try {
    const handle = await open(temporaryManifest, 'wx', 0o600)
    try {
      await handle.writeFile(JSON.stringify(manifest, null, 2) + '\n')
      await handle.sync()
    } finally { await handle.close() }
    await link(temporaryManifest, manifestFile).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    })
    let saved: typeof manifest
    try { saved = JSON.parse(await readFile(manifestFile, 'utf8')) as typeof manifest }
    catch { return fail('AUDIO_REMEDIATION_MANIFEST_CONFLICT', '既有处理记录不是完整 JSON') }
    if (JSON.stringify(saved) !== JSON.stringify(manifest)) {
      return fail('AUDIO_REMEDIATION_MANIFEST_CONFLICT', '既有处理记录与当前派生片不一致')
    }
  } finally { await rm(temporaryManifest, { force: true }) }
  return { ...manifest, manifestUrl: plan.manifestUrl }
}
