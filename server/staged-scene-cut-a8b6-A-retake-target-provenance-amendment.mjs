/** Immutable correction to the already signed target-source receipt.
 * The old Chinese prompt field was an operator summary, and the image2pipe
 * extraction field was a later reproduction method, not the original call. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import ffmpeg from 'ffmpeg-static'
import { A8B6_A_RETAKE_PARENT_VIDEO_SHA256,
  A8B6_A_RETAKE_RAW_SHA256, A8B6_A_RETAKE_RESIZED_SHA256,
  A8B6_A_RETAKE_TAIL_SHA256,
  verifyA8B6ARetakeTargetSourceSync } from
  './staged-scene-cut-a8b6-A-retake-target.mjs'
import { verifyA8B6ARetakeTargetReviewSync } from
  './staged-scene-cut-a8b6-A-retake-target-review.mjs'

const fail = reason => { throw Error(`A8B6_A_RETAKE_PROVENANCE_AMENDMENT_INVALID: ${reason}`) }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const canonical = value => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.entries(value).filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}` : JSON.stringify(value ?? null)
const filename = root => path.join(root,
  '.runtime/staged-scene-cut-a8b6-A-retake/target-provenance-amendment.json')
const key = root => {
  const value = readFileSync(path.join(root, '.runtime/staged-scene-cut.key'))
  if (value.length !== 32) fail('signing key invalid')
  return value
}
const sign = (body, secret) => createHmac('sha256', secret)
  .update(canonical(body)).digest('hex')

export const A8B6_A_RETAKE_EXACT_IMAGEGEN_PROMPT = `Use case: precise-object-edit. Asset type: target end-frame guide for an 8-second live-action historical video. Edit the supplied 1280x720 frame. Preserve the exact camera, framing, Jiangzhou ruined street, daylight, background crowd and rubble, all four men's faces, hair, armor, robes, positions and scale. Zhang Fei remains at the far left; two guards are standing back on either side of Yan Yan. Change ONLY Yan Yan's forearms, wrists, hands, and the rope: bring his two wrists together naturally in front of his lower chest/upper abdomen, tightly loop a single coarse hemp rope around BOTH wrists and show one clearly completed, realistic knot facing camera between the wrists. His fingers remain visible below the knot. Remove the existing loops wrapped around his waist and arms and remove dangling loose rope. Guards' hands do not touch him. Keep a photoreal cinematic still, physically plausible anatomy, no speech mouth, no letters, no subtitles, no added people, no scene change. This is a still reference; do not imply approval of motion.`
export const A8B6_A_RETAKE_EXACT_IMAGEGEN_PROMPT_SHA256 =
  sha(A8B6_A_RETAKE_EXACT_IMAGEGEN_PROMPT)
const ACTUAL_EXTRACTION_COMMAND =
  'node_modules/ffmpeg-static/ffmpeg -hide_banner -loglevel error -i qa/staged-scene-cut/v9-phase-A-provider-review.mp4 -vf "select=eq(n\\,192)" -vsync 0 -frames:v 1 qa/staged-scene-cut/v9-phase-A-tail.png -y'

export async function prepareA8B6ARetakeTargetProvenanceAmendment(
  root = process.cwd()) {
  const source = verifyA8B6ARetakeTargetSourceSync(root)
  const review = verifyA8B6ARetakeTargetReviewSync(root)
  const qaVideo = readFileSync(path.join(root,
    'qa/staged-scene-cut/v9-phase-A-provider-review.mp4'))
  const archived = readFileSync(path.join(root, 'public',
    source.receipt.rejectedVideo.url.slice(1)))
  if (sha(qaVideo) !== A8B6_A_RETAKE_PARENT_VIDEO_SHA256
    || !qaVideo.equals(archived))
    fail('QA source video and archived paid A bytes differ')
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'a8b6-A-tail-proof-'))
  let replay
  try {
    const output = path.join(tempDir, 'tail.png')
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error',
      '-i', path.join(root, 'qa/staged-scene-cut/v9-phase-A-provider-review.mp4'),
      '-vf', 'select=eq(n\\,192)', '-vsync', '0', '-frames:v', '1',
      output, '-y'], { maxBuffer: 5_000_000 })
    replay = await readFile(output)
  } finally { await rm(tempDir, { recursive: true, force: true }) }
  if (sha(replay) !== A8B6_A_RETAKE_TAIL_SHA256
    || !replay.equals(readFileSync(path.join(root,
      'qa/staged-scene-cut/v9-phase-A-tail.png'))))
    fail('original file-output extraction does not reproduce actual tail')
  if (review.review.sourceReceiptSha256 !== source.receiptSha256
    || review.review.targetSha256 !== A8B6_A_RETAKE_RESIZED_SHA256
    || source.receipt.imageEdit.rawSha256 !== A8B6_A_RETAKE_RAW_SHA256
    || source.receipt.resize.candidateSha256
      !== A8B6_A_RETAKE_RESIZED_SHA256)
    fail('existing target source or four-JPEG review changed')
  return {
    version: 'staged-a8b6-A-retake-target-provenance-amendment-v1',
    sourceReceiptSha256: source.receiptSha256,
    targetReviewSha256: review.reviewSha256,
    amendmentReason: 'correct prompt and original extraction provenance without altering signed source or visual review',
    priorSourceFieldClarification: {
      imageEditPromptMeaning: 'Chinese operator summary; not the original ImageGen prompt',
      summarizedPromptSha256: source.receipt.imageEdit.promptSha256,
      nativeEditTargetExtractionMeaning: 'later byte-identical image2pipe verification recipe; not the original file-output command',
      originalReceiptPreserved: true },
    imageGen: { exactPrompt: A8B6_A_RETAKE_EXACT_IMAGEGEN_PROMPT,
      exactPromptSha256: A8B6_A_RETAKE_EXACT_IMAGEGEN_PROMPT_SHA256,
      inputNativeTailSha256: A8B6_A_RETAKE_TAIL_SHA256,
      toolOutputRawSha256: A8B6_A_RETAKE_RAW_SHA256,
      resizedCandidateSha256: A8B6_A_RETAKE_RESIZED_SHA256,
      targetReviewSha256: review.reviewSha256 },
    actualNativeTailExtraction: {
      inputPath: 'qa/staged-scene-cut/v9-phase-A-provider-review.mp4',
      inputSha256: A8B6_A_RETAKE_PARENT_VIDEO_SHA256,
      outputPath: 'qa/staged-scene-cut/v9-phase-A-tail.png',
      outputSha256: A8B6_A_RETAKE_TAIL_SHA256,
      command: ACTUAL_EXTRACTION_COMMAND,
      byteIdenticalReplayVerified: true },
    targetRole: 'reviewed-still-guide-only; new provider native A tail remains unaccepted',
  }
}

export function verifyA8B6ARetakeTargetProvenanceAmendmentSync(
  root = process.cwd()) {
  const bytes = readFileSync(filename(root))
  const amendment = JSON.parse(bytes.toString('utf8'))
  const { signature, ...body } = amendment
  const expected = sign(body, key(root))
  const source = verifyA8B6ARetakeTargetSourceSync(root)
  const review = verifyA8B6ARetakeTargetReviewSync(root)
  if (!/^[a-f0-9]{64}$/.test(String(signature))
    || !timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))
    || amendment.version
      !== 'staged-a8b6-A-retake-target-provenance-amendment-v1'
    || amendment.sourceReceiptSha256 !== source.receiptSha256
    || amendment.targetReviewSha256 !== review.reviewSha256
    || amendment.priorSourceFieldClarification?.summarizedPromptSha256
      !== source.receipt.imageEdit.promptSha256
    || amendment.priorSourceFieldClarification.imageEditPromptMeaning
      !== 'Chinese operator summary; not the original ImageGen prompt'
    || amendment.priorSourceFieldClarification.nativeEditTargetExtractionMeaning
      !== 'later byte-identical image2pipe verification recipe; not the original file-output command'
    || amendment.priorSourceFieldClarification.originalReceiptPreserved !== true
    || amendment.imageGen?.exactPrompt !== A8B6_A_RETAKE_EXACT_IMAGEGEN_PROMPT
    || amendment.imageGen.exactPromptSha256
      !== A8B6_A_RETAKE_EXACT_IMAGEGEN_PROMPT_SHA256
    || amendment.imageGen.inputNativeTailSha256 !== A8B6_A_RETAKE_TAIL_SHA256
    || amendment.imageGen.toolOutputRawSha256 !== A8B6_A_RETAKE_RAW_SHA256
    || amendment.imageGen.resizedCandidateSha256
      !== A8B6_A_RETAKE_RESIZED_SHA256
    || amendment.imageGen.targetReviewSha256 !== review.reviewSha256
    || amendment.actualNativeTailExtraction?.inputSha256
      !== A8B6_A_RETAKE_PARENT_VIDEO_SHA256
    || amendment.actualNativeTailExtraction.outputSha256
      !== A8B6_A_RETAKE_TAIL_SHA256
    || amendment.actualNativeTailExtraction.command
      !== ACTUAL_EXTRACTION_COMMAND
    || amendment.actualNativeTailExtraction.byteIdenticalReplayVerified
      !== true
    || amendment.targetRole
      !== 'reviewed-still-guide-only; new provider native A tail remains unaccepted')
    fail('signed exact-prompt provenance amendment changed')
  if (sha(readFileSync(path.join(root,
    amendment.actualNativeTailExtraction.inputPath)))
      !== A8B6_A_RETAKE_PARENT_VIDEO_SHA256
    || sha(readFileSync(path.join(root,
      amendment.actualNativeTailExtraction.outputPath)))
      !== A8B6_A_RETAKE_TAIL_SHA256)
    fail('original extraction source bytes changed')
  return { amendment, amendmentSha256: sha(bytes) }
}

export async function issueA8B6ARetakeTargetProvenanceAmendment(
  root = process.cwd()) {
  const body = await prepareA8B6ARetakeTargetProvenanceAmendment(root)
  const amendment = { ...body, signature: sign(body, key(root)) }
  const file = filename(root)
  await mkdir(path.dirname(file), { recursive: true })
  const bytes = Buffer.from(JSON.stringify(amendment, null, 2) + '\n')
  try { await writeFile(file, bytes, { flag: 'wx', mode: 0o600 }) }
  catch (error) {
    if (error.code !== 'EEXIST' || !(await readFile(file)).equals(bytes))
      fail('existing provenance amendment differs')
  }
  return verifyA8B6ARetakeTargetProvenanceAmendmentSync(root)
}
