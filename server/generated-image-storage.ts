import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

/** Persist provider bytes before the execution ledger redacts base64 payloads. */
export async function persistGeneratedImageResponse(value: unknown, root = process.cwd()): Promise<unknown> {
  if (typeof value === 'string' && value.startsWith('data:image/')) {
    const match = value.match(/^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=\s]+)$/)
    if (!match) throw new Error('图片模型返回了无效的图片 data URL')
    const bytes = Buffer.from(match[2], 'base64')
    if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new Error('图片模型结果大小必须在 1B 到 20MB 之间')
    const metadata = await sharp(bytes, { failOn: 'error' }).metadata()
    if (!metadata.width || !metadata.height) throw new Error('图片模型返回了不可解码的图片')
    const filename = `image-${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}.${metadata.format === 'jpeg' ? 'jpg' : metadata.format}`
    await mkdir(path.join(root, 'public/generated'), { recursive: true })
    await writeFile(path.join(root, 'public/generated', filename), bytes)
    return `/generated/${filename}`
  }
  if (Array.isArray(value)) return Promise.all(value.map((item) => persistGeneratedImageResponse(item, root)))
  if (value && typeof value === 'object') {
    return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await persistGeneratedImageResponse(item, root)])))
  }
  return value
}
