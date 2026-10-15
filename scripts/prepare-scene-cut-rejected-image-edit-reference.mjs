// Preparation only. No workflow runtime imports this module and it never
// approves a rejected image or writes a media/database artifact.
import { createHash } from 'node:crypto'
import sharp from 'sharp'

const LIMITS = Object.freeze({ count: 5, fileBytes: 5 * 1024 * 1024,
  sourceBytes: 20 * 1024 * 1024, totalBytes: 24 * 1024 * 1024,
  sourcePixels: 16 * 1024 * 1024 })
const EDIT_CONVERSION = 'rejected-png-to-jpeg-q90-444-v1'
const fail = message => { throw Error(`SCENE_CUT_EDIT_REFERENCE_INVALID: ${message}`) }
const value = input => input && typeof input === 'object' && !Array.isArray(input) ? input : {}
const hashBytes = bytes => createHash('sha256').update(bytes).digest('hex')
const hashJson = input => hashBytes(Buffer.from(JSON.stringify(input)))
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)
const hex = (input, length) => typeof input === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(input)

async function decoded(bytes, format, label, maxBytes = LIMITS.fileBytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > maxBytes) {
    fail(`${label} bytes missing or over ${maxBytes / 1024 / 1024} MiB`)
  }
  try {
    const options = { failOn: 'warning', limitInputPixels: LIMITS.sourcePixels }
    const metadata = await sharp(bytes, options).metadata()
    if (metadata.format !== format || !metadata.width || !metadata.height) fail(`${label} is not ${format}`)
    await sharp(bytes, options).raw().toBuffer()
    return { width: metadata.width, height: metadata.height }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('SCENE_CUT_EDIT_REFERENCE_INVALID:')) throw error
    fail(`${label} cannot be fully decoded`)
  }
}

/**
 * Build exactly three Codex JPEG references: the two frozen identity boards,
 * then a previously rejected PNG converted to a traceable JPEG. The caller
 * must supply the pinned DB MD5 and bytes read from the archived local files.
 * This is not an image approval and does not produce a candidate first frame.
 */
export async function prepareRejectedSceneCutEditReference(input) {
  const source = value(input?.source), runs = source.nodeRuns
  const sourceId = input?.expectedSourceId, sourceMd5 = input?.expectedSourceMd5
  const imageSha = input?.expectedImageSha256, reviewSha = input?.expectedReviewSha256
  if (!Array.isArray(runs) || !/^record-[\w-]+$/.test(sourceId ?? '')
    || source.id !== sourceId || !hex(sourceMd5, 32)
    || input?.sourceResultMd5 !== sourceMd5 || !hex(imageSha, 64) || !hex(reviewSha, 64)
    || source.sceneCutFirstFrameRecovery?.workflowSchemaVersion !== 176) {
    fail('source record identity, schema or pinned hashes do not match')
  }
  const archive = runs[41], plan = runs[43], image = runs[45], evidence = runs[48]
  const review = runs[49], approval = runs[50], video = runs[52]
  if (archive?.node?.id !== 'sanguo-scene-cut-source-archive' || archive.status !== 'success'
    || plan?.node?.id !== 'sanguo-scene-cut-opening-plan' || plan.status !== 'success'
    || image?.node?.id !== 'sanguo-scene-cut-first-frame' || image.status !== 'success'
    || evidence?.node?.id !== 'sanguo-scene-cut-evidence' || evidence.status !== 'success'
    || review?.node?.id !== 'sanguo-scene-cut-review' || review.status !== 'success'
    || approval?.node?.id !== 'sanguo-scene-cut-approval' || approval.status !== 'idle'
    || video?.node?.id !== 'sanguo-video' || video.status !== 'idle'
    || [archive, plan, image, evidence, review].some(run => run.loopIndex !== 0)) {
    fail('failed first image was already advanced or its run sequence changed')
  }
  const sources = value(archive.output), shot = value(runs[44]?.context?.shot_script)
  const openingPlan = value(plan.output), generated = value(image.output)
  const inspected = value(evidence.output), verdict = value(review.output)
  const bindings = sources.referenceBindings, frozenRefs = sources.imageReferenceImages
  const boardBytes = input?.identityBoardBytes
  if (sources.identityPlateVersion !== 'scene-cut-identity-plate-v4'
    || !Array.isArray(bindings) || bindings.length !== 2
    || !Array.isArray(frozenRefs) || frozenRefs.length !== 2
    || !Array.isArray(boardBytes) || boardBytes.length !== 2
    || generated.params?.sceneCutShot?.id !== shot.id
    || !same(generated.params?.sceneCutShot, shot)
    || !same(generated.params?.sceneCutSources, sources)
    || !same(generated.params?.sceneCutOpeningPlan, openingPlan)
    || !same(generated.params?.referenceImages, frozenRefs)) {
    fail('approved shot, opening plan or ordered v4 identity boards changed')
  }
  if (verdict.passed !== false || !Array.isArray(verdict.issues) || verdict.issues.length < 1
    || hashJson(verdict) !== reviewSha || verdict.frame?.sourceUrl !== generated.url
    || verdict.evidenceUrl !== inspected.evidenceUrl
    || inspected.items?.[0]?.url !== generated.url
    || !/^\/generated\/image-([a-f0-9]{32})\.png$/.test(generated.url ?? '')) {
    fail('source is not the independently rejected and evidenced PNG')
  }
  const sourcePngBytes = input?.sourcePngBytes
  const sourceHash = Buffer.isBuffer(sourcePngBytes) ? hashBytes(sourcePngBytes) : ''
  if (sourceHash !== imageSha || generated.url !== `/generated/image-${imageSha.slice(0, 32)}.png`) {
    fail('rejected PNG bytes differ from the frozen source')
  }
  const dimensions = await decoded(sourcePngBytes, 'png', 'rejected source', LIMITS.sourceBytes)
  const identityBoards = []
  let totalBytes = 0
  for (const [index, binding] of bindings.entries()) {
    const bytes = boardBytes[index], digest = Buffer.isBuffer(bytes) ? hashBytes(bytes) : ''
    if (!hex(binding.frontSha256, 64) || digest !== binding.frontSha256
      || !/^\/generated\/[\w.-]+\.jpg$/.test(binding.frontUrl ?? '')
      || frozenRefs[index] !== `data:image/jpeg;base64,${bytes?.toString('base64')}`) {
      fail(`identity board ${index + 1} bytes or order changed`)
    }
    await decoded(bytes, 'jpeg', `identity board ${index + 1}`)
    totalBytes += bytes.length
    identityBoards.push({ position: index + 1, characterName: binding.characterName,
      frontUrl: binding.frontUrl, sha256: digest, bytes: bytes.length })
  }
  const jpeg = await sharp(sourcePngBytes, { failOn: 'error', limitInputPixels: LIMITS.sourcePixels })
    .jpeg({ quality: 90, chromaSubsampling: '4:4:4' }).toBuffer()
  const jpegDimensions = await decoded(jpeg, 'jpeg', 'edit reference')
  if (jpegDimensions.width !== dimensions.width || jpegDimensions.height !== dimensions.height) {
    fail('JPEG conversion changed the rejected image dimensions')
  }
  totalBytes += jpeg.length
  if (identityBoards.length + 1 > LIMITS.count || totalBytes > LIMITS.totalBytes) {
    fail('three-reference transport exceeds Codex image limits')
  }
  const editSha = hashBytes(jpeg)
  const receipt = {
    version: 'scene-cut-rejected-image-edit-reference-v1', role: 'reference-only',
    sourceVerdict: 'rejected', approvedFirstFrame: false,
    requiresFreshIndependentReview: true, requiresPaidGateRevalidation: true,
    sourceExecutionId: sourceId, sourceResultMd5: sourceMd5,
    sourceImageRunId: image.id, sourceImageUrl: generated.url, sourceImageSha256: imageSha,
    failedReviewRunId: review.id, failedReviewOutputSha256: reviewSha,
    failedReviewEvidenceUrl: verdict.evidenceUrl,
    approvedShotSha256: hashJson(shot), sourceArchiveSha256: hashJson(sources),
    openingPlanSha256: hashJson(openingPlan),
    referenceOrder: [...identityBoards, { position: 3, role: 'rejected-edit-source',
      sourceUrl: generated.url, sourceSha256: imageSha, jpegSha256: editSha, bytes: jpeg.length }],
    conversion: { version: EDIT_CONVERSION, quality: 90, chromaSubsampling: '4:4:4',
      width: dimensions.width, height: dimensions.height }, totalReferenceBytes: totalBytes,
  }
  return { referenceImages: [...frozenRefs, `data:image/jpeg;base64,${jpeg.toString('base64')}`],
    receipt, receiptSha256: hashJson(receipt) }
}
