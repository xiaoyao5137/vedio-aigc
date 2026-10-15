import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { loadReviewImages, REVIEW_IMAGE_LIMITS, REVIEW_SEQUENCE_LIMITS, type LoadedReviewImage } from './review-images.ts'

function invalid(message: string): never {
  throw new Error(`CODEX_REFERENCE_IMAGES_INVALID: ${message}`)
}

/** Uploaded reference pictures are separate from the local-only reviewImages contract. */
export async function loadCodexReferenceImages(value: unknown, preceding: readonly LoadedReviewImage[] = []): Promise<LoadedReviewImage[]> {
  if (value === undefined) return []
  const sources = Array.isArray(value) ? value : [value]
  if (sources.length + preceding.length > REVIEW_IMAGE_LIMITS.count) invalid(`图片附件超过 ${REVIEW_IMAGE_LIMITS.count} 张上限`)
  let totalBytes = preceding.reduce((total, frame) => total + frame.bytes.length, 0)
  const frames: LoadedReviewImage[] = []
  const maxBase64Length = Math.ceil(REVIEW_IMAGE_LIMITS.fileBytes / 3) * 4

  for (const [index, source] of sources.entries()) {
    const url = typeof source === 'string' ? source
      : source && typeof source === 'object' && !Array.isArray(source) ? (source as { url?: unknown }).url : undefined
    if (typeof url !== 'string' || !/^data:image\/jpeg;base64,/i.test(url)) {
      invalid(`第 ${index + 1} 张参考图只接受 data:image/jpeg;base64 URL 或含 url 的对象`)
    }
    const base64 = url.slice(url.indexOf(',') + 1)
    if (!base64 || base64.length > maxBase64Length || base64.length % 4 !== 0
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) invalid(`第 ${index + 1} 张参考图 Base64 非法或超过单图 5MiB 上限`)
    const bytes = Buffer.from(base64, 'base64')
    if (!bytes.length || bytes.length > REVIEW_IMAGE_LIMITS.fileBytes || bytes.toString('base64') !== base64) {
      invalid(`第 ${index + 1} 张参考图 Base64 非法或超过单图 5MiB 上限`)
    }
    totalBytes += bytes.length
    if (totalBytes > REVIEW_IMAGE_LIMITS.totalBytes) invalid(`图片附件合计超过 ${REVIEW_IMAGE_LIMITS.totalBytes / 1024 / 1024}MiB 上限`)
    try {
      const options = { failOn: 'warning' as const, limitInputPixels: REVIEW_SEQUENCE_LIMITS.sourcePixels }
      const metadata = await sharp(bytes, options).metadata()
      if (metadata.format !== 'jpeg') invalid(`第 ${index + 1} 张参考图实际内容不是 JPEG`)
      await sharp(bytes, options).resize(1, 1).raw().toBuffer()
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('CODEX_REFERENCE_IMAGES_INVALID:')) throw error
      invalid(`第 ${index + 1} 张参考图无法完整解码为 JPEG，或像素超过安全上限`)
    }
    const digest = createHash('sha256').update(bytes).digest('hex')
    frames.push({ url: `upload-reference:${index + 1}:${digest}`, bytes, mimeType: 'image/jpeg',
      kind: 'original', frameIndex: preceding.length + index, label: `上传参考图 ${index + 1}` })
  }
  return frames
}

/** The same immutable snapshots are fingerprinted and sent to Codex. */
export async function loadCodexTextFrames(params: Record<string, unknown>, root = process.cwd()): Promise<LoadedReviewImage[]> {
  const reviewFrames = await loadReviewImages(params.reviewImages, root, params.reviewImageDetail)
  const uploadedFrames = await loadCodexReferenceImages(params.referenceImages, reviewFrames)
  return [...reviewFrames, ...uploadedFrames]
}
