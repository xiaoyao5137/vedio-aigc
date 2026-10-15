// Prepare a rejected first frame plus a geometry-only guide for a new four-image
// retry. This module only reads supplied bytes and never approves or pays media.
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { createJsonHasher } from './restore-branch-checkpoint.mjs'

const LIMITS = Object.freeze({ count: 5, fileBytes: 5 * 1024 * 1024,
  sourceBytes: 20 * 1024 * 1024, totalBytes: 24 * 1024 * 1024,
  sourcePixels: 16 * 1024 * 1024 })
const CONVERSION = 'png-to-jpeg-q90-444-v1'
const fail = message => { throw Error(`SCENE_CUT_FOUR_REFERENCE_INVALID: ${message}`) }
const value = input => input && typeof input === 'object' && !Array.isArray(input) ? input : {}
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const hashJson = input => sha256(Buffer.from(JSON.stringify(input)))
const hex = (input, length) => typeof input === 'string'
  && new RegExp(`^[a-f0-9]{${length}}$`).test(input)
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)

async function decoded(bytes, format, label, maxBytes = LIMITS.fileBytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > maxBytes) fail(`${label} bytes missing or too large`)
  try {
    const options = { failOn: 'warning', limitInputPixels: LIMITS.sourcePixels }
    const metadata = await sharp(bytes, options).metadata()
    if (metadata.format !== format || !metadata.width || !metadata.height) fail(`${label} is not ${format}`)
    await sharp(bytes, options).raw().toBuffer()
    return { width: metadata.width, height: metadata.height }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('SCENE_CUT_FOUR_REFERENCE_INVALID:')) throw error
    fail(`${label} cannot be fully decoded`)
  }
}

async function jpegReference(pngBytes, label) {
  const dimensions = await decoded(pngBytes, 'png', label, LIMITS.sourceBytes)
  const jpeg = await sharp(pngBytes, { failOn: 'error', limitInputPixels: LIMITS.sourcePixels })
    .jpeg({ quality: 90, chromaSubsampling: '4:4:4' }).toBuffer()
  const converted = await decoded(jpeg, 'jpeg', `${label} JPEG`)
  if (converted.width !== dimensions.width || converted.height !== dimensions.height) {
    fail(`${label} conversion changed dimensions`)
  }
  return { bytes: jpeg, sha256: sha256(jpeg), dimensions }
}

/** Ordered authority: two original v4 identity boards, rejected-frame edit
 * reference, then a non-authoritative geometry guide. */
export async function prepareRejectedSceneCutFourReferences(input) {
  const source = value(input?.source), runs = source.nodeRuns
  const sourceId = input?.expectedSourceId, sourceMd5 = input?.expectedSourceMd5
  const imageSha = input?.expectedImageSha256, reviewSha = input?.expectedReviewSha256
  const guideSha = input?.expectedGuideSha256, guidePath = input?.guidePath
  const prior = source.sceneCutImageRepairRecovery
  if (!Array.isArray(runs) || runs.length !== 464 || source.id !== sourceId
    || !/^record-[\w-]+$/.test(sourceId ?? '') || !hex(sourceMd5, 32)
    || input.sourceResultMd5 !== sourceMd5 || !hex(imageSha, 64) || !hex(reviewSha, 64)
    || !hex(guideSha, 64) || !/^qa\/record-[\w-]+\/[\w.-]+\.png$/.test(guidePath ?? '')
    || source.sceneCutFirstFrameRecovery?.workflowSchemaVersion !== 177
    || prior?.version !== 'scene-cut-image-repair-schema177-fork-v1'
    || !hex(prior.repairPreparationSha256, 64)
    || runs.slice(0, 45).some(run => !['success', 'skipped'].includes(run.status))) {
    fail('source record, prior repair, or pinned digests changed')
  }
  const archive = runs[41], plan = runs[43], image = runs[45], evidence = runs[48]
  const review = runs[49], approval = runs[50], video = runs[52]
  const sources = value(archive?.output), shot = value(runs[44]?.context?.shot_script)
  const openingPlan = value(plan?.output), generated = value(image?.output)
  const inspected = value(evidence?.output), verdict = value(review?.output)
  const bindings = sources.referenceBindings, frozenRefs = sources.imageReferenceImages
  const boards = input?.identityBoardBytes
  if (archive?.node?.id !== 'sanguo-scene-cut-source-archive' || archive.status !== 'success'
    || plan?.node?.id !== 'sanguo-scene-cut-opening-plan' || plan.status !== 'success'
    || image?.node?.id !== 'sanguo-scene-cut-first-frame' || image.status !== 'success'
    || evidence?.node?.id !== 'sanguo-scene-cut-evidence' || evidence.status !== 'success'
    || review?.node?.id !== 'sanguo-scene-cut-review' || review.status !== 'success'
    || approval?.node?.id !== 'sanguo-scene-cut-approval' || approval.status !== 'idle'
    || video?.node?.id !== 'sanguo-video' || video.status !== 'idle'
    || [archive, plan, image, evidence, review].some(run => run.loopIndex !== 0)
    || runs.slice(50).some(run => run.status !== 'idle')
    || sources.identityPlateVersion !== 'scene-cut-identity-plate-v4'
    || !Array.isArray(bindings) || bindings.length !== 2
    || !Array.isArray(frozenRefs) || frozenRefs.length !== 2
    || !Array.isArray(boards) || boards.length !== 2
    || !same(generated.params?.sceneCutShot, shot)
    || !same(generated.params?.sceneCutSources, sources)
    || !same(generated.params?.sceneCutOpeningPlan, openingPlan)
    || !same(generated.params?.referenceImages, frozenRefs)) {
    fail('saved shot, original boards, or rejected review route changed')
  }
  if (verdict.passed !== false || !Array.isArray(verdict.issues) || !verdict.issues.length
    || hashJson(verdict) !== reviewSha || verdict.frame?.sourceUrl !== generated.url
    || verdict.evidenceUrl !== inspected.evidenceUrl
    || inspected.items?.[0]?.url !== generated.url
    || generated.url !== `/generated/image-${imageSha.slice(0, 32)}.png`
    || !Buffer.isBuffer(input?.sourcePngBytes) || sha256(input.sourcePngBytes) !== imageSha
    || !Buffer.isBuffer(input?.guidePngBytes) || sha256(input.guidePngBytes) !== guideSha) {
    fail('failed frame/review or geometry guide differs from pinned bytes')
  }
  const referenceOrder = []
  let totalBytes = 0
  for (const [index, binding] of bindings.entries()) {
    const bytes = boards[index], digest = Buffer.isBuffer(bytes) ? sha256(bytes) : ''
    if (!hex(binding.frontSha256, 64) || digest !== binding.frontSha256
      || !/^\/generated\/[\w.-]+\.jpg$/.test(binding.frontUrl ?? '')
      || frozenRefs[index] !== `data:image/jpeg;base64,${bytes?.toString('base64')}`) {
      fail(`identity board ${index + 1} bytes or order changed`)
    }
    await decoded(bytes, 'jpeg', `identity board ${index + 1}`)
    totalBytes += bytes.length
    referenceOrder.push({ position: index + 1,
      characterName: binding.characterName, frontUrl: binding.frontUrl,
      sha256: digest, bytes: bytes.length })
  }
  const rejected = await jpegReference(input.sourcePngBytes, 'rejected first frame')
  const guide = await jpegReference(input.guidePngBytes, 'geometry guide')
  totalBytes += rejected.bytes.length + guide.bytes.length
  if (referenceOrder.length + 2 > LIMITS.count || totalBytes > LIMITS.totalBytes) {
    fail('four-reference transport exceeds image limits')
  }
  referenceOrder.push({ position: 3, role: 'rejected-edit-source',
    sourceUrl: generated.url, sourceSha256: imageSha,
    jpegSha256: rejected.sha256, bytes: rejected.bytes.length })
  referenceOrder.push({ position: 4, role: 'geometry-guide', purpose: 'geometry-only', referenceOnly: true,
    sourcePath: guidePath, sourceSha256: guideSha,
    jpegSha256: guide.sha256, bytes: guide.bytes.length })
  const receipt = { version: 'scene-cut-rejected-image-edit-reference-v2',
    role: 'reference-only', sourceVerdict: 'rejected', approvedFirstFrame: false,
    requiresFreshIndependentReview: true, requiresPaidGateRevalidation: true,
    sourceExecutionId: sourceId, sourceResultMd5: sourceMd5,
    sourceImageRunId: image.id, sourceImageUrl: generated.url, sourceImageSha256: imageSha,
    failedReviewRunId: review.id, failedReviewOutputSha256: reviewSha,
    failedReviewEvidenceUrl: verdict.evidenceUrl,
    approvedShotSha256: hashJson(shot), sourceArchiveSha256: hashJson(sources),
    openingPlanSha256: hashJson(openingPlan),
    priorRepairPreparationSha256: prior.repairPreparationSha256,
    priorRepairMarkerHash: createJsonHasher()(prior),
    geometryGuide: { role: 'geometry-only', identityAuthority: false,
      sourcePath: guidePath, sourceSha256: guideSha },
    referenceOrder, conversion: { version: CONVERSION, quality: 90,
      chromaSubsampling: '4:4:4', rejectedDimensions: rejected.dimensions,
      guideDimensions: guide.dimensions }, totalReferenceBytes: totalBytes }
  return { referenceImages: [...frozenRefs,
    `data:image/jpeg;base64,${rejected.bytes.toString('base64')}`,
    `data:image/jpeg;base64,${guide.bytes.toString('base64')}`],
  receipt, receiptSha256: hashJson(receipt) }
}
