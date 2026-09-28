import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { isPublicInternetUrl } from './web-sources.ts'

/** Keep the first/end map originals on our host before the image-evidence
 * gate hashes them. The provider URL alone can expire or change. */
export async function persistHistoricalMapFrameResponse(value: unknown, root = process.cwd()): Promise<unknown> {
  const persistUrl = async (url: string) => {
    if (url.startsWith('/generated/')) return url
    if (!isPublicInternetUrl(url)) throw new Error('HISTORICAL_MAP_FRAME_STORAGE_INVALID: 图片 URL 必须是公开供应商地址')
    const response = await fetch(url, { signal: AbortSignal.timeout(120000) })
    if (!response.ok || !response.body) throw new Error(`HISTORICAL_MAP_FRAME_STORAGE_INVALID: 原图下载 HTTP ${response.status}`)
    const chunks: Uint8Array[] = []; let size = 0
    for await (const chunk of response.body) {
      size += chunk.length
      if (size > 20 * 1024 * 1024) throw new Error('HISTORICAL_MAP_FRAME_STORAGE_INVALID: 原图超过 20MB')
      chunks.push(chunk)
    }
    const bytes = Buffer.concat(chunks)
    const metadata = await sharp(bytes, { failOn: 'error' }).metadata()
    if (!metadata.width || !metadata.height || !['png', 'jpeg', 'webp'].includes(metadata.format ?? '')) {
      throw new Error('HISTORICAL_MAP_FRAME_STORAGE_INVALID: 原图不能解码为 PNG、JPEG 或 WebP')
    }
    const extension = metadata.format === 'jpeg' ? 'jpg' : metadata.format
    const filename = `historical-map-frame-${createHash('sha256').update(bytes).digest('hex')}.${extension}`
    const directory = path.join(root, 'public/generated'); await mkdir(directory, { recursive: true })
    const temporary = path.join(directory, `${filename}.${randomUUID()}.tmp`)
    await writeFile(temporary, bytes)
    await rename(temporary, path.join(directory, filename))
    return `/generated/${filename}`
  }
  const visit = async (node: unknown, inImages = false): Promise<unknown> => {
    if (Array.isArray(node)) return Promise.all(node.map(item => visit(item, inImages)))
    if (!node || typeof node !== 'object') return node
    const entries = await Promise.all(Object.entries(node).map(async ([key, child]) => {
      if ((key === 'url' || key === 'image_url') && inImages && typeof child === 'string') return [key, await persistUrl(child)] as const
      return [key, await visit(child, inImages || key === 'images')] as const
    }))
    return Object.fromEntries(entries)
  }
  return visit(value)
}
