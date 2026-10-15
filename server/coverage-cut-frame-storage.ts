import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { isPublicInternetUrl } from './web-sources.ts'

type Binding = { characterName: string; assetId: string; url: string; [key: string]: unknown }
type SourceInput = { previousTail: { url: string; available: true; source: 'extracted-from-video'; videoTailUrl: string };
  referenceBindings: Binding[] }

export async function archiveCoverageImage(url: string, root: string) {
  const directory = path.join(root, 'public/generated')
  await mkdir(directory, { recursive: true })
    let bytes: Buffer
    if (/^\/generated\/[\w.-]+\.(?:png|jpe?g|webp)$/i.test(url)) bytes = await readFile(path.join(root, 'public', url))
    else {
      if (!isPublicInternetUrl(url)) throw new Error('COVERAGE_SOURCE_INVALID: 图片源不是本地图或公网供应商图')
      const response = await fetch(url, { signal: AbortSignal.timeout(120_000) })
      if (!response.ok || !response.body) throw new Error(`COVERAGE_SOURCE_INVALID: 原图下载 HTTP ${response.status}`)
      const chunks: Uint8Array[] = []; let size = 0
      for await (const chunk of response.body) {
        size += chunk.length
        if (size > 20 * 1024 * 1024) throw new Error('COVERAGE_SOURCE_INVALID: 原图超过 20MB')
        chunks.push(chunk)
      }
      bytes = Buffer.concat(chunks)
    }
    const metadata = await sharp(bytes, { failOn: 'error' }).metadata()
    if (!metadata.width || !metadata.height || !['png', 'jpeg', 'webp'].includes(metadata.format ?? '')) {
      throw new Error('COVERAGE_SOURCE_INVALID: 原图无法解码')
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const extension = metadata.format === 'jpeg' ? 'jpg' : metadata.format
    const filename = `coverage-source-${sha256}.${extension}`
    const output = path.join(directory, filename)
    const temporary = `${output}.${randomUUID()}.tmp`
    await writeFile(temporary, bytes)
    await rename(temporary, output)
    return { url: `/generated/${filename}`, sha256, sourceUrl: url }
}

/** Archive the actual preceding video tail and the exact selected identity sheets
 * before an image model is invoked. Provider URLs may expire or serve new bytes. */
export async function archiveCoverageCutSources(input: SourceInput, root = process.cwd()) {
  const tail = input?.previousTail
  const bindings = input?.referenceBindings
  if (!tail || tail.available !== true || tail.source !== 'extracted-from-video'
    || !tail.url || tail.url !== tail.videoTailUrl || !Array.isArray(bindings)
    || bindings.length < 1 || bindings.length > 2
    || bindings.some(item => !item || !item.characterName || !item.assetId || !item.url)
    || new Set(bindings.map(item => item.characterName)).size !== bindings.length) {
    throw new Error('COVERAGE_SOURCE_INVALID: 缺少前镜实际尾帧或一至两张已选人物三视图')
  }
  const previous = await archiveCoverageImage(tail.url, root)
  const archivedBindings = await Promise.all(bindings.map(async item => ({ ...item, ...await archiveCoverageImage(item.url, root) })))
  return { version: 'coverage-cut-sources-v1', previousTail: { ...previous, source: tail.source,
    available: true, videoTailUrl: tail.videoTailUrl }, referenceBindings: archivedBindings,
  referenceImages: archivedBindings.map(item => item.url) }
}

/** Persist a newly generated camera-angle image before evidence or video uses it. */
export async function persistCoverageCutFirstFrameResponse(value: unknown, root = process.cwd()): Promise<unknown> {
  const visit = async (node: unknown, inImages = false): Promise<unknown> => {
    if (Array.isArray(node)) return Promise.all(node.map(item => visit(item, inImages)))
    if (!node || typeof node !== 'object') return node
    return Object.fromEntries(await Promise.all(Object.entries(node).map(async ([key, child]) => {
      if ((key === 'url' || key === 'image_url') && inImages && typeof child === 'string') {
        return [key, (await archiveCoverageImage(child, root)).url] as const
      }
      return [key, await visit(child, inImages || key === 'images')] as const
    })))
  }
  const persisted = await visit(value)
  const images = (persisted as { data?: { task_result?: { images?: Array<{ url?: unknown }> } } } | null)?.data?.task_result?.images
  if (!Array.isArray(images) || images.length !== 1 || typeof images[0]?.url !== 'string'
    || !/^\/generated\/[\w.-]+\.(?:png|jpe?g|webp)$/i.test(images[0].url)) {
    throw new Error('COVERAGE_FRAME_STORAGE_INVALID: Kling 新机位首帧原图未持久化，禁止进入采证或视频')
  }
  return persisted
}
