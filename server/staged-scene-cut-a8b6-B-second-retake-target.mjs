/** A new, write-once end guide after the first B-only child was rejected.
 * Guide pixels remain source evidence, never acceptance of native video. */
import { execFileSync } from 'node:child_process'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import ffmpeg from 'ffmpeg-static'
import sharp from 'sharp'
import { freshA8B6GeneratedFile } from
  './staged-scene-cut-a8b6-fresh-ledger.mjs'
import { verifyFreshA8B6PhaseBRejection } from
  './staged-scene-cut-a8b6-fresh-B-rejection.mjs'
import { readFreshA8B6BRetakeParentSigned } from
  './staged-scene-cut-a8b6-B-retake-parent.mjs'
import { verifyFreshA8B6BRetakeTargetSource } from
  './staged-scene-cut-a8b6-B-retake-target.mjs'

const VERSION = 'staged-a8b6-B-second-retake-target-source-v1'
const REVIEW_VERSION = 'staged-a8b6-B-second-retake-target-review-v1'
const SHA = /^[a-f0-9]{64}$/
const fail = reason => { throw Error(`A8B6_B_SECOND_RETAKE_TARGET_INVALID: ${reason}`) }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const canonical = value => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.entries(value).filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}` : JSON.stringify(value ?? null)
const sourceDir = (previousChildPlanId, root) => path.join(root,
  '.runtime/staged-scene-cut-a8b6-B-retake', previousChildPlanId)
const sourceFile = (previousChildPlanId, root) => path.join(
  sourceDir(previousChildPlanId, root), 'target-source.json')
const reviewFile = (previousChildPlanId, root) => path.join(
  sourceDir(previousChildPlanId, root), 'target-review.json')
const qaFile = (root, name) => path.join(root, 'qa/staged-scene-cut', name)
const provenanceName = 'v9-B-second-retake-imagegen-prompt.json'
const reviewName = 'v9-B-second-retake-target-review.json'

function signingKey(root) {
  const key = readFileSync(path.join(root, '.runtime/staged-scene-cut.key'))
  if (key.length !== 32) fail('staging signing key invalid')
  return key
}
const signature = (body, key) => createHmac('sha256', key)
  .update(canonical(body)).digest('hex')
async function writeOnce(filename, bytes) {
  await mkdir(path.dirname(filename), { recursive: true })
  try { await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }) }
  catch (error) {
    if (error.code !== 'EEXIST' || !(await readFile(filename)).equals(bytes))
      fail(`existing artifact differs: ${filename}`)
  }
}
async function signedOnce(filename, body, root) {
  const value = { ...body, signature: signature(body, signingKey(root)) }
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n')
  await writeOnce(filename, bytes)
  return { value, sha256: sha(bytes) }
}
async function readSigned(filename, root) {
  const bytes = await readFile(filename)
  const value = JSON.parse(bytes.toString('utf8'))
  const { signature: actual, ...body } = value
  const expected = signature(body, signingKey(root))
  if (!SHA.test(String(actual))
    || !timingSafeEqual(Buffer.from(actual, 'hex'),
      Buffer.from(expected, 'hex')))
    fail('signed second guide evidence changed')
  return { value, sha256: sha(bytes) }
}
function localImage(name) {
  if (!/^qa\/staged-scene-cut\/[\w.-]+\.(?:jpg|png)$/.test(name))
    fail('ImageGen source must be a retained local QA image')
  return name
}

export async function prepareFreshA8B6BSecondRetakeTargetSource(
  previousChildPlanId, root = process.cwd()) {
  if (!SHA.test(String(previousChildPlanId)))
    fail('previous B-only child plan ID invalid')
  const rejected = await verifyFreshA8B6PhaseBRejection(
    previousChildPlanId, root)
  if (rejected.rejection.version
      !== 'staged-a8b6-fresh-native-B-rejection-v2'
    || rejected.rejection.failedChecks
      ?.guardsContinueWithdrawalWithoutRegrab !== false
    || rejected.rejection.checks
      ?.frontWristKnotRemainsVisibleThroughout !== true
    || rejected.rejection.nextPaidPhaseBlocked !== true)
    fail('previous child was not rejected for guard regrab')
  const parentPlanId = rejected.rejection.parentPlanId
  const parent = readFreshA8B6BRetakeParentSigned(parentPlanId, root)
  const firstTarget = await verifyFreshA8B6BRetakeTargetSource(
    parentPlanId, root)
  if (rejected.rejection.sourceA?.acceptanceSha256
      !== parent.A.acceptanceSha256
    || rejected.rejection.sourceA?.frameSha256
      !== parent.A.acceptance.acceptedFrameSha256)
    fail('previous child changed accepted A source')
  const provenanceBytes = await readFile(qaFile(root, provenanceName))
  let provenance
  try { provenance = JSON.parse(provenanceBytes.toString('utf8')) }
  catch { fail('second guide provenance JSON malformed') }
  if (provenance.version
      !== 'staged-a8b6-B-second-retake-imagegen-provenance-v1'
    || typeof provenance.prompt !== 'string'
    || provenance.prompt.trim().length < 100
    || !Number.isFinite(Date.parse(provenance.generatedAt))
    || !Array.isArray(provenance.references)
    || provenance.references.length !== 2
    || provenance.references[0]?.path
      !== 'qa/staged-scene-cut/v9-B-retake-end-guide.jpg'
    || provenance.references[0]?.sha256
      !== firstTarget.receipt.output.sha256
    || provenance.references[1]?.path
      !== 'qa/staged-scene-cut/v9-A-retake-native-192.png'
    || !SHA.test(String(provenance.references[1]?.sha256))
    || provenance.raw?.path
      !== 'qa/staged-scene-cut/v9-B-second-retake-end-guide-raw.png'
    || provenance.output?.path
      !== 'qa/staged-scene-cut/v9-B-second-retake-end-guide.jpg'
    || !SHA.test(String(provenance.raw?.sha256))
    || !SHA.test(String(provenance.output?.sha256)))
    fail('second guide ImageGen lineage or prompt changed')
  const [referenceGuide, referenceA, raw, jpeg] = await Promise.all([
    readFile(path.join(root, localImage(provenance.references[0].path))),
    readFile(path.join(root, localImage(provenance.references[1].path))),
    readFile(path.join(root, localImage(provenance.raw.path))),
    readFile(path.join(root, localImage(provenance.output.path))),
  ])
  const Afile = freshA8B6GeneratedFile(parent.A.media.videoUrl,
    'video', root)
  const actualAPng = execFileSync(ffmpeg, ['-v', 'error', '-i', Afile,
    '-map', '0:v:0', '-an', '-vf', 'select=eq(n\\,192)',
    '-vsync', 'vfr', '-frames:v', '1', '-f', 'image2pipe',
    '-vcodec', 'png', '-'], { maxBuffer: 20_000_000 })
  const normalized = await sharp(raw)
    .resize(1280, 720, { fit: 'fill' })
    .jpeg({ quality: 92 }).toBuffer()
  const metadata = await sharp(jpeg).metadata()
  const outputUrl = `/generated/a8b6-second-retake-B-end-guide-${sha(jpeg).slice(0, 20)}.jpg`
  if (sha(referenceGuide) !== provenance.references[0].sha256
    || sha(referenceA) !== provenance.references[1].sha256
    || !actualAPng.equals(referenceA)
    || sha(raw) !== provenance.raw.sha256
    || raw.length !== provenance.raw.bytes
    || !normalized.equals(jpeg)
    || sha(jpeg) !== provenance.output.sha256
    || jpeg.length !== provenance.output.bytes
    || metadata.format !== 'jpeg' || metadata.width !== 1280
    || metadata.height !== 720
    || provenance.output.width !== metadata.width
    || provenance.output.height !== metadata.height
    || provenance.output.url !== outputUrl
    || jpeg.length > 2_000_000)
    fail('second guide bytes or 1280x720 normalization changed')
  return { version: VERSION,
    parentPlanId, previousChildPlanId,
    parentAAcceptanceSha256: parent.A.acceptanceSha256,
    previousChildRejectionSha256: rejected.rejectionSha256,
    previousChildManifestSha256: rejected.rejection.manifestSha256,
    previousChildMediaSha256: rejected.rejection.mediaSha256,
    previousChildVideoSha256: rejected.rejection.videoSha256,
    firstTargetSourceSha256: firstTarget.receiptSha256,
    imageEdit: { method: 'imagegen-two-reference-edit',
      provenanceFile: `qa/staged-scene-cut/${provenanceName}`,
      provenanceSha256: sha(provenanceBytes),
      prompt: provenance.prompt,
      promptSha256: sha(provenance.prompt),
      generatedAt: provenance.generatedAt,
      references: provenance.references,
      rawPath: provenance.raw.path,
      rawSha256: provenance.raw.sha256 },
    normalization: { method: 'sharp.resize(1280,720,{fit:"fill"}).jpeg({quality:92})',
      sharpVersion: sharp.versions.sharp,
      candidatePath: provenance.output.path,
      candidateSha256: provenance.output.sha256,
      width: 1280, height: 720 },
    output: { url: outputUrl, sha256: sha(jpeg),
      width: 1280, height: 720 },
    role: 'target-guide-only', nativeTailAcceptance: false }
}

export async function issueFreshA8B6BSecondRetakeTargetSource(
  previousChildPlanId, root = process.cwd()) {
  const body = await prepareFreshA8B6BSecondRetakeTargetSource(
    previousChildPlanId, root)
  await writeOnce(freshA8B6GeneratedFile(body.output.url,
    'image', root), await readFile(qaFile(root,
    'v9-B-second-retake-end-guide.jpg')))
  await signedOnce(sourceFile(previousChildPlanId, root), body, root)
  return verifyFreshA8B6BSecondRetakeTargetSource(previousChildPlanId,
    root)
}

export async function verifyFreshA8B6BSecondRetakeTargetSource(
  previousChildPlanId, root = process.cwd()) {
  const signed = await readSigned(sourceFile(previousChildPlanId, root), root)
  const expected = await prepareFreshA8B6BSecondRetakeTargetSource(
    previousChildPlanId, root)
  const bytes = await readFile(freshA8B6GeneratedFile(
    signed.value.output.url, 'image', root))
  if (canonical(signed.value) !== canonical({ ...expected,
    signature: signed.value.signature })
    || sha(bytes) !== expected.output.sha256)
    fail('second guide lost rejected B and accepted A source')
  return { receipt: signed.value, receiptSha256: signed.sha256 }
}

export function assertFreshA8B6BSecondRetakeGuideReview(report,
  source, sourceSha256) {
  const checks = report?.checks
  if (report?.version !== REVIEW_VERSION
    || report.parentPlanId !== source.parentPlanId
    || report.previousChildPlanId !== source.previousChildPlanId
    || report.sourceReceiptSha256 !== sourceSha256
    || report.previousChildRejectionSha256
      !== source.previousChildRejectionSha256
    || report.targetSha256 !== source.output.sha256
    || report.reviewer !== 'Codex' || report.verdict !== 'accept'
    || !Number.isFinite(Date.parse(report.reviewedAt))
    || checks?.sameStreetAndFourIdentities !== true
    || checks?.yanFrontWristKnotClearlyVisible !== true
    || checks?.zhangAtStopPosition !== true
    || checks?.bothGuardsFarAwayHandsDown !== true
    || checks?.guideIsNotAcceptedNativeTail !== true
    || !Array.isArray(report.observations)
    || report.observations.length < 2
    || report.observations.some(item =>
      typeof item !== 'string' || item.trim().length < 12))
    fail('second guide direct visual review incomplete')
  return true
}

export async function issueFreshA8B6BSecondRetakeTargetReview(
  previousChildPlanId, root = process.cwd()) {
  const source = await verifyFreshA8B6BSecondRetakeTargetSource(
    previousChildPlanId, root)
  const reportBytes = await readFile(qaFile(root, reviewName))
  const report = JSON.parse(reportBytes.toString('utf8'))
  assertFreshA8B6BSecondRetakeGuideReview(report,
    source.receipt, source.receiptSha256)
  await signedOnce(reviewFile(previousChildPlanId, root), {
    version: 'staged-a8b6-B-second-retake-target-review-receipt-v1',
    parentPlanId: source.receipt.parentPlanId,
    previousChildPlanId,
    previousChildRejectionSha256:
      source.receipt.previousChildRejectionSha256,
    sourceReceiptSha256: source.receiptSha256,
    targetSha256: source.receipt.output.sha256,
    reportPath: `qa/staged-scene-cut/${reviewName}`,
    reportSha256: sha(reportBytes), verdict: 'accept' }, root)
  return verifyFreshA8B6BSecondRetakeTargetReview(previousChildPlanId,
    root)
}

export async function verifyFreshA8B6BSecondRetakeTargetReview(
  previousChildPlanId, root = process.cwd()) {
  const source = await verifyFreshA8B6BSecondRetakeTargetSource(
    previousChildPlanId, root)
  const signed = await readSigned(reviewFile(previousChildPlanId, root), root)
  const reportBytes = await readFile(qaFile(root, reviewName))
  const report = JSON.parse(reportBytes.toString('utf8'))
  assertFreshA8B6BSecondRetakeGuideReview(report,
    source.receipt, source.receiptSha256)
  if (signed.value.version
      !== 'staged-a8b6-B-second-retake-target-review-receipt-v1'
    || signed.value.parentPlanId !== source.receipt.parentPlanId
    || signed.value.previousChildPlanId !== previousChildPlanId
    || signed.value.previousChildRejectionSha256
      !== source.receipt.previousChildRejectionSha256
    || signed.value.sourceReceiptSha256 !== source.receiptSha256
    || signed.value.targetSha256 !== source.receipt.output.sha256
    || signed.value.reportPath
      !== `qa/staged-scene-cut/${reviewName}`
    || signed.value.reportSha256 !== sha(reportBytes)
    || signed.value.verdict !== 'accept')
    fail('second guide signed review or report changed')
  return { review: signed.value, reviewSha256: signed.sha256 }
}
