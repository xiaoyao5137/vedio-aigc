import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { link, readFile, realpath, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import ffmpeg from 'ffmpeg-static'
import type { StoryVocalBeat } from '../src/story-shot-vocals.ts'

const exec = promisify(execFile)
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')

type Source = { url: string; sha256: string; duration: number }

export type StoryVocalEvidence = {
  version: 'story-vocal-evidence-v1'
  sourceVideoUrl: string
  sourceVideoSha256: string
  acousticStatus: 'signal-present' | 'silent-window'
  semanticStatus: 'unverified'
  lipSyncStatus: 'unverified'
  windows: Array<StoryVocalBeat & { audioUrl: string; audioSha256: string;
    meanVolumeDb: number | null; maxVolumeDb: number | null; acousticStatus: 'signal-present' | 'silent-window' }>
}

/** Isolate each scheduled call from the same immutable paid take. Acoustic
 * energy can reject a silent slot, but cannot establish that its sound is a
 * cat or dog, that it says the intended call, or that its mouth is in sync. */
export async function collectStoryVocalEvidence(source: Source, vocalBeats: StoryVocalBeat[], root = process.cwd(),
  visualBeats: Array<{ id: string; startSecond: number; endSecond: number }> = []): Promise<StoryVocalEvidence> {
  if (!ffmpeg) throw Error('STORY_VOCAL_EVIDENCE_UNAVAILABLE: ffmpeg 缺失')
  if (!/^\/generated\/[A-Za-z0-9._-]+\.mp4$/.test(source.url) || !/^[a-f0-9]{64}$/.test(source.sha256)
    || !Number.isFinite(source.duration) || source.duration <= 0 || !vocalBeats.length) {
    throw Error('STORY_VOCAL_EVIDENCE_INVALID: 来源视频或叫声计划无效')
  }
  const generated = await realpath(path.join(root, 'public/generated'))
  const sourceFile = await realpath(path.join(generated, path.basename(source.url)))
  if (!sourceFile.startsWith(generated + path.sep) || !(await stat(sourceFile)).isFile()
    || sha256(await readFile(sourceFile)) !== source.sha256) {
    throw Error('STORY_VOCAL_EVIDENCE_SOURCE_CHANGED: 保存的视频与审定散列不一致')
  }
  const windows: StoryVocalEvidence['windows'] = []
  for (const beat of vocalBeats) {
    const segment = visualBeats.find(item => item.id === beat.visualBeatId)
    const startSecond = beat.startSecond ?? segment?.startSecond
    const endSecond = beat.endSecond ?? segment?.endSecond
    if (startSecond === undefined || endSecond === undefined
      || !Number.isFinite(startSecond) || !Number.isFinite(endSecond)
      || startSecond < 0 || endSecond <= startSecond || endSecond > source.duration + .5) {
      throw Error('STORY_VOCAL_EVIDENCE_INVALID: 叫声时间窗超出已保存视频')
    }
    const key = sha256(JSON.stringify({ version: 1, sourceSha256: source.sha256,
      id: beat.id, startSecond, endSecond })).slice(0, 20)
    const filename = `story-vocal-${key}.wav`
    const target = path.join(generated, filename)
    const temporary = path.join(generated, `.story-vocal-${key}-${randomUUID()}.tmp.wav`)
    let expectedAudioSha256: string
    try {
      await exec(ffmpeg, ['-hide_banner', '-v', 'error', '-xerror', '-n', '-i', sourceFile,
        '-ss', String(startSecond), '-t', String(endSecond - startSecond),
        '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', temporary],
      { timeout: 30_000 })
      expectedAudioSha256 = sha256(await readFile(temporary))
      await link(temporary, target).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
    } finally { await rm(temporary, { force: true }) }
    const bytes = await readFile(target)
    if (bytes.length < 44 || sha256(bytes) !== expectedAudioSha256) {
      throw Error('STORY_VOCAL_EVIDENCE_ARCHIVE_CONFLICT: 同源叫声片段与已保存文件不一致')
    }
    const { stderr } = await exec(ffmpeg, ['-hide_banner', '-i', target, '-af', 'volumedetect', '-f', 'null', '-'], { timeout: 30_000 })
    const measuredMean = Number(stderr.match(/mean_volume:\s*(-?[\d.]+) dB/)?.[1] ?? '-Infinity')
    const measuredMax = Number(stderr.match(/max_volume:\s*(-?[\d.]+) dB/)?.[1] ?? '-Infinity')
    const meanVolumeDb = Number.isFinite(measuredMean) ? measuredMean : null
    const maxVolumeDb = Number.isFinite(measuredMax) ? measuredMax : null
    const acousticStatus = (meanVolumeDb !== null && meanVolumeDb > -60)
      || (maxVolumeDb !== null && maxVolumeDb > -45) ? 'signal-present' : 'silent-window'
    windows.push({ ...beat, startSecond, endSecond, audioUrl: `/generated/${filename}`, audioSha256: sha256(bytes),
      meanVolumeDb, maxVolumeDb, acousticStatus })
  }
  return { version: 'story-vocal-evidence-v1', sourceVideoUrl: source.url,
    sourceVideoSha256: source.sha256,
    acousticStatus: windows.every(window => window.acousticStatus === 'signal-present') ? 'signal-present' : 'silent-window',
    semanticStatus: 'unverified', lipSyncStatus: 'unverified', windows }
}
