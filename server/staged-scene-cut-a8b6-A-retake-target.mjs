/** Source-bound target end guide for the rejected V9 A take. A guide is an
 * instruction to the generator, never an accepted native tail. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import ffmpeg from 'ffmpeg-static'
import sharp from 'sharp'

const fail = reason => { throw Error(`A8B6_A_RETAKE_TARGET_INVALID: ${reason}`) }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const canonical = value => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.entries(value).filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}` : JSON.stringify(value ?? null)
const sourceDirectory = '.runtime/staged-scene-cut-a8b6-A-retake'
const sourceFile = 'target-source.json'
export const A8B6_A_RETAKE_PARENT_PLAN_ID =
  '2022b73d1894b904985c72e6ab2cfe18584d0f8f6e154ff0175658429ff67660'
export const A8B6_A_RETAKE_PARENT_TASK_ID = '934036356547235843'
export const A8B6_A_RETAKE_PARENT_VIDEO_SHA256 =
  'd6c216f055c94f2897d84cf207242db0bcbbfd0313972c4b22767904d59f8f13'
export const A8B6_A_RETAKE_TAIL_SHA256 =
  'e85f329f17d62e39beb0341fabd7d50b896bf5a5891042b655d879e5f1b1d44b'
export const A8B6_A_RETAKE_RAW_SHA256 =
  'd74f40384d94ee133973a72cb79c3779bdbefdd7280dc33236cec5d36124db95'
export const A8B6_A_RETAKE_RESIZED_SHA256 =
  '4678b1e0a28ca4d4eae82715242d723b2a39a04b5a78e0ad2d2218651bfb7867'
export const A8B6_A_RETAKE_TARGET_URL =
  `/generated/a8b6-retake-A-end-guide-${A8B6_A_RETAKE_RESIZED_SHA256.slice(0, 20)}.png`
export const A8B6_A_RETAKE_NATIVE_TAIL_URL =
  `/generated/a8b6-retake-A-rejected-tail-${A8B6_A_RETAKE_TAIL_SHA256.slice(0, 20)}.png`

export const A8B6_A_RETAKE_IMAGE_EDIT_PROMPT =
  '以 qa/staged-scene-cut/v9-phase-A-tail.png 作为唯一 edit target，保留机位/街景/四人脸甲袍与位置；仅改严颜前臂、双腕、手及绳：腹前双腕自然并拢、单根麻绳同时绕两腕、镜头可见两腕之间完成结，手指露出；去除腰/臂绳圈与垂绳；守卫手离严颜，张飞留左；真实摄影无口型/字幕。'

const paths = root => ({
  video: path.join(root, 'public/generated',
    `fresh-a8b6-${A8B6_A_RETAKE_PARENT_PLAN_ID.slice(0, 16)}-A-${A8B6_A_RETAKE_PARENT_TASK_ID}.mp4`),
  tail: path.join(root, 'qa/staged-scene-cut/v9-phase-A-tail.png'),
  raw: path.join(root, 'qa/staged-scene-cut/v9-A-retake-end-guide-raw.png'),
  resized: path.join(root, 'qa/staged-scene-cut/v9-A-retake-end-guide-resized.png'),
  selected: path.join(root, 'public', A8B6_A_RETAKE_TARGET_URL.slice(1)),
  tailReview: path.join(root, 'public', A8B6_A_RETAKE_NATIVE_TAIL_URL.slice(1)),
  receipt: path.join(root, sourceDirectory, sourceFile),
})
const readExact = (filename, expected, label) => {
  const bytes = readFileSync(filename)
  if (sha(bytes) !== expected) fail(`${label} SHA256 changed`)
  return bytes
}
const key = root => {
  const bytes = readFileSync(path.join(root, '.runtime/staged-scene-cut.key'))
  if (bytes.length !== 32) fail('signing key invalid')
  return bytes
}
const sign = (body, secret) => createHmac('sha256', secret)
  .update(canonical(body)).digest('hex')

export async function prepareA8B6ARetakeTargetSource(root = process.cwd()) {
  const p = paths(root)
  const video = readExact(p.video, A8B6_A_RETAKE_PARENT_VIDEO_SHA256,
    'rejected A video')
  const tail = readExact(p.tail, A8B6_A_RETAKE_TAIL_SHA256,
    'rejected A native tail')
  const nativeTail = execFileSync(ffmpeg, ['-v', 'error', '-i', p.video,
    '-map', '0:v:0', '-an', '-vf', 'select=eq(n\\,192)', '-vsync', 'vfr',
    '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-'],
  { maxBuffer: 20_000_000 })
  if (!nativeTail.equals(tail)) fail('edit target is not actual rejected A frame 192')
  const raw = readExact(p.raw, A8B6_A_RETAKE_RAW_SHA256, 'image edit raw output')
  const resized = readExact(p.resized, A8B6_A_RETAKE_RESIZED_SHA256,
    'resized guide')
  const regenerated = await sharp(raw).resize(1280, 720, { fit: 'fill' })
    .png().toBuffer()
  if (!regenerated.equals(resized)) fail('Sharp resize is not byte reproducible')
  const [tailMeta, rawMeta, resizedMeta] = await Promise.all([
    sharp(tail).metadata(), sharp(raw).metadata(), sharp(resized).metadata()])
  if (tailMeta.format !== 'png' || tailMeta.width !== 1280
    || tailMeta.height !== 720 || rawMeta.format !== 'png'
    || rawMeta.width !== 1672 || rawMeta.height !== 941
    || resizedMeta.format !== 'png' || resizedMeta.width !== 1280
    || resizedMeta.height !== 720) fail('target source dimensions changed')
  return { version: 'staged-a8b6-A-retake-target-source-v1',
    parentPlanId: A8B6_A_RETAKE_PARENT_PLAN_ID,
    parentTaskId: A8B6_A_RETAKE_PARENT_TASK_ID,
    rejectedVideo: { url: `/generated/fresh-a8b6-${A8B6_A_RETAKE_PARENT_PLAN_ID.slice(0, 16)}-A-${A8B6_A_RETAKE_PARENT_TASK_ID}.mp4`,
      sha256: sha(video) },
    nativeEditTarget: { path: 'qa/staged-scene-cut/v9-phase-A-tail.png',
      reviewUrl: A8B6_A_RETAKE_NATIVE_TAIL_URL,
      frameIndex: 192, sha256: sha(tail), width: 1280, height: 720,
      extraction: 'ffmpeg select=eq(n\\,192) PNG image2pipe' },
    imageEdit: { method: 'imagegen-single-target-edit',
      prompt: A8B6_A_RETAKE_IMAGE_EDIT_PROMPT,
      promptSha256: sha(A8B6_A_RETAKE_IMAGE_EDIT_PROMPT),
      rawPath: 'qa/staged-scene-cut/v9-A-retake-end-guide-raw.png',
      rawSha256: sha(raw), width: 1672, height: 941 },
    resize: { method: 'sharp.resize(1280,720,{fit:"fill"}).png()',
      sharpVersion: sharp.versions.sharp,
      sourceSha256: sha(raw),
      candidatePath: 'qa/staged-scene-cut/v9-A-retake-end-guide-resized.png',
      candidateSha256: sha(resized), width: 1280, height: 720 },
    output: { url: A8B6_A_RETAKE_TARGET_URL,
      sha256: sha(resized), width: 1280, height: 720 },
    role: 'unreviewed-target-end-guide-only',
    nativeTailAcceptance: false }
}

export function verifyA8B6ARetakeTargetSourceSync(root = process.cwd()) {
  const p = paths(root)
  const bytes = readFileSync(p.receipt)
  const receipt = JSON.parse(bytes.toString('utf8'))
  const { signature, ...body } = receipt
  const expected = sign(body, key(root))
  if (!/^[a-f0-9]{64}$/.test(String(signature))
    || !timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))
    || receipt.version !== 'staged-a8b6-A-retake-target-source-v1'
    || receipt.parentPlanId !== A8B6_A_RETAKE_PARENT_PLAN_ID
    || receipt.parentTaskId !== A8B6_A_RETAKE_PARENT_TASK_ID
    || receipt.rejectedVideo?.sha256 !== A8B6_A_RETAKE_PARENT_VIDEO_SHA256
    || receipt.nativeEditTarget?.sha256 !== A8B6_A_RETAKE_TAIL_SHA256
    || receipt.nativeEditTarget.reviewUrl !== A8B6_A_RETAKE_NATIVE_TAIL_URL
    || receipt.imageEdit?.rawSha256 !== A8B6_A_RETAKE_RAW_SHA256
    || receipt.imageEdit.prompt !== A8B6_A_RETAKE_IMAGE_EDIT_PROMPT
    || receipt.imageEdit.promptSha256 !== sha(A8B6_A_RETAKE_IMAGE_EDIT_PROMPT)
    || receipt.resize?.sourceSha256 !== A8B6_A_RETAKE_RAW_SHA256
    || receipt.resize?.candidateSha256 !== A8B6_A_RETAKE_RESIZED_SHA256
    || receipt.output?.url !== A8B6_A_RETAKE_TARGET_URL
    || receipt.output.sha256 !== A8B6_A_RETAKE_RESIZED_SHA256
    || receipt.nativeTailAcceptance !== false
    || receipt.role !== 'unreviewed-target-end-guide-only')
    fail('signed target source changed')
  readExact(p.video, A8B6_A_RETAKE_PARENT_VIDEO_SHA256, 'old A video')
  readExact(p.tail, A8B6_A_RETAKE_TAIL_SHA256, 'old A tail')
  readExact(p.tailReview, A8B6_A_RETAKE_TAIL_SHA256, 'old A review frame')
  readExact(p.raw, A8B6_A_RETAKE_RAW_SHA256, 'raw image edit')
  readExact(p.resized, A8B6_A_RETAKE_RESIZED_SHA256, 'resized image edit')
  readExact(p.selected, A8B6_A_RETAKE_RESIZED_SHA256, 'selected target')
  return { receipt, receiptSha256: sha(bytes) }
}

export async function issueA8B6ARetakeTargetSource(root = process.cwd()) {
  const body = await prepareA8B6ARetakeTargetSource(root)
  const p = paths(root)
  const selected = await readFile(p.resized)
  const reviewTail = await readFile(p.tail)
  try { await writeFile(p.tailReview, reviewTail, { flag: 'wx' }) }
  catch (error) {
    if (error.code !== 'EEXIST' || !(await readFile(p.tailReview)).equals(reviewTail))
      fail('content-addressed rejected tail file differs')
  }
  try { await writeFile(p.selected, selected, { flag: 'wx' }) }
  catch (error) {
    if (error.code !== 'EEXIST' || !(await readFile(p.selected)).equals(selected))
      fail('content-addressed target file differs')
  }
  await mkdir(path.dirname(p.receipt), { recursive: true })
  const receipt = { ...body, signature: sign(body, key(root)) }
  const bytes = Buffer.from(JSON.stringify(receipt, null, 2) + '\n')
  try { await writeFile(p.receipt, bytes, { flag: 'wx', mode: 0o600 }) }
  catch (error) {
    if (error.code !== 'EEXIST' || !(await readFile(p.receipt)).equals(bytes))
      fail('existing target source receipt differs')
  }
  return verifyA8B6ARetakeTargetSourceSync(root)
}
