/** Four source-bound stills for an independent review of the edited A end
 * guide: approved V9 t=0, rejected native A tail, target full, wrist detail. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { A8B6_A_RETAKE_PARENT_PLAN_ID,
  verifyA8B6ARetakeTargetSourceSync } from
  './staged-scene-cut-a8b6-A-retake-target.mjs'
import { verifyA8B6LocalWorkflowApprovalV9Sync } from
  './staged-scene-cut-a8b6-local-approval-v9.mjs'

const fail = reason => { throw Error(`A8B6_A_RETAKE_REVIEW_EVIDENCE_INVALID: ${reason}`) }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const canonical = value => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.entries(value).filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}` : JSON.stringify(value ?? null)
const CROP = Object.freeze({ left: 825, top: 280, width: 200, height: 150 })
const OUTPUT = Object.freeze({ width: 800, height: 600 })
const JPEG_OPTIONS = Object.freeze({ quality: 95,
  chromaSubsampling: '4:4:4', progressive: false, mozjpeg: false })
const receiptPath = root => path.join(root,
  '.runtime/staged-scene-cut-a8b6-A-retake/target-review-evidence.json')
const generated = (root, url) => {
  if (typeof url !== 'string'
    || !/^\/generated\/[\w.-]+\.(?:png|jpg)$/.test(url))
    fail('review image URL invalid')
  return path.join(root, 'public', url.slice(1))
}
const key = root => {
  const bytes = readFileSync(path.join(root, '.runtime/staged-scene-cut.key'))
  if (bytes.length !== 32) fail('signing key invalid')
  return bytes
}
const sign = (body, secret) => createHmac('sha256', secret)
  .update(canonical(body)).digest('hex')

export async function prepareA8B6ARetakeTargetReviewEvidence(
  root = process.cwd()) {
  const source = verifyA8B6ARetakeTargetSourceSync(root)
  const parent = verifyA8B6LocalWorkflowApprovalV9Sync(
    A8B6_A_RETAKE_PARENT_PLAN_ID, root)
  const first = readFileSync(generated(root,
    parent.approval.approvedFirstFrameUrl))
  if (sha(first) !== parent.approval.approvedFirstFrameSha256)
    fail('approved V9 first frame pixels changed')
  const target = readFileSync(generated(root, source.receipt.output.url))
  const crop = await sharp(target).extract(CROP)
    .resize(OUTPUT.width, OUTPUT.height).png().toBuffer()
  const cropUrl = `/generated/a8b6-retake-A-wrist-detail-${sha(crop).slice(0, 20)}.png`
  const sourceImages = [
    { role: 'approved-V9-first-frame',
      sourceUrl: parent.approval.approvedFirstFrameUrl,
      sourceSha256: parent.approval.approvedFirstFrameSha256 },
    { role: 'rejected-A-native-tail-frame192',
      sourceUrl: source.receipt.nativeEditTarget.reviewUrl,
      sourceSha256: source.receipt.nativeEditTarget.sha256 },
    { role: 'edited-target-full',
      sourceUrl: source.receipt.output.url,
      sourceSha256: source.receipt.output.sha256 },
    { role: 'edited-target-wrist-detail', sourceUrl: cropUrl,
      sourceSha256: sha(crop) },
  ]
  const images = [], jpegBuffers = []
  for (const item of sourceImages) {
    const png = item.role === 'edited-target-wrist-detail'
      ? crop : readFileSync(generated(root, item.sourceUrl))
    if (sha(png) !== item.sourceSha256)
      fail(`${item.role} original PNG changed`)
    const jpeg = await sharp(png).jpeg(JPEG_OPTIONS).toBuffer()
    const digest = sha(jpeg)
    images.push({ ...item,
      url: `/generated/a8b6-retake-A-review-${item.role}-${digest.slice(0, 16)}.jpg`,
      sha256: digest, byteLength: jpeg.length })
    jpegBuffers.push(jpeg)
  }
  return { body: { version: 'staged-a8b6-A-retake-target-review-evidence-v1',
    sourceReceiptSha256: source.receiptSha256,
    parentWorkflowApprovalSha256: parent.approvalSha256,
    jpegEncoder: { library: 'sharp', sharpVersion: sharp.versions.sharp,
      quality: 95, chromaSubsampling: '4:4:4', progressive: false },
    imageOrder: images,
    wristDetail: { inputSha256: source.receipt.output.sha256,
      crop: CROP, resize: OUTPUT,
      method: 'sharp.extract(crop).resize(800,600).png()',
      sharpVersion: sharp.versions.sharp,
      outputSha256: sha(crop) },
    scope: 'candidate-target-review-only; no generated A native-tail acceptance' },
  crop, jpegBuffers }
}

export function verifyA8B6ARetakeTargetReviewEvidenceSync(
  root = process.cwd()) {
  const bytes = readFileSync(receiptPath(root))
  const receipt = JSON.parse(bytes.toString('utf8'))
  const { signature, ...body } = receipt
  const expected = sign(body, key(root))
  const source = verifyA8B6ARetakeTargetSourceSync(root)
  const parent = verifyA8B6LocalWorkflowApprovalV9Sync(
    A8B6_A_RETAKE_PARENT_PLAN_ID, root)
  const expectedRoles = ['approved-V9-first-frame',
    'rejected-A-native-tail-frame192', 'edited-target-full',
    'edited-target-wrist-detail']
  if (!/^[a-f0-9]{64}$/.test(String(signature))
    || !timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))
    || receipt.version !== 'staged-a8b6-A-retake-target-review-evidence-v1'
    || receipt.sourceReceiptSha256 !== source.receiptSha256
    || receipt.parentWorkflowApprovalSha256 !== parent.approvalSha256
    || receipt.imageOrder?.length !== 4
    || receipt.imageOrder.some((item, index) => item.role !== expectedRoles[index])
    || receipt.jpegEncoder?.library !== 'sharp'
    || receipt.jpegEncoder?.quality !== 95
    || receipt.jpegEncoder?.chromaSubsampling !== '4:4:4'
    || receipt.jpegEncoder?.progressive !== false
    || receipt.imageOrder[0].sourceUrl !== parent.approval.approvedFirstFrameUrl
    || receipt.imageOrder[0].sourceSha256
      !== parent.approval.approvedFirstFrameSha256
    || receipt.imageOrder[1].sourceUrl
      !== source.receipt.nativeEditTarget.reviewUrl
    || receipt.imageOrder[1].sourceSha256
      !== source.receipt.nativeEditTarget.sha256
    || receipt.imageOrder[2].sourceUrl !== source.receipt.output.url
    || receipt.imageOrder[2].sourceSha256 !== source.receipt.output.sha256
    || canonical(receipt.wristDetail?.crop) !== canonical(CROP)
    || canonical(receipt.wristDetail?.resize) !== canonical(OUTPUT)
    || receipt.wristDetail.inputSha256 !== source.receipt.output.sha256
    || receipt.wristDetail.outputSha256
      !== receipt.imageOrder[3].sourceSha256
    || receipt.scope
      !== 'candidate-target-review-only; no generated A native-tail acceptance')
    fail('signed four-image target review evidence changed')
  for (const image of receipt.imageOrder) {
    if (!/^\/generated\/[\w.-]+\.jpg$/.test(image.url)
      || !/^\/generated\/[\w.-]+\.png$/.test(image.sourceUrl)
      || sha(readFileSync(generated(root, image.sourceUrl)))
        !== image.sourceSha256)
      fail(`${image.role} original PNG changed`)
    if (sha(readFileSync(generated(root, image.url))) !== image.sha256)
      fail(`${image.role} review JPEG changed`)
  }
  return { receipt, evidenceSha256: sha(bytes) }
}

export async function issueA8B6ARetakeTargetReviewEvidence(
  root = process.cwd()) {
  const prepared = await prepareA8B6ARetakeTargetReviewEvidence(root)
  const cropFile = generated(root, prepared.body.imageOrder[3].sourceUrl)
  try { await writeFile(cropFile, prepared.crop, { flag: 'wx' }) }
  catch (error) {
    if (error.code !== 'EEXIST'
      || !(await readFile(cropFile)).equals(prepared.crop))
      fail('existing wrist detail differs')
  }
  for (const [index, item] of prepared.body.imageOrder.entries()) {
    const filename = generated(root, item.url)
    const bytes = prepared.jpegBuffers[index]
    try { await writeFile(filename, bytes, { flag: 'wx' }) }
    catch (error) {
      if (error.code !== 'EEXIST'
        || !(await readFile(filename)).equals(bytes))
        fail(`${item.role} existing JPEG differs`)
    }
  }
  const body = prepared.body
  const receipt = { ...body, signature: sign(body, key(root)) }
  const filename = receiptPath(root)
  await mkdir(path.dirname(filename), { recursive: true })
  const bytes = Buffer.from(JSON.stringify(receipt, null, 2) + '\n')
  try { await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }) }
  catch (error) {
    if (error.code !== 'EEXIST' || !(await readFile(filename)).equals(bytes))
      fail('existing target review evidence differs')
  }
  return verifyA8B6ARetakeTargetReviewEvidenceSync(root)
}
