import { createHash } from 'node:crypto'
import { open, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

/** Local request protections, not a statement of any model provider's limits. */
export const REVIEW_IMAGE_LIMITS = { count: 64, fileBytes: 5 * 1024 * 1024, totalBytes: 24 * 1024 * 1024 } as const

export const REVIEW_SEQUENCE_LIMITS = { sourceCount: 256, sourcePixels: 16 * 1024 * 1024, pagePixels: 32 * 1024 * 1024, totalPixels: 256 * 1024 * 1024 } as const
type CropDetail = { indices: number[]; columns: number; rows: number; overlap: number }
export type ReviewFrameMetadata = { evidenceIndex?: number; nativeFrameIndex?: number; url?: string; time?: number; pts?: number; timeBase?: string }
export type SequenceGridTransport = { mode: 'sequence-grid'; columns: 2; rows: 2; format?: 'png' | 'jpeg'; quality?: number; chromaSubsampling?: '4:4:4' }
type SequenceGridDetail = { transport: SequenceGridTransport; frameMetadata?: ReviewFrameMetadata[]; indices?: never; columns?: never; rows?: never; overlap?: never }
export type ReviewImageDetail = CropDetail | SequenceGridDetail
export type ReviewImageRect = { left: number; top: number; width: number; height: number }
export type ReviewSequenceCell = ReviewFrameMetadata & { evidenceIndex: number; url: string; sourceSha256: string; sourceRect: ReviewImageRect; targetRect: ReviewImageRect }
export type LoadedReviewImage = {
  url: string; bytes: Buffer
  label?: string; frameIndex?: number; sourceRect?: ReviewImageRect
  detailConfig?: ReviewImageDetail; kind?: 'original' | 'detail' | 'sequence-grid'
  mimeType?: 'image/jpeg' | 'image/png'; attachmentIndex?: number; cells?: ReviewSequenceCell[]
  encoding?: { format: 'png' | 'jpeg'; lossless: boolean; reencoded: true; noResize: true; quality?: number; chromaSubsampling?: '4:4:4' }
}

function invalid(message: string): never {
  throw new Error(`REVIEW_IMAGES_INVALID: ${message}`)
}

function detailConfig(value: unknown, frameCount: number): ReviewImageDetail | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('reviewImageDetail 必须是局部附件配置对象')
  const config = value as Record<string, unknown>
  if (Object.hasOwn(config, 'transport')) {
    if (['indices', 'columns', 'rows', 'overlap'].some(key => Object.hasOwn(config, key))) invalid('reviewImageDetail 的 sequence-grid 传输与局部裁剪配置互斥')
    if (Object.keys(config).some(key => !['transport', 'frameMetadata'].includes(key))) invalid('reviewImageDetail sequence-grid 包含未知配置字段')
    const transport = config.transport as Record<string, unknown>
    if (!transport || typeof transport !== 'object' || Array.isArray(transport) || transport.mode !== 'sequence-grid' || transport.columns !== 2 || transport.rows !== 2
      || Object.keys(transport).some(key => !['mode', 'columns', 'rows', 'format', 'quality', 'chromaSubsampling'].includes(key))) invalid('reviewImageDetail.transport 必须显式设置 sequence-grid 与 2×2 网格')
    const format = transport.format ?? 'png'
    if (!['png', 'jpeg'].includes(String(format))) invalid('reviewImageDetail.transport.format 必须为 png 或 jpeg')
    if (format === 'jpeg' && (!Number.isInteger(transport.quality) || Number(transport.quality) < 1 || Number(transport.quality) > 100 || transport.chromaSubsampling !== '4:4:4')) invalid('reviewImageDetail JPEG 传输须显式设置 quality 整数1–100及 chromaSubsampling=4:4:4')
    if (format === 'png' && (Object.hasOwn(transport, 'quality') || Object.hasOwn(transport, 'chromaSubsampling'))) invalid('reviewImageDetail PNG 传输不能设置 JPEG 质量选项')
    if (!frameCount) invalid('reviewImageDetail sequence-grid 至少需要一张原帧')
    if (frameCount > REVIEW_SEQUENCE_LIMITS.sourceCount || Math.ceil(frameCount / 4) > REVIEW_IMAGE_LIMITS.count) invalid(`sequence-grid 原帧共 ${frameCount} 张，超过源帧上限256或最终附件上限64；未提交任何截断审查`)
    const metadata = config.frameMetadata
    if (metadata !== undefined && (!Array.isArray(metadata) || metadata.length !== frameCount)) invalid('reviewImageDetail.frameMetadata 须与原帧数组等长')
    const seen = new Set<number>()
    const frameMetadata = (Array.isArray(metadata) ? metadata : Array.from({ length: frameCount }, () => ({}))).map((value, index) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('reviewImageDetail.frameMetadata 每项必须为元数据对象')
      const row = value as Record<string, unknown>
      if (Object.keys(row).some(key => !['evidenceIndex', 'nativeFrameIndex', 'url', 'time', 'pts', 'timeBase'].includes(key))) invalid('reviewImageDetail.frameMetadata 含未知字段，不能隐式丢弃采证映射')
      for (const key of ['evidenceIndex', 'nativeFrameIndex']) if (row[key] !== undefined && (!Number.isSafeInteger(row[key]) || Number(row[key]) < 0)) invalid('reviewImageDetail.frameMetadata.' + key + ' 须为非负安全整数')
      if (row.time !== undefined && (typeof row.time !== 'number' || !Number.isFinite(row.time) || row.time < 0)) invalid('reviewImageDetail.frameMetadata.time 须为非负有限秒数')
      if (row.pts !== undefined && !Number.isSafeInteger(row.pts)) invalid('reviewImageDetail.frameMetadata.pts 须为安全整数')
      if (row.timeBase !== undefined && (typeof row.timeBase !== 'string' || !/^[1-9]\d*\/[1-9]\d*$/.test(row.timeBase))) invalid('reviewImageDetail.frameMetadata.timeBase 须为正有理数文本')
      if (row.url !== undefined && typeof row.url !== 'string') invalid('reviewImageDetail.frameMetadata.url 须为对应原帧URL')
      const evidenceIndex = row.evidenceIndex === undefined ? index : Number(row.evidenceIndex)
      if (seen.has(evidenceIndex)) invalid('reviewImageDetail.frameMetadata.evidenceIndex 不能重复')
      seen.add(evidenceIndex)
      return { ...row, evidenceIndex } as ReviewFrameMetadata
    })
    return { transport: { mode: 'sequence-grid', columns: 2, rows: 2, format: format as 'png' | 'jpeg', ...(format === 'jpeg' ? { quality: Number(transport.quality), chromaSubsampling: '4:4:4' as const } : {}) }, frameMetadata }
  }
  if (Object.hasOwn(config, 'frameMetadata')) invalid('reviewImageDetail.frameMetadata 仅适用于显式 sequence-grid 传输')
  if (!Array.isArray(config.indices) || !config.indices.length || config.indices.some(index => !Number.isInteger(index) || index < 0 || index >= frameCount)
    || new Set(config.indices).size !== config.indices.length) invalid('reviewImageDetail.indices 必须是不重复且位于原帧数组范围内的整数编号')
  if (![config.columns, config.rows].every(count => typeof count === 'number' && Number.isInteger(count) && count >= 1 && count <= REVIEW_IMAGE_LIMITS.count)) invalid('reviewImageDetail.columns/rows 必须是 1–64 的整数')
  if (typeof config.overlap !== 'number' || !Number.isFinite(config.overlap) || config.overlap < 0 || config.overlap >= 1) invalid('reviewImageDetail.overlap 必须大于等于 0 且小于 1')
  const result = { indices: [...config.indices] as number[], columns: config.columns as number, rows: config.rows as number, overlap: config.overlap }
  const count = frameCount + result.indices.length * result.columns * result.rows
  if (count > REVIEW_IMAGE_LIMITS.count) invalid(`原帧及局部附件共 ${count} 张，超过本地请求上限 64 张；未提交任何截断审查`)
  return result
}

/** Adjacent tiles overlap by this fraction of a tile; integer rounding keeps
 * every crop inside the source and both outer edges covered. No resampling. */
function detailRects(width: number, height: number, config: CropDetail): ReviewImageRect[] {
  if (config.columns > width || config.rows > height) invalid('reviewImageDetail 网格数不能超过原图对应方向的像素数')
  const tileWidth = Math.ceil(width / (config.columns - (config.columns - 1) * config.overlap))
  const tileHeight = Math.ceil(height / (config.rows - (config.rows - 1) * config.overlap))
  return Array.from({ length: config.rows * config.columns }, (_, index) => ({
    left: config.columns === 1 ? 0 : Math.round((index % config.columns) * (width - tileWidth) / (config.columns - 1)),
    top: config.rows === 1 ? 0 : Math.round(Math.floor(index / config.columns) * (height - tileHeight) / (config.rows - 1)),
    width: tileWidth, height: tileHeight,
  }))
}

function imageLabel(kind: 'original' | 'detail', frameIndex: number, url: string, rect: ReviewImageRect): string {
  return `${kind === 'original' ? '原始完整帧' : '原像素局部图'} frameIndex=${frameIndex}；source=${url}；源像素矩形 left=${rect.left}, top=${rect.top}, width=${rect.width}, height=${rect.height}（原图左上角为原点）。${kind === 'detail' ? '仅从该原帧裁剪，未放大、未补画或生成细节；请结合完整原帧判断空间归属。' : '保留完整原始画面。'}`
}

/** Load one immutable request snapshot; the same bytes must be hashed and sent. */
export async function loadReviewImages(value: unknown, root = process.cwd(), detail?: unknown): Promise<LoadedReviewImage[]> {
  if (value === undefined) {
    detailConfig(detail, 0)
    return []
  }
  if (!Array.isArray(value)) invalid('reviewImages 必须是本地 JPEG 帧地址数组')
  const config = detailConfig(detail, value.length)
  const sequence = config && 'transport' in config ? config : undefined
  if (!sequence && value.length > REVIEW_IMAGE_LIMITS.count) invalid(`审查帧共 ${value.length} 张，超过本地请求上限 64 张；未提交任何截断审查`)
  if (!value.length) return []
  for (const url of value) {
    if (typeof url !== 'string' || !/^\/generated\/[\w.-]+\.jpg$/.test(url)) invalid('审查只接受 /generated/ 下的本地 JPEG 帧')
  }
  const urls = [...value] as string[]
  if (sequence?.frameMetadata?.some((metadata, index) => metadata.url !== undefined && metadata.url !== urls[index])) invalid('reviewImageDetail.frameMetadata.url 与对应原帧URL不一致')
  const generatedRoot = await realpath(path.join(root, 'public', 'generated'))
  const sources: Array<{ url: string; filename: string }> = []
  let declaredTotal = 0
  for (const url of urls) {
    const filename = await realpath(path.join(generatedRoot, path.basename(url)))
    if (path.dirname(filename) !== generatedRoot) invalid(`审查帧 ${url} 指向本地 generated 目录之外`)
    const info = await stat(filename)
    if (!info.isFile()) invalid(`审查帧 ${url} 不是文件`)
    if (info.size > REVIEW_IMAGE_LIMITS.fileBytes) invalid(`审查帧 ${url} 超过本地单帧上限 5MiB`)
    declaredTotal += info.size
    if (declaredTotal > REVIEW_IMAGE_LIMITS.totalBytes) invalid('审查帧合计超过本地请求上限 24MiB；未提交任何截断审查')
    sources.push({ url, filename })
  }

  const frames: LoadedReviewImage[] = []
  const dimensions: Array<{ width: number; height: number }> = []
  let actualTotal = 0
  let decodedPixels = 0
  for (const { url, filename } of sources) {
    // Bound the actual read as well as stat: a growing file cannot bypass the limit.
    const handle = await open(filename, 'r')
    const chunks: Buffer[] = []
    let length = 0
    try {
      for await (const chunk of handle.createReadStream()) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        length += bytes.length
        actualTotal += bytes.length
        if (length > REVIEW_IMAGE_LIMITS.fileBytes) invalid(`审查帧 ${url} 超过本地单帧上限 5MiB`)
        if (actualTotal > REVIEW_IMAGE_LIMITS.totalBytes) invalid('审查帧合计超过本地请求上限 24MiB；未提交任何截断审查')
        chunks.push(bytes)
      }
    } finally {
      await handle.close()
    }
    const bytes = Buffer.concat(chunks, length)
    try {
      const metadata = await sharp(bytes, { failOn: 'warning' }).metadata()
      if (metadata.format !== 'jpeg') invalid(`审查帧 ${url} 的实际内容不是 JPEG`)
      if (sequence) {
        const pixels = Number(metadata.width) * Number(metadata.height)
        decodedPixels += pixels
        if (!Number.isSafeInteger(pixels) || pixels <= 0 || pixels > REVIEW_SEQUENCE_LIMITS.sourcePixels || decodedPixels > REVIEW_SEQUENCE_LIMITS.totalPixels) invalid('sequence-grid 原帧解码像素超过单帧16Mi/合计256Mi像素安全上限；未提交任何截断审查')
      }
      // metadata alone accepts some truncated JPEGs; force pixel decoding too.
      await sharp(bytes, { failOn: 'warning' }).resize(1, 1).raw().toBuffer()
      if (config) {
        if (!metadata.width || !metadata.height) invalid(`审查帧 ${url} 缺少原始像素尺寸`)
        dimensions.push({ width: metadata.width, height: metadata.height })
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('REVIEW_IMAGES_INVALID:')) throw error
      invalid(`审查帧 ${url} 无法完整解码为 JPEG`)
    }
    frames.push({ url, bytes })
  }
  if (sequence) {
    const result: LoadedReviewImage[] = []
    let transmittedBytes = 0
    for (let start = 0; start < frames.length; start += 4) {
      const group = frames.slice(start, start + 4), sizes = dimensions.slice(start, start + 4)
      const tileWidth = Math.max(...sizes.map(size => size.width)), tileHeight = Math.max(...sizes.map(size => size.height))
      const width = tileWidth * 2, height = tileHeight * 2
      if (!Number.isSafeInteger(width * height) || width * height > REVIEW_SEQUENCE_LIMITS.pagePixels) invalid('sequence-grid 单附件画布超过32Mi像素安全上限；不会缩放原图')
      const cells: ReviewSequenceCell[] = group.map((frame, index) => ({
        ...sequence.frameMetadata![start + index], evidenceIndex: sequence.frameMetadata![start + index].evidenceIndex!, url: frame.url,
        sourceSha256: createHash('sha256').update(frame.bytes).digest('hex'),
        sourceRect: { left: 0, top: 0, ...sizes[index] },
        targetRect: { left: index % 2 * tileWidth, top: Math.floor(index / 2) * tileHeight, ...sizes[index] },
      }))
      // Each page is constructed from immutable JPEG snapshots at native size.
      // Explicit JPEG transport re-encodes; it must never be called lossless.
      const pipeline = sharp({ create: { width, height, channels: 3, background: '#000000' } }).composite(group.map((frame, index) => ({ input: frame.bytes, left: cells[index].targetRect.left, top: cells[index].targetRect.top })))
      const jpeg = sequence.transport.format === 'jpeg'
      const bytes = await (jpeg ? pipeline.jpeg({ quality: sequence.transport.quality!, chromaSubsampling: '4:4:4' }) : pipeline.png({ compressionLevel: 9, palette: false })).toBuffer()
      if (bytes.length > REVIEW_IMAGE_LIMITS.fileBytes) invalid('sequence-grid 实际附件超过本地单图上限 5MiB；不会自动降低质量或缩放')
      transmittedBytes += bytes.length
      if (transmittedBytes > REVIEW_IMAGE_LIMITS.totalBytes) invalid('sequence-grid 实际附件合计超过本地请求上限 24MiB；不会自动降低质量、缩放或截断')
      const attachmentIndex = result.length
      const encoding: NonNullable<LoadedReviewImage['encoding']> = { format: jpeg ? 'jpeg' : 'png', lossless: !jpeg, reencoded: true, noResize: true,
        ...(jpeg ? { quality: sequence.transport.quality, chromaSubsampling: '4:4:4' as const } : {}) }
      result.push({ url: 'sequence-grid:attachment-' + attachmentIndex, bytes, mimeType: jpeg ? 'image/jpeg' : 'image/png', kind: 'sequence-grid', attachmentIndex,
        cells, encoding, detailConfig: sequence,
        label: `时序拼图 attachmentIndex=${attachmentIndex}；2×2按从左至右、从上至下排列原帧，未缩放。${jpeg ? `显式JPEG质量${encoding.quality}、4:4:4再次编码，有损传输。` : 'PNG无损保留JPEG解码后的像素。'}每格只对应cells中的原帧；空白余区不是证据帧；拼图整体不对应单个frameIndex。cells=${JSON.stringify(cells)}` })
    }
    return result
  }
  if (config && !('transport' in config)) {
    // Retain all original bytes first. Detail attachments never replace or
    // renumber originals, including when only a later frame is selected.
    frames.forEach((frame, frameIndex) => {
      const sourceRect = { left: 0, top: 0, ...dimensions[frameIndex] }
      Object.assign(frame, { kind: 'original', frameIndex, sourceRect, detailConfig: config, label: imageLabel('original', frameIndex, frame.url, sourceRect) })
    })
    const crops = config.indices.flatMap(frameIndex => detailRects(dimensions[frameIndex].width, dimensions[frameIndex].height, config).map(sourceRect => ({ frameIndex, sourceRect })))
    for (const { frameIndex, sourceRect } of crops) {
      const source = frames[frameIndex]
      const bytes = await sharp(source.bytes, { failOn: 'warning' }).extract(sourceRect).jpeg({ quality: 90 }).toBuffer()
      if (bytes.length > REVIEW_IMAGE_LIMITS.fileBytes) invalid(`审查帧 ${source.url} 的局部附件超过本地单帧上限 5MiB`)
      actualTotal += bytes.length
      if (actualTotal > REVIEW_IMAGE_LIMITS.totalBytes) invalid('原帧及局部附件合计超过本地请求上限 24MiB；未提交任何截断审查')
      frames.push({ url: source.url, bytes, kind: 'detail', frameIndex, sourceRect, detailConfig: config, label: imageLabel('detail', frameIndex, source.url, sourceRect) })
    }
  }
  return frames
}

/** Includes every ordered attachment, including later frames with unchanged URLs. */
export function reviewImagesFingerprint(baseFingerprint: string, frames: readonly LoadedReviewImage[]): string {
  if (!frames.length) return baseFingerprint
  const digest = createHash('sha256').update('review-images-v1\0').update(baseFingerprint).update('\0')
  for (const frame of frames) {
    digest.update(JSON.stringify([frame.url, frame.bytes.length])).update('\0')
    if (frame.label !== undefined || frame.detailConfig !== undefined) digest.update(JSON.stringify([frame.label, frame.detailConfig])).update('\0')
    if (frame.kind === 'sequence-grid') digest.update(JSON.stringify([frame.kind, frame.mimeType, frame.attachmentIndex, frame.cells, frame.encoding])).update('\0')
    digest.update(createHash('sha256').update(frame.bytes).digest())
  }
  return digest.digest('hex')
}

export function reviewImageContentBlocks(frames: readonly LoadedReviewImage[]): Array<Record<string, unknown>> {
  return frames.flatMap(frame => {
    const image = { type: 'image', source: { type: 'base64', media_type: frame.mimeType ?? 'image/jpeg', data: frame.bytes.toString('base64') } }
    return frame.label === undefined ? [image] : [{ type: 'text', text: frame.label }, image]
  })
}
