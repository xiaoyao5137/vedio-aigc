/** A write-once, source-bound target guide for a B-only retake. The guide
 * instructs generation; acceptance must still use the new B native frames. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import ffmpeg from 'ffmpeg-static'
import { freshA8B6GeneratedFile } from
  './staged-scene-cut-a8b6-fresh-ledger.mjs'
import { extractFreshNativeJpeg } from
  './staged-scene-cut-a8b6-fresh-native.mjs'
import { readFreshA8B6BRetakeParentSigned } from
  './staged-scene-cut-a8b6-B-retake-parent.mjs'

const SHA = /^[a-f0-9]{64}$/
const fail = reason => { throw Error(`A8B6_B_RETAKE_TARGET_INVALID: ${reason}`) }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const canonical = value => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.entries(value).filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}` : JSON.stringify(value ?? null)
const sourceDir = (parentPlanId, root) => path.join(root,
  '.runtime/staged-scene-cut-a8b6-B-retake', parentPlanId)
const sourceFile = (parentPlanId, root) => path.join(
  sourceDir(parentPlanId, root), 'target-source.json')
const reviewFile = (parentPlanId, root) => path.join(
  sourceDir(parentPlanId, root), 'target-review.json')
const qaFile = (root, name) => path.join(root, 'qa/staged-scene-cut', name)
const rawName = 'v9-B-retake-end-guide-raw.png'
const jpegName = 'v9-B-retake-end-guide.jpg'
const promptName = 'v9-B-retake-imagegen-prompt.json'
const reviewName = 'v9-B-retake-target-review.json'

function key(root) {
  const secret = readFileSync(path.join(root, '.runtime/staged-scene-cut.key'))
  if (secret.length !== 32) fail('signing key invalid')
  return secret
}
const sign = (body, secret) => createHmac('sha256', secret)
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
  const value = { ...body, signature: sign(body, key(root)) }
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n')
  await writeOnce(filename, bytes)
  return { value, sha256: sha(bytes) }
}
async function readSigned(filename, root) {
  const bytes = await readFile(filename)
  const value = JSON.parse(bytes.toString('utf8'))
  const { signature, ...body } = value
  if (!SHA.test(String(signature))
    || !timingSafeEqual(Buffer.from(signature, 'hex'),
      Buffer.from(sign(body, key(root)), 'hex')))
    fail('signed guide evidence changed')
  return { value, sha256: sha(bytes) }
}
function localReference(filename, root) {
  const relative = path.relative(root, filename)
  if (relative.startsWith('..') || path.isAbsolute(relative)
    || !/^qa\/staged-scene-cut\/[\w.-]+\.(?:png|jpg)$/.test(relative))
    fail('guide input must be a retained local QA image')
  return relative
}

export async function prepareFreshA8B6BRetakeTargetSource(parentPlanId,
  root = process.cwd()) {
  if (!SHA.test(String(parentPlanId))) fail('parent plan ID invalid')
  const { A, B, BPlan, manifestSha256 } =
    readFreshA8B6BRetakeParentSigned(parentPlanId, root)
  const [promptBytes, raw, jpeg] = await Promise.all([
    readFile(qaFile(root, promptName)), readFile(qaFile(root, rawName)),
    readFile(qaFile(root, jpegName)),
  ])
  const prompt = JSON.parse(promptBytes.toString('utf8'))
  if (typeof prompt.prompt !== 'string' || prompt.prompt.trim().length < 40
    || !Array.isArray(prompt.referenced_image_paths)
    || prompt.referenced_image_paths.length !== 2
    || !Number.isFinite(Date.parse(prompt.generatedAt)))
    fail('actual ImageGen prompt and two source references required')
  const references = await Promise.all(prompt.referenced_image_paths
    .map(async (filename, index) => {
      const absolute = path.resolve(filename)
      const relative = localReference(absolute, root)
      const bytes = await readFile(absolute)
      const metadata = await sharp(bytes).metadata()
      if (!['png', 'jpeg'].includes(metadata.format)
        || metadata.width < 1000 || metadata.height < 500)
        fail('guide reference image invalid')
      const declared = prompt.referenceImages?.[index]
      if (declared?.path !== relative || declared.sha256 !== sha(bytes))
        fail('ImageGen prompt reference metadata differs from actual input')
      return { role: index === 0 ? 'failed-B-native-f144'
        : 'accepted-A-native-tail', path: relative,
        sha256: sha(bytes), width: metadata.width, height: metadata.height }
    }))
  if (references[0].path !== 'qa/staged-scene-cut/v9-B-retake-native-144.jpg'
    || references[1].path
      !== 'qa/staged-scene-cut/v9-A-retake-native-192.png'
    || A.acceptance.acceptedFrameIndex !== 192
    || B.native.lastFrameIndex !== 144
    || BPlan.plan.sourceA.acceptanceSha256 !== A.acceptanceSha256
    || prompt.imageGenRaw?.sha256 !== sha(raw)
    || prompt.finalGuide?.sha256 !== sha(jpeg))
    fail('guide references changed from accepted A and failed B native tails')
  const Afile = freshA8B6GeneratedFile(A.media.videoUrl, 'video', root)
  const Bfile = freshA8B6GeneratedFile(B.media.videoUrl, 'video', root)
  const AoldNativePng = execFileSync(ffmpeg, ['-v', 'error', '-i', Afile,
    '-map', '0:v:0', '-an', '-vf', 'select=eq(n\\,192)',
    '-vsync', 'vfr', '-frames:v', '1', '-f', 'image2pipe',
    '-vcodec', 'png', '-'], { maxBuffer: 20_000_000 })
  const BfailedNativeJpeg = await extractFreshNativeJpeg(Bfile, 144)
  if (sha(AoldNativePng) !== references[1].sha256
    || BfailedNativeJpeg.sha256 !== references[0].sha256)
    fail('ImageGen references are not the exact accepted A/failed B native tails')
  const generated = await sharp(raw).resize(1280, 720, { fit: 'fill' })
    .jpeg({ quality: 92 }).toBuffer()
  const [rawMeta, jpegMeta] = await Promise.all([
    sharp(raw).metadata(), sharp(jpeg).metadata()])
  if (!generated.equals(jpeg) || rawMeta.format !== 'png'
    || jpegMeta.format !== 'jpeg'
    || jpegMeta.width !== 1280 || jpegMeta.height !== 720
    || jpeg.length > 2_000_000)
    fail('guide JPEG differs from reproducible 1280x720 compression')
  const guideUrl = `/generated/a8b6-retake-B-end-guide-${sha(jpeg).slice(0, 20)}.jpg`
  return { version: 'staged-a8b6-B-retake-target-source-v1',
    parentPlanId, parentManifestSha256: manifestSha256,
    acceptedA: { taskId: A.media.taskId,
      videoSha256: A.media.videoSha256,
      mediaSha256: A.mediaSha256,
      acceptanceSha256: A.acceptanceSha256,
      nativeTailFrameIndex: A.acceptance.acceptedFrameIndex,
      nativeTailFrameSha256: A.acceptance.acceptedFrameSha256 },
    failedB: { taskId: B.media.taskId,
      videoSha256: B.media.videoSha256,
      mediaSha256: B.mediaSha256,
      planSha256: BPlan.planSha256,
      nativeTailFrameIndex: B.native.lastFrameIndex },
    imageEdit: { method: 'imagegen-two-reference-edit',
      promptFile: `qa/staged-scene-cut/${promptName}`,
      promptFileSha256: sha(promptBytes), prompt: prompt.prompt,
      promptSha256: sha(prompt.prompt), generatedAt: prompt.generatedAt,
      references, rawPath: `qa/staged-scene-cut/${rawName}`,
      rawSha256: sha(raw), width: rawMeta.width,
      height: rawMeta.height },
    normalization: { method: 'sharp.resize(1280,720,{fit:"fill"}).jpeg({quality:92})',
      sharpVersion: sharp.versions.sharp,
      candidatePath: `qa/staged-scene-cut/${jpegName}`,
      candidateSha256: sha(jpeg), width: 1280, height: 720 },
    output: { url: guideUrl, sha256: sha(jpeg),
      width: 1280, height: 720 },
    role: 'target-guide-only', nativeTailAcceptance: false }
}

export async function issueFreshA8B6BRetakeTargetSource(parentPlanId,
  root = process.cwd()) {
  const body = await prepareFreshA8B6BRetakeTargetSource(parentPlanId, root)
  const jpeg = await readFile(qaFile(root, jpegName))
  await writeOnce(freshA8B6GeneratedFile(body.output.url, 'image', root),
    jpeg)
  await signedOnce(sourceFile(parentPlanId, root), body, root)
  return verifyFreshA8B6BRetakeTargetSource(parentPlanId, root)
}

export async function verifyFreshA8B6BRetakeTargetSource(parentPlanId,
  root = process.cwd()) {
  const { value: receipt, sha256: receiptSha256 } = await readSigned(
    sourceFile(parentPlanId, root), root)
  const expected = await prepareFreshA8B6BRetakeTargetSource(parentPlanId, root)
  if (canonical(receipt) !== canonical({ ...expected,
    signature: receipt.signature })
    || sha(await readFile(freshA8B6GeneratedFile(receipt.output.url,
      'image', root))) !== receipt.output.sha256)
    fail('target guide lost original A/B and reproducible source')
  return { receipt, receiptSha256 }
}

export function assertFreshA8B6BRetakeGuideReview(report, source,
  sourceSha256) {
  const checks = report?.checks
  if (report?.version !== 'staged-a8b6-B-retake-target-review-v1'
    || report.parentPlanId !== source.parentPlanId
    || report.sourceReceiptSha256 !== sourceSha256
    || report.targetSha256 !== source.output.sha256
    || report.reviewer !== 'Codex' || report.verdict !== 'accept'
    || !Number.isFinite(Date.parse(report.reviewedAt))
    || checks?.sameStreetAndFourIdentities !== true
    || checks?.yanFrontWristKnotClearlyVisible !== true
    || checks?.zhangAtStopPosition !== true
    || checks?.guardsWithdrawnToSides !== true
    || checks?.guideIsNotAcceptedNativeTail !== true
    || !Array.isArray(report.observations)
    || report.observations.length < 2
    || report.observations.some(item =>
      typeof item !== 'string' || item.trim().length < 12))
    fail('guide direct review incomplete')
  return true
}

export async function issueFreshA8B6BRetakeTargetReview(parentPlanId,
  root = process.cwd()) {
  const source = await verifyFreshA8B6BRetakeTargetSource(parentPlanId, root)
  const reportBytes = await readFile(qaFile(root, reviewName))
  const report = JSON.parse(reportBytes.toString('utf8'))
  assertFreshA8B6BRetakeGuideReview(report, source.receipt,
    source.receiptSha256)
  await signedOnce(reviewFile(parentPlanId, root), {
    version: 'staged-a8b6-B-retake-target-review-receipt-v1',
    parentPlanId, sourceReceiptSha256: source.receiptSha256,
    targetSha256: source.receipt.output.sha256,
    reportPath: `qa/staged-scene-cut/${reviewName}`,
    reportSha256: sha(reportBytes), verdict: 'accept',
  }, root)
  return verifyFreshA8B6BRetakeTargetReview(parentPlanId, root)
}

export async function verifyFreshA8B6BRetakeTargetReview(parentPlanId,
  root = process.cwd()) {
  const source = await verifyFreshA8B6BRetakeTargetSource(parentPlanId, root)
  const signed = await readSigned(reviewFile(parentPlanId, root), root)
  const reportBytes = await readFile(qaFile(root, reviewName))
  const report = JSON.parse(reportBytes.toString('utf8'))
  assertFreshA8B6BRetakeGuideReview(report, source.receipt,
    source.receiptSha256)
  if (signed.value.version
      !== 'staged-a8b6-B-retake-target-review-receipt-v1'
    || signed.value.parentPlanId !== parentPlanId
    || signed.value.sourceReceiptSha256 !== source.receiptSha256
    || signed.value.targetSha256 !== source.receipt.output.sha256
    || signed.value.reportPath !== `qa/staged-scene-cut/${reviewName}`
    || signed.value.reportSha256 !== sha(reportBytes)
    || signed.value.verdict !== 'accept')
    fail('signed guide review or report changed')
  return { review: signed.value, reviewSha256: signed.sha256 }
}
