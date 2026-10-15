import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { validateStoryVocalBeats, type StoryVocalBeat } from '../src/story-shot-vocals.ts'
import { applyStoryVocalReviewGate, validateStoryShotAssessment } from './story-media-review.ts'

type Value = Record<string, unknown>
const value = (input: unknown): Value => input !== null && typeof input === 'object' && !Array.isArray(input) ? input as Value : {}
const sha = (input: unknown): input is string => typeof input === 'string' && /^[a-f0-9]{64}$/.test(input)
const fail = (message: string): never => { throw Error(`STORY_VOCAL_MANUAL_ACCEPTANCE_INVALID: ${message}`) }

/** Order-independent JSON digest for binding the preserved automated output. */
export function storyVocalJsonSha256(input: unknown): string {
  const seen = new WeakSet<object>()
  const canonical = (item: unknown): string => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item)
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item)
    if (typeof item !== 'object') return fail('source contains a non-JSON value')
    if (seen.has(item)) return fail('source contains a repeated object reference')
    seen.add(item)
    const result = Array.isArray(item) ? `[${item.map(canonical).join(',')}]`
      : `{${Object.keys(item as Value).filter(key => (item as Value)[key] !== undefined).sort()
        .map(key => `${JSON.stringify(key)}:${canonical((item as Value)[key])}`).join(',')}}`
    seen.delete(item)
    return result
  }
  return createHash('sha256').update(canonical(input)).digest('hex')
}

export type StoryVocalHumanAcceptance = {
  version: 'story-vocal-human-acceptance-v1'
  reviewMethod: 'human-listening-and-mouth-sync'
  verdict: 'pass'
  reviewer: string
  reviewedAt: string
  sourceRecordId: string
  sourceResultMd5: string
  sourceRunId: string
  sourceVideoOutputSha256: string
  sourceShotSha256: string
  sourceReviewSha256: string
  sourceVideoSha256: string
  sourceVideoUrl: string
  sourceEvidenceUrl: string
  reviewFile: string
  reviewFileSha256: string
  shot: unknown
  windows: Array<StoryVocalBeat & { audioUrl: string; audioSha256: string;
    heardAsExpected: true; mouthSyncConfirmed: true; observation: string }>
}

/** A separate human judgement can lift only the vocal uncertainty. The
 * original model review, its frame observations and every paid byte stay
 * unchanged. This also replays the visual validator, so an incomplete or
 * uncertain visual beat cannot be approved through the audio path. */
export function requireStoryVocalHumanAcceptance(currentInput: unknown): { sourceSha256: string } {
  const current = value(currentInput), human = value(current.humanVocalAcceptance)
  const originalOutput = { ...current }
  delete originalOutput.humanVocalAcceptance
  const review = value(current.storyMediaReview), evidence = value(review.videoEvidence)
  const savedEvidence = value(current.videoEvidence), vocal = value(review.vocalEvidence)
  const shot = human.shot, planned = value(shot).vocalBeats
  if (human.version !== 'story-vocal-human-acceptance-v1'
    || human.reviewMethod !== 'human-listening-and-mouth-sync' || human.verdict !== 'pass'
    || typeof human.reviewer !== 'string' || human.reviewer.trim().length < 2
    || typeof human.reviewedAt !== 'string' || !Number.isFinite(Date.parse(human.reviewedAt))
    || typeof human.sourceRecordId !== 'string' || !/^record-[\w-]+$/.test(human.sourceRecordId)
    || typeof human.sourceResultMd5 !== 'string' || !/^[a-f0-9]{32}$/.test(human.sourceResultMd5)
    || typeof human.sourceRunId !== 'string' || !human.sourceRunId
    || typeof human.reviewFile !== 'string' || !/^qa\/[\w./-]+\.json$/.test(human.reviewFile)
    || human.reviewFile.includes('..')
    || !sha(human.reviewFileSha256) || !sha(human.sourceShotSha256)
    || !sha(human.sourceVideoOutputSha256) || !sha(human.sourceReviewSha256)
    || !sha(human.sourceVideoSha256)
    || storyVocalJsonSha256(originalOutput) !== human.sourceVideoOutputSha256
    || storyVocalJsonSha256(review) !== human.sourceReviewSha256
    || storyVocalJsonSha256(shot) !== human.sourceShotSha256
    || typeof current.originalUrl !== 'string' || !current.originalUrl.startsWith('https://')
    || review.videoUrl !== current.originalUrl || evidence.originalUrl !== current.originalUrl
    || current.paidSourceUrl !== undefined || current.paidSourceSha256 !== undefined
    || current.audioFoleyRemediation !== undefined || current.audioLevelRemediation !== undefined
    || current.retimedComposite !== undefined || review.audioLevelRemediation !== undefined
    || review.audioFoleyRemediation !== undefined
    || validateStoryVocalBeats(shot, { required: true }).length
    || review.version !== 'story-shot-media-review-v1' || review.reviewStatus !== 'uncertain'
    || review.passed !== false || review.retryable !== false
    || evidence.decoded !== true || savedEvidence.decoded !== true
    || !sha(evidence.sha256) || evidence.sha256 !== human.sourceVideoSha256
    || savedEvidence.sha256 !== evidence.sha256 || current.url !== evidence.url
    || savedEvidence.url !== evidence.url || human.sourceVideoUrl !== evidence.url
    || typeof evidence.url !== 'string' || !/^\/generated\/[\w.-]+\.mp4$/.test(evidence.url)
    || typeof evidence.evidenceUrl !== 'string' || !evidence.evidenceUrl
    || human.sourceEvidenceUrl !== evidence.evidenceUrl
    || savedEvidence.evidenceUrl !== evidence.evidenceUrl
    || vocal.version !== 'story-vocal-evidence-v1' || vocal.sourceVideoSha256 !== evidence.sha256
    || vocal.sourceVideoUrl !== evidence.url || vocal.acousticStatus !== 'signal-present'
    || vocal.semanticStatus !== 'unverified' || vocal.lipSyncStatus !== 'unverified'
    || !Array.isArray(planned) || !Array.isArray(vocal.windows) || !Array.isArray(human.windows)
    || planned.length !== vocal.windows.length || planned.length !== human.windows.length) {
    return fail('human verdict, saved output, shot, video or acoustic source binding differs')
  }
  const visual = validateStoryShotAssessment(shot, evidence as Parameters<typeof validateStoryShotAssessment>[1],
    review.observations, review.assessment)
  const gated = applyStoryVocalReviewGate(visual, vocal as Parameters<typeof applyStoryVocalReviewGate>[1])
  if (!visual.passed || visual.reviewStatus !== 'passed' || visual.issues.length
    || gated.reviewStatus !== review.reviewStatus || gated.passed !== review.passed
    || storyVocalJsonSha256(gated.issues) !== storyVocalJsonSha256(review.issues)
    || storyVocalJsonSha256(visual.beatChecks) !== storyVocalJsonSha256(review.beatChecks)
    || storyVocalJsonSha256(visual.endingHold) !== storyVocalJsonSha256(review.endingHold)) {
    return fail('original visual actions and ending hold did not independently pass')
  }
  for (const [index, plannedBeat] of (planned as StoryVocalBeat[]).entries()) {
    const excerpt = value(vocal.windows[index]), heard = value(human.windows[index])
    for (const key of ['id', 'speaker', 'utterance', 'visualBeatId', 'responseTo'] as const) {
      if (excerpt[key] !== plannedBeat[key] || heard[key] !== plannedBeat[key]) return fail(`vocal window ${index} differs from the reviewed script`)
    }
    const segment = (value(shot).visualBeats as unknown[] | undefined)?.map(value)
      .find(item => item.id === plannedBeat.visualBeatId)
    const startSecond = plannedBeat.startSecond ?? segment?.startSecond
    const endSecond = plannedBeat.endSecond ?? segment?.endSecond
    if (excerpt.startSecond !== startSecond || heard.startSecond !== startSecond
      || excerpt.endSecond !== endSecond || heard.endSecond !== endSecond) {
      return fail(`vocal window ${index} differs from its story segment`)
    }
    if (!sha(excerpt.audioSha256) || excerpt.acousticStatus !== 'signal-present'
      || typeof excerpt.audioUrl !== 'string' || !/^\/generated\/[\w.-]+\.wav$/.test(excerpt.audioUrl)
      || heard.audioSha256 !== excerpt.audioSha256 || heard.audioUrl !== excerpt.audioUrl
      || heard.heardAsExpected !== true || heard.mouthSyncConfirmed !== true
      || typeof heard.observation !== 'string' || heard.observation.trim().length < 12) {
      return fail(`vocal window ${index} lacks exact audio, heard call or mouth-sync evidence`)
    }
  }
  return { sourceSha256: evidence.sha256 as string }
}

/** The review file and archived WAV bytes must still exist at continuation. */
export async function assertStoryVocalHumanAssets(currentInput: unknown, root = process.cwd()): Promise<void> {
  requireStoryVocalHumanAcceptance(currentInput)
  const human = value(value(currentInput).humanVocalAcceptance)
  const qa = await realpath(path.join(root, 'qa'))
  const reportFile = await realpath(path.join(root, human.reviewFile as string))
  if (!reportFile.startsWith(qa + path.sep) || !(await stat(reportFile)).isFile()) fail('human review report path changed')
  const reportBytes = await readFile(reportFile)
  if (createHash('sha256').update(reportBytes).digest('hex') !== human.reviewFileSha256) fail('human review report changed or disappeared')
  let report: Value
  try { report = value(JSON.parse(reportBytes.toString('utf8'))) }
  catch { return fail('human review report is not JSON') }
  for (const key of ['version', 'reviewMethod', 'verdict', 'reviewer', 'reviewedAt',
    'sourceRecordId', 'sourceResultMd5', 'sourceRunId', 'sourceVideoOutputSha256',
    'sourceShotSha256', 'sourceReviewSha256', 'sourceVideoSha256', 'sourceVideoUrl']) {
    if (report[key] !== human[key]) fail(`human review report field ${key} differs from its saved certificate`)
  }
  if (!Array.isArray(report.windows) || report.windows.length !== (human.windows as unknown[]).length) {
    fail('human review report has different vocal windows')
  }
  for (const [index, raw] of (report.windows as unknown[]).entries()) {
    const saved = value((human.windows as unknown[])[index]), reviewed = value(raw)
    for (const key of ['id', 'speaker', 'utterance', 'startSecond', 'endSecond', 'audioUrl',
      'audioSha256', 'heardAsExpected', 'mouthSyncConfirmed', 'observation']) {
      if (reviewed[key] !== saved[key]) fail(`human review window ${index} field ${key} changed`)
    }
  }
  const generated = await realpath(path.join(root, 'public/generated'))
  for (const window of human.windows as Array<{ audioUrl: string; audioSha256: string }>) {
    const name = path.basename(window.audioUrl)
    const file = await realpath(path.join(generated, name))
    if (!file.startsWith(generated + path.sep) || !(await stat(file)).isFile()
      || createHash('sha256').update(await readFile(file)).digest('hex') !== window.audioSha256) {
      fail('listened WAV bytes changed or disappeared')
    }
  }
}
